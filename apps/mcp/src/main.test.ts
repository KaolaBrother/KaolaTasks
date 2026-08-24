import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, createPrivateKey, verify as cryptoVerify, sign as cryptoSign } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { deviceProofCanonical } from '../../../packages/shared/src/device-proof.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const FORGE_TOKEN = 'gitea-FORGE-TOKEN-must-not-persist-zzq7'
const DEFAULT_ORIGIN = 'http://localhost:31415'
const PENDING_EXPIRES_AT = '2026-08-25T12:00:00.000Z'

function readMcpPackageJson() {
  const path = join(PKG_DIR, 'package.json')
  assert.equal(existsSync(path), true, 'apps/mcp/package.json must exist for @kaola/mcp')
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function loadBridge() {
  try {
    return await import('./main.ts')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    assert.fail(`apps/mcp/src/main.ts must export the stdio bridge (got ${code || String(err)})`)
  }
}

function tmpKaolaHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-home-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function walkFiles(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkFiles(path))
    else out.push(path)
  }
  return out
}

function headerMap(rawHeaders) {
  const map = new Map()
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value == null) continue
    map.set(String(key).toLowerCase(), Array.isArray(value) ? value.join(',') : String(value))
  }
  return map
}

function assertValidDeviceProof(req, bodyBuf, device) {
  const headers = headerMap(req.headers)
  const key = headers.get('x-kaola-key')
  const ts = headers.get('x-kaola-ts')
  const nonce = headers.get('x-kaola-nonce')
  const sigB64 = headers.get('x-kaola-sig')
  assert.ok(key, 'X-Kaola-Key is required')
  assert.ok(ts, 'X-Kaola-Ts is required')
  assert.ok(nonce, 'X-Kaola-Nonce is required')
  assert.ok(sigB64, 'X-Kaola-Sig is required')
  assert.equal(key, device.publicKeySpki)
  assert.match(ts, /^[1-9][0-9]*$/)
  assert.match(nonce, /^[0-9a-f]{32}$/)
  assert.equal(headers.has('authorization'), false, 'stdio bridge must not send Bearer ktk_')

  const pathname = String(req.url ?? '').split('?')[0]
  const canonical = deviceProofCanonical({
    ts,
    nonce,
    method: String(req.method),
    pathname,
    body: bodyBuf,
  })
  const publicKey = createPublicKey({
    key: Buffer.from(device.publicKeySpki, 'base64'),
    type: 'spki',
    format: 'der',
  })
  const ok = cryptoVerify(null, Buffer.from(canonical, 'utf8'), publicKey, Buffer.from(sigB64, 'base64'))
  assert.equal(ok, true, 'X-Kaola-Sig must verify deviceProofCanonical with device.json SPKI')
}

function startMockMcp(t, handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        handler(req, res, Buffer.concat(chunks))
      })
    })
    t.after(() => server.close())
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr == null || typeof addr === 'string') throw new Error('expected TCP address')
      resolve({ server, origin: `http://127.0.0.1:${addr.port}` })
    })
  })
}

function captureConsole(t) {
  const lines = []
  const names = ['log', 'info', 'warn', 'error', 'debug']
  const orig = {}
  for (const name of names) {
    orig[name] = console[name]
    console[name] = (...args) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
  }
  t.after(() => {
    for (const name of names) console[name] = orig[name]
  })
  return lines
}

function assertNoSecretInText(label, text, secrets) {
  for (const secret of secrets) {
    assert.equal(String(text).includes(secret), false, `${label} must not contain secret material`)
  }
}

function hasTokenKey(value) {
  if (value == null || typeof value !== 'object') return false
  if (Object.hasOwn(value, 'token')) return true
  if (Array.isArray(value)) return value.some(hasTokenKey)
  return Object.values(value).some(hasTokenKey)
}

