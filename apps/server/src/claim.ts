import { parsePrUrl } from '@kaola/forge-adapters'
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
import { type Lease, type Task, credentialProfiles, events, leases, submissions, tasks } from './schema.ts'
import { publishStreamEvent } from './stream.ts'
import { selectTask, taskBrief } from './tasks.ts'
import { decryptToken, insertAuditEvent, isVaultUnconfiguredError } from './vault.ts'
import { scheduleWriteback } from './writeback.ts'

const PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'
const TASK_ALREADY_CLAIMED_MESSAGE = '任务已被认领。'
const TASK_NOT_CLAIMED_MESSAGE = '任务未被认领。'
const REQUEST_ID_CONFLICT_MESSAGE =
  '同一 request_id 已用于一次不同的认领尝试（目标任务或 autonomous 标记不一致），本次请求已被拒绝。'
const REQUEST_ID_REPLAY_TERMINAL_MESSAGE = '该 request_id 对应的认领已结束，请使用新的 request_id 重新认领。'
// Issue #31: claim_id fencing on report_progress/release_task/submit_pr.
const CLAIM_ID_REQUIRED_MESSAGE = '该认领要求提供 claim_id。'
const STALE_CLAIM_MESSAGE = '提交的 claim_id 与当前认领不匹配。'
const PR_URL_INVALID_MESSAGE = 'pr_url 无法解析，或与任务所属仓库不一致。'
const PR_URL_CONFLICT_MESSAGE = '同一认领已提交过另一个 pr_url。'
const PR_URL_TAKEN_MESSAGE = '该 pr_url 已被另一任务的进行中提交占用。'
// Issue #53.
const USE_SUBMIT_REVISION_MESSAGE = '任务已有首次提交；修订请认领「待修改」任务后调用 submit_revision。'
const PARENT_NOT_READY_MESSAGE = '父任务尚未提交 PR，子任务暂不可认领。'
const PERCENT_INVALID_MESSAGE = 'percent 必须是 0–100 的整数。'
// DESIGN §17.4: a sub-task is claimable once its parent has a PR to stack on (or is merged).
const PARENT_READY_STATUSES: ReadonlySet<string> = new Set(['待验收', '待修改', '待合并', '已完成'])
const CLAIMABLE_STATUSES: ReadonlySet<string> = new Set(['待认领', '待修改'])
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

