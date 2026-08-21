import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTaskBrief } from '@kaola/shared'
import { createDb } from './db.ts'

// Issue #16 claim-confirmation gate for autonomous polling agents (REST + MCP).
// Seams copied from claim.test.ts and mcp.test.ts (do not import either). Oracle:
// kaola-workflow/bundle-15-16/.cache/orchestrator-rulings.md §"#16" +
// kaola-workflow/bundle-15-16/.cache/ground-truth.md. Handoff:
// kaola-workflow/bundle-15-16/.cache/tests-claim-confirm.md.
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'cd'.repeat(32)

const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const REPO_FULL_NAME = 'team/orders'

const INLINE_TOKEN = 'gitea-INLINE-ONE-OFF-TOKEN-zzq7'

const PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'
const TOKEN_REVEAL_EVENT = 'token 揭示'
const PENDING_CONFIRM_EVENT = '认领待确认'
const CONFIRM_APPROVED_EVENT = '认领已确认'
const TTL_SECONDS = 86400
const FROZEN_MS = Date.UTC(2026, 7, 21, 4, 0, 0)
const CLONE_TOKEN_USAGE =
  'token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。'
const AGENT_KEY_RE = /^ktk_[0-9a-f]{64}$/
const MCP_PATH = '/api/mcp'
const MCP_PROTOCOL_VERSION = '2025-11-25'

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
  github: {
    decoratorName: 'githubOAuth2',
    startPath: '/login/github',
    callbackPath: '/login/github/callback',
  },
  gitlab: {
    decoratorName: 'gitlabOAuth2',
    startPath: '/login/gitlab',
    callbackPath: '/login/gitlab/callback',
  },
  gitea: {
    decoratorName: 'giteaOAuth2',
    startPath: '/login/gitea',
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
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
    },
  })
}

function sqliteFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-claim-confirm-'))
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
  const accessToken = nextAccessToken(label)
  stub.oauth.set(accessToken, {
    id: 80000 + tokenSeq,
    username: `gl-${label}`,
    name: `Git Lab ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })
}

async function loginGitea(app, stub, label = 'gitea') {
  const accessToken = nextAccessToken(label)
  stub.oauth.set(accessToken, {
    id: 70000 + tokenSeq,
    login: `gt-${label}`,
    full_name: `Gi Tea ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitea, accessToken })
}

// Fixed remote id so two logins (e.g. against two `buildApp` instances on the same sqlite
// file) resolve to the *same* underlying user row, for the cross-restart persistence test.
async function loginGiteaFixed(app, stub, remoteId, label = 'gitea-fixed') {
  const accessToken = nextAccessToken(label)
  stub.oauth.set(accessToken, {
    id: remoteId,
    login: `gt-${label}`,
    full_name: `Gi Tea ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitea, accessToken })
}

async function loginGithub(app, stub, label = 'github') {
  const accessToken = nextAccessToken(label)
  stub.oauth.set(accessToken, {
    id: 60000 + tokenSeq,
    login: `gh-${label}`,
    name: `Octo ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.github, accessToken })
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
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/agent-keys',
    cookies,
    headers: jsonHeaders,
    payload: { label },
  })
  assert.equal(res.statusCode, 201, `POST /api/v1/agent-keys: ${res.statusCode} ${res.body}`)
  const body = jsonBody(res)
  assert.match(String(body?.token ?? ''), AGENT_KEY_RE)
  return { id: body.id, token: body.token, label: body.label }
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

// Missing `autonomous` => omit the body entirely (today's real clients send none).
async function claimTaskAutonomous(app, { token, publicId, autonomous }) {
  const req = {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/claim`,
    headers: bearerHeaders(token),
  }
  if (autonomous !== undefined) req.payload = { autonomous }
  return app.inject(req)
}

async function getMe(app, cookies) {
  return app.inject({ method: 'GET', url: '/api/v1/me', cookies, headers: jsonHeaders })
}

async function putSettings(app, cookies, trustedAutomation) {
  return app.inject({
    method: 'PUT',
    url: '/api/v1/me/settings',
    cookies,
    headers: jsonHeaders,
    payload: { trusted_automation: trustedAutomation },
  })
}

async function getClaimConfirmations(app, cookies) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/claim-confirmations',
    cookies,
    headers: jsonHeaders,
  })
}

async function approveConfirmation(app, cookies, id) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/claim-confirmations/${id}/approve`,
    cookies,
    headers: jsonHeaders,
  })
}

