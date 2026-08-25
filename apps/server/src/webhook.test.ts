import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.ts'
import { injectSigned, pairDeviceToSelf } from './device-proof.test-helpers.ts'
import { ensureSetup } from './auth.test-helpers.ts'

// Issue #13. Seams copied from poller.test.ts (do not import that file): OAuth login, agent key
// mint, HTTP claim, MCP `submit_pr`, and the sqlite row-reading helpers. This spec drives a task
// through the real HTTP + MCP surface to 待验收, then POSTs a raw webhook delivery at
// `app.inject` — exercising the real `buildApp({ forgeInstances })` composition root, never a
// mocked/stubbed webhook subject.
//
// HEAD `44eca32b`: no `/api/v1/webhooks/:publicId` route exists at all (Fastify's own 404
// handles any URL), `parseWebhook`/`registerWebhook` throw `not implemented`, and nothing ever
// reads a `forgeInstances` option. Every assertion below requires the *specific* JSON error body
// and status code from the ruling, not just "some 4xx" — a bare `assert.ok(res.statusCode >= 400)`
// would pass against today's generic Fastify 404 and must not be used here.

const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'ab'.repeat(32)

const FORGE_BASE_URL = 'https://gitea.webhook.example.test'
const REPO_FULL_NAME = 'team/checkout'
const INLINE_TOKEN = 'gitea-WEBHOOK-INLINE-TOKEN-qz9'

const GITEA_INSTANCE_ID = 'inst-gitea-primary'
const GITEA_WEBHOOK_SECRET = 'gitea-webhook-secret-kaola-01'
const GITHUB_INSTANCE_ID = 'inst-github-primary'
const GITHUB_WEBHOOK_SECRET = 'github-webhook-secret-kaola-02'

const STATUS_TRANSITION_EVENT = '状态迁移'
const WEBHOOK_PATH_PREFIX = '/api/v1/webhooks'
const MCP_PATH = '/api/mcp'
const MCP_PROTOCOL_VERSION = '2025-11-25'

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

const jsonHeaders = { accept: 'application/json' }

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input && typeof input === 'object' && 'url' in input) return String(input.url)
  return String(input)
}

