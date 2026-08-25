import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getSessionUser, sendUnauthorized } from './auth.ts'
import type { AppDb } from './db.ts'
import { canManageInstance } from './permissions.ts'
import { unixNow } from './leases.ts'
import { type Claimant, type Device, type User, claimants, devices } from './schema.ts'
import { insertAuditEvent } from './vault.ts'

function isoUnix(unix: number | null | undefined): string | null {
  if (unix == null) return null
  return new Date(unix * 1000).toISOString()
}

function parsePositiveInt(raw: string): number | undefined {
  const id = Number.parseInt(raw, 10)
  if (!Number.isInteger(id) || id <= 0) return undefined
  return id
}

function requireFullAdmin(db: AppDb, request: FastifyRequest, reply: FastifyReply): User | undefined {
  const user = getSessionUser(db, request)
  if (user == null) {
    sendUnauthorized(request, reply)
    return undefined
  }
  if (!canManageInstance(user)) {
    reply.code(403).send({ error: 'forbidden' })
    return undefined
  }
  return user
}

function ownerJson(device: Device, claimant: Claimant | undefined): Record<string, unknown> | null {
  if (device.status === 'pending') return null
  if (device.claimantId != null) {
    return {
      kind: 'claimant',
      claimant_id: device.claimantId,
      display_name: claimant?.displayName,
    }
  }
  if (device.userId != null) {
    return { kind: 'user', user_id: device.userId }
  }
  return null
}

function pendingJson(device: Device) {
  return {
    id: device.id,
    hostname: device.hostname,
    fingerprint: device.fingerprint,
    created_at: isoUnix(device.createdAt),
    expires_at: isoUnix(device.pendingExpiresAt),
  }
}

function deviceJson(device: Device, claimant?: Claimant) {
  return {
    id: device.id,
    hostname: device.hostname,
    fingerprint: device.fingerprint,
    status: device.status,
    created_at: isoUnix(device.createdAt),
    paired_at: isoUnix(device.pairedAt),
    expires_at: isoUnix(device.expiresAt ?? device.pendingExpiresAt),
    last_seen: isoUnix(device.lastSeen),
    owner: ownerJson(device, claimant),
  }
}

function readBindBody(
  body: unknown,
):
  | { variant: 'claimant_id'; claimantId: number }
  | { variant: 'claimant_display_name'; displayName: string }
  | { variant: 'bind_to_self' }
  | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const rec = body as Record<string, unknown>
  const keys = ['claimant_id', 'claimant_display_name', 'bind_to_self'].filter((k) => k in rec)
  if (keys.length !== 1) return undefined
  if ('claimant_id' in rec) {
    const id = rec.claimant_id
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return undefined
    return { variant: 'claimant_id', claimantId: id }
  }
  if ('claimant_display_name' in rec) {
    const name = rec.claimant_display_name
    if (typeof name !== 'string') return undefined
    const displayName = name.trim()
    if (displayName === '') return undefined
    return { variant: 'claimant_display_name', displayName }
  }
  if (rec.bind_to_self === true) return { variant: 'bind_to_self' }
  return undefined
}

function readPolicyBody(body: unknown): { deviceMaxAgeDays?: number; maxDevices?: number; deviceIdleDays?: number } | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const rec = body as Record<string, unknown>
  const out: { deviceMaxAgeDays?: number; maxDevices?: number; deviceIdleDays?: number } = {}
  let any = false
  if ('device_max_age_days' in rec) {
    const n = rec.device_max_age_days
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 365) return undefined
    out.deviceMaxAgeDays = n
    any = true
  }
  if ('max_devices' in rec) {
    const n = rec.max_devices
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 50) return undefined
    out.maxDevices = n
    any = true
  }
  if ('device_idle_days' in rec) {
    const n = rec.device_idle_days
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 365) return undefined
    out.deviceIdleDays = n
    any = true
  }
  if (!any) return {}
  return out
}

function countActiveDevices(db: AppDb, owner: { claimantId?: number; userId?: number }): number {
  const rows = db.select().from(devices).all()
  return rows.filter((row) => {
    if (row.status !== 'active') return false
    if (owner.claimantId != null) return row.claimantId === owner.claimantId
    if (owner.userId != null) return row.userId === owner.userId
    return false
  }).length
}

