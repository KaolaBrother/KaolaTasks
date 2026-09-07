import { createForgeAdapter } from '@kaola/forge-adapters'
import { discussionMessageKindSchema, transitionTaskStatus } from '@kaola/shared'
import type { DiscussionMessageKind, ReviewRoundKind, ReviewVerdict, TaskStatus } from '@kaola/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getSessionUser, sendUnauthorized } from './auth.ts'
import {
  type AgentPrincipal,
  type AgentServiceResult,
  actorUserId,
  canonicalizePrUrl,
  illegalTransitionMessage,
  resolveActiveLeaseForMutation,
  resolveMutationLease,
} from './claim.ts'
import type { AppDb } from './db.ts'
import { markLeaseReleased, selectActiveLease, sweepExpiredLeases, unixNow } from './leases.ts'
import { canPublish } from './permissions.ts'
import {
  type DiscussionMessage,
  type ReviewRound,
  type Submission,
  type Task,
  type User,
  claimants,
  devices,
  discussionMessages,
  events,
  leases,
  reviewRounds,
  submissionRevisions,
  submissions,
  tasks,
  users,
} from './schema.ts'
import { publishStreamEvent } from './stream.ts'
import { selectTask, taskBrief } from './tasks.ts'
import { insertAuditEvent } from './vault.ts'
import { decryptTaskToken, trackBackgroundWork } from './writeback.ts'

// Issue #53 (DESIGN.md §17): the in-Kaola review loop. Code facts stay on the forge (Draft PR,
// commits, diff, merge); rounds, verdicts, blocking items and "who holds the ball" live here.
// Nothing in this module ever returns, logs, or stores a forge token — the only outbound forge
// calls (Draft → ready, optional summary comment) decrypt server-side, off the response path.

export const REVIEW_MESSAGE_EVENT = '评审消息'
export const REVIEW_ROUND_OPENED_EVENT = '评审开轮'
export const REVIEW_REVISED_EVENT = '评审交回'
export const REVIEW_APPROVED_EVENT = '评审通过'
export const REVIEW_WITHDRAWN_EVENT = '评审撤回'
export const REVIEW_TERMINATED_EVENT = '评审终止'
export const RESTACK_EVENT = 'restack'
const STATUS_TRANSITION_EVENT = '状态迁移'
const WRITEBACK_EVENT = '回写'
export const MARK_READY_TRANSITION = '翻ready'

const NO_PENDING_MESSAGES_MESSAGE = '没有待提交的评审意见。'
const PARENT_NOT_COMPLETED_MESSAGE = '父任务尚未完成，不能通过子任务。'
const USE_SUBMIT_PR_MESSAGE = '任务尚无首次提交，请先调用 submit_pr。'
const PR_URL_MISMATCH_MESSAGE = 'pr_url 与首次提交的 PR 不一致；一任务一 PR，请在同一 PR 上推送修订。'
const HEAD_SHA_UNCHANGED_MESSAGE = 'head_sha 与上一轮相同，没有新的修订可交回。'
const STALE_CLAIM_MESSAGE = '提交的 claim_id 与当前认领不匹配。'
const NOT_A_CHILD_MESSAGE = '该认领所属任务不是此任务的子任务。'

const REVIEWABLE_STATUSES: ReadonlySet<string> = new Set(['待验收', '待修改', '待合并'])
const PENDING_USER_STATUS = '待批准'
// Size caps (security review R2): bodies are stored, replayed into Review Briefs and Agent
// context, so they are bounded well below Fastify's 1 MiB body limit.
export const MESSAGE_BODY_MAX_CHARS = 20_000
export const REVIEW_ITEMS_MAX = 50
const ANCHOR_FIELD_MAX_CHARS = 2_000
const TERMINATE_FROM_STATUSES: ReadonlySet<string> = new Set(['待验收', '待修改', '待合并'])

export type MessageAnchor = { path?: string; line?: number; head_sha?: string; url?: string }

export type MessageWire = {
  id: number
  round: number | null
  author_kind: DiscussionMessage['authorKind']
  author: string
  kind: DiscussionMessageKind
  body_md: string
  anchor: MessageAnchor | null
  reply_to: number | null
  resolves: number | null
  resolved: boolean
  created_at: string
}

export type ReviewBrief = {
  task_id: string
  pr_url: string | null
  round: number
  kind: ReviewRoundKind
  head_sha: string | null
  base_branch: string
  verdict: ReviewVerdict | null
  blocking: MessageWire[]
  non_blocking: MessageWire[]
  thread: MessageWire[]
  source_trust: 'internal'
}

type RoundWire = {
  round: number
  kind: ReviewRoundKind
  verdict: ReviewVerdict | null
  opened_by: string | null
  opened_by_task_id: string | null
  opened_at: string
  revised_at: string | null
  revision_head_sha: string | null
}

// Structural subsets of `AppDb` so the helpers below work inside `db.transaction(...)` too —
// same pattern as leases.ts / vault.ts.
type Writer = { insert: AppDb['insert']; update: AppDb['update']; select: AppDb['select'] }

function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

function parseAnchor(raw: string | null): MessageAnchor | null {
  if (raw == null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as MessageAnchor
  } catch {
    return null
  }
}

// Strict anchor reader: only the four documented keys, only their documented types. Anything
// else is `undefined` (→ invalid_body); an omitted / null anchor is `null`.
export function readAnchor(value: unknown): MessageAnchor | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const anchor: MessageAnchor = {}
  for (const key of Object.keys(raw)) {
    if (key === 'path' || key === 'head_sha' || key === 'url') {
      if (typeof raw[key] !== 'string' || (raw[key] as string).length > ANCHOR_FIELD_MAX_CHARS) return undefined
      anchor[key] = raw[key] as string
    } else if (key === 'line') {
      if (typeof raw.line !== 'number' || !Number.isInteger(raw.line) || raw.line < 0) return undefined
      anchor.line = raw.line
    } else {
      return undefined
    }
  }
  return anchor
}

export function latestSubmissionFor(db: Pick<AppDb, 'select'>, taskId: number): Submission | undefined {
  return db
    .select()
    .from(submissions)
    .where(eq(submissions.taskId, taskId))
    .orderBy(desc(submissions.id))
    .limit(1)
    .get()
}

