import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTaskBrief } from '@kaola/shared'
import { createDb } from './db.ts'
import { injectSigned, pairDeviceToSelf, pairDeviceToClaimant } from './device-proof.test-helpers.ts'
import { ensureSetup } from './auth.test-helpers.ts'

// Issue #10 MCP server. Seams copied from claim.test.ts (do not import that file).
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'cd'.repeat(32)

const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const REPO_FULL_NAME = 'team/orders'
const GITLAB_FORGE_BASE_URL = 'https://gitlab.forge.example.test'
const GITLAB_REPO_FULL_NAME = 'team/payments'
const GITHUB_FORGE_BASE_URL = 'https://github.com'
const GITHUB_REPO_FULL_NAME = 'octo/widget'

const INLINE_TOKEN = 'gitea-INLINE-ONE-OFF-TOKEN-zzq7'
const PROFILE_TOKEN = 'gitea-PROFILE-SHARED-TOKEN-vv31'
const GITLAB_FORGE_TOKEN = 'gitlab-FILTER-ONE-OFF-TOKEN-aa19'
const GITHUB_FORGE_TOKEN = 'github-INLINE-ONE-OFF-TOKEN-gh01'

const TASK_ALREADY_CLAIMED_MESSAGE = '任务已被认领。'
const TASK_NOT_CLAIMED_MESSAGE = '任务未被认领。'
const TOKEN_REVEAL_EVENT = 'token 揭示'
const STATUS_TRANSITION_EVENT = '状态迁移'
const HEARTBEAT_EVENT = '心跳'
const TTL_SECONDS = 86400
const FROZEN_MS = Date.UTC(2026, 7, 21, 4, 0, 0)
const CLONE_TOKEN_USAGE =
  'token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。'
const MCP_PATH = '/api/mcp'
const MCP_PROTOCOL_VERSION = '2025-11-25'
const TOOL_NAMES = [
  'list_tasks',
  'get_task_brief',
  'claim_task',
  'report_progress',
  'submit_pr',
  'release_task',
]

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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-mcp-'))
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

async function claimTaskHttp(app, { token, identity, publicId }) {
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
      'SELECT id, task_id, claimer_user_id, device_id, claimed_at, expires_at, last_heartbeat, state FROM leases WHERE task_id = ?',
    )
    .all(taskPk)
}

function activeLeaseRows(db, taskPk) {
  return leaseRows(db, taskPk).filter((row) => row.state === 'active')
}

function submissionRows(db, taskPk) {
  return db.$client
    .prepare('SELECT task_id, lease_id, pr_url, summary, pr_state FROM submissions WHERE task_id = ?')
    .all(taskPk)
}

async function boot(t, sqlitePath, opts = {}) {
  if (sqlitePath && typeof sqlitePath === 'object') {
    opts = sqlitePath
    sqlitePath = undefined
  }
  if (opts.admins) withAdmins(t, opts.admins)
  const app = await createApp(t, sqlitePath)
  const stub = beginFetch(t)
  allowForgeToken(stub, INLINE_TOKEN)
  allowForgeToken(stub, PROFILE_TOKEN)
  allowForgeToken(stub, GITLAB_FORGE_TOKEN, { repo: GITLAB_REPO_ACCESS })
  allowForgeToken(stub, GITHUB_FORGE_TOKEN)
  return { app, stub }
}

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

async function postMcp(app, { token, identity, cookies, sessionId, extraHeaders, payload }) {
  const proof = identity ?? (token && typeof token === 'object' && token.privateKey ? token : null)
  if (proof != null) {
    const extra = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(extraHeaders ?? {}),
    }
    if (sessionId != null) extra['mcp-session-id'] = sessionId
    return injectSigned(app, proof, {
      method: 'POST',
      url: MCP_PATH,
      payload,
      extraHeaders: extra,
    })
  }
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

function assertToolError(result, expected = {}) {
  assert.equal(result?.isError, true, `expected isError true, got: ${JSON.stringify(result)}`)
  const body = toolStructured(result)
  if (expected.error !== undefined) assert.equal(body.error, expected.error)
  if (expected.message !== undefined) assert.equal(body.message, expected.message)
  if (expected.omitMessage) {
    assert.equal(Object.hasOwn(body, 'message'), false, `error body must omit message: ${JSON.stringify(body)}`)
  }
  return body
}