function requestMethod(input, init) {
  if (input && typeof input === 'object' && 'method' in input && typeof input.method === 'string' && input.method !== '') {
    return input.method.toUpperCase()
  }
  return (init?.method ?? 'GET').toUpperCase()
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

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Same PR-endpoint classifier as poller.test.ts's `isPrEndpoint`: no PR stub is ever installed in
// this file, so any accidental `getPullRequest` call (which the webhook path must never make) hits
// the "unstubbed pr endpoint" 500 branch below and is also independently checked via `stub.requests`.
function isPrEndpoint(url) {
  return /\/(?:pulls|merge_requests)\/\d+(?:[/?#]|$)/u.test(url)
}

function isRepoEndpoint(url) {
  return (url.includes('/repos/') || url.includes('/projects/')) && !isPrEndpoint(url)
}

function isUserEndpoint(url) {
  return url.endsWith('/user') && !isPrEndpoint(url)
}

function beginFetch(t) {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const oauth = new Map()
  const forge = new Map()
  const requests = []
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    requests.push({ url, method: requestMethod(input, init) })

    if (isPrEndpoint(url)) {
      return jsonResponse(500, { error: 'webhook path must never call getPullRequest', url })
    }

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
  return { oauth, forge, requests }
}

const REPO_FULL_ACCESS = {
  permissions: { pull: true, push: true, admin: false },
  has_pull_requests: true,
  private: true,
}

function allowForgeToken(stub, token, descriptor = { repo: REPO_FULL_ACCESS }) {
  stub.forge.set(token, descriptor)
}

function sqliteFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-webhook-'))
  const sqlitePath = join(dir, 'kaola.sqlite')
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return sqlitePath
}

async function createApp(t, options) {
  const app = buildApp(options)
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
    title: 'Webhook 待验收任务',
    description_md: '……（Markdown 详述）',
    source: { type: 'native' },
    repo: {
      forge: 'gitea',
      base_url: FORGE_BASE_URL,
      full_name: REPO_FULL_NAME,
      base_branch: 'main',
      suggested_dir: 'checkout',
    },
    acceptance_criteria: ['通过结账测试'],
    test_command: 'pnpm test',
    constraints: { allowed_paths: ['src/**'], forbidden_paths: [] },
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
    headers: jsonHeaders,
    payload,
  })
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

async function postMcp(app, { token, identity, sessionId, payload }) {
  const proof = identity ?? (token && typeof token === 'object' && token.privateKey ? token : null)
  if (proof != null) {
    const extra = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    }
    if (sessionId != null) extra['mcp-session-id'] = sessionId
    return injectSigned(app, proof, {
      method: 'POST',
      url: MCP_PATH,
      payload,
      extraHeaders: extra,
    })
  }
  return app.inject({ method: 'POST', url: MCP_PATH, headers: mcpHeaders({ token, sessionId }), payload })
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
    assert.ok(messages.length > 0, `expected SSE event: message JSON-RPC payloads, status ${res.statusCode}: ${body}`)
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
  assert.ok(texts.length > 0, `tool result has neither structuredContent nor text content: ${JSON.stringify(result)}`)
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
            clientInfo: { name: 'kaola-webhook-test', version: '0.0.0' },
          },
        },
      })
      assert.equal(res.statusCode, 200, `MCP initialize HTTP: ${res.statusCode} ${res.body}`)
      const rpc = jsonRpcById(parseJsonRpcHttp(res), id)
      assert.equal(rpc.error, undefined, `MCP initialize JSON-RPC error: ${JSON.stringify(rpc.error)}`)
      const header = res.headers['mcp-session-id']
      if (header != null && header !== '') sessionId = String(header)
      if (sessionId != null) {
        await postMcp(app, { token, sessionId, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } })
      }
    },
    async callTool(app, token, name, args = {}) {
      const id = nextId
      nextId += 1
      const res = await postMcp(app, {
        token,
        sessionId,
        payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      })
      assert.equal(res.statusCode, 200, `tools/call ${name} HTTP: ${res.statusCode} ${res.body}`)
      const rpc = jsonRpcById(parseJsonRpcHttp(res), id)
      assert.equal(
        rpc.error,
        undefined,
        `tools/call ${name} must be a JSON-RPC result, not a protocol error: ${JSON.stringify(rpc.error)}`,
      )
      return { res, result: rpc.result }
    },
  }
}

async function readyMcp(app, token) {
  const client = createMcpClient()
  await client.initialize(app, token)
  return client
}

async function submitPrViaMcp(app, token, { taskId, prUrl, summary }) {
  const client = await readyMcp(app, token)
  const called = await client.callTool(app, token, 'submit_pr', { task_id: taskId, pr_url: prUrl, summary })
  return assertToolOk(called.result)
}

function parseDetails(row) {
  if (row == null) return null
  if (typeof row.details === 'string') return JSON.parse(row.details)
  return row.details
}

function eventRows(db) {
  return db.$client.prepare('SELECT type, actor_user_id, created_at, details FROM events').all()
}

function statusTransitionEventsFor(db, publicId) {
  return eventRows(db)
    .filter((event) => event.type === STATUS_TRANSITION_EVENT)
    .filter((event) => parseDetails(event)?.task_id === publicId)
}

function taskRow(db, publicId) {
  return db.$client
    .prepare('SELECT id, public_id, status FROM tasks WHERE public_id = ?')
    .get(publicId)
}

function submissionRows(db, taskPk) {
  return db.$client
    .prepare('SELECT id, task_id, lease_id, pr_url, summary, pr_state FROM submissions WHERE task_id = ? ORDER BY id')
    .all(taskPk)
}