function listRounds(db: AppDb, taskId: number): ReviewRound[] {
  return db.select().from(reviewRounds).where(eq(reviewRounds.taskId, taskId)).orderBy(reviewRounds.round).all()
}

function roundRow(db: Pick<AppDb, 'select'>, taskId: number, round: number): ReviewRound | undefined {
  return db
    .select()
    .from(reviewRounds)
    .where(and(eq(reviewRounds.taskId, taskId), eq(reviewRounds.round, round)))
    .get()
}

function listMessages(db: Pick<AppDb, 'select'>, taskId: number): DiscussionMessage[] {
  return db
    .select()
    .from(discussionMessages)
    .where(eq(discussionMessages.taskId, taskId))
    .orderBy(discussionMessages.id)
    .all()
}

function unroundedMessages(db: Pick<AppDb, 'select'>, taskId: number): DiscussionMessage[] {
  return db
    .select()
    .from(discussionMessages)
    .where(and(eq(discussionMessages.taskId, taskId), isNull(discussionMessages.round)))
    .orderBy(discussionMessages.id)
    .all()
}

// Author display names are resolved at read time (never denormalized into the row): reviewer →
// users.username; agent → the device's claimant display name or bound user's username; system /
// forge → fixed labels.
function authorNames(db: AppDb, rows: DiscussionMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  const userIds = new Set<number>()
  const deviceIds = new Set<number>()
  for (const row of rows) {
    if (row.authorUserId != null) userIds.add(row.authorUserId)
    if (row.authorDeviceId != null) deviceIds.add(row.authorDeviceId)
  }
  for (const id of userIds) {
    const user = db.select({ username: users.username }).from(users).where(eq(users.id, id)).get()
    names.set(`u${id}`, user?.username ?? '')
  }
  for (const id of deviceIds) {
    const device = db.select().from(devices).where(eq(devices.id, id)).get()
    let label = ''
    if (device?.claimantId != null) {
      const claimant = db.select().from(claimants).where(eq(claimants.id, device.claimantId)).get()
      label = claimant?.displayName ?? ''
    } else if (device?.userId != null) {
      const user = db.select({ username: users.username }).from(users).where(eq(users.id, device.userId)).get()
      label = user?.username ?? ''
    }
    names.set(`d${id}`, label)
  }
  return names
}

function messageWire(row: DiscussionMessage, names: Map<string, string>, resolvedIds: Set<number>): MessageWire {
  let author = ''
  if (row.authorKind === 'system') author = '系统'
  else if (row.authorKind === 'forge') author = 'forge'
  else if (row.authorUserId != null) author = names.get(`u${row.authorUserId}`) ?? ''
  else if (row.authorDeviceId != null) author = names.get(`d${row.authorDeviceId}`) ?? ''
  return {
    id: row.id,
    round: row.round,
    author_kind: row.authorKind,
    author,
    kind: row.kind,
    body_md: row.bodyMd,
    anchor: parseAnchor(row.anchor),
    reply_to: row.replyToMessageId,
    resolves: row.resolvesMessageId,
    resolved: resolvedIds.has(row.id),
    created_at: isoOf(row.createdAt),
  }
}

function resolvedIdsOf(rows: DiscussionMessage[]): Set<number> {
  const resolved = new Set<number>()
  for (const row of rows) {
    if (row.kind === 'resolution' && row.resolvesMessageId != null) resolved.add(row.resolvesMessageId)
  }
  return resolved
}

function wireMessages(db: AppDb, rows: DiscussionMessage[]): MessageWire[] {
  const names = authorNames(db, rows)
  const resolved = resolvedIdsOf(rows)
  return rows.map((row) => messageWire(row, names, resolved))
}

function roundWire(db: AppDb, row: ReviewRound): RoundWire {
  let openedBy: string | null = null
  if (row.openedByUserId != null) {
    const user = db.select({ username: users.username }).from(users).where(eq(users.id, row.openedByUserId)).get()
    openedBy = user?.username ?? null
  }
  let openedByTaskId: string | null = null
  if (row.openedByTaskId != null) {
    const child = db.select({ publicId: tasks.publicId }).from(tasks).where(eq(tasks.id, row.openedByTaskId)).get()
    openedByTaskId = child?.publicId ?? null
  }
  return {
    round: row.round,
    kind: row.kind,
    verdict: row.verdict,
    opened_by: openedBy,
    opened_by_task_id: openedByTaskId,
    opened_at: isoOf(row.openedAt),
    revised_at: row.revisedAt == null ? null : isoOf(row.revisedAt),
    revision_head_sha: row.revisionHeadSha,
  }
}

// The Review Brief for one round (DESIGN §9 / §17). Round 0 (nothing opened yet) — or the
// current round when it equals 0 — reads the not-yet-rounded messages; a real round reads
// exactly the messages folded into it. `resolved` is computed over the whole task thread so a
// resolution posted in a later round still marks the earlier blocking item.
export function buildReviewBrief(db: AppDb, publicId: string, round?: number): ReviewBrief | undefined {
  const row = selectTask(db, publicId)
  if (row == null) return undefined
  const submission = latestSubmissionFor(db, row.task.id)
  const currentRound = submission?.reviewRound ?? 0
  const targetRound = round ?? currentRound
  if (targetRound < 0 || targetRound > currentRound) return undefined
  const all = listMessages(db, row.task.id)
  const names = authorNames(db, all)
  const resolved = resolvedIdsOf(all)
  const inRound = all.filter((m) => (targetRound === 0 ? m.round == null : m.round === targetRound))
  const thread = inRound.map((m) => messageWire(m, names, resolved))
  const roundRecord = targetRound === 0 ? undefined : roundRow(db, row.task.id, targetRound)
  return {
    task_id: publicId,
    pr_url: submission?.prUrl ?? null,
    round: targetRound,
    kind: roundRecord?.kind ?? 'review',
    head_sha: submission?.headSha ?? null,
    base_branch: row.baseBranch ?? row.task.repoBaseBranch,
    verdict: roundRecord?.verdict ?? null,
    blocking: thread.filter((m) => m.kind === 'blocking'),
    non_blocking: thread.filter((m) => m.kind === 'suggestion' || m.kind === 'question' || m.kind === 'note'),
    thread,
    source_trust: 'internal',
  }
}

