# Ground truth: Kaola Tasks issue #17 (single-port 31415 hosting)

Measured from worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17` on 2026-08-21. Product files were not modified. This file is the only write.

Issue: https://github.com/KaolaBrother/KaolaTasks/issues/17 — title `M1: 单端口 31415 托管 SPA + API（开发反代 / 生产静态）`. Body is the work. Comments: one workflow note only (`Kaola-Workflow started local work for bundle-8-17`); no product comments that override the body.

**Verdict in one line:** this tree is still two public origins (Vite `:5173` by library default + Fastify `:3000`). Fastify `GET /` is an exact placeholder route. There is no `@fastify/static`, no HTTP proxy plugin, no root `pnpm dev`, no web `dist` in the worktree, and Docker still maps `3000:3000` without building the SPA.

---

## Entry Points

| Entry | Path | What it does |
| --- | --- | --- |
| Process listen | `apps/server/src/index.ts` | `buildApp({ sqlitePath })` then `app.listen({ port, host })`. Only production/dev process entry. Tests never import this file. |
| App factory | `apps/server/src/app.ts` `buildApp` | Creates Fastify + SQLite, registers `GET /` placeholder, then `registerAuth` / `registerAgentKeys` / `registerCredentialProfiles` / `registerTasks`. |
| Placeholder body | `apps/server/src/placeholder.ts` `getPlaceholderBody()` | Returns the literal string `考拉任务服务占位`. |
| OAuth / session | `apps/server/src/auth.ts` `registerAuth` | Required env, cookie/session/oauth2 plugins, `/login*`, `/api/v1/me`, approve. Builds **absolute** `callbackUri` from `PUBLIC_URL`. Post-login `reply.redirect('/')`. |
| Vite SPA | `apps/web/vite.config.ts` + `apps/web/src/main.ts` | Vue plugin; **no `server.port`**. Dev proxy `/api` and `/login` → `http://127.0.0.1:3000`. Mounts `App.vue` (no vue-router). |
| Docker | `docker-compose.yml` + `apps/server/Dockerfile` | Service `server`, `3000:3000`, `CMD pnpm --filter @kaola/server start`. |
| Tests | listed under Q2 / Q7 | `buildApp()` + `inject`; `placeholder.test.ts` does not boot Fastify. |

Nobody imports `index.ts` except the `start`/`dev` scripts. Hosting attached only in `index.ts` is invisible to today’s inject suite; hosting attached inside `buildApp()` is visible to every suite that calls `buildApp()`.

---

## Execution Flow

### Process boot (`pnpm --filter @kaola/server start` / `dev`)

1. `apps/server/package.json` scripts: `"start": "node --experimental-strip-types src/index.ts"`, `"dev": "node --watch --experimental-strip-types src/index.ts"`.
2. `index.ts` (full file, 7 lines):

```1:7:apps/server/src/index.ts
import { buildApp } from './app.ts'

const app = buildApp({ sqlitePath: process.env.SQLITE_PATH ?? ':memory:' })
const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const host = process.env.HOST ?? '0.0.0.0'

await app.listen({ port, host })
```

3. `buildApp` **always** calls `registerAuth` (and the other registers). Missing OAuth/session env throws at construction, before listen. Docker compose currently does not inject those vars (pre-existing).
4. `GET /` is registered **before** auth/API plugins, as an exact route.

### HTTP `GET /` today

```9:22:apps/server/src/app.ts
export function buildApp(options?: { sqlitePath?: string }) {
  const db = createDb(options?.sqlitePath ?? ':memory:')
  const app = Fastify()
  app.addHook('onClose', () => {
    db.$client.close()
  })
  app.get('/', async (_request, reply) => {
    return reply.type('text/plain; charset=utf-8').send(getPlaceholderBody())
  })
  registerAuth(app, db)
  registerAgentKeys(app, db)
  registerCredentialProfiles(app, db)
  registerTasks(app, db)
  return app
}
```

`buildApp` is **synchronous**. Tests `await app.ready()` themselves. There is no `webDist`, no `viteProxy`, no `existsSync`.

### Dev browser path today (inverted vs issue #17)

```
browser  →  Vite (library default port 5173; host default localhost)
              proxy /api  →  http://127.0.0.1:3000
              proxy /login →  http://127.0.0.1:3000
         or  Fastify :3000 directly (placeholder at GET /, OAuth HTML at GET /login)
```

`apps/web/src/App.vue` uses **relative** URLs (`fetch('/api/v1/me', …)`, `<a href="/login/github">`). Same-origin after #17; today they only work on the Vite origin because of the Vite→Fastify proxy.

### OAuth round trip today

1. `GET /login/{github|gitlab|gitea}` (`@fastify/oauth2` `startRedirectPath`).
2. Authorize URL `redirect_uri` = `${PUBLIC_URL}/login/{provider}/callback` (absolute; default origin `http://localhost:3000`).
3. Callback handler → `completeOAuthLogin` → `reply.redirect('/')` (relative Location).
4. Browser resolves `/` against the **callback request origin**, which is `PUBLIC_URL`. That origin is Fastify, so the user lands on the placeholder body, not the SPA.

### Target flow (issue body; not implemented)

