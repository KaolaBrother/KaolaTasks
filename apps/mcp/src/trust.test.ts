// Issue #48 — MCP installation and certificate-trust onboarding.
// Independent acceptance suite; test custody only, no production code here.
//
// Contract source: docs/DESIGN.md §16 + §7 TLS / NODE_EXTRA_CA_CERTS sentences, and
// README.md「安装与证书信任」. This suite pins library seams (verify/install/export and
// in-process runStdioBridge). Package-bin CLI, `$KAOLA_HOME/trust/` layout, and state.json
// are frozen in DESIGN §16.7 and exercised by trust-cli.test.ts. When an install API
// returns a PEM path, assertions use that return value rather than an invented relative
// path.
//
// Production seams this suite imports (missing export = RED):
//   apps/mcp/src/trust.ts:
//     verifyRootCaPem, installRootCa, statusRootCa, exportMcpTrustEnv,
//     uninstallRootCa, systemTrustElevationPlan
//   apps/mcp/src/main.ts: runStdioBridge (HTTPS path with strict TLS)
//
// Untracked leftover apps/mcp/src/trust.ts is NOT the oracle. Fail-closed verify/install
// tests may already pass against it; HTTPS wiring through runStdioBridge must still fail
// the overall run until production applies extra CA without disabling verification.

import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
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
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'

const HERE = dirname(fileURLToPath(import.meta.url))
const TRUST_PATH = join(HERE, 'trust.ts')
const MAIN_PATH = join(HERE, 'main.ts')
const MCP_EXAMPLE_PATH = join(HERE, '..', 'examples', 'mcp.json')

const PRIVATE_KEY_MARKER = /BEGIN [A-Z0-9 ]*PRIVATE KEY/
const CERT_BEGIN = '-----BEGIN CERTIFICATE-----'

async function loadTrust() {
  try {
    return await import('./trust.ts')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    assert.fail(`apps/mcp/src/trust.ts must export the MCP trust-onboarding seams (got ${code || String(err)})`)
  }
}

async function loadBridge() {
  try {
    return await import('./main.ts')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    assert.fail(`apps/mcp/src/main.ts must export the stdio bridge (got ${code || String(err)})`)
  }
}

let trust
let bridge
let fixtures

before(async () => {
  trust = await loadTrust()
  bridge = await loadBridge()
  fixtures = mintEphemeralPki()
})

function tmpDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tmpKaolaHome(t) {
  return tmpDir(t, 'kaola-trust-home-')
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

function openssl(args, cwd) {
  return execFileSync('openssl', args, { encoding: 'utf8', cwd })
}

function opensslFingerprintSha256(pemPath) {
  const raw = openssl(['x509', '-in', pemPath, '-noout', '-fingerprint', '-sha256'])
  const value = raw.trim().split('=')[1]
  assert.ok(value, `openssl fingerprint output must contain a value: ${raw}`)
  return value.trim()
}

function mintRootCa(dir, cn) {
  const keyPath = join(dir, `${cn.replace(/\s+/g, '-')}.key`)
  const pemPath = join(dir, `${cn.replace(/\s+/g, '-')}.pem`)
  const cnfPath = join(dir, `${cn.replace(/\s+/g, '-')}.cnf`)
  writeFileSync(
    cnfPath,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '[dn]',
      `CN = ${cn}`,
      '[ext]',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,keyCertSign,cRLSign',
      '',
    ].join('\n'),
  )
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '1',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    pemPath,
    '-config',
    cnfPath,
  ])
  return {
    keyPath,
    pemPath,
    pem: readFileSync(pemPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8'),
    fingerprint: opensslFingerprintSha256(pemPath),
  }
}

function mintLeafSignedBy(dir, ca, { cn, san }) {
  const keyPath = join(dir, 'leaf.key')
  const csrPath = join(dir, 'leaf.csr')
  const pemPath = join(dir, 'leaf.pem')
  const cnfPath = join(dir, 'leaf.cnf')
  writeFileSync(
    cnfPath,
    [
      '[req]',
      'distinguished_name = dn',
      'req_extensions = ext',
      'prompt = no',
      '[dn]',
      `CN = ${cn}`,
      '[ext]',
      'basicConstraints = CA:FALSE',
      'keyUsage = digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = ${san}`,
      '',
    ].join('\n'),
  )
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    csrPath,
    '-config',
    cnfPath,
  ])
  openssl([
    'x509',
    '-req',
    '-in',
    csrPath,
    '-CA',
    ca.pemPath,
    '-CAkey',
    ca.keyPath,
    '-CAcreateserial',
    '-out',
    pemPath,
    '-days',
    '1',
    '-sha256',
    '-extfile',
    cnfPath,
    '-extensions',
    'ext',
  ])
  return {
    keyPath,
    pemPath,
    pem: readFileSync(pemPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8'),
    fingerprint: opensslFingerprintSha256(pemPath),
  }
}

