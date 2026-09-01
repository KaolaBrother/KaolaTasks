// Issue #48 — user-callable kaola-mcp trust CLI + launcher (package bin).
// Independent acceptance suite; test custody only, no production code here.
//
// Contract source: docs/DESIGN.md §16 + §16.7 (DESIGN freeze in this worktree).
// Oracle is the real package bin child (`apps/mcp/bin/kaola-mcp.mjs`), not
// exportMcpTrustEnv / in-process runStdioBridge. Ephemeral PKI only; no real
// deployment identifiers.

import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync, sign as cryptoSign, X509Certificate } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const BIN_PATH = join(PKG_DIR, 'bin', 'kaola-mcp.mjs')
const PKG_JSON_PATH = join(PKG_DIR, 'package.json')
const MCP_EXAMPLE_PATH = join(PKG_DIR, 'examples', 'mcp.json')
const SRC_DIR = HERE

const PRIVATE_KEY_MARKER = /BEGIN [A-Z0-9 ]*PRIVATE KEY/
const CERT_BEGIN = '-----BEGIN CERTIFICATE-----'
const SIX_MCP_TOOLS = [
  'list_tasks',
  'get_task_brief',
  'claim_task',
  'report_progress',
  'release_task',
  'submit_pr',
]

let fixtures

before(() => {
  fixtures = mintEphemeralPki()
})

function tmpDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tmpKaolaHome(t) {
  return tmpDir(t, 'kaola-trust-cli-home-')
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

function mintLeafSignedBy(dir, ca, { cn, san }, prefix) {
  const stem = prefix ?? 'leaf'
  const keyPath = join(dir, `${stem}.key`)
  const csrPath = join(dir, `${stem}.csr`)
  const pemPath = join(dir, `${stem}.pem`)
  const cnfPath = join(dir, `${stem}.cnf`)
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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-trust-cli-pki-'))
  const ca = mintRootCa(dir, 'Kaola CLI Fixture Root CA')
  const otherCa = mintRootCa(dir, 'Kaola CLI Other Root CA')
  const leaf = mintLeafSignedBy(dir, ca, { cn: '127.0.0.1', san: 'IP:127.0.0.1' }, 'leaf-a')
  const otherLeaf = mintLeafSignedBy(dir, otherCa, { cn: '127.0.0.1', san: 'IP:127.0.0.1' }, 'leaf-b')
  return { dir, ca, otherCa, leaf, otherLeaf }
}

function fingerprintHex(opensslColonFingerprint) {
  return opensslColonFingerprint.replace(/[:\s]/g, '').toLowerCase()
}

function trustDir(home) {
  return join(home, 'trust')
}

function trustPemPath(home) {
  return join(trustDir(home), 'root-ca.pem')
}

function trustStatePath(home) {
  return join(trustDir(home), 'state.json')
}

function unixMode(path) {
  return statSync(path).mode & 0o777
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

function hostNeutralForbiddenHits(text, home) {
  const hits = []
  if (text.includes(CERT_BEGIN)) hits.push('pem-body')
  if (PRIVATE_KEY_MARKER.test(text)) hits.push('private-key')
  const host = hostname()
  if (host && text.includes(host)) hits.push('hostname')
  if (home && text.includes(home)) hits.push('kaolaHome-absolute-path')
  if (/(^|["\s])\/(?:Users|home|tmp|etc|var)\b/m.test(text) || /[A-Za-z]:\\/.test(text)) {
    hits.push('absolute-path-shaped')
  }
  return hits
}

function readState(home) {
  const path = trustStatePath(home)
  assert.equal(existsSync(path), true, `state.json must exist at ${path}`)
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  return { raw, parsed, path }
}

function assertHostNeutralState(home, { fingerprint, kind, publicKeySpki } = {}) {
  const { raw, parsed } = readState(home)
  const hits = hostNeutralForbiddenHits(raw, home)
  assert.deepEqual(hits, [], `state.json must be host-neutral; leaked ${hits.join(', ')}: ${raw}`)
  assert.equal(parsed.v, 1)
  assert.equal(parsed.alg, 'sha256')
  assert.equal(typeof parsed.fingerprintSha256, 'string')
  assert.match(parsed.fingerprintSha256, /^[0-9a-f]{64}$/)
  if (fingerprint) {
    assert.equal(parsed.fingerprintSha256, fingerprintHex(fingerprint))
  }
  if (kind) {
    assert.equal(parsed.kind, kind)
  }
  if (publicKeySpki) {
    assert.equal(parsed.publicKeySpki, publicKeySpki)
  }
}

function assertInstallLayout(home, fingerprint) {
  const dir = trustDir(home)
  const pem = trustPemPath(home)
  const state = trustStatePath(home)
  assert.equal(existsSync(dir), true, 'install must create $KAOLA_HOME/trust/')
  assert.equal(existsSync(pem), true, 'install must write root-ca.pem')
  assert.equal(existsSync(state), true, 'install must write state.json')
  if (process.platform !== 'win32') {
    assert.equal(unixMode(dir), 0o700, 'trust dir mode must be 0700')
    assert.equal(unixMode(pem), 0o600, 'root-ca.pem mode must be 0600')
    assert.equal(unixMode(state), 0o600, 'state.json mode must be 0600')
  }
  const onDisk = readFileSync(pem, 'utf8')
  assert.match(onDisk, /BEGIN CERTIFICATE/)
  assert.equal(PRIVATE_KEY_MARKER.test(onDisk), false)
  const beginCount = onDisk.split(CERT_BEGIN).length - 1
  assert.equal(beginCount, 1, 'installed PEM must be exactly one CERTIFICATE')
  assert.equal(opensslFingerprintSha256(pem).replace(/[:\s]/g, '').toLowerCase(), fingerprintHex(fingerprint))
  assertHostNeutralState(home, { fingerprint })
}

function assertNotInstalled(home, label) {
  const pem = trustPemPath(home)
  const state = trustStatePath(home)
  assert.equal(existsSync(pem), false, `${label}: must not leave root-ca.pem`)
  assert.equal(existsSync(state), false, `${label}: must not leave state.json`)
}

function parseStatusReady(result) {
  for (const text of [result.stdout, result.stderr]) {
    for (const line of String(text).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && typeof parsed.ready === 'boolean') return parsed.ready
      } catch {
        // keep scanning
      }
    }
  }
  const blob = `${result.stdout}\n${result.stderr}`
  if (/\bready\s*[:=]\s*true\b/i.test(blob)) return true
  if (/\bready\s*[:=]\s*false\b/i.test(blob)) return false
  if (/\bnot[- ]ready\b/i.test(blob)) return false
  return null
}

function launchEnv(home, extra = {}) {
  const env = { ...process.env, KAOLA_HOME: home, ...extra }
  if (!Object.hasOwn(extra, 'NODE_EXTRA_CA_CERTS')) delete env.NODE_EXTRA_CA_CERTS
  if (!Object.hasOwn(extra, 'NODE_TLS_REJECT_UNAUTHORIZED')) delete env.NODE_TLS_REJECT_UNAUTHORIZED
  return env
}

function runBin(args, { env, input = '', timeoutMs = 12000 } = {}) {
  assert.equal(existsSync(BIN_PATH), true, `package bin must exist at ${BIN_PATH}`)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdin.write(input)
    child.stdin.end()
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, timeoutMs)
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut: signal === 'SIGKILL' })
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout, stderr, error, timedOut: false })
    })
  })
}

function initializeRpc(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'trust-cli-test', version: '0' },
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