```
browser ──► Fastify :31415
              ├─ /api/*  and /login*  → existing routes
              ├─ production: apps/web dist (@fastify/static + SPA fallback)
              └─ development: other GET/WS proxied to internal Vite; Vite is not the public origin
```

---

## Architecture Insights

1. **Exact `GET /` wins.** Adding `@fastify/static` or a proxy *after* the existing `app.get('/')` will **not** serve `index.html` at `/`. SPA fallback via `setNotFoundHandler` also will **not** run for `/`, because `/` is already matched. Production/dev hosting **must gate or replace** that route. Unmatched paths such as `/foo` currently 404 (no catch-all). There is no vue-router; the SPA is a single page at `/`, but the issue still asks for deep-link fallback.

2. **Naked `buildApp()` must stay placeholder.** `vault.test.ts` and `agent-keys.test.ts` inject `GET /` on a default `buildApp()`. If `buildApp` auto-`existsSync`s `../web/dist` (or any default path), a prior `pnpm --filter @kaola/web build` (or a dirty Docker context) would turn those tests red. `.gitignore` lists `dist/`; this worktree has **no** `apps/web/dist`. CI (`.github/workflows/ci.yml`) runs `pnpm test` and does **not** run `pnpm build`.

3. **Proxy direction must invert.** Today Vite is the public origin and proxies `/api`+`/login` to Fastify. Issue #17 makes Fastify public and proxies the remainder (GET/WS, including Vite HMR) to an internal Vite. The issue also keeps a **legacy** Vite-direct path: if someone still opens `:5173`, `vite.config.ts` proxy target becomes `127.0.0.1:31415`.

4. **HMR needs WebSocket on the public origin.** Vite 7 docs (`server.ws`): reverse proxies in front of Vite are expected to proxy WebSocket; otherwise the client falls back to a direct Vite connection (which would expose the internal port). Neither `@fastify/http-proxy` nor `@fastify/websocket` is in this tree.

5. **`PUBLIC_URL` is not in `index.ts`.** Listen port (`PORT`) and OAuth callback origin (`PUBLIC_URL`) are independent defaults, both currently `3000`. Changing only `PORT` would desync callbacks unless `PUBLIC_URL` changes too. Issue acceptance: both leave `3000`.

6. **pnpm script cwd.** Dockerfile `WORKDIR /app` (monorepo root) then `CMD ["pnpm", "--filter", "@kaola/server", "start"]`. pnpm runs that script in the **package directory** (`apps/server`). A relative web dist from the running process is `../web/dist` (image absolute `/app/apps/web/dist`). Do not invent a third path.

7. **No `scope` in `registerAuth`.** `apps/server/src/auth.ts` has zero matches for `scope`. Issue body: do **not** fix `scope=undefined` as a side effect.

8. **RFC1918 is intentionally allowed.** `isHttpOrHttpsUrlWithHost` (`tasks.ts:147-156`) only requires `http:`/`https:` and non-empty `hostname`. Loopback / RFC1918 are legal. Issue body: do **not** block them.

---

## Q1. `PORT` / `PUBLIC_URL` defaults, and tests that mention `3000`

### `index.ts` — PORT yes, PUBLIC_URL absent

```3:5:apps/server/src/index.ts
const app = buildApp({ sqlitePath: process.env.SQLITE_PATH ?? ':memory:' })
const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const host = process.env.HOST ?? '0.0.0.0'
```

- `PORT` default: string `'3000'` then `Number.parseInt(..., 10)`.
- `PUBLIC_URL`: **not read** in this file.
- `HOST` default: `'0.0.0.0'`.
- `SQLITE_PATH` default: `':memory:'`.

### `auth.ts` — PUBLIC_URL yes, PORT absent

```241:251:apps/server/src/auth.ts
export function registerAuth(app: FastifyInstance, db: AppDb) {
  const sessionSecret = requireEnv('SESSION_SECRET')
  const publicUrl = trimTrailingSlash(process.env.PUBLIC_URL ?? 'http://localhost:3000')
  const githubClientId = requireEnv('OAUTH_GITHUB_CLIENT_ID')
  const githubClientSecret = requireEnv('OAUTH_GITHUB_CLIENT_SECRET')
  const gitlabClientId = requireEnv('OAUTH_GITLAB_CLIENT_ID')
  const gitlabClientSecret = requireEnv('OAUTH_GITLAB_CLIENT_SECRET')
  const gitlabBaseUrl = trimTrailingSlash(requireEnv('OAUTH_GITLAB_BASE_URL'))
  const giteaClientId = requireEnv('OAUTH_GITEA_CLIENT_ID')
  const giteaClientSecret = requireEnv('OAUTH_GITEA_CLIENT_SECRET')
  const giteaBaseUrl = trimTrailingSlash(requireEnv('OAUTH_GITEA_BASE_URL'))
```

`trimTrailingSlash` (`auth.ts:49-51`): `url.replace(/\/+$/, '')`.

`PUBLIC_URL` is then used only to build **absolute** callback URIs:

```268:300:apps/server/src/auth.ts
    startRedirectPath: '/login/github',
    callbackUri: `${publicUrl}/login/github/callback`,
    cookie: oauthCookie,
  })
  // ...
    startRedirectPath: '/login/gitlab',
    callbackUri: `${publicUrl}/login/gitlab/callback`,
  // ...
    startRedirectPath: '/login/gitea',
    callbackUri: `${publicUrl}/login/gitea/callback`,
```

