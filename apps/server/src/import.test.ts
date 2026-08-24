import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.ts'

// Issue #12. HTTP draft seam POST /api/v1/tasks/import. Seams copied from tasks.test.ts
// (do not import that file). Drives the real `buildApp`; stub global fetch for the Issue GET only.
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'cd'.repeat(32)

const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const REPO_FULL_NAME = 'team/orders'
const ISSUE_NUMBER = 87
const ISSUE_WEB_URL = `${FORGE_BASE_URL}/${REPO_FULL_NAME}/issues/${ISSUE_NUMBER}`
const ISSUE_API_URL = `${FORGE_BASE_URL}/api/v1/repos/${encodeURIComponent('team')}/${encodeURIComponent('orders')}/issues/${ISSUE_NUMBER}`
const ISSUE_TITLE = '为订单导出接口增加分页'
const ISSUE_BODY = '从 Issue 导入的正文'

const INLINE_TOKEN = 'gitea-INLINE-ONE-OFF-TOKEN-zzq7'
const PROFILE_TOKEN = 'gitea-PROFILE-SHARED-TOKEN-vv31'

const TOKEN_REVEAL_EVENT = 'token 揭示'
const PROFILE_MISSING_MESSAGE = '所选凭证档案不存在。'
const PROFILE_REPO_MISMATCH_MESSAGE = '所选凭证档案与仓库不匹配。'
const REPO_BASE_URL_INVALID_MESSAGE = '仓库地址不是合法的 http 或 https 地址。'
const UNPARSEABLE_ISSUE_URL_MESSAGE = '无法解析 Issue 地址。'
const ISSUE_NOT_FOUND_MESSAGE = '无法读取该 Issue。'
const TOKEN_CHECK_FAILED_MESSAGE = 'token 无效或无权读取该 Issue。'
const FORGE_UNREACHABLE_MESSAGE = '无法连接 forge 导入 Issue。'
const ISSUE_REPO_MISMATCH_MESSAGE = 'Issue 地址与仓库不匹配。'

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

