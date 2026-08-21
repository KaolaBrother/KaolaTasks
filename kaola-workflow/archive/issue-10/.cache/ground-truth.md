## Exploration: MCP server wrap surface (issue #10)

Worktree measured: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10`  
Forge issue: https://github.com/KaolaBrother/KaolaTasks/issues/10  
Comments override body. Body: official MCP TS SDK, six tools, API Key auth, unauthenticated rejected, params/returns match DESIGN.md §9.  
Comment `#issuecomment-5356076474`: `claim_task` return must include `suggested_dir` + token-hygiene guidance; **tool description text** must mention token hygiene.  
This issue owns MCP including `submit_pr` → `待验收`. PR polling / reopen / `getPullRequest` is #11 (`https://github.com/KaolaBrother/KaolaTasks/issues/11`; no comments).

---

### Entry Points

- `buildApp(options?)` (`apps/server/src/app.ts`): process boot (`apps/server/src/index.ts` `listen`) and every HTTP test (`app.inject` after `app.ready()`). Creates SQLite via `createDb`, registers plugins, returns a Fastify instance. Does **not** `listen` or `ready`.
- Session cookie (Web): `getSessionUser` (`auth.ts`) reads `request.session.userId`. Used by `GET/POST /api/v1/tasks`, `GET/PATCH /api/v1/tasks/:publicId`, agent-key CRUD, profiles, `/api/v1/me`. **Does not accept Bearer.**
- Bearer Agent Key: `addAgentBearerHook` (`apps/server/src/agent-bearer.ts`) on encapsulated child plugins only. Used today by `GET /api/v1/agent/whoami` (`registerAgentKeys`) and `POST /api/v1/tasks/:publicId/{claim,progress,release}` (`registerClaim`).
- Shared state machine: `transitionTaskStatus(from, to)` (`packages/shared/src/index.ts`).
- Task brief serializer: exported `taskBrief({ task, posterUsername })` (`apps/server/src/tasks.ts`).
- Lease expiry: `sweepExpiredLeases(db)` (`apps/server/src/leases.ts`) — check-on-read (session GET list/one) and check-on-write (claim/progress/release). **No cron.**

There is **no** MCP server, **no** `/mcp` route, **no** `submit_pr` HTTP, **no** `@modelcontextprotocol/sdk` in any `package.json` or `pnpm-lock.yaml`.

---

### Execution Flow