function rpcInput(rpcs) {
  return rpcs.map((rpc) => `${JSON.stringify(rpc)}\n`).join('')
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

function jsonRpcSuccess(stdout) {
  return parseJsonRpcStdout(stdout).some((rpc) => rpc.result != null && rpc.error == null)
}

function collectErrorText(result) {
  return `${result.stderr || ''}\n${result.stdout || ''}\n${result.error ? String(result.error) : ''}`
}

function assertStrictTlsNotDisabled(result, label) {
  const blob = collectErrorText(result)
  assert.equal(
    /NODE_TLS_REJECT_UNAUTHORIZED[=:]['"]?0/.test(blob),
    false,
    `${label}: must not disable TLS via NODE_TLS_REJECT_UNAUTHORIZED=0`,
  )
  assert.equal(
    /rejectUnauthorized["'\s:]*false/.test(blob),
    false,
    `${label}: must not log rejectUnauthorized: false`,
  )
}

function assertFailClosedLaunch(result, mock, label) {
  assert.notEqual(result.code, 0, `${label}: launcher must fail closed (non-zero)`)
  assert.equal(jsonRpcSuccess(result.stdout), false, `${label}: must not yield JSON-RPC success`)
  assert.equal(mock.httpRequests(), 0, `${label}: must not start the bridge (no HTTP to origin)`)
  assertStrictTlsNotDisabled(result, label)
}

function sourceOf(path) {
  assert.equal(existsSync(path), true, `${path} must exist`)
  return readFileSync(path, 'utf8')
}

function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '\n').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function walkSrcFiles(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue
      out.push(...walkSrcFiles(path))
      continue
    }
    if (/\.(ts|js|mjs)$/.test(ent.name) && !ent.name.endsWith('.test.ts')) out.push(path)
  }
  return out
}

function writeManifest(dir, pem, { fingerprint, signature, publicKeySpki, truncated } = {}) {
  const cert = new X509Certificate(pem)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki =
    publicKeySpki ?? Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64')
  const sig = signature ?? cryptoSign(null, cert.raw, privateKey).toString('base64')
  const body = {
    v: 1,
    fingerprintSha256: fingerprint ?? fingerprintHex(cert.fingerprint256),
    signature: sig,
    publicKeySpki: spki,
  }
  const path = join(dir, 'trust-manifest.json')
  if (truncated) {
    writeFileSync(path, `${JSON.stringify(body).slice(0, 24)}\n`)
  } else {
    writeFileSync(path, `${JSON.stringify(body)}\n`)
  }
  return { path, body }
}