type InsertMessageInput = {
  taskId: number
  round: number | null
  authorKind: DiscussionMessage['authorKind']
  authorUserId: number | null
  authorDeviceId: number | null
  kind: DiscussionMessageKind
  bodyMd: string
  anchor: MessageAnchor | null
  replyToMessageId: number | null
  resolvesMessageId: number | null
  now: number
}

function insertMessage(db: Writer, input: InsertMessageInput): DiscussionMessage {
  const inserted = db
    .insert(discussionMessages)
    .values({
      taskId: input.taskId,
      round: input.round,
      authorKind: input.authorKind,
      authorUserId: input.authorUserId,
      authorDeviceId: input.authorDeviceId,
      kind: input.kind,
      bodyMd: input.bodyMd,
      anchor: input.anchor == null ? null : JSON.stringify(input.anchor),
      replyToMessageId: input.replyToMessageId,
      resolvesMessageId: input.resolvesMessageId,
      createdAt: input.now,
    })
    .returning()
    .get()
  if (inserted == null) throw new Error('failed to insert discussion message')
  return inserted
}

// Opens round N+1 on the task's submission, folding every not-yet-rounded message into it.
// Bumps submissions.review_round in the same write set (the caller's transaction).
function openRound(
  db: Writer,
  input: {
    task: Task
    submission: Submission
    kind: ReviewRoundKind
    verdict: ReviewVerdict | null
    openedByUserId: number | null
    openedByTaskId: number | null
    now: number
  },
): ReviewRound {
  const round = input.submission.reviewRound + 1
  const inserted = db
    .insert(reviewRounds)
    .values({
      taskId: input.task.id,
      round,
      kind: input.kind,
      openedByUserId: input.openedByUserId,
      openedByTaskId: input.openedByTaskId,
      verdict: input.verdict,
      openedAt: input.now,
      revisedAt: null,
      revisionHeadSha: null,
    })
    .returning()
    .get()
  if (inserted == null) throw new Error('failed to insert review round')
  db.update(discussionMessages)
    .set({ round })
    .where(and(eq(discussionMessages.taskId, input.task.id), isNull(discussionMessages.round)))
    .run()
  db.update(submissions).set({ reviewRound: round }).where(eq(submissions.id, input.submission.id)).run()
  return inserted
}

function setTaskStatus(db: Writer, task: Task, to: TaskStatus, actorUserId: number | null, extra?: Record<string, unknown>): Task {
  const updated = db.update(tasks).set({ status: to }).where(eq(tasks.id, task.id)).returning().get()
  if (updated == null) throw new Error('failed to update task status')
  insertAuditEvent(db, {
    type: STATUS_TRANSITION_EVENT,
    actorUserId,
    details: { task_id: task.publicId, from: task.status, to, ...(extra ?? {}) },
  })
  return updated
}

function publishTaskUpdated(task: Pick<Task, 'publicId' | 'status'>): void {
  publishStreamEvent('task_updated', { task_id: task.publicId, status: task.status })
}

function publishRound(publicId: string, round: ReviewRound): void {
  publishStreamEvent('review_round', { task_id: publicId, round: round.round, kind: round.kind, verdict: round.verdict })
}

function publishMessage(publicId: string, message: DiscussionMessage): void {
  publishStreamEvent('discussion_message', {
    task_id: publicId,
    message_id: message.id,
    kind: message.kind,
    author_kind: message.authorKind,
  })
}

function reviewBriefOrThrow(db: AppDb, publicId: string): ReviewBrief {
  const brief = buildReviewBrief(db, publicId)
  if (brief == null) throw new Error('task missing after review write')
  return brief
}

function freshTaskBrief(db: AppDb, publicId: string) {
  const fresh = selectTask(db, publicId)
  if (fresh == null) throw new Error('task missing after review write')
  return taskBrief(fresh)
}

// ---------------------------------------------------------------------------------------------
// Message body validation shared by the reviewer REST route and the Agent MCP tool.
// ---------------------------------------------------------------------------------------------

export type MessageInput = {
  bodyMd: string
  kind: DiscussionMessageKind
  anchor: MessageAnchor | null
  replyTo: number | null
  resolves: number | null
}

function readOptionalId(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

export function readMessageInput(body: unknown): MessageInput | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const raw = body as Record<string, unknown>
  if (typeof raw.body_md !== 'string' || raw.body_md.trim() === '' || raw.body_md.length > MESSAGE_BODY_MAX_CHARS) {
    return undefined
  }
  const kind = discussionMessageKindSchema.safeParse(raw.kind)
  if (!kind.success) return undefined
  const anchor = readAnchor(raw.anchor)
  if (anchor === undefined) return undefined
  const replyTo = readOptionalId(raw.reply_to)
  const resolves = readOptionalId(raw.resolves)
  if (replyTo === undefined || resolves === undefined) return undefined
  return { bodyMd: raw.body_md, kind: kind.data, anchor, replyTo, resolves }
}

