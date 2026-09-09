import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PAIRING_TTL_SECONDS,
  MIN_PAIRING_TTL_SECONDS,
  alignPendingExpiresAt,
  derivePairingKey,
  encodeApprovalTranscript,
  encodePairingTranscript,
  pairingApprovalProof,
  pairingCommitment,
  pairingExpiresAt,
  pairingIsLive,
  parsePairingTtlSeconds,
} from './pairing.ts'

const VECTOR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/decisions/0031-pairing-test-vectors.json',
)

const vectors = JSON.parse(readFileSync(VECTOR_PATH, 'utf8')) as {
  encoding: { attempt_lifetime: { default_ttl_seconds: number; minimum_ttl_seconds: number; post_bind_device_max_age_days_default: number } }
  vectors: Array<{
    pairing_id: string
    instance_id: string
    origin: string
    device_fingerprint: string
    client_nonce_hex: string
    server_nonce_hex: string
    root_ca_sha256_hex: string
    expires_at: number
    pairing_secret_hex: string
    transcript_hex: string
    transcript_sha256_hex: string
    commitment_hex: string
    hkdf: { pairing_key_hex: string }
    approval: {
      owner_kind: 'claimant' | 'user'
      owner_id: string
      approved_at: number
      transcript_hex: string
      proof_hex: string
    }
    bind_to_self_approval: {
      owner_kind: 'user'
      owner_id: string
      proof_hex: string
    }
    negative: {
      wrong_secret_commitment_hex: string
      field_substitution_commitment_hex: Record<string, string>
    }
  }>
}

const primary = vectors.vectors[0]

describe('ADR 0031 pairing encoding', () => {
  test('attempt lifetime freeze is 86400 default and minimum, bound device default is 90 days', () => {
    assert.equal(vectors.encoding.attempt_lifetime.default_ttl_seconds, 86400)
    assert.equal(vectors.encoding.attempt_lifetime.minimum_ttl_seconds, 86400)
    assert.equal(vectors.encoding.attempt_lifetime.post_bind_device_max_age_days_default, 90)
    assert.equal(DEFAULT_PAIRING_TTL_SECONDS, 86400)
    assert.equal(MIN_PAIRING_TTL_SECONDS, 86400)
    assert.equal(parsePairingTtlSeconds(undefined), 86400)
    assert.throws(() => parsePairingTtlSeconds('900'))
    assert.throws(() => parsePairingTtlSeconds('300'))
  })

  test('primary transcript, commitment, HKDF key, and proofs match frozen vectors', () => {
    const transcript = encodePairingTranscript({
      pairingId: primary.pairing_id,
      instanceId: primary.instance_id,
      origin: primary.origin,
      deviceFingerprint: primary.device_fingerprint,
      clientNonce: Buffer.from(primary.client_nonce_hex, 'hex'),
      serverNonce: Buffer.from(primary.server_nonce_hex, 'hex'),
      rootCaSha256: Buffer.from(primary.root_ca_sha256_hex, 'hex'),
      expiresAt: primary.expires_at,
    })
    assert.equal(transcript.toString('hex'), primary.transcript_hex)
    const secret = Buffer.from(primary.pairing_secret_hex, 'hex')
    assert.equal(pairingCommitment(secret, transcript).toString('hex'), primary.commitment_hex)
    const pairingKey = derivePairingKey(secret, transcript)
    assert.equal(pairingKey.toString('hex'), primary.hkdf.pairing_key_hex)

    const approval = encodeApprovalTranscript({
      pairingId: primary.pairing_id,
      instanceId: primary.instance_id,
      origin: primary.origin,
      deviceFingerprint: primary.device_fingerprint,
      rootCaSha256: Buffer.from(primary.root_ca_sha256_hex, 'hex'),
      ownerKind: 'claimant',
      ownerId: 7,
      approvedAt: primary.approval.approved_at,
      expiresAt: primary.expires_at,
    })
    assert.equal(approval.toString('hex'), primary.approval.transcript_hex)
    assert.equal(pairingApprovalProof(pairingKey, approval).toString('hex'), primary.approval.proof_hex)

    const self = encodeApprovalTranscript({
      pairingId: primary.pairing_id,
      instanceId: primary.instance_id,
      origin: primary.origin,
      deviceFingerprint: primary.device_fingerprint,
      rootCaSha256: Buffer.from(primary.root_ca_sha256_hex, 'hex'),
      ownerKind: 'user',
      ownerId: 3,
      approvedAt: primary.approval.approved_at,
      expiresAt: primary.expires_at,
    })
    assert.equal(pairingApprovalProof(pairingKey, self).toString('hex'), primary.bind_to_self_approval.proof_hex)
  })

  test('wrong secret and one-byte field substitutions never equal the primary commitment', () => {
    const transcript = Buffer.from(primary.transcript_hex, 'hex')
    const secret = Buffer.from(primary.pairing_secret_hex, 'hex')
    const wrong = Buffer.from(secret)
    wrong[0] ^= 1
    assert.equal(
      pairingCommitment(wrong, transcript).toString('hex'),
      primary.negative.wrong_secret_commitment_hex,
    )
    assert.notEqual(pairingCommitment(wrong, transcript).toString('hex'), primary.commitment_hex)
    for (const hex of Object.values(primary.negative.field_substitution_commitment_hex)) {
      assert.notEqual(hex, primary.commitment_hex)
    }
  })

  test('pairing is live until expires_at and pending alignment never shortens the 24h window', () => {
    const created = 1_700_000_000
    const expires = pairingExpiresAt(created, DEFAULT_PAIRING_TTL_SECONDS)
    assert.equal(expires - created, 86400)
    assert.equal(pairingIsLive(created + 1, expires), true)
    assert.equal(pairingIsLive(expires - 1, expires), true)
    assert.equal(pairingIsLive(expires, expires), false)
    const leftoverPending = created + 3600
    assert.equal(alignPendingExpiresAt(leftoverPending, expires), expires)
    assert.equal(alignPendingExpiresAt(expires + 10, expires), expires + 10)
  })
})