1. `buildApp({ sqlitePath?, webDist?, viteDevTarget? })` → `createDb(sqlitePath ?? ':memory:')` → `Fastify()` → `app.addHook('onClose', () => db.$client.close())`.
2. Hosting: empty `webDist` and `viteDevTarget` (empty string treated as omitted via `nonemptyOption`) → `GET /` `text/plain; charset=utf-8` body `getPlaceholderBody()` = `考拉任务服务占位`. Non-empty `webDist` wins over `viteDevTarget`: `@fastify/static` + `GET /` `sendFile('index.html')` + `setNotFoundHandler` SPA fallback for GET that is **not** `/api`, `/api/*`, or `/login*`. Only `viteDevTarget`: `@fastify/http-proxy` `GET`/`HEAD` + websocket; `preHandler` `reply.callNotFound()` when `isApiOrLoginPath`.
3. Plugin order (sync calls on the parent instance): `registerAuth` → `registerAgentKeys` → `registerCredentialProfiles` → `registerTasks` → `registerClaim` → hosting. `registerAuth` **throws** `missing required environment variable <NAME>` if any of `SESSION_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`, `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL` is missing/empty. `VAULT_MASTER_KEY` is **not** read at boot.
4. Bearer child: `app.register(async function agentBearerContext|claimBearerContext(child) { addAgentBearerHook(child, db); child.get/post(...) })`. The `onRequest` hook is **encapsulated** — it does **not** run on session routes. Putting `addAgentBearerHook` on the parent would 401 `GET /` and all session APIs.
5. `addAgentBearerHook` flow: parse `authorization` with `/^Bearer\s+(\S+)/i` → sha256 utf8 hex of plaintext → `SELECT` `agent_keys` `WHERE key_hash =` presented hash → `timingSafeEqual` on hex buffers → load `users` by `key.userId` → on any miss: `sendBearerUnauthorized` (`401` `{ error: 'unauthorized' }` + header `WWW-Authenticate: Bearer`) and **do not** bump `last_used_at`. On hit: `UPDATE agent_keys SET last_used_at = unix_seconds WHERE id = key.id`, set `request.agentAuth = { user, key }`. **Does not inspect `users.status`.** So a later handler 403 (pending claim) still ticks `last_used_at`.
6. Session `GET /api/v1/tasks` / `GET /api/v1/tasks/:publicId`: any logged-in user including `status === '待批准'`. Unauth: `sendUnauthorized` → JSON Accept `401 { error: 'unauthorized' }` (no `WWW-Authenticate`); otherwise `302 /login`. Handler: `sweepExpiredLeases` then `selectTasks`/`selectTask` then `taskBrief`. **Ignores query string.** No `status`/`tags`/`forge` filters. No Bearer path. Address is `public_id` (`kt-YYYY-NNNN`); numeric `"1"` is `404 { error: 'not_found' }`.
7. Bearer `POST /api/v1/tasks/:publicId/claim`: hook first → `requireAgentAuth` → **if `auth.user.status === '待批准'` then `403 { error: 'forbidden', message: '你的账号待正式成员批准后方可认领任务。' }` before any decrypt** → `sweepExpiredLeases` → `selectTask` → 404 / 409 `进行中` (`conflict`, `任务已被认领。`) / 409 other non-`待认领` (`illegal_transition`, Chinese message to `进行中`) → decrypt profile or inline ciphertext → `transitionTaskStatus(from, '进行中')` → insert `leases` `state='active'` TTL `86400` → audit `token 揭示` then `状态迁移` → `201` envelope.
8. Bearer `POST …/progress`: no pending check; `sweepExpiredLeases`; no live lease → `409 { error: 'conflict', message: '任务未被认领。' }`; `lease.claimerUserId !== auth.user.id` → `403 { error: 'forbidden' }` (no `message`); else `renewActiveLease` (`expires_at = now + 86400` from heartbeat, not claim time), event `心跳`, `200 { task, lease }` **no `token`**. Body `note` optional string; omit/non-string → event `note: ''`. Does **not** check `tasks.status === '进行中'`.
9. Bearer `POST …/release`: same 401/404/403/409 as progress; `markLeaseReleased` (`state='released'`); `transitionTaskStatus(from, '待认领')`; event `状态迁移`; `200 { task }` **no `token`, no `lease`**. Optional string `reason` is included in event `details` **only when present**; omitted → `details` has no `reason` key (`Object.hasOwn` false).
10. `sweepExpiredLeases`: `state='active' AND expires_at <= now` → set `expired`; if task still `进行中`, `transitionTaskStatus('进行中','待认领')` and `insertAuditEvent` type `状态迁移`, **`actorUserId: null`**, details `{ task_id: publicId, from: '进行中', to: '待认领' }`. If task is no longer `进行中`, lease is still marked `expired` but status is left alone.

---

### Architecture Insights

