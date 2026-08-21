import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { AppDb } from './db.ts'
import { credentialProfiles, events } from './schema.ts'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const MASTER_KEY_HEX_RE = /^[0-9a-fA-F]{64}$/

export const VAULT_UNCONFIGURED = 'vault_unconfigured'

export class VaultUnconfiguredError extends Error {
  readonly code = VAULT_UNCONFIGURED

  constructor() {
    super(VAULT_UNCONFIGURED)
    this.name = 'VaultUnconfiguredError'
  }
}

export function isVaultUnconfiguredError(err: unknown): boolean {
  return (
    err instanceof VaultUnconfiguredError ||
    (typeof err === 'object' &&
      err != null &&
      'code' in err &&
      err.code === VAULT_UNCONFIGURED)
  )
}

function readMasterKey(): Buffer {
  const hex = process.env.VAULT_MASTER_KEY
  if (hex == null || hex === '' || !MASTER_KEY_HEX_RE.test(hex)) {
    throw new VaultUnconfiguredError()
  }
  const key = Buffer.from(hex, 'hex')
  if (key.length !== 32) {
    throw new VaultUnconfiguredError()
  }
  return key
}

export function encryptToken(plaintext: string): string {
  const key = readMasterKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ciphertext, tag]).toString('base64')
}

export function decryptToken(encoded: string | Buffer): string {
  const key = readMasterKey()
  const blob = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded, 'base64')
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('invalid ciphertext')
  }
  const iv = blob.subarray(0, IV_LENGTH)
  const tag = blob.subarray(blob.length - AUTH_TAG_LENGTH)
  const ciphertext = blob.subarray(IV_LENGTH, blob.length - AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

// Structural subset of `AppDb` so callers running inside a `db.transaction(...)` can pass the
// transaction handle (`BetterSQLiteTransaction`) — it shares `insert`'s type with `AppDb` (both
// extend the same drizzle `BaseSQLiteDatabase`) but lacks `$client`, so it isn't assignable to
// the full `AppDb` type.
type AuditEventWriter = { insert: AppDb['insert'] }

export function insertAuditEvent(
  db: AuditEventWriter,
  input: { type: string; actorUserId: number | null; details: unknown },
): void {
  db.insert(events)
    .values({
      type: input.type,
      actorUserId: input.actorUserId,
      createdAt: Math.floor(Date.now() / 1000),
      details: JSON.stringify(input.details),
    })
    .run()
}

export function revealCredentialProfile(
  db: AppDb,
  input: { profileId: number; actorUserId: number; agentKeyId: number },
): string {
  const row = db
    .select()
    .from(credentialProfiles)
    .where(eq(credentialProfiles.id, input.profileId))
    .get()
  if (row == null) {
    throw new Error('credential profile not found')
  }
  const plaintext = decryptToken(row.tokenEncrypted)
  insertAuditEvent(db, {
    type: 'token 揭示',
    actorUserId: input.actorUserId,
    details: { agent_key_id: input.agentKeyId, profile_id: input.profileId },
  })
  return plaintext
}