### Tests that mention `http://localhost:3000`

**No test asserts `PORT === 3000` or `listen`s on 3000.** No `assert.*` contains `3000`.

Four files **assign** the fixture (so OAuth `callbackUri` is that origin while those files run). Changing the **code default** to `http://localhost:31415` does **not** fail these files unless the fixture is also changed:

| File | Line | Quote |
| --- | --- | --- |
| `apps/server/src/auth.test.ts` | 20 | `process.env.PUBLIC_URL = 'http://localhost:3000'` |
| `apps/server/src/agent-keys.test.ts` | 28 | `process.env.PUBLIC_URL = 'http://localhost:3000'` |
| `apps/server/src/vault.test.ts` | 26 | `process.env.PUBLIC_URL = 'http://localhost:3000'` |
| `apps/server/src/tasks.test.ts` | 74 | `process.env.PUBLIC_URL = 'http://localhost:3000'` |

OAuth start tests in `auth.test.ts` only match the **forge authorize host**, not the `redirect_uri` query (so they do not pin `:3000` in Location):

- `auth.test.ts:188` `assert.match(String(res.headers.location), /https:\/\/github\.com\/login\/oauth\/authorize/)`
- `auth.test.ts:195` `assert.match(..., /https:\/\/gitlab\.example\.test\/oauth\/authorize/)`
- `auth.test.ts:202` `assert.match(..., /https:\/\/gitea\.example\.test\/login\/oauth\/authorize/)`

`placeholder.test.ts` never sets `PUBLIC_URL` or `PORT`.

---

## Q2. Exact `GET /` handler, content-type, placeholder pins, boot style

**Handler** (`app.ts:15-17`):

```javascript
app.get('/', async (_request, reply) => {
  return reply.type('text/plain; charset=utf-8').send(getPlaceholderBody())
})
```

**Body helper** (`placeholder.ts:1-3`):

```javascript
export function getPlaceholderBody(): string {
  return '考拉任务服务占位'
}
```

**Content-Type:** `text/plain; charset=utf-8` (set on the reply; **no test asserts this header**).

### Files that pin the placeholder string

| File | How the app boots | Assertions |
| --- | --- | --- |
| `apps/server/src/placeholder.test.ts` | **Does not boot Fastify.** Direct import of `getPlaceholderBody`. No `inject`, no `listen`. | `assert.equal(body, '考拉任务服务占位')` (line 13). Also `typeof function`, `typeof string`, `body.length > 0`. Comment lines 5–6: handler must call `getPlaceholderBody()` and not duplicate the string. |
| `apps/server/src/vault.test.ts` | `applyOauthTestEnv()` then dynamic `import('./app.ts')`. `createApp`: `buildApp(sqlitePath ? { sqlitePath } : undefined)` → `t.after(app.close)` → `await app.ready()`. **`app.inject`.** Outer describe `{ concurrency: false }`. | `test('GET / still returns 考拉任务服务占位'` at 308–312: `inject({ method: 'GET', url: '/' })`; `assert.equal(res.statusCode, 200)`; `assert.equal(res.body, '考拉任务服务占位')`. Does **not** assert content-type. |
| `apps/server/src/agent-keys.test.ts` | Same inject pattern. `createApp(t, options)` → `buildApp(options)`. Deletes `VAULT_MASTER_KEY`. **No** file-level `concurrency: false`. | `test('GitLab full+active can generate keys without VAULT_MASTER_KEY; GET / stays 考拉任务服务占位'` at 489–541: `root.body` and later `stillRoot.body` both `assert.equal(..., '考拉任务服务占位')`; `root.statusCode === 200`. |

**Not pinned:** `auth.test.ts`, `tasks.test.ts` never `GET /`.

**No test file calls `app.listen`.** The only `listen` in `apps/server` is `index.ts:7`.

---

## Q3. `completeOAuthLogin` redirect vs `PUBLIC_URL`

**Post-login site** (`auth.ts:209-238`):

```209:238:apps/server/src/auth.ts
async function completeOAuthLogin(
  app: FastifyInstance,
  db: AppDb,
  provider: UserProvider,
  gitlabBaseUrl: string,
  giteaBaseUrl: string,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { token } = await oauthOf(app, provider).getAccessTokenFromAuthorizationCodeFlow(request)
  // ... userinfo fetch, upsertUser, session.userId, session.save() ...
  return reply.redirect('/')
}
```

Callbacks (`auth.ts:307-314`) all call `completeOAuthLogin`. There is no other post-login redirect.

**Callback URLs:** absolute, concatenated from `PUBLIC_URL` (see Q1). `PUBLIC_URL` is **not** passed to `reply.redirect`.

**Post-login redirect:** relative `'/'`. Same Fastify `reply.redirect` style as unauthenticated browser routes, which inject tests pin as a **relative** Location:

- `tasks.test.ts:613` `assert.equal(res.headers.location, '/login')` for `reply.redirect('/login')` (`auth.ts:66`, `auth.ts:323`).
- `auth.test.ts:215` `assert.match(String(res.headers.location), /\/login(?:\?|$)/)`.
- `agent-keys.test.ts:197-199` `assertLoginRedirect` uses the same relative `/login` pattern.

Therefore `reply.redirect('/')` yields **`Location: /`**, not `Location: http://localhost:3000/`. A browser then resolves `/` against the **current request URL** (the OAuth callback). That URL’s origin is `PUBLIC_URL` because that is what was registered as `callbackUri`. README’s phrasing “相对 `PUBLIC_URL`” describes browser resolution, not Fastify concatenating `PUBLIC_URL + '/'`.

`loginViaCallback` (`auth.test.ts:135-154`) only asserts callback status in `[200, 400)` and then `GET /api/v1/me` 200. It does **not** pin `callback.headers.location === '/'`. Inject does not follow redirects.

Other relative redirects (do not change as a side effect): `sendUnauthorized` → `reply.redirect('/login')` (`auth.ts:62-66`); unauthenticated HTML `GET /api/v1/me` → `reply.redirect('/login')` (`auth.ts:323`).

---

## Q4. Vite config and package.json scripts

### `apps/web/vite.config.ts` (entire file, 16 lines)

```1:16:apps/web/vite.config.ts
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/login': 'http://127.0.0.1:3000',
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
```

Measured absences: no `server.port`, no `server.host`, no `server.strictPort`, no `server.ws` / `server.hmr`, no `base`, no `build.outDir` (Vite default `dist` relative to `apps/web`), no path alias, no `import.meta.env` / `VITE_*` in `apps/web/src`.

Vite 7 docs (`https://vite.dev/config/server-options.html`): `server.port` default **`5173`** (if taken, Vite tries the next port); `server.host` default **`'localhost'`**. Product source under `apps/` contains **zero** occurrences of `5173`. Lockfile: `vite@7.3.6`.

### `apps/web/package.json` scripts

```json
"dev": "vite",
"build": "vite build",
"test": "vitest run",
"typecheck": "vue-tsc --noEmit -p tsconfig.json",
"preview": "vite preview"
```

### `apps/server/package.json` scripts

```json
"start": "node --experimental-strip-types src/index.ts",
"dev": "node --watch --experimental-strip-types src/index.ts",
"typecheck": "tsc --noEmit -p tsconfig.json",
"build": "tsc --noEmit -p tsconfig.json"
```

Server `build` is typecheck-only (`noEmit`). It does **not** emit JS and does **not** copy web dist.

### Root `package.json` scripts

```json
"lint": "eslint .",
"typecheck": "pnpm -r --if-present typecheck",
"test": "node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts apps/server/src/tasks.test.ts && pnpm --filter @kaola/web test",
"build": "pnpm -r --if-present build"
```

**Confirmed: no root `pnpm dev`, no root `start`.** No `concurrently` / `npm-run-all` / `wait-on` dependency in any `package.json`.

---

## Q5. Docker

### `docker-compose.yml` (entire file)

```1:16:docker-compose.yml
services:
  server:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    ports:
      - "3000:3000"
    environment:
      PORT: "3000"
      HOST: "0.0.0.0"
    volumes:
      - kaola-data:/data

volumes:
  kaola-data:
```

Not set: `PUBLIC_URL`, `SQLITE_PATH` (code default remains `:memory:` so the volume is unused), OAuth env, `SESSION_SECRET`, `VAULT_MASTER_KEY`.

### `apps/server/Dockerfile` (entire file)

```1:25:apps/server/Dockerfile
FROM node:22-bookworm-slim
# apt python3 make g++ for better-sqlite3; corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/forge-adapters/package.json packages/forge-adapters/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["pnpm", "--filter", "@kaola/server", "start"]
```

| Question | Measured |
| --- | --- |
| Public port | `EXPOSE 3000`; compose `3000:3000`; `ENV PORT=3000` |
| Working directory | `/app` (repo root) |
| Start command | `pnpm --filter @kaola/server start` |
| Web dist built? | **No** `RUN pnpm --filter @kaola/web build` (or any `vite build`) |
| Web source copied? | **Yes**: `apps/web/package.json` before install; `COPY . .` copies `apps/web` source |
| Dist copied as artifact? | **No** dedicated copy. `.gitignore` has `dist/`. No `.dockerignore` in this tree, so a **local** `apps/web/dist` *could* enter the build context, but the image does not create one |
| Fastify serves dist? | **No** — `GET /` is still the placeholder |

Issue target: expose only `31415:31415`, build web, put dist in the same image.

---

## Q6. Fastify version and `@fastify/*` plugins

`apps/server/package.json` dependencies:

| Package | Specifier | Lockfile resolved |
| --- | --- | --- |
| `fastify` | `^5.4.0` | **`5.12.1`** |
| `@fastify/cookie` | `^11.1.2` | `11.1.2` |
| `@fastify/oauth2` | `^8.3.0` | `8.3.0` |
| `@fastify/session` | `^11.1.2` | `11.1.2` |

**Fastify major: 5** (not 4).

`pnpm-lock.yaml` has **no** `@fastify/static`, **no** `@fastify/http-proxy`, **no** `@fastify/reply-from`, **no** `@fastify/websocket`.