function assertRpcBodyHasNoSession(rpc, sessionId, label) {
  assert.equal(
    JSON.stringify(rpc).includes(sessionId),
    false,
    `${label} JSON-RPC body must not include mcp-session-id (session is HTTP-only)`,
  )
  if (rpc != null && typeof rpc === 'object' && !Array.isArray(rpc)) {
    for (const key of ['sessionId', 'session_id', 'mcp-session-id', 'mcpSessionId']) {
      assert.equal(Object.hasOwn(rpc, key), false, `${label} must not add JSON field ${key}`)
    }
  }
}

function assertKaolaHomeHasNoForgeToken(home) {
  for (const path of walkFiles(home)) {
    assert.equal(readFileSync(path, 'utf8').includes(FORGE_TOKEN), false, `${path} must not persist FORGE_TOKEN`)
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

function stdoutChunkToText(chunk, encoding) {
  if (typeof chunk === 'string') return chunk
  const enc = typeof encoding === 'string' ? encoding : 'utf8'
  return Buffer.from(chunk).toString(enc)
}

/** node:test binary reporter frames are not JSON-RPC and have no trailing newline. */
function isJsonRpcCaptureChunk(text) {
  const trimmed = String(text).trim()
  return trimmed.startsWith('{') && trimmed.includes('"jsonrpc"')
}

function requestSessionHeader(req) {
  return headerMap(req.headers).get('mcp-session-id') ?? ''
}

/**
 * Optional 3rd-arg `io` for runStdioBridge, plus a process.stdin stand-in so today's
 * implementation (which still reads process.stdin) cannot hang the test run.
 */
function attachStdioBridgeIo(t) {
  const stdin = new PassThrough()
  let stdoutText = ''
  let stderrText = ''
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  function appendStdoutCapture(text) {
    if (stdoutText.length > 0 && !stdoutText.endsWith('\n') && !String(text).startsWith('\n')) {
      stdoutText += '\n'
    }
    stdoutText += text
  }

  stdout.on('data', (c) => {
    appendStdoutCapture(String(c))
  })
  stderr.on('data', (c) => {
    stderrText += String(c)
  })

  const stdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: true,
    value: stdin,
  })

  const origStdoutWrite = process.stdout.write
  const origStderrWrite = process.stderr.write
  process.stdout.write = function teeStdout(chunk, encoding, cb) {
    const text = stdoutChunkToText(chunk, encoding)
    if (isJsonRpcCaptureChunk(text)) appendStdoutCapture(text)
    return origStdoutWrite.call(this, chunk, encoding, cb)
  }
  process.stderr.write = function teeStderr(chunk, encoding, cb) {
    stderrText += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return origStderrWrite.call(this, chunk, encoding, cb)
  }

  t.after(() => {
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
    if (stdinDesc != null) Object.defineProperty(process, 'stdin', stdinDesc)
  })

  return {
    io: { stdin, stdout, stderr },
    stdout: () => stdoutText,
    stderr: () => stderrText,
  }
}

