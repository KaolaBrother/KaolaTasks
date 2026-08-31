// Issue #34 — Add explicit Kaola Project Runner carrier compatibility. Independent acceptance
// suite; test custody only, no production code here. RED against HEAD 5e79230: neither
// apps/mcp/src/runner-carrier.ts nor its exports exist yet, and apps/mcp/src/main.ts ignores
// KAOLA_CARRIER/KAOLA_RUNNER/KAOLA_RUNNER_SESSION/KAOLA_RUNNER_REPO entirely (the receipt always
// records carrier:'direct', runner:null, runner_session:null).
//
// -----------------------------------------------------------------------------------------------
// Contract source: the bundle brief for Issue #34, and the pinned Runner measurement recorded
// there (kaola-project-runner @ commit fa19c63d, 2026-08-31, read-only — this suite binds to that
// recorded snapshot, never to the live external repo, which this suite never writes to).
//
// Production exports this suite requires from a NEW file apps/mcp/src/runner-carrier.ts (a pure
// module: no I/O, no process spawning, no network — see the "pure module contract" test below,
// which statically greps the module's own source text for forbidden imports):
//
//   1. RUNNER_SNAPSHOT_COMMIT: string
//        The pinned Runner snapshot identity, exactly 'fa19c63d'. The Runner carries no semver
//        and no tag, so the commit hash IS the version.
//
//   2. RUNNER_VARIANTS: ReadonlyArray<{ id: string, binary: string }>
//        The pinned runtime-variant fixture table (scripts/kaola-tmux.sh:51 in the snapshot),
//        exactly five entries, in this exact id -> binary mapping:
//          grok         -> grok
//          claude-code  -> claude
//          opencode     -> opencode
//          kimi-cli     -> kimi
//          cursor-cli   -> cursor-agent
//        Acceptance binds to this recorded list, not to whatever the external repo exposes
//        later (see "Fixtures bind to the pinned list" in the brief).
//
//   3. resolveCarrierIntent(env: Record<string, string | undefined>): CarrierIntent
//        Pure. Reads ONLY KAOLA_CARRIER / KAOLA_RUNNER / KAOLA_RUNNER_SESSION /
//        KAOLA_RUNNER_REPO from the given env map (never an MCP tool parameter — explicit intent
//        is local-only per the brief). Returns exactly one of three discriminated shapes:
//          { carrier: 'direct' }
//            -- KAOLA_CARRIER is unset, empty, or literally 'direct'.
//          { carrier: 'runner', runner: <one of the 5 pinned ids>, repo: <string>,
//            session: <string> }
//            -- KAOLA_CARRIER === 'runner' AND KAOLA_RUNNER is one of the 5 pinned ids AND
//               KAOLA_RUNNER_SESSION is a non-empty string AND KAOLA_RUNNER_REPO is a non-empty
//               ABSOLUTE path (syntactic check only -- this module does no filesystem I/O, so it
//               cannot confirm the path is an existing git top-level; see the resolved ambiguity
//               note below).
//          { carrier: 'advisory', observation: <non-empty, legible string> }
//            -- every other case: KAOLA_CARRIER === 'runner' but KAOLA_RUNNER is unknown/absent,
//               KAOLA_RUNNER_SESSION is missing/empty, KAOLA_RUNNER_REPO is missing/empty/not
//               absolute, or KAOLA_CARRIER is itself an unrecognized non-empty value that is
//               neither 'direct' nor 'runner'.
//        MUST NEVER throw and MUST NEVER silently return { carrier: 'direct' } for a case that
//        should be advisory (no silent fallback).
//
//   4. runnerSessionLocator(repo: string, session: string): string
//        Pure. Serializes (repo, session) into the single string persisted verbatim into the
//        Claim receipt's existing `runner_session` field (that field's shape is frozen by Issue
//        #32 as a single `string | null` -- see claim-receipt.test.ts -- so this module owns
//        packing/unpacking it). Throws (TypeError or Error; this suite only asserts *some* throw)
//        when `repo` is not an absolute path, or when `session` is empty. Round-trips through:
//
//   5. parseRunnerSessionLocator(value: string | null | undefined): { repo, session } | null
//        Pure, defensive: never throws. Returns null for null/undefined/non-JSON/garbage/
//        incomplete input; otherwise returns the exact { repo, session } that produced the
//        string via runnerSessionLocator. This is what lets a FRESH bridge process reading only
//        the receipt recover the same (repo, session) locator without starting anything.
//
//   6. runnerForwardedEnv(env: Record<string, string | undefined>): Record<string, string>
//        Pure. Returns the subset of `env` whose keys match the exact forwarding pattern the
//        pinned Runner's own `start` command uses (scripts/kaola-tmux.sh:403:
//        `CLAUDE_*|GROK_*|OPENCODE_*|KIMI_*|CURSOR_*|FAKE_*`), unchanged in value. This is a pure
//        read-only projection -- it never mutates `env` -- used so the module (and this suite)
//        can reason about what a Runner `start` invocation would end up forwarding without this
//        module itself ever spawning anything.
//
// Resolved ambiguities (decided here, not left to the implementer):
//   A. "Ordering: workspace before Runner start" (brief point D) can only be asserted, from a
//      pure no-I/O module, as a SYNTACTIC precondition: KAOLA_RUNNER_REPO must be a non-empty
//      ABSOLUTE path, or the result is advisory. Confirming the path is an *existing git
//      top-level* requires filesystem I/O, which this module's contract explicitly excludes and
//      which this suite is forbidden from performing (no real filesystem probing of an actual
//      git checkout, no starting anything). The absolute-path requirement is therefore the
//      maximal honest signal this suite binds to for point D.
//   B. An unrecognized non-empty KAOLA_CARRIER value (neither 'direct' nor 'runner', e.g.
//      'sandbox') is treated as advisory, not silently as direct -- consistent with "never a
//      silent fallback to direct" applying to any malformed explicit carrier signal, not only a
//      malformed runner selection.
//   C. What the Claim receipt's `carrier` field becomes when resolveCarrierIntent returns
//      'advisory' is NOT pinned by this suite: the brief specifies receipt behavior only for the
//      default direct path and for a well-formed explicit Runner selection (point C), and pins
//      point F ("no silent carrier switch") only at the resolveCarrierIntent boundary. Freezing a
//      receipt-level interpretation for the advisory case here would invent behavior the brief
//      does not state. This suite instead asserts, for the advisory case, only what IS stated
//      elsewhere: the claim still succeeds and the six tools' behavior is unchanged (point E).
//   D. runnerSessionLocator's serialization format is intentionally unconstrained beyond "throws
//      on invalid input, round-trips via parseRunnerSessionLocator" -- this suite fuzzes the
//      round trip (including a session name containing characters a naive delimiter would
//      mishandle) rather than pinning a specific string format, so the implementer is free to
//      choose JSON, a delimiter, or any other encoding.
// -----------------------------------------------------------------------------------------------

