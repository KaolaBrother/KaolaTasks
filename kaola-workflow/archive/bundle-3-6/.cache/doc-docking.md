# doc-docking — bundle-3-6

What README / CHANGELOG / CLAUDE.md Commands+Snapshot / `docs/api.md` / `docs/architecture.md` now state from **source**, versus what remains **DESIGN-only** (`docs/DESIGN.md` v0.2, not edited).

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6`  
Date: 2026-08-21

## Docked (in tree + now in docs)

### HTTP / auth (#3)

| Item | Source | Docs |
|------|--------|------|
| `GET /` `text/plain; charset=utf-8` body `考拉任务服务占位` | `app.ts` / `placeholder.ts` | README, api, architecture, CLAUDE Commands |
| `GET /login` HTML 200 | `auth.ts` `loginPageHtml` | README, api |
| OAuth start `GET /login/github`, `/login/gitlab`, `/login/gitea` | `@fastify/oauth2` `startRedirectPath` | README, api, CHANGELOG |
| Callbacks `GET /login/{github\|gitlab\|gitea}/callback` | `auth.ts` | README, api, CHANGELOG |
| GitLab OAuth `/oauth/authorize` + `/oauth/token`; Gitea `/login/oauth/authorize` + `/login/oauth/access_token` | `registerAuth` | api.md |
| GitHub plugin `GITHUB_CONFIGURATION` | `auth.ts` | api.md (no invented GitHub authorize path) |
| Userinfo GET GitHub `https://api.github.com/user`; GitLab `${base}/api/v4/user`; Gitea `${base}/api/v1/user` | `userinfoUrl` | api.md |
| `GET /api/v1/me` JSON fields `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`; pending `message` `你的账号待正式成员批准后方可认领任务。` | `publicUser` | README, api, CHANGELOG |
| Unauthenticated `/api/v1/me`: JSON Accept → 401 `{ error: 'unauthorized' }`; else 302 `/login` | `auth.ts` | api.md |
| `POST /api/v1/users/:id/approve` only `active`+`full`; sets `status` `active`; GitHub stays `claim_only`; errors `unauthorized` / `forbidden` / `invalid_id` / `not_found`; empty re-select `{ ok: true }` | `auth.ts` | api.md, README, CHANGELOG |
| `users` SQL: `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`; UNIQUE `(provider, remote_id)` | `db.ts` `USERS_DDL` | api, CHANGELOG, README |
| Enums `provider` `github`\|`gitlab`\|`gitea`; `status` `active`\|`待批准`; `permission_level` `full`\|`claim_only` | `schema.ts` | api, CHANGELOG |
| First insert: GitHub `待批准`+`claim_only`; GitLab/Gitea `active`+`full`; later login updates username/display_name only | `mapProfile` / `upsertUser` | api.md, README |
| `CREATE TABLE IF NOT EXISTS users` in `createDb`; default `:memory:` unless `SQLITE_PATH` | `db.ts` | api, architecture |
| `buildApp({ sqlitePath? })` own db; `index.ts` `SQLITE_PATH ?? ':memory:'` | `app.ts`, `index.ts` | api, architecture |
| Required env (throw `missing required environment variable …`): `SESSION_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`, `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL` | `requireEnv` | README, CLAUDE Commands, api, CHANGELOG |
| Optional `PUBLIC_URL` default `http://localhost:3000` (trim trailing slash); `PORT`/`HOST` | `auth.ts`, `index.ts` | same |
| Deps `@fastify/oauth2@^8.3.0`, `@fastify/cookie@^11.1.2`, `@fastify/session@^11.1.2` | server `package.json` | CHANGELOG, api, architecture |
| Session `userId?: number`; cookie `path: '/'`, `secure: false`, `httpOnly: true`, `sameSite: 'lax'`; `saveUninitialized: false` | `auth.ts` | architecture.md (cookie **name** not in source → omitted) |
| Login success redirect `/` | `completeOAuthLogin` | api.md |
| 502 `{ error: 'userinfo_failed' }` / `{ error: 'userinfo_invalid' }` | `auth.ts` | api.md |

### Web (#3)

| Item | Source | Docs |
|------|--------|------|
| Chinese Naive UI `zhCN` / `dateZhCN`; login buttons `/login/github\|gitlab\|gitea`; pending card; 正式成员 approve by user id | `App.vue` | README, CHANGELOG, architecture |
| Vite proxy `/api` and `/login` → `http://127.0.0.1:3000` | `vite.config.ts` | same |
| No vue-router; deps `vue` `^3.5.0`, `naive-ui` `^2.45.0` | `package.json`, `main.ts` | same |
| Title 考拉任务 | `index.html`, header | README |

### Forge adapters (#6)

