// AUDIT-R1 — the discarded advisory observation must reach stderr, not silently vanish.
//
// -----------------------------------------------------------------------------------------------
// Defect (found by an independent scope audit of commit cfe50ff / Issue #34): resolveCarrierIntent
// in apps/mcp/src/runner-carrier.ts computes a legible `observation` string whenever an explicit
// KAOLA_CARRIER=runner selection cannot be honored (unrecognized carrier value, unknown/missing
// runner id, missing session, non-absolute repo). That string's sole consumer,
// receiptCarrierFields in apps/mcp/src/main.ts, reads only `intent.carrier` and throws the
// observation away. `grep -n "observation" apps/mcp/src/main.ts` currently returns zero hits, so
// an operator who typos KAOLA_RUNNER (e.g. "claude" instead of the pinned "claude-code") gets
// total silence: the only trace left behind is `carrier:"advisory"` inside a 0600 receipt file,
// and only if a claim_task later succeeds. docs/runner-carrier.md:88-94 promises a legible
// advisory observation instead.
//
// Independent test custody; test paths only, no production code here. This suite does not import
// from runner-carrier.test.ts, main.test.ts, or claim-receipt.test.ts (each of those suites keeps
// its own independent harness by the same convention) -- it builds its own minimal stdio-bridge
// and fake-backend fixtures.
//
// Contract pinned here:
//   1. When resolveCarrierIntent(env) resolves to { carrier: 'advisory', observation }, running
//      the bridge under that same env writes `observation` to stderr AT STARTUP -- i.e. even when
//      no claim_task (or any RPC at all) is ever sent on stdin. This is the exact gap: today the
//      only trace requires a successful claim; the fix must not depend on one.
//   2. The observation is written to stderr EXACTLY ONCE per process, even across multiple
//      claim_task calls -- "once, at startup", not re-emitted per request.
//   3. A well-formed explicit Runner selection (a recognized pinned runner id, valid session,
//      absolute repo) resolves to { carrier: 'runner', ... } and MUST NOT write any of this
//      advisory noise to stderr.
//   4. The plain default Workflow path (KAOLA_CARRIER unset) MUST NOT write any advisory noise to
//      stderr either.
//   5. The reported text is exactly the `observation` computed by resolveCarrierIntent for that
//      same env -- derived from the production pure function itself, not hand-authored prose here,
//      so the implementer keeps full wording freedom for the observation text.
//   6. Reporting the observation must never leak the forge token, an Authorization-shaped header
//      value, or any other credential material into stderr.
// -----------------------------------------------------------------------------------------------

import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'

const FORGE_TOKEN = 'gitea-FORGE-TOKEN-must-not-persist-r1stderr'
const AUTH_HEADER_CANARY = 'Bearer ktk_should-never-persist-r1stderr'

async function loadRunnerCarrier() {
  try {
    return await import('./runner-carrier.ts')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    assert.fail(`apps/mcp/src/runner-carrier.ts must export resolveCarrierIntent (got ${code || String(err)})`)
  }
}

async function loadBridge() {
  try {
    return await import('./main.ts')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    assert.fail(`apps/mcp/src/main.ts must remain importable (got ${code || String(err)})`)
  }
}

let rc
let mod
before(async () => {
  rc = await loadRunnerCarrier()
  mod = await loadBridge()
})

function tmpKaolaHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-r1-home-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tmpRepoDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-r1-repo-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
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
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'r1-stderr-test', version: '0' } },
  }
}

function claimRpc(id, taskId) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'claim_task', arguments: { task_id: taskId } } }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0
  return (haystack.match(new RegExp(escapeRegExp(needle), 'g')) || []).length
}

/**
 * A minimal fake Kaola server: initialize + claim_task only, returning a forge token and an
 * Authorization-shaped canary exactly like the existing claim response shape (mirrors the
 * harness pattern in runner-carrier.test.ts, kept independent here per that suite's own
 * convention of not being imported from).
 */
