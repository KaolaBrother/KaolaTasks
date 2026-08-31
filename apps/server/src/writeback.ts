import { createForgeAdapter } from '@kaola/forge-adapters'
import { desc, eq } from 'drizzle-orm'
import type { AppDb } from './db.ts'
import { type Task, credentialProfiles, events, submissions, tasks } from './schema.ts'
import { decryptToken, insertAuditEvent } from './vault.ts'

// Issue #14: status write-back to the source Issue on 认领 / 提交PR / 完成, for imported tasks
// only. Non-blocking by design — `attemptWriteback` swallows every fault (forge throw, decrypt
// miss, unparseable URL) so the surrounding claim/submit_pr/completion always succeeds. Durable
// success marker is a `回写` event with `details.ok === true` for that (task_id, transition); no
// new queue/job table. `retryPendingWritebacks` re-attempts anything imported whose transition
// has occurred but has no such successful event yet.

const WRITEBACK_EVENT = '回写'
const STATUS_TRANSITION_EVENT = '状态迁移'
const IN_PROGRESS_STATUS = '进行中'
const COMPLETED_STATUS = '已完成'

// Deliberately longer than forge-adapters' read-path DEFAULT_TIMEOUT_MS: an abort here fires
// *after* a slow-but-working forge has already committed the comment, so `attemptWriteback`
// records no successful 回写 event and the uncapped `retryPendingWritebacks` sweep reposts it
// forever, duplicating a real comment on a real Issue. A durable, user-visible write deserves
// more patience than a read.
const WRITEBACK_TIMEOUT_MS = 30_000

export type WritebackTransition = '认领' | '提交PR' | '完成'

// Same branch as `claimTask`'s credential resolution (claim.ts), except any failure here (vault
// unconfigured, missing profile, corrupt ciphertext) resolves to `undefined` rather than
// throwing — there is no HTTP request to fail on this caller's behalf. Shared by the poller's
// `getPullRequest` lookup and by write-back's `commentOnIssue` call.
export function decryptTaskToken(db: AppDb, task: Task): string | undefined {
  try {
    if (task.credentialProfileId != null) {
      const profile = db
        .select()
        .from(credentialProfiles)
        .where(eq(credentialProfiles.id, task.credentialProfileId))
        .get()
      if (profile == null) return undefined
      return decryptToken(profile.tokenEncrypted)
    }
    if (task.inlineTokenEncrypted == null) return undefined
    return decryptToken(task.inlineTokenEncrypted)
  } catch {
    return undefined
  }
}

function isImportedWithIssue(task: Task): boolean {
  return task.sourceType === 'imported' && task.sourceIssueUrl != null && task.sourceIssueUrl !== ''
}

function publicUrl(): string {
  const raw = process.env.PUBLIC_URL ?? 'http://localhost:31415'
  return raw.replace(/\/+$/u, '')
}

function commentBodyFor(transition: WritebackTransition, publicId: string, prUrl: string | undefined): string {
  const url = publicUrl()
  if (transition === '认领') {
    return `考拉任务（Kaola Tasks）已认领本 Issue 对应的任务。\n任务编号：${publicId}\n任务详情：${url}`
  }
  if (transition === '提交PR') {
    return `考拉任务（Kaola Tasks）任务 ${publicId} 已提交 PR。\n任务详情：${url}\nPR：${prUrl ?? ''}`
  }
  return `考拉任务（Kaola Tasks）任务 ${publicId} 已完成并合并。\n任务详情：${url}\nPR：${prUrl ?? ''}`
}