import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readFileSync as readFileSyncSecrets,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER_CARRIER_PATH = join(HERE, 'runner-carrier.ts')

const FORGE_TOKEN = 'gitea-FORGE-TOKEN-must-not-persist-r34n'
const AUTH_HEADER_CANARY = 'Bearer ktk_should-never-persist-r34x'
const PINNED_VARIANT_IDS = ['grok', 'claude-code', 'opencode', 'kimi-cli', 'cursor-cli']
const PINNED_BINARY_BY_ID = {
  grok: 'grok',
  'claude-code': 'claude',
  opencode: 'opencode',
  'kimi-cli': 'kimi',
  'cursor-cli': 'cursor-agent',
}

async function loadRunnerCarrier() {
  try {
    return await import('./runner-carrier.ts')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    assert.fail(
      `apps/mcp/src/runner-carrier.ts must export RUNNER_SNAPSHOT_COMMIT, RUNNER_VARIANTS, ` +
        `resolveCarrierIntent, runnerSessionLocator, parseRunnerSessionLocator, ` +
        `runnerForwardedEnv (got ${code || String(err)})`,
    )
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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-runner-home-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tmpRepoDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-runner-repo-'))
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

function assertNoSecrets(text, secrets, label) {
  for (const secret of secrets) {
    assert.equal(String(text).includes(secret), false, `${label} must not contain: ${secret}`)
  }
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
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'runner-carrier-test', version: '0' } },
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
 * A minimal fake Kaola server (mirrors the harness in claim-receipt.test.ts, kept independent
 * here since this suite must not import from a file it is forbidden to touch): sessions, claim
 * idempotency keyed by request_id, and a mutation call ledger the tests assert against directly.
 */
async function makeClaimBackend(t) {
  const state = { initializeCount: 0, claimsByRequestId: new Map(), claimCreateCount: 0, sessions: new Set(), mutationCalls: [] }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
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
          state.initializeCount++
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
            let claimId = requestId ? state.claimsByRequestId.get(requestId) : undefined
            if (claimId == null) {
              state.claimCreateCount++
              claimId = `clm_${state.claimCreateCount}_${taskId}`
              if (requestId) state.claimsByRequestId.set(requestId, claimId)
            }
            respond(200, {
              jsonrpc: '2.0',
              id: parsed.id,
              result: {
                task: { id: taskId, repo: { forge: 'gitea', full_name: 'kaola/demo-repo' } },
                token: FORGE_TOKEN,
                lease: { claim_id: claimId, expires_at: '2026-09-01T06:00:00.000Z', ttl_seconds: 86400 },
                clone: { suggested_dir: 'demo' },
                _debug: { authorization: AUTH_HEADER_CANARY },
              },
            })
            return
          }
          if (name === 'report_progress' || name === 'release_task' || name === 'submit_pr') {
            state.mutationCalls.push({ tool: name, args })
            respond(200, { jsonrpc: '2.0', id: parsed.id, result: { ok: true } })
            return
          }
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
      resolveP({ origin: `http://127.0.0.1:${addr.port}`, state })
    })
  })
}

