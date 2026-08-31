import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createDb } from './db.ts'
import { injectSigned, pairDeviceToSelf } from './device-proof.test-helpers.ts'
import { ensureSetup } from './auth.test-helpers.ts'
import { pollPendingReviews } from './poller.ts'
import { sweepExpiredLeases } from './leases.ts'

// Issue #31 claim fencing: claim_id on report_progress/release_task/submit_pr, exact-device
// fencing (the deliberate legacy tightening), claim-transaction atomicity for heartbeat/release/
// expiry-sweep/submit_pr, idempotent release + idempotent one-submission-per-Claim, PR-repo
// ownership validation, pr_url canonicalization, and no-duplicate-PR-across-tasks.
//
// RED baseline: commit 8a49a63477115f998f24e1ff989ab7d709bddd22 ("feat(claim): idempotent Claim
// identity and atomic claim acquisition (#36)"). At that commit: reportProgress/releaseTask/
// submitPr take no claim_id parameter at all (apps/server/src/claim.ts), ownerMatchesLease
// (claim.ts) checks only claimerUserId/claimerClaimantId — never leases.device_id, reportProgress/
// releaseTask/submitPr/sweepExpiredLeases each perform 2-4 sequential (non-transactional) writes,
// submissions has no unique index on lease_id (apps/server/src/db.ts), submitPr never validates
// the submitted pr_url against the task's own repo or against other tasks' live submissions, and
// @kaola/forge-adapters (packages/forge-adapters/src/index.ts) has no exported `parsePrUrl` (only
// the module-private parseGithubPrUrl/parseGitlabMrUrl/parseGiteaPrUrl).
//
// Ambiguity notes (the brief pins claim_id_required / stale_claim as the two typed-error names,
// but not their HTTP status; resolved here, documented rather than silently assumed elsewhere):
// (1) claim_id_required -> HTTP 400 (a required field is missing, matching ordinary REST
// convention; distinct from the existing 403 forbidden / 409 conflict families already used for
// owner/lease-state mismatches in claim.ts). (2) stale_claim -> HTTP 409 (a presented Claim no
// longer matches the current lease identity, the same family as TASK_NOT_CLAIMED_MESSAGE /
// TASK_ALREADY_CLAIMED_MESSAGE). (3) A device mismatch (the legacy-tightening case) is asserted
// only as "not a successful mutation, and no state changed" — not tied to a specific status/error
// string, since the brief does not say whether it reuses the existing `forbidden` path or folds
// into `stale_claim`. (4) Cross-repo PR rejection, duplicate-pr-across-tasks rejection, and a
// same-Claim-different-pr_url conflict are asserted the same way (typed string `error`, no state
// change) without pinning a literal error string, following the `claim_request_conflict` precedent
// in claim-identity.test.ts. (5) The fixture table's ".git suffix" case for parsePrUrl is read as
// an unparseable/garbage case: a bare repo URL ending in `.git` with no /pull|merge_requests|pulls/
// path segment at all — a real PR/MR URL never legitimately carries that shape, so it must resolve
// to undefined under any reasonable implementation. (6) The canonical stored form of pr_url is
// never asserted as a specific literal string invented by this suite; it is proven two ways that
// do not require guessing the implementation's own convention: (a) three differently-decorated
// submissions of the *same* real PR, submitted as repeats of the *same* Claim, must all resolve to
// one idempotent submission (which only happens if canonicalization normalizes them to the same
// identity), and (b) a webhook/poller delivery carrying the bare, undecorated URL (the shape real
// forges actually send) must match the stored value byte-for-byte — which is only possible if the
// stored value *is* that bare form.

const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const REPO_FULL_NAME = 'team/orders'
const REPO_FULL_NAME_OTHER = 'team/other-repo'
const GITHUB_FORGE_BASE_URL = 'https://github.com'
const GITHUB_REPO_FULL_NAME = 'octo/widget'
const GITHUB_REPO_FULL_NAME_OTHER = 'octo/other-widget'
const GITLAB_FORGE_BASE_URL = 'https://gitlab.forge.example.test'
const GITLAB_SUBGROUP_FULL_NAME = 'group/subgroup/app'
const GITLAB_SUBGROUP_FULL_NAME_OTHER = 'group/subgroup/other-app'
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'ef'.repeat(32)

const INLINE_TOKEN = 'gitea-INLINE-ONE-OFF-TOKEN-fz31'
const GITHUB_FORGE_TOKEN = 'github-INLINE-ONE-OFF-TOKEN-fz32'
const GITLAB_FORGE_TOKEN = 'gitlab-INLINE-ONE-OFF-TOKEN-fz33'

const STATUS_TRANSITION_EVENT = '状态迁移'
const HEARTBEAT_EVENT = '心跳'
const WEBHOOK_PATH_PREFIX = '/api/v1/webhooks'
const MCP_PATH = '/api/mcp'
const MCP_PROTOCOL_VERSION = '2025-11-25'
const GITEA_INSTANCE_ID = 'inst-gitea-fencing'
const GITEA_WEBHOOK_SECRET = 'gitea-webhook-secret-fencing-01'
const GITHUB_INSTANCE_ID = 'inst-github-fencing'
const GITHUB_WEBHOOK_SECRET = 'github-webhook-secret-fencing-02'
const GITLAB_INSTANCE_ID = 'inst-gitlab-fencing'
const GITLAB_WEBHOOK_SECRET = 'gitlab-webhook-secret-fencing-03'

function applyOauthTestEnv() {
  process.env.OAUTH_GITHUB_CLIENT_ID = 'test-github-client-id'
  process.env.OAUTH_GITHUB_CLIENT_SECRET = 'test-github-client-secret'
  process.env.OAUTH_GITLAB_CLIENT_ID = 'test-gitlab-client-id'
  process.env.OAUTH_GITLAB_CLIENT_SECRET = 'test-gitlab-client-secret'
  process.env.OAUTH_GITLAB_BASE_URL = GITLAB_BASE_URL
  process.env.OAUTH_GITEA_CLIENT_ID = 'test-gitea-client-id'
  process.env.OAUTH_GITEA_CLIENT_SECRET = 'test-gitea-client-secret'
  process.env.OAUTH_GITEA_BASE_URL = GITEA_BASE_URL
  process.env.SESSION_SECRET = '3'.repeat(32)
  process.env.PUBLIC_URL = 'http://localhost:3000'
  process.env.VAULT_MASTER_KEY = VAULT_MASTER_KEY_HEX
}

applyOauthTestEnv()

const { buildApp } = await import('./app.ts')
const forgeAdaptersModule = await import('@kaola/forge-adapters')

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

// Same three-way endpoint classifier as poller.test.ts's isPrEndpoint/isRepoEndpoint/isUserEndpoint
// (this file does not import that test file — copied deliberately as house style dictates).
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

const GITLAB_REPO_ACCESS = {
  permissions: {
    project_access: { access_level: 40 },
    group_access: { access_level: 0 },
  },
  repository_access_level: 'enabled',
  can_create_merge_request_in: true,
  merge_requests_access_level: 'enabled',
}

function allowForgeToken(stub, token, descriptor = { repo: REPO_FULL_ACCESS }) {
  stub.forge.set(token, descriptor)
}

function sqliteFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-claim-fencing-'))
  const sqlitePath = join(dir, 'kaola.sqlite')
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return sqlitePath
}

