import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
} from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
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

function writeJsonRpcLine(stdout: Writable, out: unknown): Promise<void> {
  const line = `${JSON.stringify(out)}\n`
  return new Promise((resolve, reject) => {
    stdout.write(line, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err != null && typeof err === 'object' && 'code' in err
}

// ---------------------------------------------------------------------------------------
// Issue #32 -- Claim recovery receipts.
//
// The bridge persists the smallest possible recovery receipt per (server origin, task) under
// its existing KAOLA_HOME boundary (see docs/decisions/0030-...md, "Local bridge receipt").
// It never contains a forge token, HTTP header, Task description, prompt, Workflow content,
// Runner frame, or transcript -- only enough identity to replay an idempotent Claim attempt
// and to auto-attach claim_id to later mutations, even from a fresh process.
// ---------------------------------------------------------------------------------------

const RECEIPTS_DIR = 'receipts'
const DEFAULT_CARRIER = 'direct'
const LOCK_SUFFIX = '.lock'
const LOCK_POLL_MS = 15
const LOCK_MAX_WAIT_MS = 8000
const LOCK_STALE_MS = 4000

type ClaimReceipt = {
  v: 1
  server: string
  task_id: string
  request_id: string
  claim_id: string | null
  repo_identity: string | null
  carrier: string
  runner: string | null
  runner_session: string | null
}

/**
 * Pure, deterministic digest of a normalized Kaola server origin (scheme + host; path and
 * trailing slash are irrelevant). Used as the receipt's `server` field and to namespace
 * receipts on disk per server without ever persisting the literal URL.
 */
export function originDigest(url: string): string {
  let normalized: string
  try {
    const parsed = new URL(stripTrailingSlash(String(url)))
    normalized = `${parsed.protocol}//${parsed.host}`
  } catch {
    normalized = stripTrailingSlash(String(url))
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * Deterministic absolute path for the (origin, task) receipt, always strictly inside
 * kaolaHome. Every path component derived from the caller's input is a hex digest, never the
 * raw task id or origin: a digest can never contain a path separator, `..`, a null byte, or
 * any other traversal-relevant byte, so hostile task ids (empty, absolute, `../..`, null
 * bytes, non-ASCII, over-long) are handled uniformly without extra validation logic.
 */
export function receiptFilePath(kaolaHome: string, url: string, taskId: string): string {
  const originHash = originDigest(url)
  const taskHash = createHash('sha256').update(String(taskId), 'utf8').digest('hex')
  return join(kaolaHome, RECEIPTS_DIR, originHash, `${taskHash}.json`)
}

/** Same 0700-dir/0600-file pattern ensureDeviceIdentity already uses for KAOLA_HOME. */
function ensureDirSecure(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

function writeReceiptAtomic(path: string, receipt: ClaimReceipt): void {
  ensureDirSecure(dirname(path))
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmpPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600, encoding: 'utf8' })
  chmodSync(tmpPath, 0o600)
  renameSync(tmpPath, path)
  chmodSync(path, 0o600)
}

function newPendingReceipt(server: string, taskId: string, requestId: string): ClaimReceipt {
  return {
    v: 1,
    server,
    task_id: taskId,
    request_id: requestId,
    claim_id: null,
    repo_identity: null,
    carrier: DEFAULT_CARRIER,
    runner: null,
    runner_session: null,
  }
}

/**
 * Reads a receipt defensively. A truncated/garbage/wrong-shape file, or one whose internal
 * (server, task_id) does not match the lookup key, is treated as "no usable receipt" rather
 * than trusted or surfaced as a crash.
 *
 * Corruption/mismatch recovery choice: regenerate a fresh pending receipt (see the claim flow
 * below) rather than a typed error. The server remains the sole source of truth for the Claim
 * itself and every attempt is keyed by a fresh request_id, so silently starting a new
 * (still-idempotent) attempt is always safe -- a hard error here would instead strand an Agent
 * on a local cache problem it has no way to repair.
 */
function readReceiptSafely(path: string, expectedServer: string, expectedTaskId: string): ClaimReceipt | null {
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (parsed.v !== 1) return null
  if (
    typeof parsed.server !== 'string' ||
    typeof parsed.task_id !== 'string' ||
    typeof parsed.request_id !== 'string'
  ) {
    return null
  }
  if (parsed.server !== expectedServer || parsed.task_id !== expectedTaskId) return null
  return {
    v: 1,
    server: parsed.server,
    task_id: parsed.task_id,
    request_id: parsed.request_id,
    claim_id: typeof parsed.claim_id === 'string' ? parsed.claim_id : null,
    repo_identity: typeof parsed.repo_identity === 'string' ? parsed.repo_identity : null,
    carrier: typeof parsed.carrier === 'string' ? parsed.carrier : DEFAULT_CARRIER,
    runner: typeof parsed.runner === 'string' ? parsed.runner : null,
    runner_session: typeof parsed.runner_session === 'string' ? parsed.runner_session : null,
  }
}

/**
 * Cross-process serialization for "originate a brand-new receipt": an atomic `open(..., 'wx')`
 * lock file next to the receipt. Whichever bridge process wins creates the pending receipt
 * (and its request_id); the loser waits for that receipt to appear and reuses it, so two
 * processes claiming the same task always converge on one request_id and therefore one
 * server-side claim. No daemon, scheduler, or new dependency.
 */
function tryAcquireReceiptLock(path: string): boolean {
  ensureDirSecure(dirname(path))
  const lockPath = `${path}${LOCK_SUFFIX}`
  try {
    const fd = openSync(lockPath, 'wx', 0o600)
    closeSync(fd)
    return true
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EEXIST') return false
    throw err
  }
}

function releaseReceiptLock(path: string): void {
  try {
    unlinkSync(`${path}${LOCK_SUFFIX}`)
  } catch {
    // best-effort: a missing lock file is not an error
  }
}

async function waitForPeerReceipt(
  path: string,
  expectedServer: string,
  expectedTaskId: string,
): Promise<ClaimReceipt | null> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  const lockPath = `${path}${LOCK_SUFFIX}`
  while (Date.now() < deadline) {
    const receipt = readReceiptSafely(path, expectedServer, expectedTaskId)
    if (receipt != null) return receipt
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS))
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs
      if (age > LOCK_STALE_MS) {
        // The lock holder appears to have crashed without ever writing a receipt; break the
        // stale lock so this process can originate its own attempt instead of waiting forever.
        unlinkSync(lockPath)
        return null
      }
    } catch {
      // lock already released; loop back and read the receipt directly
    }
  }
  return null
}

