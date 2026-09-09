import {
  X509Certificate,
  createPrivateKey,
  randomBytes,
  sign as cryptoSign,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { hostname as osHostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Writable } from 'node:stream'
import tls from 'node:tls'
import {
  derivePairingKey,
  deviceFingerprint,
  deviceProofCanonical,
  displayPairingSecret,
  encodeApprovalTranscript,
  encodePairingTranscript,
  inspectPublicRootPem,
  newPairingNonce,
  newPairingSecret,
  normalizePairingOrigin,
  originDigestSha256,
  pairingApprovalProof,
  pairingCommitment,
  pairingIsLive,
  timingSafeEqualHex,
} from '@kaola/shared'
import { forbiddenLauncherArgv, inspectInstalledTrust, resolveKaolaHome } from './trust.ts'

type DeviceIdentity = {
  v: 1
  privateKeyPkcs8: string
  publicKeySpki: string
  createdAt: string
}

export const PAIRING_REQUIRED_EXIT_CODE = 2
export const PAIRING_RECEIPT_VERSION = 1
export const PAIRING_TRUST_VERSION = 2

const UNKNOWN_ISSUER_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

const PAIRING_ID_RE = /^kpr_[0-9a-f]{32}$/
const BOOTSTRAP_PATHS = [
  /^\/api\/v1\/device-pairings$/,
  /^\/api\/v1\/device-pairings\/kpr_[0-9a-f]{32}\/commit$/,
  /^\/api\/v1\/device-pairings\/kpr_[0-9a-f]{32}\/status$/,
]

export type PairingHttpResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export type PairingHttpRequest = {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body: Buffer
  mode: 'strict' | 'bootstrap'
  extraCaPem?: string
}

export type PairingTransport = {
  request(input: PairingHttpRequest): Promise<PairingHttpResponse>
  destroy?(): void
}

export type PairingReceipt = {
  v: number
  origin: string
  pairing_id: string | null
  instance_id: string | null
  device_fingerprint: string
  client_nonce: string
  server_nonce: string | null
  secret: string
  commitment: string | null
  root_pem: string | null
  root_sha256: string | null
  expires_at: string | null
}

export type V2TrustState = {
  v: 2
  alg: 'sha256'
  originDigest: string
  instanceId: string
  deviceFingerprint: string
  fingerprintSha256: string
  previousFingerprintSha256?: string
  trustEpoch: number
  pairedAt: number
}

export type InspectedV2Trust =
  | { present: false; ready: false; dir: string; pemPath: string; statePath: string }
  | {
      present: true
      ready: false
      dir: string
      pemPath: string
      statePath: string
      message: string
    }
  | {
      present: true
      ready: true
      dir: string
      pemPath: string
      statePath: string
      pem: string
      state: V2TrustState
    }

export type TlsFailureClass = 'unknown_issuer' | 'fail_closed'

export type PairingCliIo = {
  stdout?: Writable
  stderr?: Writable
}

export type PairingCliDeps = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  transport?: PairingTransport
  pollIntervalMs?: number
}

type ApprovalPayload = {
  v: number
  pairing_id: string
  instance_id: string
  origin: string
  device_fingerprint: string
  root_sha256: string
  owner: { kind: 'claimant'; claimant_id: number } | { kind: 'user'; user_id: number }
  approved_at: number
  expires_at: number
}

function writeLine(stream: Writable | undefined, line: string): void {
  const target = stream ?? process.stderr
  target.write(line.endsWith('\n') ? line : `${line}\n`)
}

function tlsVerificationDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.NODE_TLS_REJECT_UNAUTHORIZED
  if (raw == null) return false
  const value = String(raw).trim().toLowerCase()
  return value === '0' || value === 'false'
}

function collectErrorCodes(err: unknown, into: Set<string>, depth = 0): void {
  if (err == null || depth > 4) return
  if (typeof err === 'object') {
    const rec = err as { code?: unknown; reason?: unknown; cause?: unknown; message?: unknown }
    if (typeof rec.code === 'string' && rec.code.length > 0) into.add(rec.code)
    if (typeof rec.reason === 'string' && rec.reason.length > 0) into.add(rec.reason)
    if (typeof rec.message === 'string') {
      for (const code of UNKNOWN_ISSUER_CODES) {
        if (rec.message.includes(code)) into.add(code)
      }
      if (/unable to verify the first certificate/i.test(rec.message)) {
        into.add('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
      }
      if (/CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ERR_TLS_CERT_ALTNAME_INVALID/.test(rec.message)) {
        into.add(RegExp.lastMatch)
      }
    }
    collectErrorCodes(rec.cause, into, depth + 1)
  }
}

export function classifyTlsFailure(err: unknown): TlsFailureClass {
  const codes = new Set<string>()
  collectErrorCodes(err, codes)
  for (const code of codes) {
    if (UNKNOWN_ISSUER_CODES.has(code)) return 'unknown_issuer'
  }
  return 'fail_closed'
}

export function isBootstrapPathAllowed(pathname: string): boolean {
  return BOOTSTRAP_PATHS.some((re) => re.test(pathname))
}

export function pairingOriginDigest(url: string): string {
  return originDigestSha256(normalizePairingOrigin(url))
}

export function pairingReceiptDir(kaolaHome: string, origin: string): string {
  return join(kaolaHome, 'pairings', pairingOriginDigest(origin))
}

export function pairingReceiptPath(kaolaHome: string, origin: string): string {
  return join(pairingReceiptDir(kaolaHome, origin), 'receipt.json')
}

export function v2TrustDir(kaolaHome: string, origin: string): string {
  return join(kaolaHome, 'trust', 'v2', pairingOriginDigest(origin))
}

export function v2PreviousTrustDir(kaolaHome: string, origin: string): string {
  return `${v2TrustDir(kaolaHome, origin)}.previous`
}

function v2DirLooksComplete(dir: string): boolean {
  return existsSync(join(dir, 'root-ca.pem')) && existsSync(join(dir, 'state.json'))
}

export function recoverInterruptedV2Trust(kaolaHome: string, origin: string): void {
  const finalDir = v2TrustDir(kaolaHome, origin)
  const previous = v2PreviousTrustDir(kaolaHome, origin)
  const finalComplete = v2DirLooksComplete(finalDir)
  const previousComplete = v2DirLooksComplete(previous)
  if (finalComplete) {
    if (existsSync(previous)) rmSync(previous, { recursive: true, force: true })
    return
  }
  if (previousComplete) {
    if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true })
    renameSync(previous, finalDir)
  }
}

