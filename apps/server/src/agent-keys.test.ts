import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createDb } from './db.ts'
import { injectSigned, pairDeviceToSelf } from './device-proof.test-helpers.ts'

// Binding names: kaola-workflow/bundle-4-5/.cache/technical-decisions.md
const PENDING_STATUS = '待批准'
const PENDING_GENERATE_MESSAGE = '你的账号待正式成员批准后方可生成 Agent Key。'
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const TOKEN_RE = /^ktk_[0-9a-f]{64}$/
const JSON_ACCEPT = { accept: 'application/json' }
const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' }

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
  delete process.env.VAULT_MASTER_KEY
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

async function createApp(t, options) {
  const app = buildApp(options)
  t.after(async () => {
    await app.close()
  })
  await app.ready()
  return app
}

function tempSqlitePath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-agent-keys-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return join(dir, 'kaola.sqlite')
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
    headers: JSON_ACCEPT,
  })
  assert.equal(me.statusCode, 200, `GET /api/v1/me after callback: ${me.statusCode} ${me.body}`)
  return { callback, cookies, me, body: me.json() }
}

function parseJson(res) {
  try {
    return res.json()
  } catch {
    return null
  }
}

function sha256Hex(plaintext) {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

function assertSessionUnauthorized(res) {
  assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}: ${res.body}`)
  assert.deepEqual(parseJson(res), { error: 'unauthorized' })
  assert.equal(res.headers['www-authenticate'], undefined)
}

function assertDeviceUnauthorized(res) {
  assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}: ${res.body}`)
  assert.deepEqual(parseJson(res), { error: 'unauthorized' })
  assert.match(String(res.headers['www-authenticate'] ?? ''), /Kaola-Device/)
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

function assertWhoamiDeviceOwner(res, { deviceId, fingerprint, userId }) {
  assert.equal(res.statusCode, 200, `GET /api/v1/agent/whoami: ${res.statusCode} ${res.body}`)
  const who = parseJson(res)
  assert.equal(Number(who.device_id), Number(deviceId))
  assert.equal(who.fingerprint, fingerprint)
  assert.equal(who.status, 'active')
  assert.equal(who.owner?.kind, 'user')
  assert.equal(Number(who.owner?.user_id), Number(userId))
  assert.equal(Object.hasOwn(who, 'token'), false)
  assert.equal(who.key_id, undefined)
}

function assertLoginRedirect(res) {
  assert.equal(res.statusCode, 302, `expected 302, got ${res.statusCode}: ${res.body}`)
  assert.match(String(res.headers.location), /\/login(?:\?|$)/)
}

function assertCreateKeyBody(body, expectedLabel) {
  assert.equal(typeof body, 'object')
  assert.ok(body)
  assert.ok(Number.isInteger(Number(body.id)) && Number(body.id) > 0, `id must be a positive integer, got ${body.id}`)
  assert.equal(body.label, expectedLabel)
  assert.equal(body.last_used_at, null)
  assert.equal(typeof body.token, 'string')
  assert.match(body.token, TOKEN_RE)
  assert.equal(body.key_hash, undefined)
}

function assertNoPlaintextOrHash(payload, plaintexts) {
  const dumped = JSON.stringify(payload)
  assert.ok(!dumped.includes('key_hash'), `response must not include key_hash: ${dumped}`)
  for (const token of plaintexts) {
    assert.equal(dumped.includes(token), false, `response must not contain plaintext token`)
  }
}

function assertListBody(body, plaintexts) {
  assert.equal(typeof body, 'object')
  assert.ok(body)
  assert.ok(Array.isArray(body.keys), `expected { keys: [] }, got ${JSON.stringify(body)}`)
  assert.equal(body.token, undefined)
  assertNoPlaintextOrHash(body, plaintexts)
  for (const key of body.keys) {
    assert.ok(Number.isInteger(Number(key.id)) && Number(key.id) > 0)
    assert.equal(typeof key.label, 'string')
    assert.ok(key.last_used_at === null || Number.isInteger(key.last_used_at), `last_used_at must be null or unix seconds, got ${key.last_used_at}`)
    assert.equal(key.token, undefined)
    assert.equal(key.key_hash, undefined)
  }
}

