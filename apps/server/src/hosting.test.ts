import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Issue #17 — single-port 31415 hosting.
// Seam: buildApp({ sqlitePath?, webDist?: string, viteDevTarget?: string }).
// Inject only. Do not import('./index.ts') (it listens).
// This file fixtures PUBLIC_URL to :3000 like the other HTTP suites; the 31415
// default is pinned by reading auth.ts / index.ts source.

const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'
const PLACEHOLDER_BODY = '考拉任务服务占位'
const SPA_MARKER = 'kaola-hosting-spa-marker'
const INDEX_HTML = `<!doctype html>
<html>
  <head><title>${SPA_MARKER}</title></head>
  <body><div id="app">hosted-spa-from-webDist</div></body>
</html>
`
const ASSET_JS = 'window.__KAOLA_HOSTING_ASSET__=1;\n'
const VITE_DEV_TARGET = 'http://127.0.0.1:5173'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

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

function readRepoFile(relPath) {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}

function contentType(res) {
  const value = res.headers['content-type']
  return Array.isArray(value) ? value.join(';') : String(value ?? '')
}

async function createApp(t, options) {
  const app = buildApp(options)
  t.after(async () => {
    await app.close()
  })
  await app.ready()
  return app
}

function makeWebDist(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-webdist-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(join(dir, 'index.html'), INDEX_HTML)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app.js'), ASSET_JS)
  return dir
}

