import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTaskBrief } from '@kaola/shared'
import { createDb } from './db.ts'
import { injectSigned, pairDeviceToSelf, pairDeviceToClaimant, generateDeviceIdentity } from './device-proof.test-helpers.ts'
import { ensureSetup } from './auth.test-helpers.ts'

// Issue #9 REST claim / progress / release. Seams copied from tasks.test.ts (do not import that file).
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'cd'.repeat(32)

const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const REPO_FULL_NAME = 'team/orders'
const GITHUB_FORGE_BASE_URL = 'https://github.com'
const GITHUB_REPO_FULL_NAME = 'octo/widget'
const GITLAB_FORGE_BASE_URL = 'https://gitlab.forge.example.test'
const GITLAB_SUBGROUP_FULL_NAME = 'group/subgroup/app'

const INLINE_TOKEN = 'gitea-INLINE-ONE-OFF-TOKEN-zzq7'
const PROFILE_TOKEN = 'gitea-PROFILE-SHARED-TOKEN-vv31'
const GITHUB_FORGE_TOKEN = 'github-INLINE-ONE-OFF-TOKEN-gh01'
const GITLAB_FORGE_TOKEN = 'gitlab-INLINE-ONE-OFF-TOKEN-gl01'

const TASK_ALREADY_CLAIMED_MESSAGE = '任务已被认领。'
const TASK_NOT_CLAIMED_MESSAGE = '任务未被认领。'
const TOKEN_REVEAL_EVENT = 'token 揭示'
const STATUS_TRANSITION_EVENT = '状态迁移'
const HEARTBEAT_EVENT = '心跳'
const TTL_SECONDS = 86400
const FROZEN_MS = Date.UTC(2026, 7, 21, 4, 0, 0)
const CLONE_TOKEN_USAGE =
  'token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。'
const BRIEF_KEYS = [
  'id',
  'title',
  'description_md',
  'source',
  'repo',
  'acceptance_criteria',
  'test_command',
  'constraints',
  'pr_convention',
  'credential',
  'priority',
  'tags',
  'poster',
  'status',
  'created_at',
]

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
  process.env.SESSION_SECRET = '0'.repeat(32)
  process.env.PUBLIC_URL = 'http://localhost:3000'
  process.env.VAULT_MASTER_KEY = VAULT_MASTER_KEY_HEX
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

const REPO_FULL_ACCESS = {
  permissions: { pull: true, push: true, admin: false },
  has_pull_requests: true,
  private: true,
}

const GITLAB_REPO_ACCESS = {
  permissions: {
    project_access: { access_level: 40 },
    group_access: { access_level: 0 },
  },
  repository_access_level: 'enabled',
  can_create_merge_request_in: true,
  merge_requests_access_level: 'enabled',
}

const EXTRA_HEADER_BY_FORGE = {
  github: { name: 'Authorization', value_pattern: 'Bearer ${token}' },
  gitlab: { name: 'Authorization', value_pattern: 'Bearer ${token}' },
  gitea: { name: 'Authorization', value_pattern: 'token ${token}' },
}

function allowForgeToken(stub, token, descriptor = { repo: REPO_FULL_ACCESS }) {
  stub.forge.set(token, descriptor)
}

function recordOutboundFetch() {
  const inner = globalThis.fetch
  const outbound = []
  globalThis.fetch = async (input, init) => {
    outbound.push({
      url: requestUrl(input),
      authorization: readHeader(input, init, 'authorization') ?? null,
      privateToken: readHeader(input, init, 'private-token') ?? null,
    })
    return inner(input, init)
  }
  return outbound
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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-claim-'))
  const sqlitePath = join(dir, 'kaola.sqlite')
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return sqlitePath
}

function withAdmins(t, spec) {
  const previous = process.env.KAOLA_ADMINS
  if (spec == null || spec === '') delete process.env.KAOLA_ADMINS
  else process.env.KAOLA_ADMINS = spec
  t.after(() => {
    if (previous == null) delete process.env.KAOLA_ADMINS
    else process.env.KAOLA_ADMINS = previous
  })
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

function expiresAtIso(unixSeconds) {
  return new Date((unixSeconds + TTL_SECONDS) * 1000).toISOString()
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
    acceptance_criteria: [
      'GET /api/orders/export 支持 page/page_size 参数',
      '新增单元测试覆盖分页边界',
    ],
    test_command: 'pnpm test',
    constraints: {
      allowed_paths: ['src/api/**', 'tests/**'],
      forbidden_paths: ['migrations/**'],
    },
    priority: 'P1',
    tags: ['backend', 'api'],
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

async function listTasks(app, cookies) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/tasks',
    cookies,
    headers: jsonHeaders,
  })
}

async function getTask(app, cookies, publicId) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${publicId}`,
    cookies,
    headers: jsonHeaders,
  })
}

async function patchTask(app, cookies, publicId, payload) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/tasks/${publicId}`,
    cookies,
    headers: jsonHeaders,
    payload,
  })
}

async function postProfile(app, cookies, overrides = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/credential-profiles',
    cookies,
    headers: jsonHeaders,
    payload: {
      forge: 'gitea',
      base_url: FORGE_BASE_URL,
      repo_full_name: REPO_FULL_NAME,
      token: PROFILE_TOKEN,
      ...overrides,
    },
  })
  assert.equal(res.statusCode, 201, `POST credential profile: ${res.statusCode} ${res.body}`)
  return jsonBody(res)
}

async function createTaskOk(app, cookies, payload = taskPayload()) {
  const res = await postTask(app, cookies, payload)
  assert.equal(res.statusCode, 201, `POST /api/v1/tasks: ${res.statusCode} ${res.body}`)
  const brief = jsonBody(res)
  assertBriefShape(brief)
  return { res, brief }
}

function bearerHeaders(token) {
  return { accept: 'application/json', authorization: `Bearer ${token}` }
}

async function mintAgentKey(app, cookies, label = 'agent') {
  const paired = await pairDeviceToSelf(app, cookies, { hostname: label })
  return { id: paired.deviceId, identity: paired.identity, deviceId: paired.deviceId }
}

async function claimTask(app, { identity, token, publicId, cookies, payload }) {
  const url = `/api/v1/tasks/${publicId}/claim`
  if (identity != null) {
    return injectSigned(app, identity, {
      method: 'POST',
      url,
      payload: payload ?? {},
      extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
    })
  }
  const headers = token != null ? bearerHeaders(token) : jsonHeaders
  return app.inject({
    method: 'POST',
    url,
    headers,
    cookies,
    payload,
  })
}