// -----------------------------------------------------------------------------------------------

describe('runner-carrier module shape (Issue #34)', () => {
  test('exports the six pure functions/constants the bridge integration will depend on', async () => {
    assert.equal(typeof rc.resolveCarrierIntent, 'function')
    assert.equal(typeof rc.runnerSessionLocator, 'function')
    assert.equal(typeof rc.parseRunnerSessionLocator, 'function')
    assert.equal(typeof rc.runnerForwardedEnv, 'function')
    assert.ok(Array.isArray(rc.RUNNER_VARIANTS))
    assert.equal(typeof rc.RUNNER_SNAPSHOT_COMMIT, 'string')
  })

  test('RUNNER_SNAPSHOT_COMMIT pins the recorded Runner snapshot, not a live measurement', async () => {
    assert.equal(rc.RUNNER_SNAPSHOT_COMMIT, 'fa19c63d')
  })

  test('is a pure module: its own source never imports process-spawning, filesystem, or network primitives', async () => {
    const source = readFileSync(RUNNER_CARRIER_PATH, 'utf8')
    const forbidden = ['node:child_process', 'child_process', 'node:net', 'node:http', 'node:https', 'node:dgram', 'node:tls']
    for (const spec of forbidden) {
      assert.equal(source.includes(spec), false, `runner-carrier.ts must not import ${spec} (pure, no I/O, no process spawning, no network)`)
    }
  })
})

describe('RUNNER_VARIANTS fixture table (bound to the recorded snapshot, not the live repo)', () => {
  test('has exactly the five pinned identifiers, no more, no fewer', async () => {
    const ids = rc.RUNNER_VARIANTS.map((v) => v.id).sort()
    assert.deepEqual(ids, [...PINNED_VARIANT_IDS].sort())
  })

  for (const id of PINNED_VARIANT_IDS) {
    test(`variant "${id}" is bound to binary "${PINNED_BINARY_BY_ID[id]}"`, async () => {
      const entry = rc.RUNNER_VARIANTS.find((v) => v.id === id)
      assert.ok(entry, `expected a RUNNER_VARIANTS entry for id "${id}"`)
      assert.equal(entry.binary, PINNED_BINARY_BY_ID[id])
    })
  }

  test('does not include an unpinned/future variant such as "gpt5-cli"', async () => {
    assert.equal(rc.RUNNER_VARIANTS.some((v) => v.id === 'gpt5-cli'), false)
  })
})