// Issue #40: distinguishes a DEFINITE failure (a real, status-bearing HTTP response from the forge
// API itself — nothing was created forge-side) from an AMBIGUOUS one (the fetch itself rejected —
// abort/timeout/network — or a status was returned that cannot rule out a forge-side commit, so
// whether the comment was created before the client observed the failure is unknown).
//
// R1 follow-up (independent review, same issue #40): a bare "some status was present" test is
// wrong. AGENTS.md's own deployment model is self-hosted GitLab/Gitea behind a reverse proxy — the
// proxy (or the origin itself, for a rate limit) can answer 502/503/504/408/429 AFTER the origin
// already committed the comment, and that must be resolved via a listing exactly like a bare
// network failure already is, never treated as "nothing was created". Only a 4xx from the forge
// API itself (except 408/429, which are gateway/rate-limit-shaped, not "rejected the request")
// rules out a forge-side commit and stays DEFINITE.
//
// The status is parsed out of `commentOnIssue`'s own throw idiom specifically
// (`commentOnIssue: <kind> responded <status>` — see forge-adapters' `commentOnIssue`/
// `forgePost`), so this cannot drift per forge kind (the idiom is shared verbatim across
// github/gitlab/gitea) and cannot accidentally match `listIssueComments`'s own throw (a different
// prefix) even though that call is already isolated by its own inner try/catch. Anything that
// doesn't match — a thrown `DOMException`/`TypeError` from `fetch()` itself, a decrypt miss, any
// other message shape — carries no usable status and must be treated as ambiguous.
const COMMENT_ON_ISSUE_FAILURE_PATTERN = /^commentOnIssue: \S+ responded (\d+)$/u
const AMBIGUOUS_STATUS_CODES = new Set([408, 429])

function isDefiniteFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const match = COMMENT_ON_ISSUE_FAILURE_PATTERN.exec(err.message)
  if (match == null) return false
  const status = Number(match[1])
  return status >= 400 && status < 500 && !AMBIGUOUS_STATUS_CODES.has(status)
}

async function postComment(db: AppDb, task: Task, body: string): Promise<void> {
  const token = decryptTaskToken(db, task)
  if (token == null) {
    throw new Error('writeback: no forge credential available for task')
  }
  const adapter = createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl, timeoutMs: WRITEBACK_TIMEOUT_MS })
  await adapter.commentOnIssue({ token }, { issue_url: task.sourceIssueUrl as string }, body)
}

// Only called for an AMBIGUOUS failure, never a definite one (keeps the definite path's
// listing-call count at zero). Resolves `true` when `body` (the exact idempotency marker
// `commentBodyFor` already embeds — task.publicId plus the transition's Chinese phrase) is found
// anywhere in the listing, `false` when the listing succeeds but does not contain it, and throws
// when the listing itself is unavailable — the caller must treat a thrown result as "unknown, skip
// this tick" rather than "not found, repost".
async function commentAlreadyPosted(db: AppDb, task: Task, body: string): Promise<boolean> {
  const token = decryptTaskToken(db, task)
  if (token == null) {
    throw new Error('writeback: no forge credential available for task')
  }
  const adapter = createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl, timeoutMs: WRITEBACK_TIMEOUT_MS })
  const bodies = await adapter.listIssueComments({ token }, { issue_url: task.sourceIssueUrl as string })
  return bodies.includes(body)
}

function recordSuccessfulWriteback(
  db: AppDb,
  task: Task,
  transition: WritebackTransition,
  actorUserId: number | null,
): void {
  insertAuditEvent(db, {
    type: WRITEBACK_EVENT,
    actorUserId,
    details: { task_id: task.publicId, transition, ok: true, issue_url: task.sourceIssueUrl },
  })
}

// Issue #40: records the OUTCOME of a failed attempt (never the token) so the next attempt for the
// same (task_id, transition) knows, without re-deriving it, whether the last failure was DEFINITE
// (`ambiguous: false` — plain repost next time, exactly as before this issue) or AMBIGUOUS
// (`ambiguous: true` — resolve via `listIssueComments` before ever reposting again). Recording an
// outcome for a definite failure too (rather than nothing, as before) is what lets a later definite
// failure supersede an earlier ambiguous one — `latestWritebackOutcome` only ever looks at the most
// recent row, so the check-first behavior never gets stuck on forever after just one ambiguous blip.
//
// Self-guarding: skips the insert when `latestWritebackOutcome` already reports this exact
// (`ok: false`, `ambiguous`) outcome, so an unbroken run of identical failures — the common case,
// since `retryPendingWritebacks` retries forever on every poller tick against a persistently-broken
// forge (down for days, a revoked token) — writes exactly one row for the whole run instead of one
// per tick. `events` growth this way is bounded by real state changes, not by elapsed time; the
// audit timeline `GET /api/v1/events` exposes is never flooded by a stuck write-back.
function recordFailedWriteback(
  db: AppDb,
  task: Task,
  transition: WritebackTransition,
  ambiguous: boolean,
): void {
  const latest = latestWritebackOutcome(db, task.publicId, transition)
  if (latest != null && !latest.ok && latest.ambiguous === ambiguous) return
  insertAuditEvent(db, {
    type: WRITEBACK_EVENT,
    actorUserId: null,
    details: { task_id: task.publicId, transition, ok: false, ambiguous },
  })
}

