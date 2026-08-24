import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.ts'

// Issue #19. HTTP seam GET /api/v1/credential-profiles/:id/issues.
// Seams copied from vault.test.ts / import.test.ts (do not import those files).
// Drives real `buildApp`; stub globalThis.fetch for OAuth userinfo + the forge list GET only.

const GITLAB_OAUTH_BASE_URL = 'https://gitlab.example.test'
const GITEA_OAUTH_BASE_URL = 'https://gitea.example.test'
const VAULT_MASTER_KEY_HEX = 'ef'.repeat(32)

const GITEA_FORGE_BASE_URL = 'https://gitea.forge.example.test'
const GITEA_REPO_FULL_NAME = 'team/orders'
const GITEA_ISSUE_NUMBER = 87
const GITEA_ISSUE_TITLE = '为订单导出接口增加分页'
const GITEA_ISSUE_URL = `${GITEA_FORGE_BASE_URL}/${GITEA_REPO_FULL_NAME}/issues/${GITEA_ISSUE_NUMBER}`
const GITEA_LIST_API_URL = `${GITEA_FORGE_BASE_URL}/api/v1/repos/${encodeURIComponent('team')}/${encodeURIComponent('orders')}/issues?state=open&type=issues&limit=50`
const GITEA_MISLEADING_HTML_URL = `https://html-url.example/${GITEA_REPO_FULL_NAME}/issues/${GITEA_ISSUE_NUMBER}`

const GITLAB_FORGE_BASE_URL = 'https://gitlab.forge.example.test'
const GITLAB_REPO_FULL_NAME = 'acme/vault-demo'
const GITLAB_IID = 42
const GITLAB_INTERNAL_ID = 900042
const GITLAB_ISSUE_TITLE = '修复分页'
const GITLAB_ISSUE_URL = `${GITLAB_FORGE_BASE_URL}/${GITLAB_REPO_FULL_NAME}/-/issues/${GITLAB_IID}`
const GITLAB_LIST_API_URL = `${GITLAB_FORGE_BASE_URL}/api/v4/projects/${encodeURIComponent(GITLAB_REPO_FULL_NAME)}/issues?state=opened&per_page=50&order_by=created_at&sort=desc`
const GITLAB_WORK_ITEMS_WEB_URL = `https://evil.example/${GITLAB_REPO_FULL_NAME}/-/work_items/${GITLAB_IID}`

const GITEA_PROFILE_TOKEN = 'gitea-PROFILE-LIST-ISSUES-TOKEN-k19'
const GITLAB_PROFILE_TOKEN = 'gitlab-PROFILE-LIST-ISSUES-TOKEN-k19'

const TOKEN_REVEAL_EVENT = 'token 揭示'
const TOKEN_CHECK_FAILED_MESSAGE = 'token 无效或无权读取该 Issue。'
const FORGE_UNREACHABLE_MESSAGE = '无法连接 forge 列出 Issue。'
const IMPORT_FORGE_UNREACHABLE_MESSAGE = '无法连接 forge 导入 Issue。'
const ISSUE_NOT_FOUND_MESSAGE = '无法读取该 Issue。'

const SECRET_KEY_NAMES = new Set(['token', 'token_encrypted', 'inline_token_encrypted', 'access_token'])

function applyOauthTestEnv() {
  process.env.OAUTH_GITHUB_CLIENT_ID = 'test-github-client-id'
  process.env.OAUTH_GITHUB_CLIENT_SECRET = 'test-github-client-secret'
  process.env.OAUTH_GITLAB_CLIENT_ID = 'test-gitlab-client-id'
  process.env.OAUTH_GITLAB_CLIENT_SECRET = 'test-gitlab-client-secret'
  process.env.OAUTH_GITLAB_BASE_URL = GITLAB_OAUTH_BASE_URL
  process.env.OAUTH_GITEA_CLIENT_ID = 'test-gitea-client-id'
  process.env.OAUTH_GITEA_CLIENT_SECRET = 'test-gitea-client-secret'
  process.env.OAUTH_GITEA_BASE_URL = GITEA_OAUTH_BASE_URL
  process.env.SESSION_SECRET = '0'.repeat(32)
  process.env.PUBLIC_URL = 'http://localhost:3000'
  process.env.VAULT_MASTER_KEY = VAULT_MASTER_KEY_HEX
}

applyOauthTestEnv()

const { buildApp } = await import('./app.ts')

