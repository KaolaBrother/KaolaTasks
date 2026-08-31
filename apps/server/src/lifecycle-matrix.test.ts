// Issue #35 — "Prove end-to-end Claim lifecycle parity and recovery."
//
// INDEPENDENT TEST CUSTODY. This suite re-verifies, at the INTEGRATION layer, what #36/#31/#32/
// #33/#34's own focused suites (claim-identity.test.ts, claim-fencing.test.ts,
// apps/mcp/src/claim-receipt.test.ts, workflow-default.test.ts, apps/mcp/src/runner-carrier.test.ts)
// already proved in isolation. It is deliberately NOT a re-run of those suites: every test here
// boots the REAL Fastify app (buildApp from ./app.ts) on a REAL TCP port, and drives it with the
// REAL kaola-mcp bridge (apps/mcp/src/main.ts) as a genuine child process talking real stdio
// JSON-RPC over a real HTTP connection — the same technique apps/mcp/src/claim-receipt.test.ts
// already uses for its own "two processes sharing one KAOLA_HOME" test, just pointed at the real
// server instead of a fake one. The only things stubbed anywhere in this file are the THIRD-PARTY
// forge HTTP endpoints (validateToken's repo/user lookups) — never any Kaola-owned layer.
//
// Device pairing is driven for real, not bypassed: the bridge mints its own on-disk Ed25519
// device identity (apps/mcp/src/main.ts's ensureDeviceIdentity) and signs every request
// (apps/server/src/device-proof.ts); this suite drives the exact admin pairing flow
// (GET /api/v1/devices/pending, POST /api/v1/devices/:id/bind) documented in devices.ts and
// exercised by devices.test.ts, against the bridge's own real pending-device row.
//
// Scope notes (read before extending):
//  - "Response lost" is simulated with a small transparent TCP-level proxy this file owns
//    (startInterceptProxy below): it forwards every byte to the real backend and only ever
//    chooses, per request, to either deliver the real upstream response unmodified or to hold it
//    for a fixed delay / destroy the client socket AFTER the real upstream response was fully
//    received (i.e. strictly after the real claim.ts transaction already committed). This is a
//    transport-layer test double for a flaky network, not a stub of any Kaola code — the real
//    Fastify app answers every request for real.
//  - "Server restart" closes the real buildApp() instance and boots a brand new one against the
//    SAME sqlite file, re-listening on the SAME port — a fresh in-memory Fastify/MCP-session state
//    over the same durable storage, which is what an operator's process restart looks like from
//    the bridge's perspective.
//  - "Bridge restart" kills the real child process (SIGKILL) and spawns a fresh one pointed at the
//    same KAOLA_HOME, mirroring apps/mcp/src/claim-receipt.test.ts's own kill/restart boundary
//    tests, elevated here to a real network round trip against the real server.
//  - Live-provider (real GitLab/Gitea) smoke is NOT executed by this suite. No GITLAB_TOKEN /
//    GITEA_TOKEN is set in this environment and there is no .env anywhere in the repo or worktree
//    (verified before writing this file); `scripts/forge-smoke.ts` also exits for `github` by
//    design. The "three forges" coverage below is the shared-fixture / stubbed-forge coverage the
//    brief calls for, not a live-provider run — it is never represented as one.
//  - No git clone/checkout is ever executed by this suite (the claim response's clone recipe is
//    asserted as data, never acted on), so there is no git config surface for this suite to create
//    or scan. Noted explicitly rather than silently skipped.
//  - No Project Runner (kaola-project-runner / kaola-tmux.sh) is ever started here. The live
//    Runner evidence run for #34 already happened and is recorded at
//    kaola-workflow/bundle-31-32-33-34-35-36/.cache/runner-live-evidence.md; this suite instead
//    proves the *absence* of any Runner invocation on the default direct path (a poisoned
//    kaola-tmux.sh on PATH — see "zero Project Runner calls" below) and proves carrier parity by
//    setting the bridge's own KAOLA_CARRIER=runner env var, which apps/mcp/src/main.ts only ever
//    uses to choose what to *record* in the local receipt — it never spawns anything.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { ensureSetup, sqliteFile } from './auth.test-helpers.ts'
import { claimIdForLease } from './leases.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAIN_PATH = join(HERE, '..', '..', 'mcp', 'src', 'main.ts')

function applyTestEnv() {
  process.env.OAUTH_GITHUB_CLIENT_ID = 'test-github-client-id'
  process.env.OAUTH_GITHUB_CLIENT_SECRET = 'test-github-client-secret'
  process.env.OAUTH_GITLAB_CLIENT_ID = 'test-gitlab-client-id'
  process.env.OAUTH_GITLAB_CLIENT_SECRET = 'test-gitlab-client-secret'
  process.env.OAUTH_GITLAB_BASE_URL = 'https://gitlab.example.test'
  process.env.OAUTH_GITEA_CLIENT_ID = 'test-gitea-client-id'
  process.env.OAUTH_GITEA_CLIENT_SECRET = 'test-gitea-client-secret'
  process.env.OAUTH_GITEA_BASE_URL = 'https://gitea.example.test'
  process.env.SESSION_SECRET = '7'.repeat(32)
  process.env.PUBLIC_URL = 'http://localhost:3000'
  process.env.VAULT_MASTER_KEY = 'a1'.repeat(32)
}
applyTestEnv()

const { buildApp } = await import('./app.ts')

const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' }

// ---------------------------------------------------------------------------------------
// Forge HTTP stub (the one legitimate third-party stub in this file) — same shape/classifier as
// claim-fencing.test.ts / devices.test.ts's own beginFetch, duplicated deliberately per this
// codebase's established house style rather than imported cross-file.
// ---------------------------------------------------------------------------------------

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input && typeof input === 'object' && 'url' in input) return String(input.url)
  return String(input)
}

