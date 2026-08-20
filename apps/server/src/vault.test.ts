import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.ts'

// Binding names: kaola-workflow/bundle-4-5/.cache/technical-decisions.md
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const FORGE_REVOKE_MESSAGE = '请同时到 forge 侧撤销该 token。'
const VAULT_MASTER_KEY_HEX = 'ab'.repeat(32)
const ONE_OFF_TOKEN = 'glpat-ONE-OFF-TEMP-TOKEN-xyzzynotindb'
const PROFILE_TOKEN = 'glpat-PROFILE-PLAINTEXT-TOKEN-do-not-store'

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
  const dir = mkdtempSync(join(tmpdir(), 'kaola-vault-'))
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

function beginUserinfo(t) {
  const profiles = new Map()
  stubUserinfoByAccessToken(t, profiles)
  return profiles
}

async function loginGitlab(app, profiles, label = 'gitlab') {
  const accessToken = nextAccessToken(label)
  profiles.set(accessToken, {
    id: 80000 + tokenSeq,
    username: `gl-${label}`,
    name: `Git Lab ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })
}

async function loginGitea(app, profiles, label = 'gitea') {
  const accessToken = nextAccessToken(label)
  profiles.set(accessToken, {
    id: 70000 + tokenSeq,
    login: `gt-${label}`,
    full_name: `Gi Tea ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.gitea, accessToken })
}

async function loginGithub(app, profiles, label = 'github') {
  const accessToken = nextAccessToken(label)
  profiles.set(accessToken, {
    id: 60000 + tokenSeq,
    login: `gh-${label}`,
    name: `Octo ${label}`,
  })
  return loginViaCallback(app, { ...PROVIDERS.github, accessToken })
}

function jsonBody(res) {
  try {
    return res.json()
  } catch {
    return null
  }
}

function assertNoSecrets(body, plaintext) {
  assert.equal(body?.token, undefined)
  assert.equal(body?.token_encrypted, undefined)
  const dumped = JSON.stringify(body)
  assert.equal(dumped.includes(plaintext), false, `response leaked plaintext token: ${dumped}`)
}

function assertPublicProfile(body, expected, plaintext) {
  assert.equal(typeof body, 'object')
  assert.ok(body)
  assert.ok(Number.isInteger(Number(body.id)) && Number(body.id) > 0, `id must be a positive integer, got ${body.id}`)
  assert.equal(body.forge, expected.forge)
  assert.equal(body.base_url, expected.base_url)
  assert.equal(body.repo_full_name, expected.repo_full_name)
  assert.deepEqual(body.scopes_checked, [])
  assert.equal(body.created_by, expected.created_by)
  assertNoSecrets(body, plaintext)
}

function profilePayload(overrides = {}) {
  return {
    forge: 'gitlab',
    base_url: GITLAB_BASE_URL,
    repo_full_name: 'acme/vault-demo',
    token: PROFILE_TOKEN,
    ...overrides,
  }
}

async function postProfile(app, cookies, payload = profilePayload()) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/credential-profiles',
    cookies,
    headers: jsonHeaders,
    payload,
  })
}

async function listProfiles(app, cookies) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/credential-profiles',
    cookies,
    headers: jsonHeaders,
  })
}

