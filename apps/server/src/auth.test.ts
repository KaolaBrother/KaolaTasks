import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDERS,
  applyOauthTestEnv,
  assertNotAUserBody,
  completeOauthCallback,
  cookieJar,
  ensureSetup,
  loginGiteaPublisher,
  loginGitlabPublisher,
  loginViaCallback,
  nextAccessToken,
  openDb,
  seedUser,
  sqliteFile,
  stubUserinfoByAccessToken,
  withAdmins,
} from './auth.test-helpers.ts'

const PENDING_STATUS = '待批准'
const PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'

applyOauthTestEnv()

const { buildApp } = await import('./app.ts')

async function createApp(t, sqlitePath) {
  const app = buildApp(sqlitePath ? { sqlitePath } : undefined)
  t.after(async () => {
    await app.close()
  })
  await app.ready()
  return app
}

describe('login start paths', () => {
  test('GET /login is allowed without a session', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(res.statusCode, 200, `GET /login: ${res.statusCode} ${res.body}`)
  })

  test('GET /login/github is 404', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: '/login/github' })
    assert.equal(res.statusCode, 404, `GET /login/github: ${res.statusCode}`)
  })

  test('GET /login/gitlab redirects to the configured GitLab authorize URL after setup', async (t) => {
    const app = await createApp(t)
    await ensureSetup(app)
    const res = await app.inject({ method: 'GET', url: PROVIDERS.gitlab.startPath })
    assert.equal(res.statusCode, 302, `GET ${PROVIDERS.gitlab.startPath}: ${res.statusCode}`)
    assert.match(String(res.headers.location), /https:\/\/gitlab\.example\.test\/oauth\/authorize/)
    assert.match(String(res.headers.location), /(?:^|[?&])scope=read_user(?:&|$)/)
  })

  test('GET /login/gitea redirects to the configured Gitea authorize URL after setup', async (t) => {
    const app = await createApp(t)
    await ensureSetup(app)
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

describe('OAuth publishers after setup', () => {
  test('session Set-Cookie does not include Secure when PUBLIC_URL is http://localhost', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const { callback } = await loginGitlabPublisher(app, profiles, 'http-cookie')
    const session = callback.cookies.find((cookie) => cookie.name === 'sessionId')
    assert.ok(session, 'http localhost login must still set sessionId')
    assert.notEqual(session.secure, true)
    const raw = callback.headers['set-cookie']
    const headers = raw == null ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)]
    const sessionHeader = headers.find((header) => header.startsWith('sessionId='))
    assert.ok(sessionHeader, 'http localhost login must emit sessionId Set-Cookie')
    assert.doesNotMatch(sessionHeader, /(?:^|;)\s*Secure(?:;|$)/i)
  })

  test('GitLab after setup persists active full publisher', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const { body } = await loginGitlabPublisher(app, profiles, 'gl-user')
    assert.equal(body.provider, 'gitlab')
    assert.equal(body.status, 'active')
    assert.equal(body.permission_level, 'full')
    assert.notEqual(body.message, PENDING_CLAIM_MESSAGE)
  })

  test('Gitea after setup persists active full publisher; display_name falls back to login', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const named = await loginGiteaPublisher(app, profiles, 'gt-user')
    assert.equal(named.body.provider, 'gitea')
    assert.equal(named.body.permission_level, 'full')

    const accessToken = nextAccessToken('gitea-noname')
    profiles.set(accessToken, { id: 6, login: 'gt-fallback', full_name: '' })
    const { body } = await loginViaCallback(app, { ...PROVIDERS.gitea, accessToken })
    assert.equal(body.display_name, 'gt-fallback')
    assert.equal(body.permission_level, 'full')
  })

  test('second GitLab callback with the same remote_id reuses the same user id', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    await ensureSetup(app)
    const profile = { id: 111, username: 'same-cat', name: 'Same Cat' }
    const firstToken = nextAccessToken('gitlab-dup-1')
    const secondToken = nextAccessToken('gitlab-dup-2')
    profiles.set(firstToken, profile)
    profiles.set(secondToken, profile)
    const first = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: firstToken })
    const second = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: secondToken })
    assert.equal(String(second.body.id), String(first.body.id))
    assert.equal(second.body.provider, 'gitlab')
    assert.equal(second.body.remote_id, '111')
  })
})

describe('leftover 待批准 via GitLab reuse; approve retired', () => {
  test('seeded leftover 待批准 GitLab user cannot call retired approve (404)', async (t) => {
    const sqlitePath = sqliteFile(t)
    const db = openDb(t, sqlitePath)
    const seeded = seedUser(db, {
      provider: 'gitlab',
      remoteId: 222,
      username: 'pending-cat',
      displayName: 'Pending Cat',
      status: PENDING_STATUS,
      permissionLevel: 'claim_only',
    })
    const app = await createApp(t, sqlitePath)
    await ensureSetup(app)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('gitlab-cannot-approve')
    profiles.set(accessToken, { id: 222, username: 'pending-cat', name: 'Pending Cat' })

    const pending = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })
    assert.equal(String(pending.body.id), String(seeded.id))
    assert.equal(pending.body.status, PENDING_STATUS)
    assert.equal(pending.body.permission_level, 'claim_only')

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${pending.body.id}/approve`,
      cookies: pending.cookies,
      headers: { accept: 'application/json' },
    })
    assert.equal(approve.statusCode, 404)
    assert.equal(pending.body.message, PENDING_CLAIM_MESSAGE)
  })
})

describe('KAOLA_ADMINS', () => {
  test('empty KAOLA_ADMINS still buildApp() and GitHub login stays 404', async (t) => {
    withAdmins(t, '')
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(res.statusCode, 200, `empty KAOLA_ADMINS must still boot: ${res.statusCode} ${res.body}`)
    const github = await app.inject({ method: 'GET', url: '/login/github' })
    assert.equal(github.statusCode, 404)
  })

  test('KAOLA_ADMINS github:octo-admin is ignored and does not insert github login', async (t) => {
    withAdmins(t, 'github:octo-admin')
    const sqlitePath = sqliteFile(t)
    const app = await createApp(t, sqlitePath)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const invited = await loginGitlabPublisher(app, profiles, 'after-env')
    assert.equal(invited.body.permission_level, 'full')
    const github = await app.inject({ method: 'GET', url: '/login/github' })
    assert.equal(github.statusCode, 404)
    const db = openDb(t, sqlitePath)
    const githubRows = db.$client.prepare("SELECT COUNT(*) AS n FROM users WHERE provider = 'github'").get()
    assert.equal(Number(githubRows.n), 0)
  })
})

describe('revoked re-login', () => {
  test('revoked GitLab user re-login does not become active and does not set a session', async (t) => {
    const sqlitePath = sqliteFile(t)
    const db = openDb(t, sqlitePath)
    seedUser(db, {
      provider: 'gitlab',
      remoteId: 77,
      username: 'revoked-cat',
      displayName: 'Revoked Cat',
      status: 'revoked',
      permissionLevel: 'full',
    })
    const app = await createApp(t, sqlitePath)
    await ensureSetup(app)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('gitlab-revoked')
    profiles.set(accessToken, { id: 77, username: 'revoked-cat', name: 'Revoked Cat' })

    const callback = await completeOauthCallback(app, { ...PROVIDERS.gitlab, accessToken })
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
