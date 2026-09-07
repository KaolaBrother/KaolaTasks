#!/usr/bin/env node
/**
 * Live forge smoke against a real GitLab or Gitea repo.
 *
 * Team publish surface is GitLab + Gitea only (not GitHub). Claim identity is
 * still device proof + remote bind — the claimant never needs their own PAT.
 *
 * Real: GITLAB_TOKEN / GITEA_TOKEN (forge HTTP + git). The script never invents
 * those. Simulated: the Kaola process itself — isolated sqlite, Fastify inject
 * (no listen, no `pnpm dev`), ensureSetup, stub GitLab OAuth publisher, device
 * pair, MCP. Missing SESSION_SECRET / VAULT_MASTER_KEY / OAUTH_* / PUBLIC_URL
 * are filled in-process (random session/vault, unused OAuth placeholders).
 * Already-set values are left alone. Never print tokens. Never write them into
 * git remotes, mcp.json, or .env.
 *
 * Then: setup local admin → GitLab publisher OAuth stub → credential profile →
 * import Issue → publish → production stdio bridge → pair device (admin bind) →
 * request_id/claim_id recovery + same-device fencing → Workflow guidance → git clone
 * via the claim envelope → push branch → open Draft PR → submit_pr(head_sha) → reviewer
 * blocking round (REST) → 待修改 → revision claim → get_review_feedback → push a follow-up
 * commit → submit_revision → 待验收 → (#54 drift leg: push one more commit the Agent never
 * declared → 「通过」 refused 409 head_sha_stale → reviewer blocking round → 待修改 → second
 * revision claim → submit_revision(new head)) → 「通过」(REST) → 待合并 + Draft flipped to ready
 * on the forge → merge → pollPendingReviews → 已完成 + 回写 (#53 review loop).
 *
 * `--web` (Path C): same live forge through the undeclared-push wait, then listen + Vue
 * proxy so a browser (or computer-use) can click the review panel. The script pauses on
 * flag files instead of injecting the 409 / second round / approve. See docs/smoke-test.md.
 *
 * Usage:
 *   node --experimental-strip-types scripts/forge-smoke.ts gitlab
 *   node --experimental-strip-types scripts/forge-smoke.ts gitea
 *   pnpm smoke:forge -- gitlab
 *   pnpm smoke:forge -- gitea
 *   pnpm smoke:uat -- gitlab --web
 *   pnpm smoke:uat -- gitea --web
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app.ts'
import { createDb } from '../apps/server/src/db.ts'
import {
  injectSigned,
  pairDeviceToSelf,
} from '../apps/server/src/device-proof.test-helpers.ts'
import { pollPendingReviews } from '../apps/server/src/poller.ts'
import { settleWritebacks } from '../apps/server/src/writeback.ts'
import { createForgeAdapter } from '../packages/forge-adapters/src/index.ts'
import { DEFAULT_SETUP, ensureSetup } from '../apps/server/src/auth.test-helpers.ts'
import { runStdioBridge } from '../apps/mcp/src/main.ts'

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
const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' }

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

function fillEnvIfEmpty(name: string, value: string): void {
  const current = process.env[name]
  if (current == null || current === '') process.env[name] = value
}

/** Process-local Kaola boot env. Does not invent GITLAB_TOKEN / GITEA_TOKEN. */
export function ensureSimulatedAuthEnv(): void {
  fillEnvIfEmpty('SESSION_SECRET', randomBytes(32).toString('hex'))
  fillEnvIfEmpty('VAULT_MASTER_KEY', randomBytes(32).toString('hex'))
  fillEnvIfEmpty('PUBLIC_URL', 'http://localhost:31415')
  fillEnvIfEmpty('OAUTH_GITHUB_CLIENT_ID', 'unused')
  fillEnvIfEmpty('OAUTH_GITHUB_CLIENT_SECRET', 'unused')
  fillEnvIfEmpty('OAUTH_GITLAB_CLIENT_ID', 'unused')
  fillEnvIfEmpty('OAUTH_GITLAB_CLIENT_SECRET', 'unused')
  fillEnvIfEmpty('OAUTH_GITLAB_BASE_URL', 'https://gitlab.com')
  fillEnvIfEmpty('OAUTH_GITEA_CLIENT_ID', 'unused')
  fillEnvIfEmpty('OAUTH_GITEA_CLIENT_SECRET', 'unused')
  fillEnvIfEmpty('OAUTH_GITEA_BASE_URL', 'https://gitea.com')
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

async function runBridgeMessages(
  url: string,
  kaolaHome: string,
  messages: unknown[],
): Promise<{ messages: JsonRpc[]; stderr: string }> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(String(chunk))
      callback()
    },
  })
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(String(chunk))
      callback()
    },
  })
  const stdin = Readable.from(messages.map((message) => `${JSON.stringify(message)}\n`))
  await runStdioBridge(['--url', url], { KAOLA_HOME: kaolaHome }, { stdin, stdout, stderr })
  const parsed = stdoutChunks
    .join('')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JsonRpc)
  return { messages: parsed, stderr: stderrChunks.join('') }
}

