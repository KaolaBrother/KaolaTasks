import { createHash } from 'node:crypto'

/** Seconds of clock skew allowed for X-Kaola-Ts. */
export const DEVICE_PROOF_SKEW_SECONDS = 300

export const DEVICE_PROOF_PREFIX = 'kaola-device-v1'

export function deviceProofCanonical(input: {
  ts: string | number
  nonce: string
  method: string
  pathname: string
  body?: string | Buffer | Uint8Array | null
}): string {
  const raw = bodyBytes(input.body)
  const bodyHash = createHash('sha256').update(raw).digest('hex')
  return [
    DEVICE_PROOF_PREFIX,
    String(input.ts),
    String(input.nonce),
    String(input.method).toUpperCase(),
    String(input.pathname),
    bodyHash,
  ].join('\n')
}

export function deviceFingerprint(spkiDer: Buffer | Uint8Array): string {
  return createHash('sha256').update(spkiDer).digest('hex')
}

function bodyBytes(body: string | Buffer | Uint8Array | null | undefined): Buffer {
  if (body == null || body === '') return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  return Buffer.from(body, 'utf8')
}
