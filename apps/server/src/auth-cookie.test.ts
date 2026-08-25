import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETUP,
  PROVIDERS,
  applyOauthTestEnv,
  ensureSetup,
  postSetup,
  stubTokenExchange,
  stubUserinfoByAccessToken,
} from './auth.test-helpers.ts'

const HTTPS_PUBLIC_URL = 'https://tasks.example.test'
const SESSION_COOKIE = 'sessionId'
const OAUTH_STATE_COOKIE = 'oauth2-redirect-state'

applyOauthTestEnv({ PUBLIC_URL: HTTPS_PUBLIC_URL })

const { buildApp } = await import('./app.ts')

function setCookieHeaders(response) {
  const raw = response.headers['set-cookie']
  if (raw == null) return []
  return Array.isArray(raw) ? raw.map(String) : [String(raw)]
}

function setCookieNamed(response, name) {
  const hit = setCookieHeaders(response).find((header) => header.startsWith(`${name}=`))
  assert.ok(
    hit,
    `missing Set-Cookie for ${name}: ${setCookieHeaders(response).join(' | ') || '(none)'}`,
  )
  return hit
}

function parsedCookie(response, name) {
  const hit = response.cookies.find((cookie) => cookie.name === name)
  assert.ok(hit, `inject cookies missing ${name}: ${response.cookies.map((c) => c.name).join(', ')}`)
  return hit
}

function assertSetCookieHasSecure(response, name) {
  const parsed = parsedCookie(response, name)
  assert.equal(parsed.secure, true, `${name} cookie.secure must be true`)
  assert.match(setCookieNamed(response, name), /(?:^|;)\s*Secure(?:;|$)/i)
}

async function createApp(t) {
  const app = buildApp()
  t.after(async () => {
    await app.close()
  })
  await app.ready()
  return app
}

async function gitlabCallbackBehindProxy(app, { remoteAddress = '127.0.0.1' } = {}) {
  stubTokenExchange(app, PROVIDERS.gitlab.decoratorName, 'test-access-token-https-cookie')
  return app.inject({
    method: 'GET',
    url: `${PROVIDERS.gitlab.callbackPath}?code=test-authorization-code`,
    remoteAddress,
    headers: { 'x-forwarded-proto': 'https' },
  })
}

describe('HTTPS PUBLIC_URL cookie Secure', { concurrency: false }, () => {
  test('POST /api/v1/setup session Set-Cookie includes Secure when PUBLIC_URL is https', async (t) => {
    const app = await createApp(t)
    const res = await postSetup(app, DEFAULT_SETUP)
    assert.equal(res.statusCode, 201, `POST /api/v1/setup: ${res.statusCode} ${res.body}`)
    assertSetCookieHasSecure(res, SESSION_COOKIE)
  })

  test('GET /login/gitlab OAuth state Set-Cookie includes Secure when PUBLIC_URL is https', async (t) => {
    const app = await createApp(t)
    await ensureSetup(app)
    const res = await app.inject({ method: 'GET', url: PROVIDERS.gitlab.startPath })
    assert.equal(res.statusCode, 302, `GET /login/gitlab: ${res.statusCode}`)
    assertSetCookieHasSecure(res, OAUTH_STATE_COOKIE)
  })

  test('login callback session Set-Cookie includes Secure behind X-Forwarded-Proto https (loopback peer)', async (t) => {
    const app = await createApp(t)
    await ensureSetup(app)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    profiles.set('test-access-token-https-cookie', { id: 4242, username: 'octo-cat', name: 'Octo Cat' })

    const callback = await gitlabCallbackBehindProxy(app, { remoteAddress: '127.0.0.1' })
    assert.ok(
      callback.statusCode >= 200 && callback.statusCode < 400,
      `expected callback to complete login, got ${callback.statusCode}: ${callback.body}`,
    )
    assertSetCookieHasSecure(callback, SESSION_COOKIE)
  })

  test('login callback session Set-Cookie includes Secure behind X-Forwarded-Proto https (docker-bridge peer)', async (t) => {
    const app = await createApp(t)
    await ensureSetup(app)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    profiles.set('test-access-token-https-cookie', { id: 4242, username: 'octo-cat', name: 'Octo Cat' })

    const callback = await gitlabCallbackBehindProxy(app, { remoteAddress: '172.18.0.1' })
    assert.ok(
      callback.statusCode >= 200 && callback.statusCode < 400,
      `expected callback to complete login, got ${callback.statusCode}: ${callback.body}`,
    )
    assertSetCookieHasSecure(callback, SESSION_COOKIE)
  })

  test('untrusted public peer cannot mint a Secure session cookie via spoofed X-Forwarded-Proto', async (t) => {
    const app = await createApp(t)
    await ensureSetup(app)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    profiles.set('test-access-token-https-cookie', { id: 4242, username: 'octo-cat', name: 'Octo Cat' })

    const callback = await gitlabCallbackBehindProxy(app, { remoteAddress: '203.0.113.10' })
    const session = callback.cookies.find((cookie) => cookie.name === SESSION_COOKIE)
    assert.equal(
      session,
      undefined,
      'trustProxy must not be true: a direct public peer spoofing X-Forwarded-Proto must not receive sessionId',
    )
  })
})