async function waitForStdioBridge(running, ms = 8000) {
  let timer
  try {
    await Promise.race([
      running,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `runStdioBridge did not finish within ${ms}ms (accept optional 3rd io { stdin, stdout, stderr } and end stdin)`,
            ),
          )
        }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('@kaola/mcp package', () => {
  test('package.json is @kaola/mcp ESM, Node >=22, bin kaola-mcp', () => {
    const pkg = readMcpPackageJson()
    assert.equal(pkg.name, '@kaola/mcp')
    assert.equal(pkg.private, true)
    assert.equal(pkg.type, 'module')
    assert.equal(pkg.engines?.node, '>=22')
    const binPath = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['kaola-mcp']
    assert.equal(typeof binPath, 'string')
    assert.match(String(binPath), /kaola-mcp/)
    assert.equal(existsSync(join(PKG_DIR, binPath)), true, 'bin kaola-mcp path must exist')
    assert.equal(pkg.dependencies?.['@modelcontextprotocol/sdk'], '1.30.0')
    assert.equal(pkg.dependencies?.['@kaola/shared'], 'workspace:*')
  })

  test('committed mcp.json example is command plus url and contains no secrets', () => {
    const path = join(PKG_DIR, 'examples', 'mcp.json')
    assert.equal(existsSync(path), true, 'apps/mcp/examples/mcp.json must be committed')
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(parsed, {
      mcpServers: {
        'kaola-tasks': {
          command: 'kaola-mcp',
          args: ['--url', 'http://localhost:31415'],
        },
      },
    })
    const raw = readFileSync(path, 'utf8')
    assert.equal(/headers/i.test(raw), false)
    assert.equal(raw.includes('ktk_'), false)
    assert.equal(/KAOLA_AGENT_KEY/.test(raw), false)
    assert.equal(/Authorization/i.test(raw), false)
    assert.equal(raw.includes('gitea-'), false)
    assert.equal(raw.includes('ghp_'), false)
    assert.equal(raw.includes('glpat-'), false)
  })
})

describe('resolveKaolaUrl', () => {
  test('--url wins, then KAOLA_URL, then localhost:31415; trailing slash is stripped', async () => {
    const mod = await loadBridge()
    assert.equal(typeof mod.resolveKaolaUrl, 'function')
    assert.equal(mod.resolveKaolaUrl(['--url', 'http://bridge.example.test:9/'], { KAOLA_URL: 'http://env.example/' }), 'http://bridge.example.test:9')
    assert.equal(mod.resolveKaolaUrl([], { KAOLA_URL: 'http://env.example.test/' }), 'http://env.example.test')
    assert.equal(mod.resolveKaolaUrl([], { KAOLA_URL: '' }), DEFAULT_ORIGIN)
    assert.equal(mod.resolveKaolaUrl([], {}), DEFAULT_ORIGIN)
    assert.equal(mod.resolveKaolaUrl(['node', 'main.ts'], {}), DEFAULT_ORIGIN)
  })
})

describe('ensureDeviceIdentity', () => {
  test('creates ~/.kaola-shaped dir 0700 and device.json 0600 Ed25519 PKCS8+SPKI when missing', async (t) => {
    const home = tmpKaolaHome(t)
    const mod = await loadBridge()
    assert.equal(typeof mod.ensureDeviceIdentity, 'function')
    const device = await mod.ensureDeviceIdentity(home)
    const devicePath = join(home, 'device.json')
    assert.equal(existsSync(devicePath), true)
    assert.equal(statSync(home).mode & 0o777, 0o700)
    assert.equal(statSync(devicePath).mode & 0o777, 0o600)

    const onDisk = JSON.parse(readFileSync(devicePath, 'utf8'))
    assert.equal(onDisk.v, 1)
    assert.equal(typeof onDisk.privateKeyPkcs8, 'string')
    assert.equal(typeof onDisk.publicKeySpki, 'string')
    assert.equal(typeof onDisk.createdAt, 'string')
    assert.equal(device.publicKeySpki, onDisk.publicKeySpki)
    assert.equal(Object.hasOwn(onDisk, 'token'), false)

    const privateKey = createPrivateKey({
      key: Buffer.from(onDisk.privateKeyPkcs8, 'base64'),
      type: 'pkcs8',
      format: 'der',
    })
    const publicKey = createPublicKey({
      key: Buffer.from(onDisk.publicKeySpki, 'base64'),
      type: 'spki',
      format: 'der',
    })
    const msg = Buffer.from('kaola-mcp-key-roundtrip')
    assert.equal(cryptoVerify(null, msg, publicKey, cryptoSign(null, msg, privateKey)), true)

    const again = await mod.ensureDeviceIdentity(home)
    assert.equal(again.publicKeySpki, onDisk.publicKeySpki)
    assert.equal(again.privateKeyPkcs8, onDisk.privateKeyPkcs8)

    for (const path of walkFiles(home)) {
      const text = readFileSync(path, 'utf8')
      assert.equal(text.includes(FORGE_TOKEN), false)
      assert.equal(text.includes('ktk_'), false)
    }
  })
})

describe('forwardMcpRequest', () => {
  test('POSTs to {url}/api/mcp with canonical device proof headers', async (t) => {
    const home = tmpKaolaHome(t)
    const mod = await loadBridge()
    await mod.ensureDeviceIdentity(home)
    const device = JSON.parse(readFileSync(join(home, 'device.json'), 'utf8'))
    const seen = []

    const mock = await startMockMcp(t, (req, res, body) => {
      seen.push({ method: req.method, url: req.url, body })
      assertValidDeviceProof(req, body, device)
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
    })

    const rpc = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }
    const out = await mod.forwardMcpRequest({
      kaolaHome: home,
      url: `${mock.origin}/`,
      body: rpc,
    })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'POST')
    assert.equal(String(seen[0].url).split('?')[0], '/api/mcp')
    assert.equal(out?.jsonrpc, '2.0')
    assert.equal(out?.result?.ok, true)
  })

  test('HTTP 202 authorization_required becomes a JSON-RPC error, never a successful token result', async (t) => {
    const home = tmpKaolaHome(t)
    const logs = captureConsole(t)
    const stderr = new PassThrough()
    const stdout = new PassThrough()
    const stdioChunks = { out: '', err: '' }
    stdout.on('data', (c) => {
      stdioChunks.out += String(c)
    })
    stderr.on('data', (c) => {
      stdioChunks.err += String(c)
    })

    const mod = await loadBridge()
    await mod.ensureDeviceIdentity(home)
    const device = JSON.parse(readFileSync(join(home, 'device.json'), 'utf8'))

    const mock = await startMockMcp(t, (req, res, body) => {
      assertValidDeviceProof(req, body, device)
      res.statusCode = 202
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          error: 'authorization_required',
          pending: true,
          expires_at: PENDING_EXPIRES_AT,
        }),
      )
    })

    const rpc = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'claim_task', arguments: { task_id: 'kt-pending' } },
    }
    const out = await mod.forwardMcpRequest({
      kaolaHome: home,
      url: mock.origin,
      body: rpc,
      stdout,
      stderr,
    })

    assert.equal(out?.jsonrpc, '2.0')
    assert.equal(out?.id, 7)
    assert.equal(out?.result, undefined)
    assert.equal(typeof out?.error, 'object')
    assert.notEqual(out.error, null)
    const message = String(out.error.message ?? '')
    assert.match(message, /authorization_required/)
    assert.match(message, new RegExp(PENDING_EXPIRES_AT.replaceAll('.', '\\.')))
    assert.equal(hasTokenKey(out), false)
    assert.equal(JSON.stringify(out).includes(FORGE_TOKEN), false)

    const privateKey = device.privateKeyPkcs8
    assertNoSecretInText('console', logs.join('\n'), [privateKey, FORGE_TOKEN])
    assertNoSecretInText('stderr', stdioChunks.err, [privateKey, FORGE_TOKEN])
    assertNoSecretInText('stdout', stdioChunks.out, [privateKey, FORGE_TOKEN])
  })

  test('successful claim JSON-RPC may contain token but KAOLA_HOME never stores it', async (t) => {
    const home = tmpKaolaHome(t)
    const logs = captureConsole(t)
    const stderr = new PassThrough()
    const stdout = new PassThrough()
    const stdioChunks = { out: '', err: '' }
    stdout.on('data', (c) => {
      stdioChunks.out += String(c)
    })
    stderr.on('data', (c) => {
      stdioChunks.err += String(c)
    })

    const mod = await loadBridge()
    await mod.ensureDeviceIdentity(home)
    const device = JSON.parse(readFileSync(join(home, 'device.json'), 'utf8'))

    const mock = await startMockMcp(t, (req, res, body) => {
      assertValidDeviceProof(req, body, device)
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          result: {
            task: { id: 'kt-1' },
            token: FORGE_TOKEN,
            lease: { ttl: 86400 },
            clone: { suggested_dir: 'orders' },
          },
        }),
      )
    })

    const out = await mod.forwardMcpRequest({
      kaolaHome: home,
      url: mock.origin,
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'claim_task', arguments: { task_id: 'kt-1' } },
      },
      stdout,
      stderr,
    })

    assert.equal(out?.result?.token, FORGE_TOKEN)

    for (const path of walkFiles(home)) {
      const text = readFileSync(path, 'utf8')
      assert.equal(text.includes(FORGE_TOKEN), false, `${path} must not persist forge token`)
    }

    const privateKey = device.privateKeyPkcs8
    assertNoSecretInText('console', logs.join('\n'), [privateKey, FORGE_TOKEN])
    assertNoSecretInText('stderr', stdioChunks.err, [privateKey, FORGE_TOKEN])
    assertNoSecretInText('stdout', stdioChunks.out, [privateKey])
  })
})