async function boot(t, sqlitePath, options = {}) {
  const app = await createApp(t, { sqlitePath, ...options })
  const stub = beginFetch(t)
  allowForgeToken(stub, INLINE_TOKEN)
  return { app, stub }
}

// Drives one task through the real HTTP + MCP surface up to 待验收 (create → claim → submit_pr),
// mirroring `poller.test.ts`'s `createPendingReviewTask`. Returns the public id and the exact
// pr_url stored on the submission, so the webhook payload's pr_url can match it precisely.
async function createPendingReviewTask(app, poster, key, { title, prNumber, summary }) {
  const brief = await createTaskOk(app, poster.cookies, taskPayload({ title }))
  const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
  assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)
  const prUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/${prNumber}`
  const submitted = await submitPrViaMcp(app, key.identity, { taskId: brief.id, prUrl, summary })
  assert.equal(submitted.task.status, '待验收', `setup submit_pr: ${JSON.stringify(submitted)}`)
  return { publicId: brief.id, prUrl }
}

// --- webhook signature + payload helpers (this spec computes its own expected digests) ---

function giteaSignature(secret, rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

function githubSignature(secret, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}

function giteaPrPayload({ merged, prUrl, fullName = REPO_FULL_NAME }) {
  return {
    action: 'closed',
    pull_request: { merged, html_url: prUrl },
    repository: { full_name: fullName },
  }
}

function webhookUrl(instancePublicId) {
  return `${WEBHOOK_PATH_PREFIX}/${instancePublicId}`
}

async function postGiteaWebhook(app, instancePublicId, { secret, eventName = 'pull_request', rawBody }) {
  const headers = { 'content-type': 'application/json', 'x-gitea-event': eventName }
  if (secret != null) headers['x-gitea-signature'] = giteaSignature(secret, rawBody)
  return app.inject({ method: 'POST', url: webhookUrl(instancePublicId), headers, payload: rawBody })
}

describe('issue #13 webhook receiver (POST /api/v1/webhooks/:publicId)', { concurrency: false }, () => {
  test('unknown publicId (no matching forgeInstances entry) → 404 { error: "not_found" }, no signature required', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITEA_WEBHOOK_SECRET },
      ],
    })

    const res = await app.inject({
      method: 'POST',
      url: webhookUrl('does-not-exist-instance'),
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ anything: true }),
    })

    assert.equal(res.statusCode, 404, `expected 404 for an unknown publicId, got ${res.statusCode}: ${res.body}`)
    assert.deepEqual(jsonBody(res), { error: 'not_found' })
  })

  test('bad signature (wrong secret) → 401 { error: "invalid_signature" }, and the response never leaks the secret', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITEA_WEBHOOK_SECRET },
      ],
    })

    const rawBody = JSON.stringify(giteaPrPayload({ merged: true, prUrl: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/9001` }))
    const res = await app.inject({
      method: 'POST',
      url: webhookUrl(GITEA_INSTANCE_ID),
      headers: {
        'content-type': 'application/json',
        'x-gitea-event': 'pull_request',
        'x-gitea-signature': giteaSignature('totally-wrong-secret', rawBody),
      },
      payload: rawBody,
    })

    assert.equal(res.statusCode, 401, `expected 401 for a bad signature, got ${res.statusCode}: ${res.body}`)
    assert.deepEqual(jsonBody(res), { error: 'invalid_signature' })
    assert.equal(res.body.includes(GITEA_WEBHOOK_SECRET), false, 'response must never contain the configured webhook secret')
  })

  test('bad signature (missing signature header) → 401 { error: "invalid_signature" }', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITEA_WEBHOOK_SECRET },
      ],
    })

    const rawBody = JSON.stringify(giteaPrPayload({ merged: true, prUrl: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/9002` }))
    const res = await app.inject({
      method: 'POST',
      url: webhookUrl(GITEA_INSTANCE_ID),
      headers: { 'content-type': 'application/json', 'x-gitea-event': 'pull_request' },
      payload: rawBody,
    })

    assert.equal(res.statusCode, 401)
    assert.deepEqual(jsonBody(res), { error: 'invalid_signature' })
  })

  test('ping/irrelevant event with a correct signature → 204 empty body', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITEA_WEBHOOK_SECRET },
      ],
    })

    const rawBody = JSON.stringify({ ref: 'refs/heads/main', commits: [] })
    const res = await postGiteaWebhook(app, GITEA_INSTANCE_ID, { secret: GITEA_WEBHOOK_SECRET, eventName: 'push', rawBody })

    assert.equal(res.statusCode, 204, `expected 204 for an irrelevant event, got ${res.statusCode}: ${res.body}`)
    assert.equal(res.body, '', 'a 204 response must have an empty body')
  })

  test('merge event with a matching 待验收 submission → 204, task 已完成, submissions.pr_state merged, system 状态迁移 event', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITEA_WEBHOOK_SECRET },
      ],
    })
    const poster = await loginGitea(app, stub, 'merge')
    const key = await mintAgentKey(app, poster.cookies, 'webhook')
    const setup = await createPendingReviewTask(app, poster, key, { title: '合并用例', prNumber: 601, summary: '已提交' })

    const rawBody = JSON.stringify(giteaPrPayload({ merged: true, prUrl: setup.prUrl }))
    const res = await postGiteaWebhook(app, GITEA_INSTANCE_ID, { secret: GITEA_WEBHOOK_SECRET, rawBody })

    assert.equal(res.statusCode, 204, `expected 204 on a successful merge delivery, got ${res.statusCode}: ${res.body}`)
    assert.equal(res.body, '')

    const db = openDb(t, sqlitePath)
    const after = taskRow(db, setup.publicId)
    assert.equal(after.status, '已完成', `expected 已完成, got ${JSON.stringify(after)}`)

    const rows = submissionRows(db, after.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].pr_state, 'merged')

    const migrated = statusTransitionEventsFor(db, setup.publicId).filter((event) => {
      const details = parseDetails(event)
      return details?.from === '待验收' && details?.to === '已完成'
    })
    assert.equal(migrated.length, 1, `expected one system 状态迁移 待验收→已完成, got ${JSON.stringify(eventRows(db))}`)
    assert.equal(migrated[0].actor_user_id, null, 'webhook-driven transition must have actor_user_id null (system-driven)')
    assert.deepEqual(parseDetails(migrated[0]), {
      task_id: setup.publicId,
      from: '待验收',
      to: '已完成',
      pr_url: setup.prUrl,
    })

    assert.equal(
      stub.requests.some((r) => r.url.includes('/pulls/')),
      false,
      'the webhook path must never call getPullRequest — the payload is the source of truth',
    )
    assert.equal(res.body.includes(INLINE_TOKEN), false)
    assert.equal(JSON.stringify(eventRows(db)).includes(INLINE_TOKEN), false, 'plaintext token must never reach events.details')
  })

  test('closed-unmerged event with a matching 待验收 submission → 204, task 已退回, submissions.pr_state closed', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITEA_WEBHOOK_SECRET },
      ],
    })
    const poster = await loginGitea(app, stub, 'closed')
    const key = await mintAgentKey(app, poster.cookies, 'webhook')
    const setup = await createPendingReviewTask(app, poster, key, { title: '关闭用例', prNumber: 602, summary: '未通过' })

    const rawBody = JSON.stringify(giteaPrPayload({ merged: false, prUrl: setup.prUrl }))
    const res = await postGiteaWebhook(app, GITEA_INSTANCE_ID, { secret: GITEA_WEBHOOK_SECRET, rawBody })

    assert.equal(res.statusCode, 204)
    assert.equal(res.body, '')

    const db = openDb(t, sqlitePath)
    const after = taskRow(db, setup.publicId)
    assert.equal(after.status, '已退回', `expected 已退回, got ${JSON.stringify(after)}`)

    const rows = submissionRows(db, after.id)
    assert.equal(rows[0].pr_state, 'closed')

    const migrated = statusTransitionEventsFor(db, setup.publicId).filter((event) => {
      const details = parseDetails(event)
      return details?.from === '待验收' && details?.to === '已退回'
    })
    assert.equal(migrated.length, 1)
    assert.equal(migrated[0].actor_user_id, null)
    assert.deepEqual(parseDetails(migrated[0]), {
      task_id: setup.publicId,
      from: '待验收',
      to: '已退回',
      pr_url: setup.prUrl,
    })
  })

  test('a delivery whose pr_url matches no 待验收 submission → 204 no-op, no task/event changes', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITEA_WEBHOOK_SECRET },
      ],
    })
    const poster = await loginGitea(app, stub, 'nomatch')
    const key = await mintAgentKey(app, poster.cookies, 'webhook')
    const setup = await createPendingReviewTask(app, poster, key, { title: '不匹配用例', prNumber: 603, summary: '未匹配' })

    const unrelatedPrUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/999999`
    const rawBody = JSON.stringify(giteaPrPayload({ merged: true, prUrl: unrelatedPrUrl }))
    const res = await postGiteaWebhook(app, GITEA_INSTANCE_ID, { secret: GITEA_WEBHOOK_SECRET, rawBody })

    assert.equal(res.statusCode, 204, `expected 204 (idempotent no-op) for a non-matching pr_url, got ${res.statusCode}: ${res.body}`)
    assert.equal(res.body, '')

    const db = openDb(t, sqlitePath)
    const after = taskRow(db, setup.publicId)
    assert.equal(after.status, '待验收', 'a non-matching delivery must never change an unrelated task')
    assert.equal(
      statusTransitionEventsFor(db, setup.publicId).filter((e) => parseDetails(e)?.from === '待验收').length,
      0,
      'a non-matching delivery must never write a 状态迁移 event',
    )
  })

  test('a syncMode: "poll" instance webhook still completes the task (mode gates the poller, not this receiver)', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'poll', webhookSecret: GITEA_WEBHOOK_SECRET },
      ],
    })
    const poster = await loginGitea(app, stub, 'pollmode')
    const key = await mintAgentKey(app, poster.cookies, 'webhook')
    const setup = await createPendingReviewTask(app, poster, key, { title: 'poll 模式仍接收用例', prNumber: 604, summary: '仍应完成' })

    const rawBody = JSON.stringify(giteaPrPayload({ merged: true, prUrl: setup.prUrl }))
    const res = await postGiteaWebhook(app, GITEA_INSTANCE_ID, { secret: GITEA_WEBHOOK_SECRET, rawBody })

    assert.equal(res.statusCode, 204)
    const db = openDb(t, sqlitePath)
    assert.equal(taskRow(db, setup.publicId).status, '已完成', 'a poll-mode instance must still accept and act on an inbound webhook delivery')
  })

  test('no session cookie and no Bearer token are required or accepted as auth — the signature alone gates the request', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITEA_WEBHOOK_SECRET },
      ],
    })
    const poster = await loginGitea(app, stub, 'noauth')
    const key = await mintAgentKey(app, poster.cookies, 'webhook')
    const setup = await createPendingReviewTask(app, poster, key, { title: '无鉴权用例', prNumber: 605, summary: '仅签名鉴权' })

    const rawBody = JSON.stringify(giteaPrPayload({ merged: true, prUrl: setup.prUrl }))
    const res = await app.inject({
      method: 'POST',
      url: webhookUrl(GITEA_INSTANCE_ID),
      headers: {
        'content-type': 'application/json',
        'x-gitea-event': 'pull_request',
        'x-gitea-signature': giteaSignature(GITEA_WEBHOOK_SECRET, rawBody),
      },
      payload: rawBody,
    })

    assert.equal(res.statusCode, 204, `a correctly-signed request with no cookies/Bearer must still succeed, got ${res.statusCode}: ${res.body}`)
    const db = openDb(t, sqlitePath)
    assert.equal(taskRow(db, setup.publicId).status, '已完成')
  })

  test('cross-forge dispatch: a github forgeInstances entry is verified with X-Hub-Signature-256, not the gitea scheme', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITHUB_INSTANCE_ID, forge: 'github', baseUrl: 'https://api.github.com', syncMode: 'webhook', webhookSecret: GITHUB_WEBHOOK_SECRET },
      ],
    })

    const pingBody = JSON.stringify({ zen: 'Responsive is better than fast.', hook_id: 1 })
    const goodRes = await app.inject({
      method: 'POST',
      url: webhookUrl(GITHUB_INSTANCE_ID),
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-hub-signature-256': githubSignature(GITHUB_WEBHOOK_SECRET, pingBody),
      },
      payload: pingBody,
    })
    assert.equal(goodRes.statusCode, 204, `expected 204 for a correctly-signed github ping, got ${goodRes.statusCode}: ${goodRes.body}`)
    assert.equal(goodRes.body, '')

    const badRes = await app.inject({
      method: 'POST',
      url: webhookUrl(GITHUB_INSTANCE_ID),
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-hub-signature-256': githubSignature('wrong-secret-here', pingBody),
      },
      payload: pingBody,
    })
    assert.equal(badRes.statusCode, 401, `expected 401 for a github delivery with the wrong secret, got ${badRes.statusCode}: ${badRes.body}`)
    assert.deepEqual(jsonBody(badRes), { error: 'invalid_signature' })
  })

  test('confused deputy: a correctly-signed github delivery must not complete an unrelated gitea instance\'s task merely because pr_url matches', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath, {
      forgeInstances: [
        { publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITEA_WEBHOOK_SECRET },
        { publicId: GITHUB_INSTANCE_ID, forge: 'github', baseUrl: 'https://api.github.com', syncMode: 'webhook', webhookSecret: GITHUB_WEBHOOK_SECRET },
      ],
    })
    const poster = await loginGitea(app, stub, 'confused')
    const key = await mintAgentKey(app, poster.cookies, 'webhook')
    const setup = await createPendingReviewTask(app, poster, key, { title: '跨实例混淆用例', prNumber: 606, summary: '跨实例冒用' })

    // Same payload shape as a gitea pull_request delivery (mapGithubShapedEvent reads identical
    // fields for both kinds), but delivered to, and correctly signed for, the *github* instance.
    // Its pull_request.html_url is the gitea task's own pr_url — the attacker-chosen confusion.
    const rawBody = JSON.stringify(giteaPrPayload({ merged: true, prUrl: setup.prUrl, fullName: 'unrelated/repo' }))
    const res = await app.inject({
      method: 'POST',
      url: webhookUrl(GITHUB_INSTANCE_ID),
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': githubSignature(GITHUB_WEBHOOK_SECRET, rawBody),
      },
      payload: rawBody,
    })

    assert.equal(
      res.statusCode,
      204,
      `a validly-signed github delivery must not be rejected as an authentication failure (this is an authorization gap, not a signature problem), got ${res.statusCode}: ${res.body}`,
    )
    assert.equal(res.body, '')

    const db = openDb(t, sqlitePath)
    const after = taskRow(db, setup.publicId)
    assert.equal(
      after.status,
      '待验收',
      `a github instance's signed delivery must never complete a gitea task just because pr_url matches, got ${JSON.stringify(after)}`,
    )
    assert.equal(
      statusTransitionEventsFor(db, setup.publicId).filter((e) => parseDetails(e)?.from === '待验收').length,
      0,
      'a cross-instance delivery must never write a 状态迁移 event out of 待验收 for the unrelated task',
    )
  })
})
