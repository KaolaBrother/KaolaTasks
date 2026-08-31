import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { createDb } from './db.ts'
import { injectSigned, pairDeviceToSelf, pairDeviceToClaimant } from './device-proof.test-helpers.ts'
import { ensureSetup } from './auth.test-helpers.ts'
import { claimTask as claimTaskDirect } from './claim.ts'
import { devices as devicesTable, tasks as tasksTable, users as usersTable } from './schema.ts'

// Issue #36 idempotent claim identity (`request_id` / `claim_id`), claim-transaction atomicity,
// credential-profile deletion retention, and off-response-path write-back. Seams copied from
// claim.test.ts / mcp.test.ts / writeback.test.ts / claim-confirm.test.ts (do not import any of
// those files). This suite is RED against HEAD `df98907`: `leases.request_id` does not exist,
// `claimIdForLease` is not exported from `./leases.ts`, `settleWritebacks` is not exported from
// `./writeback.ts`, the REST/MCP claim body ignores `request_id` entirely, claim writes are not
// transactional, `attemptWriteback` is awaited on the claim response path, and
// DELETE /api/v1/credential-profiles/:id deletes unconditionally regardless of task references.
//
// Ambiguity notes (the brief does not pin these; documented here rather than frozen as literal
// assertions): (1) the exact `error` code/string for a "typed conflict" on request_id reuse with
// a mismatched digest is not specified — tests assert HTTP 409 with a string `error` field and
// the state-unchanged invariant, not a literal code. (2) the exact marker field name for a replay
// token-reveal event ("details mark it a replay") is not specified — this suite assumes a
// `replay: true` field as the most natural fit with the existing `{task_id, device_id, credential,
// ...}` detail shape; if the real implementation names it differently, only that one assertion
// needs adjustment, not the surrounding invariants. (3) the response shape for a replay against a
// now-terminal lease is not specified — the test asserts only the invariant the brief states in
// prose ("NEVER creates a new lease"), not a literal body.
//
// Credential retention: apps/server/src/credential-profiles.ts today has no PUT/PATCH route, and
// apps/server/src/tasks.ts's only PATCH (`readStatusBody`) accepts status only — there is no
// task-side surface that can re-point a non-terminal task's credential_profile_id today, so no
// "replace" surface is covered here (see the `credential-profiles.ts` read above).

const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const REPO_FULL_NAME = 'team/orders'
const VAULT_MASTER_KEY_HEX = 'cd'.repeat(32)
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'

const INLINE_TOKEN = 'gitea-INLINE-ONE-OFF-TOKEN-zzq7'
const PROFILE_TOKEN = 'gitea-PROFILE-SHARED-TOKEN-vv31'

const TOKEN_REVEAL_EVENT = 'token 揭示'
const STATUS_TRANSITION_EVENT = '状态迁移'
const MCP_PATH = '/api/mcp'
const MCP_PROTOCOL_VERSION = '2025-11-25'

const SECRET_KEY_NAMES = new Set(['token', 'token_encrypted', 'inline_token_encrypted', 'access_token'])
const NON_TERMINAL_STATUSES = ['待认领', '进行中', '待验收', '已退回']
const TERMINAL_STATUSES = ['已完成', '已取消']
// credential_profiles has UNIQUE (forge, base_url, repo_full_name) — since the four-non-terminal
// test never succeeds in deleting a profile (that's the point), each iteration needs its own
// identity or the second postProfile call collides with the still-referenced first one.
const NON_TERMINAL_STATUS_SLUG = {
  待认领: 'daiqingling',
  进行中: 'jinxingzhong',
  待验收: 'daiyanshou',
  已退回: 'yituihui',
}

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

function isCommentEndpoint(url) {
  return /\/issues\/\d+\/comments$/u.test(url) || /\/issues\/\d+\/notes$/u.test(url)
}

function isRepoEndpoint(url) {
  return (url.includes('/repos/') || url.includes('/projects/')) && !isCommentEndpoint(url)
}

function isUserEndpoint(url) {
  return url.endsWith('/user') && !isCommentEndpoint(url)
}

// Merges claim.test.ts's OAuth/repo/user forge stub with writeback.test.ts's comment-endpoint
// stub, plus a controllable slow-comment mode used only by the write-back-off-response tests.
function beginFetch(t) {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const oauth = new Map()
  const forge = new Map()
  const commentRequests = []
  let nextCommentResponse = null
  let delayNextCommentMs = 0

  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    const method = requestMethod(input, init)

    if (method === 'POST' && isCommentEndpoint(url)) {
      commentRequests.push({ url })
      const delay = delayNextCommentMs
      delayNextCommentMs = 0
      const override = nextCommentResponse
      nextCommentResponse = null
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      if (override?.unreachable) throw new TypeError('fetch failed')
      return jsonResponse(override?.status ?? 201, { id: commentRequests.length })
    }

    const token = stubbedToken(input, init)
    const forgeStub = token == null ? undefined : forge.get(token)
    if (forgeStub != null) {
      if (forgeStub.unreachable) {
        throw new TypeError('fetch failed')
      }
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
    commentRequests,
    setNextCommentResponse(response) {
      nextCommentResponse = response
    },
    delayNextComment(ms) {
      delayNextCommentMs = ms
    },
  }
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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-claim-identity-'))
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

// Installs a real SQLite trigger (via a second raw connection to the same file) that RAISEs on a
// specific write, so a claim-transaction write boundary genuinely fails instead of being stubbed.
// Triggers live in sqlite_master, so they fire regardless of which connection performs the write.
function installFailingTrigger(t, sqlitePath, name, sql) {
  const raw = new Database(sqlitePath)
  raw.exec(`CREATE TRIGGER ${name} ${sql}`)
  t.after(() => {
    raw.close()
  })
}

async function loginGitea(app) {
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
    constraints: { allowed_paths: ['src/api/**'], forbidden_paths: ['migrations/**'] },
    priority: 'P1',
    tags: ['backend'],
    credential: { token: INLINE_TOKEN },
    ...overrides,
  }
}