export function illegalTransitionMessage(from: string, to: string): string {
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

function readProgressBody(body: unknown): ProgressExtras | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const raw = body as Record<string, unknown>
  const extras: ProgressExtras = {}
  if (raw.percent !== undefined) extras.percent = raw.percent
  if (raw.phase !== undefined) extras.phase = raw.phase
  return extras
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

export function actorUserId(auth: AgentPrincipal): number | null {
  return auth.owner.kind === 'user' ? auth.owner.user.id : null
}

function ownerIsPendingUser(auth: AgentPrincipal): boolean {
  return auth.owner.kind === 'user' && auth.owner.user.status === '待批准'
}

// Issue #31: the deliberate legacy tightening — a lease's owner match now ALSO requires the exact
// device that holds it, not just the same user/claimant. Before this, two devices bound to the
// same owner could act on each other's Claims; after this, only the device recorded on the lease
// (`leases.device_id`) may act on it, even for a legacy (`request_id IS NULL`) lease.
function ownerMatchesLease(
  auth: AgentPrincipal,
  lease: { claimerUserId: number | null; claimerClaimantId: number | null; deviceId: number },
): boolean {
  if (lease.deviceId !== auth.device.id) return false
  if (auth.owner.kind === 'user') {
    return lease.claimerUserId === auth.owner.user.id
  }
  return lease.claimerClaimantId === auth.owner.claimant.id
}

// Issue #31: fencing shared by report_progress/release_task/submit_pr against whichever lease the
// caller is being checked against (an active lease, or — for release_task/submit_pr's idempotent
// terminal path below — a resolved terminal one). A lease with a non-null request_id (a
// "new-style" Claim) requires claim_id; a legacy (`request_id IS NULL`) lease may omit it. A
// presented claim_id that does not match the lease's own derived identity is a stale_claim, and a
// device/owner mismatch is a forbidden — checked in that order so a caller who simply forgot
// claim_id is told so before anything about who they are.
function checkClaimFencing(
  auth: AgentPrincipal,
  lease: Lease,
  claimId: string | undefined,
): AgentServiceError2 | undefined {
  if (lease.requestId != null && claimId == null) {
    return { httpStatus: 400, error: 'claim_id_required', message: CLAIM_ID_REQUIRED_MESSAGE }
  }
  if (!ownerMatchesLease(auth, lease)) {
    return { httpStatus: 403, error: 'forbidden' }
  }
  if (claimId != null && claimIdForLease(lease) !== claimId) {
    return { httpStatus: 409, error: 'stale_claim', message: STALE_CLAIM_MESSAGE }
  }
  return undefined
}

type AgentServiceError2 = { httpStatus: number; error: string; message?: string }

function fencingFailureResult<T>(failure: AgentServiceError2): AgentServiceResult<T> {
  return {
    ok: false,
    httpStatus: failure.httpStatus,
    body: failure.message === undefined ? { error: failure.error } : { error: failure.error, message: failure.message },
  }
}

// The active-lease-only resolver used by report_progress: a heartbeat only ever makes sense
// against a currently active lease, so — unlike release_task/submit_pr below — there is no
// terminal-Claim fallback here.
export function resolveActiveLeaseForMutation(
  db: AppDb,
  auth: AgentPrincipal,
  taskId: number,
  claimId: string | undefined,
): AgentServiceResult<Lease> {
  const lease = selectActiveLease(db, taskId)
  if (lease == null) {
    return { ok: false, httpStatus: 409, body: { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE } }
  }
  const failure = checkClaimFencing(auth, lease, claimId)
  if (failure != null) {
    return fencingFailureResult(failure)
  }
  return { ok: true, httpStatus: 200, body: lease }
}

// release_task/submit_pr's fenced Claim resolution. Once a Claim goes terminal (released, or
// consumed by a prior submit_pr), it no longer holds the task's active lease — so a repeat of the
// same operation for the same Claim (the idempotent paths in releaseTask/submitPr below) has to
// resolve the Claim by identity instead, fenced by the exact same device+owner match the active
// path uses. Omitted claim_id against a terminal Claim only ever resolves a legacy
// (`request_id IS NULL`) one — a new-style Claim always requires it, even here.
export function resolveMutationLease(
  db: AppDb,
  auth: AgentPrincipal,
  taskId: number,
  claimId: string | undefined,
): AgentServiceResult<{ lease: Lease; terminal: boolean }> {
  const active = selectActiveLease(db, taskId)
  if (active != null) {
    const failure = checkClaimFencing(auth, active, claimId)
    if (failure != null) {
      return fencingFailureResult(failure)
    }
    return { ok: true, httpStatus: 200, body: { lease: active, terminal: false } }
  }

  const candidate = findTerminalLeaseForMutation(db, auth, taskId, claimId)
  if (candidate == null) {
    if (claimId != null) {
      return { ok: false, httpStatus: 409, body: { error: 'stale_claim', message: STALE_CLAIM_MESSAGE } }
    }
    return { ok: false, httpStatus: 409, body: { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE } }
  }
  return { ok: true, httpStatus: 200, body: { lease: candidate, terminal: true } }
}

function findTerminalLeaseForMutation(
  db: AppDb,
  auth: AgentPrincipal,
  taskId: number,
  claimId: string | undefined,
): Lease | undefined {
  const candidates = db
    .select()
    .from(leases)
    .where(and(eq(leases.taskId, taskId), eq(leases.deviceId, auth.device.id)))
    .all()
    .filter((lease) => ownerMatchesLease(auth, lease))

  if (claimId != null) {
    return candidates.find((lease) => claimIdForLease(lease) === claimId)
  }
  // Legacy derivation (issue #31 contract): an omitted claim_id can only ever resolve a lease
  // that itself never required one. Among those, the most recently held one for this exact
  // (task, device, owner) is "the" Claim being implicitly referenced.
  const legacyCandidates = candidates.filter((lease) => lease.requestId == null)
  if (legacyCandidates.length === 0) return undefined
  return legacyCandidates.reduce((latest, lease) => (lease.id > latest.id ? lease : latest))
}

// Issue #31: the stored form of a submitted pr_url must be the bare, undecorated URL a real forge
// actually emits — webhook.ts compares it byte-for-byte against the payload's own URL, and
// poller.ts feeds it straight back into getPullRequest. `parsePrUrl` (forge-adapters) already
// tolerates trailing slash / query / fragment / a /files/, /commits/, /diffs sub-page suffix for
// shape+ownership validation; this reproduces the same normalization generically (origin + a
// suffix-stripped pathname) to derive the exact string to persist, independent of forge kind.
const PR_URL_SUBPAGE_SUFFIX = /\/(?:files|commits|diffs)$/u

export function canonicalizePrUrl(prUrl: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(prUrl)
  } catch {
    return undefined
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '').replace(PR_URL_SUBPAGE_SUFFIX, '')
  return `${parsed.origin}${pathname}`
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

      const brief = taskBrief(row)
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
  // Issue #53 (D12): 待修改 is a claimable state too — a revision Claim, same envelope.
  if (!CLAIMABLE_STATUSES.has(from)) {
    return {
      ok: false,
      httpStatus: 409,
      body: { error: 'illegal_transition', message: illegalTransitionMessage(from, '进行中') },
    }
  }
  // Issue #53 (D13 / §17.4): a sub-task cannot be claimed until its parent has something to stack on.
  if (row.task.parentTaskId != null) {
    const parent = db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, row.task.parentTaskId)).get()
    if (parent == null || !PARENT_READY_STATUSES.has(parent.status)) {
      return { ok: false, httpStatus: 409, body: { error: 'parent_not_ready', message: PARENT_NOT_READY_MESSAGE } }
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
        .where(and(eq(tasks.id, row.task.id), eq(tasks.status, from)))
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
  // A revision Claim (from 待修改) does not re-announce 认领 on the source Issue.
  if (from === '待认领') {
    scheduleWriteback(db, outcome.updated, '认领', actorUserId(auth))
  }
  publishStreamEvent('task_updated', { task_id: publicId, status: outcome.updated.status })

  const brief = taskBrief({ ...row, task: outcome.updated })
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

export type ProgressExtras = { percent?: unknown; phase?: unknown }

// Issue #53 (D15): optional percent (0–100 integer) / phase (short text). Omitted keys leave the
// heartbeat exactly as before; a present-but-invalid value is a 400.
function readProgressExtras(extras: ProgressExtras | undefined): { percent?: number; phase?: string } | undefined {
  const out: { percent?: number; phase?: string } = {}
  if (extras?.percent !== undefined) {
    const percent = extras.percent
    if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100) return undefined
    out.percent = percent
  }
  if (extras?.phase !== undefined) {
    if (typeof extras.phase !== 'string') return undefined
    out.phase = extras.phase
  }
  return out
}