// `resolves` must name a blocking message of THIS task; `reply_to` must name any message of this
// task. Both are read against the task thread so a cross-task id is refused as invalid_body.
function validateMessageRefs(db: AppDb, taskId: number, input: MessageInput): boolean {
  if (input.resolves != null) {
    const target = db
      .select()
      .from(discussionMessages)
      .where(and(eq(discussionMessages.id, input.resolves), eq(discussionMessages.taskId, taskId)))
      .get()
    if (target == null || target.kind !== 'blocking') return false
  }
  if (input.replyTo != null) {
    const target = db
      .select({ id: discussionMessages.id })
      .from(discussionMessages)
      .where(and(eq(discussionMessages.id, input.replyTo), eq(discussionMessages.taskId, taskId)))
      .get()
    if (target == null) return false
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// Reviewer services (session; canPublish = active admin | full).
// ---------------------------------------------------------------------------------------------

type ReviewerResult<T> = { status: number; body: T | { error: string; message?: string } }

function illegal(from: string, to: string): ReviewerResult<never> {
  return { status: 409, body: { error: 'illegal_transition', message: illegalTransitionMessage(from, to) } }
}

export function getReviewView(db: AppDb, publicId: string) {
  const row = selectTask(db, publicId)
  if (row == null) return undefined
  const submission = latestSubmissionFor(db, row.task.id)
  const current = reviewBriefOrThrow(db, publicId)
  return {
    task_id: publicId,
    status: row.task.status,
    pr_url: submission?.prUrl ?? null,
    head_sha: submission?.headSha ?? null,
    round: submission?.reviewRound ?? 0,
    rounds: listRounds(db, row.task.id).map((r) => roundWire(db, r)),
    messages: wireMessages(db, listMessages(db, row.task.id)),
    current,
  }
}

export function reviewerPostMessage(db: AppDb, user: User, publicId: string, input: MessageInput): ReviewerResult<MessageWire> {
  const row = selectTask(db, publicId)
  if (row == null) return { status: 404, body: { error: 'not_found' } }
  if (!REVIEWABLE_STATUSES.has(row.task.status)) {
    return { status: 409, body: { error: 'illegal_transition', message: `任务状态「${row.task.status}」不接受评审消息。` } }
  }
  if (!validateMessageRefs(db, row.task.id, input)) return { status: 400, body: { error: 'invalid_body' } }
  const now = unixNow()
  const inserted = db.transaction((tx) => {
    const message = insertMessage(tx, {
      taskId: row.task.id,
      round: null,
      authorKind: 'reviewer',
      authorUserId: user.id,
      authorDeviceId: null,
      kind: input.kind,
      bodyMd: input.bodyMd,
      anchor: input.anchor,
      replyToMessageId: input.replyTo,
      resolvesMessageId: input.resolves,
      now,
    })
    insertAuditEvent(tx, {
      type: REVIEW_MESSAGE_EVENT,
      actorUserId: user.id,
      details: { task_id: publicId, message_id: message.id, kind: message.kind },
    })
    return message
  })
  publishMessage(publicId, inserted)
  const all = listMessages(db, row.task.id)
  const wire = messageWire(inserted, authorNames(db, [inserted]), resolvedIdsOf(all))
  return { status: 201, body: wire }
}

export function reviewerSubmitRound(db: AppDb, user: User, publicId: string) {
  const row = selectTask(db, publicId)
  if (row == null) return { status: 404, body: { error: 'not_found' } } as ReviewerResult<never>
  if (row.task.status !== '待验收') return illegal(row.task.status, '待修改')
  const submission = latestSubmissionFor(db, row.task.id)
  if (submission == null) return illegal(row.task.status, '待修改')
  const pending = unroundedMessages(db, row.task.id).filter((m) => m.authorKind === 'reviewer')
  if (pending.length === 0) {
    return { status: 409, body: { error: 'no_pending_messages', message: NO_PENDING_MESSAGES_MESSAGE } } as ReviewerResult<never>
  }
  const hasBlocking = pending.some((m) => m.kind === 'blocking')
  const now = unixNow()
  const outcome = db.transaction((tx) => {
    const round = openRound(tx, {
      task: row.task,
      submission,
      kind: 'review',
      verdict: hasBlocking ? 'changes_requested' : null,
      openedByUserId: user.id,
      openedByTaskId: null,
      now,
    })
    let updated = row.task
    if (hasBlocking) {
      const to = transitionTaskStatus(row.task.status, '待修改') as TaskStatus
      updated = setTaskStatus(tx, row.task, to, user.id, { round: round.round })
    }
    insertAuditEvent(tx, {
      type: REVIEW_ROUND_OPENED_EVENT,
      actorUserId: user.id,
      details: { task_id: publicId, round: round.round, kind: round.kind, verdict: round.verdict },
    })
    return { round, updated }
  })
  publishRound(publicId, outcome.round)
  if (hasBlocking) publishTaskUpdated(outcome.updated)
  return {
    status: 201,
    body: { task: freshTaskBrief(db, publicId), round: roundWire(db, outcome.round), current: reviewBriefOrThrow(db, publicId) },
  }
}

export function reviewerApprove(db: AppDb, user: User, publicId: string) {
  const row = selectTask(db, publicId)
  if (row == null) return { status: 404, body: { error: 'not_found' } } as ReviewerResult<never>
  if (row.task.status !== '待验收') return illegal(row.task.status, '待合并')
  const submission = latestSubmissionFor(db, row.task.id)
  if (submission == null) return illegal(row.task.status, '待合并')
  if (row.task.parentTaskId != null) {
    const parent = db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, row.task.parentTaskId)).get()
    if (parent == null || parent.status !== '已完成') {
      return { status: 409, body: { error: 'parent_not_completed', message: PARENT_NOT_COMPLETED_MESSAGE } } as ReviewerResult<never>
    }
  }
  const now = unixNow()
  const to = transitionTaskStatus(row.task.status, '待合并') as TaskStatus
  const outcome = db.transaction((tx) => {
    const round = openRound(tx, {
      task: row.task,
      submission,
      kind: 'review',
      verdict: 'approved',
      openedByUserId: user.id,
      openedByTaskId: null,
      now,
    })
    const updated = setTaskStatus(tx, row.task, to, user.id, { round: round.round })
    insertAuditEvent(tx, {
      type: REVIEW_APPROVED_EVENT,
      actorUserId: user.id,
      details: { task_id: publicId, round: round.round, pr_url: submission.prUrl },
    })
    return { round, updated }
  })
  publishRound(publicId, outcome.round)
  publishTaskUpdated(outcome.updated)
  // Off the response path — never awaited here (same posture as claim.ts's 认领 write-back).
  scheduleMarkReady(db, outcome.updated, submission.prUrl, outcome.round.round)
  return { status: 200, body: { task: freshTaskBrief(db, publicId), round: roundWire(db, outcome.round) } }
}

