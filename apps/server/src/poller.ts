import { createForgeAdapter } from '@kaola/forge-adapters'
import type { PrStatus } from '@kaola/forge-adapters'
import { transitionTaskStatus } from '@kaola/shared'
import type { TaskStatus } from '@kaola/shared'
import { desc, eq } from 'drizzle-orm'
import type { AppDb } from './db.ts'
import { type Task, credentialProfiles, submissions, tasks } from './schema.ts'
import { decryptToken, insertAuditEvent } from './vault.ts'

// Issue #11: the only driver of 待验收→已完成/已退回. Runs on-demand (tests call it directly) or on
// a `buildApp({ pollIntervalMs })` timer (see app.ts). Mirrors `sweepExpiredLeases`'s pattern for
// system-driven transitions: write the new status, then a `状态迁移` event with `actorUserId: null`.

const PENDING_REVIEW_STATUS = '待验收'
const STATUS_TRANSITION_EVENT = '状态迁移'

function latestSubmission(db: AppDb, taskId: number) {
  return db
    .select()
    .from(submissions)
    .where(eq(submissions.taskId, taskId))
    .orderBy(desc(submissions.id))
    .limit(1)
    .get()
}

// Same branch as `claimTask`'s credential resolution, except any failure here (vault
// unconfigured, missing profile, corrupt ciphertext) skips this row rather than throwing out of
// the poll loop — there is no HTTP request to fail on the poller's behalf.
function decryptTaskToken(db: AppDb, task: Task): string | undefined {
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

async function pollOneTask(db: AppDb, task: Task): Promise<void> {
  const submission = latestSubmission(db, task.id)
  if (submission == null) return

  const status = await fetchPrStatus(db, task, submission.prUrl)
  if (status == null || status.state === 'open') return

  const from = task.status as TaskStatus
  const toChinese = status.state === 'merged' ? '已完成' : '已退回'
  const to = transitionTaskStatus(from, toChinese) as TaskStatus
  const prState = status.state === 'merged' ? 'merged' : 'closed'

  // One transaction so a fault between the two updates and the audit insert cannot leave a task
  // advanced to 已完成/已退回 with no 状态迁移 event recording it.
  db.transaction((tx) => {
    tx.update(tasks).set({ status: to }).where(eq(tasks.id, task.id)).run()
    tx.update(submissions).set({ prState }).where(eq(submissions.id, submission.id)).run()
    insertAuditEvent(tx, {
      type: STATUS_TRANSITION_EVENT,
      actorUserId: null,
      details: { task_id: task.publicId, from, to, pr_url: submission.prUrl },
    })
  })
}

// Must never reject: this drives a `setInterval` (see app.ts), and an unhandled rejection there
// would take down the whole process under Node's default `--unhandled-rejections=throw`. Every
// fault — the initial select or any single task's write phase — is caught and skips only the
// affected row so the rest of the pending set still gets polled.
export async function pollPendingReviews(db: AppDb): Promise<void> {
  let pending: Task[]
  try {
    pending = db.select().from(tasks).where(eq(tasks.status, PENDING_REVIEW_STATUS)).all()
  } catch {
    return
  }
  for (const task of pending) {
    try {
      await pollOneTask(db, task)
    } catch {
      // Skip this row; a DB or forge fault here must not abort polling the rest of the set.
    }
  }
}
