import { createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { deviceProofCanonical } from '@kaola/shared'

const DEFAULT_ORIGIN = 'http://localhost:31415'
const MCP_PATH = '/api/mcp'

export type DeviceIdentity = {
  v: 1
  privateKeyPkcs8: string
  publicKeySpki: string
  createdAt: string
}

export function resolveKaolaUrl(
  argv: readonly string[] = [],
  env: Record<string, string | undefined> = {},
): string {
  let fromFlag: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') {
      fromFlag = argv[i + 1]
      break
    }
  }
  const raw = (fromFlag && fromFlag.length > 0 ? fromFlag : undefined) ??
    (typeof env.KAOLA_URL === 'string' && env.KAOLA_URL.length > 0 ? env.KAOLA_URL : undefined) ??
    DEFAULT_ORIGIN
  return stripTrailingSlash(raw)
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function kaolaHomeFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KAOLA_HOME
  if (typeof override === 'string' && override.length > 0) return override
  return join(homedir(), '.kaola')
}

export async function ensureDeviceIdentity(kaolaHome: string): Promise<DeviceIdentity> {
  mkdirSync(kaolaHome, { recursive: true, mode: 0o700 })
  chmodSync(kaolaHome, 0o700)

  const devicePath = join(kaolaHome, 'device.json')
  if (existsSync(devicePath)) {
    const parsed = JSON.parse(readFileSync(devicePath, 'utf8')) as DeviceIdentity
    chmodSync(devicePath, 0o600)
    return parsed
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const device: DeviceIdentity = {
    v: 1,
    privateKeyPkcs8: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64'),
    publicKeySpki: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
    createdAt: new Date().toISOString(),
  }
  writeFileSync(devicePath, `${JSON.stringify(device)}\n`, { mode: 0o600, encoding: 'utf8' })
  chmodSync(devicePath, 0o600)
  return device
}

function signDeviceHeaders(device: DeviceIdentity, bodyBuf: Buffer): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(16).toString('hex')
  const canonical = deviceProofCanonical({
    ts,
    nonce,
    method: 'POST',
    pathname: MCP_PATH,
    body: bodyBuf,
  })
  const privateKey = createPrivateKey({
    key: Buffer.from(device.privateKeyPkcs8, 'base64'),
    type: 'pkcs8',
    format: 'der',
  })
  const sig = cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKey)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'X-Kaola-Key': device.publicKeySpki,
    'X-Kaola-Ts': ts,
    'X-Kaola-Nonce': nonce,
    'X-Kaola-Sig': sig.toString('base64'),
  }
  try {
    headers['X-Kaola-Hostname'] = hostname()
  } catch {
    // hostname is untrusted and optional
  }
  return headers
}

function rpcId(body: unknown): unknown {
  if (body != null && typeof body === 'object' && 'id' in body) {
    return (body as { id: unknown }).id
  }
  return null
}

function jsonRpcError(id: unknown, message: string): {
  jsonrpc: '2.0'
  id: unknown
  error: { code: number; message: string }
} {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message },
  }
}

function writeStderr(stderr: Writable | undefined, line: string): void {
  if (stderr != null) {
    stderr.write(`${line}\n`)
    return
  }
  process.stderr.write(`${line}\n`)
}

export async function forwardMcpRequest(input: {
  kaolaHome: string
  url: string
  body: unknown
  stdout?: Writable
  stderr?: Writable
  sessionId?: string
}): Promise<unknown> {
  const device = await ensureDeviceIdentity(input.kaolaHome)
  const origin = stripTrailingSlash(input.url)
  const bodyBuf = Buffer.from(JSON.stringify(input.body), 'utf8')
  const headers = signDeviceHeaders(device, bodyBuf)
  if (input.sessionId) {
    headers['mcp-session-id'] = input.sessionId
  }

  const res = await fetch(`${origin}${MCP_PATH}`, {
    method: 'POST',
    headers,
    body: bodyBuf,
  })

  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text.length === 0 ? null : JSON.parse(text)
  } catch {
    parsed = null
  }

  if (res.status === 202) {
    const obj = parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const errName = typeof obj.error === 'string' ? obj.error : 'authorization_required'
    const expiresAt = typeof obj.expires_at === 'string' ? obj.expires_at : ''
    const message =
      expiresAt.length > 0
        ? `${errName} pending until ${expiresAt}`
        : errName
    writeStderr(input.stderr, `MCP ${errName}`)
    return jsonRpcError(rpcId(input.body), message)
  }

  if (res.status === 401 || res.status === 403) {
    const obj = parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const errName = typeof obj.error === 'string' ? obj.error : `http_${res.status}`
    writeStderr(input.stderr, `MCP ${errName}`)
    return jsonRpcError(rpcId(input.body), errName)
  }

  if (parsed != null) return parsed
  return jsonRpcError(rpcId(input.body), `http_${res.status}`)
}

export async function runStdioBridge(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const url = resolveKaolaUrl(argv, env as Record<string, string | undefined>)
  const kaolaHome = kaolaHomeFromEnv(env)
  await ensureDeviceIdentity(kaolaHome)

  if (url.startsWith('http:') && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(`${url}/`)) {
    writeStderr(process.stderr, 'KAOLA url is http (not localhost); prefer https')
  }

  let sessionId: string | undefined
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let body: unknown
    try {
      body = JSON.parse(trimmed)
    } catch {
      writeStderr(process.stderr, 'ignored non-JSON stdin line')
      continue
    }
    const out = await forwardMcpRequest({
      kaolaHome,
      url,
      body,
      stderr: process.stderr,
      sessionId,
    })
    process.stdout.write(`${JSON.stringify(out)}\n`)
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (entry == null) return false
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectRun()) {
  runStdioBridge().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'kaola-mcp failed'
    process.stderr.write(`${message}\n`)
    process.exit(1)
  })
}