| Item | Source | Docs |
|------|--------|------|
| `getForgeAdaptersHealth()` → `kaola-forge-adapters-ready` | `index.ts` | all surfaces |
| `createForgeAdapter(kind, options?: { baseUrl?: string })` | `index.ts` | README, api, CHANGELOG, CLAUDE snapshot |
| Types `ForgeKind`, `Credential` `{ token: string }`, `RepoRef` `{ full_name, base_url }`, `TokenCapability` `'读'\|'推'\|'PR'`, `TokenCheck` `{ missing }`, `CreateForgeAdapterOptions`, `ForgeAdapter` | `index.ts` | README, api, CHANGELOG |
| Placeholders `ImportedIssue`, `PrStatus`, `ForgeEvent`, `IssueRef` = `unknown` | `index.ts` | README, api, CHANGELOG |
| `kind` + `validateToken` implemented (global `fetch`, GET-only); other methods `Error('not implemented')` | `index.ts` | same |
| GitHub API host always `https://api.github.com` (ignores `baseUrl`); GitLab strip slashes + `/api/v4`; Gitea `/api/v1`; origin `options?.baseUrl ?? repo.base_url` | `apiUrl` | README, api, architecture |
| GitLab path `/projects/${encodeURIComponent(full_name)}`; GitHub/Gitea `/repos/${full_name}`; `/user` | `index.ts` | api.md |
| Auth headers GitHub Bearer + `User-Agent: KaolaTasks` + `Accept: application/vnd.github+json`; GitLab `PRIVATE-TOKEN`; Gitea `Authorization: token` | `authHeaders` | api.md |
| No runtime HTTP dep | forge-adapters `package.json` | README, api, CHANGELOG |
| Push/PR = REST permission proxies, not mutating push/POST PR | `validateToken` / capability helpers | README, api, CHANGELOG |
| Shared spec file `packages/forge-adapters/src/validate-token.shared.test.ts` | tree | architecture.md |
| Server does **not** depend on `@kaola/forge-adapters` or `@kaola/shared` | server `package.json` | architecture.md, README |

### Tooling

| Item | Source | Docs |
|------|--------|------|
| Root test five-file list | `package.json` `"test"` | README, CLAUDE Commands, CHANGELOG |
| Measured 124 pass / 0 fail, 10 suites; lint/typecheck/build exit 0; vite 2565 modules; `index-CfV3Ee1H.js` 1,445.96 kB gzip 401.17 kB | `final-validation.md` | CHANGELOG (counts); CLAUDE Commands (file list only) |
| CI still `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` | `ci.yml` | README (unchanged behavior) |
| No `.env.example` | glob | README |
| compose no OAuth / `SQLITE_PATH` | `docker-compose.yml` | README, architecture |

DESIGN §11 login **capability matrix** is still printed in README as design; implementation mapping (status/permission_level) is printed next to it from `auth.ts`.

## Still DESIGN-only (not in source; docs say unimplemented)

Do not treat these as shipped. `docs/DESIGN.md` was not changed.

| DESIGN locus | What | Docs stance |
|--------------|------|-------------|
| §4 / §9 | MCP Server; tools `list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `submit_pr`, `release_task`; Bearer Agent API Key | api.md / README / CLAUDE: not implemented. No MCP SDK in server `package.json`. |
| §9 | REST `/api/v1/tasks` mirror | not implemented |
| §4 / §7 / §10 | Token Vault; `credential_profiles`; AES-256-GCM master key env name | not implemented; no master-key env in code |
| §4 / §10 | Task CRUD, board UI (list/kanban), `tasks` / `leases` / `submissions` / `events` / `agent_keys` tables | not implemented |
| §5 / §7 | Publish-time 发布即校验 wired to a task going on the board | library `validateToken` exists; publish/board not implemented (README says this explicitly) |
| §8 | `importIssue`, `getPullRequest`, `registerWebhook`, `parseWebhook`, `commentOnIssue` behavior | interface members exist; throw `not implemented`. Payload types `unknown`. |
| §8 | `registerWebhook?` optional in DESIGN | source method is required and throws; documented as throw, DESIGN left as-is |
| §8 | Typed `ImportedIssue` / `PrStatus` / `ForgeEvent` / `IssueRef` shapes | DESIGN unnamed; source `unknown` |
| §11 | Agent Key generate/revoke; webhook HMAC | not implemented |
| §11 | 查看任务板 / 发布任务 as live product capabilities | login exists; board/publish do not |
| §12 | compose injecting 主密钥; static frontend in compose; SQLite on `kaola-data` volume | volume declared unused; default still `:memory:` |
| §13 M1 remainder | 凭证档案、任务看板、租约认领、MCP 六工具、PR 轮询 | README roadmap: #3 and #6 only |
| D6 vs D8 | D6 still says GitLab **or** Gitea pick-one | DESIGN untouched; implementation is three IdPs (D8 / #3 comment) |

## Source names that DESIGN did not specify (docked from code, not from DESIGN)

DESIGN never named these; they are in source and now in api/README/CHANGELOG:

- HTTP paths `/login`, `/login/{provider}`, `/callback`, `/api/v1/me`, `/api/v1/users/:id/approve`
- Env var names listed above
- SQL column identifiers `display_name`, `permission_level`, `id`
- Unique `(provider, remote_id)`
- `TokenCheck.missing`, `Credential.token`, `RepoRef.full_name` / `base_url`
- Factory `createForgeAdapter`
- Chinese pending `message` string
- Session cookie flags (not the cookie name — unnamed in source)

## Intentionally omitted (not in source)

- Session cookie name
- Session TTL / store type beyond what `auth.ts` sets
- GitHub authorize/token URL strings inside `GITHUB_CONFIGURATION` (not inlined in repo source)
- Any invented `.env.example` values
- Claim that server calls `validateToken` on publish