// unixNow() (leases.ts) only has 1-second resolution, and a claim followed immediately by a
// progress call in-process can easily land in the same wall-clock second — which would make a
// last_heartbeat "before vs after" comparison pass by coincidence even if the write actually
// happened, masking a real all-or-nothing violation. Freezing and then jumping the clock forward
// by a large, unambiguous amount between setup and the write under test removes that coincidence.
function freezeNow(t, ms = Date.UTC(2026, 7, 21, 4, 0, 0)) {
  const realNow = Date.now
  let current = ms
  Date.now = () => current
  t.after(() => {
    Date.now = realNow
  })
  return {
    advanceMs(delta) {
      current += delta
    },
  }
}

async function createApp(t, sqlitePath, options = {}) {
  const app = buildApp({ ...(sqlitePath ? { sqlitePath } : {}), ...options })
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
// specific write, so a transaction write boundary genuinely fails instead of being stubbed.
// Triggers live in sqlite_master, so they fire regardless of which connection performs the write.
// Copied from claim-identity.test.ts's helper of the same name (house style: do not import it).
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

async function postTask(app, cookies, payload) {
  return app.inject({ method: 'POST', url: '/api/v1/tasks', cookies, headers: jsonHeaders, payload })
}

async function createTaskOk(app, cookies, payload = taskPayload()) {
  const res = await postTask(app, cookies, payload)
  assert.equal(res.statusCode, 201, `POST /api/v1/tasks: ${res.statusCode} ${res.body}`)
  return { res, brief: jsonBody(res) }
}

async function mintAgentKey(app, cookies, label = 'agent') {
  const paired = await pairDeviceToSelf(app, cookies, { hostname: label })
  return { id: paired.deviceId, identity: paired.identity, deviceId: paired.deviceId }
}

async function restClaim(app, { identity, publicId, payload }) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/claim`,
    payload: payload ?? {},
    extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
  })
}

async function restProgress(app, { identity, publicId, claimId, note }) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/progress`,
    payload: { note, claim_id: claimId },
    extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
  })
}

