# Ground truth — Kaola Tasks identity / claim / MCP (issue #23)

Measured on worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23` (read-only). This file records **current code**, not a design.

**Issue comments used as “latest” (comments override body; later comments replace earlier):**

| When (UTC) | id | Role |
|------------|-----|------|
| 2026-08-24 03:04:21 | `5390219462` | **Current** admin bootstrap + claimant-without-web-login |
| 2026-08-24 02:49:01 | `5390135367` | **Current** MCP-first device pending (1 day); withdraws 10-minute pairing code |
| 2026-08-24 02:41:44 | `5390094441` | Device crypto / hard expiry / `device_max_age_days` (10-minute ritual **withdrawn** by `5390135367`) |
| 2026-08-24 02:36:27 | `5390064003` | Device + stdio bridge; withdraws copy-`ktk_`-into-each-runtime |
| 2026-08-24 02:58:52 | `5390189031` | `KAOLA_ADMINS` closed join — **partially replaced** by `5390219462` (empty env may boot; first `full` bootstrap) |
| 2026-08-24 02:29:21 | `5390023681` | Option A auto-mint `ktk_` — **withdrawn** |

---

## 1. OAuth bootstrap

### What exists

**Required env at `registerAuth` (empty/missing throws `missing required environment variable ${name}`):** `SESSION_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`, `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL` (`apps/server/src/auth.ts:284-293`, `requireEnv` `:42-47`). Optional: `PUBLIC_URL` default `http://localhost:31415` (`:285`).

**No admin whitelist env var** exists in `apps/` or `packages/` (`KAOLA_ADMINS` grep: zero matches in server/web source). Boot does not refuse empty admin config.

**First-login mapping (`mapProfile`, `auth.ts:109-137`):**

| Provider | `status` | `permission_level` | Tests |
|----------|----------|--------------------|--------|
| GitHub | `'待批准'` (`PENDING_STATUS`, `:8`) | `'claim_only'` | `auth.test.ts:247-268` |
| GitLab | `'active'` | `'full'` | `auth.test.ts:292-313` |
| Gitea | `'active'` | `'full'` | `auth.test.ts:315-336` |

**GitLab/Gitea first login is auto-`full`.** Yes. Inserted on first callback (`upsertUser` `:165-176`). Existing row: **only** `username` / `displayName` update — `status` and `permission_level` are not rewritten (`:150-162`). Approved GitHub stays `active`+`claim_only` after re-login (`auth.test.ts:466-499`).

**Who is `active` vs `待批准`:** GitHub first insert = `待批准`. GitLab/Gitea first insert = `active`. Approve path sets **only** `status: 'active'` (`auth.ts:410`), leaving GitHub `claim_only` (`auth.test.ts:425-463`). Unique key `(provider, remote_id)` (`schema.ts:18`). Same numeric `remote_id` on GitHub vs GitLab = two users (`auth.test.ts:373-390`).

**`GET /api/v1/me` (`auth.ts:366-375`):** session cookie. No session + JSON Accept → `401 { error: 'unauthorized' }` (`:369-370`; `auth.test.ts:228`). Browser-like (no `application/json` in Accept) → `302 /login`. Body via `publicUser` (`:70-95`): `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`, `trusted_automation`. If `status === '待批准'`, additive `message` = `'你的账号待正式成员批准后方可认领任务。'` (`PENDING_CLAIM_MESSAGE` `:10`, `:91-93`). Pending users **do** get `200` (not 401) on `/me`.

**`PUT /api/v1/me/settings` (`auth.ts:377-391`):** no session **or** `status === '待批准'` → same `sendUnauthorized` as unauth (`401` JSON / `302 /login`). Body must have boolean `trusted_automation`; else `400 { error: 'invalid_body' }`. Success `200 { trusted_automation }`. Default column `trusted_automation` SQLite `INTEGER NOT NULL DEFAULT 0` (`db.ts:23`, `schema.ts:16`). Exercised in `claim-confirm.test.ts:1040+`.

**`POST /api/v1/users/:id/approve` (`auth.ts:393-413`):** no session → `401 { error: 'unauthorized' }`. Actor must `status === 'active'` **and** `permissionLevel === 'full'`; else `403 { error: 'forbidden' }` (no message). Invalid id → `400 { error: 'invalid_id' }`. Missing user → `404 { error: 'not_found' }`. Success returns `publicUser(updated)`. `claim_only` cannot approve (`auth.test.ts:501-510`). Pending cannot approve (`auth.test.ts:394-411`).