function importedTaskPayload(overrides = {}) {
  const issueNumber = overrides.issueNumber ?? 701
  return taskPayload({
    title: `导入任务 ${issueNumber}`,
    source: { type: 'imported', issue_url: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/issues/${issueNumber}` },
    ...overrides,
  })
}

function giteaCommentUrl(issueNumber) {
  return `${FORGE_BASE_URL}/api/v1/repos/${REPO_FULL_NAME}/issues/${issueNumber}/comments`
}

async function postTask(app, cookies, payload) {
  return app.inject({ method: 'POST', url: '/api/v1/tasks', cookies, headers: jsonHeaders, payload })
}

async function createTaskOk(app, cookies, payload = taskPayload()) {
  const res = await postTask(app, cookies, payload)
  assert.equal(res.statusCode, 201, `POST /api/v1/tasks: ${res.statusCode} ${res.body}`)
  return { res, brief: jsonBody(res) }
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

async function mintAgentKey(app, cookies, label = 'agent') {
  const paired = await pairDeviceToSelf(app, cookies, { hostname: label })
  return { id: paired.deviceId, identity: paired.identity, deviceId: paired.deviceId }
}

async function pairRivalDevice(app, cookies, label = 'rival') {
  const paired = await pairDeviceToClaimant(app, cookies, label, { hostname: label })
  return { id: paired.deviceId, identity: paired.identity, deviceId: paired.deviceId }
}

async function claimTask(app, { identity, publicId, payload }) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/claim`,
    payload: payload ?? {},
    extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
  })
}

async function releaseTask(app, { identity, publicId }) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/release`,
    payload: {},
    extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
  })
}

async function progressTask(app, { identity, publicId, payload }) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/progress`,
    payload: payload ?? {},
    extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
  })
}

// Loads the real (device, owner) principal for an already-paired agent key, straight off the
// db, so the CAS test can call the production `claimTask` export directly (bypassing HTTP) with
// a db handle the test owns and can monkey-patch.
function loadUserAuth(db, deviceFingerprint) {
  const device = db.select().from(devicesTable).where(eq(devicesTable.fingerprint, deviceFingerprint)).get()
  assert.ok(device, `device with fingerprint ${deviceFingerprint} must exist`)
  assert.ok(device.userId != null, 'expected a user-bound device for the CAS test')
  const user = db.select().from(usersTable).where(eq(usersTable.id, device.userId)).get()
  assert.ok(user, `user ${device.userId} must exist`)
  return { device, owner: { kind: 'user', user } }
}

async function getClaimConfirmations(app, cookies) {
  return app.inject({ method: 'GET', url: '/api/v1/claim-confirmations', cookies, headers: jsonHeaders })
}

