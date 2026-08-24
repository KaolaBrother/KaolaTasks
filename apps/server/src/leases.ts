import { transitionTaskStatus } from '@kaola/shared'
import type { TaskStatus } from '@kaola/shared'
import { and, eq, lte } from 'drizzle-orm'
import type { AppDb } from './db.ts'
import { type Lease, leases, tasks } from './schema.ts'
import { insertAuditEvent } from './vault.ts'

export const LEASE_TTL_SECONDS = 86400
const STATUS_TRANSITION_EVENT = '状态迁移'

export function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

export function selectActiveLease(db: AppDb, taskId: number): Lease | undefined {
  return db
    .select()
    .from(leases)
    .where(and(eq(leases.taskId, taskId), eq(leases.state, 'active')))
    .get()
}

export function insertActiveLease(
  db: AppDb,
  input: {
    taskId: number
    claimerUserId: number | null
    claimerClaimantId: number | null
    deviceId: number
    now: number
  },
): Lease {
  const expiresAt = input.now + LEASE_TTL_SECONDS
  const inserted = db
    .insert(leases)
    .values({
      taskId: input.taskId,
      claimerUserId: input.claimerUserId,
      claimerClaimantId: input.claimerClaimantId,
      deviceId: input.deviceId,
      agentKeyId: null,
      claimedAt: input.now,
      expiresAt,
      lastHeartbeat: input.now,
      state: 'active',
    })
    .returning()
    .get()
  if (inserted == null) {
    throw new Error('failed to insert lease')
  }
  return inserted
}

export function renewActiveLease(db: AppDb, leaseId: number, now: number): number {
  const expiresAt = now + LEASE_TTL_SECONDS
  db.update(leases)
    .set({ lastHeartbeat: now, expiresAt })
    .where(and(eq(leases.id, leaseId), eq(leases.state, 'active')))
    .run()
  return expiresAt
}

export function markLeaseReleased(db: AppDb, leaseId: number): void {
  db.update(leases).set({ state: 'released' }).where(eq(leases.id, leaseId)).run()
}

export function sweepExpiredLeases(db: AppDb): void {
  const now = unixNow()
  const expired = db
    .select()
    .from(leases)
    .where(and(eq(leases.state, 'active'), lte(leases.expiresAt, now)))
    .all()

  for (const lease of expired) {
    db.update(leases).set({ state: 'expired' }).where(eq(leases.id, lease.id)).run()
    const task = db.select().from(tasks).where(eq(tasks.id, lease.taskId)).get()
    if (task == null || task.status !== '进行中') continue
    const to = transitionTaskStatus(task.status, '待认领') as TaskStatus
    db.update(tasks).set({ status: to }).where(eq(tasks.id, task.id)).run()
    insertAuditEvent(db, {
      type: STATUS_TRANSITION_EVENT,
      actorUserId: null,
      details: { task_id: task.publicId, from: '进行中', to: '待认领' },
    })
  }
}