describe('stdio bridge Streamable HTTP session', { concurrency: 1 }, () => {
  test('captures MCP-Session-Id from initialize without putting it on the JSON-RPC body', async (t) => {
    const SESSION_ID = '7e2a9c14-b4d1-4f88-a6c3-kaola-sid-init'
    const home = tmpKaolaHome(t)
    const stderr = new PassThrough()
    let stderrText = ''
    stderr.on('data', (c) => {
      stderrText += String(c)
    })

    const mod = await loadBridge()
    await mod.ensureDeviceIdentity(home)
    const device = JSON.parse(readFileSync(join(home, 'device.json'), 'utf8'))
    const seen = []

    const mock = await startMockMcp(t, (req, res, body) => {
      assertValidDeviceProof(req, body, device)
      const parsed = JSON.parse(body.toString('utf8'))
      seen.push({ rpcMethod: parsed.method, session: requestSessionHeader(req) })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.setHeader('MCP-Session-Id', SESSION_ID)
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-11-25' } }))
    })

    let captured
    const out = await mod.forwardMcpRequest({
      kaolaHome: home,
      url: mock.origin,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      stderr,
      onSessionId: (id) => {
        captured = id
      },
    })

    assert.equal(seen.length, 1)
    assert.equal(seen[0].rpcMethod, 'initialize')
    assert.equal(seen[0].session, '', 'initialize must not invent a session request header')
    assert.equal(captured, SESSION_ID)
    assert.equal(out?.jsonrpc, '2.0')
    assert.equal(out?.result?.protocolVersion, '2025-11-25')
    assertRpcBodyHasNoSession(out, SESSION_ID, 'initialize RPC body')
    assertKaolaHomeHasNoForgeToken(home)
    assert.equal(stderrText.includes(FORGE_TOKEN), false)

    const follow = await mod.forwardMcpRequest({
      kaolaHome: home,
      url: mock.origin,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      stderr,
      sessionId: captured,
    })
    assert.equal(seen.length, 2)
    assert.equal(seen[1].rpcMethod, 'tools/list')
    assert.equal(seen[1].session, SESSION_ID)
    assert.equal(follow?.jsonrpc, '2.0')
    assertRpcBodyHasNoSession(follow, SESSION_ID, 'follow-up RPC body')
  })

  describe('runStdioBridge session replay', { concurrency: 1 }, () => {
    test('replays captured mcp-session-id on the next stdin tools/list', async (t) => {
      const SESSION_ID = 'a1b2c3d4-e5f6-4789-abcd-kaola-sid-replay'
      const home = tmpKaolaHome(t)
      const streams = attachStdioBridgeIo(t)
      const mod = await loadBridge()
      await mod.ensureDeviceIdentity(home)
      const device = JSON.parse(readFileSync(join(home, 'device.json'), 'utf8'))
      const seen = []

      const mock = await startMockMcp(t, (req, res, body) => {
        assertValidDeviceProof(req, body, device)
        const parsed = JSON.parse(body.toString('utf8'))
        const session = requestSessionHeader(req)
        seen.push({ rpcMethod: parsed.method, session })

        if (parsed.method === 'initialize') {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.setHeader('mcp-session-id', SESSION_ID)
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'kaola-tasks' } },
            }),
          )
          return
        }

        if (parsed.method === 'tools/list') {
          if (session !== SESSION_ID) {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                id: null,
              }),
            )
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { tools: [{ name: 'list_tasks' }] } }))
          return
        }

        res.statusCode = 400
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Unknown method' }, id: parsed.id }))
      })

      const initialize = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cursor-test', version: '0' } },
      }
      const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }

      const running = mod.runStdioBridge(['--url', mock.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(`${JSON.stringify(initialize)}\n`)
      streams.io.stdin.write(`${JSON.stringify(toolsList)}\n`)
      streams.io.stdin.end()
      await waitForStdioBridge(running)

      assert.equal(seen.length, 2, `expected initialize then tools/list HTTP POSTs, got ${JSON.stringify(seen)}`)
      assert.equal(seen[0].rpcMethod, 'initialize')
      assert.equal(seen[0].session, '', 'initialize request must omit mcp-session-id')
      assert.equal(seen[1].rpcMethod, 'tools/list')
      assert.equal(seen[1].session, SESSION_ID, 'second POST must replay mcp-session-id from initialize')

      const rpcs = parseJsonRpcStdout(streams.stdout())
      assert.equal(rpcs.length, 2, `expected two JSON-RPC stdout lines, got ${JSON.stringify(rpcs)}`)
      assert.equal(
        rpcs[1]?.error?.code,
        undefined,
        `tools/list stdout must not be the session Bad Request: ${JSON.stringify(rpcs[1])}`,
      )
      assert.notEqual(rpcs[1]?.error?.message, 'Bad Request: No valid session ID provided')
      assert.deepEqual(rpcs[1]?.result, { tools: [{ name: 'list_tasks' }] })
      assertRpcBodyHasNoSession(rpcs[0], SESSION_ID, 'stdout initialize')
      assertRpcBodyHasNoSession(rpcs[1], SESSION_ID, 'stdout tools/list')
      assertKaolaHomeHasNoForgeToken(home)
      assert.equal(streams.stderr().includes(FORGE_TOKEN), false)
    })

    test('omits mcp-session-id on later stdin when initialize response had no such header', async (t) => {
      const home = tmpKaolaHome(t)
      const streams = attachStdioBridgeIo(t)
      const mod = await loadBridge()
      await mod.ensureDeviceIdentity(home)
      const device = JSON.parse(readFileSync(join(home, 'device.json'), 'utf8'))
      const seen = []

      const mock = await startMockMcp(t, (req, res, body) => {
        assertValidDeviceProof(req, body, device)
        const parsed = JSON.parse(body.toString('utf8'))
        seen.push({ rpcMethod: parsed.method, session: requestSessionHeader(req) })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        if (parsed.method === 'initialize') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-11-25' } }))
          return
        }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { tools: [{ name: 'list_tasks' }] } }))
      })

      const running = mod.runStdioBridge(['--url', mock.origin], { KAOLA_HOME: home }, streams.io)
      streams.io.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`,
      )
      streams.io.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
      streams.io.stdin.end()
      await waitForStdioBridge(running)

      assert.equal(seen.length, 2, `expected two POSTs, got ${JSON.stringify(seen)}`)
      assert.equal(seen[0].session, '', 'initialize must omit mcp-session-id')
      assert.equal(seen[1].session, '', 'must not invent mcp-session-id when initialize omitted the header')
      const rpcs = parseJsonRpcStdout(streams.stdout())
      const toolsOut = rpcs.find((rpc) => rpc.id === 2) ?? rpcs[1]
      assert.deepEqual(toolsOut?.result, { tools: [{ name: 'list_tasks' }] })
      assertKaolaHomeHasNoForgeToken(home)
      assert.equal(streams.stderr().includes(FORGE_TOKEN), false)
    })
  })
})