Login HTML (`auth.ts:199-215`) and web login copy (`App.vue:17`) still say GitLab/Gitea are 正式成员.

### Gap vs #23 latest comments

- No `KAOLA_ADMINS`; GitLab/Gitea **every** first login is `active`+`full` (comment `5390219462` / `5390189031` reject “GitLab.com = auto admin”).
- No “zero `full` users → only the first web OAuth becomes admin; later logins do not auto-`full`”.
- No “whitelist identity cannot be demoted in the UI”; no demote/revoke-user HTTP at all.
- No closed join: any OAuth callback **creates a `users` row** (GitHub as `待批准` queue — comment `5390189031` forbade that social-engineering queue; `5390219462` says uninvited web login must not become a publisher).
- Re-login of GitLab/Gitea does not “revive” a demoted user only because **demotion does not exist**; upsert also would not restore `active` if someone later added demotion (status not updated on existing — that part already matches “re-login must not auto-save revoked identity”).
- Claimants are still OAuth `users` (`claim_only` after GitHub approve), not a separate non-login identity (`5390219462`).

---

## 2. Agent keys

### What exists

**Create:** session `POST /api/v1/agent-keys` (`agent-keys.ts:40-70`). Self-serve. `getSessionUser`; no session → `sendUnauthorized`. `user.status !== 'active'` → `403 { error: 'forbidden', message: '你的账号待正式成员批准后方可生成 Agent Key。' }` (`PENDING_GENERATE_MESSAGE` `:9`; `agent-keys.test.ts:375-390`). Body `{ label?: string }` (non-string → `''`).

**Plaintext:** `` `ktk_${randomBytes(32).toString('hex')}` `` (`:15-17`) — prefix **`ktk_`** + 64 hex. Tests `TOKEN_RE = /^ktk_[0-9a-f]{64}$/` (`agent-keys.test.ts:14`). **201** `{ id, label, token, last_used_at: null }` — plaintext **only this once**. Stored `key_hash` = SHA-256 of UTF-8 plaintext as hex (`hashAgentKey` `:11-13`, insert `:49-56`). Table columns: `id`, `user_id`, `key_hash`, `label`, `last_used_at` (`schema.ts:21-31`, `db.ts:45-51`). No plaintext column.

**List:** `GET /api/v1/agent-keys` — `active` only else `403 { error: 'forbidden' }`. `{ keys: [{ id, label, last_used_at }] }` (`publicKey` `:19-25`). **Delete:** `DELETE /api/v1/agent-keys/:id` scoped to owner; `404 { error: 'not_found' }` if missing/other user.

**Whoami:** child plugin + `addAgentBearerHook` (`:106-122`). `GET /api/v1/agent/whoami` → `{ id, key_id, label, status, permission_level }`. Missing/bad Bearer → `401 { error: 'unauthorized' }` + `WWW-Authenticate: Bearer` (`agent-bearer.ts:34-36`). **Hook does not check `users.status`.** Session cookie does not authorize whoami (`agent-keys.test.ts:341`). Approved `claim_only` can mint (`agent-keys.test.ts:394+`). Gitea `full`+`active` can mint (`:545+`).

**Frontend copy that tells users to generate a key to claim:**

- Button label **`生成 Agent Key`** (`App.vue:443`).
- Blurb: `自助生成与吊销个人 Agent API Key。明文仅在创建时显示一次，服务端只存哈希。` (`:434`).
- Empty: `暂无 Agent Key。` (`:449`).
- README 认领者 steps 1–3: login, **钥匙栏生成 Agent Key**, put key in MCP (`README.md:65-69`). Permission matrix: `生成 Agent Key、让 Agent 认领` (`:45`).
- README Agent 节 still: `考拉 Agent Key（钥匙页生成，前缀 ktk_…）只用来打开考拉 MCP / REST 大门` + `KAOLA_AGENT_KEY` inject (`:89`).
- Exact substring **`生成钥匙`**: **not** in `apps/web` or `README.md`. Closest in smoke-test: `也不是用生成钥匙来换 200` (`docs/smoke-test.md:86`).