function mintEphemeralPki() {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-trust-pki-'))
  const ca = mintRootCa(dir, 'Kaola Test Fixture Root CA')
  const otherCa = mintRootCa(dir, 'Kaola Other Fixture Root CA')
  const leaf = mintLeafSignedBy(dir, ca, { cn: '127.0.0.1', san: 'IP:127.0.0.1' })
  return { dir, ca, otherCa, leaf }
}

function requireFn(mod, name) {
  assert.equal(typeof mod[name], 'function', `apps/mcp/src/trust.ts must export ${name}()`)
  return mod[name]
}

function assertNotReady(kaolaHome, expectedFingerprint, label) {
  const statusRootCa = requireFn(trust, 'statusRootCa')
  const exportMcpTrustEnv = requireFn(trust, 'exportMcpTrustEnv')
  const status = statusRootCa({ kaolaHome, expectedFingerprint })
  assert.equal(status?.ready, false, `${label}: status must not be ready`)
  const exported = exportMcpTrustEnv({ kaolaHome, expectedFingerprint })
  assert.equal(exported, null, `${label}: must not yield NODE_EXTRA_CA_CERTS`)
  if (exported && typeof exported === 'object') {
    assert.equal(
      Object.hasOwn(exported, 'NODE_EXTRA_CA_CERTS'),
      false,
      `${label}: extra-CA env object must not be returned`,
    )
  }
}

function assertNoPrivateKeyUnder(home, extraBlobs = []) {
  for (const path of walkFiles(home)) {
    const text = readFileSync(path, 'utf8')
    assert.equal(PRIVATE_KEY_MARKER.test(text), false, `${path} must not contain a private key block`)
    for (const blob of extraBlobs) {
      assert.equal(text.includes(blob), false, `${path} must not contain root private-key material`)
    }
  }
}

function fingerprintVariants(opensslColonFingerprint) {
  const hex = opensslColonFingerprint.replace(/[:\s]/g, '')
  return {
    opensslColon: opensslColonFingerprint,
    lowerNoColon: hex.toLowerCase(),
    mixedColon: opensslColonFingerprint
      .split(':')
      .map((part, i) => (i % 2 === 0 ? part.toLowerCase() : part.toUpperCase()))
      .join(':'),
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
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'trust-test', version: '0' },
    },
  }
}

function listTasksRpc(id = 2) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'list_tasks', arguments: {} },
  }
}

function jsonRpcSuccess(stdout) {
  return parseJsonRpcStdout(stdout).some((rpc) => rpc.result != null && rpc.error == null)
}

function collectErrorText(error) {
  const parts = []
  let cur = error
  const seen = new Set()
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    if (typeof cur.message === 'string') parts.push(cur.message)
    if (typeof cur.code === 'string') parts.push(cur.code)
    if (typeof cur.cause === 'object') {
      cur = cur.cause
      continue
    }
    break
  }
  return parts.join('\n')
}

function isCertificateTlsFailure(error, stdout, stderr) {
  const blob = `${collectErrorText(error)}\n${stderr || ''}\n${stdout || ''}`
  return /unable to verif|unable to get local issuer|self[- ]signed|UNABLE_TO_VERIFY|CERT_UNTRUSTED|DEPTH_ZERO|ERR_TLS|certificate|SSL alert|tls/i.test(
    blob,
  )
}