async function restRelease(app, { identity, publicId, claimId, reason }) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/release`,
    payload: { reason, claim_id: claimId },
    extraHeaders: { accept: 'application/json', 'content-type': 'application/json' },
  })
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

function assertToolError(result, expected = {}) {
  assert.equal(result?.isError, true, `expected isError true, got: ${JSON.stringify(result)}`)
  const body = toolStructured(result)
  if (expected.error !== undefined) assert.equal(body.error, expected.error)
  return body
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
            clientInfo: { name: 'kaola-claim-fencing-test', version: '0.0.0' },
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

async function mcpSubmitPr(app, identity, { taskId, prUrl, summary, claimId }) {
  const client = await readyMcp(app, identity)
  return client.callTool(app, identity, 'submit_pr', { task_id: taskId, pr_url: prUrl, summary, claim_id: claimId })
}

async function mcpReportProgress(app, identity, { taskId, note, claimId }) {
  const client = await readyMcp(app, identity)
  return client.callTool(app, identity, 'report_progress', { task_id: taskId, note, claim_id: claimId })
}

async function mcpReleaseTask(app, identity, { taskId, reason, claimId }) {
  const client = await readyMcp(app, identity)
  return client.callTool(app, identity, 'release_task', { task_id: taskId, reason, claim_id: claimId })
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

function statusTransitionEvents(db, publicId) {
  return eventsOfType(db, STATUS_TRANSITION_EVENT).filter((event) => parseDetails(event)?.task_id === publicId)
}

function heartbeatEvents(db, publicId) {
  return eventsOfType(db, HEARTBEAT_EVENT).filter((event) => parseDetails(event)?.task_id === publicId)
}

function taskRow(db, publicId) {
  return db.$client.prepare('SELECT id, public_id, status FROM tasks WHERE public_id = ?').get(publicId)
}

function leaseRows(db, taskPk) {
  return db.$client
    .prepare(
      'SELECT id, task_id, claimer_user_id, device_id, claimed_at, expires_at, last_heartbeat, state, request_id FROM leases WHERE task_id = ? ORDER BY id',
    )
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

async function boot(t, sqlitePath, options = {}) {
  const app = await createApp(t, sqlitePath, options)
  const stub = beginFetch(t)
  allowForgeToken(stub, INLINE_TOKEN)
  return { app, stub }
}

// Shared setup: publish a native gitea task, mint one agent device, claim it. `requestId` present
// -> a new-style Claim (claim_id required by #31); omitted -> a legacy Claim (claim_id optional).
async function setupClaimedTask(app, poster, { title, requestId }) {
  const { brief } = await createTaskOk(app, poster.cookies, taskPayload({ title }))
  const key = await mintAgentKey(app, poster.cookies, title)
  const payload = requestId != null ? { request_id: requestId } : {}
  const claimed = await restClaim(app, { identity: key.identity, publicId: brief.id, payload })
  assert.equal(claimed.statusCode, 201, `setup claim (${title}): ${claimed.statusCode} ${claimed.body}`)
  const body = jsonBody(claimed)
  return { brief, key, claimId: body.lease.claim_id, claimBody: body }
}

// --- webhook signature + payload helpers (this spec computes its own expected digests) ---

function giteaSignature(secret, rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

function githubSignature(secret, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}

function webhookUrl(instancePublicId) {
  return `${WEBHOOK_PATH_PREFIX}/${instancePublicId}`
}

function giteaPrPayload({ merged, prUrl, fullName = REPO_FULL_NAME }) {
  return {
    action: 'closed',
    pull_request: { merged, html_url: prUrl },
    repository: { full_name: fullName },
  }
}

function githubPrPayload({ merged, prUrl, fullName = GITHUB_REPO_FULL_NAME }) {
  return {
    action: 'closed',
    pull_request: { merged, html_url: prUrl },
    repository: { full_name: fullName },
  }
}

function gitlabMrPayload({ state, mrUrl, fullName = GITLAB_SUBGROUP_FULL_NAME }) {
  return {
    object_attributes: { state, url: mrUrl },
    project: { path_with_namespace: fullName },
  }
}

async function postGiteaWebhook(app, instancePublicId, { secret, rawBody }) {
  return app.inject({
    method: 'POST',
    url: webhookUrl(instancePublicId),
    headers: { 'content-type': 'application/json', 'x-gitea-event': 'pull_request', 'x-gitea-signature': giteaSignature(secret, rawBody) },
    payload: rawBody,
  })
}

async function postGithubWebhook(app, instancePublicId, { secret, rawBody }) {
  return app.inject({
    method: 'POST',
    url: webhookUrl(instancePublicId),
    headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': githubSignature(secret, rawBody) },
    payload: rawBody,
  })
}

async function postGitlabWebhook(app, instancePublicId, { secret, rawBody }) {
  return app.inject({
    method: 'POST',
    url: webhookUrl(instancePublicId),
    headers: { 'content-type': 'application/json', 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-token': secret },
    payload: rawBody,
  })
}

describe('issue #31 claim fencing', { concurrency: false }, () => {
  describe('parsePrUrl (packages/forge-adapters) — pure fixture table', () => {
    test('@kaola/forge-adapters exports parsePrUrl(kind, prUrl): { full_name } | undefined', () => {
      assert.equal(
        typeof forgeAdaptersModule.parsePrUrl,
        'function',
        'packages/forge-adapters/src/index.ts must export parsePrUrl, analogous to the existing exported parseIssueUrl',
      )
    })

    test('github: base, trailing slash, query string, and fragment all resolve to the same repo full_name', () => {
      const { parsePrUrl } = forgeAdaptersModule
      const base = `${GITHUB_FORGE_BASE_URL}/${GITHUB_REPO_FULL_NAME}/pull/42`
      for (const url of [base, `${base}/`, `${base}?tab=files`, `${base}#discussion_r1`]) {
        const parsed = parsePrUrl('github', url)
        assert.deepEqual(parsed, { full_name: GITHUB_REPO_FULL_NAME }, `expected ${url} to parse to ${GITHUB_REPO_FULL_NAME}, got ${JSON.stringify(parsed)}`)
      }
    })

    test('gitlab: a subgroup MR URL (base, trailing slash, query string, fragment) resolves to the full nested namespace', () => {
      const { parsePrUrl } = forgeAdaptersModule
      const base = `${GITLAB_FORGE_BASE_URL}/${GITLAB_SUBGROUP_FULL_NAME}/-/merge_requests/7`
      for (const url of [base, `${base}/`, `${base}?tab=diffs`, `${base}#note_1`]) {
        const parsed = parsePrUrl('gitlab', url)
        assert.deepEqual(parsed, { full_name: GITLAB_SUBGROUP_FULL_NAME }, `expected ${url} to parse to ${GITLAB_SUBGROUP_FULL_NAME}, got ${JSON.stringify(parsed)}`)
      }
    })

    test('gitea: base, trailing slash, query string, and fragment all resolve to the same repo full_name', () => {
      const { parsePrUrl } = forgeAdaptersModule
      const base = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/3`
      for (const url of [base, `${base}/`, `${base}?diff=1`, `${base}#issuecomment-1`]) {
        const parsed = parsePrUrl('gitea', url)
        assert.deepEqual(parsed, { full_name: REPO_FULL_NAME }, `expected ${url} to parse to ${REPO_FULL_NAME}, got ${JSON.stringify(parsed)}`)
      }
    })

    test('unparseable garbage (not a URL, wrong path shape, or a bare .git repo URL with no pull/MR segment) resolves to undefined, never throws', () => {
      const { parsePrUrl } = forgeAdaptersModule
      const garbage = [
        ['github', 'not a url at all'],
        ['github', `${GITHUB_FORGE_BASE_URL}/${GITHUB_REPO_FULL_NAME}.git`],
        ['github', `${GITHUB_FORGE_BASE_URL}/${GITHUB_REPO_FULL_NAME}/issues/42`],
        ['gitlab', 'not a url at all'],
        ['gitlab', `${GITLAB_FORGE_BASE_URL}/${GITLAB_SUBGROUP_FULL_NAME}.git`],
        ['gitea', 'not a url at all'],
        ['gitea', `${FORGE_BASE_URL}/${REPO_FULL_NAME}.git`],
      ]
      for (const [kind, url] of garbage) {
        assert.doesNotThrow(() => parsePrUrl(kind, url), `parsePrUrl(${kind}, ${url}) must not throw`)
        assert.equal(parsePrUrl(kind, url), undefined, `parsePrUrl(${kind}, ${url}) must resolve to undefined, not a guessed full_name`)
      }
    })
  })

  describe('new-style Claim (request_id present) requires claim_id — omitting it is refused before any write', () => {
    test('REST progress without claim_id: 400 claim_id_required, lease heartbeat untouched, no 心跳 event', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'progress-needs-claim-id', requestId: 'req-progress-needed' })
      const db = openDb(t, sqlitePath)
      const before = leaseRows(db, taskRow(db, setup.brief.id).id)[0]

      const res = await restProgress(app, { identity: setup.key.identity, publicId: setup.brief.id })
      assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'claim_id_required')

      const after = leaseRows(db, taskRow(db, setup.brief.id).id)[0]
      assert.equal(after.last_heartbeat, before.last_heartbeat, 'a rejected claim_id_required call must not renew the lease')
      assert.equal(after.expires_at, before.expires_at)
      assert.equal(heartbeatEvents(db, setup.brief.id).length, 0)
    })

    test('REST release without claim_id: 400 claim_id_required, lease stays active, task stays 进行中', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'release-needs-claim-id', requestId: 'req-release-needed' })

      const res = await restRelease(app, { identity: setup.key.identity, publicId: setup.brief.id })
      assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'claim_id_required')

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(activeLeaseRows(db, task.id).length, 1)
      assert.equal(statusTransitionEvents(db, setup.brief.id).filter((e) => parseDetails(e)?.to === '待认领').length, 0)
    })

    test('MCP report_progress without claim_id: isError claim_id_required, no 心跳 event', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'mcp-progress-needs-claim-id', requestId: 'req-mcp-progress' })

      const called = await mcpReportProgress(app, setup.key.identity, { taskId: setup.brief.id })
      assertToolError(called.result, { error: 'claim_id_required' })

      const db = openDb(t, sqlitePath)
      assert.equal(heartbeatEvents(db, setup.brief.id).length, 0)
    })

    test('MCP release_task without claim_id: isError claim_id_required, lease stays active', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'mcp-release-needs-claim-id', requestId: 'req-mcp-release' })

      const called = await mcpReleaseTask(app, setup.key.identity, { taskId: setup.brief.id })
      assertToolError(called.result, { error: 'claim_id_required' })

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(activeLeaseRows(db, task.id).length, 1)
    })

    test('MCP submit_pr without claim_id: isError claim_id_required, task stays 进行中, no submission row', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'mcp-submit-needs-claim-id', requestId: 'req-mcp-submit' })

      const called = await mcpSubmitPr(app, setup.key.identity, {
        taskId: setup.brief.id,
        prUrl: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/1`,
        summary: '不应成功',
      })
      assertToolError(called.result, { error: 'claim_id_required' })

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(submissionRows(db, task.id).length, 0)
    })
  })

  describe('legacy Claim (no request_id) still accepts an omitted claim_id', () => {
    test('REST progress and release succeed for a legacy Claim with no claim_id in the body', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'legacy-rest-compat' })

      const progressed = await restProgress(app, { identity: setup.key.identity, publicId: setup.brief.id, note: '继续' })
      assert.equal(progressed.statusCode, 200, `progress: ${progressed.statusCode} ${progressed.body}`)

      const released = await restRelease(app, { identity: setup.key.identity, publicId: setup.brief.id })
      assert.equal(released.statusCode, 200, `release: ${released.statusCode} ${released.body}`)
    })

    test('MCP report_progress, release_task, and submit_pr succeed for a legacy Claim with no claim_id', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'legacy-mcp-compat' })

      const progressed = await mcpReportProgress(app, setup.key.identity, { taskId: setup.brief.id })
      assertToolOk(progressed.result)

      const submitted = await mcpSubmitPr(app, setup.key.identity, {
        taskId: setup.brief.id,
        prUrl: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/2`,
        summary: '合规提交',
      })
      const submittedBody = assertToolOk(submitted.result)
      assert.equal(submittedBody.task.status, '待验收')
    })
  })

  describe('wrong claim_id is a typed stale_claim — refused before any write', () => {
    test('REST progress with a garbage claim_id: 409 stale_claim, lease heartbeat untouched', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'progress-wrong-claim-id', requestId: 'req-wrong-1' })
      const db = openDb(t, sqlitePath)
      const before = leaseRows(db, taskRow(db, setup.brief.id).id)[0]

      const res = await restProgress(app, { identity: setup.key.identity, publicId: setup.brief.id, claimId: 'clm_totally-wrong-value' })
      assert.equal(res.statusCode, 409, `expected 409, got ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'stale_claim')

      const after = leaseRows(db, taskRow(db, setup.brief.id).id)[0]
      assert.equal(after.last_heartbeat, before.last_heartbeat)
      assert.equal(heartbeatEvents(db, setup.brief.id).length, 0)
    })

    test('REST release with a garbage claim_id: 409 stale_claim, lease stays active', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'release-wrong-claim-id', requestId: 'req-wrong-2' })

      const res = await restRelease(app, { identity: setup.key.identity, publicId: setup.brief.id, claimId: 'clm_totally-wrong-value' })
      assert.equal(res.statusCode, 409, `expected 409, got ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'stale_claim')

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(activeLeaseRows(db, task.id).length, 1)
    })

    test('MCP submit_pr with a garbage claim_id: isError stale_claim, task stays 进行中, no submission row', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'submit-wrong-claim-id', requestId: 'req-wrong-3' })

      const called = await mcpSubmitPr(app, setup.key.identity, {
        taskId: setup.brief.id,
        prUrl: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/9`,
        summary: '不应成功',
        claimId: 'clm_totally-wrong-value',
      })
      assertToolError(called.result, { error: 'stale_claim' })

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(submissionRows(db, task.id).length, 0)
    })
  })

  describe('an old (now-terminal) claim_id cannot act on a newer Claim on the same task', () => {
    // One task, claimed twice in sequence: C1 (released), then C2 (active, a different claim_id).
    // C1's claim_id must never be able to heartbeat/release/submit against C2.
    async function setupSupersededClaim(app, poster, title) {
      const { brief } = await createTaskOk(app, poster.cookies, taskPayload({ title }))
      const key = await mintAgentKey(app, poster.cookies, title)
      const first = await restClaim(app, { identity: key.identity, publicId: brief.id, payload: { request_id: `${title}-r1` } })
      assert.equal(first.statusCode, 201, `first claim: ${first.statusCode} ${first.body}`)
      const oldClaimId = jsonBody(first).lease.claim_id

      const released = await restRelease(app, { identity: key.identity, publicId: brief.id, claimId: oldClaimId })
      assert.equal(released.statusCode, 200, `release: ${released.statusCode} ${released.body}`)

      const second = await restClaim(app, { identity: key.identity, publicId: brief.id, payload: { request_id: `${title}-r2` } })
      assert.equal(second.statusCode, 201, `second claim: ${second.statusCode} ${second.body}`)
      const newClaimId = jsonBody(second).lease.claim_id
      assert.notEqual(newClaimId, oldClaimId, 'setup: the second claim must mint a different claim_id')
      return { brief, key, oldClaimId, newClaimId }
    }

    test('the old claim_id cannot heartbeat the newer Claim', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupSupersededClaim(app, poster, 'superseded-progress')
      const db = openDb(t, sqlitePath)
      const before = leaseRows(db, taskRow(db, setup.brief.id).id).find((row) => row.state === 'active')

      const res = await restProgress(app, { identity: setup.key.identity, publicId: setup.brief.id, claimId: setup.oldClaimId })
      assert.equal(res.statusCode, 409, `expected 409, got ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'stale_claim')

      const after = leaseRows(db, taskRow(db, setup.brief.id).id).find((row) => row.state === 'active')
      assert.equal(after.last_heartbeat, before.last_heartbeat, 'the new Claim lease must not be renewed by the old claim_id')
    })

    test('the old claim_id cannot release the newer Claim', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupSupersededClaim(app, poster, 'superseded-release')

      const res = await restRelease(app, { identity: setup.key.identity, publicId: setup.brief.id, claimId: setup.oldClaimId })
      assert.equal(res.statusCode, 409, `expected 409, got ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'stale_claim')

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中', 'the new Claim must remain active — the old claim_id must not release it')
      assert.equal(activeLeaseRows(db, task.id).length, 1)
    })

    test('the old claim_id cannot submit a PR against the newer Claim', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupSupersededClaim(app, poster, 'superseded-submit')

      const called = await mcpSubmitPr(app, setup.key.identity, {
        taskId: setup.brief.id,
        prUrl: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/11`,
        summary: '不应成功',
        claimId: setup.oldClaimId,
      })
      assertToolError(called.result, { error: 'stale_claim' })

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(submissionRows(db, task.id).length, 0)
    })
  })

  describe('exact-device fencing — the deliberate legacy tightening (ownerMatchesLease now also checks leases.device_id)', () => {
    test('ISSUE #31 LEGACY TIGHTENING: a second device bound to the SAME owner can no longer heartbeat or release a legacy Claim it does not hold', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(app, poster.cookies, taskPayload({ title: 'device-fence-legacy' }))
      const holder = await mintAgentKey(app, poster.cookies, 'device-fence-holder')
      const other = await mintAgentKey(app, poster.cookies, 'device-fence-other')

      const claimed = await restClaim(app, { identity: holder.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `claim: ${claimed.statusCode} ${claimed.body}`)

      const db = openDb(t, sqlitePath)
      const before = leaseRows(db, taskRow(db, brief.id).id)[0]

      // Before #31, ownerMatchesLease only compared claimerUserId/claimerClaimantId — since both
      // devices are bound to the same admin/poster user, this call used to succeed. #31 requires
      // it to fail because leases.device_id (holder's device) does not match auth.device.id (the
      // second device's own id) even though the owner is identical.
      const progressed = await restProgress(app, { identity: other.identity, publicId: brief.id })
      assert.notEqual(
        progressed.statusCode,
        200,
        `a different device for the same owner must no longer heartbeat a Claim it does not hold, got ${progressed.statusCode} ${progressed.body}`,
      )
      const released = await restRelease(app, { identity: other.identity, publicId: brief.id })
      assert.notEqual(
        released.statusCode,
        200,
        `a different device for the same owner must no longer release a Claim it does not hold, got ${released.statusCode} ${released.body}`,
      )

      const after = leaseRows(db, taskRow(db, brief.id).id)[0]
      assert.equal(after.last_heartbeat, before.last_heartbeat, 'the rejected cross-device heartbeat must not have renewed the lease')
      assert.equal(after.state, 'active', 'the rejected cross-device release must not have released the lease')
      assert.equal(taskRow(db, brief.id).status, '进行中')

      // The actual holder device must still be able to act — this is a device-identity check, not
      // a global regression.
      const holderProgressed = await restProgress(app, { identity: holder.identity, publicId: brief.id })
      assert.equal(holderProgressed.statusCode, 200, `the real holder device must still succeed: ${holderProgressed.statusCode} ${holderProgressed.body}`)
    })

    test('a different device presenting the correct (copied) claim_id for a new-style Claim is still rejected — claim_id alone is not device proof', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'device-fence-newstyle', requestId: 'req-device-fence' })
      const other = await mintAgentKey(app, poster.cookies, 'device-fence-newstyle-other')

      const res = await restRelease(app, { identity: other.identity, publicId: setup.brief.id, claimId: setup.claimId })
      assert.notEqual(
        res.statusCode,
        200,
        `a different device presenting the holder's own (copied) claim_id must still be rejected, got ${res.statusCode} ${res.body}`,
      )

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(activeLeaseRows(db, task.id).length, 1)
    })
  })

  describe('idempotent release — repeating release for an already-terminal Claim returns the same result, no duplicate transition/audit', () => {
    test('new-style Claim: releasing twice with the same claim_id is idempotent, not a 409', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'idempotent-release-new', requestId: 'req-idempotent-release' })

      const first = await restRelease(app, { identity: setup.key.identity, publicId: setup.brief.id, claimId: setup.claimId })
      assert.equal(first.statusCode, 200, `first release: ${first.statusCode} ${first.body}`)
      const firstBody = jsonBody(first)

      const second = await restRelease(app, { identity: setup.key.identity, publicId: setup.brief.id, claimId: setup.claimId })
      assert.equal(second.statusCode, 200, `repeating release for the same terminal Claim must stay 200, got ${second.statusCode} ${second.body}`)
      assert.deepEqual(jsonBody(second), firstBody, 'a repeated release must return the same result')

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(leaseRows(db, task.id).length, 1, 'a repeated release must never insert a second lease row')
      assert.equal(
        statusTransitionEvents(db, setup.brief.id).filter((e) => parseDetails(e)?.to === '待认领').length,
        1,
        'a repeated release must never write a second 状态迁移 event',
      )
    })

    test('legacy Claim: releasing twice in a row (no claim_id) is idempotent, not a 409', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'idempotent-release-legacy' })

      const first = await restRelease(app, { identity: setup.key.identity, publicId: setup.brief.id })
      assert.equal(first.statusCode, 200, `first release: ${first.statusCode} ${first.body}`)
      const firstBody = jsonBody(first)

      const second = await restRelease(app, { identity: setup.key.identity, publicId: setup.brief.id })
      assert.equal(second.statusCode, 200, `repeating a legacy release must stay 200, got ${second.statusCode} ${second.body}`)
      assert.deepEqual(jsonBody(second), firstBody)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(leaseRows(db, task.id).length, 1)
      assert.equal(statusTransitionEvents(db, setup.brief.id).filter((e) => parseDetails(e)?.to === '待认领').length, 1)
    })
  })

  describe('report_progress is one transaction with its 心跳 audit', () => {
    test('failure injection: a failing 心跳 audit write leaves the lease heartbeat exactly as it was before the call', async (t) => {
      const sqlitePath = sqliteFile(t)
      const clock = freezeNow(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'progress-txn-fail-audit' })
      const db = openDb(t, sqlitePath)
      const before = leaseRows(db, taskRow(db, setup.brief.id).id)[0]
      // Jump the clock forward well past 1-second resolution so a genuine (buggy) write is
      // observably different from "unchanged" — see freezeNow's comment above.
      clock.advanceMs(500_000)

      installFailingTrigger(
        t,
        sqlitePath,
        'kaola_test_fail_heartbeat_event',
        `BEFORE INSERT ON events
         WHEN NEW.type = '${HEARTBEAT_EVENT}' AND NEW.details LIKE '%"task_id":"${setup.brief.id}"%'
         BEGIN SELECT RAISE(ABORT, 'kaola-test: injected heartbeat event failure'); END`,
      )

      const res = await restProgress(app, { identity: setup.key.identity, publicId: setup.brief.id, claimId: setup.claimId, note: 'x' })
      assert.notEqual(res.statusCode, 200, `an injected audit failure must not report success, got ${res.statusCode} ${res.body}`)

      const after = leaseRows(db, taskRow(db, setup.brief.id).id)[0]
      assert.equal(
        after.last_heartbeat,
        before.last_heartbeat,
        `a failed 心跳 audit write must leave the lease heartbeat untouched (all-or-nothing), got before=${before.last_heartbeat} after=${after.last_heartbeat}`,
      )
      assert.equal(after.expires_at, before.expires_at)
      assert.equal(heartbeatEvents(db, setup.brief.id).length, 0)
    })
  })

  describe('release_task is one transaction with the lease release, the task update, and the 状态迁移 audit', () => {
    test('failure injection: a failing 状态迁移 audit write rolls back the lease release and the task update', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'release-txn-fail-audit' })

      installFailingTrigger(
        t,
        sqlitePath,
        'kaola_test_fail_release_event',
        `BEFORE INSERT ON events
         WHEN NEW.type = '${STATUS_TRANSITION_EVENT}'
           AND NEW.details LIKE '%"task_id":"${setup.brief.id}"%'
           AND NEW.details LIKE '%"to":"待认领"%'
         BEGIN SELECT RAISE(ABORT, 'kaola-test: injected release event failure'); END`,
      )

      const res = await restRelease(app, { identity: setup.key.identity, publicId: setup.brief.id, claimId: setup.claimId })
      assert.notEqual(res.statusCode, 200, `an injected audit failure must not report success, got ${res.statusCode} ${res.body}`)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中', 'the task update must have rolled back alongside the failed audit write')
      assert.equal(activeLeaseRows(db, task.id).length, 1, 'the lease release must have rolled back alongside the failed audit write')
    })

    test('failure injection: a failing task-status update rolls back the lease release that preceded it', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'release-txn-fail-task-update' })
      const taskPk = taskRow(openDb(t, sqlitePath), setup.brief.id).id

      installFailingTrigger(
        t,
        sqlitePath,
        'kaola_test_fail_release_task_update',
        `BEFORE UPDATE ON tasks
         WHEN NEW.id = ${taskPk} AND NEW.status = '待认领'
         BEGIN SELECT RAISE(ABORT, 'kaola-test: injected release task-update failure'); END`,
      )

      const res = await restRelease(app, { identity: setup.key.identity, publicId: setup.brief.id, claimId: setup.claimId })
      assert.notEqual(res.statusCode, 200, `an injected task-update failure must not report success, got ${res.statusCode} ${res.body}`)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(activeLeaseRows(db, task.id).length, 1, 'the lease release must have rolled back when the task update failed')
      assert.equal(statusTransitionEvents(db, setup.brief.id).filter((e) => parseDetails(e)?.to === '待认领').length, 0)
    })
  })

  describe('the expiry sweep is one transaction per lease — no reachable 进行中 task with no active lease', () => {
    async function setupExpiredLease(t, sqlitePath, app, poster, title) {
      const setup = await setupClaimedTask(app, poster, { title })
      const db = openDb(t, sqlitePath)
      const taskPk = taskRow(db, setup.brief.id).id
      const leaseId = leaseRows(db, taskPk)[0].id
      db.$client.prepare('UPDATE leases SET expires_at = ? WHERE id = ?').run(0, leaseId)
      return { ...setup, taskPk, leaseId }
    }

    test('failure injection: a failing task-status update leaves the lease still active and the task still 进行中 (never both expired-lease + 进行中)', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupExpiredLease(t, sqlitePath, app, poster, 'sweep-txn-fail-task-update')

      installFailingTrigger(
        t,
        sqlitePath,
        'kaola_test_fail_sweep_task_update',
        `BEFORE UPDATE ON tasks
         WHEN NEW.id = ${setup.taskPk} AND NEW.status = '待认领'
         BEGIN SELECT RAISE(ABORT, 'kaola-test: injected sweep task-update failure'); END`,
      )
      const db = openDb(t, sqlitePath)
      assert.throws(() => sweepExpiredLeases(db), 'the injected failure must propagate rather than being silently swallowed mid-sweep')

      const task = taskRow(db, setup.brief.id)
      const lease = leaseRows(db, setup.taskPk).find((row) => row.id === setup.leaseId)
      const stranded = task.status === '进行中' && lease.state !== 'active'
      assert.equal(stranded, false, `a 进行中 task with no active lease must be unreachable, got task.status=${task.status} lease.state=${lease.state}`)
      assert.equal(lease.state, 'active', 'the lease-expiry write must have rolled back alongside the failed task update')
      assert.equal(task.status, '进行中')
    })

    test('failure injection: a failing 状态迁移 audit write leaves the lease still active and the task still 进行中', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupExpiredLease(t, sqlitePath, app, poster, 'sweep-txn-fail-audit')

      installFailingTrigger(
        t,
        sqlitePath,
        'kaola_test_fail_sweep_event',
        `BEFORE INSERT ON events
         WHEN NEW.type = '${STATUS_TRANSITION_EVENT}'
           AND NEW.details LIKE '%"task_id":"${setup.brief.id}"%'
           AND NEW.details LIKE '%"to":"待认领"%'
         BEGIN SELECT RAISE(ABORT, 'kaola-test: injected sweep audit failure'); END`,
      )
      const db = openDb(t, sqlitePath)
      assert.throws(() => sweepExpiredLeases(db))

      const task = taskRow(db, setup.brief.id)
      const lease = leaseRows(db, setup.taskPk).find((row) => row.id === setup.leaseId)
      const stranded = task.status === '进行中' && lease.state !== 'active'
      assert.equal(stranded, false, `a 进行中 task with no active lease must be unreachable, got task.status=${task.status} lease.state=${lease.state}`)
      assert.equal(lease.state, 'active')
      assert.equal(task.status, '进行中')
    })
  })

  describe('submit_pr is one transaction with the lease release, the task update, the submissions insert, and the 状态迁移 audit', () => {
    test('failure injection: a failing submissions insert rolls back the lease release and the task update', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'submit-txn-fail-submission' })
      const taskPk = taskRow(openDb(t, sqlitePath), setup.brief.id).id

      installFailingTrigger(
        t,
        sqlitePath,
        'kaola_test_fail_submission_insert',
        `BEFORE INSERT ON submissions
         WHEN NEW.task_id = ${taskPk}
         BEGIN SELECT RAISE(ABORT, 'kaola-test: injected submissions insert failure'); END`,
      )

      const called = await mcpSubmitPr(app, setup.key.identity, {
        taskId: setup.brief.id,
        prUrl: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/21`,
        summary: '不应成功',
      })
      assert.equal(called.result?.isError, true, `an injected submissions-insert failure must not report success, got ${JSON.stringify(called.result)}`)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中', 'the task update must have rolled back alongside the failed submissions insert')
      assert.equal(activeLeaseRows(db, task.id).length, 1, 'the lease release must have rolled back alongside the failed submissions insert')
      assert.equal(submissionRows(db, task.id).length, 0)
    })

    test('failure injection: a failing 状态迁移 audit write rolls back the lease release, the task update, and the submissions insert', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'submit-txn-fail-audit' })

      installFailingTrigger(
        t,
        sqlitePath,
        'kaola_test_fail_submit_event',
        `BEFORE INSERT ON events
         WHEN NEW.type = '${STATUS_TRANSITION_EVENT}'
           AND NEW.details LIKE '%"task_id":"${setup.brief.id}"%'
           AND NEW.details LIKE '%"to":"待验收"%'
         BEGIN SELECT RAISE(ABORT, 'kaola-test: injected submit event failure'); END`,
      )

      const called = await mcpSubmitPr(app, setup.key.identity, {
        taskId: setup.brief.id,
        prUrl: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/22`,
        summary: '不应成功',
      })
      assert.equal(called.result?.isError, true, `an injected audit failure must not report success, got ${JSON.stringify(called.result)}`)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(activeLeaseRows(db, task.id).length, 1)
      assert.equal(submissionRows(db, task.id).length, 0)
    })
  })

  describe('one submission per Claim (a unique index on submissions.lease_id)', () => {
    test('the schema enforces a unique index on submissions.lease_id — two raw inserts with the same lease_id must conflict', async (t) => {
      const db = createDb()
      t.after(() => db.$client.close())
      db.$client
        .prepare('INSERT INTO submissions (task_id, lease_id, pr_url, summary, pr_state) VALUES (?,?,?,?,?)')
        .run(1, 999001, 'https://example.test/a/b/pulls/1', 's1', 'open')
      assert.throws(
        () =>
          db.$client
            .prepare('INSERT INTO submissions (task_id, lease_id, pr_url, summary, pr_state) VALUES (?,?,?,?,?)')
            .run(1, 999001, 'https://example.test/a/b/pulls/2', 's2', 'open'),
        /UNIQUE constraint failed/i,
        'submissions must have a unique index on lease_id — a second row for the same lease_id must be rejected',
      )
    })

    test('repeating submit_pr with the same Claim and the same pr_url is idempotent — one submission row, same response', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'submit-idempotent-same-url' })
      const prUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/31`

      const first = await mcpSubmitPr(app, setup.key.identity, { taskId: setup.brief.id, prUrl, summary: '首次提交' })
      const firstBody = assertToolOk(first.result)
      assert.equal(firstBody.task.status, '待验收')

      const second = await mcpSubmitPr(app, setup.key.identity, { taskId: setup.brief.id, prUrl, summary: '首次提交' })
      const secondBody = assertToolOk(second.result)
      assert.deepEqual(secondBody, firstBody, 'repeating the same Claim + same pr_url must return the existing submission')

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(submissionRows(db, task.id).length, 1, 'repeating the same submit_pr must never insert a second submissions row')
    })

    test('repeating submit_pr with the same Claim but a DIFFERENT pr_url is a typed conflict, and the original submission is untouched', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'submit-conflict-different-url' })
      const prUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/32`
      const otherPrUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/33`

      const first = await mcpSubmitPr(app, setup.key.identity, { taskId: setup.brief.id, prUrl, summary: '首次提交' })
      assertToolOk(first.result)

      const second = await mcpSubmitPr(app, setup.key.identity, { taskId: setup.brief.id, prUrl: otherPrUrl, summary: '换一个 PR' })
      const body = assertToolError(second.result)
      assert.equal(typeof body.error, 'string', `a same-Claim different-pr_url resubmission must carry a typed error, got ${JSON.stringify(second.result)}`)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      const rows = submissionRows(db, task.id)
      assert.equal(rows.length, 1, 'a rejected different-pr_url resubmission must never insert a second row')
      assert.equal(rows[0].pr_url, prUrl, 'the original submission must be untouched')
    })
  })

  describe('a submitted PR/MR URL must belong to the Task repository — rejected before any mutation', () => {
    test('github: a PR URL for a different repo is rejected, task stays 进行中, no submission row', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      allowForgeToken(stub, GITHUB_FORGE_TOKEN)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'cross-repo-github',
          repo: { forge: 'github', base_url: GITHUB_FORGE_BASE_URL, full_name: GITHUB_REPO_FULL_NAME, base_branch: 'main', suggested_dir: 'widget' },
          credential: { token: GITHUB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'cross-repo-github')
      const claimed = await restClaim(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)

      const wrongRepoPrUrl = `${GITHUB_FORGE_BASE_URL}/${GITHUB_REPO_FULL_NAME_OTHER}/pull/5`
      const called = await mcpSubmitPr(app, key.identity, { taskId: brief.id, prUrl: wrongRepoPrUrl, summary: '跨仓库' })
      assertToolError(called.result)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(task.status, '进行中', 'a cross-repo pr_url must be rejected before the task is mutated')
      assert.equal(submissionRows(db, task.id).length, 0)
    })

    test('gitlab (subgroup repo): an MR URL for a different subgroup repo is rejected, task stays 进行中, no submission row', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      allowForgeToken(stub, GITLAB_FORGE_TOKEN, { repo: GITLAB_REPO_ACCESS })
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'cross-repo-gitlab-subgroup',
          repo: { forge: 'gitlab', base_url: GITLAB_FORGE_BASE_URL, full_name: GITLAB_SUBGROUP_FULL_NAME, base_branch: 'main', suggested_dir: 'app' },
          credential: { token: GITLAB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'cross-repo-gitlab-subgroup')
      const claimed = await restClaim(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)

      const wrongRepoMrUrl = `${GITLAB_FORGE_BASE_URL}/${GITLAB_SUBGROUP_FULL_NAME_OTHER}/-/merge_requests/5`
      const called = await mcpSubmitPr(app, key.identity, { taskId: brief.id, prUrl: wrongRepoMrUrl, summary: '跨仓库' })
      assertToolError(called.result)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(submissionRows(db, task.id).length, 0)
    })

    test('gitea: a PR URL for a different repo is rejected, task stays 进行中, no submission row', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'cross-repo-gitea' })

      const wrongRepoPrUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME_OTHER}/pulls/5`
      const called = await mcpSubmitPr(app, setup.key.identity, { taskId: setup.brief.id, prUrl: wrongRepoPrUrl, summary: '跨仓库' })
      assertToolError(called.result)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(submissionRows(db, task.id).length, 0)
    })

    test('an unparseable pr_url is rejected before any mutation', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'unparseable-pr-url' })

      const called = await mcpSubmitPr(app, setup.key.identity, { taskId: setup.brief.id, prUrl: 'not a url at all', summary: '不合法' })
      assertToolError(called.result)

      const db = openDb(t, sqlitePath)
      const task = taskRow(db, setup.brief.id)
      assert.equal(task.status, '进行中')
      assert.equal(submissionRows(db, task.id).length, 0)
    })
  })

  describe('no duplicate PR across tasks — a pr_url already held by another LIVE submission is a typed conflict', () => {
    test('a second task cannot submit a pr_url already held by another live (open) submission, before any state change', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const first = await setupClaimedTask(app, poster, { title: 'duplicate-pr-first' })
      const second = await setupClaimedTask(app, poster, { title: 'duplicate-pr-second' })
      const sharedPrUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/41`

      const submittedFirst = await mcpSubmitPr(app, first.key.identity, { taskId: first.brief.id, prUrl: sharedPrUrl, summary: '任务一' })
      assertToolOk(submittedFirst.result)

      const submittedSecond = await mcpSubmitPr(app, second.key.identity, { taskId: second.brief.id, prUrl: sharedPrUrl, summary: '任务二冒用' })
      const body = assertToolError(submittedSecond.result)
      assert.equal(typeof body.error, 'string', 'a duplicate live pr_url across tasks must carry a typed error')

      const db = openDb(t, sqlitePath)
      const secondTask = taskRow(db, second.brief.id)
      assert.equal(secondTask.status, '进行中', 'the second task must never advance on a pr_url already held live by another task')
      assert.equal(submissionRows(db, secondTask.id).length, 0)

      const firstTask = taskRow(db, first.brief.id)
      assert.equal(submissionRows(db, firstTask.id).length, 1, "the first task's submission must remain the sole live claim on this pr_url")
    })

    test('once the first task\'s submission is terminal (merged), a second task may reuse the same pr_url', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const first = await setupClaimedTask(app, poster, { title: 'duplicate-pr-terminal-first' })
      const second = await setupClaimedTask(app, poster, { title: 'duplicate-pr-terminal-second' })
      const sharedPrUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/42`

      const submittedFirst = await mcpSubmitPr(app, first.key.identity, { taskId: first.brief.id, prUrl: sharedPrUrl, summary: '任务一' })
      assertToolOk(submittedFirst.result)

      const db = openDb(t, sqlitePath)
      const firstTaskPk = taskRow(db, first.brief.id).id
      db.$client.prepare("UPDATE submissions SET pr_state = 'merged' WHERE task_id = ?").run(firstTaskPk)

      const submittedSecond = await mcpSubmitPr(app, second.key.identity, { taskId: second.brief.id, prUrl: sharedPrUrl, summary: '任务二复用' })
      const body = assertToolOk(submittedSecond.result)
      assert.equal(body.task.status, '待验收', `reusing a pr_url once the earlier submission is terminal must succeed, got ${JSON.stringify(submittedSecond.result)}`)
    })
  })

  describe('canonicalization — the stored pr_url absorbs decoration, proven via idempotent matching across variants', () => {
    async function submitDecoratedVariants(app, key, taskId, baseUrl, decorations) {
      const results = []
      for (const decoration of decorations) {
        const called = await mcpSubmitPr(app, key.identity, { taskId, prUrl: `${baseUrl}${decoration}`, summary: '同一个 PR' })
        results.push(called)
      }
      return results
    }

    test('gitea: trailing slash, query string, and a /commits suffix all resolve to the same stored canonical pr_url', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'canon-gitea' })
      const bareUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/51`

      const results = await submitDecoratedVariants(app, setup.key, setup.brief.id, bareUrl, ['?tab=diff', '/', '/commits'])
      for (const [i, called] of results.entries()) {
        assertToolOk(called.result, `decorated submit #${i} must succeed (idempotent match against the canonical form)`)
      }

      const db = openDb(t, sqlitePath)
      const rows = submissionRows(db, taskRow(db, setup.brief.id).id)
      assert.equal(rows.length, 1, `differently-decorated submissions of the same real PR must collapse to one canonical row, got ${JSON.stringify(rows)}`)
      assert.equal(rows[0].pr_url, bareUrl, `the stored pr_url must be the bare canonical form, got ${rows[0].pr_url}`)
    })

    test('github: trailing slash, fragment, and a /files suffix all resolve to the same stored canonical pr_url', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      allowForgeToken(stub, GITHUB_FORGE_TOKEN)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'canon-github',
          repo: { forge: 'github', base_url: GITHUB_FORGE_BASE_URL, full_name: GITHUB_REPO_FULL_NAME, base_branch: 'main', suggested_dir: 'widget' },
          credential: { token: GITHUB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'canon-github')
      const claimed = await restClaim(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)
      const bareUrl = `${GITHUB_FORGE_BASE_URL}/${GITHUB_REPO_FULL_NAME}/pull/52`

      const results = await submitDecoratedVariants(app, key, brief.id, bareUrl, ['/', '#discussion_r1', '/files'])
      for (const [i, called] of results.entries()) {
        assertToolOk(called.result, `decorated submit #${i} must succeed`)
      }

      const db = openDb(t, sqlitePath)
      const rows = submissionRows(db, taskRow(db, brief.id).id)
      assert.equal(rows.length, 1, `expected one canonical row, got ${JSON.stringify(rows)}`)
      assert.equal(rows[0].pr_url, bareUrl, `the stored pr_url must be the bare canonical form, got ${rows[0].pr_url}`)
    })

    test('gitlab (subgroup): trailing slash, query string, and fragment all resolve to the same stored canonical pr_url', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      allowForgeToken(stub, GITLAB_FORGE_TOKEN, { repo: GITLAB_REPO_ACCESS })
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'canon-gitlab-subgroup',
          repo: { forge: 'gitlab', base_url: GITLAB_FORGE_BASE_URL, full_name: GITLAB_SUBGROUP_FULL_NAME, base_branch: 'main', suggested_dir: 'app' },
          credential: { token: GITLAB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'canon-gitlab-subgroup')
      const claimed = await restClaim(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)
      const bareUrl = `${GITLAB_FORGE_BASE_URL}/${GITLAB_SUBGROUP_FULL_NAME}/-/merge_requests/53`

      const results = await submitDecoratedVariants(app, key, brief.id, bareUrl, ['?tab=diffs', '/', '#note_1'])
      for (const [i, called] of results.entries()) {
        assertToolOk(called.result, `decorated submit #${i} must succeed`)
      }

      const db = openDb(t, sqlitePath)
      const rows = submissionRows(db, taskRow(db, brief.id).id)
      assert.equal(rows.length, 1, `expected one canonical row, got ${JSON.stringify(rows)}`)
      assert.equal(rows[0].pr_url, bareUrl, `the stored pr_url must be the bare canonical form, got ${rows[0].pr_url}`)
    })
  })

  describe('canonicalization round trip — webhook delivery of a real forge-shaped (bare) URL still matches the stored value', () => {
    test('gitea: a webhook delivery carrying the bare PR URL matches the canonical stored value and completes the task', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app } = await boot(t, sqlitePath, {
        forgeInstances: [{ publicId: GITEA_INSTANCE_ID, forge: 'gitea', baseUrl: FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITEA_WEBHOOK_SECRET }],
      })
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'webhook-canon-gitea' })
      const bareUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/61`

      const submitted = await mcpSubmitPr(app, setup.key.identity, { taskId: setup.brief.id, prUrl: `${bareUrl}?tab=diff`, summary: '装饰过的提交' })
      assertToolOk(submitted.result)

      const rawBody = JSON.stringify(giteaPrPayload({ merged: true, prUrl: bareUrl }))
      const res = await postGiteaWebhook(app, GITEA_INSTANCE_ID, { secret: GITEA_WEBHOOK_SECRET, rawBody })
      assert.equal(res.statusCode, 204, `webhook delivery: ${res.statusCode} ${res.body}`)

      const db = openDb(t, sqlitePath)
      assert.equal(
        taskRow(db, setup.brief.id).status,
        '已完成',
        'a webhook delivering the bare (real forge) URL must match the canonical stored pr_url and complete the task',
      )
    })

    test('github: a webhook delivery carrying the bare PR URL matches the canonical stored value and completes the task', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath, {
        forgeInstances: [{ publicId: GITHUB_INSTANCE_ID, forge: 'github', baseUrl: GITHUB_FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITHUB_WEBHOOK_SECRET }],
      })
      allowForgeToken(stub, GITHUB_FORGE_TOKEN)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'webhook-canon-github',
          repo: { forge: 'github', base_url: GITHUB_FORGE_BASE_URL, full_name: GITHUB_REPO_FULL_NAME, base_branch: 'main', suggested_dir: 'widget' },
          credential: { token: GITHUB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'webhook-canon-github')
      const claimed = await restClaim(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)
      const bareUrl = `${GITHUB_FORGE_BASE_URL}/${GITHUB_REPO_FULL_NAME}/pull/62`

      const submitted = await mcpSubmitPr(app, key.identity, { taskId: brief.id, prUrl: `${bareUrl}/`, summary: '装饰过的提交' })
      assertToolOk(submitted.result)

      const rawBody = JSON.stringify(githubPrPayload({ merged: true, prUrl: bareUrl }))
      const res = await postGithubWebhook(app, GITHUB_INSTANCE_ID, { secret: GITHUB_WEBHOOK_SECRET, rawBody })
      assert.equal(res.statusCode, 204, `webhook delivery: ${res.statusCode} ${res.body}`)

      const db = openDb(t, sqlitePath)
      assert.equal(taskRow(db, brief.id).status, '已完成')
    })

    test('gitlab: a webhook delivery carrying the bare MR URL matches the canonical stored value and completes the task', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath, {
        forgeInstances: [{ publicId: GITLAB_INSTANCE_ID, forge: 'gitlab', baseUrl: GITLAB_FORGE_BASE_URL, syncMode: 'webhook', webhookSecret: GITLAB_WEBHOOK_SECRET }],
      })
      allowForgeToken(stub, GITLAB_FORGE_TOKEN, { repo: GITLAB_REPO_ACCESS })
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'webhook-canon-gitlab',
          repo: { forge: 'gitlab', base_url: GITLAB_FORGE_BASE_URL, full_name: GITLAB_SUBGROUP_FULL_NAME, base_branch: 'main', suggested_dir: 'app' },
          credential: { token: GITLAB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'webhook-canon-gitlab')
      const claimed = await restClaim(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)
      const bareUrl = `${GITLAB_FORGE_BASE_URL}/${GITLAB_SUBGROUP_FULL_NAME}/-/merge_requests/63`

      const submitted = await mcpSubmitPr(app, key.identity, { taskId: brief.id, prUrl: `${bareUrl}#note_1`, summary: '装饰过的提交' })
      assertToolOk(submitted.result)

      const rawBody = JSON.stringify(gitlabMrPayload({ state: 'merged', mrUrl: bareUrl }))
      const res = await postGitlabWebhook(app, GITLAB_INSTANCE_ID, { secret: GITLAB_WEBHOOK_SECRET, rawBody })
      assert.equal(res.statusCode, 204, `webhook delivery: ${res.statusCode} ${res.body}`)

      const db = openDb(t, sqlitePath)
      assert.equal(taskRow(db, brief.id).status, '已完成')
    })
  })

  describe('canonicalization round trip — the poller resolves the canonical stored value against the real PR/MR API', () => {
    test('gitea: the poller resolves the stored canonical pr_url and completes a merged PR', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      const poster = await loginGitea(app)
      const setup = await setupClaimedTask(app, poster, { title: 'poller-canon-gitea' })
      const submitted = await mcpSubmitPr(app, setup.key.identity, {
        taskId: setup.brief.id,
        prUrl: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/71/commits`,
        summary: '装饰过的提交',
      })
      assertToolOk(submitted.result)

      stub.pr.set('71', { status: 200, body: { merged: true, state: 'closed' } })
      const db = openDb(t, sqlitePath)
      await pollPendingReviews(db)

      assert.equal(
        taskRow(db, setup.brief.id).status,
        '已完成',
        'the poller must successfully resolve the stored (canonical) pr_url against the real PR-status endpoint',
      )
    })

    test('github: the poller resolves the stored canonical pr_url and completes a merged PR', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      allowForgeToken(stub, GITHUB_FORGE_TOKEN)
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'poller-canon-github',
          repo: { forge: 'github', base_url: GITHUB_FORGE_BASE_URL, full_name: GITHUB_REPO_FULL_NAME, base_branch: 'main', suggested_dir: 'widget' },
          credential: { token: GITHUB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'poller-canon-github')
      const claimed = await restClaim(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)
      const submitted = await mcpSubmitPr(app, key.identity, {
        taskId: brief.id,
        prUrl: `${GITHUB_FORGE_BASE_URL}/${GITHUB_REPO_FULL_NAME}/pull/72/files`,
        summary: '装饰过的提交',
      })
      assertToolOk(submitted.result)

      stub.pr.set('72', { status: 200, body: { merged: true, state: 'closed' } })
      const db = openDb(t, sqlitePath)
      await pollPendingReviews(db)

      assert.equal(taskRow(db, brief.id).status, '已完成')
    })

    test('gitlab (subgroup): the poller resolves the stored canonical MR url and completes a merged MR', async (t) => {
      const sqlitePath = sqliteFile(t)
      const { app, stub } = await boot(t, sqlitePath)
      allowForgeToken(stub, GITLAB_FORGE_TOKEN, { repo: GITLAB_REPO_ACCESS })
      const poster = await loginGitea(app)
      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          title: 'poller-canon-gitlab',
          repo: { forge: 'gitlab', base_url: GITLAB_FORGE_BASE_URL, full_name: GITLAB_SUBGROUP_FULL_NAME, base_branch: 'main', suggested_dir: 'app' },
          credential: { token: GITLAB_FORGE_TOKEN },
        }),
      )
      const key = await mintAgentKey(app, poster.cookies, 'poller-canon-gitlab')
      const claimed = await restClaim(app, { identity: key.identity, publicId: brief.id })
      assert.equal(claimed.statusCode, 201, `setup claim: ${claimed.statusCode} ${claimed.body}`)
      const submitted = await mcpSubmitPr(app, key.identity, {
        taskId: brief.id,
        prUrl: `${GITLAB_FORGE_BASE_URL}/${GITLAB_SUBGROUP_FULL_NAME}/-/merge_requests/73/diffs`,
        summary: '装饰过的提交',
      })
      assertToolOk(submitted.result)

      stub.pr.set('73', { status: 200, body: { state: 'merged' } })
      const db = openDb(t, sqlitePath)
      await pollPendingReviews(db)

      assert.equal(taskRow(db, brief.id).status, '已完成')
    })
  })
})