function startHttpsMcp(t, tls, handler) {
  return new Promise((resolve) => {
    let httpRequests = 0
    const server = createHttpsServer(
      { cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' },
      (req, res) => {
        httpRequests += 1
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
      resolve({
        server,
        origin: `https://127.0.0.1:${addr.port}`,
        httpRequests: () => httpRequests,
      })
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
      res.setHeader('mcp-session-id', 'trust-cli-session')
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

async function launchUrl(home, origin, extraEnv = {}) {
  return runBin(['--url', origin], {
    env: launchEnv(home, extraEnv),
    input: rpcInput([initializeRpc(1), listTasksRpc(2)]),
  })
}

async function trustStatus(home) {
  return runBin(['trust', 'status'], { env: launchEnv(home) })
}

describe('package bin is the user-callable trust CLI (not a new MCP tool)', () => {
  test('@kaola/mcp bin is still kaola-mcp and trust install/status/uninstall/system-plan are callable', async (t) => {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8'))
    assert.equal(pkg.name, '@kaola/mcp')
    const binPath = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['kaola-mcp']
    assert.equal(typeof binPath, 'string')
    assert.match(String(binPath), /kaola-mcp/)
    assert.equal(existsSync(join(PKG_DIR, binPath)), true)

    const home = tmpKaolaHome(t)
    const status = await runBin(['trust', 'status'], { env: launchEnv(home) })
    const uninstall = await runBin(['trust', 'uninstall'], { env: launchEnv(home) })
    const plan = await runBin(['trust', 'system-plan', '--platform', 'darwin'], { env: launchEnv(home) })
    const install = await runBin(
      ['trust', 'install', '--pem', fixtures.ca.pemPath, '--fingerprint', fixtures.ca.fingerprint],
      { env: launchEnv(home) },
    )

    assert.equal(status.error, undefined, 'trust status must spawn the package bin')
    assert.equal(uninstall.error, undefined, 'trust uninstall must spawn the package bin')
    assert.equal(plan.error, undefined, 'trust system-plan must spawn the package bin')
    assert.equal(install.error, undefined, 'trust install must spawn the package bin')
    assert.equal(status.timedOut, false, 'trust status must not hang as the stdio bridge')
    assert.equal(plan.timedOut, false, 'trust system-plan must not hang as the stdio bridge')
    assert.equal(
      install.code,
      0,
      `trust install via package bin must exit 0 on matching fingerprint; stdout=${install.stdout} stderr=${install.stderr}`,
    )
    assertInstallLayout(home, fixtures.ca.fingerprint)
    assert.equal(
      /security add-trusted-cert/.test(`${plan.stdout}\n${plan.stderr}`),
      true,
      `trust system-plan --platform darwin must print operator commands; stdout=${plan.stdout} stderr=${plan.stderr}`,
    )
  })

  test('committed mcp.json stays command+--url only and apps/mcp source does not add trust MCP tools', async (t) => {
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

    const srcFiles = [join(PKG_DIR, 'bin', 'kaola-mcp.mjs'), ...walkSrcFiles(SRC_DIR)]
    const blob = srcFiles.map((path) => stripJsComments(sourceOf(path))).join('\n')
    for (const name of SIX_MCP_TOOLS) {
      assert.match(blob, new RegExp(`['"]${name}['"]`), `existing tool ${name} must remain`)
    }
    assert.equal(
      /\b(?:trust_install|trust_status|trust_uninstall|install_root_ca|installRootCaTool)\b/.test(blob),
      false,
      'must not add MCP tool names for trust onboarding',
    )

    const home = tmpKaolaHome(t)
    const install = await runBin(
      ['trust', 'install', '--pem', fixtures.ca.pemPath, '--fingerprint', fixtures.ca.fingerprint],
      { env: launchEnv(home) },
    )
    assert.equal(
      install.code,
      0,
      'trust remains a package-bin CLI (not an MCP tool); matching install must succeed',
    )
    assertInstallLayout(home, fixtures.ca.fingerprint)
  })
})

describe('trust install --fingerprint', () => {
  test('matching fingerprint writes PEM+state 0700/0600, host-neutral state, and status ready', async (t) => {
    const home = tmpKaolaHome(t)
    const result = await runBin(
      ['trust', 'install', '--pem', fixtures.ca.pemPath, '--fingerprint', fixtures.ca.fingerprint],
      { env: launchEnv(home) },
    )
    assert.equal(result.code, 0, `matching fingerprint install must exit 0; stderr=${result.stderr}`)
    assertInstallLayout(home, fixtures.ca.fingerprint)
    assertNoPrivateKeyUnder(home, [fixtures.ca.key, fixtures.otherCa.key, fixtures.leaf.key])

    const status = await trustStatus(home)
    assert.equal(status.code, 0, `trust status after matching install must exit 0; stderr=${status.stderr}`)
    assert.equal(parseStatusReady(status), true, `trust status must report ready; stdout=${status.stdout}`)
  })

  test('--fingerprint and --manifest are mutually exclusive; exactly one is required with --pem', async (t) => {
    const home = tmpKaolaHome(t)
    const { path: manifestPath } = writeManifest(tmpDir(t, 'kaola-manifest-'), fixtures.ca.pem)

    const both = await runBin(
      [
        'trust',
        'install',
        '--pem',
        fixtures.ca.pemPath,
        '--fingerprint',
        fixtures.ca.fingerprint,
        '--manifest',
        manifestPath,
      ],
      { env: launchEnv(home) },
    )
    assert.notEqual(both.code, 0, 'providing both --fingerprint and --manifest must fail')
    assertNotInstalled(home, 'both flags')

    const neither = await runBin(['trust', 'install', '--pem', fixtures.ca.pemPath], { env: launchEnv(home) })
    assert.notEqual(neither.code, 0, 'install without --fingerprint or --manifest must fail')
    assertNotInstalled(home, 'neither flag')
  })

  test('wrong fingerprint does not install; status not ready; launcher injects no extra CA', async (t) => {
    const home = tmpKaolaHome(t)
    const result = await runBin(
      ['trust', 'install', '--pem', fixtures.ca.pemPath, '--fingerprint', fixtures.otherCa.fingerprint],
      { env: launchEnv(home) },
    )
    assert.notEqual(result.code, 0, 'wrong fingerprint must fail closed')
    assertNotInstalled(home, 'wrong fingerprint')
    assertNoPrivateKeyUnder(home, [fixtures.ca.key])

    const status = await trustStatus(home)
    assert.notEqual(parseStatusReady(status), true, 'status must not be ready after rejected install')

    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )
    const launched = await launchUrl(home, mock.origin)
    assertFailClosedLaunch(launched, mock, 'wrong fingerprint')
  })
})

describe('trust install --manifest', () => {
  test('matching publisher-signature manifest installs and records kind+publicKeySpki', async (t) => {
    const home = tmpKaolaHome(t)
    const { path, body } = writeManifest(tmpDir(t, 'kaola-manifest-ok-'), fixtures.ca.pem)
    const result = await runBin(['trust', 'install', '--pem', fixtures.ca.pemPath, '--manifest', path], {
      env: launchEnv(home),
    })
    assert.equal(result.code, 0, `matching manifest install must exit 0; stderr=${result.stderr}`)
    assertInstallLayout(home, fixtures.ca.fingerprint)
    assertHostNeutralState(home, {
      fingerprint: fixtures.ca.fingerprint,
      kind: 'publisher-signature-manifest',
      publicKeySpki: body.publicKeySpki,
    })
    const status = await trustStatus(home)
    assert.equal(parseStatusReady(status), true)
  })

  test('wrong signature, mismatched manifest fingerprint, and truncated manifest do not install', async (t) => {
    const home = tmpKaolaHome(t)
    const src = tmpDir(t, 'kaola-manifest-bad-')

    const wrongSig = writeManifest(src, fixtures.ca.pem, {
      signature: Buffer.alloc(64, 7).toString('base64'),
    })
    const mismatchFp = writeManifest(src, fixtures.ca.pem, {
      fingerprint: fingerprintHex(fixtures.otherCa.fingerprint),
    })
    const truncated = writeManifest(src, fixtures.ca.pem, { truncated: true })
    writeFileSync(mismatchFp.path.replace(/\.json$/, '-mismatch.json'), JSON.stringify(mismatchFp.body))
    const mismatchPath = join(src, 'mismatch.json')
    writeFileSync(mismatchPath, `${JSON.stringify(mismatchFp.body)}\n`)
    const wrongSigPath = join(src, 'wrong-sig.json')
    writeFileSync(wrongSigPath, `${JSON.stringify(wrongSig.body)}\n`)

    const cases = [
      ['wrong-signature', wrongSigPath],
      ['mismatched-fingerprint', mismatchPath],
      ['truncated', truncated.path],
    ]
    for (const [label, manifestPath] of cases) {
      const result = await runBin(
        ['trust', 'install', '--pem', fixtures.ca.pemPath, '--manifest', manifestPath],
        { env: launchEnv(home) },
      )
      assert.notEqual(result.code, 0, `${label} must not install; stderr=${result.stderr}`)
      assertNotInstalled(home, label)
    }
  })
})

describe('inconsistent on-disk pair fail-closed', { concurrency: 1 }, () => {
  test('replacing on-disk PEM with another CA makes status not ready and kaola-mcp --url fail closed', async (t) => {
    const home = tmpKaolaHome(t)
    const installed = await runBin(
      ['trust', 'install', '--pem', fixtures.ca.pemPath, '--fingerprint', fixtures.ca.fingerprint],
      { env: launchEnv(home) },
    )
    assert.equal(installed.code, 0, 'setup install must succeed before replacement')
    assertInstallLayout(home, fixtures.ca.fingerprint)
    writeFileSync(trustPemPath(home), fixtures.otherCa.pem, { mode: 0o600 })

    const status = await trustStatus(home)
    assert.notEqual(parseStatusReady(status), true, 'replaced PEM must not be ready')

    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )
    const launched = await launchUrl(home, mock.origin)
    assertFailClosedLaunch(launched, mock, 'replaced PEM')
  })

  test('missing state, missing PEM, or chmod violating 0600/0700 fail closed on status and launch', async (t) => {
    const home = tmpKaolaHome(t)
    const installed = await runBin(
      ['trust', 'install', '--pem', fixtures.ca.pemPath, '--fingerprint', fixtures.ca.fingerprint],
      { env: launchEnv(home) },
    )
    assert.equal(installed.code, 0)
    assertInstallLayout(home, fixtures.ca.fingerprint)

    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )

    unlinkSync(trustStatePath(home))
    let status = await trustStatus(home)
    assert.notEqual(parseStatusReady(status), true, 'missing state.json is not ready')
    let launched = await launchUrl(home, mock.origin)
    assertFailClosedLaunch(launched, mock, 'missing state.json')

    writeFileSync(trustStatePath(home), JSON.stringify({
      v: 1,
      alg: 'sha256',
      fingerprintSha256: fingerprintHex(fixtures.ca.fingerprint),
    }), { mode: 0o600 })
    unlinkSync(trustPemPath(home))
    status = await trustStatus(home)
    assert.notEqual(parseStatusReady(status), true, 'missing PEM is not ready')
    launched = await launchUrl(home, mock.origin)
    assertFailClosedLaunch(launched, mock, 'missing PEM')

    if (process.platform === 'win32') return

    const reinstalled = await runBin(
      ['trust', 'install', '--pem', fixtures.ca.pemPath, '--fingerprint', fixtures.ca.fingerprint],
      { env: launchEnv(home) },
    )
    assert.equal(reinstalled.code, 0)
    chmodSync(trustPemPath(home), 0o644)
    status = await trustStatus(home)
    assert.notEqual(parseStatusReady(status), true, 'PEM 0644 is not ready')
    launched = await launchUrl(home, mock.origin)
    assertFailClosedLaunch(launched, mock, 'PEM 0644')

    chmodSync(trustPemPath(home), 0o600)
    chmodSync(trustStatePath(home), 0o644)
    status = await trustStatus(home)
    assert.notEqual(parseStatusReady(status), true, 'state.json 0644 is not ready')
    launched = await launchUrl(home, mock.origin)
    assertFailClosedLaunch(launched, mock, 'state.json 0644')

    chmodSync(trustStatePath(home), 0o600)
    chmodSync(trustDir(home), 0o755)
    status = await trustStatus(home)
    assert.notEqual(parseStatusReady(status), true, 'trust dir 0755 is not ready')
    launched = await launchUrl(home, mock.origin)
    assertFailClosedLaunch(launched, mock, 'trust dir 0755')
  })
})

describe('uninstall preserves device.json and Claim receipts', () => {
  test('uninstall removes PEM+state, keeps device.json and a Claim receipt; later public launch injects no extra CA', async (t) => {
    const home = tmpKaolaHome(t)
    const devicePath = join(home, 'device.json')
    const deviceBody = JSON.stringify({ v: 1, publicKeySpki: 'test-device-spki', createdAt: '2026-01-01T00:00:00.000Z' })
    writeFileSync(devicePath, deviceBody, { mode: 0o600 })
    const receiptPath = join(home, 'receipts', 'claim-receipt-canary.json')
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 })
    const receiptBody = JSON.stringify({
      v: 1,
      server: 'placeholder',
      task_id: 'task-trust-cli-uninstall',
      request_id: 'req-trust-cli-uninstall',
      claim_id: null,
      repo_identity: null,
      carrier: 'workflow',
      runner: null,
      runner_session: null,
    })
    writeFileSync(receiptPath, receiptBody, { mode: 0o600 })

    const installed = await runBin(
      ['trust', 'install', '--pem', fixtures.ca.pemPath, '--fingerprint', fixtures.ca.fingerprint],
      { env: launchEnv(home) },
    )
    assert.equal(installed.code, 0)
    assertInstallLayout(home, fixtures.ca.fingerprint)

    const removed = await runBin(['trust', 'uninstall'], { env: launchEnv(home) })
    assert.equal(removed.code, 0, `trust uninstall must exit 0; stderr=${removed.stderr}`)
    assertNotInstalled(home, 'after uninstall')
    assert.equal(existsSync(devicePath), true, 'uninstall must not delete device.json')
    assert.equal(readFileSync(devicePath, 'utf8'), deviceBody)
    assert.equal(existsSync(receiptPath), true, 'uninstall must not delete Claim receipts')
    assert.equal(readFileSync(receiptPath, 'utf8'), receiptBody)

    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )
    const launched = await launchUrl(home, mock.origin)
    assert.equal(jsonRpcSuccess(launched.stdout), false, 'public launch after uninstall must not inject extra CA')
    assert.equal(
      jsonRpcSuccess(launched.stdout),
      false,
    )
    assert.notEqual(
      launched.code === 0 && jsonRpcSuccess(launched.stdout),
      true,
      'uninstalled extra CA must not be a success path',
    )
  })
})