function snapshotTlsEnv(t) {
  const savedReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const savedExtra = process.env.NODE_EXTRA_CA_CERTS
  t.after(() => {
    if (savedReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedReject
    if (savedExtra === undefined) delete process.env.NODE_EXTRA_CA_CERTS
    else process.env.NODE_EXTRA_CA_CERTS = savedExtra
  })
}

function assertStrictTlsEnv(label) {
  const reject = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  assert.notEqual(reject, '0', `${label}: production must not set NODE_TLS_REJECT_UNAUTHORIZED=0`)
  assert.notEqual(String(reject).toLowerCase(), 'false', `${label}: production must not set NODE_TLS_REJECT_UNAUTHORIZED=false`)
}

async function runBridgeRpc({ argv, env, rpcs, ms = 8000 }) {
  assert.equal(typeof bridge.runStdioBridge, 'function', 'apps/mcp/src/main.ts must export runStdioBridge')
  const streams = makeStdioStreams()
  const running = bridge.runStdioBridge(argv, env, streams.io)
  for (const rpc of rpcs) {
    streams.io.stdin.write(`${JSON.stringify(rpc)}\n`)
  }
  streams.io.stdin.end()
  let error = null
  try {
    await waitForBridge(running, ms)
  } catch (err) {
    error = err
  }
  return {
    error,
    stdout: streams.stdoutText(),
    stderr: streams.stderrText(),
  }
}

function startHttpsMcp(t, tls, handler) {
  return new Promise((resolve) => {
    const server = createHttpsServer(
      { cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' },
      (req, res) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          handler(req, res, Buffer.concat(chunks))
        })
      },
    )
    t.after(() => server.close())
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr == null || typeof addr === 'string') throw new Error('expected TCP address')
      resolve({ server, origin: `https://127.0.0.1:${addr.port}` })
    })
  })
}

function privateCaMcpHandler() {
  return (req, res, bodyBuf) => {
    let parsed
    try {
      parsed = JSON.parse(String(bodyBuf))
    } catch {
      parsed = null
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    if (parsed?.method === 'initialize') {
      res.setHeader('mcp-session-id', 'trust-test-session')
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'kaola-tasks' } },
        }),
      )
      return
    }
    if (parsed?.method === 'tools/call' && parsed?.params?.name === 'list_tasks') {
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            structuredContent: { tasks: [] },
            content: [{ type: 'text', text: '{"tasks":[]}' }],
          },
        }),
      )
      return
    }
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: parsed?.id ?? null,
        result: { ok: true },
      }),
    )
  }
}

function sourceOf(path) {
  assert.equal(existsSync(path), true, `${path} must exist`)
  return readFileSync(path, 'utf8')
}

function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '\n').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** CommandLineToArgvW / CRT argv split. Used as the win32 quoting oracle, not a spawn. */
function commandLineToArgvW(commandLine) {
  const args = []
  let current = ''
  let inQuotes = false
  let backslashes = 0
  let started = false
  const flushBackslashes = (beforeQuote) => {
    if (!beforeQuote) {
      current += '\\'.repeat(backslashes)
      backslashes = 0
      return false
    }
    current += '\\'.repeat(Math.floor(backslashes / 2))
    const literalQuote = backslashes % 2 === 1
    backslashes = 0
    return literalQuote
  }
  const pushArg = () => {
    args.push(current)
    current = ''
    started = false
  }
  for (const char of commandLine) {
    if (char === '\\') {
      backslashes += 1
      started = true
      continue
    }
    if (char === '"') {
      const literalQuote = flushBackslashes(true)
      started = true
      if (literalQuote) current += '"'
      else inQuotes = !inQuotes
      continue
    }
    flushBackslashes(false)
    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (started) pushArg()
      continue
    }
    current += char
    started = true
  }
  flushBackslashes(false)
  if (started) pushArg()
  return args
}

describe('verifyRootCaPem fail-closed', () => {
  test('empty PEM, private-key block, not-one CERTIFICATE, unparseable, non-CA, and fingerprint mismatch do not verify', () => {
    const verifyRootCaPem = requireFn(trust, 'verifyRootCaPem')
    const fp = fixtures.ca.fingerprint

    const empty = verifyRootCaPem('', fp)
    assert.equal(empty?.ok, false, 'empty PEM must not verify')

    const withKey = verifyRootCaPem(`${fixtures.ca.pem}\n${fixtures.ca.key}`, fp)
    assert.equal(withKey?.ok, false, 'PEM containing PRIVATE KEY must not verify')

    const twoCerts = verifyRootCaPem(`${fixtures.ca.pem}\n${fixtures.otherCa.pem}`, fp)
    assert.equal(twoCerts?.ok, false, 'PEM with more than one CERTIFICATE block must not verify')

    const unparseable = verifyRootCaPem(`${CERT_BEGIN}\nnot-a-certificate\n-----END CERTIFICATE-----\n`, fp)
    assert.equal(unparseable?.ok, false, 'unparseable PEM must not verify')

    const nonCa = verifyRootCaPem(fixtures.leaf.pem, fixtures.leaf.fingerprint)
    assert.equal(nonCa?.ok, false, 'non-CA (basicConstraints CA != true) must not verify')

    const mismatch = verifyRootCaPem(fixtures.ca.pem, fixtures.otherCa.fingerprint)
    assert.equal(mismatch?.ok, false, 'fingerprint mismatch must not verify')
  })

  test('matching openssl SHA-256 fingerprint of a real CA cert verifies, colon/case-insensitive', () => {
    const verifyRootCaPem = requireFn(trust, 'verifyRootCaPem')
    const variants = fingerprintVariants(fixtures.ca.fingerprint)
    for (const [label, value] of Object.entries(variants)) {
      const result = verifyRootCaPem(fixtures.ca.pem, value)
      assert.equal(result?.ok, true, `matching CA fingerprint (${label}) must verify`)
    }
  })
})

