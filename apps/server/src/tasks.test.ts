import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTaskBrief } from '@kaola/shared'
import { createDb } from './db.ts'

// Contract source: docs/DESIGN.md §5 (lifecycle), §6 (task brief), §7 (credentials),
// §10 (data model), §11 (permissions). Idiom follows apps/server/src/vault.test.ts.
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'cd'.repeat(32)

// The forge that hosts task repos is deliberately a DIFFERENT origin from the Gitea OAuth
// provider above, so a stubbed forge-API call can never be confused with a stubbed userinfo call.
const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const REPO_FULL_NAME = 'team/orders'

const INLINE_TOKEN = 'gitea-INLINE-ONE-OFF-TOKEN-zzq7'
const PROFILE_TOKEN = 'gitea-PROFILE-SHARED-TOKEN-vv31'

const TOKEN_INVALID_MESSAGE = 'token 无效或无权访问该仓库，任务未发布。'
const FORGE_UNREACHABLE_MESSAGE = '无法连接 forge 校验 token，任务未发布。'
const PROFILE_MISSING_MESSAGE = '所选凭证档案不存在。'
const PROFILE_REPO_MISMATCH_MESSAGE = '所选凭证档案与仓库不匹配。'
const REPO_BASE_URL_INVALID_MESSAGE = '仓库地址不是合法的 http 或 https 地址。'
const TOKEN_REVEAL_EVENT = 'token 揭示'

// F1 PoC victim: a gitlab profile whose plaintext must never ride a caller-chosen gitea origin.
const VICTIM_PROFILE_TOKEN = 'glpat-VICTIM-SHARED-SECRET-9f3a'
const VICTIM_GITLAB_BASE_URL = 'https://gitlab.internal.example'
const ATTACKER_BASE_URL = 'http://attacker.example'

function tokenInsufficientMessage(missing) {
  return `token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。`
}

function illegalTransitionMessage(from, to) {
  return `任务状态不允许从「${from}」变更为「${to}」。`
}

// docs/DESIGN.md §6 — the brief is the whole contract: exactly these keys, no more, no less.
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

// Every credential this suite stubs reaches `fetch` as one of three header forms:
//   OAuth userinfo  -> Authorization: Bearer <access token>   (apps/server/src/auth.ts)
//   GitHub / Gitea  -> Authorization: Bearer|token <forge token>
//   GitLab          -> PRIVATE-TOKEN: <forge token>
// Extracting the bare token from any of them lets ONE stub route both concerns by identity.
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

// THE FETCH SEAM.
// vault.test.ts / agent-keys.test.ts replace globalThis.fetch with a userinfo-only stub that
// answers 500 to every unrecognised Authorization header. 发布即校验 needs the SAME global hook
// for forge-API calls, so a second stub would clobber the first. Instead this suite installs one
// router keyed on the bare token: tokens registered in `forge` are answered as forge-API calls,
// tokens registered in `oauth` are answered as userinfo, anything else is a loud 500. Registration
// is explicit per test, so an unexpected outbound call can never pass silently.
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
        // undici's shape for DNS failure / connection refused / TLS error.
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

// Gitea repo payloads, shaped for packages/forge-adapters giteaCapabilities():
//   canPush = permissions.push === true ; canPr = canPush && has_pull_requests !== false
const REPO_FULL_ACCESS = {
  permissions: { pull: true, push: true, admin: false },
  has_pull_requests: true,
  private: true,
}
const REPO_READ_ONLY = {
  permissions: { pull: true, push: false, admin: false },
  has_pull_requests: true,
  private: true,
}
const REPO_NO_PULL_REQUESTS = {
  permissions: { pull: true, push: true, admin: false },
  has_pull_requests: false,
  private: true,
}

function allowForgeToken(stub, token, descriptor = { repo: REPO_FULL_ACCESS }) {
  stub.forge.set(token, descriptor)
}

// Local wrap on top of beginFetch — records URL + auth headers, then forwards. Does not replace the seam.
function recordOutboundFetch() {
  const inner = globalThis.fetch
  const outbound = []
  globalThis.fetch = async (input, init) => {
    outbound.push({
      url: requestUrl(input),
      authorization: readHeader(input, init, 'authorization') ?? null,
      privateToken: readHeader(input, init, 'private-token') ?? null,
    })
    return inner(input, init)
  }
  return outbound
}

function assertOutboundCarriesNoPlaintext(outbound, ...plaintexts) {
  for (const call of outbound) {
    const dumped = JSON.stringify(call)
    for (const plaintext of plaintexts) {
      assert.equal(
        dumped.includes(plaintext),
        false,
        `outbound fetch carried plaintext token ${plaintext}: ${dumped}`,
      )
    }
  }
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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-tasks-'))
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

function withAdmins(t, spec) {
  const previous = process.env.KAOLA_ADMINS
  if (spec == null || spec === '') delete process.env.KAOLA_ADMINS
  else process.env.KAOLA_ADMINS = spec
  t.after(() => {
    if (previous == null) delete process.env.KAOLA_ADMINS
    else process.env.KAOLA_ADMINS = previous
  })
}

function seedLeftoverGithub(db, { remoteId, username, displayName, status, permissionLevel }) {
  db.$client
    .prepare(
      `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
       VALUES ('github', ?, ?, ?, ?, ?, 0)`,
    )
    .run(String(remoteId), username, displayName, status, permissionLevel)
}

async function loginLeftoverGithub(app, stub, { remoteId, login, name, label }) {
  const leftoverToken = nextAccessToken(label)
  stub.oauth.set(leftoverToken, { id: Number(remoteId), login, name })
  return loginViaCallback(app, { ...PROVIDERS.github, accessToken: leftoverToken })
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

async function listTasks(app, cookies) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/tasks',
    cookies,
    headers: jsonHeaders,
  })
}

async function getTask(app, cookies, publicId) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${publicId}`,
    cookies,
    headers: jsonHeaders,
  })
}

async function patchTask(app, cookies, publicId, payload) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/tasks/${publicId}`,
    cookies,
    headers: jsonHeaders,
    payload,
  })
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

async function createTaskOk(app, cookies, payload = taskPayload()) {
  const res = await postTask(app, cookies, payload)
  assert.equal(res.statusCode, 201, `POST /api/v1/tasks: ${res.statusCode} ${res.body}`)
  const brief = jsonBody(res)
  assertBriefShape(brief)
  return { res, brief }
}