function isIssueEndpoint(url) {
  return /\/issues\/\d+(?:[/?#]|$)/u.test(url)
}

function isUserEndpoint(url) {
  return url.endsWith('/user')
}

const DEFAULT_ISSUE = { title: ISSUE_TITLE, body: ISSUE_BODY }

function beginFetch(t) {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const oauth = new Map()
  const issue = new Map()
  const outbound = []
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    outbound.push({
      url,
      authorization: readHeader(input, init, 'authorization') ?? null,
      privateToken: readHeader(input, init, 'private-token') ?? null,
    })
    const token = stubbedToken(input, init)
    if (isIssueEndpoint(url)) {
      const stub = token == null ? undefined : issue.get(token)
      if (stub == null) return jsonResponse(500, { error: 'unstubbed issue endpoint', url, token: token ?? null })
      if (stub.unreachable) throw new TypeError('fetch failed')
      const status = stub.status ?? 200
      if (status !== 200) return jsonResponse(status, stub.body ?? { message: 'error' })
      return jsonResponse(200, stub.body ?? DEFAULT_ISSUE)
    }
    const profile = token == null ? undefined : oauth.get(token)
    if (profile != null) return jsonResponse(200, profile)
    return jsonResponse(500, { error: 'unstubbed fetch', url, token: token ?? null })
  }
  return { oauth, issue, outbound }
}

function allowIssue(stub, token, descriptor = {}) {
  stub.issue.set(token, descriptor)
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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-import-'))
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

function importPayload(overrides = {}) {
  return {
    issue_url: ISSUE_WEB_URL,
    repo: {
      forge: 'gitea',
      base_url: FORGE_BASE_URL,
    },
    credential: { token: INLINE_TOKEN },
    ...overrides,
  }
}

async function postImport(app, cookies, payload = importPayload()) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/tasks/import',
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

function tokenRevealEvents(db) {
  return eventRows(db).filter((event) => event.type === TOKEN_REVEAL_EVENT)
}

function profileCiphertext(db, profileId) {
  const row = db.$client
    .prepare('SELECT token_encrypted FROM credential_profiles WHERE id = ?')
    .get(profileId)
  return row?.token_encrypted
}

function taskCount(db) {
  const row = db.$client.prepare('SELECT COUNT(*) AS n FROM tasks').get()
  return Number(row?.n ?? 0)
}

function assertUnixSeconds(value) {
  const now = Math.floor(Date.now() / 1000)
  assert.ok(Number.isInteger(Number(value)), `expected unix seconds, got ${value}`)
  const n = Number(value)
  assert.ok(n >= now - 300 && n <= now + 5, `${n} is not a current unix-second timestamp`)
}

function issueGets(outbound, since = 0) {
  return outbound.slice(since).filter((call) => isIssueEndpoint(call.url))
}

function userGets(outbound, since = 0) {
  return outbound.slice(since).filter((call) => isUserEndpoint(call.url))
}

function assertImportDraft(body) {
  assert.deepEqual(body, {
    title: ISSUE_TITLE,
    description_md: ISSUE_BODY,
    source: { type: 'imported', issue_url: ISSUE_WEB_URL },
    repo: { forge: 'gitea', base_url: FORGE_BASE_URL, full_name: REPO_FULL_NAME },
  })
}

describe('issue #12 POST /api/v1/tasks/import', { concurrency: false }, () => {
  describe('authentication (same gate as POST /api/v1/tasks)', () => {
    test('unauthenticated JSON POST returns 401 unauthorized', async (t) => {
      const app = await createApp(t)
      const res = await postImport(app, {})
      assert.equal(res.statusCode, 401, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'unauthorized' })
    })

    test('leftover 待批准 GitHub user gets 403 forbidden', async (t) => {
      const sqlitePath = sqliteFile(t)
      const db = openDb(t, sqlitePath)
      seedLeftoverGithub(db, {
        remoteId: 22201,
        username: 'gh-import-pending',
        displayName: 'Pending Import',
        status: '待批准',
        permissionLevel: 'claim_only',
      })
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      const github = await loginLeftoverGithub(app, stub, {
        remoteId: 22201,
        login: 'gh-import-pending',
        name: 'Pending Import',
        label: 'pending-import',
      })
      assert.equal(github.body.status, '待批准')
      assert.equal(github.body.permission_level, 'claim_only')
      const res = await postImport(app, github.cookies)
      assert.equal(res.statusCode, 403, `pending import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'forbidden' })
    })

    test('leftover active claim_only GitHub user gets 403 forbidden', async (t) => {
      const sqlitePath = sqliteFile(t)
      const db = openDb(t, sqlitePath)
      seedLeftoverGithub(db, {
        remoteId: 22202,
        username: 'gh-import-claim-only',
        displayName: 'Claim Only Import',
        status: 'active',
        permissionLevel: 'claim_only',
      })
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      const member = await loginGitea(app, stub, 'owner')
      const github = await loginLeftoverGithub(app, stub, {
        remoteId: 22202,
        login: 'gh-import-claim-only',
        name: 'Claim Only Import',
        label: 'claim-only-import',
      })
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        cookies: github.cookies,
        headers: jsonHeaders,
      })
      assert.equal(me.json().status, 'active')
      assert.equal(me.json().permission_level, 'claim_only')
      assert.notEqual(Number(github.body.id), Number(member.body.id))
      const res = await postImport(app, github.cookies)
      assert.equal(res.statusCode, 403, `claim_only import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'forbidden' })
    })
  })

  describe('success is a pre-publish draft (200, no tasks row, no token)', () => {
    test('inline credential returns 200 mapped fields and does not insert a tasks row', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'inline-ok')
      const afterLogin = stub.outbound.length

      const res = await postImport(app, poster.cookies)
      assert.equal(res.statusCode, 200, `POST import: ${res.statusCode} ${res.body}`)
      assertImportDraft(jsonBody(res))
      assertNoTokenMaterial(res, INLINE_TOKEN, PROFILE_TOKEN)

      const gets = issueGets(stub.outbound, afterLogin)
      assert.equal(gets.length, 1, `expected one Issue GET, got ${JSON.stringify(stub.outbound.slice(afterLogin))}`)
      assert.equal(gets[0].url, ISSUE_API_URL)
      assert.equal(userGets(stub.outbound, afterLogin).length, 0, 'import must not call validateToken (/user)')

      const db = openDb(t, sqlitePath)
      assert.equal(taskCount(db), 0, 'import must not persist a tasks row')
      assert.equal(tokenRevealEvents(db).length, 0, 'inline path must not write token 揭示')

      const listed = await listTasks(app, poster.cookies)
      assert.deepEqual(jsonBody(listed).tasks, [])
    })

    test('optional repo.full_name matching the parsed name still 200', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'full-name-ok')
      const res = await postImport(
        app,
        poster.cookies,
        importPayload({ repo: { forge: 'gitea', base_url: FORGE_BASE_URL, full_name: REPO_FULL_NAME } }),
      )
      assert.equal(res.statusCode, 200, `POST import: ${res.statusCode} ${res.body}`)
      assertImportDraft(jsonBody(res))
      assert.equal(taskCount(openDb(t, sqlitePath)), 0)
    })

    test('trailing slash on issue_url is stripped in source.issue_url', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'slash')
      const res = await postImport(app, poster.cookies, importPayload({ issue_url: `${ISSUE_WEB_URL}/` }))
      assert.equal(res.statusCode, 200, `POST import: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res).source.issue_url, ISSUE_WEB_URL)
    })

    test('gitea constructor baseUrl is used, not the pasted issue host (SSRF)', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'ssrf')
      const afterLogin = stub.outbound.length
      const pasted = `https://attacker.example/${REPO_FULL_NAME}/issues/${ISSUE_NUMBER}`
      const res = await postImport(app, poster.cookies, importPayload({ issue_url: pasted }))
      assert.equal(res.statusCode, 200, `POST import: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res).source.issue_url, pasted)
      assert.equal(jsonBody(res).repo.base_url, FORGE_BASE_URL)
      assert.equal(jsonBody(res).repo.full_name, REPO_FULL_NAME)
      const gets = issueGets(stub.outbound, afterLogin)
      assert.equal(gets.length, 1)
      assert.equal(gets[0].url, ISSUE_API_URL)
      assert.equal(
        stub.outbound.slice(afterLogin).some((call) => call.url.includes('attacker.example')),
        false,
        `must not fetch the pasted host: ${JSON.stringify(stub.outbound.slice(afterLogin))}`,
      )
    })
  })

  describe('error mapping', () => {
    test('generic parse / missing issue_url / missing forge is 400 invalid_body with no message', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'parse')
      const afterLogin = stub.outbound.length

      const cases = [
        importPayload({ issue_url: undefined }),
        { repo: { forge: 'gitea', base_url: FORGE_BASE_URL }, credential: { token: INLINE_TOKEN } },
        importPayload({ repo: { base_url: FORGE_BASE_URL } }),
        importPayload({ credential: {} }),
        importPayload({ credential: { token: INLINE_TOKEN, profile_id: 3 } }),
      ]
      for (const payload of cases) {
        const res = await postImport(app, poster.cookies, payload)
        assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)}: ${res.statusCode} ${res.body}`)
        assert.deepEqual(jsonBody(res), { error: 'invalid_body' })
        assert.equal(Object.prototype.hasOwnProperty.call(jsonBody(res), 'message'), false)
      }
      assert.equal(issueGets(stub.outbound, afterLogin).length, 0)
    })

    test('unparseable issue_url is 400 with 无法解析 Issue 地址 and does not fetch', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'unparseable')
      const afterLogin = stub.outbound.length
      const res = await postImport(
        app,
        poster.cookies,
        importPayload({ issue_url: `${FORGE_BASE_URL}/${REPO_FULL_NAME}/pulls/${ISSUE_NUMBER}` }),
      )
      assert.equal(res.statusCode, 400, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'invalid_body', message: UNPARSEABLE_ISSUE_URL_MESSAGE })
      assert.equal(issueGets(stub.outbound, afterLogin).length, 0)
    })

    test('repo.full_name that does not equal the parsed name is 400 Issue 地址与仓库不匹配', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN)
      const poster = await loginGitea(app, stub, 'mismatch')
      const afterLogin = stub.outbound.length
      const res = await postImport(
        app,
        poster.cookies,
        importPayload({
          repo: { forge: 'gitea', base_url: FORGE_BASE_URL, full_name: 'other/repo' },
        }),
      )
      assert.equal(res.statusCode, 400, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'invalid_body', message: ISSUE_REPO_MISMATCH_MESSAGE })
      assert.equal(issueGets(stub.outbound, afterLogin).length, 0)
    })

    test('repo.base_url that is not http(s)+host uses the publish Chinese message', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      const poster = await loginGitea(app, stub, 'bad-base')
      const res = await postImport(
        app,
        poster.cookies,
        importPayload({ repo: { forge: 'gitea', base_url: 'not-a-url' } }),
      )
      assert.equal(res.statusCode, 400, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'invalid_body', message: REPO_BASE_URL_INVALID_MESSAGE })
    })

    test('forge 404 is 404 issue_not_found', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN, { status: 404 })
      const poster = await loginGitea(app, stub, '404')
      const res = await postImport(app, poster.cookies)
      assert.equal(res.statusCode, 404, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'issue_not_found', message: ISSUE_NOT_FOUND_MESSAGE })
      assertNoTokenMaterial(res, INLINE_TOKEN)
    })

    test('forge 410 is 404 issue_not_found', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN, { status: 410 })
      const poster = await loginGitea(app, stub, '410')
      const res = await postImport(app, poster.cookies)
      assert.equal(res.statusCode, 404, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'issue_not_found', message: ISSUE_NOT_FOUND_MESSAGE })
    })

    test('forge 401 is 422 token_check_failed with missing 读', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN, { status: 401 })
      const poster = await loginGitea(app, stub, '401')
      const res = await postImport(app, poster.cookies)
      assert.equal(res.statusCode, 422, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), {
        error: 'token_check_failed',
        missing: ['读'],
        message: TOKEN_CHECK_FAILED_MESSAGE,
      })
    })

    test('other non-OK forge status is 502 forge_unreachable', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN, { status: 503 })
      const poster = await loginGitea(app, stub, '503')
      const res = await postImport(app, poster.cookies)
      assert.equal(res.statusCode, 502, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'forge_unreachable', message: FORGE_UNREACHABLE_MESSAGE })
    })

    test('fetch/network throw is 502 forge_unreachable', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, INLINE_TOKEN, { unreachable: true })
      const poster = await loginGitea(app, stub, 'net')
      const res = await postImport(app, poster.cookies)
      assert.equal(res.statusCode, 502, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'forge_unreachable', message: FORGE_UNREACHABLE_MESSAGE })
    })
  })

  describe('profile credential bind, decrypt, and token 揭示', () => {
    test('matching profile 200 writes token 揭示 outcome ok; no tasks row; no token in JSON', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowIssue(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'profile-ok')
      const profile = await postProfile(app, poster.cookies)
      const afterSetup = stub.outbound.length

      const res = await postImport(
        app,
        poster.cookies,
        importPayload({ credential: { profile_id: profile.id } }),
      )
      assert.equal(res.statusCode, 200, `POST import: ${res.statusCode} ${res.body}`)
      assertImportDraft(jsonBody(res))
      assertNoTokenMaterial(res, PROFILE_TOKEN, INLINE_TOKEN)
      assert.equal(userGets(stub.outbound, afterSetup).length, 0, 'import must not call validateToken')
      assert.equal(issueGets(stub.outbound, afterSetup).length, 1)

      const db = openDb(t, sqlitePath)
      assert.equal(taskCount(db), 0)
      const reveals = tokenRevealEvents(db)
      assert.equal(reveals.length, 1, `expected one token 揭示, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(Number(reveals[0].actor_user_id), Number(poster.body.id))
      assertUnixSeconds(reveals[0].created_at)
      assert.deepEqual(parseDetails(reveals[0]), {
        profile_id: Number(profile.id),
        forge: 'gitea',
        base_url: FORGE_BASE_URL,
        full_name: REPO_FULL_NAME,
        outcome: 'ok',
      })
      const dumped = JSON.stringify(reveals[0])
      assert.equal(dumped.includes(PROFILE_TOKEN), false, `reveal event leaked plaintext: ${dumped}`)
      const ciphertext = profileCiphertext(db, profile.id)
      assert.equal(typeof ciphertext, 'string')
      assert.equal(dumped.includes(ciphertext), false, `reveal event leaked ciphertext: ${dumped}`)
      assert.equal(
        Object.prototype.hasOwnProperty.call(parseDetails(reveals[0]), 'agent_key_id'),
        false,
        'import-time reveal must omit agent_key_id',
      )
    })

    test('profile-path 404 still writes token 揭示 with outcome issue_not_found', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowIssue(stub, PROFILE_TOKEN, { status: 404 })
      const poster = await loginGitea(app, stub, 'profile-404')
      const profile = await postProfile(app, poster.cookies)
      const res = await postImport(
        app,
        poster.cookies,
        importPayload({ credential: { profile_id: profile.id } }),
      )
      assert.equal(res.statusCode, 404, `POST import: ${res.statusCode} ${res.body}`)
      assert.equal(jsonBody(res).error, 'issue_not_found')
      const db = openDb(t, sqlitePath)
      const reveals = tokenRevealEvents(db)
      assert.equal(reveals.length, 1, `expected one token 揭示 after 404, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(parseDetails(reveals[0]).outcome, 'issue_not_found')
      assert.equal(parseDetails(reveals[0]).profile_id, Number(profile.id))
      assert.equal(taskCount(db), 0)
    })

    test('profile-path 401 still writes token 揭示 with outcome token_check_failed', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowIssue(stub, PROFILE_TOKEN, { status: 401 })
      const poster = await loginGitea(app, stub, 'profile-401')
      const profile = await postProfile(app, poster.cookies)
      const res = await postImport(
        app,
        poster.cookies,
        importPayload({ credential: { profile_id: profile.id } }),
      )
      assert.equal(res.statusCode, 422, `POST import: ${res.statusCode} ${res.body}`)
      const db = openDb(t, sqlitePath)
      const reveals = tokenRevealEvents(db)
      assert.equal(reveals.length, 1, `expected one token 揭示 after 401, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(parseDetails(reveals[0]).outcome, 'token_check_failed')
    })

    test('profile-path 502 still writes token 揭示 with outcome forge_unreachable', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowIssue(stub, PROFILE_TOKEN, { unreachable: true })
      const poster = await loginGitea(app, stub, 'profile-502')
      const profile = await postProfile(app, poster.cookies)
      const res = await postImport(
        app,
        poster.cookies,
        importPayload({ credential: { profile_id: profile.id } }),
      )
      assert.equal(res.statusCode, 502, `POST import: ${res.statusCode} ${res.body}`)
      const db = openDb(t, sqlitePath)
      const reveals = tokenRevealEvents(db)
      assert.equal(reveals.length, 1, `expected one token 揭示 after 502, got ${JSON.stringify(eventRows(db))}`)
      assert.equal(parseDetails(reveals[0]).outcome, 'forge_unreachable')
    })

    test('unparseable issue_url with profile_id does not decrypt (no token 揭示, no fetch)', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowIssue(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'parse-before-decrypt')
      const profile = await postProfile(app, poster.cookies)
      const afterSetup = stub.outbound.length
      const res = await postImport(
        app,
        poster.cookies,
        importPayload({
          issue_url: 'https://example.com/totally/not/an/issue',
          credential: { profile_id: profile.id },
        }),
      )
      assert.equal(res.statusCode, 400, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'invalid_body', message: UNPARSEABLE_ISSUE_URL_MESSAGE })
      assert.equal(issueGets(stub.outbound, afterSetup).length, 0)
      const db = openDb(t, sqlitePath)
      assert.equal(
        tokenRevealEvents(db).length,
        0,
        `parse-before-decrypt must not write token 揭示, got ${JSON.stringify(eventRows(db))}`,
      )
    })

    test('missing profile is 400 所选凭证档案不存在', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      const poster = await loginGitea(app, stub, 'missing-profile')
      const res = await postImport(app, poster.cookies, importPayload({ credential: { profile_id: 4242 } }))
      assert.equal(res.statusCode, 400, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'invalid_body', message: PROFILE_MISSING_MESSAGE })
    })

    test('profile bind is exact forge/base_url/parsed full_name (mismatch does not decrypt)', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowIssue(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'bind-mismatch')
      const profile = await postProfile(app, poster.cookies, { repo_full_name: 'other/repo' })
      const afterSetup = stub.outbound.length
      const res = await postImport(
        app,
        poster.cookies,
        importPayload({ credential: { profile_id: profile.id } }),
      )
      assert.equal(res.statusCode, 400, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'invalid_body', message: PROFILE_REPO_MISMATCH_MESSAGE })
      assert.equal(issueGets(stub.outbound, afterSetup).length, 0)
      const db = openDb(t, sqlitePath)
      assert.equal(
        tokenRevealEvents(db).length,
        0,
        `bind mismatch must not write token 揭示, got ${JSON.stringify(eventRows(db))}`,
      )
    })

    test('profile path without VAULT_MASTER_KEY returns 500 vault_unconfigured', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowIssue(stub, PROFILE_TOKEN)
      const poster = await loginGitea(app, stub, 'vault')
      const profile = await postProfile(app, poster.cookies)
      const previous = process.env.VAULT_MASTER_KEY
      t.after(() => {
        process.env.VAULT_MASTER_KEY = previous
      })
      delete process.env.VAULT_MASTER_KEY
      const res = await postImport(
        app,
        poster.cookies,
        importPayload({ credential: { profile_id: profile.id } }),
      )
      assert.equal(res.statusCode, 500, `POST import: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'vault_unconfigured' })
    })
  })
})