export function reviewerWithdraw(db: AppDb, user: User, publicId: string) {
  const row = selectTask(db, publicId)
  if (row == null) return { status: 404, body: { error: 'not_found' } } as ReviewerResult<never>
  if (row.task.status !== '待合并') return illegal(row.task.status, '待修改')
  const submission = latestSubmissionFor(db, row.task.id)
  if (submission == null) return illegal(row.task.status, '待修改')
  const now = unixNow()
  const to = transitionTaskStatus(row.task.status, '待修改') as TaskStatus
  const outcome = db.transaction((tx) => {
    const round = openRound(tx, {
      task: row.task,
      submission,
      kind: 'review',
      verdict: 'withdrawn',
      openedByUserId: user.id,
      openedByTaskId: null,
      now,
    })
    const updated = setTaskStatus(tx, row.task, to, user.id, { round: round.round })
    insertAuditEvent(tx, {
      type: REVIEW_WITHDRAWN_EVENT,
      actorUserId: user.id,
      details: { task_id: publicId, round: round.round },
    })
    return { round, updated }
  })
  publishRound(publicId, outcome.round)
  publishTaskUpdated(outcome.updated)
  return { status: 200, body: { task: freshTaskBrief(db, publicId), round: roundWire(db, outcome.round) } }
}

export function reviewerTerminate(db: AppDb, user: User, publicId: string) {
  const row = selectTask(db, publicId)
  if (row == null) return { status: 404, body: { error: 'not_found' } } as ReviewerResult<never>
  if (!TERMINATE_FROM_STATUSES.has(row.task.status)) return illegal(row.task.status, '已退回')
  const submission = latestSubmissionFor(db, row.task.id)
  if (submission == null) return illegal(row.task.status, '已退回')
  const now = unixNow()
  const to = transitionTaskStatus(row.task.status, '已退回') as TaskStatus
  const outcome = db.transaction((tx) => {
    const round = openRound(tx, {
      task: row.task,
      submission,
      kind: 'review',
      verdict: 'terminated',
      openedByUserId: user.id,
      openedByTaskId: null,
      now,
    })
    const updated = setTaskStatus(tx, row.task, to, user.id, { round: round.round })
    insertAuditEvent(tx, {
      type: REVIEW_TERMINATED_EVENT,
      actorUserId: user.id,
      details: { task_id: publicId, round: round.round },
    })
    return { round, updated }
  })
  publishRound(publicId, outcome.round)
  publishTaskUpdated(outcome.updated)
  notifyChildrenParentEnded(db, outcome.updated)
  return { status: 200, body: { task: freshTaskBrief(db, publicId), round: roundWire(db, outcome.round) } }
}

// ---------------------------------------------------------------------------------------------
// Agent services (device proof; MCP tools).
// ---------------------------------------------------------------------------------------------

export function getReviewFeedback(db: AppDb, publicId: string, round?: number): AgentServiceResult<ReviewBrief> {
  sweepExpiredLeases(db)
  if (round !== undefined && (!Number.isInteger(round) || round < 0)) {
    return { ok: false, httpStatus: 400, body: { error: 'invalid_body' } }
  }
  const brief = buildReviewBrief(db, publicId, round)
  if (brief == null) return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
  return { ok: true, httpStatus: 200, body: brief }
}

export function postDiscussionMessage(
  db: AppDb,
  auth: AgentPrincipal,
  publicId: string,
  claimId: string | undefined,
  input: MessageInput,
): AgentServiceResult<MessageWire> {
  sweepExpiredLeases(db)
  const row = selectTask(db, publicId)
  if (row == null) return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
  const resolved = resolveActiveLeaseForMutation(db, auth, row.task.id, claimId)
  if (!resolved.ok) {
    // An Agent without the task's active lease is a stale Claim, whatever the underlying reason.
    if (resolved.body.error === 'conflict') {
      return { ok: false, httpStatus: 409, body: { error: 'stale_claim', message: STALE_CLAIM_MESSAGE } }
    }
    return resolved
  }
  if (!validateMessageRefs(db, row.task.id, input)) {
    return { ok: false, httpStatus: 400, body: { error: 'invalid_body' } }
  }
  const now = unixNow()
  const inserted = db.transaction((tx) => {
    const message = insertMessage(tx, {
      taskId: row.task.id,
      round: null,
      authorKind: 'agent',
      authorUserId: null,
      authorDeviceId: auth.device.id,
      kind: input.kind,
      bodyMd: input.bodyMd,
      anchor: input.anchor,
      replyToMessageId: input.replyTo,
      resolvesMessageId: input.resolves,
      now,
    })
    insertAuditEvent(tx, {
      type: REVIEW_MESSAGE_EVENT,
      actorUserId: actorUserId(auth),
      details: { task_id: publicId, message_id: message.id, kind: message.kind },
    })
    return message
  })
  publishMessage(publicId, inserted)
  const all = listMessages(db, row.task.id)
  return { ok: true, httpStatus: 201, body: messageWire(inserted, authorNames(db, [inserted]), resolvedIdsOf(all)) }
}