function isSecureUnixMode(path: string, expected: number): boolean {
  if (process.platform === 'win32') return true
  try {
    return (statSync(path).mode & 0o777) === expected
  } catch {
    return false
  }
}

function ensureDirSecure(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

function writeFileAtomic(path: string, contents: string): void {
  ensureDirSecure(dirname(path))
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmpPath, contents, { mode: 0o600, encoding: 'utf8' })
  chmodSync(tmpPath, 0o600)
  renameSync(tmpPath, path)
  chmodSync(path, 0o600)
}

export function deletePairingReceipt(kaolaHome: string, origin: string): void {
  const path = pairingReceiptPath(kaolaHome, origin)
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

function parseReceipt(raw: string, origin: string, deviceFingerprintHex: string): PairingReceipt | undefined {
  try {
    const parsed = JSON.parse(raw) as PairingReceipt
    if (parsed.v !== PAIRING_RECEIPT_VERSION) return undefined
    if (parsed.origin !== origin) return undefined
    if (parsed.device_fingerprint !== deviceFingerprintHex) return undefined
    if (typeof parsed.secret !== 'string' || parsed.secret.length < 32) return undefined
    if (typeof parsed.client_nonce !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.client_nonce)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function readPairingReceipt(
  kaolaHome: string,
  origin: string,
  deviceFingerprintHex: string,
): PairingReceipt | undefined {
  const path = pairingReceiptPath(kaolaHome, origin)
  if (!existsSync(path)) return undefined
  if (!isSecureUnixMode(path, 0o600) && process.platform !== 'win32') return undefined
  try {
    return parseReceipt(readFileSync(path, 'utf8'), origin, deviceFingerprintHex)
  } catch {
    return undefined
  }
}

function writePairingReceipt(kaolaHome: string, receipt: PairingReceipt): void {
  writeFileAtomic(pairingReceiptPath(kaolaHome, originOf(receipt)), `${JSON.stringify(receipt)}\n`)
}

function originOf(receipt: PairingReceipt): string {
  return receipt.origin
}

function parseV2State(raw: string): V2TrustState | undefined {
  try {
    const parsed = JSON.parse(raw) as V2TrustState
    if (parsed.v !== PAIRING_TRUST_VERSION || parsed.alg !== 'sha256') return undefined
    if (typeof parsed.originDigest !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.originDigest)) return undefined
    if (typeof parsed.instanceId !== 'string' || parsed.instanceId.length === 0) return undefined
    if (typeof parsed.deviceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.deviceFingerprint)) {
      return undefined
    }
    if (typeof parsed.fingerprintSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.fingerprintSha256)) {
      return undefined
    }
    if (!Number.isInteger(parsed.trustEpoch) || parsed.trustEpoch < 1) return undefined
    if (!Number.isInteger(parsed.pairedAt) || parsed.pairedAt < 0) return undefined
    if (parsed.previousFingerprintSha256 != null) {
      if (
        typeof parsed.previousFingerprintSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(parsed.previousFingerprintSha256)
      ) {
        return undefined
      }
    }
    if (typeof (parsed as { origin?: unknown }).origin === 'string') return undefined
    if (typeof (parsed as { secret?: unknown }).secret === 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

function fingerprintFromDeviceJson(kaolaHome: string): string | undefined {
  const path = join(kaolaHome, 'device.json')
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { publicKeySpki?: unknown }
    if (typeof parsed.publicKeySpki !== 'string' || parsed.publicKeySpki.length === 0) return undefined
    return deviceFingerprint(Buffer.from(parsed.publicKeySpki, 'base64'))
  } catch {
    return undefined
  }
}

export function inspectV2Trust(kaolaHome: string, origin: string): InspectedV2Trust {
  recoverInterruptedV2Trust(kaolaHome, origin)
  const dir = v2TrustDir(kaolaHome, origin)
  const pemPath = join(dir, 'root-ca.pem')
  const statePath = join(dir, 'state.json')
  const pemExists = existsSync(pemPath)
  const stateExists = existsSync(statePath)
  if (!pemExists && !stateExists) {
    return { present: false, ready: false, dir, pemPath, statePath }
  }
  const fail = (message: string): InspectedV2Trust => ({
    present: true,
    ready: false,
    dir,
    pemPath,
    statePath,
    message,
  })
  if (!pemExists || !stateExists) return fail('v2 trust is incomplete; extra CA is not ready')
  if (!isSecureUnixMode(dir, 0o700)) return fail('v2 trust directory mode must be 0700')
  if (!isSecureUnixMode(pemPath, 0o600) || !isSecureUnixMode(statePath, 0o600)) {
    return fail('v2 trust file mode must be 0600')
  }
  let stateRaw: string
  let pemText: string
  try {
    stateRaw = readFileSync(statePath, 'utf8')
    pemText = readFileSync(pemPath, 'utf8')
  } catch {
    return fail('v2 trust exists but cannot be read')
  }
  const state = parseV2State(stateRaw)
  if (state == null) return fail('v2 trust state is not a host-neutral approval-bound document')
  if (state.originDigest !== pairingOriginDigest(origin)) {
    return fail('v2 trust origin digest does not match this --url')
  }
  const bundle = inspectV2PemBundle(pemText, state)
  if (!bundle.ok) return fail(bundle.message)
  const deviceFp = fingerprintFromDeviceJson(kaolaHome)
  if (deviceFp == null || deviceFp !== state.deviceFingerprint) {
    return fail('v2 trust device fingerprint does not match device.json')
  }
  if (/BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(pemText) || /BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(stateRaw)) {
    return fail('v2 trust must not contain private keys')
  }
  return {
    present: true,
    ready: true,
    dir,
    pemPath,
    statePath,
    pem: bundle.pem,
    state,
  }
}

function splitCaPemBlocks(pemText: string): string[] | null {
  const blocks: string[] = []
  const begin = '-----BEGIN CERTIFICATE-----'
  const end = '-----END CERTIFICATE-----'
  let cursor = 0
  while (true) {
    const start = pemText.indexOf(begin, cursor)
    if (start === -1) break
    const stop = pemText.indexOf(end, start)
    if (stop === -1) return null
    blocks.push(`${pemText.slice(start, stop + end.length)}\n`)
    cursor = stop + end.length
  }
  return blocks
}

function inspectV2PemBundle(
  pemText: string,
  state: V2TrustState,
): { ok: true; pem: string } | { ok: false; message: string } {
  if (/BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(pemText)) {
    return { ok: false, message: 'v2 root PEM contains private key material' }
  }
  const blocks = splitCaPemBlocks(pemText)
  if (blocks == null) return { ok: false, message: 'v2 root PEM is truncated' }
  if (blocks.length < 1 || blocks.length > 2) {
    return { ok: false, message: 'v2 root PEM must contain one CA, or two during overlap' }
  }
  const shas: string[] = []
  for (const pem of blocks) {
    const inspected = inspectPublicRootPem(pem)
    if (!inspected.ok) return { ok: false, message: `v2 root PEM rejected: ${inspected.code}` }
    shas.push(inspected.fingerprintSha256)
  }
  if (blocks.length === 1) {
    if (!timingSafeEqualHex(shas[0] ?? '', state.fingerprintSha256)) {
      return { ok: false, message: 'v2 root PEM does not match pinned fingerprint' }
    }
    return { ok: true, pem: blocks[0] ?? pemText }
  }
  const previous = state.previousFingerprintSha256
  if (previous == null || !timingSafeEqualHex(shas[0] ?? '', previous)) {
    return { ok: false, message: 'overlap PEM first root must match previousFingerprintSha256' }
  }
  if (!timingSafeEqualHex(shas[1] ?? '', state.fingerprintSha256)) {
    return { ok: false, message: 'overlap PEM second root must match fingerprintSha256' }
  }
  return { ok: true, pem: `${blocks[0]}${blocks[1]}` }
}

function fingerprintOfDevice(device: DeviceIdentity): string {
  return deviceFingerprint(Buffer.from(device.publicKeySpki, 'base64'))
}

function signDeviceRequest(
  device: DeviceIdentity,
  method: string,
  pathname: string,
  bodyBuf: Buffer,
): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(16).toString('hex')
  const canonical = deviceProofCanonical({ ts, nonce, method, pathname, body: bodyBuf })
  const privateKey = createPrivateKey({
    key: Buffer.from(device.privateKeyPkcs8, 'base64'),
    type: 'pkcs8',
    format: 'der',
  })
  const sig = cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKey)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'X-Kaola-Key': device.publicKeySpki,
    'X-Kaola-Ts': ts,
    'X-Kaola-Nonce': nonce,
    'X-Kaola-Sig': sig.toString('base64'),
  }
  try {
    headers['X-Kaola-Hostname'] = osHostname()
  } catch {
    // hostname is untrusted and optional
  }
  return headers
}