function headerValue(headers, name) {
  if (headers == null) return undefined
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }
  if (Array.isArray(headers)) {
    const hit = headers.find(([key]) => String(key).toLowerCase() === name)
    return hit?.[1]
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

function readHeader(input, init, name) {
  const fromInit = headerValue(init?.headers, name)
  if (fromInit != null) return fromInit
  if (input && typeof input === 'object' && 'headers' in input) {
    return headerValue(input.headers, name)
  }
  return undefined
}

function stubbedToken(input, init) {
  const priv = readHeader(input, init, 'private-token')
  if (typeof priv === 'string' && priv !== '') return priv
  const auth = readHeader(input, init, 'authorization')
  const match = typeof auth === 'string' ? auth.match(/^(?:Bearer|token)\s+(\S+)/i) : null
  return match?.[1]
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function isRepoEndpoint(url) {
  return url.includes('/repos/') || url.includes('/projects/')
}

function isUserEndpoint(url) {
  return url.endsWith('/user')
}

function beginFetchStub(t) {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const forge = new Map()
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    const token = stubbedToken(input, init)
    const forgeStub = token == null ? undefined : forge.get(token)
    if (forgeStub != null) {
      if (isRepoEndpoint(url)) return jsonResponse(200, forgeStub.repo ?? {})
      if (isUserEndpoint(url)) return jsonResponse(200, { id: 4242, login: 'forge-bot' })
      return jsonResponse(500, { error: 'unstubbed forge endpoint', url })
    }
    return jsonResponse(500, { error: 'unstubbed fetch', url, token: token ?? null })
  }
  return { forge }
}

const REPO_FULL_ACCESS = {
  permissions: { pull: true, push: true, admin: false },
  has_pull_requests: true,
  private: true,
}

const GITLAB_REPO_ACCESS = {
  permissions: {
    project_access: { access_level: 40 },
    group_access: { access_level: 0 },
  },
  repository_access_level: 'enabled',
  can_create_merge_request_in: true,
  merge_requests_access_level: 'enabled',
}

function forgeRepoDescriptor(forge) {
  return forge === 'gitlab' ? GITLAB_REPO_ACCESS : REPO_FULL_ACCESS
}

function allowForgeToken(stub, token, forge) {
  stub.forge.set(token, { repo: forgeRepoDescriptor(forge) })
}

function prUrlFor(forge, baseUrl, fullName, number) {
  if (forge === 'github') return `${baseUrl}/${fullName}/pull/${number}`
  if (forge === 'gitlab') return `${baseUrl}/${fullName}/-/merge_requests/${number}`
  return `${baseUrl}/${fullName}/pulls/${number}`
}

// ---------------------------------------------------------------------------------------
// Real server boot / restart.
// ---------------------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolveP) => setTimeout(resolveP, ms))
}

async function listenWithRetry(app, port, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      await app.listen({ port, host: '127.0.0.1' })
      return
    } catch (err) {
      if (err && err.code === 'EADDRINUSE' && i < attempts - 1) {
        await sleep(50)
        continue
      }
      throw err
    }
  }
}

async function bootApp(t, opts = {}) {
  const sqlitePath = sqliteFile(t, 'kaola-lifecycle-')
  const app = buildApp({ sqlitePath, ...opts })
  await app.listen({ port: 0, host: '127.0.0.1' })
  t.after(async () => {
    await app.close()
  })
  const port = app.server.address().port
  const admin = await ensureSetup(app)
  return { app, sqlitePath, port, origin: `http://127.0.0.1:${port}`, admin }
}

// A real process restart: closes the real Fastify instance and boots a brand new one against the
// same durable sqlite file, re-listening on the SAME port so the bridge's already-configured
// --url never has to change (matching what an operator's fixed server URL looks like across a
// restart). Every in-memory MCP session and poller timer from the old instance is genuinely gone.
async function restartApp(t, prev) {
  await prev.app.close()
  const app = buildApp({ sqlitePath: prev.sqlitePath })
  await listenWithRetry(app, prev.port)
  t.after(async () => {
    await app.close()
  })
  const admin = await ensureSetup(app)
  return { app, sqlitePath: prev.sqlitePath, port: prev.port, origin: prev.origin, admin }
}

// ---------------------------------------------------------------------------------------
// A transparent response-loss / delay proxy sitting in front of the real server. It never
// fabricates, mutates, or short-circuits a response on its own — it always waits for the REAL
// upstream (the real Fastify app) to answer in full, and only then chooses to deliver it, delay
// it, or withhold it. That means every "response lost" scenario in this file is a genuine
// post-commit transport failure, never a stand-in for the app's own decision.
// ---------------------------------------------------------------------------------------

function startInterceptProxy(t, backendPort, { dropFor = () => false, delayMsFor = () => 0 } = {}) {
  const proxy = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks)
      let parsedBody
      try {
        parsedBody = JSON.parse(bodyBuf.toString('utf8'))
      } catch {
        parsedBody = null
      }
      const upstreamReq = http.request(
        { host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers: req.headers },
        (upRes) => {
          const outChunks = []
          upRes.on('data', (c) => outChunks.push(c))
          upRes.on('end', () => {
            const outBuf = Buffer.concat(outChunks)
            if (process.env.KAOLA_PROXY_DEBUG) {
              console.error('PROXY DEBUG', req.url, parsedBody?.params?.name, upRes.statusCode, outBuf.toString('utf8').slice(0, 500))
            }
            const deliver = () => {
              if (dropFor(parsedBody)) {
                req.socket.destroy()
                return
              }
              res.writeHead(upRes.statusCode, upRes.headers)
              res.end(outBuf)
            }
            const delay = delayMsFor(parsedBody)
            if (delay > 0) setTimeout(deliver, delay)
            else deliver()
          })
        },
      )
      upstreamReq.on('error', () => {
        try {
          req.socket.destroy()
        } catch {
          // already gone
        }
      })
      upstreamReq.write(bodyBuf)
      upstreamReq.end()
    })
  })
  t.after(() => proxy.close())
  return new Promise((resolveP) => {
    proxy.listen(0, '127.0.0.1', () => {
      const addr = proxy.address()
      resolveP({ origin: `http://127.0.0.1:${addr.port}` })
    })
  })
}

function isToolCall(body, name, taskId) {
  return (
    body != null &&
    typeof body === 'object' &&
    body.method === 'tools/call' &&
    body.params?.name === name &&
    body.params?.arguments?.task_id === taskId
  )
}

function once(predicate) {
  let used = false
  return (body) => {
    if (used) return false
    if (predicate(body)) {
      used = true
      return true
    }
    return false
  }
}

// ---------------------------------------------------------------------------------------
// Real child-process bridge.
// ---------------------------------------------------------------------------------------

function tmpKaolaHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-lifecycle-home-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function spawnBridge(t, { home, origin, env = {} }) {
  const child = spawn(process.execPath, ['--experimental-strip-types', MAIN_PATH, '--url', origin], {
    env: { ...process.env, KAOLA_HOME: home, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => {
    out += String(c)
  })
  child.stderr.on('data', (c) => {
    err += String(c)
  })
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill()
  })
  return {
    child,
    send: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    end: () => child.stdin.end(),
    kill: (signal) => child.kill(signal),
    stdoutText: () => out,
    stderrText: () => err,
    exit: () => new Promise((resolveP) => child.on('exit', (code) => resolveP(code))),
  }
}

function parseJsonRpcStdout(text) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed[0] !== '{') continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed != null && typeof parsed === 'object' && parsed.jsonrpc === '2.0') out.push(parsed)
  }
  return out
}