export function registerDevices(app: FastifyInstance, db: AppDb): void {
  app.get('/api/v1/devices/pending', async (request, reply) => {
    const admin = requireFullAdmin(db, request, reply)
    if (admin == null) return
    const now = unixNow()
    const rows = db.select().from(devices).orderBy(desc(devices.id)).all()
    const pending = rows.filter(
      (row) =>
        row.status === 'pending' &&
        (row.pendingExpiresAt == null || row.pendingExpiresAt > now),
    )
    return reply.send({ devices: pending.map(pendingJson) })
  })

  app.get('/api/v1/devices', async (request, reply) => {
    const admin = requireFullAdmin(db, request, reply)
    if (admin == null) return
    const rows = db.select().from(devices).orderBy(desc(devices.id)).all()
    const claimantRows = db.select().from(claimants).all()
    const byId = new Map(claimantRows.map((c) => [c.id, c]))
    return reply.send({
      devices: rows.map((row) => deviceJson(row, row.claimantId != null ? byId.get(row.claimantId) : undefined)),
    })
  })

  app.get('/api/v1/me/devices', async (request, reply) => {
    const admin = requireFullAdmin(db, request, reply)
    if (admin == null) return
    const rows = db
      .select()
      .from(devices)
      .where(eq(devices.userId, admin.id))
      .orderBy(desc(devices.id))
      .all()
    return reply.send({ devices: rows.map((row) => deviceJson(row)) })
  })

  app.post('/api/v1/devices/:id/bind', async (request, reply) => {
    const admin = requireFullAdmin(db, request, reply)
    if (admin == null) return
    const id = parsePositiveInt((request.params as { id: string }).id)
    if (id == null) return reply.code(404).send({ error: 'not_found' })
    const bind = readBindBody(request.body)
    if (bind == null) return reply.code(400).send({ error: 'invalid_body' })

    const device = db.select().from(devices).where(eq(devices.id, id)).get()
    const now = unixNow()
    if (
      device == null ||
      device.status !== 'pending' ||
      (device.pendingExpiresAt != null && device.pendingExpiresAt <= now)
    ) {
      return reply.code(409).send({
        error: 'conflict',
        message: '电脑申请已过期或不在待授权状态。',
      })
    }

    let claimantId: number | null = null
    let userId: number | null = null
    let maxAgeDays = 30
    let maxDevices = 5
    let ownerPayload: Record<string, unknown>

    if (bind.variant === 'bind_to_self') {
      userId = admin.id
      maxAgeDays = admin.deviceMaxAgeDays
      maxDevices = admin.maxDevices
      if (countActiveDevices(db, { userId }) >= maxDevices) {
        return reply.code(409).send({ error: 'conflict', message: '已达该身份的电脑台数上限。' })
      }
      ownerPayload = { kind: 'user', user_id: admin.id }
    } else if (bind.variant === 'claimant_id') {
      const claimant = db.select().from(claimants).where(eq(claimants.id, bind.claimantId)).get()
      if (claimant == null || claimant.status !== 'active') {
        return reply.code(404).send({ error: 'not_found' })
      }
      claimantId = claimant.id
      maxAgeDays = claimant.deviceMaxAgeDays
      maxDevices = claimant.maxDevices
      if (countActiveDevices(db, { claimantId }) >= maxDevices) {
        return reply.code(409).send({ error: 'conflict', message: '已达该身份的电脑台数上限。' })
      }
      ownerPayload = { kind: 'claimant', claimant_id: claimant.id, display_name: claimant.displayName }
    } else {
      const inserted = db
        .insert(claimants)
        .values({
          displayName: bind.displayName,
          status: 'active',
          createdAt: now,
        })
        .returning()
        .get()
      if (inserted == null) throw new Error('failed to insert claimant')
      claimantId = inserted.id
      maxAgeDays = inserted.deviceMaxAgeDays
      maxDevices = inserted.maxDevices
      ownerPayload = { kind: 'claimant', claimant_id: inserted.id, display_name: inserted.displayName }
    }

    const pairedAt = now
    const expiresAt = now + maxAgeDays * 86400
    db.update(devices)
      .set({
        status: 'active',
        claimantId,
        userId,
        pairedAt,
        expiresAt,
        pendingExpiresAt: null,
      })
      .where(eq(devices.id, device.id))
      .run()

    insertAuditEvent(db, {
      type: '电脑授权',
      actorUserId: admin.id,
      details: {
        device_id: device.id,
        fingerprint: device.fingerprint,
        ...(claimantId != null ? { claimant_id: claimantId } : { user_id: userId }),
      },
    })

    return reply.send({
      ok: true,
      device_id: device.id,
      owner: ownerPayload,
    })
  })

  app.post('/api/v1/devices/:id/revoke', async (request, reply) => {
    const admin = requireFullAdmin(db, request, reply)
    if (admin == null) return
    const id = parsePositiveInt((request.params as { id: string }).id)
    if (id == null) return reply.code(404).send({ error: 'not_found' })
    const device = db.select().from(devices).where(eq(devices.id, id)).get()
    if (device == null) return reply.code(404).send({ error: 'not_found' })
    db.update(devices).set({ status: 'revoked' }).where(eq(devices.id, id)).run()
    insertAuditEvent(db, {
      type: '电脑解除',
      actorUserId: admin.id,
      details: { device_id: device.id, fingerprint: device.fingerprint },
    })
    return reply.send({ ok: true })
  })

  app.get('/api/v1/claimants', async (request, reply) => {
    const admin = requireFullAdmin(db, request, reply)
    if (admin == null) return
    const rows = db.select().from(claimants).orderBy(desc(claimants.id)).all()
    return reply.send({
      claimants: rows.map((row) => ({
        id: row.id,
        display_name: row.displayName,
        status: row.status,
        device_max_age_days: row.deviceMaxAgeDays,
        max_devices: row.maxDevices,
        device_idle_days: row.deviceIdleDays,
      })),
    })
  })

  app.post('/api/v1/claimants/:id/revoke', async (request, reply) => {
    const admin = requireFullAdmin(db, request, reply)
    if (admin == null) return
    const id = parsePositiveInt((request.params as { id: string }).id)
    if (id == null) return reply.code(404).send({ error: 'not_found' })
    const claimant = db.select().from(claimants).where(eq(claimants.id, id)).get()
    if (claimant == null) return reply.code(404).send({ error: 'not_found' })
    db.update(claimants).set({ status: 'revoked' }).where(eq(claimants.id, id)).run()
    db.update(devices).set({ status: 'revoked' }).where(eq(devices.claimantId, id)).run()
    insertAuditEvent(db, {
      type: '认领者解除',
      actorUserId: admin.id,
      details: { claimant_id: id },
    })
    return reply.send({ ok: true })
  })

  app.patch('/api/v1/claimants/:id/settings', async (request, reply) => {
    const admin = requireFullAdmin(db, request, reply)
    if (admin == null) return
    const id = parsePositiveInt((request.params as { id: string }).id)
    if (id == null) return reply.code(404).send({ error: 'not_found' })
    const policy = readPolicyBody(request.body)
    if (policy == null) return reply.code(400).send({ error: 'invalid_body' })
    const claimant = db.select().from(claimants).where(eq(claimants.id, id)).get()
    if (claimant == null) return reply.code(404).send({ error: 'not_found' })
    db.update(claimants)
      .set({
        ...(policy.deviceMaxAgeDays != null ? { deviceMaxAgeDays: policy.deviceMaxAgeDays } : {}),
        ...(policy.maxDevices != null ? { maxDevices: policy.maxDevices } : {}),
        ...(policy.deviceIdleDays != null ? { deviceIdleDays: policy.deviceIdleDays } : {}),
      })
      .where(eq(claimants.id, id))
      .run()
    const updated = db.select().from(claimants).where(eq(claimants.id, id)).get()
    if (updated == null) return reply.code(404).send({ error: 'not_found' })
    return reply.send({
      device_max_age_days: updated.deviceMaxAgeDays,
      max_devices: updated.maxDevices,
      device_idle_days: updated.deviceIdleDays,
    })
  })

  app.register(async function agentWhoamiContext(child) {
    const { addDeviceProofHook } = await import('./device-proof.ts')
    addDeviceProofHook(child, db)
    child.get('/api/v1/agent/whoami', async (request, reply) => {
      const auth = request.deviceAuth
      if (auth == null) {
        return
      }
      const { device, owner } = auth
      return reply.send({
        device_id: device.id,
        fingerprint: device.fingerprint,
        hostname: device.hostname,
        status: 'active',
        owner:
          owner.kind === 'user'
            ? { kind: 'user', user_id: owner.user.id }
            : {
                kind: 'claimant',
                claimant_id: owner.claimant.id,
                display_name: owner.claimant.displayName,
              },
      })
    })
  })
}
