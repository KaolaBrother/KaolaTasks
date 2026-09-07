import { createForgeAdapter } from '@kaola/forge-adapters'
import type { ForgeKind, PrStatus } from '@kaola/forge-adapters'
import { transitionTaskStatus } from '@kaola/shared'
import type { TaskStatus } from '@kaola/shared'
import { desc, eq } from 'drizzle-orm'
import type { AppDb } from './db.ts'
import { unixNow } from './leases.ts'
import { type Task, submissions, tasks } from './schema.ts'
import { insertAuditEvent } from './vault.ts'
import { attemptWriteback, decryptTaskToken } from './writeback.ts'

// Issue #14: `retryPendingWritebacks` lives in writeback.ts (which this module already depends
// on for `decryptTaskToken`/`attemptWriteback`) and is re-exported here so callers/tests can
// import it alongside `pollPendingReviews` from a single module, per this file's existing role
// as the poller's public surface.
import { retryPendingWritebacks as retryPendingIssueWritebacks } from './writeback.ts'
import { notifyChildrenParentEnded, restackChildren, retryPendingMarkReady } from './review.ts'
import { publishStreamEvent } from './stream.ts'

// Issue #53: the same poller tick also retries a failed Draft → ready flip (review.ts).
export async function retryPendingWritebacks(db: AppDb): Promise<void> {
  await retryPendingIssueWritebacks(db)
  await retryPendingMarkReady(db)
}

// Issue #11: the only driver of 待验收→已完成/已退回. Runs on-demand (tests call it directly) or on
// a `buildApp({ pollIntervalMs })` timer (see app.ts). Mirrors `sweepExpiredLeases`'s pattern for
// system-driven transitions: write the new status, then a `状态迁移` event with `actorUserId: null`.

// Issue #53 (§17): the poller watches every task that holds an open PR — 待验收 (ball with the
// reviewer), 待修改 (ball with the Agent), 待合并 (approved in Kaola, waiting for the human merge).
export const OPEN_PR_STATUSES: ReadonlySet<string> = new Set(['待验收', '待修改', '待合并'])
const STATUS_TRANSITION_EVENT = '状态迁移'

// Issue #13: `buildApp({ forgeInstances })` config. `pollPendingReviews` skips a task whose
// `(repoForge, repoBaseUrl)` exactly matches a `syncMode: 'webhook'` instance — that repo's
// terminal transitions arrive over `POST /api/v1/webhooks/:publicId` instead (see webhook.ts).
// The same shape also carries the secret the webhook receiver verifies deliveries against.
export type ForgeInstanceConfig = {
  publicId: string
  forge: ForgeKind
  baseUrl: string
  syncMode: 'webhook' | 'poll'
  webhookSecret: string
}

// Shared by `isWebhookManaged` (below) and the webhook receiver (webhook.ts): the same
// (forge, base_url) equality binds a task to the one signature-verified instance a delivery
// arrived on, so a task can never be advanced by an instance it does not belong to.
export function taskMatchesForgeInstance(
  task: Task,
  instance: Pick<ForgeInstanceConfig, 'forge' | 'baseUrl'>,
): boolean {
  return instance.forge === task.repoForge && instance.baseUrl === task.repoBaseUrl
}

function isWebhookManaged(task: Task, forgeInstances: ForgeInstanceConfig[] | undefined): boolean {
  if (forgeInstances == null) return false
  return forgeInstances.some(
    (instance) => instance.syncMode === 'webhook' && taskMatchesForgeInstance(task, instance),
  )
}

export function latestSubmission(db: AppDb, taskId: number) {
  return db
    .select()
    .from(submissions)
    .where(eq(submissions.taskId, taskId))
    .orderBy(desc(submissions.id))
    .limit(1)
    .get()
}

// Shared by the poller (below) and the webhook receiver (webhook.ts): both drive 待验收 to its
// terminal 已完成/已退回 through the exact same write shape, so the transition itself — not just
// its trigger — stays in one place. The webhook path never decrypts a token or calls
// `getPullRequest`; it calls this directly off the payload's own merged/closed verdict.
//
// Issue #14: once the transaction is committed, a `merged` terminal additionally attempts a 完成
// write-back comment on the source Issue (imported tasks only) — never on `closed` (已退回), and
// never inside the transaction above (no SQLite write lock held across the outbound HTTP call).
// Issue #53: `merged` only completes a task Kaola already approved (待合并 → 已完成). A merge
// observed while the task is still 待验收 / 待修改 is not a legal edge (§5) and is left untouched
// — the human merged something Kaola never passed; the board keeps showing the truth. `closed`
// returns the task from any of the three open-PR states. Returns whether anything was written.
export function prTerminalTarget(status: string, terminal: 'merged' | 'closed'): TaskStatus | undefined {
  if (!OPEN_PR_STATUSES.has(status)) return undefined
  if (terminal === 'closed') return '已退回'
  return status === '待合并' ? '已完成' : undefined
}

