import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectSigned, pairDeviceToSelf } from './device-proof.test-helpers.ts'
import { ensureSetup } from './auth.test-helpers.ts'

// Issue #15 — GET /api/v1/events + GET /api/v1/stats. Neither route exists yet (verified by
// grepping every app.get|post|patch|delete( call site in apps/server/src — see
// kaola-workflow/bundle-15-16/.cache/ground-truth.md). This suite pins the acceptance surface
// from kaola-workflow/bundle-15-16/.cache/orchestrator-rulings.md §15 and is expected to fail
// (route not found / 404) until `registerEvents` lands. Seams copied from claim.test.ts /
// tasks.test.ts (do not import those test files).

const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'ab'.repeat(32)

const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const REPO_FULL_NAME = 'team/orders'
const INLINE_TOKEN = 'gitea-EVENTS-INLINE-TOKEN-q7z1'

const TOKEN_REVEAL_EVENT = 'token 揭示'
const STATUS_TRANSITION_EVENT = '状态迁移'
const HEARTBEAT_EVENT = '心跳'
const SYSTEM_ACTOR_LABEL = '系统'
const COMPLETED_STATUS = '已完成'

const SECRET_KEY_NAMES = new Set(['token', 'token_encrypted', 'inline_token_encrypted', 'access_token'])

function applyOauthTestEnv() {
  process.env.OAUTH_GITHUB_CLIENT_ID = 'test-github-client-id'
  process.env.OAUTH_GITHUB_CLIENT_SECRET = 'test-github-client-secret'
  process.env.OAUTH_GITLAB_CLIENT_ID = 'test-gitlab-client-id'
  process.env.OAUTH_GITLAB_CLIENT_SECRET = 'test-gitlab-client-secret'
  process.env.OAUTH_GITLAB_BASE_URL = GITLAB_BASE_URL
  process.env.OAUTH_GITEA_CLIENT_ID = 'test-gitea-client-id'
  process.env.OAUTH_GITEA_CLIENT_SECRET = 'test-gitea-client-secret'
  process.env.OAUTH_GITEA_BASE_URL = GITEA_BASE_URL
  process.env.SESSION_SECRET = '1'.repeat(32)
  process.env.PUBLIC_URL = 'http://localhost:3000'
  process.env.VAULT_MASTER_KEY = VAULT_MASTER_KEY_HEX
}

applyOauthTestEnv()

const { buildApp } = await import('./app.ts')
const { createDb } = await import('./db.ts')

const PROVIDERS = {
  github: {
    decoratorName: 'githubOAuth2',
    callbackPath: '/login/github/callback',
  },
  gitea: {
    decoratorName: 'giteaOAuth2',
    callbackPath: '/login/gitea/callback',
  },
}

const jsonHeaders = { accept: 'application/json' }

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
      if (isRepoEndpoint(url)) {
        return jsonResponse(200, forgeStub.repo ?? {})
      }
      if (isUserEndpoint(url)) {
        return jsonResponse(200, { id: 4242, login: 'forge-bot' })
      }
      return jsonResponse(500, { error: 'unstubbed forge endpoint', url })
    }
    const profile = token == null ? undefined : oauth.get(token)
    if (profile != null) return jsonResponse(200, profile)
    return jsonResponse(500, { error: 'unstubbed fetch', url, token: token ?? null })
  }
  return { oauth, forge }
}

const REPO_FULL_ACCESS = {
  permissions: { pull: true, push: true, admin: false },
  has_pull_requests: true,
  private: true,
}

function allowForgeToken(stub, token, descriptor = { repo: REPO_FULL_ACCESS }) {
  stub.forge.set(token, descriptor)
}

function stubTokenExchange(app, decoratorName, accessToken) {
  const oauth = app[decoratorName]
  assert.equal(
    typeof oauth?.getAccessTokenFromAuthorizationCodeFlow,
    'function',
    `${decoratorName}.getAccessTokenFromAuthorizationCodeFlow must exist so tests can stub token exchange`,
  )
  oauth.getAccessTokenFromAuthorizationCodeFlow = async () => ({
    token: { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 },
  })
}

function sqliteFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-events-'))
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
    headers: jsonHeaders,
  })
  assert.equal(me.statusCode, 200, `GET /api/v1/me after callback: ${me.statusCode} ${me.body}`)
  return { cookies, body: me.json() }
}

async function loginGitea(app, stub, label = 'gitea') {
  void stub
  void label
  return ensureSetup(app)
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
    constraints: { allowed_paths: ['src/api/**'], forbidden_paths: [] },
    priority: 'P1',
    tags: ['backend'],
    credential: { token: INLINE_TOKEN },
    ...overrides,
  }
}

async function postTask(app, cookies, payload = taskPayload()) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    cookies,
    headers: jsonHeaders,
    payload,
  })
}

async function createTaskOk(app, cookies, payload = taskPayload()) {
  const res = await postTask(app, cookies, payload)
  assert.equal(res.statusCode, 201, `POST /api/v1/tasks: ${res.statusCode} ${res.body}`)
  return jsonBody(res)
}

function bearerHeaders(token) {
  return { accept: 'application/json', authorization: `Bearer ${token}` }
}

async function mintAgentKey(app, cookies, label = 'agent') {
  const paired = await pairDeviceToSelf(app, cookies, { hostname: label })
  return { id: paired.deviceId, identity: paired.identity, deviceId: paired.deviceId }
}

async function claimTask(app, { token, identity, publicId }) {
  const proof = identity ?? (token && typeof token === 'object' && token.privateKey ? token : null)
  if (proof != null) {
    return injectSigned(app, proof, {
      method: 'POST',
      url: `/api/v1/tasks/${publicId}/claim`,
      payload: {},
      extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
    })
  }
  return app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/claim`,
    headers: bearerHeaders(token),
  })
}

async function progressTask(app, { token, identity, publicId, payload }) {
  const proof = identity ?? (token && typeof token === 'object' && token.privateKey ? token : null)
  if (proof != null) {
    return injectSigned(app, proof, {
      method: 'POST',
      url: `/api/v1/tasks/${publicId}/progress`,
      payload: payload ?? {},
      extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
    })
  }
  const req = {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/progress`,
    headers: bearerHeaders(token),
  }
  if (payload !== undefined) req.payload = payload
  return app.inject(req)
}

async function getEvents(app, cookies) {
  return app.inject({ method: 'GET', url: '/api/v1/events', cookies, headers: jsonHeaders })
}

async function getStats(app, cookies) {
  return app.inject({ method: 'GET', url: '/api/v1/stats', cookies, headers: jsonHeaders })
}

function insertRawEvent(db, { type, actorUserId, createdAt, details }) {
  db.$client
    .prepare('INSERT INTO events (type, actor_user_id, created_at, details) VALUES (?, ?, ?, ?)')
    .run(type, actorUserId ?? null, createdAt, JSON.stringify(details))
}

function forceStatus(db, publicId, status) {
  const info = db.$client.prepare('UPDATE tasks SET status = ? WHERE public_id = ?').run(status, publicId)
  assert.equal(info.changes, 1, `expected to force ${publicId} into ${status}`)
}

function collectKeys(value, acc = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc)
    return acc
  }
  if (value != null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      acc.add(key)
      collectKeys(child, acc)
    }
  }
  return acc
}

// No forge plaintext, no secret key names anywhere in the response (including nested `details`).
function assertNoSecretMaterial(res, ...plaintexts) {
  const dumped = res.body
  for (const plaintext of plaintexts) {
    assert.equal(dumped.includes(plaintext), false, `response leaked plaintext ${plaintext}: ${dumped}`)
  }
  const parsed = jsonBody(res)
  for (const key of collectKeys(parsed)) {
    assert.equal(SECRET_KEY_NAMES.has(key), false, `response carried a secret-bearing key "${key}": ${dumped}`)
  }
}