async function rejectConfirmation(app, cookies, id) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/claim-confirmations/${id}/reject`,
    cookies,
    headers: jsonHeaders,
  })
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

// For any non-token-reveal response: no forge plaintext, no secret key names (including `token`).
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

function assertNoForgeSecretValue(value, dumped, ...plaintexts) {
  const text = dumped ?? JSON.stringify(value)
  for (const plaintext of plaintexts) {
    assert.equal(text.includes(plaintext), false, `payload leaked plaintext token ${plaintext}: ${text}`)
  }
  for (const key of collectKeys(value)) {
    assert.equal(SECRET_KEY_NAMES.has(key), false, `payload carried a secret-bearing key "${key}": ${text}`)
  }
}

// Claim 201 (or its MCP equivalent) is allowed to have a top-level `token` equal to the fixture
// forge plaintext; nothing nested may repeat it.
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
  assert.deepEqual(Object.keys(body.lease).sort(), ['expires_at', 'ttl_seconds'])
  assert.equal(body.lease.ttl_seconds, TTL_SECONDS)
  assert.equal(body.lease.expires_at, expiresAtIso(nowUnix))
  assert.deepEqual(Object.keys(body.clone).sort(), ['suggested_dir', 'token_usage'])
  assert.equal(body.clone.suggested_dir, suggestedDir)
  assert.equal(body.clone.token_usage, CLONE_TOKEN_USAGE)
  return body
}

function assertPending202(res, { secretPlaintexts = [] } = {}) {
  assert.equal(res.statusCode, 202, `expected 202 confirmation_required, got ${res.statusCode}: ${res.body}`)
  const body = jsonBody(res)
  assert.equal(body.error, 'confirmation_required')
  assert.equal(typeof body.message, 'string')
  assert.ok(body.message.length > 0, 'pending message must be non-empty Chinese copy')
  assert.equal(Object.hasOwn(body, 'token'), false, 'pending body must omit token')
  assertNoForgeSecretMaterial(res, ...secretPlaintexts)
  return body
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
    return details?.task_id === publicId && details?.agent_key_id != null
  })
}

function pendingConfirmEvents(db, publicId) {
  return eventsOfType(db, PENDING_CONFIRM_EVENT).filter((event) => parseDetails(event)?.task_id === publicId)
}

function confirmApprovedEvents(db, publicId) {
  return eventsOfType(db, CONFIRM_APPROVED_EVENT).filter((event) => parseDetails(event)?.task_id === publicId)
}

function taskRow(db, publicId) {
  return db.$client
    .prepare(
      'SELECT id, public_id, status, poster_user_id, credential_profile_id, inline_token_encrypted FROM tasks WHERE public_id = ?',
    )
    .get(publicId)
}

function leaseRows(db, taskPk) {
  return db.$client
    .prepare(
      'SELECT task_id, claimer_user_id, agent_key_id, claimed_at, expires_at, last_heartbeat, state FROM leases WHERE task_id = ?',
    )
    .all(taskPk)
}

// `claim_confirmations` schema is pinned by the oracle (orchestrator-rulings.md §16):
// id, task_id (tasks.id PK, NOT the public_id string), user_id, agent_key_id, state, created_at.
function claimConfirmationRows(db, taskPk, userId, agentKeyId) {
  return db.$client
    .prepare(
      'SELECT id, task_id, user_id, agent_key_id, state, created_at FROM claim_confirmations WHERE task_id = ? AND user_id = ? AND agent_key_id = ?',
    )
    .all(taskPk, userId, agentKeyId)
}

function seedClaimConfirmation(db, { taskPk, userId, agentKeyId, state, createdAt }) {
  db.$client
    .prepare(
      'INSERT INTO claim_confirmations (task_id, user_id, agent_key_id, state, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(taskPk, userId, agentKeyId, state, createdAt)
}

async function boot(t) {
  const app = await createApp(t)
  const stub = beginFetch(t)
  allowForgeToken(stub, INLINE_TOKEN)
  return { app, stub }
}

// --- MCP seams (copied from mcp.test.ts, not imported) ---------------------------------------

function mcpHeaders({ token, sessionId, extra } = {}) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...extra,
  }
  if (token != null) headers.authorization = `Bearer ${token}`
  if (sessionId != null) headers['mcp-session-id'] = sessionId
  return headers
}

async function postMcp(app, { token, cookies, sessionId, extraHeaders, payload }) {
  return app.inject({
    method: 'POST',
    url: MCP_PATH,
    headers: mcpHeaders({ token, sessionId, extra: extraHeaders }),
    cookies,
    payload,
  })
}

function parseSseMessages(body) {
  const messages = []
  const chunks = String(body).split(/\r?\n\r?\n/)
  for (const chunk of chunks) {
    if (!chunk.trim()) continue
    let eventName = 'message'
    const dataParts = []
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataParts.push(line.slice('data:'.length).replace(/^\s/, ''))
    }
    if (eventName === 'message' && dataParts.length > 0) {
      messages.push(JSON.parse(dataParts.join('\n')))
    }
  }
  return messages
}

function parseJsonRpcHttp(res) {
  const contentType = String(res.headers['content-type'] ?? '')
  const body = String(res.body ?? '')
  if (contentType.includes('text/event-stream') || /^\s*event:/m.test(body) || /^\s*data:/m.test(body)) {
    const messages = parseSseMessages(body)
    assert.ok(
      messages.length > 0,
      `expected SSE event: message JSON-RPC payloads, status ${res.statusCode}: ${body}`,
    )
    return messages
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    assert.fail(`MCP response was not JSON or SSE (status ${res.statusCode}): ${body}`)
  }
  return Array.isArray(parsed) ? parsed : [parsed]
}

function jsonRpcById(messages, id) {
  const hit = messages.find((message) => message && message.id === id)
  assert.ok(hit, `no JSON-RPC message with id ${id}: ${JSON.stringify(messages)}`)
  return hit
}

function toolStructured(result) {
  if (result?.structuredContent != null) return result.structuredContent
  const texts = Array.isArray(result?.content)
    ? result.content.filter((block) => block?.type === 'text').map((block) => block.text)
    : []
  assert.ok(
    texts.length > 0,
    `tool result has neither structuredContent nor text content: ${JSON.stringify(result)}`,
  )
  try {
    return JSON.parse(texts[0])
  } catch {
    assert.fail(`tool text content was not JSON: ${texts[0]}`)
  }
}

function assertToolOk(result) {
  assert.notEqual(result?.isError, true, `expected success tool result, got: ${JSON.stringify(result)}`)
  return toolStructured(result)
}

function createMcpClient() {
  let nextId = 1
  let sessionId
  return {
    async initialize(app, token) {
      const id = nextId
      nextId += 1
      const res = await postMcp(app, {
        token,
        sessionId,
        payload: {
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'kaola-mcp-test', version: '0.0.0' },
          },
        },
      })
      assert.equal(res.statusCode, 200, `MCP initialize HTTP: ${res.statusCode} ${res.body}`)
      const rpc = jsonRpcById(parseJsonRpcHttp(res), id)
      assert.equal(rpc.error, undefined, `MCP initialize JSON-RPC error: ${JSON.stringify(rpc.error)}`)
      const header = res.headers['mcp-session-id']
      if (header != null && header !== '') sessionId = String(header)
      if (sessionId != null) {
        await postMcp(app, {
          token,
          sessionId,
          payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
        })
      }
      return { res, rpc, sessionId }
    },
    async callTool(app, token, name, args = {}) {
      const id = nextId
      nextId += 1
      const res = await postMcp(app, {
        token,
        sessionId,
        payload: {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        },
      })
      assert.equal(res.statusCode, 200, `tools/call ${name} HTTP: ${res.statusCode} ${res.body}`)
      const rpc = jsonRpcById(parseJsonRpcHttp(res), id)
      assert.equal(
        rpc.error,
        undefined,
        `tools/call ${name} must be a JSON-RPC result, not a protocol error: ${JSON.stringify(rpc.error)}`,
      )
      return { res, rpc, result: rpc.result }
    },
  }
}

async function readyMcp(app, token) {
  const client = createMcpClient()
  await client.initialize(app, token)
  return client
}

function assertClaimEnvelope(body, { forgeToken, suggestedDir, nowUnix }) {
  assert.equal(typeof body, 'object')
  assert.ok(body)
  assert.deepEqual(Object.keys(body).sort(), ['clone', 'lease', 'task', 'token'])
  assertBriefShape(body.task)
  assert.equal(body.task.status, '进行中')
  assertClaimRevealToken(body, forgeToken)
  assert.deepEqual(Object.keys(body.lease).sort(), ['expires_at', 'ttl_seconds'])
  assert.equal(body.lease.ttl_seconds, TTL_SECONDS)
  assert.equal(body.lease.expires_at, expiresAtIso(nowUnix))
  assert.deepEqual(Object.keys(body.clone).sort(), ['suggested_dir', 'token_usage'])
  assert.equal(body.clone.suggested_dir, suggestedDir)
  assert.equal(body.clone.token_usage, CLONE_TOKEN_USAGE)
}

// ------------------------------------------------------------------------------------------

describe('issue #16 claim-confirmation for autonomous polling agents', { concurrency: false }, () => {
  describe('instructed claims stay MVP 认领即授权 (comment overrides the issue body)', () => {
    test('no body and explicit autonomous:false both still return 201 with a token (assertClaim201 shape unchanged)', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'instructed-no-body')
      const first = await createTaskOk(app, poster.cookies)
      const second = await createTaskOk(app, poster.cookies, taskPayload({ title: '第二张' }))
      const key = await mintAgentKey(app, poster.cookies, 'instructed')

      const noBody = await claimTaskAutonomous(app, { token: key.token, publicId: first.brief.id })
      assertClaim201(noBody, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: first.brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })

      const explicitFalse = await claimTaskAutonomous(app, {
        token: key.token,
        publicId: second.brief.id,
        autonomous: false,
      })
      assertClaim201(explicitFalse, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: second.brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
    })

    test('MCP claim_task without autonomous still returns the token envelope', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'instructed-mcp')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'mcp-instructed')
      const client = await readyMcp(app, key.token)

      const called = await client.callTool(app, key.token, 'claim_task', { task_id: brief.id })
      const envelope = assertToolOk(called.result)
      assertClaimEnvelope(envelope, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
    })

    test('instructed claim ignores a leftover rejected confirmation row for the same (task, user, key)', async (t) => {
      const clock = freezeNow(t)
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'instructed-ignore-rejected')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'ignore-rejected')
      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      seedClaimConfirmation(db, {
        taskPk: task.id,
        userId: poster.body.id,
        agentKeyId: key.id,
        state: 'rejected',
        createdAt: clock.unix(),
      })

      const res = await claimTaskAutonomous(app, { token: key.token, publicId: brief.id })
      assertClaim201(res, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
    })
  })

  describe('autonomous claim gate — 待批准 first', () => {
    test('待批准 users are still 403 before the autonomous gate, even with autonomous:true', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const member = await loginGitea(app, stub, 'pending-gate-owner')
      const pending = await loginGithub(app, stub, 'pending-gate-claimer')
      assert.equal(pending.body.status, '待批准')
      const { brief } = await createTaskOk(app, member.cookies)
      const db = openDb(t, sqlitePath)
      const seeded = seedAgentKey(db, pending.body.id)

      const res = await claimTaskAutonomous(app, { token: seeded.token, publicId: brief.id, autonomous: true })
      assert.equal(res.statusCode, 403, `pending autonomous claim: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'forbidden')
      assert.equal(jsonBody(res)?.message, PENDING_CLAIM_MESSAGE)
      assertNoForgeSecretMaterial(res, INLINE_TOKEN)
      assert.equal(eventsOfType(db, PENDING_CONFIRM_EVENT).length, 0)
    })
  })

  describe('autonomous claim gate — automation off (default)', () => {
    test('autonomous + off + unconfirmed → 202 confirmation_required; no token; no token 揭示; task stays 待认领; writes 认领待确认', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'auto-off')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'poller')

      const res = await claimTaskAutonomous(app, { token: key.token, publicId: brief.id, autonomous: true })
      assertPending202(res, { secretPlaintexts: [INLINE_TOKEN] })

      const db = openDb(t, sqlitePath)
      assert.equal(claimRevealEvents(db, brief.id).length, 0)
      assert.equal(eventsOfType(db, TOKEN_REVEAL_EVENT).length, 0)
      const parkedEvents = pendingConfirmEvents(db, brief.id)
      assert.equal(parkedEvents.length, 1, `expected one 认领待确认, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(Number(parkedEvents[0].actor_user_id), Number(poster.body.id))
      assert.deepEqual(parseDetails(parkedEvents[0]), { task_id: brief.id, agent_key_id: key.id })

      const task = taskRow(db, brief.id)
      assert.equal(task.status, '待认领')
      assert.equal(leaseRows(db, task.id).length, 0)

      const confirmations = await getClaimConfirmations(app, poster.cookies)
      assert.equal(confirmations.statusCode, 200, `GET confirmations: ${confirmations.statusCode} ${confirmations.body}`)
      const list = jsonBody(confirmations).confirmations
      assert.equal(list.length, 1)
      assert.equal(list[0].task_id, brief.id)
      assert.equal(list[0].state, 'pending')
      assertNoForgeSecretMaterial(confirmations, INLINE_TOKEN)
    })

    test('MCP claim_task autonomous:true pending is isError false, structuredContent { pending:true, error:confirmation_required }, no token', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'auto-off-mcp')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'mcp-poller')
      const client = await readyMcp(app, key.token)

      const called = await client.callTool(app, key.token, 'claim_task', { task_id: brief.id, autonomous: true })
      assert.notEqual(
        called.result?.isError,
        true,
        `pending must be isError false, got ${JSON.stringify(called.result)}`,
      )
      const body = toolStructured(called.result)
      assert.equal(body.pending, true)
      assert.equal(body.error, 'confirmation_required')
      assert.equal(Object.hasOwn(body, 'token'), false)
      assertNoForgeSecretValue(body, JSON.stringify(called.result), INLINE_TOKEN)
      assertNoForgeSecretMaterial(called.res, INLINE_TOKEN)
    })

    test('idempotent re-request while pending returns 202 again and reuses one pending row', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'auto-off-idem')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'idempotent')

      const first = await claimTaskAutonomous(app, { token: key.token, publicId: brief.id, autonomous: true })
      assertPending202(first, { secretPlaintexts: [INLINE_TOKEN] })
      const second = await claimTaskAutonomous(app, { token: key.token, publicId: brief.id, autonomous: true })
      assertPending202(second, { secretPlaintexts: [INLINE_TOKEN] })
      assert.deepEqual(jsonBody(first), jsonBody(second))

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      const rows = claimConfirmationRows(db, task.id, poster.body.id, key.id)
      assert.equal(rows.length, 1, `expected one reused pending row, got ${JSON.stringify(rows)}`)
      assert.equal(rows[0].state, 'pending')
    })
  })

  describe('settings — trusted_automation', () => {
    test('GET /api/v1/me defaults trusted_automation false; PUT settings true unlocks 直通 201; PUT false again reinstates 202', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'settings-toggle')
      assert.equal(poster.body.trusted_automation, false)

      const meAgain = await getMe(app, poster.cookies)
      assert.equal(jsonBody(meAgain).trusted_automation, false)
      assertNoForgeSecretMaterial(meAgain, INLINE_TOKEN)

      const first = await createTaskOk(app, poster.cookies)
      const second = await createTaskOk(app, poster.cookies, taskPayload({ title: '第二张' }))
      const key = await mintAgentKey(app, poster.cookies, 'toggle-bot')

      const stillOff = await claimTaskAutonomous(app, { token: key.token, publicId: first.brief.id, autonomous: true })
      assertPending202(stillOff, { secretPlaintexts: [INLINE_TOKEN] })

      const on = await putSettings(app, poster.cookies, true)
      assert.equal(on.statusCode, 200, `PUT settings true: ${on.statusCode} ${on.body}`)
      assert.deepEqual(jsonBody(on), { trusted_automation: true })
      assertNoForgeSecretMaterial(on, INLINE_TOKEN)

      const meOn = await getMe(app, poster.cookies)
      assert.equal(jsonBody(meOn).trusted_automation, true)

      const throughput = await claimTaskAutonomous(app, { token: key.token, publicId: first.brief.id, autonomous: true })
      assertClaim201(throughput, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: first.brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })

      const off = await putSettings(app, poster.cookies, false)
      assert.equal(off.statusCode, 200, `PUT settings false: ${off.statusCode} ${off.body}`)
      assert.deepEqual(jsonBody(off), { trusted_automation: false })
      assertNoForgeSecretMaterial(off, INLINE_TOKEN)

      const backToPending = await claimTaskAutonomous(app, {
        token: key.token,
        publicId: second.brief.id,
        autonomous: true,
      })
      assertPending202(backToPending, { secretPlaintexts: [INLINE_TOKEN] })
    })

    test('trusted_automation persists across a new buildApp on the same sqlite file path', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app1 = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const REMOTE_ID = '990001'
      const owner1 = await loginGiteaFixed(app1, stub, REMOTE_ID, 'restart-owner-1')

      const on = await putSettings(app1, owner1.cookies, true)
      assert.equal(on.statusCode, 200, `PUT settings on app1: ${on.statusCode} ${on.body}`)
      assert.deepEqual(jsonBody(on), { trusted_automation: true })

      const app2 = await createApp(t, sqlitePath)
      const owner2 = await loginGiteaFixed(app2, stub, REMOTE_ID, 'restart-owner-2')
      assert.equal(
        owner2.body.id,
        owner1.body.id,
        'expected the same underlying user row across both buildApp instances (same provider + remote_id)',
      )
      assert.equal(
        owner2.body.trusted_automation,
        true,
        'trusted_automation must persist across a new buildApp on the same sqlite file path',
      )
    })
  })

  describe('approve / reject a pending claim confirmation (session, not Bearer)', () => {
    test('approve consumes the pending row: agent retry succeeds; approve itself reveals no token, inserts no lease, flips no status', async (t) => {
      const clock = freezeNow(t)
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const owner = await loginGitea(app, stub, 'approve-flow-owner')
      const { brief } = await createTaskOk(app, owner.cookies)
      const key = await mintAgentKey(app, owner.cookies, 'approve-bot')

      const parked = await claimTaskAutonomous(app, { token: key.token, publicId: brief.id, autonomous: true })
      assertPending202(parked, { secretPlaintexts: [INLINE_TOKEN] })

      const listRes = await getClaimConfirmations(app, owner.cookies)
      const list = jsonBody(listRes).confirmations
      assert.equal(list.length, 1)
      const confirmationId = list[0].id

      const approve = await approveConfirmation(app, owner.cookies, confirmationId)
      assert.equal(approve.statusCode, 200, `approve: ${approve.statusCode} ${approve.body}`)
      assertNoForgeSecretMaterial(approve, INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(task.status, '待认领', 'approve itself must not flip task status')
      assert.equal(leaseRows(db, task.id).length, 0, 'approve itself must not insert a lease')
      assert.equal(claimRevealEvents(db, brief.id).length, 0, 'approve itself must not reveal the token')
      const approved = confirmApprovedEvents(db, brief.id)
      assert.equal(approved.length, 1, `expected one 认领已确认, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(Number(approved[0].actor_user_id), Number(owner.body.id))
      assert.deepEqual(parseDetails(approved[0]), { task_id: brief.id, agent_key_id: key.id })

      const retry = await claimTaskAutonomous(app, { token: key.token, publicId: brief.id, autonomous: true })
      assertClaim201(retry, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })

      const release = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${brief.id}/release`,
        headers: bearerHeaders(key.token),
      })
      assert.equal(release.statusCode, 200, `setup release: ${release.statusCode} ${release.body}`)

      const staleReplay = await claimTaskAutonomous(app, { token: key.token, publicId: brief.id, autonomous: true })
      assert.equal(
        staleReplay.statusCode,
        202,
        `a consumed approval must not grant a second free claim: ${staleReplay.statusCode} ${staleReplay.body}`,
      )
    })

    test('MCP: approve a pending confirmation then retry claim_task succeeds with a token', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const owner = await loginGitea(app, stub, 'mcp-approve-owner')
      const { brief } = await createTaskOk(app, owner.cookies)
      const key = await mintAgentKey(app, owner.cookies, 'mcp-approve-bot')
      const client = await readyMcp(app, key.token)

      const parked = await client.callTool(app, key.token, 'claim_task', { task_id: brief.id, autonomous: true })
      const pendingBody = toolStructured(parked.result)
      assert.equal(pendingBody.pending, true)
      assert.equal(Object.hasOwn(pendingBody, 'token'), false)

      const listRes = await getClaimConfirmations(app, owner.cookies)
      const list = jsonBody(listRes).confirmations
      assert.equal(list.length, 1)
      const approve = await approveConfirmation(app, owner.cookies, list[0].id)
      assert.equal(approve.statusCode, 200, `approve: ${approve.statusCode} ${approve.body}`)

      const retry = await client.callTool(app, key.token, 'claim_task', { task_id: brief.id, autonomous: true })
      const envelope = assertToolOk(retry.result)
      assertClaimEnvelope(envelope, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
    })

    test('reject sets state rejected; retry of autonomous claim starts a fresh pending, still no token', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const owner = await loginGitea(app, stub, 'reject-flow-owner')
      const { brief } = await createTaskOk(app, owner.cookies)
      const key = await mintAgentKey(app, owner.cookies, 'reject-bot')

      const parked = await claimTaskAutonomous(app, { token: key.token, publicId: brief.id, autonomous: true })
      assertPending202(parked, { secretPlaintexts: [INLINE_TOKEN] })
      const listRes = await getClaimConfirmations(app, owner.cookies)
      const confirmationId = jsonBody(listRes).confirmations[0].id

      const reject = await rejectConfirmation(app, owner.cookies, confirmationId)
      assert.equal(reject.statusCode, 200, `reject: ${reject.statusCode} ${reject.body}`)
      assertNoForgeSecretMaterial(reject, INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      assert.equal(claimRevealEvents(db, brief.id).length, 0)

      const retry = await claimTaskAutonomous(app, { token: key.token, publicId: brief.id, autonomous: true })
      assertPending202(retry, { secretPlaintexts: [INLINE_TOKEN] })

      const listAfterRes = await getClaimConfirmations(app, owner.cookies)
      const listAfter = jsonBody(listAfterRes).confirmations
      const pendingAfter = listAfter.filter((row) => row.state === 'pending' && row.task_id === brief.id)
      assert.equal(
        pendingAfter.length,
        1,
        `expected a fresh pending row after reject+retry, got ${JSON.stringify(listAfter)}`,
      )
    })

    test("approve/reject on another user's confirmation id is 404; GET list only shows the current user's rows", async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const ownerA = await loginGitea(app, stub, 'other-user-a')
      const ownerB = await loginGitlab(app, stub, 'other-user-b')
      const { brief } = await createTaskOk(app, ownerA.cookies)
      const keyA = await mintAgentKey(app, ownerA.cookies, 'a-bot')

      const parked = await claimTaskAutonomous(app, { token: keyA.token, publicId: brief.id, autonomous: true })
      assertPending202(parked, { secretPlaintexts: [INLINE_TOKEN] })
      const listARes = await getClaimConfirmations(app, ownerA.cookies)
      const listA = jsonBody(listARes).confirmations
      assert.equal(listA.length, 1)
      const confirmationId = listA[0].id

      const listBRes = await getClaimConfirmations(app, ownerB.cookies)
      assert.equal(listBRes.statusCode, 200)
      const listB = jsonBody(listBRes).confirmations
      assert.equal(listB.length, 0, "user B must not see user A's pending confirmations")

      const approveByB = await approveConfirmation(app, ownerB.cookies, confirmationId)
      assert.equal(approveByB.statusCode, 404, `approve by non-owner: ${approveByB.statusCode} ${approveByB.body}`)

      const rejectByB = await rejectConfirmation(app, ownerB.cookies, confirmationId)
      assert.equal(rejectByB.statusCode, 404, `reject by non-owner: ${rejectByB.statusCode} ${rejectByB.body}`)

      const db = openDb(t, sqlitePath)
      assert.equal(pendingConfirmEvents(db, brief.id).length, 1)
      assert.equal(confirmApprovedEvents(db, brief.id).length, 0)
    })
  })

  describe('authentication sanity around the new surfaces', () => {
    test('an unauthenticated session cannot read or act on claim-confirmations, and Bearer alone does not authorize them', async (t) => {
      const { app, stub } = await boot(t)
      const owner = await loginGitea(app, stub, 'session-auth-only')
      const { brief } = await createTaskOk(app, owner.cookies)
      const key = await mintAgentKey(app, owner.cookies, 'session-auth-bot')
      const parked = await claimTaskAutonomous(app, { token: key.token, publicId: brief.id, autonomous: true })
      assertPending202(parked, { secretPlaintexts: [INLINE_TOKEN] })

      const noSession = await app.inject({
        method: 'GET',
        url: '/api/v1/claim-confirmations',
        headers: jsonHeaders,
      })
      assert.equal(
        noSession.statusCode,
        401,
        `unauthenticated GET confirmations should be 401, got ${noSession.statusCode}: ${noSession.body}`,
      )

      const bearerOnly = await app.inject({
        method: 'GET',
        url: '/api/v1/claim-confirmations',
        headers: bearerHeaders(key.token),
      })
      assert.notEqual(
        bearerOnly.statusCode,
        200,
        'Bearer Agent Key alone must not authorize the session-only claim-confirmations endpoint',
      )
    })
  })
})