Existing `@fastify/*` usage is only in `auth.ts`: `cookie`, `oauth2`, `session` via `app.register(...)` inside `registerAuth` (not awaited; tests rely on `app.ready()`). Same registration style is the existing seam for new plugins.

Do **not** invent plugin versions in implementation; pick Fastify 5–compatible releases at install time. Issue candidates: `@fastify/static` (prod) and `@fastify/http-proxy` or equivalent (dev).

---

## Q7. How tests construct the app; listen+fetch vs placeholder; `registerAuth` env

### Construction pattern (all HTTP suites)

1. Mutate `process.env` in `applyOauthTestEnv()` **before** `await import('./app.ts')`.
2. `const app = buildApp(...)` (sync).
3. `t.after(() => app.close())`.
4. `await app.ready()`.
5. `app.inject({ method, url, ... })`.

Helpers:

- `auth.test.ts:126-133` `createApp(t)` → `buildApp()` no options.
- `agent-keys.test.ts:135-142` `createApp(t, options)` → `buildApp(options)`.
- `vault.test.ts:144-151` `createApp(t, sqlitePath)` → `buildApp(sqlitePath ? { sqlitePath } : undefined)`.
- `tasks.test.ts` same as vault (line 292 region).

`placeholder.test.ts` never calls `buildApp`.

`auth.test.ts` / `agent-keys.test.ts` do **not** set `{ concurrency: false }` on a file-level describe. `vault.test.ts:306` and `tasks.test.ts:583` do.

### Can a hosting test `listen` + `fetch GET /` without breaking the placeholder suite?

**Yes**, if and only if:

1. It uses a **separate** Fastify instance (every `buildApp()` is isolated).
2. It does **not** change the default `GET /` for naked `buildApp()`.
3. It does **not** auto-enable static because a dist directory happens to exist on disk.
4. If it `listen`s, it binds an **ephemeral port** (`listen({ port: 0, host: '127.0.0.1' })`) so it cannot collide with concurrent tests or a developer’s `:3000`/`:31415`. No current test listens, so a **fixed** `31415` would not break placeholder tests — it would only flake if that port is taken.
5. `registerAuth` still requires the nine env vars (hosting tests must set the same fixture before import, or import after fixture).

`fetch` of `GET /` against a real listen is **not required** to pin placeholder behavior; inject already does. Listen+fetch is useful for proxy/HMR/static file serving that inject cannot fully emulate (WebSocket).

### `registerAuth` required env (from source)

`requireEnv` (`auth.ts:41-47`) throws `missing required environment variable ${name}` if `null` or `''`.

Required (9):

1. `SESSION_SECRET`
2. `OAUTH_GITHUB_CLIENT_ID`
3. `OAUTH_GITHUB_CLIENT_SECRET`
4. `OAUTH_GITLAB_CLIENT_ID`
5. `OAUTH_GITLAB_CLIENT_SECRET`
6. `OAUTH_GITLAB_BASE_URL`
7. `OAUTH_GITEA_CLIENT_ID`
8. `OAUTH_GITEA_CLIENT_SECRET`
9. `OAUTH_GITEA_BASE_URL`

Optional in `registerAuth`: `PUBLIC_URL` (default `http://localhost:3000`).

**Not** read by `registerAuth`: `PORT`, `HOST`, `SQLITE_PATH`, `VAULT_MASTER_KEY`.

`VAULT_MASTER_KEY` is read by `encryptToken`/`decryptToken`, not at `buildApp()` boot (`CLAUDE.md` / `vault.ts`). `agent-keys.test.ts` deletes it and still boots.

Because `buildApp` always calls `registerAuth`, **every** `buildApp()` (inject or listen) needs those nine non-empty values.

---

## Q8. Where production static + SPA fallback should attach (`buildApp` vs `index.ts`)

### What exists today

- `buildApp(options?: { sqlitePath?: string })` — single optional field.
- Exact `GET /` placeholder registered first.
- `index.ts` is the only listener; tests never import it.
- No `existsSync`, no env for web root, no `registerWeb*` function.

### Constraint from the issue

> 两者都没有时仍返回「考拉任务服务占位」（inject 测试、裸 `buildApp()` 不破）

### Recommended seam (do not implement here)

**Do not** default-on `existsSync('../web/dist')` (or `/app/apps/web/dist`) inside `buildApp()`. That couples unit tests to whether a developer or `pnpm build` left a dist on disk.

**Do** extend the existing options object (reuse; do not add a parallel factory):

```ts
buildApp(options?: {
  sqlitePath?: string
  webDist?: string        // production: directory containing index.html; omit/empty = off
  viteDevTarget?: string  // development: e.g. http://127.0.0.1:<internal-vite>; omit = off
})
```

Behavior:

| `webDist` | `viteDevTarget` | `GET /` |
| --- | --- | --- |
| unset/empty and no dir | unset | **today’s placeholder** (`getPlaceholderBody()` + `text/plain; charset=utf-8`) |
| set and `index.html` exists | unset | `@fastify/static` + SPA `setNotFoundHandler` for GET that are not `/api` or `/login*` |
| unset | set | proxy non-API GET/WS to Vite; do not steal `/api` or `/login` |
| both | — | undefined in the issue; implementer should treat as invalid or prod-wins — **ask** if tests do not pin it |