function createMcpClient() {
  let nextId = 1
  let sessionId
  return {
    sessionId() {
      return sessionId
    },
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
    async listTools(app, token) {
      const id = nextId
      nextId += 1
      const res = await postMcp(app, {
        token,
        sessionId,
        payload: { jsonrpc: '2.0', id, method: 'tools/list', params: {} },
      })
      assert.equal(res.statusCode, 200, `tools/list HTTP: ${res.statusCode} ${res.body}`)
      const rpc = jsonRpcById(parseJsonRpcHttp(res), id)
      assert.equal(rpc.error, undefined, `tools/list JSON-RPC error: ${JSON.stringify(rpc.error)}`)
      const tools = rpc.result?.tools
      assert.ok(Array.isArray(tools), `tools/list result.tools must be an array: ${JSON.stringify(rpc.result)}`)
      return { res, rpc, tools }
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
  assertCloneRecipe(body.clone, {
    suggestedDir,
    repo: body.task.repo,
    forgePlaintext: forgeToken,
  })
  return body
}

describe('issue #10 MCP server', { concurrency: false }, () => {
  describe('authentication — device proof, HTTP 401 before JSON-RPC', () => {
    test('unauthenticated POST /api/mcp (missing device headers) is 401 unauthorized with WWW-Authenticate Kaola-Device', async (t) => {
      const { app } = await boot(t)
      const res = await postMcp(app, {
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      })
      assertBearerUnauthorized(res)
    })

    test('Token scheme, Basic, leftover ktk_, and wrong device proof on POST /api/mcp are 401 with WWW-Authenticate Kaola-Device', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'wrong-bearer')
      await mintAgentKey(app, poster.cookies, 'unused')
      const fake = `ktk_${'ab'.repeat(32)}`

      const wrong = await postMcp(app, {
        token: fake,
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      })
      assertBearerUnauthorized(wrong)

      const tokenScheme = await postMcp(app, {
        extraHeaders: { authorization: `Token ${fake}` },
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      })
      assertBearerUnauthorized(tokenScheme)

      const basic = await postMcp(app, {
        extraHeaders: { authorization: 'Basic dXNlcjpwYXNz' },
        payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } },
      })
      assertBearerUnauthorized(basic)
    })

    test('a session cookie without device proof does not authorize POST /api/mcp', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'session-only')
      await mintAgentKey(app, poster.cookies, 'unused')

      const res = await postMcp(app, {
        cookies: poster.cookies,
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      })
      assertBearerUnauthorized(res)
    })

    test('authenticated tools/list includes the six tools and claim_task describes token hygiene', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'tools-list')
      const key = await mintAgentKey(app, poster.cookies, 'lister')
      const client = await readyMcp(app, key.identity)
      const { tools } = await client.listTools(app, key.identity)

      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        [...TOOL_NAMES].sort(),
        `tools/list names: ${JSON.stringify(tools.map((tool) => tool.name))}`,
      )
      for (const name of TOOL_NAMES) {
        const tool = tools.find((entry) => entry.name === name)
        assert.equal(typeof tool.description, 'string')
        assert.ok(tool.description.length > 0, `${name} must have a description`)
      }
      const claim = tools.find((tool) => tool.name === 'claim_task')
      assert.equal(
        claim.description.includes(CLONE_TOKEN_USAGE),
        true,
        `claim_task description must contain the REST token-hygiene sentence: ${claim.description}`,
      )
      assert.match(
        claim.description,
        /omit(?:ting)?\s+`?autonomous`?/i,
        `claim_task description must mention omitting autonomous when the human instructed the claim: ${claim.description}`,
      )

      const listTasks = tools.find((tool) => tool.name === 'list_tasks')
      assert.ok(
        listTasks.description.includes('待认领'),
        `list_tasks description must mention 待认领: ${listTasks.description}`,
      )
      assert.match(
        listTasks.description,
        /never includes a forge token/i,
        `list_tasks description must say the list never includes a forge token: ${listTasks.description}`,
      )

      const submit = tools.find((tool) => tool.name === 'submit_pr')
      assert.ok(
        /\bPR\b/i.test(submit.description) && /\bMR\b/.test(submit.description),
        `submit_pr description must mention PR/MR: ${submit.description}`,
      )
      assert.match(
        submit.description,
        /exist/i,
        `submit_pr description must say to call it after a PR/MR exists: ${submit.description}`,
      )
      assert.match(
        submit.description,
        /forge/i,
        `submit_pr description must mention the forge: ${submit.description}`,
      )
    })
  })

  describe('list_tasks / get_task_brief', () => {
    test('list_tasks returns { tasks } briefs that parse and never contain forge secrets', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'list-shape')
      const first = await createTaskOk(app, poster.cookies)
      const second = await createTaskOk(app, poster.cookies, taskPayload({ title: '第二张卡片' }))
      const key = await mintAgentKey(app, poster.cookies, 'lister')
      const client = await readyMcp(app, key.identity)

      const called = await client.callTool(app, key.identity, 'list_tasks', {})
      const payload = assertToolOk(called.result)
      assert.deepEqual(Object.keys(payload).sort(), ['tasks'])
      assert.ok(Array.isArray(payload.tasks), 'list_tasks.tasks must be an array')
      assert.equal(payload.tasks.length, 2)
      assert.deepEqual(
        payload.tasks.map((task) => task.id),
        [first.brief.id, second.brief.id],
      )
      for (const brief of payload.tasks) assertBriefShape(brief)
      assertNoForgeSecretMaterial(called.res, INLINE_TOKEN, PROFILE_TOKEN, GITLAB_FORGE_TOKEN)
      assertNoForgeSecretValue(payload, JSON.stringify(payload), INLINE_TOKEN)
    })

    test('list_tasks filters by exact status, tag membership of one tag, and exact repo.forge', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'list-filters')
      const backend = await createTaskOk(app, poster.cookies)
      const frontend = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ title: '前端样式', tags: ['frontend'] }),
      )
      const gitlab = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'gitlab payments',
          tags: ['backend'],
          repo: {
            forge: 'gitlab',
            base_url: GITLAB_FORGE_BASE_URL,
            full_name: GITLAB_REPO_FULL_NAME,
            base_branch: 'main',
            suggested_dir: 'payments',
          },
          credential: { token: GITLAB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'filter-bot')
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: backend.brief.id })
      assert.equal(claimed.statusCode, 201, `REST claim setup: ${claimed.statusCode} ${claimed.body}`)

      const client = await readyMcp(app, key.identity)

      const byStatus = assertToolOk(
        (await client.callTool(app, key.identity, 'list_tasks', { status: '进行中' })).result,
      )
      assert.deepEqual(
        byStatus.tasks.map((task) => task.id),
        [backend.brief.id],
      )
      assert.equal(byStatus.tasks[0].status, '进行中')

      const pending = assertToolOk(
        (await client.callTool(app, key.identity, 'list_tasks', { status: '待认领' })).result,
      )
      assert.deepEqual(
        pending.tasks.map((task) => task.id),
        [frontend.brief.id, gitlab.brief.id],
      )

      const byTag = assertToolOk(
        (await client.callTool(app, key.identity, 'list_tasks', { tags: 'backend' })).result,
      )
      assert.deepEqual(
        byTag.tasks.map((task) => task.id),
        [backend.brief.id, gitlab.brief.id],
      )

      const frontendOnly = assertToolOk(
        (await client.callTool(app, key.identity, 'list_tasks', { tags: 'frontend' })).result,
      )
      assert.deepEqual(
        frontendOnly.tasks.map((task) => task.id),
        [frontend.brief.id],
      )

      const byForge = assertToolOk(
        (await client.callTool(app, key.identity, 'list_tasks', { forge: 'gitlab' })).result,
      )
      assert.deepEqual(
        byForge.tasks.map((task) => task.id),
        [gitlab.brief.id],
      )
      assert.equal(byForge.tasks[0].repo.forge, 'gitlab')

      const giteaOnly = assertToolOk(
        (await client.callTool(app, key.identity, 'list_tasks', { forge: 'gitea' })).result,
      )
      assert.deepEqual(
        giteaOnly.tasks.map((task) => task.id),
        [backend.brief.id, frontend.brief.id],
      )
    })

    test('list_tasks and get_task_brief apply sweepExpiredLeases so an expired 进行中 task shows as 待认领', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'list-expiry')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'expiring')
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `REST claim: ${claimed.statusCode} ${claimed.body}`)

      const client = await readyMcp(app, key.identity)
      clock.advanceMs(TTL_SECONDS * 1000)

      const listed = await client.callTool(app, key.identity, 'list_tasks', {})
      const listPayload = assertToolOk(listed.result)
      assert.equal(listPayload.tasks.length, 1)
      assert.equal(listPayload.tasks[0].status, '待认领')
      assertBriefShape(listPayload.tasks[0])
      assertNoForgeSecretMaterial(listed.res, INLINE_TOKEN)

      const fetched = await client.callTool(app, key.identity, 'get_task_brief', { task_id: brief.id })
      const briefPayload = assertToolOk(fetched.result)
      assertBriefShape(briefPayload)
      assert.equal(briefPayload.status, '待认领')
      assertNoForgeSecretMaterial(fetched.res, INLINE_TOKEN)
    })

    test('a leftover ktk_ Bearer cannot list_tasks: 401 unauthorized, not a successful tool result', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const member = await loginGitea(app, stub, 'pending-list-owner')
      const { brief } = await createTaskOk(app, member.cookies)
      const db = openDb(t, sqlitePath)
      db.$client
        .prepare(
          `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
           VALUES ('github', '60222', 'gh-leftover-lister', 'Leftover Lister', '待批准', 'claim_only', 0)`,
        )
        .run()
      const leftoverId = db.$client.prepare("SELECT id FROM users WHERE username = 'gh-leftover-lister'").get().id
      const seeded = seedAgentKey(db, leftoverId)

      const res = await postMcp(app, {
        token: seeded.token,
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } },
      })
      assertBearerUnauthorized(res)
      assert.notEqual(res.statusCode, 202)
      assertNoForgeSecretMaterial(res, INLINE_TOKEN)
      assert.equal(brief.id.length > 0, true)
    })

    test('get_task_brief returns a top-level brief; missing and numeric ids are isError not_found', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'get-brief')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'getter')
      const client = await readyMcp(app, key.identity)

      const fetched = await client.callTool(app, key.identity, 'get_task_brief', { task_id: brief.id })
      const payload = assertToolOk(fetched.result)
      assertBriefShape(payload)
      assert.equal(payload.id, brief.id)
      assert.equal(Object.hasOwn(payload, 'tasks'), false)
      assert.equal(Object.hasOwn(payload, 'clone'), false)
      assertNoForgeSecretMaterial(fetched.res, INLINE_TOKEN)

      for (const taskId of ['kt-2026-9999', '1']) {
        const missing = await client.callTool(app, key.identity, 'get_task_brief', { task_id: taskId })
        const body = assertToolError(missing.result, { error: 'not_found' })
        assertNoForgeSecretValue(body, JSON.stringify(missing.result), INLINE_TOKEN)
        assertNoForgeSecretMaterial(missing.res, INLINE_TOKEN)
      }
    })
  })

  describe('claim_task', () => {
    test('claim_task success envelope keys are exactly task, token, lease, clone with the REST clone pin', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'mcp-claim')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'claimer')
      const client = await readyMcp(app, key.identity)

      const called = await client.callTool(app, key.identity, 'claim_task', { task_id: brief.id })
      const envelope = assertToolOk(called.result)
      assertClaimEnvelope(envelope, {
        forgeToken: INLINE_TOKEN,
        suggestedDir: brief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
    })

    test('claim_task on a second task_id returns that task\'s token, not the first task\'s', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'mcp-switch-task-token')
      const { brief: firstBrief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ title: 'mcp first task_id inline' }),
      )
      const { brief: secondBrief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'mcp second task_id other inline',
          credential: { token: PROFILE_TOKEN },
        }),
      )
      assert.notEqual(firstBrief.id, secondBrief.id)
      const key = await mintAgentKey(app, poster.cookies, 'mcp-switch-bot')
      const client = await readyMcp(app, key.identity)

      const first = await client.callTool(app, key.identity, 'claim_task', { task_id: firstBrief.id })
      const firstBody = assertClaimEnvelope(assertToolOk(first.result), {
        forgeToken: INLINE_TOKEN,
        suggestedDir: firstBrief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
      assert.equal(firstBody.task.id, firstBrief.id)

      const second = await client.callTool(app, key.identity, 'claim_task', { task_id: secondBrief.id })
      const secondBody = assertClaimEnvelope(assertToolOk(second.result), {
        forgeToken: PROFILE_TOKEN,
        suggestedDir: secondBrief.repo.suggested_dir,
        nowUnix: clock.unix(),
      })
      assert.equal(secondBody.task.id, secondBrief.id)
      assert.notEqual(secondBody.token, firstBody.token)
      assert.equal(secondBody.token, PROFILE_TOKEN)
      assert.equal(firstBody.token, INLINE_TOKEN)
    })

    test('claim_task on a github task returns Bearer extra_header and github.com remote_url, not api.github.com', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'mcp-claim-github')
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'github mcp clone recipe',
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
      const key = await mintAgentKey(app, poster.cookies, 'gh-claimer')
      const client = await readyMcp(app, key.identity)
      const called = await client.callTool(app, key.identity, 'claim_task', { task_id: brief.id })
      const envelope = assertToolOk(called.result)
      assertClaimEnvelope(envelope, {
        forgeToken: GITHUB_FORGE_TOKEN,
        suggestedDir: 'widget',
        nowUnix: clock.unix(),
      })
      assert.equal(envelope.task.repo.forge, 'github')
      assert.equal(envelope.clone.remote_url, 'https://github.com/octo/widget.git')
      assert.equal(envelope.clone.extra_header.name, 'Authorization')
      assert.equal(envelope.clone.extra_header.value_pattern, 'Bearer ${token}')
    })

    test('claim_task on a gitlab task returns Bearer extra_header and keeps slashes in remote_url', async (t) => {
      const clock = freezeNow(t)
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'mcp-claim-gitlab')
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'gitlab mcp clone recipe',
          repo: {
            forge: 'gitlab',
            base_url: GITLAB_FORGE_BASE_URL,
            full_name: GITLAB_REPO_FULL_NAME,
            base_branch: 'main',
            suggested_dir: 'payments',
          },
          credential: { token: GITLAB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'gl-claimer')
      const client = await readyMcp(app, key.identity)
      const called = await client.callTool(app, key.identity, 'claim_task', { task_id: brief.id })
      const envelope = assertToolOk(called.result)
      assertClaimEnvelope(envelope, {
        forgeToken: GITLAB_FORGE_TOKEN,
        suggestedDir: 'payments',
        nowUnix: clock.unix(),
      })
      assert.equal(envelope.task.repo.forge, 'gitlab')
      assert.equal(envelope.clone.remote_url, 'https://gitlab.forge.example.test/team/payments.git')
      assert.equal(envelope.clone.extra_header.name, 'Authorization')
      assert.equal(envelope.clone.extra_header.value_pattern, 'Bearer ${token}')
      assert.equal(envelope.clone.remote_url.includes('%2F'), false)
    })

    test('leftover ktk_ Bearer cannot claim_task: 401 unauthorized, no token 揭示', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const member = await loginGitea(app, stub, 'pending-claim-owner')
      const { brief } = await createTaskOk(app, member.cookies)
      const db = openDb(t, sqlitePath)
      db.$client
        .prepare(
          `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
           VALUES ('github', '60223', 'gh-leftover-claimer', 'Leftover Claimer', '待批准', 'claim_only', 0)`,
        )
        .run()
      const leftoverId = db.$client.prepare("SELECT id FROM users WHERE username = 'gh-leftover-claimer'").get().id
      const seeded = seedAgentKey(db, leftoverId)
      assert.equal(claimRevealEvents(db, brief.id).length, 0)

      const res = await postMcp(app, {
        token: seeded.token,
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'claim_task', arguments: { task_id: brief.id } },
        },
      })
      assertBearerUnauthorized(res)
      assert.notEqual(res.statusCode, 202)
      assertNoForgeSecretMaterial(res, INLINE_TOKEN)
      assert.equal(claimRevealEvents(db, brief.id).length, 0)
    })

    test('second claim_task is conflict; list_tasks and get_task_brief still omit the forge token', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath, { admins: 'gitlab:gl-rival' })
      const poster = await loginGitea(app, stub, 'second-claim')
      const other = await loginGitlab(app, stub, 'rival')
      assert.equal(other.body.permission_level, 'full')
      const { brief } = await createTaskOk(app, poster.cookies)
      const firstKey = await mintAgentKey(app, poster.cookies, 'holder')
      const rivalKey = await pairDeviceToClaimant(app, poster.cookies, 'rival', { hostname: 'rival' })
      const holder = await readyMcp(app, firstKey.identity)
      const rival = await readyMcp(app, rivalKey.identity)

      const first = await holder.callTool(app, firstKey.identity, 'claim_task', { task_id: brief.id })
      const envelope = assertToolOk(first.result)
      assert.equal(envelope.token, INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      assert.equal(claimRevealEvents(db, brief.id).length, 1)

      const retry = await holder.callTool(app, firstKey.identity, 'claim_task', { task_id: brief.id })
      const retryBody = assertToolError(retry.result, {
        error: 'conflict',
        message: TASK_ALREADY_CLAIMED_MESSAGE,
      })
      assert.equal(Object.hasOwn(retryBody, 'token'), false)
      assertNoForgeSecretValue(retry.result, JSON.stringify(retry.result), INLINE_TOKEN)
      assertNoForgeSecretMaterial(retry.res, INLINE_TOKEN)

      const rivalCall = await rival.callTool(app, rivalKey.identity, 'claim_task', { task_id: brief.id })
      assertToolError(rivalCall.result, { error: 'conflict', message: TASK_ALREADY_CLAIMED_MESSAGE })
      assertNoForgeSecretMaterial(rivalCall.res, INLINE_TOKEN)
      assert.equal(claimRevealEvents(db, brief.id).length, 1)

      const listed = await holder.callTool(app, firstKey.identity, 'list_tasks', {})
      const listPayload = assertToolOk(listed.result)
      assert.equal(listPayload.tasks[0].status, '进行中')
      assertBriefShape(listPayload.tasks[0])
      assertNoForgeSecretMaterial(listed.res, INLINE_TOKEN)

      const fetched = await holder.callTool(app, firstKey.identity, 'get_task_brief', { task_id: brief.id })
      const briefPayload = assertToolOk(fetched.result)
      assert.equal(briefPayload.status, '进行中')
      assertBriefShape(briefPayload)
      assertNoForgeSecretMaterial(fetched.res, INLINE_TOKEN)
    })
  })

  describe('report_progress / release_task', () => {
    test('report_progress wraps REST: optional note (omit → empty string), envelope { task, lease }, no token', async (t) => {
      const clock = freezeNow(t)
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'mcp-progress')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'heart')
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `REST claim: ${claimed.statusCode} ${claimed.body}`)
      const client = await readyMcp(app, key.identity)

      const omitted = await client.callTool(app, key.identity, 'report_progress', { task_id: brief.id })
      const omitPayload = assertToolOk(omitted.result)
      assert.deepEqual(Object.keys(omitPayload).sort(), ['lease', 'task'])
      assertBriefShape(omitPayload.task)
      assert.equal(omitPayload.task.status, '进行中')
      assert.deepEqual(Object.keys(omitPayload.lease).sort(), ['expires_at', 'ttl_seconds'])
      assert.equal(omitPayload.lease.ttl_seconds, TTL_SECONDS)
      assert.equal(omitPayload.lease.expires_at, expiresAtIso(clock.unix()))
      assertNoForgeSecretValue(omitPayload, JSON.stringify(omitPayload), INLINE_TOKEN)
      assertNoForgeSecretMaterial(omitted.res, INLINE_TOKEN)

      clock.advanceMs(60 * 1000)
      const noted = await client.callTool(app, key.identity, 'report_progress', {
        task_id: brief.id,
        note: '正在写分页测试',
      })
      const notePayload = assertToolOk(noted.result)
      assert.deepEqual(Object.keys(notePayload).sort(), ['lease', 'task'])
      assert.equal(notePayload.lease.expires_at, expiresAtIso(clock.unix()))
      assertNoForgeSecretMaterial(noted.res, INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      const beats = heartbeatEvents(db, brief.id)
      assert.equal(beats.length, 2, `expected two 心跳, got ${JSON.stringify(beats.map(parseDetails))}`)
      assert.deepEqual(parseDetails(beats[0]), { task_id: brief.id, note: '' })
      assert.deepEqual(parseDetails(beats[1]), { task_id: brief.id, note: '正在写分页测试' })
    })

    test('release_task wraps REST: optional reason, envelope { task } 待认领, no token', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'mcp-release')
      const first = await createTaskOk(app, poster.cookies)
      const second = await createTaskOk(app, poster.cookies, taskPayload({ title: '第二张' }))
      const key = await mintAgentKey(app, poster.cookies, 'releaser')
      assert.equal(
        (await claimTaskHttp(app, { token: key.identity, publicId: first.brief.id })).statusCode,
        201,
      )
      assert.equal(
        (await claimTaskHttp(app, { token: key.identity, publicId: second.brief.id })).statusCode,
        201,
      )
      const client = await readyMcp(app, key.identity)

      const omitted = await client.callTool(app, key.identity, 'release_task', { task_id: first.brief.id })
      const omitPayload = assertToolOk(omitted.result)
      assert.deepEqual(Object.keys(omitPayload).sort(), ['task'])
      assertBriefShape(omitPayload.task)
      assert.equal(omitPayload.task.status, '待认领')
      assertNoForgeSecretValue(omitPayload, JSON.stringify(omitPayload), INLINE_TOKEN)
      assertNoForgeSecretMaterial(omitted.res, INLINE_TOKEN)

      const reasoned = await client.callTool(app, key.identity, 'release_task', {
        task_id: second.brief.id,
        reason: '换人做',
      })
      const reasonPayload = assertToolOk(reasoned.result)
      assert.deepEqual(Object.keys(reasonPayload).sort(), ['task'])
      assert.equal(reasonPayload.task.status, '待认领')
      assertNoForgeSecretMaterial(reasoned.res, INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      const firstTask = taskRow(db, first.brief.id)
      const secondTask = taskRow(db, second.brief.id)
      assert.equal(leaseRows(db, firstTask.id)[0].state, 'released')
      assert.equal(leaseRows(db, secondTask.id)[0].state, 'released')

      const omitEvent = statusTransitionEvents(db, first.brief.id).find(
        (event) => parseDetails(event)?.from === '进行中' && parseDetails(event)?.to === '待认领',
      )
      assert.ok(omitEvent, 'expected 状态迁移 进行中→待认领 for omitted reason')
      assert.equal(Object.hasOwn(parseDetails(omitEvent), 'reason'), false)

      const reasonEvent = statusTransitionEvents(db, second.brief.id).find(
        (event) => parseDetails(event)?.from === '进行中',
      )
      assert.deepEqual(parseDetails(reasonEvent), {
        task_id: second.brief.id,
        from: '进行中',
        to: '待认领',
        reason: '换人做',
      })
    })

    test('non-holder report_progress and release_task are isError forbidden with no message', async (t) => {
      const { app, stub } = await boot(t, { admins: 'gitlab:gl-bystander' })
      const poster = await loginGitea(app, stub, 'holder')
      const other = await loginGitlab(app, stub, 'bystander')
      assert.equal(other.body.permission_level, 'full')
      const { brief } = await createTaskOk(app, poster.cookies)
      const holderKey = await mintAgentKey(app, poster.cookies, 'holder-key')
      const otherKey = await pairDeviceToClaimant(app, poster.cookies, 'bystander', { hostname: 'bystander-key' })
      assert.equal(
        (await claimTaskHttp(app, { token: holderKey.identity, publicId: brief.id })).statusCode,
        201,
      )
      const bystander = await readyMcp(app, otherKey.identity)

      const progressed = await bystander.callTool(app, otherKey.identity, 'report_progress', {
        task_id: brief.id,
        note: 'nope',
      })
      assertToolError(progressed.result, { error: 'forbidden', omitMessage: true })
      assertNoForgeSecretMaterial(progressed.res, INLINE_TOKEN)

      const released = await bystander.callTool(app, otherKey.identity, 'release_task', {
        task_id: brief.id,
        reason: 'nope',
      })
      assertToolError(released.result, { error: 'forbidden', omitMessage: true })
      assertNoForgeSecretMaterial(released.res, INLINE_TOKEN)
    })

    test('report_progress and release_task with no live lease are isError 任务未被认领', async (t) => {
      const { app, stub } = await boot(t)
      const poster = await loginGitea(app, stub, 'never-claimed')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'idle')
      const client = await readyMcp(app, key.identity)

      const progressed = await client.callTool(app, key.identity, 'report_progress', { task_id: brief.id })
      assertToolError(progressed.result, { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE })
      assertNoForgeSecretMaterial(progressed.res, INLINE_TOKEN)

      const released = await client.callTool(app, key.identity, 'release_task', { task_id: brief.id })
      assertToolError(released.result, { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE })
      assertNoForgeSecretMaterial(released.res, INLINE_TOKEN)
    })
  })

  describe('submit_pr', () => {
    test('submit_pr success is { task, pr_url, summary } 待验收, persists submissions, clears the lease, writes 状态迁移', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'submit-pr')
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'submitter')
      assert.equal(
        (await claimTaskHttp(app, { token: key.identity, publicId: brief.id })).statusCode,
        201,
      )
      const client = await readyMcp(app, key.identity)
      const prUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/7`
      const summary = '分页导出已提交'

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      const lease = activeLeaseRows(db, task.id)[0]
      assert.ok(lease, 'setup: expected an active lease before submit_pr')

      const called = await client.callTool(app, key.identity, 'submit_pr', {
        task_id: brief.id,
        pr_url: prUrl,
        summary,
      })
      const payload = assertToolOk(called.result)
      assert.deepEqual(Object.keys(payload).sort(), ['pr_url', 'summary', 'task'])
      assertBriefShape(payload.task)
      assert.equal(payload.task.status, '待验收')
      assert.equal(payload.pr_url, prUrl)
      assert.equal(payload.summary, summary)
      assertNoForgeSecretValue(payload, JSON.stringify(payload), INLINE_TOKEN)
      assertNoForgeSecretMaterial(called.res, INLINE_TOKEN)

      const rows = submissionRows(db, task.id)
      assert.equal(rows.length, 1, `expected one submissions row, got ${JSON.stringify(rows)}`)
      assert.equal(Number(rows[0].task_id), Number(task.id))
      assert.equal(Number(rows[0].lease_id), Number(lease.id))
      assert.equal(rows[0].pr_url, prUrl)
      assert.equal(rows[0].summary, summary)
      assert.equal(rows[0].pr_state, 'open')

      const leases = leaseRows(db, task.id)
      assert.equal(leases.length, 1)
      assert.equal(leases[0].state, 'released')
      assert.equal(activeLeaseRows(db, task.id).length, 0)

      const migrated = statusTransitionEvents(db, brief.id).filter((event) => {
        const details = parseDetails(event)
        return details?.from === '进行中' && details?.to === '待验收'
      })
      assert.equal(migrated.length, 1, `expected 状态迁移 进行中→待验收, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(Number(migrated[0].actor_user_id), Number(poster.body.id))
      assert.deepEqual(parseDetails(migrated[0]), {
        task_id: brief.id,
        from: '进行中',
        to: '待验收',
        pr_url: prUrl,
        summary,
      })
    })

    test('submit_pr fails for non-holder, no lease, and not 进行中', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath, { admins: 'gitlab:gl-submit-fail-other' })
      const poster = await loginGitea(app, stub, 'submit-fail-owner')
      const other = await loginGitlab(app, stub, 'submit-fail-other')
      assert.equal(other.body.permission_level, 'full')
      const live = await createTaskOk(app, poster.cookies)
      const unused = await createTaskOk(app, poster.cookies, taskPayload({ title: '从未认领' }))
      const cancelled = await createTaskOk(app, poster.cookies, taskPayload({ title: '将取消' }))
      const holderKey = await mintAgentKey(app, poster.cookies, 'holder')
      const otherKey = await pairDeviceToClaimant(app, poster.cookies, 'other', { hostname: 'other' })
      assert.equal(
        (await claimTaskHttp(app, { token: holderKey.identity, publicId: live.brief.id })).statusCode,
        201,
      )
      assert.equal(
        (await claimTaskHttp(app, { token: holderKey.identity, publicId: cancelled.brief.id })).statusCode,
        201,
      )
      const db = openDb(t, sqlitePath)
      forceStatus(db, cancelled.brief.id, '已取消')

      const holder = await readyMcp(app, holderKey.identity)
      const bystander = await readyMcp(app, otherKey.identity)
      const args = {
        pr_url: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/8`,
        summary: '不应成功',
      }

      const nonHolder = await bystander.callTool(app, otherKey.identity, 'submit_pr', {
        task_id: live.brief.id,
        ...args,
      })
      assertToolError(nonHolder.result, { error: 'forbidden', omitMessage: true })
      assertNoForgeSecretMaterial(nonHolder.res, INLINE_TOKEN)

      const noLease = await holder.callTool(app, holderKey.identity, 'submit_pr', {
        task_id: unused.brief.id,
        ...args,
      })
      assertToolError(noLease.result, { error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE })
      assertNoForgeSecretMaterial(noLease.res, INLINE_TOKEN)

      const notInProgress = await holder.callTool(app, holderKey.identity, 'submit_pr', {
        task_id: cancelled.brief.id,
        ...args,
      })
      assertToolError(notInProgress.result, {
        error: 'illegal_transition',
        message: illegalTransitionMessage('已取消', '待验收'),
      })
      assertNoForgeSecretMaterial(notInProgress.res, INLINE_TOKEN)
    })
  })
})
