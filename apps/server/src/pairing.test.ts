import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  DEFAULT_PAIRING_TTL_SECONDS,
  encodePairingTranscript,
  pairingCommitment,
  pairingIsLive,
} from '@kaola/shared'
import { applyOauthTestEnv, ensureSetup, sqliteFile } from './auth.test-helpers.ts'
import { generateDeviceIdentity, injectSigned } from './device-proof.test-helpers.ts'
import { createDb } from './db.ts'
import { loadPairingConfig } from './pairing.ts'

const VAULT_MASTER_KEY_HEX = 'cd'.repeat(32)
const MCP_PATH = '/api/mcp'
const FROZEN_MS = Date.UTC(2026, 7, 21, 4, 0, 0)
const SECRET_HEX = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf'
const WRONG_SECRET_HEX = 'b0a1a2a3a4a5a6a7a8a9aaabacadaeaf'
const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' }

applyOauthTestEnv({
  VAULT_MASTER_KEY: VAULT_MASTER_KEY_HEX,
  PUBLIC_URL: 'http://localhost:3000',
})
delete process.env.KAOLA_PAIRING_MODE
delete process.env.KAOLA_PUBLIC_ROOT_CA_PATH
delete process.env.KAOLA_PAIRING_TTL_SECONDS
delete process.env.KAOLA_NEXT_PUBLIC_ROOT_CA_PATH

const { buildApp } = await import('./app.ts')

function jsonBody(res) {
  try {
    return JSON.parse(res.body)
  } catch {
    return undefined
  }
}

function freezeNow(t, ms = FROZEN_MS) {
  const realNow = Date.now
  let current = ms
  Date.now = () => current
  t.after(() => {
    Date.now = realNow
  })
  return {
    unix() {
      return Math.floor(current / 1000)
    },
    advanceMs(delta) {
      current += delta
    },
  }
}

function restoreEnv(t) {
  const saved = {
    mode: process.env.KAOLA_PAIRING_MODE,
    path: process.env.KAOLA_PUBLIC_ROOT_CA_PATH,
    ttl: process.env.KAOLA_PAIRING_TTL_SECONDS,
    next: process.env.KAOLA_NEXT_PUBLIC_ROOT_CA_PATH,
  }
  t.after(() => {
    if (saved.mode == null) delete process.env.KAOLA_PAIRING_MODE
    else process.env.KAOLA_PAIRING_MODE = saved.mode
    if (saved.path == null) delete process.env.KAOLA_PUBLIC_ROOT_CA_PATH
    else process.env.KAOLA_PUBLIC_ROOT_CA_PATH = saved.path
    if (saved.ttl == null) delete process.env.KAOLA_PAIRING_TTL_SECONDS
    else process.env.KAOLA_PAIRING_TTL_SECONDS = saved.ttl
    if (saved.next == null) delete process.env.KAOLA_NEXT_PUBLIC_ROOT_CA_PATH
    else process.env.KAOLA_NEXT_PUBLIC_ROOT_CA_PATH = saved.next
  })
}

function mintTestRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-pairing-ca-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const pem = join(dir, 'ca.pem')
  const key = join(dir, 'ca.key')
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
    key,
    '-out',
    pem,
    '-subj',
    '/CN=Kaola Pairing Test Root',
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ])
  return pem
}

function enablePairing(t) {
  restoreEnv(t)
  const pem = mintTestRoot(t)
  process.env.KAOLA_PAIRING_MODE = 'private_ca'
  process.env.KAOLA_PUBLIC_ROOT_CA_PATH = pem
  delete process.env.KAOLA_PAIRING_TTL_SECONDS
  delete process.env.KAOLA_NEXT_PUBLIC_ROOT_CA_PATH
  return pem
}

async function createApp(t, sqlitePath) {
  const app = buildApp(sqlitePath ? { sqlitePath } : undefined)
  t.after(async () => {
    await app.close()
  })
  await app.ready()
  return app
}

