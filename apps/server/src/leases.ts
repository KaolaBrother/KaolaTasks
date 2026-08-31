import { createHash } from 'node:crypto'
import { transitionTaskStatus } from '@kaola/shared'
import type { TaskStatus } from '@kaola/shared'
import { and, eq, lte } from 'drizzle-orm'
import type { AppDb } from './db.ts'
import { type Lease, leases, tasks } from './schema.ts'
import { insertAuditEvent } from './vault.ts'

export const LEASE_TTL_SECONDS = 86400
const STATUS_TRANSITION_EVENT = '状态迁移'
const CLAIM_ID_PREFIX = 'clm_'
// 32 base64url characters off a sha256 digest is 192 bits of the hash — collision-proof for this
// purpose while staying short as an opaque public token.
const CLAIM_ID_DIGEST_LENGTH = 32

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

// Issue #36: replay identity lookup — any state (active/released/expired), keyed on the pair the
// contract pins as the idempotency key. A different device presenting the same request_id must
// never match, hence device_id is part of the predicate rather than request_id alone.
export function selectLeaseByDeviceRequest(
  db: AppDb,
  deviceId: number,
  requestId: string,
): Lease | undefined {
  return db
    .select()
    .from(leases)
    .where(and(eq(leases.deviceId, deviceId), eq(leases.requestId, requestId)))
    .get()
}

// Structural subset of `AppDb` so callers running inside `db.transaction(...)` can pass the
// transaction handle, matching `insertAuditEvent`'s `AuditEventWriter` pattern (vault.ts).
type LeaseInsertWriter = { insert: AppDb['insert'] }

export function insertActiveLease(
  db: LeaseInsertWriter,
  input: {
    taskId: number
    claimerUserId: number | null
    claimerClaimantId: number | null
    deviceId: number
    now: number
    requestId?: string | null
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
      requestId: input.requestId ?? null,
    })
    .returning()
    .get()
  if (inserted == null) {
    throw new Error('failed to insert lease')
  }
  return inserted
}

type ClaimIdentityFields = Pick<
  Lease,
  'id' | 'taskId' | 'deviceId' | 'claimedAt' | 'requestId' | 'claimerUserId' | 'claimerClaimantId'
>

// Length-prefixed so no field's own content (a request_id that happens to contain whatever
// separator we'd otherwise pick) can shift the hash into colliding with a different lease's.
function encodeClaimIdentityField(value: string | number | null): string {
  const raw = value == null ? '' : String(value)
  return `${raw.length}:${raw}`
}

// ADR-0030 / Issue #36: claim_id is DERIVED, never stored — an opaque public encoding of the
// lease row's immutable identity. Only fields that can never change across a heartbeat or a
// terminal transition may participate here (never state / expiresAt / lastHeartbeat).
export function claimIdForLease(lease: ClaimIdentityFields): string {
  const material = [
    lease.id,
    lease.taskId,
    lease.deviceId,
    lease.claimedAt,
    lease.requestId,
    lease.claimerUserId,
    lease.claimerClaimantId,
  ]
    .map(encodeClaimIdentityField)
    .join('')
  const digest = createHash('sha256').update(material).digest('base64url')
  return `${CLAIM_ID_PREFIX}${digest.slice(0, CLAIM_ID_DIGEST_LENGTH)}`
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