function bridgeInitialize(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'kaola-forge-smoke-bridge', version: '0.0.0' },
    },
  }
}

async function bridgeToolCall(
  url: string,
  kaolaHome: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const toolId = 2
  const run = await runBridgeMessages(url, kaolaHome, [
    bridgeInitialize(1),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: toolId, method: 'tools/call', params: { name, arguments: args } },
  ])
  const rpc = rpcById(run.messages, toolId)
  if (rpc.error != null) fail(`bridge tools/call ${name} protocol error: ${JSON.stringify(rpc.error)}`)
  if (rpc.result?.isError === true) fail(`bridge tools/call ${name} isError: ${JSON.stringify(rpc.result)}`)
  return toolBody(rpc.result)
}

async function bridgeListTools(url: string, kaolaHome: string): Promise<Array<Record<string, unknown>>> {
  const listId = 2
  const run = await runBridgeMessages(url, kaolaHome, [
    bridgeInitialize(1),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: listId, method: 'tools/list', params: {} },
  ])
  const initialized = rpcById(run.messages, 1)
  const instructions = String((initialized.result as { instructions?: unknown } | undefined)?.instructions ?? '')
  if (!/workflow/iu.test(instructions) || !/(必须|required|must)/iu.test(instructions)) {
    fail('MCP initialize instructions did not require Workflow after claim')
  }
  const rpc = rpcById(run.messages, listId)
  if (rpc.error != null) fail(`bridge tools/list protocol error: ${JSON.stringify(rpc.error)}`)
  const tools = rpc.result?.tools
  if (!Array.isArray(tools)) fail(`bridge tools/list missing tools: ${JSON.stringify(rpc.result)}`)
  return tools as Array<Record<string, unknown>>
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
      { method: 'POST', body: { title: `Draft: ${title}`, source_branch: branch, target_branch: 'main', description: 'Kaola Tasks live smoke.' } },
    )
    if (!res.ok) fail(`GitLab open MR ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { iid: number }
    return { number: json.iid, url: spec.prWebUrl(json.iid) }
  }
  const res = await forgeFetch(spec.kind, token, 'https://gitea.com/api/v1/repos/KaolaBrother/kaola-tasks-smoke/pulls', {
    method: 'POST',
    body: { title: `WIP: ${title}`, head: branch, base: 'main', body: 'Kaola Tasks live smoke.' },
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
}): { cloneAuth: string; dir: string; header: string; headSha: string } {
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
    return { cloneAuth: attempt.label, dir, header: attempt.header, headSha: headShaOf(dir, attempt.header, opts.secrets) }
  }
  fail(`git clone/push failed for ${opts.kind}: ${last.slice(0, 800)}`)
}

function headShaOf(dir: string, header: string, secrets: string[]): string {
  const rev = runGit(['rev-parse', 'HEAD'], header, dir, secrets)
  if (rev.status !== 0) fail(`git rev-parse failed: ${rev.output}`)
  // runGit folds stdout and stderr into one redacted `output`; the sha is its first 40-hex line.
  const sha = /\b[0-9a-f]{40}\b/u.exec(rev.output)?.[0]
  if (sha == null) fail(`git rev-parse produced no sha: ${rev.output}`)
  return sha
}

// Issue #53: the revision Claim pushes a follow-up commit onto the SAME branch (one task, one PR).
function pushFollowUp(opts: { dir: string; header: string; branch: string; line: string; secrets: string[] }): string {
  writeFileSync(join(opts.dir, 'README.md'), `${readFileSync(join(opts.dir, 'README.md'), 'utf8').trimEnd()}\n${opts.line}\n`)
  const add = runGit(['add', 'README.md'], opts.header, opts.dir, opts.secrets)
  if (add.status !== 0) fail(`git add (revision) failed: ${add.output}`)
  const commit = runGit(['commit', '-m', opts.line], opts.header, opts.dir, opts.secrets)
  if (commit.status !== 0) fail(`git commit (revision) failed: ${commit.output}`)
  const push = runGit(['push', 'origin', `HEAD:${opts.branch}`], opts.header, opts.dir, opts.secrets)
  if (push.status !== 0) fail(`git push (revision) failed: ${push.output}`)
  return headShaOf(opts.dir, opts.header, opts.secrets)
}

// Issue #54: a forge reports a pushed head on its PR object only eventually (GitLab refreshes the
// MR `sha` in a background job after the push; observed lag of several seconds on gitlab.com).
// Kaola's live check is correct against whatever the forge reports, so the smoke waits until the
// forge itself has caught up before asking Kaola to notice the drift.
async function waitForForgeHead(kind: ForgeKind, spec: ForgeSpec, token: string, prUrl: string, expected: string): Promise<void> {
  const adapter = createForgeAdapter(kind, { baseUrl: spec.baseUrl })
  const deadline = Date.now() + 90_000
  let seen = ''
  while (Date.now() < deadline) {
    seen = (await adapter.getPullRequest({ token }, prUrl)).head_sha
    if (seen === expected) return
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  fail(`forge never reported pushed head ${expected.slice(0, 12)} within 90s (last seen ${seen.slice(0, 12)})`)
}

function parseArgs(argv: string[]): { kind: ForgeKind; web: boolean } {
  const tokens = argv.slice(2).filter((arg) => arg !== '--')
  let kind: ForgeKind | undefined
  let web = false
  for (const token of tokens) {
    if (token === '--web') {
      web = true
      continue
    }
    if (token === 'github') {
      fail('publish smoke is GitLab + Gitea only; GitHub is not a poster surface')
    }
    if (token === 'gitlab' || token === 'gitea') {
      kind = token
      continue
    }
    fail(`unexpected argument ${token} (usage: … <gitlab|gitea> [--web])`)
  }
  if (kind == null) fail('usage: node --experimental-strip-types scripts/forge-smoke.ts <gitlab|gitea> [--web]')
  return { kind, web }
}

function uatHoldDir(): string {
  return process.env.UAT_HOLD_DIR != null && process.env.UAT_HOLD_DIR !== ''
    ? process.env.UAT_HOLD_DIR
    : join(tmpdir(), 'kaola-uat-web')
}

function uatHoldTimeoutMs(): number {
  const raw = process.env.UAT_HOLD_TIMEOUT_MS
  const parsed = raw != null && raw !== '' ? Number.parseInt(raw, 10) : 1_800_000
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1_800_000
}

function writeUatState(dir: string, state: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
}

async function waitForUatFlag(dir: string, expected: string, secrets: string[]): Promise<void> {
  const flag = join(dir, 'go')
  const deadline = Date.now() + uatHoldTimeoutMs()
  console.log(`uat_wait ${expected} timeout_ms=${uatHoldTimeoutMs()}`)
  while (Date.now() < deadline) {
    try {
      const got = redact(readFileSync(flag, 'utf8').trim(), secrets)
      if (got === expected) {
        unlinkSync(flag)
        console.log(`uat_flag ${expected}`)
        return
      }
      if (got !== '') fail(`unexpected UAT flag ${JSON.stringify(got)} (want ${expected})`)
    } catch {
      // flag file missing
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  fail(`timed out waiting for ${flag} to contain ${expected}`)
}

async function run(): Promise<void> {
  const { kind, web } = parseArgs(process.argv)
  const spec = FORGES[kind]
  const webPort = Number.parseInt(process.env.UAT_WEB_PORT ?? '31416', 10)
  if (web) {
    if (!Number.isInteger(webPort) || webPort <= 0) fail(`invalid UAT_WEB_PORT ${process.env.UAT_WEB_PORT}`)
    process.env.PUBLIC_URL = `http://localhost:${webPort}`
  }
  ensureSimulatedAuthEnv()
  const token = requiredEnv(spec.tokenEnv)

  const secrets = [token, STUB_OAUTH_ACCESS]
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const workRoot = mkdtempSync(join(tmpdir(), 'kaola-forge-smoke-'))
  const sqlitePath = join(workRoot, 'kaola.sqlite')
  mkdirSync(workRoot, { recursive: true })

  installOauthUserinfoStub()
  const issue = await createSmokeIssue(spec, token, stamp)
  console.log(`issue ${issue.url}`)

  const viteDevTarget =
    process.env.VITE_DEV_TARGET != null && process.env.VITE_DEV_TARGET !== ''
      ? process.env.VITE_DEV_TARGET
      : 'http://127.0.0.1:5173'
  const app = buildApp({
    sqlitePath,
    pollIntervalMs: web ? 2_000 : 0,
    viteDevTarget: web ? viteDevTarget : undefined,
  })
  await app.ready()
  const holdDir = web ? uatHoldDir() : ''
  try {
    const setup = await ensureSetup(app, DEFAULT_SETUP)
    const cookies = await loginGitlabStub(app)
    const listenHost = web ? (process.env.UAT_WEB_HOST || '0.0.0.0') : '127.0.0.1'
    const bridgeUrl = await app.listen({ host: listenHost, port: web ? webPort : 0 })
    const origin = web ? `http://localhost:${webPort}` : bridgeUrl
    if (web) console.log(`uat_origin ${origin}`)
    const kaolaHome = join(workRoot, 'kaola-home')

    const sighted = await runBridgeMessages(bridgeUrl, kaolaHome, [bridgeInitialize(1)])
    if (!sighted.stderr.includes('authorization_required')) {
      fail(`unbound bridge did not request device authorization: ${sighted.stderr}`)
    }
    const pendingRes = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/pending',
      cookies: setup.cookies,
      headers: { accept: 'application/json' },
    })
    const pendingBody = await expectJson(pendingRes, 200, 'list pending bridge device')
    const pending = pendingBody.devices
    if (!Array.isArray(pending) || pending.length !== 1) {
      fail(`expected one pending bridge device: ${pendingRes.body}`)
    }
    const pendingId = (pending[0] as { id?: unknown }).id
    if (typeof pendingId !== 'number') fail(`pending bridge device id missing: ${pendingRes.body}`)
    await expectJson(
      await app.inject({
        method: 'POST',
        url: `/api/v1/devices/${pendingId}/bind`,
        cookies: setup.cookies,
        headers: JSON_HEADERS,
        payload: { bind_to_self: true },
      }),
      200,
      'bind bridge device',
    )

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

    const tools = await bridgeListTools(bridgeUrl, kaolaHome)
    const submitTool = tools.find((tool) => tool.name === 'submit_pr')
    if (!/workflow/iu.test(String(submitTool?.description ?? ''))) {
      fail('submit_pr description did not identify Workflow completion')
    }

    const firstClaim = await bridgeToolCall(bridgeUrl, kaolaHome, 'claim_task', { task_id: task.id })
    const firstLease = firstClaim.lease as { claim_id?: unknown } | undefined
    if (typeof firstLease?.claim_id !== 'string' || !firstLease.claim_id.startsWith('clm_')) {
      fail(`first claim missing claim_id: ${JSON.stringify({ ...firstClaim, token: undefined })}`)
    }
    const released = await bridgeToolCall(bridgeUrl, kaolaHome, 'release_task', {
      task_id: task.id,
      reason: 'live smoke recovery boundary',
    })
    if ((released.task as { status?: string } | undefined)?.status !== '待认领') {
      fail(`release_task expected 待认领: ${JSON.stringify(released)}`)
    }

    // A fresh bridge process recovers the terminal receipt, receives the server's typed
    // claim_request_conflict, rotates request_id once, and claims again without caller help.
    const claimed = await bridgeToolCall(bridgeUrl, kaolaHome, 'claim_task', { task_id: task.id })
    const claimedTask = claimed.task as { status?: string } | undefined
    const claimLease = claimed.lease as { claim_id?: unknown } | undefined
    const clone = claimed.clone as
      | { suggested_dir?: string; remote_url?: string; extra_header?: CloneHeader }
      | undefined
    if (claimedTask?.status !== '进行中') fail(`claim did not enter 进行中: ${JSON.stringify({ ...claimed, token: undefined })}`)
    if (typeof claimed.token !== 'string' || claimed.token === '') fail('claim missing token')
    if (typeof claimLease?.claim_id !== 'string' || !claimLease.claim_id.startsWith('clm_')) {
      fail(`claim missing claim_id: ${JSON.stringify({ ...claimed, token: undefined })}`)
    }
    if (claimLease.claim_id === firstLease.claim_id) fail('terminal Claim recovery did not mint a fresh claim_id')
    if (clone?.remote_url == null || clone.extra_header == null) fail('claim missing clone envelope')
    const revealed = claimed.token
    secrets.push(revealed)
    if (clone.remote_url.includes(revealed)) fail('clone.remote_url contained the token')

    const replayed = await bridgeToolCall(bridgeUrl, kaolaHome, 'claim_task', { task_id: task.id })
    const replayLease = replayed.lease as { claim_id?: unknown } | undefined
    if (replayLease?.claim_id !== claimLease.claim_id || replayed.token !== revealed) {
      fail('claim replay did not return the same Claim identity and credential')
    }

    const progressed = await bridgeToolCall(bridgeUrl, kaolaHome, 'report_progress', {
      task_id: task.id,
      note: 'live smoke after Workflow start',
    })
    if ((progressed.task as { status?: string } | undefined)?.status !== '进行中') {
      fail(`report_progress expected 进行中: ${JSON.stringify(progressed)}`)
    }

    const otherDevice = await pairDeviceToSelf(app, setup.cookies, { hostname: 'forge-smoke-other-device' })
    const copiedClaimAttempt = await injectSigned(app, otherDevice.identity, {
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/progress`,
      payload: { note: 'must not pass', claim_id: claimLease.claim_id },
      extraHeaders: JSON_HEADERS,
    })
    if (copiedClaimAttempt.statusCode !== 403) {
      fail(`different device unexpectedly used copied claim_id: ${copiedClaimAttempt.statusCode} ${copiedClaimAttempt.body}`)
    }

    const branch = `kaola/${task.id}-smoke-${stamp}`
    const line = `Smoke ${kind} ${task.id} ${stamp}.`
    const pushed = cloneAndPush({
      kind,
      remoteUrl: clone.remote_url,
      extra: clone.extra_header,
      token: revealed,
      workParent: workRoot,
      branch,
      line,
      secrets,
    })
    const cloneAuth = pushed.cloneAuth
    console.log(`clone_auth ${cloneAuth}`)

    const pull = await openPull(spec, revealed, branch, `[${task.id}] ${line}`)
    console.log(`pull ${pull.url}`)

    const submitted = await bridgeToolCall(bridgeUrl, kaolaHome, 'submit_pr', {
      task_id: task.id,
      pr_url: pull.url,
      summary: line,
      head_sha: pushed.headSha,
      head_branch: branch,
    })
    const submittedTask = submitted.task as { status?: string } | undefined
    if (submittedTask?.status !== '待验收') fail(`submit_pr expected 待验收: ${JSON.stringify(submitted)}`)

    // #53 review loop, reviewer side (session REST): one blocking item, then 提交本轮意见.
    const blocking = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/review/messages`,
      cookies: setup.cookies,
      headers: JSON_HEADERS,
      payload: { body_md: `smoke: 请再补一行（${stamp}）`, kind: 'blocking' },
    })
    if (blocking.statusCode !== 201) fail(`review message ${blocking.statusCode}: ${blocking.body}`)
    const rounded = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/review/rounds`,
      cookies: setup.cookies,
      headers: JSON_HEADERS,
      payload: {},
    })
    if (rounded.statusCode !== 201) fail(`review round ${rounded.statusCode}: ${rounded.body}`)
    const roundedTask = (rounded.json() as { task?: { status?: string } }).task
    if (roundedTask?.status !== '待修改') fail(`提交本轮意见 expected 待修改, got ${JSON.stringify(roundedTask)}`)
    console.log(`review_round 1 ${task.id} 待修改`)

    // Revision Claim (any device may take it; the bridge re-claims with the same identity).
    const reclaimed = await bridgeToolCall(bridgeUrl, kaolaHome, 'claim_task', { task_id: task.id })
    const reclaimedTask = reclaimed.task as { status?: string; review_round?: number } | undefined
    if (reclaimedTask?.status !== '进行中' || reclaimedTask.review_round !== 1) {
      fail(`revision claim expected 进行中 / review_round 1: ${JSON.stringify(reclaimedTask)}`)
    }
    const revisionClaimId = (reclaimed.lease as { claim_id?: string } | undefined)?.claim_id
    if (typeof revisionClaimId !== 'string') fail('revision claim missing claim_id')
    const feedback = await bridgeToolCall(bridgeUrl, kaolaHome, 'get_review_feedback', { task_id: task.id })
    const blockingItems = feedback.blocking as Array<{ id: number; resolved: boolean }> | undefined
    if (!Array.isArray(blockingItems) || blockingItems.length !== 1 || blockingItems[0]?.resolved !== false) {
      fail(`get_review_feedback expected one unresolved blocking item: ${JSON.stringify(feedback)}`)
    }
    if (JSON.stringify(feedback).includes(revealed)) fail('get_review_feedback leaked the forge token')
    const revisionLine = `Smoke revision ${kind} ${task.id} ${stamp}.`
    const revisionSha = pushFollowUp({ dir: pushed.dir, header: pushed.header, branch, line: revisionLine, secrets })
    await bridgeToolCall(bridgeUrl, kaolaHome, 'post_discussion_message', {
      task_id: task.id,
      claim_id: revisionClaimId,
      body_md: '已补一行。',
      kind: 'resolution',
      resolves: blockingItems[0]?.id,
    })
    const revised = await bridgeToolCall(bridgeUrl, kaolaHome, 'submit_revision', {
      task_id: task.id,
      claim_id: revisionClaimId,
      pr_url: pull.url,
      head_sha: revisionSha,
      summary: revisionLine,
    })
    if ((revised.task as { status?: string } | undefined)?.status !== '待验收') {
      fail(`submit_revision expected 待验收: ${JSON.stringify(revised)}`)
    }
    console.log(`submit_revision ${revisionSha.slice(0, 12)} 待验收`)

    // #54 drift leg: a commit pushed AFTER submit_revision that the Agent never declared. 「通过」
    // must refuse it (409 head_sha_stale, both shas, no state change) and the review view must
    // show the forge head as stale; the reviewer then sends the task back for a proper hand-back.
    const driftLine = `Smoke undeclared push ${kind} ${task.id} ${stamp}.`
    const driftSha = pushFollowUp({ dir: pushed.dir, header: pushed.header, branch, line: driftLine, secrets })
    await waitForForgeHead(kind, spec, revealed, pull.url, driftSha)

    if (web) {
      writeUatState(holdDir, {
        phase: 'awaiting_ui_stale',
        origin,
        kind,
        task_id: task.id,
        issue_url: issue.url,
        pr_url: pull.url,
        login_username: DEFAULT_SETUP.username,
        recorded_head_sha: revisionSha.slice(0, 12),
        forge_head_sha: driftSha.slice(0, 12),
      })
      console.log(`uat_hold ${holdDir} task ${task.id}`)
      await waitForUatFlag(holdDir, 'round-done', secrets)
      const afterRound = await app.inject({
        method: 'GET',
        url: `/api/v1/tasks/${task.id}/review`,
        cookies: setup.cookies,
      })
      if (afterRound.statusCode !== 200) fail(`review after UI round ${afterRound.statusCode}: ${afterRound.body}`)
      if ((afterRound.json() as { status?: string }).status !== '待修改') {
        fail(`UI round expected 待修改: ${afterRound.body}`)
      }
      if (afterRound.body.includes(revealed)) fail('review view leaked the forge token')
    } else {
      const stale = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/review/approve`,
        cookies: setup.cookies,
        headers: JSON_HEADERS,
        payload: {},
      })
      if (stale.statusCode !== 409) fail(`approve after undeclared push expected 409, got ${stale.statusCode}: ${stale.body}`)
      const staleBody = stale.json() as { error?: string; recorded_head_sha?: string; forge_head_sha?: string }
      if (staleBody.error !== 'head_sha_stale') fail(`approve expected head_sha_stale: ${stale.body}`)
      if (staleBody.recorded_head_sha !== revisionSha || staleBody.forge_head_sha !== driftSha) {
        fail(`head_sha_stale shas mismatch: ${stale.body} (expected ${revisionSha} / ${driftSha})`)
      }
      if (stale.body.includes(revealed)) fail('head_sha_stale body leaked the forge token')
      const staleView = await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.id}/review`, cookies: setup.cookies })
      if (staleView.statusCode !== 200) fail(`review view ${staleView.statusCode}: ${staleView.body}`)
      const staleViewBody = staleView.json() as { status?: string; head_stale?: boolean; forge_head_sha?: string | null }
      if (staleViewBody.status !== '待验收' || staleViewBody.head_stale !== true || staleViewBody.forge_head_sha !== driftSha) {
        fail(`review view after undeclared push expected 待验收 / head_stale / forge head ${driftSha.slice(0, 12)}: ${staleView.body}`)
      }
      if (staleView.body.includes(revealed)) fail('review view leaked the forge token')
      console.log(`head_sha_stale ${task.id} recorded=${revisionSha.slice(0, 12)} forge=${driftSha.slice(0, 12)}`)

      const staleNotice = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/review/messages`,
        cookies: setup.cookies,
        headers: JSON_HEADERS,
        payload: { body_md: 'forge 头已变化，请以新 head_sha 重新交回。', kind: 'blocking' },
      })
      if (staleNotice.statusCode !== 201) fail(`stale notice ${staleNotice.statusCode}: ${staleNotice.body}`)
      const rounded2 = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/review/rounds`,
        cookies: setup.cookies,
        headers: JSON_HEADERS,
        payload: {},
      })
      if (rounded2.statusCode !== 201) fail(`review round 2 ${rounded2.statusCode}: ${rounded2.body}`)
      if ((rounded2.json() as { task?: { status?: string } }).task?.status !== '待修改') fail('round 2 expected 待修改')
    }

    const reclaimed2 = await bridgeToolCall(bridgeUrl, kaolaHome, 'claim_task', { task_id: task.id })
    const reclaimed2Task = reclaimed2.task as { status?: string; review_round?: number } | undefined
    if (reclaimed2Task?.status !== '进行中' || reclaimed2Task.review_round !== 2) {
      fail(`second revision claim expected 进行中 / review_round 2: ${JSON.stringify(reclaimed2Task)}`)
    }
    const revisionClaimId2 = (reclaimed2.lease as { claim_id?: string } | undefined)?.claim_id
    if (typeof revisionClaimId2 !== 'string') fail('second revision claim missing claim_id')
    const revised2 = await bridgeToolCall(bridgeUrl, kaolaHome, 'submit_revision', {
      task_id: task.id,
      claim_id: revisionClaimId2,
      pr_url: pull.url,
      head_sha: driftSha,
      summary: driftLine,
    })
    if ((revised2.task as { status?: string } | undefined)?.status !== '待验收') {
      fail(`second submit_revision expected 待验收: ${JSON.stringify(revised2)}`)
    }
    console.log(`submit_revision ${driftSha.slice(0, 12)} 待验收 (round 2)`)

    if (web) {
      writeUatState(holdDir, {
        phase: 'awaiting_ui_approve',
        origin,
        kind,
        task_id: task.id,
        issue_url: issue.url,
        pr_url: pull.url,
        login_username: DEFAULT_SETUP.username,
      })
      await waitForUatFlag(holdDir, 'approved', secrets)
      const approvedView = await app.inject({
        method: 'GET',
        url: `/api/v1/tasks/${task.id}/review`,
        cookies: setup.cookies,
      })
      if (approvedView.statusCode !== 200) fail(`review after UI approve ${approvedView.statusCode}: ${approvedView.body}`)
      const approvedViewBody = approvedView.json() as { status?: string; head_sha?: string }
      if (approvedViewBody.status !== '待合并') fail(`UI approve expected 待合并: ${approvedView.body}`)
      if (approvedView.body.includes(revealed)) fail('review view leaked the forge token')
    } else {
      const approved = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/review/approve`,
        cookies: setup.cookies,
        headers: JSON_HEADERS,
        payload: {},
      })
      if (approved.statusCode !== 200) fail(`approve ${approved.statusCode}: ${approved.body}`)
      const approvedBody = approved.json() as { task?: { status?: string }; head_sha?: string; head_verified?: boolean }
      if (approvedBody.task?.status !== '待合并') fail('approve expected 待合并')
      if (approvedBody.head_sha !== driftSha || approvedBody.head_verified !== true) {
        fail(`approve expected head_sha ${driftSha.slice(0, 12)} / head_verified true: ${approved.body}`)
      }
    }
    await settleWritebacks()
    const adapter = createForgeAdapter(kind, { baseUrl: spec.baseUrl })
    const prStatus = await adapter.getPullRequest({ token: revealed }, pull.url)
    if (prStatus.draft) fail(`PR still draft after 通过: ${JSON.stringify(prStatus)}`)
    if (prStatus.head_sha !== driftSha) fail(`forge head ${prStatus.head_sha} != submitted ${driftSha}`)
    console.log(`approved ${task.id} 待合并 draft=false head_verified=true`)

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
      for (const needed of ['认领', '提交PR', '完成', '翻ready']) {
        if (!transitions.has(needed)) fail(`missing 回写 ${needed}`)
      }
      const dump = db.$client.prepare('SELECT details FROM events').all() as Array<{ details: string }>
      if (dump.some((event) => event.details.includes(revealed))) fail('events.details leaked the forge token')
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