export async function submitRevision(
  db: AppDb,
  auth: AgentPrincipal,
  publicId: string,
  claimId: string | undefined,
  prUrl: string,
  headSha: string,
  summary: string,
): Promise<AgentServiceResult<{ task: ReturnType<typeof taskBrief>; pr_url: string; head_sha: string; round: number }>> {
  sweepExpiredLeases(db)
  const row = selectTask(db, publicId)
  if (row == null) return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
  if (typeof headSha !== 'string' || headSha.trim() === '') {
    return { ok: false, httpStatus: 400, body: { error: 'invalid_body' } }
  }
  const resolved = resolveMutationLease(db, auth, row.task.id, claimId)
  if (!resolved.ok) return resolved
  const { lease, terminal } = resolved.body

  const submission = latestSubmissionFor(db, row.task.id)
  if (submission == null) {
    return { ok: false, httpStatus: 409, body: { error: 'use_submit_pr', message: USE_SUBMIT_PR_MESSAGE } }
  }
  const canonical = canonicalizePrUrl(prUrl)
  if (canonical == null || canonical !== submission.prUrl) {
    return { ok: false, httpStatus: 422, body: { error: 'pr_url_invalid', message: PR_URL_MISMATCH_MESSAGE } }
  }

  if (terminal) {
    // Idempotent repeat: this Claim already handed back exactly this head.
    const existing = db.select().from(submissionRevisions).where(eq(submissionRevisions.leaseId, lease.id)).get()
    if (existing == null) {
      return { ok: false, httpStatus: 409, body: { error: 'stale_claim', message: STALE_CLAIM_MESSAGE } }
    }
    if (existing.headSha !== headSha) {
      return { ok: false, httpStatus: 409, body: { error: 'head_sha_unchanged', message: HEAD_SHA_UNCHANGED_MESSAGE } }
    }
    return {
      ok: true,
      httpStatus: 200,
      body: { task: freshTaskBrief(db, publicId), pr_url: submission.prUrl, head_sha: existing.headSha, round: existing.round },
    }
  }

  if (submission.headSha != null && submission.headSha === headSha) {
    return { ok: false, httpStatus: 409, body: { error: 'head_sha_unchanged', message: HEAD_SHA_UNCHANGED_MESSAGE } }
  }
  if (row.task.status !== '进行中') {
    return { ok: false, httpStatus: 409, body: { error: 'illegal_transition', message: illegalTransitionMessage(row.task.status, '待验收') } }
  }
  const to = transitionTaskStatus(row.task.status, '待验收') as TaskStatus
  const now = unixNow()
  const round = submission.reviewRound
  const updated = db.transaction((tx) => {
    markLeaseReleased(tx, lease.id)
    tx.insert(submissionRevisions)
      .values({ submissionId: submission.id, leaseId: lease.id, round, headSha, summary, submittedAt: now })
      .run()
    tx.update(submissions).set({ headSha }).where(eq(submissions.id, submission.id)).run()
    if (round > 0) {
      tx.update(reviewRounds)
        .set({ revisedAt: now, revisionHeadSha: headSha })
        .where(and(eq(reviewRounds.taskId, row.task.id), eq(reviewRounds.round, round)))
        .run()
    }
    const updatedTask = setTaskStatus(tx, row.task, to, actorUserId(auth), { pr_url: submission.prUrl, head_sha: headSha })
    insertAuditEvent(tx, {
      type: REVIEW_REVISED_EVENT,
      actorUserId: actorUserId(auth),
      details: { task_id: publicId, round, head_sha: headSha },
    })
    return updatedTask
  })
  publishTaskUpdated(updated)
  return {
    ok: true,
    httpStatus: 200,
    body: { task: taskBrief({ ...row, task: updated }), pr_url: submission.prUrl, head_sha: headSha, round },
  }
}

export type ReviewItemInput = { kind: DiscussionMessageKind; bodyMd: string; anchor: MessageAnchor | null }

export function readReviewItems(value: unknown): ReviewItemInput[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > REVIEW_ITEMS_MAX) return undefined
  const items: ReviewItemInput[] = []
  for (const raw of value) {
    if (raw == null || typeof raw !== 'object') return undefined
    const item = raw as Record<string, unknown>
    if (typeof item.body_md !== 'string' || item.body_md.trim() === '' || item.body_md.length > MESSAGE_BODY_MAX_CHARS) {
      return undefined
    }
    const kind = discussionMessageKindSchema.safeParse(item.kind)
    if (!kind.success) return undefined
    const anchor = readAnchor(item.anchor)
    if (anchor === undefined) return undefined
    items.push({ kind: kind.data, bodyMd: item.body_md, anchor })
  }
  return items
}

