import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.ts'
import { pollPendingReviews, retryPendingWritebacks } from './poller.ts'
import { settleWritebacks } from './writeback.ts'
import { injectSigned, pairDeviceToClaimant } from './device-proof.test-helpers.ts'
import { ensureSetup } from './auth.test-helpers.ts'

// Issue #53 — the in-Kaola review loop, driven end to end through the real HTTP + MCP surface
// (buildApp, device proof, Streamable HTTP MCP) with only the third-party forge stubbed. Seams
// are copied from poller.test.ts per this codebase's house style (never imported cross-file).
//
// Custody note: this file is the acceptance oracle for DESIGN §17 / issue #53 phases 2, 3, 4
// (server half) and 5. An implementer may not weaken or reinterpret it to pass.

const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'ef'.repeat(32)

const FORGE_BASE_URL = 'https://gitea.review.example.test'
const REPO_FULL_NAME = 'team/orders'
const INLINE_TOKEN = 'gitea-REVIEW-INLINE-TOKEN-zz91'
const SECRET_NEEDLES = [INLINE_TOKEN, 'token_encrypted', 'inline_token_encrypted', 'access_token']

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
  delete process.env.KAOLA_REVIEW_SUMMARY_COMMENT
}

applyOauthTestEnv()

const { buildApp } = await import('./app.ts')

const jsonHeaders = { accept: 'application/json', 'content-type': 'application/json' }

// ---------------------------------------------------------------------------------------------
// Forge stub
// ---------------------------------------------------------------------------------------------

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
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? undefined
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
  if (input && typeof input === 'object' && 'headers' in input) return headerValue(input.headers, name)
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
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function isPrEndpoint(url) {
  return /\/(?:pulls|merge_requests)\/\d+(?:[/?#]|$)/u.test(url)
}

function isIssueCommentsEndpoint(url) {
  return /\/issues\/\d+\/comments(?:[?#]|$)/u.test(url)
}

function isRepoEndpoint(url) {
  return (url.includes('/repos/') || url.includes('/projects/')) && !isPrEndpoint(url) && !isIssueCommentsEndpoint(url)
}

function isUserEndpoint(url) {
  return url.endsWith('/user') && !isPrEndpoint(url)
}

function prNumberFromUrl(url) {
  const path = new URL(url).pathname
  const match = path.match(/\/(?:pulls|merge_requests)\/(\d+)$/u)
  return match ? match[1] : undefined
}

function prBody(number, overrides = {}) {
  return {
    number: Number(number),
    state: 'open',
    merged: false,
    title: `WIP: [kt] change ${number}`,
    head: { sha: `sha-${number}-1`, ref: `kaola/branch-${number}` },
    ...overrides,
  }
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
    const method = requestMethod(input, init)
    const body = typeof init?.body === 'string' ? init.body : undefined
    requests.push({ url, method, body })

    if (isPrEndpoint(url)) {
      const number = prNumberFromUrl(url)
      const stub = number == null ? undefined : pr.get(number)
      if (stub == null) return jsonResponse(500, { error: 'unstubbed pr endpoint', url })
      if (stub.unreachable) throw new TypeError('fetch failed')
      if (method === 'PATCH' || method === 'PUT') {
        if (stub.patchStatus != null && stub.patchStatus !== 200) return jsonResponse(stub.patchStatus, { message: 'nope' })
        const parsed = body == null ? {} : JSON.parse(body)
        stub.body = { ...(stub.body ?? {}), ...parsed }
        return jsonResponse(200, stub.body)
      }
      return jsonResponse(stub.status ?? 200, stub.body ?? {})
    }
    if (isIssueCommentsEndpoint(url)) {
      return jsonResponse(201, { id: 1 })
    }

    const token = stubbedToken(input, init)
    const forgeStub = token == null ? undefined : forge.get(token)
    if (forgeStub != null) {
      if (isRepoEndpoint(url)) return jsonResponse(200, forgeStub.repo ?? {})
      if (isUserEndpoint(url)) return jsonResponse(200, { id: 4242, login: 'forge-bot' })
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

// ---------------------------------------------------------------------------------------------
// App / db / session / device helpers
// ---------------------------------------------------------------------------------------------

function sqliteFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-review-'))
  const sqlitePath = join(dir, 'kaola.sqlite')
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return sqlitePath
}

function openDb(t, sqlitePath) {
  const db = createDb(sqlitePath)
  t.after(() => {
    db.$client.close()
  })
  return db
}

async function boot(t) {
  const sqlitePath = sqliteFile(t)
  const app = buildApp({ sqlitePath })
  t.after(async () => {
    await app.close()
  })
  await app.ready()
  const stub = beginFetch(t)
  stub.forge.set(INLINE_TOKEN, { repo: REPO_FULL_ACCESS })
  const admin = await ensureSetup(app)
  const db = openDb(t, sqlitePath)
  return { app, stub, admin, db, sqlitePath }
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
    title: '评审循环任务',
    description_md: '……',
    source: { type: 'native' },
    repo: { forge: 'gitea', base_url: FORGE_BASE_URL, full_name: REPO_FULL_NAME, base_branch: 'main', suggested_dir: 'orders' },
    credential: { token: INLINE_TOKEN },
    ...overrides,
  }
}

async function createTaskOk(app, cookies, payload = taskPayload()) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/tasks', cookies, headers: jsonHeaders, payload })
  assert.equal(res.statusCode, 201, `POST /api/v1/tasks: ${res.statusCode} ${res.body}`)
  return jsonBody(res)
}

async function pairClaimantDevice(app, adminCookies, label) {
  const paired = await pairDeviceToClaimant(app, adminCookies, label, { hostname: label })
  return { identity: paired.identity, deviceId: paired.deviceId }
}

async function claimHttp(app, identity, publicId) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/claim`,
    payload: {},
    extraHeaders: jsonHeaders,
  })
}

async function claimOk(app, identity, publicId) {
  const res = await claimHttp(app, identity, publicId)
  assert.equal(res.statusCode, 201, `claim ${publicId}: ${res.statusCode} ${res.body}`)
  const body = jsonBody(res)
  assert.equal(typeof body.token, 'string')
  return body
}

async function progressHttp(app, identity, publicId, payload) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/progress`,
    payload,
    extraHeaders: jsonHeaders,
  })
}

async function releaseHttp(app, identity, publicId, payload = {}) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/release`,
    payload,
    extraHeaders: jsonHeaders,
  })
}

async function reviewGet(app, cookies, publicId) {
  return app.inject({ method: 'GET', url: `/api/v1/tasks/${publicId}/review`, cookies, headers: { accept: 'application/json' } })
}

async function reviewPost(app, cookies, publicId, action, payload) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${publicId}/review/${action}`,
    cookies,
    headers: jsonHeaders,
    payload: payload ?? {},
  })
}

async function postReviewerMessage(app, cookies, publicId, message) {
  const res = await reviewPost(app, cookies, publicId, 'messages', message)
  assert.equal(res.statusCode, 201, `review message: ${res.statusCode} ${res.body}`)
  return jsonBody(res)
}

// ---------------------------------------------------------------------------------------------
// MCP client (Streamable HTTP over device proof)
// ---------------------------------------------------------------------------------------------

async function postMcp(app, identity, sessionId, payload) {
  const extra = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
  if (sessionId != null) extra['mcp-session-id'] = sessionId
  return injectSigned(app, identity, { method: 'POST', url: MCP_PATH, payload, extraHeaders: extra })
}

function parseSseMessages(body) {
  const messages = []
  for (const chunk of String(body).split(/\r?\n\r?\n/)) {
    if (!chunk.trim()) continue
    let eventName = 'message'
    const dataParts = []
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataParts.push(line.slice('data:'.length).replace(/^\s/, ''))
    }
    if (eventName === 'message' && dataParts.length > 0) messages.push(JSON.parse(dataParts.join('\n')))
  }
  return messages
}

