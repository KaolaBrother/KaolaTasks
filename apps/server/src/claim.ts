import { transitionTaskStatus } from '@kaola/shared'
import type { TaskStatus } from '@kaola/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { addDeviceProofHook, requireDeviceAuth, type AgentPrincipal } from './device-proof.ts'
export type { AgentPrincipal } from './device-proof.ts'
import {
  consumeApprovedConfirmation,
  findClaimConfirmations,
  insertPendingConfirmation,
  pendingConfirmationBody,
  recordPendingConfirmEvent,
} from './claim-confirmations.ts'
import type { AppDb } from './db.ts'
import {
  LEASE_TTL_SECONDS,
  insertActiveLease,
  markLeaseReleased,
  renewActiveLease,
  selectActiveLease,
  sweepExpiredLeases,
  unixNow,
} from './leases.ts'
import { credentialProfiles, submissions, tasks } from './schema.ts'
import { selectTask, taskBrief } from './tasks.ts'
import { decryptToken, insertAuditEvent, isVaultUnconfiguredError } from './vault.ts'
import { attemptWriteback } from './writeback.ts'

const PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'
const TASK_ALREADY_CLAIMED_MESSAGE = '任务已被认领。'
const TASK_NOT_CLAIMED_MESSAGE = '任务未被认领。'
const STATUS_TRANSITION_EVENT = '状态迁移'
const TOKEN_REVEAL_EVENT = 'token 揭示'
const HEARTBEAT_EVENT = '心跳'
export const CLONE_TOKEN_USAGE =
  'token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。'

export type AgentServiceError = { error: string; message?: string }

export type AgentServiceResult<T> =
  | { ok: true; httpStatus: number; body: T }
  | { ok: false; httpStatus: number; body: AgentServiceError }

function illegalTransitionMessage(from: string, to: string): string {
  return `任务状态不允许从「${from}」变更为「${to}」。`
}

function leaseEnvelope(expiresAt: number) {
  return {
    expires_at: new Date(expiresAt * 1000).toISOString(),
    ttl_seconds: LEASE_TTL_SECONDS,
  }
}

function readOptionalString(body: unknown, key: string): string | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

// Missing/invalid/empty body = instructed (today's clients send no body at all).
function readAutonomous(body: unknown): boolean | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const value = (body as Record<string, unknown>).autonomous
  return typeof value === 'boolean' ? value : undefined
}

function actorUserId(auth: AgentPrincipal): number | null {
  return auth.owner.kind === 'user' ? auth.owner.user.id : null
}

function ownerIsPendingUser(auth: AgentPrincipal): boolean {
  return auth.owner.kind === 'user' && auth.owner.user.status === '待批准'
}

function ownerMatchesLease(auth: AgentPrincipal, lease: { claimerUserId: number | null; claimerClaimantId: number | null }): boolean {
  if (auth.owner.kind === 'user') {
    return lease.claimerUserId === auth.owner.user.id
  }
  return lease.claimerClaimantId === auth.owner.claimant.id
}

function sendAgentResult<T>(reply: FastifyReply, result: AgentServiceResult<T>) {
  return reply.code(result.httpStatus).send(result.body)
}

type ClaimSuccessBody = {
  task: ReturnType<typeof taskBrief>
  token: string
  lease: ReturnType<typeof leaseEnvelope>
  clone: {
    suggested_dir: string
    token_usage: string
    remote_url: string
    extra_header: { name: string; value_pattern: string }
  }
}

type ClaimPendingBody = { error: 'confirmation_required'; message: string; pending: true }

