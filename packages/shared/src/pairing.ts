import { X509Certificate, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

export const PAIRING_PROTOCOL_VERSION = 'kaola-pairing/1'
export const PAIRING_APPROVAL_PROTOCOL_VERSION = 'kaola-pairing-approval/1'
export const PAIRING_HKDF_INFO = 'kaola-pairing-approval-v1'
export const PAIRING_ID_PREFIX = 'kpr_'
export const DEFAULT_PAIRING_TTL_SECONDS = 86400
export const MIN_PAIRING_TTL_SECONDS = 86400
export const MAX_PAIRING_TTL_SECONDS = 604800
export const PAIRING_SECRET_BYTES = 16
export const PAIRING_NONCE_BYTES = 32
export const PAIRING_MAX_FIELD_LENGTH = 65536
export const PAIRING_MAX_FAILED_ATTEMPTS = 8

const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const CERT_BEGIN = '-----BEGIN CERTIFICATE-----'
const CERT_END = '-----END CERTIFICATE-----'

export type PairingOwnerKind = 'claimant' | 'user'

export type PairingTranscriptInput = {
  pairingId: string
  instanceId: string
  origin: string
  deviceFingerprint: string
  clientNonce: Buffer
  serverNonce: Buffer
  rootCaSha256: Buffer
  expiresAt: number
}

export type PairingApprovalInput = {
  pairingId: string
  instanceId: string
  origin: string
  deviceFingerprint: string
  rootCaSha256: Buffer
  ownerKind: PairingOwnerKind
  ownerId: number
  approvedAt: number
  expiresAt: number
}

function u32be(length: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(length)
  return buf
}

export function encodeLengthPrefixedField(bytes: Buffer): Buffer {
  if (bytes.length > PAIRING_MAX_FIELD_LENGTH) {
    throw new Error('pairing field exceeds 65536 bytes')
  }
  return Buffer.concat([u32be(bytes.length), bytes])
}

export function utf8Field(value: string): Buffer {
  return encodeLengthPrefixedField(Buffer.from(value, 'utf8'))
}

export function unixSecondsField(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('unix seconds must be a non-negative integer')
  }
  return utf8Field(value === 0 ? '0' : String(value))
}

export function encodePairingTranscript(input: PairingTranscriptInput): Buffer {
  return Buffer.concat([
    utf8Field(PAIRING_PROTOCOL_VERSION),
    utf8Field(input.pairingId),
    utf8Field(input.instanceId),
    utf8Field(input.origin),
    utf8Field(input.deviceFingerprint),
    encodeLengthPrefixedField(input.clientNonce),
    encodeLengthPrefixedField(input.serverNonce),
    encodeLengthPrefixedField(input.rootCaSha256),
    unixSecondsField(input.expiresAt),
  ])
}

export function encodeApprovalTranscript(input: PairingApprovalInput): Buffer {
  return Buffer.concat([
    utf8Field(PAIRING_APPROVAL_PROTOCOL_VERSION),
    utf8Field(input.pairingId),
    utf8Field(input.instanceId),
    utf8Field(input.origin),
    utf8Field(input.deviceFingerprint),
    encodeLengthPrefixedField(input.rootCaSha256),
    utf8Field(input.ownerKind),
    utf8Field(String(input.ownerId)),
    unixSecondsField(input.approvedAt),
    unixSecondsField(input.expiresAt),
  ])
}

export function sha256(bytes: Buffer): Buffer {
  return createHash('sha256').update(bytes).digest()
}

export function pairingCommitment(pairingSecret: Buffer, transcript: Buffer): Buffer {
  return createHmac('sha256', pairingSecret).update(sha256(transcript)).digest()
}

export function derivePairingKey(pairingSecret: Buffer, transcript: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', pairingSecret, sha256(transcript), Buffer.from(PAIRING_HKDF_INFO, 'utf8'), 32),
  )
}