async function postAgentKey(app, cookies, payload) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/agent-keys',
    cookies,
    headers: JSON_HEADERS,
    payload: payload ?? {},
  })
}

async function listAgentKeys(app, cookies) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/agent-keys',
    cookies,
    headers: JSON_ACCEPT,
  })
}

async function deleteAgentKey(app, cookies, id) {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/agent-keys/${id}`,
    cookies,
    headers: JSON_ACCEPT,
  })
}

async function agentWhoami(app, { token, authorization, cookies } = {}) {
  const headers = { ...JSON_ACCEPT }
  if (authorization != null) {
    headers.authorization = authorization
  } else if (token != null) {
    headers.authorization = `Bearer ${token}`
  }
  return app.inject({
    method: 'GET',
    url: '/api/v1/agent/whoami',
    headers,
    cookies,
  })
}

describe('unauthenticated session agent-key routes', () => {
  test('JSON Accept is 401 unauthorized without WWW-Authenticate; browser-like requests redirect to /login', async (t) => {
    const app = await createApp(t)

    const jsonGet = await listAgentKeys(app, undefined)
    assertSessionUnauthorized(jsonGet)

    const jsonPost = await postAgentKey(app, undefined, { label: 'no-session' })
    assertSessionUnauthorized(jsonPost)

    const jsonDelete = await deleteAgentKey(app, undefined, 1)
    assertSessionUnauthorized(jsonDelete)

    const browserGet = await app.inject({
      method: 'GET',
      url: '/api/v1/agent-keys',
      headers: { accept: 'text/html' },
    })
    assertLoginRedirect(browserGet)

    const browserPost = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-keys',
      headers: { accept: 'text/html', 'content-type': 'application/json' },
      payload: { label: 'browser' },
    })
    assertLoginRedirect(browserPost)

    const browserDelete = await app.inject({
      method: 'DELETE',
      url: '/api/v1/agent-keys/1',
      headers: { accept: 'text/html' },
    })
    assertLoginRedirect(browserDelete)

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: JSON_ACCEPT,
    })
    assertSessionUnauthorized(me)
  })
})

describe('GET /api/v1/agent/whoami device-proof failures', () => {
  test('missing, leftover ktk_, and non-device credentials are 401 with WWW-Authenticate Kaola-Device', async (t) => {
    const app = await createApp(t)
    const fake = `ktk_${'ab'.repeat(32)}`

    const missing = await agentWhoami(app, {})
    assertDeviceUnauthorized(missing)

    const wrong = await agentWhoami(app, { token: fake })
    assertDeviceUnauthorized(wrong)

    const tokenScheme = await agentWhoami(app, { authorization: `Token ${fake}` })
    assertDeviceUnauthorized(tokenScheme)

    const basic = await agentWhoami(app, { authorization: 'Basic dXNlcjpwYXNz' })
    assertDeviceUnauthorized(basic)
  })

  test('a session cookie does not authorize whoami; GET /api/v1/me does not accept Bearer', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('gitlab-session-whoami')
    profiles.set(accessToken, { id: 21, username: 'sess-user', name: 'Sess User' })
    const session = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })

    const created = await postAgentKey(app, session.cookies, { label: 'probe' })
    assert.equal(created.statusCode, 201, `POST /api/v1/agent-keys: ${created.statusCode} ${created.body}`)
    const createdBody = created.json()
    assertCreateKeyBody(createdBody, 'probe')

    const sessionOnly = await agentWhoami(app, { cookies: session.cookies })
    assertDeviceUnauthorized(sessionOnly)

    const sessionPlusWrong = await agentWhoami(app, {
      cookies: session.cookies,
      token: `ktk_${'cd'.repeat(32)}`,
    })
    assertDeviceUnauthorized(sessionPlusWrong)

    const meWithBearer = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${createdBody.token}`,
      },
    })
    assertSessionUnauthorized(meWithBearer)
  })
})