export async function applyPrTerminalTransition(
  db: AppDb,
  task: Task,
  submissionId: number,
  terminal: 'merged' | 'closed',
  prUrl: string,
): Promise<boolean> {
  const from = task.status as TaskStatus
  const toChinese = prTerminalTarget(from, terminal)
  if (toChinese == null) return false
  const to = transitionTaskStatus(from, toChinese) as TaskStatus
  const prState = terminal === 'merged' ? 'merged' : 'closed'

  // One transaction so a fault between the two updates and the audit insert cannot leave a task
  // advanced to 已完成/已退回 with no 状态迁移 event recording it.
  db.transaction((tx) => {
    tx.update(tasks).set({ status: to }).where(eq(tasks.id, task.id)).run()
    tx.update(submissions).set({ prState }).where(eq(submissions.id, submissionId)).run()
    insertAuditEvent(tx, {
      type: STATUS_TRANSITION_EVENT,
      actorUserId: null,
      details: { task_id: task.publicId, from, to, pr_url: prUrl },
    })
  })

  const updated: Task = { ...task, status: to }
  publishStreamEvent('task_updated', { task_id: task.publicId, status: to })

  if (terminal === 'merged') {
    // Issue #53 (§17.4): children stack on this task; tell them the base moved.
    restackChildren(db, updated, prUrl)
    await attemptWriteback(db, task, '完成', null, prUrl)
  } else {
    notifyChildrenParentEnded(db, updated)
  }
  return true
}

async function fetchPrStatus(db: AppDb, task: Task, prUrl: string): Promise<PrStatus | undefined> {
  try {
    const token = decryptTaskToken(db, task)
    if (token == null) return undefined
    const adapter = createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl })
    return await adapter.getPullRequest({ token }, prUrl)
  } catch {
    return undefined
  }
}

// Issue #53: the poller's first look at a PR backfills head_sha / head_branch / is_draft on the
// submission when they are still unknown (an Agent that omitted head_sha, or a legacy row).
function backfillSubmissionHead(db: AppDb, submissionId: number, status: PrStatus): void {
  const row = db.select().from(submissions).where(eq(submissions.id, submissionId)).get()
  if (row == null) return
  const patch: Partial<{ headSha: string; headBranch: string; isDraft: boolean }> = {}
  if (row.headSha == null && status.head_sha !== '') patch.headSha = status.head_sha
  if (row.headBranch == null && status.head_branch !== '') patch.headBranch = status.head_branch
  if (row.isDraft !== status.draft) patch.isDraft = status.draft
  if (Object.keys(patch).length === 0) return
  db.update(submissions).set(patch).where(eq(submissions.id, submissionId)).run()
}

// Issue #54 (§17.7): every tick (not just the first) records the forge head this tick observed —
// overwriting, unlike `backfillSubmissionHead`'s NULL-only `head_sha`. An empty observed head
// (forge omitted it) is never recorded. Returns whether the observed value differs from the
// previously stored one, so the caller can decide whether a `task_updated` frame is warranted.
function recordForgeHeadObservation(db: AppDb, submissionId: number, status: PrStatus): boolean {
  if (status.head_sha === '') return false
  const row = db.select({ forgeHeadSha: submissions.forgeHeadSha }).from(submissions).where(eq(submissions.id, submissionId)).get()
  if (row == null) return false
  const changed = row.forgeHeadSha !== status.head_sha
  db.update(submissions)
    .set({ forgeHeadSha: status.head_sha, forgeHeadSeenAt: unixNow() })
    .where(eq(submissions.id, submissionId))
    .run()
  return changed
}

async function pollOneTask(db: AppDb, task: Task): Promise<void> {
  const submission = latestSubmission(db, task.id)
  if (submission == null) return

  const status = await fetchPrStatus(db, task, submission.prUrl)
  if (status == null) return
  backfillSubmissionHead(db, submission.id, status)
  const headChanged = recordForgeHeadObservation(db, submission.id, status)
  if (headChanged) publishStreamEvent('task_updated', { task_id: task.publicId, status: task.status })
  if (status.state === 'open') return

  await applyPrTerminalTransition(db, task, submission.id, status.state, submission.prUrl)
}

// Must never reject: this drives a `setInterval` (see app.ts), and an unhandled rejection there
// would take down the whole process under Node's default `--unhandled-rejections=throw`. Every
// fault — the initial select or any single task's write phase — is caught and skips only the
// affected row so the rest of the pending set still gets polled.
//
// Issue #13: `forgeInstances` (omitted or `[]` = poll every 待验收 row, same as before) lets a
// `syncMode: 'webhook'` instance opt its repo out of polling — that instance's tasks are advanced
// by the webhook receiver (webhook.ts) instead.
export async function pollPendingReviews(
  db: AppDb,
  forgeInstances?: ForgeInstanceConfig[],
): Promise<void> {
  let pending: Task[]
  try {
    pending = db.select().from(tasks).all().filter((task) => OPEN_PR_STATUSES.has(task.status))
  } catch {
    return
  }
  for (const task of pending) {
    if (isWebhookManaged(task, forgeInstances)) continue
    try {
      await pollOneTask(db, task)
    } catch {
      // Skip this row; a DB or forge fault here must not abort polling the rest of the set.
    }
  }
}
