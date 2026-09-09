import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpsServer } from 'node:https'
import {
  derivePairingKey,
  encodeApprovalTranscript,
  encodePairingTranscript,
  inspectPublicRootPem,
  pairingApprovalProof,
} from '@kaola/shared'
import {
  PAIRING_REQUIRED_EXIT_CODE,
  classifyTlsFailure,
  inspectV2Trust,
  isBootstrapPathAllowed,
  pairingReceiptPath,
  pairingOriginDigest,
  prepareHttpsLauncher,
  recoverInterruptedV2Trust,
  runPairCli,
  verifyPairingApproval,
  v2PreviousTrustDir,
  v2TrustDir,
  writeV2Staging,
  commitV2Staging,
  type PairingHttpRequest,
  type PairingTransport,
} from './pair.ts'
import { readVerifiedExtraCaPem, trustDir, trustRootCaPath, trustStatePath } from './trust.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const VECTOR_PATH = join(HERE, '../../../docs/decisions/0031-pairing-test-vectors.json')
const BIN_PATH = join(HERE, '../bin/kaola-mcp.mjs')
const INSTANCE_ID = '01234567-89ab-4def-8123-456789abcdef'

function tmpHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-pair-home-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function captureIo() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.setEncoding('utf8')
  stderr.setEncoding('utf8')
  stdout.on('data', (chunk) => {
    out += chunk
  })
  stderr.on('data', (chunk) => {
    err += chunk
  })
  return {
    io: { stdout, stderr },
    stdout: () => out,
    stderr: () => err,
  }
}

function unknownIssuer() {
  const err = new Error('unable to get local issuer certificate')
  ;(err as { code?: string }).code = 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
  throw err
}

function mintRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-pair-ca-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const pem = join(dir, 'ca.pem')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-days',
    '365',
    '-nodes',
    '-keyout',
    join(dir, 'ca.key'),
    '-out',
    pem,
    '-subj',
    '/CN=Kaola Pair Client Test Root',
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ])
  const pemText = readFileSync(pem, 'utf8')
  const inspected = inspectPublicRootPem(pemText)
  assert.equal(inspected.ok, true)
  return inspected.ok
    ? { pem: inspected.pem, sha256: inspected.fingerprintSha256 }
    : assert.fail('minted root must inspect')
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

function loadVectors() {
  return JSON.parse(readFileSync(VECTOR_PATH, 'utf8'))
}

function approvalFromReceipt(home, origin, owner = { kind: 'user', user_id: 3 }) {
  const receipt = JSON.parse(readFileSync(pairingReceiptPath(home, origin), 'utf8'))
  const expiresAt = Math.floor(Date.parse(receipt.expires_at) / 1000)
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
  const pairingKey = derivePairingKey(Buffer.from(receipt.secret, 'hex'), transcript)
  const approvedAt = 1_700_000_000
  const approvalTranscript = encodeApprovalTranscript({
    pairingId: receipt.pairing_id,
    instanceId: receipt.instance_id,
    origin: receipt.origin,
    deviceFingerprint: receipt.device_fingerprint,
    rootCaSha256: Buffer.from(receipt.root_sha256, 'hex'),
    ownerKind: owner.kind,
    ownerId: owner.kind === 'user' ? owner.user_id : owner.claimant_id,
    approvedAt,
    expiresAt,
  })
  return {
    payload: {
      v: 1,
      pairing_id: receipt.pairing_id,
      instance_id: receipt.instance_id,
      origin: receipt.origin,
      device_fingerprint: receipt.device_fingerprint,
      root_sha256: receipt.root_sha256,
      owner,
      approved_at: approvedAt,
      expires_at: expiresAt,
    },
    proof: pairingApprovalProof(pairingKey, approvalTranscript).toString('hex'),
    deviceFingerprint: receipt.device_fingerprint,
  }
}