describe('leftover 待批准 GitHub cannot generate Agent Keys', () => {
  test('leftover 待批准 GitHub POST /api/v1/agent-keys returns 403 with the generate-gate message', async (t) => {
    const sqlitePath = tempSqlitePath(t)
    const db = createDb(sqlitePath)
    t.after(() => {
      db.$client.close()
    })
    seedLeftoverGithub(db, {
      remoteId: 4242,
      username: 'pending-cat',
      displayName: 'Pending Cat',
      status: PENDING_STATUS,
      permissionLevel: 'claim_only',
    })
    const app = await createApp(t, { sqlitePath })
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('github-pending-key')
    profiles.set(accessToken, { id: 4242, login: 'pending-cat', name: 'Pending Cat' })
    const pending = await loginViaCallback(app, { ...PROVIDERS.github, accessToken })
    assert.equal(pending.body.status, PENDING_STATUS)
    assert.equal(pending.body.permission_level, 'claim_only')

    const generated = await postAgentKey(app, pending.cookies, { label: 'blocked' })
    assert.equal(generated.statusCode, 403, `pending generate: ${generated.statusCode} ${generated.body}`)
    const body = parseJson(generated)
    assert.equal(body?.error, 'forbidden')
    assert.equal(body?.message, PENDING_GENERATE_MESSAGE)
  })
})

describe('leftover GitHub claim_only session CRUD (unused-compat)', () => {
  test('leftover active claim_only can generate, list without plaintext, and revoke; leftover ktk_ is not whoami', async (t) => {
    const sqlitePath = tempSqlitePath(t)
    const db = createDb(sqlitePath)
    t.after(() => {
      db.$client.close()
    })
    seedLeftoverGithub(db, {
      remoteId: 333,
      username: 'needs-ok',
      displayName: 'Needs Ok',
      status: 'active',
      permissionLevel: 'claim_only',
    })
    const app = await createApp(t, { sqlitePath })
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const githubToken = nextAccessToken('github-approved-key')
    profiles.set(githubToken, { id: 333, login: 'needs-ok', name: 'Needs Ok' })

    const github = await loginViaCallback(app, { ...PROVIDERS.github, accessToken: githubToken })
    assert.equal(github.body.status, 'active')
    assert.equal(github.body.permission_level, 'claim_only')

    const empty = await listAgentKeys(app, github.cookies)
    assert.equal(empty.statusCode, 200, `GET /api/v1/agent-keys: ${empty.statusCode} ${empty.body}`)
    assertListBody(empty.json(), [])
    assert.equal(empty.json().keys.length, 0)

    const created = await postAgentKey(app, github.cookies, { label: 'gh-agent' })
    assert.equal(created.statusCode, 201, `POST /api/v1/agent-keys: ${created.statusCode} ${created.body}`)
    const createdBody = created.json()
    assertCreateKeyBody(createdBody, 'gh-agent')
    const plaintext = createdBody.token

    const listed = await listAgentKeys(app, github.cookies)
    assert.equal(listed.statusCode, 200)
    assertListBody(listed.json(), [plaintext])
    assert.equal(listed.json().keys.length, 1)
    assert.equal(listed.json().keys[0].id, createdBody.id)
    assert.equal(listed.json().keys[0].label, 'gh-agent')
    assert.equal(listed.json().keys[0].last_used_at, null)

    const wrong = await agentWhoami(app, { token: `ktk_${'ef'.repeat(32)}` })
    assertDeviceUnauthorized(wrong)
    const listedAfterWrong = await listAgentKeys(app, github.cookies)
    assert.equal(listedAfterWrong.json().keys[0].last_used_at, null)

    const leftover = await agentWhoami(app, { token: plaintext })
    assertDeviceUnauthorized(leftover)
    const listedAfterLeftover = await listAgentKeys(app, github.cookies)
    assert.equal(listedAfterLeftover.json().keys[0].last_used_at, null)

    const revoked = await deleteAgentKey(app, github.cookies, createdBody.id)
    assert.equal(revoked.statusCode, 200, `DELETE /api/v1/agent-keys/:id: ${revoked.statusCode} ${revoked.body}`)
    assert.deepEqual(parseJson(revoked), { ok: true })
    assertNoPlaintextOrHash(parseJson(revoked), [plaintext])

    const afterRevoke = await agentWhoami(app, { token: plaintext })
    assertDeviceUnauthorized(afterRevoke)

    const listedAfterRevoke = await listAgentKeys(app, github.cookies)
    assertListBody(listedAfterRevoke.json(), [plaintext])
    assert.equal(listedAfterRevoke.json().keys.length, 0)
  })
})