async function obtainClaimRequestId(
  kaolaHome: string,
  url: string,
  taskId: string,
): Promise<{ path: string; requestId: string }> {
  const server = originDigest(url)
  const path = receiptFilePath(kaolaHome, url, taskId)

  const existing = readReceiptSafely(path, server, taskId)
  if (existing != null) return { path, requestId: existing.request_id }

  if (tryAcquireReceiptLock(path)) {
    try {
      // A peer may have written a valid receipt between our first read and winning the lock.
      const afterLock = readReceiptSafely(path, server, taskId)
      if (afterLock != null) return { path, requestId: afterLock.request_id }
      const requestId = randomUUID()
      writeReceiptAtomic(path, newPendingReceipt(server, taskId, requestId))
      return { path, requestId }
    } finally {
      releaseReceiptLock(path)
    }
  }

  const peer = await waitForPeerReceipt(path, server, taskId)
  if (peer != null) return { path, requestId: peer.request_id }

  // The lock holder never produced a usable receipt (crash or an unexpectedly slow write);
  // fall back to originating our own attempt rather than hanging the bridge forever.
  const requestId = randomUUID()
  writeReceiptAtomic(path, newPendingReceipt(server, taskId, requestId))
  return { path, requestId }
}

function claimIdFromResult(result: unknown): string | null {
  if (!isPlainObject(result)) return null
  const lease = result.lease
  if (!isPlainObject(lease)) return null
  return typeof lease.claim_id === 'string' ? lease.claim_id : null
}

function repoIdentityFromResult(result: unknown): string | null {
  if (!isPlainObject(result)) return null
  const task = result.task
  if (!isPlainObject(task)) return null
  const repo = task.repo
  if (!isPlainObject(repo)) return null
  const forge = repo.forge
  const fullName = repo.full_name
  if (typeof forge !== 'string' || typeof fullName !== 'string') return null
  return `${forge}/${fullName}`
}

function claimIdForTask(kaolaHome: string, url: string, taskId: string): string | null {
  const receipt = readReceiptSafely(receiptFilePath(kaolaHome, url, taskId), originDigest(url), taskId)
  return receipt?.claim_id ?? null
}

