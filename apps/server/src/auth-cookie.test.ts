import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

// Isolated from auth.test.ts: that file sets PUBLIC_URL=http://localhost:3000
// then import('./app.ts') once. HTTPS cookie flags need a separate module load.
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const HTTPS_PUBLIC_URL = 'https://tasks.example.test'
const SESSION_COOKIE = 'sessionId'
const OAUTH_STATE_COOKIE = 'oauth2-redirect-state'

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
  process.env.PUBLIC_URL = HTTPS_PUBLIC_URL
}

applyOauthTestEnv()

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
      return new Response(JSON.stringify({ error: 'unstubbed userinfo' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
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

async function loginCallbackBehindProxy(app, { remoteAddress = '127.0.0.1' } = {}) {
  stubTokenExchange(app, 'githubOAuth2', 'test-access-token-https-cookie')
  return app.inject({
    method: 'GET',
    url: '/login/github/callback?code=test-authorization-code',
    remoteAddress,
    headers: { 'x-forwarded-proto': 'https' },
  })
}

describe('HTTPS PUBLIC_URL cookie Secure', { concurrency: false }, () => {
  test('GET /login/github OAuth state Set-Cookie includes Secure when PUBLIC_URL is https', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: '/login/github' })
    assert.equal(res.statusCode, 302, `GET /login/github: ${res.statusCode}`)
    assertSetCookieHasSecure(res, OAUTH_STATE_COOKIE)
  })

  test('login callback session Set-Cookie includes Secure behind X-Forwarded-Proto https (loopback peer)', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    profiles.set('test-access-token-https-cookie', { id: 4242, login: 'octo-cat', name: 'Octo Cat' })

    const callback = await loginCallbackBehindProxy(app, { remoteAddress: '127.0.0.1' })
    assert.ok(
      callback.statusCode >= 200 && callback.statusCode < 400,
      `expected callback to complete login, got ${callback.statusCode}: ${callback.body}`,
    )
    assertSetCookieHasSecure(callback, SESSION_COOKIE)
  })

  test('login callback session Set-Cookie includes Secure behind X-Forwarded-Proto https (docker-bridge peer)', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    profiles.set('test-access-token-https-cookie', { id: 4242, login: 'octo-cat', name: 'Octo Cat' })

    const callback = await loginCallbackBehindProxy(app, { remoteAddress: '172.18.0.1' })
    assert.ok(
      callback.statusCode >= 200 && callback.statusCode < 400,
      `expected callback to complete login, got ${callback.statusCode}: ${callback.body}`,
    )
    assertSetCookieHasSecure(callback, SESSION_COOKIE)
  })

  test('untrusted public peer cannot mint a Secure session cookie via spoofed X-Forwarded-Proto', async (t) => {
    const app = await createApp(t)
    const profiles = new Map()
    stubUserinfoByAccessToken(t, profiles)
    profiles.set('test-access-token-https-cookie', { id: 4242, login: 'octo-cat', name: 'Octo Cat' })

    const callback = await loginCallbackBehindProxy(app, { remoteAddress: '203.0.113.10' })
    const session = callback.cookies.find((cookie) => cookie.name === SESSION_COOKIE)
    assert.equal(
      session,
      undefined,
      'trustProxy must not be true: a direct public peer spoofing X-Forwarded-Proto must not receive sessionId',
    )
  })
})
