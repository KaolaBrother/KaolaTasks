import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.ts'
import { ensureSetup } from './auth.test-helpers.ts'
import {
  DEVICE_PROOF_SKEW_SECONDS,
  deviceProofCanonical,
  generateDeviceIdentity,
  signedInjectHeaders,
} from './device-proof.test-helpers.ts'

const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'cd'.repeat(32)
const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const REPO_FULL_NAME = 'team/orders'
const INLINE_TOKEN = 'gitea-INLINE-ONE-OFF-TOKEN-zzq7'
const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' }
const MCP_PATH = '/api/mcp'
const FROZEN_MS = Date.UTC(2026, 7, 21, 4, 0, 0)
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function applyOauthTestEnv() {
  process.env.OAUTH_GITHUB_CLIENT_ID = 'test-github-client-id'
  process.env.OAUTH_GITHUB_CLIENT_SECRET = 'test-github-client-secret'
  process.env.OAUTH_GITLAB_CLIENT_ID = 'test-gitlab-client-id'
  process.env.OAUTH_GITLAB_CLIENT_SECRET = 'test-gitlab-client-secret'
  process.env.OAUTH_GITLAB_BASE_URL = GITLAB_BASE_URL
  process.env.OAUTH_GITEA_CLIENT_ID = 'test-gitea-client-id'
  process.env.OAUTH_GITEA_CLIENT_SECRET = 'test-gitea-client-secret'
  process.env.OAUTH_GITEA_BASE_URL = GITEA_BASE_URL
  process.env.SESSION_SECRET = '0'.repeat(32)
  process.env.PUBLIC_URL = 'http://localhost:3000'
  process.env.VAULT_MASTER_KEY = VAULT_MASTER_KEY_HEX
  delete process.env.KAOLA_ADMINS
}

applyOauthTestEnv()

const { buildApp } = await import('./app.ts')

const PROVIDERS = {
  gitlab: {
    decoratorName: 'gitlabOAuth2',
    startPath: '/login/gitlab',
    callbackPath: '/login/gitlab/callback',
  },
}

let tokenSeq = 0
function nextAccessToken(label) {
  tokenSeq += 1
  return `test-access-token-${label}-${tokenSeq}`
}

function cookieJar(response) {
  const jar = {}
  for (const cookie of response.cookies) {
    jar[cookie.name] = cookie.value
  }
  return jar
}

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

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function isRepoEndpoint(url) {
  return url.includes('/repos/') || url.includes('/projects/')
}

function isUserEndpoint(url) {
  return url.endsWith('/user')
}

function stubTokenExchange(app, decoratorName, accessToken) {
  const oauth = app[decoratorName]
  assert.equal(
    typeof oauth?.getAccessTokenFromAuthorizationCodeFlow,
    'function',
    `${decoratorName}.getAccessTokenFromAuthorizationCodeFlow must exist so tests can stub token exchange`,
  )
  oauth.getAccessTokenFromAuthorizationCodeFlow = async () => ({
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
    },
  })
}

function sqliteFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-devices-'))
  const sqlitePath = join(dir, 'kaola.sqlite')
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return sqlitePath
}

async function createApp(t, sqlitePath) {
  const app = buildApp(sqlitePath ? { sqlitePath } : undefined)
  t.after(async () => {
    await app.close()
  })
  await app.ready()
  return app
}

function openDb(t, sqlitePath) {
  const db = createDb(sqlitePath)
  t.after(() => {
    db.$client.close()
  })
  return db
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

async function loginViaCallback(app, { decoratorName, callbackPath, accessToken }) {
  stubTokenExchange(app, decoratorName, accessToken)
  const callback = await app.inject({
    method: 'GET',
    url: `${callbackPath}?code=test-authorization-code`,
  })
  assert.ok(
    callback.statusCode >= 200 && callback.statusCode < 400,
    `expected ${callbackPath} to complete login, got ${callback.statusCode}: ${callback.body}`,
  )
  const cookies = cookieJar(callback)
  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    cookies,
    headers: { accept: 'application/json' },
  })
  assert.equal(me.statusCode, 200, `GET /api/v1/me after callback: ${me.statusCode} ${me.body}`)
  return { callback, cookies, me, body: me.json() }
}

