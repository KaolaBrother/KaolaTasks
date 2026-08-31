import { transitionTaskStatus } from '@kaola/shared'
import type { TaskStatus } from '@kaola/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { addDeviceProofHook, requireDeviceAuth, type AgentPrincipal } from './device-proof.ts'
export type { AgentPrincipal } from './device-proof.ts'
import {
  PENDING_CONFIRM_EVENT,
  consumeApprovedConfirmation,
  findClaimConfirmations,
  insertPendingConfirmation,
  pendingConfirmationBody,
  recordPendingConfirmEvent,
} from './claim-confirmations.ts'
import type { AppDb } from './db.ts'
import {
  LEASE_TTL_SECONDS,
  claimIdForLease,
  insertActiveLease,
  markLeaseReleased,
  renewActiveLease,
  selectActiveLease,
  selectLeaseByDeviceRequest,
  sweepExpiredLeases,
  unixNow,
} from './leases.ts'
import { type Lease, type Task, credentialProfiles, events, submissions, tasks } from './schema.ts'
import { selectTask, taskBrief } from './tasks.ts'
import { decryptToken, insertAuditEvent, isVaultUnconfiguredError } from './vault.ts'
import { attemptWriteback, scheduleWriteback } from './writeback.ts'

const PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'
const TASK_ALREADY_CLAIMED_MESSAGE = '任务已被认领。'
const TASK_NOT_CLAIMED_MESSAGE = '任务未被认领。'
const REQUEST_ID_CONFLICT_MESSAGE =
  '同一 request_id 已用于一次不同的认领尝试（目标任务或 autonomous 标记不一致），本次请求已被拒绝。'
const REQUEST_ID_REPLAY_TERMINAL_MESSAGE = '该 request_id 对应的认领已结束，请使用新的 request_id 重新认领。'
const STATUS_TRANSITION_EVENT = '状态迁移'
const TOKEN_REVEAL_EVENT = 'token 揭示'
const HEARTBEAT_EVENT = '心跳'
export const CLONE_TOKEN_USAGE =
  'token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。'

export type AgentServiceError = { error: string; message?: string }

export type AgentServiceResult<T> =
  | { ok: true; httpStatus: number; body: T }
  | { ok: false; httpStatus: number; body: AgentServiceError }

// Thrown only inside the claim transaction when the Task CAS predicate (id + status = '待认领')
// matches zero rows — i.e. a concurrent writer already moved the task out from under us between
// our read and our write. Caught immediately outside the transaction; never escapes claimTask.
class ClaimCasLostError extends Error {}

function illegalTransitionMessage(from: string, to: string): string {
  return `任务状态不允许从「${from}」变更为「${to}」。`
}

// The claim response's lease envelope only — report_progress/release keep their own unrelated
// shape ({ expires_at, ttl_seconds }, no claim_id), so this is deliberately not the same helper.
function claimLeaseEnvelope(lease: Lease) {
  return {
    claim_id: claimIdForLease(lease),
    expires_at: new Date(lease.expiresAt * 1000).toISOString(),
    ttl_seconds: LEASE_TTL_SECONDS,
  }
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
  lease: ReturnType<typeof claimLeaseEnvelope>
  clone: {
    suggested_dir: string
    token_usage: string
    remote_url: string
    extra_header: { name: string; value_pattern: string }
  }
}

type ClaimPendingBody = { error: 'confirmation_required'; message: string; pending: true }

type RevealDetailsBase = {
  task_id: string
  device_id: number
  credential: 'inline' | 'profile'
  profile_id?: number
  claimant_id?: number
}

function cloneRecipe(brief: ReturnType<typeof taskBrief>) {
  return {
    suggested_dir: brief.repo.suggested_dir,
    token_usage: CLONE_TOKEN_USAGE,
    remote_url: `${brief.repo.base_url.replace(/\/+$/u, '')}/${brief.repo.full_name}.git`,
    extra_header:
      brief.repo.forge === 'gitea'
        ? { name: 'Authorization', value_pattern: 'token ${token}' }
        : { name: 'Authorization', value_pattern: 'Bearer ${token}' },
  }
}

// Shared by the fresh-claim path and the replay path: decrypting the task's credential (profile
// or inline) and shaping the base of the 揭示 audit details is identical either way — only the
// claim_id / request_id / autonomous / replay tail differs, added by each caller.
function resolveClaimCredential(
  db: AppDb,
  auth: AgentPrincipal,
  task: Task,
  publicId: string,
): { plaintext: string; detailsBase: RevealDetailsBase } {
  if (task.credentialProfileId != null) {
    const profile = db
      .select()
      .from(credentialProfiles)
      .where(eq(credentialProfiles.id, task.credentialProfileId))
      .get()
    if (profile == null) {
      throw new Error('credential profile not found')
    }
    return {
      plaintext: decryptToken(profile.tokenEncrypted),
      detailsBase: {
        task_id: publicId,
        device_id: auth.device.id,
        credential: 'profile',
        profile_id: profile.id,
        ...(auth.owner.kind === 'claimant' ? { claimant_id: auth.owner.claimant.id } : {}),
      },
    }
  }
  if (task.inlineTokenEncrypted == null) {
    throw new Error('task credential xor violated')
  }
  return {
    plaintext: decryptToken(task.inlineTokenEncrypted),
    detailsBase: {
      task_id: publicId,
      device_id: auth.device.id,
      credential: 'inline',
      ...(auth.owner.kind === 'claimant' ? { claimant_id: auth.owner.claimant.id } : {}),
    },
  }
}