describe('GitLab and Gitea full+active self-service', () => {
  test('GitLab full+active can generate keys without VAULT_MASTER_KEY; GET / stays 考拉任务服务占位', async (t) => {
    assert.equal(process.env.VAULT_MASTER_KEY, undefined)
    const app = await createApp(t)
    const root = await app.inject({ method: 'GET', url: '/' })
    assert.equal(root.statusCode, 200)
    assert.equal(root.body, '考拉任务服务占位')

    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('gitlab-full-key')
    profiles.set(accessToken, { id: 99, username: 'gl-user', name: 'Git Lab' })
    const gitlab = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })
    assert.equal(gitlab.body.status, 'active')
    assert.equal(gitlab.body.permission_level, 'full')

    const unlabeled = await postAgentKey(app, gitlab.cookies, {})
    assert.equal(unlabeled.statusCode, 201, `POST unlabeled: ${unlabeled.statusCode} ${unlabeled.body}`)
    assertCreateKeyBody(unlabeled.json(), '')

    const labeled = await postAgentKey(app, gitlab.cookies, { label: 'ci' })
    assert.equal(labeled.statusCode, 201)
    assertCreateKeyBody(labeled.json(), 'ci')
    assert.notEqual(labeled.json().token, unlabeled.json().token)

    const sameLabel = await postAgentKey(app, gitlab.cookies, { label: 'ci' })
    assert.equal(sameLabel.statusCode, 201)
    assertCreateKeyBody(sameLabel.json(), 'ci')
    assert.notEqual(sameLabel.json().token, labeled.json().token)

    const listed = await listAgentKeys(app, gitlab.cookies)
    assert.equal(listed.statusCode, 200)
    assertListBody(listed.json(), [
      unlabeled.json().token,
      labeled.json().token,
      sameLabel.json().token,
    ])
    assert.equal(listed.json().keys.length, 3)

    const leftoverLower = await agentWhoami(app, { authorization: `bearer ${labeled.json().token}` })
    assertDeviceUnauthorized(leftoverLower)
    const leftoverMixed = await agentWhoami(app, { authorization: `BeArEr ${unlabeled.json().token}` })
    assertDeviceUnauthorized(leftoverMixed)

    const paired = await pairDeviceToSelf(app, gitlab.cookies)
    const whoami = await injectSigned(app, paired.identity, {
      method: 'GET',
      url: '/api/v1/agent/whoami',
      extraHeaders: JSON_ACCEPT,
    })
    assertWhoamiDeviceOwner(whoami, {
      deviceId: paired.deviceId,
      fingerprint: paired.identity.fingerprint,
      userId: gitlab.body.id,
    })
    assertNoPlaintextOrHash(parseJson(whoami), [
      unlabeled.json().token,
      labeled.json().token,
      sameLabel.json().token,
    ])

    const stillRoot = await app.inject({ method: 'GET', url: '/' })
    assert.equal(stillRoot.body, '考拉任务服务占位')
    assert.equal(process.env.VAULT_MASTER_KEY, undefined)
  })

  test('Gitea full+active can generate, list, and use device-proof whoami', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('gitea-full-key')
    profiles.set(accessToken, { id: 5, login: 'gt-user', full_name: 'Gi Tea' })
    const gitea = await loginViaCallback(app, { ...PROVIDERS.gitea, accessToken })
    assert.equal(gitea.body.status, 'active')
    assert.equal(gitea.body.permission_level, 'full')

    const created = await postAgentKey(app, gitea.cookies, { label: 'gitea-bot' })
    assert.equal(created.statusCode, 201, `POST /api/v1/agent-keys: ${created.statusCode} ${created.body}`)
    assertCreateKeyBody(created.json(), 'gitea-bot')

    const listed = await listAgentKeys(app, gitea.cookies)
    assert.equal(listed.statusCode, 200)
    assertListBody(listed.json(), [created.json().token])
    assert.equal(listed.json().keys.length, 1)

    const leftover = await agentWhoami(app, { token: created.json().token })
    assertDeviceUnauthorized(leftover)

    const paired = await pairDeviceToSelf(app, gitea.cookies)
    const whoami = await injectSigned(app, paired.identity, {
      method: 'GET',
      url: '/api/v1/agent/whoami',
      extraHeaders: JSON_ACCEPT,
    })
    assertWhoamiDeviceOwner(whoami, {
      deviceId: paired.deviceId,
      fingerprint: paired.identity.fingerprint,
      userId: gitea.body.id,
    })
    assertNoPlaintextOrHash(parseJson(whoami), [created.json().token])
  })
})