async function loginGitlab(app, stub, label = 'gitlab') {
  await ensureSetup(app)
  const accessToken = nextAccessToken(label)
  stub.oauth.set(accessToken, {
    id: 80000 + tokenSeq,
    username: `gl-${label}`,
    name: `Git Lab ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })
}

function jsonBody(res) {
  try {
    return res.json()
  } catch {
    return null
  }
}

function taskPayload(overrides = {}) {
  return {
    title: '为订单导出接口增加分页',
    description_md: '……（Markdown 详述）',
    source: { type: 'native' },
    repo: {
      forge: 'gitea',
      base_url: FORGE_BASE_URL,
      full_name: REPO_FULL_NAME,
      base_branch: 'main',
      suggested_dir: 'orders',
    },
    acceptance_criteria: ['GET /api/orders/export 支持 page/page_size 参数'],
    test_command: 'pnpm test',
    constraints: { allowed_paths: ['src/api/**'], forbidden_paths: ['migrations/**'] },
    priority: 'P1',
    tags: ['backend'],
    credential: { token: INLINE_TOKEN },
    ...overrides,
  }
}

async function createTaskOk(app, cookies, payload = taskPayload()) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    cookies,
    headers: JSON_HEADERS,
    payload,
  })
  assert.equal(res.statusCode, 201, `POST /api/v1/tasks: ${res.statusCode} ${res.body}`)
  return { res, brief: jsonBody(res) }
}

const REPO_FULL_ACCESS = {
  permissions: { pull: true, push: true, admin: false },
  has_pull_requests: true,
  private: true,
}

function beginFetch(t) {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const oauth = new Map()
  const forge = new Map()
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    const token = stubbedToken(input, init)
    const forgeStub = token == null ? undefined : forge.get(token)
    if (forgeStub != null) {
      if (forgeStub.unreachable) {
        throw new TypeError('fetch failed')
      }
      if (isRepoEndpoint(url)) {
        const status = forgeStub.repoStatus ?? 200
        if (status !== 200) return jsonResponse(status, { message: 'Not Found' })
        return jsonResponse(200, forgeStub.repo ?? {}, forgeStub.repoHeaders ?? {})
      }
      if (isUserEndpoint(url)) {
        const status = forgeStub.userStatus ?? 200
        return jsonResponse(status, { id: 4242, login: 'forge-bot' })
      }
      return jsonResponse(500, { error: 'unstubbed forge endpoint', url })
    }
    const profile = token == null ? undefined : oauth.get(token)
    if (profile != null) return jsonResponse(200, profile)
    return jsonResponse(500, { error: 'unstubbed fetch', url, token: token ?? null })
  }
  return { oauth, forge }
}

function allowForgeToken(stub, token, descriptor = { repo: REPO_FULL_ACCESS }) {
  stub.forge.set(token, descriptor)
}

async function boot(t, sqlitePath) {
  const app = await createApp(t, sqlitePath)
  const stub = beginFetch(t)
  allowForgeToken(stub, INLINE_TOKEN)
  return { app, stub }
}

function assertDeviceUnauthorized(res) {
  assert.equal(res.statusCode, 401, `expected 401 unauthorized, got ${res.statusCode}: ${res.body}`)
  assert.equal(jsonBody(res)?.error, 'unauthorized')
  assert.match(String(res.headers['www-authenticate'] ?? ''), /Kaola-Device/)
}

function assertAuthorizationRequired(res) {
  assert.equal(res.statusCode, 202, `expected 202 authorization_required, got ${res.statusCode}: ${res.body}`)
  const body = jsonBody(res)
  assert.equal(body.error, 'authorization_required')
  assert.equal(body.pending, true)
  assert.equal(typeof body.expires_at, 'string')
  assert.match(String(body.expires_at), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(Object.hasOwn(body, 'token'), false, `202 must omit forge token: ${res.body}`)
  assert.notEqual(body.error, 'confirmation_required')
  return body
}

function assertNoForgeToken(res, plaintext = INLINE_TOKEN) {
  assert.equal(String(res.body).includes(plaintext), false, `response leaked forge token: ${res.body}`)
  const body = jsonBody(res)
  if (body && typeof body === 'object') {
    assert.equal(Object.hasOwn(body, 'token'), false, `body must omit token: ${res.body}`)
  }
}

function mcpInitializePayload() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'kaola-device-test', version: '0.0.0' },
    },
  }
}

function mcpListTasksPayload(id = 2) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'list_tasks', arguments: {} },
  }
}

async function signedPost(app, { identity, url, payload, hostname, nowSeconds }) {
  const body = JSON.stringify(payload ?? {})
  const headers = signedInjectHeaders({
    identity,
    method: 'POST',
    pathname: url,
    payload: body,
    hostname,
    nowSeconds,
    extra: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
  })
  return app.inject({
    method: 'POST',
    url,
    headers,
    payload: body,
  })
}

async function signedClaim(app, { identity, publicId, hostname, nowSeconds }) {
  return signedPost(app, {
    identity,
    url: `/api/v1/tasks/${publicId}/claim`,
    payload: {},
    hostname,
    nowSeconds,
  })
}

async function listPendingDevices(app, cookies) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/devices/pending',
    cookies,
    headers: { accept: 'application/json' },
  })
}

async function bindDevice(app, cookies, deviceId, payload) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/bind`,
    cookies,
    headers: JSON_HEADERS,
    payload,
  })
}