describe('launcher public vs private CA (real bin child)', { concurrency: 1 }, () => {
  test('public mode: caller NODE_EXTRA_CA_CERTS fail-closed; clean home without it does not write extra CA', async (t) => {
    const home = tmpKaolaHome(t)
    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )

    const withCallerCa = await launchUrl(home, mock.origin, {
      NODE_EXTRA_CA_CERTS: fixtures.ca.pemPath,
    })
    assertFailClosedLaunch(withCallerCa, mock, 'public mode unexpected extra CA')

    const cleanHome = tmpKaolaHome(t)
    const beforeFiles = new Set(walkFiles(cleanHome))
    const clean = await launchUrl(cleanHome, mock.origin)
    assert.equal(jsonRpcSuccess(clean.stdout), false, 'clean public launch must not trust the private leaf')
    for (const path of walkFiles(cleanHome)) {
      const text = readFileSync(path, 'utf8')
      if (beforeFiles.has(path) && path.endsWith('device.json')) continue
      assert.equal(text.includes(CERT_BEGIN), false, `clean-home launch must not write extra CA PEM at ${path}`)
    }
    assert.equal(existsSync(trustPemPath(cleanHome)), false)
    assert.equal(existsSync(trustStatePath(cleanHome)), false)
  })

  test('private-CA success: CLI install then real bin --url with parent env not setting NODE_EXTRA_CA_CERTS', async (t) => {
    const home = tmpKaolaHome(t)
    const installed = await runBin(
      ['trust', 'install', '--pem', fixtures.ca.pemPath, '--fingerprint', fixtures.ca.fingerprint],
      { env: launchEnv(home) },
    )
    assert.equal(installed.code, 0, 'matching fingerprint must install before the HTTPS success path')
    assertInstallLayout(home, fixtures.ca.fingerprint)
    assert.equal(
      process.env.NODE_EXTRA_CA_CERTS == null || process.env.NODE_EXTRA_CA_CERTS === '',
      true,
      'parent test process must not rely on NODE_EXTRA_CA_CERTS as the trust source',
    )

    const mock = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )
    const launched = await launchUrl(home, mock.origin)
    assertStrictTlsNotDisabled(launched, 'private-CA success')
    assert.equal(
      jsonRpcSuccess(launched.stdout),
      true,
      `after CLI install, bin child initialize/list_tasks must succeed with TLS verification on; stdout=${launched.stdout} stderr=${launched.stderr}`,
    )
    assert.equal(launched.code, 0, `bin child must exit 0 after successful private-CA TLS; stderr=${launched.stderr}`)
    const rpcs = parseJsonRpcStdout(launched.stdout)
    const init = rpcs.find((rpc) => rpc.id === 1)
    assert.equal(init?.result?.serverInfo?.name, 'kaola-tasks')
    const listed = rpcs.find((rpc) => rpc.id === 2)
    assert.ok(listed?.result, 'list_tasks must succeed over verified TLS')
    assert.ok(mock.httpRequests() >= 1, 'success path must actually reach the HTTPS MCP fixture')
  })

  test('rotation: install A then B atomically; new child talks to B; leftover A extra-CA is not the success path', async (t) => {
    const home = tmpKaolaHome(t)
    const first = await runBin(
      ['trust', 'install', '--pem', fixtures.ca.pemPath, '--fingerprint', fixtures.ca.fingerprint],
      { env: launchEnv(home) },
    )
    assert.equal(first.code, 0)
    assertInstallLayout(home, fixtures.ca.fingerprint)
    const leftoverA = join(tmpDir(t, 'kaola-leftover-a-'), 'old-root.pem')
    writeFileSync(leftoverA, fixtures.ca.pem, { mode: 0o600 })

    const second = await runBin(
      ['trust', 'install', '--pem', fixtures.otherCa.pemPath, '--fingerprint', fixtures.otherCa.fingerprint],
      { env: launchEnv(home) },
    )
    assert.equal(second.code, 0, `rotation install of CA B must exit 0; stderr=${second.stderr}`)
    assertInstallLayout(home, fixtures.otherCa.fingerprint)
    assert.equal(
      fingerprintHex(opensslFingerprintSha256(trustPemPath(home))),
      fingerprintHex(fixtures.otherCa.fingerprint),
      'on-disk PEM must be atomically replaced with CA B',
    )

    const serverB = await startHttpsMcp(
      t,
      { cert: fixtures.otherLeaf.pem, key: fixtures.otherLeaf.key },
      privateCaMcpHandler(),
    )
    const serverA = await startHttpsMcp(
      t,
      { cert: fixtures.leaf.pem, key: fixtures.leaf.key },
      privateCaMcpHandler(),
    )

    const toB = await launchUrl(home, serverB.origin)
    assert.equal(
      jsonRpcSuccess(toB.stdout),
      true,
      `after rotation, bin child must talk to the B-signed server; stdout=${toB.stdout} stderr=${toB.stderr}`,
    )

    const leftoverAgainstA = await launchUrl(home, serverA.origin, { NODE_EXTRA_CA_CERTS: leftoverA })
    assert.equal(
      jsonRpcSuccess(leftoverAgainstA.stdout),
      false,
      'leftover NODE_EXTRA_CA_CERTS pointing at CA A must not be the success path against A',
    )
    assert.notEqual(leftoverAgainstA.code === 0 && jsonRpcSuccess(leftoverAgainstA.stdout), true)
  })
})