export function reportProgress(
  db: AppDb,
  auth: AgentPrincipal,
  publicId: string,
  note?: string,
  claimId?: string,
  extras?: ProgressExtras,
): AgentServiceResult<{
  task: ReturnType<typeof taskBrief>
  lease: ReturnType<typeof leaseEnvelope>
}> {
  sweepExpiredLeases(db)

  const progress = readProgressExtras(extras)
  if (progress == null) {
    return { ok: false, httpStatus: 400, body: { error: 'invalid_body', message: PERCENT_INVALID_MESSAGE } }
  }

  const row = selectTask(db, publicId)
  if (row == null) {
    return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
  }

  const resolved = resolveActiveLeaseForMutation(db, auth, row.task.id, claimId)
  if (!resolved.ok) {
    return resolved
  }
  const lease = resolved.body

  // Issue #31: report_progress is one transaction — the lease renew and its 心跳 audit either
  // both commit or neither does (poller.ts's applyPrTerminalTransition is the in-repo precedent
  // for this shape).
  const now = unixNow()
  const expiresAt = db.transaction((tx) => {
    const renewed = renewActiveLease(tx, lease.id, now)
    insertAuditEvent(tx, {
      type: HEARTBEAT_EVENT,
      actorUserId: actorUserId(auth),
      details: { task_id: publicId, note: note ?? '', ...progress },
    })
    return renewed
  })
  // The stream carries percent / phase only — never the free-text note.
  publishStreamEvent('progress', { task_id: publicId, percent: progress.percent ?? null, phase: progress.phase ?? null })

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
  claimId?: string,
): AgentServiceResult<{ task: ReturnType<typeof taskBrief> }> {
  sweepExpiredLeases(db)

  const row = selectTask(db, publicId)
  if (row == null) {
    return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
  }

  const resolved = resolveMutationLease(db, auth, row.task.id, claimId)
  if (!resolved.ok) {
    return resolved
  }
  const { lease, terminal } = resolved.body

  if (terminal) {
    // Issue #31: idempotent release — repeating release for a Claim that this exact call already
    // terminated returns the same result rather than a 409, with no duplicate transition/audit.
    // A terminal Claim that instead already submitted a PR through submitPr (it holds a
    // submissions row) was never released by release_task, so it is not a valid repeat here.
    const existingSubmission = db.select().from(submissions).where(eq(submissions.leaseId, lease.id)).get()
    if (existingSubmission != null) {
      return { ok: false, httpStatus: 409, body: { error: 'stale_claim', message: STALE_CLAIM_MESSAGE } }
    }
    const fresh = selectTask(db, publicId)
    if (fresh == null) {
      throw new Error('task missing after idempotent release lookup')
    }
    return { ok: true, httpStatus: 200, body: { task: taskBrief(fresh) } }
  }

  const from = row.task.status
  // Issue #53 (§5): a revision Claim abandoned mid-way goes back to 待修改, not 待认领.
  const hasSubmission = db.select({ id: submissions.id }).from(submissions).where(eq(submissions.taskId, row.task.id)).get() != null
  const to = transitionTaskStatus(from, hasSubmission ? '待修改' : '待认领') as TaskStatus
  const details =
    reason === undefined
      ? { task_id: publicId, from, to }
      : { task_id: publicId, from, to, reason }

  // Issue #31: release_task is one transaction — the lease release, the task update, and the
  // 状态迁移 audit either all commit or none does.
  const updated = db.transaction((tx) => {
    markLeaseReleased(tx, lease.id)
    const updatedTask = tx
      .update(tasks)
      .set({ status: to })
      .where(eq(tasks.id, row.task.id))
      .returning()
      .get()
    if (updatedTask == null) {
      throw new Error('failed to update task status')
    }
    insertAuditEvent(tx, {
      type: STATUS_TRANSITION_EVENT,
      actorUserId: actorUserId(auth),
      details,
    })
    return updatedTask
  })
  publishStreamEvent('task_updated', { task_id: publicId, status: updated.status })

  return {
    ok: true,
    httpStatus: 200,
    body: {
      task: taskBrief({ ...row, task: updated }),
    },
  }
}