async function approveConfirmation(app, cookies, id) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/claim-confirmations/${id}/approve`,
    cookies,
    headers: jsonHeaders,
  })
}

async function deleteProfile(app, cookies, id) {
  return app.inject({ method: 'DELETE', url: `/api/v1/credential-profiles/${id}`, cookies, headers: jsonHeaders })
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
    assert.equal(dumped.includes(plaintext), false, `response leaked plaintext token ${plaintext}: ${dumped}`)
  }
  const parsed = parsedBody(res)
  for (const key of collectKeys(parsed)) {
    assert.equal(SECRET_KEY_NAMES.has(key), false, `response carried a secret-bearing key "${key}": ${dumped}`)
  }
}

// The REST claim 201 (and the MCP claim_task success body) are the two channels AGENTS.md
// allows to reveal the forge token — the token belongs at the top level (`body.token`), never
// nested inside `task` / `lease` / `clone`. Do not apply this to the whole response body; that
// would wrongly demand the top-level token be absent too.
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
  return eventsOfType(db, TOKEN_REVEAL_EVENT).filter((event) => parseDetails(event)?.task_id === publicId)
}

function statusTransitionEvents(db, publicId) {
  return eventsOfType(db, STATUS_TRANSITION_EVENT).filter((event) => parseDetails(event)?.task_id === publicId)
}

function taskRow(db, publicId) {
  return db.$client
    .prepare('SELECT id, public_id, status FROM tasks WHERE public_id = ?')
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

function profileExists(db, id) {
  return db.$client.prepare('SELECT id FROM credential_profiles WHERE id = ?').get(id) != null
}

function successfulWritebackEventsFor(db, publicId, transition) {
  return eventsOfType(db, '回写')
    .filter((event) => parseDetails(event)?.task_id === publicId)
    .filter((event) => parseDetails(event)?.transition === transition)
    .filter((event) => parseDetails(event)?.ok === true)
}

// A failed write inside the claim transaction must leave exactly the pre-claim state behind:
// task still 待认领, no active lease, no token reveal, no 状态迁移 to 进行中. The response itself
// must not report success either.
function assertClaimAllOrNothing(db, publicId, res) {
  assert.notEqual(
    res.statusCode,
    201,
    `an injected mid-transaction write failure must not report a successful claim: ${res.statusCode} ${res.body}`,
  )
  const task = taskRow(db, publicId)
  assert.ok(task, `task ${publicId} must still exist after a failed claim attempt`)
  assert.equal(
    task.status,
    '待认领',
    `a failed claim-transaction write must leave the task exactly as it was (待认领), never partially committed to 进行中, got ${task.status}`,
  )
  assert.equal(activeLeaseRows(db, task.id).length, 0, 'a failed claim-transaction write must leave no active lease behind')
  assert.equal(claimRevealEvents(db, publicId).length, 0, 'a failed claim-transaction write must leave no token 揭示 event behind')
  assert.equal(
    statusTransitionEvents(db, publicId).filter((event) => parseDetails(event)?.to === '进行中').length,
    0,
    'a failed claim-transaction write must leave no 状态迁移 to 进行中 behind',
  )
}

async function postMcp(app, { identity, sessionId, payload }) {
  const extra = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
  if (sessionId != null) extra['mcp-session-id'] = sessionId
  return injectSigned(app, identity, { method: 'POST', url: MCP_PATH, payload, extraHeaders: extra })
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
    async initialize(app, identity) {
      const id = nextId
      nextId += 1
      const res = await postMcp(app, {
        identity,
        sessionId,
        payload: {
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'kaola-claim-identity-test', version: '0.0.0' },
          },
        },
      })
      assert.equal(res.statusCode, 200, `MCP initialize HTTP: ${res.statusCode} ${res.body}`)
      const rpc = jsonRpcById(parseJsonRpcHttp(res), id)
      assert.equal(rpc.error, undefined, `MCP initialize JSON-RPC error: ${JSON.stringify(rpc.error)}`)
      const header = res.headers['mcp-session-id']
      if (header != null && header !== '') sessionId = String(header)
      if (sessionId != null) {
        await postMcp(app, { identity, sessionId, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } })
      }
    },
    async callTool(app, identity, name, args = {}) {
      const id = nextId
      nextId += 1
      const res = await postMcp(app, {
        identity,
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

async function readyMcp(app, identity) {
  const client = createMcpClient()
  await client.initialize(app, identity)
  return client
}

async function boot(t, sqlitePath) {
  const app = await createApp(t, sqlitePath)
  const stub = beginFetch(t)
  allowForgeToken(stub, INLINE_TOKEN)
  allowForgeToken(stub, PROFILE_TOKEN)
  return { app, stub }
}

describe('issue #36 claim identity (request_id / claim_id)', { concurrency: false }, () => {
  describe('claimIdForLease (apps/server/src/leases.ts) — direct unit contract', () => {
    test('claimIdForLease is exported and returns a clm_-prefixed opaque string', async () => {
      const leasesModule = await import('./leases.ts')
      assert.equal(
        typeof leasesModule.claimIdForLease,
        'function',
        'apps/server/src/leases.ts must export claimIdForLease(lease)',
      )
      const lease = {
        id: 1,
        taskId: 10,
        deviceId: 20,
        claimedAt: 1000,
        requestId: null,
        claimerUserId: 5,
        claimerClaimantId: null,
        state: 'active',
        lastHeartbeat: 1000,
        expiresAt: 1000 + 86400,
      }
      const claimId = leasesModule.claimIdForLease(lease)
      assert.equal(typeof claimId, 'string')
      assert.match(claimId, /^clm_/, `claim_id must be prefixed clm_, got ${claimId}`)
    })

    test('claimIdForLease is stable across a heartbeat and across release (only immutable fields matter)', async () => {
      const { claimIdForLease } = await import('./leases.ts')
      const base = {
        id: 1,
        taskId: 10,
        deviceId: 20,
        claimedAt: 1000,
        requestId: 'r1',
        claimerUserId: 5,
        claimerClaimantId: null,
      }
      const active = { ...base, state: 'active', lastHeartbeat: 1000, expiresAt: 1000 + 86400 }
      const afterHeartbeat = { ...base, state: 'active', lastHeartbeat: 5000, expiresAt: 5000 + 86400 }
      const afterRelease = { ...base, state: 'released', lastHeartbeat: 5000, expiresAt: 5000 + 86400 }
      const afterExpiry = { ...base, state: 'expired', lastHeartbeat: 5000, expiresAt: 5000 + 86400 }
      assert.equal(claimIdForLease(active), claimIdForLease(afterHeartbeat), 'claim_id must not change across a heartbeat')
      assert.equal(claimIdForLease(active), claimIdForLease(afterRelease), 'claim_id must not change once the lease is released')
      assert.equal(claimIdForLease(active), claimIdForLease(afterExpiry), 'claim_id must not change once the lease is expired')
    })

    test('claimIdForLease differs between two different lease rows', async () => {
      const { claimIdForLease } = await import('./leases.ts')
      const leaseA = {
        id: 1,
        taskId: 10,
        deviceId: 20,
        claimedAt: 1000,
        requestId: null,
        claimerUserId: 5,
        claimerClaimantId: null,
        state: 'active',
        lastHeartbeat: 1000,
        expiresAt: 1000 + 86400,
      }
      const leaseOnDifferentTask = { ...leaseA, id: 2, taskId: 11 }
      const leaseByDifferentDevice = { ...leaseA, id: 3, deviceId: 21 }
      assert.notEqual(claimIdForLease(leaseA), claimIdForLease(leaseOnDifferentTask))
      assert.notEqual(claimIdForLease(leaseA), claimIdForLease(leaseByDifferentDevice))
    })
  })

  describe('legacy compatibility — no request_id sent', () => {
    test('REST claim without request_id stays 201 and the lease envelope is exactly { claim_id, expires_at, ttl_seconds }', async (t) => {
      const { app } = await boot(t)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'legacy-rest')

      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(res.statusCode, 201, `claim: ${res.statusCode} ${res.body}`)
      const body = jsonBody(res)
      assert.deepEqual(
        Object.keys(body.lease).sort(),
        ['claim_id', 'expires_at', 'ttl_seconds'],
        `lease envelope must gain claim_id alongside the existing fields, got ${JSON.stringify(Object.keys(body.lease))}`,
      )
      assert.equal(typeof body.lease.claim_id, 'string')
      assert.match(body.lease.claim_id, /^clm_/)
      assertClaimRevealToken(body, INLINE_TOKEN)
    })

    test('MCP claim_task without request_id stays a success result and the lease envelope carries claim_id', async (t) => {
      const { app } = await boot(t)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'legacy-mcp')
      const client = await readyMcp(app, key.identity)

      const called = await client.callTool(app, key.identity, 'claim_task', { task_id: brief.id })
      const envelope = assertToolOk(called.result)
      assert.deepEqual(
        Object.keys(envelope.lease).sort(),
        ['claim_id', 'expires_at', 'ttl_seconds'],
        `MCP lease envelope must gain claim_id, got ${JSON.stringify(Object.keys(envelope.lease))}`,
      )
      assert.equal(typeof envelope.lease.claim_id, 'string')
      assert.match(envelope.lease.claim_id, /^clm_/)
    })
  })

  describe('replay identity — same (device, request_id)', () => {
    test('replaying the same request_id 100 times yields exactly one lease, one 状态迁移 to 进行中, and one claim_id', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'replay-100')
      const requestId = 'replay-100-request'

      const first = await claimTask(app, { identity: key.identity, publicId: brief.id, payload: { request_id: requestId } })
      assert.equal(first.statusCode, 201, `first claim: ${first.statusCode} ${first.body}`)
      const firstBody = jsonBody(first)
      const claimId = firstBody.lease.claim_id
      assert.equal(typeof claimId, 'string')

      for (let i = 0; i < 99; i += 1) {
        const replay = await claimTask(app, {
          identity: key.identity,
          publicId: brief.id,
          payload: { request_id: requestId },
        })
        assert.equal(replay.statusCode, 201, `replay #${i} must still be 201, got ${replay.statusCode} ${replay.body}`)
        const replayBody = jsonBody(replay)
        assert.equal(replayBody.lease.claim_id, claimId, `replay #${i} must return the same claim_id`)
        assert.equal(replayBody.token, firstBody.token, `replay #${i} must return the same credential`)
      }

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(leaseRows(db, task.id).length, 1, 'replaying must never insert a second lease row of any kind')
      assert.equal(activeLeaseRows(db, task.id).length, 1)
      const started = statusTransitionEvents(db, brief.id).filter((event) => parseDetails(event)?.to === '进行中')
      assert.equal(started.length, 1, 'replaying must never write a second 状态迁移 to 进行中')
    })

    test('a single replay reuses the same claim_id and token, and audits the re-reveal as a replay without leaking the token', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'replay-audit')
      const requestId = 'replay-audit-request'

      const first = await claimTask(app, { identity: key.identity, publicId: brief.id, payload: { request_id: requestId } })
      assert.equal(first.statusCode, 201, `first claim: ${first.statusCode} ${first.body}`)
      const firstBody = jsonBody(first)

      const replay = await claimTask(app, { identity: key.identity, publicId: brief.id, payload: { request_id: requestId } })
      assert.equal(replay.statusCode, 201, `replay must still be 201, got ${replay.statusCode} ${replay.body}`)
      const replayBody = jsonBody(replay)
      assert.equal(replayBody.lease.claim_id, firstBody.lease.claim_id)
      assert.equal(replayBody.token, firstBody.token)
      assertClaimRevealToken(replayBody, INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      const reveals = claimRevealEvents(db, brief.id)
      assert.equal(reveals.length, 2, `a replay must still be audited as a token re-reveal, got ${JSON.stringify(reveals.map(parseDetails))}`)
      const replayDetails = parseDetails(reveals[1])
      assert.equal(replayDetails.replay, true, 'the replay reveal event must mark itself as a replay (details.replay === true)')
      const dumped = JSON.stringify(reveals)
      assert.equal(dumped.includes(INLINE_TOKEN), false, `reveal events must never contain the plaintext forge token: ${dumped}`)
    })

    test('replaying a request_id after the lease is released never creates a new lease', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'replay-terminal')
      const requestId = 'replay-terminal-request'

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id, payload: { request_id: requestId } })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      const released = await releaseTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(released.statusCode, 200, `release: ${released.statusCode} ${released.body}`)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      const leaseCountBeforeReplay = leaseRows(db, task.id).length
      assert.equal(leaseCountBeforeReplay, 1)

      await claimTask(app, { identity: key.identity, publicId: brief.id, payload: { request_id: requestId } })

      const leasesAfter = leaseRows(db, task.id)
      assert.equal(
        leasesAfter.length,
        leaseCountBeforeReplay,
        `replaying a request_id whose lease is now terminal must never insert a new lease row, got ${JSON.stringify(leasesAfter)}`,
      )
      assert.equal(activeLeaseRows(db, task.id).length, 0, 'a terminal replay must never create a new active lease')
    })

    test('a different device presenting the holder\'s request_id cannot replay and never sees the active token', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const holder = await mintAgentKey(app, poster.cookies, 'device-holder')
      const rival = await pairRivalDevice(app, poster.cookies, 'device-rival')
      const requestId = 'shared-request-id-across-devices'

      const first = await claimTask(app, { identity: holder.identity, publicId: brief.id, payload: { request_id: requestId } })
      assert.equal(first.statusCode, 201, `holder claim: ${first.statusCode} ${first.body}`)
      const holderToken = jsonBody(first).token

      const intruder = await claimTask(app, { identity: rival.identity, publicId: brief.id, payload: { request_id: requestId } })
      assert.notEqual(intruder.statusCode, 201, `a different device must never be treated as a replay of the holder's claim, got ${intruder.statusCode} ${intruder.body}`)
      assertNoForgeSecretMaterial(intruder, holderToken)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(activeLeaseRows(db, task.id).length, 1)
      assert.equal(Number(activeLeaseRows(db, task.id)[0].device_id), Number(holder.id), 'the active lease must still be held by the original device')
    })
  })

  describe('replay identity — typed conflicts on a mismatched digest', () => {
    test('same request_id against a different task publicId is a typed conflict and changes nothing', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief: taskA } = await createTaskOk(app, poster.cookies, taskPayload({ title: 'task A for request_id conflict' }))
      const { brief: taskB } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ title: 'task B for request_id conflict', credential: { token: PROFILE_TOKEN } }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'cross-task-conflict')
      const requestId = 'cross-task-request-id'

      const first = await claimTask(app, { identity: key.identity, publicId: taskA.id, payload: { request_id: requestId } })
      assert.equal(first.statusCode, 201, `claim task A: ${first.statusCode} ${first.body}`)

      const conflict = await claimTask(app, { identity: key.identity, publicId: taskB.id, payload: { request_id: requestId } })
      assert.equal(
        conflict.statusCode,
        409,
        `same request_id against a different task publicId must be a typed conflict, got ${conflict.statusCode} ${conflict.body}`,
      )
      const body = jsonBody(conflict)
      assert.equal(typeof body?.error, 'string', `refusal must carry a typed error, got ${conflict.body}`)
      assertNoForgeSecretMaterial(conflict, INLINE_TOKEN, PROFILE_TOKEN)

      const db = openDb(t, sqlitePath)
      const rowB = taskRow(db, taskB.id)
      assert.equal(rowB.status, '待认领', 'task B must be untouched by a mismatched-digest replay against it')
      assert.equal(activeLeaseRows(db, rowB.id).length, 0)
      const rowA = taskRow(db, taskA.id)
      assert.equal(rowA.status, '进行中', 'task A must keep its original claim')
      assert.equal(activeLeaseRows(db, rowA.id).length, 1)
    })

    test('same request_id but a different autonomous flag is a typed conflict and reveals no token', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'autonomous-mismatch')
      const requestId = 'autonomous-flag-mismatch-request'

      const first = await claimTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { autonomous: true, request_id: requestId },
      })
      assert.equal(first.statusCode, 202, `first autonomous attempt: ${first.statusCode} ${first.body}`)

      const second = await claimTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { autonomous: false, request_id: requestId },
      })
      assert.equal(
        second.statusCode,
        409,
        `same request_id with a different autonomous flag must be a typed conflict, got ${second.statusCode} ${second.body}`,
      )
      const body = jsonBody(second)
      assert.equal(typeof body?.error, 'string', `refusal must carry a typed error, got ${second.body}`)
      assertNoForgeSecretMaterial(second, INLINE_TOKEN)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(task.status, '待认领', 'nothing must change after a mismatched-digest replay')
      assert.equal(activeLeaseRows(db, task.id).length, 0)
      assert.equal(claimRevealEvents(db, brief.id).length, 0, 'a mismatched-digest replay must never reveal the forge token')
    })
  })

  describe('autonomous 202 stability, then a single 201 after approval', () => {
    test('202 is stable while pending under the same request_id, and exactly one 201/lease follows approval even under repeated replay', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const owner = await loginGitea(app)
      const { brief } = await createTaskOk(app, owner.cookies)
      const key = await mintAgentKey(app, owner.cookies, 'autonomous-202-stable')
      const requestId = 'autonomous-pending-request'

      const pending1 = await claimTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { autonomous: true, request_id: requestId },
      })
      assert.equal(pending1.statusCode, 202, `first pending: ${pending1.statusCode} ${pending1.body}`)
      const pending2 = await claimTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { autonomous: true, request_id: requestId },
      })
      assert.equal(pending2.statusCode, 202, `replay while pending must stay 202, got ${pending2.statusCode} ${pending2.body}`)
      assert.deepEqual(jsonBody(pending1), jsonBody(pending2))

      const listed = await getClaimConfirmations(app, owner.cookies)
      assert.equal(listed.statusCode, 200, `GET confirmations: ${listed.statusCode} ${listed.body}`)
      const confirmations = jsonBody(listed).confirmations.filter((c) => c.task_id === brief.id)
      assert.equal(confirmations.length, 1, `pending window must reuse one confirmation row, got ${JSON.stringify(confirmations)}`)
      const approve = await approveConfirmation(app, owner.cookies, confirmations[0].id)
      assert.equal(approve.statusCode, 200, `approve: ${approve.statusCode} ${approve.body}`)

      const claimed = await claimTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { autonomous: true, request_id: requestId },
      })
      assert.equal(claimed.statusCode, 201, `post-approval claim: ${claimed.statusCode} ${claimed.body}`)
      const claimId = jsonBody(claimed).lease.claim_id

      for (let i = 0; i < 5; i += 1) {
        const replay = await claimTask(app, {
          identity: key.identity,
          publicId: brief.id,
          payload: { autonomous: true, request_id: requestId },
        })
        assert.equal(replay.statusCode, 201, `replay #${i} after approval must stay 201, got ${replay.statusCode} ${replay.body}`)
        assert.equal(jsonBody(replay).lease.claim_id, claimId, `replay #${i} must reuse the same claim_id`)
      }

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(leaseRows(db, task.id).length, 1, 'exactly one lease must exist across the whole pending+approve+replay sequence')
      assert.equal(activeLeaseRows(db, task.id).length, 1)
    })
  })

  describe('credential-profile deletion is refused while referenced by a non-terminal task', () => {
    test('DELETE is refused (typed error, profile retained) when referenced by a task in each of the four non-terminal statuses', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const db = openDb(t, sqlitePath)

      for (const status of NON_TERMINAL_STATUSES) {
        // Each iteration needs its own profile identity (UNIQUE (forge, base_url,
        // repo_full_name)) since delete is expected to be refused every time, so the profile
        // from the previous iteration is still there. Publish also requires the task's
        // repo.full_name to match the profile's repo_full_name (PROFILE_REPO_MISMATCH_MESSAGE),
        // so both are varied together.
        const repoFullName = `${REPO_FULL_NAME}-${NON_TERMINAL_STATUS_SLUG[status]}`
        const profile = await postProfile(app, poster.cookies, { repo_full_name: repoFullName })
        const { brief } = await createTaskOk(
          app,
          poster.cookies,
          taskPayload({
            title: `retention-${status}`,
            repo: {
              forge: 'gitea',
              base_url: FORGE_BASE_URL,
              full_name: repoFullName,
              base_branch: 'main',
              suggested_dir: 'orders',
            },
            credential: { profile_id: profile.id },
          }),
        )
        forceStatus(db, brief.id, status)

        const res = await deleteProfile(app, poster.cookies, profile.id)
        assert.notEqual(
          res.statusCode,
          200,
          `deleting a profile referenced by a ${status} task must be refused, got ${res.statusCode} ${res.body}`,
        )
        const body = jsonBody(res)
        assert.equal(typeof body?.error, 'string', `refusal for status ${status} must carry a typed error, got ${res.body}`)
        assert.ok(profileExists(db, profile.id), `profile must not be deleted while referenced by a ${status} task`)
      }
    })

    test('DELETE succeeds as today when referenced only by a terminal-status task, or by no task at all', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const db = openDb(t, sqlitePath)

      for (const status of TERMINAL_STATUSES) {
        const profile = await postProfile(app, poster.cookies)
        const { brief } = await createTaskOk(
          app,
          poster.cookies,
          taskPayload({ title: `terminal-retention-${status}`, credential: { profile_id: profile.id } }),
        )
        forceStatus(db, brief.id, status)

        const res = await deleteProfile(app, poster.cookies, profile.id)
        assert.equal(res.statusCode, 200, `deleting a profile referenced only by a ${status} task must still succeed, got ${res.statusCode} ${res.body}`)
        assert.equal(jsonBody(res).ok, true)
        assert.equal(profileExists(db, profile.id), false)
      }

      const unreferenced = await postProfile(app, poster.cookies)
      const res = await deleteProfile(app, poster.cookies, unreferenced.id)
      assert.equal(res.statusCode, 200, `deleting an unreferenced profile must still succeed, got ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res).ok, true)
      assert.equal(profileExists(db, unreferenced.id), false)
    })
  })

  describe('claim-transaction atomicity — no reachable 进行中 task without an active lease', () => {
    test('failure injection: a failing lease insert leaves the claim exactly as it was before the attempt', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'fail-lease-insert')

      installFailingTrigger(
        t,
        sqlitePath,
        'kaola_test_fail_lease_insert',
        `BEFORE INSERT ON leases
         WHEN NEW.task_id = (SELECT id FROM tasks WHERE public_id = '${brief.id}')
         BEGIN SELECT RAISE(ABORT, 'kaola-test: injected lease insert failure'); END`,
      )

      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      const db = openDb(t, sqlitePath)
      assertClaimAllOrNothing(db, brief.id, res)
    })

    test('failure injection: a failing token 揭示 audit write leaves the claim exactly as it was before the attempt', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'fail-reveal-event')

      installFailingTrigger(
        t,
        sqlitePath,
        'kaola_test_fail_reveal_event',
        `BEFORE INSERT ON events
         WHEN NEW.type = '${TOKEN_REVEAL_EVENT}' AND NEW.details LIKE '%"task_id":"${brief.id}"%'
         BEGIN SELECT RAISE(ABORT, 'kaola-test: injected reveal-event insert failure'); END`,
      )

      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      const db = openDb(t, sqlitePath)
      assertClaimAllOrNothing(db, brief.id, res)
    })

    test('failure injection: a failing 状态迁移 audit write rolls back the task update and the lease insert that preceded it', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'fail-transition-event')

      installFailingTrigger(
        t,
        sqlitePath,
        'kaola_test_fail_transition_event',
        `BEFORE INSERT ON events
         WHEN NEW.type = '${STATUS_TRANSITION_EVENT}'
           AND NEW.details LIKE '%"task_id":"${brief.id}"%'
           AND NEW.details LIKE '%"to":"进行中"%'
         BEGIN SELECT RAISE(ABORT, 'kaola-test: injected transition-event insert failure'); END`,
      )

      const res = await claimTask(app, { identity: key.identity, publicId: brief.id })
      const db = openDb(t, sqlitePath)
      assertClaimAllOrNothing(db, brief.id, res)
    })
  })

  describe('write-back off the response path', () => {
    test('a slow forge write-back comment cannot delay the committed claim response', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies, importedTaskPayload({ issueNumber: 801 }))
      const key = await mintAgentKey(app, poster.cookies, 'slow-writeback')

      stub.delayNextComment(4000)
      const start = Date.now()
      const claimPromise = claimTask(app, { identity: key.identity, publicId: brief.id })
      const timeoutGuard = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('claim did not resolve within 1500ms; a slow forge write-back comment must not block/delay the claim response')),
          1500,
        )
      })
      const res = await Promise.race([claimPromise, timeoutGuard])
      const elapsedMs = Date.now() - start
      assert.equal(res.statusCode, 201, `claim must still succeed immediately: ${res.statusCode} ${res.body}`)
      assert.ok(elapsedMs < 1500, `claim took ${elapsedMs}ms; it must not wait on the forge write-back comment`)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(activeLeaseRows(db, task.id).length, 1)
    }, { timeout: 10_000 })

    test('settleWritebacks lets a test observe a failed background write-back deterministically, and retryPendingWritebacks still recovers it', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies, importedTaskPayload({ issueNumber: 802 }))
      const key = await mintAgentKey(app, poster.cookies, 'settle-writebacks')

      stub.setNextCommentResponse({ unreachable: true })
      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      const writeback = await import('./writeback.ts')
      assert.equal(
        typeof writeback.settleWritebacks,
        'function',
        'apps/server/src/writeback.ts must export settleWritebacks(): Promise<void>',
      )
      await writeback.settleWritebacks()

      assert.equal(
        stub.commentRequests.filter((r) => r.url === giteaCommentUrl(802)).length,
        1,
        `the background write-back must have attempted exactly once by the time settleWritebacks resolves, got ${JSON.stringify(stub.commentRequests)}`,
      )
      const db = openDb(t, sqlitePath)
      assert.equal(
        successfulWritebackEventsFor(db, brief.id, '认领').length,
        0,
        'a failed background write-back must not be recorded as successful',
      )

      const poller = await import('./poller.ts')
      assert.equal(typeof poller.retryPendingWritebacks, 'function')
      await poller.retryPendingWritebacks(db)
      assert.equal(
        successfulWritebackEventsFor(db, brief.id, '认领').length,
        1,
        'retryPendingWritebacks must still own recovery of a write-back that failed on the response path',
      )
    })
  })

  describe('claim-transaction atomicity — the Task update predicate itself (CAS)', () => {
    // The realistic seam: drive the production `claimTask` export directly (not via HTTP) against
    // a db handle the test owns, and monkey-patch that handle's `update` so the very first
    // `db.update(tasks)` call — the production write claim.ts performs after its stale
    // `selectTask` read — first lands a concurrent `UPDATE tasks SET status='进行中'` out from
    // under it, then proceeds. This exercises the real race window between claim.ts's read and
    // its write. If the guard lives only in the earlier read-and-branch (today's code: `db.update
    // (tasks).set({status}).where(eq(tasks.id, row.task.id))`, no status predicate), the write
    // still matches by id alone and a second lease/reveal/transition is produced despite the row
    // no longer being 待认领 at write time. If the guard is a real CAS (predicate additionally
    // requires status = '待认领'), the write must affect zero rows and none of that must happen.
    test('a task that flips out of 待认领 between the read and the write produces no lease, no token 揭示, and no second 状态迁移', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'cas-race')

      const raceDb = createDb(sqlitePath)
      t.after(() => {
        raceDb.$client.close()
      })

      const auth = loadUserAuth(raceDb, key.identity.fingerprint)
      const taskPk = taskRow(raceDb, brief.id).id

      const originalUpdate = raceDb.update.bind(raceDb)
      let flipped = false
      raceDb.update = (table) => {
        if (!flipped && table === tasksTable) {
          flipped = true
          raceDb.$client.prepare("UPDATE tasks SET status = '进行中' WHERE id = ?").run(taskPk)
        }
        return originalUpdate(table)
      }

      try {
        await claimTaskDirect(raceDb, auth, brief.id)
      } catch {
        // Either outcome (a graceful ok:false result, or a thrown error from the zero-row-update
        // safety net) is acceptable here — only the persisted state below is under test.
      }

      assert.ok(flipped, 'the race harness itself must have fired: claimTask must call db.update(tasks)')
      const db = openDb(t, sqlitePath)
      assert.equal(
        activeLeaseRows(db, taskPk).length,
        0,
        'a task update that lost the CAS race (status no longer 待认领 at write time) must never insert a lease',
      )
      assert.equal(
        claimRevealEvents(db, brief.id).length,
        0,
        'a task update that lost the CAS race must never reveal the token',
      )
      assert.equal(
        statusTransitionEvents(db, brief.id).filter((event) => parseDetails(event)?.to === '进行中').length,
        0,
        'a task update that lost the CAS race must never write a second 状态迁移 to 进行中',
      )
    })
  })

  describe('a different request_id is a new attempt only when the Task is legally claimable', () => {
    test('a different request_id on the same device is rejected while the task is already claimed, and creates no second lease', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'different-request-id-busy')

      const first = await claimTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { request_id: 'first-attempt-request-id' },
      })
      assert.equal(first.statusCode, 201, `first claim: ${first.statusCode} ${first.body}`)

      const rejected = await claimTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { request_id: 'second-different-request-id' },
      })
      assert.notEqual(
        rejected.statusCode,
        201,
        `a different request_id while the task is already claimed must not create a second claim, got ${rejected.statusCode} ${rejected.body}`,
      )

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(activeLeaseRows(db, task.id).length, 1)
      assert.equal(leaseRows(db, task.id).length, 1, 'a different request_id against an already-claimed task must never insert a second lease')
      const started = statusTransitionEvents(db, brief.id).filter((event) => parseDetails(event)?.to === '进行中')
      assert.equal(started.length, 1, 'a different request_id against an already-claimed task must never write a second 状态迁移 to 进行中')
    })

    test('after the holder releases, a different request_id makes a legitimate new attempt and mints a new claim_id', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'different-request-id-after-release')

      const first = await claimTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { request_id: 'req-before-release' },
      })
      assert.equal(first.statusCode, 201, `first claim: ${first.statusCode} ${first.body}`)
      const firstClaimId = jsonBody(first).lease.claim_id

      const released = await releaseTask(app, { identity: key.identity, publicId: brief.id })
      assert.equal(released.statusCode, 200, `release: ${released.statusCode} ${released.body}`)

      const second = await claimTask(app, {
        identity: key.identity,
        publicId: brief.id,
        payload: { request_id: 'req-after-release' },
      })
      assert.equal(
        second.statusCode,
        201,
        `a different request_id must be a legitimate new attempt once the task is claimable again, got ${second.statusCode} ${second.body}`,
      )
      const secondClaimId = jsonBody(second).lease.claim_id
      assert.equal(typeof secondClaimId, 'string')
      assert.match(secondClaimId, /^clm_/)
      assert.notEqual(secondClaimId, firstClaimId, 'a fresh claim after release must mint a new claim_id, not reuse the released one')

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(leaseRows(db, task.id).length, 2, 'release then a differently-identified reclaim must produce a second lease row')
      assert.equal(activeLeaseRows(db, task.id).length, 1)
    })
  })

  describe('token containment — only the REST claim 201 and MCP claim_task success channels ever carry the token', () => {
    test('after a successful claim and a replay, the forge token appears nowhere else: brief, list, MCP, progress/release, or any events row', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies)
      const key = await mintAgentKey(app, poster.cookies, 'containment')
      const requestId = 'containment-request'

      const claimed = await claimTask(app, { identity: key.identity, publicId: brief.id, payload: { request_id: requestId } })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)
      assert.equal(jsonBody(claimed).token, INLINE_TOKEN)

      // A replay re-reveals the same token, but only inside the claim channel itself; its own
      // response and its own audit event are scanned below alongside every other surface.
      const replay = await claimTask(app, { identity: key.identity, publicId: brief.id, payload: { request_id: requestId } })
      assert.equal(replay.statusCode, 201, `replay: ${replay.statusCode} ${replay.body}`)

      const restList = await app.inject({ method: 'GET', url: '/api/v1/tasks', cookies: poster.cookies, headers: jsonHeaders })
      const restDetail = await app.inject({ method: 'GET', url: `/api/v1/tasks/${brief.id}`, cookies: poster.cookies, headers: jsonHeaders })
      const progressed = await progressTask(app, { identity: key.identity, publicId: brief.id })
      const released = await releaseTask(app, { identity: key.identity, publicId: brief.id })

      for (const res of [restList, restDetail, progressed, released]) {
        assertNoForgeSecretMaterial(res, INLINE_TOKEN)
      }

      const client = await readyMcp(app, key.identity)
      const mcpList = await client.callTool(app, key.identity, 'list_tasks', {})
      const mcpBrief = await client.callTool(app, key.identity, 'get_task_brief', { task_id: brief.id })
      for (const result of [mcpList.result, mcpBrief.result]) {
        const dumped = JSON.stringify(result)
        assert.equal(dumped.includes(INLINE_TOKEN), false, `MCP tool result leaked the forge token: ${dumped}`)
        for (const key2 of collectKeys(result)) {
          assert.equal(SECRET_KEY_NAMES.has(key2), false, `MCP tool result carried a secret-bearing key "${key2}": ${dumped}`)
        }
      }

      const db = openDb(t, sqlitePath)
      const dumpedEvents = JSON.stringify(eventRows(db))
      assert.equal(dumpedEvents.includes(INLINE_TOKEN), false, `an events row (including the replay's audit event) leaked the forge token: ${dumpedEvents}`)
    })
  })
})
