# API

Document public APIs, endpoints, schemas, events, and integration contracts.

Product contracts that are not yet in source remain in [DESIGN.md](DESIGN.md) §6 (任务卡 Schema), §8 (ForgeAdapter), §9 (MCP 工具面 / REST). This file records what is implemented.

MCP tools (`list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `submit_pr`, `release_task`) are implemented (`registerMcp` in `apps/server/src/mcp.ts`): Bearer `POST /api/mcp` Streamable HTTP. Claim HTTP is also implemented (`registerClaim` in `apps/server/src/claim.ts`): Bearer `POST /api/v1/tasks/:publicId/claim`, `…/progress`, `…/release` (no REST `submit_pr`). Forge token reveal channels: successful `POST …/claim` `201` top-level `token` **and** MCP `claim_task` success `token`. Session `GET /api/v1/tasks` and `GET /api/v1/tasks/:publicId` never contain it. Task CRUD HTTP is implemented (`registerTasks` in `apps/server/src/tasks.ts`). `revealCredentialProfile` is a module export from `apps/server/src/vault.ts` (not itself HTTP).

## HTTP (`@kaola/server`)

Sources: `apps/server/src/app.ts`, `auth.ts`, `agent-keys.ts`, `agent-bearer.ts`, `credential-profiles.ts`, `vault.ts`, `tasks.ts`, `claim.ts`, `leases.ts`, `mcp.ts`, `schema.ts`, `db.ts`, `placeholder.ts`, `index.ts`.

`buildApp({ sqlitePath?, webDist?, viteDevTarget? })` creates its own SQLite via `createDb`. Process `index.ts` uses `SQLITE_PATH ?? ':memory:'`, and passes `WEB_DIST` / `VITE_DEV_TARGET` into `buildApp`. Empty string is treated as omitted.

### `GET /`

Depends on hosting options (unauthenticated):

- Omit or empty both `webDist` and `viteDevTarget`: `text/plain; charset=utf-8` body `考拉任务服务占位` (`getPlaceholderBody()`).
- Non-empty `webDist`: `@fastify/static` from that directory; exact `GET /` `sendFile` `index.html`; other GET that are not `/api` or `/login*` fall back to `index.html`. `/api` and `/login*` are not swallowed by the SPA.
- Both `webDist` and `viteDevTarget` set: `webDist` wins.
- Only `viteDevTarget`: `@fastify/http-proxy` to that upstream (`GET`/`HEAD`, websocket).

### `GET /login`

HTML 200 (`text/html; charset=utf-8`). Links to `/login/github`, `/login/gitlab`, `/login/gitea`.

### OAuth start (`@fastify/oauth2` `startRedirectPath`)

- `GET /login/github`
- `GET /login/gitlab`
- `GET /login/gitea`

### OAuth callbacks

- `GET /login/github/callback`
- `GET /login/gitlab/callback`
- `GET /login/gitea/callback`

Successful login sets `request.session.userId` and redirects to `/`. Userinfo fetch failure: `502` `{ error: 'userinfo_failed' }` or `{ error: 'userinfo_invalid' }`.

OAuth token hosts / paths in `registerAuth`: GitHub uses `@fastify/oauth2` `GITHUB_CONFIGURATION`; GitLab `authorizePath` `/oauth/authorize`, `tokenPath` `/oauth/token` on `OAUTH_GITLAB_BASE_URL`; Gitea `authorizePath` `/login/oauth/authorize`, `tokenPath` `/login/oauth/access_token` on `OAUTH_GITEA_BASE_URL`. Userinfo GET: GitHub `https://api.github.com/user`; GitLab `${gitlabBaseUrl}/api/v4/user`; Gitea `${giteaBaseUrl}/api/v1/user`.

### `GET /api/v1/me`

Session user JSON. Fields: `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`. When `status` is `待批准`, also `message` `你的账号待正式成员批准后方可认领任务。`.

Unauthenticated: `Accept` containing `application/json` → `401` `{ error: 'unauthorized' }`; otherwise `302` `/login`.

### `POST /api/v1/users/:id/approve`

Actor must be session user with `status` `active` and `permission_level` `full`. Sets target `status` to `active` (does not change `permission_level`; GitHub stays `claim_only`). Response is the updated user JSON (same fields as `GET /api/v1/me`); if the re-select is empty, `{ ok: true }`.

Errors: no session → `401` `{ error: 'unauthorized' }`; actor not `active`+`full` → `403` `{ error: 'forbidden' }`; non-integer or `<= 0` id → `400` `{ error: 'invalid_id' }`; missing user → `404` `{ error: 'not_found' }`.

### `POST /api/v1/agent-keys`

Session cookie. Body: optional `{ "label"?: string }`; missing or non-string `label` becomes `''`.

Requires `status === 'active'` (approved GitHub `claim_only` may generate). Pending → `403` `{ error: 'forbidden', message: '你的账号待正式成员批准后方可生成 Agent Key。' }`.

`201` `{ id, label, token, last_used_at: null }`. `token` is returned only here. Plaintext is `ktk_` plus 64 hex chars (`randomBytes(32).toString('hex')`). Stored `key_hash` is `createHash('sha256').update(plaintext, 'utf8').digest('hex')`.

Unauthenticated: same oracle as `GET /api/v1/me` (`401` `{ error: 'unauthorized' }` or `302` `/login`).

### `GET /api/v1/agent-keys`

Session cookie. Requires `status === 'active'`. Pending → `403` `{ error: 'forbidden' }` (no `message` field).

`200` `{ keys: [{ id, label, last_used_at }] }`. No `token`, no `key_hash`. `last_used_at` is unix seconds or `null`.

### `DELETE /api/v1/agent-keys/:id`

Session cookie. Requires `status === 'active'`. Pending → `403` `{ error: 'forbidden' }`. Deletes the row when `id` belongs to the session user.

`200` `{ ok: true }`. Non-integer / `<= 0` id, missing row, or not owned → `404` `{ error: 'not_found' }`.

### `GET /api/v1/agent/whoami`

Bearer only. Child Fastify `onRequest` via `addAgentBearerHook` in `agent-bearer.ts` (used by the whoami plugin in `agent-keys.ts`, the claim plugin in `claim.ts`, and the MCP plugin in `mcp.ts`). Encapsulated hook, not `@fastify/bearer-auth`. Header `authorization` must match `/^Bearer\s+(\S+)/i`; remainder is the plaintext key. Lookup is by sha256 hex `key_hash`. Successful auth updates `last_used_at` to unix seconds (`Math.floor(Date.now() / 1000)`). Failed / missing / revoked key does not tick `last_used_at`.

`200` `{ id, key_id, label, status, permission_level }` (`id` is the user id). `401` `{ error: 'unauthorized' }` with `WWW-Authenticate: Bearer`. Session `GET /api/v1/me` is unchanged (no `WWW-Authenticate`; Bearer is not accepted there).

### `GET /api/v1/credential-profiles`

Session cookie. Gate: `status === 'active'` AND `permission_level === 'full'`. Otherwise `403` `{ error: 'forbidden' }`. Lists every row (team-shared).

`200` `{ profiles: [{ id, forge, base_url, repo_full_name, scopes_checked, created_by }] }`. Never includes `token` or `token_encrypted`. `scopes_checked` is JSON parsed to an array (`[]` if parse fails or value is not an array).

Unauthenticated: same oracle as `GET /api/v1/me`.

### `POST /api/v1/credential-profiles`

Session cookie. Same `active`+`full` gate (`403` `{ error: 'forbidden' }`).

Body `{ forge, base_url, repo_full_name, token }`: `forge` must be `github` | `gitlab` | `gitea`; `base_url`, `repo_full_name`, and `token` must be non-empty strings. Otherwise `400` `{ error: 'invalid_body' }`.

Encrypts `token` with `encryptToken` (does not call `validateToken`). Inserts `scopes_checked` `'[]'`. Writes `events` row `type` `变更`, `details` `{"action":"create","profile_id":<n>}`.

`201` same public shape as a list item. Duplicate UNIQUE `(forge, base_url, repo_full_name)` → `409` `{ error: 'conflict' }`. Missing or invalid `VAULT_MASTER_KEY` → `500` `{ error: 'vault_unconfigured' }`.

### `DELETE /api/v1/credential-profiles/:id`

Session cookie. Same `active`+`full` gate. Deletes the row (any `full` member may delete any profile).

`200` `{ ok: true, message: '请同时到 forge 侧撤销该 token。' }`. Writes `events` row `type` `变更`, `details` `{"action":"delete","profile_id":<n>}`. Non-integer / `<= 0` id or missing row → `404` `{ error: 'not_found' }`.

### `GET /api/v1/tasks`

Session cookie. Any logged-in user (including `status` `待批准`) may list. Unauthenticated: same oracle as `GET /api/v1/me` (`401` `{ error: 'unauthorized' }` or `302` `/login`).

`200` `{ tasks: [<brief>, ...] }` ordered by integer PK `id`. Each item is a Task Brief (snake_case; keys in `@kaola/shared` `taskBriefSchema`). `id` is `public_id` (`kt-YYYY-NNNN`), not the integer PK. `credential` is `{ profile_id: "<id>" }` or `{ inline: true }` — never a token. `pr_convention` is derived: `branch_prefix` `kaola/${public_id}-`, `title_prefix` `[${public_id}] `. `created_at` is ISO-8601 from stored unix seconds. `poster` is the poster's `username`. Handler calls `sweepExpiredLeases` (check-on-read) then re-reads. After a successful claim, list items still omit forge plaintext and secret key names (`token` / `token_encrypted` / `inline_token_encrypted` / `access_token`).

### `GET /api/v1/tasks/:publicId`

Session cookie. Same auth as list. Addressed by `public_id` string (numeric-looking ids such as `1` are `404`).

`200` the same brief shape as create. Missing row → `404` `{ error: 'not_found' }`. Handler calls `sweepExpiredLeases` (check-on-read) then re-reads. Never contains forge plaintext or the secret key names above.

### `POST /api/v1/tasks`

Session cookie. Gate: `status === 'active'` AND `permission_level === 'full'` (same population as credential profiles). Otherwise `403` `{ error: 'forbidden' }`. 发布即校验: a failing check is never persisted.

Wire is snake_case. Request `credential` is `{ profile_id }` XOR `{ token }` (`profile_id` integer or numeric string). That is not the brief-side union (`{ profile_id: string }` | `{ inline: true }`); a request of `{ inline: true }` with no token is `400` `{ error: 'invalid_body' }`. Sending both `profile_id` and `token` is `400`. Client-supplied `id` / `pr_convention` / `poster` / `status` / `created_at` are ignored (server-owned).

Required: non-empty `title`; `repo.forge` `github` | `gitlab` | `gitea`; non-empty `repo.base_url` and `repo.full_name`; `credential`. Defaults when omitted: `description_md` `''`; `source` `{ type: 'native' }`; `repo.base_branch` `'main'`; `repo.suggested_dir` last path segment of `full_name`; `acceptance_criteria` `[]`; `test_command` `''`; `constraints` `{ allowed_paths: [], forbidden_paths: [] }`; `priority` `'P2'`; `tags` `[]`. `source.type` `imported` requires non-empty `issue_url`. Generic parse failure → `400` `{ error: 'invalid_body' }` (no `message`).

`repo.base_url` must parse as `http:` or `https:` with a non-empty hostname; else `400` `{ error: 'invalid_body', message: '仓库地址不是合法的 http 或 https 地址。' }` (before any forge fetch).

Profile path: load `credential_profiles` by id; missing → `400` `{ error: 'invalid_body', message: '所选凭证档案不存在。' }`. Bind `repo.forge` / `repo.base_url` / `repo.full_name` to the profile row with exact `===` **before** decrypt; mismatch → `400` `{ error: 'invalid_body', message: '所选凭证档案与仓库不匹配。' }` (no `token 揭示` event). Then `decryptToken`. Inline path: `encryptToken` of the request token into `inline_token_encrypted`. Missing or invalid `VAULT_MASTER_KEY` on either path → `500` `{ error: 'vault_unconfigured' }`.

Then `createForgeAdapter(repo.forge, { baseUrl: repo.base_url }).validateToken({ token }, { full_name, base_url })`. Unreachable forge → `502` `{ error: 'forge_unreachable', message: '无法连接 forge 校验 token，任务未发布。' }`. `missing.length > 0` → `422` `{ error: 'token_check_failed', missing, message }` where `missing` is `TokenCapability[]` (`读` | `推` | `PR`); if `missing` includes `读`, `message` is `token 无效或无权访问该仓库，任务未发布。`; otherwise `token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。`.

Profile path writes `events.type` `token 揭示` after decrypt (including 422 / 502): `details` `{ profile_id, forge, base_url, full_name, outcome }` with `outcome` `ok` | `token_check_failed` | `forge_unreachable`. `profile_id` is the integer profile PK. No token / ciphertext / `agent_key_id` in details. Inline path does not write this event.

`201` the Task Brief (`status` `待认领`). No response contains a token.

### `PATCH /api/v1/tasks/:publicId`

Session cookie. Same `active`+`full` gate (`403` `{ error: 'forbidden' }`). Body `{ status }`; `status` must be a `taskStatusSchema` value else `400` `{ error: 'invalid_body' }`. Missing `public_id` → `404` `{ error: 'not_found' }`. Non-poster → `403` `{ error: 'forbidden' }`.

Poster-only edges in source: `待认领` → `已取消`; `已退回` → `已取消` | `待认领`. Other requested statuses (including `待认领` → `进行中`) → `409` `{ error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「${to}」。' }`. Success writes `events.type` `状态迁移`, `details` `{ task_id, from, to }` (`task_id` is the `public_id` string) and returns `200` the updated brief.

### `POST /api/v1/tasks/:publicId/claim`

Bearer only (`addAgentBearerHook` from `agent-bearer.ts`, registered in the `claim.ts` child plugin; session cookie does not authorize). `:publicId` is `kt-YYYY-NNNN`. Auth runs before resource lookup.

`201` exact keys `clone`, `lease`, `task`, `token`:

- `task` — existing 15-key Task Brief (`parseTaskBrief`); `status` `进行中`; `credential` remains `{ profile_id }` or `{ inline: true }` (no token inside `task`)
- `token` — forge plaintext (one of two reveal channels; the other is MCP `claim_task` success `token`)
- `lease` — `{ expires_at, ttl_seconds }` with `ttl_seconds` the number `86400` (`LEASE_TTL_SECONDS`). `expires_at` is ISO-8601 from unix `(now + 86400) * 1000`
- `clone` — `{ suggested_dir, token_usage }` where `suggested_dir` equals `task.repo.suggested_dir` and `token_usage` is exactly `token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。`

Do not put forge plaintext inside `task` / `lease` / `clone`. Nested objects must not contain keys `token` / `token_encrypted` / `inline_token_encrypted` / `access_token`.

Pending `users.status === '待批准'` → `403` `{ error: 'forbidden', message: '你的账号待正式成员批准后方可认领任务。' }` (no forge token; no `token 揭示`). Unknown `publicId` or numeric PK with a valid Bearer → `404` `{ error: 'not_found' }`. Second claim while `进行中` → `409` `{ error: 'conflict', message: '任务已被认领。' }`. Claim when status is not `待认领` (and not the `进行中` conflict above) → `409` `{ error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「进行中」。' }`. Missing/invalid `VAULT_MASTER_KEY` on decrypt → `500` `{ error: 'vault_unconfigured' }`. Unauthenticated / wrong / non-Bearer / session-cookie-only → `401` `{ error: 'unauthorized' }` + `WWW-Authenticate: Bearer`.

Holder identity for later progress/release is `leases.claimer_user_id` compared to the Agent user id (`claim.ts`).

Writes (successful claim): `events.type` `token 揭示` then `状态迁移`. See Events below. Inserts one `leases` row `state` `'active'` keyed by integer `tasks.id`. Calls `sweepExpiredLeases` first (check-on-write). Does not call `validateToken`.

`registerClaim(app, db)` is wired in `app.ts` after `registerTasks`.

### `POST /api/v1/tasks/:publicId/progress`

Bearer only. Body `{ note?: string }` (omit body OK). Non-string `note` is treated as omitted.

`200` exact keys `lease`, `task`. `task.status` `进行中`. Same `lease` wire shape (`expires_at`, `ttl_seconds` `86400`). **No** `token`. Renews `expires_at` from heartbeat `now + 86400`, not original claim time. Writes `events.type` `心跳`, `details` `{ task_id, note }` (`note` is `''` when omitted).

No live lease (including after expiry sweep or after the holder released) → `409` `{ error: 'conflict', message: '任务未被认领。' }`. Non-holder (`leases.claimer_user_id` !== Agent user id) → `403` `{ error: 'forbidden' }` (no `message` required). Unknown id → `404` `{ error: 'not_found' }`. Unauthenticated → `401` as above. Calls `sweepExpiredLeases` first (check-on-write).

### `POST /api/v1/tasks/:publicId/release`

Bearer only. Body `{ reason?: string }` (omit body OK). Non-string `reason` is treated as omitted.

`200` exact keys `task`. `task.status` `待认领`. **No** `token`. **No** `lease` on the wire. Marks the lease `state` `'released'`. Writes `events.type` `状态迁移`, `details` `{ task_id, from, to }` plus `reason` only when the body had a string `reason`.

Same 401 / 404 / non-holder 403 / no-live-lease 409 as progress. Calls `sweepExpiredLeases` first (check-on-write).

There is no REST `POST /api/v1/tasks/:publicId/submit_pr`. `submit_pr` is MCP-only (`submitPr` in `claim.ts`).

### `POST /api/mcp`

Bearer only (`addAgentBearerHook` from `agent-bearer.ts`, registered in the `mcp.ts` child plugin; session cookie does not authorize). Streamable HTTP via `@modelcontextprotocol/sdk` `1.30.0` `StreamableHTTPServerTransport` (`enableJsonResponse: true`; session header `mcp-session-id`). Tests initialize with `protocolVersion` `2025-11-25`. `McpServer` `{ name: 'kaola-tasks', version: '0.0.0' }`.

Unauthenticated / wrong / non-Bearer / session-cookie-only → `401` `{ error: 'unauthorized' }` + `WWW-Authenticate: Bearer` (before JSON-RPC). `GET /api/mcp` and `DELETE /api/mcp` → `405` JSON-RPC `{ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }`. Non-initialize POST without a session → `400` JSON-RPC `-32000` `Bad Request: No valid session ID provided`. Unknown `mcp-session-id` → `404` JSON-RPC `-32001` `Session not found`.

Authenticated `tools/call` HTTP status is `200`. Business failures are a JSON-RPC **result** with `isError: true` and REST `{ error, message? }` in `structuredContent` (and JSON text `content`).

Six `registerTool` names:

| Tool | Input | Success `structuredContent` |
|------|--------|------------------------------|
| `list_tasks` | `status?` `tags?` `forge?` (optional strings) | `{ tasks: [<brief>, ...] }` ordered by integer PK `id`. Filters: `status` exact, `tags` membership of one tag (`brief.tags.includes`), `forge` exact `repo.forge`. Never a token. |
| `get_task_brief` | `task_id` | top-level brief (not wrapped). Missing or numeric PK such as `"1"` → `isError` `{ error: 'not_found' }`. Never a token. Description in source: never includes a forge token. |
| `claim_task` | `task_id` | same envelope as REST claim `201`: keys `clone`, `lease`, `task`, `token`. Tool description includes `CLONE_TOKEN_USAGE` (`token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。`). |
| `report_progress` | `task_id`, `note?` | `{ task, lease }` (no `token`). Omit `note` → event `note` `''`. |
| `release_task` | `task_id`, `reason?` | `{ task }` with `status` `待认领` (no `token`, no `lease`). Omit `reason` → event details have no `reason` key. |
| `submit_pr` | `task_id`, `pr_url`, `summary` | `{ task, pr_url, summary }` with `task.status` `待验收` (no `token`). Inserts `submissions` (`pr_state` `'open'`), marks the live lease `'released'`. |

`list_tasks` / `get_task_brief` / mutating tools call `sweepExpiredLeases` first. Claim/progress/release/submit wrap `claimTask` / `reportProgress` / `releaseTask` / `submitPr` (same REST error bodies: pending claim `forbidden` + `你的账号待正式成员批准后方可认领任务。`; second claim `conflict` + `任务已被认领。`; non-holder `forbidden` without `message`; no live lease `conflict` + `任务未被认领。`; `submit_pr` when status is not `进行中` → `illegal_transition` to `待验收`).

`registerMcp(app, db)` is wired in `app.ts` after `registerClaim`. No PR polling.

### `users` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS users`): `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`; UNIQUE `(provider, remote_id)`.

Drizzle enums in `apps/server/src/schema.ts`: `provider` `github` | `gitlab` | `gitea`; `status` `active` | `待批准`; `permission_level` `full` | `claim_only`.

First insert (`mapProfile`): GitHub → `status` `待批准`, `permission_level` `claim_only`; GitLab / Gitea → `active` + `full`. Subsequent login updates `username` and `display_name` only.

### `agent_keys` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS agent_keys`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `user_id INTEGER NOT NULL`, `key_hash TEXT NOT NULL UNIQUE`, `label TEXT NOT NULL DEFAULT ''`, `last_used_at INTEGER`.

### `credential_profiles` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS credential_profiles`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `forge TEXT NOT NULL`, `base_url TEXT NOT NULL`, `repo_full_name TEXT NOT NULL`, `token_encrypted TEXT NOT NULL`, `scopes_checked TEXT NOT NULL DEFAULT '[]'`, `created_by INTEGER NOT NULL`; UNIQUE `(forge, base_url, repo_full_name)`.

Drizzle enum in `schema.ts`: `forge` `github` | `gitlab` | `gitea`.

### `tasks` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS tasks`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `public_id TEXT NOT NULL UNIQUE`, `title TEXT NOT NULL`, `description_md TEXT NOT NULL DEFAULT ''`, `source_type TEXT NOT NULL`, `source_issue_url TEXT`, `repo_forge TEXT NOT NULL`, `repo_base_url TEXT NOT NULL`, `repo_full_name TEXT NOT NULL`, `repo_base_branch TEXT NOT NULL`, `repo_suggested_dir TEXT NOT NULL`, `acceptance_criteria TEXT NOT NULL DEFAULT '[]'`, `test_command TEXT NOT NULL DEFAULT ''`, `allowed_paths TEXT NOT NULL DEFAULT '[]'`, `forbidden_paths TEXT NOT NULL DEFAULT '[]'`, `priority TEXT NOT NULL`, `tags TEXT NOT NULL DEFAULT '[]'`, `credential_profile_id INTEGER`, `inline_token_encrypted TEXT`, `poster_user_id INTEGER NOT NULL`, `status TEXT NOT NULL`, `created_at INTEGER NOT NULL`; CONSTRAINT `tasks_credential_xor` CHECK `((credential_profile_id IS NULL) != (inline_token_encrypted IS NULL))`.

Drizzle enums in `schema.ts`: `source_type` `native` | `imported`; `repo_forge` `github` | `gitlab` | `gitea`; `priority` `P0` | `P1` | `P2` | `P3`; `status` `待认领` | `进行中` | `待验收` | `已完成` | `已退回` | `已取消`.

### `leases` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS leases`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `task_id INTEGER NOT NULL`, `claimer_user_id INTEGER NOT NULL`, `agent_key_id INTEGER NOT NULL`, `claimed_at INTEGER NOT NULL`, `expires_at INTEGER NOT NULL`, `last_heartbeat INTEGER NOT NULL`, `state TEXT NOT NULL`.

Unique index `leases_one_active_per_task` on `leases(task_id) WHERE state = 'active'`.

`task_id` is the integer `tasks.id` PK, not `public_id`. Drizzle enum in `schema.ts`: `state` `'active' | 'released' | 'expired'`. Lease times are unix seconds. TTL is `LEASE_TTL_SECONDS` `86400` in `leases.ts` (no per-task TTL column). Expiry uses `expires_at <= now` via `sweepExpiredLeases` (sets `state` `'expired'`, transitions the task `进行中` → `待认领` when the task is still `进行中`). No cron.

### `submissions` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS submissions`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `task_id INTEGER NOT NULL`, `lease_id INTEGER NOT NULL`, `pr_url TEXT NOT NULL`, `summary TEXT NOT NULL`, `pr_state TEXT NOT NULL`.

`task_id` is the integer `tasks.id` PK, not `public_id`. Drizzle in `schema.ts` maps `taskId`/`leaseId`/`prUrl`/`summary`/`prState` with no enum on `pr_state`. MCP `submit_pr` success inserts `pr_state` `'open'`.

### `events` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS events`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `type TEXT NOT NULL`, `actor_user_id INTEGER`, `created_at INTEGER NOT NULL`, `details TEXT NOT NULL`.

No events HTTP. Rows written in source:

- profile create/delete: `type` `变更`, `details` JSON `{ "action": "create" | "delete", "profile_id": <n> }`
- `revealCredentialProfile`: `type` `token 揭示`, `details` JSON `{ "agent_key_id": <n>, "profile_id": <n> }`
- POST `/api/v1/tasks` profile path (after decrypt, including 422 / 502): `type` `token 揭示`, `details` JSON `{ "profile_id": <n>, "forge": <forge>, "base_url": <string>, "full_name": <string>, "outcome": "ok" | "token_check_failed" | "forge_unreachable" }` (no token; no `agent_key_id`; inline path does not write this)
- PATCH `/api/v1/tasks/:publicId` success: `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": <status>, "to": <status> }`
- POST `/api/v1/tasks/:publicId/claim` success: `type` `token 揭示`, `details` JSON `{ "task_id": <public_id>, "agent_key_id": <n>, "credential": "inline" | "profile", "profile_id"? }` (`profile_id` only when `credential === 'profile'`, integer profile PK; no plaintext, no ciphertext) then `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": <status>, "to": <status> }` (claimer `actor_user_id`)
- POST `/api/v1/tasks/:publicId/progress` success: `type` `心跳`, `details` JSON `{ "task_id": <public_id>, "note": <string> }` (`note` is `''` when omitted)
- POST `/api/v1/tasks/:publicId/release` success: `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": <status>, "to": <status>, "reason"? }` (`reason` only when body had string `reason`)
- MCP `submit_pr` success (`submitPr` in `claim.ts`): `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": "进行中", "to": "待验收", "pr_url": <string>, "summary": <string> }` (claimer `actor_user_id`)
- lease expiry in `sweepExpiredLeases`: `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": "进行中", "to": "待认领" }`, `actor_user_id` null

`created_at` is unix seconds.

### Vault (`apps/server/src/vault.ts`)

`encryptToken(plaintext: string): string` / `decryptToken(encoded: string | Buffer): string`. Algorithm `'aes-256-gcm'`, `{ authTagLength: 16 }`, IV `randomBytes(12)`. Stored blob is `iv || ciphertext || tag` as base64 TEXT in `token_encrypted`.

`insertAuditEvent(db, { type, actorUserId, details })` with `actorUserId: number | null` (expiry writes SQL NULL).

`revealCredentialProfile(db, { profileId, actorUserId, agentKeyId })` decrypts the profile row and returns the plaintext string. Missing row throws `Error('credential profile not found')`. Writes a `token 揭示` event. Does not log the token. Not an HTTP handler. Forge token reveal channels: successful Bearer `POST /api/v1/tasks/:publicId/claim` `201` top-level `token` and MCP `claim_task` success `token`.

### Env (`registerAuth`)

Required (throw `missing required environment variable …` if empty): `SESSION_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`, `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL`.

Optional: `PUBLIC_URL` default `http://localhost:31415` (trailing slash stripped). Process `index.ts`: `PORT` default `'31415'`, `HOST` default `'0.0.0.0'`, `SQLITE_PATH` default `':memory:'`. Optional `WEB_DIST` and `VITE_DEV_TARGET` (not required by `registerAuth`).

Callback URIs: `${publicUrl}/login/{github|gitlab|gitea}/callback` (`publicUrl` is the trimmed `PUBLIC_URL`). Post-login redirect is still `reply.redirect('/')` (relative).

### Env (`VAULT_MASTER_KEY`)

Read by `encryptToken` / `decryptToken` in `vault.ts` when encrypting or decrypting. Not required at `buildApp()` or `registerAuth` boot.

Must match `/^[0-9a-fA-F]{64}$/` and decode to 32 bytes. Missing, empty, or invalid → `VaultUnconfiguredError` (`code` `vault_unconfigured`). Create-profile HTTP, `POST /api/v1/tasks`, `POST /api/v1/tasks/:publicId/claim`, and MCP `claim_task` (same `claimTask` decrypt) map that to `500` `{ error: 'vault_unconfigured' }` (MCP: `isError` + that body, HTTP 200). Not `SESSION_SECRET`.

There is no `.env.example` in the repository.

Server dependencies: `@fastify/oauth2@^8.3.0`, `@fastify/cookie@^11.1.2`, `@fastify/session@^11.1.2`, `@fastify/static@^10.1.3`, `@fastify/http-proxy@^11.6.0`, `"@kaola/shared": "workspace:*"`, `"@kaola/forge-adapters": "workspace:*"`, `"@modelcontextprotocol/sdk": "1.30.0"`, `"zod": "^4.4.3"` (plus existing `fastify`, `drizzle-orm`, `better-sqlite3`). Vault and agent-key hashing use `node:crypto` (no extra npm package). Agent Bearer is the encapsulated hook in `agent-bearer.ts`, not `@fastify/bearer-auth`.

## `@kaola/forge-adapters`

Package export `"."` → `./src/index.ts`. No runtime HTTP dependency (global `fetch`).

- `getForgeAdaptersHealth(): string` → `'kaola-forge-adapters-ready'`
- `createForgeAdapter(kind, options?: { baseUrl?: string }): ForgeAdapter`

`validateToken` is `ForgeAdapter.validateToken`, not a package-level export.

Types: `ForgeKind` `'github' | 'gitlab' | 'gitea'`; `Credential` `{ token: string }`; `RepoRef` `{ full_name: string; base_url: string }`; `TokenCapability` `'读' | '推' | 'PR'`; `TokenCheck` `{ missing: TokenCapability[] }`; `CreateForgeAdapterOptions`; `ForgeAdapter`.

Placeholders: `ImportedIssue`, `PrStatus`, `ForgeEvent`, `IssueRef` are `unknown`.

Implemented: `kind` + `validateToken` (GET-only). Other interface methods throw `Error('not implemented')`.

API hosts: GitHub always `https://api.github.com` (ignores `baseUrl`). GitLab: strip trailing slashes then `/api/v4`. Gitea: `/api/v1`. GitLab/Gitea origin is `options?.baseUrl ?? repo.base_url`. GitLab repo path: `/projects/${encodeURIComponent(full_name)}`. GitHub/Gitea repo path: `/repos/${full_name}`. User path: `/user`.

Auth headers: GitHub `Authorization: Bearer`, `User-Agent: KaolaTasks`, `Accept: application/vnd.github+json`; GitLab `PRIVATE-TOKEN`; Gitea `Authorization: token`.

Push/PR checks are REST permission proxies, not mutating git push / POST PR.

Unknown `kind` throws `Error('unknown forge kind: …')`.

## `@kaola/shared`

(`packages/shared/src/index.ts`, package export `"."` → `./src/index.ts`) library contract matching [DESIGN.md](DESIGN.md) §5–§6:

- `getSharedHealth(): string` → `'kaola-shared-ready'`
- `taskStatusSchema` — `z.enum(['待认领', '进行中', '待验收', '已完成', '已退回', '已取消'])`
- `type TaskStatus`
- `taskBriefSchema` — `z.strictObject` (unknown keys throw)
- `type TaskBrief`
- `parseTaskBrief(input: unknown): TaskBrief` — `taskBriefSchema.parse(input)` (throws on invalid)
- `transitionTaskStatus(from: string, to: string): string` — legal edges return `to`; others throw

`taskBriefSchema` keys in source: `id`, `title`, `description_md`, `source`, `repo`, `acceptance_criteria`, `test_command`, `constraints`, `pr_convention`, `credential`, `priority`, `tags`, `poster`, `status`, `created_at`. `source` is a discriminated union on `type`: `native` (type only) | `imported` (type + `issue_url` string). `repo`: `forge` enum `github` | `gitlab` | `gitea`; `base_url`, `full_name`, `base_branch`, `suggested_dir` strings. `acceptance_criteria`: `string[]`. `test_command`: string. `constraints`: `allowed_paths`, `forbidden_paths` `string[]`. `pr_convention`: `branch_prefix`, `title_prefix`. `credential`: `z.union` of `z.strictObject({ profile_id: z.string() })` and `z.strictObject({ inline: z.literal(true) })` (token keys rejected). `priority`: `P0` | `P1` | `P2` | `P3`. `tags`: `string[]`. `poster`, `title`, `description_md`, `id`: string. `status`: `taskStatusSchema`. `created_at`: `z.iso.datetime({ offset: true })`.

Legal `transitionTaskStatus` edges in source: 待认领 → 进行中, 已取消; 进行中 → 待认领, 待验收; 待验收 → 已完成, 已退回; 已退回 → 待认领, 已取消.

The DESIGN.md §6 example still parses (`packages/shared/src/index.test.ts` pins it). Field names and enums live in source and DESIGN.md §6 — this file does not duplicate that JSON example. Dependency: `zod` `^4.4.3`.
