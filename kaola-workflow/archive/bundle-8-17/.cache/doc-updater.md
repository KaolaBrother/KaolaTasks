# doc-updater report (bundle #8 + #17)

Working tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17`
Did not commit. Did not invent CODEMAPS (`scripts/codemaps/` and `docs/CODEMAPS/` absent). Did not touch `docs/DESIGN.md` (no ports added; §12 docker-compose one-liner left as-is). Did not edit tests or production code. Did not re-run `pnpm lint` / `typecheck` / `test` / `build` — pass counts omitted from current docs.

## Files updated

### `CLAUDE.md`
- **Project Snapshot**: `GET /` is placeholder only on naked `buildApp()` (omit/empty `webDist` and `viteDevTarget`); SPA when `webDist`; Vite proxy when only `viteDevTarget`; both set → `webDist` wins. Member workbench 任务看板 exists. MCP and claim still not implemented.
  - Reconciled against: `apps/server/src/app.ts:26-80`; `apps/server/src/placeholder.ts:1-3`; `apps/web/src/App.vue:19-115,427-431,464-471,654-662`; `apps/server/package.json` (no MCP SDK).
- **Commands**: root `pnpm test` includes `apps/server/src/hosting.test.ts`; `PORT`/`PUBLIC_URL` default 31415; root `pnpm dev` (`node scripts/dev.mjs`); `buildApp({ sqlitePath?, webDist?, viteDevTarget? })`; nine `registerAuth` required env unchanged.
  - Reconciled against: `package.json:10-13`; `apps/server/src/index.ts:3-9`; `apps/server/src/auth.ts:242-251`; `scripts/dev.mjs:7-28`.

### `CHANGELOG.md`
- New Unreleased bullets at the **top** (#8 board UI; #17 `buildApp` hosting seam + deps; root `pnpm dev` / docker 31415 / test script). Existing #7 (and older) bullets left as-is, including historical `PORT` 3000 / “no board” / “GET / still placeholder”.

### `README.md`
- Status / 已落地 (#8 / #17); removed 任务广场 from 尚未实现; dual `GET /` (placeholder vs SPA); advertised origin `localhost:31415`; root `pnpm dev`; Vite proxy `127.0.0.1:31415`; OAuth `reply.redirect('/')` now lands on SPA under default `pnpm dev`; cookie host-only `localhost` (`secure: false`, no `domain`) vs `127.0.0.1` kept; docker `31415:31415` + `WEB_DIST`; test script includes `hosting.test.ts`. Stale measured 243/27 pass counts omitted (not re-run).
  - Reconciled against: `index.ts:3-9`; `auth.ts:238,243,256-258`; `app.ts:26-80`; `scripts/dev.mjs`; `vite.config.ts:6-10`; `docker-compose.yml`; `apps/server/Dockerfile`; `App.vue` board + `canApprove`; `package.json`.

### `docs/api.md`
- `buildApp({ sqlitePath?, webDist?, viteDevTarget? })`; `GET /` hosting cases; `PUBLIC_URL` default `http://localhost:31415`; `PORT` `'31415'`; optional `WEB_DIST` / `VITE_DEV_TARGET` (not `registerAuth` required); `@fastify/static@^10.1.3`, `@fastify/http-proxy@^11.6.0`. MCP tools still listed as unimplemented. No events HTTP (unchanged).

### `docs/architecture.md`
- Diagram: advertised origin 31415; Vite 5173 loopback-only under root `pnpm dev`; `GET /` dual; board UI; docker/Dockerfile 31415 + `WEB_DIST`.

## Surfaces skipped (reason)