async function waitForRpcId(bridge, id, { timeoutMs = 15000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = parseJsonRpcStdout(bridge.stdoutText()).find((r) => r.id === id)
    if (hit) return hit
    await sleep(pollMs)
  }
  throw new Error(
    `RPC id ${JSON.stringify(id)} not observed within ${timeoutMs}ms; stdout=${bridge.stdoutText()} stderr=${bridge.stderrText()}`,
  )
}

let rpcIdSeq = 0
function nextId(label) {
  rpcIdSeq += 1
  return `${label}-${rpcIdSeq}`
}

function initializeRpc(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifecycle-matrix', version: '0' } },
  }
}

function claimRpc(id, taskId, extra = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'claim_task', arguments: { task_id: taskId, ...extra } } }
}

function mutationRpc(id, name, args) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

// A tools/call failure (claim_id_required, stale_claim, conflict, ...) surfaces as a normal
// JSON-RPC `result` with `isError: true` on the CallToolResult (see toToolResult in mcp.ts) — it
// is NOT the JSON-RPC transport-level `error` field, which only appears for protocol/transport
// faults (bad session, malformed request). Checking `.error === undefined` alone would silently
// accept a business-level failure as success; every tool-call assertion in this suite must go
// through this helper instead.
function assertToolOk(res, label) {
  assert.equal(res?.error, undefined, `${label}: transport-level error ${JSON.stringify(res)}`)
  assert.notEqual(res?.result?.isError, true, `${label}: tool call failed ${JSON.stringify(res)}`)
}

function toolFailed(res) {
  return res?.error != null || res?.result?.isError === true
}

async function initializeBridge(bridge) {
  const id = nextId('init')
  bridge.send(initializeRpc(id))
  const res = await waitForRpcId(bridge, id)
  assertToolOk(res, `initialize must succeed: ${JSON.stringify(res)}`)
  return res
}

// Spawns a throwaway bridge whose first (rejected, device-pending) call creates the real pending
// device row, then binds it through the real admin REST flow (devices.ts), exactly as an operator
// would from the web UI. The device identity lives on disk under `home` — every later bridge
// process pointed at the same `home` reuses it and is already paired.
async function pairFreshBridgeDevice(t, ctx, { home, ownerKind = 'claimant', displayName = 'Lifecycle Bot' }) {
  const pairing = spawnBridge(t, { home, origin: ctx.origin })
  const id = nextId('pair')
  pairing.send(initializeRpc(id))
  const res = await waitForRpcId(pairing, id)
  assert.ok(res.error, `an unpaired device's first call must be rejected pending approval: ${JSON.stringify(res)}`)
  pairing.end()
  await pairing.exit()

  const pending = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/devices/pending',
    cookies: ctx.admin.cookies,
    headers: { accept: 'application/json' },
  })
  assert.equal(pending.statusCode, 200, `GET pending devices: ${pending.statusCode} ${pending.body}`)
  const rows = pending.json().devices
  assert.ok(rows.length >= 1, `expected a pending device row from the real bridge, got ${pending.body}`)
  const row = rows[rows.length - 1]

  const bindBody = ownerKind === 'claimant' ? { claimant_display_name: displayName } : { bind_to_self: true }
  const bound = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/devices/${row.id}/bind`,
    cookies: ctx.admin.cookies,
    headers: JSON_HEADERS,
    payload: bindBody,
  })
  assert.equal(bound.statusCode, 200, `POST bind device: ${bound.statusCode} ${bound.body}`)
  return { deviceId: row.id }
}

// ---------------------------------------------------------------------------------------
// Task fixtures.
// ---------------------------------------------------------------------------------------

let taskSeq = 0
function taskPayload({ forge, baseUrl, fullName, token, title }) {
  taskSeq += 1
  return {
    title: title ?? `lifecycle-${forge}-${taskSeq}`,
    description_md: '# lifecycle matrix fixture',
    source: { type: 'native' },
    repo: { forge, base_url: baseUrl, full_name: fullName, base_branch: 'main', suggested_dir: 'work' },
    acceptance_criteria: ['passes CI'],
    test_command: 'pnpm test',
    constraints: { allowed_paths: ['src/**'], forbidden_paths: [] },
    priority: 'P1',
    tags: ['lifecycle-matrix'],
    credential: { token },
  }
}

async function createTask(ctx, payload) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    cookies: ctx.admin.cookies,
    headers: JSON_HEADERS,
    payload,
  })
  assert.equal(res.statusCode, 201, `POST /api/v1/tasks: ${res.statusCode} ${res.body}`)
  return res.json()
}

// ---------------------------------------------------------------------------------------
// Direct sqlite inspection — real durable artifacts, never the app's own in-memory state. Reads
// use a dedicated read-only connection so they never contend with the app's own writer.
// ---------------------------------------------------------------------------------------

function withReadDb(sqlitePath, fn) {
  const db = new Database(sqlitePath, { readonly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function withWriteDb(sqlitePath, fn) {
  const db = new Database(sqlitePath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function leaseRowsForTask(sqlitePath, publicId) {
  return withReadDb(sqlitePath, (db) =>
    db
      .prepare(
        `SELECT leases.* FROM leases JOIN tasks ON tasks.id = leases.task_id WHERE tasks.public_id = ? ORDER BY leases.id`,
      )
      .all(publicId),
  )
}

function submissionRowsForTask(sqlitePath, publicId) {
  return withReadDb(sqlitePath, (db) =>
    db
      .prepare(
        `SELECT submissions.* FROM submissions JOIN tasks ON tasks.id = submissions.task_id WHERE tasks.public_id = ? ORDER BY submissions.id`,
      )
      .all(publicId),
  )
}

function taskRow(sqlitePath, publicId) {
  return withReadDb(sqlitePath, (db) => db.prepare(`SELECT * FROM tasks WHERE public_id = ?`).get(publicId))
}

function allEventRows(sqlitePath) {
  return withReadDb(sqlitePath, (db) => db.prepare(`SELECT * FROM events ORDER BY id`).all())
}

function expireLeaseNow(sqlitePath, leaseId) {
  withWriteDb(sqlitePath, (db) => {
    db.prepare(`UPDATE leases SET expires_at = ? WHERE id = ?`).run(Math.floor(Date.now() / 1000) - 10, leaseId)
  })
}

// ---------------------------------------------------------------------------------------
// Secret scan.
// ---------------------------------------------------------------------------------------

function walkFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkFiles(path))
    else out.push(path)
  }
  return out
}

function assertNoSecrets(text, secrets, label) {
  for (const secret of secrets) {
    if (secret == null || secret === '') continue
    assert.equal(String(text).includes(secret), false, `${label} must not contain: ${secret}`)
  }
}

// ---------------------------------------------------------------------------------------
// A poisoned Runner launcher: if this is ever invoked, it proves the default direct path shelled
// out to the Project Runner, which must never happen. It writes a marker file and fails loudly.
// ---------------------------------------------------------------------------------------

function poisonedRunnerBin(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-poison-bin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const marker = join(dir, 'invoked.marker')
  const scriptPath = join(dir, 'kaola-tmux.sh')
  writeFileSync(scriptPath, `#!/bin/sh\necho "kaola-tmux.sh was invoked" >> "${marker}"\nexit 17\n`)
  chmodSync(scriptPath, 0o755)
  return { dir, marker }
}