function parseJsonRpcHttp(res) {
  const contentType = String(res.headers['content-type'] ?? '')
  const body = String(res.body ?? '')
  if (contentType.includes('text/event-stream') || /^\s*event:/m.test(body)) {
    const messages = parseSseMessages(body)
    assert.ok(messages.length > 0, `expected SSE JSON-RPC payloads, status ${res.statusCode}: ${body}`)
    return messages
  }
  const parsed = JSON.parse(body)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function toolStructured(result) {
  if (result?.structuredContent != null) return result.structuredContent
  const texts = Array.isArray(result?.content) ? result.content.filter((b) => b?.type === 'text').map((b) => b.text) : []
  assert.ok(texts.length > 0, `tool result has no content: ${JSON.stringify(result)}`)
  return JSON.parse(texts[0])
}

async function mcpClient(app, identity) {
  let nextId = 1
  let sessionId
  const id = nextId++
  const init = await postMcp(app, identity, undefined, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'kaola-review-test', version: '0.0.0' } },
  })
  assert.equal(init.statusCode, 200, `MCP initialize: ${init.statusCode} ${init.body}`)
  const header = init.headers['mcp-session-id']
  if (header != null && header !== '') sessionId = String(header)
  await postMcp(app, identity, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    async call(name, args = {}) {
      const callId = nextId++
      const res = await postMcp(app, identity, sessionId, {
        jsonrpc: '2.0',
        id: callId,
        method: 'tools/call',
        params: { name, arguments: args },
      })
      assert.equal(res.statusCode, 200, `tools/call ${name}: ${res.statusCode} ${res.body}`)
      const rpc = parseJsonRpcHttp(res).find((m) => m && m.id === callId)
      assert.ok(rpc, `no JSON-RPC result for ${name}`)
      assert.equal(rpc.error, undefined, `tools/call ${name} protocol error: ${JSON.stringify(rpc.error)}`)
      return { isError: rpc.result?.isError === true, body: toolStructured(rpc.result), raw: res.body }
    },
    async ok(name, args = {}) {
      const called = await this.call(name, args)
      assert.equal(called.isError, false, `${name} expected success, got ${JSON.stringify(called.body)}`)
      return called.body
    },
    async err(name, args = {}) {
      const called = await this.call(name, args)
      assert.equal(called.isError, true, `${name} expected isError, got ${JSON.stringify(called.body)}`)
      return called.body
    },
  }
}

// ---------------------------------------------------------------------------------------------
// DB probes
// ---------------------------------------------------------------------------------------------

function taskRow(db, publicId) {
  return db.$client.prepare('SELECT id, public_id, status, parent_task_id FROM tasks WHERE public_id = ?').get(publicId)
}