describe('issue #17 single-port 31415 hosting', { concurrency: false }, () => {
  test('omitted hosting options keep GET / as 考拉任务服务占位 with text/plain; webDist serves index.html at /', async (t) => {
    const omittedCases = [
      undefined,
      {},
      { sqlitePath: ':memory:' },
      { webDist: '' },
      { viteDevTarget: '' },
    ]
    for (const options of omittedCases) {
      const app = await createApp(t, options)
      const res = await app.inject({ method: 'GET', url: '/' })
      assert.equal(res.statusCode, 200, `omitted hosting GET /: ${res.statusCode} ${res.body}`)
      assert.equal(res.body, PLACEHOLDER_BODY)
      assert.match(contentType(res), /text\/plain/)
    }

    const webDist = makeWebDist(t)
    const app = await createApp(t, { webDist })
    const res = await app.inject({ method: 'GET', url: '/' })
    assert.equal(res.statusCode, 200, `webDist GET /: ${res.statusCode} ${res.body}`)
    assert.equal(res.body, INDEX_HTML)
    assert.match(contentType(res), /text\/html/)
    assert.notEqual(res.body, PLACEHOLDER_BODY)
    assert.match(res.body, new RegExp(SPA_MARKER))
  })

  test('webDist SPA-fallbacks unmatched GET, serves assets, and does not swallow /api or /login', async (t) => {
    const webDist = makeWebDist(t)
    const app = await createApp(t, { webDist })

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' })
    assert.equal(asset.statusCode, 200, `GET /assets/app.js: ${asset.statusCode} ${asset.body}`)
    assert.equal(asset.body, ASSET_JS)
    assert.notEqual(asset.body, INDEX_HTML)

    const deep = await app.inject({ method: 'GET', url: '/some/deep/path' })
    assert.equal(deep.statusCode, 200, `GET /some/deep/path: ${deep.statusCode} ${deep.body}`)
    assert.equal(deep.body, INDEX_HTML)
    assert.match(contentType(deep), /text\/html/)

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { accept: 'application/json' },
    })
    assert.equal(me.statusCode, 401, `GET /api/v1/me: ${me.statusCode} ${me.body}`)
    assert.match(contentType(me), /json/)
    assert.equal(me.json().error, 'unauthorized')
    assert.notEqual(me.body, INDEX_HTML)
    assert.doesNotMatch(me.body, new RegExp(SPA_MARKER))

    const login = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(login.statusCode, 200, `GET /login: ${login.statusCode} ${login.body}`)
    assert.match(login.body, /考拉任务登录/)
    assert.notEqual(login.body, INDEX_HTML)
    assert.doesNotMatch(login.body, new RegExp(SPA_MARKER))

    const start = await app.inject({ method: 'GET', url: '/login/github' })
    assert.equal(start.statusCode, 302, `GET /login/github: ${start.statusCode}`)
    assert.match(String(start.headers.location), /https:\/\/github\.com\/login\/oauth\/authorize/)
  })

  test('when webDist and viteDevTarget are both set, webDist wins', async (t) => {
    const webDist = makeWebDist(t)
    const app = await createApp(t, { webDist, viteDevTarget: VITE_DEV_TARGET })
    const res = await app.inject({ method: 'GET', url: '/' })
    assert.equal(res.statusCode, 200, `GET / both set: ${res.statusCode} ${res.body}`)
    assert.equal(res.body, INDEX_HTML)
    assert.match(contentType(res), /text\/html/)
    assert.notEqual(res.body, PLACEHOLDER_BODY)
  })

  test('index.ts PORT default is 31415 (source pin; does not import index.ts)', () => {
    const src = readRepoFile('apps/server/src/index.ts')
    const defaults = [...src.matchAll(/process\.env\.PORT\s*\?\?\s*'[^']+'/g)].map((m) => m[0])
    assert.deepEqual(defaults, ["process.env.PORT ?? '31415'"])
  })

  test('auth.ts PUBLIC_URL default is http://localhost:31415 (source pin)', () => {
    const src = readRepoFile('apps/server/src/auth.ts')
    const defaults = [...src.matchAll(/process\.env\.PUBLIC_URL\s*\?\?\s*'[^']+'/g)].map((m) => m[0])
    assert.deepEqual(defaults, ["process.env.PUBLIC_URL ?? 'http://localhost:31415'"])
  })

  test('vite.config.ts proxies /api and /login to http://127.0.0.1:31415', () => {
    const src = readRepoFile('apps/web/vite.config.ts')
    assert.match(src, /['"]\/api['"]:\s*['"]http:\/\/127\.0\.0\.1:31415['"]/)
    assert.match(src, /['"]\/login['"]:\s*['"]http:\/\/127\.0\.0\.1:31415['"]/)
    assert.doesNotMatch(src, /127\.0\.0\.1:3000/)
  })

  test('docker-compose maps 31415:31415 and sets PORT 31415', () => {
    const src = readRepoFile('docker-compose.yml')
    assert.match(src, /['"]31415:31415['"]/)
    assert.match(src, /PORT:\s*["']31415["']/)
    assert.doesNotMatch(src, /['"]3000:3000['"]/)
    assert.doesNotMatch(src, /PORT:\s*["']3000["']/)
  })

  test('Dockerfile EXPOSE 31415, ENV PORT=31415, and image build includes web dist', () => {
    const dockerfile = readRepoFile('apps/server/Dockerfile')
    const compose = readRepoFile('docker-compose.yml')
    assert.match(dockerfile, /EXPOSE\s+31415/)
    assert.match(dockerfile, /ENV PORT=31415/)
    assert.doesNotMatch(dockerfile, /EXPOSE\s+3000\b/)
    const dockerSources = `${dockerfile}\n${compose}`
    assert.ok(
      /pnpm --filter @kaola\/web (?:run )?build/.test(dockerSources) ||
        /(?:^|\s)vite build(?:\s|$)/m.test(dockerfile),
      'Dockerfile or compose must build the web dist (pnpm --filter @kaola/web build or equivalent)',
    )
  })

  test('root package.json has a non-empty dev script', () => {
    const pkg = JSON.parse(readRepoFile('package.json'))
    assert.equal(typeof pkg.scripts.dev, 'string')
    assert.ok(pkg.scripts.dev.length > 0, 'scripts.dev must be a non-empty string')
  })
})