const PROVIDERS = {
  github: {
    decoratorName: 'githubOAuth2',
    callbackPath: '/login/github/callback',
  },
  gitlab: {
    decoratorName: 'gitlabOAuth2',
    callbackPath: '/login/gitlab/callback',
  },
  gitea: {
    decoratorName: 'giteaOAuth2',
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

function isListIssuesEndpoint(url) {
  return /\/issues(?:\?|$)/u.test(url) && !/\/issues\/\d+/u.test(url)
}

function isUserEndpoint(url) {
  return url.endsWith('/user')
}

function giteaListJson() {
  return [
    {
      id: 800000 + GITEA_ISSUE_NUMBER,
      number: GITEA_ISSUE_NUMBER,
      title: GITEA_ISSUE_TITLE,
      html_url: GITEA_MISLEADING_HTML_URL,
      body: 'must-not-leak-into-listed-issue',
    },
  ]
}

function gitlabListJson() {
  return [
    {
      id: GITLAB_INTERNAL_ID,
      iid: GITLAB_IID,
      title: GITLAB_ISSUE_TITLE,
      web_url: GITLAB_WORK_ITEMS_WEB_URL,
    },
  ]
}

function beginFetch(t) {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const oauth = new Map()
  const list = new Map()
  const outbound = []
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    outbound.push({
      url,
      authorization: readHeader(input, init, 'authorization') ?? null,
      privateToken: readHeader(input, init, 'private-token') ?? null,
    })
    const token = stubbedToken(input, init)
    if (isListIssuesEndpoint(url)) {
      const stub = token == null ? undefined : list.get(token)
      if (stub == null) return jsonResponse(500, { error: 'unstubbed list endpoint', url, token: token ?? null })
      if (stub.unreachable) throw new TypeError('fetch failed')
      const status = stub.status ?? 200
      if (status !== 200) return jsonResponse(status, stub.body ?? { message: 'error' })
      return jsonResponse(200, stub.body ?? giteaListJson())
    }
    const profile = token == null ? undefined : oauth.get(token)
    if (profile != null) return jsonResponse(200, profile)
    return jsonResponse(500, { error: 'unstubbed fetch', url, token: token ?? null })
  }
  return { oauth, list, outbound }
}

function allowList(stub, token, descriptor = {}) {
  stub.list.set(token, descriptor)
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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-profile-issues-'))
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

async function loginGitlab(app, stub, label = 'gitlab') {
  const accessToken = nextAccessToken(label)
  stub.oauth.set(accessToken, {
    id: 80000 + tokenSeq,
    username: `gl-${label}`,
    name: `Git Lab ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })
}

function jsonBody(res) {
  try {
    return res.json()
  } catch {
    return null
  }
}

async function postProfile(app, cookies, overrides = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/credential-profiles',
    cookies,
    headers: jsonHeaders,
    payload: {
      forge: 'gitea',
      base_url: GITEA_FORGE_BASE_URL,
      repo_full_name: GITEA_REPO_FULL_NAME,
      token: GITEA_PROFILE_TOKEN,
      ...overrides,
    },
  })
  assert.equal(res.statusCode, 201, `POST credential profile: ${res.statusCode} ${res.body}`)
  return jsonBody(res)
}

async function getProfileIssues(app, cookies, id, extra = {}) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/credential-profiles/${id}/issues`,
    cookies,
    headers: jsonHeaders,
    ...extra,
  })
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

function listGets(outbound, since = 0) {
  return outbound.slice(since).filter((call) => isListIssuesEndpoint(call.url))
}

function userGets(outbound, since = 0) {
  return outbound.slice(since).filter((call) => isUserEndpoint(call.url))
}

function assertForbidden(res) {
  assert.equal(res.statusCode, 403, `expected 403 forbidden, got ${res.statusCode} ${res.body}`)
  assert.deepEqual(jsonBody(res), { error: 'forbidden' })
  assert.equal(Object.prototype.hasOwnProperty.call(jsonBody(res) ?? {}, 'message'), false)
}

function assertListedGitea(body) {
  assert.deepEqual(body, {
    issues: [
      {
        number: GITEA_ISSUE_NUMBER,
        title: GITEA_ISSUE_TITLE,
        issue_url: GITEA_ISSUE_URL,
      },
    ],
  })
}

describe('issue #19 GET /api/v1/credential-profiles/:id/issues', { concurrency: false }, () => {
  describe('authentication and permission gate (same as credential-profile CRUD)', () => {
    test('unauthenticated JSON GET returns 401 unauthorized (same oracle as GET /api/v1/me)', async (t) => {
      const app = await createApp(t)
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: jsonHeaders,
      })
      assert.equal(me.statusCode, 401)
      assert.deepEqual(jsonBody(me), { error: 'unauthorized' })

      const res = await getProfileIssues(app, {}, 1)
      assert.equal(res.statusCode, 401, `GET issues: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'unauthorized' })
      assert.equal(res.statusCode, me.statusCode)
      assert.deepEqual(jsonBody(res), jsonBody(me))
    })

    test('browser-like GET without a session redirects to /login', async (t) => {
      const app = await createApp(t)
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/credential-profiles/1/issues',
        headers: { accept: 'text/html' },
      })
      assert.equal(res.statusCode, 302)
      assert.match(String(res.headers.location), /\/login(?:\?|$)/)
    })

    test('leftover 待批准 GitHub user gets 403 forbidden with no message', async (t) => {
      const sqlitePath = sqliteFile(t)
      const db = openDb(t, sqlitePath)
      seedLeftoverGithub(db, {
        remoteId: 22401,
        username: 'gh-issues-pending',
        displayName: 'Pending Issues',
        status: '待批准',
        permissionLevel: 'claim_only',
      })
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      const github = await loginLeftoverGithub(app, stub, {
        remoteId: 22401,
        login: 'gh-issues-pending',
        name: 'Pending Issues',
        label: 'pending',
      })
      assert.equal(github.body.status, '待批准')
      assert.equal(github.body.permission_level, 'claim_only')
      const afterLogin = stub.outbound.length

      const res = await getProfileIssues(app, github.cookies, 1)
      assertForbidden(res)
      assert.equal(listGets(stub.outbound, afterLogin).length, 0)
    })

    test('leftover active GitHub claim_only still gets 403 forbidden with no message', async (t) => {
      const sqlitePath = sqliteFile(t)
      const db = openDb(t, sqlitePath)
      seedLeftoverGithub(db, {
        remoteId: 22402,
        username: 'gh-issues-claim-only',
        displayName: 'Claim Only Issues',
        status: 'active',
        permissionLevel: 'claim_only',
      })
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowList(stub, GITEA_PROFILE_TOKEN, { body: giteaListJson() })
      const member = await loginGitea(app, stub, 'approver')
      const github = await loginLeftoverGithub(app, stub, {
        remoteId: 22402,
        login: 'gh-issues-claim-only',
        name: 'Claim Only Issues',
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

      const profile = await postProfile(app, member.cookies)
      const afterSetup = stub.outbound.length
      const res = await getProfileIssues(app, github.cookies, profile.id)
      assertForbidden(res)
      assert.equal(listGets(stub.outbound, afterSetup).length, 0, 'claim_only must not decrypt-and-list')
    })
  })

  describe('missing profile or bad :id', () => {
    test('missing row is 404 not_found', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      const member = await loginGitea(app, stub, 'missing-row')
      const afterLogin = stub.outbound.length

      const res = await getProfileIssues(app, member.cookies, 999999)
      assert.equal(res.statusCode, 404, `GET issues: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'not_found' })
      assert.equal(listGets(stub.outbound, afterLogin).length, 0)
    })

    test('non-positive / non-integer :id (abc, 0, -1) is 404 not_found', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      const member = await loginGitea(app, stub, 'bad-id')
      const afterLogin = stub.outbound.length

      for (const id of ['abc', '0', '-1']) {
        const res = await getProfileIssues(app, member.cookies, id)
        assert.equal(res.statusCode, 404, `id=${id}: ${res.statusCode} ${res.body}`)
        assert.deepEqual(jsonBody(res), { error: 'not_found' })
      }
      assert.equal(listGets(stub.outbound, afterLogin).length, 0)
    })
  })

  describe('success lists open issues from the profile row', () => {
    test('Gitea 200 maps number/title, constructs issue_url, pins list URL, omits secrets, does not write token 揭示', async (t) => {
      const sqlitePath = sqliteFile(t)
      const app = await createApp(t, sqlitePath)
      const stub = beginFetch(t)
      allowList(stub, GITEA_PROFILE_TOKEN, { body: giteaListJson() })
      const poster = await loginGitea(app, stub, 'gitea-ok')
      const profile = await postProfile(app, poster.cookies)
      const afterSetup = stub.outbound.length

      const res = await getProfileIssues(app, poster.cookies, profile.id)
      assert.equal(res.statusCode, 200, `GET issues: ${res.statusCode} ${res.body}`)
      assertListedGitea(jsonBody(res))
      assertNoTokenMaterial(res, GITEA_PROFILE_TOKEN, GITLAB_PROFILE_TOKEN)
      assert.equal(res.body.includes('html-url.example'), false, `must not copy Gitea html_url: ${res.body}`)
      assert.equal(res.body.includes('must-not-leak-into-listed-issue'), false)

      const gets = listGets(stub.outbound, afterSetup)
      assert.equal(gets.length, 1, `expected one list GET, got ${JSON.stringify(stub.outbound.slice(afterSetup))}`)
      assert.equal(gets[0].url, GITEA_LIST_API_URL)
      assert.equal(gets[0].authorization, `token ${GITEA_PROFILE_TOKEN}`)
      assert.equal(
        stub.outbound.slice(afterSetup).some((call) => call.url.includes('gitea.example.test')),
        false,
        'list fetch must use the profile base_url, not the OAuth Gitea host',
      )
      assert.equal(userGets(stub.outbound, afterSetup).length, 0, 'list must not call validateToken (/user)')

      const db = openDb(t, sqlitePath)
      const reveals = tokenRevealEvents(db)
      assert.equal(
        reveals.length,
        0,
        `GET issues must not write token 揭示 (import profile path does); got ${JSON.stringify(eventRows(db))}`,
      )
      const ciphertext = profileCiphertext(db, profile.id)
      assert.equal(typeof ciphertext, 'string')
      const dumpedEvents = JSON.stringify(eventRows(db))
      assert.equal(dumpedEvents.includes(GITEA_PROFILE_TOKEN), false, `events leaked plaintext: ${dumpedEvents}`)
      assert.equal(dumpedEvents.includes(ciphertext), false, `events leaked ciphertext: ${dumpedEvents}`)
      assert.equal(res.body.includes(ciphertext), false, `response leaked ciphertext: ${res.body}`)

      const listedEvents = await app.inject({
        method: 'GET',
        url: '/api/v1/events',
        cookies: poster.cookies,
        headers: jsonHeaders,
      })
      assert.equal(listedEvents.statusCode, 200, `GET /api/v1/events: ${listedEvents.statusCode} ${listedEvents.body}`)
      const eventTypes = (jsonBody(listedEvents)?.events ?? []).map((event) => event.type)
      assert.equal(eventTypes.includes(TOKEN_REVEAL_EVENT), false, `GET /api/v1/events included token 揭示: ${listedEvents.body}`)
      assertNoTokenMaterial(listedEvents, GITEA_PROFILE_TOKEN)
    })

    test('GitLab 200 maps iid not id and constructs /-/issues/{iid} on the profile base_url', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowList(stub, GITLAB_PROFILE_TOKEN, { body: gitlabListJson() })
      const poster = await loginGitlab(app, stub, 'gitlab-ok')
      const profile = await postProfile(app, poster.cookies, {
        forge: 'gitlab',
        base_url: GITLAB_FORGE_BASE_URL,
        repo_full_name: GITLAB_REPO_FULL_NAME,
        token: GITLAB_PROFILE_TOKEN,
      })
      const afterSetup = stub.outbound.length

      const res = await getProfileIssues(app, poster.cookies, profile.id)
      assert.equal(res.statusCode, 200, `GET issues: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), {
        issues: [
          {
            number: GITLAB_IID,
            title: GITLAB_ISSUE_TITLE,
            issue_url: GITLAB_ISSUE_URL,
          },
        ],
      })
      const body = jsonBody(res)
      assert.notEqual(body?.issues?.[0]?.number, GITLAB_INTERNAL_ID)
      assert.equal(String(body?.issues?.[0]?.issue_url).includes('/-/work_items/'), false)
      assert.equal(String(body?.issues?.[0]?.issue_url).includes(`/-/issues/${GITLAB_IID}`), true)
      assert.equal(res.body.includes('evil.example'), false, `must not copy GitLab web_url: ${res.body}`)
      assertNoTokenMaterial(res, GITLAB_PROFILE_TOKEN, GITEA_PROFILE_TOKEN)

      const gets = listGets(stub.outbound, afterSetup)
      assert.equal(gets.length, 1, `expected one list GET, got ${JSON.stringify(stub.outbound.slice(afterSetup))}`)
      assert.equal(gets[0].url, GITLAB_LIST_API_URL)
      assert.equal(gets[0].privateToken, GITLAB_PROFILE_TOKEN)
      assert.equal(
        stub.outbound.slice(afterSetup).some((call) => call.url.includes('gitlab.example.test')),
        false,
        'list fetch must use the profile base_url, not the OAuth GitLab host',
      )
    })
  })

  describe('error mapping', () => {
    test('unset or invalid VAULT_MASTER_KEY after profile exists is 500 vault_unconfigured', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowList(stub, GITEA_PROFILE_TOKEN, { body: giteaListJson() })
      const poster = await loginGitea(app, stub, 'vault')
      const profile = await postProfile(app, poster.cookies)
      const previous = process.env.VAULT_MASTER_KEY
      t.after(() => {
        process.env.VAULT_MASTER_KEY = previous
      })
      const afterSetup = stub.outbound.length

      delete process.env.VAULT_MASTER_KEY
      const unset = await getProfileIssues(app, poster.cookies, profile.id)
      assert.equal(unset.statusCode, 500, `unset vault: ${unset.statusCode} ${unset.body}`)
      assert.deepEqual(jsonBody(unset), { error: 'vault_unconfigured' })
      assertNoTokenMaterial(unset, GITEA_PROFILE_TOKEN)

      process.env.VAULT_MASTER_KEY = 'not-a-valid-master-key'
      const invalid = await getProfileIssues(app, poster.cookies, profile.id)
      assert.equal(invalid.statusCode, 500, `invalid vault: ${invalid.statusCode} ${invalid.body}`)
      assert.deepEqual(jsonBody(invalid), { error: 'vault_unconfigured' })
      assertNoTokenMaterial(invalid, GITEA_PROFILE_TOKEN)

      assert.equal(listGets(stub.outbound, afterSetup).length, 0, 'vault miss must not fetch the forge')
    })

    test('forge HTTP 401 is 422 token_check_failed with missing 读', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowList(stub, GITEA_PROFILE_TOKEN, { status: 401 })
      const poster = await loginGitea(app, stub, '401')
      const profile = await postProfile(app, poster.cookies)
      const res = await getProfileIssues(app, poster.cookies, profile.id)
      assert.equal(res.statusCode, 422, `GET issues: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), {
        error: 'token_check_failed',
        missing: ['读'],
        message: TOKEN_CHECK_FAILED_MESSAGE,
      })
      assertNoTokenMaterial(res, GITEA_PROFILE_TOKEN)
    })

    test('forge HTTP 500 is 502 forge_unreachable with 列出 Issue copy', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowList(stub, GITEA_PROFILE_TOKEN, { status: 500 })
      const poster = await loginGitea(app, stub, '500')
      const profile = await postProfile(app, poster.cookies)
      const res = await getProfileIssues(app, poster.cookies, profile.id)
      assert.equal(res.statusCode, 502, `GET issues: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'forge_unreachable', message: FORGE_UNREACHABLE_MESSAGE })
      assert.notEqual(jsonBody(res)?.message, IMPORT_FORGE_UNREACHABLE_MESSAGE)
      assertNoTokenMaterial(res, GITEA_PROFILE_TOKEN)
    })

    test('fetch/network throw is 502 forge_unreachable with 列出 Issue copy', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      allowList(stub, GITEA_PROFILE_TOKEN, { unreachable: true })
      const poster = await loginGitea(app, stub, 'net')
      const profile = await postProfile(app, poster.cookies)
      const res = await getProfileIssues(app, poster.cookies, profile.id)
      assert.equal(res.statusCode, 502, `GET issues: ${res.statusCode} ${res.body}`)
      assert.deepEqual(jsonBody(res), { error: 'forge_unreachable', message: FORGE_UNREACHABLE_MESSAGE })
      assertNoTokenMaterial(res, GITEA_PROFILE_TOKEN)
    })

    test('forge HTTP 404 (and 410) is 502 列出, not issue_not_found', async (t) => {
      const app = await createApp(t)
      const stub = beginFetch(t)
      const poster = await loginGitea(app, stub, '404')
      const profile = await postProfile(app, poster.cookies)

      for (const status of [404, 410]) {
        allowList(stub, GITEA_PROFILE_TOKEN, { status })
        const res = await getProfileIssues(app, poster.cookies, profile.id)
        assert.equal(res.statusCode, 502, `forge ${status}: ${res.statusCode} ${res.body}`)
        assert.deepEqual(jsonBody(res), { error: 'forge_unreachable', message: FORGE_UNREACHABLE_MESSAGE })
        assert.notEqual(jsonBody(res)?.error, 'issue_not_found')
        assert.notEqual(jsonBody(res)?.message, ISSUE_NOT_FOUND_MESSAGE)
        assertNoTokenMaterial(res, GITEA_PROFILE_TOKEN)
      }
    })
  })
})
