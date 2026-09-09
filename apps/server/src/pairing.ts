import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  DEFAULT_PAIRING_TTL_SECONDS,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PAIRING_PROTOCOL_VERSION,
  alignPendingExpiresAt,
  derivePairingKey,
  encodeApprovalTranscript,
  encodePairingTranscript,
  inspectPublicRootPem,
  newPairingId,
  newPairingNonce,
  normalizePairingOrigin,
  pairingApprovalProof,
  pairingCommitment,
  pairingExpiresAt,
  pairingIsLive,
  parsePairingSecret,
  parsePairingTtlSeconds,
  timingSafeEqualHex,
} from '@kaola/shared'
import { getPublicUrl } from './auth.ts'
import {
  addDeviceProofHook,
  sendAuthorizationRequired,
  sendDeviceUnauthorized,
} from './device-proof.ts'
import type { AppDb } from './db.ts'
import { unixNow } from './leases.ts'
import { appSettings, type Device, type DevicePairing, devicePairings, devices } from './schema.ts'

type PairingOwner = { kind: 'claimant'; claimant_id: number } | { kind: 'user'; user_id: number }

export type PairingBindFailure = { ok: false; httpStatus: number; body: Record<string, unknown> }
export type PairingBindOk = { ok: true; row: DevicePairing; secret: Buffer }

type PairingConfig =
  | { mode: 'disabled' }
  | {
      mode: 'private_ca'
      ttlSeconds: number
      origin: string
      instanceId: string
      rootPem: string
      rootSha256: string
      nextRootPem?: string
      nextRootSha256?: string
    }

function readSetting(db: AppDb, key: string): string | undefined {
  return db.select().from(appSettings).where(eq(appSettings.k, key)).get()?.v
}

export function instanceIdOf(db: AppDb): string {
  const value = readSetting(db, 'instance_id')
  if (value == null || value === '') throw new Error('app_settings.instance_id is missing')
  return value
}

export function loadPairingConfig(db: AppDb): PairingConfig {
  if (process.env.KAOLA_PAIRING_MODE !== 'private_ca') return { mode: 'disabled' }
  const ttlSeconds = parsePairingTtlSeconds(process.env.KAOLA_PAIRING_TTL_SECONDS)
  const path = process.env.KAOLA_PUBLIC_ROOT_CA_PATH
  if (path == null || path === '') {
    throw new Error('KAOLA_PUBLIC_ROOT_CA_PATH is required when KAOLA_PAIRING_MODE=private_ca')
  }
  let pemText: string
  try {
    pemText = readFileSync(path, 'utf8')
  } catch {
    throw new Error('KAOLA_PUBLIC_ROOT_CA_PATH is unreadable')
  }
  const inspected = inspectPublicRootPem(pemText)
  if (!inspected.ok) throw new Error(`public root CA rejected: ${inspected.code}`)
  const origin = normalizePairingOrigin(getPublicUrl())
  let nextRootPem: string | undefined
  let nextRootSha256: string | undefined
  const nextPath = process.env.KAOLA_NEXT_PUBLIC_ROOT_CA_PATH
  if (nextPath != null && nextPath !== '') {
    const nextInspected = inspectPublicRootPem(readFileSync(nextPath, 'utf8'))
    if (!nextInspected.ok) throw new Error(`next public root CA rejected: ${nextInspected.code}`)
    nextRootPem = nextInspected.pem
    nextRootSha256 = nextInspected.fingerprintSha256
  }
  return {
    mode: 'private_ca',
    ttlSeconds,
    origin,
    instanceId: instanceIdOf(db),
    rootPem: inspected.pem,
    rootSha256: inspected.fingerprintSha256,
    nextRootPem,
    nextRootSha256,
  }
}

function hex32(raw: unknown): Buffer | undefined {
  if (typeof raw !== 'string') return undefined
  const hex = raw.replace(/[:\s-]/g, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) return undefined
  return Buffer.from(hex, 'hex')
}

function requirePairingDevice(request: FastifyRequest, reply: FastifyReply): Device | undefined {
  const device = request.pairingDevice
  if (device == null) {
    sendDeviceUnauthorized(reply)
    return undefined
  }
  return device
}

function requireActiveDevice(request: FastifyRequest, reply: FastifyReply) {
  if (request.deviceAuth != null) return request.deviceAuth
  const device = request.pairingDevice
  if (device != null && device.status === 'pending') {
    sendAuthorizationRequired(
      reply,
      device.pendingExpiresAt ?? device.createdAt + DEFAULT_PAIRING_TTL_SECONDS,
    )
    return undefined
  }
  sendDeviceUnauthorized(reply)
  return undefined
}