- **Encapsulated Bearer hook, not `@fastify/bearer-auth`:** two independent Fastify child plugins (`agentBearerContext`, `claimBearerContext`) both call `addAgentBearerHook`. MCP must use a **third child** (or share one child) with the same hook; never attach it to the root instance.
- **Session vs Agent are disjoint oracles:** session 401 has no `WWW-Authenticate`; Bearer 401 always does. Cookie does not authorize whoami/claim; Bearer does not authorize `GET /api/v1/me` or `GET /api/v1/tasks`.
- **REST does not fully mirror DESIGN §9:** list/get are session-only and unfiltered; `submit_pr` has no HTTP at all. MCP cannot “just HTTP-inject” list/get as an Agent. Reuse **functions** (`selectTask`, `taskBrief`, lease helpers, `decryptToken`, `insertAuditEvent`, `transitionTaskStatus`), not the session routes.
- **Reveal-on-claim only:** the **only** HTTP that returns forge plaintext is successful claim `201` top-level `token`. `taskBrief` / session GET / progress / release / error bodies must not contain key names `token` | `token_encrypted` | `inline_token_encrypted` | `access_token` (claim 201 may have top-level `token` only; nested `task`/`lease`/`clone` must not).
- **Check-on-read/write, no cron:** MCP `list_tasks` / `get_task_brief` / mutating tools must call `sweepExpiredLeases` the same way or Agents will see stale `进行中`.
- **State machine already allows `submit_pr`:** `进行中 → 待验收` is legal in `@kaola/shared`. Poster `PATCH` **refuses** that edge (`POSTER_TRANSITIONS` only 待认领→已取消 and 已退回→已取消|待认领). First writer of 进行中→待验收 is this issue’s MCP `submit_pr`.
- **Hosting collision for `/mcp`:** `isApiOrLoginPath` is only `/api`, `/api/`, `/login`. A GET `/mcp` with `webDist` hits SPA `index.html`; with only `viteDevTarget` the proxy forwards GET/HEAD to Vite. Mount under `/api/` (e.g. `/api/mcp`) or register the route such that it wins **and** extend `isApiOrLoginPath` if the path is not under `/api`. DESIGN §12 “首选同进程挂载”; it does not name the URL.
- **Filters exist only in the Vue board:** `App.vue` `filteredBoardTasks` is client-side: `status` exact, `tags.includes(tag)`, `repo.forge` exact. `GET /api/v1/tasks` is called with **no query**. DESIGN `list_tasks` params `status?` `tags?` `forge?` are MCP-side new work.

---

### Key Files

| File | Role | Importance |
|---|---|---|
| `apps/server/src/app.ts` | `buildApp`, plugin order, `onClose`, hosting / `isApiOrLoginPath` | Critical |
| `apps/server/src/agent-bearer.ts` | `addAgentBearerHook`, `sendBearerUnauthorized`, `request.agentAuth` | Critical |
| `apps/server/src/agent-keys.ts` | Session key CRUD; child whoami; pending generate gate | Critical |
| `apps/server/src/claim.ts` | Bearer claim/progress/release; reveal envelope; clone hygiene string | Critical |
| `apps/server/src/leases.ts` | `LEASE_TTL_SECONDS=86400`, CRUD + `sweepExpiredLeases` | Critical |
| `apps/server/src/tasks.ts` | Session CRUD; exported `taskBrief` / `selectTask`; **unexported** `selectTasks` | Critical |
| `apps/server/src/schema.ts` + `db.ts` | `users`/`agent_keys`/`tasks`/`leases`/`events` DDL; unique one-active lease | Critical |
| `apps/server/src/vault.ts` | `encryptToken`/`decryptToken`/`insertAuditEvent`/`revealCredentialProfile` | Critical |
| `packages/shared/src/index.ts` | `taskBriefSchema` / `parseTaskBrief` / `transitionTaskStatus` | Critical |
| `apps/server/src/auth.ts` | OAuth, session, `getSessionUser`, `sendUnauthorized`, user status | High |
| `docs/DESIGN.md` §5–§11 | Intended MCP tool table + lifecycle; not all implemented | High |
| `docs/api.md` | Implemented REST (says MCP tools are not implemented) | High |
| `apps/server/src/claim.test.ts` | Boot/env/login/mint/seed/assert envelope patterns to reuse | High |
| `apps/server/src/tasks.test.ts` | `assertNoTokenMaterial`; session task fixtures | High |
| `apps/server/src/agent-keys.test.ts` | Bearer whoami / `last_used_at` / pending generate | High |
| `apps/web/src/App.vue` | Client-side list filters (status/tags/forge) | Medium |

---

### Dependencies

- External (server today): `fastify@^5.4.0`, `@fastify/cookie@^11.1.2`, `@fastify/session@^11.1.2`, `@fastify/oauth2@^8.3.0`, `@fastify/static@^10.1.3`, `@fastify/http-proxy@^11.6.0`, `better-sqlite3@^12.2.0`, `drizzle-orm@^0.44.4`, `node:crypto`. **No** `@modelcontextprotocol/sdk`, **no** `@fastify/bearer-auth`.
- External (shared): `zod@^4.4.3`.
- Internal: `@kaola/server` → `@kaola/shared` + `@kaola/forge-adapters` (`workspace:*`). MCP wrap does **not** need forge adapters (`claim` does not call `validateToken`; grep of claim success path: outbound fetch length 0).
- Missing for this issue: `@modelcontextprotocol/sdk` (DESIGN §12 names it). Not present in root or workspace `package.json` / lockfile.