// Issue #53 §17.4 反向意见: an Agent holding a Claim on a CHILD task opens a round on the parent.
export function openReviewRound(
  db: AppDb,
  auth: AgentPrincipal,
  parentPublicId: string,
  claimId: string | undefined,
  items: ReviewItemInput[],
): AgentServiceResult<{ task: ReturnType<typeof taskBrief>; round: RoundWire | null; current: ReviewBrief }> {
  sweepExpiredLeases(db)
  const parentRow = selectTask(db, parentPublicId)
  if (parentRow == null) return { ok: false, httpStatus: 404, body: { error: 'not_found' } }
  // The caller's Claim: the active lease on whichever task this device+owner holds that names
  // this parent. Find candidate children first, then fence the lease exactly like other tools.
  const children = db.select().from(tasks).where(eq(tasks.parentTaskId, parentRow.task.id)).all()
  let childLease: { taskId: number } | undefined
  for (const child of children) {
    const lease = selectActiveLease(db, child.id)
    if (lease != null && lease.deviceId === auth.device.id) {
      const fenced = resolveActiveLeaseForMutation(db, auth, child.id, claimId)
      if (fenced.ok) {
        childLease = { taskId: child.id }
        break
      }
      return fenced.body.error === 'conflict'
        ? { ok: false, httpStatus: 409, body: { error: 'stale_claim', message: STALE_CLAIM_MESSAGE } }
        : fenced
    }
  }
  if (childLease == null) {
    // Distinguish "this device holds a Claim, just not on a child of this parent" (403) from
    // "no live Claim at all" (409 stale_claim).
    const anyLease = db
      .select()
      .from(leases)
      .where(and(eq(leases.deviceId, auth.device.id), eq(leases.state, 'active')))
      .get()
    if (anyLease != null) {
      return { ok: false, httpStatus: 403, body: { error: 'forbidden', message: NOT_A_CHILD_MESSAGE } }
    }
    return { ok: false, httpStatus: 409, body: { error: 'stale_claim', message: STALE_CLAIM_MESSAGE } }
  }
  const submission = latestSubmissionFor(db, parentRow.task.id)
  const flips = parentRow.task.status === '待验收' && submission != null
  const now = unixNow()
  const outcome = db.transaction((tx) => {
    const inserted: DiscussionMessage[] = []
    for (const item of items) {
      inserted.push(
        insertMessage(tx, {
          taskId: parentRow.task.id,
          round: null,
          authorKind: 'agent',
          authorUserId: null,
          authorDeviceId: auth.device.id,
          kind: item.kind,
          bodyMd: item.bodyMd,
          anchor: item.anchor,
          replyToMessageId: null,
          resolvesMessageId: null,
          now,
        }),
      )
    }
    let round: ReviewRound | undefined
    let updated = parentRow.task
    if (flips && submission != null) {
      round = openRound(tx, {
        task: parentRow.task,
        submission,
        kind: 'downstream_finding',
        verdict: 'changes_requested',
        openedByUserId: null,
        openedByTaskId: childLease.taskId,
        now,
      })
      const to = transitionTaskStatus(parentRow.task.status, '待修改') as TaskStatus
      updated = setTaskStatus(tx, parentRow.task, to, actorUserId(auth), { round: round.round })
      insertAuditEvent(tx, {
        type: REVIEW_ROUND_OPENED_EVENT,
        actorUserId: actorUserId(auth),
        details: { task_id: parentPublicId, round: round.round, kind: round.kind, verdict: round.verdict },
      })
    } else {
      for (const message of inserted) {
        insertAuditEvent(tx, {
          type: REVIEW_MESSAGE_EVENT,
          actorUserId: actorUserId(auth),
          details: { task_id: parentPublicId, message_id: message.id, kind: message.kind },
        })
      }
    }
    return { inserted, round, updated }
  })
  for (const message of outcome.inserted) publishMessage(parentPublicId, message)
  if (outcome.round != null) {
    publishRound(parentPublicId, outcome.round)
    publishTaskUpdated(outcome.updated)
  }
  return {
    ok: true,
    httpStatus: 200,
    body: {
      task: freshTaskBrief(db, parentPublicId),
      round: outcome.round == null ? null : roundWire(db, outcome.round),
      current: reviewBriefOrThrow(db, parentPublicId),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Parent → children automation (§17.4), called by the poller/webhook terminal path and terminate.
// ---------------------------------------------------------------------------------------------

function childrenOf(db: AppDb, parentId: number): Task[] {
  return db.select().from(tasks).where(eq(tasks.parentTaskId, parentId)).orderBy(tasks.id).all()
}

// Parent reached 已完成: every child gets a system message plus a `restack` round; a child in
// 待验收 moves to 待修改 (it must rebase onto the new base before review continues).
export function restackChildren(db: AppDb, parent: Task, parentPrUrl: string | undefined): void {
  const children = childrenOf(db, parent.id)
  for (const child of children) {
    try {
      const submission = latestSubmissionFor(db, child.id)
      const now = unixNow()
      const body =
        `父任务 ${parent.publicId} 已合并，新的基线分支是 \`${parent.repoBaseBranch}\`` +
        (parentPrUrl == null ? '。' : `（父 PR：${parentPrUrl}）。`) +
        '请把本任务分支 rebase 到新基线并解决冲突后再交回。'
      const outcome = db.transaction((tx) => {
        const message = insertMessage(tx, {
          taskId: child.id,
          round: null,
          authorKind: 'system',
          authorUserId: null,
          authorDeviceId: null,
          kind: 'blocking',
          bodyMd: body,
          anchor: null,
          replyToMessageId: null,
          resolvesMessageId: null,
          now,
        })
        let round: ReviewRound | undefined
        let updated = child
        if (submission != null) {
          round = openRound(tx, {
            task: child,
            submission,
            kind: 'restack',
            verdict: 'changes_requested',
            openedByUserId: null,
            openedByTaskId: parent.id,
            now,
          })
          if (child.status === '待验收') {
            const to = transitionTaskStatus(child.status, '待修改') as TaskStatus
            updated = setTaskStatus(tx, child, to, null, { round: round.round })
          }
        }
        insertAuditEvent(tx, {
          type: RESTACK_EVENT,
          actorUserId: null,
          details: {
            task_id: child.publicId,
            parent_task_id: parent.publicId,
            round: round?.round ?? null,
            base_branch: parent.repoBaseBranch,
          },
        })
        return { message, round, updated }
      })
      publishMessage(child.publicId, outcome.message)
      if (outcome.round != null) publishRound(child.publicId, outcome.round)
      if (outcome.updated.status !== child.status) publishTaskUpdated(outcome.updated)
    } catch {
      // One child's fault must not abort the rest; the parent's own transition already committed.
    }
  }
}

// Parent reached 已退回 / 已取消: children get a system notice only; the poster decides.
export function notifyChildrenParentEnded(db: AppDb, parent: Task): void {
  const children = childrenOf(db, parent.id)
  for (const child of children) {
    try {
      const message = insertMessage(db, {
        taskId: child.id,
        round: null,
        authorKind: 'system',
        authorUserId: null,
        authorDeviceId: null,
        kind: 'note',
        bodyMd: `父任务 ${parent.publicId} 已进入「${parent.status}」。本任务状态不变，请发布者决定取消或改选父任务。`,
        anchor: null,
        replyToMessageId: null,
        resolvesMessageId: null,
        now: unixNow(),
      })
      insertAuditEvent(db, {
        type: REVIEW_MESSAGE_EVENT,
        actorUserId: null,
        details: { task_id: child.publicId, message_id: message.id, kind: message.kind },
      })
      publishMessage(child.publicId, message)
    } catch {
      // Isolate per child.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Draft → ready after 「通过」 (§17.2). Same posture as writeback.ts: never blocks the response,
// never rolls the task back, records `回写` outcomes, and is retried by the poller tick.
// ---------------------------------------------------------------------------------------------

const MARK_READY_TIMEOUT_MS = 30_000
const MARK_READY_FAILURE_PATTERN = /^markPullRequestReady: \S+ responded (\d+)$/u
const AMBIGUOUS_STATUS_CODES = new Set([408, 429])

function summaryCommentEnabled(): boolean {
  return process.env.KAOLA_REVIEW_SUMMARY_COMMENT === '1'
}

function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? 'http://localhost:31415').replace(/\/+$/u, '')
}

function parseDetails(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function latestMarkReadyOutcome(db: AppDb, publicId: string): { ok: boolean; ambiguous: boolean } | undefined {
  const rows = db.select().from(events).where(eq(events.type, WRITEBACK_EVENT)).all()
  let latest: { id: number; ok: boolean; ambiguous: boolean } | undefined
  for (const row of rows) {
    const details = parseDetails(row.details)
    if (details?.task_id !== publicId || details?.transition !== MARK_READY_TRANSITION) continue
    if (latest == null || row.id > latest.id) {
      latest = { id: row.id, ok: details.ok === true, ambiguous: details.ambiguous === true }
    }
  }
  return latest == null ? undefined : { ok: latest.ok, ambiguous: latest.ambiguous }
}

function hasApprovalEvent(db: AppDb, publicId: string): boolean {
  const rows = db.select().from(events).where(eq(events.type, REVIEW_APPROVED_EVENT)).all()
  return rows.some((row) => parseDetails(row.details)?.task_id === publicId)
}

function isDefiniteFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const match = MARK_READY_FAILURE_PATTERN.exec(err.message)
  if (match == null) return false
  const status = Number(match[1])
  return status >= 400 && status < 500 && !AMBIGUOUS_STATUS_CODES.has(status)
}

export async function attemptMarkReady(db: AppDb, task: Task, prUrl: string, round: number | null): Promise<void> {
  try {
    const token = decryptTaskToken(db, task)
    if (token == null) throw new Error('markPullRequestReady: no forge credential available for task')
    const adapter = createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl, timeoutMs: MARK_READY_TIMEOUT_MS })
    try {
      await adapter.markPullRequestReady({ token }, prUrl)
    } catch (err) {
      const latest = latestMarkReadyOutcome(db, task.publicId)
      const ambiguous = !isDefiniteFailure(err)
      if (latest == null || latest.ok || latest.ambiguous !== ambiguous) {
        insertAuditEvent(db, {
          type: WRITEBACK_EVENT,
          actorUserId: null,
          details: { task_id: task.publicId, transition: MARK_READY_TRANSITION, ok: false, ambiguous },
        })
      }
      return
    }
    insertAuditEvent(db, {
      type: WRITEBACK_EVENT,
      actorUserId: null,
      details: { task_id: task.publicId, transition: MARK_READY_TRANSITION, ok: true, pr_url: prUrl },
    })
    if (summaryCommentEnabled()) {
      try {
        const rounds = round == null ? '' : `经考拉 ${round} 轮评审`
        await adapter.commentOnPullRequest(
          { token },
          prUrl,
          `考拉任务（Kaola Tasks）任务 ${task.publicId} ${rounds}通过，已标记为可合并。讨论见 ${publicUrl()}`,
        )
      } catch {
        // Optional; never recorded as a failure of the approval itself.
      }
    }
  } catch {
    // Never rejects: the approval already committed.
  }
}

export function scheduleMarkReady(db: AppDb, task: Task, prUrl: string, round: number | null): void {
  trackBackgroundWork(attemptMarkReady(db, task, prUrl, round))
}

// Poller-tick retry: any task that was approved (a 评审通过 event exists) and is still 待合并 or
// already 已完成, with no successful 翻ready outcome yet, is attempted again.
export async function retryPendingMarkReady(db: AppDb): Promise<void> {
  let candidates: Task[]
  try {
    candidates = db.select().from(tasks).all().filter((t) => t.status === '待合并' || t.status === '已完成')
  } catch {
    return
  }
  for (const task of candidates) {
    try {
      if (!hasApprovalEvent(db, task.publicId)) continue
      const latest = latestMarkReadyOutcome(db, task.publicId)
      if (latest?.ok) continue
      const submission = latestSubmissionFor(db, task.id)
      if (submission == null) continue
      await attemptMarkReady(db, task, submission.prUrl, submission.reviewRound)
    } catch {
      // Isolate per task.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// REST (session).
// ---------------------------------------------------------------------------------------------

function requireReviewer(db: AppDb, request: FastifyRequest, reply: FastifyReply): User | undefined {
  const user = getSessionUser(db, request)
  if (user == null) {
    sendUnauthorized(request, reply)
    return undefined
  }
  if (!canPublish(user)) {
    reply.code(403).send({ error: 'forbidden' })
    return undefined
  }
  return user
}

export function registerReview(app: FastifyInstance, db: AppDb) {
  app.get('/api/v1/tasks/:publicId/review', async (request, reply) => {
    // Same population as GET /api/v1/events (security review R1): any active session may read
    // the thread, a 待批准 account may not; writing stays with canPublish below.
    const user = getSessionUser(db, request)
    if (user == null || user.status === PENDING_USER_STATUS) return sendUnauthorized(request, reply)
    sweepExpiredLeases(db)
    const view = getReviewView(db, (request.params as { publicId: string }).publicId)
    if (view == null) return reply.code(404).send({ error: 'not_found' })
    return reply.send(view)
  })

  app.post('/api/v1/tasks/:publicId/review/messages', async (request, reply) => {
    const user = requireReviewer(db, request, reply)
    if (user == null) return
    const input = readMessageInput(request.body)
    if (input == null) return reply.code(400).send({ error: 'invalid_body' })
    const result = reviewerPostMessage(db, user, (request.params as { publicId: string }).publicId, input)
    return reply.code(result.status).send(result.body)
  })

  app.post('/api/v1/tasks/:publicId/review/rounds', async (request, reply) => {
    const user = requireReviewer(db, request, reply)
    if (user == null) return
    sweepExpiredLeases(db)
    const result = reviewerSubmitRound(db, user, (request.params as { publicId: string }).publicId)
    return reply.code(result.status).send(result.body)
  })

  app.post('/api/v1/tasks/:publicId/review/approve', async (request, reply) => {
    const user = requireReviewer(db, request, reply)
    if (user == null) return
    sweepExpiredLeases(db)
    const result = reviewerApprove(db, user, (request.params as { publicId: string }).publicId)
    return reply.code(result.status).send(result.body)
  })

  app.post('/api/v1/tasks/:publicId/review/withdraw', async (request, reply) => {
    const user = requireReviewer(db, request, reply)
    if (user == null) return
    sweepExpiredLeases(db)
    const result = reviewerWithdraw(db, user, (request.params as { publicId: string }).publicId)
    return reply.code(result.status).send(result.body)
  })

  app.post('/api/v1/tasks/:publicId/review/terminate', async (request, reply) => {
    const user = requireReviewer(db, request, reply)
    if (user == null) return
    sweepExpiredLeases(db)
    const result = reviewerTerminate(db, user, (request.params as { publicId: string }).publicId)
    return reply.code(result.status).send(result.body)
  })
}