describe('install into user-level Kaola home (MCP-only extra CA)', () => {
  test('failed verify does not install, does not export NODE_EXTRA_CA_CERTS, and is not ready', async (t) => {
    const installRootCa = requireFn(trust, 'installRootCa')
    const home = tmpKaolaHome(t)
    const sourceDir = tmpDir(t, 'kaola-trust-src-')
    const badPem = join(sourceDir, 'bad.pem')
    writeFileSync(badPem, `${fixtures.ca.pem}\n${fixtures.ca.key}`)

    const installed = installRootCa({
      kaolaHome: home,
      sourcePemPath: badPem,
      expectedFingerprint: fixtures.ca.fingerprint,
    })
    assert.equal(installed?.ok, false, 'install of PEM that contains a private key must fail')
    assertNotReady(home, fixtures.ca.fingerprint, 'private-key PEM')
    assertNoPrivateKeyUnder(home, [fixtures.ca.key])
  })

  test('matching verify+install writes public root PEM under kaolaHome 0600/0700 and exports absolute extra-CA path', async (t) => {
    const installRootCa = requireFn(trust, 'installRootCa')
    const exportMcpTrustEnv = requireFn(trust, 'exportMcpTrustEnv')
    const statusRootCa = requireFn(trust, 'statusRootCa')
    const home = tmpKaolaHome(t)

    const installed = installRootCa({
      kaolaHome: home,
      sourcePemPath: fixtures.ca.pemPath,
      expectedFingerprint: fixtures.ca.fingerprint,
    })
    assert.equal(installed?.ok, true, 'matching CA fingerprint must install')
    assert.equal(typeof installed.pemPath, 'string')
    assert.equal(isAbsolute(installed.pemPath), true, 'install must return an absolute PEM path')
    assert.equal(installed.pemPath.startsWith(home), true, 'installed PEM must live under the provided kaolaHome')
    assert.equal(existsSync(installed.pemPath), true)
    assert.equal(statSync(installed.pemPath).mode & 0o777, 0o600, 'installed PEM mode must be 0600')
    const pemDir = dirname(installed.pemPath)
    assert.equal(statSync(pemDir).mode & 0o777, 0o700, 'directory containing extra CA PEM must be 0700')

    const onDisk = readFileSync(installed.pemPath, 'utf8')
    assert.match(onDisk, /BEGIN CERTIFICATE/)
    assert.equal(PRIVATE_KEY_MARKER.test(onDisk), false)
    assert.equal(onDisk.includes(fixtures.ca.key), false, 'root private key must never be written under kaolaHome')
    assertNoPrivateKeyUnder(home, [fixtures.ca.key, fixtures.otherCa.key, fixtures.leaf.key])

    const status = statusRootCa({ kaolaHome: home, expectedFingerprint: fixtures.ca.fingerprint })
    assert.equal(status?.ready, true)

    const exported = exportMcpTrustEnv({ kaolaHome: home, expectedFingerprint: fixtures.ca.fingerprint })
    assert.ok(exported && typeof exported === 'object')
    assert.equal(typeof exported.NODE_EXTRA_CA_CERTS, 'string')
    assert.equal(isAbsolute(exported.NODE_EXTRA_CA_CERTS), true)
    assert.equal(exported.NODE_EXTRA_CA_CERTS, installed.pemPath)
    if (typeof installed.nodeExtraCaCerts === 'string') {
      assert.equal(installed.nodeExtraCaCerts, installed.pemPath)
    }
  })

  test('wrong fingerprint, empty PEM, unparseable, non-CA, and multi-cert sources do not install', async (t) => {
    const installRootCa = requireFn(trust, 'installRootCa')
    const home = tmpKaolaHome(t)
    const sourceDir = tmpDir(t, 'kaola-trust-bad-')

    const cases = [
      ['empty', '', fixtures.ca.fingerprint],
      ['unparseable', `${CERT_BEGIN}\nnope\n-----END CERTIFICATE-----\n`, fixtures.ca.fingerprint],
      ['two-certs', `${fixtures.ca.pem}\n${fixtures.otherCa.pem}`, fixtures.ca.fingerprint],
      ['non-ca-leaf', fixtures.leaf.pem, fixtures.leaf.fingerprint],
      ['mismatch', fixtures.ca.pem, fixtures.otherCa.fingerprint],
    ]

    for (const [label, body, fp] of cases) {
      const src = join(sourceDir, `${label}.pem`)
      writeFileSync(src, body)
      const installed = installRootCa({ kaolaHome: home, sourcePemPath: src, expectedFingerprint: fp })
      assert.equal(installed?.ok, false, `${label} must not install`)
      assertNotReady(home, fp, label)
    }
    assertNoPrivateKeyUnder(home, [fixtures.ca.key])
  })
})