// Issue #36 / ADR-0030: claim_id is derived from the lease row, never stored, so recovering a
// replay attempt's original (task public id, autonomous) digest means reading it back out of the
// token 揭示 event that carried that claim_id — the same "state lives in events.details" precedent
// as writeback.ts's hasSuccessfulWriteback/claimOccurred (writeback.ts:116-130).
function findOriginalRevealDigest(db: AppDb, claimId: string): { taskId: string; autonomous: boolean } | undefined {
  const rows = db
    .select({ details: events.details })
    .from(events)
    .where(eq(events.type, TOKEN_REVEAL_EVENT))
    .orderBy(events.id)
    .all()
  for (const row of rows) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(row.details) as Record<string, unknown>
    } catch {
      continue
    }
    if (parsed.claim_id === claimId && typeof parsed.task_id === 'string') {
      return { taskId: parsed.task_id, autonomous: parsed.autonomous === true }
    }
  }
  return undefined
}

// A parked autonomous claim has no lease yet (that only exists once approved and consumed), so a
// replay's digest for a still-pending request_id has to be recovered from the 认领待确认 event
// that parked it — same "state lives in events.details" precedent as findOriginalRevealDigest
// above, keyed the same way (device_id, request_id).
function findPendingConfirmDigest(
  db: AppDb,
  deviceId: number,
  requestId: string,
): { taskId: string; autonomous: boolean } | undefined {
  const rows = db
    .select({ details: events.details })
    .from(events)
    .where(eq(events.type, PENDING_CONFIRM_EVENT))
    .orderBy(events.id)
    .all()
  for (const row of rows) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(row.details) as Record<string, unknown>
    } catch {
      continue
    }
    if (parsed.device_id === deviceId && parsed.request_id === requestId && typeof parsed.task_id === 'string') {
      return { taskId: parsed.task_id, autonomous: parsed.autonomous === true }
    }
  }
  return undefined
}

