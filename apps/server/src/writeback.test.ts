import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.ts'
import { pollPendingReviews } from './poller.ts'
import { injectSigned, pairDeviceToSelf } from './device-proof.test-helpers.ts'
import { ensureSetup } from './auth.test-helpers.ts'

// Issue #14. Seams copied from poller.test.ts / claim.test.ts / webhook.test.ts (do not import
// those files): OAuth login, agent key mint, HTTP claim, MCP `submit_pr`, webhook delivery, and
// the sqlite row-reading helpers. This spec drives a real `buildApp()` through the actual
// REST/MCP/webhook surface and mocks only `globalThis.fetch` — never `commentOnIssue`,
// `claimTask`, `submitPr`, or `applyPrTerminalTransition` themselves.
//
// HEAD `a722c8b`: `commentOnIssue` is unconditionally `notImplemented()` (see
// comment-on-issue.shared.test.ts), and none of `claimTask` / `submitPr` /
// `applyPrTerminalTransition` call it at all — there is no write-back of any kind yet, and
// `apps/server/src/poller.ts` exports no `retryPendingWritebacks`. Every test below that drives a
// real lifecycle transition therefore currently observes zero comment POSTs where the ruling
// requires exactly one.
//
// `retryPendingWritebacks` is imported lazily (via dynamic `import('./poller.ts')`) only inside
// the tests that need it, specifically so a missing export fails only those tests with a clear
// assertion message rather than crashing this whole file's module load (a static named import of
// a not-yet-exported binding would throw at link time and prevent every other test in this file
// from ever running).

const GITLAB_OAUTH_BASE_URL = 'https://gitlab.example.test'
const GITEA_OAUTH_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'ef'.repeat(32)
const PUBLIC_URL = 'http://localhost:3000'

const GITEA_FORGE_BASE_URL = 'https://gitea.wb.example.test'
const GITEA_REPO_FULL_NAME = 'acme/checkout'
const GITEA_INLINE_TOKEN = 'gitea-WB-INLINE-TOKEN-aa11'

const GITHUB_REPO_FULL_NAME = 'acme/app'
const GITHUB_INLINE_TOKEN = 'github_pat_WB_INLINE_TOKEN_bb22'

const GITLAB_FORGE_BASE_URL = 'https://gitlab.wb.example.test'
const GITLAB_REPO_FULL_NAME = 'acme/app'
const GITLAB_INLINE_TOKEN = 'gitlab-WB-INLINE-TOKEN-cc33'

const WRITEBACK_EVENT = '回写'
const MCP_PATH = '/api/mcp'
const MCP_PROTOCOL_VERSION = '2025-11-25'

