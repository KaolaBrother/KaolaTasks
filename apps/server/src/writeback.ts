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

async function postComment(db: AppDb, task: Task, body: string): Promise<void> {
  const token = decryptTaskToken(db, task)
  if (token == null) {
    throw new Error('writeback: no forge credential available for task')
  }
  const adapter = createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl })
  await adapter.commentOnIssue({ token }, { issue_url: task.sourceIssueUrl as string }, body)
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

// Attempted after the status transition itself is committed — never inside a `db.transaction`,
// never holding a SQLite write lock across the outbound HTTP call. Every failure is swallowed:
// the caller (claimTask / submitPr / applyPrTerminalTransition) has already succeeded and must
// stay that way regardless of what happens here.
export async function attemptWriteback(
  db: AppDb,
  task: Task,
  transition: WritebackTransition,
  actorUserId: number | null,
  prUrl?: string,
): Promise<void> {
  if (!isImportedWithIssue(task)) return
  try {
    const body = commentBodyFor(transition, task.publicId, prUrl)
    await postComment(db, task, body)
    recordSuccessfulWriteback(db, task, transition, actorUserId)
  } catch {
    // Non-blocking: retryPendingWritebacks re-attempts later based on the absence of a
    // successful 回写 event for this (task_id, transition).
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