| Surface | Reason |
|---|---|
| `docs/DESIGN.md` | Must not change contracts; §12 docker-compose one-liner has no ports — left unchanged |
| `scripts/codemaps/`, `docs/CODEMAPS/` | Do not exist; do not invent |
| `.env.example` | Absent; must not create |
| Any `*.ts` / `*.vue` / `package.json` / tests / lockfile | Must not edit |
| MCP tools / `claim_task` / claim HTTP | Still unimplemented (no MCP SDK in `apps/server/package.json`) |
| Older CHANGELOG Unreleased bullets | Instructed to keep #7 bullets |
| `docs/README.md`, `docs/conventions.md`, `docs/decisions/` | Not in allowed edit list |
| `.github/workflows/ci.yml` | Already `pnpm test`; not in allowed list |
| New required env | `registerAuth` still the same nine vars; `WEB_DIST` / `VITE_DEV_TARGET` optional |
| lint/test/build pass counts | Not re-run this session; omitted rather than invented |

## Ground-truth pins used (not invented)

- `buildApp(options?: { sqlitePath?: string; webDist?: string; viteDevTarget?: string })` (`apps/server/src/app.ts:26-30`).
- `index.ts`: `SQLITE_PATH ?? ':memory:'`, `webDist: process.env.WEB_DIST`, `viteDevTarget: process.env.VITE_DEV_TARGET`, `PORT ?? '31415'`, `HOST ?? '0.0.0.0'` (`apps/server/src/index.ts:3-9`).
- `PUBLIC_URL ?? 'http://localhost:31415'` then `trimTrailingSlash`; `reply.redirect('/')`; callbacks `` `${publicUrl}/login/{github\|gitlab\|gitea}/callback` `` (`auth.ts:238,243,269,284,299`).
- Session cookie `{ path: '/', secure: false, httpOnly: true, sameSite: 'lax' }` — no `domain` (`auth.ts:256-258`).
- Placeholder: omit/empty both hosting options → `text/plain; charset=utf-8` + `getPlaceholderBody()` (`app.ts:12-14,40-43`; `placeholder.ts:1-3`).
- `webDist` → `@fastify/static` + `sendFile('index.html')` + SPA fallback GET except `/api` and `/login*`; both set → `webDist` wins; only `viteDevTarget` → `@fastify/http-proxy` (`app.ts:51-80`).
- Root `"dev": "node scripts/dev.mjs"` (`package.json:10`); `PORT ?? '31415'`, `VITE_DEV_TARGET ?? 'http://127.0.0.1:5173'`; Vite `--host 127.0.0.1 --port 5173 --strictPort` (`scripts/dev.mjs:7-27`).
- Vite proxy `/api` and `/login` → `http://127.0.0.1:31415` (`apps/web/vite.config.ts:6-10`).
- `docker-compose.yml`: `"31415:31415"`, `PORT: "31415"`, `HOST: "0.0.0.0"`. Compose does not set `SQLITE_PATH` / OAuth / `VAULT_MASTER_KEY` / `WEB_DIST`.
- Dockerfile: `RUN pnpm --filter @kaola/web build`, `ENV PORT=31415`, `ENV HOST=0.0.0.0`, `ENV WEB_DIST=/app/apps/web/dist`, `EXPOSE 31415`.
- Server deps: `@fastify/static` `^10.1.3`, `@fastify/http-proxy` `^11.6.0` (`apps/server/package.json:14-15`).
- Root test script includes `apps/server/src/hosting.test.ts` then `&& pnpm --filter @kaola/web test` (`package.json:13`).
- Board: `view === 'member'` 任务看板; 列表/看板; filters 状态/标签/Forge; timeline `发布 {{ poster }} {{ created_at }}`; `fetch('/api/v1/tasks')` no query; pending card title 账号待批准; `claim_only` board without `task-form` (`App.vue`; `App.board.test.ts:390-411`).
- No vue-router (`apps/web/package.json` deps: `vue`, `naive-ui` only).
- `registerAuth` required env: `SESSION_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`, `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL` (`auth.ts:242-251`).

## Not measured

- Full-suite pass/fail counts after #8/#17 (not run here).
- Whether remote GitHub Actions has gone green (README still says it has not been treated as green).
- Cookie sharing was not re-probed end-to-end; flags transcribed from `auth.ts` only.