async function makeMinimalClaimBackend(t) {
  const state = { sessions: new Set(), claimCreateCount: 0 }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        parsed = null
      }
      const session = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : ''
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
        const sid = `sid-${randomUUID()}`
        state.sessions.add(sid)
        respond(
          200,
          { jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'kaola-tasks' } } },
          { 'mcp-session-id': sid },
        )
        return
      }
      if (session && !state.sessions.has(session)) {
        respond(404, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32001, message: 'Session not found' } })
        return
      }
      if (parsed.method === 'tools/call' && parsed.params?.name === 'claim_task') {
        state.claimCreateCount++
        const taskId = parsed.params.arguments?.task_id
        respond(200, {
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            task: { id: taskId, repo: { forge: 'gitea', full_name: 'kaola/demo-repo' } },
            token: FORGE_TOKEN,
            lease: { claim_id: `clm_${state.claimCreateCount}_${taskId}`, expires_at: '2026-09-01T06:00:00.000Z', ttl_seconds: 86400 },
            clone: { suggested_dir: 'demo' },
            _debug: { authorization: AUTH_HEADER_CANARY },
          },
        })
        return
      }
      respond(200, { jsonrpc: '2.0', id: parsed.id ?? null, result: {} })
    })
  })
  t.after(() => server.close())
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolveP({ origin: `http://127.0.0.1:${addr.port}`, state })
    })
  })
}

// -----------------------------------------------------------------------------------------------

