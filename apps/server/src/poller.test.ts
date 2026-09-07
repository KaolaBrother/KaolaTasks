import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.ts'
import { pollPendingReviews } from './poller.ts'
import { injectSigned, pairDeviceToSelf } from './device-proof.test-helpers.ts'
import { ensureSetup } from './auth.test-helpers.ts'

// Issue #11. Seams copied from mcp.test.ts (do not import that file). This spec drives the real
// MCP `submit_pr` tool to put a task into 待验收 with a real `submissions` row, then calls
// `pollPendingReviews(db)` directly against a *second* connection to the same sqlite file — never
// against a mocked/stubbed `pollPendingReviews` or `buildApp`.

const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'cd'.repeat(32)

const FORGE_BASE_URL = 'https://gitea.poller.example.test'
const REPO_FULL_NAME = 'team/orders'
const INLINE_TOKEN = 'gitea-POLLER-INLINE-TOKEN-pq77'

const STATUS_TRANSITION_EVENT = '状态迁移'
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
  process.env.SESSION_SECRET = '0'.repeat(32)
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

// Deliberately distinct from mcp.test.ts's `isRepoEndpoint`: a PR/MR GET (`/pulls/{n}` or
// `/merge_requests/{iid}`) must never be misclassified as a validateToken repo/user probe, so the
// PR-endpoint check runs first and repo/user checks explicitly exclude it.
function isPrEndpoint(url) {
  return /\/(?:pulls|merge_requests)\/\d+(?:[/?#]|$)/u.test(url)
}

function isRepoEndpoint(url) {
  return (url.includes('/repos/') || url.includes('/projects/')) && !isPrEndpoint(url)
}

function isUserEndpoint(url) {
  return url.endsWith('/user') && !isPrEndpoint(url)
}

function prNumberFromUrl(url) {
  const path = new URL(url).pathname
  const match = path.match(/\/(?:pulls|merge_requests)\/(\d+)$/u)
  return match ? match[1] : undefined
}

function beginFetch(t) {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const oauth = new Map()
  const forge = new Map()
  const pr = new Map()
  const requests = []
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    requests.push({ url, method: requestMethod(input, init) })

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
  return { oauth, forge, pr, requests }
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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-poller-'))
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
    title: '轮询待验收任务',
    description_md: '……（Markdown 详述）',
    source: { type: 'native' },
    repo: {
      forge: 'gitea',
      base_url: FORGE_BASE_URL,
      full_name: REPO_FULL_NAME,
      base_branch: 'main',
      suggested_dir: 'orders',
    },
    acceptance_criteria: ['通过分页测试'],
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

async function patchTaskStatus(app, cookies, publicId, status) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/tasks/${publicId}`,
    cookies,
    headers: jsonHeaders,
    payload: { status },
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
            clientInfo: { name: 'kaola-poller-test', version: '0.0.0' },
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

function leaseRows(db, taskPk) {
  return db.$client
    .prepare('SELECT id, task_id, state FROM leases WHERE task_id = ?')
    .all(taskPk)
}

function activeLeaseRows(db, taskPk) {
  return leaseRows(db, taskPk).filter((row) => row.state === 'active')
}

function submissionRows(db, taskPk) {
  return db.$client
    .prepare('SELECT id, task_id, lease_id, pr_url, summary, pr_state FROM submissions WHERE task_id = ? ORDER BY id')
    .all(taskPk)
}

function forceStatus(db, publicId, status) {
  const info = db.$client.prepare('UPDATE tasks SET status = ? WHERE public_id = ?').run(status, publicId)
  assert.equal(info.changes, 1, `expected to force ${publicId} into ${status}`)
}

async function boot(t, sqlitePath) {
  const app = await createApp(t, sqlitePath ? { sqlitePath } : undefined)
  const stub = beginFetch(t)
  allowForgeToken(stub, INLINE_TOKEN)
  return { app, stub }
}

// Sets up one task through the real HTTP + MCP surface up to 待验收: create → claim → submit_pr.
// Returns the public id and the PR number embedded in the pr_url, so callers can stub the PR
// endpoint for that exact number before calling `pollPendingReviews`.
async function createPendingReviewTask(app, stub, poster, key, { title, prNumber, summary }) {
  const brief = await createTaskOk(app, poster.cookies, taskPayload({ title }))
  const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
  assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)
  const prUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/${prNumber}`
  const submitted = await submitPrViaMcp(app, key.identity, { taskId: brief.id, prUrl, summary })
  assert.equal(submitted.task.status, '待验收', `setup submit_pr: ${JSON.stringify(submitted)}`)
  return { publicId: brief.id, prUrl, prNumber: String(prNumber) }
}

describe('issue #11 poller (pollPendingReviews)', { concurrency: false }, () => {
  describe('getPullRequest-driven terminal transitions', () => {
    test('merged PR: 待合并 → 已完成, submissions.pr_state → merged, system 状态迁移 (actor_user_id null)', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'poll-merged')
      const key = await mintAgentKey(app, poster.cookies, 'poller')

      const setup = await createPendingReviewTask(app, stub, poster, key, {
        title: '合并用例',
        prNumber: 101,
        summary: '分页导出已提交',
      })
      stub.pr.set(setup.prNumber, { body: { number: 101, state: 'closed', merged: true } })

      const db = openDb(t, sqlitePath)
      // Issue #53 (§5): a merge only completes a task Kaola已「通过」. Approving in Kaola is exactly
      // this row write, so drive the task to 待合并 before the merge is observed.
      forceStatus(db, setup.publicId, '待合并')
      const before = taskRow(db, setup.publicId)
      await pollPendingReviews(db)

      const after = taskRow(db, setup.publicId)
      assert.equal(after.status, '已完成', `expected 已完成, got ${JSON.stringify(after)}`)

      const rows = submissionRows(db, before.id)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].pr_state, 'merged')

      const migrated = statusTransitionEventsFor(db, setup.publicId).filter((event) => {
        const details = parseDetails(event)
        return details?.from === '待合并' && details?.to === '已完成'
      })
      assert.equal(migrated.length, 1, `expected one system 状态迁移 待合并→已完成, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(migrated[0].actor_user_id, null, 'poller-driven transition must have actor_user_id null')
      assert.deepEqual(parseDetails(migrated[0]), {
        task_id: setup.publicId,
        from: '待合并',
        to: '已完成',
        pr_url: setup.prUrl,
      })

      assert.equal(activeLeaseRows(db, before.id).length, 0, 'poller must never resurrect a lease')
      assert.equal(JSON.stringify(eventRows(db)).includes(INLINE_TOKEN), false, 'plaintext token must never reach events.details')
    })

    test('closed (unmerged) PR: 待验收 → 已退回, submissions.pr_state → closed', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'poll-closed')
      const key = await mintAgentKey(app, poster.cookies, 'poller')

      const setup = await createPendingReviewTask(app, stub, poster, key, {
        title: '关闭用例',
        prNumber: 102,
        summary: '未通过验收',
      })
      stub.pr.set(setup.prNumber, { body: { number: 102, state: 'closed', merged: false } })

      const db = openDb(t, sqlitePath)
      const before = taskRow(db, setup.publicId)
      await pollPendingReviews(db)

      const after = taskRow(db, setup.publicId)
      assert.equal(after.status, '已退回', `expected 已退回, got ${JSON.stringify(after)}`)

      const rows = submissionRows(db, before.id)
      assert.equal(rows.length, 1)
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

    test('open PR: task stays 待验收, pr_state stays open', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'poll-open')
      const key = await mintAgentKey(app, poster.cookies, 'poller')

      const setup = await createPendingReviewTask(app, stub, poster, key, {
        title: '仍开放用例',
        prNumber: 103,
        summary: '仍在审阅',
      })
      stub.pr.set(setup.prNumber, { body: { number: 103, state: 'open', merged: false } })

      const db = openDb(t, sqlitePath)
      const before = taskRow(db, setup.publicId)
      await pollPendingReviews(db)

      const after = taskRow(db, setup.publicId)
      assert.equal(after.status, '待验收', `open PR must leave the task at 待验收, got ${JSON.stringify(after)}`)

      const rows = submissionRows(db, before.id)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].pr_state, 'open')

      assert.equal(
        statusTransitionEventsFor(db, setup.publicId).filter((event) => {
          const details = parseDetails(event)
          return details?.from === '待验收'
        }).length,
        0,
        'an open PR must not write any 状态迁移 out of 待验收',
      )
    })

    // Issue #53 (§5): 待验收 → 已完成 is no longer a legal edge. A human who merges a PR that Kaola
    // never passed must not silently complete the task — the board keeps showing 待验收.
    test('a merged PR observed while the task is still 待验收 is left unchanged (Kaola never approved it)', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'poll-merged-unapproved')
      const key = await mintAgentKey(app, poster.cookies, 'poller')

      const setup = await createPendingReviewTask(app, stub, poster, key, {
        title: '未通过即合并用例',
        prNumber: 104,
        summary: '考拉尚未通过',
      })
      stub.pr.set(setup.prNumber, { body: { number: 104, state: 'closed', merged: true } })

      const db = openDb(t, sqlitePath)
      const before = taskRow(db, setup.publicId)
      assert.equal(before.status, '待验收', 'setup: the task must still be awaiting Kaola review')
      await pollPendingReviews(db)

      const after = taskRow(db, setup.publicId)
      assert.equal(after.status, '待验收', `a merge without a Kaola 通过 must leave the task at 待验收, got ${JSON.stringify(after)}`)

      const rows = submissionRows(db, before.id)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].pr_state, 'open', 'pr_state must not be advanced to merged for an unapproved task')

      assert.equal(
        statusTransitionEventsFor(db, setup.publicId).filter((event) => parseDetails(event)?.to === '已完成').length,
        0,
        `no 状态迁移 may reach 已完成, got ${JSON.stringify(eventRows(db))}`,
      )
    })
  })

  describe('scope: only 待验收 tasks are ever fetched', () => {
    test('待认领/进行中/已完成/已取消/已退回 tasks are never fetched as PRs and are left untouched', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'poll-scope')
      const key = await mintAgentKey(app, poster.cookies, 'poller')

      const statuses = ['待认领', '进行中', '已完成', '已取消', '已退回']
      const setups = []
      let prNumber = 200
      for (const status of statuses) {
        prNumber += 1
        const setup = await createPendingReviewTask(app, stub, poster, key, {
          title: `作用域用例 ${status}`,
          prNumber,
          summary: '不应被轮询',
        })
        // A stub is installed so that if the poller mistakenly fetches this PR, the mismatch
        // between the stub's `merged: true` and the unchanged status below will be caught.
        stub.pr.set(setup.prNumber, { body: { number: prNumber, state: 'closed', merged: true } })
        const db = openDb(t, sqlitePath)
        forceStatus(db, setup.publicId, status)
        setups.push({ ...setup, status })
      }

      const db = openDb(t, sqlitePath)
      await pollPendingReviews(db)

      for (const setup of setups) {
        const row = taskRow(db, setup.publicId)
        assert.equal(row.status, setup.status, `expected ${setup.publicId} to remain ${setup.status}, got ${row.status}`)
        assert.equal(
          stub.requests.some((r) => r.url.includes(`/pulls/${setup.prNumber}`)),
          false,
          `task at ${setup.status} must never be fetched as a PR (${setup.publicId})`,
        )
      }
    })
  })

  describe('resilience', () => {
    test('a fetch failure on one 待验收 task is skipped, and a sibling 待合并 task still completes', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'poll-resilience')
      const key = await mintAgentKey(app, poster.cookies, 'poller')

      const broken = await createPendingReviewTask(app, stub, poster, key, {
        title: '不可达用例',
        prNumber: 301,
        summary: '将失败',
      })
      stub.pr.set(broken.prNumber, { unreachable: true })

      const healthy = await createPendingReviewTask(app, stub, poster, key, {
        title: '健康用例',
        prNumber: 302,
        summary: '将完成',
      })
      stub.pr.set(healthy.prNumber, { body: { number: 302, state: 'closed', merged: true } })

      const db = openDb(t, sqlitePath)
      // Issue #53 (§5): only a task Kaola已「通过」(待合并) is completed by an observed merge.
      forceStatus(db, healthy.publicId, '待合并')
      const brokenPk = taskRow(db, broken.publicId).id
      const healthyPk = taskRow(db, healthy.publicId).id

      await assert.doesNotReject(async () => {
        await pollPendingReviews(db)
      }, 'one failing task must not throw out of the poll loop')

      const brokenAfter = taskRow(db, broken.publicId)
      assert.equal(brokenAfter.status, '待验收', 'the failing task must be skipped, not transitioned')
      assert.equal(submissionRows(db, brokenPk)[0].pr_state, 'open')

      const healthyAfter = taskRow(db, healthy.publicId)
      assert.equal(healthyAfter.status, '已完成', 'a sibling 待合并 task must still complete')
      assert.equal(submissionRows(db, healthyPk)[0].pr_state, 'merged')
    })
  })

  describe('reopen after a poller-driven 已退回', () => {
    test('poster PATCH { status: 待认领 } succeeds after 已退回, and prior events + the submissions row remain', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app, stub, 'poll-reopen')
      const key = await mintAgentKey(app, poster.cookies, 'poller')

      const setup = await createPendingReviewTask(app, stub, poster, key, {
        title: '重开用例',
        prNumber: 401,
        summary: '未通过',
      })
      stub.pr.set(setup.prNumber, { body: { number: 401, state: 'closed', merged: false } })

      const db = openDb(t, sqlitePath)
      const pk = taskRow(db, setup.publicId).id
      await pollPendingReviews(db)
      assert.equal(taskRow(db, setup.publicId).status, '已退回', 'setup: expected the poller to reject the task first')

      const eventsBeforeReopen = statusTransitionEventsFor(db, setup.publicId)
      assert.ok(eventsBeforeReopen.length > 0, 'setup: expected prior 状态迁移 history')
      const submissionsBeforeReopen = submissionRows(db, pk)
      assert.equal(submissionsBeforeReopen.length, 1)

      const reopened = await patchTaskStatus(app, poster.cookies, setup.publicId, '待认领')
      assert.equal(reopened.statusCode, 200, `PATCH reopen: ${reopened.statusCode} ${reopened.body}`)
      assert.equal(jsonBody(reopened).status, '待认领')

      const afterReopen = taskRow(db, setup.publicId)
      assert.equal(afterReopen.status, '待认领')

      const eventsAfterReopen = statusTransitionEventsFor(db, setup.publicId)
      assert.ok(
        eventsAfterReopen.length >= eventsBeforeReopen.length + 1,
        '状态迁移 history must be additive across the poller transition and the reopen, never pruned',
      )
      for (const event of eventsBeforeReopen) {
        assert.ok(
          eventsAfterReopen.some((e) => JSON.stringify(e) === JSON.stringify(event)),
          'a prior 状态迁移 event must survive the reopen unmodified',
        )
      }

      const submissionsAfterReopen = submissionRows(db, pk)
      assert.deepEqual(
        submissionsAfterReopen,
        submissionsBeforeReopen,
        'the submissions row from the rejected PR must survive the reopen unmodified',
      )
    })
  })

  describe('buildApp({ pollIntervalMs }) frequency contract', () => {
    test('omitted pollIntervalMs registers no interval', async (t) => {
      const calls = []
      const originalSetInterval = globalThis.setInterval
      t.mock.method(globalThis, 'setInterval', (fn, ms, ...rest) => {
        calls.push({ ms })
        return originalSetInterval(fn, ms, ...rest)
      })
      t.after(() => {
        globalThis.setInterval = originalSetInterval
      })

      await createApp(t, undefined)
      assert.equal(calls.length, 0, 'buildApp() with no pollIntervalMs must not register a poller interval')
    })

    test('pollIntervalMs: 0 registers no interval', async (t) => {
      const sqlitePath = sqliteFile(t)
      const calls = []
      const originalSetInterval = globalThis.setInterval
      t.mock.method(globalThis, 'setInterval', (fn, ms, ...rest) => {
        calls.push({ ms })
        return originalSetInterval(fn, ms, ...rest)
      })
      t.after(() => {
        globalThis.setInterval = originalSetInterval
      })

      await createApp(t, { sqlitePath, pollIntervalMs: 0 })
      assert.equal(calls.length, 0, 'pollIntervalMs: 0 must not register a poller interval')
    })

    test('pollIntervalMs: 1234 registers setInterval with delay 1234', async (t) => {
      const sqlitePath = sqliteFile(t)
      const calls = []
      const fakeHandle = {}
      const originalSetInterval = globalThis.setInterval
      const originalClearInterval = globalThis.clearInterval
      t.mock.method(globalThis, 'setInterval', (fn, ms) => {
        calls.push({ fn, ms })
        return fakeHandle
      })
      t.mock.method(globalThis, 'clearInterval', (handle) => {
        if (handle !== fakeHandle) return originalClearInterval(handle)
      })
      t.after(() => {
        globalThis.setInterval = originalSetInterval
        globalThis.clearInterval = originalClearInterval
      })

      await createApp(t, { sqlitePath, pollIntervalMs: 1234 })
      assert.equal(calls.length, 1, `expected exactly one setInterval registration, got ${calls.length}`)
      assert.equal(calls[0].ms, 1234)
    })
  })
})

// Issue #13. ADD-only: per-instance webhook-vs-poll config that `pollPendingReviews` must honor.
// `pollPendingReviews(db, forgeInstances)` is called directly here — the same style every other
// test in this file already uses to drive the poller — with a second argument the function does
// not accept on HEAD `44eca32b` (that HEAD's `pollPendingReviews` takes only `db`, has no concept
// of an "instance", and therefore can never skip any 待验收 row). None of the tests above this
// marker are modified.
describe('issue #13: per-instance webhook-vs-poll config (pollPendingReviews honors forgeInstances)', { concurrency: false }, () => {
  test('a syncMode: "webhook" instance matching (repoForge, repoBaseUrl) is skipped: zero getPullRequest fetches, task stays 待验收', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const poster = await loginGitea(app, stub, 'skip-webhook-mode')
    const key = await mintAgentKey(app, poster.cookies, 'poller')

    const setup = await createPendingReviewTask(app, stub, poster, key, {
      title: 'webhook 模式跳过用例',
      prNumber: 501,
      summary: '应被跳过',
    })
    // Tripwire: if the poller mistakenly fetches this PR despite webhook mode, this merged: true
    // stub would flip the status below — the skip is proven by observed behavior, not merely by
    // the absence of a recorded request.
    stub.pr.set(setup.prNumber, { body: { number: 501, state: 'closed', merged: true } })

    const forgeInstances = [
      {
        publicId: 'inst-webhook-mode',
        forge: 'gitea',
        baseUrl: FORGE_BASE_URL,
        syncMode: 'webhook',
        webhookSecret: 'test-webhook-secret-aa',
      },
    ]

    const db = openDb(t, sqlitePath)
    await pollPendingReviews(db, forgeInstances)

    const after = taskRow(db, setup.publicId)
    assert.equal(
      after.status,
      '待验收',
      `a webhook-mode instance's task must not be advanced by the poller, got ${JSON.stringify(after)}`,
    )
    assert.equal(
      stub.requests.some((r) => r.url.includes(`/pulls/${setup.prNumber}`)),
      false,
      'a webhook-mode instance must result in zero getPullRequest fetches for its tasks',
    )
    assert.equal(submissionRows(db, after.id)[0].pr_state, 'open')
  })

  test('an unlisted/mismatched instance (wrong base_url, or right base_url with the wrong forge) is still polled as before', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const poster = await loginGitea(app, stub, 'skip-unlisted')
    const key = await mintAgentKey(app, poster.cookies, 'poller')

    const setup = await createPendingReviewTask(app, stub, poster, key, {
      title: '未列出实例仍轮询用例',
      prNumber: 502,
      summary: '应正常完成',
    })
    stub.pr.set(setup.prNumber, { body: { number: 502, state: 'closed', merged: true } })

    // Neither entry is an exact (forge, base_url) match for the task's (gitea, FORGE_BASE_URL):
    // the first has the right forge but a different base_url, the second has the right base_url
    // but a different forge. The match must be the exact tuple, not either field alone.
    const forgeInstances = [
      {
        publicId: 'inst-other-host',
        forge: 'gitea',
        baseUrl: 'https://gitea.unrelated.example.test',
        syncMode: 'webhook',
        webhookSecret: 'x',
      },
      {
        publicId: 'inst-wrong-forge',
        forge: 'github',
        baseUrl: FORGE_BASE_URL,
        syncMode: 'webhook',
        webhookSecret: 'y',
      },
    ]

    const db = openDb(t, sqlitePath)
    forceStatus(db, setup.publicId, '待合并')
    await pollPendingReviews(db, forgeInstances)

    const after = taskRow(db, setup.publicId)
    assert.equal(
      after.status,
      '已完成',
      `a task matching no forgeInstances entry by the exact (forge, base_url) tuple must still be polled, got ${JSON.stringify(after)}`,
    )
    assert.equal(
      stub.requests.some((r) => r.url.includes(`/pulls/${setup.prNumber}`)),
      true,
      'expected the unlisted-instance task to actually be fetched',
    )
  })

  test('a syncMode: "poll" instance matching (repoForge, repoBaseUrl) is still polled', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const poster = await loginGitea(app, stub, 'skip-poll-mode')
    const key = await mintAgentKey(app, poster.cookies, 'poller')

    const setup = await createPendingReviewTask(app, stub, poster, key, {
      title: 'poll 模式仍轮询用例',
      prNumber: 503,
      summary: '应正常完成',
    })
    stub.pr.set(setup.prNumber, { body: { number: 503, state: 'closed', merged: true } })

    const forgeInstances = [
      {
        publicId: 'inst-poll-mode',
        forge: 'gitea',
        baseUrl: FORGE_BASE_URL,
        syncMode: 'poll',
        webhookSecret: 'test-webhook-secret-bb',
      },
    ]

    const db = openDb(t, sqlitePath)
    forceStatus(db, setup.publicId, '待合并')
    await pollPendingReviews(db, forgeInstances)

    const after = taskRow(db, setup.publicId)
    assert.equal(after.status, '已完成', 'a syncMode: poll instance must not be skipped by the poller')
    assert.equal(
      stub.requests.some((r) => r.url.includes(`/pulls/${setup.prNumber}`)),
      true,
    )
  })

  test('an explicit empty forgeInstances array polls every 待合并 task exactly as omitting the argument does', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const poster = await loginGitea(app, stub, 'skip-empty-array')
    const key = await mintAgentKey(app, poster.cookies, 'poller')

    const setup = await createPendingReviewTask(app, stub, poster, key, {
      title: '空实例列表用例',
      prNumber: 504,
      summary: '应正常完成',
    })
    stub.pr.set(setup.prNumber, { body: { number: 504, state: 'closed', merged: true } })

    const db = openDb(t, sqlitePath)
    forceStatus(db, setup.publicId, '待合并')
    await pollPendingReviews(db, [])

    const after = taskRow(db, setup.publicId)
    assert.equal(after.status, '已完成', 'an empty forgeInstances array must behave like today: poll everything')
  })
})