describe('resolveCarrierIntent — env-only explicit intent, direct by default', () => {
  test('unset KAOLA_CARRIER resolves to the direct carrier with no extra fields', async () => {
    const result = rc.resolveCarrierIntent({})
    assert.deepEqual(result, { carrier: 'direct' })
  })

  test('empty-string KAOLA_CARRIER resolves to direct, same as unset', async () => {
    const result = rc.resolveCarrierIntent({ KAOLA_CARRIER: '' })
    assert.deepEqual(result, { carrier: 'direct' })
  })

  test('explicit KAOLA_CARRIER=direct resolves to direct even with stray runner env present', async () => {
    const result = rc.resolveCarrierIntent({
      KAOLA_CARRIER: 'direct',
      KAOLA_RUNNER: 'not-a-real-variant',
      KAOLA_RUNNER_SESSION: 'sess',
      KAOLA_RUNNER_REPO: 'relative/not-absolute',
    })
    assert.deepEqual(result, { carrier: 'direct' })
  })

  for (const id of PINNED_VARIANT_IDS) {
    test(`well-formed explicit selection of pinned variant "${id}" resolves to the runner carrier`, async (t) => {
      const repo = tmpRepoDir(t)
      const result = rc.resolveCarrierIntent({
        KAOLA_CARRIER: 'runner',
        KAOLA_RUNNER: id,
        KAOLA_RUNNER_SESSION: `kw-session-${id}`,
        KAOLA_RUNNER_REPO: repo,
      })
      assert.deepEqual(result, { carrier: 'runner', runner: id, repo, session: `kw-session-${id}` })
    })
  }

  test('an unknown/unrecognized runner id produces an advisory observation, never a throw, never a silent switch to direct', async (t) => {
    const repo = tmpRepoDir(t)
    let result
    assert.doesNotThrow(() => {
      result = rc.resolveCarrierIntent({
        KAOLA_CARRIER: 'runner',
        KAOLA_RUNNER: 'totally-unpinned-cli',
        KAOLA_RUNNER_SESSION: 'sess-1',
        KAOLA_RUNNER_REPO: repo,
      })
    })
    assert.equal(result.carrier, 'advisory')
    assert.notEqual(result.carrier, 'direct')
    assert.equal(typeof result.observation, 'string')
    assert.ok(result.observation.length > 0, 'observation must be a legible, non-empty string')
    assert.ok(
      result.observation.includes('totally-unpinned-cli'),
      'observation should name the offending runner id so it is legible, not just a boolean flag',
    )
  })

  test('KAOLA_CARRIER=runner with KAOLA_RUNNER missing entirely is advisory (incomplete selection), not direct', async (t) => {
    const repo = tmpRepoDir(t)
    const result = rc.resolveCarrierIntent({
      KAOLA_CARRIER: 'runner',
      KAOLA_RUNNER_SESSION: 'sess-1',
      KAOLA_RUNNER_REPO: repo,
    })
    assert.equal(result.carrier, 'advisory')
    assert.equal(typeof result.observation, 'string')
    assert.ok(result.observation.length > 0)
  })

  test('KAOLA_CARRIER=runner with KAOLA_RUNNER_SESSION missing is advisory (incomplete selection)', async (t) => {
    const repo = tmpRepoDir(t)
    const result = rc.resolveCarrierIntent({ KAOLA_CARRIER: 'runner', KAOLA_RUNNER: 'grok', KAOLA_RUNNER_REPO: repo })
    assert.equal(result.carrier, 'advisory')
  })

  test('KAOLA_CARRIER=runner with KAOLA_RUNNER_SESSION empty string is advisory, same as missing', async (t) => {
    const repo = tmpRepoDir(t)
    const result = rc.resolveCarrierIntent({
      KAOLA_CARRIER: 'runner',
      KAOLA_RUNNER: 'grok',
      KAOLA_RUNNER_SESSION: '',
      KAOLA_RUNNER_REPO: repo,
    })
    assert.equal(result.carrier, 'advisory')
  })

  test('KAOLA_CARRIER=runner with KAOLA_RUNNER_REPO missing entirely is advisory (incomplete selection)', async () => {
    const result = rc.resolveCarrierIntent({ KAOLA_CARRIER: 'runner', KAOLA_RUNNER: 'grok', KAOLA_RUNNER_SESSION: 'sess-1' })
    assert.equal(result.carrier, 'advisory')
  })

  test('a relative (non-absolute) KAOLA_RUNNER_REPO is advisory — the pure module can only assert the syntactic precondition for "workspace must exist before Runner start" (see resolved ambiguity A)', async () => {
    const result = rc.resolveCarrierIntent({
      KAOLA_CARRIER: 'runner',
      KAOLA_RUNNER: 'grok',
      KAOLA_RUNNER_SESSION: 'sess-1',
      KAOLA_RUNNER_REPO: 'relative/path/not/absolute',
    })
    assert.equal(result.carrier, 'advisory')
    assert.notEqual(result.carrier, 'runner')
  })

  test('an unrecognized non-empty KAOLA_CARRIER value (neither direct nor runner) is advisory, not a silent direct fallback (see resolved ambiguity B)', async () => {
    let result
    assert.doesNotThrow(() => {
      result = rc.resolveCarrierIntent({ KAOLA_CARRIER: 'sandbox' })
    })
    assert.equal(result.carrier, 'advisory')
    assert.notEqual(result.carrier, 'direct')
  })

  test('never throws across a battery of malformed/hostile env shapes', async () => {
    const battery = [
      { KAOLA_CARRIER: 'runner' },
      { KAOLA_CARRIER: '   runner   ' },
      { KAOLA_CARRIER: 'runner', KAOLA_RUNNER: '', KAOLA_RUNNER_SESSION: '', KAOLA_RUNNER_REPO: '' },
      { KAOLA_CARRIER: 'runner', KAOLA_RUNNER: '任务🚀混合ID', KAOLA_RUNNER_SESSION: 's', KAOLA_RUNNER_REPO: '/tmp' },
      { KAOLA_CARRIER: 'RUNNER', KAOLA_RUNNER: 'GROK' },
    ]
    for (const env of battery) {
      assert.doesNotThrow(() => rc.resolveCarrierIntent(env), `must not throw for env ${JSON.stringify(env)}`)
    }
  })
})