export async function claimTask(
  db: AppDb,
  auth: AgentPrincipal,
  publicId: string,
  autonomous?: boolean,
): Promise<AgentServiceResult<ClaimSuccessBody | ClaimPendingBody>> {
  if (ownerIsPendingUser(auth)) {
    return { ok: false, httpStatus: 403, body: { error: 'forbidden', message: PENDING_CLAIM_MESSAGE } }
  }
  if (auth.owner.kind === 'user' && auth.owner.user.status !== 'active') {
    return { ok: false, httpStatus: 403, body: { error: 'forbidden' } }
  }
  if (auth.owner.kind === 'claimant' && auth.owner.claimant.status !== 'active') {
    return { ok: false, httpStatus: 403, body: { error: 'forbidden' } }
  }

  sweepExpiredLeases(db)

  const row = selectTask(db, publicId)
  if (row == null) {
    return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
  }

  const from = row.task.status
  if (from === '进行中') {
    return { ok: false, httpStatus: 409, body: { error: 'conflict', message: TASK_ALREADY_CLAIMED_MESSAGE } }
  }
  if (from !== '待认领') {
    return {
      ok: false,
      httpStatus: 409,
      body: { error: 'illegal_transition', message: illegalTransitionMessage(from, '进行中') },
    }
  }

  // Issue #16: autonomous claims from a not-yet-trusted user need a per-claim confirmation.
  // Instructed claims (autonomous not true) skip this entirely, ignoring any leftover row.
  if (
    auth.owner.kind === 'user' &&
    autonomous === true &&
    !auth.owner.user.trustedAutomation
  ) {
    const lookup = findClaimConfirmations(db, row.task.id, auth.owner.user.id, auth.device.id)
    if (lookup.pending != null) {
      return { ok: true, httpStatus: 202, body: pendingConfirmationBody() }
    }
    if (lookup.approved != null) {
      consumeApprovedConfirmation(db, lookup.approved.id)
    } else {
      insertPendingConfirmation(db, { taskId: row.task.id, userId: auth.owner.user.id, deviceId: auth.device.id })
      recordPendingConfirmEvent(db, { actorUserId: auth.owner.user.id, publicId, deviceId: auth.device.id })
      return { ok: true, httpStatus: 202, body: pendingConfirmationBody() }
    }
  }

  let plaintext: string
  let revealDetails: {
    task_id: string
    device_id: number
    credential: 'inline' | 'profile'
    profile_id?: number
    claimant_id?: number
  }
  try {
    if (row.task.credentialProfileId != null) {
      const profile = db
        .select()
        .from(credentialProfiles)
        .where(eq(credentialProfiles.id, row.task.credentialProfileId))
        .get()
      if (profile == null) {
        throw new Error('credential profile not found')
      }
      plaintext = decryptToken(profile.tokenEncrypted)
      revealDetails = {
        task_id: publicId,
        device_id: auth.device.id,
        credential: 'profile',
        profile_id: profile.id,
        ...(auth.owner.kind === 'claimant' ? { claimant_id: auth.owner.claimant.id } : {}),
      }
    } else {
      if (row.task.inlineTokenEncrypted == null) {
        throw new Error('task credential xor violated')
      }
      plaintext = decryptToken(row.task.inlineTokenEncrypted)
      revealDetails = {
        task_id: publicId,
        device_id: auth.device.id,
        credential: 'inline',
        ...(auth.owner.kind === 'claimant' ? { claimant_id: auth.owner.claimant.id } : {}),
      }
    }
  } catch (err) {
    if (isVaultUnconfiguredError(err)) {
      return { ok: false, httpStatus: 500, body: { error: 'vault_unconfigured' } }
    }
    throw err
  }

  const now = unixNow()
  const to = transitionTaskStatus(from, '进行中') as TaskStatus
  const updated = db
    .update(tasks)
    .set({ status: to })
    .where(eq(tasks.id, row.task.id))
    .returning()
    .get()
  if (updated == null) {
    throw new Error('failed to update task status')
  }

  const lease = insertActiveLease(db, {
    taskId: row.task.id,
    claimerUserId: auth.owner.kind === 'user' ? auth.owner.user.id : null,
    claimerClaimantId: auth.owner.kind === 'claimant' ? auth.owner.claimant.id : null,
    deviceId: auth.device.id,
    now,
  })

  insertAuditEvent(db, {
    type: TOKEN_REVEAL_EVENT,
    actorUserId: actorUserId(auth),
    details: revealDetails,
  })
  insertAuditEvent(db, {
    type: STATUS_TRANSITION_EVENT,
    actorUserId: actorUserId(auth),
    details: { task_id: publicId, from, to },
  })

  await attemptWriteback(db, updated, '认领', actorUserId(auth))

  const brief = taskBrief({ task: updated, posterUsername: row.posterUsername })
  return {
    ok: true,
    httpStatus: 201,
    body: {
      task: brief,
      token: plaintext,
      lease: leaseEnvelope(lease.expiresAt),
      clone: {
        suggested_dir: brief.repo.suggested_dir,
        token_usage: CLONE_TOKEN_USAGE,
        remote_url: `${brief.repo.base_url.replace(/\/+$/u, '')}/${brief.repo.full_name}.git`,
        extra_header:
          brief.repo.forge === 'gitea'
            ? { name: 'Authorization', value_pattern: 'token ${token}' }
            : { name: 'Authorization', value_pattern: 'Bearer ${token}' },
      },
    },
  }
}

export function reportProgress(
  db: AppDb,
  auth: AgentPrincipal,
  publicId: string,
  note?: string,
): AgentServiceResult<{
  task: ReturnType<typeof taskBrief>
  lease: ReturnType<typeof leaseEnvelope>
}> {
  sweepExpiredLeases(db)

  const row = selectTask(db, publicId)
  if (row == null) {
    return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
  }

  const lease = selectActiveLease(db, row.task.id)
  if (lease == null) {
    return { ok: false, httpStatus: 409, body: { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE } }
  }
  if (!ownerMatchesLease(auth, lease)) {
    return { ok: false, httpStatus: 403, body: { error: 'forbidden' } }
  }

  const now = unixNow()
  const expiresAt = renewActiveLease(db, lease.id, now)
  insertAuditEvent(db, {
    type: HEARTBEAT_EVENT,
    actorUserId: actorUserId(auth),
    details: { task_id: publicId, note: note ?? '' },
  })

  const fresh = selectTask(db, publicId)
  if (fresh == null) {
    throw new Error('task missing after heartbeat')
  }
  return {
    ok: true,
    httpStatus: 200,
    body: {
      task: taskBrief(fresh),
      lease: leaseEnvelope(expiresAt),
    },
  }
}