async function deleteProfile(app, cookies, id) {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/credential-profiles/${id}`,
    cookies,
    headers: jsonHeaders,
  })
}

function parseDetails(row) {
  if (row == null) return null
  if (typeof row.details === 'string') return JSON.parse(row.details)
  return row.details
}

function blobText(value) {
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function assertUnixSeconds(value) {
  const now = Math.floor(Date.now() / 1000)
  assert.ok(Number.isInteger(Number(value)), `created_at must be unix seconds, got ${value}`)
  const n = Number(value)
  assert.ok(n >= now - 120 && n <= now + 5, `created_at ${n} is not a current unix-second timestamp`)
}

function eventRows(db) {
  return db.$client.prepare('SELECT type, actor_user_id, created_at, details FROM events').all()
}

describe('issue #5 credential vault', { concurrency: false }, () => {
describe('placeholder pin', () => {
  test('GET / still returns 考拉任务服务占位', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: '/' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, '考拉任务服务占位')
  })
})

describe('unauthenticated credential-profile routes', () => {
  test('JSON GET/POST/DELETE without a session return 401 unauthorized', async (t) => {
    const app = await createApp(t)

    const listed = await listProfiles(app, {})
    assert.equal(listed.statusCode, 401, `GET list: ${listed.statusCode} ${listed.body}`)
    assert.equal(jsonBody(listed)?.error, 'unauthorized')

    const created = await postProfile(app, {})
    assert.equal(created.statusCode, 401, `POST: ${created.statusCode} ${created.body}`)
    assert.equal(jsonBody(created)?.error, 'unauthorized')

    const deleted = await deleteProfile(app, {}, 1)
    assert.equal(deleted.statusCode, 401, `DELETE: ${deleted.statusCode} ${deleted.body}`)
    assert.equal(jsonBody(deleted)?.error, 'unauthorized')
  })

  test('browser-like GET /api/v1/credential-profiles redirects to /login', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/credential-profiles',
      headers: { accept: 'text/html' },
    })
    assert.equal(res.statusCode, 302)
    assert.match(String(res.headers.location), /\/login(?:\?|$)/)
  })
})

describe('credential profile CRUD (session, active full)', () => {
  test('GitLab POST returns 201 public fields and GET lists them without secrets', async (t) => {
    const app = await createApp(t)
    const profiles = beginUserinfo(t)
    const gitlab = await loginGitlab(app, profiles, 'create')
    const payload = profilePayload({ repo_full_name: 'acme/create-demo' })

    const created = await postProfile(app, gitlab.cookies, payload)
    assert.equal(created.statusCode, 201, `POST: ${created.statusCode} ${created.body}`)
    const body = jsonBody(created)
    assertPublicProfile(
      body,
      {
        forge: payload.forge,
        base_url: payload.base_url,
        repo_full_name: payload.repo_full_name,
        created_by: gitlab.body.id,
      },
      payload.token,
    )

    const listed = await listProfiles(app, gitlab.cookies)
    assert.equal(listed.statusCode, 200, `GET list: ${listed.statusCode} ${listed.body}`)
    const listBody = jsonBody(listed)
    assert.ok(Array.isArray(listBody?.profiles), `expected { profiles: [] }, got ${listed.body}`)
    const hit = listBody.profiles.find((row) => String(row.id) === String(body.id))
    assertPublicProfile(
      hit,
      {
        forge: payload.forge,
        base_url: payload.base_url,
        repo_full_name: payload.repo_full_name,
        created_by: gitlab.body.id,
      },
      payload.token,
    )
    for (const row of listBody.profiles) {
      assertNoSecrets(row, payload.token)
    }
  })

  test('Gitea active full member can POST a credential profile', async (t) => {
    const app = await createApp(t)
    const profiles = beginUserinfo(t)
    const gitea = await loginGitea(app, profiles, 'create')
    const payload = profilePayload({
      forge: 'gitea',
      base_url: GITEA_BASE_URL,
      repo_full_name: 'acme/gitea-demo',
    })
    const created = await postProfile(app, gitea.cookies, payload)
    assert.equal(created.statusCode, 201, `POST: ${created.statusCode} ${created.body}`)
    assertPublicProfile(
      jsonBody(created),
      {
        forge: 'gitea',
        base_url: GITEA_BASE_URL,
        repo_full_name: 'acme/gitea-demo',
        created_by: gitea.body.id,
      },
      payload.token,
    )
  })

  test('duplicate (forge, base_url, repo_full_name) returns 409 conflict', async (t) => {
    const app = await createApp(t)
    const profiles = beginUserinfo(t)
    const first = await loginGitlab(app, profiles, 'dup-a')
    const second = await loginGitlab(app, profiles, 'dup-b')
    const payload = profilePayload({ repo_full_name: 'acme/unique-triple' })

    const created = await postProfile(app, first.cookies, payload)
    assert.equal(created.statusCode, 201, `first POST: ${created.statusCode} ${created.body}`)

    const sameUser = await postProfile(app, first.cookies, payload)
    assert.equal(sameUser.statusCode, 409, `same user duplicate: ${sameUser.statusCode} ${sameUser.body}`)
    assert.equal(jsonBody(sameUser)?.error, 'conflict')
    assertNoSecrets(jsonBody(sameUser), payload.token)

    const otherUser = await postProfile(app, second.cookies, payload)
    assert.equal(otherUser.statusCode, 409, `other user duplicate: ${otherUser.statusCode} ${otherUser.body}`)
    assert.equal(jsonBody(otherUser)?.error, 'conflict')
  })

  test('DELETE returns forge-revoke copy; missing id is 404 not_found', async (t) => {
    const app = await createApp(t)
    const profiles = beginUserinfo(t)
    const gitlab = await loginGitlab(app, profiles, 'delete')
    const payload = profilePayload({ repo_full_name: 'acme/to-delete' })
    const created = await postProfile(app, gitlab.cookies, payload)
    assert.equal(created.statusCode, 201, `POST: ${created.statusCode} ${created.body}`)
    const id = jsonBody(created).id

    const deleted = await deleteProfile(app, gitlab.cookies, id)
    assert.equal(deleted.statusCode, 200, `DELETE: ${deleted.statusCode} ${deleted.body}`)
    const body = jsonBody(deleted)
    assert.equal(body?.ok, true)
    assert.equal(body?.message, FORGE_REVOKE_MESSAGE)
    assertNoSecrets(body, payload.token)

    const missing = await deleteProfile(app, gitlab.cookies, id)
    assert.equal(missing.statusCode, 404, `second DELETE: ${missing.statusCode} ${missing.body}`)
    assert.equal(jsonBody(missing)?.error, 'not_found')

    const neverExisted = await deleteProfile(app, gitlab.cookies, 999999)
    assert.equal(neverExisted.statusCode, 404)
    assert.equal(jsonBody(neverExisted)?.error, 'not_found')
  })

  test('any active full member lists and deletes team-shared profiles', async (t) => {
    const app = await createApp(t)
    const profiles = beginUserinfo(t)
    const owner = await loginGitlab(app, profiles, 'share-owner')
    const peer = await loginGitea(app, profiles, 'share-peer')
    const payload = profilePayload({ repo_full_name: 'acme/team-shared' })

    const created = await postProfile(app, owner.cookies, payload)
    assert.equal(created.statusCode, 201, `POST: ${created.statusCode} ${created.body}`)
    const id = jsonBody(created).id

    const listed = await listProfiles(app, peer.cookies)
    assert.equal(listed.statusCode, 200, `peer GET list: ${listed.statusCode} ${listed.body}`)
    const hit = jsonBody(listed)?.profiles?.find((row) => String(row.id) === String(id))
    assert.ok(hit, `peer did not see team-shared profile ${id}: ${listed.body}`)
    assert.equal(hit.created_by, owner.body.id)

    const deleted = await deleteProfile(app, peer.cookies, id)
    assert.equal(deleted.statusCode, 200, `peer DELETE: ${deleted.statusCode} ${deleted.body}`)
    assert.equal(jsonBody(deleted)?.message, FORGE_REVOKE_MESSAGE)
  })
})

describe('permission gate (profiles are active+full only)', () => {
  test('pending GitHub user gets 403 forbidden on POST/GET/DELETE', async (t) => {
    const app = await createApp(t)
    const profiles = beginUserinfo(t)
    const pending = await loginGithub(app, profiles, 'pending')
    assert.equal(pending.body.status, '待批准')
    assert.equal(pending.body.permission_level, 'claim_only')

    const created = await postProfile(app, pending.cookies)
    assert.equal(created.statusCode, 403, `POST: ${created.statusCode} ${created.body}`)
    assert.equal(jsonBody(created)?.error, 'forbidden')

    const listed = await listProfiles(app, pending.cookies)
    assert.equal(listed.statusCode, 403, `GET: ${listed.statusCode} ${listed.body}`)
    assert.equal(jsonBody(listed)?.error, 'forbidden')

    const deleted = await deleteProfile(app, pending.cookies, 1)
    assert.equal(deleted.statusCode, 403, `DELETE: ${deleted.statusCode} ${deleted.body}`)
    assert.equal(jsonBody(deleted)?.error, 'forbidden')
  })

  test('approved GitHub claim_only still gets 403 forbidden on POST/GET/DELETE', async (t) => {
    const app = await createApp(t)
    const profiles = beginUserinfo(t)
    const github = await loginGithub(app, profiles, 'claim-only')
    const member = await loginGitlab(app, profiles, 'approver')

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${github.body.id}/approve`,
      cookies: member.cookies,
      headers: jsonHeaders,
    })
    assert.ok(
      approve.statusCode >= 200 && approve.statusCode < 300,
      `approve should succeed, got ${approve.statusCode}: ${approve.body}`,
    )
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: github.cookies,
      headers: jsonHeaders,
    })
    assert.equal(me.json().status, 'active')
    assert.equal(me.json().permission_level, 'claim_only')

    const payload = profilePayload({ repo_full_name: 'acme/member-owned' })
    const owned = await postProfile(app, member.cookies, payload)
    assert.equal(owned.statusCode, 201, `member POST: ${owned.statusCode} ${owned.body}`)
    const id = jsonBody(owned).id

    const created = await postProfile(app, github.cookies, profilePayload({ repo_full_name: 'acme/gh-cannot' }))
    assert.equal(created.statusCode, 403, `claim_only POST: ${created.statusCode} ${created.body}`)
    assert.equal(jsonBody(created)?.error, 'forbidden')

    const listed = await listProfiles(app, github.cookies)
    assert.equal(listed.statusCode, 403, `claim_only GET: ${listed.statusCode} ${listed.body}`)
    assert.equal(jsonBody(listed)?.error, 'forbidden')

    const deleted = await deleteProfile(app, github.cookies, id)
    assert.equal(deleted.statusCode, 403, `claim_only DELETE: ${deleted.statusCode} ${deleted.body}`)
    assert.equal(jsonBody(deleted)?.error, 'forbidden')
  })
})

