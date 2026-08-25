import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.ts'

export const GITLAB_BASE_URL = 'https://gitlab.example.test'
export const GITEA_BASE_URL = 'https://gitea.example.test'

export const DEFAULT_SETUP = {
  username: 'kaola-admin',
  password: 'correct-horse-battery',
}

export const JSON_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
}

export const IDENTITY_SECRET_KEYS = ['password', 'password_hash', 'hash', 'token', 'access_token', 'ciphertext']

export const PROVIDERS = {
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

const setupSessions = new WeakMap()

let tokenSeq = 0

export function applyOauthTestEnv(overrides = {}) {
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
  Object.assign(process.env, overrides)
}

export function nextAccessToken(label) {
  tokenSeq += 1
  return `test-access-token-${label}-${tokenSeq}`
}

export function cookieJar(response) {
  const jar = {}
  for (const cookie of response.cookies) {
    jar[cookie.name] = cookie.value
  }
  return jar
}

export function sqliteFile(t, prefix = 'kaola-auth-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const sqlitePath = join(dir, 'kaola.sqlite')
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return sqlitePath
}

export function openDb(t, sqlitePath) {
  const db = createDb(sqlitePath)
  t.after(() => {
    db.$client.close()
  })
  return db
}

export function countUsers(db) {
  return Number(db.$client.prepare('SELECT COUNT(*) AS n FROM users').get().n)
}

export function seedUser(db, { provider, remoteId, username, displayName, status, permissionLevel }) {
  db.$client
    .prepare(
      `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(provider, String(remoteId), username, displayName, status, permissionLevel)
  return db.$client.prepare('SELECT * FROM users WHERE provider = ? AND remote_id = ?').get(provider, String(remoteId))
}

export function withAdmins(t, spec) {
  const previous = process.env.KAOLA_ADMINS
  if (spec == null || spec === '') delete process.env.KAOLA_ADMINS
  else process.env.KAOLA_ADMINS = spec
  t.after(() => {
    if (previous == null) delete process.env.KAOLA_ADMINS
    else process.env.KAOLA_ADMINS = previous
  })
}

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input && typeof input === 'object' && 'url' in input) return String(input.url)
  return String(input)
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

export function authorizationHeader(input, init) {
  const fromInit = readAuthorization(init?.headers)
  if (fromInit) return fromInit
  if (input && typeof input === 'object' && 'headers' in input) {
    return readAuthorization(input.headers)
  }
  return undefined
}

export function stubUserinfoByAccessToken(t, profiles) {
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

export function stubTokenExchange(app, decoratorName, accessToken) {
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

export async function completeOauthCallback(app, { decoratorName, callbackPath, accessToken }) {
  stubTokenExchange(app, decoratorName, accessToken)
  return app.inject({
    method: 'GET',
    url: `${callbackPath}?code=test-authorization-code`,
  })
}

export async function loginViaCallback(app, { decoratorName, callbackPath, accessToken }) {
  const callback = await completeOauthCallback(app, { decoratorName, callbackPath, accessToken })
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

export function collectKeys(value, acc = new Set()) {
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

export function assertNoIdentitySecrets(resOrBody, ...plaintexts) {
  const dumped = typeof resOrBody === 'string' ? resOrBody : resOrBody?.body != null ? String(resOrBody.body) : JSON.stringify(resOrBody)
  for (const plaintext of plaintexts) {
    if (plaintext) {
      assert.equal(dumped.includes(plaintext), false, `response leaked plaintext: ${dumped}`)
    }
  }
  let parsed = resOrBody
  if (resOrBody != null && typeof resOrBody === 'object' && typeof resOrBody.json === 'function') {
    try {
      parsed = resOrBody.json()
    } catch {
      parsed = null
    }
  } else if (typeof resOrBody === 'string') {
    try {
      parsed = JSON.parse(resOrBody)
    } catch {
      parsed = null
    }
  }
  for (const key of collectKeys(parsed)) {
    assert.equal(
      IDENTITY_SECRET_KEYS.includes(key),
      false,
      `response carried a secret-bearing key "${key}": ${dumped}`,
    )
  }
}

export async function getSetup(app) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/setup',
    headers: { accept: 'application/json' },
  })
}

export async function postSetup(app, body = DEFAULT_SETUP) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    headers: JSON_HEADERS,
    payload: body,
  })
}

export async function postLogin(app, body) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/login',
    headers: JSON_HEADERS,
    payload: body,
  })
}

export async function getMe(app, cookies) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/me',
    cookies,
    headers: { accept: 'application/json' },
  })
}

async function sessionFromAuthResponse(app, response) {
  const cookies = cookieJar(response)
  const me = await getMe(app, cookies)
  assert.equal(me.statusCode, 200, `GET /api/v1/me after auth: ${me.statusCode} ${me.body}`)
  return { response, cookies, me, body: me.json() }
}

export function getSetupAdmin(app) {
  return setupSessions.get(app)
}

export async function ensureSetup(app, creds = DEFAULT_SETUP) {
  const cached = setupSessions.get(app)
  if (cached) return cached
  const probe = await getSetup(app)
  if (probe.statusCode === 200 && probe.json()?.setup_complete === true) {
    const login = await postLogin(app, { username: creds.username, password: creds.password })
    if (login.statusCode === 200) {
      const session = await sessionFromAuthResponse(app, login)
      setupSessions.set(app, session)
      return session
    }
  }
  const setup = await postSetup(app, creds)
  assert.equal(setup.statusCode, 201, `POST /api/v1/setup: ${setup.statusCode} ${setup.body}`)
  const session = await sessionFromAuthResponse(app, setup)
  setupSessions.set(app, session)
  return session
}

export async function loginGitlabPublisher(app, stubOauthMap, label = 'gitlab') {
  await ensureSetup(app)
  const accessToken = nextAccessToken(label)
  stubOauthMap.set(accessToken, {
    id: 80000 + tokenSeq,
    username: `gl-${label}`,
    name: `Git Lab ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })
}

export async function loginGiteaPublisher(app, stubOauthMap, label = 'gitea') {
  await ensureSetup(app)
  const accessToken = nextAccessToken(label)
  stubOauthMap.set(accessToken, {
    id: 70000 + tokenSeq,
    login: `gt-${label}`,
    full_name: `Gi Tea ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitea, accessToken })
}

export function assertPersistedUser(body, expected) {
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

export function assertNotAUserBody(body) {
  if (body == null || typeof body !== 'object') return
  assert.equal(body.provider, undefined)
  assert.equal(body.remote_id, undefined)
  assert.equal(body.username, undefined)
  assert.equal(body.permission_level, undefined)
}

export const LEGACY_USERS_DDL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  permission_level TEXT NOT NULL,
  trusted_automation INTEGER NOT NULL DEFAULT 0,
  UNIQUE (provider, remote_id)
)
`

export function insertLegacyUser(sqlite, { provider, remoteId, username, displayName, status, permissionLevel }) {
  sqlite
    .prepare(
      `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(provider, String(remoteId), username, displayName, status, permissionLevel)
}