describe('replacement fail-closed', () => {
  test('replacing the on-disk PEM with a different cert drops ready/export', async (t) => {
    const installRootCa = requireFn(trust, 'installRootCa')
    const home = tmpKaolaHome(t)
    const installed = installRootCa({
      kaolaHome: home,
      sourcePemPath: fixtures.ca.pemPath,
      expectedFingerprint: fixtures.ca.fingerprint,
    })
    assert.equal(installed?.ok, true)
    writeFileSync(installed.pemPath, fixtures.otherCa.pem, { mode: 0o600 })
    assertNotReady(home, fixtures.ca.fingerprint, 'replaced on-disk PEM')
  })
})

describe('uninstall', () => {
  test('removes extra CA PEM and export without deleting device.json or Claim receipts', async (t) => {
    const installRootCa = requireFn(trust, 'installRootCa')
    const uninstallRootCa = requireFn(trust, 'uninstallRootCa')
    const home = tmpKaolaHome(t)

    const devicePath = join(home, 'device.json')
    const deviceBody = JSON.stringify({ v: 1, publicKeySpki: 'test-device-spki', createdAt: '2026-01-01T00:00:00.000Z' })
    writeFileSync(devicePath, deviceBody, { mode: 0o600 })

    assert.equal(typeof bridge.receiptFilePath, 'function', 'receiptFilePath is required to pin uninstall vs Claim receipts')
    const receiptPath = bridge.receiptFilePath(home, 'https://kaola.example.test', 'task-trust-uninstall')
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 })
    const receiptBody = JSON.stringify({
      v: 1,
      server: 'placeholder',
      task_id: 'task-trust-uninstall',
      request_id: 'req-trust-uninstall',
      claim_id: null,
      repo_identity: null,
      carrier: 'workflow',
      runner: null,
      runner_session: null,
    })
    writeFileSync(receiptPath, receiptBody, { mode: 0o600 })

    const installed = installRootCa({
      kaolaHome: home,
      sourcePemPath: fixtures.ca.pemPath,
      expectedFingerprint: fixtures.ca.fingerprint,
    })
    assert.equal(installed?.ok, true)

    const removed = uninstallRootCa({ kaolaHome: home })
    assert.equal(removed?.removed, true)
    assert.equal(existsSync(installed.pemPath), false, 'uninstall must remove the extra CA PEM')
    assertNotReady(home, fixtures.ca.fingerprint, 'after uninstall')

    assert.equal(existsSync(devicePath), true, 'uninstall must not delete device.json')
    assert.equal(readFileSync(devicePath, 'utf8'), deviceBody)
    assert.equal(existsSync(receiptPath), true, 'uninstall must not delete Claim receipts')
    assert.equal(readFileSync(receiptPath, 'utf8'), receiptBody)
  })
})