`index.ts` (process only) reads env and **passes** options; it should not become a second place that registers routes the tests cannot see. Suggested env names are **not in the tree** (issue: “实现细节（插件版本、env 名）由落地时对源确认”). Whatever names are chosen, document them; do not silently scrape `../web/dist`.

`registerAuth` already uses `app.register(plugin)` then `app.ready()` in tests. New Fastify 5 plugins should follow that, **after** API routes so `/api` and `/login*` stay first. **Replace or skip** the exact `GET /` placeholder when a hosting mode is on; a later wildcard cannot override it.

SPA fallback: no vue-router today, but issue acceptance requires deep-link fallback → `index.html` for unmatched GET. Do not fallback `/api/*` or `/login*` to HTML.

Dev: Fastify listens `PORT` (target default 31415). Vite must bind **loopback only** (Vite default host is already `localhost`). Public origin is Fastify. Root `pnpm dev` must occupy **only** 31415 (spawn internal Vite; do not advertise 5173). Proxy WS for HMR.

Legacy: `vite.config.ts` proxy targets change `127.0.0.1:3000` → `127.0.0.1:31415` so a leftover `:5173` still hits the API.

---

## Q9. Docs that still teach 3000 / 5173 (will go stale)

Issue also lists `CHANGELOG.md`; Q9 asked for CLAUDE.md Commands, README, `docs/api.md`, `docs/architecture.md`. Quoted below. `docs/conventions.md` has **no** port numbers. `docs/DESIGN.md` has **no** `3000` / `5173` / `31415` (only §12 one-liner, see Q10).

### `CLAUDE.md` Commands (line 17)

> Dev server: `pnpm --filter @kaola/server start` (`node --experimental-strip-types src/index.ts`; `HOST` default `0.0.0.0`, `PORT` default `3000`; `GET /` body `考拉任务服务占位`). `registerAuth` requires non-empty `SESSION_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`, `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL`. Optional `PUBLIC_URL` default `http://localhost:3000`; `SQLITE_PATH` default `:memory:`. `VAULT_MASTER_KEY` (64 hex chars) is read by `encryptToken`/`decryptToken`, not required at `buildApp()` boot. `pnpm --filter @kaola/server dev` (`node --watch --experimental-strip-types src/index.ts`); `pnpm --filter @kaola/web dev` (`vite`). No root `pnpm dev`.

Snapshot line 6 still says server `GET /` body `考拉任务服务占位` as an M0 shell — after #17, production `GET /` is the SPA when dist exists; keep the naked-`buildApp()` placeholder fact.

### `README.md`

- Line 64: `可选：`PUBLIC_URL` 默认 `http://localhost:3000`（去掉尾斜杠）；`PORT` 默认 `3000`；`HOST` 默认 `0.0.0.0`；`SQLITE_PATH` 默认 `:memory:`。`
- Line 73: ``GET /` 响应 `text/plain; charset=utf-8`，正文为 `考拉任务服务占位`（由 `getPlaceholderBody()` 返回）。`
- Lines 76–81: 前端 `pnpm --filter @kaola/web dev`；`Vite 将 `/api` 与 `/login` 代理到 `http://127.0.0.1:3000`。`
- Line 83: `开发登录脚注（#7 未改代码）：`completeOAuthLogin` 以 `reply.redirect('/')` 相对 `PUBLIC_URL`（默认 `http://localhost:3000`）跳转，登录后浏览器落在 Fastify `GET /` 占位页，而不是 Vite SPA。…因此回到 `http://localhost:5173` 仍已登录；打开 `http://127.0.0.1:5173` 不共享该 cookie。`
- Line 85: `热重载服务：`pnpm --filter @kaola/server dev`…根目录没有 `pnpm dev`。`
- Line 89: `仓库含 `docker-compose.yml` 骨架：服务名 `server`，端口 `3000:3000`，环境变量 `PORT=3000`、`HOST=0.0.0.0`…`

### `docs/api.md`

- Lines 15–17: ``GET /`` / ``text/plain; charset=utf-8` body `考拉任务服务占位` (`getPlaceholderBody()`). Unauthenticated.`
- Line 186: `Optional: `PUBLIC_URL` default `http://localhost:3000` (trailing slash stripped). Existing `PORT` / `HOST` / `SQLITE_PATH`.`
- Line 188: `Callback URIs: `${PUBLIC_URL}/login/{github|gitlab|gitea}/callback`.`
- Line 198: server deps list `fastify`, `@fastify/oauth2`, `@fastify/cookie`, `@fastify/session` — will need static/proxy plugins once added.

### `docs/architecture.md`

- Line 10: `browser  →  @kaola/web (Vite; proxy /api and /login → 127.0.0.1:3000)`
- Line 12: `GET /                            placeholder body`
- Line 31: ``apps/server/src/index.ts` listens `HOST` default `0.0.0.0`, `PORT` default `3000`, `buildApp({ sqlitePath: process.env.SQLITE_PATH ?? ':memory:' })`.`
- Line 45: ``vite.config.ts` proxy: `/api` and `/login` → `http://127.0.0.1:3000`.`
- Line 55: ``docker-compose.yml`: service `server`, `3000:3000`, `PORT=3000`, `HOST=0.0.0.0`… Dockerfile `node:22-bookworm-slim`, `CMD pnpm --filter @kaola/server start`.`