function hashAgentKey(plaintext) {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

function seedAgentKey(db, userId, label = 'seeded-pending') {
  const token = `ktk_${randomBytes(32).toString('hex')}`
  const keyHash = hashAgentKey(token)
  db.$client
    .prepare('INSERT INTO agent_keys (user_id, key_hash, label, last_used_at) VALUES (?, ?, ?, NULL)')
    .run(userId, keyHash, label)
  const row = db.$client.prepare('SELECT id FROM agent_keys WHERE key_hash = ?').get(keyHash)
  assert.ok(row, 'seeded agent_keys row missing')
  return { id: Number(row.id), token, keyHash, label }
}

async function progressTask(app, { identity, token, publicId, payload }) {
  const url = `/api/v1/tasks/${publicId}/progress`
  if (identity != null) {
    return injectSigned(app, identity, {
      method: 'POST',
      url,
      payload: payload ?? {},
      extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
    })
  }
  const req = {
    method: 'POST',
    url,
    headers: bearerHeaders(token),
  }
  if (payload !== undefined) req.payload = payload
  return app.inject(req)
}

async function releaseTask(app, { identity, token, publicId, payload }) {
  const url = `/api/v1/tasks/${publicId}/release`
  if (identity != null) {
    return injectSigned(app, identity, {
      method: 'POST',
      url,
      payload: payload ?? {},
      extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
    })
  }
  const req = {
    method: 'POST',
    url,
    headers: bearerHeaders(token),
  }
  if (payload !== undefined) req.payload = payload
  return app.inject(req)
}

function assertBriefShape(brief) {
  assert.equal(typeof brief, 'object', `brief must be an object, got ${JSON.stringify(brief)}`)
  assert.ok(brief)
  assert.deepEqual(
    Object.keys(brief).sort(),
    [...BRIEF_KEYS].sort(),
    `brief keys must be exactly the DESIGN §6 set, got ${JSON.stringify(Object.keys(brief))}`,
  )
  parseTaskBrief(brief)
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

function dumpedBody(res) {
  return typeof res === 'string' ? res : res.body
}

function parsedBody(res) {
  return typeof res === 'string' ? JSON.parse(res) : jsonBody(res)
}

// For list/get/progress/release and error bodies: no forge plaintext, no secret key names (including `token`).
function assertNoForgeSecretMaterial(res, ...plaintexts) {
  const dumped = dumpedBody(res)
  for (const plaintext of plaintexts) {
    assert.equal(
      dumped.includes(plaintext),
      false,
      `response leaked plaintext token ${plaintext}: ${dumped}`,
    )
  }
  const parsed = parsedBody(res)
  for (const key of collectKeys(parsed)) {
    assert.equal(
      SECRET_KEY_NAMES.has(key),
      false,
      `response carried a secret-bearing key "${key}": ${dumped}`,
    )
  }
}

function expectedCloneRemoteUrl(repo) {
  return `${String(repo.base_url).replace(/\/+$/u, '')}/${repo.full_name}.git`
}

function assertCloneRecipe(clone, { suggestedDir, repo, forgePlaintext }) {
  assert.equal(typeof clone, 'object')
  assert.ok(clone)
  assert.deepEqual(Object.keys(clone).sort(), ['extra_header', 'remote_url', 'suggested_dir', 'token_usage'])
  assert.equal(clone.suggested_dir, suggestedDir)
  assert.equal(clone.suggested_dir, repo.suggested_dir)
  assert.equal(clone.token_usage, CLONE_TOKEN_USAGE)
  assert.equal(clone.remote_url, expectedCloneRemoteUrl(repo))
  assert.equal(clone.remote_url.includes(forgePlaintext), false, `remote_url leaked forge plaintext: ${clone.remote_url}`)
  assert.equal(clone.remote_url.includes('@'), false, `remote_url must not embed credentials: ${clone.remote_url}`)
  assert.equal(clone.remote_url.includes('api.github.com'), false, `remote_url must not use api.github.com: ${clone.remote_url}`)
  assert.equal(clone.remote_url.includes('%2F'), false, `remote_url must not use GitLab API %2F: ${clone.remote_url}`)
  assert.equal(clone.remote_url.includes('%2f'), false, `remote_url must not use GitLab API %2f: ${clone.remote_url}`)
  const extra = clone.extra_header
  assert.equal(typeof extra, 'object')
  assert.ok(extra)
  assert.deepEqual(Object.keys(extra).sort(), ['name', 'value_pattern'])
  const expectedHeader = EXTRA_HEADER_BY_FORGE[repo.forge]
  assert.ok(expectedHeader, `unknown forge ${repo.forge}`)
  assert.equal(extra.name, expectedHeader.name)
  assert.equal(extra.value_pattern, expectedHeader.value_pattern)
  assert.equal(extra.value_pattern.includes('${token}'), true, `value_pattern must keep literal \${token}: ${extra.value_pattern}`)
  assert.equal(extra.value_pattern.includes(forgePlaintext), false, `value_pattern leaked forge plaintext: ${extra.value_pattern}`)
}

// Claim 201 is allowed to have a top-level `token` equal to the fixture forge plaintext.
function assertClaimRevealToken(body, forgePlaintext) {
  assert.equal(body.token, forgePlaintext)
  for (const part of [body.task, body.lease, body.clone]) {
    const dumped = JSON.stringify(part)
    assert.equal(
      dumped.includes(forgePlaintext),
      false,
      `claim envelope nested object leaked forge plaintext: ${dumped}`,
    )
    for (const key of collectKeys(part)) {
      assert.equal(
        SECRET_KEY_NAMES.has(key),
        false,
        `claim nested object carried secret key "${key}": ${dumped}`,
      )
    }
  }
}

function assertClaim201(res, { forgeToken, suggestedDir, nowUnix }) {
  assert.equal(res.statusCode, 201, `POST claim: ${res.statusCode} ${res.body}`)
  const body = jsonBody(res)
  assert.equal(typeof body, 'object')
  assert.ok(body)
  assert.deepEqual(Object.keys(body).sort(), ['clone', 'lease', 'task', 'token'])
  assertBriefShape(body.task)
  assert.equal(body.task.status, '进行中')
  assertClaimRevealToken(body, forgeToken)
  // Issue #36: the claim lease envelope gains a derived, opaque claim_id alongside the existing
  // fields (report_progress's envelope is unaffected — see assertProgress200 below).
  assert.deepEqual(Object.keys(body.lease).sort(), ['claim_id', 'expires_at', 'ttl_seconds'])
  assert.equal(body.lease.ttl_seconds, TTL_SECONDS)
  assert.equal(body.lease.expires_at, expiresAtIso(nowUnix))
  assertCloneRecipe(body.clone, {
    suggestedDir,
    repo: body.task.repo,
    forgePlaintext: forgeToken,
  })
  return body
}

function assertProgress200(res, { nowUnix, forgeTokens }) {
  assert.equal(res.statusCode, 200, `POST progress: ${res.statusCode} ${res.body}`)
  const body = jsonBody(res)
  assert.deepEqual(Object.keys(body).sort(), ['lease', 'task'])
  assertBriefShape(body.task)
  assert.equal(body.task.status, '进行中')
  assert.deepEqual(Object.keys(body.lease).sort(), ['expires_at', 'ttl_seconds'])
  assert.equal(body.lease.ttl_seconds, TTL_SECONDS)
  assert.equal(body.lease.expires_at, expiresAtIso(nowUnix))
  assertNoForgeSecretMaterial(res, ...forgeTokens)
  return body
}

function assertRelease200(res, { forgeTokens }) {
  assert.equal(res.statusCode, 200, `POST release: ${res.statusCode} ${res.body}`)
  const body = jsonBody(res)
  assert.deepEqual(Object.keys(body).sort(), ['task'])
  assertBriefShape(body.task)
  assert.equal(body.task.status, '待认领')
  assertNoForgeSecretMaterial(res, ...forgeTokens)
  return body
}

function assertBearerUnauthorized(res) {
  assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}: ${res.body}`)
  assert.deepEqual(jsonBody(res), { error: 'unauthorized' })
  assert.match(String(res.headers['www-authenticate'] ?? ''), /Kaola-Device/)
}

function illegalTransitionMessage(from, to) {
  return `任务状态不允许从「${from}」变更为「${to}」。`
}

function parseDetails(row) {
  if (row == null) return null
  if (typeof row.details === 'string') return JSON.parse(row.details)
  return row.details
}

function eventRows(db) {
  return db.$client.prepare('SELECT type, actor_user_id, created_at, details FROM events').all()
}

function eventsOfType(db, type) {
  return eventRows(db).filter((event) => event.type === type)
}

function claimRevealEvents(db, publicId) {
  return eventsOfType(db, TOKEN_REVEAL_EVENT).filter((event) => {
    const details = parseDetails(event)
    return details?.task_id === publicId && details?.device_id != null
  })
}

function statusTransitionEvents(db, publicId) {
  return eventsOfType(db, STATUS_TRANSITION_EVENT).filter((event) => {
    const details = parseDetails(event)
    return details?.task_id === publicId
  })
}

function heartbeatEvents(db, publicId) {
  return eventsOfType(db, HEARTBEAT_EVENT).filter((event) => parseDetails(event)?.task_id === publicId)
}

function taskRow(db, publicId) {
  return db.$client
    .prepare(
      'SELECT id, public_id, status, poster_user_id, credential_profile_id, inline_token_encrypted FROM tasks WHERE public_id = ?',
    )
    .get(publicId)
}

function forceStatus(db, publicId, status) {
  const info = db.$client.prepare('UPDATE tasks SET status = ? WHERE public_id = ?').run(status, publicId)
  assert.equal(info.changes, 1, `expected to force ${publicId} into ${status}`)
}

function leaseRows(db, taskPk) {
  return db.$client
    .prepare(
      'SELECT task_id, claimer_user_id, device_id, claimed_at, expires_at, last_heartbeat, state FROM leases WHERE task_id = ?',
    )
    .all(taskPk)
}

function activeLeaseRows(db, taskPk) {
  return leaseRows(db, taskPk).filter((row) => row.state === 'active')
}

function profileCiphertext(db, profileId) {
  const row = db.$client.prepare('SELECT token_encrypted FROM credential_profiles WHERE id = ?').get(profileId)
  return row?.token_encrypted
}

function assertEventOmitsSecrets(event, ...secrets) {
  const dumped = JSON.stringify(event)
  for (const secret of secrets) {
    assert.equal(dumped.includes(secret), false, `event leaked secret ${secret}: ${dumped}`)
  }
}

function assertLiveLease(row, { taskPk, userId, deviceId, nowUnix }) {
  assert.ok(row, 'expected a leases row')
  assert.equal(Number(row.task_id), Number(taskPk))
  assert.equal(Number(row.claimer_user_id), Number(userId))
  assert.equal(Number(row.device_id), Number(deviceId))
  assert.equal(Number(row.claimed_at), nowUnix)
  assert.equal(Number(row.expires_at), nowUnix + TTL_SECONDS)
  assert.equal(Number(row.last_heartbeat), nowUnix)
  assert.equal(row.state, 'active')
}

async function boot(t, { admins } = {}) {
  if (admins) withAdmins(t, admins)
  const app = await createApp(t)
  const stub = beginFetch(t)
  allowForgeToken(stub, INLINE_TOKEN)
  allowForgeToken(stub, PROFILE_TOKEN)
  return { app, stub }
}

describe('issue #9 lease-based claiming', { concurrency: false }, () => {
  describe('authentication — device proof', () => {
    test('unauthenticated claim, progress, and release are 401 unauthorized with WWW-Authenticate Kaola-Device', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'unauth-poster')
      const { brief } = await createTaskOk(app, poster.cookies)

      for (const methodPath of [
        ['POST', `/api/v1/tasks/${brief.id}/claim`],
        ['POST', `/api/v1/tasks/${brief.id}/progress`],
        ['POST', `/api/v1/tasks/${brief.id}/release`],
      ]) {
        const res = await app.inject({
          method: methodPath[0],
          url: methodPath[1],
          headers: jsonHeaders,
        })
        assertBearerUnauthorized(res)
      }
    })

    test('signed unpaired device proof on claim is 202 authorization_required with no token and no lease', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'unpaired-poster')
      const { brief } = await createTaskOk(app, poster.cookies)
      const identity = generateDeviceIdentity()

      const res = await claimTask(app, { identity, publicId: brief.id })
      assert.equal(res.statusCode, 202, `unpaired claim: ${res.statusCode} ${res.body}`)
      const body = jsonBody(res)
      assert.equal(body.error, 'authorization_required')
      assert.equal(body.pending, true)
      assert.equal(typeof body.expires_at, 'string')
      assert.equal(Object.hasOwn(body, 'token'), false, `202 must omit forge token: ${res.body}`)
      assertNoForgeSecretMaterial(res, INLINE_TOKEN)
      const db = openDb(t, sqlitePath)
      assert.equal(eventsOfType(db, TOKEN_REVEAL_EVENT).length, 0)
      const task = taskRow(db, brief.id)
      assert.equal(activeLeaseRows(db, task.id).length, 0)
    })

    test('wrong and non-device credentials are 401 with WWW-Authenticate Kaola-Device', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'wrong-bearer')
      const { brief } = await createTaskOk(app, poster.cookies)
      const fake = `ktk_${'ab'.repeat(32)}`

      const wrong = await claimTask(app, { token: fake, publicId: brief.id })
      assertBearerUnauthorized(wrong)

      const tokenScheme = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${brief.id}/claim`,
        headers: { accept: 'application/json', authorization: `Token ${fake}` },
      })
      assertBearerUnauthorized(tokenScheme)

      const basic = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${brief.id}/progress`,
        headers: { accept: 'application/json', authorization: 'Basic dXNlcjpwYXNz' },
      })
      assertBearerUnauthorized(basic)
    })

    test('a session cookie without Bearer does not authorize claim, progress, or release', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'session-only')
      const { brief } = await createTaskOk(app, poster.cookies)
      await mintAgentKey(app, poster.cookies, 'unused')

      const claimed = await claimTask(app, { publicId: brief.id, cookies: poster.cookies })
      assertBearerUnauthorized(claimed)

      const progressed = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${brief.id}/progress`,
        cookies: poster.cookies,
        headers: jsonHeaders,
        payload: { note: 'should not work' },
      })
      assertBearerUnauthorized(progressed)

      const released = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${brief.id}/release`,
        cookies: poster.cookies,
        headers: jsonHeaders,
        payload: { reason: 'should not work' },
      })
      assertBearerUnauthorized(released)
    })

    test('unknown publicId with a valid Bearer key is 404 not_found', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'unknown-id')
      await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'claimer')

      const res = await claimTask(app, { identity: key.identity, publicId: 'kt-2026-9999' })
      assert.equal(res.statusCode, 404, `claim unknown: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'not_found' })
      assertNoForgeSecretMaterial(res, INLINE_TOKEN)
    })

    test('numeric PK in the path with a valid Bearer key is 404 not_found', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'numeric-id')
      await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'claimer')

      for (const raw of ['1', '0', '-1']) {
        const res = await claimTask(app, { identity: key.identity, publicId: raw })
        assert.equal(res.statusCode, 404, `claim /${raw}: ${res.statusCode} ${res.body}`)
        assert.deepEqual(jsonBody(res), { error: 'not_found' })
      }
    })
  })

  describe('POST /api/v1/tasks/:publicId/claim — 201 envelope', () => {
    test('claiming an inline task returns 201 with task, forge token, lease TTL, and clone guidance', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'claim-inline')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'inline-bot')

      const outbound = recordOutboundFetch()
      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      const body = assertClaim201(res, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
      assert.deepEqual(body.task.credential, { inline: true })
      assert.equal(outbound.length, 0, `claim must not call validateToken/fetch, got ${JSON.stringify(outbound)}`)
    })

    test('claiming a profile task returns 201; credential stays { profile_id }; token is the profile forge plaintext', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'claim-profile')
      const profile = await postProfile(app, poster.cookies)
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ credential: { profile_id: profile.id } }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'profile-bot')

      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      const body = assertClaim201(res, {
        forgeToken: PROFILE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
      assert.deepEqual(body.task.credential, { profile_id: String(profile.id) })
    })

    test('claiming a second publicId returns that task\'s token, not the first task\'s', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'switch-task-token')
      const profile = await postProfile(app, poster.cookies)
      const { brief: firstBrief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ title: 'first publicId inline token' }),
      )
      const { brief: secondBrief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'second publicId profile token',
          credential: { profile_id: profile.id },
        }),
      )
      assert.notEqual(firstBrief.id, secondBrief.id)
      const key = await mintAgentKey(app, poster.cookies, 'switch-bot')

      const first = await claimTask(app, { identity: key.identity, publicId: firstBrief.id })
      const firstBody = assertClaim201(first, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: firstBrief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
      assert.equal(firstBody.task.id, firstBrief.id)
      assert.deepEqual(firstBody.task.credential, { inline: true })
      assert.notEqual(firstBody.token, PROFILE_TOKEN)

      const second = await claimTask(app, { identity: key.identity, publicId: secondBrief.id })
      const secondBody = assertClaim201(second, {
        forgeToken: PROFILE_TOKEN,
        suggestedDir: secondBrief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
      assert.equal(secondBody.task.id, secondBrief.id)
      assert.deepEqual(secondBody.task.credential, { profile_id: String(profile.id) })
      assert.notEqual(secondBody.token, firstBody.token)
      assert.equal(secondBody.token, PROFILE_TOKEN)
      assert.equal(firstBody.token, INLINE_TOKEN)
    })

    test('claiming a github task returns Bearer extra_header and a web-origin remote_url, not api.github.com', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      allowForgeToken(stub, GITHUB_FORGE_TOKEN)
      const poster = await loginGitea(app, stub, 'claim-github-clone')
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'github clone recipe',
          repo: {
            forge: 'github',
            base_url: GITHUB_FORGE_BASE_URL,
            full_name: GITHUB_REPO_FULL_NAME,
            base_branch: 'main',
            suggested_dir: 'widget',
          },
          credential: { token: GITHUB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'github-bot')
      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      const body = assertClaim201(res, {
        forgeToken: GITHUB_FORGE_TOKEN,
        suggestedDir: 'widget',
        nowUnix: clock.unix(),
      })
      assert.equal(body.task.repo.forge, 'github')
      assert.equal(body.clone.remote_url, 'https://github.com/octo/widget.git')
      assert.equal(body.clone.extra_header.name, 'Authorization')
      assert.equal(body.clone.extra_header.value_pattern, 'Bearer ${token}')
    })

    test('claiming a gitlab subgroup task keeps slashes in remote_url and uses Bearer extra_header', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      allowForgeToken(stub, GITLAB_FORGE_TOKEN, { repo: GITLAB_REPO_ACCESS })
      const poster = await loginGitea(app, stub, 'claim-gitlab-clone')
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'gitlab subgroup clone recipe',
          repo: {
            forge: 'gitlab',
            base_url: GITLAB_FORGE_BASE_URL,
            full_name: GITLAB_SUBGROUP_FULL_NAME,
            base_branch: 'main',
            suggested_dir: 'app',
          },
          credential: { token: GITLAB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'gitlab-bot')
      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      const body = assertClaim201(res, {
        forgeToken: GITLAB_FORGE_TOKEN,
        suggestedDir: 'app',
        nowUnix: clock.unix(),
      })
      assert.equal(body.task.repo.forge, 'gitlab')
      assert.equal(body.task.repo.full_name, GITLAB_SUBGROUP_FULL_NAME)
      assert.equal(body.clone.remote_url, 'https://gitlab.forge.example.test/group/subgroup/app.git')
      assert.equal(body.clone.extra_header.name, 'Authorization')
      assert.equal(body.clone.extra_header.value_pattern, 'Bearer ${token}')
    })

    test('claim remote_url strips trailing slashes from stored repo.base_url', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'claim-slash-clone')
      const created = await postTask(
        app,
        poster.cookies,
        taskPayload({
          title: 'trailing slash base_url',
          repo: {
            forge: 'gitea',
            base_url: `${FORGE_BASE_URL}/`,
            full_name: REPO_FULL_NAME,
            base_branch: 'main',
            suggested_dir: 'orders',
          },
        }),
      )
      if (created.statusCode !== 201) {
        return
      }
      const brief = jsonBody(created)
      assertBriefShape(brief)
      assert.equal(brief.repo.base_url.endsWith('/'), true, 'this case only pins strip when publish stores a trailing slash')
      const key = await mintAgentKey(app, poster.cookies, 'slash-bot')
      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      const body = assertClaim201(res, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
      assert.equal(body.clone.remote_url, 'https://gitea.forge.example.test/team/orders.git')
      assert.equal(body.clone.remote_url.includes('//team/'), false)
    })

    test('session GET list and GET one after a successful claim still omit forge token and secret keys', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'never-token-get')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'getter')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)
      assert.equal(jsonBody(claimed).task.status, '进行中')

      const listed = await listTasks(app, poster.cookies)
      assert.equal(listed.statusCode, 200, `GET list: ${listed.statusCode} ${listed.body}`)
      assert.equal(jsonBody(listed).tasks.length, 1)
      assert.equal(jsonBody(listed).tasks[0].status, '进行中')
      assertBriefShape(jsonBody(listed).tasks[0])
      assert.equal(Object.hasOwn(jsonBody(listed).tasks[0], 'clone'), false)
      assertNoForgeSecretMaterial(listed, INLINE_TOKEN)

      const fetched = await getTask(app, poster.cookies, brief.id)
      assert.equal(fetched.statusCode, 200, `GET one: ${fetched.statusCode} ${fetched.body}`)
      assert.equal(jsonBody(fetched).status, '进行中')
      assertBriefShape(jsonBody(fetched))
      assert.equal(Object.hasOwn(jsonBody(fetched), 'clone'), false)
      assertNoForgeSecretMaterial(fetched, INLINE_TOKEN)
    })
  })

  describe('AuthZ', () => {
    test('leftover ktk_ Bearer is 401 unauthorized, not a claim identity, and writes no token 揭示', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const member = await loginGitea(app, stub, 'pending-owner')
      const { brief } = await createTaskOk(app, member.cookies)
      const db = openDb(t, sqlitePath)
      const leftover = db.$client
        .prepare(
          `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
           VALUES ('github', '60111', 'gh-leftover-claimer', 'Leftover', '待批准', 'claim_only', 0)`,
        )
        .run()
      const leftoverId = leftover.lastInsertRowid
      const seeded = seedAgentKey(db, leftoverId)
      assert.equal(claimRevealEvents(db, brief.id).length, 0)

      const res = await claimTask(app, { token: seeded.token, publicId: brief.id })
      assert.equal(res.statusCode, 401, `leftover ktk_ claim: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'unauthorized' })
      assert.notEqual(res.statusCode, 202)
      assertNoForgeSecretMaterial(res, INLINE_TOKEN)
      assert.equal(claimRevealEvents(db, brief.id).length, 0)
      assert.equal(eventsOfType(db, TOKEN_REVEAL_EVENT).length, 0)
    })

    test('leftover claim_only session cannot bind a device, and leftover ktk_ cannot claim', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const member = await loginGitea(app, stub, 'claim-only-owner')
      const { brief } = await createTaskOk(app, member.cookies)
      const db = openDb(t, sqlitePath)
      db.$client
        .prepare(
          `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
           VALUES ('gitlab', '60112', 'gl-leftover-claim-only', 'Claim Only', 'active', 'claim_only', 0)`,
        )
        .run()
      const leftoverId = db.$client.prepare("SELECT id FROM users WHERE username = 'gl-leftover-claim-only'").get().id
      const leftoverToken = nextAccessToken('leftover-claim-only')
      stub.oauth.set(leftoverToken, { id: 60112, username: 'gl-leftover-claim-only', name: 'Claim Only' })
      const leftoverLogin = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: leftoverToken })
      assert.equal(leftoverLogin.body.status, 'active')
      assert.equal(leftoverLogin.body.permission_level, 'claim_only')
      assert.equal(Number(leftoverLogin.body.id), Number(leftoverId))

      const identity = generateDeviceIdentity()
      await claimTask(app, { identity, publicId: brief.id })
      const pending = await app.inject({
        method: 'GET',
        url: '/api/v1/devices/pending',
        cookies: leftoverLogin.cookies,
        headers: jsonHeaders,
      })
      assert.equal(pending.statusCode, 403, `claim_only cannot list pending: ${pending.statusCode} ${pending.body}`)

      const listedAsFull = await app.inject({
        method: 'GET',
        url: '/api/v1/devices/pending',
        cookies: member.cookies,
        headers: jsonHeaders,
      })
      const row = jsonBody(listedAsFull)?.devices?.[0]
      const bind = await app.inject({
        method: 'POST',
        url: `/api/v1/devices/${row?.id ?? 1}/bind`,
        cookies: leftoverLogin.cookies,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        payload: { bind_to_self: true },
      })
      assert.equal(bind.statusCode, 403, `claim_only cannot bind: ${bind.statusCode} ${bind.body}`)

      const seeded = seedAgentKey(db, leftoverId)
      const res = await claimTask(app, { token: seeded.token, publicId: brief.id })
      assert.equal(res.statusCode, 401, `leftover ktk_ claim: ${res.statusCode} ${res.body}`)
      assertNoForgeSecretMaterial(res, INLINE_TOKEN)
    })

    test('active admin can claim via bind_to_self', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t, { admins: 'gitea:gt-full-claimer' })
      const poster = await loginGitlab(app, stub, 'full-poster')
      const claimer = await loginGitea(app, stub, 'full-claimer')
      assert.equal(claimer.body.status, 'active')
      assert.equal(claimer.body.permission_level, 'admin')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, claimer.cookies, 'full-bot')
      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assertClaim201(res, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
    })
  })

  describe('conflicts / illegal states', () => {
    test('second claim while 进行中 is 409 conflict, no token, and no second reveal', async (t) => {
      const sqlitePath = sqliteFile(t)
      withAdmins(t, 'gitlab:gl-second-claimer')
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'first-holder')
      const other = await loginGitlab(app, stub, 'second-claimer')
      assert.equal(other.body.permission_level, 'full')
      const { brief } = await createTaskOk(app, poster.cookies)
      const firstKey = await mintAgentKey(app, poster.cookies, 'holder')
      const otherKey = await pairDeviceToClaimant(app, poster.cookies, 'rival', { hostname: 'rival' })

      const first = await claimTask(app, { identity: firstKey.identity, publicId: brief.id })
      assert.equal(first.statusCode, 201, `first claim: ${first.statusCode} ${first.body}`)
      assert.equal(jsonBody(first).token, INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      assert.equal(claimRevealEvents(db, brief.id).length, 1)

      const retry = await claimTask(app, { identity: firstKey.identity, publicId: brief.id })
      assert.equal(retry.statusCode, 409, `same-key retry: ${retry.statusCode} ${retry.body}`)
      assert.deepEqual(jsonBody(retry), { error: 'conflict', message: TASK_ALREADY_CLAIMED_MESSAGE })
      assertNoForgeSecretMaterial(retry, INLINE_TOKEN)

      const rival = await claimTask(app, { identity: otherKey.identity, publicId: brief.id })
      assert.equal(rival.statusCode, 409, `rival claim: ${rival.statusCode} ${rival.body}`)
      assert.deepEqual(jsonBody(rival), { error: 'conflict', message: TASK_ALREADY_CLAIMED_MESSAGE })
      assertNoForgeSecretMaterial(rival, INLINE_TOKEN)
      assert.equal(claimRevealEvents(db, brief.id).length, 1)
    })

    test('claiming a 已取消 task is 409 illegal_transition', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'cancelled-claim')
      const { brief } = await createTaskOk(app, poster.cookies)
      const cancelled = await patchTask(app, poster.cookies, brief.id, { status: '已取消' })
      assert.equal(cancelled.statusCode, 200)
      const key = await mintAgentKey(app, poster.cookies, 'too-late')

      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(res.statusCode, 409, `claim cancelled: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), {
        error: 'illegal_transition',
        message: illegalTransitionMessage('已取消', '进行中'),
      })
      assertNoForgeSecretMaterial(res, INLINE_TOKEN)
    })

    test('claiming a 待验收 task is 409 illegal_transition', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'review-claim')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'reviewer')
      const db = openDb(t, sqlitePath)
      forceStatus(db, brief.id, '待验收')

      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(res.statusCode, 409, `claim 待验收: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), {
        error: 'illegal_transition',
        message: illegalTransitionMessage('待验收', '进行中'),
      })
      assertNoForgeSecretMaterial(res, INLINE_TOKEN)
    })

    test('progress and release by a non-holder are 403 forbidden', async (t) => {
      const { app, stub } = await boot(t, { admins: 'gitlab:gl-bystander' })
      const poster = await loginGitea(app, stub, 'holder')
      const other = await loginGitlab(app, stub, 'bystander')
      assert.equal(other.body.permission_level, 'full')
      const { brief } = await createTaskOk(app, poster.cookies)
      const holderKey = await mintAgentKey(app, poster.cookies, 'holder-key')
      const otherKey = await pairDeviceToClaimant(app, poster.cookies, 'bystander', { hostname: 'bystander-key' })

      const claimed = await claimTask(app, { identity: holderKey.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      const progressed = await progressTask(app, { identity: otherKey.identity, publicId: brief.id, payload: { note: 'nope' } })
      assert.equal(progressed.statusCode, 403, `non-holder progress: ${progressed.statusCode} ${progressed.body}`)
      assert.equal(jsonBody(progressed)?.error, 'forbidden')
      assertNoForgeSecretMaterial(progressed, INLINE_TOKEN)

      const released = await releaseTask(app, { identity: otherKey.identity, publicId: brief.id, payload: { reason: 'nope' } })
      assert.equal(released.statusCode, 403, `non-holder release: ${released.statusCode} ${released.body}`)
      assert.equal(jsonBody(released)?.error, 'forbidden')
      assertNoForgeSecretMaterial(released, INLINE_TOKEN)

      const still = await getTask(app, poster.cookies, brief.id)
      assert.equal(jsonBody(still).status, '进行中')
    })

    test('progress and release with no live lease are 409 conflict 任务未被认领', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'never-claimed')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'idle')

      const progressed = await progressTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(progressed.statusCode, 409, `progress unused: ${progressed.statusCode} ${progressed.body}`)
      assert.deepEqual(jsonBody(progressed), { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE })
      assertNoForgeSecretMaterial(progressed, INLINE_TOKEN)

      const released = await releaseTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(released.statusCode, 409, `release unused: ${released.statusCode} ${released.body}`)
      assert.deepEqual(jsonBody(released), { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE })
      assertNoForgeSecretMaterial(released, INLINE_TOKEN)
    })

    // Issue #31: repeating release for the same already-terminal Claim is now idempotent (200,
    // same result) rather than 409 — progress still has no active lease to renew, so it stays 409
    // 任务未被认领 exactly as before.
    test('progress after the holder released is 409 任务未被认领; a repeated release is idempotent 200', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'after-release')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'holder')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)
      const released = await releaseTask(app, { identity: key.identity, publicId: brief.id })
      const releasedBody = assertRelease200(released, { forgeTokens: [INLINE_TOKEN] })

      const progressed = await progressTask(app, { identity: key.identity, publicId: brief.id, payload: { note: 'late' } })
      assert.equal(progressed.statusCode, 409, `progress after release: ${progressed.statusCode} ${progressed.body}`)
      assert.deepEqual(jsonBody(progressed), { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE })

      const again = await releaseTask(app, { identity: key.identity, publicId: brief.id })
      const againBody = assertRelease200(again, { forgeTokens: [INLINE_TOKEN] })
      assert.deepEqual(againBody, releasedBody, 'a repeated release for the same already-terminal Claim must return the same result')
    })
  })

  describe('heartbeat', () => {
    test('omitted note still renews expires_at from heartbeat time and writes 心跳 with note empty string', async (t) => {
      const clock = freezeNow(t)
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'heartbeat-omit')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'heart')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      const claimedBody = assertClaim201(claimed, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })

      clock.advanceMs(3600 * 1000)
      const progressed = await progressTask(app, { identity: key.identity, publicId: brief.id })
      const body = assertProgress200(progressed, { nowUnix: clock.unix(), forgeTokens: [INLINE_TOKEN] })
      assert.notEqual(body.lease.expires_at, claimedBody.lease.expires_at)

      const db = openDb(t, sqlitePath)
      const beats = heartbeatEvents(db, brief.id)
      assert.equal(beats.length, 1, `expected one 心跳, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(Number(beats[0].actor_user_id), Number(poster.body.id))
      assert.deepEqual(parseDetails(beats[0]), { task_id: brief.id, note: '' })

      const task = taskRow(db, brief.id)
      const leases = leaseRows(db, task.id)
      assert.equal(leases.length, 1)
      assert.equal(leases[0].state, 'active')
      assert.equal(Number(leases[0].last_heartbeat), clock.unix())
      assert.equal(Number(leases[0].expires_at), clock.unix() + TTL_SECONDS)
      assert.equal(Number(leases[0].claimed_at), clock.unix() - 3600)
    })

    test('a progress note is persisted on the 心跳 event; empty note still renews', async (t) => {
      const clock = freezeNow(t)
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'heartbeat-note')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'noted')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      const empty = await progressTask(app, { identity: key.identity, publicId: brief.id, payload: { note: '' } })
      assertProgress200(empty, { nowUnix: clock.unix(), forgeTokens: [INLINE_TOKEN] })

      clock.advanceMs(60 * 1000)
      const noted = await progressTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { note: '正在写分页测试' },
      })
      assertProgress200(noted, { nowUnix: clock.unix(), forgeTokens: [INLINE_TOKEN] })

      const db = openDb(t, sqlitePath)
      const beats = heartbeatEvents(db, brief.id)
      assert.equal(beats.length, 2, `expected two 心跳 rows, got ${JSON.stringify(beats.map(parseDetails))}`)
      assert.deepEqual(parseDetails(beats[0]), { task_id: brief.id, note: '' })
      assert.deepEqual(parseDetails(beats[1]), { task_id: brief.id, note: '正在写分页测试' })
    })
  })

  describe('release', () => {
    test('holder release returns 200 { task } 待认领, marks the lease released, and writes 状态迁移 without reason', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'release-omit')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'releaser')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      const released = await releaseTask(app, { identity: key.identity, publicId: brief.id })
      assertRelease200(released, { forgeTokens: [INLINE_TOKEN] })

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(task.status, '待认领')
      const leases = leaseRows(db, task.id)
      assert.equal(leases.length, 1)
      assert.equal(leases[0].state, 'released')
      assert.equal(activeLeaseRows(db, task.id).length, 0)

      const transitions = statusTransitionEvents(db, brief.id).filter((event) => parseDetails(event)?.to === '待认领')
      assert.equal(transitions.length, 1)
      assert.equal(Number(transitions[0].actor_user_id), Number(poster.body.id))
      const details = parseDetails(transitions[0])
      assert.equal(details.task_id, brief.id)
      assert.equal(details.from, '进行中')
      assert.equal(details.to, '待认领')
      assert.equal(Object.hasOwn(details, 'reason'), false)
    })

    test('release with reason stores reason on the 状态迁移 event', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'release-reason')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'releaser')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      const released = await releaseTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { reason: '换人做' },
      })
      assertRelease200(released, { forgeTokens: [INLINE_TOKEN] })

      const db = openDb(t, sqlitePath)
      const transitions = statusTransitionEvents(db, brief.id).filter((event) => parseDetails(event)?.from === '进行中')
      assert.equal(transitions.length, 1)
      assert.deepEqual(parseDetails(transitions[0]), {
        task_id: brief.id,
        from: '进行中',
        to: '待认领',
        reason: '换人做',
      })
    })
  })

  describe('expiry', () => {
    test('check-on-read: after TTL, session GET list and GET one show 待认领, lease expired, actor_user_id null, reveal rows unchanged', async (t) => {
      const clock = freezeNow(t)
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'expiry-read')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'expiring')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)
      assert.equal(jsonBody(claimed).task.status, '进行中')

      const mid = await getTask(app, poster.cookies, brief.id)
      assert.equal(jsonBody(mid).status, '进行中')

      const db = openDb(t, sqlitePath)
      const revealsBefore = eventsOfType(db, TOKEN_REVEAL_EVENT).map((row) => JSON.stringify(row))

      clock.advanceMs((TTL_SECONDS - 1) * 1000)
      const stillLive = await getTask(app, poster.cookies, brief.id)
      assert.equal(stillLive.statusCode, 200)
      assert.equal(jsonBody(stillLive).status, '进行中')

      clock.advanceMs(1000)
      const fetched = await getTask(app, poster.cookies, brief.id)
      assert.equal(fetched.statusCode, 200, `GET after expiry: ${fetched.statusCode} ${fetched.body}`)
      assert.equal(jsonBody(fetched).status, '待认领')
      assertBriefShape(jsonBody(fetched))
      assertNoForgeSecretMaterial(fetched, INLINE_TOKEN)

      const listed = await listTasks(app, poster.cookies)
      assert.equal(listed.statusCode, 200)
      assert.equal(jsonBody(listed).tasks[0].status, '待认领')
      assertNoForgeSecretMaterial(listed, INLINE_TOKEN)

      const task = taskRow(db, brief.id)
      assert.equal(task.status, '待认领')
      const leases = leaseRows(db, task.id)
      assert.equal(leases.length, 1)
      assert.equal(leases[0].state, 'expired')
      assert.equal(activeLeaseRows(db, task.id).length, 0)

      const expiryTransitions = statusTransitionEvents(db, brief.id).filter((event) => {
        const details = parseDetails(event)
        return details?.from === '进行中' && details?.to === '待认领'
      })
      assert.equal(expiryTransitions.length, 1)
      assert.equal(expiryTransitions[0].actor_user_id, null)
      assert.deepEqual(parseDetails(expiryTransitions[0]), {
        task_id: brief.id,
        from: '进行中',
        to: '待认领',
      })

      const revealsAfter = eventsOfType(db, TOKEN_REVEAL_EVENT).map((row) => JSON.stringify(row))
      assert.deepEqual(revealsAfter, revealsBefore)
    })

    test('check-on-write: after TTL, progress sweeps then returns 409 任务未被认领', async (t) => {
      const clock = freezeNow(t)
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'expiry-write')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'late-heart')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      clock.advanceMs(TTL_SECONDS * 1000)
      const progressed = await progressTask(app, { identity: key.identity, publicId: brief.id, payload: { note: 'too late' } })
      assert.equal(progressed.statusCode, 409, `progress after TTL: ${progressed.statusCode} ${progressed.body}`)
      assert.deepEqual(jsonBody(progressed), { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE })
      assertNoForgeSecretMaterial(progressed, INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(task.status, '待认领')
      assert.equal(leaseRows(db, task.id)[0].state, 'expired')
      assert.equal(heartbeatEvents(db, brief.id).length, 0)
      const expiryTransitions = statusTransitionEvents(db, brief.id).filter((event) => parseDetails(event)?.to === '待认领')
      assert.equal(expiryTransitions[0].actor_user_id, null)
    })

    test('after expiry a different Agent Key can claim again and writes a second token 揭示', async (t) => {
      const clock = freezeNow(t)
      const sqlitePath = sqliteFile(t)
      withAdmins(t, 'gitlab:gl-expiry-reclaim-other')
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'expiry-reclaim-owner')
      const other = await loginGitlab(app, stub, 'expiry-reclaim-other')
      assert.equal(other.body.permission_level, 'full')
      const { brief } = await createTaskOk(app, poster.cookies)
      const firstKey = await mintAgentKey(app, poster.cookies, 'first')
      const secondKey = await pairDeviceToClaimant(app, poster.cookies, 'second', { hostname: 'second' })

      const first = await claimTask(app, { identity: firstKey.identity, publicId: brief.id })
      assert.equal(first.statusCode, 201, `first claim: ${first.statusCode} ${first.body}`)

      clock.advanceMs(TTL_SECONDS * 1000)
      const second = await claimTask(app, { identity: secondKey.identity, publicId: brief.id })
      assertClaim201(second, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })

      const db = openDb(t, sqlitePath)
      const reveals = claimRevealEvents(db, brief.id)
      assert.equal(reveals.length, 2, `expected two claim reveals, got ${JSON.stringify(reveals.map(parseDetails))}`)
      assert.equal(Number(parseDetails(reveals[0]).device_id), Number(firstKey.id))
      assert.equal(Number(parseDetails(reveals[1]).device_id), Number(secondKey.id))

      const task = taskRow(db, brief.id)
      assert.equal(task.status, '进行中')
      const leases = leaseRows(db, task.id)
      assert.equal(leases.filter((row) => row.state === 'expired').length, 1)
      assert.equal(activeLeaseRows(db, task.id).length, 1)
      assert.equal(Number(activeLeaseRows(db, task.id)[0].device_id), Number(secondKey.id))
    })
  })

  describe('reveal audit', () => {
    test('inline claim writes token 揭示 { task_id, device_id, credential: inline } and 状态迁移 待认领→进行中', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'audit-inline')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'inline-audit')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)
      assert.equal(jsonBody(claimed).token, INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      const reveals = claimRevealEvents(db, brief.id)
      assert.equal(reveals.length, 1)
      assert.equal(Number(reveals[0].actor_user_id), Number(poster.body.id))
      // Issue #36: the reveal event's details gain claim_id/request_id/autonomous (a legacy claim
      // with no request_id records request_id: null, autonomous: false) — claim_id is a derived
      // hash, so its shape is checked separately and then substituted into the exact-match below.
      const inlineRevealDetails = parseDetails(reveals[0])
      assert.equal(typeof inlineRevealDetails.claim_id, 'string')
      assert.match(inlineRevealDetails.claim_id, /^clm_/)
      assert.deepEqual(inlineRevealDetails, {
        task_id: brief.id,
        device_id: key.id,
        credential: 'inline',
        claim_id: inlineRevealDetails.claim_id,
        request_id: null,
        autonomous: false,
      })
      assert.equal(Object.hasOwn(parseDetails(reveals[0]), 'profile_id'), false)
      assertEventOmitsSecrets(reveals[0], INLINE_TOKEN, key.identity.publicKeySpkiB64)

      const started = statusTransitionEvents(db, brief.id).filter((event) => parseDetails(event)?.to === '进行中')
      assert.equal(started.length, 1)
      assert.equal(Number(started[0].actor_user_id), Number(poster.body.id))
      assert.deepEqual(parseDetails(started[0]), {
        task_id: brief.id,
        from: '待认领',
        to: '进行中',
      })
    })

    test('profile claim writes token 揭示 with credential profile and integer profile_id; no plaintext or ciphertext', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'audit-profile')
      const profile = await postProfile(app, poster.cookies)
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ credential: { profile_id: profile.id } }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'profile-audit')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)
      assert.equal(jsonBody(claimed).token, PROFILE_TOKEN)

      const db = openDb(t, sqlitePath)
      const ciphertext = profileCiphertext(db, profile.id)
      const reveals = claimRevealEvents(db, brief.id)
      assert.equal(reveals.length, 1)
      // Issue #36: same claim_id/request_id/autonomous addition as the inline case above.
      const profileRevealDetails = parseDetails(reveals[0])
      assert.equal(typeof profileRevealDetails.claim_id, 'string')
      assert.match(profileRevealDetails.claim_id, /^clm_/)
      assert.deepEqual(profileRevealDetails, {
        task_id: brief.id,
        device_id: key.id,
        credential: 'profile',
        profile_id: Number(profile.id),
        claim_id: profileRevealDetails.claim_id,
        request_id: null,
        autonomous: false,
      })
      assertEventOmitsSecrets(reveals[0], PROFILE_TOKEN, key.identity.publicKeySpkiB64, ciphertext)
    })
  })

  describe('leases table', () => {
    test('successful claim inserts one active lease keyed by tasks.id PK; at most one active row per task', async (t) => {
      const clock = freezeNow(t)
      const sqlitePath = sqliteFile(t)
      withAdmins(t, 'gitlab:gl-lease-rival')
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'lease-row')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'lease-bot')

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.ok(Number.isInteger(Number(task.id)) && Number(task.id) > 0)
      const leases = leaseRows(db, task.id)
      assert.equal(leases.length, 1)
      assertLiveLease(leases[0], {
        taskPk: task.id,
        userId: poster.body.id,
        deviceId: key.id,
        nowUnix: clock.unix(),
      })
      assert.equal(activeLeaseRows(db, task.id).length, 1)

      const rival = await loginGitlab(app, stub, 'lease-rival')
      assert.equal(rival.body.permission_level, 'full')
      const rivalKey = await pairDeviceToClaimant(app, poster.cookies, 'lease-rival', { hostname: 'rival' })
      const second = await claimTask(app, { identity: rivalKey.identity, publicId: brief.id })
      assert.equal(second.statusCode, 409)
      assert.equal(activeLeaseRows(db, task.id).length, 1)
      assert.equal(Number(activeLeaseRows(db, task.id)[0].device_id), Number(key.id))
    })
  })
})