function defaultRuntimeCaCerts(): string[] {
  const getCACertificates = (
    tls as typeof tls & { getCACertificates?: (type?: string) => string[] }
  ).getCACertificates
  if (typeof getCACertificates === 'function') {
    try {
      const bundled = getCACertificates('bundled')
      let system: string[] = []
      try {
        system = getCACertificates('system')
      } catch {
        system = []
      }
      return [...bundled, ...system]
    } catch {
      return [...tls.rootCertificates]
    }
  }
  return [...tls.rootCertificates]
}

function headerMap(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return out
}

function verifyBootstrapPeer(socket: tls.TLSSocket, hostname: string): void {
  const peer = socket.getPeerCertificate()
  if (peer == null || peer.raw == null) {
    throw Object.assign(new Error('bootstrap peer certificate is missing'), { code: 'UNABLE_TO_GET_ISSUER_CERT' })
  }
  const cert = new X509Certificate(peer.raw)
  const now = Date.now()
  const from = Date.parse(cert.validFrom)
  const to = Date.parse(cert.validTo)
  if (!Number.isFinite(from) || now < from) {
    throw Object.assign(new Error('certificate is not yet valid'), { code: 'CERT_NOT_YET_VALID' })
  }
  if (!Number.isFinite(to) || now > to) {
    throw Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })
  }
  const identityErr = tls.checkServerIdentity(hostname, peer)
  if (identityErr) throw identityErr
}

