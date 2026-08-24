import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { Readable } from 'node:stream'
import { DEVICE_PROOF_SKEW_SECONDS, deviceFingerprint, deviceProofCanonical } from '@kaola/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppDb } from './db.ts'
import { type Claimant, type Device, type User, claimants, devices, users } from './schema.ts'

const PENDING_WINDOW_SECONDS = 86400
const WWW_AUTHENTICATE = 'Kaola-Device'

export type DeviceOwner =
  | { kind: 'user'; user: User }
  | { kind: 'claimant'; claimant: Claimant }

export type AgentPrincipal = {
  device: Device
  owner: DeviceOwner
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer
    deviceAuth?: AgentPrincipal
  }
}

const replayCache = new Map<string, number>()

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

function sweepReplay(now: number): void {
  for (const [key, exp] of replayCache) {
    if (exp <= now) replayCache.delete(key)
  }
}

export function sendDeviceUnauthorized(reply: FastifyReply) {
  return reply.header('WWW-Authenticate', WWW_AUTHENTICATE).code(401).send({ error: 'unauthorized' })
}

export function sendAuthorizationRequired(reply: FastifyReply, expiresAtUnix: number) {
  return reply.code(202).send({
    error: 'authorization_required',
    pending: true,
    expires_at: new Date(expiresAtUnix * 1000).toISOString(),
  })
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  return undefined
}

function parseSpki(b64: string): Buffer | undefined {
  try {
    const der = Buffer.from(b64, 'base64')
    if (der.length < 32) return undefined
    createPublicKey({ key: der, format: 'der', type: 'spki' })
    return der
  } catch {
    return undefined
  }
}

function verifySignature(spkiDer: Buffer, canonical: string, sigB64: string): boolean {
  try {
    const key = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' })
    const sig = Buffer.from(sigB64, 'base64')
    if (sig.length !== 64) return false
    return cryptoVerify(null, Buffer.from(canonical, 'utf8'), key, sig)
  } catch {
    return false
  }
}

