# tests-hosting — `apps/server/src/hosting.test.ts` (issue #17)

**Role:** tdd-guide (test author only; no production code).
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17`
**Baseline SHA:** `190a79aa5bc806286cb62ad8cddba5d40e65fb47`
**Recorded:** 2026-08-21
**Verbatim RED capture:** `kaola-workflow/bundle-8-17/.cache/tests-hosting-baseline.txt`

I wrote tests only. I did not edit `app.ts`, `index.ts`, `auth.ts`, Dockerfile, `vite.config.ts`, `docker-compose.yml`, or any other production file. I did not edit `placeholder.test.ts`, `vault.test.ts`, `agent-keys.test.ts`, `auth.test.ts`, or `tasks.test.ts` (their `PUBLIC_URL=http://localhost:3000` fixtures stay).

---

## Files authored

| Path | Role |
|------|------|
| `.kw/worktrees/bundle-8-17/apps/server/src/hosting.test.ts` | New. `node:test` + Fastify `inject` + source/file pins. |
| `.kw/worktrees/bundle-8-17/package.json` `"test"` script | Appended `apps/server/src/hosting.test.ts` to the `node --test` list, immediately before `&& pnpm --filter @kaola/web test`. Test-harness custody (same as issue #7). |

---

## Pinned `buildApp` option names

```ts
buildApp(options?: {
  sqlitePath?: string
  webDist?: string
  viteDevTarget?: string
})
```

- **`webDist`**: absolute directory containing `index.html` (tests also drop `/assets/app.js`). Non-empty → production static + SPA fallback.
- **`viteDevTarget`**: development Vite origin string (tests pass `'http://127.0.0.1:5173'`). Accepted as an option; **inject does not exercise the HTTP proxy** (see gap below).
- Omit both, or pass empty strings (`webDist: ''`, `viteDevTarget: ''`) → today’s placeholder. `sqlitePath` alone does not turn hosting on.
- **Both set → `webDist` wins.**

Do **not** `existsSync('../web/dist')` (or any default path) inside `buildApp()`. Naked `buildApp()` / omitted hosting options must stay the placeholder even if a dist happens to exist on disk.

---

## How RED was proved

```
$ cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17
$ CI=true node --experimental-strip-types --test apps/server/src/hosting.test.ts
ℹ tests 9
ℹ suites 1
ℹ pass 0
ℹ fail 9
exit 1
```

**9 tests, 0 pass, 9 fail.** Not one test in this file is green on the baseline.

Existing placeholder inject suites stay green:

```
$ CI=true node --experimental-strip-types --test \
    apps/server/src/placeholder.test.ts \
    apps/server/src/vault.test.ts \
    apps/server/src/agent-keys.test.ts
ℹ tests 26
ℹ pass 26
ℹ fail 0
```

Full root script (now includes this file):

```
$ CI=true pnpm test
ℹ tests 252
ℹ pass 243
ℹ fail 9
```

The 9 failures are exactly `hosting.test.ts`. Because the script is `node --test … && pnpm --filter @kaola/web test`, the web suite did not run on that RED `pnpm test`. Ran separately:

```
$ CI=true pnpm --filter @kaola/web test
Test Files  1 passed (1)
Tests  27 passed (27)
```

`pnpm exec eslint apps/server/src/hosting.test.ts` is clean.

---

## RED failure signatures (verbatim, this baseline)

1. **`omitted hosting options keep GET / as 考拉任务服务占位 with text/plain; webDist serves index.html at /`**
   - Omitted/empty cases already return the placeholder (those asserts pass). The test dies on `webDist` `GET /`:
   - `actual: '考拉任务服务占位'`
   - `expected:` the fixture HTML whose `<title>` is `kaola-hosting-spa-marker`

2. **`webDist SPA-fallbacks unmatched GET, serves assets, and does not swallow /api or /login`**
   - `GET /assets/app.js: 404 {"message":"Route GET:/assets/app.js not found","error":"Not Found","statusCode":404}`
   - `404 !== 200`

3. **`when webDist and viteDevTarget are both set, webDist wins`**
   - same as (1): `GET /` still `考拉任务服务占位`, not the fixture HTML

4. **`index.ts PORT default is 31415`**
   - `actual: [ "process.env.PORT ?? '3000'" ]`
   - `expected: [ "process.env.PORT ?? '31415'" ]`

5. **`auth.ts PUBLIC_URL default is http://localhost:31415`**
   - `actual: [ "process.env.PUBLIC_URL ?? 'http://localhost:3000'" ]`
   - `expected: [ "process.env.PUBLIC_URL ?? 'http://localhost:31415'" ]`

6. **`vite.config.ts proxies /api and /login to http://127.0.0.1:31415`**
   - file still has `'/api': 'http://127.0.0.1:3000'` / `'/login': 'http://127.0.0.1:3000'`

7. **`docker-compose maps 31415:31415 and sets PORT 31415`**
   - file still has `"3000:3000"` and `PORT: "3000"`

8. **`Dockerfile EXPOSE 31415, ENV PORT=31415, and image build includes web dist`**
   - file still has `EXPOSE 3000` / `ENV PORT=3000`; no web `build` step (fails first on `EXPOSE 31415`)

9. **`root package.json has a non-empty dev script`**
   - `typeof pkg.scripts.dev` is `undefined`, not `string`

---

## Data / file assertions the implementer must make green

### A. Inject — hosting off (must stay true; already true today)

Naked `buildApp()`, `buildApp({})`, `buildApp({ sqlitePath: ':memory:' })`, `buildApp({ webDist: '' })`, `buildApp({ viteDevTarget: '' })`:

- `GET /` → **200**, body exactly **`考拉任务服务占位`**, `content-type` matches `/text\/plain/`

Existing `placeholder.test.ts` / `vault.test.ts` / `agent-keys.test.ts` must stay green. Do not auto-detect a workspace dist.

### B. Inject — `webDist` on

Temp dir with:

- `index.html` = exact fixture (marker `kaola-hosting-spa-marker`, trailing newline)
- `assets/app.js` = exact `window.__KAOLA_HOSTING_ASSET__=1;\n`

| Request | Must |
|---|---|
| `GET /` | 200, body **===** that `index.html`, `content-type` matches `/text\/html/`, not the placeholder |
| `GET /assets/app.js` | 200, body **===** the JS file, **not** `index.html` |
| `GET /some/deep/path` | 200, body **===** that `index.html`, `content-type` matches `/text\/html/` |
| `GET /api/v1/me` `Accept: application/json` | **401** JSON `{ error: 'unauthorized' }`, `content-type` matches `/json/`, body is not the SPA |
| `GET /login` | 200, body matches `/考拉任务登录/`, is **not** the SPA `index.html` |
| `GET /login/github` | **302** Location matching `/https:\/\/github\.com\/login\/oauth\/authorize/` |

Gate or replace the exact `app.get('/')` placeholder when `webDist` is on. A later static plugin cannot override an already-registered `/`. `setNotFoundHandler` does not run for `/`. Register static **after** `/api` and `/login*` so those routes are not swallowed. SPA fallback is **GET** unmatched paths only.

### C. Inject — both options

`buildApp({ webDist, viteDevTarget: 'http://127.0.0.1:5173' })` → `GET /` is still the **webDist** `index.html` (not placeholder, not a proxy error). Production wins.

### D. Defaults leave 3000 (source pins; this file does **not** `import('./index.ts')`)

- `apps/server/src/index.ts`: exactly one `process.env.PORT ?? '31415'`
- `apps/server/src/auth.ts`: exactly one `process.env.PUBLIC_URL ?? 'http://localhost:31415'`

Other HTTP suites keep assigning `PUBLIC_URL=http://localhost:3000`. Leave those fixtures.

### E. File pins (legacy Vite-direct + Docker + root `dev`)

- `apps/web/vite.config.ts`: `'/api'` and `'/login'` → **`http://127.0.0.1:31415`**. Must not contain `127.0.0.1:3000`.
- `docker-compose.yml`: port mapping `31415:31415`; `PORT: "31415"` (or `'31415'`). Must not keep `3000:3000` or `PORT: "3000"`.
- `apps/server/Dockerfile`: `EXPOSE 31415`; `ENV PORT=31415` (unquoted, current style). Must not `EXPOSE 3000`.
- Dockerfile **or** compose text includes a web dist build: `pnpm --filter @kaola/web build`, `pnpm --filter @kaola/web run build`, or `vite build` in the Dockerfile.
- Root `package.json` `scripts.dev` is a **non-empty string**. The test does not spawn it.

---

## Judgement calls

1. **Seam names** are the orchestrator’s `webDist` / `viteDevTarget`. No parallel factory. No invented env names in tests (`index.ts` may pass options from env; that wiring is untested here).
2. **Empty string = off**, same as omit. Do not treat `'webDist' in options` as on when the value is `''`.
3. **No auto-`existsSync`**. A temp dist is served only when passed as `webDist`. Tests never create `apps/web/dist`.
4. **`webDist` wins** when both options are set. `viteDevTarget` is still a required option name (the both-set test passes it).
5. **`viteDevTarget` inject gap (binding):** Fastify `inject` cannot drive `@fastify/http-proxy` / reply-from against a live Vite (real HTTP + WS). This suite does **not** fake a proxy and does **not** `listen` on 31415. Pin `webDist` via inject; pin Vite/dev **wiring** via the file tests in E (`vite.config.ts` proxy target + root `dev` script existence). Runtime Fastify→internal Vite GET/WS/HMR is **out of this oracle**.
6. **SPA fixture is a unique temp HTML**, not `apps/web/index.html`, so login HTML (`考拉任务登录`) cannot collide.
7. **`/api` and `/login` asserts live in the same test as assets/deep-path**, after those asserts, so they cannot independently pass on today’s app (today `/login` and `/api/v1/me` already work).
8. **`GET /login/github` 302** is an extra `/login*` pin (orchestrator said `/login*` must not be swallowed). Same test as (7).
9. **PORT / PUBLIC_URL** pinned by **reading source**, not by importing `index.ts` (it listens) and not by deleting `PUBLIC_URL` in-process (this file fixtures `:3000` like the other HTTP suites).
10. **Dockerfile `ENV PORT=31415`** is unquoted to match today’s `ENV PORT=3000` style.
11. **Web image build** accepts `pnpm --filter @kaola/web build` **or** `run build` **or** a Dockerfile `vite build`. That is the “or equivalent” in the prompt.
12. **Root `dev`:** existence + non-empty only. No concurrently/wait-on/port spawn.
13. **Asset vs fallback:** a real file under `webDist` must be served as that file; SPA fallback is for unmatched GET paths.
14. **Exact file bytes** for `index.html` and `app.js` (including the trailing newline on both fixtures).
15. **`HOST` default `0.0.0.0`** is not pinned (issue does not change it).
16. **Plugin names/versions** are not pinned; pick Fastify 5–compatible `@fastify/static` (and a proxy plugin for dev) at install time.
17. **Out of scope (do not touch):** OAuth `scope`, RFC1918 on `repo.base_url`, `docs/DESIGN.md` contracts, cookie `Domain` / localhost vs 127.0.0.1.
18. **Docs** (README / CLAUDE.md Commands / CHANGELOG / `docs/api.md` / `docs/architecture.md`) are not in this suite; doc-updater owns them after implementation.
19. **First test combines hosting-off + hosting-on** so the file has **zero green tests** on baseline while still pinning placeholder `text/plain` (which no prior test asserted as a header).
20. **Concurrency:** file-level `{ concurrency: false }` because several `buildApp()` instances share `process.env` and temp dirs.

---

## Idiom copied

`applyOauthTestEnv` + top-level `await import('./app.ts')` + `buildApp` + `t.after(app.close)` + `await app.ready()` + `app.inject` — from `apps/server/src/auth.test.ts`. The nine OAuth/session env vars are still required for every `buildApp()` including `GET /`.