function pairingTransport({ home, origin, root, failWhoami = false, descriptorOrigin }) {
  const pairingId = 'kpr_00112233445566778899aabbccddeeff'
  const serverNonce = '11'.repeat(32)
  const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString()
  const advertisedOrigin = descriptorOrigin ?? origin
  const transport: PairingTransport = {
    async request(input: PairingHttpRequest) {
      const url = new URL(input.url)
      if (input.mode === 'bootstrap') {
        assert.equal(isBootstrapPathAllowed(url.pathname), true, `bootstrap blocked ${url.pathname}`)
        assert.equal(Object.hasOwn(input.headers, 'cookie') || Object.hasOwn(input.headers, 'Cookie'), false)
        assert.equal(Object.hasOwn(input.headers, 'authorization') || Object.hasOwn(input.headers, 'Authorization'), false)
        assert.equal(url.pathname.includes('/api/mcp'), false)
      }
      if (input.mode === 'strict' && (input.extraCaPem == null || input.extraCaPem.length === 0)) {
        unknownIssuer()
      }
      if (url.pathname === '/api/v1/setup' && input.mode === 'strict') {
        return { status: 200, headers: {}, body: '{"setup_complete":true}' }
      }
      if (url.pathname === '/api/v1/device-pairings' && input.method === 'POST') {
        const body = JSON.parse(input.body.toString('utf8'))
        assert.equal(typeof body.client_nonce, 'string')
        return {
          status: 201,
          headers: {},
          body: JSON.stringify({
            pairing_id: pairingId,
            protocol_version: 'kaola-pairing/1',
            instance_id: INSTANCE_ID,
            origin: advertisedOrigin,
            server_nonce: serverNonce,
            root_pem: root.pem,
            root_sha256: root.sha256,
            expires_at: expiresAt,
            device_id: 1,
            device_fingerprint: 'pending',
            status: 'created',
          }),
        }
      }
      if (url.pathname.endsWith('/commit')) {
        return { status: 200, headers: {}, body: JSON.stringify({ status: 'committed', pairing_id: pairingId, expires_at: expiresAt }) }
      }
      if (url.pathname.endsWith('/status')) {
        const approval = approvalFromReceipt(home, origin)
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            status: 'approved',
            pairing_id: pairingId,
            expires_at: expiresAt,
            approval: { payload: approval.payload, proof: approval.proof },
          }),
        }
      }
      if (url.pathname === '/api/v1/agent/whoami') {
        if (failWhoami) return { status: 202, headers: {}, body: JSON.stringify({ error: 'authorization_required' }) }
        const approval = approvalFromReceipt(home, origin)
        assert.equal(input.extraCaPem?.includes('BEGIN CERTIFICATE'), true)
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            device_id: 1,
            fingerprint: approval.deviceFingerprint,
            hostname: 'test',
            status: 'active',
            instance_id: INSTANCE_ID,
            owner: { kind: 'user', user_id: 3 },
          }),
        }
      }
      if (url.pathname.endsWith('/complete')) {
        return { status: 200, headers: {}, body: JSON.stringify({ status: 'consumed', pairing_id: pairingId }) }
      }
      throw new Error(`unexpected ${input.mode} ${input.method} ${url.pathname}`)
    },
  }
  return transport
}

