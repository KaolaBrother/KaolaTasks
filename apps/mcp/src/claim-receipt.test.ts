// Issue #32 — kaola-mcp bridge Claim recovery receipts. Independent acceptance suite; test
// custody only, no production code here. RED against HEAD df98907: none of `originDigest`,
// `receiptFilePath`, request-id generation/persistence, receipt-first-then-forward ordering,
// claim_id auto-attach, or typed session recovery exist yet in apps/mcp/src/main.ts.
//
// Contract source: docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md ("Local bridge
// receipt" + "Minimal Claim protocol additions") and the bundle brief for Issue #32. The frozen
// receipt shape is exactly:
//   { v, server, task_id, request_id, claim_id, repo_identity, carrier, runner, runner_session }
//
// Production exports this suite requires from apps/mcp/src/main.ts (none exist today):
//   1. originDigest(url: string): string
//        Pure, deterministic digest of a normalized Kaola server origin. Used both as the
//        receipt's `server` field and as (part of) the on-disk addressing scheme.
//   2. receiptFilePath(kaolaHome: string, url: string, taskId: string): string
//        Deterministic absolute path (inside kaolaHome) for the (origin, task) receipt. Every
//        component derived from `taskId`/`url` must be validated/encoded so the result can never
//        resolve outside `kaolaHome` — this suite calls it directly with hostile task ids and
//        requires either a thrown error or a path that stays strictly inside kaolaHome.
//   Everything else (request_id generation/persistence ordering, claim_id capture, mutation
//   auto-attach, typed session recovery, receipt-file locking across processes) is exercised only
//   through the already-exported `runStdioBridge`/`forwardMcpRequest`, observing stdout bytes,
//   receipt files on disk, and the fake server's own call ledger — never a private function name.
//
// Resolved ambiguities (decided here, not left to the implementer):
//   A. "Legacy server" signal: a server whose claim_task success `lease` object omits `claim_id`
//      (see `legacy: true` on `makeClaimBackend`). This is the only signal these tests bind to;
//      no capability marker on `initialize` is asserted.
//   B. "Byte-for-byte unmodified" pass-through is asserted as structural (deep-equal) JSON-RPC
//      identity of the parsed body sent to the server and the parsed line written to stdout —
//      not literal insignificant-whitespace-preserving byte identity — because the existing
//      bridge already round-trips every body through JSON.parse/JSON.stringify (see
//      forwardMcpRequest in main.ts) and main.test.ts already accepts that architecture.
//   C. Secret-scan scope: KAOLA_HOME (every file), stderr, and the receipt file's field allowlist
//      must have zero hits of the forge token, an Authorization-shaped value, the device private
//      key, the Task description, and arbitrary extra/prompt-shaped server fields. stdout is
//      EXCLUDED from the forge-token check for the claim_task success response only, because
//      AGENTS.md explicitly allows token disclosure there ("只允许现有 REST claim 201 和 MCP
//      claim_task 成功响应揭示") and main.test.ts already pins `out.result.token === FORGE_TOKEN`
//      for that exact response. All other secrets (private key, description, decoy debug fields)
//      must never appear on stdout either.
//   D. Receipt corruption/mismatch recovery mechanism (regenerate vs. typed error) is left to the
//      implementer; this suite pins only the safety invariants explicitly required by the brief:
//      no crash, no secret exposure, and unrelated receipt files are neither read nor deleted.

import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as pathResolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAIN_PATH = join(HERE, 'main.ts')

const FORGE_TOKEN = 'gitea-FORGE-TOKEN-must-not-persist-9q2z'
const AUTH_HEADER_CANARY = 'Bearer ktk_should-never-persist-8x1v'
const TASK_DESCRIPTION_CANARY = 'TASK-DESCRIPTION-CANARY-do-not-persist-4k9w'
const PROMPT_CANARY = 'PROMPT-CANARY-do-not-persist-7h3m'

const RECEIPT_ALLOWED_KEYS = new Set([
  'v',
  'server',
  'task_id',
  'request_id',
  'claim_id',
  'repo_identity',
  'carrier',
  'runner',
  'runner_session',
])

async function loadBridge() {
  try {
    return await import('./main.ts')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    assert.fail(`apps/mcp/src/main.ts must export the claim-receipt seams (got ${code || String(err)})`)
  }
}

// Loaded once for the whole file (mirrors apps/mcp/src/main.test.ts's own `loadBridge` pattern),
// then referenced by every test below.
let mod
before(async () => {
  mod = await loadBridge()
})

function tmpKaolaHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-receipt-home-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

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

function makeStdioStreams() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let outText = ''
  let errText = ''
  stdout.on('data', (c) => {
    outText += String(c)
  })
  stderr.on('data', (c) => {
    errText += String(c)
  })
  return { io: { stdin, stdout, stderr }, stdoutText: () => outText, stderrText: () => errText }
}