// -------------------------------------------------------------------------------------------
// Issue #54 (§17.7 / docs/api.md "#54: every poll additionally records the observed head…").
// Custody note: this describe block is the acceptance oracle for the poller half of #54 — every
// pollPendingReviews tick records the forge-observed head (overwriting), never rewrites a
// recorded submissions.head_sha, never changes task status on a head mismatch, and publishes SSE
// task_updated when the observation changes. An implementer may not weaken or reinterpret it.
// -------------------------------------------------------------------------------------------

// Sets up one task through create → claim → submit_pr WITH an explicit head_sha (the plain
// `createPendingReviewTask` above omits head_sha so the #53 backfill has something to fill in;
// this variant is needed here to prove the poller never rewrites an already-recorded head_sha).
async function createPendingReviewTaskWithHead(app, stub, poster, key, { title, prNumber, summary, headSha }) {
  const brief = await createTaskOk(app, poster.cookies, taskPayload({ title }))
  const claimed = await claimTaskHttp(app, { token: key.identity, publicId: brief.id })
  assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)
  const prUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/${prNumber}`
  const client = await readyMcp(app, key.identity)
  const called = await client.callTool(app, key.identity, 'submit_pr', {
    task_id: brief.id,
    pr_url: prUrl,
    summary,
    head_sha: headSha,
  })
  const submitted = assertToolOk(called.result)
  assert.equal(submitted.task.status, '待验收', `setup submit_pr: ${JSON.stringify(submitted)}`)
  return { publicId: brief.id, prUrl, prNumber: String(prNumber) }
}

function submissionRow(db, taskPk) {
  return db.$client.prepare('SELECT * FROM submissions WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskPk)
}

// A real network + node:http seam for the one test below that must observe an actual SSE frame.
// `beginFetch` above monkey-patches `globalThis.fetch` for the forge stub; reusing the global
// `fetch` to also open the SSE connection would route straight into that same stub instead of the
// real server (it answers unrecognized URLs with a fake 500), so this goes around it via
// node:http, a code path `beginFetch` never touches.
async function listeningPollerApp(t, sqlitePath) {
  const app = buildApp({ sqlitePath })
  t.after(async () => {
    await app.close()
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address != null ? address.port : 0
  assert.ok(port > 0, 'test server must be listening on an ephemeral port')
  return { app, origin: `http://127.0.0.1:${port}` }
}