type WritebackOutcome = { ok: boolean; ambiguous: boolean }

function latestWritebackOutcome(
  db: AppDb,
  publicId: string,
  transition: WritebackTransition,
): WritebackOutcome | undefined {
  const rows = db.select().from(events).where(eq(events.type, WRITEBACK_EVENT)).all()
  let latest: { id: number; outcome: WritebackOutcome } | undefined
  for (const row of rows) {
    const details = parseDetails(row.details)
    if (details?.task_id !== publicId || details?.transition !== transition) continue
    const outcome: WritebackOutcome = { ok: details.ok === true, ambiguous: details.ambiguous === true }
    if (latest == null || row.id > latest.id) latest = { id: row.id, outcome }
  }
  return latest?.outcome
}

// Attempted after the status transition itself is committed — never inside a `db.transaction`,
// never holding a SQLite write lock across the outbound HTTP call. Every failure is swallowed:
// the caller (claimTask / submitPr / applyPrTerminalTransition) has already succeeded and must
// stay that way regardless of what happens here.
//
// Issue #40 dedupe: if the LAST recorded outcome for this (task, transition) was AMBIGUOUS (the
// prior fetch itself rejected — abort/timeout/network — so whether the forge committed the comment
// is unknown), resolve that ambiguity via `listIssueComments` before ever posting again. A DEFINITE
// failure (a real, status-bearing response) never triggers a listing call, keeping the common-path
// cost at zero — this is the same path as before this issue, just now driven by the recorded
// outcome instead of "no event at all means never attempted".
export async function attemptWriteback(
  db: AppDb,
  task: Task,
  transition: WritebackTransition,
  actorUserId: number | null,
  prUrl?: string,
): Promise<void> {
  if (!isImportedWithIssue(task)) return
  // Everything below — including the new #40 bookkeeping reads/writes — stays inside this single
  // outer try/catch so the pre-existing "attemptWriteback never rejects" invariant holds even if a
  // bookkeeping write itself faults (e.g. a caller's db handle already closed): the very scenario
  // `settleWritebacks`'s `Promise.all` would otherwise surface as an unhandled rejection.
  try {
    const body = commentBodyFor(transition, task.publicId, prUrl)

    const latest = latestWritebackOutcome(db, task.publicId, transition)
    if (latest?.ambiguous === true) {
      let alreadyPosted: boolean
      try {
        alreadyPosted = await commentAlreadyPosted(db, task, body)
      } catch {
        // DEGRADATION: listing itself is unavailable. Skip this tick entirely rather than
        // reposting blindly (that would recreate the very duplicate this dedupe exists to
        // prevent) or fabricating a false success. The stored "ambiguous" outcome is left
        // untouched, so the next tick resolves it the exact same way once listing recovers.
        return
      }
      if (alreadyPosted) {
        recordSuccessfulWriteback(db, task, transition, actorUserId)
        return
      }
      // NOT FOUND: fall through and post exactly as today.
    }

    try {
      await postComment(db, task, body)
      recordSuccessfulWriteback(db, task, transition, actorUserId)
    } catch (err) {
      // Non-blocking: retryPendingWritebacks re-attempts later. Which strategy it uses next time
      // (blind repost vs. check-first) is decided by the outcome recorded here.
      // `recordFailedWriteback` self-guards against writing a duplicate row for an unchanged
      // outcome, so it is always safe to call unconditionally here.
      recordFailedWriteback(db, task, transition, !isDefiniteFailure(err))
    }
  } catch {
    // Non-blocking: retryPendingWritebacks re-attempts later based on the recorded outcome (or
    // its absence) for this (task_id, transition).
  }
}

