# API

Document public APIs, endpoints, schemas, events, and integration contracts.

Product contracts that are not yet in source remain in [DESIGN.md](DESIGN.md) §6 (任务卡 Schema), §8 (ForgeAdapter), §9 (MCP 工具面 / REST). This file records what is implemented.

MCP tools (`list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `submit_pr`, `release_task`) are implemented (`registerMcp` in `apps/server/src/mcp.ts`): device-proof `POST /api/mcp` Streamable HTTP (headers `X-Kaola-Key` / `X-Kaola-Ts` / `X-Kaola-Nonce` / `X-Kaola-Sig`, optional `X-Kaola-Hostname`; `addDeviceProofHook` in `device-proof.ts`). Claim HTTP is also implemented (`registerClaim` in `apps/server/src/claim.ts`): the same device-proof hook on `POST /api/v1/tasks/:publicId/claim`, `…/progress`, `…/release` (no REST `submit_pr`). Unbound but valid signatures answer HTTP `202` `{ error: 'authorization_required', pending: true, expires_at }` and never reach the tools. Forge token reveal channels: successful `POST …/claim` `201` top-level `token` **and** MCP `claim_task` success `token`. Session `GET /api/v1/tasks` and `GET /api/v1/tasks/:publicId` never contain it. `POST /api/v1/tasks/import` `200` never contains a forge token. Task CRUD HTTP is implemented (`registerTasks` in `apps/server/src/tasks.ts`), including the pre-publish draft `POST /api/v1/tasks/import`. `revealCredentialProfile` is a module export from `apps/server/src/vault.ts` (not itself HTTP). Two mechanisms drive `待验收` → `已完成`/`已退回` (#13): PR polling (`pollPendingReviews` in `apps/server/src/poller.ts`, still **not** an HTTP route — either called directly (tests) or driven by an internal `setInterval` registered by `buildApp({ pollIntervalMs })`) and the webhook receiver (`registerWebhooks` in `apps/server/src/webhook.ts`, `POST /api/v1/webhooks/:publicId`, no session, no Bearer — the forge signature is the sole auth). Both share the same terminal-transition write path (`applyPrTerminalTransition`, extracted in `poller.ts`). `buildApp({ forgeInstances? })` lets a `syncMode: 'webhook'` instance opt its repo out of polling (`pollPendingReviews` skips it); a poll-mode or unlisted instance is unaffected. `commentOnIssue` / status write-back to the source Issue is implemented (#14): `attemptWriteback` (`apps/server/src/writeback.ts`, not itself HTTP) posts a status comment for **imported** tasks on 认领 (inside `claimTask`), 提交PR (inside `submitPr`), and 完成 (inside `applyPrTerminalTransition`, only on a `merged` terminal) — see the "Status write-back" section below. It never changes any response shape and never introduces a third token-reveal channel. `GET /api/v1/credential-profiles/:id/issues` (#19) is implemented (`registerCredentialProfiles` in `apps/server/src/credential-profiles.ts`): session `canPublish` (`status === 'active'` and `permission_level` `admin` or `full`), server-side decrypt then `listIssues` (same decrypt-to-call-forge pattern as the poller). It is **not** a third reveal channel: the `200`/`4xx`/`5xx` bodies never contain a token or ciphertext, and this route does **not** write `events.type` `token 揭示` (contrast `POST /api/v1/tasks/import`'s profile path, which still does). Audit log + team stats (#15) are implemented (`registerEvents` in `apps/server/src/events.ts`): session `GET /api/v1/events` and `GET /api/v1/stats`, gated stricter than the task board (a `待批准` session is `401` on both). Claim confirmation for autonomous agents (#16) is implemented: REST `POST …/claim` and MCP `claim_task` both accept an optional `autonomous: boolean`; when `true` and the claiming user's `trusted_automation` is not `true`, the claim parks as `202` `{ error: 'confirmation_required', pending: true }` instead of revealing a token, until an admin session approves it via `registerClaimConfirmations` (`apps/server/src/claim-confirmations.ts`, `GET/POST /api/v1/claim-confirmations*`, `canManageInstance`). That `confirmation_required` string is **not** the device-hook `authorization_required`. `GET /api/v1/me` gains additive `trusted_automation`; session `PUT /api/v1/me/settings` toggles it (admin-only). Device bind/pending/whoami (#23, `registerDevices` in `devices.ts`) never contain a forge token. None of `GET /api/v1/events`, `GET /api/v1/stats`, `GET/POST /api/v1/claim-confirmations*`, `GET /api/v1/me`, `PUT /api/v1/me/settings`, a claim `202`, or `GET /api/v1/credential-profiles/:id/issues` ever contains a forge token — the two reveal channels above are unchanged. Idempotent Claim identity, fenced mutations, and atomic transactions (#36, #31) add an optional `request_id` to claim and an optional `claim_id` to `report_progress` / `release_task` / `submit_pr`, plus new typed errors `claim_request_conflict`, `claim_id_required`, `stale_claim`, `pr_url_invalid`, `pr_url_conflict`, `pr_url_taken`, and `credential_profile_in_use` — none of them ever contains a forge token either. The revealed forge credential is a reusable stored repository credential, not minted per Claim; release and lease expiry revoke only Kaola Tasks' own lifecycle authority and Claim fencing, never the forge token itself (see the claim section below and `docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md`).

## HTTP (`@kaola/server`)

Sources: `apps/server/src/app.ts`, `auth.ts`, `password.ts`, `permissions.ts`, `agent-keys.ts`, `device-proof.ts`, `devices.ts`, `credential-profiles.ts`, `vault.ts`, `tasks.ts`, `claim.ts`, `claim-confirmations.ts`, `leases.ts`, `mcp.ts`, `poller.ts`, `webhook.ts`, `writeback.ts`, `events.ts`, `schema.ts`, `db.ts`, `placeholder.ts`, `index.ts`. `apps/mcp/src/main.ts` is the stdio bridge (`kaola-mcp --url`); `apps/mcp/src/runner-carrier.ts` is the pure explicit-Runner-intent resolver it uses (#34, see [docs/runner-carrier.md](runner-carrier.md)).

`buildApp({ sqlitePath?, webDist?, viteDevTarget?, pollIntervalMs?, forgeInstances? })` creates its own SQLite via `createDb`. Process `index.ts` uses `SQLITE_PATH ?? ':memory:'`, and passes `WEB_DIST` / `VITE_DEV_TARGET` / `pollIntervalMs` / `forgeInstances` into `buildApp`. Empty string is treated as omitted for `webDist`/`viteDevTarget`. `forgeInstances` (from `FORGE_INSTANCES`, a JSON array; unset/`''` → `[]`; invalid JSON throws, failing boot) has no dedicated table — it is process config, threaded into both the poller (§ PR polling below) and the webhook receiver (§ webhook below).

### `GET /`

Depends on hosting options (unauthenticated):

- Omit or empty both `webDist` and `viteDevTarget`: `text/plain; charset=utf-8` body `考拉任务服务占位` (`getPlaceholderBody()`).
- Non-empty `webDist`: `@fastify/static` from that directory; exact `GET /` `sendFile` `index.html`; other GET that are not `/api` or `/login*` fall back to `index.html`. `/api` and `/login*` are not swallowed by the SPA.
- Both `webDist` and `viteDevTarget` set: `webDist` wins.
- Only `viteDevTarget`: `@fastify/http-proxy` to that upstream (`GET`/`HEAD`, websocket).

### `GET /login`

HTML 200 (`text/html; charset=utf-8`). When `countLoginableAdmins` is 0 (no `active`+`admin` row with `provider` `local` | `gitlab` | `gitea`), the body is the setup wizard (`<form method="post" action="/api/v1/setup">`, username/password; no `/login/gitlab` or `/login/gitea` links, no `/login/github`). After at least one loginable admin: local password form (`POST /api/v1/login`) plus links to `/login/gitlab` and `/login/gitea` only.

`@kaola/web` probes `GET /api/v1/setup` and shows card title `初始向导` vs `登录` the same way (no GitHub button).

### `GET /api/v1/setup`

Unauthenticated. `200` `{ setup_complete: boolean }` (`true` iff `countLoginableAdmins > 0`). Never a password, hash, or forge token.

### `POST /api/v1/setup`

JSON `{ username, password }` (`display_name` optional string; if omitted or blank, equals trimmed `username`). When a loginable admin already exists → `409` `{ error: 'setup_complete' }`. Empty/missing `username` or empty `password` → `400` `{ error: 'invalid_body' }`. Success inserts `provider` `'local'`, `remote_id` `'local'`, `status` `'active'`, `permission_level` `'admin'`, stores `password_hash` from `hashPassword` (`apps/server/src/password.ts`, `node:crypto` scrypt, encoded `scrypt$N$r$p$saltHex$keyHex`; N=16384, r=8, p=1, key 32 bytes, salt 16 bytes). Calls `persistSession(..., { skipUntrusted: true })` then writes `events.type` `管理员创建`, `details` `{ user_id }` (no password/hash), `201` the same public user JSON as `GET /api/v1/me`. An untrusted HTTP peer with `PUBLIC_URL` https does not get `Set-Cookie`; the `201` body still returns. Concurrent second insert → `409` `{ error: 'setup_complete' }`. Response never includes `password` / `password_hash`.

### `POST /api/v1/login`

JSON `{ username, password }` against a `provider === 'local'` row (username match is trim + lower-case). Success: `persistSession(..., { skipUntrusted: true })` then `200` public user JSON. An untrusted HTTP peer with `PUBLIC_URL` https does not get `Set-Cookie`; the `200` body still returns. Wrong password, unknown user, empty password, missing hash, or `status !== 'active'` → `401` `{ error: 'unauthorized' }` (same shape; does not disclose whether the user exists).

### OAuth start (`@fastify/oauth2` `startRedirectPath`)

- `GET /login/gitlab` — authorize `scope` is `read_user`
- `GET /login/gitea` — authorize `scope` is `read:user`

Omitted `scope` on `@fastify/oauth2` becomes the literal query value `undefined`, which GitLab rejects (`The requested scope is invalid, unknown, or malformed.`).

`GET /login/github` and `GET /login/github/callback` are **not** OAuth start/callback: both answer `404` `{ error: 'not_found' }` (`sendGithubGone`). `@fastify/oauth2` is registered for GitLab and Gitea only. GitHub forge adapters and publish-to-GitHub remain.

### OAuth callbacks

- `GET /login/gitlab/callback`
- `GET /login/gitea/callback`

Token exchange failure: `502` `{ error: 'oauth_token_failed', message }` (`message` from the provider or `无法向登录提供方换取令牌。`). Userinfo fetch failure: `502` `{ error: 'userinfo_failed' }` or `{ error: 'userinfo_invalid' }`.

`completeUserLogin` (`auth.ts`): existing `(provider, remote_id)` updates `username` and `display_name` only; `revoked` redirects `/login?reason=revoked` (no session). New GitLab/Gitea row is inserted only when `countLoginableAdmins > 0`, as `status` `'active'` and `permission_level` `'full'` (not `admin`; not `待批准` / `claim_only`; no `/login?reason=uninvited`). Zero loginable admins: redirect `/login`, **no** insert, **no** session (empty-DB OAuth cannot grab `full`). Successful insert/reuse sets `request.session.userId` and redirects to `/`.

OAuth token hosts / paths in `registerAuth`: GitLab `authorizePath` `/oauth/authorize`, `tokenPath` `/oauth/token` on `OAUTH_GITLAB_BASE_URL`; Gitea `authorizePath` `/login/oauth/authorize`, `tokenPath` `/login/oauth/access_token` on `OAUTH_GITEA_BASE_URL`. Userinfo GET: GitLab `${gitlabBaseUrl}/api/v4/user`; Gitea `${giteaBaseUrl}/api/v1/user`.

### `GET /api/v1/me`

Session user JSON. Fields: `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`, `trusted_automation` (#16, additive boolean; `users.trusted_automation`, default `false`). `provider` may be `local` | `gitlab` | `gitea` | leftover `github`. `permission_level` may be `admin` | `full` | leftover `claim_only`. When `status` is `待批准`, also `message` `你的账号待正式成员批准后方可认领任务。`. Never `password` / `password_hash`.

Unauthenticated: `Accept` containing `application/json` → `401` `{ error: 'unauthorized' }`; otherwise `302` `/login`.

### `PUT /api/v1/me/settings` (#16)

Session cookie. No session or `status` `待批准` / `revoked` → `sendUnauthorized` (`401`/`302`). Otherwise `canManageInstance` (`active`+`admin`); publisher `full` → `403` `{ error: 'forbidden' }`.

Body `{ trusted_automation: boolean }`; non-boolean or missing key → `400` `{ error: 'invalid_body' }`. Sets `users.trusted_automation`. `200` `{ trusted_automation }` (echoes the stored value). Persists across a new `buildApp()` on the same `SQLITE_PATH`. Never returns a forge token.

### `GET /api/v1/users`

Session cookie. Unauthenticated → `sendUnauthorized`. Non-admin → `403` `{ error: 'forbidden' }`. Admin → `200` `{ users: [{ id, provider, username, display_name, status, permission_level }] }` (exactly those keys; no `password_hash` / `remote_id` / `trusted_automation`).

### `POST /api/v1/users/:id/promote`

Session `active`+`admin` (`canManageInstance`). Unauthenticated → `sendUnauthorized`; publisher → `403` `{ error: 'forbidden' }`. Non-integer or `<= 0` `:id` → `400` `{ error: 'invalid_id' }`. Target must be `provider` `gitlab` or `gitea`, `status` `'active'`, and `permission_level` `'full'` or `'admin'`; otherwise `404` `{ error: 'not_found' }` (includes local, leftover GitHub, missing id). Already `admin` → idempotent `200` `{ ok: true }` (no event). `full` → `permission_level` `'admin'`, `events.type` `权限变更`, `details` `{ target_user_id, from: 'full', to: 'admin' }`, `200` `{ ok: true }`. Never a password/hash/token.

### `POST /api/v1/users/:id/approve`

Retired. Always `404` `{ error: 'not_found' }` (no session check, no status flip).

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

Leftover `ktk_` plaintext is **not** MCP/claim identity: a Bearer `ktk_…` on device-proof routes is `401` `{ error: 'unauthorized' }` with `WWW-Authenticate: Kaola-Device`. Claimants do not mint Agent Keys. `#23` identity is device proof (`registerDevices` / `addDeviceProofHook`).

### Device proof headers (#23, `device-proof.ts`)

Required on `POST /api/mcp`, `GET /api/v1/agent/whoami`, and `POST /api/v1/tasks/:publicId/claim|progress|release`:

| Header | Role |
|--------|------|
| `X-Kaola-Key` | Ed25519 SPKI public key, standard base64 |
| `X-Kaola-Ts` | unix seconds decimal string |
| `X-Kaola-Nonce` | unique per request |
| `X-Kaola-Sig` | Ed25519 signature over the canonical string, standard base64 |
| `X-Kaola-Hostname` | optional; used when creating a pending `devices` row |

Missing/invalid/skewed/replayed → `401` `{ error: 'unauthorized' }` + `WWW-Authenticate: Kaola-Device`. Valid signature for an unknown or `pending` fingerprint upserts `devices.status` `'pending'` (`pending_expires_at` = now + `86400`) and returns **`202`** `{ error: 'authorization_required', pending: true, expires_at }` (ISO-8601). No forge token, no lease. `revoked` → `403` `{ error: 'forbidden' }`. Past `expires_at` or idle → `403` `{ error: 'device_expired' }`.

stdio bridge `kaola-mcp --url <origin>` (`apps/mcp/src/main.ts`, env `KAOLA_URL`, identity `~/.kaola/device.json`) sends those headers on `POST {origin}/api/mcp`. After `initialize` it reads the HTTP `mcp-session-id` response header (case-insensitive) and replays it on later stdin JSON-RPC lines; the session id is HTTP-only and is not added to the stdout JSON-RPC body. Without that replay, `tools/list` is `400` JSON-RPC `-32000` `Bad Request: No valid session ID provided` (Cursor live tool discovery fails). Committed example `apps/mcp/examples/mcp.json` is command + `--url` only (no `ktk_`, no forge token).

Before forwarding a `claim_task` call, the bridge generates (or recovers, on a cold process) a `request_id` and rewrites the outgoing `tools/call` arguments to include it (#32); on a successful result it records the returned `lease.claim_id` and auto-attaches it to that same task's later `report_progress` / `release_task` / `submit_pr` calls, so a caller does not have to track `claim_id` itself. This state lives only in a local, secret-free recovery receipt under `KAOLA_HOME` (default `~/.kaola`), namespaced per `(server origin digest, task id)` — see [docs/architecture.md](architecture.md#claim-lifecycle-36--31--32--33--34) for the on-disk shape and [docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md](decisions/0030-claim-mcp-workflow-runner-compatibility.md) for the design. A stale MCP session (`mcp-session-id` no longer known to the server) triggers exactly one re-`initialize` and one replay of the in-flight call.

### `GET /api/v1/devices/pending`, `GET /api/v1/devices`, `GET /api/v1/me/devices` (#23)

Session `active`+`admin` (`requireFullAdmin` in `devices.ts` calls `canManageInstance`; else `401`/`403`). Publisher `full` is `403`. `GET …/pending` → `200` `{ devices: [{ id, hostname, fingerprint, created_at, expires_at }] }` (non-expired `status === 'pending'`). `GET /api/v1/devices` → `{ devices: [{ id, hostname, fingerprint, status, created_at, paired_at, expires_at, last_seen, owner }] }` (`owner` is `null` while pending; else `{ kind: 'claimant', claimant_id, display_name }` or `{ kind: 'user', user_id }`). `GET /api/v1/me/devices` lists the admin's own bound rows (`devices.user_id`).

### `POST /api/v1/devices/:id/bind` (#23)

Session `active`+`admin`. Body must contain **exactly one** of `bind_to_self` (must be `true`), `claimant_id` (positive int), `claimant_display_name` (non-empty string). Else `400` `{ error: 'invalid_body' }`. Target must be live `pending` else `409` `{ error: 'conflict', message: '电脑申请已过期或不在待授权状态。' }`. Over `max_devices` → `409` `{ error: 'conflict', message: '已达该身份的电脑台数上限。' }`. Unknown `claimant_id` → `404`. Success `200` `{ ok: true, device_id, owner }` (`owner` `{ kind: 'user', user_id }` or `{ kind: 'claimant', claimant_id, display_name }`). Writes `events.type` `电脑授权`. Does not claim a task and does not reveal a forge token. Web **电脑** pane **绑到我自己** sends `{ bind_to_self: true }`.

### `POST /api/v1/devices/:id/revoke`, claimants (#23)

`POST /api/v1/devices/:id/revoke` → `200` `{ ok: true }`, `events.type` `电脑解除`. `GET /api/v1/claimants` → `{ claimants: [{ id, display_name, status, device_max_age_days, max_devices, device_idle_days }] }`. `POST /api/v1/claimants/:id/revoke` revokes the **认领者** and its devices, `events.type` `认领者解除`. `PATCH /api/v1/claimants/:id/settings` body optional `device_max_age_days` (1–365), `max_devices` (1–50), `device_idle_days` (0–365) → those three keys echoed.

### `GET /api/v1/agent/whoami` (#23)

Device proof only (`addDeviceProofHook`). Bound `active` device → `200` `{ device_id, fingerprint, hostname, status: 'active', owner }` (`owner` `{ kind: 'user', user_id }` or `{ kind: 'claimant', claimant_id, display_name }`). Pending signature → same `202` `authorization_required` as MCP. Never a forge token. Leftover `ktk_` Bearer → `401` + `WWW-Authenticate: Kaola-Device`. Session `GET /api/v1/me` is unchanged.

### `GET /api/v1/credential-profiles`

Session cookie. Gate: `canPublish` — `status === 'active'` AND `permission_level` `admin` or `full` (`credential-profiles.ts`). Otherwise `403` `{ error: 'forbidden' }`. Lists every row (team-shared).

`200` `{ profiles: [{ id, forge, base_url, repo_full_name, scopes_checked, created_by }] }`. Never includes `token` or `token_encrypted`. `scopes_checked` is JSON parsed to an array (`[]` if parse fails or value is not an array).

Unauthenticated: same oracle as `GET /api/v1/me`.

### `POST /api/v1/credential-profiles`

Session cookie. Same `canPublish` gate (`403` `{ error: 'forbidden' }`).

Body `{ forge, base_url, repo_full_name, token }`: `forge` must be `github` | `gitlab` | `gitea`; `base_url`, `repo_full_name`, and `token` must be non-empty strings. Otherwise `400` `{ error: 'invalid_body' }`.

Encrypts `token` with `encryptToken` (does not call `validateToken`). Inserts `scopes_checked` `'[]'`. Writes `events` row `type` `变更`, `details` `{"action":"create","profile_id":<n>}`.

`201` same public shape as a list item. Duplicate UNIQUE `(forge, base_url, repo_full_name)` → `409` `{ error: 'conflict' }`. Missing or invalid `VAULT_MASTER_KEY` → `500` `{ error: 'vault_unconfigured' }`.

### `DELETE /api/v1/credential-profiles/:id`

Session cookie. Same `canPublish` gate. Deletes the row (any `admin` or `full` member may delete any profile).

Before deleting (#36), checks whether any task with this `credential_profile_id` is in a non-terminal status (`待认领` | `进行中` | `待验收` | `已退回`); if so → `409` `{ error: 'credential_profile_in_use', message: '该凭证档案仍被未完成任务引用，暂不能删除。' }`, no delete, no event. This retention keeps an active Claim able to re-decrypt the same credential it was claimed with. A profile referenced only by terminal tasks (`已完成` / `已取消`) or by no task at all still deletes exactly as before.

`200` `{ ok: true, message: '请同时到 forge 侧撤销该 token。' }`. Writes `events` row `type` `变更`, `details` `{"action":"delete","profile_id":<n>}`. Non-integer / `<= 0` id or missing row → `404` `{ error: 'not_found' }`.

### `GET /api/v1/credential-profiles/:id/issues` (#19)

Session cookie. Same `canPublish` gate as the other profile routes (`403` `{ error: 'forbidden' }`). Unauthenticated: same oracle as `GET /api/v1/me`.

Loads the `credential_profiles` row by integer id, decrypts `token_encrypted` with `decryptToken` (server-side, same vault helper the poller uses to call the forge), then `createForgeAdapter(profile.forge, { baseUrl: profile.baseUrl }).listIssues({ token }, { full_name: profile.repoFullName, base_url: profile.baseUrl })`.

`200` `{ issues: [{ number, title, issue_url }] }` (`ListedIssue[]` from the adapter; never a token, never `token_encrypted` / ciphertext / `access_token`). Non-integer / `<= 0` id or missing row → `404` `{ error: 'not_found' }`. Missing or invalid `VAULT_MASTER_KEY` → `500` `{ error: 'vault_unconfigured' }`.

Forge HTTP 401 → `422` `{ error: 'token_check_failed', missing: ['读'], message: 'token 无效或无权读取该 Issue。' }` (same `message` as `POST /api/v1/tasks/import`). Any other non-OK forge status (including 404 and 410) or a network throw → `502` `{ error: 'forge_unreachable', message: '无法连接 forge 列出 Issue。' }`. Forge 404/410 are **not** mapped to `issue_not_found` (this route has no single-issue lookup).

Does **not** write `events.type` `token 揭示` (contrast import's profile path, which writes that event after decrypt). Does not persist a task.

### `GET /api/v1/tasks`

Session cookie. Any logged-in user (including `status` `待批准`) may list. Unauthenticated: same oracle as `GET /api/v1/me` (`401` `{ error: 'unauthorized' }` or `302` `/login`).

`200` `{ tasks: [<brief>, ...] }` ordered by integer PK `id`. Each item is a Task Brief (snake_case; keys in `@kaola/shared` `taskBriefSchema`). `id` is `public_id` (`kt-YYYY-NNNN`), not the integer PK. `credential` is `{ profile_id: "<id>" }` or `{ inline: true }` — never a token. `pr_convention` is derived: `branch_prefix` `kaola/${public_id}-`, `title_prefix` `[${public_id}] `. `created_at` is ISO-8601 from stored unix seconds. `poster` is the poster's `username`. Handler calls `sweepExpiredLeases` (check-on-read) then re-reads. After a successful claim, list items still omit forge plaintext and secret key names (`token` / `token_encrypted` / `inline_token_encrypted` / `access_token`).

### `GET /api/v1/tasks/:publicId`

Session cookie. Same auth as list. Addressed by `public_id` string (numeric-looking ids such as `1` are `404`).

`200` the same brief shape as create. Missing row → `404` `{ error: 'not_found' }`. Handler calls `sweepExpiredLeases` (check-on-read) then re-reads. Never contains forge plaintext or the secret key names above.

### `POST /api/v1/tasks`

Session cookie. Gate: `canPostTasks` / `canPublish` — `status === 'active'` AND `permission_level` `admin` or `full` (same population as credential profiles). Otherwise `403` `{ error: 'forbidden' }`. Leftover `claim_only` cannot publish. 发布即校验: a failing check is never persisted.

Wire is snake_case. Request `credential` is `{ profile_id }` XOR `{ token }` (`profile_id` integer or numeric string). That is not the brief-side union (`{ profile_id: string }` | `{ inline: true }`); a request of `{ inline: true }` with no token is `400` `{ error: 'invalid_body' }`. Sending both `profile_id` and `token` is `400`. Client-supplied `id` / `pr_convention` / `poster` / `status` / `created_at` are ignored (server-owned).

Required: non-empty `title`; `repo.forge` `github` | `gitlab` | `gitea`; non-empty `repo.base_url` and `repo.full_name`; `credential`. Defaults when omitted: `description_md` `''`; `source` `{ type: 'native' }`; `repo.base_branch` `'main'`; `repo.suggested_dir` last path segment of `full_name`; `acceptance_criteria` `[]`; `test_command` `''`; `constraints` `{ allowed_paths: [], forbidden_paths: [] }`; `priority` `'P2'`; `tags` `[]`. `@kaola/web` 发布向导省略后五项（验收标准 / 测试命令 / 路径约束 / 优先级 / 标签），由上述缺省补齐；请求/响应形状不变。`source.type` `imported` requires non-empty `issue_url`. Generic parse failure → `400` `{ error: 'invalid_body' }` (no `message`).

`repo.base_url` must parse as `http:` or `https:` with a non-empty hostname; else `400` `{ error: 'invalid_body', message: '仓库地址不是合法的 http 或 https 地址。' }` (before any forge fetch).

Profile path: load `credential_profiles` by id; missing → `400` `{ error: 'invalid_body', message: '所选凭证档案不存在。' }`. Bind `repo.forge` / `repo.base_url` / `repo.full_name` to the profile row with exact `===` **before** decrypt; mismatch → `400` `{ error: 'invalid_body', message: '所选凭证档案与仓库不匹配。' }` (no `token 揭示` event). Then `decryptToken`. Inline path: `encryptToken` of the request token into `inline_token_encrypted`. Missing or invalid `VAULT_MASTER_KEY` on either path → `500` `{ error: 'vault_unconfigured' }`.

Then `createForgeAdapter(repo.forge, { baseUrl: repo.base_url }).validateToken({ token }, { full_name, base_url })`. Unreachable forge → `502` `{ error: 'forge_unreachable', message: '无法连接 forge 校验 token，任务未发布。' }`. `missing.length > 0` → `422` `{ error: 'token_check_failed', missing, message }` where `missing` is `TokenCapability[]` (`读` | `推` | `PR`); if `missing` includes `读`, `message` is `token 无效或无权访问该仓库，任务未发布。`; otherwise `token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。`.

Profile path writes `events.type` `token 揭示` after decrypt (including 422 / 502): `details` `{ profile_id, forge, base_url, full_name, outcome }` with `outcome` `ok` | `token_check_failed` | `forge_unreachable`. `profile_id` is the integer profile PK. No token / ciphertext / `agent_key_id` in details. Inline path does not write this event.

`201` the Task Brief (`status` `待认领`). No response contains a token.

### `POST /api/v1/tasks/import`

Session cookie. Same `canPublish` gate as create (`403` `{ error: 'forbidden' }`). Unauthenticated: same oracle as `GET /api/v1/me`. Pre-publish draft in `registerTasks`: does **not** insert a `tasks` row and does **not** call `validateToken` (发布即校验 stays on `POST /api/v1/tasks`).

Wire is snake_case. Required: non-empty `issue_url`; `repo.forge` `github` | `gitlab` | `gitea`; non-empty `repo.base_url`; request `credential` `{ profile_id }` XOR `{ token }` (same union as create). `repo.full_name` is optional. Generic parse failure → `400` `{ error: 'invalid_body' }` (no `message`).

`repo.base_url` must parse as `http:` or `https:` with a non-empty hostname; else `400` `{ error: 'invalid_body', message: '仓库地址不是合法的 http 或 https 地址。' }` (before any forge fetch).

Parses `issue_url` with package-level `parseIssueUrl(forge, issue_url)` **before** decrypt. Unparseable → `400` `{ error: 'invalid_body', message: '无法解析 Issue 地址。' }` (zero fetch; no `token 揭示`). If `repo.full_name` is present it must equal the parsed `full_name`; else `400` `{ error: 'invalid_body', message: 'Issue 地址与仓库不匹配。' }`.

Profile path: load `credential_profiles` by id; missing → `400` `{ error: 'invalid_body', message: '所选凭证档案不存在。' }`. Bind `repo.forge` / `repo.base_url` / **parsed** `full_name` to the profile row with exact `===` **before** decrypt; mismatch → `400` `{ error: 'invalid_body', message: '所选凭证档案与仓库不匹配。' }` (no `token 揭示` event). Then `decryptToken`. Inline path: uses the request token as-is and does **not** encrypt (nothing is persisted). Missing or invalid `VAULT_MASTER_KEY` on the profile path → `500` `{ error: 'vault_unconfigured' }`.

Then `createForgeAdapter(repo.forge, { baseUrl: repo.base_url }).importIssue({ token }, issue_url)`. Forge HTTP 404 or 410 → `404` `{ error: 'issue_not_found', message: '无法读取该 Issue。' }`. Forge HTTP 401 → `422` `{ error: 'token_check_failed', missing: ['读'], message: 'token 无效或无权读取该 Issue。' }`. Other non-OK forge status or a network throw → `502` `{ error: 'forge_unreachable', message: '无法连接 forge 导入 Issue。' }`.

Profile path writes `events.type` `token 揭示` after decrypt (including 404 / 422 / 502): `details` `{ profile_id, forge, base_url, full_name, outcome }` with `outcome` `ok` | `issue_not_found` | `token_check_failed` | `forge_unreachable`. `profile_id` is the integer profile PK. No token / ciphertext / `agent_key_id` in details. Inline path does not write this event.

`200` `{ title, description_md, source: { type: 'imported', issue_url }, repo: { forge, base_url, full_name } }` (`full_name` is the parsed/imported name; `forge`/`base_url` echo the request). Not a Task Brief. Nested objects must not contain keys `token` / `token_encrypted` / `inline_token_encrypted` / `access_token`. This `200` never contains a forge token.

### `PATCH /api/v1/tasks/:publicId`

Session cookie. Same `canPublish` gate (`403` `{ error: 'forbidden' }`). Body `{ status }`; `status` must be a `taskStatusSchema` value else `400` `{ error: 'invalid_body' }`. Missing `public_id` → `404` `{ error: 'not_found' }`. Non-poster → `403` `{ error: 'forbidden' }`.

Poster-only edges in source: `待认领` → `已取消`; `已退回` → `已取消` | `待认领`. Other requested statuses (including `待认领` → `进行中`) → `409` `{ error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「${to}」。' }`. Success writes `events.type` `状态迁移`, `details` `{ task_id, from, to }` (`task_id` is the `public_id` string) and returns `200` the updated brief. `@kaola/web` poster board detail now calls this existing route (取消 → `{ status: '已取消' }`; 重新开放 → `{ status: '待认领' }`); the wire contract is unchanged.

### `POST /api/v1/tasks/:publicId/claim`

Device proof only (`addDeviceProofHook` in the `claim.ts` child plugin; session cookie does not authorize). `:publicId` is `kt-YYYY-NNNN`. Auth runs before resource lookup. Unbound valid signature → **`202`** `{ error: 'authorization_required', pending: true, expires_at }` (no `token`, no `clone`). Bound leftover `ktk_` Bearer → `401` `{ error: 'unauthorized' }` + `WWW-Authenticate: Kaola-Device`.

Body `{ autonomous?: boolean, request_id?: string }` (`autonomous` #16, `request_id` #36). Missing body, non-object body, or a non-boolean `autonomous` key is treated as **instructed** (`autonomous` `undefined`) — the pre-#16 behavior below is unchanged in every way for an instructed claim (still 认领即授权, still `201` on the first `待认领`→`进行中` transition). `autonomous: false` is also instructed.

**Idempotent claim identity (#36).** `request_id` is an optional client-supplied idempotency key scoped to `(device_id, request_id)` (`leases_device_request_identity`, a partial unique index on non-null `request_id`). Acquisition (the Task compare-and-swap, the lease insert, the `token 揭示` audit, and the `状态迁移` audit) is one SQLite transaction; a lost compare-and-swap (a concurrent writer already moved the task) aborts the whole transaction and surfaces as the existing `409` `conflict`. Given a `request_id`:

- an existing lease for that exact `(device_id, request_id)` — in any state — is checked *before* the target task is even looked at. Its recorded digest (the original claim's `task_id` + `autonomous`) must match this request's; a mismatch is `409` `{ error: 'claim_request_conflict', message: '同一 request_id 已用于一次不同的认领尝试（目标任务或 autonomous 标记不一致），本次请求已被拒绝。' }` without touching any state.
- a digest match against a **still-active** lease is a replay: it re-decrypts and re-reveals the same credential (audited as `token 揭示` `replay: true`) and returns the same `201` envelope, including the same `claim_id` — no new lease, no new `状态迁移` event.
- a digest match against a **terminal** (released/expired) lease is `409` `{ error: 'claim_request_conflict', message: '该 request_id 对应的认领已结束，请使用新的 request_id 重新认领。' }` — a terminal Claim is never revived by replay.
- a still-**pending** autonomous confirmation (#16) for that `(device_id, request_id)` is checked the same way before it is ever parked again, so a mismatched digest against a pending confirmation is refused identically, before any `202` is issued.
- no existing lease or pending confirmation: falls through to a fresh claim attempt exactly as an omitted `request_id` would, except the new lease stores this `request_id`.

Omitting `request_id` behaves exactly as before #36 — every existing caller that sends no `request_id` is unaffected.

When `autonomous === true` **and** the claiming Agent's user has `trusted_automation !== true` — checked *after* the `待批准` `403` gate below, *before* the resource/lease logic that produces `201` — the claim does not reveal a token:

- An existing `claim_confirmations` row in state `'approved'` for this exact `(task, user, agent_key)` triple is consumed (row deleted — one-time use, so a later `release` + re-claim cannot ride the same approval again) and the claim proceeds to the normal `201` flow below.
- Otherwise: a `'pending'` row for that triple is inserted (or, if one already exists, reused as-is — a repeated pending request is idempotent and does not duplicate the row or the event), `events.type` `认领待确认` is written (`details` `{ task_id, device_id }`, `actor_user_id` the claiming user), and the response is `202` `{ error: 'confirmation_required', message: '该任务的自动认领需要你先在网页端确认，请到「待确认认领」列表批准或拒绝。', pending: true }`. No `token`, no `clone`, no `token 揭示` event, no lease inserted, task status stays `待认领`.

`autonomous: true` from a user with `trusted_automation === true` skips the confirmation gate entirely and always reaches the normal `201` flow (same as an instructed claim). `trusted_automation` defaults `false` — every user needs an explicit `PUT /api/v1/me/settings` before an autonomous claim can go straight through.

MCP 配置平时不含仓库 / forge token。Successful REST claim `201` (and MCP `claim_task` success) is when the agent gets **that task’s** forge token (top-level `token`) plus `clone`. Claiming a different `publicId` / `task_id` returns that other task’s token. Never reuse the previous token from MCP config or git remote. Committed MCP example is `kaola-mcp --url` only (`apps/mcp/examples/mcp.json`; no secrets, no `ktk_`, no forge PAT). Forge token must **never** appear in any mcp.json. Humans should not edit mcp.json per task.

`201` exact keys `clone`, `lease`, `task`, `token`:

- `task` — existing 15-key Task Brief (`parseTaskBrief`); `status` `进行中`; `credential` remains `{ profile_id }` or `{ inline: true }` (no token inside `task`)
- `token` — forge plaintext of **the claimed task** (one of two reveal channels; the other is MCP `claim_task` success `token`). This is the task's reusable stored repository credential, not a token minted specifically for this Claim; release and lease expiry never revoke it on the forge — they only revoke Kaola Tasks' own lifecycle authority and Claim fencing (see `docs/decisions/0030-...md`, "Credential semantics")
- `lease` — `{ claim_id, expires_at, ttl_seconds }` (#36 adds `claim_id`) with `ttl_seconds` the number `86400` (`LEASE_TTL_SECONDS`). `expires_at` is ISO-8601 from unix `(now + 86400) * 1000`. `claim_id` (`claimIdForLease` in `leases.ts`) is an opaque `clm_`-prefixed public encoding of the lease row's immutable fields (`id`, `task_id`, `device_id`, `claimed_at`, `request_id`, claimer) — it is derived on every read, never stored as its own column. `report_progress` / `release_task` / `submit_pr` must present this same `claim_id` to act on this Claim once it was minted with a `request_id` (see those sections below)
- `clone` — exactly four keys `suggested_dir`, `token_usage`, `remote_url`, `extra_header`:
  - `suggested_dir` equals `task.repo.suggested_dir` (relative dir name)
  - `token_usage` is exactly `token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。`
  - `remote_url` is the HTTPS git remote with **no** username/password/token: strip trailing slashes from `task.repo.base_url`, then `'/'` + `task.repo.full_name` + `'.git'`. GitLab subgroup `full_name` keeps slashes (`https://host/group/subgroup/app.git`). Do not use the GitLab API `%2F` project path. Do not use `api.github.com`.
  - `extra_header` is `{ name, value_pattern }`. `value_pattern` contains the literal characters `${token}` and must **not** contain the revealed forge token.

  | forge | `name` | `value_pattern` |
  |-------|--------|-----------------|
  | github | Authorization | Bearer ${token} |
  | gitlab | Authorization | Bearer ${token} |
  | gitea | Authorization | token ${token} |

  Agent substitutes top-level `token` into `value_pattern`, equivalent to `git -c http.extraHeader="<name>: <value>" clone <remote_url> <suggested_dir>`. Server does not run git.

Do not put forge plaintext inside `task` / `lease` / `clone`. Nested objects must not contain the plaintext or secret key names `token` / `token_encrypted` / `inline_token_encrypted` / `access_token` (`value_pattern` may contain the placeholder `${token}`, not the revealed secret). Outer `201` keys stay `clone`, `lease`, `task`, `token`.

Pending `users.status === '待批准'` → `403` `{ error: 'forbidden', message: '你的账号待正式成员批准后方可认领任务。' }` (no forge token; no `token 揭示`) — checked before the #16 autonomous/confirmation gate above, so a pending user gets `403` even with `autonomous: true`. Unknown `publicId` or numeric PK with a valid bound device → `404` `{ error: 'not_found' }`. Second claim while `进行中` → `409` `{ error: 'conflict', message: '任务已被认领。' }`. Claim when status is not `待认领` (and not the `进行中` conflict above) → `409` `{ error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「进行中」。' }`. A `request_id` reused with a mismatched `(task_id, autonomous)` digest, or a `request_id` whose lease is already terminal → `409` `{ error: 'claim_request_conflict', message: '…' }` (#36, see above; checked before the task lookup, so it can fire even for an unknown `publicId`). Missing/invalid `VAULT_MASTER_KEY` on decrypt → `500` `{ error: 'vault_unconfigured' }`. Missing/invalid device proof → `401` `{ error: 'unauthorized' }` + `WWW-Authenticate: Kaola-Device`. Unbound valid proof → `202` `authorization_required` (distinct from #16 `confirmation_required`).

Holder identity for later progress/release/submit is the exact lease: same Task, same active (or, for release/submit's idempotent terminal path, that same now-terminal) lease, same owner (`claimer_user_id` or `claimer_claimant_id`), and — as of #31 — the *exact same device* (`leases.device_id` compared to the caller's device, not just the same owner; see `report_progress`/`release_task` below for the deliberate legacy tightening this brings).

Writes (successful `201` claim): one SQLite transaction inserts the `leases` row `state` `'active'` (keyed by integer `tasks.id`, storing `request_id` when given) and writes `events.type` `token 揭示` then `状态迁移` (#36; see Events below). A lost Task compare-and-swap aborts the whole transaction and surfaces as the existing `409` `conflict`. Calls `sweepExpiredLeases` first (check-on-write). Does not call `validateToken`. `claimTask` (`apps/server/src/claim.ts`) is `async`. After that transaction commits it calls `scheduleWriteback(db, updated, '认领', actorUserId(auth))` — fired off but **never awaited** by the claim response (#36; `submitPr` below moved to the same fire-and-forget call in #38) — so a slow/unreachable forge cannot delay a committed `201`; the response shape and its `token` are unaffected by that call's outcome either way. A replayed claim (an active `request_id` match) re-decrypts and re-audits (`token 揭示` `replay: true`) but writes no new lease and no new `状态迁移`. A parked `202` (#16) writes only `认领待确认` and touches neither `leases` nor writeback.

`registerClaim(app, db)` is wired in `app.ts` after `registerTasks`.

### `GET /api/v1/claim-confirmations`, `POST /api/v1/claim-confirmations/:id/approve`, `POST /api/v1/claim-confirmations/:id/reject` (#16, `registerClaimConfirmations` in `apps/server/src/claim-confirmations.ts`)

Session cookie only (`requireActiveSessionUser`: no session or `status === '待批准'` → `sendUnauthorized`, same `401`/`302` oracle as `GET /api/v1/me` — **not** the claim route's `403`). Then `canManageInstance` (`active`+`admin`); publisher `full` → `403` `{ error: 'forbidden' }`. A Bearer Agent Key alone does not authorize these three routes.

`GET` → `200` `{ confirmations: [{ id, task_id, state, created_at }] }` (`task_id` is the task's `public_id` via a join; `state` `'pending'` | `'approved'` | `'rejected'`), scoped to `claim_confirmations.user_id === ` the session user's id — one user never sees another user's rows.

`POST …/approve` → sets that row's `state` to `'approved'`, writes `events.type` `认领已确认` (`details` `{ task_id, device_id }`, `actor_user_id` the approving session user), `200` `{ ok: true }`. Does **not** itself insert a lease, flip the task's status, or decrypt/reveal a forge token — it only flips the row an autonomous re-claim will later consume (see the claim section above). A non-integer id, a missing row, or a row owned by a different user → `404` `{ error: 'not_found' }` (no distinction between "doesn't exist" and "not yours").

`POST …/reject` → sets `state` to `'rejected'`, `200` `{ ok: true }`, no event write. Same `404` rule as approve. A rejected row is left in place (not deleted); a subsequent autonomous claim attempt on the same `(task, user, agent_key)` triple ignores it and inserts a fresh `'pending'` row (rejection is not remembered as a standing denial).

None of the three responses ever contains a forge token, `token_encrypted`, `inline_token_encrypted`, or `access_token`.

### `POST /api/v1/tasks/:publicId/progress`

Device proof only (same child plugin as claim; session cookie does not authorize). Body `{ note?: string, claim_id?: string }` (omit body OK; `claim_id` added #31). Non-string `note` is treated as omitted.

**Claim fencing (#31).** Resolves the task's current *active* lease (no idempotent-terminal fallback — a heartbeat only ever makes sense against a currently active lease). A lease minted with a non-null `request_id` (a "new-style" Claim) requires `claim_id`; omitting it → `400` `{ error: 'claim_id_required', message: '该认领要求提供 claim_id。' }`. A legacy lease (`request_id IS NULL`) may omit `claim_id`. Fencing then checks, in this order: (1) `claim_id_required` above, (2) owner **and exact device** match (`leases.device_id` — not just the same user/claimant; this is a deliberate tightening from #31: a same-owner different-device heartbeat that used to succeed is now `403 forbidden`, including against a legacy lease), (3) a presented `claim_id` that does not match the lease's own derived identity → `409` `{ error: 'stale_claim', message: '提交的 claim_id 与当前认领不匹配。' }`.

`200` exact keys `lease`, `task`. `task.status` `进行中`. Same `lease` wire shape (`expires_at`, `ttl_seconds` `86400` — **no** `claim_id` in this envelope, unlike the claim `201`'s `lease`). **No** `token`. Renews `expires_at` from heartbeat `now + 86400`, not original claim time. The lease renewal and its `心跳` audit are one transaction (#31). Writes `events.type` `心跳`, `details` `{ task_id, note }` (`note` is `''` when omitted).

No live lease (including after expiry sweep or after the holder released) → `409` `{ error: 'conflict', message: '任务未被认领。' }`. Unknown id → `404` `{ error: 'not_found' }`. Unauthenticated / wrong / leftover `ktk_` → `401` `{ error: 'unauthorized' }` + `WWW-Authenticate: Kaola-Device`. Calls `sweepExpiredLeases` first (check-on-write).

### `POST /api/v1/tasks/:publicId/release`

Device proof only (same child plugin as claim; session cookie does not authorize). Body `{ reason?: string, claim_id?: string }` (omit body OK; `claim_id` added #31). Non-string `reason` is treated as omitted.

**Claim fencing and idempotent terminal path (#31).** Resolves the task's active lease first; if none is active, resolves the caller's own most recent *terminal* lease for this task instead (same owner+device fencing, keyed by `claim_id` when given, else the most recent legacy lease) so a repeat of the same release is idempotent: releasing an already-released Claim again returns the same `200` with no duplicate `状态迁移` write. A terminal Claim that instead already submitted a PR (it holds a `submissions` row) is not a valid repeat of release — `409` `{ error: 'stale_claim' }`. Otherwise the same `claim_id_required` / owner+device / `stale_claim` fencing as `progress` above applies to the active-lease path.

`200` exact keys `task`. `task.status` `待认领`. **No** `token`. **No** `lease` on the wire. Marks the lease `state` `'released'`. The lease release, the task update, and the `状态迁移` audit are one transaction (#31). Writes `events.type` `状态迁移`, `details` `{ task_id, from, to }` plus `reason` only when the body had a string `reason`.

Same 401 / 404 / no-live-lease `409 conflict` as progress, plus `claim_id_required` / owner+device `403` / `stale_claim` `409` fencing. Calls `sweepExpiredLeases` first (check-on-write).

There is no REST `POST /api/v1/tasks/:publicId/submit_pr`. `submit_pr` is MCP-only (`submitPr` in `claim.ts`).

### `POST /api/mcp`

Device proof only (`addDeviceProofHook` from `device-proof.ts`, registered in the `mcp.ts` child plugin; session cookie does not authorize; leftover `ktk_` Bearer is `401` + `WWW-Authenticate: Kaola-Device`). Streamable HTTP via `@modelcontextprotocol/sdk` `1.30.0` `StreamableHTTPServerTransport` (`enableJsonResponse: true`; session header `mcp-session-id`). Tests initialize with `protocolVersion` `2025-11-25`. `McpServer` `{ name: 'kaola-tasks', version: '0.0.0' }`. stdio `kaola-mcp` replays `mcp-session-id` after initialize (see Device proof above).

Unauthenticated / wrong / leftover `ktk_` / session-cookie-only → `401` `{ error: 'unauthorized' }` + `WWW-Authenticate: Kaola-Device` (before JSON-RPC). Valid unbound signature → HTTP **`202`** `{ error: 'authorization_required', pending: true, expires_at }` (stdio bridge maps this to JSON-RPC error `-32000`). `GET /api/mcp` and `DELETE /api/mcp` → `405` JSON-RPC `{ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }`. Non-initialize POST without a session → `400` JSON-RPC `-32000` `Bad Request: No valid session ID provided`. Unknown `mcp-session-id` → `404` JSON-RPC `-32001` `Session not found`.

Authenticated `tools/call` HTTP status is `200`. Business failures are a JSON-RPC **result** with `isError: true` and REST `{ error, message? }` in `structuredContent` (and JSON text `content`).

The `McpServer` constructor now also passes `instructions` (#33) — a default-direct-Workflow, no-silent-carrier-switch description, plus the measured Kaola Workflow `10.2.1` / `7e93763e` issue-less-project `no_target` finding; see [docs/workflow-default.md](workflow-default.md). Six `registerTool` names (unchanged — no carrier/runner/execution field is added to any tool):

| Tool | Input | Success `structuredContent` |
|------|--------|------------------------------|
| `list_tasks` | `status?` `tags?` `forge?` (optional strings) | `{ tasks: [<brief>, ...] }` ordered by integer PK `id`. Filters: `status` exact, `tags` membership of one tag (`brief.tags.includes`), `forge` exact `repo.forge`. Never a token. |
| `get_task_brief` | `task_id` | top-level brief (not wrapped). Missing or numeric PK such as `"1"` → `isError` `{ error: 'not_found' }`. Never a token. Description in source: never includes a forge token. |
| `claim_task` | `task_id`, `autonomous?` (boolean, #16), `request_id?` (string, #36) | MCP config normally contains no repo/forge token. Success: same envelope as REST claim `201` — keys `clone`, `lease` (now including `claim_id`, #36), `task`, `token`. That success is when the agent gets **this** `task_id`’s reusable stored repository credential (top-level `token`, not minted per Claim) plus `clone`. A different `task_id` returns that other task’s credential; never reuse the previous token from MCP config or git remote. `clone` is the same four keys (`suggested_dir`, `token_usage`, `remote_url`, `extra_header`; `remote_url` / `extra_header` table as REST `201` above). Nested `clone` must not contain forge plaintext or secret key names. Tool description states the credential is reusable and not minted per Claim, that release/lease-expiry revoke only Kaola Tasks' own lifecycle authority and Claim fencing (never the forge token), includes `CLONE_TOKEN_USAGE` (`token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。`), explains `autonomous`, and explains that an optional `request_id` makes retries of the same claim attempt idempotent. `autonomous: true` from a non-`trusted_automation` user is **not** an error result — `isError` is `false`/absent and `structuredContent` is `{ error: 'confirmation_required', message, pending: true }` (same body as REST `202`; no `token`, no `clone`). A reused `request_id` with a mismatched `(task_id, autonomous)` digest, or one whose Claim is already terminal, is `isError` `{ error: 'claim_request_conflict', message }` (#36). Forge token must never appear in any mcp.json and must never be put in MCP `Authorization`. |
| `report_progress` | `task_id`, `note?`, `claim_id?` (string, #31) | `{ task, lease }` (no `token`; `lease` here has no `claim_id`, only `expires_at`/`ttl_seconds`). Omit `note` → event `note` `''`. `claim_id` is required when the active Claim was minted with `request_id` (`isError` `{ error: 'claim_id_required' }`), optional for a legacy Claim; a mismatched `claim_id` is `isError` `{ error: 'stale_claim' }`; a different device holding the same owner's Claim is `isError` `{ error: 'forbidden' }` (#31 device fencing, tightened from user/claimant-only). |
| `release_task` | `task_id`, `reason?`, `claim_id?` (string, #31) | `{ task }` with `status` `待认领` (no `token`, no `lease`). Omit `reason` → event details have no `reason` key. Same `claim_id_required` / `stale_claim` / device-fenced `forbidden` rules as `report_progress`; repeating release for an already-released Claim is idempotent and returns the same `{ task }` with no duplicate audit write. |
| `submit_pr` | `task_id`, `pr_url`, `summary`, `claim_id?` (string, #31) | `{ task, pr_url, summary }` with `task.status` `待验收` (no `token`; `pr_url` is the **canonicalized** form, which may differ byte-for-byte from the submitted URL — trailing slash and a `/files`, `/commits`, or `/diffs` sub-page suffix stripped). Same `claim_id_required` / `stale_claim` / device-fenced `forbidden` rules as `report_progress`. `pr_url` must parse for the task's own `repo_forge` and its parsed `full_name` must equal the task's `repo_full_name`, checked before any write — else `isError` `{ error: 'pr_url_invalid', message: 'pr_url 无法解析，或与任务所属仓库不一致。' }` (#31). Repeating `submit_pr` for the same Claim and the same canonical `pr_url` is idempotent (`200`-shaped result, same `pr_url`/`summary` returned); the same Claim with a **different** `pr_url` is `isError` `{ error: 'pr_url_conflict', message: '同一认领已提交过另一个 pr_url。' }`; a canonical `pr_url` already held by another task's live (`pr_state === 'open'`) submission is `isError` `{ error: 'pr_url_taken', message: '该 pr_url 已被另一任务的进行中提交占用。' }`. Inserts `submissions` (`pr_state` `'open'`, `lease_id` unique — one submission per Claim), marks the live lease `'released'`, all in one transaction with the `状态迁移` audit (#31). `submitPr` (`claim.ts`) is `async` and, after that transaction commits, calls `scheduleWriteback(db, updated, '提交PR', actorUserId(auth), canonicalPrUrl)` (#14, no-op for a native task; fire-and-forget as of #38, the same way claim's writeback already was since #36) — never awaited, so a slow/unreachable forge cannot delay the `submit_pr` response. |

`list_tasks` / `get_task_brief` / mutating tools call `sweepExpiredLeases` first. Claim/progress/release/submit wrap `claimTask` / `reportProgress` / `releaseTask` / `submitPr` (same REST error bodies: pending claim `forbidden` + `你的账号待正式成员批准后方可认领任务。`; second claim `conflict` + `任务已被认领。`; claim request-id conflict `claim_request_conflict`; device-fenced non-holder `forbidden` without `message`; no live lease `conflict` + `任务未被认领。`; missing `claim_id` on a new-style Claim `claim_id_required`; mismatched `claim_id` `stale_claim`; `submit_pr` when status is not `进行中` → `illegal_transition` to `待验收`; `submit_pr` URL failures `pr_url_invalid` / `pr_url_conflict` / `pr_url_taken`).

`registerMcp(app, db)` is wired in `app.ts` after `registerClaim`.

### `GET /api/v1/events`, `GET /api/v1/stats` (#15, `registerEvents` in `apps/server/src/events.ts`)

Session cookie only. Gate `canReadEvents`: `user.status !== '待批准'` — stricter than `GET /api/v1/tasks` (which a `待批准` user may read); no session or a pending session → `401` `{ error: 'unauthorized' }` (same `sendUnauthorized` oracle as `GET /api/v1/me`, so a non-JSON `Accept` gets `302 /login` instead). Any other logged-in user — `active`+`admin`, `active`+`full`, or leftover `active`+`claim_only` — may read both. No query string on either route; every filter is client-side in `@kaola/web`.

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

`apps/server/src/writeback.ts` exports `attemptWriteback(db: AppDb, task: Task, transition: '认领' | '提交PR' | '完成', actorUserId: number | null, prUrl?: string): Promise<void>`. It is a no-op for a native task (`task.sourceType !== 'imported'` or empty `task.sourceIssueUrl`) — zero forge calls, zero `events` rows. For an imported task it builds a Chinese status comment (always contains `task.publicId` and `PUBLIC_URL`, trailing slash trimmed, default `http://localhost:31415`; the 提交PR and 完成 bodies also contain the given `prUrl`) and calls `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl, timeoutMs: WRITEBACK_TIMEOUT_MS }).commentOnIssue({ token }, { issue_url: task.sourceIssueUrl }, body)`, where `token` comes from `decryptTaskToken(db, task)` (moved here from `poller.ts`; the poller still imports it for its own `getPullRequest` call) — the task's own profile/inline credential, never the caller's Agent API key.

Every failure — `decryptTaskToken` returning `undefined`, a thrown `commentOnIssue` (non-OK response or unparseable `issue_url`) — is caught inside `attemptWriteback` and swallowed; nothing propagates to the caller. On success it writes `events.type` `回写`, `details` **exactly** `{ task_id, transition, ok: true, issue_url }` (`task_id` is the `public_id` string; `issue_url` is `task.sourceIssueUrl`; no token, no ciphertext). As of #40, a failure can now also write a `回写` row — see "Ack-loss dedupe" immediately below.

**Ack-loss dedupe (#40).** `WRITEBACK_TIMEOUT_MS` narrows but does not close the window described above it: a forge that COMMITS the comment and then fails to acknowledge it before the abort leaves no successful `回写` event, and the uncapped sweep reposts — duplicating a comment on a real Issue. Since none of GitHub, GitLab or Gitea offers any idempotency key or conditional create for comments (measured against their APIs), the write side cannot be made idempotent and only a read-back resolves it. `ForgeAdapter` therefore gained `listIssueComments(cred, issueRef): Promise<string[]>`, which GETs the same collection `commentOnIssue` POSTs to (`…/issues/{n}/comments`; GitLab `…/notes`) under the same host/SSRF rule and the same abort deadline. It requests `per_page=100` for GitHub and GitLab explicitly — GitHub defaults to 30 comments/page and GitLab notes default to 20/page (both max 100, both ascending creation order), so an unpaginated request can miss a just-committed marker sitting past the small default first page on a busy imported Issue. Gitea's comment-listing endpoint accepts no page/limit params at all (measured), so it gets no query string — this is one request with a larger page, never a multi-page loop, and whether Gitea's endpoint returns every comment unbounded or applies some undocumented server-side cap is **unverified**; nothing here claims Gitea is safe from truncation.

Failures are classified DEFINITE versus AMBIGUOUS by parsing the status out of `commentOnIssue`'s own throw idiom specifically (`commentOnIssue: <kind> responded <status>` — anchored to that exact message so the parse cannot drift per forge kind, and so it can never be confused with `listIssueComments`'s own, differently-prefixed throw). DEFINITE is a 4xx status **except** 408 and 429 — a real rejection from the forge API itself, ruling out a forge-side commit. AMBIGUOUS is everything else: every 5xx, 408, 429, and any thrown error carrying no parseable status at all (the `fetch()` call itself rejecting on abort/timeout/network, a decrypt miss, an unparseable `issue_url`). This boundary was corrected (independent review, same issue #40) from an earlier "any status-bearing throw is DEFINITE" rule, which was wrong for exactly the topology AGENTS.md names as this product's own deployment model: a self-hosted GitLab/Gitea behind a reverse proxy or gateway can answer 502/503/504 — or the origin itself can answer 408/429 — *after* already committing the comment, and that must be resolved the same way a bare network failure already is, never treated as "nothing was created". A definite failure behaves exactly as before this issue: swallowed, reposted on the next `retryPendingWritebacks` tick, **zero** `listIssueComments` calls, so the common "forge rejected the request" path costs no extra requests. An ambiguous failure is instead resolved on the *next* attempt, before ever reposting: one `listIssueComments` call, scanning every returned body for the exact comment text `commentBodyFor` already builds (`task.publicId` plus the transition's phrase — no new hidden token), across the whole returned array since Gitea's endpoint documents no ordering. Found → the success event is recorded without reposting. Not found → it posts exactly as before. If the listing call itself fails, that tick is skipped entirely — no repost, no false success recorded, nothing thrown upward — and the recorded `ambiguous` outcome is left intact so a later tick retries the same resolution once listing recovers. There is no attempt cap and no backoff — `retryPendingWritebacks` still retries forever — and none of this touches the Claim, Workflow, PR, or server-availability path, which write-back already stays off via `scheduleWriteback`.

A failed attempt writes `events.type` `回写`, `details` `{ task_id, transition, ok: false, ambiguous }` (`ambiguous` is the classification above; no token) — but **only when this differs from the most recently recorded outcome for that `(task_id, transition)`**, so `retryPendingWritebacks` retrying forever against a persistently-broken forge (down for days, a revoked token) writes exactly one such row for the whole unbroken run, not one per poller tick. A new row is written only when the state genuinely changes (e.g. ambiguous → definite, or the very first failure after none recorded yet) — this is what lets the next attempt know, without a forge round-trip, whether it must resolve an ambiguity before reposting.

**Write-back's own outbound deadline (#37 follow-up).** `writeback.ts` defines `WRITEBACK_TIMEOUT_MS = 30_000` (30s) and passes it as `timeoutMs` only at this one `createForgeAdapter` call inside `postComment` — every other production call site still gets the package's 10s `DEFAULT_TIMEOUT_MS` (see "Outbound fetch timeout (#37)" below). The longer deadline is deliberate: `commentOnIssue` POSTs a durable, user-visible comment onto a real forge Issue, and an abort that fires *after* a slow-but-working forge has already committed that comment leaves no successful `回写` event behind — the uncapped `retryPendingWritebacks` sweep then re-attempts on every poller tick, reposting (and duplicating) that comment on a real Issue each time it does. A 30s budget makes that false-timeout duplication much less likely for an ordinarily-slow forge than the 10s read default would. It does **not** eliminate the window: a forge that is persistently slower than 30s to acknowledge the POST would still hit this same failure mode and still loop under `retryPendingWritebacks`.

`scheduleWriteback(db, task, transition, actorUserId, prUrl?): void` (#36) wraps `attemptWriteback` for both fire-and-forget call sites below: it tracks the returned promise in a module-level `Set` (`trackWriteback`) without awaiting it, so the caller — `claimTask` (#36) and, as of #38, `submitPr` too — returns immediately after its own transaction commits. Because `attemptWriteback` already swallows every fault, the tracked promise itself never rejects (no unhandled-rejection risk). `settleWritebacks(): Promise<void>` (also exported from `writeback.ts`) awaits every currently-tracked writeback and is the deterministic seam tests use to observe a background writeback before asserting on it — it is not called from any request path.

Three call sites, each after its own status transition is already committed (never inside a `db.transaction`, never holding a SQLite write lock across the outbound HTTP call):

| Call site | Transition | `actorUserId` | Awaited by the caller? |
|---|---|---|---|
| `claimTask` (`claim.ts`, both REST claim and MCP `claim_task` share this function) — via `scheduleWriteback` | `'认领'` | the claiming user | **No** (#36) — fired-and-forgotten so a slow/unreachable forge cannot delay the `201` response; tracked internally, not awaited |
| `submitPr` (`claim.ts`, MCP `submit_pr` only — no REST route) — via `scheduleWriteback` | `'提交PR'` | the claiming user | **No** (#38) — same fire-and-forget as claim's, so a slow/unreachable forge cannot delay the `submit_pr` response |
| `applyPrTerminalTransition` (`poller.ts`, shared by `pollPendingReviews` and the webhook receiver) — only when `terminal === 'merged'` | `'完成'` | `null` | Yes (but the transition itself already committed first) |

`已退回` (`terminal === 'closed'`) and `releaseTask` never call `attemptWriteback`. `claimTask` and `submitPr` are `async` as of #14; `registerClaim` and the MCP `claim_task`/`submit_pr` tool handlers `await` the outer function call either way (the transaction, decrypt, and lease/submission work all still complete before the response), but both `claimTask`'s and (as of #38) `submitPr`'s own internal write-back call are fire-and-forget via `scheduleWriteback` — only `applyPrTerminalTransition`'s `完成` write-back is still a direct `await`. Neither response shape (`201` claim envelope; `{ task, pr_url, summary }`) is affected by a writeback failure either way.

`retryPendingWritebacks(db: AppDb): Promise<void>` (exported from `writeback.ts`, re-exported from `poller.ts`; never rejects — a DB fault or one task's fault only skips that task) scans every `imported` task and, for each transition that has already occurred but has no successful `回写` event yet, calls `attemptWriteback` again with a `null` actor:

- 认领 occurred: a `状态迁移` event with `details.to === '进行中'` exists for that task.
- 提交PR occurred: a `submissions` row exists for that task.
- 完成 occurred: `task.status === '已完成'` (uses the latest `submissions.prUrl`).

A transition with an existing successful `回写` (`details.ok === true` for that `task_id` + `transition`) is never retried again. `apps/server/src/app.ts`'s existing poller `setInterval` calls `retryPendingWritebacks(db)` every tick, sequentially right after `pollPendingReviews`, under the same in-flight guard (`.then(() => retryPendingWritebacks(db).catch(() => {}))`).

Web has no vue-router and no `/tasks/:id` route, so the comment body never contains a task deep link — only `PUBLIC_URL` plus the `publicId` text.

### `users` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS users`): `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`, `password_hash TEXT` (nullable, #28), `trusted_automation INTEGER NOT NULL DEFAULT 0` (#16), `device_max_age_days` / `max_devices` / `device_idle_days`; UNIQUE `(provider, remote_id)`. Unique index `users_local_username` on `lower(trim(username))` WHERE `provider = 'local'`. On an existing sqlite file, `createDb` `ALTER TABLE`s missing columns (`trusted_automation`, device policy columns, `password_hash TEXT`) and swallows "duplicate column name". Then `promoteEarliestLoginableAdmin`: if no `active`+`admin` with provider `local`/`gitlab`/`gitea`, the earliest `active`+`full` among those providers becomes `admin`; leftover GitHub `full` is not promoted and does not count as a loginable admin.

Drizzle enums in `apps/server/src/schema.ts`: `provider` `github` | `gitlab` | `gitea` | `local`; `status` `active` | `待批准` | `revoked`; `permission_level` `admin` | `full` | `claim_only`. `passwordHash` maps to `password_hash` (nullable text). `trusted_automation` is `integer(..., { mode: 'boolean' })`, default `false`.

Inserts: `POST /api/v1/setup` creates the first loginable admin (`local` / `active` / `admin`). GitLab/Gitea OAuth (`completeUserLogin`) inserts `active`+`full` only after `countLoginableAdmins > 0`; with zero loginable admins it inserts nothing. `KAOLA_ADMINS` is ignored (malformed or `github:…` still `buildApp()`; does not enable `GET /login/github`). `trusted_automation` always starts `false`. Subsequent OAuth of an existing row updates `username` and `display_name` only. `revoked` existing users redirect `/login?reason=revoked`.

### `claim_confirmations` table (#16 / #27)

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS claim_confirmations`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `task_id INTEGER NOT NULL` (integer `tasks.id`, not `public_id`), `user_id INTEGER NOT NULL`, `device_id INTEGER NOT NULL`, `agent_key_id INTEGER` (nullable leftover), `state TEXT NOT NULL`, `created_at INTEGER NOT NULL`. No unique constraint — `claimTask` and `registerClaimConfirmations` both enforce "at most one live (`'pending'`) row per `(task_id, user_id, device_id)`" in application code (`findClaimConfirmations`), not in the schema.

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

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS leases`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `task_id INTEGER NOT NULL`, `claimer_user_id INTEGER`, `claimer_claimant_id INTEGER`, `device_id INTEGER NOT NULL`, `agent_key_id INTEGER`, `claimed_at INTEGER NOT NULL`, `expires_at INTEGER NOT NULL`, `last_heartbeat INTEGER NOT NULL`, `state TEXT NOT NULL`, `request_id TEXT` (nullable, added via `ALTER TABLE` for an existing file, #36).

Unique indexes: `leases_one_active_per_task` on `leases(task_id) WHERE state = 'active'`; `leases_device_request_identity` on `leases(device_id, request_id) WHERE request_id IS NOT NULL` (#36) — the `(device_id, request_id)` idempotency key for a claim attempt.

`task_id` is the integer `tasks.id` PK, not `public_id`. Drizzle enum in `schema.ts`: `state` `'active' | 'released' | 'expired'`. Lease times are unix seconds. TTL is `LEASE_TTL_SECONDS` `86400` in `leases.ts` (no per-task TTL column). Expiry uses `expires_at <= now` via `sweepExpiredLeases` (one transaction per expired lease, #31: sets `state` `'expired'`, transitions the task `进行中` → `待认领` when the task is still `进行中`, and writes the `状态迁移` audit — all three or none). No cron.

`claim_id` is **not** a column on this table. `leases.ts`'s `claimIdForLease(lease)` derives an opaque `clm_`-prefixed public identity from a length-prefixed concatenation of the row's immutable fields (`id`, `task_id`, `device_id`, `claimed_at`, `request_id`, `claimer_user_id`, `claimer_claimant_id`) hashed with `sha256` — never `state`/`expires_at`/`last_heartbeat`, so a heartbeat or a terminal transition never changes a Claim's own `claim_id` (#36).

### `submissions` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS submissions`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `task_id INTEGER NOT NULL`, `lease_id INTEGER NOT NULL`, `pr_url TEXT NOT NULL`, `summary TEXT NOT NULL`, `pr_state TEXT NOT NULL`.

Unique index `submissions_lease_id` on `submissions(lease_id)` (#31) — enforces one submission per Claim (lease) at the storage layer, matching `submit_pr`'s idempotent-repeat contract.

`task_id` is the integer `tasks.id` PK, not `public_id`. Drizzle in `schema.ts` maps `taskId`/`leaseId`/`prUrl`/`summary`/`prState` with no enum on `pr_state`. `pr_url` is stored **canonicalized** (#31, `canonicalizePrUrl` in `claim.ts`: origin plus a pathname with any trailing slash and a `/files`, `/commits`, or `/diffs` sub-page suffix stripped) — the same form the webhook receiver and the poller compare/feed back, independent of forge kind. MCP `submit_pr` success inserts `pr_state` `'open'`. `pollPendingReviews` later updates that same row's `pr_state` to `'merged'` or `'closed'` (never back to `'open'`) once the PR leaves the open state. A canonical `pr_url` already held by a *different* task's `pr_state === 'open'` row blocks a new `submit_pr` (`pr_url_taken`, #31) — same-task reuse of the row is the idempotent-repeat path instead.

### `events` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS events`): `id INTEGER PRIMARY KEY AUTOINCREMENT`, `type TEXT NOT NULL`, `actor_user_id INTEGER`, `created_at INTEGER NOT NULL`, `details TEXT NOT NULL`.

`GET /api/v1/events` / `GET /api/v1/stats` (#15, above) are read-only surfaces over this table — nothing here changes what gets written. Rows written in source:

- profile create/delete: `type` `变更`, `details` JSON `{ "action": "create" | "delete", "profile_id": <n> }`
- `revealCredentialProfile`: `type` `token 揭示`, `details` JSON `{ "agent_key_id": <n>, "profile_id": <n> }`
- POST `/api/v1/tasks` profile path (after decrypt, including 422 / 502): `type` `token 揭示`, `details` JSON `{ "profile_id": <n>, "forge": <forge>, "base_url": <string>, "full_name": <string>, "outcome": "ok" | "token_check_failed" | "forge_unreachable" }` (no token; no `agent_key_id`; inline path does not write this)
- POST `/api/v1/tasks/import` profile path (after decrypt, including 404 / 422 / 502): `type` `token 揭示`, `details` JSON `{ "profile_id": <n>, "forge": <forge>, "base_url": <string>, "full_name": <string>, "outcome": "ok" | "issue_not_found" | "token_check_failed" | "forge_unreachable" }` (no token; no `agent_key_id`; inline path does not write this)
- PATCH `/api/v1/tasks/:publicId` success: `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": <status>, "to": <status> }`
- POST `/api/v1/tasks/:publicId/claim` `201` success: `type` `token 揭示`, `details` JSON `{ "task_id": <public_id>, "device_id": <n>, "credential": "inline" | "profile", "profile_id"?: <n>, "claimant_id"?: <n>, "claim_id": <string>, "request_id": <string> | null, "autonomous": <boolean> }` (`profile_id` only when `credential === 'profile'`, integer profile PK; `claimant_id` only when the claimer is a claimant rather than a Web user; no plaintext, no ciphertext; `claim_id`/`request_id`/`autonomous` added #36) then `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": <status>, "to": <status> }` (claimer `actor_user_id`). A replayed claim (#36, matching `request_id`) writes only that first `token 揭示` event again with `"replay": true` added, and no new `状态迁移`
- POST `/api/v1/tasks/:publicId/claim` `202` pending (#16, `autonomous: true` + not `trusted_automation`, no existing `'approved'` row): `type` `认领待确认`, `details` JSON `{ "task_id": <public_id>, "device_id": <n> }` (claimer `actor_user_id`; no `token 揭示`, no `状态迁移` — the task never leaves `待认领`)
- POST `/api/v1/claim-confirmations/:id/approve` success (#16): `type` `认领已确认`, `details` JSON `{ "task_id": <public_id>, "device_id": <n> }` (approving session user `actor_user_id`); reject writes no event
- `POST /api/v1/setup` success: `type` `管理员创建`, `details` JSON `{ "user_id": <n> }` (no password/hash)
- `POST /api/v1/users/:id/promote` when flipping `full` → `admin`: `type` `权限变更`, `details` JSON `{ "target_user_id": <n>, "from": "full", "to": "admin" }`
- POST `/api/v1/tasks/:publicId/progress` success: `type` `心跳`, `details` JSON `{ "task_id": <public_id>, "note": <string> }` (`note` is `''` when omitted)
- POST `/api/v1/tasks/:publicId/release` success: `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": <status>, "to": <status>, "reason"? }` (`reason` only when body had string `reason`)
- MCP `submit_pr` success (`submitPr` in `claim.ts`): `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": "进行中", "to": "待验收", "pr_url": <string>, "summary": <string> }` (`pr_url` is the canonicalized form, #31; claimer `actor_user_id`)
- lease expiry in `sweepExpiredLeases`: `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": "进行中", "to": "待认领" }`, `actor_user_id` null
- `applyPrTerminalTransition` merged/closed transition (`poller.ts`, shared by `pollPendingReviews` and `registerWebhooks`'s `POST /api/v1/webhooks/:publicId`, #13): `type` `状态迁移`, `details` JSON `{ "task_id": <public_id>, "from": "待验收", "to": "已完成" | "已退回", "pr_url": <string> }` (no `summary` key), `actor_user_id` null
- `attemptWriteback` success (`writeback.ts`, #14; imported tasks only, on 认领 / 提交PR / 完成-when-merged): `type` `回写`, `details` JSON `{ "task_id": <public_id>, "transition": "认领" | "提交PR" | "完成", "ok": true, "issue_url": <string> }` (no token; `actor_user_id` is the acting user for 认领/提交PR, `null` for 完成 and for any `retryPendingWritebacks`-driven write-back). A failed attempt records `details` `{ "task_id": <public_id>, "transition": …, "ok": false, "ambiguous": <bool> }` (#40, `actor_user_id` `null`) — `ambiguous` is `true` when the outbound `fetch` itself rejected (abort/timeout/network), so the forge-side outcome is unknown, and `false` when a real HTTP status came back, meaning nothing was created. This row is written **only when the outcome changes**: `retryPendingWritebacks` retries forever on every poller tick, so repeated identical failures collapse to a single row rather than one per tick; an `ambiguous`↔definite change does record, because the next tick's behaviour depends on it. Note the guard compares only the IMMEDIATELY PRECEDING outcome, so a forge that *flaps* — a timeout one tick, a 502 the next — alternates the outcome and therefore still writes one row per tick. Growth is bounded by real outcome transitions, not by elapsed time, which is not the same as bounded absolutely. It exists so the next attempt knows whether it must check the forge before reposting (see "Ack-loss dedupe" below).

`created_at` is unix seconds.

### Vault (`apps/server/src/vault.ts`)

`encryptToken(plaintext: string): string` / `decryptToken(encoded: string | Buffer): string`. Algorithm `'aes-256-gcm'`, `{ authTagLength: 16 }`, IV `randomBytes(12)`. Stored blob is `iv || ciphertext || tag` as base64 TEXT in `token_encrypted`.

`insertAuditEvent(db, { type, actorUserId, details })` with `actorUserId: number | null` (expiry writes SQL NULL).

`revealCredentialProfile(db, { profileId, actorUserId, agentKeyId })` decrypts the profile row and returns the plaintext string. Missing row throws `Error('credential profile not found')`. Writes a `token 揭示` event. Does not log the token. Not an HTTP handler. Forge token reveal channels: successful device-proof `POST /api/v1/tasks/:publicId/claim` `201` top-level `token` and MCP `claim_task` success `token`. `POST /api/v1/tasks/import` `200` never contains a forge token. `apps/server/src/writeback.ts`'s `decryptTaskToken(db, task)` (used by `attemptWriteback`, #14) decrypts the task's own credential the same way `claimTask` does, but resolves to `undefined` on any failure instead of throwing, and does not write a `token 揭示` event (that event denotes a reveal to a principal; write-back's decrypt, like the poller's, never returns the plaintext anywhere).

### Env (`registerAuth`)

Required (throw `missing required environment variable …` if empty): `SESSION_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`, `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL`. GitHub client id/secret remain **required at boot** (`requireEnv` in `registerAuth`) even though GitHub login is retired (`GET /login/github` is 404); they are unused for login. GitLab / Gitea OAuth apps are what the login buttons use.

Optional: `PUBLIC_URL` default `http://localhost:31415` (trailing slash stripped via `trimTrailingSlash` / `replace(/\/+$/, '')` in `auth.ts`; write-back uses the same default with `replace(/\/+$/u, '')`). When the trimmed value `startsWith('https:')`, TLS follows DESIGN §12 #46 two-mode contract: `DEBUG_PRIVATE_CA` (enrolled machines; root-signed leaf SAN = `<public-host>`; `NODE_EXTRA_CA_CERTS` on the MCP bridge only) or `STABLE_PUBLIC_CA` (clean-machine default trust; ACME DNS-01 fullchain for `<production-subdomain>`). Cookie `Secure` / `trustProxy` (below) assume the terminator already presented whatever that mode requires — they do not make a CN-only self-signed leaf trusted. Real host / `<https-port>` / DNS provider / cert identity are not in this repo. `kaola-mcp --url` uses runtime-default TLS verification; `NODE_TLS_REJECT_UNAUTHORIZED=0` and `--insecure` are not part of the client contract. On an enrolled debug machine, `NODE_EXTRA_CA_CERTS` may be scoped to the user-local MCP server process and point to the verified public root CA certificate; it is never a clean-machine default, and its local path/value is not committed. `KAOLA_ADMINS` if set is **ignored** (not an invite list, does not grant GitHub login, does not fail boot). Process `index.ts`: `PORT` default `'31415'`, `HOST` default `'0.0.0.0'`, `SQLITE_PATH` default `':memory:'` (compose overrides to `/data/kaola.sqlite`; non-compose unset still in-memory). Optional `WEB_DIST` and `VITE_DEV_TARGET` (not required by `registerAuth`). Optional `KAOLA_HOME` for `kaola-mcp` (default `~/.kaola`).

Callback URIs actually registered: `${publicUrl}/login/gitlab/callback` and `${publicUrl}/login/gitea/callback` (`publicUrl` is the trimmed `PUBLIC_URL`). `${publicUrl}/login/github/callback` is a 404 handler, not an OAuth callback. Post-login redirect is still `reply.redirect('/')` (relative). Intranet deploy: forge OAuth Redirect URI is the GitLab/Gitea callback under the browser-facing `PUBLIC_URL` (may coexist with a localhost callback); `OAUTH_GITLAB_BASE_URL` / `OAUTH_GITEA_BASE_URL` are the **server-to-forge** origins (trim trailing slash), not the public entry.

Cookie `Secure` and Fastify `trustProxy` (`cookieSecureFromPublicUrl`, `COOKIE_SECURE_TRUST_PROXY` in `auth.ts`; constructor in `app.ts`): `cookieSecure` is true iff trimmed `PUBLIC_URL` `startsWith('https:')` (not `'auto'`). Session `@fastify/session` cookie: `{ path: '/', secure: cookieSecure, httpOnly: true, sameSite: 'lax' }`, `saveUninitialized: false`. OAuth `@fastify/oauth2` cookie: `{ path: '/', secure: cookieSecure }`. When `cookieSecure`, `buildApp` uses `Fastify({ trustProxy: [...COOKIE_SECURE_TRUST_PROXY] })` where the list is `'127.0.0.1'`, `'::1'`, `'10.0.0.0/8'`, `'172.16.0.0/12'`, `'192.168.0.0/16'` (loopback + RFC1918 peers for a TLS-terminating reverse proxy). When not `cookieSecure`, `Fastify()` with no `trustProxy`. Do not use hop-count `1` (Fastify 5.12.1 no-op) or `true`. `persistSession(request, userId, { skipUntrusted: true })` is used at three call sites: OAuth `completeOAuthLogin`, `POST /api/v1/setup`, and `POST /api/v1/login`. `shouldSkipSessionSave` is `request.session.cookie.secure === true && request.protocol !== 'https' && !isTrustedSessionPeer(request)`. `isTrustedSessionPeer` checks `COOKIE_SECURE_TRUST_PROXY` (loopback + RFC1918) via `node:net` `BlockList`, stripping a leading `::ffff:`. When skip fires there is no `session.save()`, so `@fastify/session` `onSend` does not emit `sessionId`; OAuth still redirects, setup still `201` `publicUser` (user created), login still `200` `publicUser` (credentials valid). Trusted loopback/RFC1918 still get a Secure `sessionId` (including a default inject peer without `X-Forwarded-Proto`). An untrusted public peer spoofing `X-Forwarded-Proto` does not.

### Env (`VAULT_MASTER_KEY`)

Read by `encryptToken` / `decryptToken` in `vault.ts` when encrypting or decrypting. Not required at `buildApp()` or `registerAuth` boot.

Must match `/^[0-9a-fA-F]{64}$/` and decode to 32 bytes. Missing, empty, or invalid → `VaultUnconfiguredError` (`code` `vault_unconfigured`). Create-profile HTTP, `POST /api/v1/tasks`, `POST /api/v1/tasks/import` (profile decrypt), `POST /api/v1/tasks/:publicId/claim`, and MCP `claim_task` (same `claimTask` decrypt) map that to `500` `{ error: 'vault_unconfigured' }` (MCP: `isError` + that body, HTTP 200). Not `SESSION_SECRET`.

`.env.example` at the repo root lists empty keys matching `docker-compose.yml` pass-through (`PUBLIC_URL`, `SESSION_SECRET`, `VAULT_MASTER_KEY`, nine `OAUTH_*`). `.env` is gitignored; compose uses `env_file: .env`. Local `pnpm dev` still does not load `.env` (export into the shell as in the README).

Server dependencies: `@fastify/oauth2@^8.3.0`, `@fastify/cookie@^11.1.2`, `@fastify/session@^11.1.2`, `@fastify/static@^10.1.3`, `@fastify/http-proxy@^11.6.0`, `"@kaola/shared": "workspace:*"`, `"@kaola/forge-adapters": "workspace:*"`, `"@modelcontextprotocol/sdk": "1.30.0"`, `"zod": "^4.4.3"` (plus existing `fastify`, `drizzle-orm`, `better-sqlite3`). Vault and agent-key hashing use `node:crypto` (no extra npm package). Agent Bearer is the encapsulated hook in `agent-bearer.ts`, not `@fastify/bearer-auth`.

## `@kaola/forge-adapters`

Package export `"."` → `./src/index.ts`. No runtime HTTP dependency (global `fetch`).

- `getForgeAdaptersHealth(): string` → `'kaola-forge-adapters-ready'`
- `createForgeAdapter(kind, options?: { baseUrl?: string; webhookSecret?: string; timeoutMs?: number }): ForgeAdapter`
- `parseIssueUrl(kind, issueUrl): { full_name: string } | undefined`
- `class WebhookSignatureError extends Error` (`name === 'WebhookSignatureError'`, default message `'invalid webhook signature'`)

Unknown `kind` to `createForgeAdapter` throws `Error('unknown forge kind: …')`.

`validateToken`, `importIssue`, `listIssues`, `registerWebhook`, `parseWebhook`, `commentOnIssue` are `ForgeAdapter` methods, not package-level exports. `parseIssueUrl(kind, issueUrl): { full_name: string } | undefined` **is** a package-level export (same Issue URL parsers as `importIssue`).

Types: `ForgeKind` `'github' | 'gitlab' | 'gitea'`; `Credential` `{ token: string }`; `RepoRef` `{ full_name: string; base_url: string }`; `TokenCapability` `'读' | '推' | 'PR'`; `TokenCheck` `{ missing: TokenCapability[] }`; `CreateForgeAdapterOptions` (`{ baseUrl?: string; webhookSecret?: string; timeoutMs?: number }`, `timeoutMs` #37); `ForgeAdapter`.

**Outbound fetch timeout (#37).** The two central fetch helpers, `forgePost` and `forgeGet` (used by every adapter method except `parseWebhook`, which never fetches), pass `signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)` to `globalThis.fetch`, where `DEFAULT_TIMEOUT_MS` is `10_000` (10s). This bounds `validateToken`, `getPullRequest`, `registerWebhook`, `importIssue`, `listIssues`, and `commentOnIssue` alike, identically across github/gitlab/gitea — a forge that hangs (rather than refuses) now aborts and rejects instead of blocking the caller forever. `timeoutMs` is per-adapter-instance (set once at `createForgeAdapter(kind, options)` call time, not per call). Five of the six production `createForgeAdapter` call sites (`credential-profiles.ts`, `poller.ts`, `webhook.ts`, `tasks.ts` ×2) pass no `timeoutMs` and so run under the 10s default; the sixth, `writeback.ts`'s `postComment`, deliberately passes `timeoutMs: WRITEBACK_TIMEOUT_MS` (`30_000`, 30s) instead — see "Write-back's own outbound deadline" above for why a durable comment POST gets a longer budget than a read. New shared spec `packages/forge-adapters/src/timeout.shared.test.ts`, parameterized over github/gitlab/gitea.

`ImportedIssue` is `{ title: string; description_md: string; issue_url: string; repo: { full_name: string } }` (no longer `unknown`, #12). `ListedIssue` is `{ number: number; title: string; issue_url: string }` (#19). `PrStatus` is `{ state: 'open' | 'merged' | 'closed' }` (no longer `unknown`, #11). `ForgeEvent` is `{ type: 'pull_request'; state: 'merged' | 'closed'; pr_url: string; repo: { full_name: string } }` (no longer `unknown`, #13) — `parseWebhook` returns this or `null`. `IssueRef` is `{ issue_url: string }` (no longer `unknown`, #14).

Implemented: `kind` + `validateToken` (GET-only) + `getPullRequest` (GET-only, #11) + `importIssue` (GET-only, #12) + `listIssues` (GET-only, #19) + `registerWebhook` (POST, #13) + `parseWebhook` (no fetch, #13) + `commentOnIssue` (POST, #14).

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

### `listIssues(cred, repo)` (#19)

`listIssues(cred: Credential, repo: RepoRef): Promise<ListedIssue[]>`. Host rule matches `importIssue` / `getPullRequest` (`prApiOrigin`): GitHub REST origin is always `https://api.github.com`; GitLab/Gitea REST origin is the adapter constructor `options.baseUrl` (trailing slashes stripped), **never** `repo.base_url`'s host. Auth headers reuse `forgeGet` / `authHeaders`. One GET; query strings as in source:

- GitHub: `GET https://api.github.com/repos/{owner}/{name}/issues?state=open&per_page=50&sort=created&direction=desc` (`owner`/`name` from `repo.full_name` split on the first `/`, each `encodeURIComponent`-ed)
- GitLab: `GET {baseUrl}/api/v4/projects/{encodeURIComponent(full_name)}/issues?state=opened&per_page=50&order_by=created_at&sort=desc`
- Gitea: `GET {baseUrl}/api/v1/repos/{owner}/{name}/issues?state=open&type=issues&limit=50`

`ListedIssue.issue_url` is **constructed** from `repo.base_url` (trailing slashes stripped) plus `repo.full_name` — never copied from JSON `html_url` / `web_url`:

- GitHub / Gitea: `{base_url}/{full_name}/issues/{number}`
- GitLab: `{base_url}/{full_name}/-/issues/{number}` where `number` is JSON `iid` (not `web_url`)

GitHub items with a `pull_request` key are dropped. Mapping skips an item whose number/`iid` is not a `number`. A non-array JSON body rejects with `listIssues: ${kind} response is not an array`. A non-OK HTTP response rejects after `fetch` with `listIssues: ${kind} responded ${status}`.

New shared spec `packages/forge-adapters/src/list-issues.shared.test.ts`, parameterized over github/gitlab/gitea.

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