describe('system/browser trust elevation is explicit and never silent', () => {
  test('plan API describes operator-run commands per OS and is data, not a spawned side effect', async () => {
    const systemTrustElevationPlan = requireFn(trust, 'systemTrustElevationPlan')
    const pemPath = fixtures.ca.pemPath

    const plans = {
      darwin: systemTrustElevationPlan('darwin', pemPath),
      win32: systemTrustElevationPlan('win32', pemPath),
      debian: systemTrustElevationPlan('linux-debian', pemPath),
      fedora: systemTrustElevationPlan('linux-fedora', pemPath),
    }

    const darwinCommands = (plans.darwin?.commands ?? []).join('\n')
    assert.match(darwinCommands, /security add-trusted-cert/)
    assert.match(
      `${darwinCommands}\n${plans.darwin?.note ?? ''}`,
      /system keychain|System\.keychain|钥匙串/i,
    )

    const winCommands = (plans.win32?.commands ?? []).join('\n')
    assert.match(winCommands, /certutil -addstore Root/)

    const debianCommands = (plans.debian?.commands ?? []).join('\n')
    assert.match(debianCommands, /update-ca-certificates/)
    assert.equal(/trust anchor/.test(debianCommands), false, 'Debian/Ubuntu commands must not mix Fedora trust anchor')

    const fedoraCommands = (plans.fedora?.commands ?? []).join('\n')
    assert.match(fedoraCommands, /trust anchor/)
    assert.equal(
      /update-ca-certificates/.test(fedoraCommands),
      false,
      'Fedora/RHEL commands must not mix Debian update-ca-certificates',
    )

    for (const [label, plan] of Object.entries(plans)) {
      assert.equal(plan?.requiresElevation, true, `${label} elevation must be explicit`)
      assert.ok(Array.isArray(plan.commands) && plan.commands.length > 0, `${label} must list operator-run commands`)
      assert.match(
        String(plan.note),
        /NODE_EXTRA_CA_CERTS is not browser trust/i,
        `${label} notes must state NODE_EXTRA_CA_CERTS is not browser trust`,
      )
    }
  })

  test('win32 quoting: path with spaces is one double-quoted argument, not POSIX single quotes', () => {
    const systemTrustElevationPlan = requireFn(trust, 'systemTrustElevationPlan')
    const pemPath = 'C:\\Program Files\\kaola\\root-ca.pem'
    const plan = systemTrustElevationPlan('win32', pemPath)
    const certutilLine = (plan?.commands ?? []).find((command) => /certutil -addstore Root/.test(command))
    assert.equal(typeof certutilLine, 'string', `win32 plan must include a certutil line; commands=${JSON.stringify(plan?.commands)}`)
    assert.equal(
      /'[^'\n]*Program Files[^'\n]*'/.test(certutilLine),
      false,
      `win32 certutil line must not wrap a spaced path in POSIX single quotes; got ${certutilLine}`,
    )
    assert.match(
      certutilLine,
      /"[^"\n]*Program Files[^"\n]*"/,
      `win32 certutil line must double-quote a path with spaces as one argument; got ${certutilLine}`,
    )
    const argv = commandLineToArgvW(certutilLine)
    const recovered = argv.find((arg) => arg.includes('Program Files'))
    assert.equal(
      typeof recovered,
      'string',
      `CommandLineToArgvW must recover the spaced path as one argument; argv=${JSON.stringify(argv)} line=${certutilLine}`,
    )
    assert.equal(
      recovered.includes(pemPath) || recovered.endsWith(pemPath),
      true,
      `recovered argument must contain the original spaced path; recovered=${recovered}`,
    )
  })

  test('win32 quoting: embedded double-quote is escaped for CommandLineToArgvW, not POSIX single-quoted', () => {
    const systemTrustElevationPlan = requireFn(trust, 'systemTrustElevationPlan')
    const pemPath = 'C:\\dir\\x"y.pem'
    const plan = systemTrustElevationPlan('win32', pemPath)
    const certutilLine = (plan?.commands ?? []).find((command) => /certutil -addstore Root/.test(command))
    assert.equal(typeof certutilLine, 'string', `win32 plan must include a certutil line; commands=${JSON.stringify(plan?.commands)}`)
    assert.equal(
      /'[^'\n]*x"y\.pem'/.test(certutilLine),
      false,
      `win32 certutil line must not POSIX-single-quote a path containing "; got ${certutilLine}`,
    )
    assert.match(
      certutilLine,
      /\\"/,
      `embedded " must be escaped as \\" inside a double-quoted Windows argument; got ${certutilLine}`,
    )
    const argv = commandLineToArgvW(certutilLine)
    const recovered = argv.find((arg) => arg.includes('x"y.pem'))
    assert.equal(
      typeof recovered,
      'string',
      `CommandLineToArgvW must recover the path containing " as one argument; argv=${JSON.stringify(argv)} line=${certutilLine}`,
    )
    assert.equal(
      recovered.includes(pemPath) || recovered.endsWith(pemPath),
      true,
      `recovered argument must contain the original path with an embedded "; recovered=${recovered}`,
    )
  })

  test('trust module source does not spawn security/certutil/update-ca-certificates/trust anchor', () => {
    const src = stripJsComments(sourceOf(TRUST_PATH))
    assert.equal(
      /from ['"]node:child_process['"]|require\(['"](?:node:)?child_process['"]\)/.test(src),
      false,
      'trust module must not import child_process',
    )
    assert.equal(/\b(?:spawn|exec|execFile|execSync|spawnSync|fork)\s*\(/.test(src), false, 'trust module must not spawn processes')
  })
})

describe('no TOFU', () => {
  test('trust module and stdio bridge contain no origin-download-to-trust helper', () => {
    const trustSrc = sourceOf(TRUST_PATH)
    const mainSrc = sourceOf(MAIN_PATH)
    const trustCode = stripJsComments(trustSrc)
    const mainCode = stripJsComments(mainSrc)

    assert.equal(
      /\b(?:fetch|https\.get|http\.get|https\.request|http\.request)\s*\(/.test(trustCode),
      false,
      'trust module must not fetch a CA (install requires a local PEM path + expected fingerprint)',
    )
    assert.equal(
      /\b(?:tofu|trustOnFirstUse|downloadRootCa|fetchCa|downloadCa|installFromOrigin|installFromUrl)\b/i.test(
        `${trustCode}\n${mainCode}`,
      ),
      false,
      'there must be no TOFU / origin-download-to-trust helper',
    )

    const installFromNetwork =
      /installRootCa[\s\S]{0,400}\bfetch\s*\(|\bfetch\s*\([\s\S]{0,400}installRootCa/.test(mainCode) ||
      /NODE_EXTRA_CA_CERTS[\s\S]{0,400}\bfetch\s*\(|\bfetch\s*\([\s\S]{0,400}BEGIN CERTIFICATE/.test(mainCode)
    assert.equal(installFromNetwork, false, 'main.ts must not fetch a CA and then install it')
  })

  test('HTTPS private-CA without prior local PEM+fingerprint does not write a CA into kaolaHome', async (t) => {
    snapshotTlsEnv(t)
    const home = tmpKaolaHome(t)
    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )
    const out = await runBridgeRpc({
      argv: ['--url', mock.origin],
      env: { KAOLA_HOME: home },
      rpcs: [initializeRpc()],
    })
    assert.equal(jsonRpcSuccess(out.stdout), false, 'TOFU path must not yield JSON-RPC success')
    assert.equal(isCertificateTlsFailure(out.error, out.stdout, out.stderr), true, 'missing extra CA must fail TLS')
    for (const path of walkFiles(home)) {
      const text = readFileSync(path, 'utf8')
      assert.equal(text.includes(CERT_BEGIN), false, `${path} must not receive a TOFU-installed CA PEM`)
    }
    assertStrictTlsEnv('no-TOFU HTTPS')
  })
})

describe('HTTPS MCP path (strict TLS)', { concurrency: 1 }, () => {
  test('private-CA success: matching verify+install then initialize/list_tasks over HTTPS with verification still on', async (t) => {
    snapshotTlsEnv(t)
    const installRootCa = requireFn(trust, 'installRootCa')
    const exportMcpTrustEnv = requireFn(trust, 'exportMcpTrustEnv')
    const home = tmpKaolaHome(t)
    const installed = installRootCa({
      kaolaHome: home,
      sourcePemPath: fixtures.ca.pemPath,
      expectedFingerprint: fixtures.ca.fingerprint,
    })
    assert.equal(installed?.ok, true, 'matching CA must install before the HTTPS success path')
    const exported = exportMcpTrustEnv({ kaolaHome: home, expectedFingerprint: fixtures.ca.fingerprint })
    assert.ok(exported?.NODE_EXTRA_CA_CERTS, 'install must yield NODE_EXTRA_CA_CERTS for the MCP process')

    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )
    const out = await runBridgeRpc({
      argv: ['--url', mock.origin],
      env: {
        KAOLA_HOME: home,
        NODE_EXTRA_CA_CERTS: exported.NODE_EXTRA_CA_CERTS,
      },
      rpcs: [initializeRpc(1), listTasksRpc(2)],
    })

    assertStrictTlsEnv('private-CA success')
    assert.equal(
      jsonRpcSuccess(out.stdout),
      true,
      `after verify+install, HTTPS MCP initialize/list_tasks must succeed with default TLS verification still on; stdout=${out.stdout} stderr=${out.stderr} error=${collectErrorText(out.error)}`,
    )
    assert.equal(out.error, null, `bridge must not throw after successful private-CA TLS: ${collectErrorText(out.error)}`)
    const rpcs = parseJsonRpcStdout(out.stdout)
    const init = rpcs.find((rpc) => rpc.id === 1)
    assert.equal(init?.result?.serverInfo?.name, 'kaola-tasks')
  })

  test('missing extra CA: same HTTPS server, fresh kaolaHome, request fails with a certificate/TLS error', async (t) => {
    snapshotTlsEnv(t)
    const home = tmpKaolaHome(t)
    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )
    const out = await runBridgeRpc({
      argv: ['--url', mock.origin],
      env: { KAOLA_HOME: home },
      rpcs: [initializeRpc()],
    })
    assert.equal(jsonRpcSuccess(out.stdout), false, 'missing extra CA must not yield JSON-RPC success')
    assert.equal(
      isCertificateTlsFailure(out.error, out.stdout, out.stderr),
      true,
      `missing extra CA must fail with a certificate/TLS error; stdout=${out.stdout} stderr=${out.stderr} error=${collectErrorText(out.error)}`,
    )
    assertStrictTlsEnv('missing extra CA')
  })

  test('wrong fingerprint: verify/install rejected; HTTPS must not succeed via a disabled verifier', async (t) => {
    snapshotTlsEnv(t)
    const installRootCa = requireFn(trust, 'installRootCa')
    const home = tmpKaolaHome(t)
    const installed = installRootCa({
      kaolaHome: home,
      sourcePemPath: fixtures.ca.pemPath,
      expectedFingerprint: fixtures.otherCa.fingerprint,
    })
    assert.equal(installed?.ok, false, 'wrong fingerprint must reject install')
    assertNotReady(home, fixtures.otherCa.fingerprint, 'wrong fingerprint')

    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )
    const out = await runBridgeRpc({
      argv: ['--url', mock.origin],
      env: { KAOLA_HOME: home },
      rpcs: [initializeRpc()],
    })
    assert.equal(jsonRpcSuccess(out.stdout), false, 'wrong fingerprint must not yield HTTPS JSON-RPC success')
    assert.equal(isCertificateTlsFailure(out.error, out.stdout, out.stderr), true)
    assertStrictTlsEnv('wrong fingerprint')
  })

  test('public-CA / clean home: default bridge does not write extra CA and does not disable TLS verification', async (t) => {
    snapshotTlsEnv(t)
    const home = tmpKaolaHome(t)
    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )
    const beforeFiles = new Set(walkFiles(home))
    await runBridgeRpc({
      argv: ['--url', mock.origin],
      env: { KAOLA_HOME: home },
      rpcs: [initializeRpc()],
    })
    for (const path of walkFiles(home)) {
      const text = readFileSync(path, 'utf8')
      if (beforeFiles.has(path) && path.endsWith('device.json')) continue
      assert.equal(text.includes(CERT_BEGIN), false, `clean-home bridge must not write extra CA PEM at ${path}`)
    }
    assertStrictTlsEnv('public-CA / clean home')
    assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0')
  })

  test('production performMcpRequest/fetch must not pass rejectUnauthorized: false', () => {
    const mainSrc = sourceOf(MAIN_PATH)
    const code = stripJsComments(mainSrc)
    assert.equal(
      /rejectUnauthorized\s*:\s*false/.test(code),
      false,
      'performMcpRequest/fetch must not pass rejectUnauthorized: false',
    )
    assert.equal(
      /NODE_TLS_REJECT_UNAUTHORIZED['"`)\s]*=['"`\s]*0/.test(code),
      false,
      'main.ts must not assign NODE_TLS_REJECT_UNAUTHORIZED=0',
    )
    assert.equal(/--insecure|curl -k/.test(code), false, 'main.ts must not use insecure TLS flags')
  })
})

describe('committed MCP example stays clean', () => {
  test('apps/mcp/examples/mcp.json has no NODE_EXTRA_CA_CERTS, PEM, or fingerprints', () => {
    assert.equal(existsSync(MCP_EXAMPLE_PATH), true, 'apps/mcp/examples/mcp.json must be committed')
    const raw = readFileSync(MCP_EXAMPLE_PATH, 'utf8')
    assert.equal(raw.includes('NODE_EXTRA_CA_CERTS'), false)
    assert.equal(raw.includes(CERT_BEGIN), false)
    assert.equal(PRIVATE_KEY_MARKER.test(raw), false)
    assert.equal(/fingerprint/i.test(raw), false)
    assert.equal(/NODE_TLS_REJECT_UNAUTHORIZED/.test(raw), false)
    const parsed = JSON.parse(raw)
    const server = parsed?.mcpServers?.['kaola-tasks']
    assert.equal(server?.command, 'kaola-mcp')
    assert.ok(Array.isArray(server?.args) && server.args.includes('--url'))
    assert.equal(server?.env, undefined, 'committed example must not include env extra-CA')
  })
})