---

### Recommendations for New Development

- Follow the encapsulated-child + `addAgentBearerHook` pattern; reject missing/wrong/non-Bearer with `sendBearerUnauthorized` (same 401 body + `WWW-Authenticate: Bearer` as whoami/claim).
- Reuse `taskBrief` + `parseTaskBrief` as the never-token card; reuse `selectTask`; **export or share** `selectTasks` rather than duplicating the join; always `sweepExpiredLeases` before read/write.
- Reuse claim/progress/release **behavior** (status codes, Chinese messages, event `type` strings, clone hygiene). Prefer extracting handlers over HTTP-injecting REST, because list/get have no Bearer twin and `submit_pr` has no REST.
- Avoid attaching the Bearer hook to the root Fastify instance; avoid returning forge tokens from `list_tasks` / `get_task_brief`; avoid calling `revealCredentialProfile` for claim (wrong `details` shape); avoid putting token in `task.credential` or remote URL; avoid implementing PR polling / `待验收→已完成|已退回` (#11); avoid assuming GET `/mcp` is safe under SPA/Vite hosting.

---

## Load-bearing facts (pin before tests)

### Issue #10 tool contract (comments > body)

| MCP tool | DESIGN §9 params | Implemented REST twin | Notes |
|---|---|---|---|
| `list_tasks` | `status?` `tags?` `forge?` | `GET /api/v1/tasks` session, **no query**, `{ tasks: [brief, ...] }` ordered by integer PK `id` | Agent has **no** Bearer list HTTP. Filters are new MCP work. Web semantics: status `===`, tags **membership** (`includes`), forge `=== repo.forge`. |
| `get_task_brief` | `task_id` | `GET /api/v1/tasks/:publicId` session, **brief at top level** (not wrapped) | `task_id` = `public_id` `kt-YYYY-NNNN`, **not** integer PK. |
| `claim_task` | `task_id` | `POST /api/v1/tasks/:publicId/claim` Bearer **`201`** | Envelope keys **exactly** `clone`, `lease`, `task`, `token`. |
| `report_progress` | `task_id` `note` | `POST /api/v1/tasks/:publicId/progress` Bearer **`200`** | REST: `note` optional; omit/non-string → `''`. Envelope keys **exactly** `lease`, `task`. No `token`. |
| `submit_pr` | `task_id` `pr_url` `summary` | **DOES NOT EXIST** | Must `transitionTaskStatus('进行中','待验收')`. No polling. |
| `release_task` | `task_id` `reason` | `POST /api/v1/tasks/:publicId/release` Bearer **`200`** | REST: `reason` optional. Envelope keys **exactly** `task`. No `token`, no `lease`. |

Unauthenticated MCP calls must be rejected (issue body). Match Bearer 401 `{ error: 'unauthorized' }` + `WWW-Authenticate: Bearer`, not session 302.

`claim_task` tool **description** (not just the return body) must include token-hygiene language (comment). Return hygiene string already pinned in REST (see below).

### Auth names and pending behavior

- Hook: **`addAgentBearerHook(app, db)`**. Unauthorized helper: **`sendBearerUnauthorized(reply)`**.
- Request decoration: **`request.agentAuth?: { user: User; key: AgentKey }`**.
- Whoami: `GET /api/v1/agent/whoami` → `200 { id, key_id, label, status, permission_level }` (`id` = **user id**, `key_id` = agent_keys id). Does **not** 403 pending; returns `status: '待批准'` if the user is pending.
- Key mint: session `POST /api/v1/agent-keys` `201 { id, label, token, last_used_at: null }`. Plaintext `/^ktk_[0-9a-f]{64}$/` (`ktk_` + `randomBytes(32).toString('hex')`). Stored `key_hash` = `createHash('sha256').update(plaintext, 'utf8').digest('hex')`. Pending generate: `403 { error: 'forbidden', message: '你的账号待正式成员批准后方可生成 Agent Key。' }`.
- `users.status` enum: `'active' | '待批准'`. `permission_level`: `'full' | 'claim_only'`. GitHub first login: `待批准` + `claim_only`. Approve `POST /api/v1/users/:id/approve` sets **only** `status='active'` (GitHub stays `claim_only`). GitLab/Gitea: `active` + `full`.
- Claim pending gate is **`auth.user.status === '待批准'`** (not `!== 'active'`). Message: **`你的账号待正式成员批准后方可认领任务。`** (same string as `GET /api/v1/me` pending `message`, **different** from generate-key message).
- Pending claim: 403, **no forge token**, **no** `events.type === 'token 揭示'`. Tests seed keys with raw SQL because pending users cannot `POST /api/v1/agent-keys`. Function in `claim.test.ts`: `seedAgentKey(db, userId)`.
- `progress` / `release` **do not** re-check `待批准`.
- Approved GitHub `claim_only` **can** claim (`claim.test.ts`).
- `last_used_at`: unix seconds integer or SQL NULL. Ticked on **every successful hook auth**, including whoami and including a pending claim that later 403s. Failed/missing/revoked Bearer does **not** tick. Session `GET /api/v1/agent-keys` returns `last_used_at` snake_case.

### `taskBrief` JSON (15 keys, snake_case)

Exact keys (sorted in tests): `acceptance_criteria`, `constraints`, `created_at`, `credential`, `description_md`, `id`, `poster`, `pr_convention`, `priority`, `repo`, `source`, `status`, `tags`, `test_command`, `title`.

- `id` = `tasks.public_id` (`kt-<UTC year>-NNNN` zero-padded 4, can grow).
- `credential`: `{ profile_id: String(integer PK) }` **or** `{ inline: true }`. Never token. DESIGN example `"cp-gitea-orders"` is schema-legal but **HTTP emits the numeric string** of `credential_profiles.id`.
- `pr_convention.branch_prefix` = `` `kaola/${publicId}-` ``; `title_prefix` = `` `[${publicId}] ` `` (trailing spaces as written).
- `repo.suggested_dir` stored on the row; default at create = last path segment of `full_name`.
- `created_at` = `new Date(task.createdAt * 1000).toISOString()` (UTC `Z`).
- `poster` = `users.username` (empty string if join miss).
- `parseTaskBrief` is `z.strictObject` — extra keys (including `token`) throw. MCP list/get output should pass it.
- Token-exclusion helper in tests: `assertNoTokenMaterial` (`tasks.test.ts`) / `assertNoForgeSecretMaterial` (`claim.test.ts`). `SECRET_KEY_NAMES = {'token','token_encrypted','inline_token_encrypted','access_token'}`. Production has **no** function of that name; it is a test walker over serialized JSON.

### Claim 201 envelope (wrap this)

```
{
  task: <15-key brief, status 进行中, credential still reference>,
  token: <forge plaintext>,
  lease: { expires_at: ISO-8601, ttl_seconds: 86400 },
  clone: {
    suggested_dir: <same as task.repo.suggested_dir>,
    token_usage: "token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。"
  }
}
```

- `ttl_seconds` is the **number** `86400` (`LEASE_TTL_SECONDS` in `leases.ts`), not a string.
- `expires_at` = `new Date((nowUnix + 86400) * 1000).toISOString()`.
- Nested `task` / `lease` / `clone` must **not** contain forge plaintext or secret key names. Top-level `token` is the only reveal.
- Claim does **not** call `validateToken` / `fetch`.
- Claim does **not** call `revealCredentialProfile` (that helper writes `details: { agent_key_id, profile_id }` **without** `task_id` / `credential`).

### HTTP status / error bodies to mirror

| Situation | Code | Body |
|---|---|---|
| Missing/wrong/non-Bearer/`Token ` scheme/Basic/session-cookie-only | 401 | `{ error: 'unauthorized' }` + `WWW-Authenticate: Bearer` |
| Pending claim | 403 | `{ error: 'forbidden', message: '你的账号待正式成员批准后方可认领任务。' }` |
| Unknown `publicId` (incl. `"1"`) | 404 | `{ error: 'not_found' }` |
| Second claim while `进行中` | 409 | `{ error: 'conflict', message: '任务已被认领。' }` |
| Claim when status is not `待认领` and not the 进行中 conflict | 409 | `{ error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「进行中」。' }` |
| Progress/release, no live lease (never claimed, released, or swept) | 409 | `{ error: 'conflict', message: '任务未被认领。' }` |
| Progress/release, `leases.claimer_user_id` !== Agent user id | 403 | `{ error: 'forbidden' }` (no `message` required) |
| Vault missing/invalid on claim decrypt | 500 | `{ error: 'vault_unconfigured' }` |

`illegalTransitionMessage` in source: `` `任务状态不允许从「${from}」变更为「${to}」。` ``  
`transitionTaskStatus` throw (if you skip the HTTP pre-check): `` `Illegal task status transition: ${from} → ${to}` `` (English, arrow `→`).

Holder identity: **`leases.claimer_user_id` vs `auth.user.id`**, not agent_key_id.

### Events (`insertAuditEvent`)

Signature: `insertAuditEvent(db, { type: string, actorUserId: number | null, details: unknown })`.  
Table `events`: `id`, `type` TEXT, `actor_user_id` INTEGER **nullable**, `created_at` unix seconds, `details` TEXT JSON.

Exact `type` strings (spaces, Chinese):

| Writer | `type` | `actor_user_id` | `details` JSON |
|---|---|---|---|
| claim success (first) | `token 揭示` | claimer user id | inline: `{ task_id, agent_key_id, credential: "inline" }` — **no** `profile_id` key. profile: `{ task_id, agent_key_id, credential: "profile", profile_id: <int PK> }` |
| claim success (second) | `状态迁移` | claimer | `{ task_id, from, to }` (`from` `待认领`, `to` `进行中`) |
| progress | `心跳` | claimer | `{ task_id, note }` (`note` always string, `''` if omitted) |
| release | `状态迁移` | claimer | `{ task_id, from, to }` plus `reason` **only if** body had a string `reason` |
| lease expiry | `状态迁移` | **`null`** | `{ task_id, from: "进行中", to: "待认领" }` |
| poster PATCH | `状态迁移` | poster | `{ task_id, from, to }` |
| publish profile-path | `token 揭示` | poster | `{ profile_id, forge, base_url, full_name, outcome }` (`ok` \| `token_check_failed` \| `forge_unreachable`) — **not** the claim shape |

`task_id` in details is always the **`public_id` string**, never the integer PK.  
No events HTTP. DESIGN also lists type `回写` — **zero writers** in `apps/server/src`.  
No `submit_pr` event yet. Closest existing type for the status change is `状态迁移` with `from: '进行中', to: '待验收'`.

### Schema: `tasks` / `leases` / `events`

**`tasks`** (`db.ts` DDL + drizzle `schema.ts`): integer PK `id`; `public_id` UNIQUE; flattened §6 columns; `credential_profile_id` / `inline_token_encrypted` XOR CHECK `tasks_credential_xor`; `status` enum `待认领|进行中|待验收|已完成|已退回|已取消`; `created_at` unix seconds. Arrays stored as JSON text.

**`leases`**: `id`, `task_id` (**integer `tasks.id`**, not public_id), `claimer_user_id`, `agent_key_id`, `claimed_at`, `expires_at`, `last_heartbeat`, `state` `'active'|'released'|'expired'`. Unique index **`leases_one_active_per_task ON leases(task_id) WHERE state = 'active'`**. No per-task TTL column. TTL constant only.

**`events`**: as above. `actor_user_id` null is legal (expiry).

**`submissions`**: in DESIGN.md §10 (`task_id`, `lease_id`, `pr_url`, `summary`, `pr_state`) — **not in DDL**, not in drizzle schema. `submit_pr` has nowhere to persist `pr_url`/`summary` unless this issue adds the table (or another store). #11 polling would need those rows.

### Shared state machine (`transitionTaskStatus`)

Legal edges (already tested in `packages/shared/src/index.test.ts`):

- `待认领` → `进行中`, `已取消`
- `进行中` → `待认领`, **`待验收`**  ← `submit_pr` / `release_task` / expiry
- `待验收` → `已完成`, `已退回`  ← #11, **out of scope**
- `已退回` → `待认领`, `已取消`

Illegal including `待验收 → 待认领`. So if `submit_pr` leaves an `active` lease and the holder later calls `release_task`, `transitionTaskStatus('待验收','待认领')` **throws** (HTTP would 500). `sweepExpiredLeases` would mark the lease `expired` but **not** move a `待验收` task.

**Pin for `submit_pr`:** must (a) require live lease + holder (same as progress), (b) require `tasks.status === '进行中'`, (c) transition to `待验收`, (d) **clear the active lease** (`released` or equivalent) or the unique index blocks a later re-claim after #11/`PATCH` returns the task to `待认领`, and progress would keep heartbeating a `待验收` task (progress does not check status).

### Confirmations requested in the task

1. **No MCP server.** No file matching `*mcp*`. No `McpServer` / `StreamableHTTP` / `registerMcp`. `docs/api.md` lede: MCP tools not implemented. `docs/architecture.md`: `MCP not implemented`. `CLAUDE.md` snapshot: `MCP is not implemented` / `MCP claim_task is not implemented`.
2. **No `@modelcontextprotocol/sdk`** in `apps/server/package.json`, any workspace `package.json`, or `pnpm-lock.yaml`.
3. **No `/mcp` route.** `isApiOrLoginPath` does not mention it.
4. **No `submit_pr` HTTP** (no route in `claim.ts` / `app.ts` / whole `apps/server/src`). Shared machine **does** allow `进行中 → 待验收`. Poster PATCH **cannot** do that edge (`409 illegal_transition`).
5. DESIGN §9 vs REST: see tool table. REST paths are `/claim` `/progress` `/release`, **not** `/claim_task`. §9 sentence “REST 端点一一对应（`/api/v1/tasks` 等）” does not name `/submit_pr`. Adding REST `submit_pr` is **not** required by the issue comments; MCP is.
6. `docs/api.md` MCP paragraph (verbatim intent): tools `list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `submit_pr`, `release_task` are **not implemented**. Claim HTTP **is**. Only claim `201` top-level `token` returns a forge token.

### `buildApp` lifecycle (for MCP mount)

```ts
export function buildApp(options?: { sqlitePath?: string; webDist?: string; viteDevTarget?: string })
```

- `onClose`: `db.$client.close()` only. If MCP opens extra resources, add another hook; do not skip this one.
- Tests: `const app = buildApp(...)`; `t.after(() => app.close())`; `await app.ready()`; `app.inject(...)`. **Do not import `index.ts`** (it `listen`s). Hosting tests document this.
- `index.ts`: `buildApp({ sqlitePath: SQLITE_PATH ?? ':memory:', webDist: WEB_DIST, viteDevTarget: VITE_DEV_TARGET })` then `listen({ port: PORT??31415, host: HOST??'0.0.0.0' })`.
- Register MCP **with the other `register*` calls** (before hosting) so routes exist prior to static/proxy.

### Test boot pattern MCP tests must reuse (do not import other test files; copy seams)

From `claim.test.ts` / `tasks.test.ts` / `agent-keys.test.ts`:

1. **Env before `buildApp`** (they `applyOauthTestEnv()` then `await import('./app.ts')`):
   - `OAUTH_GITHUB_CLIENT_ID/SECRET` = `test-github-client-id/secret`
   - `OAUTH_GITLAB_CLIENT_ID/SECRET` + `OAUTH_GITLAB_BASE_URL='https://gitlab.example.test'`
   - `OAUTH_GITEA_CLIENT_ID/SECRET` + `OAUTH_GITEA_BASE_URL='https://gitea.example.test'`
   - `SESSION_SECRET = '0'.repeat(32)`
   - `PUBLIC_URL = 'http://localhost:3000'` (test fixture; production default is `http://localhost:31415`)
   - Claim/task tests: `VAULT_MASTER_KEY = 'cd'.repeat(32)` (64 hex). Agent-keys tests **`delete process.env.VAULT_MASTER_KEY`** (whoami does not decrypt).
2. **`buildApp(sqlitePath ? { sqlitePath } : undefined)`** + `ready` + `close`. In-memory cannot be opened twice; event/lease inspection uses `sqliteFile(t)` + second `createDb(path)` (`openDb`).
3. **Fetch stub** `beginFetch(t)`: OAuth userinfo keyed by access token; forge `validateToken` keyed by forge token. Task repos live on **`https://gitea.forge.example.test`** (not the OAuth Gitea origin). `allowForgeToken(stub, INLINE_TOKEN)` / `PROFILE_TOKEN` required to `POST /api/v1/tasks`.
4. **Login:** stub `app.githubOAuth2|gitlabOAuth2|giteaOAuth2.getAccessTokenFromAuthorizationCodeFlow` then `inject GET /login/{provider}/callback?code=...`, then `GET /api/v1/me` with `Accept: application/json` and cookies. GitHub pending; Gitea/GitLab active+full. Approve via `POST /api/v1/users/:id/approve` as a full member.
5. **Mint key:** session `POST /api/v1/agent-keys` `{ label }` → `body.token`. Pending: `seedAgentKey` INSERT hash.
6. **Create task:** `POST /api/v1/tasks` with `credential: { token: INLINE_TOKEN }` or `{ profile_id }` after `POST /api/v1/credential-profiles`. Inline fixture token: `'gitea-INLINE-ONE-OFF-TOKEN-zzq7'`. Profile: `'gitea-PROFILE-SHARED-TOKEN-vv31'`. `suggested_dir` in payload `'orders'`.
7. **Bearer header:** `authorization: Bearer ${token}` (scheme case-insensitive; `Token ` and `Basic` fail). Also send `accept: application/json` so session routes (if hit by mistake) 401 instead of 302.
8. **Clock:** `Date.now` freeze; TTL tests use `FROZEN_MS = Date.UTC(2026, 7, 21, 4, 0, 0)` and `advanceMs`. Expiry is `expires_at <= now` (equal counts as expired). Heartbeat at TTL-1s still live; +1s then GET/progress sweeps.
9. **Append new test file** to root `package.json` `"test"` script or `pnpm test` will not run it (existing list is explicit `.ts` paths + `pnpm --filter @kaola/web test`).
10. Suites use `{ concurrency: false }` for claim/tasks/hosting.

### Functions to reuse (exact names)

- `buildApp`, `createDb`, `addAgentBearerHook`, `sendBearerUnauthorized`
- `taskBrief`, `selectTask` (exported). `selectTasks` **exists but is not exported**.
- `LEASE_TTL_SECONDS`, `unixNow`, `selectActiveLease`, `insertActiveLease`, `renewActiveLease`, `markLeaseReleased`, `sweepExpiredLeases`
- `decryptToken`, `isVaultUnconfiguredError`, `insertAuditEvent` (`actorUserId: number | null`)
- `transitionTaskStatus`, `parseTaskBrief`, `taskBriefSchema`, `taskStatusSchema`
- Do **not** reuse `revealCredentialProfile` for claim-equivalent audit
- Claim/progress/release logic lives **inline in HTTP handlers** — no `handleClaim` export today

### Gaps the orchestrator must pin (not settled by code)

1. MCP HTTP path (DESIGN unnamed). `/mcp` collides with SPA/Vite GET; `/api/mcp` or `/api/v1/mcp` does not.
2. Whether MCP is Streamable HTTP vs stdio; DESIGN says same-process on the API server.
3. `list_tasks` filter: single `tags` vs array; AND vs membership (web = membership of one tag).
4. `list_tasks` return: REST `{ tasks: [...] }` vs a raw array.
5. `submit_pr`: persist `pr_url`/`summary` without `submissions` table? Add the DESIGN table now vs leave for #11?
6. `submit_pr` lease handling (must clear `active` — see unique index / illegal release-from-待验收).
7. `submit_pr` success body (no REST). Suggested: updated brief `status: '待验收'` plus the submitted `pr_url`/`summary`; **no token**.
8. Whether MCP also adds REST `POST …/submit_pr` (DESIGN “REST 一一对应” vs issue text “MCP surface”).
9. `report_progress`/`release_task`: DESIGN table lists `note`/`reason` without `?`; REST treats them optional. Wrap REST.
10. Pending users listing via MCP: REST GET allows it; Web hides the board. Claim remains 403 without decrypt.
