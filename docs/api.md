# API

Document public APIs, endpoints, schemas, events, and integration contracts.

Product contracts that are not yet in source remain in [DESIGN.md](DESIGN.md) §6 (任务卡 Schema), §8 (ForgeAdapter), §9 (MCP 工具面 / REST). This file records what is implemented.

MCP tools (`list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `submit_pr`, `release_task`) are implemented (`registerMcp` in `apps/server/src/mcp.ts`): Bearer `POST /api/mcp` Streamable HTTP. Claim HTTP is also implemented (`registerClaim` in `apps/server/src/claim.ts`): Bearer `POST /api/v1/tasks/:publicId/claim`, `…/progress`, `…/release` (no REST `submit_pr`). Forge token reveal channels: successful `POST …/claim` `201` top-level `token` **and** MCP `claim_task` success `token`. Session `GET /api/v1/tasks` and `GET /api/v1/tasks/:publicId` never contain it. `POST /api/v1/tasks/import` `200` never contains a forge token. Task CRUD HTTP is implemented (`registerTasks` in `apps/server/src/tasks.ts`), including the pre-publish draft `POST /api/v1/tasks/import`. `revealCredentialProfile` is a module export from `apps/server/src/vault.ts` (not itself HTTP). Two mechanisms drive `待验收` → `已完成`/`已退回` (#13): PR polling (`pollPendingReviews` in `apps/server/src/poller.ts`, still **not** an HTTP route — either called directly (tests) or driven by an internal `setInterval` registered by `buildApp({ pollIntervalMs })`) and the webhook receiver (`registerWebhooks` in `apps/server/src/webhook.ts`, `POST /api/v1/webhooks/:publicId`, no session, no Bearer — the forge signature is the sole auth). Both share the same terminal-transition write path (`applyPrTerminalTransition`, extracted in `poller.ts`). `buildApp({ forgeInstances? })` lets a `syncMode: 'webhook'` instance opt its repo out of polling (`pollPendingReviews` skips it); a poll-mode or unlisted instance is unaffected. `commentOnIssue` / status write-back to the source Issue is implemented (#14): `attemptWriteback` (`apps/server/src/writeback.ts`, not itself HTTP) posts a status comment for **imported** tasks on 认领 (inside `claimTask`), 提交PR (inside `submitPr`), and 完成 (inside `applyPrTerminalTransition`, only on a `merged` terminal) — see the "Status write-back" section below. It never changes any response shape and never introduces a third token-reveal channel. Audit log + team stats (#15) are implemented (`registerEvents` in `apps/server/src/events.ts`): session `GET /api/v1/events` and `GET /api/v1/stats`, gated stricter than the task board (a `待批准` session is `401` on both). Claim confirmation for autonomous agents (#16) is implemented: REST `POST …/claim` and MCP `claim_task` both accept an optional `autonomous: boolean`; when `true` and the claiming user's `trusted_automation` is not `true`, the claim parks as `202` `{ error: 'confirmation_required', pending: true }` instead of revealing a token, until a session user approves it via `registerClaimConfirmations` (`apps/server/src/claim-confirmations.ts`, `GET/POST /api/v1/claim-confirmations*`). `GET /api/v1/me` gains additive `trusted_automation`; new session `PUT /api/v1/me/settings` toggles it. None of `GET /api/v1/events`, `GET /api/v1/stats`, `GET/POST /api/v1/claim-confirmations*`, `GET /api/v1/me`, `PUT /api/v1/me/settings`, or a claim `202` ever contains a forge token — the two reveal channels above are unchanged.

## HTTP (`@kaola/server`)

Sources: `apps/server/src/app.ts`, `auth.ts`, `agent-keys.ts`, `agent-bearer.ts`, `credential-profiles.ts`, `vault.ts`, `tasks.ts`, `claim.ts`, `claim-confirmations.ts`, `leases.ts`, `mcp.ts`, `poller.ts`, `webhook.ts`, `writeback.ts`, `events.ts`, `schema.ts`, `db.ts`, `placeholder.ts`, `index.ts`.

`buildApp({ sqlitePath?, webDist?, viteDevTarget?, pollIntervalMs?, forgeInstances? })` creates its own SQLite via `createDb`. Process `index.ts` uses `SQLITE_PATH ?? ':memory:'`, and passes `WEB_DIST` / `VITE_DEV_TARGET` / `pollIntervalMs` / `forgeInstances` into `buildApp`. Empty string is treated as omitted for `webDist`/`viteDevTarget`. `forgeInstances` (from `FORGE_INSTANCES`, a JSON array; unset/`''` → `[]`; invalid JSON throws, failing boot) has no dedicated table — it is process config, threaded into both the poller (§ PR polling below) and the webhook receiver (§ webhook below).

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

Session user JSON. Fields: `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`, `trusted_automation` (#16, additive boolean; `users.trusted_automation`, default `false`). When `status` is `待批准`, also `message` `你的账号待正式成员批准后方可认领任务。`.

Unauthenticated: `Accept` containing `application/json` → `401` `{ error: 'unauthorized' }`; otherwise `302` `/login`.

### `PUT /api/v1/me/settings` (#16)

Session cookie. Same gate as `sendUnauthorized`: no session → `401`/`302`; `status === '待批准'` → `401` `{ error: 'unauthorized' }` (a pending session never sees the toggle, same oracle, not the `403` used elsewhere for pending).

Body `{ trusted_automation: boolean }`; non-boolean or missing key → `400` `{ error: 'invalid_body' }`. Sets `users.trusted_automation`. `200` `{ trusted_automation }` (echoes the stored value). Persists across a new `buildApp()` on the same `SQLITE_PATH`. Never returns a forge token.

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

### `POST /api/v1/tasks/import`

Session cookie. Same `active`+`full` gate as create (`403` `{ error: 'forbidden' }`). Unauthenticated: same oracle as `GET /api/v1/me`. Pre-publish draft in `registerTasks`: does **not** insert a `tasks` row and does **not** call `validateToken` (发布即校验 stays on `POST /api/v1/tasks`).

Wire is snake_case. Required: non-empty `issue_url`; `repo.forge` `github` | `gitlab` | `gitea`; non-empty `repo.base_url`; request `credential` `{ profile_id }` XOR `{ token }` (same union as create). `repo.full_name` is optional. Generic parse failure → `400` `{ error: 'invalid_body' }` (no `message`).

`repo.base_url` must parse as `http:` or `https:` with a non-empty hostname; else `400` `{ error: 'invalid_body', message: '仓库地址不是合法的 http 或 https 地址。' }` (before any forge fetch).

Parses `issue_url` with package-level `parseIssueUrl(forge, issue_url)` **before** decrypt. Unparseable → `400` `{ error: 'invalid_body', message: '无法解析 Issue 地址。' }` (zero fetch; no `token 揭示`). If `repo.full_name` is present it must equal the parsed `full_name`; else `400` `{ error: 'invalid_body', message: 'Issue 地址与仓库不匹配。' }`.

Profile path: load `credential_profiles` by id; missing → `400` `{ error: 'invalid_body', message: '所选凭证档案不存在。' }`. Bind `repo.forge` / `repo.base_url` / **parsed** `full_name` to the profile row with exact `===` **before** decrypt; mismatch → `400` `{ error: 'invalid_body', message: '所选凭证档案与仓库不匹配。' }` (no `token 揭示` event). Then `decryptToken`. Inline path: uses the request token as-is and does **not** encrypt (nothing is persisted). Missing or invalid `VAULT_MASTER_KEY` on the profile path → `500` `{ error: 'vault_unconfigured' }`.

Then `createForgeAdapter(repo.forge, { baseUrl: repo.base_url }).importIssue({ token }, issue_url)`. Forge HTTP 404 or 410 → `404` `{ error: 'issue_not_found', message: '无法读取该 Issue。' }`. Forge HTTP 401 → `422` `{ error: 'token_check_failed', missing: ['读'], message: 'token 无效或无权读取该 Issue。' }`. Other non-OK forge status or a network throw → `502` `{ error: 'forge_unreachable', message: '无法连接 forge 导入 Issue。' }`.

Profile path writes `events.type` `token 揭示` after decrypt (including 404 / 422 / 502): `details` `{ profile_id, forge, base_url, full_name, outcome }` with `outcome` `ok` | `issue_not_found` | `token_check_failed` | `forge_unreachable`. `profile_id` is the integer profile PK. No token / ciphertext / `agent_key_id` in details. Inline path does not write this event.

`200` `{ title, description_md, source: { type: 'imported', issue_url }, repo: { forge, base_url, full_name } }` (`full_name` is the parsed/imported name; `forge`/`base_url` echo the request). Not a Task Brief. Nested objects must not contain keys `token` / `token_encrypted` / `inline_token_encrypted` / `access_token`. This `200` never contains a forge token.

### `PATCH /api/v1/tasks/:publicId`

Session cookie. Same `active`+`full` gate (`403` `{ error: 'forbidden' }`). Body `{ status }`; `status` must be a `taskStatusSchema` value else `400` `{ error: 'invalid_body' }`. Missing `public_id` → `404` `{ error: 'not_found' }`. Non-poster → `403` `{ error: 'forbidden' }`.

Poster-only edges in source: `待认领` → `已取消`; `已退回` → `已取消` | `待认领`. Other requested statuses (including `待认领` → `进行中`) → `409` `{ error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「${to}」。' }`. Success writes `events.type` `状态迁移`, `details` `{ task_id, from, to }` (`task_id` is the `public_id` string) and returns `200` the updated brief. `@kaola/web` poster board detail now calls this existing route (取消 → `{ status: '已取消' }`; 重新开放 → `{ status: '待认领' }`); the wire contract is unchanged.

### `POST /api/v1/tasks/:publicId/claim`

Bearer only (`addAgentBearerHook` from `agent-bearer.ts`, registered in the `claim.ts` child plugin; session cookie does not authorize). `:publicId` is `kt-YYYY-NNNN`. Auth runs before resource lookup.

Body `{ autonomous?: boolean }` (#16). Missing body, non-object body, or a non-boolean `autonomous` key is treated as **instructed** (`autonomous` `undefined`) — the pre-#16 behavior below is unchanged in every way for an instructed claim (still 认领即授权, still `201` on the first `待认领`→`进行中` transition). `autonomous: false` is also instructed.

When `autonomous === true` **and** the claiming Agent's user has `trusted_automation !== true` — checked *after* the `待批准` `403` gate below, *before* the resource/lease logic that produces `201` — the claim does not reveal a token:

- An existing `claim_confirmations` row in state `'approved'` for this exact `(task, user, agent_key)` triple is consumed (row deleted — one-time use, so a later `release` + re-claim cannot ride the same approval again) and the claim proceeds to the normal `201` flow below.
- Otherwise: a `'pending'` row for that triple is inserted (or, if one already exists, reused as-is — a repeated pending request is idempotent and does not duplicate the row or the event), `events.type` `认领待确认` is written (`details` `{ task_id, agent_key_id }`, `actor_user_id` the claiming user), and the response is `202` `{ error: 'confirmation_required', message: '该任务的自动认领需要你先在网页端确认，请到「待确认认领」列表批准或拒绝。', pending: true }`. No `token`, no `token 揭示` event, no lease inserted, task status stays `待认领`.

`autonomous: true` from a user with `trusted_automation === true` skips the confirmation gate entirely and always reaches the normal `201` flow (same as an instructed claim). `trusted_automation` defaults `false` — every user needs an explicit `PUT /api/v1/me/settings` before an autonomous claim can go straight through.

`201` exact keys `clone`, `lease`, `task`, `token`:

- `task` — existing 15-key Task Brief (`parseTaskBrief`); `status` `进行中`; `credential` remains `{ profile_id }` or `{ inline: true }` (no token inside `task`)
- `token` — forge plaintext (one of two reveal channels; the other is MCP `claim_task` success `token`)
- `lease` — `{ expires_at, ttl_seconds }` with `ttl_seconds` the number `86400` (`LEASE_TTL_SECONDS`). `expires_at` is ISO-8601 from unix `(now + 86400) * 1000`
- `clone` — `{ suggested_dir, token_usage }` where `suggested_dir` equals `task.repo.suggested_dir` and `token_usage` is exactly `token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。`

Do not put forge plaintext inside `task` / `lease` / `clone`. Nested objects must not contain keys `token` / `token_encrypted` / `inline_token_encrypted` / `access_token`.

Pending `users.status === '待批准'` → `403` `{ error: 'forbidden', message: '你的账号待正式成员批准后方可认领任务。' }` (no forge token; no `token 揭示`) — checked before the #16 autonomous/confirmation gate above, so a pending user gets `403` even with `autonomous: true`. Unknown `publicId` or numeric PK with a valid Bearer → `404` `{ error: 'not_found' }`. Second claim while `进行中` → `409` `{ error: 'conflict', message: '任务已被认领。' }`. Claim when status is not `待认领` (and not the `进行中` conflict above) → `409` `{ error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「进行中」。' }`. Missing/invalid `VAULT_MASTER_KEY` on decrypt → `500` `{ error: 'vault_unconfigured' }`. Unauthenticated / wrong / non-Bearer / session-cookie-only → `401` `{ error: 'unauthorized' }` + `WWW-Authenticate: Bearer`.

Holder identity for later progress/release is `leases.claimer_user_id` compared to the Agent user id (`claim.ts`).

Writes (successful `201` claim): `events.type` `token 揭示` then `状态迁移`. See Events below. Inserts one `leases` row `state` `'active'` keyed by integer `tasks.id`. Calls `sweepExpiredLeases` first (check-on-write). Does not call `validateToken`. `claimTask` (`apps/server/src/claim.ts`) is `async`, and after the `状态迁移` write it `await`s `attemptWriteback(db, updated, '认领', auth.user.id)` (#14, no-op for a native task; see "Status write-back" below) — the `201` response shape and its `token` are unaffected by that call's outcome. A parked `202` (#16) writes only `认领待确认` and touches neither `leases` nor `attemptWriteback`.

`registerClaim(app, db)` is wired in `app.ts` after `registerTasks`.

### `GET /api/v1/claim-confirmations`, `POST /api/v1/claim-confirmations/:id/approve`, `POST /api/v1/claim-confirmations/:id/reject` (#16, `registerClaimConfirmations` in `apps/server/src/claim-confirmations.ts`)

Session cookie only (`requireActiveSessionUser`: no session or `status === '待批准'` → `sendUnauthorized`, same `401`/`302` oracle as `GET /api/v1/me` — **not** the claim route's `403`). A Bearer Agent Key alone does not authorize these three routes.

`GET` → `200` `{ confirmations: [{ id, task_id, state, created_at }] }` (`task_id` is the task's `public_id` via a join; `state` `'pending'` | `'approved'` | `'rejected'`), scoped to `claim_confirmations.user_id === ` the session user's id — one user never sees another user's rows.

`POST …/approve` → sets that row's `state` to `'approved'`, writes `events.type` `认领已确认` (`details` `{ task_id, agent_key_id }`, `actor_user_id` the approving session user), `200` `{ ok: true }`. Does **not** itself insert a lease, flip the task's status, or decrypt/reveal a forge token — it only flips the row an autonomous re-claim will later consume (see the claim section above). A non-integer id, a missing row, or a row owned by a different user → `404` `{ error: 'not_found' }` (no distinction between "doesn't exist" and "not yours").

`POST …/reject` → sets `state` to `'rejected'`, `200` `{ ok: true }`, no event write. Same `404` rule as approve. A rejected row is left in place (not deleted); a subsequent autonomous claim attempt on the same `(task, user, agent_key)` triple ignores it and inserts a fresh `'pending'` row (rejection is not remembered as a standing denial).

None of the three responses ever contains a forge token, `token_encrypted`, `inline_token_encrypted`, or `access_token`.

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
| `claim_task` | `task_id`, `autonomous?` (boolean, #16) | Success: same envelope as REST claim `201` — keys `clone`, `lease`, `task`, `token`. Tool description includes `CLONE_TOKEN_USAGE` (`token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。`) and explains `autonomous`. `autonomous: true` from a non-`trusted_automation` user is **not** an error result — `isError` is `false`/absent and `structuredContent` is `{ error: 'confirmation_required', message, pending: true }` (same body as REST `202`; no `token`). |
| `report_progress` | `task_id`, `note?` | `{ task, lease }` (no `token`). Omit `note` → event `note` `''`. |
| `release_task` | `task_id`, `reason?` | `{ task }` with `status` `待认领` (no `token`, no `lease`). Omit `reason` → event details have no `reason` key. |
| `submit_pr` | `task_id`, `pr_url`, `summary` | `{ task, pr_url, summary }` with `task.status` `待验收` (no `token`). Inserts `submissions` (`pr_state` `'open'`), marks the live lease `'released'`. `submitPr` (`claim.ts`) is `async` and, after its `状态迁移` write, `await`s `attemptWriteback(db, updated, '提交PR', auth.user.id, prUrl)` (#14; no-op for a native task) before returning — the response shape is unaffected. |

`list_tasks` / `get_task_brief` / mutating tools call `sweepExpiredLeases` first. Claim/progress/release/submit wrap `claimTask` / `reportProgress` / `releaseTask` / `submitPr` (same REST error bodies: pending claim `forbidden` + `你的账号待正式成员批准后方可认领任务。`; second claim `conflict` + `任务已被认领。`; non-holder `forbidden` without `message`; no live lease `conflict` + `任务未被认领。`; `submit_pr` when status is not `进行中` → `illegal_transition` to `待验收`).

`registerMcp(app, db)` is wired in `app.ts` after `registerClaim`.

### `GET /api/v1/events`, `GET /api/v1/stats` (#15, `registerEvents` in `apps/server/src/events.ts`)

Session cookie only. Gate `canReadEvents`: `user.status !== '待批准'` — stricter than `GET /api/v1/tasks` (which a `待批准` user may read); no session or a pending session → `401` `{ error: 'unauthorized' }` (same `sendUnauthorized` oracle as `GET /api/v1/me`, so a non-JSON `Accept` gets `302 /login` instead). Any other logged-in user — `active`+`full` or `active`+`claim_only` — may read both. No query string on either route; every filter is client-side in `@kaola/web`.

`GET /api/v1/events` → `200` `{ events: [<EventRow>] }`, newest-first (`orderBy(desc(events.id))`). `EventRow` keys exactly `id`, `type`, `actor_user_id`, `actor_username`, `created_at`, `details`: `id`/`type`/`created_at` (ISO-8601, from stored unix seconds) as stored; `actor_user_id` is `events.actor_user_id` (`null` for a system-driven row); `actor_username` is resolved via a `leftJoin` on `users` (`null` when `actor_user_id` is `null`, since no login is ever deleted); `details` is `JSON.parse`d (a parse failure or non-object/array value degrades to `{}`, never throws). Never contains a forge token — this route only ever surfaces what the writers below already put in `events.details` (never plaintext).

`GET /api/v1/stats` → `200` exactly `{ completed_count, completed_by_username }`. Selects `events` where `type === '状态迁移'`, then in-process counts rows whose parsed `details.to === '已完成'`: `completed_count` is that count; `completed_by_username` groups the same rows by `actor_username` (`leftJoin` on `users`), with a `null` actor (system-driven completion, i.e. every existing `applyPrTerminalTransition` merge) grouped under the literal key `'系统'` — not under `null` and not omitted. A task whose `tasks.status` is `已完成` but that has no matching `状态迁移`→`已完成` event (e.g. a row forced by direct SQL, or a future writer that forgets to write the event) is **not** counted — this endpoint counts events, not `tasks` rows. Empty DB → `{ completed_count: 0, completed_by_username: {} }`.

### PR polling (`pollPendingReviews`, not an HTTP route)

`pollPendingReviews(db: AppDb, forgeInstances?: ForgeInstanceConfig[]): Promise<void>` (`apps/server/src/poller.ts`) drives `待验收` → `已完成`/`已退回` for every task **not** managed by a `syncMode: 'webhook'` instance (see the webhook section below for the second driver, added in #13). It is never itself exposed over HTTP; it runs either on direct call (tests) or on an interval registered by `buildApp({ pollIntervalMs })` (see below).

Each call: selects `tasks` where `status === '待验收'`; skips any task whose `(repoForge, repoBaseUrl)` exactly matches a `forgeInstances` entry with `syncMode === 'webhook'` (`isWebhookManaged` / `taskMatchesForgeInstance`; zero fetches for that task — the webhook receiver is expected to complete it instead). For the rest: reads the latest `submissions` row for that task (`orderBy(desc(submissions.id)).limit(1)`); decrypts the task's credential (profile or inline — same branch as `claimTask`'s resolution); calls `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl }).getPullRequest({ token }, submission.prUrl)`.

- `state: 'open'` — task and `submissions.pr_state` are left unchanged.
- `state: 'merged'` — `transitionTaskStatus('待验收', '已完成')`; `submissions.pr_state` set to `'merged'`.
- `state: 'closed'` (closed without merging) — transitions to `已退回`; `pr_state` set to `'closed'`.

A successful transition calls `applyPrTerminalTransition(db, task, submissionId, terminal, prUrl)` (exported from `poller.ts`, also reused by the webhook receiver), which in one `db.transaction` writes the two updates above plus `events.type` `状态迁移`, `actor_user_id` `null` (system-driven, same shape as lease-expiry events), `details` `{ task_id, from: '待验收', to, pr_url }` (`task_id` is the `public_id` string; there is no `summary` key here, unlike MCP `submit_pr`'s own `状态迁移` event). After that transaction commits, `applyPrTerminalTransition` `await`s `attemptWriteback(db, task, '完成', null, prUrl)` **only when `terminal === 'merged'`** (#14; never on `closed`/已退回; see "Status write-back" below) — never inside the transaction, so no SQLite write lock is held across the outbound HTTP call.

Never throws: a missing/undecryptable credential, an unreachable forge, a non-OK forge response, or a DB fault while writing one task's row is caught and only that task is skipped — the remaining `待验收` tasks are still polled in the same call, and `pollPendingReviews` itself always resolves. Tasks in any other status are never selected and never fetched as a PR. The pre-existing poster `PATCH /api/v1/tasks/:publicId` `已退回` → `待认领` edge is unaffected by, and works after, a poller-driven `已退回`; prior `状态迁移` events and the `submissions` row survive that reopen unmodified.

`buildApp({ pollIntervalMs?, forgeInstances? })`: `pollIntervalMs` omitted or `<= 0` registers no timer. A positive number registers exactly one `setInterval(fn, pollIntervalMs)` inside its own child plugin context (so its `onClose` hook — which `clearInterval`s — runs before the root db-close hook regardless of registration order); an in-flight guard skips a tick if the previous pass has not finished, so an overrunning poll is never re-entered. `app.close()` clears the timer. `forgeInstances` (same array passed to `registerWebhooks`, below) is threaded into every `pollPendingReviews(db, forgeInstances)` call the timer makes. Process `index.ts` reads `POLL_INTERVAL_MS` (unset or `''` → `60000`; otherwise `Number.parseInt(value, 10)`) and `FORGE_INSTANCES` (JSON array; unset/`''` → `[]`; invalid JSON throws, failing boot) and passes them as `pollIntervalMs` / `forgeInstances`.

There is still no REST `POST /api/v1/tasks/:publicId/submit_pr`. `pollPendingReviews` and the webhook receiver together are the only things that ever move a task out of `待验收`.

### `POST /api/v1/webhooks/:publicId` (`registerWebhooks`, #13)

`registerWebhooks(app, db, forgeInstances?)` (`apps/server/src/webhook.ts`), wired in `app.ts` after `registerMcp`. No session cookie, no Bearer — the forge signature is the sole authentication. `:publicId` identifies an entry in `forgeInstances` (`{ publicId, forge, baseUrl, syncMode, webhookSecret }`), **not** a task's `public_id`.

The route is registered inside its own child plugin with a dedicated `addContentTypeParser('application/json', { parseAs: 'string' }, ...)` so the exact raw request body string reaches the handler for signature verification — this parser override applies only to this route, not to any other route in the app.

- Unknown `publicId` (no `forgeInstances` entry) → `404` `{ error: 'not_found' }`. No signature is checked first.
- The matched instance's `createForgeAdapter(instance.forge, { baseUrl: instance.baseUrl, webhookSecret: instance.webhookSecret }).parseWebhook(headers, request.body)` is called (`headers` built as a Web `Headers` from Fastify's `request.headers`). A thrown `WebhookSignatureError` → `401` `{ error: 'invalid_signature' }` (never leaks the secret, an expected digest, or a forge token). Any other thrown error propagates (500).
- `parseWebhook` returning `null` (ping, non-`pull_request`/`Merge Request Hook` event, non-terminal action/state, or an unparseable-but-signed payload) → `204` empty body.
- On a concrete `ForgeEvent`: `findPendingReviewMatch(db, instance, event.pr_url)` first restricts candidate tasks to `待验收` rows whose `(repoForge, repoBaseUrl)` match the **signature-verified** instance (`taskMatchesForgeInstance`), then matches the latest `submissions.prUrl` (`latestSubmission`) against `event.pr_url`. No match (wrong instance, no `pr_url` match, or the task is no longer `待验收`) → `204`, no writes — a valid forge delivery is never 404'd.
- On match: `applyPrTerminalTransition(db, task, submissionId, event.state, event.pr_url)` (the same helper the poller uses) writes `tasks.status` → `已完成`/`已退回`, `submissions.pr_state` → `merged`/`closed`, and one `状态迁移` event (`actor_user_id: null`, `details: { task_id, from, to, pr_url }`) in one transaction, then `204`.

This route itself never calls `adapter.getPullRequest` — the signed payload alone is the source of truth for merge/close, so no forge round-trip is needed to *decide* the transition. It is not a third token-reveal channel: nothing in a `404`/`401`/`204` response contains a token, the `webhookSecret`, or ciphertext. That said, on a `merged` delivery `applyPrTerminalTransition` does now (#14) `await attemptWriteback(db, task, '完成', null, event.pr_url)` once its transaction has committed, which **does** decrypt the task's forge credential in order to post the 完成 comment via `commentOnIssue` — the same decrypt-to-call-the-forge pattern the poller already used for `getPullRequest`, just newly reached from this route. The token from that decrypt still never appears in this route's `204` response, in a log, or in `events.details` (only `{ task_id, transition, ok: true, issue_url }`). A `closed` (已退回) delivery still never writes back and still never decrypts anything.

A `syncMode: 'poll'` instance's webhook deliveries are still accepted and can still complete a task (harmless and idempotent) — `syncMode` only gates whether `pollPendingReviews` also polls that instance, not whether this route accepts its deliveries.

### Status write-back (`attemptWriteback` / `retryPendingWritebacks`, #14, not an HTTP route)

`apps/server/src/writeback.ts` exports `attemptWriteback(db: AppDb, task: Task, transition: '认领' | '提交PR' | '完成', actorUserId: number | null, prUrl?: string): Promise<void>`. It is a no-op for a native task (`task.sourceType !== 'imported'` or empty `task.sourceIssueUrl`) — zero forge calls, zero `events` rows. For an imported task it builds a Chinese status comment (always contains `task.publicId` and `PUBLIC_URL`, trailing slash trimmed, default `http://localhost:31415`; the 提交PR and 完成 bodies also contain the given `prUrl`) and calls `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl }).commentOnIssue({ token }, { issue_url: task.sourceIssueUrl }, body)`, where `token` comes from `decryptTaskToken(db, task)` (moved here from `poller.ts`; the poller still imports it for its own `getPullRequest` call) — the task's own profile/inline credential, never the caller's Agent API key.

Every failure — `decryptTaskToken` returning `undefined`, a thrown `commentOnIssue` (non-OK response or unparseable `issue_url`) — is caught inside `attemptWriteback` and swallowed; nothing propagates to the caller. On success it writes `events.type` `回写`, `details` **exactly** `{ task_id, transition, ok: true, issue_url }` (`task_id` is the `public_id` string; `issue_url` is `task.sourceIssueUrl`; no token, no ciphertext).

Three call sites, each after its own status transition is already committed (never inside a `db.transaction`, never holding a SQLite write lock across the outbound HTTP call):

| Call site | Transition | `actorUserId` |
|---|---|---|
| `claimTask` (`claim.ts`, both REST claim and MCP `claim_task` share this function) | `'认领'` | the claiming user |
| `submitPr` (`claim.ts`, MCP `submit_pr` only — no REST route) | `'提交PR'` | the claiming user |
| `applyPrTerminalTransition` (`poller.ts`, shared by `pollPendingReviews` and the webhook receiver) — only when `terminal === 'merged'` | `'完成'` | `null` |

`已退回` (`terminal === 'closed'`) and `releaseTask` never call `attemptWriteback`. `claimTask` and `submitPr` are `async` as of #14; `registerClaim` and the MCP `claim_task`/`submit_pr` tool handlers `await` them, but their response shapes (`201` claim envelope; `{ task, pr_url, summary }`) are unchanged.

`retryPendingWritebacks(db: AppDb): Promise<void>` (exported from `writeback.ts`, re-exported from `poller.ts`; never rejects — a DB fault or one task's fault only skips that task) scans every `imported` task and, for each transition that has already occurred but has no successful `回写` event yet, calls `attemptWriteback` again with a `null` actor:

- 认领 occurred: a `状态迁移` event with `details.to === '进行中'` exists for that task.
- 提交PR occurred: a `submissions` row exists for that task.
- 完成 occurred: `task.status === '已完成'` (uses the latest `submissions.prUrl`).

A transition with an existing successful `回写` (`details.ok === true` for that `task_id` + `transition`) is never retried again. `apps/server/src/app.ts`'s existing poller `setInterval` calls `retryPendingWritebacks(db)` every tick, sequentially right after `pollPendingReviews`, under the same in-flight guard (`.then(() => retryPendingWritebacks(db).catch(() => {}))`).

Web has no vue-router and no `/tasks/:id` route, so the comment body never contains a task deep link — only `PUBLIC_URL` plus the `publicId` text.

### `users` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS users`): `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`, `trusted_automation INTEGER NOT NULL DEFAULT 0` (#16); UNIQUE `(provider, remote_id)`. On an existing sqlite file predating #16 (where `CREATE TABLE IF NOT EXISTS` is a no-op), `createDb` also runs `ALTER TABLE users ADD COLUMN trusted_automation INTEGER NOT NULL DEFAULT 0` and swallows the resulting "duplicate column name" error on a file that already has it (idempotent either way).

Drizzle enums in `apps/server/src/schema.ts`: `provider` `github` | `gitlab` | `gitea`; `status` `active` | `待批准`; `permission_level` `full` | `claim_only`. `trusted_automation` is `integer(..., { mode: 'boolean' })`, default `false`.

First insert (`mapProfile`): GitHub → `status` `待批准`, `permission_level` `claim_only`; GitLab / Gitea → `active` + `full`. `trusted_automation` always starts `false` regardless of provider. Subsequent login updates `username` and `display_name` only (not `trusted_automation`).

### `claim_confirmations` table (#16)

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS claim_confirmations`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `task_id INTEGER NOT NULL` (integer `tasks.id`, not `public_id`), `user_id INTEGER NOT NULL`, `agent_key_id INTEGER NOT NULL`, `state TEXT NOT NULL`, `created_at INTEGER NOT NULL`. No unique constraint — `claimTask` and `registerClaimConfirmations` both enforce "at most one live (`'pending'`) row per `(task_id, user_id, agent_key_id)`" in application code (`findClaimConfirmations`), not in the schema.

Drizzle enum in `schema.ts`: `state` `'pending' | 'approved' | 'rejected'`. A `'pending'` row for the same triple is reused (never duplicated) by a repeated autonomous claim. An `'approved'` row is deleted (not transitioned to some other state) the moment a claim consumes it, so it can never grant a second free claim. A `'rejected'` row is left in place and simply ignored by both an instructed claim and a fresh autonomous claim attempt (which inserts a new `'pending'` row alongside it).

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

`task_id` is the integer `tasks.id` PK, not `public_id`. Drizzle in `schema.ts` maps `taskId`/`leaseId`/`prUrl`/`summary`/`prState` with no enum on `pr_state`. MCP `submit_pr` success inserts `pr_state` `'open'`. `pollPendingReviews` later updates that same row's `pr_state` to `'merged'` or `'closed'` (never back to `'open'`) once the PR leaves the open state.

### `events` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS events`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `type TEXT NOT NULL`, `actor_user_id INTEGER`, `created_at INTEGER NOT NULL`, `details TEXT NOT NULL`.

`GET /api/v1/events` / `GET /api/v1/stats` (#15, above) are read-only surfaces over this table — nothing here changes what gets written. Rows written in source:

- profile create/delete: `type` `变更`, `details` JSON `{ "action": "create" | "delete", "profile_id": <n> }`
- `revealCredentialProfile`: `type` `token 揭示`, `details` JSON `{ "agent_key_id": <n>, "profile_id": <n> }`
- POST `/api/v1/tasks` profile path (after decrypt, including 422 / 502): `type` `token 揭示`, `details` JSON `{ "profile_id": <n>, "forge": <forge>, "base_url": <string>, "full_name": <string>, "outcome": "ok" | "token_check_failed" | "forge_unreachable" }` (no token; no `agent_key_id`; inline path does not write this)
- POST `/api/v1/tasks/import` profile path (after decrypt, including 404 / 422 / 502): `type` `token 揭示`, `details` JSON `{ "profile_id": <n>, "forge": <forge>, "base_url": <string>, "full_name": <string>, "outcome": "ok" | "issue_not_found" | "token_check_failed" | "forge_unreachable" }` (no token; no `agent_key_id`; inline path does not write this)
- PATCH `/api/v1/tasks/:publicId` success: `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": <status>, "to": <status> }`
- POST `/api/v1/tasks/:publicId/claim` `201` success: `type` `token 揭示`, `details` JSON `{ "task_id": <public_id>, "agent_key_id": <n>, "credential": "inline" | "profile", "profile_id"? }` (`profile_id` only when `credential === 'profile'`, integer profile PK; no plaintext, no ciphertext) then `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": <status>, "to": <status> }` (claimer `actor_user_id`)
- POST `/api/v1/tasks/:publicId/claim` `202` pending (#16, `autonomous: true` + not `trusted_automation`, no existing `'approved'` row): `type` `认领待确认`, `details` JSON `{ "task_id": <public_id>, "agent_key_id": <n> }` (claimer `actor_user_id`; no `token 揭示`, no `状态迁移` — the task never leaves `待认领`)
- POST `/api/v1/claim-confirmations/:id/approve` success (#16): `type` `认领已确认`, `details` JSON `{ "task_id": <public_id>, "agent_key_id": <n> }` (approving session user `actor_user_id`); reject writes no event
- POST `/api/v1/tasks/:publicId/progress` success: `type` `心跳`, `details` JSON `{ "task_id": <public_id>, "note": <string> }` (`note` is `''` when omitted)
- POST `/api/v1/tasks/:publicId/release` success: `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": <status>, "to": <status>, "reason"? }` (`reason` only when body had string `reason`)
- MCP `submit_pr` success (`submitPr` in `claim.ts`): `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": "进行中", "to": "待验收", "pr_url": <string>, "summary": <string> }` (claimer `actor_user_id`)
- lease expiry in `sweepExpiredLeases`: `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": "进行中", "to": "待认领" }`, `actor_user_id` null
- `applyPrTerminalTransition` merged/closed transition (`poller.ts`, shared by `pollPendingReviews` and `registerWebhooks`'s `POST /api/v1/webhooks/:publicId`, #13): `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": "待验收", "to": "已完成" | "已退回", "pr_url": <string> }` (no `summary` key), `actor_user_id` null
- `attemptWriteback` success (`writeback.ts`, #14; imported tasks only, on 认领 / 提交PR / 完成-when-merged): `type` `回写`, `details` JSON `{ "task_id": <public_id>, "transition": "认领" | "提交PR" | "完成", "ok": true, "issue_url": <string> }` (no token; `actor_user_id` is the acting user for 认领/提交PR, `null` for 完成 and for any `retryPendingWritebacks`-driven write-back). A failed attempt writes no event at all (retried later, not marked `ok: false`).

`created_at` is unix seconds.

### Vault (`apps/server/src/vault.ts`)

`encryptToken(plaintext: string): string` / `decryptToken(encoded: string | Buffer): string`. Algorithm `'aes-256-gcm'`, `{ authTagLength: 16 }`, IV `randomBytes(12)`. Stored blob is `iv || ciphertext || tag` as base64 TEXT in `token_encrypted`.

`insertAuditEvent(db, { type, actorUserId, details })` with `actorUserId: number | null` (expiry writes SQL NULL).

`revealCredentialProfile(db, { profileId, actorUserId, agentKeyId })` decrypts the profile row and returns the plaintext string. Missing row throws `Error('credential profile not found')`. Writes a `token 揭示` event. Does not log the token. Not an HTTP handler. Forge token reveal channels: successful Bearer `POST /api/v1/tasks/:publicId/claim` `201` top-level `token` and MCP `claim_task` success `token`. `POST /api/v1/tasks/import` `200` never contains a forge token. `apps/server/src/writeback.ts`'s `decryptTaskToken(db, task)` (used by `attemptWriteback`, #14) decrypts the task's own credential the same way `claimTask` does, but resolves to `undefined` on any failure instead of throwing, and does not write a `token 揭示` event (that event denotes a reveal to a principal; write-back's decrypt, like the poller's, never returns the plaintext anywhere).

### Env (`registerAuth`)

Required (throw `missing required environment variable …` if empty): `SESSION_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`, `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL`.

Optional: `PUBLIC_URL` default `http://localhost:31415` (trailing slash stripped). Process `index.ts`: `PORT` default `'31415'`, `HOST` default `'0.0.0.0'`, `SQLITE_PATH` default `':memory:'`. Optional `WEB_DIST` and `VITE_DEV_TARGET` (not required by `registerAuth`).

Callback URIs: `${publicUrl}/login/{github|gitlab|gitea}/callback` (`publicUrl` is the trimmed `PUBLIC_URL`). Post-login redirect is still `reply.redirect('/')` (relative).

### Env (`VAULT_MASTER_KEY`)

Read by `encryptToken` / `decryptToken` in `vault.ts` when encrypting or decrypting. Not required at `buildApp()` or `registerAuth` boot.

Must match `/^[0-9a-fA-F]{64}$/` and decode to 32 bytes. Missing, empty, or invalid → `VaultUnconfiguredError` (`code` `vault_unconfigured`). Create-profile HTTP, `POST /api/v1/tasks`, `POST /api/v1/tasks/import` (profile decrypt), `POST /api/v1/tasks/:publicId/claim`, and MCP `claim_task` (same `claimTask` decrypt) map that to `500` `{ error: 'vault_unconfigured' }` (MCP: `isError` + that body, HTTP 200). Not `SESSION_SECRET`.

There is no `.env.example` in the repository.

Server dependencies: `@fastify/oauth2@^8.3.0`, `@fastify/cookie@^11.1.2`, `@fastify/session@^11.1.2`, `@fastify/static@^10.1.3`, `@fastify/http-proxy@^11.6.0`, `"@kaola/shared": "workspace:*"`, `"@kaola/forge-adapters": "workspace:*"`, `"@modelcontextprotocol/sdk": "1.30.0"`, `"zod": "^4.4.3"` (plus existing `fastify`, `drizzle-orm`, `better-sqlite3`). Vault and agent-key hashing use `node:crypto` (no extra npm package). Agent Bearer is the encapsulated hook in `agent-bearer.ts`, not `@fastify/bearer-auth`.

## `@kaola/forge-adapters`

Package export `"."` → `./src/index.ts`. No runtime HTTP dependency (global `fetch`).

- `getForgeAdaptersHealth(): string` → `'kaola-forge-adapters-ready'`
- `createForgeAdapter(kind, options?: { baseUrl?: string; webhookSecret?: string }): ForgeAdapter`
- `parseIssueUrl(kind, issueUrl): { full_name: string } | undefined`
- `class WebhookSignatureError extends Error` (`name === 'WebhookSignatureError'`, default message `'invalid webhook signature'`)

Unknown `kind` to `createForgeAdapter` throws `Error('unknown forge kind: …')`.

`validateToken`, `importIssue`, `registerWebhook`, `parseWebhook`, `commentOnIssue` are `ForgeAdapter` methods, not package-level exports. `parseIssueUrl(kind, issueUrl): { full_name: string } | undefined` **is** a package-level export (same Issue URL parsers as `importIssue`).

Types: `ForgeKind` `'github' | 'gitlab' | 'gitea'`; `Credential` `{ token: string }`; `RepoRef` `{ full_name: string; base_url: string }`; `TokenCapability` `'读' | '推' | 'PR'`; `TokenCheck` `{ missing: TokenCapability[] }`; `CreateForgeAdapterOptions` (`{ baseUrl?: string; webhookSecret?: string }`); `ForgeAdapter`.

`ImportedIssue` is `{ title: string; description_md: string; issue_url: string; repo: { full_name: string } }` (no longer `unknown`, #12). `PrStatus` is `{ state: 'open' | 'merged' | 'closed' }` (no longer `unknown`, #11). `ForgeEvent` is `{ type: 'pull_request'; state: 'merged' | 'closed'; pr_url: string; repo: { full_name: string } }` (no longer `unknown`, #13) — `parseWebhook` returns this or `null`. `IssueRef` is `{ issue_url: string }` (no longer `unknown`, #14).

Implemented: `kind` + `validateToken` (GET-only) + `getPullRequest` (GET-only, #11) + `importIssue` (GET-only, #12) + `registerWebhook` (POST, #13) + `parseWebhook` (no fetch, #13) + `commentOnIssue` (POST, #14).

API hosts: GitHub always `https://api.github.com` (ignores `baseUrl`). GitLab: strip trailing slashes then `/api/v4`. Gitea: `/api/v1`. GitLab/Gitea origin is `options?.baseUrl ?? repo.base_url`. GitLab repo path: `/projects/${encodeURIComponent(full_name)}`. GitHub/Gitea repo path: `/repos/${full_name}`. User path: `/user`. `registerWebhook`'s host rule is the same: GitHub always `https://api.github.com`, GitLab/Gitea use constructor `options.baseUrl`. `parseWebhook` never fetches.

### `parseWebhook(headers, body)` and `registerWebhook(cred, repo, callback)` (#13)

`parseWebhook(headers: Headers, body: unknown): ForgeEvent | null`. `body` is the **raw** request body (`string` or `Buffer`) — verification happens before `JSON.parse`, never against a re-serialized object. `options.webhookSecret` missing or `''` throws `WebhookSignatureError` before any header is read.

Per-kind signature check (all via `node:crypto`'s `createHmac`/`timingSafeEqual`, with a length-check wrapper before `timingSafeEqual` so mismatched-length buffers return `false` instead of throwing):

- GitHub: header `x-hub-signature-256`, expected value `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`. Missing header or mismatch → `WebhookSignatureError`.
- GitLab: header `x-gitlab-token`, compared directly (timing-safe) to `webhookSecret` — a plaintext-token check, not HMAC (GitLab's newer `webhook-signature`/`signing_token` scheme is out of scope for this issue). Missing header or mismatch → `WebhookSignatureError`.
- Gitea: header `x-gitea-signature`, expected value `createHmac('sha256', secret).update(rawBody).digest('hex')` — **no** `sha256=` prefix (unlike GitHub). Missing header or mismatch → `WebhookSignatureError`.

After signature verification, `JSON.parse(rawBody)` (parse failure → `null`, not a throw). Event mapping:

- GitHub/Gitea (`mapGithubShapedEvent`): header `x-github-event`/`x-gitea-event` must equal `'pull_request'`; payload `action` must equal `'closed'`; `state` is `'merged'` iff `pull_request.merged === true`, else `'closed'`; `pr_url` = `pull_request.html_url`; `repo.full_name` = `repository.full_name`. Any missing/wrong-typed field → `null`.
- GitLab (`mapGitlabEvent`): header `x-gitlab-event` must equal `'Merge Request Hook'`; `object_attributes.state` must be `'merged'` or `'closed'`; `pr_url` = `object_attributes.url`; `repo.full_name` = `project.path_with_namespace`. Any missing/wrong-typed field → `null`.

`registerWebhook(cred, repo, callback)`: one `POST`, non-OK response rejects with `registerWebhook: ${kind} responded ${status}`.

- GitHub: `POST https://api.github.com/repos/{encodeURIComponent(owner)}/{encodeURIComponent(name)}/hooks` body `{ name: 'web', events: ['pull_request'], config: { url: callback, content_type: 'json', secret: webhookSecret, insecure_ssl: '0' } }`.
- GitLab: `POST {baseUrl}/api/v4/projects/{encodeURIComponent(repo.full_name)}/hooks` body `{ url: callback, merge_requests_events: true, token: webhookSecret }` (legacy `token` field, not `signing_token`).
- Gitea: `POST {baseUrl}/api/v1/repos/{encodeURIComponent(owner)}/{encodeURIComponent(name)}/hooks` body `{ type: 'gitea', events: ['pull_request'], config: { url: callback, content_type: 'json', secret: webhookSecret }, active: true }` (owner/repo individually `encodeURIComponent`-ed, matching the GitHub branch).

New shared spec `packages/forge-adapters/src/webhook.shared.test.ts`, parameterized over github/gitlab/gitea, copied/trimmed fetch-stub helpers (not imported from `get-pull-request.shared.test.ts`).

Auth headers: GitHub `Authorization: Bearer`, `User-Agent: KaolaTasks`, `Accept: application/vnd.github+json`; GitLab `PRIVATE-TOKEN`; Gitea `Authorization: token`.

Push/PR checks are REST permission proxies, not mutating git push / POST PR.

### `getPullRequest(cred, prUrl)`

`Credential` here carries only a bare `prUrl` string (no `RepoRef`), so owner/repo/number (or namespace/iid) are parsed out of the pasted PR/MR web URL itself, after stripping a trailing slash and (GitHub only) a trailing `.diff`/`.patch` suffix:

- GitHub: `.../{owner}/{repo}/pull/{number}` → `GET https://api.github.com/repos/{owner}/{repo}/pulls/{number}` (host is always `api.github.com`, ignoring `baseUrl`, same as `validateToken`)
- Gitea: `{baseUrl}/{owner}/{repo}/pulls/{number}` → `GET {baseUrl}/api/v1/repos/{owner}/{repo}/pulls/{number}`
- GitLab: `{baseUrl}/{namespace}/-/merge_requests/{iid}` → `GET {baseUrl}/api/v4/projects/{encodeURIComponent(namespace)}/merge_requests/{iid}` (a multi-segment namespace, e.g. `group/subgroup/app`, is encoded as one `:id` path segment)

GitLab/Gitea always use the adapter's constructor `baseUrl` option as the API origin, never the host embedded in `prUrl`. Auth headers reuse the same per-kind scheme as `validateToken`.

State derivation from the response body: GitLab `state === 'merged'` → `merged`; `state === 'closed'` → `closed`; anything else (including the vendor's `'opened'` and the transient `'locked'`) → `open`. GitHub/Gitea: `merged === true` → `merged`; else `state === 'closed'` → `closed`; else `open`.

A non-OK HTTP response rejects (after actually calling `fetch`). An unparseable `prUrl` rejects **without** calling `fetch`.

### `importIssue(cred, issueUrl)`

`Credential` here carries only a bare `issueUrl` string (no `RepoRef`). Host rule matches `getPullRequest` (reuses `prApiOrigin`): GitHub REST origin is always `https://api.github.com`; GitLab/Gitea REST origin is the adapter constructor `options.baseUrl` (trailing slashes stripped), **never** the host embedded in `issueUrl`. A trailing slash is stripped (`replace(/\/+$/u, '')`); query and hash are dropped by `URL.pathname`. Auth headers reuse `forgeGet` / `authHeaders`.

Pathname after strip:

- GitHub / Gitea: `/{owner}/{repo}/issues/{number}` → GitHub `GET https://api.github.com/repos/{owner}/{repo}/issues/{number}`; Gitea `GET {baseUrl}/api/v1/repos/{owner}/{repo}/issues/{number}`
- GitLab canonical: `/{namespace}/-/issues/{iid}` tried **before** legacy `/{namespace}/issues/{iid}` → `GET {baseUrl}/api/v4/projects/{encodeURIComponent(namespace)}/issues/{iid}`

`ImportedIssue` mapping: `title` ← JSON `title` (missing/non-string rejects after the one fetch); `description_md` ← GitLab JSON `description`, GitHub/Gitea JSON `body` (`null` / missing / non-string → `''`); `issue_url` ← the pasted web URL after trailing-slash strip (not API `html_url` / `web_url`); `repo.full_name` ← GitHub/Gitea `owner/repo`, GitLab full namespace.

A non-OK HTTP response rejects after `fetch` with `importIssue: ${kind} responded ${status}`. An unparseable `issueUrl` (including `/pull/`, `/pulls/`, `/-/merge_requests/`, `/-/work_items/` pathnames) rejects **without** calling `fetch`.

### `commentOnIssue(cred, issueRef, body)` (#14)

`IssueRef` is `{ issue_url: string }`. Reuses `resolveImportedIssue` (the same URL-parsing + host/SSRF function `importIssue` uses — GitHub always `https://api.github.com`, GitLab/Gitea use the constructor `baseUrl`, never the pasted `issue_url` host) to get the issue's REST endpoint, then reuses `forgePost` to send `{ body }` as JSON:

- GitHub / Gitea: `POST {issueApiUrl}/comments`
- GitLab: `POST {issueApiUrl}/notes`

Success is any `res.ok` (2xx) response, not a hard-coded status code (GitHub/Gitea document `201`; GitLab's create-note page does not table a status, so production only asserts `res.ok`). A non-OK response rejects after the one `fetch` with `commentOnIssue: ${kind} responded ${status}`. An unparseable `issue_url` (including a pasted PR/MR web path) rejects **without** calling `fetch`. Auth headers reuse the existing `authHeaders()` (same per-kind scheme as every other method: GitHub `Authorization: Bearer`, GitLab `PRIVATE-TOKEN`, Gitea `Authorization: token`).

New shared spec `packages/forge-adapters/src/comment-on-issue.shared.test.ts`, parameterized over github/gitlab/gitea, copied/trimmed fetch-stub helpers (not imported from `import-issue.shared.test.ts`).

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