const TEST_TIMEOUT = 45000

// =========================================================================================
// Matrix
// =========================================================================================

describe('Issue #35 — Claim lifecycle parity and recovery (real server + real bridge)', () => {
  describe('response loss and restart convergence', () => {
    test(
      'a lost claim response, a bridge crash, and a server restart converge to exactly one active Claim',
      { timeout: TEST_TIMEOUT },
      async (t) => {
        const ctx = await bootApp(t)
        const stub = beginFetchStub(t)
        const token = 'gitea-token-loss-conv-01'
        allowForgeToken(stub, token, 'gitea')
        const brief = await createTask(ctx, taskPayload({ forge: 'gitea', baseUrl: 'https://gitea.forge.test', fullName: 'kaola/loss-conv', token }))
        const home = tmpKaolaHome(t)
        await pairFreshBridgeDevice(t, ctx, { home })

        const dropClaim = once((body) => isToolCall(body, 'claim_task', brief.id))
        const { origin: proxyOrigin } = await startInterceptProxy(t, ctx.port, { dropFor: dropClaim })

        // Attempt 1: the server commits the claim for real, but the response never reaches the
        // bridge (proxy destroys the client socket after the real upstream 200). The bridge's
        // unhandled fetch failure crashes that process — matching the exact tolerated-crash shape
        // apps/mcp/src/claim-receipt.test.ts's own "response was lost" boundary test accepts.
        const first = spawnBridge(t, { home, origin: proxyOrigin })
        await initializeBridge(first)
        first.send(claimRpc(nextId('claim'), brief.id))
        await first.exit()

        assert.equal(leaseRowsForTask(ctx.sqlitePath, brief.id).length, 1, 'server must have committed exactly one lease despite the lost response')

        // Bridge restart: a fresh process, same KAOLA_HOME, replays via the persisted receipt.
        const second = spawnBridge(t, { home, origin: proxyOrigin })
        await initializeBridge(second)
        const claimId2 = nextId('claim')
        second.send(claimRpc(claimId2, brief.id))
        const claimRes = await waitForRpcId(second, claimId2)
        assertToolOk(claimRes, `recovered claim must succeed: ${JSON.stringify(claimRes)}`)
        assert.ok(claimRes.result?.structuredContent?.lease?.claim_id, `recovered claim must carry a claim_id: ${JSON.stringify(claimRes)}`)

        const leasesAfterBridgeRestart = leaseRowsForTask(ctx.sqlitePath, brief.id)
        assert.equal(leasesAfterBridgeRestart.length, 1, 'bridge-restart replay must never create a second lease')
        assert.equal(leasesAfterBridgeRestart[0].state, 'active', 'exactly one ACTIVE Claim before submit')
        second.end()
        await second.exit()

        // Server restart: brand new Fastify instance over the same durable sqlite file, same
        // port. The proxy (still alive — closed only at test end) is the bridge's one fixed
        // configured URL throughout this test, exactly as a real operator's Kaola URL never
        // changes across a server restart; receipts are partitioned per literal origin by design
        // (originDigest/receiptFilePath), so `third` must keep using that same origin, not the
        // backend's own restarted.origin, to find the receipt `first`/`second` already wrote.
        const restarted = await restartApp(t, ctx)
        const third = spawnBridge(t, { home, origin: proxyOrigin })
        await initializeBridge(third)
        const progressId = nextId('progress')
        third.send(mutationRpc(progressId, 'report_progress', { task_id: brief.id, note: 'still alive after server restart' }))
        const progressRes = await waitForRpcId(third, progressId)
        assertToolOk(progressRes, `heartbeat after server restart must succeed: ${JSON.stringify(progressRes)}`)
        third.end()
        await third.exit()

        const leasesAfterServerRestart = leaseRowsForTask(restarted.sqlitePath, brief.id)
        assert.equal(leasesAfterServerRestart.length, 1, 'server restart must not fabricate or duplicate a lease')
        assert.equal(leasesAfterServerRestart[0].state, 'active', 'exactly one active Claim survives the server restart')
        assert.equal(leasesAfterServerRestart[0].id, leasesAfterBridgeRestart[0].id, 'server restart must resolve the SAME lease row, not a new one')
      },
    )

    test(
      'a lost submit_pr response and a bridge crash converge to exactly one terminal Claim, one submission, no release',
      { timeout: TEST_TIMEOUT },
      async (t) => {
        const ctx = await bootApp(t)
        const stub = beginFetchStub(t)
        const token = 'gitea-token-loss-submit-01'
        allowForgeToken(stub, token, 'gitea')
        const baseUrl = 'https://gitea.forge.test'
        const fullName = 'kaola/loss-submit'
        const brief = await createTask(ctx, taskPayload({ forge: 'gitea', baseUrl, fullName, token }))
        const home = tmpKaolaHome(t)
        await pairFreshBridgeDevice(t, ctx, { home })

        // The receipt (and therefore claim_id auto-attach) is addressed by the bridge's own
        // --url origin, so every step of this scenario — including the initial clean claim —
        // must run through the SAME origin the drop is later injected on (the proxy), exactly as
        // a real Agent would use one fixed configured Kaola URL throughout.
        const prUrl = prUrlFor('gitea', baseUrl, fullName, 1)
        const dropSubmit = once((body) => isToolCall(body, 'submit_pr', brief.id))
        const { origin: proxyOrigin } = await startInterceptProxy(t, ctx.port, { dropFor: dropSubmit })

        const claimBridge = spawnBridge(t, { home, origin: proxyOrigin })
        await initializeBridge(claimBridge)
        const claimId = nextId('claim')
        claimBridge.send(claimRpc(claimId, brief.id))
        const claimRes = await waitForRpcId(claimBridge, claimId)
        assertToolOk(claimRes, `setup claim must succeed: ${JSON.stringify(claimRes)}`)
        claimBridge.end()
        await claimBridge.exit()

        const firstSubmit = spawnBridge(t, { home, origin: proxyOrigin })
        await initializeBridge(firstSubmit)
        firstSubmit.send(mutationRpc(nextId('submit'), 'submit_pr', { task_id: brief.id, pr_url: prUrl, summary: 'forward-only proof' }))
        await firstSubmit.exit()

        const submissionsAfterLoss = submissionRowsForTask(ctx.sqlitePath, brief.id)
        assert.equal(submissionsAfterLoss.length, 1, 'server must have committed exactly one submission despite the lost response')

        // Retry via a fresh bridge process (claim_id recovered from the persisted receipt): must
        // be idempotent, not a second PR/submission.
        const retry = spawnBridge(t, { home, origin: proxyOrigin })
        await initializeBridge(retry)
        const retryId = nextId('submit')
        retry.send(mutationRpc(retryId, 'submit_pr', { task_id: brief.id, pr_url: prUrl, summary: 'forward-only proof' }))
        const retryRes = await waitForRpcId(retry, retryId)
        assertToolOk(retryRes, `idempotent submit retry must succeed: ${JSON.stringify(retryRes)}`)
        assert.equal(retryRes.result?.structuredContent?.pr_url, prUrl)
        retry.end()
        await retry.exit()

        const submissionsAfterRetry = submissionRowsForTask(ctx.sqlitePath, brief.id)
        assert.equal(submissionsAfterRetry.length, 1, 'a retried submit_pr must never create a second submission row (forward-only)')
        assert.equal(submissionsAfterRetry[0].id, submissionsAfterLoss[0].id)
        assert.equal(submissionsAfterRetry[0].pr_state, 'open')

        // Forward-only: once a PR/submission exists for this Claim, release_task must never undo it.
        const releaseAttempt = spawnBridge(t, { home, origin: proxyOrigin })
        await initializeBridge(releaseAttempt)
        const releaseId = nextId('release')
        releaseAttempt.send(mutationRpc(releaseId, 'release_task', { task_id: brief.id }))
        const releaseRes = await waitForRpcId(releaseAttempt, releaseId)
        assert.ok(toolFailed(releaseRes), `release after submit must be rejected, not silently accepted: ${JSON.stringify(releaseRes)}`)
        releaseAttempt.end()
        await releaseAttempt.exit()

        const leases = leaseRowsForTask(ctx.sqlitePath, brief.id)
        assert.equal(leases.length, 1, 'exactly one terminal Claim after submit')
        assert.equal(leases[0].state, 'released', 'submit_pr terminates the lease (not "active")')
        assert.equal(submissionRowsForTask(ctx.sqlitePath, brief.id).length, 1, 'release attempt must not have created a second submission')

        const task = taskRow(ctx.sqlitePath, brief.id)
        assert.equal(task.status, '待验收', 'task must have moved forward to 待验收, never bounced back by the rejected release')
      },
    )

    test(
      'a process kill precisely mid-flight (after server commit, before the response arrives) still converges to one Claim',
      { timeout: TEST_TIMEOUT },
      async (t) => {
        const ctx = await bootApp(t)
        const stub = beginFetchStub(t)
        const token = 'gitea-token-kill-midflight-01'
        allowForgeToken(stub, token, 'gitea')
        const brief = await createTask(ctx, taskPayload({ forge: 'gitea', baseUrl: 'https://gitea.forge.test', fullName: 'kaola/kill-midflight', token }))
        const home = tmpKaolaHome(t)
        await pairFreshBridgeDevice(t, ctx, { home })

        // Hold the (already-committed) response for 400ms so we can SIGKILL the bridge while it
        // is verifiably still waiting on it.
        const delayClaim = once((body) => isToolCall(body, 'claim_task', brief.id))
        const { origin: proxyOrigin } = await startInterceptProxy(t, ctx.port, { delayMsFor: (body) => (delayClaim(body) ? 400 : 0) })

        const first = spawnBridge(t, { home, origin: proxyOrigin })
        await initializeBridge(first)
        first.send(claimRpc(nextId('claim'), brief.id))
        await sleep(120)
        first.kill('SIGKILL')
        await first.exit()

        assert.equal(leaseRowsForTask(ctx.sqlitePath, brief.id).length, 1, 'the real commit happened before the kill; exactly one lease must exist')

        // Same origin as the killed attempt: the receipt persisted before the kill (written
        // BEFORE the request was even forwarded, per apps/mcp/src/main.ts's receipt-first
        // ordering) lets this fresh process replay the identical (device, request_id) idempotency
        // key rather than mint a brand new claim attempt against an already-进行中 task.
        const second = spawnBridge(t, { home, origin: proxyOrigin })
        await initializeBridge(second)
        const claimId = nextId('claim')
        second.send(claimRpc(claimId, brief.id))
        const res = await waitForRpcId(second, claimId)
        assertToolOk(res, `recovery claim after SIGKILL must succeed: ${JSON.stringify(res)}`)
        second.end()
        await second.exit()

        const leases = leaseRowsForTask(ctx.sqlitePath, brief.id)
        assert.equal(leases.length, 1, 'a mid-flight kill must never fan out into a second Claim')
        assert.equal(leases[0].state, 'active')
      },
    )
  })

  describe('lease expiry mid-flight and recovery', () => {
    // Integration finding (see this suite's final report): apps/mcp/src/main.ts's
    // obtainClaimRequestId() unconditionally reuses ANY well-formed, matching on-disk receipt for
    // (origin, task) as the claim_task request_id, with no check of whether the Claim it recorded
    // is still active. apps/server/src/claim.ts's replay-identity branch then refuses ANY
    // terminal lease (released, submitted, OR — this test — expired) with
    // claim_request_conflict / REQUEST_ID_REPLAY_TERMINAL_MESSAGE. The server-side half of
    // "recovery from lease expiry" (the task itself becomes reclaimable) is real and passes; the
    // bridge-side half (an Agent's normal, receipt-driven retry actually reaching that reclaimable
    // task) currently cannot recover on its own — only a fresh KAOLA_HOME (a new device identity)
    // or manually deleting the stale receipt file would let the SAME bridge process re-claim.
    test('an expired lease releases the task back to 待认领 and a fresh claim recovers with a new Claim identity', { timeout: TEST_TIMEOUT }, async (t) => {
      const ctx = await bootApp(t)
      const stub = beginFetchStub(t)
      const token = 'gitea-token-expiry-01'
      allowForgeToken(stub, token, 'gitea')
      const brief = await createTask(ctx, taskPayload({ forge: 'gitea', baseUrl: 'https://gitea.forge.test', fullName: 'kaola/expiry', token }))
      const home = tmpKaolaHome(t)
      await pairFreshBridgeDevice(t, ctx, { home })

      const bridge = spawnBridge(t, { home, origin: ctx.origin })
      await initializeBridge(bridge)
      const claimId1 = nextId('claim')
      bridge.send(claimRpc(claimId1, brief.id))
      const claimRes1 = await waitForRpcId(bridge, claimId1)
      const firstClaimId = claimRes1.result?.structuredContent?.lease?.claim_id
      assert.ok(firstClaimId, `setup claim must succeed: ${JSON.stringify(claimRes1)}`)
      bridge.end()
      await bridge.exit()

      const activeBefore = leaseRowsForTask(ctx.sqlitePath, brief.id).find((l) => l.state === 'active')
      assert.ok(activeBefore, 'expected exactly one active lease before expiry')
      expireLeaseNow(ctx.sqlitePath, activeBefore.id)

      // Any claim.ts entry point sweeps expired leases first; use a fresh claim attempt to force
      // the sweep and observe the real recovery in one round trip.
      const recovery = spawnBridge(t, { home, origin: ctx.origin })
      await initializeBridge(recovery)
      const claimId2 = nextId('claim')
      recovery.send(claimRpc(claimId2, brief.id))
      const claimRes2 = await waitForRpcId(recovery, claimId2)
      const secondClaimId = claimRes2.result?.structuredContent?.lease?.claim_id
      assert.ok(secondClaimId, `claim after expiry must succeed (task must be reclaimable): ${JSON.stringify(claimRes2)}`)
      assert.notEqual(secondClaimId, firstClaimId, 'expiry recovery must mint a genuinely new Claim identity, not resurrect the expired one')
      recovery.end()
      await recovery.exit()

      const rows = leaseRowsForTask(ctx.sqlitePath, brief.id)
      assert.equal(rows.find((l) => l.id === activeBefore.id)?.state, 'expired', 'the original lease must be recorded expired, not silently deleted')
      assert.equal(rows.filter((l) => l.state === 'active').length, 1, 'exactly one active lease after recovery')
    })
  })

  describe('direct vs Runner carrier parity', () => {
    test('claim_task/report_progress/submit_pr under KAOLA_CARRIER=runner reach the same Task/Claim/submission outcome as the default direct carrier, with no Runner ever started', { timeout: TEST_TIMEOUT }, async (t) => {
      const ctx = await bootApp(t)
      const stub = beginFetchStub(t)
      const token = 'gitea-token-carrier-parity-01'
      allowForgeToken(stub, token, 'gitea')
      const baseUrl = 'https://gitea.forge.test'

      async function runLifecycle(fullName, env) {
        const brief = await createTask(ctx, taskPayload({ forge: 'gitea', baseUrl, fullName, token }))
        const home = tmpKaolaHome(t)
        await pairFreshBridgeDevice(t, ctx, { home })
        const bridge = spawnBridge(t, { home, origin: ctx.origin, env })
        await initializeBridge(bridge)

        const claimId = nextId('claim')
        bridge.send(claimRpc(claimId, brief.id))
        const claimRes = await waitForRpcId(bridge, claimId)
        assertToolOk(claimRes, `claim (${JSON.stringify(env)}): ${JSON.stringify(claimRes)}`)

        const progressId = nextId('progress')
        bridge.send(mutationRpc(progressId, 'report_progress', { task_id: brief.id }))
        await waitForRpcId(bridge, progressId)

        const prUrl = prUrlFor('gitea', baseUrl, fullName, 1)
        const submitId = nextId('submit')
        bridge.send(mutationRpc(submitId, 'submit_pr', { task_id: brief.id, pr_url: prUrl, summary: 'carrier parity' }))
        const submitRes = await waitForRpcId(bridge, submitId)
        assertToolOk(submitRes, `submit (${JSON.stringify(env)}): ${JSON.stringify(submitRes)}`)
        bridge.end()
        await bridge.exit()

        const task = taskRow(ctx.sqlitePath, brief.id)
        const leases = leaseRowsForTask(ctx.sqlitePath, brief.id)
        const submissions = submissionRowsForTask(ctx.sqlitePath, brief.id)
        // Each fixture uses its own repo full_name (so the two runs' PR URLs can never collide
        // under submit_pr's own no-duplicate-PR-across-tasks rule — a real product rule, not a
        // harness artifact) — so this run's own submitted pr_url is checked against ITS OWN
        // fixture input here, never against the other run's literal URL.
        assert.equal(submissions[0]?.pr_url, prUrl, `${fullName}: submission must record the pr_url this run actually submitted`)
        return {
          taskStatus: task.status,
          leaseCount: leases.length,
          leaseState: leases[0]?.state,
          submissionCount: submissions.length,
          submissionState: submissions[0]?.pr_state,
        }
      }

      const directOutcome = await runLifecycle('kaola/carrier-direct', {})
      const runnerRepo = mkdtempSync(join(tmpdir(), 'kaola-runner-repo-fixture-'))
      t.after(() => rmSync(runnerRepo, { recursive: true, force: true }))
      const runnerOutcome = await runLifecycle('kaola/carrier-runner', {
        KAOLA_CARRIER: 'runner',
        KAOLA_RUNNER: 'claude-code',
        KAOLA_RUNNER_SESSION: 'lifecycle-matrix-parity-session',
        KAOLA_RUNNER_REPO: runnerRepo,
      })

      assert.deepEqual(runnerOutcome, directOutcome, 'the Runner carrier selection must never change the observable Task/Claim/submission outcome')
      assert.equal(directOutcome.taskStatus, '待验收')
      assert.equal(directOutcome.leaseState, 'released')
      assert.equal(directOutcome.submissionCount, 1)
    })
  })

  describe('zero Project Runner calls on the default direct path', () => {
    test('a full claim → report_progress → submit_pr cycle never invokes kaola-tmux.sh', { timeout: TEST_TIMEOUT }, async (t) => {
      const ctx = await bootApp(t)
      const stub = beginFetchStub(t)
      const token = 'gitea-token-zero-runner-01'
      allowForgeToken(stub, token, 'gitea')
      const baseUrl = 'https://gitea.forge.test'
      const fullName = 'kaola/zero-runner'
      const brief = await createTask(ctx, taskPayload({ forge: 'gitea', baseUrl, fullName, token }))
      const home = tmpKaolaHome(t)
      await pairFreshBridgeDevice(t, ctx, { home })

      const poison = poisonedRunnerBin(t)
      const bridge = spawnBridge(t, { home, origin: ctx.origin, env: { PATH: `${poison.dir}:${process.env.PATH}` } })
      await initializeBridge(bridge)

      const claimId = nextId('claim')
      bridge.send(claimRpc(claimId, brief.id))
      assertToolOk(await waitForRpcId(bridge, claimId), 'zero-runner-calls claim')

      const progressId = nextId('progress')
      bridge.send(mutationRpc(progressId, 'report_progress', { task_id: brief.id }))
      assertToolOk(await waitForRpcId(bridge, progressId), 'zero-runner-calls report_progress')

      const submitId = nextId('submit')
      bridge.send(mutationRpc(submitId, 'submit_pr', { task_id: brief.id, pr_url: prUrlFor('gitea', baseUrl, fullName, 1), summary: 'no runner' }))
      assertToolOk(await waitForRpcId(bridge, submitId), 'zero-runner-calls submit_pr')
      bridge.end()
      await bridge.exit()

      assert.equal(existsSync(poison.marker), false, 'the default direct path must never shell out to kaola-tmux.sh')
    })
  })

  describe('direct-path bridge restart recovers the Claim receipt', () => {
    test('a killed-and-respawned bridge recovers the exact claim_id from its own persisted receipt', { timeout: TEST_TIMEOUT }, async (t) => {
      const ctx = await bootApp(t)
      const stub = beginFetchStub(t)
      const token = 'gitea-token-receipt-recover-01'
      allowForgeToken(stub, token, 'gitea')
      const brief = await createTask(ctx, taskPayload({ forge: 'gitea', baseUrl: 'https://gitea.forge.test', fullName: 'kaola/receipt-recover', token }))
      const home = tmpKaolaHome(t)
      await pairFreshBridgeDevice(t, ctx, { home })

      const first = spawnBridge(t, { home, origin: ctx.origin })
      await initializeBridge(first)
      const claimId1 = nextId('claim')
      first.send(claimRpc(claimId1, brief.id))
      const claimRes1 = await waitForRpcId(first, claimId1)
      const mintedClaimId = claimRes1.result?.structuredContent?.lease?.claim_id
      assert.ok(mintedClaimId)
      first.kill('SIGKILL')
      await first.exit()

      const mod = await import('../../mcp/src/main.ts')
      const receiptPath = mod.receiptFilePath(home, ctx.origin, brief.id)
      assert.equal(existsSync(receiptPath), true, 'a completed claim must leave a durable receipt behind')
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      assert.equal(receipt.claim_id, mintedClaimId)
      assert.equal(receipt.task_id, brief.id)

      // A fresh bridge process, same home, recovers claim_id from the receipt for a mutation with
      // no claim_id supplied by the caller at all.
      const second = spawnBridge(t, { home, origin: ctx.origin })
      await initializeBridge(second)
      const progressId = nextId('progress')
      second.send(mutationRpc(progressId, 'report_progress', { task_id: brief.id }))
      const progressRes = await waitForRpcId(second, progressId)
      assertToolOk(progressRes, `heartbeat via recovered receipt must succeed: ${JSON.stringify(progressRes)}`)
      second.end()
      await second.exit()

      const activeLease = leaseRowsForTask(ctx.sqlitePath, brief.id).find((l) => l.state === 'active')
      assert.ok(activeLease)
      assert.equal(claimIdForLease({
        id: activeLease.id,
        taskId: activeLease.task_id,
        deviceId: activeLease.device_id,
        claimedAt: activeLease.claimed_at,
        requestId: activeLease.request_id,
        claimerUserId: activeLease.claimer_user_id,
        claimerClaimantId: activeLease.claimer_claimant_id,
      }), mintedClaimId, 'the receipt-recovered claim_id must independently re-derive from the actual lease row')
    })
  })

  describe('heartbeat / receipt / submit ordering, proven from real artifacts', () => {
    test('events table, receipt file, and submissions row agree on claim < heartbeat < submit', { timeout: TEST_TIMEOUT }, async (t) => {
      const ctx = await bootApp(t)
      const stub = beginFetchStub(t)
      const token = 'gitea-token-ordering-01'
      allowForgeToken(stub, token, 'gitea')
      const baseUrl = 'https://gitea.forge.test'
      const fullName = 'kaola/ordering'
      const brief = await createTask(ctx, taskPayload({ forge: 'gitea', baseUrl, fullName, token }))
      const home = tmpKaolaHome(t)
      await pairFreshBridgeDevice(t, ctx, { home })

      const bridge = spawnBridge(t, { home, origin: ctx.origin })
      await initializeBridge(bridge)
      const claimId = nextId('claim')
      bridge.send(claimRpc(claimId, brief.id))
      const claimRes = await waitForRpcId(bridge, claimId)
      const mintedClaimId = claimRes.result?.structuredContent?.lease?.claim_id
      assert.ok(mintedClaimId)

      const progressId = nextId('progress')
      bridge.send(mutationRpc(progressId, 'report_progress', { task_id: brief.id, note: 'ordering probe' }))
      await waitForRpcId(bridge, progressId)

      const prUrl = prUrlFor('gitea', baseUrl, fullName, 1)
      const submitId = nextId('submit')
      bridge.send(mutationRpc(submitId, 'submit_pr', { task_id: brief.id, pr_url: prUrl, summary: 'ordering probe' }))
      await waitForRpcId(bridge, submitId)
      bridge.end()
      await bridge.exit()

      const events = allEventRows(ctx.sqlitePath).filter((row) => {
        try {
          return JSON.parse(row.details).task_id === brief.id
        } catch {
          return false
        }
      })
      const claimEvent = events.find((row) => row.type === '状态迁移' && JSON.parse(row.details).to === '进行中')
      const heartbeatEvent = events.find((row) => row.type === '心跳')
      const submitEvent = events.find((row) => row.type === '状态迁移' && JSON.parse(row.details).to === '待验收')
      assert.ok(claimEvent, 'a 状态迁移(→进行中) event must exist')
      assert.ok(heartbeatEvent, 'a 心跳 event must exist')
      assert.ok(submitEvent, 'a 状态迁移(→待验收) event must exist')
      assert.ok(claimEvent.id < heartbeatEvent.id, `claim event (id ${claimEvent.id}) must precede heartbeat (id ${heartbeatEvent.id})`)
      assert.ok(heartbeatEvent.id < submitEvent.id, `heartbeat event (id ${heartbeatEvent.id}) must precede submit (id ${submitEvent.id})`)

      const mod = await import('../../mcp/src/main.ts')
      const receipt = JSON.parse(readFileSync(mod.receiptFilePath(home, ctx.origin, brief.id), 'utf8'))
      assert.equal(receipt.claim_id, mintedClaimId, 'the receipt on disk must carry the same claim_id the events/lease agree on')

      const submissions = submissionRowsForTask(ctx.sqlitePath, brief.id)
      assert.equal(submissions.length, 1)
      assert.equal(submissions[0].pr_url, prUrl)
      assert.equal(submissions[0].pr_state, 'open')
    })
  })

  describe('three-forge shared fixtures (GitHub, GitLab with a subgroup, Gitea)', () => {
    const FORGES = [
      { forge: 'github', baseUrl: 'https://github.example.test', fullName: 'octo/widget' },
      { forge: 'gitlab', baseUrl: 'https://gitlab.forge.test', fullName: 'group/subgroup/app' },
      { forge: 'gitea', baseUrl: 'https://gitea.forge.test', fullName: 'team/orders' },
    ]

    for (const fixture of FORGES) {
      test(`${fixture.forge}: claim → submit_pr reaches 待验收 with one submission, and a retry submit_pr is idempotent`, { timeout: TEST_TIMEOUT }, async (t) => {
        const ctx = await bootApp(t)
        const stub = beginFetchStub(t)
        const token = `${fixture.forge}-token-three-forge-01`
        allowForgeToken(stub, token, fixture.forge)
        const brief = await createTask(ctx, taskPayload({ forge: fixture.forge, baseUrl: fixture.baseUrl, fullName: fixture.fullName, token }))
        const home = tmpKaolaHome(t)
        await pairFreshBridgeDevice(t, ctx, { home })

        const bridge = spawnBridge(t, { home, origin: ctx.origin })
        await initializeBridge(bridge)
        const claimId = nextId('claim')
        bridge.send(claimRpc(claimId, brief.id))
        const claimRes = await waitForRpcId(bridge, claimId)
        assertToolOk(claimRes, `${fixture.forge} claim: ${JSON.stringify(claimRes)}`)

        const prUrl = prUrlFor(fixture.forge, fixture.baseUrl, fixture.fullName, 7)
        const submitId = nextId('submit')
        bridge.send(mutationRpc(submitId, 'submit_pr', { task_id: brief.id, pr_url: prUrl, summary: `${fixture.forge} fixture` }))
        const submitRes = await waitForRpcId(bridge, submitId)
        assertToolOk(submitRes, `${fixture.forge} submit: ${JSON.stringify(submitRes)}`)

        const retryId = nextId('submit')
        bridge.send(mutationRpc(retryId, 'submit_pr', { task_id: brief.id, pr_url: prUrl, summary: `${fixture.forge} fixture` }))
        const retryRes = await waitForRpcId(bridge, retryId)
        assertToolOk(retryRes, `${fixture.forge} idempotent retry: ${JSON.stringify(retryRes)}`)
        bridge.end()
        await bridge.exit()

        const task = taskRow(ctx.sqlitePath, brief.id)
        assert.equal(task.status, '待验收', `${fixture.forge}: task must reach 待验收`)
        const submissions = submissionRowsForTask(ctx.sqlitePath, brief.id)
        assert.equal(submissions.length, 1, `${fixture.forge}: exactly one submission despite the retry`)
        assert.equal(submissions[0].pr_url, prUrl)
      })
    }
  })

  describe('token scan across every reachable evidence surface', () => {
    test('receipts, events.details, bridge stdout/stderr, and admin task views carry zero forge-token hits (outside the two AGENTS.md-allowed responses)', { timeout: TEST_TIMEOUT }, async (t) => {
      const ctx = await bootApp(t)
      const stub = beginFetchStub(t)
      const token = 'gitea-SECRET-SCAN-TOKEN-must-not-persist-9k2x'
      allowForgeToken(stub, token, 'gitea')
      const baseUrl = 'https://gitea.forge.test'
      const fullName = 'kaola/secret-scan'
      const brief = await createTask(ctx, taskPayload({ forge: 'gitea', baseUrl, fullName, token, title: 'secret-scan-fixture' }))
      const home = tmpKaolaHome(t)
      await pairFreshBridgeDevice(t, ctx, { home })

      const bridge = spawnBridge(t, { home, origin: ctx.origin })
      await initializeBridge(bridge)
      const claimId = nextId('claim')
      bridge.send(claimRpc(claimId, brief.id))
      const claimRes = await waitForRpcId(bridge, claimId)
      assert.equal(claimRes.result?.structuredContent?.token, token, 'sanity: the one AGENTS.md-allowed MCP claim_task success disclosure still happens')

      const progressId = nextId('progress')
      bridge.send(mutationRpc(progressId, 'report_progress', { task_id: brief.id, note: 'secret scan' }))
      await waitForRpcId(bridge, progressId)

      const prUrl = prUrlFor('gitea', baseUrl, fullName, 3)
      const submitId = nextId('submit')
      bridge.send(mutationRpc(submitId, 'submit_pr', { task_id: brief.id, pr_url: prUrl, summary: 'secret scan' }))
      await waitForRpcId(bridge, submitId)
      bridge.end()
      await bridge.exit()

      // KAOLA_HOME: device.json is the accepted store for the device PRIVATE key only — it must
      // still never carry the forge token. Everything else under KAOLA_HOME (receipts) must never
      // carry the token either.
      const devicePath = join(home, 'device.json')
      for (const path of walkFiles(home)) {
        assertNoSecrets(readFileSync(path, 'utf8'), [token], path)
      }
      assert.equal(existsSync(devicePath), true)

      // events.details — the durable server-side audit trail, including the token-揭示 rows.
      for (const row of allEventRows(ctx.sqlitePath)) {
        assertNoSecrets(row.details, [token], `events.id=${row.id} details`)
      }

      // stderr must never carry the token under any circumstance.
      assertNoSecrets(bridge.stderrText(), [token], 'bridge stderr')

      // stdout: the MCP claim_task success response IS the one place AGENTS.md allows the token
      // to appear — assert that allowance narrowly (only within that one JSON-RPC response), and
      // that every OTHER stdout line is clean.
      const rpcs = parseJsonRpcStdout(bridge.stdoutText())
      for (const rpc of rpcs) {
        if (rpc.id === claimId) continue
        assertNoSecrets(JSON.stringify(rpc), [token], `stdout rpc id=${JSON.stringify(rpc.id)}`)
      }

      // Admin-facing task views (brief / list / detail) must never carry the token — the REST
      // claim 201 is the only REST surface AGENTS.md allows it on, and this suite never exercises
      // that endpoint with this token, so the admin views below must be completely clean.
      const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/tasks', cookies: ctx.admin.cookies, headers: { accept: 'application/json' } })
      assertNoSecrets(list.body, [token], 'GET /api/v1/tasks')
      const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/tasks/${brief.id}`, cookies: ctx.admin.cookies, headers: { accept: 'application/json' } })
      assertNoSecrets(detail.body, [token], 'GET /api/v1/tasks/:id')

      // No git operation is ever executed by this suite (no clone/checkout happens), so there is
      // no git config surface here to scan — noted explicitly per this suite's honesty
      // requirements, not silently skipped.
    })
  })
})