function assertUnauthorized(res) {
  assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}: ${res.body}`)
  assert.deepEqual(jsonBody(res), { error: 'unauthorized' })
}

function eventsOfType(rows, type) {
  return rows.filter((row) => row.type === type)
}

function rowsForTask(rows, publicId) {
  return rows.filter((row) => row.details != null && row.details.task_id === publicId)
}

async function boot(t) {
  const app = await createApp(t)
  const stub = beginFetch(t)
  allowForgeToken(stub, INLINE_TOKEN)
  return { app, stub }
}

describe('issue #15 audit log HTTP + team stats', { concurrency: false }, () => {
  describe('authentication — session cookie, same mechanism as GET /api/v1/tasks', () => {
    test('unauthenticated GET /api/v1/events and GET /api/v1/stats are 401 unauthorized', async (t) => {
      const { app } = await boot(t)
      assertUnauthorized(await getEvents(app, {}))
      assertUnauthorized(await getStats(app, {}))
    })

    test('待批准 GitHub user is 401 on events and stats (never sees the member workbench)', async (t) => {
      const sqlitePath = sqliteFile(t)
      const db = openDb(t, sqlitePath)
      db.$client
        .prepare(
          `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
           VALUES ('gitlab', '2222', 'gl-events-pending', 'Pending Events', '待批准', 'claim_only', 0)`,
        )
        .run()
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const leftoverToken = nextAccessToken('events-pending')
      stub.oauth.set(leftoverToken, { id: 2222, username: 'gl-events-pending', name: 'Pending Events' })
      await ensureSetup(app)
      const pending = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: leftoverToken })
      assert.equal(pending.body.status, '待批准')

      assertUnauthorized(await getEvents(app, pending.cookies))
      assertUnauthorized(await getStats(app, pending.cookies))
    })

    test('approved claim_only user can read events and stats, same as the board', async (t) => {
      const sqlitePath = sqliteFile(t)
      const db = openDb(t, sqlitePath)
      db.$client
        .prepare(
          `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
           VALUES ('gitlab', '3333', 'gl-events-claim-only', 'Claim Only Events', 'active', 'claim_only', 0)`,
        )
        .run()
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const owner = await loginGitea(app, stub, 'events-owner')
      const leftoverToken = nextAccessToken('events-claim-only')
      stub.oauth.set(leftoverToken, { id: 3333, username: 'gl-events-claim-only', name: 'Claim Only Events' })
      const leftover = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: leftoverToken })
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        cookies: leftover.cookies,
        headers: jsonHeaders,
      })
      assert.equal(me.json().status, 'active')
      assert.equal(me.json().permission_level, 'claim_only')
      assert.notEqual(Number(leftover.body.id), Number(owner.body.id))

      const events = await getEvents(app, leftover.cookies)
      assert.equal(events.statusCode, 200, `claim_only GET events: ${events.statusCode} ${events.body}`)

      const stats = await getStats(app, leftover.cookies)
      assert.equal(stats.statusCode, 200, `claim_only GET stats: ${stats.statusCode} ${stats.body}`)
    })
  })

  describe('GET /api/v1/events', () => {
    test('envelope is { events: [] } with newest-first EventRow shape; no query string needed', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'events-shape')
      const { brief } = await pipeAndClaim(app, poster.cookies)

      const res = await getEvents(app, poster.cookies)
      assert.equal(res.statusCode, 200, `GET /api/v1/events: ${res.statusCode} ${res.body}`)
      const body = jsonBody(res)
      assert.deepEqual(Object.keys(body).sort(), ['events'])
      assert.ok(Array.isArray(body.events))
      assert.ok(body.events.length > 0)

      for (const row of body.events) {
        assert.deepEqual(
          Object.keys(row).sort(),
          ['actor_user_id', 'actor_username', 'created_at', 'details', 'id', 'type'],
          `unexpected EventRow shape: ${JSON.stringify(row)}`,
        )
        assert.equal(typeof row.id, 'number')
        assert.equal(typeof row.type, 'string')
        assert.equal(typeof row.created_at, 'string')
        assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
        assert.equal(typeof row.details, 'object', `details must be parsed JSON, not a string: ${JSON.stringify(row)}`)
        assert.ok(row.details != null)
        assert.ok(!Array.isArray(row.details))
      }

      const ids = body.events.map((row) => row.id)
      for (let i = 1; i < ids.length; i += 1) {
        assert.ok(ids[i - 1] > ids[i], `expected newest-first (id desc), got ${JSON.stringify(ids)}`)
      }

      const taskRows = rowsForTask(body.events, brief.id)
      assert.ok(taskRows.length >= 2, `expected reveal+transition rows for ${brief.id}`)
    })

    test('list carries real writers rows with parsed details and actor_username resolved via left-join', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'events-writers')
      const { brief, key } = await pipeAndClaim(app, poster.cookies)

      const progressed = await progressTask(app, { token: key.identity, publicId: brief.id, payload: { note: '写测试' } })
      assert.equal(progressed.statusCode, 200, `progress: ${progressed.statusCode} ${progressed.body}`)

      const res = await getEvents(app, poster.cookies)
      const rows = jsonBody(res).events
      const forTask = rowsForTask(rows, brief.id)

      const reveal = eventsOfType(forTask, TOKEN_REVEAL_EVENT)
      assert.equal(reveal.length, 1)
      assert.equal(reveal[0].actor_user_id, poster.body.id)
      assert.equal(reveal[0].actor_username, poster.body.username)
      assert.deepEqual(reveal[0].details, {
        task_id: brief.id,
        device_id: key.id,
        credential: 'inline',
      })

      const transitions = eventsOfType(forTask, STATUS_TRANSITION_EVENT)
      assert.equal(transitions.length, 1)
      assert.equal(transitions[0].actor_user_id, poster.body.id)
      assert.equal(transitions[0].actor_username, poster.body.username)
      assert.deepEqual(transitions[0].details, { task_id: brief.id, from: '待认领', to: '进行中' })

      const heartbeats = eventsOfType(forTask, HEARTBEAT_EVENT)
      assert.equal(heartbeats.length, 1)
      assert.equal(heartbeats[0].actor_user_id, poster.body.id)
      assert.equal(heartbeats[0].actor_username, poster.body.username)
      assert.deepEqual(heartbeats[0].details, { task_id: brief.id, note: '写测试' })

      assertNoSecretMaterial(res, INLINE_TOKEN)
    })

    test('system-driven rows (actor_user_id null) still appear, with actor_username null', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'events-system-row')
      const brief = await createTaskOk(app, poster.cookies)

      const db = openDb(t, sqlitePath)
      insertRawEvent(db, {
        type: STATUS_TRANSITION_EVENT,
        actorUserId: null,
        createdAt: Math.floor(Date.now() / 1000),
        details: { task_id: brief.id, from: '进行中', to: '待认领' },
      })

      const res = await getEvents(app, poster.cookies)
      const rows = jsonBody(res).events
      const systemRows = rowsForTask(rows, brief.id).filter((row) => row.actor_user_id == null)
      assert.equal(systemRows.length, 1, `expected the seeded system row, got ${JSON.stringify(rows)}`)
      assert.equal(systemRows[0].actor_username, null)
      assert.deepEqual(systemRows[0].details, { task_id: brief.id, from: '进行中', to: '待认领' })
    })
  })

  describe('GET /api/v1/stats', () => {
    test('empty DB returns { completed_count: 0, completed_by_username: {} }', async (t) => {
      const { app, stub } = await boot(t)
      const anyLogin = await loginGitea(app, stub, 'stats-empty')
      const res = await getStats(app, anyLogin.cookies)
      assert.equal(res.statusCode, 200, `GET /api/v1/stats: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { completed_count: 0, completed_by_username: {} })
    })

    test('completed_count counts 状态迁移 rows with details.to === 已完成; null actor groups under 系统', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const alice = await loginGitea(app, stub, 'stats-alice')
      const db = openDb(t, sqlitePath)
      db.$client
        .prepare(
          `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
           VALUES ('gitea', '88001', 'gt-stats-bob', 'Gi Tea stats-bob', 'active', 'full', 0)`,
        )
        .run()
      const bob = db.$client.prepare("SELECT id, username FROM users WHERE username = 'gt-stats-bob'").get()
      const now = Math.floor(Date.now() / 1000)

      // Two system (null-actor) completions — the poller's real write shape (poller.ts /
      // webhook.ts always pass actorUserId: null for this transition; no production writer
      // exists today that completes a task with a real actor, so both rows here are seeded via
      // raw SQL rather than driven through a real HTTP call).
      insertRawEvent(db, {
        type: STATUS_TRANSITION_EVENT,
        actorUserId: null,
        createdAt: now,
        details: { task_id: 'kt-2026-9001', from: '待验收', to: COMPLETED_STATUS, pr_url: 'https://example.test/pr/1' },
      })
      insertRawEvent(db, {
        type: STATUS_TRANSITION_EVENT,
        actorUserId: null,
        createdAt: now,
        details: { task_id: 'kt-2026-9002', from: '待验收', to: COMPLETED_STATUS, pr_url: 'https://example.test/pr/2' },
      })
      // One completion attributed to alice, none to bob.
      insertRawEvent(db, {
        type: STATUS_TRANSITION_EVENT,
        actorUserId: alice.body.id,
        createdAt: now,
        details: { task_id: 'kt-2026-9003', from: '待验收', to: COMPLETED_STATUS },
      })
      // Noise that must NOT count: a non-completion transition, and a heartbeat.
      insertRawEvent(db, {
        type: STATUS_TRANSITION_EVENT,
        actorUserId: bob.id,
        createdAt: now,
        details: { task_id: 'kt-2026-9004', from: '进行中', to: '待验收' },
      })
      insertRawEvent(db, {
        type: HEARTBEAT_EVENT,
        actorUserId: bob.id,
        createdAt: now,
        details: { task_id: 'kt-2026-9004', note: '' },
      })

      const res = await getStats(app, alice.cookies)
      assert.equal(res.statusCode, 200, `GET /api/v1/stats: ${res.statusCode} ${res.body}`)
      const body = jsonBody(res)
      assert.deepEqual(Object.keys(body).sort(), ['completed_by_username', 'completed_count'])
      assert.equal(body.completed_count, 3)
      assert.deepEqual(body.completed_by_username, {
        [SYSTEM_ACTOR_LABEL]: 2,
        [alice.body.username]: 1,
      })
      assert.equal(Object.hasOwn(body.completed_by_username, bob.username), false)
      assertNoSecretMaterial(res, INLINE_TOKEN)
    })

    test('a 已完成 task row with no matching event does not inflate stats (near-miss vs COUNT(*) FROM tasks)', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'stats-near-miss')
      const brief = await createTaskOk(app, poster.cookies)
      const db = openDb(t, sqlitePath)
      forceStatus(db, brief.id, COMPLETED_STATUS)

      const res = await getStats(app, poster.cookies)
      assert.equal(res.statusCode, 200, `GET /api/v1/stats: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { completed_count: 0, completed_by_username: {} })
    })
  })
})

// Shared fixture: create an inline-credential task, mint an Agent Key for the poster, and claim
// it — this drives the real `token 揭示` + `状态迁移`(待认领→进行中) writers.
async function pipeAndClaim(app, posterCookies) {
  const brief = await createTaskOk(app, posterCookies)
  const key = await mintAgentKey(app, posterCookies, 'events-bot')
  const claimed = await claimTask(app, { token: key.identity, publicId: brief.id })
  assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)
  return { brief, key }
}