function pathnameOf(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

function loadOwner(db: AppDb, device: Device): DeviceOwner | undefined {
  if (device.userId != null) {
    const user = db.select().from(users).where(eq(users.id, device.userId)).get()
    if (user == null) return undefined
    return { kind: 'user', user }
  }
  if (device.claimantId != null) {
    const claimant = db.select().from(claimants).where(eq(claimants.id, device.claimantId)).get()
    if (claimant == null) return undefined
    return { kind: 'claimant', claimant }
  }
  return undefined
}

function idleExpired(owner: DeviceOwner, device: Device, now: number): boolean {
  const idleDays = owner.kind === 'user' ? owner.user.deviceIdleDays : owner.claimant.deviceIdleDays
  if (idleDays == null || idleDays <= 0) return false
  if (device.lastSeen == null) return false
  return now - device.lastSeen > idleDays * 86400
}

function upsertPending(
  db: AppDb,
  input: { fingerprint: string; publicKey: string; hostname: string; now: number },
): Device {
  const existing = db.select().from(devices).where(eq(devices.fingerprint, input.fingerprint)).get()
  if (existing == null) {
    const inserted = db
      .insert(devices)
      .values({
        fingerprint: input.fingerprint,
        publicKey: input.publicKey,
        hostname: input.hostname,
        status: 'pending',
        claimantId: null,
        userId: null,
        createdAt: input.now,
        pendingExpiresAt: input.now + PENDING_WINDOW_SECONDS,
        pairedAt: null,
        expiresAt: null,
        lastSeen: input.now,
      })
      .returning()
      .get()
    if (inserted == null) throw new Error('failed to insert pending device')
    return inserted
  }

  if (existing.status === 'pending') {
    const pendingExp = existing.pendingExpiresAt ?? existing.createdAt + PENDING_WINDOW_SECONDS
    if (input.now < pendingExp) {
      db.update(devices).set({ lastSeen: input.now }).where(eq(devices.id, existing.id)).run()
      return { ...existing, lastSeen: input.now }
    }
    const next = db
      .update(devices)
      .set({
        status: 'pending',
        claimantId: null,
        userId: null,
        hostname: existing.hostname || input.hostname,
        createdAt: input.now,
        pendingExpiresAt: input.now + PENDING_WINDOW_SECONDS,
        pairedAt: null,
        expiresAt: null,
        lastSeen: input.now,
      })
      .where(eq(devices.id, existing.id))
      .returning()
      .get()
    return next ?? existing
  }

  return existing
}

export function addDeviceProofHook(app: FastifyInstance, db: AppDb): void {
  app.addHook('preParsing', async (request, _reply, payload) => {
    const chunks: Buffer[] = []
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
    }
    const buf = Buffer.concat(chunks)
    request.rawBody = buf
    return Readable.from(buf)
  })

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const keyB64 = headerString(request.headers['x-kaola-key'])
    const tsRaw = headerString(request.headers['x-kaola-ts'])
    const nonce = headerString(request.headers['x-kaola-nonce'])
    const sig = headerString(request.headers['x-kaola-sig'])
    const hostname = headerString(request.headers['x-kaola-hostname']) ?? ''

    if (keyB64 == null || tsRaw == null || nonce == null || sig == null) {
      return sendDeviceUnauthorized(reply)
    }

    if (!/^(?:0|[1-9][0-9]*)$/.test(tsRaw)) {
      return sendDeviceUnauthorized(reply)
    }
    const ts = Number.parseInt(tsRaw, 10)
    const now = unixNow()
    if (Math.abs(now - ts) > DEVICE_PROOF_SKEW_SECONDS) {
      return sendDeviceUnauthorized(reply)
    }

    const spkiDer = parseSpki(keyB64)
    if (spkiDer == null) {
      return sendDeviceUnauthorized(reply)
    }

    const canonical = deviceProofCanonical({
      ts: tsRaw,
      nonce,
      method: request.method,
      pathname: pathnameOf(request.url),
      body: request.rawBody ?? Buffer.alloc(0),
    })
    if (!verifySignature(spkiDer, canonical, sig)) {
      return sendDeviceUnauthorized(reply)
    }

    const fingerprint = deviceFingerprint(spkiDer)
    sweepReplay(now)
    const replayKey = `${fingerprint}:${nonce}`
    if (replayCache.has(replayKey)) {
      return sendDeviceUnauthorized(reply)
    }
    replayCache.set(replayKey, ts + DEVICE_PROOF_SKEW_SECONDS)

    let device = db.select().from(devices).where(eq(devices.fingerprint, fingerprint)).get()

    if (device == null || device.status === 'pending') {
      device = upsertPending(db, { fingerprint, publicKey: keyB64, hostname, now })
      const pendingExp = device.pendingExpiresAt ?? device.createdAt + PENDING_WINDOW_SECONDS
      return sendAuthorizationRequired(reply, pendingExp)
    }

    if (device.status === 'revoked') {
      return reply.code(403).send({ error: 'forbidden' })
    }

    if (device.status === 'expired') {
      return reply.code(403).send({ error: 'device_expired' })
    }

    if (device.status !== 'active') {
      return reply.code(403).send({ error: 'forbidden' })
    }

    if (device.expiresAt != null && now >= device.expiresAt) {
      db.update(devices).set({ status: 'expired' }).where(eq(devices.id, device.id)).run()
      return reply.code(403).send({ error: 'device_expired' })
    }

    const owner = loadOwner(db, device)
    if (owner == null) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    if (owner.kind === 'claimant' && owner.claimant.status === 'revoked') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    if (owner.kind === 'user' && owner.user.status !== 'active') {
      return reply.code(403).send({ error: 'forbidden' })
    }

    if (idleExpired(owner, device, now)) {
      db.update(devices).set({ status: 'expired' }).where(eq(devices.id, device.id)).run()
      return reply.code(403).send({ error: 'device_expired' })
    }

    db.update(devices).set({ lastSeen: now }).where(eq(devices.id, device.id)).run()
    request.deviceAuth = { device: { ...device, lastSeen: now }, owner }
  })
}

export function requireDeviceAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): AgentPrincipal | undefined {
  const auth = request.deviceAuth
  if (auth == null) {
    sendDeviceUnauthorized(reply)
    return undefined
  }
  return auth
}