function httpsOnce(input: PairingHttpRequest): Promise<PairingHttpResponse> {
  const parsed = new URL(input.url)
  if (input.mode === 'bootstrap' && !isBootstrapPathAllowed(parsed.pathname)) {
    return Promise.reject(new Error(`bootstrap must not call ${parsed.pathname}`))
  }
  const headers: Record<string, string> = {
    ...input.headers,
    'content-length': String(input.body.length),
  }
  delete headers.cookie
  delete headers.Cookie
  delete headers.authorization
  delete headers.Authorization
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      input.url,
      {
        // Pairing is low-frequency control traffic: use a one-request Agent, never
        // leave bootstrap sockets (or handshake listeners) in the global pool.
        agent: false,
        method: input.method,
        headers,
        rejectUnauthorized: input.mode === 'strict',
        ca:
          input.mode === 'strict'
            ? input.extraCaPem != null && input.extraCaPem.length > 0
              ? [...defaultRuntimeCaCerts(), input.extraCaPem]
              : defaultRuntimeCaCerts()
            : undefined,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: headerMap(res.headers),
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        if (input.mode !== 'bootstrap') return
        try {
          verifyBootstrapPeer(socket as tls.TLSSocket, parsed.hostname)
        } catch (err) {
          req.destroy(err as Error)
        }
      })
    })
    req.on('error', reject)
    if (input.body.length > 0) req.write(input.body)
    req.end()
  })
}

export function createDefaultPairingTransport(): PairingTransport {
  return {
    request: httpsOnce,
  }
}

export function extraCaPemForOrigin(kaolaHome: string, origin: string): string | undefined {
  const v2 = inspectV2Trust(kaolaHome, origin)
  if (v2.present && v2.ready) return v2.pem
  if (v2.present && !v2.ready) return undefined
  const v1 = inspectInstalledTrust(kaolaHome)
  if (v1.ready && v1.pem != null) return v1.pem
  return undefined
}

export async function probeHttpsOrigin(
  url: string,
  extraCaPem: string | undefined,
  transport: PairingTransport = createDefaultPairingTransport(),
): Promise<{ ok: true } | { ok: false; class: TlsFailureClass; message: string }> {
  try {
    await transport.request({
      method: 'GET',
      url: `${normalizePairingOrigin(url)}/api/v1/setup`,
      headers: { accept: 'application/json' },
      body: Buffer.alloc(0),
      mode: 'strict',
      extraCaPem,
    })
    return { ok: true }
  } catch (err) {
    const klass = classifyTlsFailure(err)
    const message = err instanceof Error ? err.message : 'tls probe failed'
    return { ok: false, class: klass, message }
  }
}

export function pairingRequiredMessage(origin: string): string {
  return `pairing_required\n运行: kaola-mcp pair --url ${origin}`
}

export type PreparedHttpsLauncher =
  | { ok: true; extraCaPem?: string; extraCaPemPath?: string }
  | { ok: false; pairingRequired?: boolean; message: string }

export async function prepareHttpsLauncher(input: {
  url: string
  env: NodeJS.ProcessEnv
  transport?: PairingTransport
}): Promise<PreparedHttpsLauncher> {
  if (tlsVerificationDisabled(input.env)) {
    return { ok: false, message: 'NODE_TLS_REJECT_UNAUTHORIZED=0/false is not a success path' }
  }
  let origin: string
  try {
    origin = normalizePairingOrigin(input.url)
  } catch {
    return { ok: false, message: 'KAOLA url is not an absolute URL' }
  }
  const kaolaHome = resolveKaolaHome(input.env)
  const transport = input.transport ?? createDefaultPairingTransport()
  const v2 = inspectV2Trust(kaolaHome, origin)
  if (v2.present && !v2.ready) return { ok: false, message: v2.message }
  const v1 = inspectInstalledTrust(kaolaHome)
  const callerExtra = input.env.NODE_EXTRA_CA_CERTS
  const hasCallerExtra = typeof callerExtra === 'string' && callerExtra.trim().length > 0
  if (hasCallerExtra && !v2.ready && !v1.ready) {
    return {
      ok: false,
      message:
        'NODE_EXTRA_CA_CERTS is not a trust source; public-CA mode refuses caller extra CA without verified local trust state',
    }
  }

  if (v2.ready) {
    const migrated = await migratePublicCaIfPossible({
      kaolaHome,
      origin,
      v2,
      transport,
    })
    if (migrated.ok && migrated.removed) {
      const probe = await probeHttpsOrigin(origin, undefined, transport)
      if (!probe.ok) return { ok: false, message: probe.message }
      return { ok: true }
    }
    await applyNextRootIfOffered({ kaolaHome, origin, v2, transport })
    const afterNext = inspectV2Trust(kaolaHome, origin)
    if (afterNext.ready) {
      await dropOldRootIfNewChainProves({
        kaolaHome,
        origin,
        v2: afterNext,
        transport,
      })
    }
  }

  const extraPem = extraCaPemForOrigin(kaolaHome, origin)
  const extraPath = inspectV2Trust(kaolaHome, origin)
  const extraCaPemPath = extraPath.ready ? extraPath.pemPath : undefined
  const probe = await probeHttpsOrigin(origin, extraPem, transport)
  if (probe.ok) {
    return { ok: true, extraCaPem: extraPem, extraCaPemPath }
  }
  if (probe.class === 'unknown_issuer') {
    return { ok: false, pairingRequired: true, message: pairingRequiredMessage(origin) }
  }
  return { ok: false, message: probe.message }
}