export async function claimTask(
  db: AppDb,
  auth: AgentPrincipal,
  publicId: string,
  autonomous?: boolean,
  requestId?: string,
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

  const autonomousFlag = autonomous === true

  // Issue #36: replay identity. request_id is keyed to (device_id, request_id) — any lease
  // state — before the target task is even looked at, so a mismatched digest (different task, or
  // a different autonomous flag) is refused as a typed conflict rather than silently starting a
  // brand-new claim attempt.
  if (requestId != null) {
    const existingLease = selectLeaseByDeviceRequest(db, auth.device.id, requestId)
    if (existingLease != null) {
      const claimId = claimIdForLease(existingLease)
      const original = findOriginalRevealDigest(db, claimId)
      const digestMatches = original != null && original.taskId === publicId && original.autonomous === autonomousFlag
      if (!digestMatches) {
        return {
          ok: false,
          httpStatus: 409,
          body: { error: 'claim_request_conflict', message: REQUEST_ID_CONFLICT_MESSAGE },
        }
      }
      if (existingLease.state !== 'active') {
        return {
          ok: false,
          httpStatus: 409,
          body: { error: 'claim_request_conflict', message: REQUEST_ID_REPLAY_TERMINAL_MESSAGE },
        }
      }
      if (!ownerMatchesLease(auth, existingLease)) {
        return { ok: false, httpStatus: 403, body: { error: 'forbidden' } }
      }

      const row = selectTask(db, publicId)
      if (row == null) {
        return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
      }

      let credential: { plaintext: string; detailsBase: RevealDetailsBase }
      try {
        credential = resolveClaimCredential(db, auth, row.task, publicId)
      } catch (err) {
        if (isVaultUnconfiguredError(err)) {
          return { ok: false, httpStatus: 500, body: { error: 'vault_unconfigured' } }
        }
        throw err
      }

      insertAuditEvent(db, {
        type: TOKEN_REVEAL_EVENT,
        actorUserId: actorUserId(auth),
        details: {
          ...credential.detailsBase,
          claim_id: claimId,
          request_id: requestId,
          autonomous: autonomousFlag,
          replay: true,
        },
      })

      const brief = taskBrief({ task: row.task, posterUsername: row.posterUsername })
      return {
        ok: true,
        httpStatus: 201,
        body: {
          task: brief,
          token: credential.plaintext,
          lease: claimLeaseEnvelope(existingLease),
          clone: cloneRecipe(brief),
        },
      }
    } else {
      // No lease yet for this (device, request_id) — but a still-pending autonomous confirmation
      // may already own this request_id. A mismatched digest there is refused the same way; a
      // match falls through to the normal path, which re-hits the pending-confirmation branch
      // below and answers 202 again (no lease is created either way).
      const pending = findPendingConfirmDigest(db, auth.device.id, requestId)
      if (pending != null && (pending.taskId !== publicId || pending.autonomous !== autonomousFlag)) {
        return {
          ok: false,
          httpStatus: 409,
          body: { error: 'claim_request_conflict', message: REQUEST_ID_CONFLICT_MESSAGE },
        }
      }
    }
  }

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
  let approvedConfirmationId: number | undefined
  if (auth.owner.kind === 'user' && autonomousFlag && !auth.owner.user.trustedAutomation) {
    const lookup = findClaimConfirmations(db, row.task.id, auth.owner.user.id, auth.device.id)
    if (lookup.pending != null) {
      return { ok: true, httpStatus: 202, body: pendingConfirmationBody() }
    }
    if (lookup.approved != null) {
      // Consumed inside the claim transaction below, so a failed claim never burns the approval.
      approvedConfirmationId = lookup.approved.id
    } else {
      insertPendingConfirmation(db, { taskId: row.task.id, userId: auth.owner.user.id, deviceId: auth.device.id })
      recordPendingConfirmEvent(db, {
        actorUserId: auth.owner.user.id,
        publicId,
        deviceId: auth.device.id,
        requestId,
        autonomous: autonomousFlag,
      })
      return { ok: true, httpStatus: 202, body: pendingConfirmationBody() }
    }
  }

  let credential: { plaintext: string; detailsBase: RevealDetailsBase }
  try {
    credential = resolveClaimCredential(db, auth, row.task, publicId)
  } catch (err) {
    if (isVaultUnconfiguredError(err)) {
      return { ok: false, httpStatus: 500, body: { error: 'vault_unconfigured' } }
    }
    throw err
  }

  const now = unixNow()
  const to = transitionTaskStatus(from, '进行中') as TaskStatus

  // Issue #36: one transaction for approved-confirmation consumption, the Task CAS UPDATE, the
  // lease INSERT, the token 揭示 audit, and the 状态迁移 audit — poller.ts's
  // applyPrTerminalTransition (poller.ts:85-93) is the in-repo precedent for this shape. The Task
  // UPDATE predicate is a real compare-and-swap (id + status = '待认领'): if a concurrent writer
  // already moved the task, the predicate matches zero rows and ClaimCasLostError aborts the
  // whole transaction so nothing partially commits.
  let outcome: { updated: Task; lease: Lease; claimId: string }
  try {
    outcome = db.transaction((tx) => {
      if (approvedConfirmationId != null) {
        consumeApprovedConfirmation(tx, approvedConfirmationId)
      }

      // Deliberately `db.update`, not `tx.update`: it is still inside this transaction (same
      // underlying connection — better-sqlite3 has no separate per-object transaction context),
      // but issuing it through the same `db` handle the caller passed in is what lets a
      // concurrent writer's race on that exact call be observed/tested from outside claimTask.
      const updated = db
        .update(tasks)
        .set({ status: to })
        .where(and(eq(tasks.id, row.task.id), eq(tasks.status, '待认领')))
        .returning()
        .get()
      if (updated == null) {
        throw new ClaimCasLostError()
      }

      const lease = insertActiveLease(tx, {
        taskId: row.task.id,
        claimerUserId: auth.owner.kind === 'user' ? auth.owner.user.id : null,
        claimerClaimantId: auth.owner.kind === 'claimant' ? auth.owner.claimant.id : null,
        deviceId: auth.device.id,
        now,
        requestId: requestId ?? null,
      })
      const claimId = claimIdForLease(lease)

      insertAuditEvent(tx, {
        type: TOKEN_REVEAL_EVENT,
        actorUserId: actorUserId(auth),
        details: {
          ...credential.detailsBase,
          claim_id: claimId,
          request_id: requestId ?? null,
          autonomous: autonomousFlag,
        },
      })
      insertAuditEvent(tx, {
        type: STATUS_TRANSITION_EVENT,
        actorUserId: actorUserId(auth),
        details: { task_id: publicId, from, to },
      })

      return { updated, lease, claimId }
    })
  } catch (err) {
    if (err instanceof ClaimCasLostError) {
      return { ok: false, httpStatus: 409, body: { error: 'conflict', message: TASK_ALREADY_CLAIMED_MESSAGE } }
    }
    throw err
  }

  // Off the response path: never awaited here, so a slow/unreachable forge cannot delay a
  // committed claim. settleWritebacks() (writeback.ts) is the deterministic seam for tests.
  scheduleWriteback(db, outcome.updated, '认领', actorUserId(auth))

  const brief = taskBrief({ task: outcome.updated, posterUsername: row.posterUsername })
  return {
    ok: true,
    httpStatus: 201,
    body: {
      task: brief,
      token: credential.plaintext,
      lease: claimLeaseEnvelope(outcome.lease),
      clone: cloneRecipe(brief),
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

  // submit_pr's write-back stays on the response path (unlike claim's) — only claimTask's forge
  // comment was moved off it.
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
      return sendAgentResult(
        reply,
        await claimTask(
          db,
          auth,
          publicId,
          readAutonomous(request.body),
          readOptionalString(request.body, 'request_id'),
        ),
      )
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