function expireStalePairings(db: AppDb, deviceId: number, now: number): void {
  const rows = db.select().from(devicePairings).where(eq(devicePairings.deviceId, deviceId)).all()
  for (const row of rows) {
    if (
      (row.status === 'created' || row.status === 'committed' || row.status === 'approved') &&
      row.consumedAt == null &&
      !pairingIsLive(now, row.expiresAt)
    ) {
      db.update(devicePairings).set({ status: 'expired' }).where(eq(devicePairings.id, row.id)).run()
    }
  }
}

function livePairingForDevice(db: AppDb, deviceId: number, now: number): DevicePairing | undefined {
  const rows = db.select().from(devicePairings).where(eq(devicePairings.deviceId, deviceId)).all()
  return rows.find(
    (row) =>
      (row.status === 'created' || row.status === 'committed' || row.status === 'approved') &&
      row.consumedAt == null &&
      pairingIsLive(now, row.expiresAt),
  )
}

function pairingByPublicId(db: AppDb, pairingId: string): DevicePairing | undefined {
  return db.select().from(devicePairings).where(eq(devicePairings.pairingId, pairingId)).get()
}

function effectiveStatus(row: DevicePairing, now: number): DevicePairing['status'] {
  if (
    (row.status === 'created' || row.status === 'committed' || row.status === 'approved') &&
    !pairingIsLive(now, row.expiresAt)
  ) {
    return 'expired'
  }
  return row.status
}

function isoUnix(unix: number): string {
  return new Date(unix * 1000).toISOString()
}

function descriptor(
  cfg: Extract<PairingConfig, { mode: 'private_ca' }>,
  row: DevicePairing,
  device: Device,
  status: string,
) {
  return {
    pairing_id: row.pairingId,
    protocol_version: row.protocolVersion,
    instance_id: row.instanceId,
    origin: row.origin,
    server_nonce: row.serverNonceHex,
    root_pem: cfg.rootPem,
    root_sha256: row.rootSha256,
    expires_at: isoUnix(row.expiresAt),
    device_id: device.id,
    device_fingerprint: device.fingerprint,
    status,
  }
}

function rebuildTranscript(row: DevicePairing, device: Device) {
  return encodePairingTranscript({
    pairingId: row.pairingId,
    instanceId: row.instanceId,
    origin: row.origin,
    deviceFingerprint: device.fingerprint,
    clientNonce: Buffer.from(row.clientNonceHex, 'hex'),
    serverNonce: Buffer.from(row.serverNonceHex, 'hex'),
    rootCaSha256: Buffer.from(row.rootSha256, 'hex'),
    expiresAt: row.expiresAt,
  })
}

export function pendingPairingFields(
  db: AppDb,
  deviceId: number,
  now: number,
): { pairing_id: string; pairing_expires_at: string; requires_pairing_secret: true } | Record<string, never> {
  const live = livePairingForDevice(db, deviceId, now)
  if (live == null) return {}
  if (live.status !== 'created' && live.status !== 'committed' && live.status !== 'approved') return {}
  return {
    pairing_id: live.pairingId,
    pairing_expires_at: isoUnix(live.expiresAt),
    requires_pairing_secret: true,
  }
}

export function deviceHasPairingHistory(db: AppDb, deviceId: number): boolean {
  return db.select().from(devicePairings).where(eq(devicePairings.deviceId, deviceId)).get() != null
}

export function checkPairingSecret(
  db: AppDb,
  input: { device: Device; pairingId: string; pairingSecret: string; now: number },
): PairingBindOk | PairingBindFailure {
  const cfg = loadPairingConfig(db)
  if (cfg.mode !== 'private_ca') {
    return { ok: false, httpStatus: 404, body: { error: 'pairing_mode_disabled' } }
  }
  const secret = parsePairingSecret(input.pairingSecret)
  if (secret == null) {
    return { ok: false, httpStatus: 400, body: { error: 'invalid_body' } }
  }
  const row = pairingByPublicId(db, input.pairingId)
  if (row == null || row.deviceId !== input.device.id) {
    return { ok: false, httpStatus: 409, body: { error: 'conflict', message: '配对申请不存在或不属于这台电脑。' } }
  }
  const status = effectiveStatus(row, input.now)
  if (status === 'expired') {
    return { ok: false, httpStatus: 409, body: { error: 'pairing_expired' } }
  }
  if (row.status === 'rejected') {
    return { ok: false, httpStatus: 409, body: { error: 'pairing_secret_invalid' } }
  }
  if (row.status !== 'committed' && row.status !== 'approved') {
    return { ok: false, httpStatus: 409, body: { error: 'conflict', message: '配对尚未提交密语承诺。' } }
  }
  if (row.commitmentHex == null) {
    return { ok: false, httpStatus: 409, body: { error: 'conflict', message: '配对尚未提交密语承诺。' } }
  }
  const transcript = rebuildTranscript(row, input.device)
  const commitment = pairingCommitment(secret, transcript)
  if (!timingSafeEqualHex(commitment.toString('hex'), row.commitmentHex)) {
    const failed = row.failedAttempts + 1
    const rejected = failed >= PAIRING_MAX_FAILED_ATTEMPTS
    db.update(devicePairings)
      .set({
        failedAttempts: failed,
        ...(rejected ? { status: 'rejected' as const } : {}),
      })
      .where(eq(devicePairings.id, row.id))
      .run()
    return { ok: false, httpStatus: 403, body: { error: 'pairing_secret_invalid' } }
  }
  return { ok: true, row, secret }
}