async function waitForBridge(running, ms = 8000) {
  let timer
  try {
    await Promise.race([
      running,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`runStdioBridge did not finish within ${ms}ms (must not loop/hang)`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForBridgeSettled(running, ms = 8000) {
  let timer
  try {
    await Promise.race([
      running.catch(() => {}),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`runStdioBridge did not settle within ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
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

function initializeRpc(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'receipt-test', version: '0' } },
  }
}

function claimRpc(id, taskId, extraArgs = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'claim_task', arguments: { task_id: taskId, ...extraArgs } },
  }
}

function mutationRpc(id, name, args) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

/**
 * A minimal but protocol-faithful fake Kaola server: sessions, claim idempotency keyed by
 * request_id, controllable mid-flight drop/delay/stale-session hooks, and a call ledger the
 * tests assert against directly (never a mock of the bridge itself).
 */
async function makeClaimBackend(t, opts = {}) {
  const {
    legacy = false,
    tasks = {},
    dropAfterCommitFor,
    staleSessionFor,
    delayMs = 0,
  } = opts

  const state = {
    requests: [],
    initializeCount: 0,
    claimsByRequestId: new Map(),
    claimCreateCount: 0,
    sessions: new Set(),
    mutationCalls: [],
  }

  function taskFor(taskId) {
    return (
      tasks[taskId] ?? {
        repo: { forge: 'gitea', full_name: 'kaola/demo-repo' },
        description_md: TASK_DESCRIPTION_CANARY,
      }
    )
  }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks)
        let parsed
        try {
          parsed = JSON.parse(rawBody.toString('utf8'))
        } catch {
          parsed = null
        }
        const session = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : ''
        state.requests.push({ method: parsed?.method, session, parsed, rawBody })

        const respond = (status, obj, extraHeaders = {}) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
          res.end(JSON.stringify(obj))
        }

        if (parsed == null) {
          respond(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
          return
        }

        if (parsed.method === 'initialize') {
          state.initializeCount++
          const sid = `sid-${randomUUID()}`
          state.sessions.add(sid)
          respond(
            200,
            {
              jsonrpc: '2.0',
              id: parsed.id,
              result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'kaola-tasks' } },
            },
            { 'mcp-session-id': sid },
          )
          return
        }

        if (staleSessionFor && staleSessionFor(parsed, session)) {
          respond(404, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32001, message: 'Session not found' } })
          return
        }
        if (session && !state.sessions.has(session)) {
          respond(404, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32001, message: 'Session not found' } })
          return
        }

        if (parsed.method === 'ping') {
          respond(200, { jsonrpc: '2.0', id: parsed.id, result: {} })
          return
        }
        if (parsed.method === 'tools/list') {
          respond(200, { jsonrpc: '2.0', id: parsed.id, result: { tools: [{ name: 'list_tasks' }] } })
          return
        }
        if (parsed.method != null && parsed.method.startsWith('notifications/')) {
          respond(200, { jsonrpc: '2.0', id: parsed.id ?? null, result: { noted: true } })
          return
        }

        if (parsed.method === 'tools/call') {
          const name = parsed.params?.name
          const args = parsed.params?.arguments ?? {}

          if (name === 'claim_task') {
            const requestId = args.request_id
            const taskId = args.task_id
            const task = taskFor(taskId)

            const commit = () => {
              let claimId = requestId ? state.claimsByRequestId.get(requestId) : undefined
              if (claimId == null) {
                state.claimCreateCount++
                claimId = `clm_${state.claimCreateCount}_${taskId}`
                if (requestId) state.claimsByRequestId.set(requestId, claimId)
              }
              return claimId
            }

            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))

            if (dropAfterCommitFor && dropAfterCommitFor(parsed)) {
              commit()
              req.socket.destroy()
              return
            }

            const claimId = commit()
            const lease = legacy
              ? { expires_at: '2026-09-01T06:00:00.000Z', ttl_seconds: 86400 }
              : { claim_id: claimId, expires_at: '2026-09-01T06:00:00.000Z', ttl_seconds: 86400 }
            respond(200, {
              jsonrpc: '2.0',
              id: parsed.id,
              result: {
                task: { id: taskId, repo: task.repo, description_md: task.description_md },
                token: FORGE_TOKEN,
                lease,
                clone: { suggested_dir: 'demo' },
                _debug: { authorization: AUTH_HEADER_CANARY, note: PROMPT_CANARY },
              },
            })
            return
          }

          if (name === 'report_progress' || name === 'release_task' || name === 'submit_pr') {
            state.mutationCalls.push({ tool: name, args })
            respond(200, { jsonrpc: '2.0', id: parsed.id, result: { ok: true } })
            return
          }

          // unknown tool: echo back the raw args so the caller can assert unmodified pass-through
          respond(200, { jsonrpc: '2.0', id: parsed.id, result: { echoed: { name, args } } })
          return
        }

        respond(200, { jsonrpc: '2.0', id: parsed.id ?? null, result: {} })
      })()
    })
  })

  t.after(() => server.close())
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolveP({ origin: `http://127.0.0.1:${addr.port}`, state, server })
    })
  })
}

async function closedPort() {
  const server = createServer(() => {})
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  await new Promise((r) => server.close(r))
  return addr.port
}

function spawnBridge(t, { home, origin }) {
  const child = spawn(process.execPath, ['--experimental-strip-types', MAIN_PATH, '--url', origin], {
    env: { ...process.env, KAOLA_HOME: home },
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
    send: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    end: () => child.stdin.end(),
    stdoutText: () => out,
    stderrText: () => err,
    exit: () => new Promise((resolveP) => child.on('exit', (code) => resolveP(code))),
  }
}

function assertReceiptShape(receipt, expected) {
  for (const key of Object.keys(receipt)) {
    assert.ok(RECEIPT_ALLOWED_KEYS.has(key), `receipt must not carry unexpected key "${key}"`)
  }
  assert.equal(receipt.v, 1)
  if (expected.server !== undefined) assert.equal(receipt.server, expected.server)
  if (expected.task_id !== undefined) assert.equal(receipt.task_id, expected.task_id)
  assert.equal(typeof receipt.request_id, 'string')
  assert.ok(receipt.request_id.length > 0)
  if (expected.claim_id !== undefined) assert.equal(receipt.claim_id, expected.claim_id)
  if (expected.repo_identity !== undefined) assert.equal(receipt.repo_identity, expected.repo_identity)
}

function assertNoSecrets(text, secrets, label) {
  for (const secret of secrets) {
    assert.equal(String(text).includes(secret), false, `${label} must not contain: ${secret}`)
  }
}

describe('kaola-mcp Claim recovery receipt (Issue #32)', () => {
  describe('receiptFilePath path safety', () => {
    test('is a pure function exported from main.ts', async () => {
      assert.equal(typeof mod.receiptFilePath, 'function', 'main.ts must export receiptFilePath(kaolaHome, url, taskId)')
      assert.equal(typeof mod.originDigest, 'function', 'main.ts must export originDigest(url)')
    })

    test('a legitimate task id resolves to a path strictly inside kaolaHome', async (t) => {
      const home = tmpKaolaHome(t)
      const path = mod.receiptFilePath(home, 'http://127.0.0.1:31415', 'kt-2026-0142')
      assert.equal(typeof path, 'string')
      const resolvedHome = pathResolve(home)
      const resolvedPath = pathResolve(path)
      assert.ok(
        resolvedPath === resolvedHome || resolvedPath.startsWith(resolvedHome + sep),
        `receipt path ${resolvedPath} must stay inside kaolaHome ${resolvedHome}`,
      )
    })

    test('hostile task ids either throw or stay strictly inside kaolaHome (no traversal escape)', async (t) => {
      const home = tmpKaolaHome(t)
      const resolvedHome = pathResolve(home)
      const hostileTaskIds = [
        '../../../../etc/passwd',
        '..',
        '/etc/passwd',
        '',
        'a'.repeat(4096),
        'task\0withnull',
        'task/with/slash',
        'task\\with\\backslash',
        '任务🚀混合ID',
        '....//....//etc/passwd',
      ]
      for (const taskId of hostileTaskIds) {
        let path
        try {
          path = mod.receiptFilePath(home, 'http://127.0.0.1:31415', taskId)
        } catch {
          continue // throwing on hostile input is an accepted safe outcome
        }
        assert.equal(typeof path, 'string', `receiptFilePath(${JSON.stringify(taskId)}) must throw or return a string`)
        const resolvedPath = pathResolve(path)
        assert.ok(
          resolvedPath === resolvedHome || resolvedPath.startsWith(resolvedHome + sep),
          `hostile task id ${JSON.stringify(taskId)} escaped kaolaHome: got ${resolvedPath}`,
        )
      }
    })

    test('different task ids produce different receipt files for the same origin', async (t) => {
      const home = tmpKaolaHome(t)
      const a = mod.receiptFilePath(home, 'http://127.0.0.1:31415', 'kt-aaa')
      const b = mod.receiptFilePath(home, 'http://127.0.0.1:31415', 'kt-bbb')
      assert.notEqual(a, b)
    })
  })

  describe('originDigest', () => {
    test('is deterministic and distinguishes different origins', async () => {
      const d1 = mod.originDigest('http://127.0.0.1:31415')
      const d2 = mod.originDigest('http://127.0.0.1:31415')
      const d3 = mod.originDigest('http://127.0.0.1:9999')
      assert.equal(typeof d1, 'string')
      assert.ok(d1.length > 0)
      assert.equal(d1, d2)
      assert.notEqual(d1, d3)
    })
  })

  describe('claim receipt happy path', () => {
    test('writes an atomic pre-claim receipt with request_id BEFORE the request, then records claim_id after success', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {
        tasks: { 'kt-happy': { repo: { forge: 'gitea', full_name: 'kaola/happy-repo' }, description_md: TASK_DESCRIPTION_CANARY } },
      })
      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-happy'))}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)

      const rpcs = parseJsonRpcStdout(streams.stdoutText())
      const claimResult = rpcs.find((r) => r.id === 2)
      assert.ok(claimResult?.result?.lease?.claim_id, `expected a successful claim result, got ${JSON.stringify(claimResult)}`)
      const claimId = claimResult.result.lease.claim_id

      const receiptPath = mod.receiptFilePath(home, backend.origin, 'kt-happy')
      assert.equal(existsSync(receiptPath), true, 'receipt file must exist after a successful claim')
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      assertReceiptShape(receipt, {
        server: mod.originDigest(backend.origin),
        task_id: 'kt-happy',
        claim_id: claimId,
        repo_identity: 'gitea/kaola/happy-repo',
      })

      // request_id must have been injected into the outgoing claim_task params, and must be the
      // same request_id persisted in the receipt (generated BEFORE the request was forwarded).
      const claimCall = backend.state.requests.find((r) => r.method === 'tools/call' && r.parsed?.params?.name === 'claim_task')
      assert.equal(claimCall?.parsed?.params?.arguments?.request_id, receipt.request_id)
    })

    test('directory is 0700 and the receipt file is 0600', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {})
      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-perm'))}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)

      const devicePath = join(home, 'device.json')
      assert.equal(statSync(home).mode & 0o777, 0o700)
      assert.equal(statSync(devicePath).mode & 0o777, 0o600)

      const receiptPath = mod.receiptFilePath(home, backend.origin, 'kt-perm')
      assert.equal(existsSync(receiptPath), true)
      assert.equal(statSync(receiptPath).mode & 0o777, 0o600, 'receipt file must be 0600')
      assert.equal(statSync(dirname(receiptPath)).mode & 0o777, 0o700, 'receipt-holding directory must be 0700')
    })

    test('a later claim for the same (origin, task) reuses the recorded request_id and never creates a second server-side claim', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {})

      for (let i = 0; i < 2; i++) {
        const streams = makeStdioStreams()
        const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
        streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
        streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-reuse'))}\n`)
        streams.io.stdin.end()
        await waitForBridge(running)
      }

      assert.equal(backend.state.claimCreateCount, 1, 'exactly one claim must ever be created server-side')
      const receiptPath = mod.receiptFilePath(home, backend.origin, 'kt-reuse')
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      const claimCalls = backend.state.requests.filter((r) => r.parsed?.params?.name === 'claim_task')
      assert.equal(claimCalls.length, 2, 'the bridge must still forward both attempts')
      assert.equal(claimCalls[0].parsed.params.arguments.request_id, receipt.request_id)
      assert.equal(claimCalls[1].parsed.params.arguments.request_id, receipt.request_id, 'second attempt must reuse the same request_id')
    })
  })

  describe('mutation claim_id auto-attach', () => {
    test('report_progress, release_task and submit_pr get claim_id injected from a persisted receipt, even from a fresh process with no in-memory state', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {})

      const claimStreams = makeStdioStreams()
      const claimRunning = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, claimStreams.io)
      claimStreams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      claimStreams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-mutate'))}\n`)
      claimStreams.io.stdin.end()
      await waitForBridge(claimRunning)
      const claimResult = parseJsonRpcStdout(claimStreams.stdoutText()).find((r) => r.id === 2)
      const claimId = claimResult?.result?.lease?.claim_id
      assert.ok(claimId, 'setup claim must succeed')

      // Fresh process/streams: only durable receipt state is available now.
      const mutStreams = makeStdioStreams()
      const mutRunning = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, mutStreams.io)
      mutStreams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      mutStreams.io.stdin.write(`${JSON.stringify(mutationRpc(2, 'report_progress', { task_id: 'kt-mutate', note: 'hi' }))}\n`)
      mutStreams.io.stdin.write(`${JSON.stringify(mutationRpc(3, 'release_task', { task_id: 'kt-mutate' }))}\n`)
      mutStreams.io.stdin.write(`${JSON.stringify(mutationRpc(4, 'submit_pr', { task_id: 'kt-mutate', pr_url: 'https://example.test/pr/1', summary: 'done' }))}\n`)
      mutStreams.io.stdin.end()
      await waitForBridge(mutRunning)

      const calls = backend.state.mutationCalls
      assert.equal(calls.length, 3)
      for (const call of calls) {
        assert.equal(call.args.claim_id, claimId, `${call.tool} must carry the recorded claim_id`)
      }
    })
  })

  describe('legacy server compatibility (lease without claim_id)', () => {
    test('claim still succeeds and mutations omit claim_id rather than injecting an undefined/null value', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, { legacy: true })

      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-legacy'))}\n`)
      streams.io.stdin.write(`${JSON.stringify(mutationRpc(3, 'release_task', { task_id: 'kt-legacy' }))}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)

      const rpcs = parseJsonRpcStdout(streams.stdoutText())
      const claimResult = rpcs.find((r) => r.id === 2)
      assert.equal(claimResult?.error, undefined, 'legacy claim must still succeed')
      assert.ok(claimResult?.result?.task, 'legacy claim result must still carry the task envelope')
      assert.equal(claimResult.result.lease?.claim_id, undefined, 'legacy lease has no claim_id (sanity on the fake server)')

      const release = backend.state.mutationCalls.find((c) => c.tool === 'release_task')
      assert.ok(release, 'release_task must have been forwarded')
      assert.equal(Object.hasOwn(release.args, 'claim_id'), false, 'must omit claim_id entirely, not send null/undefined')
    })
  })

  describe('kill/restart boundaries converge to exactly one Claim', { concurrency: 1 }, () => {
    test('boundary: killed before any receipt write — restart claims cleanly with one request_id/claim_id', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {})

      // "Kill" before anything happens: start a bridge invocation, send it nothing, end stdin.
      const abandoned = makeStdioStreams()
      const abandonedRunning = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, abandoned.io)
      abandoned.io.stdin.end()
      await waitForBridge(abandonedRunning)
      assert.equal(existsSync(mod.receiptFilePath(home, backend.origin, 'kt-boundary-a')), false)

      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-boundary-a'))}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)

      assert.equal(backend.state.claimCreateCount, 1)
      const receipt = JSON.parse(readFileSync(mod.receiptFilePath(home, backend.origin, 'kt-boundary-a'), 'utf8'))
      assert.ok(receipt.claim_id)
    })

    test('boundary: receipt written but request never reached the server — restart reuses the recorded request_id and creates exactly one claim', async (t) => {
      const home = tmpKaolaHome(t)
      const deadPort = await closedPort(t)

      const firstAttempt = makeStdioStreams()
      const firstRunning = mod.runStdioBridge(
        ['--url', `http://127.0.0.1:${deadPort}`],
        { KAOLA_HOME: home },
        firstAttempt.io,
      )
      firstAttempt.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      firstAttempt.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-boundary-b'))}\n`)
      firstAttempt.io.stdin.end()
      await waitForBridgeSettled(firstRunning)

      const backend = await makeClaimBackend(t, {})
      const receiptPathBefore = mod.receiptFilePath(home, backend.origin, 'kt-boundary-b')
      // The receipt is addressed by (origin, task); a dead port and the live backend are
      // different origins, so re-point at the live backend for the restart, as an Agent would
      // after the operator brings the real server back on the configured URL.
      mkdirSync(dirname(receiptPathBefore), { recursive: true })
      writeFileSync(
        receiptPathBefore,
        `${JSON.stringify({
          v: 1,
          server: mod.originDigest(backend.origin),
          task_id: 'kt-boundary-b',
          request_id: randomUUID(),
          claim_id: null,
          repo_identity: null,
          carrier: 'direct',
          runner: null,
          runner_session: null,
        })}\n`,
        { mode: 0o600 },
      )
      const preRecovery = JSON.parse(readFileSync(receiptPathBefore, 'utf8'))

      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-boundary-b'))}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)

      assert.equal(backend.state.claimCreateCount, 1)
      const claimCall = backend.state.requests.find((r) => r.parsed?.params?.name === 'claim_task')
      assert.equal(
        claimCall?.parsed?.params?.arguments?.request_id,
        preRecovery.request_id,
        'restart must reuse the pre-recorded request_id rather than minting a new one',
      )
    })

    test('boundary: server committed the claim but the response was lost — restart replays and the server never creates a second claim', async (t) => {
      const home = tmpKaolaHome(t)
      let dropped = false
      const backend = await makeClaimBackend(t, {
        dropAfterCommitFor: (parsed) => {
          if (dropped) return false
          if (parsed.params?.name === 'claim_task' && parsed.params.arguments.task_id === 'kt-boundary-c') {
            dropped = true
            return true
          }
          return false
        },
      })

      const firstAttempt = makeStdioStreams()
      const firstRunning = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, firstAttempt.io)
      firstAttempt.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      firstAttempt.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-boundary-c'))}\n`)
      firstAttempt.io.stdin.end()
      await waitForBridgeSettled(firstRunning)

      assert.equal(backend.state.claimCreateCount, 1, 'server must have committed the claim on the first (dropped) attempt')

      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-boundary-c'))}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)

      assert.equal(backend.state.claimCreateCount, 1, 'restart must never create a second claim')
      const rpcs = parseJsonRpcStdout(streams.stdoutText())
      const claimResult = rpcs.find((r) => r.id === 2)
      assert.ok(claimResult?.result?.lease?.claim_id, `restart must eventually surface a successful claim, got ${JSON.stringify(claimResult)}`)
    })

    test('boundary: receipt already carried claim_id (full completion) — a repeat claim never creates a second server-side claim', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {})

      let lastClaimId
      for (let i = 0; i < 2; i++) {
        const streams = makeStdioStreams()
        const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
        streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
        streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-boundary-d'))}\n`)
        streams.io.stdin.end()
        await waitForBridge(running)
        const rpcs = parseJsonRpcStdout(streams.stdoutText())
        const claimResult = rpcs.find((r) => r.id === 2)
        assert.ok(claimResult?.result?.lease?.claim_id, `attempt ${i} must succeed`)
        if (i === 0) lastClaimId = claimResult.result.lease.claim_id
        else assert.equal(claimResult.result.lease.claim_id, lastClaimId, 'repeat claim must return the same claim_id')
      }

      assert.equal(backend.state.claimCreateCount, 1)
    })
  })

  describe('stale mcp-session-id recovery', { concurrency: 1 }, () => {
    test('re-initializes exactly once and replays the pending claim exactly once (no second lease)', async (t) => {
      const home = tmpKaolaHome(t)
      let firstSessionSeen
      const backend = await makeClaimBackend(t, {
        staleSessionFor: (parsed, session) => {
          if (parsed.params?.name !== 'claim_task') return false
          if (firstSessionSeen == null) {
            firstSessionSeen = session
            return true // the very first claim attempt hits a stale/expired session
          }
          return false // the replay (after re-initialize) must succeed
        },
      })

      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-stale-session'))}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)

      assert.equal(backend.state.initializeCount, 2, 'must re-initialize exactly once after the stale session')
      assert.equal(backend.state.claimCreateCount, 1, 'must never create a second lease from the recovery replay')
      const rpcs = parseJsonRpcStdout(streams.stdoutText())
      const claimResult = rpcs.find((r) => r.id === 2)
      assert.ok(claimResult?.result?.lease?.claim_id, `recovered claim must surface success, got ${JSON.stringify(claimResult)}`)

      const claimAttempts = backend.state.requests.filter((r) => r.parsed?.params?.name === 'claim_task')
      assert.equal(claimAttempts.length, 2, 'exactly one stale attempt plus exactly one replay, no more')
    })

    test('a second consecutive stale session surfaces an error instead of looping forever', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {
        staleSessionFor: (parsed) => parsed.params?.name === 'claim_task',
      })

      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-double-stale'))}\n`)
      streams.io.stdin.end()
      // Must settle (not hang) within the timeout even if every session is rejected.
      await waitForBridge(running, 8000)

      assert.equal(backend.state.claimCreateCount, 0, 'never fabricate a successful claim over an unrecoverable session')
      assert.ok(backend.state.initializeCount <= 2, `must not loop re-initializing forever, got ${backend.state.initializeCount}`)
      const rpcs = parseJsonRpcStdout(streams.stdoutText())
      const claimResult = rpcs.find((r) => r.id === 2)
      assert.ok(claimResult, 'must still surface a JSON-RPC line for the pending request id')
      assert.equal(claimResult.result?.lease?.claim_id, undefined, 'must not report success on an unrecoverable session')
    })
  })

  describe('two bridge processes sharing one KAOLA_HOME', () => {
    test('claiming the same task from two processes serializes on the receipt: exactly one server-side claim', { timeout: 25000 }, async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, { delayMs: 150 })

      const a = spawnBridge(t, { home, origin: backend.origin })
      const b = spawnBridge(t, { home, origin: backend.origin })
      a.send(initializeRpc(1))
      a.send(claimRpc(2, 'kt-two-proc'))
      a.end()
      b.send(initializeRpc(1))
      b.send(claimRpc(2, 'kt-two-proc'))
      b.end()
      const [codeA, codeB] = await Promise.all([a.exit(), b.exit()])
      assert.equal(codeA, 0, `process A must exit cleanly, stderr: ${a.stderrText()}`)
      assert.equal(codeB, 0, `process B must exit cleanly, stderr: ${b.stderrText()}`)

      const claimA = parseJsonRpcStdout(a.stdoutText()).find((r) => r.id === 2)
      const claimB = parseJsonRpcStdout(b.stdoutText()).find((r) => r.id === 2)
      assert.ok(claimA, 'process A must produce a claim_task response')
      assert.ok(claimB, 'process B must produce a claim_task response')

      const claimIds = [claimA, claimB]
        .filter((r) => r?.result?.lease?.claim_id)
        .map((r) => r.result.lease.claim_id)
      assert.ok(claimIds.length >= 1, 'at least one process must successfully claim')
      assert.equal(new Set(claimIds).size, 1, `every successful claim result must share one claim_id, got ${JSON.stringify(claimIds)}`)
      assert.equal(backend.state.claimCreateCount, 1, `server must create exactly one claim total, got ${backend.state.claimCreateCount}`)
    })
  })

  describe('different tasks and different server origins coexist without interference', () => {
    test('separate receipt files with correct isolated content, no cross-contamination', async (t) => {
      const home = tmpKaolaHome(t)
      const backendOne = await makeClaimBackend(t, {
        tasks: { 'kt-one-a': { repo: { forge: 'github', full_name: 'kaola/one-a' }, description_md: 'x' } },
      })
      const backendTwo = await makeClaimBackend(t, {
        tasks: { 'kt-two-a': { repo: { forge: 'gitlab', full_name: 'kaola/two-a' }, description_md: 'y' } },
      })

      const combos = [
        { backend: backendOne, taskId: 'kt-one-a' },
        { backend: backendOne, taskId: 'kt-one-b' },
        { backend: backendTwo, taskId: 'kt-two-a' },
      ]
      for (const { backend, taskId } of combos) {
        const streams = makeStdioStreams()
        const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
        streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
        streams.io.stdin.write(`${JSON.stringify(claimRpc(2, taskId))}\n`)
        streams.io.stdin.end()
        await waitForBridge(running)
      }

      const paths = combos.map(({ backend, taskId }) => mod.receiptFilePath(home, backend.origin, taskId))
      const unique = new Set(paths)
      assert.equal(unique.size, combos.length, 'each (origin, task) pair must have its own receipt file')

      for (let i = 0; i < combos.length; i++) {
        const receipt = JSON.parse(readFileSync(paths[i], 'utf8'))
        assert.equal(receipt.task_id, combos[i].taskId)
        assert.equal(receipt.server, mod.originDigest(combos[i].backend.origin))
      }

      assert.equal(backendOne.state.claimCreateCount, 2)
      assert.equal(backendTwo.state.claimCreateCount, 1)
    })
  })

  describe('receipt corruption and mismatch fail safely', () => {
    async function seedUnrelatedReceipt(mod, home, backend) {
      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-unrelated-control'))}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)
      const path = mod.receiptFilePath(home, backend.origin, 'kt-unrelated-control')
      return { path, before: readFileSync(path, 'utf8') }
    }

    const corruptionCases = [
      ['truncated JSON', '{"v":1,"server":"abc","task_id":"kt-corrupt'],
      ['garbage bytes', ' not-json-at-all�'],
      ['wrong shape (array)', JSON.stringify([1, 2, 3])],
      ['wrong shape (missing fields)', JSON.stringify({ v: 1 })],
    ]

    for (const [label, contents] of corruptionCases) {
      test(`${label} at the receipt path does not crash the bridge and leaves unrelated receipts untouched`, async (t) => {
        const home = tmpKaolaHome(t)
        const backend = await makeClaimBackend(t, {})
        const control = await seedUnrelatedReceipt(mod, home, backend)

        const path = mod.receiptFilePath(home, backend.origin, 'kt-corrupt')
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, contents)

        const streams = makeStdioStreams()
        const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
        streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
        streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-corrupt'))}\n`)
        streams.io.stdin.end()
        await waitForBridge(running) // must not hang or reject uncaught

        assert.equal(readFileSync(control.path, 'utf8'), control.before, 'unrelated receipt must be neither read-through nor deleted')
        assertNoSecrets(streams.stderrText(), [FORGE_TOKEN, AUTH_HEADER_CANARY, TASK_DESCRIPTION_CANARY], 'stderr after corruption recovery')
        for (const path2 of walkFiles(home)) {
          assertNoSecrets(readFileSync(path2, 'utf8'), [FORGE_TOKEN, AUTH_HEADER_CANARY], `${path2} after corruption recovery`)
        }
      })
    }

    test('a receipt whose internal server/task_id do not match the lookup key is treated as unusable, not blindly trusted', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {})
      const path = mod.receiptFilePath(home, backend.origin, 'kt-mismatch')
      mkdirSync(dirname(path), { recursive: true })
      const foreignRequestId = randomUUID()
      writeFileSync(
        path,
        JSON.stringify({
          v: 1,
          server: 'not-the-real-origin-digest',
          task_id: 'some-other-task-entirely',
          request_id: foreignRequestId,
          claim_id: 'clm_foreign_should_not_be_reused',
          repo_identity: 'github/someone/else',
          carrier: 'direct',
          runner: null,
          runner_session: null,
        }),
        { mode: 0o600 },
      )

      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-mismatch'))}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)

      const claimCall = backend.state.requests.find((r) => r.parsed?.params?.name === 'claim_task')
      assert.notEqual(
        claimCall?.parsed?.params?.arguments?.request_id,
        foreignRequestId,
        'must never forward a foreign receipt\'s request_id for an unrelated task lookup',
      )
    })
  })

  describe('secret scan across a full claim + report_progress + submit_pr cycle', () => {
    test('KAOLA_HOME files, stderr, and the receipt field allowlist have zero hits of forge token / auth-shaped value / device private key / task description / decoy prompt fields', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {
        tasks: { 'kt-secret-scan': { repo: { forge: 'gitea', full_name: 'kaola/secret-scan' }, description_md: TASK_DESCRIPTION_CANARY } },
      })

      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
      streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-secret-scan'))}\n`)
      streams.io.stdin.write(`${JSON.stringify(mutationRpc(3, 'report_progress', { task_id: 'kt-secret-scan', note: 'ok' }))}\n`)
      streams.io.stdin.write(
        `${JSON.stringify(mutationRpc(4, 'submit_pr', { task_id: 'kt-secret-scan', pr_url: 'https://example.test/pr/9', summary: 'done' }))}\n`,
      )
      streams.io.stdin.end()
      await waitForBridge(running)

      // device.json is the existing, already-accepted on-disk store for the device private key
      // (see ensureDeviceIdentity / main.test.ts); it is excluded from the private-key sweep
      // below on purpose. It must still never carry the other secrets.
      const devicePath = join(home, 'device.json')
      const device = JSON.parse(readFileSync(devicePath, 'utf8'))
      const privateKey = device.privateKeyPkcs8
      const nonKeySecrets = [FORGE_TOKEN, AUTH_HEADER_CANARY, TASK_DESCRIPTION_CANARY, PROMPT_CANARY]
      const secrets = [...nonKeySecrets, privateKey]

      for (const path of walkFiles(home)) {
        if (path === devicePath) {
          assertNoSecrets(readFileSync(path, 'utf8'), nonKeySecrets, path)
          continue
        }
        assertNoSecrets(readFileSync(path, 'utf8'), secrets, path)
      }
      assertNoSecrets(streams.stderrText(), secrets, 'stderr')

      const receiptPath = mod.receiptFilePath(home, backend.origin, 'kt-secret-scan')
      const receiptRaw = readFileSync(receiptPath, 'utf8')
      assertNoSecrets(receiptRaw, secrets, 'receipt file')
      assertReceiptShape(JSON.parse(receiptRaw), {
        server: mod.originDigest(backend.origin),
        task_id: 'kt-secret-scan',
      })

      // stdout: AGENTS.md explicitly allows the token on the claim_task success response; that
      // is not this bridge's secret to withhold. Everything else must still never appear there.
      const rpcs = parseJsonRpcStdout(streams.stdoutText())
      const claimResult = rpcs.find((r) => r.id === 2)
      assert.equal(claimResult?.result?.token, FORGE_TOKEN, 'sanity: the allowed claim_task token disclosure still happens')
      assertNoSecrets(streams.stdoutText(), [privateKey], 'stdout')
    })
  })

  describe('non-tool JSON-RPC methods and unknown tools pass through unmodified', { concurrency: 1 }, () => {
    test('initialize, tools/list, ping, a notification, and an unknown method are forwarded and returned structurally unmodified', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {})

      const lines = [
        initializeRpc(1),
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'ping', params: {} },
        { jsonrpc: '2.0', method: 'notifications/progress', params: { extra: { nested: [1, 2, { k: 'v' }] } } },
        { jsonrpc: '2.0', id: 4, method: 'some/unknown/method', params: { anything: true, arr: [1, 'x', null] } },
      ]
      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      for (const line of lines) streams.io.stdin.write(`${JSON.stringify(line)}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)

      const wire = backend.state.requests.map((r) => r.parsed)
      for (const original of lines) {
        const matchOnWire = wire.find((w) => w?.method === original.method && (original.id === undefined || w.id === original.id))
        assert.ok(matchOnWire, `${original.method} must reach the server`)
        assert.deepEqual(matchOnWire, original, `${original.method} must be forwarded structurally unmodified`)
      }

      const rpcs = parseJsonRpcStdout(streams.stdoutText())
      const toolsListOut = rpcs.find((r) => r.id === 2)
      assert.deepEqual(toolsListOut?.result, { tools: [{ name: 'list_tasks' }] })
      const unknownMethodOut = rpcs.find((r) => r.id === 4)
      assert.notEqual(unknownMethodOut, undefined)
      assert.equal(unknownMethodOut.error, undefined, 'an unknown method is the server\'s business, not the bridge\'s')
    })

    test('an unknown tool name inside tools/call is forwarded with its arguments unmodified', async (t) => {
      const home = tmpKaolaHome(t)
      const backend = await makeClaimBackend(t, {})

      const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'some_future_tool', arguments: { weird: { nested: true }, claim_id: 'should-not-be-touched' } } }
      const streams = makeStdioStreams()
      const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(call)}\n`)
      streams.io.stdin.end()
      await waitForBridge(running)

      const seen = backend.state.requests.find((r) => r.parsed?.params?.name === 'some_future_tool')
      assert.ok(seen, 'unknown tool call must reach the server')
      assert.deepEqual(seen.parsed.params.arguments, call.params.arguments, 'unknown tool arguments must not be rewritten')

      const rpcs = parseJsonRpcStdout(streams.stdoutText())
      assert.deepEqual(rpcs[0]?.result, { echoed: { name: 'some_future_tool', args: call.params.arguments } })
    })
  })
})