describe('kaola-mcp pair (#63)', { concurrency: false }, () => {
  test('unknown-issuer codes enter bootstrap; hostname/expiry do not', () => {
    for (const code of [
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    ]) {
      assert.equal(classifyTlsFailure({ code }), 'unknown_issuer', code)
    }
    assert.equal(classifyTlsFailure({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'fail_closed')
    assert.equal(classifyTlsFailure({ code: 'CERT_HAS_EXPIRED' }), 'fail_closed')
    assert.equal(classifyTlsFailure({ code: 'CERT_NOT_YET_VALID' }), 'fail_closed')
  })

  test('bootstrap allowlist is only create/commit/status', () => {
    assert.equal(isBootstrapPathAllowed('/api/v1/device-pairings'), true)
    assert.equal(isBootstrapPathAllowed('/api/v1/device-pairings/kpr_00112233445566778899aabbccddeeff/commit'), true)
    assert.equal(isBootstrapPathAllowed('/api/v1/device-pairings/kpr_00112233445566778899aabbccddeeff/status'), true)
    assert.equal(isBootstrapPathAllowed('/api/v1/device-pairings/kpr_00112233445566778899aabbccddeeff/complete'), false)
    assert.equal(isBootstrapPathAllowed('/api/mcp'), false)
    assert.equal(isBootstrapPathAllowed('/api/v1/tasks'), false)
    assert.equal(isBootstrapPathAllowed('/api/v1/agent/whoami'), false)
  })

  test('verifyPairingApproval reproduces frozen vectors and rejects a swapped origin', () => {
    const primary = loadVectors().vectors[0]
    const receipt = {
      v: 1,
      origin: primary.origin,
      pairing_id: primary.pairing_id,
      instance_id: primary.instance_id,
      device_fingerprint: primary.device_fingerprint,
      client_nonce: primary.client_nonce_hex,
      server_nonce: primary.server_nonce_hex,
      secret: primary.pairing_secret_hex,
      commitment: primary.commitment_hex,
      root_pem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
      root_sha256: primary.root_ca_sha256_hex,
      expires_at: new Date(primary.expires_at * 1000).toISOString(),
    }
    const ok = verifyPairingApproval({
      receipt,
      payload: {
        v: 1,
        pairing_id: primary.pairing_id,
        instance_id: primary.instance_id,
        origin: primary.origin,
        device_fingerprint: primary.device_fingerprint,
        root_sha256: primary.root_ca_sha256_hex,
        owner: { kind: 'claimant', claimant_id: 7 },
        approved_at: primary.approval.approved_at,
        expires_at: primary.expires_at,
      },
      proofHex: primary.approval.proof_hex,
    })
    assert.equal(ok.ok, true, ok.ok ? '' : ok.reason)
    const swapped = verifyPairingApproval({
      receipt,
      payload: {
        v: 1,
        pairing_id: primary.pairing_id,
        instance_id: primary.instance_id,
        origin: 'https://evil.example.test',
        device_fingerprint: primary.device_fingerprint,
        root_sha256: primary.root_ca_sha256_hex,
        owner: { kind: 'claimant', claimant_id: 7 },
        approved_at: primary.approval.approved_at,
        expires_at: primary.expires_at,
      },
      proofHex: primary.approval.proof_hex,
    })
    assert.equal(swapped.ok, false)
  })

  test('http origin, --insecure, and NODE_TLS_REJECT_UNAUTHORIZED=0 fail closed', async (t) => {
    const home = tmpHome(t)
    const streams = captureIo()
    const httpCode = await runPairCli(['--url', 'http://127.0.0.1:1'], { KAOLA_HOME: home }, streams.io)
    assert.equal(httpCode, 1)
    assert.match(streams.stderr(), /https/)

    const insecure = captureIo()
    const insecureCode = await runPairCli(
      ['--url', 'https://kaola.example.test', '--insecure'],
      { KAOLA_HOME: home },
      insecure.io,
    )
    assert.equal(insecureCode, 1)
    assert.match(insecure.stderr(), /not permitted/)

    const disabled = captureIo()
    const disabledCode = await runPairCli(
      ['--url', 'https://kaola.example.test'],
      { KAOLA_HOME: home, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      disabled.io,
    )
    assert.equal(disabledCode, 1)
    assert.match(disabled.stderr(), /NODE_TLS_REJECT_UNAUTHORIZED/)
  })

  test('--cancel deletes the local receipt without writing v2', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const dir = dirname(pairingReceiptPath(home, origin))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      pairingReceiptPath(home, origin),
      `${JSON.stringify({ v: 1, origin, secret: 'aa'.repeat(16), client_nonce: '11'.repeat(32) })}\n`,
      { mode: 0o600 },
    )
    const streams = captureIo()
    const code = await runPairCli(['--url', origin, '--cancel'], { KAOLA_HOME: home }, streams.io)
    assert.equal(code, 0)
    assert.equal(existsSync(pairingReceiptPath(home, origin)), false)
    assert.equal(existsSync(v2TrustDir(home, origin)), false)
  })

  test('public-CA strict success does not install an extra root', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const transport: PairingTransport = {
      async request(input) {
        assert.equal(input.mode, 'strict')
        assert.equal(input.extraCaPem, undefined)
        return { status: 200, headers: {}, body: '{"setup_complete":true}' }
      },
    }
    const streams = captureIo()
    const code = await runPairCli(['--url', origin], { KAOLA_HOME: home }, streams.io, {
      transport,
      sleep: async () => {},
    })
    assert.equal(code, 0)
    assert.match(streams.stdout(), /公开 CA/)
    assert.equal(existsSync(v2TrustDir(home, origin)), false)
    for (const path of walkFiles(home)) {
      const text = readFileSync(path, 'utf8')
      assert.equal(text.includes('BEGIN CERTIFICATE'), false, path)
      if (!path.endsWith('device.json')) {
        assert.equal(/BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(text), false, path)
      }
    }
  })

  test('pair verifies proof, writes v2 only after strict whoami, then deletes the receipt', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    const transport = pairingTransport({ home, origin, root })
    const streams = captureIo()
    const code = await runPairCli(['--url', origin], { KAOLA_HOME: home }, streams.io, {
      transport,
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(code, 0, streams.stderr())
    assert.match(streams.stdout(), /配对密语/)
    assert.match(streams.stdout(), /配对完成/)
    assert.equal(existsSync(pairingReceiptPath(home, origin)), false)
    const inspected = inspectV2Trust(home, origin)
    assert.equal(inspected.ready, true, inspected.ready ? '' : inspected.message)
    assert.equal(inspected.ready && inspected.state.v, 2)
    assert.equal(JSON.stringify(inspected.ready ? inspected.state : {}).includes(origin), false)
    assert.equal(String(streams.stderr()).includes('a0a1'), false)
    const stateText = readFileSync(inspected.ready ? inspected.statePath : '', 'utf8')
    assert.equal(stateText.includes('BEGIN CERTIFICATE'), false)
    assert.equal(/PRIVATE KEY/.test(stateText), false)
  })

  test('failed strict whoami does not leave ready v2 trust', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    const transport = pairingTransport({ home, origin, root, failWhoami: true })
    const streams = captureIo()
    const code = await runPairCli(['--url', origin], { KAOLA_HOME: home }, streams.io, {
      transport,
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(code, 1)
    assert.equal(inspectV2Trust(home, origin).ready, false)
    assert.equal(existsSync(join(v2TrustDir(home, origin), 'root-ca.pem')), false)
  })

  test('descriptor origin mismatch does not write v2', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    const transport = pairingTransport({
      home,
      origin,
      root,
      descriptorOrigin: 'https://evil.example.test',
    })
    const streams = captureIo()
    const code = await runPairCli(['--url', origin], { KAOLA_HOME: home }, streams.io, {
      transport,
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(code, 1)
    assert.match(streams.stderr(), /origin/)
    assert.equal(inspectV2Trust(home, origin).ready, false)
  })

  test('restart reuses an unexpired receipt secret and client_nonce', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
    const secret = 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecf'
    const clientNonce = '22'.repeat(32)
    const { ensureDeviceIdentity } = await import('./main.ts')
    const device = await ensureDeviceIdentity(home)
    const { deviceFingerprint } = await import('@kaola/shared')
    const fp = deviceFingerprint(Buffer.from(device.publicKeySpki, 'base64'))
    const dir = dirname(pairingReceiptPath(home, origin))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      pairingReceiptPath(home, origin),
      `${JSON.stringify({
        v: 1,
        origin,
        pairing_id: null,
        instance_id: null,
        device_fingerprint: fp,
        client_nonce: clientNonce,
        server_nonce: null,
        secret,
        commitment: null,
        root_pem: null,
        root_sha256: null,
        expires_at: new Date(Date.now() + 86400 * 1000).toISOString(),
      })}\n`,
      { mode: 0o600 },
    )
    chmodSync(pairingReceiptPath(home, origin), 0o600)
    chmodSync(dir, 0o700)
    let seenNonce = ''
    const base = pairingTransport({ home, origin, root })
    const transport: PairingTransport = {
      async request(input) {
        const url = new URL(input.url)
        if (url.pathname === '/api/v1/device-pairings' && input.method === 'POST') {
          seenNonce = JSON.parse(input.body.toString('utf8')).client_nonce
        }
        return base.request(input)
      },
    }
    const streams = captureIo()
    const code = await runPairCli(['--url', origin], { KAOLA_HOME: home }, streams.io, {
      transport,
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(code, 0, streams.stderr())
    assert.equal(seenNonce, clientNonce)
    assert.match(streams.stdout(), new RegExp(secret.replace(/(.{4})/g, '$1-').replace(/-$/, '')))
  })

  test('approval with a substituted root does not write v2', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    const other = mintRoot(t)
    const base = pairingTransport({ home, origin, root })
    const transport: PairingTransport = {
      async request(input) {
        const url = new URL(input.url)
        if (url.pathname.endsWith('/status')) {
          const res = await base.request(input)
          const body = JSON.parse(res.body)
          body.approval.payload.root_sha256 = other.sha256
          return { ...res, body: JSON.stringify(body) }
        }
        return base.request(input)
      },
    }
    const streams = captureIo()
    const code = await runPairCli(['--url', origin], { KAOLA_HOME: home }, streams.io, {
      transport,
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(code, 1)
    assert.match(streams.stderr(), /root mismatch|proof/)
    assert.equal(inspectV2Trust(home, origin).ready, false)
  })

  test('legacy v1 extra CA remains v:1 and is not rewritten as v2', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    mkdirSync(trustDir(home), { recursive: true, mode: 0o700 })
    writeFileSync(trustRootCaPath(home), root.pem, { mode: 0o600 })
    writeFileSync(
      trustStatePath(home),
      `${JSON.stringify({ v: 1, alg: 'sha256', fingerprintSha256: root.sha256 })}\n`,
      { mode: 0o600 },
    )
    chmodSync(trustDir(home), 0o700)
    chmodSync(trustRootCaPath(home), 0o600)
    chmodSync(trustStatePath(home), 0o600)
    const transport = pairingTransport({ home, origin, root })
    const streams = captureIo()
    const code = await runPairCli(['--url', origin], { KAOLA_HOME: home }, streams.io, {
      transport,
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(code, 0, streams.stderr())
    assert.match(streams.stdout(), /无需再次配对/)
    const v1 = JSON.parse(readFileSync(trustStatePath(home), 'utf8')) as { v: number }
    assert.equal(v1.v, 1)
    assert.equal(inspectV2Trust(home, origin).present, false)
  })

  test('launcher overlap writes old+new extra CA; new-only proof later drops the previous root', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    const next = mintRoot(t)
    const pairStreams = captureIo()
    const pairCode = await runPairCli(['--url', origin], { KAOLA_HOME: home }, pairStreams.io, {
      transport: pairingTransport({ home, origin, root }),
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(pairCode, 0, pairStreams.stderr())
    const overlap = await prepareHttpsLauncher({
      url: origin,
      env: { KAOLA_HOME: home },
      transport: {
        async request(input) {
          const url = new URL(input.url)
          const certs = [...(input.extraCaPem ?? '').matchAll(/-----BEGIN CERTIFICATE-----/g)].length
          if (url.pathname === '/api/v1/setup') {
            if (certs === 0) unknownIssuer()
            if (certs === 1) {
              const inspected = inspectPublicRootPem(input.extraCaPem ?? '')
              if (inspected.ok && inspected.fingerprintSha256 === next.sha256) unknownIssuer()
            }
            return { status: 200, headers: {}, body: '{"setup_complete":true}' }
          }
          if (url.pathname === '/api/v1/device-trust/next-root') {
            return {
              status: 200,
              headers: {},
              body: JSON.stringify({
                root_pem: next.pem,
                root_sha256: next.sha256,
                trust_epoch: 2,
              }),
            }
          }
          throw new Error(`unexpected ${url.pathname}`)
        },
      },
    })
    assert.equal(overlap.ok, true, overlap.ok ? '' : overlap.message)
    const overlapping = inspectV2Trust(home, origin)
    assert.equal(overlapping.ready, true)
    if (!overlapping.ready) return
    assert.equal([...overlapping.pem.matchAll(/-----BEGIN CERTIFICATE-----/g)].length, 2)
    assert.equal(overlapping.state.previousFingerprintSha256, root.sha256)
    assert.equal(overlapping.state.fingerprintSha256, next.sha256)
    assert.equal(overlapping.state.trustEpoch, 2)
    if (overlap.ok && overlap.extraCaPemPath != null) {
      const extra = readVerifiedExtraCaPem(overlap.extraCaPemPath)
      assert.equal(extra.ok, true, extra.ok ? '' : extra.message)
    }

    const dropped = await prepareHttpsLauncher({
      url: origin,
      env: { KAOLA_HOME: home },
      transport: {
        async request(input) {
          const url = new URL(input.url)
          const certs = [...(input.extraCaPem ?? '').matchAll(/-----BEGIN CERTIFICATE-----/g)].length
          if (url.pathname === '/api/v1/setup') {
            if (certs === 0) unknownIssuer()
            if (certs === 1) {
              const inspected = inspectPublicRootPem(input.extraCaPem ?? '')
              if (!inspected.ok || inspected.fingerprintSha256 !== next.sha256) unknownIssuer()
            }
            return { status: 200, headers: {}, body: '{"setup_complete":true}' }
          }
          if (url.pathname === '/api/v1/device-trust/next-root') {
            return { status: 404, headers: {}, body: '{"error":"not_found"}' }
          }
          throw new Error(`unexpected ${url.pathname}`)
        },
      },
    })
    assert.equal(dropped.ok, true, dropped.ok ? '' : dropped.message)
    const after = inspectV2Trust(home, origin)
    assert.equal(after.ready, true)
    if (!after.ready) return
    assert.equal([...after.pem.matchAll(/-----BEGIN CERTIFICATE-----/g)].length, 1)
    assert.equal(after.state.previousFingerprintSha256, undefined)
    assert.equal(after.state.fingerprintSha256, next.sha256)
  })

  test('failed next-root leaves the existing v2 extra CA unchanged', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    const pairStreams = captureIo()
    const pairCode = await runPairCli(['--url', origin], { KAOLA_HOME: home }, pairStreams.io, {
      transport: pairingTransport({ home, origin, root }),
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(pairCode, 0, pairStreams.stderr())
    const before = inspectV2Trust(home, origin)
    assert.equal(before.ready, true)
    const pemBefore = before.ready ? before.pem : ''
    const prep = await prepareHttpsLauncher({
      url: origin,
      env: { KAOLA_HOME: home },
      transport: {
        async request(input) {
          const url = new URL(input.url)
          if (url.pathname === '/api/v1/setup') {
            if (input.extraCaPem == null || input.extraCaPem.length === 0) unknownIssuer()
            return { status: 200, headers: {}, body: '{"setup_complete":true}' }
          }
          if (url.pathname === '/api/v1/device-trust/next-root') {
            return { status: 500, headers: {}, body: '{"error":"unavailable"}' }
          }
          throw new Error(`unexpected ${url.pathname}`)
        },
      },
    })
    assert.equal(prep.ok, true, prep.ok ? '' : prep.message)
    const after = inspectV2Trust(home, origin)
    assert.equal(after.ready, true)
    if (!after.ready) return
    assert.equal(after.pem, pemBefore)
    assert.equal(after.state.fingerprintSha256, root.sha256)
    assert.equal(after.state.previousFingerprintSha256, undefined)
  })

  test('missed overlap unknown-issuer returns pairing_required', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    const pairStreams = captureIo()
    const pairCode = await runPairCli(['--url', origin], { KAOLA_HOME: home }, pairStreams.io, {
      transport: pairingTransport({ home, origin, root }),
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(pairCode, 0, pairStreams.stderr())
    const prep = await prepareHttpsLauncher({
      url: origin,
      env: { KAOLA_HOME: home },
      transport: {
        async request() {
          unknownIssuer()
        },
      },
    })
    assert.equal(prep.ok, false)
    if (prep.ok) return
    assert.equal(prep.pairingRequired, true)
    assert.match(prep.message, /pairing_required/)
    assert.equal(inspectV2Trust(home, origin).ready, true)
  })

  test('public-CA migration deletes only this origin digest v2 extra root', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    const pairStreams = captureIo()
    const pairCode = await runPairCli(['--url', origin], { KAOLA_HOME: home }, pairStreams.io, {
      transport: pairingTransport({ home, origin, root }),
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(pairCode, 0, pairStreams.stderr())
    assert.equal(inspectV2Trust(home, origin).ready, true)
    const { ensureDeviceIdentity } = await import('./main.ts')
    const device = await ensureDeviceIdentity(home)
    const { deviceFingerprint } = await import('@kaola/shared')
    const fp = deviceFingerprint(Buffer.from(device.publicKeySpki, 'base64'))
    const devicePath = join(home, 'device.json')
    const prep = await prepareHttpsLauncher({
      url: origin,
      env: { KAOLA_HOME: home },
      transport: {
        async request(input) {
          const url = new URL(input.url)
          if (url.pathname === '/api/v1/setup') {
            return { status: 200, headers: {}, body: '{"setup_complete":true}' }
          }
          if (url.pathname === '/api/v1/agent/whoami') {
            assert.equal(input.extraCaPem, undefined)
            return {
              status: 200,
              headers: {},
              body: JSON.stringify({
                device_id: 1,
                fingerprint: fp,
                hostname: 'test',
                status: 'active',
                instance_id: INSTANCE_ID,
              }),
            }
          }
          throw new Error(`unexpected ${url.pathname}`)
        },
      },
    })
    assert.equal(prep.ok, true, prep.ok ? '' : prep.message)
    if (!prep.ok) return
    assert.equal(prep.extraCaPemPath, undefined)
    assert.equal(inspectV2Trust(home, origin).present, false)
    assert.equal(existsSync(devicePath), true)
  })

  test('missed overlap extra CA unknown-issuer continues pair instead of refusing a second bootstrap', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const oldRoot = mintRoot(t)
    const nextRoot = mintRoot(t)
    const first = captureIo()
    assert.equal(
      await runPairCli(['--url', origin], { KAOLA_HOME: home }, first.io, {
        transport: pairingTransport({ home, origin, root: oldRoot }),
        sleep: async () => {},
        pollIntervalMs: 0,
      }),
      0,
      first.stderr(),
    )
    assert.equal(inspectV2Trust(home, origin).ready, true)
    const base = pairingTransport({ home, origin, root: nextRoot })
    const transport: PairingTransport = {
      async request(input) {
        const url = new URL(input.url)
        const oldPem = inspectPublicRootPem(oldRoot.pem)
        if (
          input.mode === 'strict' &&
          input.extraCaPem != null &&
          oldPem.ok &&
          input.extraCaPem.includes(oldPem.pem.trim()) &&
          !input.extraCaPem.includes(nextRoot.pem.trim())
        ) {
          unknownIssuer()
        }
        return base.request(input)
      },
    }
    const streams = captureIo()
    const code = await runPairCli(['--url', origin], { KAOLA_HOME: home }, streams.io, {
      transport,
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(code, 0, streams.stderr())
    assert.match(streams.stdout(), /再次批准/)
    const after = inspectV2Trust(home, origin)
    assert.equal(after.ready, true)
    if (!after.ready) return
    assert.equal(after.state.fingerprintSha256, nextRoot.sha256)
  })

  test('interrupted v2 replace restores the previous complete directory', async (t) => {
    const home = tmpHome(t)
    const origin = 'https://kaola.example.test'
    const root = mintRoot(t)
    const streams = captureIo()
    assert.equal(
      await runPairCli(['--url', origin], { KAOLA_HOME: home }, streams.io, {
        transport: pairingTransport({ home, origin, root }),
        sleep: async () => {},
        pollIntervalMs: 0,
      }),
      0,
      streams.stderr(),
    )
    const finalDir = v2TrustDir(home, origin)
    const previous = v2PreviousTrustDir(home, origin)
    const pemBefore = readFileSync(join(finalDir, 'root-ca.pem'), 'utf8')
    renameSync(finalDir, previous)
    const recovered = inspectV2Trust(home, origin)
    assert.equal(recovered.ready, true)
    assert.equal(existsSync(previous), false)
    assert.equal(readFileSync(join(finalDir, 'root-ca.pem'), 'utf8'), pemBefore)
    const next = mintRoot(t)
    const { ensureDeviceIdentity } = await import('./main.ts')
    const device = await ensureDeviceIdentity(home)
    const { deviceFingerprint } = await import('@kaola/shared')
    const fp = deviceFingerprint(Buffer.from(device.publicKeySpki, 'base64'))
    const staging = writeV2Staging({
      kaolaHome: home,
      origin,
      pem: next.pem,
      state: {
        v: 2,
        alg: 'sha256',
        originDigest: pairingOriginDigest(origin),
        instanceId: INSTANCE_ID,
        deviceFingerprint: fp,
        fingerprintSha256: next.sha256,
        trustEpoch: 2,
        pairedAt: 1,
      },
    })
    commitV2Staging(staging, origin, home)
    const replaced = inspectV2Trust(home, origin)
    assert.equal(replaced.ready, true)
    if (!replaced.ready) return
    assert.equal(replaced.state.fingerprintSha256, next.sha256)
    assert.equal(existsSync(previous), false)
    recoverInterruptedV2Trust(home, origin)
    assert.equal(inspectV2Trust(home, origin).ready, true)
  })
})

describe('pairing_required exit contract', () => {
  test('typed pairing_required uses exit 2', () => {
    assert.equal(PAIRING_REQUIRED_EXIT_CODE, 2)
  })

  test('package bin --url against an unknown private CA prints pairing_required and exits 2', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kaola-pair-bin-pki-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const caPem = join(dir, 'ca.pem')
    const caKey = join(dir, 'ca.key')
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-days',
      '1',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      caPem,
      '-subj',
      '/CN=Kaola Pair Bin Root',
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ])
    const leafKey = join(dir, 'leaf.key')
    const leafCsr = join(dir, 'leaf.csr')
    const leafPem = join(dir, 'leaf.pem')
    const cnf = join(dir, 'leaf.cnf')
    writeFileSync(
      cnf,
      [
        '[req]',
        'distinguished_name = dn',
        'req_extensions = ext',
        'prompt = no',
        '[dn]',
        'CN = 127.0.0.1',
        '[ext]',
        'basicConstraints = CA:FALSE',
        'keyUsage = digitalSignature,keyEncipherment',
        'extendedKeyUsage = serverAuth',
        'subjectAltName = IP:127.0.0.1',
        '',
      ].join('\n'),
    )
    execFileSync('openssl', [
      'req',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      leafKey,
      '-out',
      leafCsr,
      '-config',
      cnf,
    ])
    execFileSync('openssl', [
      'x509',
      '-req',
      '-in',
      leafCsr,
      '-CA',
      caPem,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      leafPem,
      '-days',
      '1',
      '-sha256',
      '-extfile',
      cnf,
      '-extensions',
      'ext',
    ])
    const origin = await new Promise((resolve) => {
      const server = createHttpsServer(
        { cert: readFileSync(leafPem), key: readFileSync(leafKey), minVersion: 'TLSv1.2' },
        (_req, res) => {
          res.statusCode = 200
          res.end('{"setup_complete":true}')
        },
      )
      t.after(() => server.close())
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr == null || typeof addr === 'string') throw new Error('expected TCP address')
        resolve(`https://127.0.0.1:${addr.port}`)
      })
    })
    const home = tmpHome(t)
    const env = { ...process.env, KAOLA_HOME: home }
    delete env.NODE_EXTRA_CA_CERTS
    delete env.NODE_TLS_REJECT_UNAUTHORIZED
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN_PATH, '--url', origin], {
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
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 12000)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
    assert.equal(result.code, PAIRING_REQUIRED_EXIT_CODE, result.stderr)
    assert.match(result.stderr, /pairing_required/)
    assert.match(result.stderr, /kaola-mcp pair --url/)
    assert.equal(existsSync(v2TrustDir(home, origin)), false)
  })

  test('default-store public-CA probe ignores process-start NODE_EXTRA_CA_CERTS (real TLS child)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kaola-pair-r4-pki-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const caPem = join(dir, 'ca.pem')
    const caKey = join(dir, 'ca.key')
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-days',
      '1',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      caPem,
      '-subj',
      '/CN=Kaola Pair R4 Root',
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ])
    const leafKey = join(dir, 'leaf.key')
    const leafCsr = join(dir, 'leaf.csr')
    const leafPem = join(dir, 'leaf.pem')
    const cnf = join(dir, 'leaf.cnf')
    writeFileSync(
      cnf,
      [
        '[req]',
        'distinguished_name = dn',
        'req_extensions = ext',
        'prompt = no',
        '[dn]',
        'CN = 127.0.0.1',
        '[ext]',
        'basicConstraints = CA:FALSE',
        'keyUsage = digitalSignature,keyEncipherment',
        'extendedKeyUsage = serverAuth',
        'subjectAltName = IP:127.0.0.1',
        '',
      ].join('\n'),
    )
    execFileSync('openssl', [
      'req',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      leafKey,
      '-out',
      leafCsr,
      '-config',
      cnf,
    ])
    execFileSync('openssl', [
      'x509',
      '-req',
      '-in',
      leafCsr,
      '-CA',
      caPem,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      leafPem,
      '-days',
      '1',
      '-sha256',
      '-extfile',
      cnf,
      '-extensions',
      'ext',
    ])
    const caText = readFileSync(caPem, 'utf8')
    const inspected = inspectPublicRootPem(caText)
    assert.equal(inspected.ok, true)
    const home = tmpHome(t)
    const { ensureDeviceIdentity } = await import('./main.ts')
    const { deviceFingerprint } = await import('@kaola/shared')
    const device = await ensureDeviceIdentity(home)
    const fp = deviceFingerprint(Buffer.from(device.publicKeySpki, 'base64'))
    const origin = await new Promise((resolve) => {
      const server = createHttpsServer(
        { cert: readFileSync(leafPem), key: readFileSync(leafKey), minVersion: 'TLSv1.2' },
        (req, res) => {
          res.setHeader('content-type', 'application/json')
          if (req.url === '/api/v1/setup') {
            res.statusCode = 200
            res.end('{"setup_complete":true}')
            return
          }
          if (req.url === '/api/v1/agent/whoami') {
            res.statusCode = 200
            res.end(
              JSON.stringify({
                device_id: 1,
                fingerprint: fp,
                hostname: 'test',
                status: 'active',
                instance_id: INSTANCE_ID,
              }),
            )
            return
          }
          res.statusCode = 404
          res.end('{"error":"not_found"}')
        },
      )
      t.after(() => server.close())
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr == null || typeof addr === 'string') throw new Error('expected TCP address')
        resolve(`https://127.0.0.1:${addr.port}`)
      })
    })
    if (!inspected.ok) return
    const staging = writeV2Staging({
      kaolaHome: home,
      origin,
      pem: inspected.pem,
      state: {
        v: 2,
        alg: 'sha256',
        originDigest: pairingOriginDigest(origin),
        instanceId: INSTANCE_ID,
        deviceFingerprint: fp,
        fingerprintSha256: inspected.fingerprintSha256,
        trustEpoch: 1,
        pairedAt: 1,
      },
    })
    commitV2Staging(staging, origin, home)
    assert.equal(inspectV2Trust(home, origin).ready, true)
    const childScript = join(dir, 'r4-child.mjs')
    writeFileSync(
      childScript,
      [
        'import { inspectV2Trust, prepareHttpsLauncher } from ' + JSON.stringify(join(HERE, 'pair.ts')) + ';',
        'const origin = process.env.ORIGIN;',
        'const home = process.env.KAOLA_HOME;',
        'const r = await prepareHttpsLauncher({ url: origin, env: process.env });',
        'const v2 = inspectV2Trust(home, origin);',
        'process.stdout.write(JSON.stringify({ ok: r.ok, present: v2.present, extra: r.ok ? r.extraCaPemPath : null }) + "\\n");',
        '',
      ].join('\n'),
    )
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', childScript], {
        env: {
          ...process.env,
          KAOLA_HOME: home,
          ORIGIN: origin,
          NODE_EXTRA_CA_CERTS: caPem,
        },
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
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
    assert.equal(result.code, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.present, true, result.stdout)
    assert.equal(inspectV2Trust(home, origin).present, true)
    assert.equal(inspectV2Trust(home, origin).ready, true)
  })
})