async function migratePublicCaIfPossible(input: {
  kaolaHome: string
  origin: string
  v2: Extract<InspectedV2Trust, { ready: true }>
  transport: PairingTransport
}): Promise<{ ok: true; removed: boolean }> {
  const probe = await probeHttpsOrigin(input.origin, undefined, input.transport)
  if (!probe.ok) return { ok: true, removed: false }
  const { ensureDeviceIdentity } = await import('./main.ts')
  const device = await ensureDeviceIdentity(input.kaolaHome)
  const who = await signedJson(input.transport, device, {
    origin: input.origin,
    method: 'GET',
    pathname: '/api/v1/agent/whoami',
    payload: null,
    mode: 'strict',
  })
  const body = jsonParse(who.body) ?? {}
  if (
    who.status === 200 &&
    body.status === 'active' &&
    body.fingerprint === input.v2.state.deviceFingerprint &&
    body.instance_id === input.v2.state.instanceId &&
    Object.hasOwn(body, 'token') === false
  ) {
    rmSync(input.v2.dir, { recursive: true, force: true })
    return { ok: true, removed: true }
  }
  return { ok: true, removed: false }
}

async function applyNextRootIfOffered(input: {
  kaolaHome: string
  origin: string
  v2: Extract<InspectedV2Trust, { ready: true }>
  transport: PairingTransport
}): Promise<void> {
  const { ensureDeviceIdentity } = await import('./main.ts')
  const device = await ensureDeviceIdentity(input.kaolaHome)
  let res: PairingHttpResponse
  try {
    res = await signedJson(input.transport, device, {
      origin: input.origin,
      method: 'POST',
      pathname: '/api/v1/device-trust/next-root',
      payload: {},
      mode: 'strict',
      extraCaPem: input.v2.pem,
    })
  } catch {
    return
  }
  if (res.status === 404 || res.status === 202) return
  if (res.status !== 200) return
  const body = jsonParse(res.body) ?? {}
  const rootPem = typeof body.root_pem === 'string' ? body.root_pem : ''
  const rootSha = typeof body.root_sha256 === 'string' ? body.root_sha256 : ''
  const inspected = inspectPublicRootPem(rootPem)
  if (!inspected.ok) return
  if (!timingSafeEqualHex(inspected.fingerprintSha256, rootSha)) return
  if (timingSafeEqualHex(rootSha, input.v2.state.fingerprintSha256)) return
  if (input.v2.state.previousFingerprintSha256 != null) return
  const overlapPem = `${input.v2.pem.trim()}\n${inspected.pem}`
  const state: V2TrustState = {
    ...input.v2.state,
    fingerprintSha256: rootSha,
    previousFingerprintSha256: input.v2.state.fingerprintSha256,
    trustEpoch: input.v2.state.trustEpoch + 1,
  }
  const staging = writeV2Staging({ kaolaHome: input.kaolaHome, origin: input.origin, pem: overlapPem, state })
  try {
    const probe = await probeHttpsOrigin(input.origin, overlapPem, input.transport)
    if (!probe.ok) {
      discardStaging(staging)
      return
    }
    commitV2Staging(staging, input.origin, input.kaolaHome)
  } catch {
    discardStaging(staging)
  }
}

async function dropOldRootIfNewChainProves(input: {
  kaolaHome: string
  origin: string
  v2: Extract<InspectedV2Trust, { ready: true }>
  transport: PairingTransport
}): Promise<void> {
  if (input.v2.state.previousFingerprintSha256 == null) return
  const blocks = splitCaPemBlocks(input.v2.pem)
  if (blocks == null || blocks.length !== 2) return
  const newPem = blocks[1] ?? ''
  const probe = await probeHttpsOrigin(input.origin, newPem, input.transport)
  if (!probe.ok) return
  const state: V2TrustState = {
    v: input.v2.state.v,
    alg: input.v2.state.alg,
    originDigest: input.v2.state.originDigest,
    instanceId: input.v2.state.instanceId,
    deviceFingerprint: input.v2.state.deviceFingerprint,
    fingerprintSha256: input.v2.state.fingerprintSha256,
    trustEpoch: input.v2.state.trustEpoch,
    pairedAt: input.v2.state.pairedAt,
  }
  const staging = writeV2Staging({ kaolaHome: input.kaolaHome, origin: input.origin, pem: newPem, state })
  try {
    commitV2Staging(staging, input.origin, input.kaolaHome)
  } catch {
    discardStaging(staging)
  }
}