describe('runnerSessionLocator / parseRunnerSessionLocator — the receipt-recoverable locator', () => {
  test('produces a string, and round-trips back to the exact (repo, session)', async (t) => {
    const repo = tmpRepoDir(t)
    const locator = rc.runnerSessionLocator(repo, 'kw-session-abc')
    assert.equal(typeof locator, 'string')
    const parsed = rc.parseRunnerSessionLocator(locator)
    assert.deepEqual(parsed, { repo, session: 'kw-session-abc' })
  })

  test('round-trips a session name containing delimiter-hostile characters', async (t) => {
    const repo = tmpRepoDir(t)
    const hostileSessions = ['sess::with::colons', 'sess with spaces', 'sess|pipe', '会话-unicode-🚀', 'a'.repeat(300)]
    for (const session of hostileSessions) {
      const locator = rc.runnerSessionLocator(repo, session)
      const parsed = rc.parseRunnerSessionLocator(locator)
      assert.deepEqual(parsed, { repo, session }, `round trip failed for session ${JSON.stringify(session)}`)
    }
  })

  test('throws for a non-absolute repo', async () => {
    assert.throws(() => rc.runnerSessionLocator('relative/path', 'sess'))
  })

  test('throws for an empty session', async (t) => {
    const repo = tmpRepoDir(t)
    assert.throws(() => rc.runnerSessionLocator(repo, ''))
  })

  test('parseRunnerSessionLocator is defensive: null/undefined/garbage/incomplete input returns null, never throws', async () => {
    for (const value of [null, undefined, '', 'not-json-at-all', '{"repo":"/only/repo"}', '{"session":"only-session"}', '[]', '42']) {
      let parsed
      assert.doesNotThrow(() => {
        parsed = rc.parseRunnerSessionLocator(value)
      })
      assert.equal(parsed, null, `expected null for ${JSON.stringify(value)}`)
    }
  })
})

describe('runnerForwardedEnv — the exact CLAUDE_*|GROK_*|OPENCODE_*|KIMI_*|CURSOR_*|FAKE_* projection', () => {
  test('forwards only keys matching the pinned Runner start-command prefix list', async () => {
    const env = {
      CLAUDE_MODEL: 'x',
      GROK_API_KEY: 'y',
      OPENCODE_HOME: 'z',
      KIMI_TOKEN: 'w',
      CURSOR_MODE: 'v',
      FAKE_FLAG: 'u',
      UNRELATED_VAR: 'nope',
      PATH: '/usr/bin',
      HOME: '/home/x',
    }
    const forwarded = rc.runnerForwardedEnv(env)
    assert.deepEqual(Object.keys(forwarded).sort(), ['CLAUDE_MODEL', 'CURSOR_MODE', 'FAKE_FLAG', 'GROK_API_KEY', 'KIMI_TOKEN', 'OPENCODE_HOME'].sort())
    assert.equal(forwarded.CLAUDE_MODEL, 'x')
    assert.equal(forwarded.GROK_API_KEY, 'y')
  })

  test('does not mutate the input env object', async () => {
    const env = { CLAUDE_MODEL: 'x', UNRELATED: 'y' }
    const snapshot = { ...env }
    rc.runnerForwardedEnv(env)
    assert.deepEqual(env, snapshot)
  })

  test('excludes undefined-valued entries', async () => {
    const forwarded = rc.runnerForwardedEnv({ CLAUDE_MODEL: undefined, GROK_TOKEN: 'present' })
    assert.equal(Object.hasOwn(forwarded, 'CLAUDE_MODEL'), false)
    assert.equal(forwarded.GROK_TOKEN, 'present')
  })
})