function submissionRow(db, taskPk) {
  return db.$client.prepare('SELECT * FROM submissions WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskPk)
}

function eventRows(db) {
  return db.$client
    .prepare('SELECT id, type, actor_user_id, details FROM events ORDER BY id')
    .all()
    .map((row) => ({ ...row, details: JSON.parse(row.details) }))
}

function eventsFor(db, publicId, type) {
  return eventRows(db).filter((e) => e.details?.task_id === publicId && (type == null || e.type === type))
}

function activeLeases(db, taskPk) {
  return db.$client.prepare("SELECT id FROM leases WHERE task_id = ? AND state = 'active'").all(taskPk)
}

function assertNoSecrets(label, ...values) {
  const text = JSON.stringify(values)
  for (const needle of SECRET_NEEDLES) {
    assert.equal(text.includes(needle), false, `${label} must not contain ${needle}`)
  }
}

// Puts one task through create → claim → submit_pr (Draft) and returns everything a review test needs.
async function deliverDraft(app, stub, admin, { title = '评审循环任务', prNumber, headSha, parentPublicId } = {}) {
  const brief = await createTaskOk(app, admin.cookies, taskPayload({ title, ...(parentPublicId ? { parent_task_id: parentPublicId } : {}) }))
  const agent = await pairClaimantDevice(app, admin.cookies, `agent-${prNumber}`)
  const claim = await claimOk(app, agent.identity, brief.id)
  const mcp = await mcpClient(app, agent.identity)
  const prUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/${prNumber}`
  stub.pr.set(String(prNumber), { body: prBody(prNumber, headSha ? { head: { sha: headSha, ref: `kaola/branch-${prNumber}` } } : {}) })
  const submitted = await mcp.ok('submit_pr', {
    task_id: brief.id,
    pr_url: prUrl,
    summary: '首次交付（Draft）',
    claim_id: claim.lease.claim_id,
    ...(headSha ? { head_sha: headSha } : {}),
  })
  assert.equal(submitted.task.status, '待验收')
  return { brief, agent, claim, mcp, prUrl, prNumber: String(prNumber) }
}

// ---------------------------------------------------------------------------------------------

describe('issue #53 review loop', { concurrency: false }, () => {
  test('full multi-round loop: submit_pr → blocking round → 待修改 → revision Claim → submit_revision → 通过 → 翻 ready → merged → 已完成, with events at every step and no token anywhere', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const first = await deliverDraft(app, stub, admin, { prNumber: 101, headSha: 'sha-101-1' })
    const publicId = first.brief.id
    const pk = taskRow(db, publicId).id

    const sub0 = submissionRow(db, pk)
    assert.equal(sub0.head_sha, 'sha-101-1')
    assert.equal(sub0.is_draft, 1)
    assert.equal(sub0.review_round, 0)
    assert.equal(activeLeases(db, pk).length, 0, 'submit_pr releases the lease')

    // Same Claim + same URL repeated is still #31's idempotent 200, not a new submission.
    const again = await first.mcp.ok('submit_pr', { task_id: publicId, pr_url: first.prUrl, summary: 'x', claim_id: first.claim.lease.claim_id })
    assert.equal(again.pr_url, first.prUrl)

    // Reviewer writes two blocking + one suggestion (unrounded), then submits the round.
    const b1 = await postReviewerMessage(app, admin.cookies, publicId, {
      body_md: '分页边界少了 page=0 的处理',
      kind: 'blocking',
      anchor: { path: 'src/api/export.ts', line: 42, head_sha: 'sha-101-1', url: `${first.prUrl}/files` },
    })
    assert.equal(b1.round, null)
    assert.equal(b1.author_kind, 'reviewer')
    assert.deepEqual(b1.anchor, { path: 'src/api/export.ts', line: 42, head_sha: 'sha-101-1', url: `${first.prUrl}/files` })
    const b2 = await postReviewerMessage(app, admin.cookies, publicId, { body_md: '缺少单元测试', kind: 'blocking' })
    const s1 = await postReviewerMessage(app, admin.cookies, publicId, { body_md: '变量命名可以更清楚', kind: 'suggestion' })

    const viewBefore = jsonBody(await reviewGet(app, admin.cookies, publicId))
    assert.equal(viewBefore.round, 0)
    assert.equal(viewBefore.status, '待验收')
    assert.equal(viewBefore.pr_url, first.prUrl)
    assert.equal(viewBefore.head_sha, 'sha-101-1')
    assert.equal(viewBefore.current.blocking.length, 2)
    assert.equal(viewBefore.current.non_blocking.length, 1)
    assert.equal(viewBefore.current.verdict, null)
    assert.equal(viewBefore.messages.length, 3)
    assertNoSecrets('review view', viewBefore)

    const rounded = await reviewPost(app, admin.cookies, publicId, 'rounds')
    assert.equal(rounded.statusCode, 201, rounded.body)
    const roundBody = jsonBody(rounded)
    assert.equal(roundBody.task.status, '待修改')
    assert.equal(roundBody.round.round, 1)
    assert.equal(roundBody.round.kind, 'review')
    assert.equal(roundBody.round.verdict, 'changes_requested')
    assert.equal(roundBody.round.opened_by, admin.body.username)
    assert.equal(roundBody.current.round, 1)
    assert.equal(roundBody.current.blocking.length, 2)
    assert.equal(taskRow(db, publicId).status, '待修改')
    assert.equal(submissionRow(db, pk).review_round, 1)
    assert.equal(eventsFor(db, publicId, '评审开轮').length, 1)
    assert.deepEqual(eventsFor(db, publicId, '评审开轮')[0].details, { task_id: publicId, round: 1, kind: 'review', verdict: 'changes_requested' })
    assert.ok(eventsFor(db, publicId, '状态迁移').some((e) => e.details.from === '待验收' && e.details.to === '待修改'))

    // A different device (another claimant) claims the 待修改 task: revision Claim, same envelope.
    const revisor = await pairClaimantDevice(app, admin.cookies, 'revisor')
    const revisionClaim = await claimOk(app, revisor.identity, publicId)
    assert.equal(revisionClaim.task.status, '进行中')
    assert.equal(revisionClaim.task.review_round, 1, 'review_round > 0 marks the revision Claim')
    assert.equal(revisionClaim.task.pr_convention.draft, true)
    assert.deepEqual(Object.keys(revisionClaim).sort(), ['clone', 'lease', 'task', 'token'])
    const listed = await first.mcp.ok('list_tasks', { status: '进行中' })
    assert.equal(listed.tasks[0].review_round, 1)
    assert.equal(listed.tasks[0].parent_task_id, null)

    const revMcp = await mcpClient(app, revisor.identity)
    // A NEW Claim may not open a second submission: the revision loop owns the task now.
    const secondSubmit = await revMcp.err('submit_pr', { task_id: publicId, pr_url: first.prUrl, summary: 'x', claim_id: revisionClaim.lease.claim_id })
    assert.equal(secondSubmit.error, 'use_submit_revision')
    assert.equal(taskRow(db, publicId).status, '进行中')
    const feedback = await revMcp.ok('get_review_feedback', { task_id: publicId })
    assert.equal(feedback.round, 1)
    assert.equal(feedback.kind, 'review')
    assert.equal(feedback.verdict, 'changes_requested')
    assert.equal(feedback.head_sha, 'sha-101-1')
    assert.equal(feedback.base_branch, 'main')
    assert.equal(feedback.pr_url, first.prUrl)
    assert.equal(feedback.source_trust, 'internal')
    assert.deepEqual(feedback.blocking.map((m) => m.id), [b1.id, b2.id])
    assert.deepEqual(feedback.blocking.map((m) => m.resolved), [false, false])
    assert.deepEqual(feedback.non_blocking.map((m) => m.id), [s1.id])
    assert.equal(feedback.thread.length, 3)
    assert.deepEqual(
      Object.keys(feedback).sort(),
      ['base_branch', 'blocking', 'head_sha', 'kind', 'non_blocking', 'pr_url', 'round', 'source_trust', 'task_id', 'thread', 'verdict'],
    )
    assertNoSecrets('get_review_feedback', feedback)

    // Agent resolves the first blocking item, answers the suggestion.
    const resolution = await revMcp.ok('post_discussion_message', {
      task_id: publicId,
      claim_id: revisionClaim.lease.claim_id,
      body_md: '已补 page=0 分支',
      kind: 'resolution',
      resolves: b1.id,
    })
    assert.equal(resolution.author_kind, 'agent')
    assert.equal(resolution.author, 'revisor')
    const answer = await revMcp.ok('post_discussion_message', {
      task_id: publicId,
      claim_id: revisionClaim.lease.claim_id,
      body_md: '命名已调整',
      kind: 'answer',
      reply_to: s1.id,
    })
    assert.equal(answer.reply_to, s1.id)
    const afterResolve = await revMcp.ok('get_review_feedback', { task_id: publicId, round: 1 })
    assert.deepEqual(afterResolve.blocking.map((m) => m.resolved), [true, false])
    // resolves must point at a blocking message of this task.
    const badResolve = await revMcp.err('post_discussion_message', {
      task_id: publicId,
      claim_id: revisionClaim.lease.claim_id,
      body_md: 'x',
      kind: 'resolution',
      resolves: s1.id,
    })
    assert.equal(badResolve.error, 'invalid_body')

    // Heartbeat with percent / phase.
    const hb = await revMcp.ok('report_progress', { task_id: publicId, claim_id: revisionClaim.lease.claim_id, note: '改中', percent: 40, phase: '跑测试' })
    assert.equal(hb.task.status, '进行中')
    const heartbeat = eventsFor(db, publicId, '心跳').at(-1)
    assert.deepEqual(heartbeat.details, { task_id: publicId, note: '改中', percent: 40, phase: '跑测试' })

    // submit_revision error paths, then the real hand-back.
    const sameHead = await revMcp.err('submit_revision', { task_id: publicId, claim_id: revisionClaim.lease.claim_id, pr_url: first.prUrl, head_sha: 'sha-101-1', summary: '无变化' })
    assert.equal(sameHead.error, 'head_sha_unchanged')
    const otherPr = await revMcp.err('submit_revision', { task_id: publicId, claim_id: revisionClaim.lease.claim_id, pr_url: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/999`, head_sha: 'sha-101-2', summary: '另开 PR' })
    assert.equal(otherPr.error, 'pr_url_invalid')
    assert.equal(taskRow(db, publicId).status, '进行中', 'rejected revisions never move the task')

    const revised = await revMcp.ok('submit_revision', { task_id: publicId, claim_id: revisionClaim.lease.claim_id, pr_url: `${first.prUrl}/files`, head_sha: 'sha-101-2', summary: '第一轮修订' })
    assert.equal(revised.task.status, '待验收')
    assert.equal(revised.pr_url, first.prUrl, 'pr_url is the canonical first-submission URL')
    assert.equal(revised.head_sha, 'sha-101-2')
    assert.equal(revised.round, 1)
    assert.equal(activeLeases(db, pk).length, 0, 'submit_revision releases the lease')
    assert.equal(submissionRow(db, pk).head_sha, 'sha-101-2')
    const revisionRows = db.$client.prepare('SELECT * FROM submission_revisions WHERE submission_id = ?').all(sub0.id)
    assert.equal(revisionRows.length, 1)
    assert.equal(revisionRows[0].head_sha, 'sha-101-2')
    assert.equal(revisionRows[0].round, 1)
    const roundRow = db.$client.prepare('SELECT * FROM review_rounds WHERE task_id = ? AND round = 1').get(pk)
    assert.equal(roundRow.revision_head_sha, 'sha-101-2')
    assert.ok(roundRow.revised_at > 0)
    assert.equal(eventsFor(db, publicId, '评审交回').length, 1)
    assert.deepEqual(eventsFor(db, publicId, '评审交回')[0].details, { task_id: publicId, round: 1, head_sha: 'sha-101-2' })

    // Same Claim + same head repeated → idempotent 200.
    const repeat = await revMcp.ok('submit_revision', { task_id: publicId, claim_id: revisionClaim.lease.claim_id, pr_url: first.prUrl, head_sha: 'sha-101-2', summary: '重复' })
    assert.equal(repeat.head_sha, 'sha-101-2')
    assert.equal(eventsFor(db, publicId, '评审交回').length, 1, 'idempotent repeat writes no second event')
    // A stale Claim (released) can no longer post.
    const stale = await revMcp.err('post_discussion_message', { task_id: publicId, claim_id: revisionClaim.lease.claim_id, body_md: 'late', kind: 'note' })
    assert.equal(stale.error, 'stale_claim')

    // 「通过」: 待验收 → 待合并, then the Draft flips to ready off the response path.
    stub.pr.set(first.prNumber, { body: prBody(101, { title: 'WIP: [kt] change 101', head: { sha: 'sha-101-2', ref: 'kaola/branch-101' } }) })
    const approved = await reviewPost(app, admin.cookies, publicId, 'approve')
    assert.equal(approved.statusCode, 200, approved.body)
    const approvedBody = jsonBody(approved)
    assert.equal(approvedBody.task.status, '待合并')
    assert.equal(approvedBody.round.round, 2)
    assert.equal(approvedBody.round.verdict, 'approved')
    assert.equal(taskRow(db, publicId).status, '待合并')
    assert.deepEqual(eventsFor(db, publicId, '评审通过')[0].details, {
      task_id: publicId,
      round: 2,
      pr_url: first.prUrl,
      head_sha: 'sha-101-2',
      head_verified: true,
    })
    await settleWritebacks()
    const patch = stub.requests.find((r) => r.method === 'PATCH' && r.url.includes('/pulls/101'))
    assert.ok(patch, `expected a PATCH flipping the Gitea WIP title, got ${JSON.stringify(stub.requests.map((r) => `${r.method} ${r.url}`))}`)
    assert.deepEqual(JSON.parse(patch.body), { title: '[kt] change 101' })
    const ready = eventsFor(db, publicId, '回写').filter((e) => e.details.transition === '翻ready')
    assert.equal(ready.length, 1)
    assert.deepEqual(ready[0].details, { task_id: publicId, transition: '翻ready', ok: true, pr_url: first.prUrl })
    assert.equal(stub.requests.some((r) => r.url.includes('/issues/101/comments')), false, 'summary comment is off by default')

    // The human merges on the forge; the poller completes the task.
    stub.pr.set(first.prNumber, { body: prBody(101, { state: 'closed', merged: true, title: '[kt] change 101', head: { sha: 'sha-101-2', ref: 'kaola/branch-101' } }) })
    await pollPendingReviews(db)
    assert.equal(taskRow(db, publicId).status, '已完成')
    assert.equal(submissionRow(db, pk).pr_state, 'merged')
    const transitions = eventsFor(db, publicId, '状态迁移').map((e) => `${e.details.from}→${e.details.to}`)
    assert.deepEqual(transitions, ['待认领→进行中', '进行中→待验收', '待验收→待修改', '待修改→进行中', '进行中→待验收', '待验收→待合并', '待合并→已完成'])

    const finalView = jsonBody(await reviewGet(app, admin.cookies, publicId))
    assert.equal(finalView.rounds.length, 2)
    assert.equal(finalView.messages.length, 5)
    assertNoSecrets('final review view + events', finalView, eventRows(db), feedback, revised, approvedBody)
  })

  test('a round with no blocking item is recorded but leaves the task in 待验收; no pending messages is 409', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 102 })
    const empty = await reviewPost(app, admin.cookies, d.brief.id, 'rounds')
    assert.equal(empty.statusCode, 409)
    assert.deepEqual(jsonBody(empty), { error: 'no_pending_messages', message: '没有待提交的评审意见。' })

    await postReviewerMessage(app, admin.cookies, d.brief.id, { body_md: '建议加日志', kind: 'suggestion' })
    const rounded = await reviewPost(app, admin.cookies, d.brief.id, 'rounds')
    assert.equal(rounded.statusCode, 201)
    assert.equal(jsonBody(rounded).task.status, '待验收')
    assert.equal(jsonBody(rounded).round.verdict, null)
    assert.equal(taskRow(db, d.brief.id).status, '待验收')
    assert.equal(submissionRow(db, taskRow(db, d.brief.id).id).review_round, 1)
    assert.equal(eventsFor(db, d.brief.id, '状态迁移').some((e) => e.details.to === '待修改'), false)
  })

  test('a revision Claim released or expired mid-way returns the task to 待修改, never 待认领', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 103 })
    await postReviewerMessage(app, admin.cookies, d.brief.id, { body_md: '阻塞', kind: 'blocking' })
    assert.equal((await reviewPost(app, admin.cookies, d.brief.id, 'rounds')).statusCode, 201)

    const dev = await pairClaimantDevice(app, admin.cookies, 'release-agent')
    const c1 = await claimOk(app, dev.identity, d.brief.id)
    const released = await releaseHttp(app, dev.identity, d.brief.id, { reason: '先放弃', claim_id: c1.lease.claim_id })
    assert.equal(released.statusCode, 200, released.body)
    assert.equal(jsonBody(released).task.status, '待修改')
    assert.deepEqual(eventsFor(db, d.brief.id, '状态迁移').at(-1).details, { task_id: d.brief.id, from: '进行中', to: '待修改', reason: '先放弃' })

    const c2 = await claimOk(app, dev.identity, d.brief.id)
    assert.equal(c2.task.status, '进行中')
    db.$client.prepare("UPDATE leases SET expires_at = 1 WHERE state = 'active'").run()
    const list = await app.inject({ method: 'GET', url: '/api/v1/tasks', cookies: admin.cookies, headers: { accept: 'application/json' } })
    const listed = jsonBody(list).tasks.find((x) => x.id === d.brief.id)
    assert.equal(listed.status, '待修改', 'lease expiry with a submission parks the task in 待修改')
    assert.equal(taskRow(db, d.brief.id).status, '待修改')
  })

  test('withdraw 待合并 → 待修改; terminate from 待验收 / 待修改 / 待合并 → 已退回; closed PR while 待合并 → 已退回; merged while 待验收 is ignored', async (t) => {
    const { app, stub, admin, db } = await boot(t)

    const a = await deliverDraft(app, stub, admin, { prNumber: 111 })
    assert.equal((await reviewPost(app, admin.cookies, a.brief.id, 'withdraw')).statusCode, 409, 'withdraw needs 待合并')
    assert.equal((await reviewPost(app, admin.cookies, a.brief.id, 'approve')).statusCode, 200)
    await settleWritebacks()
    const withdrawn = await reviewPost(app, admin.cookies, a.brief.id, 'withdraw')
    assert.equal(withdrawn.statusCode, 200, withdrawn.body)
    assert.equal(jsonBody(withdrawn).task.status, '待修改')
    assert.equal(jsonBody(withdrawn).round.verdict, 'withdrawn')
    assert.equal(eventsFor(db, a.brief.id, '评审撤回').length, 1)
    const terminatedFromRevise = await reviewPost(app, admin.cookies, a.brief.id, 'terminate')
    assert.equal(terminatedFromRevise.statusCode, 200)
    assert.equal(jsonBody(terminatedFromRevise).task.status, '已退回')
    assert.equal(eventsFor(db, a.brief.id, '评审终止').length, 1)
    assert.equal((await reviewPost(app, admin.cookies, a.brief.id, 'terminate')).statusCode, 409, 'terminate is not repeatable from 已退回')

    const b = await deliverDraft(app, stub, admin, { prNumber: 112 })
    assert.equal(jsonBody(await reviewPost(app, admin.cookies, b.brief.id, 'terminate')).task.status, '已退回', 'terminate from 待验收')

    const c = await deliverDraft(app, stub, admin, { prNumber: 113 })
    assert.equal((await reviewPost(app, admin.cookies, c.brief.id, 'approve')).statusCode, 200)
    await settleWritebacks()
    assert.equal(jsonBody(await reviewPost(app, admin.cookies, c.brief.id, 'terminate')).task.status, '已退回', 'terminate from 待合并')

    const d = await deliverDraft(app, stub, admin, { prNumber: 114 })
    assert.equal((await reviewPost(app, admin.cookies, d.brief.id, 'approve')).statusCode, 200)
    await settleWritebacks()
    stub.pr.set('114', { body: prBody(114, { state: 'closed', merged: false }) })
    await pollPendingReviews(db)
    assert.equal(taskRow(db, d.brief.id).status, '已退回', 'PR closed while 待合并')

    const e = await deliverDraft(app, stub, admin, { prNumber: 115 })
    stub.pr.set('115', { body: prBody(115, { state: 'closed', merged: true }) })
    await pollPendingReviews(db)
    assert.equal(taskRow(db, e.brief.id).status, '待验收', 'a merge Kaola never approved leaves 待验收 untouched')
    assert.equal(eventsFor(db, e.brief.id, '状态迁移').some((x) => x.details.to === '已完成'), false)

    // The poller backfills head fields it learns from the forge.
    const f = await deliverDraft(app, stub, admin, { prNumber: 116 })
    const fpk = taskRow(db, f.brief.id).id
    assert.equal(submissionRow(db, fpk).head_sha, null)
    await pollPendingReviews(db)
    assert.equal(submissionRow(db, fpk).head_sha, 'sha-116-1')
    assert.equal(submissionRow(db, fpk).head_branch, 'kaola/branch-116')
    assert.equal(submissionRow(db, fpk).is_draft, 1)
  })

  test('review REST gates: no session 401, non-reviewer 403, wrong state 409, unknown task 404, bad body 400', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 121 })

    const anon = await app.inject({ method: 'GET', url: `/api/v1/tasks/${d.brief.id}/review`, headers: { accept: 'application/json' } })
    assert.equal(anon.statusCode, 401)
    const anonPost = await app.inject({ method: 'POST', url: `/api/v1/tasks/${d.brief.id}/review/approve`, headers: jsonHeaders, payload: {} })
    assert.equal(anonPost.statusCode, 401)

    // The session user's permission level is read per request, so flipping the row is enough to
    // exercise the reviewer gate without a second OAuth login (whose fetch stub would replace the
    // forge stub above).
    const adminId = admin.body.id
    db.$client.prepare("UPDATE users SET permission_level = 'full' WHERE id = ?").run(adminId)
    const asPublisher = await reviewPost(app, admin.cookies, d.brief.id, 'messages', { body_md: '发布者也能评审', kind: 'note' })
    assert.equal(asPublisher.statusCode, 201, `active+full is a reviewer: ${asPublisher.statusCode} ${asPublisher.body}`)
    db.$client.prepare("UPDATE users SET permission_level = 'claim_only' WHERE id = ?").run(adminId)
    for (const action of ['messages', 'rounds', 'approve', 'withdraw', 'terminate']) {
      const res = await reviewPost(app, admin.cookies, d.brief.id, action, { body_md: 'x', kind: 'note' })
      assert.equal(res.statusCode, 403, `${action} as claim_only: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'forbidden' })
    }
    const readOnly = await reviewGet(app, admin.cookies, d.brief.id)
    assert.equal(readOnly.statusCode, 200, 'any active user may read the review view')
    db.$client.prepare("UPDATE users SET permission_level = 'admin' WHERE id = ?").run(adminId)

    assert.equal((await reviewGet(app, admin.cookies, 'kt-1999-0001')).statusCode, 404)
    assert.equal((await reviewPost(app, admin.cookies, 'kt-1999-0001', 'approve')).statusCode, 404)
    for (const bad of [{}, { body_md: '', kind: 'note' }, { body_md: 'x', kind: 'shout' }, { body_md: 'x', kind: 'note', anchor: 'nope' }, { body_md: 'x', kind: 'note', resolves: 9999 }]) {
      const res = await reviewPost(app, admin.cookies, d.brief.id, 'messages', bad)
      assert.equal(res.statusCode, 400, `bad body ${JSON.stringify(bad)}: ${res.statusCode}`)
    }

    const fresh = await createTaskOk(app, admin.cookies, taskPayload({ title: '未提交' }))
    const notReviewable = await reviewPost(app, admin.cookies, fresh.id, 'messages', { body_md: 'x', kind: 'note' })
    assert.equal(notReviewable.statusCode, 409)
    assert.equal(jsonBody(notReviewable).error, 'illegal_transition')
    assert.equal((await reviewPost(app, admin.cookies, fresh.id, 'approve')).statusCode, 409)
    const view = jsonBody(await reviewGet(app, admin.cookies, fresh.id))
    assert.equal(view.pr_url, null)
    assert.equal(view.round, 0)
  })

  test('report_progress: percent out of range → 400; omitted keeps the legacy heartbeat shape; MCP tool mirrors it', async (t) => {
    const { app, admin, db } = await boot(t)
    const brief = await createTaskOk(app, admin.cookies)
    const dev = await pairClaimantDevice(app, admin.cookies, 'hb')
    const claim = await claimOk(app, dev.identity, brief.id)

    for (const percent of [101, -1, 1.5, '40']) {
      const res = await progressHttp(app, dev.identity, brief.id, { claim_id: claim.lease.claim_id, percent })
      assert.equal(res.statusCode, 400, `percent ${JSON.stringify(percent)}: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res).error, 'invalid_body')
    }
    const plain = await progressHttp(app, dev.identity, brief.id, { claim_id: claim.lease.claim_id, note: '照旧' })
    assert.equal(plain.statusCode, 200)
    assert.deepEqual(Object.keys(jsonBody(plain)).sort(), ['lease', 'task'])
    assert.deepEqual(eventsFor(db, brief.id, '心跳').at(-1).details, { task_id: brief.id, note: '照旧' })

    const mcp = await mcpClient(app, dev.identity)
    const bad = await mcp.err('report_progress', { task_id: brief.id, claim_id: claim.lease.claim_id, percent: 500 })
    assert.equal(bad.error, 'invalid_body')
    await mcp.ok('report_progress', { task_id: brief.id, claim_id: claim.lease.claim_id, percent: 0, phase: '开始' })
    assert.deepEqual(eventsFor(db, brief.id, '心跳').at(-1).details, { task_id: brief.id, note: '', percent: 0, phase: '开始' })
  })

  test('get_review_feedback needs no Claim; post_discussion_message needs the active Claim (409 stale_claim / wrong claim_id)', async (t) => {
    const { app, stub, admin } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 131 })
    const bystander = await pairClaimantDevice(app, admin.cookies, 'bystander')
    const mcp = await mcpClient(app, bystander.identity)
    const feedback = await mcp.ok('get_review_feedback', { task_id: d.brief.id })
    assert.equal(feedback.round, 0)
    assert.equal(feedback.verdict, null)
    assert.deepEqual(feedback.thread, [])
    const missing = await mcp.err('get_review_feedback', { task_id: 'kt-1999-0001' })
    assert.equal(missing.error, 'not_found')
    const tooFar = await mcp.err('get_review_feedback', { task_id: d.brief.id, round: 7 })
    assert.equal(tooFar.error, 'not_found')

    const noClaim = await mcp.err('post_discussion_message', { task_id: d.brief.id, claim_id: 'clm_nope', body_md: 'hi', kind: 'note' })
    assert.equal(noClaim.error, 'stale_claim')

    await postReviewerMessage(app, admin.cookies, d.brief.id, { body_md: '阻塞', kind: 'blocking' })
    await reviewPost(app, admin.cookies, d.brief.id, 'rounds')
    const claim = await claimOk(app, bystander.identity, d.brief.id)
    const wrongId = await mcp.err('post_discussion_message', { task_id: d.brief.id, claim_id: 'clm_wrong', body_md: 'hi', kind: 'note' })
    assert.equal(wrongId.error, 'stale_claim')
    const ok = await mcp.ok('post_discussion_message', { task_id: d.brief.id, claim_id: claim.lease.claim_id, body_md: '收到', kind: 'note' })
    assert.equal(ok.kind, 'note')
    assertNoSecrets('post_discussion_message', ok)
  })

  test('Draft → ready failure never rolls back 待合并 and is retried by the poller tick; summary comment is opt-in', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 141 })
    stub.pr.set('141', { body: prBody(141), patchStatus: 500 })
    assert.equal((await reviewPost(app, admin.cookies, d.brief.id, 'approve')).statusCode, 200)
    await settleWritebacks()
    assert.equal(taskRow(db, d.brief.id).status, '待合并')
    let ready = eventsFor(db, d.brief.id, '回写').filter((e) => e.details.transition === '翻ready')
    assert.deepEqual(ready.map((e) => e.details), [{ task_id: d.brief.id, transition: '翻ready', ok: false, ambiguous: true }])

    // Same outcome again writes no duplicate row; a definite 4xx supersedes it.
    await retryPendingWritebacks(db)
    ready = eventsFor(db, d.brief.id, '回写').filter((e) => e.details.transition === '翻ready')
    assert.equal(ready.length, 1)
    stub.pr.set('141', { body: prBody(141), patchStatus: 403 })
    await retryPendingWritebacks(db)
    ready = eventsFor(db, d.brief.id, '回写').filter((e) => e.details.transition === '翻ready')
    assert.equal(ready.length, 2)
    assert.equal(ready[1].details.ambiguous, false)

    process.env.KAOLA_REVIEW_SUMMARY_COMMENT = '1'
    t.after(() => {
      delete process.env.KAOLA_REVIEW_SUMMARY_COMMENT
    })
    stub.pr.set('141', { body: prBody(141) })
    await retryPendingWritebacks(db)
    ready = eventsFor(db, d.brief.id, '回写').filter((e) => e.details.transition === '翻ready')
    assert.equal(ready.at(-1).details.ok, true)
    const comment = stub.requests.find((r) => r.method === 'POST' && r.url.includes('/issues/141/comments'))
    assert.ok(comment, 'summary comment posted when enabled')
    assert.ok(JSON.parse(comment.body).body.includes(d.brief.id))
    assertNoSecrets('summary comment', JSON.parse(comment.body))
    await retryPendingWritebacks(db)
    assert.equal(eventsFor(db, d.brief.id, '回写').filter((e) => e.details.transition === '翻ready').length, ready.length, 'a successful flip is not retried')
  })

  test('sub-tasks: parent gates on claim and approve, derived base_branch, open_review_round, restack after the parent merges, notice when the parent is returned', async (t) => {
    const { app, stub, admin, db } = await boot(t)

    const parent = await createTaskOk(app, admin.cookies, taskPayload({ title: '父任务' }))
    const child = await createTaskOk(app, admin.cookies, taskPayload({ title: '子任务', parent_task_id: parent.id }))
    assert.equal(child.parent_task_id, parent.id)
    assert.equal(child.repo.base_branch, 'main', 'no parent PR yet → stored base branch')

    const missingParent = await app.inject({ method: 'POST', url: '/api/v1/tasks', cookies: admin.cookies, headers: jsonHeaders, payload: taskPayload({ parent_task_id: 'kt-1999-0001' }) })
    assert.equal(missingParent.statusCode, 400)
    const cancelled = await createTaskOk(app, admin.cookies, taskPayload({ title: '已取消的' }))
    await app.inject({ method: 'PATCH', url: `/api/v1/tasks/${cancelled.id}`, cookies: admin.cookies, headers: jsonHeaders, payload: { status: '已取消' } })
    const terminalParent = await app.inject({ method: 'POST', url: '/api/v1/tasks', cookies: admin.cookies, headers: jsonHeaders, payload: taskPayload({ parent_task_id: cancelled.id }) })
    assert.equal(terminalParent.statusCode, 409)
    assert.equal(jsonBody(terminalParent).error, 'parent_invalid')

    // Child cannot be claimed while the parent has no PR.
    const childDev = await pairClaimantDevice(app, admin.cookies, 'child-agent')
    const early = await claimHttp(app, childDev.identity, child.id)
    assert.equal(early.statusCode, 409)
    assert.equal(jsonBody(early).error, 'parent_not_ready')

    // Parent delivers a Draft PR (head branch known after the first poll).
    const parentDev = await pairClaimantDevice(app, admin.cookies, 'parent-agent')
    const parentClaim = await claimOk(app, parentDev.identity, parent.id)
    const parentMcp = await mcpClient(app, parentDev.identity)
    const parentPr = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/201`
    stub.pr.set('201', { body: prBody(201) })
    await parentMcp.ok('submit_pr', { task_id: parent.id, pr_url: parentPr, summary: '父 Draft', claim_id: parentClaim.lease.claim_id, head_sha: 'sha-201-1' })
    await pollPendingReviews(db)

    const childClaim = await claimOk(app, childDev.identity, child.id)
    assert.equal(childClaim.task.repo.base_branch, 'kaola/branch-201', 'stacked on the parent PR head branch')
    assert.equal(childClaim.task.parent_task_id, parent.id)

    // Child Agent finds a parent problem: open_review_round flips the parent 待验收 → 待修改.
    const childMcp = await mcpClient(app, childDev.identity)
    const wrongParent = await childMcp.err('open_review_round', { task_id: child.id, claim_id: childClaim.lease.claim_id, items: [{ kind: 'blocking', body_md: 'x' }] })
    assert.equal(wrongParent.error, 'forbidden', 'the Claim task must be a child of task_id')
    const opened = await childMcp.ok('open_review_round', {
      task_id: parent.id,
      claim_id: childClaim.lease.claim_id,
      items: [{ kind: 'blocking', body_md: '父任务的接口签名不对', anchor: { path: 'src/a.ts', line: 3 } }, { kind: 'note', body_md: '顺带' }],
    })
    assert.equal(opened.task.status, '待修改')
    assert.equal(opened.round.kind, 'downstream_finding')
    assert.equal(opened.round.opened_by_task_id, child.id)
    assert.equal(opened.round.verdict, 'changes_requested')
    assert.equal(opened.current.blocking.length, 1)
    assert.equal(taskRow(db, parent.id).status, '待修改')
    // Parent not 待验收 → items appended only.
    const appended = await childMcp.ok('open_review_round', { task_id: parent.id, claim_id: childClaim.lease.claim_id, items: [{ kind: 'note', body_md: '再补一条' }] })
    assert.equal(appended.round, null)
    assert.equal(taskRow(db, parent.id).status, '待修改')

    // Parent revision → approve; child submits; child approve is gated until the parent is 已完成.
    const parentClaim2 = await claimOk(app, parentDev.identity, parent.id)
    await parentMcp.ok('submit_revision', { task_id: parent.id, claim_id: parentClaim2.lease.claim_id, pr_url: parentPr, head_sha: 'sha-201-2', summary: '修' })
    const childPr = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/202`
    stub.pr.set('202', { body: prBody(202) })
    await childMcp.ok('submit_pr', { task_id: child.id, pr_url: childPr, summary: '子 Draft', claim_id: childClaim.lease.claim_id, head_sha: 'sha-202-1' })
    const gated = await reviewPost(app, admin.cookies, child.id, 'approve')
    assert.equal(gated.statusCode, 409)
    assert.equal(jsonBody(gated).error, 'parent_not_completed')
    assert.equal(taskRow(db, child.id).status, '待验收')

    // #54: the live head check anchors 「通过」 to the recorded head — advance the stub to the
    // revised head submit_revision just handed back so the fixture agrees with itself.
    stub.pr.set('201', { body: prBody(201, { head: { sha: 'sha-201-2', ref: 'kaola/branch-201' } }) })
    assert.equal((await reviewPost(app, admin.cookies, parent.id, 'approve')).statusCode, 200)
    await settleWritebacks()
    stub.pr.set('201', { body: prBody(201, { state: 'closed', merged: true, title: '[kt] change 201', head: { sha: 'sha-201-2', ref: 'kaola/branch-201' } }) })
    await pollPendingReviews(db)
    assert.equal(taskRow(db, parent.id).status, '已完成')

    // Restack: the child (待验收) is parked in 待修改 with a restack round and the new base.
    assert.equal(taskRow(db, child.id).status, '待修改')
    const restack = eventsFor(db, child.id, 'restack')
    assert.equal(restack.length, 1)
    assert.deepEqual(restack[0].details, { task_id: child.id, parent_task_id: parent.id, round: 1, base_branch: 'main' })
    const childFeedback = await childMcp.ok('get_review_feedback', { task_id: child.id })
    assert.equal(childFeedback.kind, 'restack')
    assert.equal(childFeedback.base_branch, 'main', 'after the parent merges the child stacks on the parent base branch')
    assert.equal(childFeedback.thread[0].author_kind, 'system')
    assert.ok(childFeedback.thread[0].body_md.includes(parent.id))
    const childBrief = await childMcp.ok('get_task_brief', { task_id: child.id })
    assert.equal(childBrief.repo.base_branch, 'main')

    // Child rebases, hands back, is approved (parent 已完成 now) and merges.
    const childClaim2 = await claimOk(app, childDev.identity, child.id)
    await childMcp.ok('submit_revision', { task_id: child.id, claim_id: childClaim2.lease.claim_id, pr_url: childPr, head_sha: 'sha-202-2', summary: 'rebase 完成' })
    // #54: same fixture sync as the parent above — advance the stub to the rebased head before
    // the live check runs.
    stub.pr.set('202', { body: prBody(202, { head: { sha: 'sha-202-2', ref: 'kaola/branch-202' } }) })
    assert.equal((await reviewPost(app, admin.cookies, child.id, 'approve')).statusCode, 200)
    await settleWritebacks()
    stub.pr.set('202', { body: prBody(202, { state: 'closed', merged: true }) })
    await pollPendingReviews(db)
    assert.equal(taskRow(db, child.id).status, '已完成')

    // A parent that is returned only notifies its (unfinished) children.
    const parent2 = await createTaskOk(app, admin.cookies, taskPayload({ title: '父2' }))
    const child2 = await createTaskOk(app, admin.cookies, taskPayload({ title: '子2', parent_task_id: parent2.id }))
    const p2dev = await pairClaimantDevice(app, admin.cookies, 'p2')
    const p2claim = await claimOk(app, p2dev.identity, parent2.id)
    const p2mcp = await mcpClient(app, p2dev.identity)
    stub.pr.set('203', { body: prBody(203) })
    await p2mcp.ok('submit_pr', { task_id: parent2.id, pr_url: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/203`, summary: 'p2', claim_id: p2claim.lease.claim_id })
    assert.equal(jsonBody(await reviewPost(app, admin.cookies, parent2.id, 'terminate')).task.status, '已退回')
    assert.equal(taskRow(db, child2.id).status, '待认领')
    const notice = jsonBody(await reviewGet(app, admin.cookies, child2.id))
    assert.equal(notice.messages.length, 1)
    assert.equal(notice.messages[0].author_kind, 'system')
    assert.ok(notice.messages[0].body_md.includes('已退回'))
    assertNoSecrets('sub-task flows', notice, childFeedback, opened, eventRows(db))
  })
})

describe('issue #53 review loop — security-review hardenings', { concurrency: false }, () => {
  test('GET review refuses a 待批准 session; oversized body_md / phase / items are 400', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 151 })
    db.$client.prepare("UPDATE users SET status = '待批准' WHERE id = ?").run(admin.body.id)
    assert.equal((await reviewGet(app, admin.cookies, d.brief.id)).statusCode, 401)
    db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(admin.body.id)
    assert.equal((await reviewGet(app, admin.cookies, d.brief.id)).statusCode, 200)

    const huge = 'x'.repeat(20_001)
    assert.equal((await reviewPost(app, admin.cookies, d.brief.id, 'messages', { body_md: huge, kind: 'note' })).statusCode, 400)
    assert.equal((await reviewPost(app, admin.cookies, d.brief.id, 'messages', { body_md: 'x'.repeat(20_000), kind: 'note' })).statusCode, 201)
    assert.equal(
      (await reviewPost(app, admin.cookies, d.brief.id, 'messages', { body_md: 'x', kind: 'note', anchor: { url: 'u'.repeat(2_001) } })).statusCode,
      400,
    )

    const dev = await pairClaimantDevice(app, admin.cookies, 'caps')
    await postReviewerMessage(app, admin.cookies, d.brief.id, { body_md: '阻塞', kind: 'blocking' })
    await reviewPost(app, admin.cookies, d.brief.id, 'rounds')
    const claim = await claimOk(app, dev.identity, d.brief.id)
    const longPhase = await progressHttp(app, dev.identity, d.brief.id, { claim_id: claim.lease.claim_id, phase: 'p'.repeat(201) })
    assert.equal(longPhase.statusCode, 400)
    const okPhase = await progressHttp(app, dev.identity, d.brief.id, { claim_id: claim.lease.claim_id, phase: 'p'.repeat(200) })
    assert.equal(okPhase.statusCode, 200)
  })
})

describe('issue #53 review loop — code-review repairs', { concurrency: false }, () => {
  test('R1: a task reopened after 已退回 (terminated or closed PR) accepts a fresh submit_pr with a new PR', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 161 })
    assert.equal(jsonBody(await reviewPost(app, admin.cookies, d.brief.id, 'terminate')).task.status, '已退回')
    assert.equal(submissionRow(db, taskRow(db, d.brief.id).id).pr_state, 'terminated')
    const reopened = await app.inject({ method: 'PATCH', url: `/api/v1/tasks/${d.brief.id}`, cookies: admin.cookies, headers: jsonHeaders, payload: { status: '待认领' } })
    assert.equal(reopened.statusCode, 200, reopened.body)
    const dev = await pairClaimantDevice(app, admin.cookies, 'redeliver')
    const claim = await claimOk(app, dev.identity, d.brief.id)
    assert.equal(claim.task.review_round, 0, 'a new delivery starts at round 0')
    const mcp = await mcpClient(app, dev.identity)
    stub.pr.set('162', { body: prBody(162) })
    const fresh = await mcp.ok('submit_pr', { task_id: d.brief.id, pr_url: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/162`, summary: '第二次交付', claim_id: claim.lease.claim_id })
    assert.equal(fresh.task.status, '待验收')
    const view = jsonBody(await reviewGet(app, admin.cookies, d.brief.id))
    assert.equal(view.pr_url, `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/162`)
    assert.equal(view.round, 0)

    // Same for a PR the forge closed.
    const e = await deliverDraft(app, stub, admin, { prNumber: 163 })
    stub.pr.set('163', { body: prBody(163, { state: 'closed', merged: false }) })
    await pollPendingReviews(db)
    assert.equal(taskRow(db, e.brief.id).status, '已退回')
    await app.inject({ method: 'PATCH', url: `/api/v1/tasks/${e.brief.id}`, cookies: admin.cookies, headers: jsonHeaders, payload: { status: '待认领' } })
    const claim2 = await claimOk(app, dev.identity, e.brief.id)
    // A released Claim after a closed PR goes back to 待认领, not 待修改 (no live submission).
    const released = await releaseHttp(app, dev.identity, e.brief.id, { claim_id: claim2.lease.claim_id })
    assert.equal(jsonBody(released).task.status, '待认领')
  })

  test('R2: submit_pr head_branch lets a sub-task stack without any poller fetch', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const parent = await createTaskOk(app, admin.cookies, taskPayload({ title: '父' }))
    const child = await createTaskOk(app, admin.cookies, taskPayload({ title: '子', parent_task_id: parent.id }))
    const dev = await pairClaimantDevice(app, admin.cookies, 'stack')
    const claim = await claimOk(app, dev.identity, parent.id)
    const mcp = await mcpClient(app, dev.identity)
    const prUrl = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/171`
    const tooLong = await mcp.err('submit_pr', { task_id: parent.id, pr_url: prUrl, summary: 'p', claim_id: claim.lease.claim_id, head_branch: 'b'.repeat(256) })
    assert.equal(tooLong.error, 'invalid_body')
    await mcp.ok('submit_pr', { task_id: parent.id, pr_url: prUrl, summary: 'p', claim_id: claim.lease.claim_id, head_sha: 'sha-171-1', head_branch: 'kaola/from-agent' })
    assert.equal(submissionRow(db, taskRow(db, parent.id).id).head_branch, 'kaola/from-agent')
    assert.equal(stub.requests.some((r) => r.url.includes('/pulls/171')), false, 'no PR fetch happened')
    const childBrief = await mcp.ok('get_task_brief', { task_id: child.id })
    assert.equal(childBrief.repo.base_branch, 'kaola/from-agent')
  })

  test('R4/R5: open_review_round finds the caller among sibling Claims; a released Claim with a new head is stale_claim', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const parent = await deliverDraft(app, stub, admin, { prNumber: 181 })
    const childA = await createTaskOk(app, admin.cookies, taskPayload({ title: '子A', parent_task_id: parent.brief.id }))
    const childB = await createTaskOk(app, admin.cookies, taskPayload({ title: '子B', parent_task_id: parent.brief.id }))
    const dev = await pairClaimantDevice(app, admin.cookies, 'siblings')
    const claimA = await claimOk(app, dev.identity, childA.id)
    const claimB = await claimOk(app, dev.identity, childB.id)
    const mcp = await mcpClient(app, dev.identity)
    // claim_id of the SECOND sibling must be found even though the first sibling's fence rejects it.
    const opened = await mcp.ok('open_review_round', { task_id: parent.brief.id, claim_id: claimB.lease.claim_id, items: [{ kind: 'blocking', body_md: '来自子B' }] })
    assert.equal(opened.round.opened_by_task_id, childB.id)
    assert.equal(taskRow(db, parent.brief.id).status, '待修改')
    const bogus = await mcp.err('open_review_round', { task_id: parent.brief.id, claim_id: 'clm_bogus', items: [{ kind: 'note', body_md: 'x' }] })
    assert.equal(bogus.error, 'stale_claim')
    void claimA

    // R5: revision Claim hands back h2, is released; the same Claim with h3 is stale, not "unchanged".
    const rev = await pairClaimantDevice(app, admin.cookies, 'rev')
    const revClaim = await claimOk(app, rev.identity, parent.brief.id)
    const revMcp = await mcpClient(app, rev.identity)
    await revMcp.ok('submit_revision', { task_id: parent.brief.id, claim_id: revClaim.lease.claim_id, pr_url: parent.prUrl, head_sha: 'sha-181-2', summary: 'r' })
    const stale = await revMcp.err('submit_revision', { task_id: parent.brief.id, claim_id: revClaim.lease.claim_id, pr_url: parent.prUrl, head_sha: 'sha-181-3', summary: 'r2' })
    assert.equal(stale.error, 'stale_claim')
  })
})

// -------------------------------------------------------------------------------------------
// Issue #54 (DESIGN.md §17.7, docs/api.md "#54 head check") — evidentiary anchoring of 「通过」
// to the recorded head_sha. Custody note: this describe block is the acceptance oracle for the
// REST/MCP half of #54; an implementer may not weaken or reinterpret it to pass.
//
// Known interaction with the pre-existing #53 suite above (flagged, not fixed here — out of this
// file's assigned scope, which is additive only): the full multi-round loop test's assertion at
// `evensFor(db, publicId, '评审通过')[0].details` (currently `{ task_id, round, pr_url }`) and the
// sub-task test's unstubbed `approve` after a `submit_revision` whose PR stub was never re-set to
// the new head will both need mechanical updates once #54's live head check lands — the former
// because the event gains `head_sha` / `head_verified` (§17.6, exactly as documented here), the
// latter because that approve call's forge stub would otherwise disagree with the recorded head
// and legitimately 409. Both are stub/assertion synchronization to the already-documented #54
// contract, not a change in accepted meaning.
// -------------------------------------------------------------------------------------------

describe('issue #54 head_sha anchoring', { concurrency: false }, () => {
  test('approve with an equal live forge head: 200, head_verified true, forge_head_sha persisted, and 评审通过 details carry head_sha + head_verified', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 601, headSha: 'sha-601-1' })
    // The live forge head equals the recorded head at approve time.
    stub.pr.set(d.prNumber, { body: prBody(601, { head: { sha: 'sha-601-1', ref: 'kaola/branch-601' } }) })

    const approved = await reviewPost(app, admin.cookies, d.brief.id, 'approve')
    assert.equal(approved.statusCode, 200, approved.body)
    const body = jsonBody(approved)
    assert.equal(body.task.status, '待合并')
    assert.equal(body.head_sha, 'sha-601-1')
    assert.equal(body.head_verified, true)

    const pk = taskRow(db, d.brief.id).id
    assert.equal(submissionRow(db, pk).forge_head_sha, 'sha-601-1', 'approve must persist the live-checked head')
    assert.ok(submissionRow(db, pk).forge_head_seen_at > 0)

    const approvedEvent = eventsFor(db, d.brief.id, '评审通过')[0]
    assert.deepEqual(approvedEvent.details, {
      task_id: d.brief.id,
      round: body.round.round,
      pr_url: d.prUrl,
      head_sha: 'sha-601-1',
      head_verified: true,
    })
    assertNoSecrets('approve equal head', body, eventRows(db))
  })

  test('approve refuses when the live forge head differs from the recorded head_sha: 409 head_sha_stale, no state change, no new round, no 评审通过 event; the view then shows head_stale', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 602, headSha: 'sha-602-1' })
    stub.pr.set(d.prNumber, { body: prBody(602, { head: { sha: 'sha-602-2', ref: 'kaola/branch-602' } }) })

    const pk = taskRow(db, d.brief.id).id
    const roundsBefore = db.$client.prepare('SELECT COUNT(*) AS n FROM review_rounds WHERE task_id = ?').get(pk).n

    const approved = await reviewPost(app, admin.cookies, d.brief.id, 'approve')
    assert.equal(approved.statusCode, 409, approved.body)
    const body = jsonBody(approved)
    assert.equal(body.error, 'head_sha_stale')
    assert.equal(body.recorded_head_sha, 'sha-602-1')
    assert.equal(body.forge_head_sha, 'sha-602-2')
    assert.equal(typeof body.message, 'string')
    assert.ok(body.message.length > 0, 'the 409 must carry a non-empty Chinese message')

    assert.equal(taskRow(db, d.brief.id).status, '待验收', 'task must not transition on a stale head')
    const roundsAfter = db.$client.prepare('SELECT COUNT(*) AS n FROM review_rounds WHERE task_id = ?').get(pk).n
    assert.equal(roundsAfter, roundsBefore, 'no new review_rounds row on a refused approve')
    assert.equal(eventsFor(db, d.brief.id, '评审通过').length, 0, 'no 评审通过 event on a refused approve')

    // The live check still persists what it observed even though it refuses the transition.
    assert.equal(submissionRow(db, pk).forge_head_sha, 'sha-602-2')

    const view = jsonBody(await reviewGet(app, admin.cookies, d.brief.id))
    assert.equal(view.forge_head_sha, 'sha-602-2')
    assert.equal(view.head_stale, true)
    assertNoSecrets('approve stale head', body, view, eventRows(db))
  })

  test('approve with no recorded head_sha (poller never ran) backfills it from the live forge head and proceeds with head_verified true', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    // deliverDraft without a headSha leaves submissions.head_sha NULL until something backfills it.
    const d = await deliverDraft(app, stub, admin, { prNumber: 603 })
    const pk = taskRow(db, d.brief.id).id
    assert.equal(submissionRow(db, pk).head_sha, null, 'setup: no head_sha recorded yet')

    stub.pr.set(d.prNumber, { body: prBody(603, { head: { sha: 'sha-603-1', ref: 'kaola/branch-603' } }) })
    const approved = await reviewPost(app, admin.cookies, d.brief.id, 'approve')
    assert.equal(approved.statusCode, 200, approved.body)
    const body = jsonBody(approved)
    assert.equal(body.head_sha, 'sha-603-1')
    assert.equal(body.head_verified, true)
    assert.equal(submissionRow(db, pk).head_sha, 'sha-603-1', 'head_sha must be backfilled from the live forge head')
    assert.equal(taskRow(db, d.brief.id).status, '待合并')
  })

  test('approve proceeds fail-open (head_verified: false) when the forge is unreachable and no forge_head_sha was ever observed', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 604, headSha: 'sha-604-1' })
    const pk = taskRow(db, d.brief.id).id
    assert.equal(submissionRow(db, pk).forge_head_sha, null, 'setup: the poller never ran')

    stub.pr.set(d.prNumber, { unreachable: true })
    const approved = await reviewPost(app, admin.cookies, d.brief.id, 'approve')
    assert.equal(approved.statusCode, 200, approved.body)
    const body = jsonBody(approved)
    assert.equal(body.head_sha, 'sha-604-1', 'falls back to the recorded head when the forge cannot be read')
    assert.equal(body.head_verified, false)
    assert.equal(taskRow(db, d.brief.id).status, '待合并')

    const approvedEvent = eventsFor(db, d.brief.id, '评审通过')[0]
    assert.deepEqual(approvedEvent.details, {
      task_id: d.brief.id,
      round: body.round.round,
      pr_url: d.prUrl,
      head_sha: 'sha-604-1',
      head_verified: false,
    })
  })

  test('approve still refuses (409) when the forge is unreachable but a previously observed forge_head_sha differs from the recorded head', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 605, headSha: 'sha-605-1' })
    stub.pr.set(d.prNumber, { body: prBody(605, { head: { sha: 'sha-605-2', ref: 'kaola/branch-605' } }) })
    await pollPendingReviews(db)

    const pk = taskRow(db, d.brief.id).id
    assert.equal(submissionRow(db, pk).forge_head_sha, 'sha-605-2', 'setup: the poller observed a different head earlier')

    stub.pr.set(d.prNumber, { unreachable: true })
    const approved = await reviewPost(app, admin.cookies, d.brief.id, 'approve')
    assert.equal(approved.statusCode, 409, approved.body)
    const body = jsonBody(approved)
    assert.equal(body.error, 'head_sha_stale')
    assert.equal(body.recorded_head_sha, 'sha-605-1')
    assert.equal(body.forge_head_sha, 'sha-605-2')
    assert.equal(taskRow(db, d.brief.id).status, '待验收')
    assert.equal(eventsFor(db, d.brief.id, '评审通过').length, 0)
  })

  test('submit_revision resets forge_head_sha / forge_head_seen_at to null after a poller tick had recorded an observation', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 606, headSha: 'sha-606-1' })
    stub.pr.set(d.prNumber, { body: prBody(606, { head: { sha: 'sha-606-2', ref: 'kaola/branch-606' } }) })
    await pollPendingReviews(db)

    const pk = taskRow(db, d.brief.id).id
    assert.ok(submissionRow(db, pk).forge_head_sha != null, 'setup: the poller recorded an observation')

    await postReviewerMessage(app, admin.cookies, d.brief.id, { body_md: '阻塞', kind: 'blocking' })
    assert.equal((await reviewPost(app, admin.cookies, d.brief.id, 'rounds')).statusCode, 201)

    const revisor = await pairClaimantDevice(app, admin.cookies, 'revisor-606')
    const revisionClaim = await claimOk(app, revisor.identity, d.brief.id)
    const revMcp = await mcpClient(app, revisor.identity)
    await revMcp.ok('submit_revision', {
      task_id: d.brief.id,
      claim_id: revisionClaim.lease.claim_id,
      pr_url: d.prUrl,
      head_sha: 'sha-606-3',
      summary: '修订',
    })

    assert.equal(submissionRow(db, pk).forge_head_sha, null, 'submit_revision must clear the stale observation')
    assert.equal(submissionRow(db, pk).forge_head_seen_at, null)
    assert.equal(submissionRow(db, pk).head_sha, 'sha-606-3')

    const view = jsonBody(await reviewGet(app, admin.cookies, d.brief.id))
    assert.equal(view.forge_head_sha, null)
    assert.equal(view.head_stale, false)
    assertNoSecrets('submit_revision reset view', view)
  })

  test('GET …/review exposes forge_head_sha / forge_head_seen_at / head_stale; head_stale is true only when both are known and differ', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 607, headSha: 'sha-607-1' })

    // Before any observation: both new fields null, head_stale false.
    let view = jsonBody(await reviewGet(app, admin.cookies, d.brief.id))
    assert.equal(view.forge_head_sha, null)
    assert.equal(view.forge_head_seen_at, null)
    assert.equal(view.head_stale, false)

    // The forge's observed head equals the recorded head: head_stale stays false.
    stub.pr.set(d.prNumber, { body: prBody(607, { head: { sha: 'sha-607-1', ref: 'kaola/branch-607' } }) })
    await pollPendingReviews(db)
    view = jsonBody(await reviewGet(app, admin.cookies, d.brief.id))
    assert.equal(view.forge_head_sha, 'sha-607-1')
    assert.ok(view.forge_head_seen_at > 0)
    assert.equal(view.head_stale, false)

    // The forge's observed head diverges: head_stale flips true.
    stub.pr.set(d.prNumber, { body: prBody(607, { head: { sha: 'sha-607-2', ref: 'kaola/branch-607' } }) })
    await pollPendingReviews(db)
    view = jsonBody(await reviewGet(app, admin.cookies, d.brief.id))
    assert.equal(view.forge_head_sha, 'sha-607-2')
    assert.equal(view.head_stale, true)
    assertNoSecrets('view exposure', view)
  })

  // Security review R1 (#54): the live head check is an await, so the 待验收 guard is a stale
  // snapshot by commit time. The transaction must re-check and refuse rather than overwrite a
  // terminal transition that landed during the forge round-trip.
  test('approve refuses (409 illegal_transition) when the task left 待验收 during the live head check; no round, no 评审通过, no 翻ready', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 611, headSha: 'sha-611-1' })
    stub.pr.set(d.prNumber, { body: prBody(611, { head: { sha: 'sha-611-1', ref: 'kaola/branch-611' } }) })
    const pk = taskRow(db, d.brief.id).id

    // While approve's getPullRequest is in flight, a poller / webhook terminal transition lands.
    const stubbedFetch = globalThis.fetch
    let interleaved = 0
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input)
      if (isPrEndpoint(url) && interleaved === 0) {
        interleaved += 1
        db.$client.prepare("UPDATE tasks SET status = '已退回' WHERE id = ?").run(pk)
        db.$client.prepare("UPDATE submissions SET pr_state = 'closed' WHERE task_id = ?").run(pk)
      }
      return stubbedFetch(input, init)
    }
    t.after(() => {
      globalThis.fetch = stubbedFetch
    })

    const approved = await reviewPost(app, admin.cookies, d.brief.id, 'approve')
    assert.equal(interleaved, 1, 'setup: the terminal transition must have interleaved with the live check')
    assert.equal(approved.statusCode, 409, approved.body)
    assert.equal(jsonBody(approved).error, 'illegal_transition')
    assert.equal(taskRow(db, d.brief.id).status, '已退回', 'the racing terminal transition must win')
    assert.equal(db.$client.prepare('SELECT COUNT(*) AS n FROM review_rounds WHERE task_id = ?').get(pk).n, 0)
    assert.equal(eventsFor(db, d.brief.id, '评审通过').length, 0)
    await settleWritebacks()
    assert.ok(
      !stub.requests.some((r) => (r.method === 'PATCH' || r.method === 'PUT') && r.url.includes('/611')),
      'no Draft → ready flip may be attempted for a task that left 待验收',
    )
  })

  test('two concurrent 「通过」 on the same task: exactly one 200, the other a clean 409 (never a 500 from the review_rounds unique index)', async (t) => {
    const { app, stub, admin, db } = await boot(t)
    const d = await deliverDraft(app, stub, admin, { prNumber: 612, headSha: 'sha-612-1' })
    stub.pr.set(d.prNumber, { body: prBody(612, { head: { sha: 'sha-612-1', ref: 'kaola/branch-612' } }) })
    const pk = taskRow(db, d.brief.id).id

    const [a, b] = await Promise.all([
      reviewPost(app, admin.cookies, d.brief.id, 'approve'),
      reviewPost(app, admin.cookies, d.brief.id, 'approve'),
    ])
    const codes = [a.statusCode, b.statusCode].sort()
    assert.deepEqual(codes, [200, 409], `${a.body} / ${b.body}`)
    const refused = a.statusCode === 409 ? a : b
    assert.equal(jsonBody(refused).error, 'illegal_transition')
    assert.equal(taskRow(db, d.brief.id).status, '待合并')
    assert.equal(db.$client.prepare('SELECT COUNT(*) AS n FROM review_rounds WHERE task_id = ?').get(pk).n, 1)
    assert.equal(eventsFor(db, d.brief.id, '评审通过').length, 1)
  })
})