export function pairingApprovalProof(pairingKey: Buffer, approvalTranscript: Buffer): Buffer {
  return createHmac('sha256', pairingKey).update(sha256(approvalTranscript)).digest()
}

export function timingSafeEqualHex(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, 'hex')
  const right = Buffer.from(rightHex, 'hex')
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function newPairingId(): string {
  return `${PAIRING_ID_PREFIX}${randomBytes(16).toString('hex')}`
}

export function newPairingSecret(): Buffer {
  return randomBytes(PAIRING_SECRET_BYTES)
}

export function newPairingNonce(): Buffer {
  return randomBytes(PAIRING_NONCE_BYTES)
}

export function parsePairingTtlSeconds(raw: string | undefined, fallback = DEFAULT_PAIRING_TTL_SECONDS): number {
  if (raw == null || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n < MIN_PAIRING_TTL_SECONDS || n > MAX_PAIRING_TTL_SECONDS) {
    throw new Error('KAOLA_PAIRING_TTL_SECONDS must be an integer in [86400, 604800]')
  }
  return n
}

export function pairingExpiresAt(createdAt: number, ttlSeconds: number): number {
  return createdAt + ttlSeconds
}

export function pairingIsLive(now: number, expiresAt: number): boolean {
  return now < expiresAt
}

export function alignPendingExpiresAt(
  existingPendingExpiresAt: number | null | undefined,
  pairingExpiresAtUnix: number,
): number {
  if (existingPendingExpiresAt == null) return pairingExpiresAtUnix
  return Math.max(existingPendingExpiresAt, pairingExpiresAtUnix)
}

export function normalizePairingOrigin(url: string): string {
  const stripped = String(url).replace(/\/+$/, '')
  const parsed = new URL(stripped)
  return `${parsed.protocol}//${parsed.host}`
}

export function originDigestSha256(origin: string): string {
  return createHash('sha256').update(origin, 'utf8').digest('hex')
}

export function parsePairingSecret(raw: string): Buffer | undefined {
  const hex = String(raw).replace(/[:\s-]/g, '').toLowerCase()
  if (!/^[0-9a-f]+$/.test(hex) || hex.length < PAIRING_SECRET_BYTES * 2 || hex.length % 2 !== 0) {
    return undefined
  }
  const buf = Buffer.from(hex, 'hex')
  if (buf.length < PAIRING_SECRET_BYTES) return undefined
  return buf
}

export function displayPairingSecret(secret: Buffer): string {
  return secret.toString('hex').replace(/(.{4})/g, '$1-').replace(/-$/, '')
}

export function normalizeFingerprintSha256(value: string): string {
  return String(value).replace(/[:\s]/g, '').toLowerCase()
}

export function certificateSha256(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
}

export function inspectPublicRootPem(pemText: string):
  | { ok: true; pem: string; fingerprintSha256: string }
  | { ok: false; code: string } {
  const raw = typeof pemText === 'string' ? pemText : ''
  if (raw.trim().length === 0) return { ok: false, code: 'empty_pem' }
  if (PRIVATE_KEY_MARKER.test(raw)) return { ok: false, code: 'private_key_present' }
  const beginCount = raw.split(CERT_BEGIN).length - 1
  const endCount = raw.split(CERT_END).length - 1
  if (beginCount !== 1 || endCount !== 1) return { ok: false, code: 'certificate_count' }
  let cert: X509Certificate
  try {
    cert = new X509Certificate(raw)
  } catch {
    return { ok: false, code: 'unparseable' }
  }
  if (!cert.ca) return { ok: false, code: 'not_a_ca' }
  const begin = raw.indexOf(CERT_BEGIN)
  const end = raw.indexOf(CERT_END)
  const pem = `${raw.slice(begin, end + CERT_END.length)}\n`
  return { ok: true, pem, fingerprintSha256: createHash('sha256').update(cert.raw).digest('hex') }
}