function jsonParse(body: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

export function verifyPairingApproval(input: {
  receipt: PairingReceipt
  payload: ApprovalPayload
  proofHex: string
}): { ok: true } | { ok: false; reason: string } {
  const receipt = input.receipt
  if (receipt.pairing_id == null || receipt.instance_id == null || receipt.server_nonce == null) {
    return { ok: false, reason: 'receipt is incomplete' }
  }
  if (receipt.root_pem == null || receipt.root_sha256 == null || receipt.expires_at == null) {
    return { ok: false, reason: 'receipt is incomplete' }
  }
  if (input.payload.v !== 1) return { ok: false, reason: 'approval payload version' }
  if (input.payload.pairing_id !== receipt.pairing_id) return { ok: false, reason: 'pairing_id mismatch' }
  if (input.payload.instance_id !== receipt.instance_id) return { ok: false, reason: 'instance_id mismatch' }
  if (input.payload.origin !== receipt.origin) return { ok: false, reason: 'origin mismatch' }
  if (input.payload.device_fingerprint !== receipt.device_fingerprint) {
    return { ok: false, reason: 'device mismatch' }
  }
  if (!timingSafeEqualHex(input.payload.root_sha256, receipt.root_sha256)) {
    return { ok: false, reason: 'root mismatch' }
  }
  const expiresAt = Math.floor(Date.parse(receipt.expires_at) / 1000)
  if (input.payload.expires_at !== expiresAt) return { ok: false, reason: 'expiry mismatch' }
  const owner = input.payload.owner
  const ownerKind = owner.kind
  const ownerId = owner.kind === 'claimant' ? owner.claimant_id : owner.user_id
  if (!Number.isInteger(ownerId) || ownerId <= 0) return { ok: false, reason: 'owner' }
  const secret = Buffer.from(receipt.secret, 'hex')
  const transcript = encodePairingTranscript({
    pairingId: receipt.pairing_id,
    instanceId: receipt.instance_id,
    origin: receipt.origin,
    deviceFingerprint: receipt.device_fingerprint,
    clientNonce: Buffer.from(receipt.client_nonce, 'hex'),
    serverNonce: Buffer.from(receipt.server_nonce, 'hex'),
    rootCaSha256: Buffer.from(receipt.root_sha256, 'hex'),
    expiresAt,
  })
  const pairingKey = derivePairingKey(secret, transcript)
  const approvalTranscript = encodeApprovalTranscript({
    pairingId: receipt.pairing_id,
    instanceId: receipt.instance_id,
    origin: receipt.origin,
    deviceFingerprint: receipt.device_fingerprint,
    rootCaSha256: Buffer.from(receipt.root_sha256, 'hex'),
    ownerKind,
    ownerId,
    approvedAt: input.payload.approved_at,
    expiresAt,
  })
  const expected = pairingApprovalProof(pairingKey, approvalTranscript).toString('hex')
  if (!timingSafeEqualHex(expected, input.proofHex.toLowerCase())) {
    return { ok: false, reason: 'proof mismatch' }
  }
  return { ok: true }
}

export function writeV2Staging(input: {
  kaolaHome: string
  origin: string
  pem: string
  state: V2TrustState
}): string {
  const finalDir = v2TrustDir(input.kaolaHome, input.origin)
  const staging = `${finalDir}.staging-${process.pid}-${randomBytes(4).toString('hex')}`
  ensureDirSecure(dirname(finalDir))
  ensureDirSecure(staging)
  writeFileAtomic(join(staging, 'root-ca.pem'), input.pem.endsWith('\n') ? input.pem : `${input.pem}\n`)
  writeFileAtomic(join(staging, 'state.json'), `${JSON.stringify(input.state)}\n`)
  return staging
}

export function commitV2Staging(staging: string, origin: string, kaolaHome: string): string {
  recoverInterruptedV2Trust(kaolaHome, origin)
  const finalDir = v2TrustDir(kaolaHome, origin)
  const previous = v2PreviousTrustDir(kaolaHome, origin)
  if (existsSync(finalDir)) {
    if (existsSync(previous)) rmSync(previous, { recursive: true, force: true })
    renameSync(finalDir, previous)
  }
  try {
    renameSync(staging, finalDir)
  } catch (err) {
    if (existsSync(previous) && !v2DirLooksComplete(finalDir)) {
      if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true })
      try {
        renameSync(previous, finalDir)
      } catch {
        // leave previous in place for recoverInterruptedV2Trust
      }
    }
    throw err
  }
  chmodSync(finalDir, 0o700)
  if (existsSync(previous)) rmSync(previous, { recursive: true, force: true })
  return finalDir
}