describe('list and revoke are own keys only', () => {
  test('a full member cannot list or revoke another user\'s key; missing and not-owned DELETE are 404 not_found', async (t) => {
    withAdmins(t, 'gitlab:bob')
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const aliceToken = nextAccessToken('gitlab-alice')
    const bobToken = nextAccessToken('gitlab-bob')
    profiles.set(aliceToken, { id: 10, username: 'alice', name: 'Alice' })
    profiles.set(bobToken, { id: 11, username: 'bob', name: 'Bob' })
    const alice = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: aliceToken })
    const bob = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken: bobToken })
    assert.notEqual(String(alice.body.id), String(bob.body.id))

    const aliceKey = await postAgentKey(app, alice.cookies, { label: 'alice-key' })
    assert.equal(aliceKey.statusCode, 201, `alice create: ${aliceKey.statusCode} ${aliceKey.body}`)
    const aliceBody = aliceKey.json()
    assertCreateKeyBody(aliceBody, 'alice-key')

    const bobList = await listAgentKeys(app, bob.cookies)
    assert.equal(bobList.statusCode, 200)
    assertListBody(bobList.json(), [aliceBody.token])
    assert.equal(bobList.json().keys.some((key) => Number(key.id) === Number(aliceBody.id)), false)

    const bobRevoke = await deleteAgentKey(app, bob.cookies, aliceBody.id)
    assert.equal(bobRevoke.statusCode, 404, `not-owned DELETE: ${bobRevoke.statusCode} ${bobRevoke.body}`)
    assert.deepEqual(parseJson(bobRevoke), { error: 'not_found' })

    const missing = await deleteAgentKey(app, alice.cookies, 999999)
    assert.equal(missing.statusCode, 404, `missing DELETE: ${missing.statusCode} ${missing.body}`)
    assert.deepEqual(parseJson(missing), { error: 'not_found' })

    const stillAlice = await listAgentKeys(app, alice.cookies)
    assert.equal(stillAlice.json().keys.length, 1)
    assert.equal(Number(stillAlice.json().keys[0].id), Number(aliceBody.id))

    const leftoverWhoami = await agentWhoami(app, { token: aliceBody.token })
    assertDeviceUnauthorized(leftoverWhoami)
    const stillAliceAfterLeftover = await listAgentKeys(app, alice.cookies)
    assert.equal(stillAliceAfterLeftover.json().keys.length, 1)
    assert.equal(Number(stillAliceAfterLeftover.json().keys[0].id), Number(aliceBody.id))

    const aliceRevoke = await deleteAgentKey(app, alice.cookies, aliceBody.id)
    assert.equal(aliceRevoke.statusCode, 200)
    assert.deepEqual(parseJson(aliceRevoke), { ok: true })

    const gone = await deleteAgentKey(app, alice.cookies, aliceBody.id)
    assert.equal(gone.statusCode, 404)
    assert.deepEqual(parseJson(gone), { error: 'not_found' })
  })
})