### Also stale (issue sync list): `CHANGELOG.md`

- Unreleased OAuth bullet: `Optional `PUBLIC_URL` default `http://localhost:3000`.`
- Web bullet: `Vite proxy `/api` and `/login` → `http://127.0.0.1:3000`.`
- M0 bullet: `PORT` default `3000`; compose port 3000; `GET /` body placeholder.

Do **not** change `docs/DESIGN.md` contracts (task-brief / state machine / MCP). §12 deployment sentence can stay as-is (no port numbers).

---

## Q10. Issue-body assumptions this tree contradicts or nuances

1. **“OAuth callback 与登录后跳转都相对它 (`PUBLIC_URL`).”** Partial. Callbacks are **absolute** `${publicUrl}/login/.../callback`. Post-login is **relative** `'/'`. Only the browser’s resolution of `/` is against the callback origin.

2. **“Vite 默认 5173”.** Not in `vite.config.ts`. Library default is 5173 (Vite 7 docs). `apps/` has no `5173`. Vite will pick another port if 5173 is busy (`strictPort` unset).

3. **“镜像不构建、不拷贝 `apps/web` dist.”** Dockerfile does **not** build dist. It **does** copy `apps/web` **source** (`COPY apps/web/package.json` + `COPY . .`). Dist is not produced in the image. No `.dockerignore`.

4. **“DESIGN.md §12 已写的部署形状（docker-compose 单机：server + 静态前端）.”** True as one sentence (`DESIGN.md:257`): `内部服务器 docker-compose 单机部署（server + 静态前端 + 挂载 SQLite 卷）。` It does **not** mention 31415, static plugin, or Fastify hosting. Compose today is API-only on 3000; SQLite volume is unused because `SQLITE_PATH` is unset.

5. **Dev topology is the opposite of the issue.** Vite is the public SPA origin; Fastify is not. Root has no `pnpm dev`. Issue wants Fastify as the only public process.

6. **“占位正文被 `placeholder.test.ts`、`vault.test.ts`、`agent-keys.test.ts` 钉死.”** True. `auth.test.ts` / `tasks.test.ts` do not pin `GET /`. `placeholder.test.ts` does not exercise HTTP.

7. **Adding static without gating `GET /` would go red** even with “no dist in tests”, if anyone auto-detects dist. The issue’s “无 dist 时保留占位” is a **behavioral** default, not a license to `existsSync` a workspace path.

8. **“前端不再单独暴露 5173/3000” vs “若有人仍开 :5173”.** 5173 remains bindable as a non-advertised origin; the Vite proxy target must move to 31415. 3000 must leave defaults (issue acceptance: `PORT` / `PUBLIC_URL` / compose / Dockerfile).

9. **SPA deep links.** No vue-router; only `/` is the app. Fallback is still required by the issue. Do not invent routes.

10. **`scope=undefined` and RFC1918** are real and out of scope. `auth.ts` registers oauth2 with no `scope`. `tasks.ts:147-156` allows any http(s) host including RFC1918. Do not “fix”.

11. **Issue comments are not empty** (one workflow comment). It does not change the body.

12. **`GET /` content-type is not pinned by tests.** Changing it to `text/html` when serving the SPA is required; keep `text/plain; charset=utf-8` on the placeholder path.

---

## Key Files

| File | Role for #17 |
| --- | --- |
| `apps/server/src/index.ts` | `PORT`/`HOST`/`SQLITE_PATH` defaults; `listen`; process-only. Pass hosting options from env here. |
| `apps/server/src/app.ts` | `buildApp` signature; exact `GET /`; register order. **Must gate placeholder.** |
| `apps/server/src/placeholder.ts` | `getPlaceholderBody(): string` → `考拉任务服务占位` |
| `apps/server/src/placeholder.test.ts` | Pins helper string; no HTTP |
| `apps/server/src/auth.ts` | `PUBLIC_URL` default; absolute `callbackUri`; `reply.redirect('/')`; `requireEnv` list |
| `apps/server/src/auth.test.ts` | OAuth inject; `PUBLIC_URL` fixture `http://localhost:3000`; relative `/login` Location |
| `apps/server/src/vault.test.ts` | Inject `GET /` placeholder pin |
| `apps/server/src/agent-keys.test.ts` | Inject `GET /` placeholder pin (twice in one test) |
| `apps/server/src/tasks.ts` | `isHttpOrHttpsUrlWithHost` — do not add RFC1918 block |
| `apps/server/package.json` | Fastify `^5.4.0`; no static/proxy; `start`/`dev` |
| `apps/web/vite.config.ts` | Proxy `/api` `/login` → `:3000`; no port |
| `apps/web/package.json` | `vite` / `vite build` / `vite preview` |
| `apps/web/index.html` | `#app` + `/src/main.ts`; production dist entry |
| `apps/web/src/App.vue` | Relative `/api` and `/login` links |
| `package.json` (root) | No `dev` script |
| `docker-compose.yml` | `3000:3000`, `PORT=3000` |
| `apps/server/Dockerfile` | `EXPOSE 3000`; no web build |
| `pnpm-lock.yaml` | `fastify@5.12.1`; no static/http-proxy |
| `docs/DESIGN.md` §12 | Deployment one-liner; **do not change contracts** |