function discardStaging(staging: string | undefined): void {
  if (staging == null) return
  try {
    rmSync(staging, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

function parseFlagUrl(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') return argv[i + 1]
    if (argv[i]?.startsWith('--url=')) return argv[i].slice('--url='.length)
  }
  return undefined
}

function hasCancel(argv: readonly string[]): boolean {
  return argv.includes('--cancel')
}

async function signedJson(
  transport: PairingTransport,
  device: DeviceIdentity,
  input: {
    origin: string
    method: 'GET' | 'POST'
    pathname: string
    payload: unknown
    mode: 'strict' | 'bootstrap'
    extraCaPem?: string
  },
): Promise<PairingHttpResponse> {
  const bodyBuf =
    input.method === 'GET' || input.payload == null
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(input.payload), 'utf8')
  const headers = signDeviceRequest(device, input.method, input.pathname, bodyBuf)
  return transport.request({
    method: input.method,
    url: `${input.origin}${input.pathname}`,
    headers,
    body: bodyBuf,
    mode: input.mode,
    extraCaPem: input.extraCaPem,
  })
}

function parseApproval(body: Record<string, unknown>): { payload: ApprovalPayload; proof: string } | undefined {
  const approval = body.approval
  if (approval == null || typeof approval !== 'object' || Array.isArray(approval)) return undefined
  const rec = approval as { payload?: unknown; proof?: unknown }
  if (typeof rec.proof !== 'string' || !/^[0-9a-f]{64}$/i.test(rec.proof)) return undefined
  const payload = rec.payload as ApprovalPayload
  if (payload == null || typeof payload !== 'object') return undefined
  return { payload, proof: rec.proof.toLowerCase() }
}

export async function runPairCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: PairingCliIo = {},
  deps: PairingCliDeps = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const forbidden = forbiddenLauncherArgv(argv)
  if (forbidden != null) {
    writeLine(stderr, `${forbidden} is not permitted`)
    return 1
  }
  if (tlsVerificationDisabled(env)) {
    writeLine(stderr, 'NODE_TLS_REJECT_UNAUTHORIZED=0/false is not a success path')
    return 1
  }
  const rawUrl = parseFlagUrl(argv)
  if (rawUrl == null || rawUrl.length === 0) {
    writeLine(stderr, 'usage: kaola-mcp pair --url <https-origin> [--cancel]')
    return 1
  }
  let origin: string
  try {
    origin = normalizePairingOrigin(rawUrl)
  } catch {
    writeLine(stderr, 'pair --url must be an absolute URL')
    return 1
  }
  if (!origin.startsWith('https:')) {
    writeLine(stderr, 'kaola-mcp pair requires https; http loopback is not a private-CA pairing target')
    return 1
  }

  const kaolaHome = resolveKaolaHome(env)
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const transport = deps.transport ?? createDefaultPairingTransport()
  const pollIntervalMs = deps.pollIntervalMs ?? 2000
  const { ensureDeviceIdentity } = await import('./main.ts')

  if (hasCancel(argv)) {
    deletePairingReceipt(kaolaHome, origin)
    writeLine(stdout, '已删除本机配对回执。服务端申请未撤销。')
    return 0
  }

  const device = await ensureDeviceIdentity(kaolaHome)
  const deviceFp = fingerprintOfDevice(device)
  const existingV2 = inspectV2Trust(kaolaHome, origin)
  if (existingV2.present && !existingV2.ready) {
    writeLine(stderr, existingV2.message)
    return 1
  }

  const extraCa = extraCaPemForOrigin(kaolaHome, origin)
  try {
    const probe = await transport.request({
      method: 'GET',
      url: `${origin}/api/v1/setup`,
      headers: { accept: 'application/json' },
      body: Buffer.alloc(0),
      mode: 'strict',
      extraCaPem: extraCa,
    })
    if (probe.status > 0) {
      if (extraCa == null) {
        writeLine(stdout, '当前 origin 已由公开 CA 信任，无需安装额外根。')
        return 0
      }
      writeLine(stdout, '本机已完成该 origin 的信任，无需再次配对。')
      return 0
    }
  } catch (err) {
    if (classifyTlsFailure(err) !== 'unknown_issuer') {
      const message = err instanceof Error ? err.message : 'strict TLS failed'
      writeLine(stderr, message)
      return 1
    }
    if (extraCa != null) {
      writeLine(stdout, '本机 extra CA 无法校验当前 origin，需要管理员再次批准配对。')
    }
  }

  let receipt = readPairingReceipt(kaolaHome, origin, deviceFp)
  const unixNow = () => Math.floor(now() / 1000)
  if (receipt?.expires_at != null) {
    const expiresAt = Math.floor(Date.parse(receipt.expires_at) / 1000)
    if (!pairingIsLive(unixNow(), expiresAt)) {
      deletePairingReceipt(kaolaHome, origin)
      receipt = undefined
    }
  }
  if (receipt == null) {
    const secret = newPairingSecret()
    const clientNonce = newPairingNonce()
    receipt = {
      v: PAIRING_RECEIPT_VERSION,
      origin,
      pairing_id: null,
      instance_id: null,
      device_fingerprint: deviceFp,
      client_nonce: clientNonce.toString('hex'),
      server_nonce: null,
      secret: secret.toString('hex'),
      commitment: null,
      root_pem: null,
      root_sha256: null,
      expires_at: null,
    }
    writePairingReceipt(kaolaHome, receipt)
  }

  let created: Record<string, unknown>
  try {
    const createRes = await signedJson(transport, device, {
      origin,
      method: 'POST',
      pathname: '/api/v1/device-pairings',
      payload: { client_nonce: receipt.client_nonce },
      mode: 'bootstrap',
    })
    if (createRes.status !== 200 && createRes.status !== 201) {
      writeLine(stderr, `pairing create failed (${createRes.status})`)
      transport.destroy?.()
      return 1
    }
    created = jsonParse(createRes.body) ?? {}
  } catch (err) {
    transport.destroy?.()
    writeLine(stderr, err instanceof Error ? err.message : 'bootstrap create failed')
    return 1
  }

  const pairingId = typeof created.pairing_id === 'string' ? created.pairing_id : ''
  const instanceId = typeof created.instance_id === 'string' ? created.instance_id : ''
  const descriptorOrigin = typeof created.origin === 'string' ? created.origin : ''
  const serverNonce = typeof created.server_nonce === 'string' ? created.server_nonce : ''
  const rootPem = typeof created.root_pem === 'string' ? created.root_pem : ''
  const rootSha = typeof created.root_sha256 === 'string' ? created.root_sha256 : ''
  const expiresAt = typeof created.expires_at === 'string' ? created.expires_at : ''
  if (!PAIRING_ID_RE.test(pairingId) || instanceId.length === 0 || !/^[0-9a-f]{64}$/.test(serverNonce)) {
    transport.destroy?.()
    writeLine(stderr, 'pairing descriptor is invalid')
    return 1
  }
  if (descriptorOrigin !== origin) {
    transport.destroy?.()
    writeLine(stderr, 'pairing origin does not match --url')
    return 1
  }
  const inspectedRoot = inspectPublicRootPem(rootPem)
  if (!inspectedRoot.ok) {
    transport.destroy?.()
    writeLine(stderr, `advertised root rejected: ${inspectedRoot.code}`)
    return 1
  }
  if (!timingSafeEqualHex(inspectedRoot.fingerprintSha256, rootSha)) {
    transport.destroy?.()
    writeLine(stderr, 'advertised root_sha256 does not match root_pem')
    return 1
  }
  const expiresUnix = Math.floor(Date.parse(expiresAt) / 1000)
  if (!Number.isInteger(expiresUnix) || !pairingIsLive(unixNow(), expiresUnix)) {
    transport.destroy?.()
    deletePairingReceipt(kaolaHome, origin)
    writeLine(stderr, 'pairing attempt is expired')
    return 1
  }

  const transcript = encodePairingTranscript({
    pairingId,
    instanceId,
    origin,
    deviceFingerprint: deviceFp,
    clientNonce: Buffer.from(receipt.client_nonce, 'hex'),
    serverNonce: Buffer.from(serverNonce, 'hex'),
    rootCaSha256: Buffer.from(rootSha, 'hex'),
    expiresAt: expiresUnix,
  })
  const commitment = pairingCommitment(Buffer.from(receipt.secret, 'hex'), transcript).toString('hex')
  receipt = {
    ...receipt,
    pairing_id: pairingId,
    instance_id: instanceId,
    server_nonce: serverNonce,
    root_pem: inspectedRoot.pem,
    root_sha256: rootSha,
    expires_at: expiresAt,
    commitment,
  }
  writePairingReceipt(kaolaHome, receipt)

  try {
    const commitRes = await signedJson(transport, device, {
      origin,
      method: 'POST',
      pathname: `/api/v1/device-pairings/${pairingId}/commit`,
      payload: { commitment },
      mode: 'bootstrap',
    })
    if (commitRes.status !== 200) {
      transport.destroy?.()
      writeLine(stderr, `pairing commit failed (${commitRes.status})`)
      return 1
    }
  } catch (err) {
    transport.destroy?.()
    writeLine(stderr, err instanceof Error ? err.message : 'bootstrap commit failed')
    return 1
  }

  writeLine(stdout, `pairing_id: ${pairingId}`)
  writeLine(stdout, `device: ${deviceFp}`)
  writeLine(stdout, `配对密语: ${displayPairingSecret(Buffer.from(receipt.secret, 'hex'))}`)
  writeLine(stdout, '请把密语交给管理员，在「电脑」页授权。')

  let approved: { payload: ApprovalPayload; proof: string } | undefined
  while (pairingIsLive(unixNow(), expiresUnix)) {
    try {
      const statusRes = await signedJson(transport, device, {
        origin,
        method: 'POST',
        pathname: `/api/v1/device-pairings/${pairingId}/status`,
        payload: {},
        mode: 'bootstrap',
      })
      const statusBody = jsonParse(statusRes.body) ?? {}
      if (statusBody.status === 'approved') {
        approved = parseApproval(statusBody)
        if (approved == null) {
          transport.destroy?.()
          writeLine(stderr, 'approved pairing status is missing proof')
          return 1
        }
        break
      }
      if (statusBody.status === 'rejected' || statusBody.status === 'expired' || statusBody.status === 'consumed') {
        transport.destroy?.()
        deletePairingReceipt(kaolaHome, origin)
        writeLine(stderr, `pairing ${String(statusBody.status)}`)
        return 1
      }
    } catch (err) {
      transport.destroy?.()
      writeLine(stderr, err instanceof Error ? err.message : 'bootstrap status failed')
      return 1
    }
    await sleep(pollIntervalMs)
  }
  if (approved == null) {
    transport.destroy?.()
    deletePairingReceipt(kaolaHome, origin)
    writeLine(stderr, 'pairing expired before approval')
    return 1
  }

  const verified = verifyPairingApproval({
    receipt,
    payload: approved.payload,
    proofHex: approved.proof,
  })
  if (!verified.ok) {
    transport.destroy?.()
    writeLine(stderr, `approval proof failed: ${verified.reason}`)
    return 1
  }

  transport.destroy?.()

  const state: V2TrustState = {
    v: 2,
    alg: 'sha256',
    originDigest: pairingOriginDigest(origin),
    instanceId,
    deviceFingerprint: deviceFp,
    fingerprintSha256: rootSha,
    trustEpoch: 1,
    pairedAt: unixNow(),
  }
  const stateJson = JSON.stringify(state)
  if (stateJson.includes(origin) || stateJson.includes(receipt.secret) || /PRIVATE KEY/.test(stateJson)) {
    writeLine(stderr, 'v2 state must not contain origin, pairing secret, or private keys')
    return 1
  }

  const staging = writeV2Staging({
    kaolaHome,
    origin,
    pem: inspectedRoot.pem,
    state,
  })
  try {
    const who = await signedJson(transport, device, {
      origin,
      method: 'GET',
      pathname: '/api/v1/agent/whoami',
      payload: null,
      mode: 'strict',
      extraCaPem: inspectedRoot.pem,
    })
    if (who.status !== 200) {
      discardStaging(staging)
      writeLine(stderr, `strict whoami failed (${who.status})`)
      return 1
    }
    const whoBody = jsonParse(who.body) ?? {}
    if (whoBody.status !== 'active') {
      discardStaging(staging)
      writeLine(stderr, 'strict whoami is not active')
      return 1
    }
    if (whoBody.fingerprint !== deviceFp || whoBody.instance_id !== instanceId) {
      discardStaging(staging)
      writeLine(stderr, 'strict whoami does not match this device or instance')
      return 1
    }
    if (Object.hasOwn(whoBody, 'token') || String(who.body).includes('ktk_')) {
      discardStaging(staging)
      writeLine(stderr, 'strict whoami leaked a token')
      return 1
    }
    commitV2Staging(staging, origin, kaolaHome)
  } catch (err) {
    discardStaging(staging)
    writeLine(stderr, err instanceof Error ? err.message : 'strict reconnect failed')
    return 1
  }

  deletePairingReceipt(kaolaHome, origin)
  try {
    await signedJson(transport, device, {
      origin,
      method: 'POST',
      pathname: `/api/v1/device-pairings/${pairingId}/complete`,
      payload: {},
      mode: 'strict',
      extraCaPem: inspectedRoot.pem,
    })
  } catch {
    // complete is cleanup, not a trust gate
  }
  writeLine(stdout, '配对完成，本机严格 TLS 已就绪。')
  return 0
}