export function releaseTask(
  db: AppDb,
  auth: AgentPrincipal,
  publicId: string,
  reason?: string,
): AgentServiceResult<{ task: ReturnType<typeof taskBrief> }> {
  sweepExpiredLeases(db)

  const row = selectTask(db, publicId)
  if (row == null) {
    return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
  }

  const lease = selectActiveLease(db, row.task.id)
  if (lease == null) {
    return { ok: false, httpStatus: 409, body: { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE } }
  }
  if (!ownerMatchesLease(auth, lease)) {
    return { ok: false, httpStatus: 403, body: { error: 'forbidden' } }
  }

  const from = row.task.status
  const to = transitionTaskStatus(from, '待认领') as TaskStatus
  markLeaseReleased(db, lease.id)
  const updated = db
    .update(tasks)
    .set({ status: to })
    .where(eq(tasks.id, row.task.id))
    .returning()
    .get()
  if (updated == null) {
    throw new Error('failed to update task status')
  }

  const details =
    reason === undefined
      ? { task_id: publicId, from, to }
      : { task_id: publicId, from, to, reason }
  insertAuditEvent(db, {
    type: STATUS_TRANSITION_EVENT,
    actorUserId: actorUserId(auth),
    details,
  })

  return {
    ok: true,
    httpStatus: 200,
    body: {
      task: taskBrief({ task: updated, posterUsername: row.posterUsername }),
    },
  }
}

export async function submitPr(
  db: AppDb,
  auth: AgentPrincipal,
  publicId: string,
  prUrl: string,
  summary: string,
): Promise<AgentServiceResult<{
  task: ReturnType<typeof taskBrief>
  pr_url: string
  summary: string
}>> {
  sweepExpiredLeases(db)

  const row = selectTask(db, publicId)
  if (row == null) {
    return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
  }

  const lease = selectActiveLease(db, row.task.id)
  if (lease == null) {
    return { ok: false, httpStatus: 409, body: { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE } }
  }
  if (!ownerMatchesLease(auth, lease)) {
    return { ok: false, httpStatus: 403, body: { error: 'forbidden' } }
  }

  const from = row.task.status
  if (from !== '进行中') {
    return {
      ok: false,
      httpStatus: 409,
      body: { error: 'illegal_transition', message: illegalTransitionMessage(from, '待验收') },
    }
  }

  const to = transitionTaskStatus(from, '待验收') as TaskStatus
  markLeaseReleased(db, lease.id)
  const updated = db
    .update(tasks)
    .set({ status: to })
    .where(eq(tasks.id, row.task.id))
    .returning()
    .get()
  if (updated == null) {
    throw new Error('failed to update task status')
  }

  db.insert(submissions)
    .values({
      taskId: row.task.id,
      leaseId: lease.id,
      prUrl,
      summary,
      prState: 'open',
    })
    .run()

  insertAuditEvent(db, {
    type: STATUS_TRANSITION_EVENT,
    actorUserId: actorUserId(auth),
    details: { task_id: publicId, from, to, pr_url: prUrl, summary },
  })

  await attemptWriteback(db, updated, '提交PR', actorUserId(auth), prUrl)

  return {
    ok: true,
    httpStatus: 200,
    body: {
      task: taskBrief({ task: updated, posterUsername: row.posterUsername }),
      pr_url: prUrl,
      summary,
    },
  }
}

export function registerClaim(app: FastifyInstance, db: AppDb) {
  app.register(async function claimDeviceContext(child) {
    addDeviceProofHook(child, db)

    child.post('/api/v1/tasks/:publicId/claim', async (request, reply) => {
      const auth = requireDeviceAuth(request, reply)
      if (auth == null) return

      const publicId = (request.params as { publicId: string }).publicId
      return sendAgentResult(reply, await claimTask(db, auth, publicId, readAutonomous(request.body)))
    })

    child.post('/api/v1/tasks/:publicId/progress', async (request, reply) => {
      const auth = requireDeviceAuth(request, reply)
      if (auth == null) return

      const publicId = (request.params as { publicId: string }).publicId
      return sendAgentResult(reply, reportProgress(db, auth, publicId, readOptionalString(request.body, 'note')))
    })

    child.post('/api/v1/tasks/:publicId/release', async (request, reply) => {
      const auth = requireDeviceAuth(request, reply)
      if (auth == null) return

      const publicId = (request.params as { publicId: string }).publicId
      return sendAgentResult(reply, releaseTask(db, auth, publicId, readOptionalString(request.body, 'reason')))
    })
  })
}