describe('SQLite: no plaintext token; 变更 events', () => {
  test('token_encrypted TEXT omits plaintext and create writes 变更', async (t) => {
    const sqlitePath = sqliteFile(t)
    const app = await createApp(t, sqlitePath)
    const profiles = beginUserinfo(t)
    const gitlab = await loginGitlab(app, profiles, 'sqlite-create')
    const payload = profilePayload({ repo_full_name: 'acme/encrypted-row' })

    const created = await postProfile(app, gitlab.cookies, payload)
    assert.equal(created.statusCode, 201, `POST: ${created.statusCode} ${created.body}`)
    const profileId = jsonBody(created).id
    assertNoSecrets(jsonBody(created), payload.token)

    const db = openDb(t, sqlitePath)
    const row = db.$client
      .prepare(
        'SELECT typeof(token_encrypted) AS token_type, token_encrypted, scopes_checked, created_by FROM credential_profiles WHERE id = ?',
      )
      .get(profileId)
    assert.ok(row, `credential_profiles row ${profileId} missing`)
    assert.equal(row.token_type, 'text')
    assert.equal(typeof row.token_encrypted, 'string')
    assert.equal(
      String(row.token_encrypted).includes(payload.token),
      false,
      `token_encrypted contained plaintext: ${row.token_encrypted}`,
    )
    assert.equal(row.created_by, gitlab.body.id)

    const createdEvents = eventRows(db).filter((event) => {
      const details = parseDetails(event)
      return event.type === '变更' && details?.action === 'create' && Number(details.profile_id) === Number(profileId)
    })
    assert.equal(createdEvents.length, 1, `expected one create 变更, got ${JSON.stringify(eventRows(db))}`)
    assert.equal(Number(createdEvents[0].actor_user_id), Number(gitlab.body.id))
    assertUnixSeconds(createdEvents[0].created_at)
  })

  test('DELETE writes 变更 action delete', async (t) => {
    const sqlitePath = sqliteFile(t)
    const app = await createApp(t, sqlitePath)
    const profiles = beginUserinfo(t)
    const gitlab = await loginGitlab(app, profiles, 'sqlite-delete')
    const payload = profilePayload({ repo_full_name: 'acme/encrypted-delete' })

    const created = await postProfile(app, gitlab.cookies, payload)
    assert.equal(created.statusCode, 201, `POST: ${created.statusCode} ${created.body}`)
    const profileId = jsonBody(created).id

    const deleted = await deleteProfile(app, gitlab.cookies, profileId)
    assert.equal(deleted.statusCode, 200, `DELETE: ${deleted.statusCode} ${deleted.body}`)
    assert.equal(jsonBody(deleted)?.message, FORGE_REVOKE_MESSAGE)

    const db = openDb(t, sqlitePath)
    const deleteEvents = eventRows(db).filter((event) => {
      const details = parseDetails(event)
      return event.type === '变更' && details?.action === 'delete' && Number(details.profile_id) === Number(profileId)
    })
    assert.equal(deleteEvents.length, 1, `expected one delete 变更, got ${JSON.stringify(eventRows(db))}`)
    assert.equal(Number(deleteEvents[0].actor_user_id), Number(gitlab.body.id))
    assertUnixSeconds(deleteEvents[0].created_at)
  })
})