No auto-insert of `agent_keys` on OAuth or on `POST …/approve`.

### Gap vs #23 latest comments

- Product is still **user self-serve mint** as the claim onboarding ritual (README + 钥匙 pane), not “钥匙页只做查看/吊销” (withdrawn A) and not “我的电脑” (`5390064003`).
- No server auto-issue on GitHub approve / GitLab-Gitea first login (withdrawn A `5390023681`).
- Latest model **forbids** copying `ktk_…` into Cursor/Claude/Codex mcp.json (`5390064003`); README still teaches `KAOLA_AGENT_KEY` → `Authorization: Bearer`.
- Identity is a **copyable long-lived Bearer**, not a device keypair with per-request signatures (`5390094441`).
- `docs/smoke-test.md` already cancelled “认领者生成 Agent Key” (step 10); **code and README have not**.

---

## 3. MCP + REST claim identity

### What exists

**`addAgentBearerHook` (`agent-bearer.ts:38-59`):** `onRequest`. Parse `Authorization: Bearer <token>` (`:28-32`, case-insensitive `Bearer`). Missing → `401` + `WWW-Authenticate: Bearer`. Hash presented token, lookup `agent_keys.key_hash`, `timingSafeEqual` on hex buffers (`:17-25`, `:45-48`). Missing user → 401. Success: tick `last_used_at` unix seconds, set `request.agentAuth = { user, key }`. **No `待批准` gate. No device. No signature.**

**`registerMcp` (`mcp.ts:227-244`):** encapsulated child; **same hook on all methods** of `/api/mcp`. `POST /api/mcp` Streamable HTTP (`:238-239`). `GET`/`DELETE` → `405` JSON-RPC `{ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }` (`:33-35`, `:241-242`) **only if Bearer already passed**. Unauthenticated GET would 401 first (hook). Missing `agentAuth` in POST handler also 401 (`:170-174`). Tests: `mcp.test.ts:837-867` — missing Authorization / Token scheme / Basic / wrong Bearer → HTTP **401 before JSON-RPC**. Session cookie does not authorize MCP (same describe).

MCP tools call `claimTask` (`mcp.ts:114-121`). Pending GitHub **seeded** key **may `list_tasks`** (`mcp.test.ts:1039-1056`) — HTTP 200 initialize + tool ok. Pending `claim_task` is **isError** `{ error: 'forbidden', message: PENDING_CLAIM_MESSAGE }` with no `token`, no `token 揭示` (`:1210-1231`). There is **no** MCP/HTTP `authorization_required` / device-pending 202.

**`claimTask` (`claim.ts:96-235`):**