// -----------------------------------------------------------------------------------------------
// Bridge integration: the receipt carries the local carrier/runner/session locator (point C),
// the default path is unaffected (point G), the six tools are unaffected by carrier selection
// (point E), and a fresh process re-attaches from the receipt without a second Claim (point C).
// -----------------------------------------------------------------------------------------------

describe('Claim receipt carrier fields (Issue #34 point C, against the existing Issue #32 receipt shape)', { concurrency: 1 }, () => {
  test('default path (KAOLA_CARRIER unset): receipt keeps carrier direct / runner null / runner_session null, unchanged from Issue #32', async (t) => {
    const home = tmpKaolaHome(t)
    const backend = await makeClaimBackend(t)
    const streams = makeStdioStreams()
    const running = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, streams.io)
    streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
    streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-default-path'))}\n`)
    streams.io.stdin.end()
    await waitForBridge(running)

    const receiptPath = mod.receiptFilePath(home, backend.origin, 'kt-default-path')
    assert.equal(existsSync(receiptPath), true)
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    assert.equal(receipt.carrier, 'direct')
    assert.equal(receipt.runner, null)
    assert.equal(receipt.runner_session, null)
  })

  test('default path stays direct even with stray KAOLA_RUNNER_* vars present but KAOLA_CARRIER unset (gating is on KAOLA_CARRIER only)', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const backend = await makeClaimBackend(t)
    const streams = makeStdioStreams()
    const running = mod.runStdioBridge(
      ['--url', backend.origin],
      { KAOLA_HOME: home, KAOLA_RUNNER: 'grok', KAOLA_RUNNER_SESSION: 'stray-session', KAOLA_RUNNER_REPO: repo },
      streams.io,
    )
    streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
    streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-stray-vars'))}\n`)
    streams.io.stdin.end()
    await waitForBridge(running)

    const receiptPath = mod.receiptFilePath(home, backend.origin, 'kt-stray-vars')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    assert.equal(receipt.carrier, 'direct')
    assert.equal(receipt.runner, null)
    assert.equal(receipt.runner_session, null)
  })

  test('explicit well-formed Runner selection: receipt records carrier "runner", the exact runner id, and a runner_session that parses back to the exact (repo, session)', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const backend = await makeClaimBackend(t)
    const streams = makeStdioStreams()
    const running = mod.runStdioBridge(
      ['--url', backend.origin],
      { KAOLA_HOME: home, KAOLA_CARRIER: 'runner', KAOLA_RUNNER: 'claude-code', KAOLA_RUNNER_SESSION: 'kw-attach-1', KAOLA_RUNNER_REPO: repo },
      streams.io,
    )
    streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
    streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-runner-selected'))}\n`)
    streams.io.stdin.end()
    await waitForBridge(running)

    const rpcs = parseJsonRpcStdout(streams.stdoutText())
    const claimResult = rpcs.find((r) => r.id === 2)
    assert.ok(claimResult?.result?.lease?.claim_id, `expected a successful claim, got ${JSON.stringify(claimResult)}`)

    const receiptPath = mod.receiptFilePath(home, backend.origin, 'kt-runner-selected')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    assert.equal(receipt.carrier, 'runner')
    assert.equal(receipt.runner, 'claude-code')
    assert.equal(typeof receipt.runner_session, 'string')
    assert.deepEqual(rc.parseRunnerSessionLocator(receipt.runner_session), { repo, session: 'kw-attach-1' })
  })

  test('re-attach: a FRESH bridge process reading the receipt recovers the same (repo, session) locator and the same claim_id, without creating a second Claim', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const backend = await makeClaimBackend(t)

    const first = makeStdioStreams()
    const runningFirst = mod.runStdioBridge(
      ['--url', backend.origin],
      { KAOLA_HOME: home, KAOLA_CARRIER: 'runner', KAOLA_RUNNER: 'opencode', KAOLA_RUNNER_SESSION: 'kw-attach-2', KAOLA_RUNNER_REPO: repo },
      first.io,
    )
    first.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
    first.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-reattach'))}\n`)
    first.io.stdin.end()
    await waitForBridge(runningFirst)
    const firstClaimId = parseJsonRpcStdout(first.stdoutText()).find((r) => r.id === 2)?.result?.lease?.claim_id
    assert.ok(firstClaimId)
    assert.equal(backend.state.claimCreateCount, 1, 'sanity: exactly one server-side claim created so far')

    // A brand-new bridge process (fresh module state), same KAOLA_HOME, reads the persisted
    // receipt directly -- no claim_task call at all -- and must recover the identical locator.
    const receiptPath = mod.receiptFilePath(home, backend.origin, 'kt-reattach')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    const recoveredLocator = rc.parseRunnerSessionLocator(receipt.runner_session)
    assert.deepEqual(recoveredLocator, { repo, session: 'kw-attach-2' })
    assert.equal(receipt.claim_id, firstClaimId)

    // A second bridge process re-claiming the SAME task_id (idempotent replay, e.g. after an
    // Agent restart) must reuse the existing request_id/claim_id rather than minting a new
    // server-side claim.
    const second = makeStdioStreams()
    const runningSecond = mod.runStdioBridge(['--url', backend.origin], { KAOLA_HOME: home }, second.io)
    second.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
    second.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-reattach'))}\n`)
    second.io.stdin.end()
    await waitForBridge(runningSecond)
    const secondClaimId = parseJsonRpcStdout(second.stdoutText()).find((r) => r.id === 2)?.result?.lease?.claim_id
    assert.equal(secondClaimId, firstClaimId, 'replay must reuse the same claim, not mint a second one')
    assert.equal(backend.state.claimCreateCount, 1, 'no second server-side claim must be created on re-attach/replay')
  })
})

