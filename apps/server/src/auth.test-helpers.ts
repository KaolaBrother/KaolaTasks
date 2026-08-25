import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
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
    decoratorName: 'gitlabOAuth2' as const,
    startPath: '/login/gitlab',
    callbackPath: '/login/gitlab/callback',
  },
  gitea: {
    decoratorName: 'giteaOAuth2' as const,
    startPath: '/login/gitea',
    callbackPath: '/login/gitea/callback',
  },
}

export type OauthDecoratorName = (typeof PROVIDERS)[keyof typeof PROVIDERS]['decoratorName']

export type CookieJar = Record<string, string>

export type InjectCookieResponse = {
  cookies: Array<{ name: string; value: string }>
  statusCode: number
  body: string
  json: () => unknown
}

export type MeBody = {
  id: number
  provider: string
  remote_id: string
  username: string
  display_name: string
  status: string
  permission_level: string
  trusted_automation?: boolean
  [key: string]: unknown
}

export type AuthSession = {
  response: InjectCookieResponse
  cookies: CookieJar
  me: InjectCookieResponse
  body: MeBody
}

type AppDb = ReturnType<typeof createDb>

type Oauth2Plugin = {
  getAccessTokenFromAuthorizationCodeFlow: (request?: unknown) => Promise<{
    token: { access_token: string; token_type: string; expires_in: number }
  }>
}

type SeedUserSpec = {
  provider: string
  remoteId: string | number
  username: string
  displayName: string
  status: string
  permissionLevel: string
}

const setupSessions = new WeakMap<FastifyInstance, AuthSession>()

let tokenSeq = 0

