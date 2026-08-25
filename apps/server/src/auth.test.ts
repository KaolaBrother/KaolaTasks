import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.ts'

// Binding names: kaola-workflow/bundle-3-6/.cache/technical-decisions.md
const PENDING_STATUS = '待批准'
const PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'

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

function authorizationHeader(input, init) {
  const fromInit = readAuthorization(init?.headers)
  if (fromInit) return fromInit
  if (input && typeof input === 'object' && 'headers' in input) {
    return readAuthorization(input.headers)
  }
  return undefined
}

function readAuthorization(headers) {
  if (headers == null) return undefined
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get('authorization') ?? headers.get('Authorization') ?? undefined
  }
  if (Array.isArray(headers)) {
    const hit = headers.find(([name]) => String(name).toLowerCase() === 'authorization')
    return hit?.[1]
  }
  return headers.authorization ?? headers.Authorization
}

function stubUserinfoByAccessToken(t, profiles) {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async (input, init) => {
    const header = authorizationHeader(input, init)
    const match = typeof header === 'string' ? header.match(/^(?:Bearer|token)\s+(\S+)/i) : null
    const accessToken = match?.[1]
    const profile = accessToken ? profiles.get(accessToken) : undefined
    if (profile == null) {
      return new Response(
        JSON.stringify({ error: 'unstubbed userinfo', url: requestUrl(input) }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify(profile), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-auth-'))
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

function countUsers(db) {
  return Number(db.$client.prepare('SELECT COUNT(*) AS n FROM users').get().n)
}

function seedUser(db, { provider, remoteId, username, displayName, status, permissionLevel }) {
  db.$client
    .prepare(
      `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(provider, String(remoteId), username, displayName, status, permissionLevel)
  return db.$client.prepare('SELECT * FROM users WHERE provider = ? AND remote_id = ?').get(provider, String(remoteId))
}

async function completeOauthCallback(app, { decoratorName, callbackPath, accessToken }) {
  stubTokenExchange(app, decoratorName, accessToken)
  return app.inject({
    method: 'GET',
    url: `${callbackPath}?code=test-authorization-code`,
  })
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
    headers: { accept: 'application/json' },
  })
  assert.equal(me.statusCode, 200, `GET /api/v1/me after callback: ${me.statusCode} ${me.body}`)
  return { callback, cookies, me, body: me.json() }
}

function assertPersistedUser(body, expected) {
  assert.equal(typeof body, 'object')
  assert.ok(body)
  assert.ok(Number.isInteger(Number(body.id)) && Number(body.id) > 0, `id must be a positive integer, got ${body.id}`)
  assert.equal(body.provider, expected.provider)
  assert.equal(body.remote_id, expected.remote_id)
  assert.equal(typeof body.remote_id, 'string')
  assert.equal(body.username, expected.username)
  assert.equal(body.display_name, expected.display_name)
  assert.equal(body.status, expected.status)
  assert.equal(body.permission_level, expected.permission_level)
}

function assertNotAUserBody(body) {
  if (body == null || typeof body !== 'object') return
  assert.equal(body.provider, undefined)
  assert.equal(body.remote_id, undefined)
  assert.equal(body.username, undefined)
  assert.equal(body.permission_level, undefined)
}

describe('login start paths', () => {
  test('GET /login is allowed without a session', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(res.statusCode, 200, `GET /login: ${res.statusCode} ${res.body}`)
  })

  test('GET /login/github redirects to GitHub authorize', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: PROVIDERS.github.startPath })
    assert.equal(res.statusCode, 302, `GET ${PROVIDERS.github.startPath}: ${res.statusCode}`)
    assert.match(String(res.headers.location), /https:\/\/github\.com\/login\/oauth\/authorize/)
    assert.match(String(res.headers.location), /(?:^|[?&])scope=read%3Auser(?:&|$)/)
  })

  test('GET /login/gitlab redirects to the configured GitLab authorize URL', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: PROVIDERS.gitlab.startPath })
    assert.equal(res.statusCode, 302, `GET ${PROVIDERS.gitlab.startPath}: ${res.statusCode}`)
    assert.match(String(res.headers.location), /https:\/\/gitlab\.example\.test\/oauth\/authorize/)
    assert.match(String(res.headers.location), /(?:^|[?&])scope=read_user(?:&|$)/)
  })

  test('GET /login/gitea redirects to the configured Gitea authorize URL', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: PROVIDERS.gitea.startPath })
    assert.equal(res.statusCode, 302, `GET ${PROVIDERS.gitea.startPath}: ${res.statusCode}`)
    assert.match(String(res.headers.location), /https:\/\/gitea\.example\.test\/login\/oauth\/authorize/)
    assert.match(String(res.headers.location), /(?:^|[?&])scope=read%3Auser(?:&|$)/)
  })
})

describe('unauthenticated GET /api/v1/me', () => {
  test('browser-like GET /api/v1/me redirects to /login and does not return a user', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { accept: 'text/html' },
    })
    assert.equal(res.statusCode, 302)
    assert.match(String(res.headers.location), /\/login(?:\?|$)/)
    let body
    try {
      body = JSON.parse(res.body)
    } catch {
      body = null
    }
    assertNotAUserBody(body)
  })

  test('JSON GET /api/v1/me without a session returns 401 and does not return a user', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { accept: 'application/json' },
    })
    assert.equal(res.statusCode, 401)
    let body
    try {
      body = res.json()
    } catch {
      body = null
    }
    assertNotAUserBody(body)
  })
})

describe('OAuth callback first login', () => {
  test('GitHub first login persists active full user and a usable session', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('github')
    profiles.set(accessToken, { id: 4242, login: 'octo-cat', name: 'Octo Cat' })

    const { body } = await loginViaCallback(app, {
      ...PROVIDERS.github,
      accessToken,
    })

    assertPersistedUser(body, {
      provider: 'github',
      remote_id: '4242',
      username: 'octo-cat',
      display_name: 'Octo Cat',
      status: 'active',
      permission_level: 'full',
    })
    assert.notEqual(body.message, PENDING_CLAIM_MESSAGE)
  })

  test('session Set-Cookie does not include Secure when PUBLIC_URL is http://localhost', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('github-http-cookie')
    profiles.set(accessToken, { id: 4243, login: 'http-cat', name: 'Http Cat' })

    const { callback } = await loginViaCallback(app, {
      ...PROVIDERS.github,
      accessToken,
    })
    const session = callback.cookies.find((cookie) => cookie.name === 'sessionId')
    assert.ok(session, 'http localhost login must still set sessionId')
    assert.notEqual(session.secure, true)
    const raw = callback.headers['set-cookie']
    const headers = raw == null ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)]
    const sessionHeader = headers.find((header) => header.startsWith('sessionId='))
    assert.ok(sessionHeader, 'http localhost login must emit sessionId Set-Cookie')
    assert.doesNotMatch(sessionHeader, /(?:^|;)\s*Secure(?:;|$)/i)
  })

  test('GitHub display_name falls back to login when name is null', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('github-noname')
    profiles.set(accessToken, { id: 7, login: 'no-name', name: null })

    const { body } = await loginViaCallback(app, {
      ...PROVIDERS.github,
      accessToken,
    })

    assertPersistedUser(body, {
      provider: 'github',
      remote_id: '7',
      username: 'no-name',
      display_name: 'no-name',
      status: 'active',
      permission_level: 'full',
    })
  })

  test('GitLab first login persists active full user and a usable session', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('gitlab')
    profiles.set(accessToken, { id: 99, username: 'gl-user', name: 'Git Lab' })

    const { body } = await loginViaCallback(app, {
      ...PROVIDERS.gitlab,
      accessToken,
    })

    assertPersistedUser(body, {
      provider: 'gitlab',
      remote_id: '99',
      username: 'gl-user',
      display_name: 'Git Lab',
      status: 'active',
      permission_level: 'full',
    })
    assert.notEqual(body.message, PENDING_CLAIM_MESSAGE)
  })

  test('Gitea first login persists active full user and a usable session', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('gitea')
    profiles.set(accessToken, { id: 5, login: 'gt-user', full_name: 'Gi Tea' })

    const { body } = await loginViaCallback(app, {
      ...PROVIDERS.gitea,
      accessToken,
    })

    assertPersistedUser(body, {
      provider: 'gitea',
      remote_id: '5',
      username: 'gt-user',
      display_name: 'Gi Tea',
      status: 'active',
      permission_level: 'full',
    })
    assert.notEqual(body.message, PENDING_CLAIM_MESSAGE)
  })

  test('Gitea display_name falls back to login when full_name is empty', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('gitea-noname')
    profiles.set(accessToken, { id: 6, login: 'gt-fallback', full_name: '' })

    const { body } = await loginViaCallback(app, {
      ...PROVIDERS.gitea,
      accessToken,
    })

    assert.equal(body.display_name, 'gt-fallback')
    assert.equal(body.status, 'active')
    assert.equal(body.permission_level, 'full')
  })

  test('second GitHub callback with the same remote_id reuses the same user id', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const profile = { id: 111, login: 'same-cat', name: 'Same Cat' }
    const firstToken = nextAccessToken('github-dup-1')
    const secondToken = nextAccessToken('github-dup-2')
    profiles.set(firstToken, profile)
    profiles.set(secondToken, profile)

    const first = await loginViaCallback(app, { ...PROVIDERS.github, accessToken: firstToken })
    const second = await loginViaCallback(app, { ...PROVIDERS.github, accessToken: secondToken })

    assert.equal(String(second.body.id), String(first.body.id))
    assert.equal(second.body.provider, 'github')
    assert.equal(second.body.remote_id, '111')
  })

  test('after a full user exists, GitLab OAuth with the same remote_id is uninvited and does not insert a second user', async (t) => {
    const sqlitePath = sqliteFile(t)
    const app = await createApp(t, sqlitePath)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const githubToken = nextAccessToken('github-shared-id')
    const gitlabToken = nextAccessToken('gitlab-shared-id')
    profiles.set(githubToken, { id: 1, login: 'gh-one', name: 'GH One' })
    profiles.set(gitlabToken, { id: 1, username: 'gl-one', name: 'GL One' })

    const github = await loginViaCallback(app, { ...PROVIDERS.github, accessToken: githubToken })
    assert.equal(github.body.status, 'active')
    assert.equal(github.body.permission_level, 'full')

    const callback = await completeOauthCallback(app, { ...PROVIDERS.gitlab, accessToken: gitlabToken })
    assert.match(String(callback.headers.location ?? callback.body), /uninvited|未被邀请/)
    const cookies = cookieJar(callback)
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies,
      headers: { accept: 'application/json' },
    })
    assert.equal(me.statusCode, 401, `uninvited GitLab must not set a session: ${me.statusCode} ${me.body}`)

    const db = openDb(t, sqlitePath)
    assert.equal(countUsers(db), 1)
    const row = db.$client.prepare('SELECT provider FROM users').get()
    assert.equal(row.provider, 'github')
  })
})

describe('leftover 待批准 GitHub users and approve', () => {
  test('seeded leftover 待批准 GitHub user cannot POST /api/v1/users/:id/approve', async (t) => {
    const sqlitePath = sqliteFile(t)
    const db = openDb(t, sqlitePath)
    const seeded = seedUser(db, {
      provider: 'github',
      remoteId: 222,
      username: 'pending-cat',
      displayName: 'Pending Cat',
      status: PENDING_STATUS,
      permissionLevel: 'claim_only',
    })
    const app = await createApp(t, sqlitePath)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('github-cannot-approve')
    profiles.set(accessToken, { id: 222, login: 'pending-cat', name: 'Pending Cat' })

    const pending = await loginViaCallback(app, { ...PROVIDERS.github, accessToken })
    assert.equal(String(pending.body.id), String(seeded.id))
    assert.equal(pending.body.status, PENDING_STATUS)
    assert.equal(pending.body.permission_level, 'claim_only')

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${pending.body.id}/approve`,
      cookies: pending.cookies,
      headers: { accept: 'application/json' },
    })
    assert.ok(
      approve.statusCode === 401 || approve.statusCode === 403,
      `leftover 待批准 GitHub user cannot approve (expected 401 or 403, got ${approve.statusCode}: ${approve.body})`,
    )
    assert.equal(pending.body.message, PENDING_CLAIM_MESSAGE)
  })

  test('an active full member can approve a leftover 待批准 GitHub user to active while leaving claim_only', async (t) => {
    const sqlitePath = sqliteFile(t)
    const db = openDb(t, sqlitePath)
    seedUser(db, {
      provider: 'github',
      remoteId: 333,
      username: 'needs-ok',
      displayName: 'Needs Ok',
      status: PENDING_STATUS,
      permissionLevel: 'claim_only',
    })
    const app = await createApp(t, sqlitePath)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)

    const githubToken = nextAccessToken('github-to-approve')
    const gitlabToken = nextAccessToken('gitlab-approver')
    profiles.set(githubToken, { id: 333, login: 'needs-ok', name: 'Needs Ok' })
    profiles.set(gitlabToken, { id: 444, username: 'team-lead', name: 'Team Lead' })

    const github = await loginViaCallback(app, { ...PROVIDERS.github, accessToken: githubToken })
    const member = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: gitlabToken })

    assert.equal(github.body.status, PENDING_STATUS)
    assert.equal(member.body.status, 'active')
    assert.equal(member.body.permission_level, 'full')

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${github.body.id}/approve`,
      cookies: member.cookies,
      headers: { accept: 'application/json' },
    })
    assert.ok(
      approve.statusCode >= 200 && approve.statusCode < 300,
      `member approve should succeed, got ${approve.statusCode}: ${approve.body}`,
    )

    const githubAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: github.cookies,
      headers: { accept: 'application/json' },
    })
    assert.equal(githubAfter.statusCode, 200)
    const body = githubAfter.json()
    assert.equal(body.status, 'active')
    assert.equal(body.permission_level, 'claim_only')
    assert.notEqual(body.message, PENDING_CLAIM_MESSAGE)
  })
})

describe('closed join after a full user exists', () => {
  test('uninvited GitHub OAuth after a GitLab full exists does not insert a user and does not set a session', async (t) => {
    const sqlitePath = sqliteFile(t)
    const app = await createApp(t, sqlitePath)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const gitlabToken = nextAccessToken('gitlab-bootstrap')
    const githubToken = nextAccessToken('github-uninvited')
    profiles.set(gitlabToken, { id: 10, username: 'gl-admin', name: 'GL Admin' })
    profiles.set(githubToken, { id: 11, login: 'gh-stranger', name: 'GH Stranger' })

    const member = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: gitlabToken })
    assert.equal(member.body.permission_level, 'full')
    const db = openDb(t, sqlitePath)
    assert.equal(countUsers(db), 1)

    const callback = await completeOauthCallback(app, { ...PROVIDERS.github, accessToken: githubToken })
    assert.match(String(callback.headers.location ?? callback.body), /uninvited|未被邀请/)
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: cookieJar(callback),
      headers: { accept: 'application/json' },
    })
    assert.equal(me.statusCode, 401, `uninvited GitHub must not set a session: ${me.statusCode} ${me.body}`)
    assert.equal(countUsers(db), 1)
  })

  test('GitLab first login is not auto-full when a full user already exists', async (t) => {
    const sqlitePath = sqliteFile(t)
    const app = await createApp(t, sqlitePath)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const giteaToken = nextAccessToken('gitea-bootstrap')
    const gitlabToken = nextAccessToken('gitlab-late')
    profiles.set(giteaToken, { id: 20, login: 'gt-admin', full_name: 'GT Admin' })
    profiles.set(gitlabToken, { id: 21, username: 'gl-late', name: 'GL Late' })

    const first = await loginViaCallback(app, { ...PROVIDERS.gitea, accessToken: giteaToken })
    assert.equal(first.body.permission_level, 'full')

    const callback = await completeOauthCallback(app, { ...PROVIDERS.gitlab, accessToken: gitlabToken })
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: cookieJar(callback),
      headers: { accept: 'application/json' },
    })
    assert.equal(me.statusCode, 401, `late GitLab must not become auto-full: ${me.statusCode} ${me.body}`)
    const db = openDb(t, sqlitePath)
    assert.equal(countUsers(db), 1)
    assert.equal(db.$client.prepare('SELECT provider FROM users').get().provider, 'gitea')
  })

  test('Gitea first login is not auto-full when a full user already exists', async (t) => {
    const sqlitePath = sqliteFile(t)
    const app = await createApp(t, sqlitePath)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const gitlabToken = nextAccessToken('gitlab-first-full')
    const giteaToken = nextAccessToken('gitea-late')
    profiles.set(gitlabToken, { id: 30, username: 'gl-first', name: 'GL First' })
    profiles.set(giteaToken, { id: 31, login: 'gt-late', full_name: 'GT Late' })

    await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: gitlabToken })
    const callback = await completeOauthCallback(app, { ...PROVIDERS.gitea, accessToken: giteaToken })
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: cookieJar(callback),
      headers: { accept: 'application/json' },
    })
    assert.equal(me.statusCode, 401, `late Gitea must not become auto-full: ${me.statusCode} ${me.body}`)
    const db = openDb(t, sqlitePath)
    assert.equal(countUsers(db), 1)
  })
})

describe('KAOLA_ADMINS', () => {
  test('empty KAOLA_ADMINS still buildApp()', async (t) => {
    t.after(() => {
      delete process.env.KAOLA_ADMINS
    })
    delete process.env.KAOLA_ADMINS
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(res.statusCode, 200, `empty KAOLA_ADMINS must still boot: ${res.statusCode} ${res.body}`)
  })

  test('KAOLA_ADMINS match still inserts full after bootstrap', async (t) => {
    t.after(() => {
      delete process.env.KAOLA_ADMINS
    })
    process.env.KAOLA_ADMINS = 'github:octo-admin'
    const sqlitePath = sqliteFile(t)
    const app = await createApp(t, sqlitePath)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const gitlabToken = nextAccessToken('gitlab-first-admin')
    const githubToken = nextAccessToken('github-whitelisted')
    profiles.set(gitlabToken, { id: 40, username: 'gl-first', name: 'GL First' })
    profiles.set(githubToken, { id: 41, login: 'octo-admin', name: 'Octo Admin' })

    const first = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: gitlabToken })
    assert.equal(first.body.permission_level, 'full')

    const invited = await loginViaCallback(app, { ...PROVIDERS.github, accessToken: githubToken })
    assertPersistedUser(invited.body, {
      provider: 'github',
      remote_id: '41',
      username: 'octo-admin',
      display_name: 'Octo Admin',
      status: 'active',
      permission_level: 'full',
    })
    const db = openDb(t, sqlitePath)
    assert.equal(countUsers(db), 2)
  })
})

describe('revoked re-login', () => {
  test('revoked user re-login does not become active and does not set a session', async (t) => {
    const sqlitePath = sqliteFile(t)
    const db = openDb(t, sqlitePath)
    seedUser(db, {
      provider: 'github',
      remoteId: 77,
      username: 'revoked-cat',
      displayName: 'Revoked Cat',
      status: 'revoked',
      permissionLevel: 'full',
    })
    const app = await createApp(t, sqlitePath)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('github-revoked')
    profiles.set(accessToken, { id: 77, login: 'revoked-cat', name: 'Revoked Cat' })

    const callback = await completeOauthCallback(app, { ...PROVIDERS.github, accessToken })
    assert.match(String(callback.headers.location ?? callback.body), /revoked|已撤销|已吊销/)
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: cookieJar(callback),
      headers: { accept: 'application/json' },
    })
    assert.equal(me.statusCode, 401, `revoked re-login must not set a session: ${me.statusCode} ${me.body}`)
    const row = db.$client.prepare('SELECT status, permission_level FROM users WHERE remote_id = ?').get('77')
    assert.equal(row.status, 'revoked')
    assert.equal(row.permission_level, 'full')
  })
})