function clientNonce() {
  return Buffer.from('11'.repeat(32), 'hex').toString('hex')
}

function mcpInitializePayload() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'kaola-pairing-test', version: '0.0.0' },
    },
  }
}

function mcpToolPayload(name, args = {}, id = 2) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

async function signedJson(app, identity, { url, payload }) {
  return injectSigned(app, identity, {
    method: 'POST',
    url,
    payload,
    extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
  })
}

async function signedMcp(app, identity, payload) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: MCP_PATH,
    payload: JSON.stringify(payload),
    extraHeaders: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
  })
}

function commitmentOf(created, secretHex) {
  const expiresAt = Math.floor(Date.parse(created.expires_at) / 1000)
  const transcript = encodePairingTranscript({
    pairingId: created.pairing_id,
    instanceId: created.instance_id,
    origin: created.origin,
    deviceFingerprint: created.device_fingerprint,
    clientNonce: Buffer.from(clientNonce(), 'hex'),
    serverNonce: Buffer.from(created.server_nonce, 'hex'),
    rootCaSha256: Buffer.from(created.root_sha256, 'hex'),
    expiresAt,
  })
  return pairingCommitment(Buffer.from(secretHex, 'hex'), transcript).toString('hex')
}

async function createAndCommit(app, identity, secretHex = SECRET_HEX) {
  const createdRes = await signedJson(app, identity, {
    url: '/api/v1/device-pairings',
    payload: { client_nonce: clientNonce() },
  })
  assert.equal(createdRes.statusCode, 201, `create pairing: ${createdRes.statusCode} ${createdRes.body}`)
  const created = jsonBody(createdRes)
  const commitRes = await signedJson(app, identity, {
    url: `/api/v1/device-pairings/${created.pairing_id}/commit`,
    payload: { commitment: commitmentOf(created, secretHex) },
  })
  assert.equal(commitRes.statusCode, 200, `commit pairing: ${commitRes.statusCode} ${commitRes.body}`)
  return created
}

function sqliteRows(sqlitePath) {
  const raw = new Database(sqlitePath, { readonly: true })
  try {
    return {
      pairing: raw.prepare('SELECT * FROM device_pairings').get(),
      device: raw.prepare('SELECT * FROM devices').get(),
      events: raw.prepare('SELECT type, details FROM events').all(),
    }
  } finally {
    raw.close()
  }
}