describe('agent_keys hashed storage', () => {
  test('SQLite stores sha256 hex of plaintext utf8, never the token, unique key_hash; failed Bearer does not set last_used_at', async (t) => {
    const sqlitePath = tempSqlitePath(t)
    const app = await createApp(t, { sqlitePath })
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('gitlab-hash')
    profiles.set(accessToken, { id: 77, username: 'hash-user', name: 'Hash User' })
    const user = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })

    const first = await postAgentKey(app, user.cookies, { label: 'one' })
    assert.equal(first.statusCode, 201, `first create: ${first.statusCode} ${first.body}`)
    assertCreateKeyBody(first.json(), 'one')
    const second = await postAgentKey(app, user.cookies, { label: 'two' })
    assert.equal(second.statusCode, 201, `second create: ${second.statusCode} ${second.body}`)
    assertCreateKeyBody(second.json(), 'two')
    const firstToken = first.json().token
    const secondToken = second.json().token
    assert.notEqual(firstToken, secondToken)

    const sqlite = new Database(sqlitePath, { readonly: false })
    t.after(() => {
      sqlite.close()
    })

    const rows = sqlite.prepare(
      'SELECT id, user_id, key_hash, label, last_used_at FROM agent_keys ORDER BY id',
    ).all()
    assert.equal(rows.length, 2, `expected 2 agent_keys rows, got ${rows.length}`)

    for (const [row, plaintext, label] of [
      [rows[0], firstToken, 'one'],
      [rows[1], secondToken, 'two'],
    ]) {
      const dump = JSON.stringify(row)
      assert.equal(dump.includes(plaintext), false, `row dump must not contain plaintext: ${dump}`)
      assert.notEqual(row.key_hash, plaintext)
      assert.equal(row.key_hash, sha256Hex(plaintext))
      assert.match(row.key_hash, /^[0-9a-f]{64}$/)
      assert.equal(Number(row.user_id), Number(user.body.id))
      assert.equal(row.label, label)
      assert.equal(row.last_used_at, null)
    }
    assert.notEqual(rows[0].key_hash, rows[1].key_hash)
    assert.equal(Number(rows[0].id), Number(first.json().id))
    assert.equal(Number(rows[1].id), Number(second.json().id))

    let duplicateInserted = false
    try {
      sqlite
        .prepare(
          'INSERT INTO agent_keys (user_id, key_hash, label, last_used_at) VALUES (?, ?, ?, ?)',
        )
        .run(rows[0].user_id, rows[0].key_hash, 'dup', null)
      duplicateInserted = true
    } catch (err) {
      assert.match(String(err.message), /UNIQUE/i)
    }
    assert.equal(duplicateInserted, false, 'duplicate key_hash must violate UNIQUE')

    const failed = await agentWhoami(app, { token: `ktk_${'00'.repeat(32)}` })
    assertDeviceUnauthorized(failed)
    const afterFail = sqlite.prepare('SELECT last_used_at FROM agent_keys WHERE id = ?').get(rows[0].id)
    assert.equal(afterFail.last_used_at, null)

    const leftoverOk = await agentWhoami(app, { token: firstToken })
    assertDeviceUnauthorized(leftoverOk)
    const afterLeftover = sqlite.prepare('SELECT last_used_at FROM agent_keys WHERE id = ?').get(rows[0].id)
    assert.equal(afterLeftover.last_used_at, null)
    const sibling = sqlite.prepare('SELECT last_used_at FROM agent_keys WHERE id = ?').get(rows[1].id)
    assert.equal(sibling.last_used_at, null)
  })
})