// ---------------------------------------------------------------------------------------
// Transport: a single request/response cycle plus typed stale-session recovery.
// ---------------------------------------------------------------------------------------

type ForwardInput = {
  kaolaHome: string
  url: string
  body: unknown
  stdout?: Writable
  stderr?: Writable
  sessionId?: string
  onSessionId?: (sessionId: string) => void
}

async function performMcpRequest(input: ForwardInput): Promise<{ status: number; parsed: unknown }> {
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

  const fromHeader = res.headers.get('mcp-session-id')?.trim()
  if (fromHeader) {
    input.onSessionId?.(fromHeader)
  }

  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text.length === 0 ? null : JSON.parse(text)
  } catch {
    parsed = null
  }

  return { status: res.status, parsed }
}

function translateHttpResult(status: number, parsed: unknown, requestBody: unknown, stderr?: Writable): unknown {
  if (status === 202) {
    const obj = parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const errName = typeof obj.error === 'string' ? obj.error : 'authorization_required'
    const expiresAt = typeof obj.expires_at === 'string' ? obj.expires_at : ''
    const message =
      expiresAt.length > 0
        ? `${errName} pending until ${expiresAt}`
        : errName
    writeStderr(stderr, `MCP ${errName}`)
    return jsonRpcError(rpcId(requestBody), message)
  }

  if (status === 401 || status === 403) {
    const obj = parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const errName = typeof obj.error === 'string' ? obj.error : `http_${status}`
    writeStderr(stderr, `MCP ${errName}`)
    return jsonRpcError(rpcId(requestBody), errName)
  }

  if (parsed != null) return parsed
  return jsonRpcError(rpcId(requestBody), `http_${status}`)
}

export async function forwardMcpRequest(input: ForwardInput): Promise<unknown> {
  const { status, parsed } = await performMcpRequest(input)
  return translateHttpResult(status, parsed, input.body, input.stderr)
}

/**
 * The fake/real server signals a stale transport session either with HTTP 404 or with a
 * JSON-RPC -32001 "Session not found" error (or both together); either is treated as typed
 * session loss.
 */
function isSessionNotFound(status: number, parsed: unknown): boolean {
  if (status === 404) return true
  if (isPlainObject(parsed) && isPlainObject(parsed.error) && parsed.error.code === -32001) return true
  return false
}

export type StdioBridgeIo = {
  stdin: Readable
  stdout: Writable
  stderr: Writable
}

type BridgeCtx = {
  kaolaHome: string
  url: string
  stdout: Writable
  stderr: Writable
  sessionId?: string
  lastInitializeBody?: unknown
}

const KNOWN_TOOLS = new Set([
  'list_tasks',
  'get_task_brief',
  'claim_task',
  'report_progress',
  'release_task',
  'submit_pr',
])
const MUTATION_TOOLS = new Set(['report_progress', 'release_task', 'submit_pr'])
const FALLBACK_PROTOCOL_VERSION = '2025-11-25'

/**
 * Sends one JSON-RPC body and, on a typed stale session, discards only the in-memory session
 * id, re-initializes exactly once, and replays this exact body exactly once. A second
 * consecutive stale session (e.g. the re-initialize itself cannot recover a usable session, or
 * the replay is stale again) falls through and is surfaced as an error rather than looping.
 */
async function dispatch(ctx: BridgeCtx, body: unknown): Promise<unknown> {
  if (isPlainObject(body) && body.method === 'initialize') {
    ctx.lastInitializeBody = body
  }

  const attempt = () =>
    performMcpRequest({
      kaolaHome: ctx.kaolaHome,
      url: ctx.url,
      body,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
      sessionId: ctx.sessionId,
      onSessionId: (id) => {
        ctx.sessionId = id
      },
    })

  let result = await attempt()

  if (isSessionNotFound(result.status, result.parsed)) {
    writeStderr(ctx.stderr, 'MCP session not found; re-initializing and replaying once')
    ctx.sessionId = undefined
    const recovered = await reinitialize(ctx)
    if (recovered) {
      result = await attempt()
    }
  }

  return translateHttpResult(result.status, result.parsed, body, ctx.stderr)
}