function assertBriefShape(brief) {
  assert.equal(typeof brief, 'object', `brief must be an object, got ${JSON.stringify(brief)}`)
  assert.ok(brief)
  assert.deepEqual(
    Object.keys(brief).sort(),
    [...BRIEF_KEYS].sort(),
    `brief keys must be exactly the DESIGN §6 set, got ${JSON.stringify(Object.keys(brief))}`,
  )
  // The real contract, not a restatement of it: @kaola/shared owns §6.
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

// Asserts against the SERIALIZED response, so a token hidden under any key at any depth is caught.
function assertNoTokenMaterial(res, ...plaintexts) {
  const dumped = typeof res === 'string' ? res : res.body
  for (const plaintext of plaintexts) {
    assert.equal(
      dumped.includes(plaintext),
      false,
      `response leaked plaintext token ${plaintext}: ${dumped}`,
    )
  }
  const parsed = typeof res === 'string' ? JSON.parse(res) : jsonBody(res)
  for (const key of collectKeys(parsed)) {
    assert.equal(
      SECRET_KEY_NAMES.has(key),
      false,
      `response carried a secret-bearing key "${key}": ${dumped}`,
    )
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

function taskRow(db, publicId) {
  return db.$client
    .prepare(
      'SELECT id, public_id, status, poster_user_id, credential_profile_id, inline_token_encrypted, created_at, typeof(created_at) AS created_at_type FROM tasks WHERE public_id = ?',
    )
    .get(publicId)
}

function forceStatus(db, publicId, status) {
  const info = db.$client.prepare('UPDATE tasks SET status = ? WHERE public_id = ?').run(status, publicId)
  assert.equal(info.changes, 1, `expected to force ${publicId} into ${status}`)
}

function assertUnixSeconds(value) {
  const now = Math.floor(Date.now() / 1000)
  assert.ok(Number.isInteger(Number(value)), `expected unix seconds, got ${value}`)
  const n = Number(value)
  assert.ok(n >= now - 300 && n <= now + 5, `${n} is not a current unix-second timestamp`)
}

function publicIdParts(publicId) {
  const match = /^kt-(\d{4})-(\d{4})$/.exec(String(publicId))
  assert.ok(match, `public id must match kt-YYYY-NNNN, got ${JSON.stringify(publicId)}`)
  return { year: match[1], sequence: Number(match[2]) }
}

function statusTransitionEvents(db, publicId, to) {
  return eventRows(db).filter((event) => {
    const details = parseDetails(event)
    return event.type === '状态迁移' && details?.task_id === publicId && details?.to === to
  })
}

function tokenRevealEvents(db) {
  return eventRows(db).filter((event) => event.type === TOKEN_REVEAL_EVENT)
}

function profileCiphertext(db, profileId) {
  const row = db.$client
    .prepare('SELECT token_encrypted FROM credential_profiles WHERE id = ?')
    .get(profileId)
  return row?.token_encrypted
}

function publishRevealDetails(profileId, { forge, baseUrl, fullName, outcome }) {
  return {
    profile_id: Number(profileId),
    forge,
    base_url: baseUrl,
    full_name: fullName,
    outcome,
  }
}

describe('issue #7 tasks HTTP surface', { concurrency: false }, () => {
  describe('authentication and DESIGN §11 permissions', () => {
    test('unauthenticated JSON GET/POST/PATCH return 401 unauthorized', async (t) => {
      const app = await createApp(t)

      const listed = await listTasks(app, {})
      assert.equal(listed.statusCode, 401, `GET list: ${listed.statusCode} ${listed.body}`)
      assert.equal(jsonBody(listed)?.error, 'unauthorized')

      const fetched = await getTask(app, {}, 'kt-2026-0001')
      assert.equal(fetched.statusCode, 401, `GET one: ${fetched.statusCode} ${fetched.body}`)
      assert.equal(jsonBody(fetched)?.error, 'unauthorized')

      const created = await postTask(app, {})
      assert.equal(created.statusCode, 401, `POST: ${created.statusCode} ${created.body}`)
      assert.equal(jsonBody(created)?.error, 'unauthorized')

      const patched = await patchTask(app, {}, 'kt-2026-0001', { status: '已取消' })
      assert.equal(patched.statusCode, 401, `PATCH: ${patched.statusCode} ${patched.body}`)
      assert.equal(jsonBody(patched)?.error, 'unauthorized')
    })

    test('browser-like GET /api/v1/tasks redirects to /login', async (t) => {
      const app = await createApp(t)
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { accept: 'text/html' },
      })
      assert.equal(res.statusCode, 302, `GET list as browser: ${res.statusCode} ${res.body}`)
      assert.equal(res.headers.location, '/login')
    })

    test('leftover 待批准 GitHub user may read the board (§11 查看任务板 ✓) but not post', async (t) => {
      const sqlitePath = sqliteFile(t)
      const db = openDb(t, sqlitePath)
      seedLeftoverGithub(db, {
        remoteId: 22501,
        username: 'gh-tasks-pending',
        displayName: 'Pending Poster',
        status: '待批准',
        permissionLevel: 'claim_only',
      })
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      const github = await loginLeftoverGithub(app, stub, {
        remoteId: 22501,
        login: 'gh-tasks-pending',
        name: 'Pending Poster',
        label: 'pending-poster',
      })
      assert.equal(github.body.status, '待批准')

      const listed = await listTasks(app, github.cookies)
      assert.equal(listed.statusCode, 200, `pending GET list: ${listed.statusCode} ${listed.body}`)
      assert.deepEqual(jsonBody(listed)?.tasks, [])

      const created = await postTask(app, github.cookies)
      assert.equal(created.statusCode, 403, `pending POST: ${created.statusCode} ${created.body}`)
      assert.equal(jsonBody(created)?.error, 'forbidden')
    })

    test('leftover active GitHub claim_only user may read the board but not post or patch', async (t) => {
      const sqlitePath = sqliteFile(t)
      const db = openDb(t, sqlitePath)
      seedLeftoverGithub(db, {
        remoteId: 22502,
        username: 'gh-tasks-claim-only',
        displayName: 'Claim Only',
        status: 'active',
        permissionLevel: 'claim_only',
      })
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const member = await loginGitea(app, stub, 'owner')
      const github = await loginLeftoverGithub(app, stub, {
        remoteId: 22502,
        login: 'gh-tasks-claim-only',
        name: 'Claim Only',
        label: 'claim-only',
      })

      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        cookies: github.cookies,
        headers: jsonHeaders,
      })
      assert.equal(me.json().status, 'active')
      assert.equal(me.json().permission_level, 'claim_only')

      const { brief } = await createTaskOk(app, member.cookies)

      const listed = await listTasks(app, github.cookies)
      assert.equal(listed.statusCode, 200, `claim_only GET list: ${listed.statusCode} ${listed.body}`)
      assert.equal(jsonBody(listed).tasks.length, 1)

      const created = await postTask(app, github.cookies)
      assert.equal(created.statusCode, 403, `claim_only POST: ${created.statusCode} ${created.body}`)
      assert.equal(jsonBody(created)?.error, 'forbidden')

      const patched = await patchTask(app, github.cookies, brief.id, { status: '已取消' })
      assert.equal(patched.statusCode, 403, `claim_only PATCH: ${patched.statusCode} ${patched.body}`)
      assert.equal(jsonBody(patched)?.error, 'forbidden')
    })

    test('only the 发布者 may cancel — another active full member gets 403', async (t) => {
      withAdmins(t, 'gitea:gt-bystander')
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitlab(app, stub, 'poster')
      const other = await loginGitea(app, stub, 'bystander')

      const { brief } = await createTaskOk(app, poster.cookies)

      const foreign = await patchTask(app, other.cookies, brief.id, { status: '已取消' })
      assert.equal(foreign.statusCode, 403, `non-poster PATCH: ${foreign.statusCode} ${foreign.body}`)
      assert.equal(jsonBody(foreign)?.error, 'forbidden')

      const own = await patchTask(app, poster.cookies, brief.id, { status: '已取消' })
      assert.equal(own.statusCode, 200, `poster PATCH: ${own.statusCode} ${own.body}`)
      assert.equal(jsonBody(own).status, '已取消')
    })
  })

  describe('POST /api/v1/tasks — 凭证档案下拉选择 path', () => {
    test('profile path creates a 待认领 task whose credential is { profile_id }', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'profile-path')
      const profile = await postProfile(app, poster.cookies)

      const { res, brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ credential: { profile_id: profile.id } }),
      )

      assert.equal(brief.status, '待认领')
      assert.deepEqual(brief.credential, { profile_id: String(profile.id) })
      assert.equal(brief.poster, poster.body.username)
      assertNoTokenMaterial(res, PROFILE_TOKEN, INLINE_TOKEN)
    })

    test('profile_id is accepted as a number and as a numeric string', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'profile-id-forms')
      const profile = await postProfile(app, poster.cookies)

      const asNumber = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ credential: { profile_id: profile.id } }),
      )
      const asString = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ credential: { profile_id: String(profile.id) } }),
      )

      assert.deepEqual(asNumber.brief.credential, { profile_id: String(profile.id) })
      assert.deepEqual(asString.brief.credential, { profile_id: String(profile.id) })
    })

    test('an unknown profile_id is refused with 400 invalid_body and a Chinese message', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'profile-missing')

      const res = await postTask(app, poster.cookies, taskPayload({ credential: { profile_id: 4242 } }))
      assert.equal(res.statusCode, 400, `POST: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'invalid_body')
      assert.equal(jsonBody(res)?.message, PROFILE_MISSING_MESSAGE)

      const listed = await listTasks(app, poster.cookies)
      assert.deepEqual(jsonBody(listed).tasks, [], 'a refused post must not persist a task')
    })
  })

  describe('POST /api/v1/tasks — 单任务临时 token path', () => {
    test('inline token path creates a 待认领 task whose credential is { inline: true }', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'inline-path')

      const { res, brief } = await createTaskOk(app, poster.cookies)

      assert.equal(brief.status, '待认领')
      assert.deepEqual(brief.credential, { inline: true })
      assertNoTokenMaterial(res, INLINE_TOKEN)
    })

    test('inline token is stored as ciphertext and recoverable through the vault', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'inline-ciphertext')

      const { brief } = await createTaskOk(app, poster.cookies)

      const db = openDb(t, sqlitePath)
      const row = taskRow(db, brief.id)
      assert.ok(row, `tasks row ${brief.id} missing`)
      assert.equal(typeof row.inline_token_encrypted, 'string')
      assert.notEqual(
        row.inline_token_encrypted,
        INLINE_TOKEN,
        'inline_token_encrypted must not be the plaintext token',
      )
      assert.equal(
        String(row.inline_token_encrypted).includes(INLINE_TOKEN),
        false,
        `inline_token_encrypted contained plaintext: ${row.inline_token_encrypted}`,
      )
      assert.equal(row.credential_profile_id, null, 'inline path must leave credential_profile_id NULL')
      assert.equal(Number(row.poster_user_id), Number(poster.body.id))

      const { decryptToken } = await import('./vault.ts')
      assert.equal(decryptToken(row.inline_token_encrypted), INLINE_TOKEN)
    })

    test('both credential paths return 500 vault_unconfigured without VAULT_MASTER_KEY', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      allowForgeToken(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'no-master-key')
      const profile = await postProfile(app, poster.cookies)

      const previous = process.env.VAULT_MASTER_KEY
      t.after(() => {
        process.env.VAULT_MASTER_KEY = previous
      })
      delete process.env.VAULT_MASTER_KEY

      const inline = await postTask(app, poster.cookies)
      assert.equal(inline.statusCode, 500, `inline POST: ${inline.statusCode} ${inline.body}`)
      assert.equal(jsonBody(inline)?.error, 'vault_unconfigured')

      const viaProfile = await postTask(
        app,
        poster.cookies,
        taskPayload({ credential: { profile_id: profile.id } }),
      )
      assert.equal(viaProfile.statusCode, 500, `profile POST: ${viaProfile.statusCode} ${viaProfile.body}`)
      assert.equal(jsonBody(viaProfile)?.error, 'vault_unconfigured')
    })
  })

  describe('发布即校验 — DESIGN §5', () => {
    test('a token missing 推 and PR is refused with 422 and names both capabilities', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN, { repo: REPO_READ_ONLY })
      const poster = await loginGitea(app, stub, 'under-scoped')

      const res = await postTask(app, poster.cookies)
      assert.equal(res.statusCode, 422, `POST: ${res.statusCode} ${res.body}`)
      const body = jsonBody(res)
      assert.equal(body?.error, 'token_check_failed')
      assert.deepEqual(body?.missing, ['推', 'PR'])
      assert.equal(body?.message, tokenInsufficientMessage(['推', 'PR']))
      assert.equal(body.message, 'token 权限不足：缺少 推、PR 权限，任务未发布。')
      assertNoTokenMaterial(res, INLINE_TOKEN)

      const listed = await listTasks(app, poster.cookies)
      assert.deepEqual(jsonBody(listed).tasks, [], '一个校验失败的任务不会出现在看板上')
    })

    test('a token that can push but cannot open PRs is refused naming only PR', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN, { repo: REPO_NO_PULL_REQUESTS })
      const poster = await loginGitea(app, stub, 'no-pr')

      const res = await postTask(app, poster.cookies)
      assert.equal(res.statusCode, 422, `POST: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res)?.missing, ['PR'])
      assert.equal(jsonBody(res)?.message, 'token 权限不足：缺少 PR 权限，任务未发布。')
    })

    test('a 401 token is refused with the token-invalid message, not the 权限不足 one', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN, { userStatus: 401 })
      const poster = await loginGitea(app, stub, 'expired-token')

      const res = await postTask(app, poster.cookies)
      assert.equal(res.statusCode, 422, `POST: ${res.statusCode} ${res.body}`)
      const body = jsonBody(res)
      assert.equal(body?.error, 'token_check_failed')
      assert.deepEqual(body?.missing, ['读', '推', 'PR'])
      assert.equal(body?.message, TOKEN_INVALID_MESSAGE)
      assert.notEqual(body.message, tokenInsufficientMessage(['读', '推', 'PR']))
    })

    test('a token with no access to the repo is refused with the token-invalid message', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN, { repoStatus: 404 })
      const poster = await loginGitea(app, stub, 'no-repo-access')

      const res = await postTask(app, poster.cookies)
      assert.equal(res.statusCode, 422, `POST: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res)?.missing, ['读', '推', 'PR'])
      assert.equal(jsonBody(res)?.message, TOKEN_INVALID_MESSAGE)
    })

    test('an unreachable forge is a DIFFERENT outcome: 502 with its own Chinese message', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN, { unreachable: true })
      const poster = await loginGitea(app, stub, 'unreachable')

      const res = await postTask(app, poster.cookies)
      assert.equal(res.statusCode, 502, `POST: ${res.statusCode} ${res.body}`)
      const body = jsonBody(res)
      assert.equal(body?.error, 'forge_unreachable')
      assert.equal(body?.message, FORGE_UNREACHABLE_MESSAGE)
      assert.notEqual(body.error, 'token_check_failed')
      assert.equal(body.missing, undefined, 'an unreachable forge yields no capability verdict')
      assertNoTokenMaterial(res, INLINE_TOKEN)

      const listed = await listTasks(app, poster.cookies)
      assert.deepEqual(jsonBody(listed).tasks, [])
    })

    test('the profile path is validated too — an under-scoped profile token is refused', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, PROFILE_TOKEN, { repo: REPO_READ_ONLY })
      const poster = await loginGitea(app, stub, 'profile-under-scoped')
      const profile = await postProfile(app, poster.cookies)

      const res = await postTask(app, poster.cookies, taskPayload({ credential: { profile_id: profile.id } }))
      assert.equal(res.statusCode, 422, `POST: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'token_check_failed')
      assert.deepEqual(jsonBody(res)?.missing, ['推', 'PR'])
      assertNoTokenMaterial(res, PROFILE_TOKEN)
    })
  })

  describe('任务卡字段完整符合 §6 schema', () => {
    test('a full request body round-trips every DESIGN §6 field', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'full-body')

      const payload = taskPayload()
      const { brief } = await createTaskOk(app, poster.cookies, payload)

      assert.equal(brief.title, payload.title)
      assert.equal(brief.description_md, payload.description_md)
      assert.deepEqual(brief.source, { type: 'native' })
      assert.deepEqual(brief.repo, payload.repo)
      assert.deepEqual(brief.acceptance_criteria, payload.acceptance_criteria)
      assert.equal(brief.test_command, payload.test_command)
      assert.deepEqual(brief.constraints, payload.constraints)
      assert.equal(brief.priority, payload.priority)
      assert.deepEqual(brief.tags, payload.tags)
      assert.equal(brief.status, '待认领')
      assert.equal(brief.poster, poster.body.username)
    })

    test('pr_convention is derived from the public id, per DESIGN §6', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'pr-convention')

      const { brief } = await createTaskOk(app, poster.cookies)

      assert.deepEqual(brief.pr_convention, {
        branch_prefix: `kaola/${brief.id}-`,
        title_prefix: `[${brief.id}] `,
      })
    })

    test('a client-supplied pr_convention or id or status is ignored — the server owns them', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'server-owned')

      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({
          id: 'kt-1999-0001',
          status: '已完成',
          poster: 'someone.else',
          pr_convention: { branch_prefix: 'evil/', title_prefix: 'evil ' },
          created_at: '1999-01-01T00:00:00Z',
        }),
      )

      assert.notEqual(brief.id, 'kt-1999-0001')
      assert.equal(brief.status, '待认领')
      assert.equal(brief.poster, poster.body.username)
      assert.equal(brief.pr_convention.branch_prefix, `kaola/${brief.id}-`)
      assert.notEqual(brief.created_at, '1999-01-01T00:00:00Z')
    })

    test('an imported source round-trips issue_url; a native source carries only type', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'sources')
      const issueUrl = 'https://gitea.internal.example/team/orders/issues/87'

      const imported = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ source: { type: 'imported', issue_url: issueUrl } }),
      )
      assert.deepEqual(imported.brief.source, { type: 'imported', issue_url: issueUrl })

      const native = await createTaskOk(app, poster.cookies, taskPayload({ source: { type: 'native' } }))
      assert.deepEqual(Object.keys(native.brief.source), ['type'])
      assert.deepEqual(native.brief.source, { type: 'native' })
    })

    test('a minimal request body is completed with the documented defaults', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'minimal-body')

      const { brief } = await createTaskOk(app, poster.cookies, {
        title: '最小任务',
        repo: { forge: 'gitea', base_url: FORGE_BASE_URL, full_name: REPO_FULL_NAME },
        credential: { token: INLINE_TOKEN },
      })

      assert.equal(brief.title, '最小任务')
      assert.equal(brief.description_md, '')
      assert.deepEqual(brief.source, { type: 'native' })
      assert.equal(brief.repo.base_branch, 'main')
      assert.equal(brief.repo.suggested_dir, 'orders')
      assert.deepEqual(brief.acceptance_criteria, [])
      assert.equal(brief.test_command, '')
      assert.deepEqual(brief.constraints, { allowed_paths: [], forbidden_paths: [] })
      assert.equal(brief.priority, 'P2')
      assert.deepEqual(brief.tags, [])
      assert.equal(brief.status, '待认领')
    })

    test('created_at is ISO-8601 with offset and matches the stored unix seconds', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'created-at')

      const { brief } = await createTaskOk(app, poster.cookies)

      assert.match(
        brief.created_at,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/,
        `created_at must be ISO-8601 with an offset, got ${brief.created_at}`,
      )
      const db = openDb(t, sqlitePath)
      const row = taskRow(db, brief.id)
      assert.equal(row.created_at_type, 'integer', 'tasks.created_at follows the house unix-seconds convention')
      assertUnixSeconds(row.created_at)
      assert.equal(Math.floor(Date.parse(brief.created_at) / 1000), Number(row.created_at))
    })

    for (const [label, payload] of [
      ['no title', taskPayload({ title: undefined })],
      ['an empty title', taskPayload({ title: '' })],
      ['no repo', taskPayload({ repo: undefined })],
      ['an unknown forge', taskPayload({ repo: { forge: 'svn', base_url: FORGE_BASE_URL, full_name: REPO_FULL_NAME } })],
      ['no repo.full_name', taskPayload({ repo: { forge: 'gitea', base_url: FORGE_BASE_URL } })],
      ['an unknown priority', taskPayload({ priority: 'P9' })],
      ['an unknown source type', taskPayload({ source: { type: 'cloned' } })],
      ['an imported source without issue_url', taskPayload({ source: { type: 'imported' } })],
      ['no credential', taskPayload({ credential: undefined })],
      ['an empty credential', taskPayload({ credential: {} })],
      ['both credential forms at once', taskPayload({ credential: { profile_id: 1, token: INLINE_TOKEN } })],
      ['a bare inline marker and no token', taskPayload({ credential: { inline: true } })],
      ['an empty inline token', taskPayload({ credential: { token: '' } })],
    ]) {
      test(`POST with ${label} returns 400 invalid_body`, async (t) => {
        const app = await createApp(t)
        const stub = beginFetch(t)
        allowForgeToken(stub, INLINE_TOKEN)
        const poster = await loginGitea(app, stub, 'invalid-body')

        const res = await postTask(app, poster.cookies, payload)
        assert.equal(res.statusCode, 400, `POST with ${label}: ${res.statusCode} ${res.body}`)
        assert.equal(jsonBody(res)?.error, 'invalid_body')
      })
    }
  })

  describe('public_id — kt-YYYY-NNNN', () => {
    test('public_id has the kt-YYYY-NNNN form and carries the current year', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'public-id-form')

      const { brief } = await createTaskOk(app, poster.cookies)
      const { year } = publicIdParts(brief.id)
      const now = new Date()
      assert.ok(
        [String(now.getFullYear()), String(now.getUTCFullYear())].includes(year),
        `public id year ${year} is not the current year`,
      )
    })

    test('public ids are distinct and their sequence increases', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'public-id-sequence')

      const first = await createTaskOk(app, poster.cookies)
      const second = await createTaskOk(app, poster.cookies)
      const third = await createTaskOk(app, poster.cookies)

      const ids = [first.brief.id, second.brief.id, third.brief.id]
      assert.equal(new Set(ids).size, 3, `public ids must be unique, got ${JSON.stringify(ids)}`)
      const sequences = ids.map((id) => publicIdParts(id).sequence)
      assert.ok(
        sequences[0] < sequences[1] && sequences[1] < sequences[2],
        `public id sequence must increase, got ${JSON.stringify(sequences)}`,
      )
    })

    test('public_id is UNIQUE in SQLite', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'public-id-unique')

      const first = await createTaskOk(app, poster.cookies)
      const second = await createTaskOk(app, poster.cookies)

      const db = openDb(t, sqlitePath)
      assert.throws(
        () =>
          db.$client
            .prepare('UPDATE tasks SET public_id = ? WHERE public_id = ?')
            .run(first.brief.id, second.brief.id),
        /UNIQUE/i,
        'tasks.public_id must carry a UNIQUE constraint',
      )
    })
  })

  describe('token secrecy — DESIGN §7', () => {
    test('no create/list/get response carries the inline token in any field', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'secrecy-inline')

      const { res, brief } = await createTaskOk(app, poster.cookies)
      assertNoTokenMaterial(res, INLINE_TOKEN)

      const listed = await listTasks(app, poster.cookies)
      assert.equal(listed.statusCode, 200, `GET list: ${listed.statusCode} ${listed.body}`)
      assertNoTokenMaterial(listed, INLINE_TOKEN)

      const fetched = await getTask(app, poster.cookies, brief.id)
      assert.equal(fetched.statusCode, 200, `GET one: ${fetched.statusCode} ${fetched.body}`)
      assertNoTokenMaterial(fetched, INLINE_TOKEN)
    })

    test('no create/list/get response carries the profile token in any field', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'secrecy-profile')
      const profile = await postProfile(app, poster.cookies)

      const { res, brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ credential: { profile_id: profile.id } }),
      )
      assertNoTokenMaterial(res, PROFILE_TOKEN)

      const listed = await listTasks(app, poster.cookies)
      assertNoTokenMaterial(listed, PROFILE_TOKEN)

      const fetched = await getTask(app, poster.cookies, brief.id)
      assertNoTokenMaterial(fetched, PROFILE_TOKEN)
    })
  })

  describe('GET /api/v1/tasks and GET /api/v1/tasks/:public_id', () => {
    test('list returns every task under a tasks key, each a §6 brief', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'list')

      const first = await createTaskOk(app, poster.cookies, taskPayload({ title: '任务一' }))
      const second = await createTaskOk(app, poster.cookies, taskPayload({ title: '任务二' }))

      const listed = await listTasks(app, poster.cookies)
      assert.equal(listed.statusCode, 200, `GET list: ${listed.statusCode} ${listed.body}`)
      const tasks = jsonBody(listed).tasks
      assert.ok(Array.isArray(tasks), `tasks must be an array, got ${listed.body}`)
      assert.equal(tasks.length, 2)
      for (const brief of tasks) assertBriefShape(brief)
      const byId = new Map(tasks.map((brief) => [brief.id, brief]))
      assert.equal(byId.get(first.brief.id)?.title, '任务一')
      assert.equal(byId.get(second.brief.id)?.title, '任务二')
    })

    test('get by public_id returns exactly the brief that create returned', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'get-one')

      const { brief } = await createTaskOk(app, poster.cookies)

      const fetched = await getTask(app, poster.cookies, brief.id)
      assert.equal(fetched.statusCode, 200, `GET one: ${fetched.statusCode} ${fetched.body}`)
      assert.deepEqual(jsonBody(fetched), brief)
    })

    test('an unknown public_id returns 404 not_found', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'get-missing')
      await createTaskOk(app, poster.cookies)

      const res = await getTask(app, poster.cookies, 'kt-2026-9999')
      assert.equal(res.statusCode, 404, `GET unknown: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'not_found')
    })

    test('a numeric-looking id returns 404 not_found — tasks are addressed by public_id only', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'get-numeric')
      await createTaskOk(app, poster.cookies)

      for (const raw of ['1', '0', '-1', 'not-a-task']) {
        const res = await getTask(app, poster.cookies, raw)
        assert.equal(res.statusCode, 404, `GET /api/v1/tasks/${raw}: ${res.statusCode} ${res.body}`)
        assert.equal(jsonBody(res)?.error, 'not_found')
      }
    })
  })

  describe('PATCH /api/v1/tasks/:public_id — 取消 / 重新开放', () => {
    test('待认领 → 已取消 by the poster returns the updated brief', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'cancel')

      const { brief } = await createTaskOk(app, poster.cookies)

      const res = await patchTask(app, poster.cookies, brief.id, { status: '已取消' })
      assert.equal(res.statusCode, 200, `PATCH: ${res.statusCode} ${res.body}`)
      const updated = jsonBody(res)
      assertBriefShape(updated)
      assert.equal(updated.status, '已取消')
      assert.equal(updated.id, brief.id)

      const fetched = await getTask(app, poster.cookies, brief.id)
      assert.equal(jsonBody(fetched).status, '已取消')
    })

    test('已退回 → 待认领 reopens the task', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'reopen')

      const { brief } = await createTaskOk(app, poster.cookies)
      const db = openDb(t, sqlitePath)
      forceStatus(db, brief.id, '已退回')

      const res = await patchTask(app, poster.cookies, brief.id, { status: '待认领' })
      assert.equal(res.statusCode, 200, `PATCH reopen: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res).status, '待认领')
    })

    test('已退回 → 已取消 by the poster', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'cancel-returned')

      const { brief } = await createTaskOk(app, poster.cookies)
      const db = openDb(t, sqlitePath)
      forceStatus(db, brief.id, '已退回')

      const res = await patchTask(app, poster.cookies, brief.id, { status: '已取消' })
      assert.equal(res.statusCode, 200, `PATCH: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res).status, '已取消')
    })

    test('an illegal transition 待认领 → 已完成 returns 409 with a Chinese message', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'illegal')

      const { brief } = await createTaskOk(app, poster.cookies)

      const res = await patchTask(app, poster.cookies, brief.id, { status: '已完成' })
      assert.equal(res.statusCode, 409, `PATCH: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'illegal_transition')
      assert.equal(jsonBody(res)?.message, illegalTransitionMessage('待认领', '已完成'))
      assert.equal(jsonBody(res).message, '任务状态不允许从「待认领」变更为「已完成」。')

      const fetched = await getTask(app, poster.cookies, brief.id)
      assert.equal(jsonBody(fetched).status, '待认领', 'a refused transition must not change the task')
    })

    test('待认领 → 进行中 is claim territory, not a poster edit: 409 illegal_transition', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'not-a-claim')

      const { brief } = await createTaskOk(app, poster.cookies)

      const res = await patchTask(app, poster.cookies, brief.id, { status: '进行中' })
      assert.equal(res.statusCode, 409, `PATCH: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'illegal_transition')
      assert.equal(jsonBody(res)?.message, illegalTransitionMessage('待认领', '进行中'))
    })

    test('已取消 is terminal — 已取消 → 待认领 returns 409', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'terminal')

      const { brief } = await createTaskOk(app, poster.cookies)
      const cancelled = await patchTask(app, poster.cookies, brief.id, { status: '已取消' })
      assert.equal(cancelled.statusCode, 200, `PATCH cancel: ${cancelled.statusCode} ${cancelled.body}`)

      const res = await patchTask(app, poster.cookies, brief.id, { status: '待认领' })
      assert.equal(res.statusCode, 409, `PATCH reopen cancelled: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'illegal_transition')
      assert.equal(jsonBody(res)?.message, illegalTransitionMessage('已取消', '待认领'))
    })

    test('an unknown status value returns 400 invalid_body', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'bad-status')

      const { brief } = await createTaskOk(app, poster.cookies)

      for (const payload of [{ status: 'cancelled' }, { status: '' }, {}, { status: 7 }]) {
        const res = await patchTask(app, poster.cookies, brief.id, payload)
        assert.equal(
          res.statusCode,
          400,
          `PATCH ${JSON.stringify(payload)}: ${res.statusCode} ${res.body}`,
        )
        assert.equal(jsonBody(res)?.error, 'invalid_body')
      }
    })

    test('PATCH on an unknown public_id returns 404 not_found', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'patch-missing')
      await createTaskOk(app, poster.cookies)

      const res = await patchTask(app, poster.cookies, 'kt-2026-9999', { status: '已取消' })
      assert.equal(res.statusCode, 404, `PATCH unknown: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res)?.error, 'not_found')
    })
  })

  describe('audit — 状态迁移 events (DESIGN §10)', () => {
    test('cancelling writes one 状态迁移 event naming the task, from, to and actor', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'audit-cancel')

      const { brief } = await createTaskOk(app, poster.cookies)
      const cancelled = await patchTask(app, poster.cookies, brief.id, { status: '已取消' })
      assert.equal(cancelled.statusCode, 200, `PATCH: ${cancelled.statusCode} ${cancelled.body}`)

      const db = openDb(t, sqlitePath)
      const rows = statusTransitionEvents(db, brief.id, '已取消')
      assert.equal(
        rows.length,
        1,
        `expected exactly one 状态迁移 to 已取消, got ${JSON.stringify(eventRows(db))}`,
      )
      const details = parseDetails(rows[0])
      assert.equal(details.task_id, brief.id)
      assert.equal(details.from, '待认领')
      assert.equal(details.to, '已取消')
      assert.equal(Number(rows[0].actor_user_id), Number(poster.body.id))
      assertUnixSeconds(rows[0].created_at)
    })

    test('reopening writes a 状态迁移 event from 已退回 to 待认领', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'audit-reopen')

      const { brief } = await createTaskOk(app, poster.cookies)
      const db = openDb(t, sqlitePath)
      forceStatus(db, brief.id, '已退回')

      const reopened = await patchTask(app, poster.cookies, brief.id, { status: '待认领' })
      assert.equal(reopened.statusCode, 200, `PATCH: ${reopened.statusCode} ${reopened.body}`)

      const rows = statusTransitionEvents(db, brief.id, '待认领')
      assert.equal(
        rows.length,
        1,
        `expected exactly one 状态迁移 to 待认领, got ${JSON.stringify(eventRows(db))}`,
      )
      const details = parseDetails(rows[0])
      assert.equal(details.from, '已退回')
      assert.equal(details.to, '待认领')
      assert.equal(Number(rows[0].actor_user_id), Number(poster.body.id))
    })

    test('a refused transition writes no 状态迁移 event', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'audit-refused')

      const { brief } = await createTaskOk(app, poster.cookies)
      const res = await patchTask(app, poster.cookies, brief.id, { status: '已完成' })
      assert.equal(res.statusCode, 409, `PATCH: ${res.statusCode} ${res.body}`)

      const db = openDb(t, sqlitePath)
      assert.equal(statusTransitionEvents(db, brief.id, '已完成').length, 0)
    })
  })

  describe('tasks table invariants (DESIGN §10: credential_profile_id / inline_token_encrypted 二选一)', () => {
    test('the profile path stores credential_profile_id and leaves inline_token_encrypted NULL', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'xor-profile')
      const profile = await postProfile(app, poster.cookies)

      const { brief } = await createTaskOk(
        app,
        poster.cookies,
        taskPayload({ credential: { profile_id: profile.id } }),
      )

      const db = openDb(t, sqlitePath)
      const row = taskRow(db, brief.id)
      assert.ok(row, `tasks row ${brief.id} missing`)
      assert.equal(Number(row.credential_profile_id), Number(profile.id))
      assert.equal(row.inline_token_encrypted, null)
    })

    test('SQLite refuses a row with BOTH credential columns set', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'xor-both')

      const { brief } = await createTaskOk(app, poster.cookies)

      const db = openDb(t, sqlitePath)
      assert.throws(
        () =>
          db.$client
            .prepare('UPDATE tasks SET credential_profile_id = 1 WHERE public_id = ?')
            .run(brief.id),
        /CONSTRAINT|CHECK/i,
        'the tasks table must enforce 二选一 — both columns set is not a legal row',
      )
    })

    test('SQLite refuses a row with NEITHER credential column set', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowForgeToken(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'xor-neither')

      const { brief } = await createTaskOk(app, poster.cookies)

      const db = openDb(t, sqlitePath)
      assert.throws(
        () =>
          db.$client
            .prepare('UPDATE tasks SET inline_token_encrypted = NULL WHERE public_id = ?')
            .run(brief.id),
        /CONSTRAINT|CHECK/i,
        'the tasks table must enforce 二选一 — neither column set is not a legal row',
      )
    })
  })

  describe('POST /api/v1/tasks — security-review repair (profile binding / base_url / audit)', () => {
    describe('F1 — profile-to-repo binding (exact forge + base_url + full_name)', () => {
      test('gitlab profile + gitea request is 400 before decrypt and never sends the plaintext token', async (t) => {
        const sqlitePath = sqliteFile(t)
        const app = await createApp(t, sqlitePath)
        const stub = beginFetch(t)
        allowForgeToken(stub, VICTIM_PROFILE_TOKEN)
        const poster = await loginGitea(app, stub, 'f1-forge-mismatch')
        const profile = await postProfile(app, poster.cookies, {
          forge: 'gitlab',
          base_url: VICTIM_GITLAB_BASE_URL,
          repo_full_name: REPO_FULL_NAME,
          token: VICTIM_PROFILE_TOKEN,
        })

        const outbound = recordOutboundFetch()
        const res = await postTask(
          app,
          poster.cookies,
          taskPayload({
            title: 'harvest',
            repo: {
              forge: 'gitea',
              base_url: ATTACKER_BASE_URL,
              full_name: 'anything/at-all',
            },
            credential: { profile_id: profile.id },
          }),
        )

        assert.equal(res.statusCode, 400, `POST: ${res.statusCode} ${res.body}`)
        assert.deepEqual(jsonBody(res), {
          error: 'invalid_body',
          message: PROFILE_REPO_MISMATCH_MESSAGE,
        })
        assert.equal(jsonBody(res).message, '所选凭证档案与仓库不匹配。')
        assertNoTokenMaterial(res, VICTIM_PROFILE_TOKEN, PROFILE_TOKEN, INLINE_TOKEN)
        assertOutboundCarriesNoPlaintext(outbound, VICTIM_PROFILE_TOKEN)

        const db = openDb(t, sqlitePath)
        assert.equal(
          tokenRevealEvents(db).length,
          0,
          `F1 mismatch must not write token 揭示, got ${JSON.stringify(eventRows(db))}`,
        )
        const listed = await listTasks(app, poster.cookies)
        assert.deepEqual(jsonBody(listed).tasks, [], 'a refused post must not persist a task')
      })

      test('matching forge and full_name with an attacker base_url is 400 before decrypt', async (t) => {
        const sqlitePath = sqliteFile(t)
        const app = await createApp(t, sqlitePath)
        const stub = beginFetch(t)
        allowForgeToken(stub, PROFILE_TOKEN)
        const poster = await loginGitea(app, stub, 'f1-base-url-mismatch')
        const profile = await postProfile(app, poster.cookies)

        const outbound = recordOutboundFetch()
        const res = await postTask(
          app,
          poster.cookies,
          taskPayload({
            repo: {
              forge: 'gitea',
              base_url: ATTACKER_BASE_URL,
              full_name: REPO_FULL_NAME,
            },
            credential: { profile_id: profile.id },
          }),
        )

        assert.equal(res.statusCode, 400, `POST: ${res.statusCode} ${res.body}`)
        assert.deepEqual(jsonBody(res), {
          error: 'invalid_body',
          message: PROFILE_REPO_MISMATCH_MESSAGE,
        })
        assertNoTokenMaterial(res, PROFILE_TOKEN)
        assertOutboundCarriesNoPlaintext(outbound, PROFILE_TOKEN)

        const db = openDb(t, sqlitePath)
        assert.equal(tokenRevealEvents(db).length, 0, `got ${JSON.stringify(eventRows(db))}`)
        const listed = await listTasks(app, poster.cookies)
        assert.deepEqual(jsonBody(listed).tasks, [])
      })

      test('matching forge and base_url with a different full_name is 400 before decrypt', async (t) => {
        const sqlitePath = sqliteFile(t)
        const app = await createApp(t, sqlitePath)
        const stub = beginFetch(t)
        allowForgeToken(stub, PROFILE_TOKEN)
        const poster = await loginGitea(app, stub, 'f1-full-name-mismatch')
        const profile = await postProfile(app, poster.cookies)

        const outbound = recordOutboundFetch()
        const res = await postTask(
          app,
          poster.cookies,
          taskPayload({
            repo: {
              forge: 'gitea',
              base_url: FORGE_BASE_URL,
              full_name: 'anything/at-all',
            },
            credential: { profile_id: profile.id },
          }),
        )

        assert.equal(res.statusCode, 400, `POST: ${res.statusCode} ${res.body}`)
        assert.deepEqual(jsonBody(res), {
          error: 'invalid_body',
          message: PROFILE_REPO_MISMATCH_MESSAGE,
        })
        assertNoTokenMaterial(res, PROFILE_TOKEN)
        assertOutboundCarriesNoPlaintext(outbound, PROFILE_TOKEN)

        const db = openDb(t, sqlitePath)
        assert.equal(tokenRevealEvents(db).length, 0, `got ${JSON.stringify(eventRows(db))}`)
        const listed = await listTasks(app, poster.cookies)
        assert.deepEqual(jsonBody(listed).tasks, [])
      })
    })

    describe('F2 — repo.base_url must be http(s) with a non-empty host', () => {
      for (const [label, baseUrl] of [
        ['a file: URL', 'file://example.com/tmp'],
        ['a javascript: URL', 'javascript:alert(1)'],
        ['a missing scheme', 'gitea.example'],
        ['an empty host', 'https:///'],
      ]) {
        test(`POST with repo.base_url ${label} returns 400 invalid_body before any forge fetch`, async (t) => {
          const app = await createApp(t)
          const stub = beginFetch(t)
          allowForgeToken(stub, INLINE_TOKEN)
          const poster = await loginGitea(app, stub, 'f2-base-url')

          const outbound = recordOutboundFetch()
          const res = await postTask(
            app,
            poster.cookies,
            taskPayload({
              repo: { forge: 'gitea', base_url: baseUrl, full_name: REPO_FULL_NAME },
              credential: { token: INLINE_TOKEN },
            }),
          )

          assert.equal(
            res.statusCode,
            400,
            `POST with ${label} (${baseUrl}): ${res.statusCode} ${res.body}`,
          )
          assert.deepEqual(jsonBody(res), {
            error: 'invalid_body',
            message: REPO_BASE_URL_INVALID_MESSAGE,
          })
          assert.equal(jsonBody(res).message, '仓库地址不是合法的 http 或 https 地址。')
          assertNoTokenMaterial(res, INLINE_TOKEN)
          assert.equal(
            outbound.length,
            0,
            `expected no fetch after reject, got ${JSON.stringify(outbound)}`,
          )

          const listed = await listTasks(app, poster.cookies)
          assert.deepEqual(jsonBody(listed).tasks, [])
        })
      }
    })

    describe('F3 — decrypting a stored profile for 发布即校验 writes token 揭示', () => {
      test('a matching profile 201 writes token 揭示 with pinned details; an inline token does not', async (t) => {
        const sqlitePath = sqliteFile(t)
        const app = await createApp(t, sqlitePath)
        const stub = beginFetch(t)
        allowForgeToken(stub, PROFILE_TOKEN)
        allowForgeToken(stub, INLINE_TOKEN)
        const poster = await loginGitea(app, stub, 'f3-reveal-ok')
        const profile = await postProfile(app, poster.cookies)

        const { res } = await createTaskOk(
          app,
          poster.cookies,
          taskPayload({ credential: { profile_id: profile.id } }),
        )
        assertNoTokenMaterial(res, PROFILE_TOKEN)

        const db = openDb(t, sqlitePath)
        const reveals = tokenRevealEvents(db)
        assert.equal(
          reveals.length,
          1,
          `expected one token 揭示 after profile publish, got ${JSON.stringify(eventRows(db))}`,
        )
        assert.equal(Number(reveals[0].actor_user_id), Number(poster.body.id))
        assertUnixSeconds(reveals[0].created_at)
        assert.deepEqual(
          parseDetails(reveals[0]),
          publishRevealDetails(profile.id, {
            forge: 'gitea',
            baseUrl: FORGE_BASE_URL,
            fullName: REPO_FULL_NAME,
            outcome: 'ok',
          }),
        )
        const dumped = JSON.stringify(reveals[0])
        assert.equal(dumped.includes(PROFILE_TOKEN), false, `reveal event leaked plaintext: ${dumped}`)
        const ciphertext = profileCiphertext(db, profile.id)
        assert.equal(typeof ciphertext, 'string')
        assert.equal(
          dumped.includes(ciphertext),
          false,
          `reveal event leaked ciphertext: ${dumped}`,
        )
        assert.equal(
          Object.prototype.hasOwnProperty.call(parseDetails(reveals[0]), 'agent_key_id'),
          false,
          'publish-time reveal must omit agent_key_id',
        )

        await createTaskOk(app, poster.cookies)
        assert.equal(
          tokenRevealEvents(db).length,
          1,
          `inline token path must not write token 揭示, got ${JSON.stringify(eventRows(db))}`,
        )
      })

      test('a profile-path 422 still writes token 揭示 (plaintext already left the process)', async (t) => {
        const sqlitePath = sqliteFile(t)
        const app = await createApp(t, sqlitePath)
        const stub = beginFetch(t)
        allowForgeToken(stub, PROFILE_TOKEN, { repo: REPO_READ_ONLY })
        const poster = await loginGitea(app, stub, 'f3-reveal-422')
        const profile = await postProfile(app, poster.cookies)

        const res = await postTask(
          app,
          poster.cookies,
          taskPayload({ credential: { profile_id: profile.id } }),
        )
        assert.equal(res.statusCode, 422, `POST: ${res.statusCode} ${res.body}`)
        assert.equal(jsonBody(res)?.error, 'token_check_failed')
        assertNoTokenMaterial(res, PROFILE_TOKEN)

        const db = openDb(t, sqlitePath)
        const reveals = tokenRevealEvents(db)
        assert.equal(
          reveals.length,
          1,
          `expected one token 揭示 after 422, got ${JSON.stringify(eventRows(db))}`,
        )
        assert.equal(Number(reveals[0].actor_user_id), Number(poster.body.id))
        assertUnixSeconds(reveals[0].created_at)
        assert.deepEqual(
          parseDetails(reveals[0]),
          publishRevealDetails(profile.id, {
            forge: 'gitea',
            baseUrl: FORGE_BASE_URL,
            fullName: REPO_FULL_NAME,
            outcome: 'token_check_failed',
          }),
        )
        const dumped = JSON.stringify(reveals[0])
        assert.equal(dumped.includes(PROFILE_TOKEN), false, `reveal event leaked plaintext: ${dumped}`)
        const ciphertext = profileCiphertext(db, profile.id)
        assert.equal(dumped.includes(ciphertext), false, `reveal event leaked ciphertext: ${dumped}`)
      })

      test('a profile-path 502 still writes token 揭示 (plaintext already left the process)', async (t) => {
        const sqlitePath = sqliteFile(t)
        const app = await createApp(t, sqlitePath)
        const stub = beginFetch(t)
        allowForgeToken(stub, PROFILE_TOKEN, { unreachable: true })
        const poster = await loginGitea(app, stub, 'f3-reveal-502')
        const profile = await postProfile(app, poster.cookies)

        const res = await postTask(
          app,
          poster.cookies,
          taskPayload({ credential: { profile_id: profile.id } }),
        )
        assert.equal(res.statusCode, 502, `POST: ${res.statusCode} ${res.body}`)
        assert.equal(jsonBody(res)?.error, 'forge_unreachable')
        assertNoTokenMaterial(res, PROFILE_TOKEN)

        const db = openDb(t, sqlitePath)
        const reveals = tokenRevealEvents(db)
        assert.equal(
          reveals.length,
          1,
          `expected one token 揭示 after 502, got ${JSON.stringify(eventRows(db))}`,
        )
        assert.equal(Number(reveals[0].actor_user_id), Number(poster.body.id))
        assertUnixSeconds(reveals[0].created_at)
        assert.deepEqual(
          parseDetails(reveals[0]),
          publishRevealDetails(profile.id, {
            forge: 'gitea',
            baseUrl: FORGE_BASE_URL,
            fullName: REPO_FULL_NAME,
            outcome: 'forge_unreachable',
          }),
        )
        const dumped = JSON.stringify(reveals[0])
        assert.equal(dumped.includes(PROFILE_TOKEN), false, `reveal event leaked plaintext: ${dumped}`)
        const ciphertext = profileCiphertext(db, profile.id)
        assert.equal(dumped.includes(ciphertext), false, `reveal event leaked ciphertext: ${dumped}`)
      })
    })
  })
})