describe('vault_unconfigured', () => {
  test('HTTP POST without VAULT_MASTER_KEY returns 500 vault_unconfigured', async (t) => {
    const previous = process.env.VAULT_MASTER_KEY
    t.after(() => {
      process.env.VAULT_MASTER_KEY = previous
    })
    delete process.env.VAULT_MASTER_KEY

    const app = await createApp(t)
    const profiles = beginUserinfo(t)
    const gitlab = await loginGitlab(app, profiles, 'unconfigured')
    const created = await postProfile(app, gitlab.cookies, profilePayload({ repo_full_name: 'acme/no-master-key' }))
    assert.equal(created.statusCode, 500, `POST: ${created.statusCode} ${created.body}`)
    assert.equal(jsonBody(created)?.error, 'vault_unconfigured')
  })
})

describe('encryptToken / decryptToken (dynamic import ./vault.ts)', () => {
  test('round-trips a one-off token string and ciphertext omits plaintext', async () => {
    const vault = await import('./vault.ts')
    assert.equal(typeof vault.encryptToken, 'function')
    assert.equal(typeof vault.decryptToken, 'function')
    const cipher = vault.encryptToken(ONE_OFF_TOKEN)
    const encoded = blobText(await cipher)
    assert.equal(encoded.includes(ONE_OFF_TOKEN), false, `ciphertext contained plaintext: ${encoded}`)
    const plain = await vault.decryptToken(await cipher)
    assert.equal(plain, ONE_OFF_TOKEN)
  })

  test('encryptToken throws when VAULT_MASTER_KEY is missing', async (t) => {
    const previous = process.env.VAULT_MASTER_KEY
    t.after(() => {
      if (previous == null) delete process.env.VAULT_MASTER_KEY
      else process.env.VAULT_MASTER_KEY = previous
    })
    delete process.env.VAULT_MASTER_KEY
    const vault = await import('./vault.ts')
    await assert.rejects(async () => {
      await vault.encryptToken(ONE_OFF_TOKEN)
    })
  })
})