describe('Controller retains custody (Issue #34 point E): selecting the Runner carrier changes none of the six tools\' behavior', { concurrency: 1 }, () => {
  test('report_progress / release_task / submit_pr receive identical arguments (plus the existing claim_id auto-attach) whether or not the Runner carrier is selected', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const backend = await makeClaimBackend(t)
    const streams = makeStdioStreams()
    const running = mod.runStdioBridge(
      ['--url', backend.origin],
      { KAOLA_HOME: home, KAOLA_CARRIER: 'runner', KAOLA_RUNNER: 'kimi-cli', KAOLA_RUNNER_SESSION: 'kw-e', KAOLA_RUNNER_REPO: repo },
      streams.io,
    )
    streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
    streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-custody'))}\n`)
    streams.io.stdin.write(`${JSON.stringify(mutationRpc(3, 'report_progress', { task_id: 'kt-custody', note: 'halfway' }))}\n`)
    streams.io.stdin.write(`${JSON.stringify(mutationRpc(4, 'submit_pr', { task_id: 'kt-custody', pr_url: 'https://example.test/pr/1', summary: 'done' }))}\n`)
    streams.io.stdin.end()
    await waitForBridge(running)

    const claimId = backend.state.claimsByRequestId.values().next().value
    assert.ok(claimId)
    assert.deepEqual(backend.state.mutationCalls, [
      { tool: 'report_progress', args: { task_id: 'kt-custody', note: 'halfway', claim_id: claimId } },
      { tool: 'submit_pr', args: { task_id: 'kt-custody', pr_url: 'https://example.test/pr/1', summary: 'done', claim_id: claimId } },
    ])
  })

  test('an advisory (unrecognized) Runner selection still lets the claim succeed and mutation args stay unaffected (no fabricated success, no mutation path through the Runner)', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const backend = await makeClaimBackend(t)
    const streams = makeStdioStreams()
    const running = mod.runStdioBridge(
      ['--url', backend.origin],
      { KAOLA_HOME: home, KAOLA_CARRIER: 'runner', KAOLA_RUNNER: 'unknown-future-cli', KAOLA_RUNNER_SESSION: 'kw-f', KAOLA_RUNNER_REPO: repo },
      streams.io,
    )
    streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
    streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-advisory'))}\n`)
    streams.io.stdin.write(`${JSON.stringify(mutationRpc(3, 'release_task', { task_id: 'kt-advisory' }))}\n`)
    streams.io.stdin.end()
    await waitForBridge(running)

    const rpcs = parseJsonRpcStdout(streams.stdoutText())
    const claimResult = rpcs.find((r) => r.id === 2)
    assert.ok(claimResult?.result?.lease?.claim_id, 'an advisory runner selection must not block or fabricate the underlying claim result')
    assert.equal(backend.state.mutationCalls.length, 1)
    assert.equal(backend.state.mutationCalls[0].tool, 'release_task')
  })
})