---

## Dependencies (hosting-relevant)

Already present:

- `fastify@5.12.1` (specifier `^5.4.0`)
- `@fastify/cookie@11.1.2`, `@fastify/session@11.1.2`, `@fastify/oauth2@8.3.0`
- `vite@7.3.6` (specifier `^7.0.0`) in `@kaola/web`
- Vue 3 + `@vitejs/plugin-vue`; no vue-router

Missing for the issue:

- `@fastify/static` (production)
- `@fastify/http-proxy` **or** `@fastify/reply-from` (dev GET proxy); WS support still needed for HMR
- Root `dev` orchestration (no `concurrently` today)
- Docker `RUN` of `pnpm --filter @kaola/web build`

`@kaola/server` `build` script remains `tsc --noEmit`; it will not stage web dist. Docker or a new compose/build step must run the web `vite build`.

---

## Recommendations for New Development (for tdd-guide + implementer)

1. **Tests (tdd-guide custody):** keep existing placeholder inject tests green on naked `buildApp()`. Add new tests that pass explicit `webDist` / `viteDevTarget` (or whatever names land). Do not author production code. Pin: placeholder body + `text/plain; charset=utf-8` when hosting off; HTML `index.html` when `webDist` has `index.html`; `/api` and `/login` not swallowed; SPA fallback for an unknown GET path; default `PORT`/`PUBLIC_URL` **31415** if you pin defaults (current tests do **not** pin the numeric default — they fixture `PUBLIC_URL` to 3000).
2. **Do not listen on 3000/31415 in the shared suite** unless using port `0`. Inject is enough for static `index.html` and placeholder.
3. **Implementer:** extend `buildApp` options; gate `GET /`; register static/proxy **after** API routes; `index.ts` defaults `PORT`/`PUBLIC_URL` away from 3000; invert/keep Vite proxy to `127.0.0.1:31415`; add root `pnpm dev` occupying only 31415; Dockerfile `EXPOSE 31415`, compose `31415:31415`, `RUN` web build; docs listed in Q9; **no** DESIGN.md contract edits; **no** OAuth `scope`; **no** RFC1918 filter.
4. **Plugin versions:** resolve against Fastify 5 at install; do not copy Fastify 4 APIs from memory.
5. **OAuth after single-port:** relative `redirect('/')` becomes correct (callback origin = SPA origin) once Fastify serves the SPA at `/`. No need to change `reply.redirect('/')` unless tests demand an absolute URL (they do not).
6. **Cookie / 127.0.0.1:** session cookie is host-only (`auth.ts:256-258`: `path: '/'`, `secure: false`, `httpOnly: true`, `sameSite: 'lax'`, no `domain`). Opening `127.0.0.1:31415` vs `localhost:31415` is still a different cookie host. Out of issue scope; do not “fix” Domain.

---

## Facts the implementer must not invent

- Placeholder body is exactly **`考拉任务服务占位`** (`placeholder.ts:2`). HTTP sends it via `getPlaceholderBody()`, content-type **`text/plain; charset=utf-8`** (`app.ts:15-16`).
- Current `PORT` default is **`'3000'`** (`index.ts:4`). Current `HOST` default is **`'0.0.0.0'`** (`index.ts:5`). Current `SQLITE_PATH` default is **`':memory:'`** (`index.ts:3`).
- Current `PUBLIC_URL` default is **`'http://localhost:3000'`** with trailing slashes stripped (`auth.ts:243, 49-51`). `index.ts` does not read `PUBLIC_URL`.
- Issue target public origin is **`http://localhost:31415`**. Acceptance: defaults **leave 3000** (`PORT`, `PUBLIC_URL`, compose, Dockerfile). The port is **31415**, not 1415, not 3000.
- Docker today: compose **`"3000:3000"`**, `PORT: "3000"`; Dockerfile **`ENV PORT=3000`**, **`EXPOSE 3000`**, `WORKDIR /app`, `CMD ["pnpm", "--filter", "@kaola/server", "start"]`. No web dist build step.
- Fastify is **major 5** (`^5.4.0` / lockfile `5.12.1`). `@fastify/static` and `@fastify/http-proxy` / `@fastify/reply-from` are **absent**.
- `buildApp(options?: { sqlitePath?: string })` — only option today. Tests: **`buildApp` + `inject` + `ready`/`close`**. Only `listen` is `index.ts:7`.
- `registerAuth` requires exactly: `SESSION_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`, `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL`.
- Post-login is **`return reply.redirect('/')`** (`auth.ts:238`) — relative. Callbacks are **`${publicUrl}/login/{github|gitlab|gitea}/callback`**.
- Vite proxy today: **`'/api': 'http://127.0.0.1:3000'`** and **`'/login': 'http://127.0.0.1:3000'`**. Root **`package.json` has no `dev` script**.
- Do not change DESIGN.md task-brief / state machine / MCP contracts. Do not set OAuth `scope`. Do not block RFC1918 on `repo.base_url`.