describe('device proof canonical string', () => {
  test('canonical payload is five newline-separated lines with no trailing newline after the hash', () => {
    const pinned = deviceProofCanonical({
      ts: 1700000000,
      nonce: 'aabbccddeeff00112233445566778899',
      method: 'POST',
      pathname: '/api/mcp',
      body: '',
    })
    assert.equal(
      pinned,
      `kaola-device-v1\n1700000000\naabbccddeeff00112233445566778899\nPOST\n/api/mcp\n${EMPTY_BODY_SHA256}`,
    )
    assert.equal(pinned.endsWith('\n'), false)
    assert.equal(DEVICE_PROOF_SKEW_SECONDS, 300)
  })
})

describe('issue #23 device proof + admin bind', { concurrency: false }, () => {
  test('signed unknown device on MCP initialize is 202 authorization_required, no token, creates pending', async (t) => {
    freezeNow(t)
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const admin = await ensureSetup(app) // was loginGitlab( 'mcp-pending-admin')
    const identity = generateDeviceIdentity()

    const res = await signedPost(app, {
      identity,
      url: MCP_PATH,
      payload: mcpInitializePayload(),
      hostname: 'laptop.example',
    })
    const body = assertAuthorizationRequired(res)
    assertNoForgeToken(res)

    const pending = await listPendingDevices(app, admin.cookies)
    assert.equal(pending.statusCode, 200, `GET pending: ${pending.statusCode} ${pending.body}`)
    const devices = jsonBody(pending).devices
    assert.ok(Array.isArray(devices))
    assert.equal(devices.length, 1)
    assert.equal(devices[0].fingerprint, identity.fingerprint)
    assert.equal(devices[0].hostname, 'laptop.example')
    assert.equal(devices[0].expires_at, body.expires_at)
    assert.equal(Object.hasOwn(devices[0], 'public_key'), false)
  })

  test('signed unknown device on REST claim is 202 authorization_required, no token, no lease', async (t) => {
    freezeNow(t)
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const admin = await ensureSetup(app) // was loginGitlab( 'claim-pending-admin')
    const { brief } = await createTaskOk(app, admin.cookies)
    const identity = generateDeviceIdentity()

    const res = await signedClaim(app, { identity, publicId: brief.id, hostname: 'ci-box' })
    assertAuthorizationRequired(res)
    assertNoForgeToken(res)

    const db = openDb(t, sqlitePath)
    const leases = db.$client.prepare('SELECT * FROM leases').all()
    assert.equal(leases.length, 0, `unpaired claim must not insert a lease: ${JSON.stringify(leases)}`)
    const task = db.$client.prepare('SELECT status FROM tasks WHERE public_id = ?').get(brief.id)
    assert.equal(task.status, '待认领')
  })

  test('retry of the same pending device does not extend pending expires_at', async (t) => {
    const clock = freezeNow(t)
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const admin = await ensureSetup(app) // was loginGitlab( 'retry-pending-admin')
    const identity = generateDeviceIdentity()

    const first = await signedPost(app, {
      identity,
      url: MCP_PATH,
      payload: mcpInitializePayload(),
      nowSeconds: clock.unix(),
    })
    const firstBody = assertAuthorizationRequired(first)
    clock.advanceMs(60_000)
    const second = await signedPost(app, {
      identity,
      url: MCP_PATH,
      payload: mcpInitializePayload(),
      nowSeconds: clock.unix(),
    })
    const secondBody = assertAuthorizationRequired(second)
    assert.equal(secondBody.expires_at, firstBody.expires_at)

    const pending = await listPendingDevices(app, admin.cookies)
    assert.equal(jsonBody(pending).devices.length, 1)
    assert.equal(jsonBody(pending).devices[0].expires_at, firstBody.expires_at)
  })

  test('missing device headers on MCP is 401 unauthorized, not 202', async (t) => {
    const { app } = await boot(t)
    const res = await app.inject({
      method: 'POST',
      url: MCP_PATH,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      payload: mcpInitializePayload(),
    })
    assertDeviceUnauthorized(res)
    assert.notEqual(res.statusCode, 202)
    assert.notEqual(jsonBody(res)?.error, 'authorization_required')
  })

  test('bad signature on an otherwise complete proof is 401 unauthorized, not 202', async (t) => {
    const { app } = await boot(t)
    const identity = generateDeviceIdentity()
    const body = JSON.stringify(mcpInitializePayload())
    const headers = signedInjectHeaders({
      identity,
      method: 'POST',
      pathname: MCP_PATH,
      payload: body,
      extra: { accept: 'application/json', 'content-type': 'application/json' },
    })
    headers['x-kaola-sig'] = Buffer.alloc(64).toString('base64')
    const res = await app.inject({
      method: 'POST',
      url: MCP_PATH,
      headers,
      payload: body,
    })
    assertDeviceUnauthorized(res)
    assert.notEqual(jsonBody(res)?.error, 'authorization_required')
  })

  test('leftover ktk_ Bearer is not MCP identity: 401, not 202', async (t) => {
    const { app } = await boot(t)
    const fake = `ktk_${'ab'.repeat(32)}`
    const res = await app.inject({
      method: 'POST',
      url: MCP_PATH,
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${fake}`,
      },
      payload: mcpListTasksPayload(),
    })
    assert.equal(res.statusCode, 401, `ktk_ must not authenticate MCP, got ${res.statusCode}: ${res.body}`)
    assert.equal(jsonBody(res)?.error, 'unauthorized')
    assert.notEqual(res.statusCode, 202)
  })

  test('full session lists pending; bind { claimant_display_name } does not claim and does not return a forge token', async (t) => {
    freezeNow(t)
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const admin = await ensureSetup(app) // was loginGitlab( 'bind-display-admin')
    assert.equal(admin.body.permission_level, 'admin')
    const { brief } = await createTaskOk(app, admin.cookies)
    const identity = generateDeviceIdentity()

    assertAuthorizationRequired(await signedClaim(app, { identity, publicId: brief.id, hostname: 'ada-laptop' }))
    const listed = await listPendingDevices(app, admin.cookies)
    assert.equal(listed.statusCode, 200, `GET pending: ${listed.statusCode} ${listed.body}`)
    const row = jsonBody(listed).devices[0]
    assert.equal(row.fingerprint, identity.fingerprint)

    const bound = await bindDevice(app, admin.cookies, row.id, { claimant_display_name: 'Ada Claimant' })
    assert.equal(bound.statusCode, 200, `POST bind: ${bound.statusCode} ${bound.body}`)
    const boundBody = jsonBody(bound)
    assert.equal(boundBody.ok, true)
    assert.equal(Number(boundBody.device_id), Number(row.id))
    assert.equal(boundBody.owner?.kind, 'claimant')
    assertNoForgeToken(bound)
    assert.equal(Object.hasOwn(boundBody, 'token'), false)
    assert.equal(Object.hasOwn(boundBody, 'lease'), false)

    const db = openDb(t, sqlitePath)
    const task = db.$client.prepare('SELECT status FROM tasks WHERE public_id = ?').get(brief.id)
    assert.equal(task.status, '待认领', 'bind must not claim the task')
    assert.equal(db.$client.prepare('SELECT * FROM leases').all().length, 0)
  })

  test('after bind, the same keypair claim is 201 with a forge token', async (t) => {
    freezeNow(t)
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const admin = await ensureSetup(app) // was loginGitlab( 'bind-then-claim-admin')
    const { brief } = await createTaskOk(app, admin.cookies)
    const identity = generateDeviceIdentity()

    assertAuthorizationRequired(await signedClaim(app, { identity, publicId: brief.id }))
    const listed = await listPendingDevices(app, admin.cookies)
    const row = jsonBody(listed).devices[0]
    const bound = await bindDevice(app, admin.cookies, row.id, { claimant_display_name: 'Claim Bot' })
    assert.equal(bound.statusCode, 200, `bind: ${bound.statusCode} ${bound.body}`)

    const claimed = await signedClaim(app, { identity, publicId: brief.id })
    assert.equal(claimed.statusCode, 201, `bound claim: ${claimed.statusCode} ${claimed.body}`)
    assert.equal(jsonBody(claimed).token, INLINE_TOKEN)
  })

  test('bind { bind_to_self: true } works', async (t) => {
    freezeNow(t)
    const { app, stub } = await boot(t)
    const admin = await ensureSetup(app) // was loginGitlab( 'bind-self-admin')
    const identity = generateDeviceIdentity()
    assertAuthorizationRequired(
      await signedPost(app, { identity, url: MCP_PATH, payload: mcpInitializePayload() }),
    )
    const listed = await listPendingDevices(app, admin.cookies)
    const row = jsonBody(listed).devices[0]
    const bound = await bindDevice(app, admin.cookies, row.id, { bind_to_self: true })
    assert.equal(bound.statusCode, 200, `bind_to_self: ${bound.statusCode} ${bound.body}`)
    assert.equal(jsonBody(bound).ok, true)
    assert.equal(jsonBody(bound).owner?.kind, 'user')
    assert.equal(Number(jsonBody(bound).owner?.user_id), Number(admin.body.id))
  })

  test('bind to existing claimant_id', async (t) => {
    freezeNow(t)
    const { app, stub } = await boot(t)
    const admin = await ensureSetup(app) // was loginGitlab( 'bind-existing-admin')
    const firstId = generateDeviceIdentity()
    const secondId = generateDeviceIdentity()

    assertAuthorizationRequired(
      await signedPost(app, { identity: firstId, url: MCP_PATH, payload: mcpInitializePayload() }),
    )
    const firstList = await listPendingDevices(app, admin.cookies)
    const firstBind = await bindDevice(app, admin.cookies, jsonBody(firstList).devices[0].id, {
      claimant_display_name: 'Shared Claimant',
    })
    assert.equal(firstBind.statusCode, 200, `first bind: ${firstBind.statusCode} ${firstBind.body}`)
    const claimantId = jsonBody(firstBind).owner?.claimant_id
    assert.ok(Number.isInteger(Number(claimantId)) && Number(claimantId) > 0)

    assertAuthorizationRequired(
      await signedPost(app, { identity: secondId, url: MCP_PATH, payload: mcpInitializePayload() }),
    )
    const secondList = await listPendingDevices(app, admin.cookies)
    const secondRow = jsonBody(secondList).devices.find((d) => d.fingerprint === secondId.fingerprint)
    assert.ok(secondRow, `second pending missing: ${secondList.body}`)
    const secondBind = await bindDevice(app, admin.cookies, secondRow.id, { claimant_id: Number(claimantId) })
    assert.equal(secondBind.statusCode, 200, `second bind: ${secondBind.statusCode} ${secondBind.body}`)
    assert.equal(Number(jsonBody(secondBind).owner?.claimant_id), Number(claimantId))
  })

  test('non-full leftover claim_only session cannot bind (403)', async (t) => {
    freezeNow(t)
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const admin = await ensureSetup(app) // was loginGitlab( 'full-for-pending')
    const identity = generateDeviceIdentity()
    assertAuthorizationRequired(
      await signedPost(app, { identity, url: MCP_PATH, payload: mcpInitializePayload() }),
    )
    const listed = await listPendingDevices(app, admin.cookies)
    const row = jsonBody(listed).devices[0]

    const db = openDb(t, sqlitePath)
    db.$client
      .prepare(
        `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
         VALUES ('gitlab', '9001', 'leftover-claim', 'Leftover Claim', 'active', 'claim_only', 0)`,
      )
      .run()

    const leftoverToken = nextAccessToken('leftover-claim-login')
    stub.oauth.set(leftoverToken, { id: 9001, username: 'leftover-claim', name: 'Leftover Claim' })
    const leftoverLogin = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: leftoverToken })
    assert.equal(leftoverLogin.body.permission_level, 'claim_only')

    const deniedList = await listPendingDevices(app, leftoverLogin.cookies)
    assert.equal(deniedList.statusCode, 403, `claim_only GET pending: ${deniedList.statusCode} ${deniedList.body}`)
    const deniedBind = await bindDevice(app, leftoverLogin.cookies, row.id, { bind_to_self: true })
    assert.equal(deniedBind.statusCode, 403, `claim_only bind: ${deniedBind.statusCode} ${deniedBind.body}`)
    assert.equal(jsonBody(deniedBind)?.error, 'forbidden')
  })

  test('revoke claimant → next proof is 403, no token', async (t) => {
    freezeNow(t)
    const { app, stub } = await boot(t)
    const admin = await ensureSetup(app) // was loginGitlab( 'revoke-claimant-admin')
    const { brief } = await createTaskOk(app, admin.cookies)
    const identity = generateDeviceIdentity()
    assertAuthorizationRequired(await signedClaim(app, { identity, publicId: brief.id }))
    const listed = await listPendingDevices(app, admin.cookies)
    const bound = await bindDevice(app, admin.cookies, jsonBody(listed).devices[0].id, {
      claimant_display_name: 'Soon Revoked',
    })
    assert.equal(bound.statusCode, 200)
    const claimantId = jsonBody(bound).owner.claimant_id

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/claimants/${claimantId}/revoke`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: {},
    })
    assert.equal(revoked.statusCode, 200, `revoke claimant: ${revoked.statusCode} ${revoked.body}`)
    assert.equal(jsonBody(revoked).ok, true)

    const next = await signedClaim(app, { identity, publicId: brief.id })
    assert.equal(next.statusCode, 403, `revoked claimant proof: ${next.statusCode} ${next.body}`)
    assertNoForgeToken(next)
    assert.notEqual(next.statusCode, 201)
  })

  test('revoke device → next proof is 403', async (t) => {
    freezeNow(t)
    const { app, stub } = await boot(t)
    const admin = await ensureSetup(app) // was loginGitlab( 'revoke-device-admin')
    const { brief } = await createTaskOk(app, admin.cookies)
    const identity = generateDeviceIdentity()
    assertAuthorizationRequired(await signedClaim(app, { identity, publicId: brief.id }))
    const listed = await listPendingDevices(app, admin.cookies)
    const row = jsonBody(listed).devices[0]
    assert.equal((await bindDevice(app, admin.cookies, row.id, { bind_to_self: true })).statusCode, 200)

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${row.id}/revoke`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: {},
    })
    assert.equal(revoked.statusCode, 200, `revoke device: ${revoked.statusCode} ${revoked.body}`)
    assert.equal(jsonBody(revoked).ok, true)

    const next = await signedClaim(app, { identity, publicId: brief.id })
    assert.equal(next.statusCode, 403, `revoked device proof: ${next.statusCode} ${next.body}`)
    assertNoForgeToken(next)
  })

  test('max_devices 409; PATCH max age does not rewrite existing expires_at', async (t) => {
    freezeNow(t)
    const { app, stub } = await boot(t)
    const admin = await ensureSetup(app) // was loginGitlab( 'policy-admin')
    const first = generateDeviceIdentity()
    const extra = generateDeviceIdentity()
    assertAuthorizationRequired(
      await signedPost(app, { identity: first, url: MCP_PATH, payload: mcpInitializePayload() }),
    )
    const listed = await listPendingDevices(app, admin.cookies)
    const row = jsonBody(listed).devices[0]
    const bound = await bindDevice(app, admin.cookies, row.id, { claimant_display_name: 'Capped' })
    assert.equal(bound.statusCode, 200)
    const claimantId = jsonBody(bound).owner.claimant_id

    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      cookies: admin.cookies,
      headers: { accept: 'application/json' },
    })
    assert.equal(mine.statusCode, 200, `GET devices: ${mine.statusCode} ${mine.body}`)
    const boundRow = jsonBody(mine).devices.find((d) => Number(d.id) === Number(row.id))
    assert.ok(boundRow, `bound device missing from GET /api/v1/devices: ${mine.body}`)
    const originalExpires = boundRow.expires_at
    assert.equal(typeof originalExpires, 'string')

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/claimants/${claimantId}/settings`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: { device_max_age_days: 7, max_devices: 1 },
    })
    assert.equal(patched.statusCode, 200, `PATCH settings: ${patched.statusCode} ${patched.body}`)
    assert.equal(jsonBody(patched).device_max_age_days, 7)
    assert.equal(jsonBody(patched).max_devices, 1)

    const afterPatch = await app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      cookies: admin.cookies,
      headers: { accept: 'application/json' },
    })
    const still = jsonBody(afterPatch).devices.find((d) => Number(d.id) === Number(row.id))
    assert.equal(still.expires_at, originalExpires, 'PATCH max age must not rewrite existing expires_at')

    assertAuthorizationRequired(
      await signedPost(app, { identity: extra, url: MCP_PATH, payload: mcpInitializePayload() }),
    )
    const pending = await listPendingDevices(app, admin.cookies)
    const extraRow = jsonBody(pending).devices.find((d) => d.fingerprint === extra.fingerprint)
    const overflow = await bindDevice(app, admin.cookies, extraRow.id, { claimant_id: claimantId })
    assert.equal(overflow.statusCode, 409, `max_devices: ${overflow.statusCode} ${overflow.body}`)
    assert.equal(jsonBody(overflow).error, 'conflict')
  })

  test('GET /api/v1/agent/whoami after bind_to_self returns the device owner, never a forge token', async (t) => {
    freezeNow(t)
    const { app, stub } = await boot(t)
    const admin = await ensureSetup(app) // was loginGitlab( 'whoami-admin')
    const identity = generateDeviceIdentity()
    assertAuthorizationRequired(
      await signedPost(app, { identity, url: MCP_PATH, payload: mcpInitializePayload() }),
    )
    const listed = await listPendingDevices(app, admin.cookies)
    const row = jsonBody(listed).devices[0]
    assert.equal((await bindDevice(app, admin.cookies, row.id, { bind_to_self: true })).statusCode, 200)

    const whoami = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/whoami',
      headers: signedInjectHeaders({
        identity,
        method: 'GET',
        pathname: '/api/v1/agent/whoami',
        payload: '',
        extra: { accept: 'application/json' },
      }),
    })
    assert.equal(whoami.statusCode, 200, `whoami: ${whoami.statusCode} ${whoami.body}`)
    const who = jsonBody(whoami)
    assert.equal(Number(who.device_id), Number(row.id))
    assert.equal(who.fingerprint, identity.fingerprint)
    assert.equal(who.status, 'active')
    assert.equal(who.owner?.kind, 'user')
    assert.equal(Number(who.owner?.user_id), Number(admin.body.id))
    assert.equal(Object.hasOwn(who, 'token'), false)
    assertNoForgeToken(whoami)
  })

  test('pending whoami is the same 202 authorization_required as MCP', async (t) => {
    freezeNow(t)
    const { app } = await boot(t)
    const identity = generateDeviceIdentity()
    const whoami = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/whoami',
      headers: signedInjectHeaders({
        identity,
        method: 'GET',
        pathname: '/api/v1/agent/whoami',
        payload: '',
        extra: { accept: 'application/json' },
      }),
    })
    assertAuthorizationRequired(whoami)
    assertNoForgeToken(whoami)
  })

  test('pending device MCP list_tasks is HTTP 202 authorization_required, not a successful tool result', async (t) => {
    freezeNow(t)
    const { app, stub } = await boot(t)
    await ensureSetup(app)
    const identity = generateDeviceIdentity()
    assertAuthorizationRequired(
      await signedPost(app, { identity, url: MCP_PATH, payload: mcpInitializePayload() }),
    )
    const listed = await signedPost(app, { identity, url: MCP_PATH, payload: mcpListTasksPayload() })
    assertAuthorizationRequired(listed)
    assert.notEqual(listed.statusCode, 200)
  })
})