describe('Secret scan under the Runner carrier (Issue #34 point H)', { concurrency: 1 }, () => {
  test('a full claim cycle under an explicit Runner selection never leaks the forge token, an Authorization-shaped value, or the device private key into KAOLA_HOME, stderr, or the forwarded-env projection', async (t) => {
    const home = tmpKaolaHome(t)
    const repo = tmpRepoDir(t)
    const backend = await makeClaimBackend(t)
    const streams = makeStdioStreams()

    // Deliberately shaped like a real caller environment: it includes forward-pattern-matching
    // keys (as an ambient shell might) so the projection has something non-trivial to filter,
    // none of which may ever come to hold forge-token-shaped material.
    const bridgeEnv = {
      KAOLA_HOME: home,
      KAOLA_CARRIER: 'runner',
      KAOLA_RUNNER: 'cursor-cli',
      KAOLA_RUNNER_SESSION: 'kw-secret-scan',
      KAOLA_RUNNER_REPO: repo,
      CLAUDE_MODEL: 'sonnet',
      CURSOR_MODE: 'agent',
    }
    const envSnapshot = { ...bridgeEnv }

    const running = mod.runStdioBridge(['--url', backend.origin], bridgeEnv, streams.io)
    streams.io.stdin.write(`${JSON.stringify(initializeRpc(1))}\n`)
    streams.io.stdin.write(`${JSON.stringify(claimRpc(2, 'kt-secret-scan'))}\n`)
    streams.io.stdin.write(`${JSON.stringify(mutationRpc(3, 'report_progress', { task_id: 'kt-secret-scan', note: 'ok' }))}\n`)
    streams.io.stdin.write(`${JSON.stringify(mutationRpc(4, 'submit_pr', { task_id: 'kt-secret-scan', pr_url: 'https://example.test/pr/9', summary: 'done' }))}\n`)
    streams.io.stdin.end()
    await waitForBridge(running)

    // Nothing must have mutated the caller-supplied env in place (e.g. by stashing a secret
    // under one of the forward-pattern keys for a later Runner start).
    assert.deepEqual(bridgeEnv, envSnapshot)

    // device.json is the existing, already-accepted on-disk store for the device private key
    // (see ensureDeviceIdentity / main.test.ts); excluded from the private-key sweep on purpose,
    // consistent with claim-receipt.test.ts's own secret-scan convention.
    const devicePath = join(home, 'device.json')
    const device = JSON.parse(readFileSyncSecrets(devicePath, 'utf8'))
    const privateKey = device.privateKeyPkcs8
    const nonKeySecrets = [FORGE_TOKEN, AUTH_HEADER_CANARY]
    const secrets = [...nonKeySecrets, privateKey]

    for (const path of walkFiles(home)) {
      if (path === devicePath) {
        assertNoSecrets(readFileSyncSecrets(path, 'utf8'), nonKeySecrets, path)
        continue
      }
      assertNoSecrets(readFileSyncSecrets(path, 'utf8'), secrets, path)
    }
    assertNoSecrets(streams.stderrText(), secrets, 'stderr')

    // The projection of what a Runner `start` would forward must never carry the forge token,
    // the Authorization-shaped canary, or the private key under any forward-pattern key.
    const forwarded = rc.runnerForwardedEnv(bridgeEnv)
    for (const [key, value] of Object.entries(forwarded)) {
      assertNoSecrets(value, secrets, `runnerForwardedEnv key "${key}"`)
    }
    assertNoSecrets(JSON.stringify(forwarded), secrets, 'runnerForwardedEnv() as a whole')
  })
})