describe('trust system-plan prints operator commands and never spawns them', () => {
  test('darwin/win32/debian/fedora command text; Linux requires explicit platform; CLI path does not spawn those tools', async (t) => {
    const home = tmpKaolaHome(t)
    const platforms = {
      darwin: /security add-trusted-cert/,
      win32: /certutil -addstore Root/,
      'linux-debian': /update-ca-certificates/,
      'linux-fedora': /trust anchor/,
    }

    for (const [platform, pattern] of Object.entries(platforms)) {
      const result = await runBin(['trust', 'system-plan', '--platform', platform], { env: launchEnv(home) })
      assert.equal(result.code, 0, `system-plan --platform ${platform} must exit 0; stderr=${result.stderr}`)
      const blob = `${result.stdout}\n${result.stderr}`
      assert.match(blob, pattern, `system-plan ${platform} must print the operator command`)
      if (platform === 'linux-debian') {
        assert.equal(/trust anchor/.test(blob), false, 'Debian plan must not mix Fedora trust anchor')
      }
      if (platform === 'linux-fedora') {
        assert.equal(
          /update-ca-certificates/.test(blob),
          false,
          'Fedora plan must not mix Debian update-ca-certificates',
        )
      }
    }

    const omitted = await runBin(['trust', 'system-plan'], { env: launchEnv(home) })
    const omittedBlob = `${omitted.stdout}\n${omitted.stderr}`
    if (process.platform === 'linux') {
      assert.notEqual(omitted.code, 0, 'Linux system-plan without --platform must fail rather than mix distros')
      assert.equal(
        /update-ca-certificates/.test(omittedBlob) && /trust anchor/.test(omittedBlob),
        false,
        'Linux without --platform must not print mixed Debian+Fedora commands',
      )
    } else if (process.platform === 'darwin') {
      assert.equal(omitted.code, 0)
      assert.match(omittedBlob, /security add-trusted-cert/)
    } else if (process.platform === 'win32') {
      assert.equal(omitted.code, 0)
      assert.match(omittedBlob, /certutil -addstore Root/)
    }

    const srcFiles = [join(PKG_DIR, 'bin', 'kaola-mcp.mjs'), ...walkSrcFiles(SRC_DIR)]
    for (const path of srcFiles) {
      const code = stripJsComments(sourceOf(path))
      assert.equal(
        /(?:spawn|exec|execFile|execSync|spawnSync|fork)\s*\([^)]*(?:security|certutil|update-ca-certificates|trust\s+anchor)/.test(
          code,
        ),
        false,
        `${path} must not spawn system/browser trust-elevation tools`,
      )
    }
  })
})