export function persistPairingApproval(
  db: { update: AppDb['update'] },
  input: { device: Device; row: DevicePairing; owner: PairingOwner; secret: Buffer; now: number },
): void {
  if (input.row.status === 'approved' && input.row.approvalPayload != null) return
  const transcript = rebuildTranscript(input.row, input.device)
  const pairingKey = derivePairingKey(input.secret, transcript)
  const approvalTranscript = encodeApprovalTranscript({
    pairingId: input.row.pairingId,
    instanceId: input.row.instanceId,
    origin: input.row.origin,
    deviceFingerprint: input.device.fingerprint,
    rootCaSha256: Buffer.from(input.row.rootSha256, 'hex'),
    ownerKind: input.owner.kind,
    ownerId: input.owner.kind === 'claimant' ? input.owner.claimant_id : input.owner.user_id,
    approvedAt: input.now,
    expiresAt: input.row.expiresAt,
  })
  const proof = pairingApprovalProof(pairingKey, approvalTranscript)
  const payload = {
    v: 1,
    pairing_id: input.row.pairingId,
    instance_id: input.row.instanceId,
    origin: input.row.origin,
    device_fingerprint: input.device.fingerprint,
    root_sha256: input.row.rootSha256,
    owner: input.owner,
    approved_at: input.now,
    expires_at: input.row.expiresAt,
  }
  db.update(devicePairings)
    .set({
      status: 'approved',
      approvalPayload: JSON.stringify(payload),
      approvalProof: proof.toString('hex'),
      approvedAt: input.now,
    })
    .where(eq(devicePairings.id, input.row.id))
    .run()
}

