import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

/** Seconds of clock skew allowed for X-Kaola-Ts. Duplicated here until implementer extracts production module. */
export const DEVICE_PROOF_SKEW_SECONDS = 300

export type DeviceIdentity = {
  publicKey: KeyObject
  privateKey: KeyObject
  spkiDer: Buffer
  publicKeySpkiB64: string
  fingerprint: string
}

export type DeviceProofBody = string | Buffer | Uint8Array | null | undefined

export type SignedDeviceHeaders = {
  headers: Record<string, string>
  ts: string
  nonce: string
  canonical: string
}

export type InjectSignedOptions = {
  method: string
  url: string
  payload?: unknown
  hostname?: string
  nowSeconds?: number
  cookies?: Record<string, string>
  extraHeaders?: Record<string, string>
}

type PendingDeviceRow = {
  id: number | string
  fingerprint?: string
  [key: string]: unknown
}

/**
 * Canonical UTF-8 payload (architecture.md). Five `\n`-separated lines, no trailing newline after the hash.
 *
 * kaola-device-v1
 * ${ts}
 * ${nonce}
 * ${METHOD}
 * ${pathname}
 * ${body_sha256_hex}
 */
export function deviceProofCanonical({
  ts,
  nonce,
  method,
  pathname,
  body,
}: {
  ts: string | number
  nonce: string
  method: string
  pathname: string
  body?: DeviceProofBody | object
}): string {
  const raw = bodyBytes(body)
  const bodyHash = createHash('sha256').update(raw).digest('hex')
  return ['kaola-device-v1', String(ts), String(nonce), String(method).toUpperCase(), String(pathname), bodyHash].join(
    '\n',
  )
}

export function deviceFingerprint(spkiDer: Buffer | Uint8Array): string {
  return createHash('sha256').update(spkiDer).digest('hex')
}

export function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const exported = publicKey.export({ type: 'spki', format: 'der' })
  const spkiDer = Buffer.isBuffer(exported) ? exported : Buffer.from(exported)
  return {
    publicKey,
    privateKey,
    spkiDer,
    publicKeySpkiB64: Buffer.from(spkiDer).toString('base64'),
    fingerprint: deviceFingerprint(spkiDer),
  }
}

export function signDeviceHeaders({
  identity,
  method,
  pathname,
  body = '',
  hostname,
  nowSeconds = Math.floor(Date.now() / 1000),
  nonce = randomNonce(),
}: {
  identity: DeviceIdentity
  method: string
  pathname: string
  body?: DeviceProofBody | object
  hostname?: string
  nowSeconds?: number
  nonce?: string
}): SignedDeviceHeaders {
  const ts = String(nowSeconds)
  const canonical = deviceProofCanonical({ ts, nonce, method, pathname, body })
  const signature = cryptoSign(null, Buffer.from(canonical, 'utf8'), identity.privateKey)
  const headers: Record<string, string> = {
    'x-kaola-key': identity.publicKeySpkiB64,
    'x-kaola-ts': ts,
    'x-kaola-nonce': nonce,
    'x-kaola-sig': signature.toString('base64'),
  }
  if (hostname != null && hostname !== '') {
    headers['x-kaola-hostname'] = hostname
  }
  return { headers, ts, nonce, canonical }
}

export function mergeDeviceHeaders(
  base: Record<string, string> | undefined,
  signed: SignedDeviceHeaders,
): Record<string, string> {
  return { ...base, ...signed.headers }
}

/** JSON-serialize payload the same way Fastify inject does, so the signed body hash matches the wire bytes. */
export function jsonBodyBytes(payload: unknown): Buffer {
  if (payload == null) return Buffer.alloc(0)
  if (Buffer.isBuffer(payload)) return payload
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8')
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

export function signedInjectHeaders({
  identity,
  method,
  pathname,
  payload,
  hostname,
  nowSeconds,
  extra = {},
}: {
  identity: DeviceIdentity
  method: string
  pathname: string
  payload?: unknown
  hostname?: string
  nowSeconds?: number
  extra?: Record<string, string>
}): Record<string, string> {
  const body = jsonBodyBytes(payload)
  const signed = signDeviceHeaders({ identity, method, pathname, body, hostname, nowSeconds })
  return mergeDeviceHeaders(extra, signed)
}

export async function injectSigned(
  app: FastifyInstance,
  identity: DeviceIdentity,
  { method, url, payload, hostname, nowSeconds, cookies, extraHeaders = {} }: InjectSignedOptions,
) {
  const pathname = String(url).split('?')[0]
  const raw =
    payload == null || payload === ''
      ? ''
      : typeof payload === 'string'
        ? payload
        : JSON.stringify(payload)
  const headers = signedInjectHeaders({
    identity,
    method,
    pathname,
    payload: raw,
    hostname,
    nowSeconds,
    extra: extraHeaders,
  })
  return app.inject({
    method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS',
    url,
    headers,
    cookies,
    payload: raw === '' ? undefined : raw,
  })
}

/**
 * Sight a pending device via signed MCP initialize, then bind it with the given payload.
 * Throws until the #23 admin routes exist — that is the intended red.
 */
export async function pairDevice(
  app: FastifyInstance,
  cookies: Record<string, string> | undefined,
  bindPayload: string | object,
  { hostname }: { hostname?: string } = {},
) {
  const identity = generateDeviceIdentity()
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'kaola-test', version: '0.0.0' } },
  })
  await injectSigned(app, identity, {
    method: 'POST',
    url: '/api/mcp',
    payload: initBody,
    hostname,
    extraHeaders: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
  })
  const listed = await app.inject({
    method: 'GET',
    url: '/api/v1/devices/pending',
    cookies,
    headers: { accept: 'application/json' },
  })
  if (listed.statusCode !== 200) {
    throw new Error(`pairDevice: GET /api/v1/devices/pending expected 200, got ${listed.statusCode}: ${listed.body}`)
  }
  const listedJson = listed.json() as { devices?: PendingDeviceRow[] } | null
  const devices: PendingDeviceRow[] = listedJson?.devices ?? []
  const row = devices.find((d) => d.fingerprint === identity.fingerprint) ?? devices[0]
  if (row == null) {
    throw new Error(`pairDevice: no pending device for fingerprint ${identity.fingerprint}: ${listed.body}`)
  }
  const bind = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${row.id}/bind`,
    cookies,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    payload: bindPayload,
  })
  if (bind.statusCode !== 200) {
    throw new Error(`pairDevice: POST bind expected 200, got ${bind.statusCode}: ${bind.body}`)
  }
  const bindJson = bind.json() as { device_id?: number | string } | null
  const deviceId = bindJson?.device_id ?? row.id
  return { identity, deviceId, pending: row, bind }
}

export async function pairDeviceToSelf(
  app: FastifyInstance,
  cookies: Record<string, string> | undefined,
  opts?: { hostname?: string },
) {
  return pairDevice(app, cookies, { bind_to_self: true }, opts)
}

function bodyBytes(body: DeviceProofBody | object): Buffer {
  if (body == null || body === '') return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  return Buffer.from(JSON.stringify(body), 'utf8')
}

function randomNonce(): string {
  return randomBytes(16).toString('hex')
}