async function reinitialize(ctx: BridgeCtx): Promise<boolean> {
  const fallbackInit: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: `kaola-mcp-reinit-${randomUUID()}`,
    method: 'initialize',
    params: {
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'kaola-mcp-bridge', version: '1' },
    },
  }
  const initBody = ctx.lastInitializeBody ?? fallbackInit

  try {
    const res = await performMcpRequest({
      kaolaHome: ctx.kaolaHome,
      url: ctx.url,
      body: initBody,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
      onSessionId: (id) => {
        ctx.sessionId = id
      },
    })
    return ctx.sessionId != null && res.status < 400
  } catch (err) {
    writeStderr(ctx.stderr, `MCP re-initialize failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    return false
  }
}

async function handleClaimTask(
  ctx: BridgeCtx,
  rawBody: Record<string, unknown>,
  params: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<unknown> {
  const taskId = args.task_id
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return dispatch(ctx, rawBody)
  }

  // Receipt-first: generate/recover request_id and persist the pending receipt atomically
  // BEFORE forwarding, so a kill between here and the response always leaves a durable,
  // replayable attempt behind.
  const { path, requestId } = await obtainClaimRequestId(ctx.kaolaHome, ctx.url, taskId)
  const rewrittenBody: Record<string, unknown> = {
    ...rawBody,
    params: { ...params, arguments: { ...args, request_id: requestId } },
  }

  const out = await dispatch(ctx, rewrittenBody)

  if (isPlainObject(out) && out.result !== undefined) {
    writeReceiptAtomic(path, {
      v: 1,
      server: originDigest(ctx.url),
      task_id: taskId,
      request_id: requestId,
      claim_id: claimIdFromResult(out.result),
      repo_identity: repoIdentityFromResult(out.result),
      carrier: DEFAULT_CARRIER,
      runner: null,
      runner_session: null,
    })
  }

  return out
}

async function handleMutation(
  ctx: BridgeCtx,
  rawBody: Record<string, unknown>,
  params: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<unknown> {
  const taskId = args.task_id
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return dispatch(ctx, rawBody)
  }

  const claimId = claimIdForTask(ctx.kaolaHome, ctx.url, taskId)
  const rewrittenArgs = claimId != null ? { ...args, claim_id: claimId } : args
  const rewrittenBody: Record<string, unknown> = { ...rawBody, params: { ...params, arguments: rewrittenArgs } }
  return dispatch(ctx, rewrittenBody)
}

/**
 * Parses and rewrites `tools/call` params for exactly the six known tools; every other
 * JSON-RPC method, and any unknown tool name inside `tools/call`, is forwarded structurally
 * unmodified.
 */
async function handleLine(ctx: BridgeCtx, rawBody: unknown): Promise<unknown> {
  if (!isPlainObject(rawBody) || rawBody.method !== 'tools/call' || !isPlainObject(rawBody.params)) {
    return dispatch(ctx, rawBody)
  }
  const params = rawBody.params
  const name = params.name
  if (typeof name !== 'string' || !KNOWN_TOOLS.has(name) || !isPlainObject(params.arguments)) {
    return dispatch(ctx, rawBody)
  }
  const args = params.arguments

  if (name === 'claim_task') return handleClaimTask(ctx, rawBody, params, args)
  if (MUTATION_TOOLS.has(name)) return handleMutation(ctx, rawBody, params, args)
  // list_tasks / get_task_brief: known tools, nothing to rewrite.
  return dispatch(ctx, rawBody)
}

export async function runStdioBridge(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io?: StdioBridgeIo,
): Promise<void> {
  const url = resolveKaolaUrl(argv, env as Record<string, string | undefined>)
  const kaolaHome = kaolaHomeFromEnv(env)
  await ensureDeviceIdentity(kaolaHome)
  const stdin = io?.stdin ?? process.stdin
  const stdout = io?.stdout ?? process.stdout
  const stderr = io?.stderr ?? process.stderr

  if (url.startsWith('http:') && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(`${url}/`)) {
    writeStderr(stderr, 'KAOLA url is http (not localhost); prefer https')
  }

  const ctx: BridgeCtx = { kaolaHome, url, stdout, stderr }
  const rl = createInterface({ input: stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let body: unknown
    try {
      body = JSON.parse(trimmed)
    } catch {
      writeStderr(stderr, 'ignored non-JSON stdin line')
      continue
    }
    const out = await handleLine(ctx, body)
    await writeJsonRpcLine(stdout, out)
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