1. `auth.user.status === '待批准'` → **`403`** `{ error: 'forbidden', message: '你的账号待正式成员批准后方可认领任务。' }` **before** sweep/decrypt/lease (`:102-104`). REST test `claim.test.ts:1085-1116`.
2. Task missing → `404 { error: 'not_found' }`. `进行中` → `409 { error: 'conflict', message: '任务已被认领。' }`. Other non-`待认领` → `409 { error: 'illegal_transition', message: 任务状态不允许从「…」变更为「进行中」。 }`.
3. **Autonomous confirmation (#16):** `autonomous === true` && `!auth.user.trustedAutomation` (`:127-140`). Existing pending row → **HTTP 202** `pendingConfirmationBody()`: `{ error: 'confirmation_required', message: '该任务的自动认领需要你先在网页端确认，请到「待确认认领」列表批准或拒绝。', pending: true }` (`claim-confirmations.ts:12-13, 83-85`). No token, no clone (`claim-confirm.test.ts:609-617`). Else consume `'approved'` row (delete) or insert `'pending'` + event `'认领待确认'` and 202. Instructed claims (`autonomous` missing/false) skip this.
4. Decrypt then `201` envelope `{ task, token, lease, clone }` (`:216-234`). Forge plaintext is top-level **`token`**.

**`leases.agent_key_id`:** Drizzle `.notNull()` (`schema.ts:99`); DDL `agent_key_id INTEGER NOT NULL` (`db.ts:111`). **`claim_confirmations.agent_key_id`:** `.notNull()` (`schema.ts:122`); DDL `:140`. Neither nullable.

**Audit on successful claim (`claim.ts:203-212`):** first `'token 揭示'` then `'状态迁移'`. `actorUserId: auth.user.id` (claimer user PK, not null). Reveal `details`: `{ task_id: publicId, agent_key_id, credential: 'inline'|'profile', profile_id? }` — no plaintext. `insertAuditEvent` (`vault.ts:73-85`) writes `events.actor_user_id`. Test: `claim.test.ts:1556-1588` (`actor_user_id` = claimer). **No `device_id` anywhere** (grep `device_id` in `apps/server/src`: zero).

REST claim routes: child + hook (`claim.ts:412-438`). `POST /api/v1/tasks/:publicId/claim|progress|release`.

### Gap vs #23 latest comments

- Unpaired MCP is **401**, not 202 `authorization_required` / `pending: true` + `expires_at` (`5390135367`). `docs/smoke-test.md:54-55` already documents this mismatch.
- Pending **GitHub user with a seeded key can list**; latest “no identity → wait, do not list/claim as anonymous success” is not implemented as a pending-device wait — it is 401 without a key, or list-ok with a pending user’s key.
- Proof of identity is **Bearer `ktk_`**, not per-request signed device private key (`5390094441`).
- Audit/lease identity is `claimer_user_id` + `agent_key_id`, not `user_id` + `device_id`.
- Claimant must still be a `users` row (OAuth); no claimant-without-login table (`5390219462`).
- `202` today means **#16 autonomous confirmation**, not device authorization wait. Error string is `confirmation_required`, not `authorization_required`.

---

## 4. #22 pins (must not break)

### What exists

**Two-task claim — REST:** `claim.test.ts:911-953` `'claiming a second publicId returns that task\'s token, not the first task\'s'`. Same Agent Key; first task inline `INLINE_TOKEN`, second profile `PROFILE_TOKEN`. Each `assertClaim201`; `task.id` matches; `secondBody.token === PROFILE_TOKEN`; tokens unequal.

**Two-task claim — MCP:** `mcp.test.ts:1100-1138` `'claim_task on a second task_id returns that task\'s token, not the first task\'s'`. Two inline credentials (`INLINE_TOKEN` then `PROFILE_TOKEN` as `{ token: PROFILE_TOKEN }`). Same pin.

**Clone four keys:** `assertCloneRecipe` sorts `Object.keys(clone)` to `['extra_header', 'remote_url', 'suggested_dir', 'token_usage']` (`claim.test.ts:589`, `mcp.test.ts:795`). Production fill (`claim.ts:224-232`): `suggested_dir` = `brief.repo.suggested_dir`; `token_usage` = `CLONE_TOKEN_USAGE` exact sentence `'token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。'` (`claim.ts:34-35`); `remote_url` = `{base_url}/{full_name}.git`; `extra_header` gitea `{ name: 'Authorization', value_pattern: 'token ${token}' }` else `Bearer ${token}`. Envelope keys exactly `clone`, `lease`, `task`, `token` (`claim.test.ts:636`).

**Committed MCP example is URL-only:** `README.md:79-86`:

```json
{
  "mcpServers": {
    "kaola-tasks": {
      "url": "http://localhost:31415/api/mcp"
    }
  }
}
```

No `headers`, no `ktk_`, no forge PAT in that snippet.

**Reveal channels (code + docs):** forge plaintext on HTTP/MCP **only** as REST claim **`201` top-level `token`** and MCP **`claim_task` success `token`** (`claim.ts:222`, `mcp.ts:42-48,120`). Session GET list/get, import `200`, credential-profile issues, claim **`202`**, whoami, agent-key **list** — no forge token. Agent-key **create** `201` `token` is the **`ktk_`** identity key, not a forge PAT. `list_tasks` / `get_task_brief` descriptions say never include forge token (`mcp.ts:108`).

### Gap vs #23 latest comments

- None of these pins are missing in current tests/docs for #22. #23 must not change clone four keys, two-task decrypt, URL-only committed example, or the two forge-reveal channels.
- README **after** the URL-only block still documents `KAOLA_AGENT_KEY` header inject (`:89`) — that is a #23 product gap, not a #22 pin break.

---

## 5. Schema today

### What exists

Tables created in `createDb` (`db.ts:146-161`): `users`, `agent_keys`, `credential_profiles`, `tasks`, `events`, `leases`, `submissions`, `claim_confirmations`. Drizzle mirrors in `schema.ts`. **No `devices` table.** **No claimant-without-login / invite table.**

**`users` columns:** `id`, `provider` enum `github|gitlab|gitea`, `remote_id`, `username`, `display_name`, `status` enum `active|待批准`, `permission_level` enum `full|claim_only`, `trusted_automation` boolean default false. Unique `(provider, remote_id)`.

**`agent_keys`:** `id`, `user_id` NOT NULL, `key_hash` NOT NULL UNIQUE, `label` NOT NULL default `''`, `last_used_at` nullable integer.

**`leases`:** `id`, `task_id` NOT NULL, `claimer_user_id` NOT NULL, `agent_key_id` NOT NULL, `claimed_at`, `expires_at`, `last_heartbeat`, `state` enum `active|released|expired`. Partial unique index `leases_one_active_per_task` on `task_id` where `state = 'active'` (`db.ts:119-122`).

**`claim_confirmations`:** `id`, `task_id` NOT NULL, `user_id` NOT NULL, `agent_key_id` NOT NULL, `state` enum `pending|approved|rejected`, `created_at`.

**`events`:** `id`, `type`, `actor_user_id` nullable, `created_at`, `details` JSON text.

Claimant identity always points at `users.id` + `agent_keys.id`.

### Gap vs #23 latest comments

- No `devices` (`pending`/`active`/`expired`, pubkey/fingerprint, `user_id`, hostname, `paired_at`, `expires_at`, `pending_expires_at`, `last_seen`).
- No `device_max_age_days` / `max_devices` / `device_idle_days` on users.
- No claimant identity table distinct from `users`.
- No invitation rows for publishers.
- `leases`/`claim_confirmations`/`token 揭示` details have `agent_key_id`, not `device_id`.

---

## 6. Web

### What exists

Four-pane member shell, **no vue-router**. Default pane `'board'` (`App.vue:767`). Nav: 看板 always; **发布** only if `canApprove`; 钥匙; 审计 (`:830-841`). Panes `v-show`.

**`canApprove`:** `me.status === 'active' && me.permission_level === 'full'` (`:812-814`). **`canManageKeys`:** `me.status === 'active'` (`:816`) — full **or** `claim_only`.

**`claim_only` UX:** no 发布 nav / no `task-form` (form wrapped `v-if="canApprove"` `:228`). 钥匙 still listed. On 钥匙: 受信自动化 + 待确认认领 + Agent Key (`v-if="canManageKeys"`). 凭证档案 + 批准 GitHub 用户 only `canApprove` (`:456-507`). Pending GitHub: `view === 'pending'` (`:806-809`) — **not** the workbench; card title `账号待批准`, alert uses `me.message` or the same PENDING_CLAIM_MESSAGE (`:44-45`). Login copy: GitLab/Gitea 正式成员; GitHub 需批准 (`:17`).

**看板 vs 钥匙:** 看板 is task list/kanban (`workbench-pane-board`). 钥匙 is settings: trust toggle, confirmations, Agent Key mint, profiles, approve-by-numeric-id. **No Agent claim button on 看板** (shell tests pin no claim testid).

**README / smoke-test / App “生成钥匙”:** App uses **`生成 Agent Key`**, not `生成钥匙`. README 认领者 still instructs 钥匙栏生成 Key. `docs/smoke-test.md` step 10 **取消** 认领者生成 Agent Key; step 11 notes unpaired `POST /api/mcp` is still 401.

Permission label: `full` → `正式成员`, else `仅认领` (`:818-819`). Approve success copy: `已批准，该用户可认领任务（GitHub 仍为仅认领）` (`:1395`).

### Gap vs #23 latest comments

- 钥匙 pane is still **generate Agent Key**, not **我的电脑**.
- No admin UI to bind a pending device to a claimant display-name (`5390135367` / `5390219462`).
- Approve widget is **GitHub user numeric id** only — not device fingerprint / hostname.
- Login/README still teach GitLab/Gitea auto 正式成员 and claimant OAuth login.
- Smoke-test copy is ahead of the UI.

---

## 7. Package layout

### What exists

`pnpm-workspace.yaml`: `apps/*`, `packages/*`.

| Member | Role |
|--------|------|
| `apps/web` | Vue 3 SPA `@kaola/web` |
| `apps/server` | Fastify API + **in-process** MCP Streamable HTTP `POST /api/mcp` (`mcp.ts`, SDK `1.30.0`) |
| `packages/shared` | zod task-brief + state machine; library `exports: "."` — **no bin** |
| `packages/forge-adapters` | forge adapters; **no bin** |

`apps/server/package.json` has `start`/`dev` on `src/index.ts` only — **no `bin`**, no stdio transport. MCP is `StreamableHTTPServerTransport` (`mcp.ts:2-3, 202-208`). `registerMcp` after `registerClaim` (`app.ts:92-95`). Hosting: `/api` and `/login*` shielded from SPA (`isApiOrLoginPath` `app.ts:28-31`); path is `/api/mcp` not `/mcp`.

**Where a new stdio binary could live:** workspace already globs `apps/*`, so a third app (e.g. `apps/mcp` / `apps/kaola-mcp`) is the existing pattern for a runnable process. `packages/*` today are importable libraries without CLIs. Putting stdio **inside** `@kaola/server` would mix Fastify boot (`OAUTH_*` required at `registerAuth`) with a local bridge that should not need a full API process — unless the binary is a **thin client** that only talks HTTP to an already-running server (matches comment: command + 考拉 URL, no secret in mcp.json).

No `StdioServerTransport` import in the tree.

### Gap vs #23 latest comments

- No `kaola-mcp` (or similar) stdio bridge, no `~/.kaola/device`, no shared command for Cursor/Claude/Codex (`5390064003`).
- MCP clients today must send **HTTP Bearer** to `POST /api/mcp` or they get **401**.

---

## File / symbol index

| Path | Symbols / routes | Why |
|------|------------------|-----|
| `apps/server/src/auth.ts` | `PENDING_STATUS`, `PENDING_CLAIM_MESSAGE`, `mapProfile`, `upsertUser`, `registerAuth`, `GET /api/v1/me`, `PUT /api/v1/me/settings`, `POST /api/v1/users/:id/approve` | OAuth bootstrap + session |
| `apps/server/src/auth.test.ts` | `OAuth callback first login`, `pending GitHub users and approve` | GitHub vs GitLab/Gitea matrix |
| `apps/server/src/agent-keys.ts` | `generatePlaintextKey`, `hashAgentKey`, `registerAgentKeys`, `GET /api/v1/agent/whoami` | Self-serve `ktk_` |
| `apps/server/src/agent-bearer.ts` | `addAgentBearerHook`, `sendBearerUnauthorized` | Shared Bearer |
| `apps/server/src/claim.ts` | `claimTask`, `CLONE_TOKEN_USAGE`, `registerClaim` | 403/202/201, reveal |
| `apps/server/src/claim-confirmations.ts` | `pendingConfirmationBody`, `CONFIRMATION_REQUIRED_MESSAGE` | #16 202 shape |
| `apps/server/src/mcp.ts` | `registerMcp`, `createKaolaMcpServer` | Streamable HTTP `/api/mcp` |
| `apps/server/src/schema.ts` / `db.ts` | `users`, `agentKeys`, `leases`, `claimConfirmations` | Columns / NOT NULL |
| `apps/server/src/vault.ts` | `insertAuditEvent` | `token 揭示` actor |
| `apps/server/src/claim.test.ts` | two-`publicId` test `:911`; clone four keys; pending 403 `:1085` | #22 + #9 |
| `apps/server/src/mcp.test.ts` | two-`task_id` `:1100`; 401 `:837`; pending list `:1039`; pending claim `:1210` | #22 + #10 |
| `apps/web/src/App.vue` | `canApprove`, `canManageKeys`, `生成 Agent Key` | 钥匙 / 看板 |
| `README.md` | MCP URL-only snippet; 认领者生成 Key | Docs vs #23 |
| `docs/smoke-test.md` | steps 10–12 | Ahead of code |
| `pnpm-workspace.yaml` | `apps/*`, `packages/*` | New stdio app slot |
| `apps/server/src/app.ts` | `registerMcp` after `registerClaim` | Wiring |

**Issue #23 URL:** https://github.com/KaolaBrother/KaolaTasks/issues/23