function applyOauthTestEnv() {
  process.env.OAUTH_GITHUB_CLIENT_ID = 'test-github-client-id'
  process.env.OAUTH_GITHUB_CLIENT_SECRET = 'test-github-client-secret'
  process.env.OAUTH_GITLAB_CLIENT_ID = 'test-gitlab-client-id'
  process.env.OAUTH_GITLAB_CLIENT_SECRET = 'test-gitlab-client-secret'
  process.env.OAUTH_GITLAB_BASE_URL = GITLAB_OAUTH_BASE_URL
  process.env.OAUTH_GITEA_CLIENT_ID = 'test-gitea-client-id'
  process.env.OAUTH_GITEA_CLIENT_SECRET = 'test-gitea-client-secret'
  process.env.OAUTH_GITEA_BASE_URL = GITEA_OAUTH_BASE_URL
  process.env.SESSION_SECRET = '3'.repeat(32)
  process.env.PUBLIC_URL = PUBLIC_URL
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

function requestHeadersObject(input, init) {
  if (input && typeof input === 'object' && 'headers' in input && input.headers !== undefined) {
    return new Headers(input.headers)
  }
  return new Headers(init?.headers)
}

function requestBodyJson(input, init) {
  let raw = init?.body
  if (raw === undefined && input && typeof input === 'object' && 'body' in input) {
    raw = input.body
  }
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
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

function isPrEndpoint(url) {
  return /\/(?:pulls|merge_requests)\/\d+(?:[/?#]|$)/u.test(url)
}

function isCommentEndpoint(url) {
  return /\/issues\/\d+\/comments$/u.test(url) || /\/issues\/\d+\/notes$/u.test(url)
}

function isRepoEndpoint(url) {
  return (url.includes('/repos/') || url.includes('/projects/')) && !isPrEndpoint(url) && !isCommentEndpoint(url)
}

function isUserEndpoint(url) {
  return url.endsWith('/user') && !isPrEndpoint(url) && !isCommentEndpoint(url)
}

function prNumberFromUrl(url) {
  const path = new URL(url).pathname
  const match = path.match(/\/(?:pulls|merge_requests)\/(\d+)$/u)
  return match ? match[1] : undefined
}

// Every forge write-back POST (comment on GitHub/Gitea, note on GitLab) is recorded here so
// tests can assert exact call counts/urls/headers/bodies, independent of the validateToken and
// getPullRequest fetches also flowing through the same mocked `globalThis.fetch`.
function beginFetch(t) {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const oauth = new Map()
  const forge = new Map()
  const pr = new Map()
  const commentRequests = []
  let nextCommentResponse = null

  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    const method = requestMethod(input, init)

    if (method === 'POST' && isCommentEndpoint(url)) {
      const headers = requestHeadersObject(input, init)
      const body = requestBodyJson(input, init)
      commentRequests.push({ url, method, headers, body })
      const override = nextCommentResponse
      nextCommentResponse = null
      if (override?.unreachable) throw new TypeError('fetch failed')
      return jsonResponse(override?.status ?? 201, { id: commentRequests.length })
    }

    if (isPrEndpoint(url)) {
      const number = prNumberFromUrl(url)
      const stub = number == null ? undefined : pr.get(number)
      if (stub == null) return jsonResponse(500, { error: 'unstubbed pr endpoint', url })
      if (stub.unreachable) throw new TypeError('fetch failed')
      return jsonResponse(stub.status ?? 200, stub.body ?? {})
    }

    const token = stubbedToken(input, init)
    const forgeStub = token == null ? undefined : forge.get(token)
    if (forgeStub != null) {
      if (forgeStub.unreachable) throw new TypeError('fetch failed')
      if (isRepoEndpoint(url)) {
        const status = forgeStub.repoStatus ?? 200
        if (status !== 200) return jsonResponse(status, { message: 'Not Found' })
        return jsonResponse(200, forgeStub.repo ?? {})
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

  return {
    oauth,
    forge,
    pr,
    commentRequests,
    setNextCommentResponse(response) {
      nextCommentResponse = response
    },
  }
}

const GITHUB_GITEA_FULL_ACCESS = {
  permissions: { pull: true, push: true, admin: false },
  has_pull_requests: true,
  private: true,
}

// gitlabCapabilities (index.ts) reads a differently-shaped repo body than github/gitea's
// permissions.push: nested project_access.access_level (>= 30) plus can_create_merge_request_in.
const GITLAB_FULL_ACCESS = {
  permissions: { project_access: { access_level: 30 } },
  can_create_merge_request_in: true,
}

function repoAccessFor(token) {
  if (token === GITLAB_INLINE_TOKEN) return GITLAB_FULL_ACCESS
  return GITHUB_GITEA_FULL_ACCESS
}

function allowForgeToken(stub, token, descriptor) {
  stub.forge.set(token, descriptor ?? { repo: repoAccessFor(token) })
}

function sqliteFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-writeback-'))
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

function repoInputFor(kind) {
  if (kind === 'gitea') {
    return { forge: 'gitea', base_url: GITEA_FORGE_BASE_URL, full_name: GITEA_REPO_FULL_NAME, base_branch: 'main', suggested_dir: 'checkout' }
  }
  if (kind === 'github') {
    return { forge: 'github', base_url: 'https://github.com', full_name: GITHUB_REPO_FULL_NAME, base_branch: 'main', suggested_dir: 'app' }
  }
  return { forge: 'gitlab', base_url: GITLAB_FORGE_BASE_URL, full_name: GITLAB_REPO_FULL_NAME, base_branch: 'main', suggested_dir: 'app' }
}

function inlineTokenFor(kind) {
  if (kind === 'gitea') return GITEA_INLINE_TOKEN
  if (kind === 'github') return GITHUB_INLINE_TOKEN
  return GITLAB_INLINE_TOKEN
}

function issueUrlFor(kind, issueNumber) {
  if (kind === 'gitea') return `${GITEA_FORGE_BASE_URL}/${GITEA_REPO_FULL_NAME}/issues/${issueNumber}`
  if (kind === 'github') return `https://github.com/${GITHUB_REPO_FULL_NAME}/issues/${issueNumber}`
  return `${GITLAB_FORGE_BASE_URL}/${GITLAB_REPO_FULL_NAME}/-/issues/${issueNumber}`
}

function giteaCommentUrl(issueNumber) {
  return `${GITEA_FORGE_BASE_URL}/api/v1/repos/${GITEA_REPO_FULL_NAME}/issues/${issueNumber}/comments`
}

function githubCommentUrl(issueNumber) {
  return `https://api.github.com/repos/${GITHUB_REPO_FULL_NAME}/issues/${issueNumber}/comments`
}

function gitlabCommentUrl(issueNumber) {
  return `${GITLAB_FORGE_BASE_URL}/api/v4/projects/${encodeURIComponent(GITLAB_REPO_FULL_NAME)}/issues/${issueNumber}/notes`
}

function taskPayload({ title, kind, sourceType, issueNumber }) {
  return {
    title,
    description_md: '……（Markdown 详述）',
    source: sourceType === 'imported' ? { type: 'imported', issue_url: issueUrlFor(kind, issueNumber) } : { type: 'native' },
    repo: repoInputFor(kind),
    acceptance_criteria: ['通过测试'],
    test_command: 'pnpm test',
    constraints: { allowed_paths: ['src/**'], forbidden_paths: [] },
    priority: 'P1',
    tags: ['backend'],
    credential: { token: inlineTokenFor(kind) },
  }
}

async function createTaskOk(app, cookies, payload) {
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

async function createImportedTask(app, cookies, { kind, issueNumber, title }) {
  return createTaskOk(app, cookies, taskPayload({ title, kind, sourceType: 'imported', issueNumber }))
}

async function createNativeTask(app, cookies, { kind, title }) {
  return createTaskOk(app, cookies, taskPayload({ title, kind, sourceType: 'native' }))
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

function mcpHeaders({ token, sessionId } = {}) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
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
            clientInfo: { name: 'kaola-writeback-test', version: '0.0.0' },
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

function writebackEventsFor(db, publicId, transition) {
  return eventRows(db)
    .filter((event) => event.type === WRITEBACK_EVENT)
    .filter((event) => parseDetails(event)?.task_id === publicId)
    .filter((event) => transition === undefined || parseDetails(event)?.transition === transition)
}

function successfulWritebackEventsFor(db, publicId, transition) {
  return writebackEventsFor(db, publicId, transition).filter((event) => parseDetails(event)?.ok === true)
}

function taskRow(db, publicId) {
  return db.$client
    .prepare('SELECT id, public_id, status FROM tasks WHERE public_id = ?')
    .get(publicId)
}

async function boot(t, sqlitePath, options = {}) {
  const app = await createApp(t, { sqlitePath, ...options })
  const stub = beginFetch(t)
  allowForgeToken(stub, GITEA_INLINE_TOKEN)
  allowForgeToken(stub, GITHUB_INLINE_TOKEN)
  allowForgeToken(stub, GITLAB_INLINE_TOKEN)
  return { app, stub }
}

function giteaSignature(secret, rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

function giteaPrPayload({ merged, prUrl, fullName }) {
  return {
    action: 'closed',
    pull_request: { merged, html_url: prUrl },
    repository: { full_name: fullName },
  }
}

describe('issue #14 write-back (commentOnIssue on 认领 / 提交PR / 完成)', { concurrency: false }, () => {
  describe('认领 (claim) write-back', () => {
    test('imported gitea task: REST claim posts a write-back comment with the task credential, not the agent key', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'claim-gitea-ok')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitea', issueNumber: 501, title: '导入任务-gitea-认领' })

      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)
      assert.equal(jsonBody(claimed).token, GITEA_INLINE_TOKEN)

      const commentPosts = stub.commentRequests.filter((r) => r.url === giteaCommentUrl(501))
      assert.equal(
        commentPosts.length,
        1,
        `expected exactly one write-back comment POST, got ${JSON.stringify(stub.commentRequests)}`,
      )
      const [req] = commentPosts
      assert.equal(
        req.headers.get('authorization'),
        `token ${GITEA_INLINE_TOKEN}`,
        'the write-back comment must authenticate with the task forge credential',
      )
      assert.equal(String(req.headers.get('authorization') ?? '').includes('ktk_'), false, 'must never use a leftover Agent API key as a forge token')
      assert.equal(typeof req.body?.body, 'string')
      assert.ok(req.body.body.includes(brief.id), `comment body must contain the task publicId: ${req.body.body}`)
      assert.ok(req.body.body.includes(PUBLIC_URL), `comment body must contain PUBLIC_URL: ${req.body.body}`)

      const db = openDb(t, sqlitePath)
      const events = successfulWritebackEventsFor(db, brief.id, '认领')
      assert.equal(events.length, 1, `expected exactly one successful 回写 event for 认领, got ${JSON.stringify(eventRows(db))}`)
      assert.deepEqual(Object.keys(parseDetails(events[0])).sort(), ['issue_url', 'ok', 'task_id', 'transition'])
      assert.equal(parseDetails(events[0]).issue_url, issueUrlFor('gitea', 501))
      assert.equal(events[0].actor_user_id, poster.body.id, 'claim write-back must record the acting user, same as claimTask itself')
      assert.equal(JSON.stringify(eventRows(db)).includes(GITEA_INLINE_TOKEN), false, '回写 event must never contain the plaintext forge token')
    })

    test('native task: REST claim never posts a write-back comment and writes no 回写 event', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'claim-native')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createNativeTask(app, poster.cookies, { kind: 'gitea', title: '原生任务-认领' })

      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      assert.equal(
        stub.commentRequests.length,
        0,
        `a native task must never trigger a comment POST, got ${JSON.stringify(stub.commentRequests)}`,
      )
      const db = openDb(t, sqlitePath)
      assert.equal(writebackEventsFor(db, brief.id).length, 0, 'a native task must never write a 回写 event')
    })

    test('imported github task: claim posts to the GitHub Issues API with a Bearer task-credential header', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'claim-github-ok')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'github', issueNumber: 541, title: '导入任务-github-认领' })

      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      const commentPosts = stub.commentRequests.filter((r) => r.url === githubCommentUrl(541))
      assert.equal(
        commentPosts.length,
        1,
        `expected exactly one github write-back comment POST, got ${JSON.stringify(stub.commentRequests)}`,
      )
      const [req] = commentPosts
      assert.equal(req.headers.get('authorization'), `Bearer ${GITHUB_INLINE_TOKEN}`)
      assert.ok(req.body.body.includes(brief.id))
      assert.ok(req.body.body.includes(PUBLIC_URL))
    })

    test('imported gitlab task: claim posts a note with a PRIVATE-TOKEN task-credential header', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'claim-gitlab-ok')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitlab', issueNumber: 551, title: '导入任务-gitlab-认领' })

      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      const commentPosts = stub.commentRequests.filter((r) => r.url === gitlabCommentUrl(551))
      assert.equal(
        commentPosts.length,
        1,
        `expected exactly one gitlab write-back note POST, got ${JSON.stringify(stub.commentRequests)}`,
      )
      const [req] = commentPosts
      assert.equal(req.headers.get('private-token'), GITLAB_INLINE_TOKEN)
      assert.ok(req.body.body.includes(brief.id))
      assert.ok(req.body.body.includes(PUBLIC_URL))
    })

    test('a forge 5xx on the claim comment never blocks the claim, and no successful 回写 is recorded', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'claim-5xx')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitea', issueNumber: 502, title: '导入任务-gitea-评论失败' })

      stub.setNextCommentResponse({ status: 503 })
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(
        claimed.statusCode,
        201,
        `a forge 5xx on the write-back comment must never fail the claim itself, got ${claimed.statusCode} ${claimed.body}`,
      )
      assert.equal(jsonBody(claimed).token, GITEA_INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      assert.equal(
        successfulWritebackEventsFor(db, brief.id, '认领').length,
        0,
        'a failed write-back comment attempt must never be recorded as a successful 回写',
      )
      assert.equal(JSON.stringify(eventRows(db)).includes(GITEA_INLINE_TOKEN), false)
    })
  })

  describe('提交 PR (submit_pr) write-back', () => {
    test('imported gitea task: MCP submit_pr posts a write-back comment containing publicId, PUBLIC_URL, and pr_url', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'submit-gitea-ok')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitea', issueNumber: 511, title: '导入任务-gitea-提交' })
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)

      const prUrl = `${GITEA_FORGE_BASE_URL}/${GITEA_REPO_FULL_NAME}/pulls/9001`
      const submitted = await submitPrViaMcp(app, key.identity, { taskId: brief.id, prUrl, summary: '已完成分页' })
      assert.equal(submitted.task.status, '待验收', `submit_pr: ${JSON.stringify(submitted)}`)

      const commentPosts = stub.commentRequests.filter((r) => r.url === giteaCommentUrl(511))
      assert.equal(
        commentPosts.length,
        2,
        `expected the claim comment plus the submit_pr comment, got ${JSON.stringify(stub.commentRequests)}`,
      )
      const submitComment = commentPosts[1]
      assert.ok(submitComment.body.body.includes(brief.id))
      assert.ok(submitComment.body.body.includes(PUBLIC_URL))
      assert.ok(submitComment.body.body.includes(prUrl), `submit_pr comment must contain the submitted pr_url: ${submitComment.body.body}`)

      const db = openDb(t, sqlitePath)
      const events = successfulWritebackEventsFor(db, brief.id, '提交PR')
      assert.equal(events.length, 1, `expected exactly one successful 回写 event for 提交PR, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(events[0].actor_user_id, poster.body.id, 'submit_pr write-back must record the acting user, same as submitPr itself')
    })

    test('a forge network failure on the submit_pr comment never blocks submit_pr, and no successful 回写 is recorded', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'submit-fail')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitea', issueNumber: 512, title: '导入任务-gitea-提交失败' })
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201)

      const prUrl = `${GITEA_FORGE_BASE_URL}/${GITEA_REPO_FULL_NAME}/pulls/9002`
      stub.setNextCommentResponse({ unreachable: true })
      const submitted = await submitPrViaMcp(app, key.identity, { taskId: brief.id, prUrl, summary: '网络故障用例' })
      assert.equal(submitted.task.status, '待验收', `submit_pr must still succeed despite the write-back failure: ${JSON.stringify(submitted)}`)

      const db = openDb(t, sqlitePath)
      assert.equal(successfulWritebackEventsFor(db, brief.id, '提交PR').length, 0)
    })
  })

  describe('完成 (complete) write-back', () => {
    test('imported gitea task: pollPendingReviews posts a write-back comment on 已完成 (merged)', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'complete-poll-ok')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitea', issueNumber: 521, title: '导入任务-gitea-完成-轮询' })
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201)
      const prUrl = `${GITEA_FORGE_BASE_URL}/${GITEA_REPO_FULL_NAME}/pulls/9011`
      const submitted = await submitPrViaMcp(app, key.identity, { taskId: brief.id, prUrl, summary: '完成用例' })
      assert.equal(submitted.task.status, '待验收')

      stub.pr.set('9011', { body: { number: 9011, state: 'closed', merged: true } })

      const db = openDb(t, sqlitePath)
      await pollPendingReviews(db)

      const after = taskRow(db, brief.id)
      assert.equal(after.status, '已完成', `expected 已完成, got ${JSON.stringify(after)}`)

      const commentPosts = stub.commentRequests.filter((r) => r.url === giteaCommentUrl(521))
      const completeComment = commentPosts[commentPosts.length - 1]
      assert.ok(completeComment, `expected a write-back comment after completion, got ${JSON.stringify(stub.commentRequests)}`)
      assert.ok(completeComment.body.body.includes(brief.id))
      assert.ok(completeComment.body.body.includes(PUBLIC_URL))
      assert.ok(completeComment.body.body.includes(prUrl))

      const events = successfulWritebackEventsFor(db, brief.id, '完成')
      assert.equal(events.length, 1, `expected exactly one successful 回写 event for 完成, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(events[0].actor_user_id, null, 'a poller-driven completion write-back must be system-driven (actor_user_id null)')
    })

    test('imported gitea task: a webhook merged delivery posts a write-back comment on 已完成', async (t) => {
      const sqlitePath = sqliteFile(t)
      const webhookSecret = 'kaola-writeback-webhook-secret-01'
      const { app, stub } = await boot(t, sqlitePath, {
        forgeInstances: [
          { publicId: 'inst-writeback-gitea', forge: 'gitea', baseUrl: GITEA_FORGE_BASE_URL, syncMode: 'webhook', webhookSecret },
        ],
      })
      const poster = await loginGitea(app, stub, 'complete-webhook-ok')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitea', issueNumber: 522, title: '导入任务-gitea-完成-webhook' })
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201)
      const prUrl = `${GITEA_FORGE_BASE_URL}/${GITEA_REPO_FULL_NAME}/pulls/9012`
      const submitted = await submitPrViaMcp(app, key.identity, { taskId: brief.id, prUrl, summary: '完成用例-webhook' })
      assert.equal(submitted.task.status, '待验收')

      const rawBody = JSON.stringify(giteaPrPayload({ merged: true, prUrl, fullName: GITEA_REPO_FULL_NAME }))
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/inst-writeback-gitea',
        headers: {
          'content-type': 'application/json',
          'x-gitea-event': 'pull_request',
          'x-gitea-signature': giteaSignature(webhookSecret, rawBody),
        },
        payload: rawBody,
      })
      assert.equal(res.statusCode, 204, `webhook delivery: ${res.statusCode} ${res.body}`)

      const db = openDb(t, sqlitePath)
      assert.equal(taskRow(db, brief.id).status, '已完成')

      const commentPosts = stub.commentRequests.filter((r) => r.url === giteaCommentUrl(522))
      const completeComment = commentPosts[commentPosts.length - 1]
      assert.ok(completeComment, `expected a write-back comment after the webhook-driven completion, got ${JSON.stringify(stub.commentRequests)}`)
      assert.ok(completeComment.body.body.includes(brief.id))
      assert.ok(completeComment.body.body.includes(PUBLIC_URL))
      assert.ok(completeComment.body.body.includes(prUrl))

      const events = successfulWritebackEventsFor(db, brief.id, '完成')
      assert.equal(events.length, 1, `expected exactly one successful 回写 event for the webhook-driven 完成, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(events[0].actor_user_id, null)
    })

    test('imported gitea task: a closed (unmerged) PR via pollPendingReviews (已退回) never posts a completion write-back comment', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'complete-closed')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitea', issueNumber: 523, title: '导入任务-gitea-已退回' })
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201)
      const prUrl = `${GITEA_FORGE_BASE_URL}/${GITEA_REPO_FULL_NAME}/pulls/9013`
      const submitted = await submitPrViaMcp(app, key.identity, { taskId: brief.id, prUrl, summary: '未通过验收' })
      assert.equal(submitted.task.status, '待验收')

      stub.pr.set('9013', { body: { number: 9013, state: 'closed', merged: false } })
      const beforeCount = stub.commentRequests.length

      const db = openDb(t, sqlitePath)
      await pollPendingReviews(db)

      const after = taskRow(db, brief.id)
      assert.equal(after.status, '已退回', `expected 已退回, got ${JSON.stringify(after)}`)
      assert.equal(
        stub.commentRequests.length,
        beforeCount,
        '已退回 (terminal: closed) must never trigger a completion write-back comment',
      )
      assert.equal(successfulWritebackEventsFor(db, brief.id, '完成').length, 0)
    })

    test('a forge 5xx on the completion comment never blocks reaching 已完成, and no successful 回写 is recorded', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'complete-5xx')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitea', issueNumber: 524, title: '导入任务-gitea-完成失败' })
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201)
      const prUrl = `${GITEA_FORGE_BASE_URL}/${GITEA_REPO_FULL_NAME}/pulls/9014`
      const submitted = await submitPrViaMcp(app, key.identity, { taskId: brief.id, prUrl, summary: '完成评论失败用例' })
      assert.equal(submitted.task.status, '待验收')

      stub.pr.set('9014', { body: { number: 9014, state: 'closed', merged: true } })
      stub.setNextCommentResponse({ status: 502 })

      const db = openDb(t, sqlitePath)
      await pollPendingReviews(db)

      assert.equal(
        taskRow(db, brief.id).status,
        '已完成',
        'the completion transition itself must succeed even though its write-back comment failed',
      )
      assert.equal(successfulWritebackEventsFor(db, brief.id, '完成').length, 0)
      assert.equal(JSON.stringify(eventRows(db)).includes(GITEA_INLINE_TOKEN), false)
    })
  })

  describe('native task: no write-back at any of the three hooks', () => {
    test('a native task never posts a write-back comment across claim, submit_pr, and completion', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'native-lifecycle')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createNativeTask(app, poster.cookies, { kind: 'gitea', title: '原生任务-全流程' })
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201)

      const prUrl = `${GITEA_FORGE_BASE_URL}/${GITEA_REPO_FULL_NAME}/pulls/9031`
      const submitted = await submitPrViaMcp(app, key.identity, { taskId: brief.id, prUrl, summary: '原生任务提交' })
      assert.equal(submitted.task.status, '待验收')

      stub.pr.set('9031', { body: { number: 9031, state: 'closed', merged: true } })
      const db = openDb(t, sqlitePath)
      await pollPendingReviews(db)
      assert.equal(taskRow(db, brief.id).status, '已完成')

      assert.equal(
        stub.commentRequests.length,
        0,
        `a native task must never post a write-back comment at any hook, got ${JSON.stringify(stub.commentRequests)}`,
      )
      assert.equal(writebackEventsFor(db, brief.id).length, 0, 'a native task must never write any 回写 event')
    })
  })

  describe('retry (retryPendingWritebacks, exported from apps/server/src/poller.ts)', () => {
    test('re-posts a write-back comment that failed on 认领, and does not duplicate once it has succeeded', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'retry-claim')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitea', issueNumber: 531, title: '导入任务-gitea-重试' })

      stub.setNextCommentResponse({ status: 500 })
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim must still succeed despite the forge 5xx, got ${claimed.statusCode} ${claimed.body}`)

      const db = openDb(t, sqlitePath)
      assert.equal(
        successfulWritebackEventsFor(db, brief.id, '认领').length,
        0,
        'setup: expected the first comment attempt to have failed (no successful 回写 yet)',
      )
      const failedAttempts = stub.commentRequests.filter((r) => r.url === giteaCommentUrl(531)).length
      assert.equal(failedAttempts, 1)

      const poller = await import('./poller.ts')
      assert.equal(
        typeof poller.retryPendingWritebacks,
        'function',
        'apps/server/src/poller.ts must export retryPendingWritebacks(db: AppDb): Promise<void>',
      )
      await poller.retryPendingWritebacks(db)

      const successfulAttempts = stub.commentRequests.filter((r) => r.url === giteaCommentUrl(531)).length
      assert.equal(
        successfulAttempts,
        2,
        `retryPendingWritebacks must re-attempt the failed 认领 comment, got ${JSON.stringify(stub.commentRequests)}`,
      )

      const events = successfulWritebackEventsFor(db, brief.id, '认领')
      assert.equal(events.length, 1, `expected exactly one successful 回写 event for 认领 after retry, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(events[0].actor_user_id, null, 'a retry-driven write-back must be system-driven (actor_user_id null)')

      // Calling it again must not duplicate a POST for a transition that already has a successful 回写.
      await poller.retryPendingWritebacks(db)
      const afterSecondCall = stub.commentRequests.filter((r) => r.url === giteaCommentUrl(531)).length
      assert.equal(afterSecondCall, 2, 'a transition with a successful 回写 must never be retried again')
      assert.equal(successfulWritebackEventsFor(db, brief.id, '认领').length, 1)
    })

    test('re-posts a write-back comment that failed on 完成 (via pollPendingReviews)', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'retry-complete')
      const key = await mintAgentKey(app, poster.cookies, 'agent')
      const brief = await createImportedTask(app, poster.cookies, { kind: 'gitea', issueNumber: 532, title: '导入任务-gitea-完成重试' })
      const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201)
      const prUrl = `${GITEA_FORGE_BASE_URL}/${GITEA_REPO_FULL_NAME}/pulls/9041`
      const submitted = await submitPrViaMcp(app, key.identity, { taskId: brief.id, prUrl, summary: '完成重试用例' })
      assert.equal(submitted.task.status, '待验收')

      stub.pr.set('9041', { body: { number: 9041, state: 'closed', merged: true } })
      stub.setNextCommentResponse({ status: 502 })

      const db = openDb(t, sqlitePath)
      await pollPendingReviews(db)
      assert.equal(taskRow(db, brief.id).status, '已完成', 'the completion itself must succeed even though its write-back comment failed')
      assert.equal(successfulWritebackEventsFor(db, brief.id, '完成').length, 0, 'setup: expected the completion comment to have failed')

      const poller = await import('./poller.ts')
      assert.equal(typeof poller.retryPendingWritebacks, 'function')
      await poller.retryPendingWritebacks(db)

      const events = successfulWritebackEventsFor(db, brief.id, '完成')
      assert.equal(events.length, 1, `expected a new successful 回写 for 完成 after retry, got ${JSON.stringify(eventRows(db))}`)
    })

    test('is a safe no-op when there is nothing pending', async (t) => {
      const sqlitePath = sqliteFile(t)
      await boot(t, sqlitePath)
      const db = openDb(t, sqlitePath)
      const poller = await import('./poller.ts')
      await assert.doesNotReject(async () => {
        await poller.retryPendingWritebacks(db)
      }, 'retryPendingWritebacks must never reject, even with zero tasks in the database')
    })
  })
})