describe('AUDIT-R1 — advisory carrier observation must reach stderr, not be discarded', () => {
  test('an unrecognized KAOLA_RUNNER id reports the exact resolveCarrierIntent observation to stderr, even when no claim_task is ever sent', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const bridgeEnv = {
      KAOLA_HOME: home,
      KAOLA_CARRIER: 'runner',
      KAOLA_RUNNER: 'claude', // plausible typo for the pinned id "claude-code"
      KAOLA_RUNNER_SESSION: 'kw-r1-typo',
      KAOLA_RUNNER_REPO: repo,
    }

    const intent = rc.resolveCarrierIntent(bridgeEnv)
    assert.equal(intent.carrier, 'advisory', 'sanity: this env must resolve to advisory for the test to be meaningful')
    assert.ok(intent.observation.includes('claude'), 'sanity: the pure function names the offending id')

    const streams = makeStdioStreams()
    // No --url flag: falls back to the bridge's own local default origin. No stdin lines at all
    // (immediately closed) -- the advisory report must not depend on any RPC, let alone a
    // successful claim_task, ever being sent.
    const running = mod.runStdioBridge([], bridgeEnv, streams.io)
    streams.io.stdin.end()
    await waitForBridge(running)

    assert.ok(
      streams.stderrText().includes(intent.observation),
      `expected stderr to contain the resolveCarrierIntent observation, got: ${JSON.stringify(streams.stderrText())}`,
    )
  })

  test('KAOLA_CARRIER=runner with KAOLA_RUNNER missing entirely also reports its observation to stderr at startup', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const bridgeEnv = {
      KAOLA_HOME: home,
      KAOLA_CARRIER: 'runner',
      KAOLA_RUNNER_SESSION: 'kw-r1-no-runner',
      KAOLA_RUNNER_REPO: repo,
    }
    const intent = rc.resolveCarrierIntent(bridgeEnv)
    assert.equal(intent.carrier, 'advisory')

    const streams = makeStdioStreams()
    const running = mod.runStdioBridge([], bridgeEnv, streams.io)
    streams.io.stdin.end()
    await waitForBridge(running)

    assert.ok(
      streams.stderrText().includes(intent.observation),
      `expected stderr to contain the observation for a missing KAOLA_RUNNER, got: ${JSON.stringify(streams.stderrText())}`,
    )
  })

  test('the observation is written to stderr exactly once, even across two successful claim_task calls', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const backend = await makeMinimalClaimBackend(t)
    const bridgeEnv = {
      KAOLA_HOME: home,
      KAOLA_CARRIER: 'runner',
      KAOLA_RUNNER: 'unknown-future-cli',
      KAOLA_RUNNER_SESSION: 'kw-r1-once',
      KAOLA_RUNNER_REPO: repo,
    }
    const intent = rc.resolveCarrierIntent(bridgeEnv)
    assert.equal(intent.carrier, 'advisory')

    const streams = makeStdioStreams()
    const running = mod.runStdioBridge(['--url', backend.origin], bridgeEnv, streams.io)
    streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
    streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-r1-once-a'))}\n`)
    streams.io.stdin.write(`${JSON.stringify(claimRpc(3, 'kt-r1-once-b'))}\n`)
    streams.io.stdin.end()
    await waitForBridge(running)

    const rpcs = parseJsonRpcStdout(streams.stdoutText())
    assert.ok(rpcs.find((r) => r.id === 2)?.result?.lease?.claim_id, 'first claim must still succeed despite the advisory selection')
    assert.ok(rpcs.find((r) => r.id === 3)?.result?.lease?.claim_id, 'second claim must still succeed despite the advisory selection')

    const errText = streams.stderrText()
    assert.equal(
      countOccurrences(errText, intent.observation),
      1,
      `expected the advisory observation exactly once (reported at startup, not per request), got: ${JSON.stringify(errText)}`,
    )

    // The advisory report must never leak the forge token or an Authorization-shaped value that
    // flowed through the two successful claim responses.
    assert.equal(errText.includes(FORGE_TOKEN), false, 'stderr must never contain the forge token')
    assert.equal(errText.includes(AUTH_HEADER_CANARY), false, 'stderr must never contain an Authorization-shaped credential')
  })

  test('a well-formed explicit Runner selection (a recognized pinned id) writes no advisory noise to stderr', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const bridgeEnv = {
      KAOLA_HOME: home,
      KAOLA_CARRIER: 'runner',
      KAOLA_RUNNER: 'claude-code', // the pinned, recognized id
      KAOLA_RUNNER_SESSION: 'kw-r1-well-formed',
      KAOLA_RUNNER_REPO: repo,
    }
    const intent = rc.resolveCarrierIntent(bridgeEnv)
    assert.equal(intent.carrier, 'runner', 'sanity: this env must resolve to a well-formed runner selection')

    const streams = makeStdioStreams()
    const running = mod.runStdioBridge([], bridgeEnv, streams.io)
    streams.io.stdin.end()
    await waitForBridge(running)

    assert.equal(
      streams.stderrText(),
      '',
      `a well-formed explicit Runner selection must not emit anything to stderr, got: ${JSON.stringify(streams.stderrText())}`,
    )
  })

  test('the plain default Workflow path (KAOLA_CARRIER unset) writes no advisory noise to stderr', async (t) => {
    const home = tmpKaolaHome(t)
    const bridgeEnv = { KAOLA_HOME: home }
    const intent = rc.resolveCarrierIntent(bridgeEnv)
    assert.equal(intent.carrier, 'direct')

    const streams = makeStdioStreams()
    const running = mod.runStdioBridge([], bridgeEnv, streams.io)
    streams.io.stdin.end()
    await waitForBridge(running)

    assert.equal(
      streams.stderrText(),
      '',
      `the default direct path must not emit anything to stderr, got: ${JSON.stringify(streams.stderrText())}`,
    )
  })

  test('stray KAOLA_RUNNER_* vars with KAOLA_CARRIER unset stay direct and write no advisory noise (gating is on KAOLA_CARRIER only)', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const bridgeEnv = {
      KAOLA_HOME: home,
      KAOLA_RUNNER: 'grok',
      KAOLA_RUNNER_SESSION: 'stray-session',
      KAOLA_RUNNER_REPO: repo,
    }
    const intent = rc.resolveCarrierIntent(bridgeEnv)
    assert.equal(intent.carrier, 'direct')

    const streams = makeStdioStreams()
    const running = mod.runStdioBridge([], bridgeEnv, streams.io)
    streams.io.stdin.end()
    await waitForBridge(running)

    assert.equal(streams.stderrText(), '', `stray runner vars without KAOLA_CARRIER must not emit advisory noise, got: ${JSON.stringify(streams.stderrText())}`)
  })
})