function cookieHeaderFrom(cookies) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

// Opens `GET /api/v1/stream` over a real socket and returns a handle whose `readUntil` waits
// (bounded by `timeoutMs`) for `predicate(accumulatedText)` to hold, and otherwise resolves with
// `timedOut: true` — used both to wait FOR a frame and to prove one never arrives within a window.
function openSseStreamViaHttp(t, origin, cookies) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${origin}/api/v1/stream`,
      { method: 'GET', headers: { accept: 'text/event-stream', cookie: cookieHeaderFrom(cookies) } },
      (res) => {
        let buffer = ''
        let ended = false
        const waiters = []
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          buffer += chunk
          for (const waiter of waiters.splice(0)) waiter()
        })
        res.on('end', () => {
          ended = true
          for (const waiter of waiters.splice(0)) waiter()
        })
        resolve({
          statusCode: res.statusCode,
          async readUntil(predicate, timeoutMs = 2000) {
            const deadline = Date.now() + timeoutMs
            while (!predicate(buffer)) {
              if (ended) return { text: buffer, timedOut: false, closed: true }
              const remaining = deadline - Date.now()
              if (remaining <= 0) return { text: buffer, timedOut: true }
              await new Promise((r) => {
                const timer = setTimeout(r, remaining)
                waiters.push(() => {
                  clearTimeout(timer)
                  r()
                })
              })
            }
            return { text: buffer, timedOut: false }
          },
        })
      },
    )
    req.on('error', reject)
    req.end()
    t.after(() => req.destroy())
  })
}

// Splits raw SSE text into `{ event, data }` frames (data JSON-parsed), ignoring `:` comments
// (`: connected`, `: ping`) and any partial trailing chunk. Parses defensively rather than
// regex-matching the raw text so frame field order never matters.
function parseStreamFrames(text) {
  const frames = []
  for (const chunk of text.split(/\n\n/)) {
    if (chunk.trim() === '' || chunk.startsWith(':')) continue
    let eventName
    const dataParts = []
    for (const line of chunk.split(/\n/)) {
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataParts.push(line.slice('data:'.length).replace(/^ /, ''))
    }
    if (eventName == null || dataParts.length === 0) continue
    try {
      frames.push({ event: eventName, data: JSON.parse(dataParts.join('\n')) })
    } catch {
      // an in-flight, not-yet-complete chunk — ignore, the next readUntil poll will see it whole.
    }
  }
  return frames
}

function taskUpdatedCount(text, publicId) {
  return parseStreamFrames(text).filter((f) => f.event === 'task_updated' && f.data?.task_id === publicId).length
}

describe('issue #54 head_sha anchoring (poller)', { concurrency: false }, () => {
  test('every tick records the observed forge head (overwriting on change), never rewrites a recorded head_sha, and never changes task status from a head mismatch alone', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const poster = await loginGitea(app, stub, 'poll-54-observe')
    const key = await mintAgentKey(app, poster.cookies, 'poller-54')

    const setup = await createPendingReviewTaskWithHead(app, stub, poster, key, {
      title: '锚定观察用例',
      prNumber: 601,
      summary: '首次交付',
      headSha: 'sha-54a-1',
    })

    const db = openDb(t, sqlitePath)
    const pk = taskRow(db, setup.publicId).id
    const before = submissionRow(db, pk)
    assert.equal(before.head_sha, 'sha-54a-1', 'setup: the Agent-reported head is recorded')
    assert.equal(before.forge_head_sha, null, 'setup: no forge observation yet')
    assert.equal(before.forge_head_seen_at, null)

    // Tick 1: the forge already has a head the Agent never reported.
    stub.pr.set(setup.prNumber, {
      body: { number: 601, state: 'open', merged: false, head: { sha: 'sha-54a-2', ref: 'kaola/branch-601' } },
    })
    await pollPendingReviews(db)

    const afterTick1 = submissionRow(db, pk)
    assert.equal(afterTick1.head_sha, 'sha-54a-1', 'the Agent-reported head_sha must never be rewritten by the poller')
    assert.equal(afterTick1.forge_head_sha, 'sha-54a-2', 'the poller must record the observed forge head')
    assert.equal(typeof afterTick1.forge_head_seen_at, 'number')
    assert.ok(afterTick1.forge_head_seen_at > 1_700_000_000, 'forge_head_seen_at must be a unix-seconds timestamp')
    assert.equal(taskRow(db, setup.publicId).status, '待验收', 'a head mismatch alone must never change task status')

    // Tick 2: the forge head moves again — forge_head_sha must be overwritten, not stuck at the
    // first observed value (NOT the NULL-only semantics head_sha itself has).
    stub.pr.set(setup.prNumber, {
      body: { number: 601, state: 'open', merged: false, head: { sha: 'sha-54a-3', ref: 'kaola/branch-601' } },
    })
    await pollPendingReviews(db)
    const afterTick2 = submissionRow(db, pk)
    assert.equal(afterTick2.head_sha, 'sha-54a-1', 'head_sha must still be untouched on the second tick')
    assert.equal(afterTick2.forge_head_sha, 'sha-54a-3', 'forge_head_sha must be overwritten on every tick, not written once')
    assert.equal(taskRow(db, setup.publicId).status, '待验收')
  })

  test('an empty observed head_sha ("") is never recorded into forge_head_sha', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, stub } = await boot(t, sqlitePath)
    const poster = await loginGitea(app, stub, 'poll-54-empty-head')
    const key = await mintAgentKey(app, poster.cookies, 'poller-54-empty')

    const setup = await createPendingReviewTaskWithHead(app, stub, poster, key, {
      title: '空头用例',
      prNumber: 602,
      summary: '首次交付',
      headSha: 'sha-54b-1',
    })
    stub.pr.set(setup.prNumber, {
      body: { number: 602, state: 'open', merged: false, head: { sha: '', ref: 'kaola/branch-602' } },
    })

    const db = openDb(t, sqlitePath)
    const pk = taskRow(db, setup.publicId).id
    await pollPendingReviews(db)

    assert.equal(submissionRow(db, pk).forge_head_sha, null, 'an empty observed head_sha must not overwrite forge_head_sha')
    assert.equal(submissionRow(db, pk).head_sha, 'sha-54b-1')
  })

  test('the poller publishes SSE task_updated only on ticks where the observed forge head differs from the previous observation', async (t) => {
    const sqlitePath = sqliteFile(t)
    const { app, origin } = await listeningPollerApp(t, sqlitePath)
    const stub = beginFetch(t)
    allowForgeToken(stub, INLINE_TOKEN)
    const poster = await loginGitea(app, stub, 'poll-54-sse')
    const key = await mintAgentKey(app, poster.cookies, 'poller-54-sse')

    const setup = await createPendingReviewTask(app, stub, poster, key, {
      title: 'SSE 观察用例',
      prNumber: 611,
      summary: '首次交付',
    })

    const stream = await openSseStreamViaHttp(t, origin, poster.cookies)
    assert.equal(stream.statusCode, 200, 'SSE handshake must succeed')
    const connected = await stream.readUntil((text) => text.includes(': connected'), 2000)
    assert.equal(connected.timedOut, false, 'expected the : connected comment before any tick')

    const db = openDb(t, sqlitePath)

    // Tick 1: first observation ever (previously stored forge_head_sha is NULL) — a change.
    stub.pr.set(setup.prNumber, {
      body: { number: 611, state: 'open', merged: false, head: { sha: 'sha-611-1', ref: 'kaola/branch-611' } },
    })
    await pollPendingReviews(db)
    const afterTick1 = await stream.readUntil((text) => taskUpdatedCount(text, setup.publicId) >= 1, 2000)
    assert.equal(afterTick1.timedOut, false, `expected a task_updated frame after the first observation: ${afterTick1.text}`)
    assert.ok(
      parseStreamFrames(afterTick1.text).some(
        (f) => f.event === 'task_updated' && f.data?.task_id === setup.publicId && f.data?.status === '待验收',
      ),
      'task_updated must carry the (unchanged) task status, per §17.5',
    )

    // Tick 2: same head as tick 1 — must NOT publish a second frame for this task.
    await pollPendingReviews(db)
    const afterTick2 = await stream.readUntil((text) => taskUpdatedCount(text, setup.publicId) >= 2, 700)
    assert.equal(afterTick2.timedOut, true, `an unchanged observed head must not publish another task_updated: ${afterTick2.text}`)

    // Tick 3: the head changes again — must publish a second frame.
    stub.pr.set(setup.prNumber, {
      body: { number: 611, state: 'open', merged: false, head: { sha: 'sha-611-2', ref: 'kaola/branch-611' } },
    })
    await pollPendingReviews(db)
    const afterTick3 = await stream.readUntil((text) => taskUpdatedCount(text, setup.publicId) >= 2, 2000)
    assert.equal(afterTick3.timedOut, false, `expected a second task_updated frame once the head changed again: ${afterTick3.text}`)
  })
})