export function registerPairing(app: FastifyInstance, db: AppDb): void {
  app.register(async function pairingContext(child) {
    addDeviceProofHook(child, db, { pending: 'continue', rejectAuthorization: true })

    child.post('/api/v1/device-pairings', async (request, reply) => {
      const cfg = loadPairingConfig(db)
      if (cfg.mode !== 'private_ca') {
        return reply.code(404).send({ error: 'pairing_mode_disabled' })
      }
      const device = requirePairingDevice(request, reply)
      if (device == null) return
      if (device.status === 'active') {
        return reply.code(409).send({
          error: 'conflict',
          message: '电脑已授权，请走根轮换而不是重新配对。',
        })
      }
      const body = request.body as { client_nonce?: unknown }
      const clientNonce = hex32(body?.client_nonce)
      if (clientNonce == null) {
        return reply.code(400).send({ error: 'invalid_body' })
      }
      const now = unixNow()
      expireStalePairings(db, device.id, now)
      const existing = livePairingForDevice(db, device.id, now)
      if (existing != null) {
        return reply.code(200).send(descriptor(cfg, existing, device, effectiveStatus(existing, now)))
      }
      const createdAt = now
      const expiresAt = pairingExpiresAt(createdAt, cfg.ttlSeconds)
      const pendingExpiresAt = alignPendingExpiresAt(device.pendingExpiresAt, expiresAt)
      const inserted = db.transaction((tx) => {
        tx.update(devices).set({ pendingExpiresAt }).where(eq(devices.id, device.id)).run()
        return tx
          .insert(devicePairings)
          .values({
            pairingId: newPairingId(),
            deviceId: device.id,
            protocolVersion: PAIRING_PROTOCOL_VERSION,
            clientNonceHex: clientNonce.toString('hex'),
            serverNonceHex: newPairingNonce().toString('hex'),
            origin: cfg.origin,
            instanceId: cfg.instanceId,
            rootSha256: cfg.rootSha256,
            status: 'created',
            failedAttempts: 0,
            createdAt,
            expiresAt,
          })
          .returning()
          .get()
      })
      if (inserted == null) throw new Error('failed to insert device pairing')
      return reply.code(201).send(descriptor(cfg, inserted, { ...device, pendingExpiresAt }, 'created'))
    })

    child.post('/api/v1/device-pairings/:id/commit', async (request, reply) => {
      const cfg = loadPairingConfig(db)
      if (cfg.mode !== 'private_ca') {
        return reply.code(404).send({ error: 'pairing_mode_disabled' })
      }
      const device = requirePairingDevice(request, reply)
      if (device == null) return
      const pairingId = (request.params as { id: string }).id
      const commitment = hex32((request.body as { commitment?: unknown })?.commitment)
      if (commitment == null) return reply.code(400).send({ error: 'invalid_body' })
      const row = pairingByPublicId(db, pairingId)
      const now = unixNow()
      if (row == null || row.deviceId !== device.id) {
        return reply.code(404).send({ error: 'not_found' })
      }
      if (effectiveStatus(row, now) === 'expired') {
        return reply.code(409).send({ error: 'pairing_expired' })
      }
      if (row.commitmentHex != null) {
        if (timingSafeEqualHex(row.commitmentHex, commitment.toString('hex'))) {
          return reply.send({
            status: effectiveStatus(row, now),
            pairing_id: row.pairingId,
            expires_at: isoUnix(row.expiresAt),
          })
        }
        return reply.code(409).send({ error: 'pairing_commitment_mismatch' })
      }
      db.update(devicePairings)
        .set({ commitmentHex: commitment.toString('hex'), status: 'committed' })
        .where(eq(devicePairings.id, row.id))
        .run()
      return reply.send({ status: 'committed', pairing_id: row.pairingId, expires_at: isoUnix(row.expiresAt) })
    })

    child.post('/api/v1/device-pairings/:id/status', async (request, reply) => {
      const cfg = loadPairingConfig(db)
      if (cfg.mode !== 'private_ca') {
        return reply.code(404).send({ error: 'pairing_mode_disabled' })
      }
      const device = requirePairingDevice(request, reply)
      if (device == null) return
      const pairingId = (request.params as { id: string }).id
      const row = pairingByPublicId(db, pairingId)
      if (row == null || row.deviceId !== device.id) {
        return reply.code(404).send({ error: 'not_found' })
      }
      const now = unixNow()
      const status = effectiveStatus(row, now)
      const base = { status, pairing_id: row.pairingId, expires_at: isoUnix(row.expiresAt) }
      if (status === 'approved' && row.approvalPayload != null && row.approvalProof != null && row.consumedAt == null) {
        return reply.send({
          ...base,
          approval: {
            payload: JSON.parse(row.approvalPayload) as unknown,
            proof: row.approvalProof,
          },
        })
      }
      return reply.send(base)
    })

    child.post('/api/v1/device-pairings/:id/complete', async (request, reply) => {
      const cfg = loadPairingConfig(db)
      if (cfg.mode !== 'private_ca') {
        return reply.code(404).send({ error: 'pairing_mode_disabled' })
      }
      const auth = requireActiveDevice(request, reply)
      if (auth == null) return
      const pairingId = (request.params as { id: string }).id
      const row = pairingByPublicId(db, pairingId)
      if (row == null || row.deviceId !== auth.device.id) {
        return reply.code(404).send({ error: 'not_found' })
      }
      if (row.status !== 'approved' && row.status !== 'consumed') {
        return reply.code(409).send({ error: 'conflict' })
      }
      if (row.consumedAt == null) {
        db.update(devicePairings)
          .set({ status: 'consumed', consumedAt: unixNow() })
          .where(eq(devicePairings.id, row.id))
          .run()
      }
      return reply.send({ status: 'consumed', pairing_id: row.pairingId })
    })

    child.post('/api/v1/device-trust/next-root', async (request, reply) => {
      const cfg = loadPairingConfig(db)
      if (cfg.mode !== 'private_ca') {
        return reply.code(404).send({ error: 'pairing_mode_disabled' })
      }
      const auth = requireActiveDevice(request, reply)
      if (auth == null) return
      if (cfg.nextRootPem == null || cfg.nextRootSha256 == null) {
        return reply.code(404).send({ error: 'not_found' })
      }
      return reply.send({
        root_pem: cfg.nextRootPem,
        root_sha256: cfg.nextRootSha256,
        trust_epoch: 2,
      })
    })
  })
}