describe('revealCredentialProfile (dynamic import ./vault.ts)', () => {
  test('returns plaintext, writes token 揭示 audit, and throws after DELETE', async (t) => {
    const sqlitePath = sqliteFile(t)
    const app = await createApp(t, sqlitePath)
    const profiles = beginUserinfo(t)
    const gitlab = await loginGitlab(app, profiles, 'reveal')
    const payload = profilePayload({ repo_full_name: 'acme/reveal-me' })

    let agentKeyId = 1
    const keyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-keys',
      cookies: gitlab.cookies,
      headers: jsonHeaders,
      payload: { label: 'vault-reveal' },
    })
    if (keyRes.statusCode === 201) {
      const keyBody = jsonBody(keyRes)
      assert.ok(Number.isInteger(Number(keyBody?.id)) && Number(keyBody.id) > 0, `agent key id: ${keyRes.body}`)
      agentKeyId = Number(keyBody.id)
    }

    const created = await postProfile(app, gitlab.cookies, payload)
    assert.equal(created.statusCode, 201, `POST: ${created.statusCode} ${created.body}`)
    const profileId = jsonBody(created).id

    const vault = await import('./vault.ts')
    assert.equal(typeof vault.revealCredentialProfile, 'function')
    const db = openDb(t, sqlitePath)
    const revealed = await vault.revealCredentialProfile(db, {
      profileId,
      actorUserId: gitlab.body.id,
      agentKeyId,
    })
    assert.equal(revealed, payload.token)

    const revealEvents = eventRows(db).filter((event) => event.type === 'token 揭示')
    assert.equal(revealEvents.length, 1, `expected one token 揭示, got ${JSON.stringify(eventRows(db))}`)
    const revealEvent = revealEvents[0]
    assert.equal(Number(revealEvent.actor_user_id), Number(gitlab.body.id))
    assertUnixSeconds(revealEvent.created_at)
    const details = parseDetails(revealEvent)
    assert.equal(Number(details.agent_key_id), Number(agentKeyId))
    assert.equal(Number(details.profile_id), Number(profileId))
    const dumped = JSON.stringify(revealEvent)
    assert.equal(dumped.includes(payload.token), false, `reveal event leaked plaintext: ${dumped}`)

    const deleted = await deleteProfile(app, gitlab.cookies, profileId)
    assert.equal(deleted.statusCode, 200, `DELETE: ${deleted.statusCode} ${deleted.body}`)
    assert.equal(jsonBody(deleted)?.message, FORGE_REVOKE_MESSAGE)

    await assert.rejects(async () => {
      await vault.revealCredentialProfile(db, {
        profileId,
        actorUserId: gitlab.body.id,
        agentKeyId,
      })
    })
  })
})
})