export function applyOauthTestEnv(overrides: Record<string, string | undefined> = {}) {
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

export function nextAccessToken(label: string) {
  tokenSeq += 1
  return `test-access-token-${label}-${tokenSeq}`
}

export function cookieJar(response: InjectCookieResponse): CookieJar {
  const jar: CookieJar = {}
  for (const cookie of response.cookies) {
    jar[cookie.name] = cookie.value
  }
  return jar
}

export function sqliteFile(t: TestContext, prefix = 'kaola-auth-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const sqlitePath = join(dir, 'kaola.sqlite')
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return sqlitePath
}

export function openDb(t: TestContext, sqlitePath: string) {
  const db = createDb(sqlitePath)
  t.after(() => {
    db.$client.close()
  })
  return db
}

export function countUsers(db: AppDb) {
  const row = db.$client.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  return Number(row.n)
}

export function seedUser(db: AppDb, { provider, remoteId, username, displayName, status, permissionLevel }: SeedUserSpec) {
  db.$client
    .prepare(
      `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(provider, String(remoteId), username, displayName, status, permissionLevel)
  return db.$client.prepare('SELECT * FROM users WHERE provider = ? AND remote_id = ?').get(provider, String(remoteId))
}

export function withAdmins(t: TestContext, spec: string | null | undefined) {
  const previous = process.env.KAOLA_ADMINS
  if (spec == null || spec === '') delete process.env.KAOLA_ADMINS
  else process.env.KAOLA_ADMINS = spec
  t.after(() => {
    if (previous == null) delete process.env.KAOLA_ADMINS
    else process.env.KAOLA_ADMINS = previous
  })
}

function requestUrl(input: unknown) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url)
  return String(input)
}

function readAuthorization(headers: unknown) {
  if (headers == null) return undefined
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get('authorization') ?? headers.get('Authorization') ?? undefined
  }
  if (Array.isArray(headers)) {
    const hit = headers.find(([name]) => String(name).toLowerCase() === 'authorization') as [unknown, unknown] | undefined
    return hit?.[1] == null ? undefined : String(hit[1])
  }
  if (typeof headers === 'object') {
    const record = headers as Record<string, unknown>
    const value = record.authorization ?? record.Authorization
    return value == null ? undefined : String(value)
  }
  return undefined
}

export function authorizationHeader(input: unknown, init?: { headers?: unknown }) {
  const fromInit = readAuthorization(init?.headers)
  if (fromInit) return fromInit
  if (input && typeof input === 'object' && 'headers' in input) {
    return readAuthorization((input as { headers?: unknown }).headers)
  }
  return undefined
}

export function stubUserinfoByAccessToken(t: TestContext, profiles: Map<string, unknown>) {
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

export function stubTokenExchange(app: FastifyInstance, decoratorName: string, accessToken: string) {
  const oauth = (app as FastifyInstance & Record<string, Oauth2Plugin | undefined>)[decoratorName]
  assert.equal(
    typeof oauth?.getAccessTokenFromAuthorizationCodeFlow,
    'function',
    `${decoratorName}.getAccessTokenFromAuthorizationCodeFlow must exist so tests can stub token exchange`,
  )
  assert.ok(oauth)
  oauth.getAccessTokenFromAuthorizationCodeFlow = async () => ({
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
    },
  })
}

export async function completeOauthCallback(
  app: FastifyInstance,
  { decoratorName, callbackPath, accessToken }: { decoratorName: string; callbackPath: string; accessToken: string },
) {
  stubTokenExchange(app, decoratorName, accessToken)
  return app.inject({
    method: 'GET',
    url: `${callbackPath}?code=test-authorization-code`,
  })
}

export async function loginViaCallback(
  app: FastifyInstance,
  { decoratorName, callbackPath, accessToken }: { decoratorName: string; callbackPath: string; accessToken: string },
) {
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
  return { callback, cookies, me, body: me.json() as MeBody }
}

export function collectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
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

export function assertNoIdentitySecrets(resOrBody: unknown, ...plaintexts: Array<string | undefined | null>) {
  const dumped =
    typeof resOrBody === 'string'
      ? resOrBody
      : resOrBody != null && typeof resOrBody === 'object' && 'body' in resOrBody && (resOrBody as { body?: unknown }).body != null
        ? String((resOrBody as { body: unknown }).body)
        : JSON.stringify(resOrBody)
  for (const plaintext of plaintexts) {
    if (plaintext) {
      assert.equal(dumped.includes(plaintext), false, `response leaked plaintext: ${dumped}`)
    }
  }
  let parsed: unknown = resOrBody
  if (resOrBody != null && typeof resOrBody === 'object' && 'json' in resOrBody && typeof (resOrBody as { json?: unknown }).json === 'function') {
    try {
      parsed = (resOrBody as { json: () => unknown }).json()
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

export async function getSetup(app: FastifyInstance) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/setup',
    headers: { accept: 'application/json' },
  })
}

export async function postSetup(app: FastifyInstance, body: { username: string; password: string } = DEFAULT_SETUP) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    headers: JSON_HEADERS,
    payload: body,
  })
}

export async function postLogin(app: FastifyInstance, body: { username: string; password: string }) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/login',
    headers: JSON_HEADERS,
    payload: body,
  })
}

export async function getMe(app: FastifyInstance, cookies: CookieJar) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/me',
    cookies,
    headers: { accept: 'application/json' },
  })
}

async function sessionFromAuthResponse(app: FastifyInstance, response: InjectCookieResponse): Promise<AuthSession> {
  const cookies = cookieJar(response)
  const me = await getMe(app, cookies)
  assert.equal(me.statusCode, 200, `GET /api/v1/me after auth: ${me.statusCode} ${me.body}`)
  return { response, cookies, me, body: me.json() as MeBody }
}

export function getSetupAdmin(app: FastifyInstance) {
  return setupSessions.get(app)
}

export async function ensureSetup(app: FastifyInstance, creds: { username: string; password: string } = DEFAULT_SETUP) {
  const cached = setupSessions.get(app)
  if (cached) return cached
  const probe = await getSetup(app)
  const probeBody = probe.json() as { setup_complete?: boolean } | null
  if (probe.statusCode === 200 && probeBody?.setup_complete === true) {
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

export async function loginGitlabPublisher(app: FastifyInstance, stubOauthMap: Map<string, unknown>, label = 'gitlab') {
  await ensureSetup(app)
  const accessToken = nextAccessToken(label)
  stubOauthMap.set(accessToken, {
    id: 80000 + tokenSeq,
    username: `gl-${label}`,
    name: `Git Lab ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })
}

export async function loginGiteaPublisher(app: FastifyInstance, stubOauthMap: Map<string, unknown>, label = 'gitea') {
  await ensureSetup(app)
  const accessToken = nextAccessToken(label)
  stubOauthMap.set(accessToken, {
    id: 70000 + tokenSeq,
    login: `gt-${label}`,
    full_name: `Gi Tea ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitea, accessToken })
}

export function assertPersistedUser(body: MeBody, expected: Omit<MeBody, 'id' | 'trusted_automation'> & { id?: number }) {
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

export function assertNotAUserBody(body: unknown) {
  if (body == null || typeof body !== 'object') return
  const record = body as Record<string, unknown>
  assert.equal(record.provider, undefined)
  assert.equal(record.remote_id, undefined)
  assert.equal(record.username, undefined)
  assert.equal(record.permission_level, undefined)
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

export function insertLegacyUser(sqlite: Database.Database, { provider, remoteId, username, displayName, status, permissionLevel }: SeedUserSpec) {
  sqlite
    .prepare(
      `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(provider, String(remoteId), username, displayName, status, permissionLevel)
}