// Issue #36: claim.ts's 认领 write-back leaves the response path — it must never delay or fail the
// claim response, so it is fired here without being awaited by the caller. `attemptWriteback`
// already swallows every fault, so the tracked promise itself never rejects (no unhandled
// rejection risk); `settleWritebacks` below is the only way a caller observes it deterministically.
const pendingWritebacks = new Set<Promise<void>>()

function trackWriteback(promise: Promise<void>): void {
  const tracked = promise.finally(() => {
    pendingWritebacks.delete(tracked)
  })
  pendingWritebacks.add(tracked)
}

export function scheduleWriteback(
  db: AppDb,
  task: Task,
  transition: WritebackTransition,
  actorUserId: number | null,
  prUrl?: string,
): void {
  trackWriteback(attemptWriteback(db, task, transition, actorUserId, prUrl))
}

// Lets a test (or any caller) wait for every currently in-flight background write-back to settle
// deterministically instead of racing a real timer. Keeps draining until the set is empty, in
// case awaiting the current batch let a caller schedule another before this returns.
export async function settleWritebacks(): Promise<void> {
  while (pendingWritebacks.size > 0) {
    await Promise.all(pendingWritebacks)
  }
}

function parseDetails(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function hasSuccessfulWriteback(db: AppDb, publicId: string, transition: WritebackTransition): boolean {
  const rows = db.select().from(events).where(eq(events.type, WRITEBACK_EVENT)).all()
  return rows.some((row) => {
    const details = parseDetails(row.details)
    return details?.task_id === publicId && details?.transition === transition && details?.ok === true
  })
}

function claimOccurred(db: AppDb, publicId: string): boolean {
  const rows = db.select().from(events).where(eq(events.type, STATUS_TRANSITION_EVENT)).all()
  return rows.some((row) => {
    const details = parseDetails(row.details)
    return details?.task_id === publicId && details?.to === IN_PROGRESS_STATUS
  })
}

function latestSubmissionRow(db: AppDb, taskId: number) {
  return db
    .select()
    .from(submissions)
    .where(eq(submissions.taskId, taskId))
    .orderBy(desc(submissions.id))
    .limit(1)
    .get()
}

async function retryTaskWritebacks(db: AppDb, task: Task): Promise<void> {
  if (!isImportedWithIssue(task)) return

  if (claimOccurred(db, task.publicId) && !hasSuccessfulWriteback(db, task.publicId, '认领')) {
    await attemptWriteback(db, task, '认领', null)
  }

  const submission = latestSubmissionRow(db, task.id)
  if (submission != null && !hasSuccessfulWriteback(db, task.publicId, '提交PR')) {
    await attemptWriteback(db, task, '提交PR', null, submission.prUrl)
  }

  if (task.status === COMPLETED_STATUS && !hasSuccessfulWriteback(db, task.publicId, '完成')) {
    const prUrl = submission?.prUrl
    if (prUrl != null) {
      await attemptWriteback(db, task, '完成', null, prUrl)
    }
  }
}

// Must never reject — driven both by direct test calls and by the same `setInterval` tick that
// drives `pollPendingReviews` (see app.ts). An empty database (no imported tasks) is a no-op.
export async function retryPendingWritebacks(db: AppDb): Promise<void> {
  let importedTasks: Task[]
  try {
    importedTasks = db.select().from(tasks).where(eq(tasks.sourceType, 'imported')).all()
  } catch {
    return
  }
  for (const task of importedTasks) {
    try {
      await retryTaskWritebacks(db, task)
    } catch {
      // Isolate: one task's fault must not abort the retry sweep for the rest.
    }
  }
}