export async function submitPr(
  db: AppDb,
  auth: AgentPrincipal,
  publicId: string,
  prUrl: string,
  summary: string,
  claimId?: string,
  headSha?: string,
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

  const resolved = resolveMutationLease(db, auth, row.task.id, claimId)
  if (!resolved.ok) {
    return resolved
  }
  const { lease, terminal } = resolved.body

  // Issue #31: PR ownership + canonicalization — before any Task or lease mutation. A pr_url that
  // does not parse, or whose repo does not match this task's own repo (all three forges,
  // including GitLab subgroups), is rejected here; nothing has been written yet.
  const parsedPr = parsePrUrl(row.task.repoForge, prUrl)
  const canonicalPrUrl = parsedPr == null ? undefined : canonicalizePrUrl(prUrl)
  if (parsedPr == null || canonicalPrUrl == null || parsedPr.full_name !== row.task.repoFullName) {
    return { ok: false, httpStatus: 422, body: { error: 'pr_url_invalid', message: PR_URL_INVALID_MESSAGE } }
  }

  if (terminal) {
    // Issue #31: one submission per Claim (submissions.lease_id is unique). Repeating submit_pr
    // for the same Claim and the same (canonical) pr_url is idempotent; the same Claim with a
    // different pr_url is a typed conflict. A terminal Claim with no submission at all here was
    // never a submitter (it was released by release_task instead) — it cannot newly submit now.
    const existingSubmission = db.select().from(submissions).where(eq(submissions.leaseId, lease.id)).get()
    if (existingSubmission == null) {
      return { ok: false, httpStatus: 409, body: { error: 'stale_claim', message: STALE_CLAIM_MESSAGE } }
    }
    if (existingSubmission.prUrl !== canonicalPrUrl) {
      return { ok: false, httpStatus: 409, body: { error: 'pr_url_conflict', message: PR_URL_CONFLICT_MESSAGE } }
    }
    const fresh = selectTask(db, publicId)
    if (fresh == null) {
      throw new Error('task missing after idempotent submit lookup')
    }
    return {
      ok: true,
      httpStatus: 200,
      body: { task: taskBrief(fresh), pr_url: existingSubmission.prUrl, summary: existingSubmission.summary },
    }
  }

  // Issue #53: submit_pr is the FIRST submission only. A task that already holds a submissions
  // row is in its revision loop — the Agent must hand the new head back via submit_revision.
  const priorSubmission = db.select({ id: submissions.id }).from(submissions).where(eq(submissions.taskId, row.task.id)).get()
  if (priorSubmission != null) {
    return { ok: false, httpStatus: 409, body: { error: 'use_submit_revision', message: USE_SUBMIT_REVISION_MESSAGE } }
  }

  // Issue #31: no duplicate PR across tasks — a pr_url already held by another task's LIVE
  // (non-terminal pr_state) submission is a typed conflict, checked before any mutation.
  const duplicate = db
    .select()
    .from(submissions)
    .where(and(eq(submissions.prUrl, canonicalPrUrl), eq(submissions.prState, 'open')))
    .all()
    .find((existing) => existing.taskId !== row.task.id)
  if (duplicate != null) {
    return { ok: false, httpStatus: 409, body: { error: 'pr_url_taken', message: PR_URL_TAKEN_MESSAGE } }
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

  // Issue #31: submit_pr is one transaction — the lease release, the task update, the submissions
  // insert, and the 状态迁移 audit either all commit or none does.
  const updated = db.transaction((tx) => {
    markLeaseReleased(tx, lease.id)
    const updatedTask = tx
      .update(tasks)
      .set({ status: to })
      .where(eq(tasks.id, row.task.id))
      .returning()
      .get()
    if (updatedTask == null) {
      throw new Error('failed to update task status')
    }
    tx.insert(submissions)
      .values({
        taskId: row.task.id,
        leaseId: lease.id,
        prUrl: canonicalPrUrl,
        summary,
        prState: 'open',
        // Issue #53 (D10): delivered as a Draft; head_sha is recorded when supplied, else the
        // poller backfills it from getPullRequest on its first look.
        headSha: typeof headSha === 'string' && headSha !== '' ? headSha : null,
        isDraft: true,
        reviewRound: 0,
      })
      .run()
    insertAuditEvent(tx, {
      type: STATUS_TRANSITION_EVENT,
      actorUserId: actorUserId(auth),
      details: { task_id: publicId, from, to, pr_url: canonicalPrUrl, summary },
    })
    return updatedTask
  })
  publishStreamEvent('task_updated', { task_id: publicId, status: updated.status })

  // Issue #38: off the response path, same as claim's 认领 write-back above — never awaited
  // here, so a slow/unreachable forge cannot delay a committed submit_pr response.
  // settleWritebacks() (writeback.ts) is the deterministic seam for tests.
  scheduleWriteback(db, updated, '提交PR', actorUserId(auth), canonicalPrUrl)

  return {
    ok: true,
    httpStatus: 200,
    body: {
      task: taskBrief({ ...row, task: updated }),
      pr_url: canonicalPrUrl,
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
      return sendAgentResult(
        reply,
        reportProgress(
          db,
          auth,
          publicId,
          readOptionalString(request.body, 'note'),
          readOptionalString(request.body, 'claim_id'),
          readProgressBody(request.body),
        ),
      )
    })

    child.post('/api/v1/tasks/:publicId/release', async (request, reply) => {
      const auth = requireDeviceAuth(request, reply)
      if (auth == null) return

      const publicId = (request.params as { publicId: string }).publicId
      return sendAgentResult(
        reply,
        releaseTask(
          db,
          auth,
          publicId,
          readOptionalString(request.body, 'reason'),
          readOptionalString(request.body, 'claim_id'),
        ),
      )
    })
  })
}
