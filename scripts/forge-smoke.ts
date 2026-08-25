#!/usr/bin/env node
/**
 * Live forge smoke against a real GitLab or Gitea repo.
 *
 * Team publish surface is GitLab + Gitea only (not GitHub). Claim identity is
 * still device proof + remote bind — the claimant never needs their own PAT.
 *
 * Boots an isolated Fastify app (inject + stub GitLab OAuth, not the browser),
 * then: credential profile → import Issue → publish → pair device →
 * claim_task → git clone via the claim envelope → push branch → open PR →
 * submit_pr → merge → pollPendingReviews → 已完成 + 回写.
 *
 * Usage:
 *   node --experimental-strip-types scripts/forge-smoke.ts gitlab
 *   node --experimental-strip-types scripts/forge-smoke.ts gitea
 *
 * Tokens come from GITLAB_TOKEN / GITEA_TOKEN. Never print them. Never write
 * them into git remotes or mcp.json.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app.ts'
import { createDb } from '../apps/server/src/db.ts'
import {
  injectSigned,
  pairDeviceToSelf,
  type DeviceIdentity,
} from '../apps/server/src/device-proof.test-helpers.ts'
import { pollPendingReviews } from '../apps/server/src/poller.ts'

type ForgeKind = 'gitlab' | 'gitea'

type ForgeSpec = {
  kind: ForgeKind
  tokenEnv: 'GITLAB_TOKEN' | 'GITEA_TOKEN'
  baseUrl: string
  fullName: string
  issueWebUrl: (n: number) => string
  prWebUrl: (n: number) => string
}

type CloneHeader = { name: string; value_pattern: string }

type JsonRpc = {
  id?: number
  error?: unknown
  result?: {
    structuredContent?: Record<string, unknown>
    content?: Array<{ type?: string; text?: string }>
    isError?: boolean
    tools?: unknown
  }
}

const STUB_OAUTH_ACCESS = 'kaola-forge-smoke-oauth-stub'
const MCP_PROTOCOL = '2025-11-25'
const MCP_PATH = '/api/mcp'
const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' }
const MCP_ACCEPT = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }

const FORGES: Record<ForgeKind, ForgeSpec> = {
  gitlab: {
    kind: 'gitlab',
    tokenEnv: 'GITLAB_TOKEN',
    baseUrl: 'https://gitlab.com',
    fullName: 'KaolaBrother/kaola-tasks-smoke',
    issueWebUrl: (n) => `https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/${n}`,
    prWebUrl: (n) => `https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/${n}`,
  },
  gitea: {
    kind: 'gitea',
    tokenEnv: 'GITEA_TOKEN',
    baseUrl: 'https://gitea.com',
    fullName: 'KaolaBrother/kaola-tasks-smoke',
    issueWebUrl: (n) => `https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/${n}`,
    prWebUrl: (n) => `https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/${n}`,
  },
}

function fail(message: string): never {
  throw new Error(message)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value == null || value === '') fail(`missing env ${name}`)
  return value
}

function cookieJar(response: { cookies: Array<{ name: string; value: string }> }): Record<string, string> {
  const jar: Record<string, string> = {}
  for (const cookie of response.cookies) jar[cookie.name] = cookie.value
  return jar
}

function readAuthorization(headers: unknown): string | undefined {
  if (headers == null) return undefined
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get('authorization') ?? headers.get('Authorization') ?? undefined
  }
  if (Array.isArray(headers)) {
    const hit = headers.find((row) => String(row[0]).toLowerCase() === 'authorization')
    return hit?.[1]
  }
  const rec = headers as Record<string, unknown>
  const value = rec.authorization ?? rec.Authorization
  return typeof value === 'string' ? value : undefined
}

function redact(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('***')
  }
  return out
}

function installOauthUserinfoStub(): void {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const header = readAuthorization(init?.headers) ?? readAuthorization(
      input != null && typeof input === 'object' && 'headers' in input
        ? (input as { headers?: unknown }).headers
        : undefined,
    )
    const match = typeof header === 'string' ? /^(?:Bearer|token)\s+(\S+)/i.exec(header) : null
    if (match?.[1] === STUB_OAUTH_ACCESS) {
      return new Response(
        JSON.stringify({ id: 201908908, username: 'KaolaBrother', name: 'KaolaBrother' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return original(input, init)
  }
}

function parseSseMessages(body: string): JsonRpc[] {
  const messages: JsonRpc[] = []
  for (const chunk of body.split(/\r?\n\r?\n/)) {
    if (!chunk.trim()) continue
    let eventName = 'message'
    const dataParts: string[] = []
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataParts.push(line.slice('data:'.length).replace(/^\s/, ''))
    }
    if (eventName === 'message' && dataParts.length > 0) {
      messages.push(JSON.parse(dataParts.join('\n')) as JsonRpc)
    }
  }
  return messages
}

function parseJsonRpcHttp(res: { headers: Record<string, unknown>; body: string; statusCode: number }): JsonRpc[] {
  const contentType = String(res.headers['content-type'] ?? '')
  const body = String(res.body ?? '')
  if (contentType.includes('text/event-stream') || /^\s*event:/m.test(body) || /^\s*data:/m.test(body)) {
    const messages = parseSseMessages(body)
    if (messages.length === 0) fail(`expected SSE JSON-RPC, status ${res.statusCode}: ${body.slice(0, 400)}`)
    return messages
  }
  const parsed: unknown = JSON.parse(body)
  return Array.isArray(parsed) ? (parsed as JsonRpc[]) : [parsed as JsonRpc]
}

function rpcById(messages: JsonRpc[], id: number): JsonRpc {
  const hit = messages.find((message) => message.id === id)
  if (hit == null) fail(`no JSON-RPC id ${id}`)
  return hit
}

function toolBody(result: JsonRpc['result']): Record<string, unknown> {
  if (result?.structuredContent != null) return result.structuredContent
  const texts = Array.isArray(result?.content)
    ? result.content.filter((block) => block?.type === 'text').map((block) => block.text ?? '')
    : []
  if (texts[0] == null || texts[0] === '') fail(`tool result empty: ${JSON.stringify(result)}`)
  return JSON.parse(texts[0]) as Record<string, unknown>
}

async function postMcp(
  app: FastifyInstance,
  identity: DeviceIdentity,
  payload: unknown,
  sessionId?: string,
) {
  const extra: Record<string, string> = { ...MCP_ACCEPT }
  if (sessionId != null) extra['mcp-session-id'] = sessionId
  return injectSigned(app, identity, {
    method: 'POST',
    url: MCP_PATH,
    payload,
    extraHeaders: extra,
  })
}

function createMcpClient(identity: DeviceIdentity) {
  let nextId = 1
  let sessionId: string | undefined
  return {
    async initialize(app: FastifyInstance) {
      const id = nextId
      nextId += 1
      const res = await postMcp(app, identity, {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL,
          capabilities: {},
          clientInfo: { name: 'kaola-forge-smoke', version: '0.0.0' },
        },
      })
      if (res.statusCode !== 200) fail(`MCP initialize HTTP ${res.statusCode}: ${res.body}`)
      const rpc = rpcById(parseJsonRpcHttp(res), id)
      if (rpc.error != null) fail(`MCP initialize JSON-RPC error: ${JSON.stringify(rpc.error)}`)
      const header = res.headers['mcp-session-id']
      if (header != null && header !== '') sessionId = String(header)
      if (sessionId != null) {
        await postMcp(app, identity, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
      }
    },
    async callTool(app: FastifyInstance, name: string, args: Record<string, unknown> = {}) {
      const id = nextId
      nextId += 1
      const res = await postMcp(
        app,
        identity,
        { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
        sessionId,
      )
      if (res.statusCode !== 200) fail(`tools/call ${name} HTTP ${res.statusCode}: ${res.body}`)
      const rpc = rpcById(parseJsonRpcHttp(res), id)
      if (rpc.error != null) fail(`tools/call ${name} protocol error: ${JSON.stringify(rpc.error)}`)
      if (rpc.result?.isError === true) fail(`tools/call ${name} isError: ${JSON.stringify(rpc.result)}`)
      return toolBody(rpc.result)
    },
  }
}

async function loginGitlabStub(app: FastifyInstance): Promise<Record<string, string>> {
  const oauth = (app as FastifyInstance & {
    gitlabOAuth2: { getAccessTokenFromAuthorizationCodeFlow: () => Promise<unknown> }
  }).gitlabOAuth2
  oauth.getAccessTokenFromAuthorizationCodeFlow = async () => ({
    token: { access_token: STUB_OAUTH_ACCESS, token_type: 'Bearer', expires_in: 3600 },
  })
  const callback = await app.inject({ method: 'GET', url: '/login/gitlab/callback?code=forge-smoke' })
  if (callback.statusCode < 200 || callback.statusCode >= 400) {
    fail(`gitlab OAuth stub callback ${callback.statusCode}: ${callback.body}`)
  }
  const cookies = cookieJar(callback)
  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    cookies,
    headers: { accept: 'application/json' },
  })
  if (me.statusCode !== 200) fail(`GET /api/v1/me ${me.statusCode}: ${me.body}`)
  const body = me.json() as { provider?: string; username?: string; permission_level?: string }
  if (body.provider !== 'gitlab' || body.username !== 'KaolaBrother' || body.permission_level !== 'full') {
    fail(`expected GitLab KaolaBrother full, got ${me.body}`)
  }
  return cookies
}

async function expectJson(
  res: { statusCode: number; body: string; json: () => unknown },
  status: number,
  label: string,
): Promise<Record<string, unknown>> {
  if (res.statusCode !== status) fail(`${label} expected ${status}, got ${res.statusCode}: ${res.body}`)
  return res.json() as Record<string, unknown>
}

function apiHeaders(kind: ForgeKind, token: string): Record<string, string> {
  if (kind === 'gitlab') return { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' }
  return { Authorization: `token ${token}`, 'content-type': 'application/json' }
}

async function forgeFetch(
  kind: ForgeKind,
  token: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: apiHeaders(kind, token),
    body: init.body == null ? undefined : JSON.stringify(init.body),
  })
}

async function createSmokeIssue(spec: ForgeSpec, token: string, stamp: string): Promise<{ number: number; url: string }> {
  const title = `smoke: append a line to README (${stamp})`
  const body = 'Kaola Tasks live smoke. Safe to close after the run.'
  if (spec.kind === 'gitlab') {
    const res = await forgeFetch(
      spec.kind,
      token,
      'https://gitlab.com/api/v4/projects/KaolaBrother%2Fkaola-tasks-smoke/issues',
      { method: 'POST', body: { title, description: body } },
    )
    if (!res.ok) fail(`GitLab create issue ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { iid: number }
    return { number: json.iid, url: spec.issueWebUrl(json.iid) }
  }
  const res = await forgeFetch(
    spec.kind,
    token,
    'https://gitea.com/api/v1/repos/KaolaBrother/kaola-tasks-smoke/issues',
    { method: 'POST', body: { title, body } },
  )
  if (!res.ok) fail(`Gitea create issue ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { number: number }
  return { number: json.number, url: spec.issueWebUrl(json.number) }
}

async function openPull(
  spec: ForgeSpec,
  token: string,
  branch: string,
  title: string,
): Promise<{ number: number; url: string }> {
  if (spec.kind === 'gitlab') {
    const res = await forgeFetch(
      spec.kind,
      token,
      'https://gitlab.com/api/v4/projects/KaolaBrother%2Fkaola-tasks-smoke/merge_requests',
      { method: 'POST', body: { title, source_branch: branch, target_branch: 'main', description: 'Kaola Tasks live smoke.' } },
    )
    if (!res.ok) fail(`GitLab open MR ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { iid: number }
    return { number: json.iid, url: spec.prWebUrl(json.iid) }
  }
  const res = await forgeFetch(spec.kind, token, 'https://gitea.com/api/v1/repos/KaolaBrother/kaola-tasks-smoke/pulls', {
    method: 'POST',
    body: { title, head: branch, base: 'main', body: 'Kaola Tasks live smoke.' },
  })
  if (!res.ok) fail(`Gitea open PR ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { number: number }
  return { number: json.number, url: spec.prWebUrl(json.number) }
}

async function mergePull(spec: ForgeSpec, token: string, number: number): Promise<void> {
  if (spec.kind === 'gitlab') {
    const project = 'https://gitlab.com/api/v4/projects/KaolaBrother%2Fkaola-tasks-smoke'
    const statusUrl = `${project}/merge_requests/${number}`
    const mergeUrl = `${statusUrl}/merge`
    let last = 'GitLab merge did not become mergeable'
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const statusRes = await forgeFetch(spec.kind, token, statusUrl)
      if (statusRes.ok) {
        const mr = (await statusRes.json()) as { detailed_merge_status?: string; merge_status?: string }
        const ready = mr.detailed_merge_status === 'mergeable' || mr.merge_status === 'can_be_merged'
        if (ready) {
          const res = await forgeFetch(spec.kind, token, mergeUrl, { method: 'PUT', body: { squash: true } })
          if (res.ok) return
          last = `GitLab merge ${res.status}: ${await res.text()}`
          if (res.status !== 405 && res.status !== 409) fail(last)
        } else {
          last = `GitLab merge not ready: ${mr.detailed_merge_status ?? mr.merge_status ?? 'unknown'}`
        }
      } else {
        last = `GitLab MR status ${statusRes.status}: ${await statusRes.text()}`
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    fail(last)
  }
  const res = await forgeFetch(
    spec.kind,
    token,
    `https://gitea.com/api/v1/repos/KaolaBrother/kaola-tasks-smoke/pulls/${number}/merge`,
    { method: 'POST', body: { Do: 'squash' } },
  )
  if (!res.ok) fail(`Gitea merge ${res.status}: ${await res.text()}`)
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Kaola Smoke',
    GIT_AUTHOR_EMAIL: 'smoke@localhost',
    GIT_COMMITTER_NAME: 'Kaola Smoke',
    GIT_COMMITTER_EMAIL: 'smoke@localhost',
  }
}

function runGit(args: string[], extraHeader: string, cwd: string | undefined, secrets: string[]) {
  const result = spawnSync('git', ['-c', `http.extraHeader=${extraHeader}`, ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
  })
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return { status: result.status ?? 1, output: redact(combined, secrets) }
}

function substituteToken(pattern: string, token: string): string {
  return pattern.split('${token}').join(token)
}

function cloneAttempts(kind: ForgeKind, extra: CloneHeader, token: string): Array<{ label: string; header: string }> {
  const envelopeValue = substituteToken(extra.value_pattern, token)
  const attempts: Array<{ label: string; header: string }> = [
    { label: 'envelope', header: `${extra.name}: ${envelopeValue}` },
  ]
  if (kind === 'gitlab') {
    attempts.push({
      label: 'gitlab-basic-oauth2',
      header: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`,
    })
  }
  return attempts
}

function cloneAndPush(opts: {
  kind: ForgeKind
  remoteUrl: string
  extra: CloneHeader
  token: string
  workParent: string
  branch: string
  line: string
  secrets: string[]
}): { cloneAuth: string; dir: string } {
  const attempts = cloneAttempts(opts.kind, opts.extra, opts.token)
  let last = ''
  for (const attempt of attempts) {
    const dir = join(opts.workParent, `${opts.kind}-${attempt.label}`)
    rmSync(dir, { recursive: true, force: true })
    const cloned = runGit(['clone', '--depth', '1', opts.remoteUrl, dir], attempt.header, undefined, opts.secrets)
    if (cloned.status !== 0) {
      last = cloned.output
      continue
    }
    const config = readFileSync(join(dir, '.git', 'config'), 'utf8')
    if (opts.secrets.some((secret) => secret !== '' && config.includes(secret))) {
      fail('clone wrote a token into .git/config')
    }
    writeFileSync(join(dir, 'README.md'), `${readFileSync(join(dir, 'README.md'), 'utf8').trimEnd()}\n${opts.line}\n`)
    const checkout = runGit(['checkout', '-B', opts.branch], attempt.header, dir, opts.secrets)
    if (checkout.status !== 0) fail(`git checkout failed: ${checkout.output}`)
    const add = runGit(['add', 'README.md'], attempt.header, dir, opts.secrets)
    if (add.status !== 0) fail(`git add failed: ${add.output}`)
    const commit = runGit(['commit', '-m', opts.line], attempt.header, dir, opts.secrets)
    if (commit.status !== 0) fail(`git commit failed: ${commit.output}`)
    const push = runGit(['push', '-u', 'origin', `HEAD:${opts.branch}`], attempt.header, dir, opts.secrets)
    if (push.status !== 0) {
      last = push.output
      continue
    }
    return { cloneAuth: attempt.label, dir }
  }
  fail(`git clone/push failed for ${opts.kind}: ${last.slice(0, 800)}`)
}

function parseKind(argv: string[]): ForgeKind {
  const raw = argv[2]
  if (raw === 'github') {
    fail('publish smoke is GitLab + Gitea only; GitHub is not a poster surface')
  }
  if (raw === 'gitlab' || raw === 'gitea') return raw
  fail('usage: node --experimental-strip-types scripts/forge-smoke.ts <gitlab|gitea>')
}

async function run(): Promise<void> {
  const kind = parseKind(process.argv)
  const spec = FORGES[kind]
  const token = requiredEnv(spec.tokenEnv)
  requiredEnv('SESSION_SECRET')
  requiredEnv('VAULT_MASTER_KEY')
  if (process.env.PUBLIC_URL == null || process.env.PUBLIC_URL === '') {
    process.env.PUBLIC_URL = 'http://localhost:31415'
  }

  const secrets = [token, STUB_OAUTH_ACCESS]
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const workRoot = mkdtempSync(join(tmpdir(), 'kaola-forge-smoke-'))
  const sqlitePath = join(workRoot, 'kaola.sqlite')
  mkdirSync(workRoot, { recursive: true })

  installOauthUserinfoStub()
  const issue = await createSmokeIssue(spec, token, stamp)
  console.log(`issue ${issue.url}`)

  const app = buildApp({ sqlitePath, pollIntervalMs: 0 })
  await app.ready()
  try {
    const cookies = await loginGitlabStub(app)
    const paired = await pairDeviceToSelf(app, cookies, { hostname: 'forge-smoke' })

    const profileRes = await app.inject({
      method: 'POST',
      url: '/api/v1/credential-profiles',
      cookies,
      headers: JSON_HEADERS,
      payload: {
        forge: spec.kind,
        base_url: spec.baseUrl,
        repo_full_name: spec.fullName,
        token,
      },
    })
    const profile = await expectJson(profileRes, 201, 'create profile')
    const profileId = profile.id
    if (typeof profileId !== 'number') fail(`profile id missing: ${profileRes.body}`)

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/import',
      cookies,
      headers: JSON_HEADERS,
      payload: {
        issue_url: issue.url,
        repo: { forge: spec.kind, base_url: spec.baseUrl, full_name: spec.fullName },
        credential: { profile_id: profileId },
      },
    })
    const imported = await expectJson(importRes, 200, 'import')
    if (typeof imported.title !== 'string') fail(`import missing title: ${importRes.body}`)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      cookies,
      headers: JSON_HEADERS,
      payload: {
        title: imported.title,
        description_md: imported.description_md ?? '',
        source: { type: 'imported', issue_url: issue.url },
        repo: { forge: spec.kind, base_url: spec.baseUrl, full_name: spec.fullName },
        credential: { profile_id: profileId },
      },
    })
    const created = await expectJson(createRes, 201, 'publish')
    const task = created as { id?: string; status?: string }
    if (typeof task.id !== 'string' || task.status !== '待认领') fail(`publish unexpected: ${createRes.body}`)
    console.log(`task ${task.id}`)

    const mcp = createMcpClient(paired.identity)
    await mcp.initialize(app)
    const claimed = await mcp.callTool(app, 'claim_task', { task_id: task.id })
    const claimedTask = claimed.task as { status?: string } | undefined
    const clone = claimed.clone as
      | { suggested_dir?: string; remote_url?: string; extra_header?: CloneHeader }
      | undefined
    if (claimedTask?.status !== '进行中') fail(`claim did not enter 进行中: ${JSON.stringify({ ...claimed, token: undefined })}`)
    if (typeof claimed.token !== 'string' || claimed.token === '') fail('claim missing token')
    if (clone?.remote_url == null || clone.extra_header == null) fail('claim missing clone envelope')
    const revealed = claimed.token
    secrets.push(revealed)
    if (clone.remote_url.includes(revealed)) fail('clone.remote_url contained the token')

    const branch = `kaola/${task.id}-smoke-${stamp}`
    const line = `Smoke ${kind} ${task.id} ${stamp}.`
    const { cloneAuth } = cloneAndPush({
      kind,
      remoteUrl: clone.remote_url,
      extra: clone.extra_header,
      token: revealed,
      workParent: workRoot,
      branch,
      line,
      secrets,
    })
    console.log(`clone_auth ${cloneAuth}`)

    const pull = await openPull(spec, revealed, branch, `[${task.id}] ${line}`)
    console.log(`pull ${pull.url}`)

    const submitted = await mcp.callTool(app, 'submit_pr', {
      task_id: task.id,
      pr_url: pull.url,
      summary: line,
    })
    const submittedTask = submitted.task as { status?: string } | undefined
    if (submittedTask?.status !== '待验收') fail(`submit_pr expected 待验收: ${JSON.stringify(submitted)}`)

    await mergePull(spec, revealed, pull.number)

    const db = createDb(sqlitePath)
    try {
      await pollPendingReviews(db)
      const row = db.$client.prepare('SELECT status FROM tasks WHERE public_id = ?').get(task.id) as
        | { status: string }
        | undefined
      if (row?.status !== '已完成') fail(`expected 已完成 after poll, got ${row?.status ?? 'missing'}`)
      const writebacks = db.$client
        .prepare(`SELECT details FROM events WHERE type = '回写' ORDER BY id`)
        .all() as Array<{ details: string }>
      const transitions = new Set(
        writebacks.map((event) => {
          try {
            return (JSON.parse(event.details) as { transition?: string }).transition
          } catch {
            return undefined
          }
        }),
      )
      for (const needed of ['认领', '提交PR', '完成']) {
        if (!transitions.has(needed)) fail(`missing 回写 ${needed}`)
      }
    } finally {
      db.$client.close()
    }

    console.log(`ok ${kind} ${task.id} ${pull.url} clone_auth=${cloneAuth}`)
  } finally {
    await app.close()
    rmSync(workRoot, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  run().catch((err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err)
    console.error(message)
    process.exitCode = 1
  })
}