describe('issue #63 approval-bound private-CA pairing', { concurrency: false }, () => {
  test('pairing REST is 404 pairing_mode_disabled when mode is off', async (t) => {
    restoreEnv(t)
    delete process.env.KAOLA_PAIRING_MODE
    delete process.env.KAOLA_PUBLIC_ROOT_CA_PATH
    const app = await createApp(t)
    const identity = generateDeviceIdentity()
    const res = await signedJson(app, identity, {
      url: '/api/v1/device-pairings',
      payload: { client_nonce: clientNonce() },
    })
    assert.equal(res.statusCode, 404, res.body)
    assert.equal(jsonBody(res).error, 'pairing_mode_disabled')
  })

  test('KAOLA_PAIRING_TTL_SECONDS=900 fails closed', (t) => {
    enablePairing(t)
    process.env.KAOLA_PAIRING_TTL_SECONDS = '900'
    const db = createDb()
    t.after(() => db.$client.close())
    assert.throws(() => loadPairingConfig(db), /86400/)
  })

  test('new attempt lasts 86400s from this create; recover does not slide; leftover pending is extended not shortened', async (t) => {
    const clock = freezeNow(t)
    enablePairing(t)
    const sqlitePath = sqliteFile(t, 'kaola-pairing-ttl-')
    const app = await createApp(t, sqlitePath)
    const identity = generateDeviceIdentity()

    await signedMcp(app, identity, mcpInitializePayload())
    const raw = new Database(sqlitePath)
    raw.prepare('UPDATE devices SET pending_expires_at = ?').run(clock.unix() + 3600)
    raw.close()

    const createdUnix = clock.unix()
    const first = await signedJson(app, identity, {
      url: '/api/v1/device-pairings',
      payload: { client_nonce: clientNonce() },
    })
    assert.equal(first.statusCode, 201, first.body)
    const created = jsonBody(first)
    const expiresUnix = Math.floor(Date.parse(created.expires_at) / 1000)
    assert.equal(expiresUnix - createdUnix, DEFAULT_PAIRING_TTL_SECONDS)
    assert.equal(pairingIsLive(clock.unix() + 1, expiresUnix), true)
    assert.equal(pairingIsLive(expiresUnix - 1, expiresUnix), true)
    assert.equal(pairingIsLive(expiresUnix, expiresUnix), false)
    assert.equal(String(created.root_pem).includes('PRIVATE KEY'), false)

    const rowsAfterCreate = sqliteRows(sqlitePath)
    assert.equal(rowsAfterCreate.device.pending_expires_at, expiresUnix)
    assert.equal(rowsAfterCreate.pairing.expires_at, expiresUnix)
    assert.equal(rowsAfterCreate.pairing.created_at, clock.unix())

    clock.advanceMs(10_000)
    const recover = await signedJson(app, identity, {
      url: '/api/v1/device-pairings',
      payload: { client_nonce: clientNonce() },
    })
    assert.equal(recover.statusCode, 200, recover.body)
    const recovered = jsonBody(recover)
    assert.equal(recovered.pairing_id, created.pairing_id)
    assert.equal(recovered.server_nonce, created.server_nonce)
    assert.equal(recovered.expires_at, created.expires_at)
    const rowsAfterRecover = sqliteRows(sqlitePath)
    assert.equal(rowsAfterRecover.pairing.expires_at, expiresUnix)
    assert.equal(rowsAfterRecover.pairing.created_at, createdUnix)
    assert.equal(rowsAfterRecover.device.pending_expires_at, expiresUnix)
  })

  test('pending pairing cannot list_tasks or claim_task; bind requires secret and grants 90-day device auth', async (t) => {
    freezeNow(t)
    enablePairing(t)
    const sqlitePath = sqliteFile(t, 'kaola-pairing-bind-')
    const app = await createApp(t, sqlitePath)
    const admin = await ensureSetup(app)
    const identity = generateDeviceIdentity()
    const created = await createAndCommit(app, identity)

    const listedPending = await signedMcp(app, identity, mcpToolPayload('list_tasks'))
    assert.equal(listedPending.statusCode, 202, listedPending.body)
    assert.equal(jsonBody(listedPending).error, 'authorization_required')
    const claimedPending = await signedMcp(
      app,
      identity,
      mcpToolPayload('claim_task', { task_id: 'kt_pending' }),
    )
    assert.equal(claimedPending.statusCode, 202, claimedPending.body)

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/pending',
      cookies: admin.cookies,
      headers: { accept: 'application/json' },
    })
    assert.equal(pending.statusCode, 200, pending.body)
    const row = jsonBody(pending).devices[0]
    assert.equal(row.requires_pairing_secret, true)
    assert.equal(row.pairing_id, created.pairing_id)
    assert.equal(String(pending.body).includes(SECRET_HEX), false)
    assert.equal(String(pending.body).includes(created.root_pem), false)

    const missingSecret = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${row.id}/bind`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: { bind_to_self: true },
    })
    assert.equal(missingSecret.statusCode, 400, missingSecret.body)

    const bound = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${row.id}/bind`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: {
        bind_to_self: true,
        pairing_id: created.pairing_id,
        pairing_secret: SECRET_HEX,
      },
    })
    assert.equal(bound.statusCode, 200, bound.body)
    const boundBody = jsonBody(bound)
    assert.equal(boundBody.ok, true)
    assert.equal(Object.hasOwn(boundBody, 'token'), false)
    assert.equal(String(bound.body).includes(SECRET_HEX), false)

    const after = sqliteRows(sqlitePath)
    assert.equal(after.device.status, 'active')
    assert.equal(after.device.expires_at - after.device.paired_at, 90 * 86400)
    assert.equal(after.pairing.status, 'approved')
    for (const event of after.events) {
      assert.equal(String(event.details).includes(SECRET_HEX), false)
      assert.equal(String(event.details).includes(created.root_pem), false)
    }

    const whoami = await injectSigned(app, identity, {
      method: 'GET',
      url: '/api/v1/agent/whoami',
      extraHeaders: { accept: 'application/json' },
    })
    assert.equal(whoami.statusCode, 200, whoami.body)
    const who = jsonBody(whoami)
    assert.equal(who.instance_id, created.instance_id)
    assert.equal(who.status, 'active')
    assert.equal(Object.hasOwn(who, 'token'), false)

    const status = await signedJson(app, identity, {
      url: `/api/v1/device-pairings/${created.pairing_id}/status`,
      payload: {},
    })
    assert.equal(status.statusCode, 200, status.body)
    assert.equal(jsonBody(status).status, 'approved')
    assert.equal(typeof jsonBody(status).approval?.proof, 'string')
    assert.equal(String(status.body).includes(SECRET_HEX), false)
  })

  test('wrong secret does not activate; the 9th failure is 409 pairing_secret_invalid', async (t) => {
    freezeNow(t)
    enablePairing(t)
    const sqlitePath = sqliteFile(t, 'kaola-pairing-wrong-')
    const app = await createApp(t, sqlitePath)
    const admin = await ensureSetup(app)
    const identity = generateDeviceIdentity()
    const created = await createAndCommit(app, identity)
    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/pending',
      cookies: admin.cookies,
      headers: { accept: 'application/json' },
    })
    const row = jsonBody(pending).devices[0]

    for (let i = 0; i < 8; i += 1) {
      const wrong = await app.inject({
        method: 'POST',
        url: `/api/v1/devices/${row.id}/bind`,
        cookies: admin.cookies,
        headers: JSON_HEADERS,
        payload: {
          bind_to_self: true,
          pairing_id: created.pairing_id,
          pairing_secret: WRONG_SECRET_HEX,
        },
      })
      assert.equal(wrong.statusCode, 403, `attempt ${i + 1}: ${wrong.body}`)
      assert.equal(jsonBody(wrong).error, 'pairing_secret_invalid')
    }
    const locked = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${row.id}/bind`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: {
        bind_to_self: true,
        pairing_id: created.pairing_id,
        pairing_secret: SECRET_HEX,
      },
    })
    assert.equal(locked.statusCode, 409, locked.body)
    assert.equal(jsonBody(locked).error, 'pairing_secret_invalid')
    assert.equal(sqliteRows(sqlitePath).device.status, 'pending')
  })

  test('approve and recover at expires_at-1; expire exactly at expires_at', async (t) => {
    const clock = freezeNow(t)
    enablePairing(t)
    const sqlitePath = sqliteFile(t, 'kaola-pairing-window-')
    const app = await createApp(t, sqlitePath)
    const admin = await ensureSetup(app)
    const identity = generateDeviceIdentity()
    const created = await createAndCommit(app, identity)
    const expiresUnix = Math.floor(Date.parse(created.expires_at) / 1000)

    clock.advanceMs(86399 * 1000)
    assert.equal(clock.unix(), expiresUnix - 1)
    const recover = await signedJson(app, identity, {
      url: '/api/v1/device-pairings',
      payload: { client_nonce: clientNonce() },
    })
    assert.equal(recover.statusCode, 200, recover.body)
    assert.equal(jsonBody(recover).pairing_id, created.pairing_id)
    assert.equal(jsonBody(recover).expires_at, created.expires_at)

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/pending',
      cookies: admin.cookies,
      headers: { accept: 'application/json' },
    })
    const row = jsonBody(pending).devices[0]
    const bound = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${row.id}/bind`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: {
        bind_to_self: true,
        pairing_id: created.pairing_id,
        pairing_secret: SECRET_HEX,
      },
    })
    assert.equal(bound.statusCode, 200, bound.body)
    assert.equal(sqliteRows(sqlitePath).device.expires_at - sqliteRows(sqlitePath).device.paired_at, 90 * 86400)
  })

  test('create/commit/status/bind fail closed at expires_at', async (t) => {
    const clock = freezeNow(t)
    enablePairing(t)
    const sqlitePath = sqliteFile(t, 'kaola-pairing-expired-')
    const app = await createApp(t, sqlitePath)
    const admin = await ensureSetup(app)
    const identity = generateDeviceIdentity()
    const created = await createAndCommit(app, identity)
    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/pending',
      cookies: admin.cookies,
      headers: { accept: 'application/json' },
    })
    const row = jsonBody(pending).devices[0]

    clock.advanceMs(86400 * 1000)
    const recover = await signedJson(app, identity, {
      url: '/api/v1/device-pairings',
      payload: { client_nonce: clientNonce() },
    })
    assert.equal(recover.statusCode, 201, recover.body)
    assert.notEqual(jsonBody(recover).pairing_id, created.pairing_id)
    const newExpires = Math.floor(Date.parse(jsonBody(recover).expires_at) / 1000)
    assert.equal(newExpires - clock.unix(), 86400)

    const commitExpired = await signedJson(app, identity, {
      url: `/api/v1/device-pairings/${created.pairing_id}/commit`,
      payload: { commitment: commitmentOf(created, SECRET_HEX) },
    })
    assert.equal(commitExpired.statusCode, 409, commitExpired.body)
    assert.equal(jsonBody(commitExpired).error, 'pairing_expired')

    const bindExpired = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${row.id}/bind`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: {
        bind_to_self: true,
        pairing_id: created.pairing_id,
        pairing_secret: SECRET_HEX,
      },
    })
    assert.equal(bindExpired.statusCode, 409, bindExpired.body)
    assert.equal(jsonBody(bindExpired).error, 'pairing_expired')
  })

  test('leftover ktk_ Bearer, session cookie, and missing device proof cannot create a pairing', async (t) => {
    freezeNow(t)
    enablePairing(t)
    const app = await createApp(t)
    const admin = await ensureSetup(app)
    const fake = `ktk_${'ab'.repeat(32)}`
    const leftover = await app.inject({
      method: 'POST',
      url: '/api/v1/device-pairings',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${fake}` },
      payload: { client_nonce: clientNonce() },
    })
    assert.equal(leftover.statusCode, 401, leftover.body)
    assert.equal(leftover.headers['www-authenticate'], 'Kaola-Device')
    assert.equal(jsonBody(leftover).error, 'unauthorized')

    const cookieOnly = await app.inject({
      method: 'POST',
      url: '/api/v1/device-pairings',
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: { client_nonce: clientNonce() },
    })
    assert.equal(cookieOnly.statusCode, 401, cookieOnly.body)
    assert.equal(jsonBody(cookieOnly).error, 'unauthorized')
  })

  test('pairing create ignores leftover Authorization even with device proof; does not Set-Cookie or leak the secret', async (t) => {
    freezeNow(t)
    enablePairing(t)
    const app = await createApp(t)
    const identity = generateDeviceIdentity()
    const fake = `ktk_${'cd'.repeat(32)}`
    const rejected = await injectSigned(app, identity, {
      method: 'POST',
      url: '/api/v1/device-pairings',
      payload: { client_nonce: clientNonce() },
      extraHeaders: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${fake}`,
      },
    })
    assert.equal(rejected.statusCode, 401, rejected.body)
    assert.equal(rejected.headers['www-authenticate'], 'Kaola-Device')

    const created = await signedJson(app, identity, {
      url: '/api/v1/device-pairings',
      payload: { client_nonce: clientNonce() },
    })
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.headers['set-cookie'], undefined)
    const body = jsonBody(created)
    assert.equal(Object.hasOwn(body, 'pairing_secret'), false)
    assert.equal(Object.hasOwn(body, 'secret'), false)
    assert.equal(Object.hasOwn(body, 'commitment'), false)
    assert.equal(Object.hasOwn(body, 'token'), false)
    assert.equal(String(created.body).includes(SECRET_HEX), false)
  })

  test('invalid client_nonce is 400; mismatched commitment is 409; identical commit is idempotent', async (t) => {
    freezeNow(t)
    enablePairing(t)
    const app = await createApp(t)
    const identity = generateDeviceIdentity()
    const badNonce = await signedJson(app, identity, {
      url: '/api/v1/device-pairings',
      payload: { client_nonce: 'aa' },
    })
    assert.equal(badNonce.statusCode, 400, badNonce.body)
    assert.equal(jsonBody(badNonce).error, 'invalid_body')

    const createdRes = await signedJson(app, identity, {
      url: '/api/v1/device-pairings',
      payload: { client_nonce: clientNonce() },
    })
    const created = jsonBody(createdRes)
    const commitUrl = `/api/v1/device-pairings/${created.pairing_id}/commit`
    const first = await signedJson(app, identity, {
      url: commitUrl,
      payload: { commitment: commitmentOf(created, SECRET_HEX) },
    })
    assert.equal(first.statusCode, 200, first.body)
    assert.equal(jsonBody(first).status, 'committed')
    const again = await signedJson(app, identity, {
      url: commitUrl,
      payload: { commitment: commitmentOf(created, SECRET_HEX) },
    })
    assert.equal(again.statusCode, 200, again.body)
    const mismatch = await signedJson(app, identity, {
      url: commitUrl,
      payload: { commitment: commitmentOf(created, WRONG_SECRET_HEX) },
    })
    assert.equal(mismatch.statusCode, 409, mismatch.body)
    assert.equal(jsonBody(mismatch).error, 'pairing_commitment_mismatch')
  })

  test('already-active device cannot start a new pairing; must rotate instead', async (t) => {
    freezeNow(t)
    enablePairing(t)
    const app = await createApp(t)
    const admin = await ensureSetup(app)
    const identity = generateDeviceIdentity()
    const created = await createAndCommit(app, identity)
    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/pending',
      cookies: admin.cookies,
      headers: { accept: 'application/json' },
    })
    const row = jsonBody(pending).devices[0]
    const bound = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${row.id}/bind`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: {
        bind_to_self: true,
        pairing_id: created.pairing_id,
        pairing_secret: SECRET_HEX,
      },
    })
    assert.equal(bound.statusCode, 200, bound.body)
    const again = await signedJson(app, identity, {
      url: '/api/v1/device-pairings',
      payload: { client_nonce: clientNonce() },
    })
    assert.equal(again.statusCode, 409, again.body)
    assert.equal(jsonBody(again).error, 'conflict')
    assert.match(String(jsonBody(again).message), /根轮换/)
  })

  test('next-root and complete stay 202 for pending devices', async (t) => {
    freezeNow(t)
    enablePairing(t)
    const app = await createApp(t)
    const identity = generateDeviceIdentity()
    const created = await createAndCommit(app, identity)
    const nextRoot = await signedJson(app, identity, {
      url: '/api/v1/device-trust/next-root',
      payload: {},
    })
    assert.equal(nextRoot.statusCode, 202, nextRoot.body)
    const complete = await signedJson(app, identity, {
      url: `/api/v1/device-pairings/${created.pairing_id}/complete`,
      payload: {},
    })
    assert.equal(complete.statusCode, 202, complete.body)
  })
})
