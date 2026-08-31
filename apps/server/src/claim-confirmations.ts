import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getSessionUser, sendUnauthorized } from './auth.ts'
import type { AppDb } from './db.ts'
import { canManageInstance } from './permissions.ts'
import { unixNow } from './leases.ts'
import { type ClaimConfirmation, claimConfirmations, tasks } from './schema.ts'
import { insertAuditEvent } from './vault.ts'

const PENDING_STATUS = '待批准'
export const PENDING_CONFIRM_EVENT = '认领待确认'
export const CONFIRM_APPROVED_EVENT = '认领已确认'
export const CONFIRMATION_REQUIRED_MESSAGE =
  '该任务的自动认领需要你先在网页端确认，请到「待确认认领」列表批准或拒绝。'

export type ClaimConfirmationLookup = {
  pending?: ClaimConfirmation
  approved?: ClaimConfirmation
}

// Issue #16: the pending/approved rows for one (task, user, agent_key) triple — the choke point
// that decides whether an autonomous claim parks, consumes a prior approval, or throughs.
export function findClaimConfirmations(
  db: AppDb,
  taskId: number,
  userId: number,
  deviceId: number,
): ClaimConfirmationLookup {
  const rows = db
    .select()
    .from(claimConfirmations)
    .where(
      and(
        eq(claimConfirmations.taskId, taskId),
        eq(claimConfirmations.userId, userId),
        eq(claimConfirmations.deviceId, deviceId),
      ),
    )
    .all()
  return {
    pending: rows.find((row) => row.state === 'pending'),
    approved: rows.find((row) => row.state === 'approved'),
  }
}

export function insertPendingConfirmation(
  db: AppDb,
  input: { taskId: number; userId: number; deviceId: number },
): ClaimConfirmation {
  const inserted = db
    .insert(claimConfirmations)
    .values({
      taskId: input.taskId,
      userId: input.userId,
      deviceId: input.deviceId,
      agentKeyId: null,
      state: 'pending',
      createdAt: unixNow(),
    })
    .returning()
    .get()
  if (inserted == null) {
    throw new Error('failed to insert claim confirmation')
  }
  return inserted
}

// Structural subset of `AppDb` so callers running inside `db.transaction(...)` can pass the
// transaction handle, matching `insertAuditEvent`'s `AuditEventWriter` pattern (vault.ts).
type ClaimConfirmationDeleter = { delete: AppDb['delete'] }

// A consumed approval must never match again (a later release + re-claim must 202, not 201), so
// consuming means removing the row rather than flipping it to some other terminal state.
export function consumeApprovedConfirmation(db: ClaimConfirmationDeleter, id: number): void {
  db.delete(claimConfirmations).where(eq(claimConfirmations.id, id)).run()
}

export function recordPendingConfirmEvent(
  db: AppDb,
  input: {
    actorUserId: number
    publicId: string
    deviceId: number
    // Issue #36: only recorded when the parking claim attempt carried a request_id, so a legacy
    // (no request_id) park keeps its exact original `{ task_id, device_id }` details shape — this
    // lets a later same-request_id attempt with a mismatched digest be refused before any lease
    // even exists (claim.ts's findPendingConfirmDigest reads it back the same way
    // findOriginalRevealDigest reads a lease's 揭示 event).
    requestId?: string
    autonomous?: boolean
  },
): void {
  insertAuditEvent(db, {
    type: PENDING_CONFIRM_EVENT,
    actorUserId: input.actorUserId,
    details: {
      task_id: input.publicId,
      device_id: input.deviceId,
      ...(input.requestId != null
        ? { request_id: input.requestId, autonomous: input.autonomous === true }
        : {}),
    },
  })
}

export function pendingConfirmationBody(): { error: 'confirmation_required'; message: string; pending: true } {
  return { error: 'confirmation_required', message: CONFIRMATION_REQUIRED_MESSAGE, pending: true }
}

function parsePositiveInt(raw: string): number | undefined {
  const id = Number.parseInt(raw, 10)
  if (!Number.isInteger(id) || id <= 0) return undefined
  return id
}

// Session-only surface, gated the same way as PUT /api/v1/me/settings: no session or a
// 待批准 session both answer 401, matching the existing sendUnauthorized seam.
function requireActiveSessionUser(db: AppDb, request: FastifyRequest, reply: FastifyReply) {
  const user = getSessionUser(db, request)
  if (user == null || user.status === PENDING_STATUS) {
    sendUnauthorized(request, reply)
    return undefined
  }
  if (!canManageInstance(user)) {
    reply.code(403).send({ error: 'forbidden' })
    return undefined
  }
  return user
}

export function registerClaimConfirmations(app: FastifyInstance, db: AppDb) {
  app.get('/api/v1/claim-confirmations', async (request, reply) => {
    const user = requireActiveSessionUser(db, request, reply)
    if (user == null) return

    const rows = db
      .select({
        id: claimConfirmations.id,
        state: claimConfirmations.state,
        createdAt: claimConfirmations.createdAt,
        publicId: tasks.publicId,
      })
      .from(claimConfirmations)
      .innerJoin(tasks, eq(claimConfirmations.taskId, tasks.id))
      .where(eq(claimConfirmations.userId, user.id))
      .all()

    return reply.send({
      confirmations: rows.map((row) => ({
        id: row.id,
        task_id: row.publicId,
        state: row.state,
        created_at: new Date(row.createdAt * 1000).toISOString(),
      })),
    })
  })

  app.post('/api/v1/claim-confirmations/:id/approve', async (request, reply) => {
    const user = requireActiveSessionUser(db, request, reply)
    if (user == null) return

    const id = parsePositiveInt((request.params as { id: string }).id)
    if (id == null) return reply.code(404).send({ error: 'not_found' })

    const row = db
      .select({ deviceId: claimConfirmations.deviceId, publicId: tasks.publicId })
      .from(claimConfirmations)
      .innerJoin(tasks, eq(claimConfirmations.taskId, tasks.id))
      .where(and(eq(claimConfirmations.id, id), eq(claimConfirmations.userId, user.id)))
      .get()
    if (row == null) return reply.code(404).send({ error: 'not_found' })

    db.update(claimConfirmations).set({ state: 'approved' }).where(eq(claimConfirmations.id, id)).run()
    insertAuditEvent(db, {
      type: CONFIRM_APPROVED_EVENT,
      actorUserId: user.id,
      details: { task_id: row.publicId, device_id: row.deviceId },
    })

    return reply.send({ ok: true })
  })

  app.post('/api/v1/claim-confirmations/:id/reject', async (request, reply) => {
    const user = requireActiveSessionUser(db, request, reply)
    if (user == null) return

    const id = parsePositiveInt((request.params as { id: string }).id)
    if (id == null) return reply.code(404).send({ error: 'not_found' })

    const updated = db
      .update(claimConfirmations)
      .set({ state: 'rejected' })
      .where(and(eq(claimConfirmations.id, id), eq(claimConfirmations.userId, user.id)))
      .returning()
      .get()
    if (updated == null) return reply.code(404).send({ error: 'not_found' })

    return reply.send({ ok: true })
  })
}
