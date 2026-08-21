# Ground truth — bundle-15-16 (Issue #15 audit UI/team stats, Issue #16 claim-confirmation policy)

**Worktree measured**: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16`
**Branch**: `workflow/bundle-15-16`
**HEAD**: `637c3041f7e20513929b7230bd7d394e77ffc1a1`
**Working tree status**: clean (`git status --porcelain=v1` empty)

## ⚠️ Load-bearing fact: CLAUDE.md's "Project Snapshot" is stale for this branch

The root `CLAUDE.md` in the **main checkout** describes an M0/early-M1 state ("MCP is not
implemented", claim HTTP is "claim|progress|release" only, test command lists ~9 files). **None
of that is true on this worktree.** This branch already has, fully implemented and tested:

- MCP server (`apps/server/src/mcp.ts`) with **six** registered tools: `list_tasks`,
  `get_task_brief`, `claim_task`, `report_progress`, `release_task`, `submit_pr`.
- REST: `claim`, `progress`, `release` (in `claim.ts`) — **`submit_pr` has a `submitPr()` function
  in `claim.ts` but it is only exposed via MCP, not as a REST route** (no
  `POST /api/v1/tasks/:publicId/submit-pr` or similar exists; verified by grepping every
  `app.get|post|patch|delete(` call site).
- Import from issue (`tasks.ts` `POST /api/v1/tasks/import`), webhook receiver (`webhook.ts`),
  polling (`poller.ts`), writeback-to-issue-comment (`writeback.ts`), `submissions` table.
- Root `package.json` `test` script actually runs 19 files, not the 9 CLAUDE.md lists (includes
  `import.test.ts`, `claim.test.ts`, `mcp.test.ts`, `poller.test.ts`, `webhook.test.ts`,
  `writeback.test.ts`, plus 4 more `forge-adapters` shared-spec files CLAUDE.md's test command
  omits: `get-pull-request.shared.test.ts`, `import-issue.shared.test.ts`,
  `webhook.shared.test.ts`, `comment-on-issue.shared.test.ts`).

**`docs/architecture.md` (in this worktree) is current and accurate** — it already documents all
of the above in detail and is the doc to trust, not CLAUDE.md's "Project Snapshot" paragraph. Its
"no events HTTP, no claim UI, no vue-router" claim about `apps/web` **is** still accurate today
(verified independently below). Do not let CLAUDE.md's summary mislead scoping for either issue;
treat `docs/architecture.md` + this file as ground truth, and treat DESIGN.md as the contract.

---

## Exploration: Issue #15 — Audit log UI + team stats

### Entry Points
- No HTTP entry point exists yet for reading events. The only current consumers of the `events`
  table are internal writers (below); nothing reads it back out today.
- Nearest sibling patterns to copy for a new session-auth `GET` read endpoint:
  - `GET /api/v1/tasks` — `apps/server/src/tasks.ts:479-485` (session cookie auth via
    `getSessionUser`/`sendUnauthorized`, no query-string filtering server-side today — filtering
    is client-side in `App.vue`).
  - `GET /api/v1/agent-keys` — `apps/server/src/agent-keys.ts:72-81` (session auth + per-user
    `.where(eq(...))` scoping, `.all()`, wraps rows in a public-shape mapper).
  - `GET /api/v1/credential-profiles` — `apps/server/src/credential-profiles.ts:89-98` (session
    auth + a `canManageProfiles` permission gate before the read).
  - `GET /api/v1/me` — `apps/server/src/auth.ts:317-326` (the `wantsJson`/`sendUnauthorized`
    content-negotiation pattern; redirects to `/login` for a browser navigation, 401 JSON for
    `Accept: application/json`).

### Execution Flow (today, events write path)
1. A route handler / lease sweep / webhook / poller finishes its own status or profile mutation.
2. It calls `insertAuditEvent(db, { type, actorUserId, details })` (`apps/server/src/vault.ts:73-85`)
   — a thin `db.insert(events).values({...}).run()` wrapper. `createdAt` is always
   `Math.floor(Date.now()/1000)` set inside the helper, never passed by the caller.
3. `details` is `JSON.stringify`'d into a single TEXT column; there is no separate structured
   column for `task_id`/`agent_key_id`/etc — a reader must `JSON.parse(events.details)`.
4. No route currently reads `events` back. `GET /api/v1/tasks` and `GET /api/v1/tasks/:publicId`
   return only task briefs (`taskBrief()`), never event rows.

### Architecture Insights
- **`insertAuditEvent` is the single choke point** for every audit write (`apps/server/src/vault.ts:73`).
  It accepts a structural type `AuditEventWriter = { insert: AppDb['insert'] }` (not the full
  `AppDb`) specifically so it can be called with either the top-level `db` or a `tx` handle inside
  `db.transaction(...)` (see `poller.ts:85-93` calling it with `tx`). Any new events-reading code
  should import the `events` schema table directly (`./schema.ts`), not add a second writer.
- **System-driven vs human-driven `actorUserId`**: `actorUserId: null` for events written by code
  with no HTTP request in flight — lease expiry sweep (`leases.ts:76`), PR-merge/close terminal
  transition (`poller.ts:90`, called from both `poller.ts` and `webhook.ts`'s receiver). Every
  other writer passes a real `user.id`/`auth.user.id`. "按人过滤" for these null-actor system
  events must decide how to render "系统" / no-actor rows — there is no sentinel user row, the
  column is just SQL NULL.
- **`task_id` in `details` is always the `public_id` STRING** (e.g. `kt-2026-0001`), never the
  integer `tasks.id` PK — see every `details: { task_id: publicId, ... }` call site below. A
  "按任务过滤" join/filter must match against `tasks.public_id`, and would need
  `db.select().from(events)` joined or filtered against a `publicId` string, not `tasks.id`.
- **Username join pattern for "按人过滤"**: `events.actorUserId` is `users.id`; the existing join
  pattern to get from a task row to a username is `selectTask`/`selectTasks` in `tasks.ts:417-433`
  (`.leftJoin(users, eq(tasks.posterUserId, users.id))` selecting `{ task, posterUsername: users.username }`).
  The same `leftJoin(users, eq(events.actorUserId, users.id))` shape would resolve an event's actor
  username; note it must be a **left** join (actorUserId can be NULL).

### Key Files
| File | Role | Importance |
|------|------|------------|
| `apps/server/src/schema.ts` (events, lines 84-90) | Drizzle table def for `events` | Must-read: exact columns/types |
| `apps/server/src/db.ts` (EVENTS_DDL, lines 70-78) | Raw SQL DDL for `events` | Must-read: confirms schema.ts matches DDL |
| `apps/server/src/vault.ts` (`insertAuditEvent`, 73-85) | The one writer helper | Every new read must respect this write shape |
| `apps/server/src/claim.ts` | 4 of the 8 `insertAuditEvent` call sites (`token 揭示`×1, `状态迁移`×3, `心跳`×1) | Richest source of `details` shapes to replicate in a reader |
| `apps/server/src/tasks.ts` | 2 call sites (`token 揭示` on profile-token reveal-outcome logging, `状态迁移` on poster PATCH) | |
| `apps/server/src/credential-profiles.ts` | 2 call sites (`变更`×2 — create/delete) | `变更` is **not** in DESIGN.md §10's enumerated type list (状态迁移/token 揭示/心跳/回写) — an undocumented 5th type already in production |
| `apps/server/src/leases.ts` | 1 call site (`状态迁移`, system lease-expiry) | actorUserId: null example |
| `apps/server/src/poller.ts` | 1 call site (`状态迁移`, system PR-terminal, inside a `tx`) | actorUserId: null example, transactional insert |
| `apps/server/src/writeback.ts` | 1 call site (`回写`) | only fires on writeback *success*; failure writes no event |
| `apps/web/src/App.vue` | Web member workbench, single-file Vue app | No events UI/audit page exists yet — see below |
| `apps/web/src/App.board.test.ts`, `App.form.test.ts` | Existing vitest+`@vue/test-utils` conventions | Pattern to imitate for a new audit-page test file |

### Exact `events` DDL / schema
Raw SQL (`apps/server/src/db.ts:70-78`):
```sql
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  actor_user_id INTEGER,
  created_at INTEGER NOT NULL,
  details TEXT NOT NULL
)
```
Drizzle (`apps/server/src/schema.ts:84-90`):
```ts
export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  actorUserId: integer('actor_user_id'),
  createdAt: integer('created_at').notNull(),
  details: text('details').notNull(),
})
export type AuditEvent = typeof events.$inferSelect
```
`createdAt` is Unix seconds (`Math.floor(Date.now()/1000)`, same convention as `tasks.createdAt`,
`leases.claimedAt`/`expiresAt`/`lastHeartbeat`, `agentKeys.lastUsedAt`). No `updated_at`. No index
on `type`/`actor_user_id`/`created_at` today (matters for a "按人/任务/时间过滤" query planner if
the table grows).

### Every writer of `events` (file:line, exact `type` string literal, `details` shape, `actorUserId`)

| File:line | `type` literal | `actorUserId` | `details` shape |
|---|---|---|---|
| `vault.ts:100-104` (`revealCredentialProfile`) | `'token 揭示'` | `input.actorUserId` (caller-supplied number) | `{ agent_key_id, profile_id }` |
| `tasks.ts:177-187` (`insertTokenRevealEvent`, called from task-create/import token-check path) | `TOKEN_REVEAL_EVENT` = `'token 揭示'` | `input.actorUserId` (number) | `{ profile_id, forge, base_url, full_name, outcome }` where `outcome: 'ok'\|'token_check_failed'\|'forge_unreachable'\|'issue_not_found'` |
| `tasks.ts:788-792` (PATCH `/api/v1/tasks/:publicId`, poster-driven transition) | `STATUS_TRANSITION_EVENT` = `'状态迁移'` | `user.id` | `{ task_id, from, to }` |
| `poller.ts:88-92` (`applyPrTerminalTransition`, inside `db.transaction`, called by both the poller and the webhook receiver) | `'状态迁移'` | `null` | `{ task_id, from, to, pr_url }` |
| `leases.ts:74-78` (`sweepExpiredLeases`, lease TTL expiry) | `'状态迁移'` | `null` | `{ task_id, from: '进行中', to: '待认领' }` |
| `credential-profiles.ts:138-142` (POST create profile) | `'变更'` | `user.id` | `{ action: 'create', profile_id }` |
| `credential-profiles.ts:172-176` (DELETE profile) | `'变更'` | `user.id` | `{ action: 'delete', profile_id }` |
| `claim.ts:162-166` (`claimTask`, token reveal on claim) | `TOKEN_REVEAL_EVENT` = `'token 揭示'` | `auth.user.id` | `{ task_id, agent_key_id, credential: 'inline'\|'profile', profile_id? }` |
| `claim.ts:167-171` (`claimTask`, status flip) | `STATUS_TRANSITION_EVENT` = `'状态迁移'` | `auth.user.id` | `{ task_id, from, to }` (`from` is always `'待认领'`, `to` always `'进行中'`) |
| `claim.ts:217-221` (`reportProgress`, heartbeat) | `HEARTBEAT_EVENT` = `'心跳'` | `auth.user.id` | `{ task_id, note }` (`note` defaults to `''`, never `undefined`) |
| `claim.ts:275-279` (`releaseTask`) | `'状态迁移'` | `auth.user.id` | `{ task_id, from, to }` or `{ task_id, from, to, reason }` when a reason string was given (key only present when defined) |
| `claim.ts:347-351` (`submitPr`) | `'状态迁移'` | `auth.user.id` | `{ task_id, from, to, pr_url, summary }` |
| `writeback.ts:78-82` (`attemptWriteback`, success only) | `WRITEBACK_EVENT` = `'回写'` | caller's `actorUserId` (may be `null` for the `applyPrTerminalTransition`/`'完成'` call site) | `{ task_id, transition: '认领'\|'提交PR'\|'完成', ok: true, issue_url }` |

**Observed `type` literal set in production**: `状态迁移`, `token 揭示`, `心跳`, `变更`, `回写`.
DESIGN.md §10 only enumerates `状态迁移 / token 揭示 / 心跳 / 回写` — **`变更` is undocumented in
DESIGN.md but is live code**; a filter/enum for "类型" in the new UI must include it or it will
silently hide credential-profile audit rows. Issue #15's body only names
"token 揭示 / 状态迁移 / 心跳" explicitly, omitting `变更` and `回写` too — worth flagging as a
premise-check candidate (the issue's named type list underclaims what already exists to filter).

### No events HTTP today (confirmed)
Every `app.get|post|patch|delete(` route in `apps/server/src` (via grep across all `.ts` files):
`/api/v1/tasks`, `/api/v1/tasks/:publicId`, `/api/v1/tasks` (POST), `/api/v1/tasks/import`,
`/api/v1/tasks/:publicId` (PATCH), `/api/v1/credential-profiles` (GET/POST),
`/api/v1/credential-profiles/:id` (DELETE), `/login`, `/login/{github,gitlab,gitea}/callback`,
`/api/v1/me`, `/api/v1/users/:id/approve`, `/api/v1/agent-keys` (GET/POST),
`/api/v1/agent-keys/:id` (DELETE), plus Bearer-only `/api/v1/tasks/:publicId/{claim,progress,release}`
(registered via `child.post`, not `app.post`, inside `claimBearerContext`), `/api/v1/agent/whoami`,
`/api/mcp` (POST/GET/DELETE), and `/api/v1/webhooks/:publicId` (in `webhook.ts`, HMAC-authed, no
session). **No route path contains `event`.**

### Web member workbench (`apps/web`)
- Single file `apps/web/src/App.vue` (886 lines), no router. `view` is a computed over `me.value`:
  `'login' | 'pending' | 'member'` (`App.vue:439-443`) — there is no URL-driven navigation, adding
  an audit page/stats page means adding a new `view` state or a new section gated the same way the
  existing 凭证档案/Agent Key/发布任务 sections are gated by `canApprove`/`canManageKeys` computeds.
- `package.json` (`apps/web/package.json`): deps are only `naive-ui` + `vue`; devDeps
  `@vitejs/plugin-vue`, `@vue/test-utils`, `happy-dom`, `vite`, `vitest`, `vue-tsc`. **No
  `vue-router` dependency anywhere in the workspace** (confirmed by reading this file directly).
- Naive UI usage: `<n-config-provider :locale="zhCN" :date-locale="dateZhCN">` wraps everything;
  layout via `n-layout`/`n-layout-header`/`n-layout-content`; forms via `n-form`/`n-form-item`;
  data via `n-select`/`n-input`/`n-button`/`n-space`/`n-text`/`n-descriptions`/`n-alert`/`n-divider`;
  every interactive element carries a `data-testid` attribute (e.g. `board-filter-status`,
  `board-view-kanban`, `task-submit`) — this is the convention any new filter UI/stats page must
  follow for testability.
- All UI copy is Chinese; e.g. 任务看板, 列表, 看板, 状态, 标签, 批准 GitHub 用户, 凭证档案,
  发布任务, 账号待批准. A new audit page/stats page must match this register.
- Fetch pattern (`App.vue:538-563` `onMounted`, and every `load*`/`create*`/`delete*` function):
  always `fetch(url, { credentials: 'include', headers: { Accept: 'application/json'[, 'Content-Type': 'application/json'] } })`,
  wrapped in `try/catch`, checks `res.ok`, reads JSON defensively via a local `readJson()` helper
  that swallows parse errors. **Confirmed: `credentials: 'include'` on every request** — this is
  the pattern a new audit-log fetch / stats fetch must copy exactly.
- Board timeline today is **synthetic**, not event-backed: `board-timeline-item`
  (`App.vue:111-115`) renders a single hardcoded `发布 {{ selectedTask.poster }} {{ selectedTask.created_at }}`
  line, not a list built from any events fetch — confirms there is genuinely no events wiring on
  the client today, only a placeholder single "posted" line.
- Existing test files: `App.board.test.ts` (board/detail/filters, 644 lines) and
  `App.form.test.ts` (发布任务 form). Both use `vitest` + `@vue/test-utils`'s `mount`, stub
  `global.fetch` per-test, and assert against `data-testid` selectors. `App.board.test.ts`'s header
  comment references a prior workflow's test-authoring cache file at
  `kaola-workflow/bundle-8-17/.cache/tests-board.md` — that is the precedent for how a `tdd-guide`
  role for this bundle should hand off judgment calls to whoever implements the audit page.

### No team-stats / completed-count exists anywhere
Grepped `已完成|count|stats|统计` across `apps/` — only hits are: the `已完成` task-status enum
literal itself (schema, tests, poller, App.vue's `BOARD_STATUSES`), and `App.form.test.ts`/
`App.board.test.ts` filenames containing "test". **No aggregation query, no `/stats` route, no
stats widget exists.** A team-completion-count feature is 100% new surface.

---

## Exploration: Issue #16 — Claim-confirmation policy

### Comment-override scope (binding)
Issue body says default claim needs human confirmation; **the issue's own comment overrides the
body** per this bundle's brief and DESIGN.md §7 agrees verbatim: "认领即授权（MVP）：Agent API Key
即用户授权——用户明确指示 Agent 认领时无需二次确认；'人确认认领'开关只针对自主轮询式 Agent（M3，
Issue #16）" (`docs/DESIGN.md:162`), and §9's `claim_task` row: "API Key 即授权，无需二次确认（自主
轮询场景见 M3）" (`docs/DESIGN.md:202`). **Today's `claimTask` has zero confirmation gate of any
kind** — instructed-claim (the default path) already matches the design (no confirmation needed);
the *entire* feature surface for #16 is a new, currently-nonexistent "autonomous/polling agent"
mode plus its confirm/skip toggle. There is no code today that distinguishes "user instructed this
claim" from "agent discovered and self-initiated this claim" — that distinction does not exist in
any request shape (REST body, MCP tool args, agent_keys schema) yet.

### Entry Points
- REST: `POST /api/v1/tasks/:publicId/claim` — Bearer-authed, registered inside
  `claimBearerContext` (`apps/server/src/claim.ts:366-393`).
- MCP: `claim_task` tool, `input Schema: { task_id: z.string() }` (`apps/server/src/mcp.ts:114-121`).
  **No `autonomous`/`mode`/similar field on `claim_task` or `list_tasks`** — confirmed by reading
  every `registerTool` call in `mcp.ts` (`list_tasks`: `{ status?, tags?, forge? }`; `get_task_brief`:
  `{ task_id }`; `claim_task`: `{ task_id }`; `report_progress`: `{ task_id, note? }`;
  `release_task`: `{ task_id, reason? }`; `submit_pr`: `{ task_id, pr_url, summary }`).

### `claimTask` signature and exact behavior (`apps/server/src/claim.ts:68-189`)
```ts
export async function claimTask(
  db: AppDb,
  auth: AgentPrincipal,
  publicId: string,
): Promise<AgentServiceResult<{
  task: ReturnType<typeof taskBrief>
  token: string
  lease: ReturnType<typeof leaseEnvelope>
  clone: { suggested_dir: string; token_usage: string }
}>>
```
Call sites: `claim.ts:375` (REST `POST .../claim` handler) and `mcp.ts:120` (`claim_task` tool).
There are exactly these two call sites in the whole repo (grepped `claimTask(`).

Behavior, in order:
1. `auth.user.status === '待批准'` → `{ ok: false, httpStatus: 403, body: { error: 'forbidden', message: PENDING_CLAIM_MESSAGE } }`. `PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'`. **This is the only existing eligibility gate on claim** — it answers "can GitHub 待批准 users claim?" → **no**, 403, before any lease/token logic runs.
2. `sweepExpiredLeases(db)`.
3. `selectTask` 404 if task missing.
4. Task status must be exactly `'待认领'`; `'进行中'` → 409 `{ error: 'conflict', message: '任务已被认领。' }`; any other status → 409 `{ error: 'illegal_transition', message }`.
5. Decrypts the task's credential (profile or inline) — a `vault_unconfigured` error surfaces as 500 `{ error: 'vault_unconfigured' }`.
6. Status flips `待认领 → 进行中` via `transitionTaskStatus` (from `@kaola/shared`).
7. `insertActiveLease(...)` (TTL `86400`s, `leases.ts:8`).
8. Writes `token 揭示` then `状态迁移` audit events (both `actorUserId: auth.user.id`).
9. `await attemptWriteback(db, updated, '认领', auth.user.id)` — best-effort issue comment for imported tasks, never throws.
10. Success: `{ ok: true, httpStatus: 201, body: { task, token: plaintext, lease: { expires_at (ISO string), ttl_seconds: 86400 }, clone: { suggested_dir, token_usage } } }`.

**Everything above runs synchronously to completion inside one call — there is no pending/awaiting
state today.** Adding a confirmation gate for autonomous agents means either (a) branching before
step 5 (before token decrypt/reveal) into a new pending-approval path that returns *without* a
token, or (b) a new endpoint/tool for "request claim" distinct from "claim". Nothing in the current
code models a two-phase claim.

### Pinned REST claim 201 envelope test (do not break)
`apps/server/src/claim.test.ts:580-595` (`assertClaim201`):
```js
assert.equal(res.statusCode, 201, ...)
assert.deepEqual(Object.keys(body).sort(), ['clone', 'lease', 'task', 'token'])
// body.token === forgePlaintext (the fixture forge token)
assert.deepEqual(Object.keys(body.clone).sort(), ['suggested_dir', 'token_usage'])
assert.equal(body.clone.token_usage, CLONE_TOKEN_USAGE)
```
And `claim.test.ts:540-562`: every non-claim response (list/get/progress/release, and all error
bodies) is asserted to leak **no** plaintext token and **no** key named
`token|token_encrypted|inline_token_encrypted|access_token`; the claim 201 response is the single
carve-out permitted to carry `body.token === forgePlaintext`. **Whatever #16 implements, the
default instructed-claim path's 201 body shape (`['clone','lease','task','token']`) is explicitly
pinned by this test and must not change for that path.**
`apps/server/src/mcp.test.ts:1042-1057` pins the identical key set for the MCP `claim_task` tool's
`structuredContent`. `mcp.test.ts:1059-1082` also pins: pending (`待批准`) `claim_task` is
`isError` matching REST's 403, reveals no token, and writes no `token 揭示` event — i.e. the
existing 待批准 gate is exercised via MCP too, same code path (`claimTask`).

### `users` table schema (`apps/server/src/schema.ts:4-16`)
```ts
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  provider: text('provider', { enum: ['github', 'gitlab', 'gitea'] }).notNull(),
  remoteId: text('remote_id').notNull(),
  username: text('username').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status', { enum: ['active', '待批准'] }).notNull(),
  permissionLevel: text('permission_level', { enum: ['full', 'claim_only'] }).notNull(),
}, unique(provider, remoteId))
```
**No settings/preference column of any kind** (no JSON blob, no boolean flag). "受信自动化" per
DESIGN.md §3/§7 is described as a per-user toggle ("可按用户关闭") — there is currently **no
column to persist it**. Adding it needs either a new nullable column on `users` (e.g.
`trusted_automation INTEGER NOT NULL DEFAULT 0`) or a new table; no precedent either way exists
yet (this would be the first user-level settings column).

### `agent_keys` table schema (`apps/server/src/schema.ts:18-28`)
```ts
export const agentKeys = sqliteTable('agent_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  keyHash: text('key_hash').notNull(),
  label: text('label').notNull().default(''),
  lastUsedAt: integer('last_used_at'),
}, unique(keyHash))
```
**No kind/autonomous/mode flag.** Keys are created via `POST /api/v1/agent-keys`
(`agent-keys.ts:40-70`) with only a free-text `label`; there is nothing distinguishing "this key is
for an instructed-claim assistant" vs "this key is for an autonomous poller" at the key level
today. If #16's "自主轮询式 Agent" concept is meant to be identified per-key rather than per-user,
that is also entirely new surface (no column, no creation-time input for it).

### No pending-claim table
Grepped all tables in `schema.ts`/`db.ts`: `users`, `agent_keys`, `credential_profiles`, `tasks`,
`events`, `leases`, `submissions`. `leases.state` enum is `['active', 'released', 'expired']` —
**no `pending`/`awaiting_confirmation` state**. There is no queue/inbox table for "claims awaiting
owner approval" anywhere in the codebase.

### Whoami / me JSON shapes
- Session `GET /api/v1/me` → `publicUser()` (`auth.ts:69-92`): `{ id, provider, remote_id,
  username, display_name, status, permission_level, message? }` (`message` present only when
  `status === '待批准'`, always the fixed `PENDING_CLAIM_MESSAGE` string).
- Bearer `GET /api/v1/agent/whoami` (`agent-keys.ts:109-121`): `{ id, key_id, label, status,
  permission_level }` — note this is the **user's** `id`/`status`/`permission_level` plus the
  **key's** `id`(as `key_id`)/`label`, not a nested object. No `autonomous`/settings field on
  either shape today.

### GitHub 待批准 users and claiming — confirmed
`mapProfile` for GitHub (`auth.ts:100-108`) sets `status: PENDING_STATUS` (i.e. `'待批准'`) and
`permissionLevel: 'claim_only'` unconditionally on first login. `claimTask` step 1 above rejects
any `'待批准'` user with 403 before doing anything else. So: **a fresh GitHub login cannot claim
until a `full`+`active` member calls `POST /api/v1/users/:id/approve`** (`auth.ts:328-348`,
session-authed, requires `actor.status === 'active' && actor.permissionLevel === 'full'`); after
approval the user's `permission_level` stays whatever it was set to (GitHub logins stay
`claim_only` forever per `mapProfile`; only `status` flips to `'active'`). GitLab/Gitea logins are
`status: 'active', permissionLevel: 'full'` from first login (not shown above but implied by
`canPostTasks`/`canManageProfiles` checks elsewhere gating on `permissionLevel === 'full'`, and
`CLAUDE.md`'s statement that GitLab/Gitea are "正式成员").

---

## Shared surfaces / collision risks between #15 and #16

1. **`insertAuditEvent` / `events` schema is the literal shared surface.** #16, if it adds a new
   confirmation-flow event type (e.g. "认领待确认"/"认领已批准"), writes through the exact same
   `insertAuditEvent` helper (`vault.ts:73`) that #15's reader must enumerate types over. **If #16
   lands first (or in the same commit) and adds a new `type` literal, #15's type-filter dropdown
   and any hardcoded type enum in the audit UI must include it, or the new type will be invisible
   in the audit log the same day it starts being written.** Coordinate the type name before either
   side hardcodes an enum.
2. **Both touch `apps/web/src/App.vue`.** #15 needs a new audit-page/stats section (new `view` or
   new gated section in the single-file component); #16 needs a new settings toggle
   ("受信自动化") somewhere in the same component, likely near the Agent Key widget
   (`App.vue:128-144`, gated on `canManageKeys`). Both edits land in the same 886-line file with no
   router to isolate them — sequence or merge carefully to avoid clobbering each other's
   `<script setup>` state block or template section. Both should follow the existing `data-testid`
   + Chinese-copy + `credentials:'include'` conventions documented above.
3. **Both touch `claim.ts` conceptually but not necessarily the same lines.** #15 only *reads*
   events that `claim.ts` already writes (no `claim.ts` edit needed for #15). #16 edits `claimTask`
   itself (new gate) — if #16 adds a new audit event type for the confirmation flow, that edit is
   in `claim.ts`/`mcp.ts` (the two `claimTask(` call sites) plus wherever the new
   confirm/approve action lives (new route/tool). No line-level collision expected since #15
   should not need to touch `claim.ts`, but both issues' audit-event vocabulary must agree.
4. **`users` schema change risk**: if #16 adds a `trusted_automation`-style column to `users`, that
   is a schema/migration change (`db.ts` DDL + `schema.ts` + `createDb`) — #15 has no reason to
   touch `users` schema, so this is low collision risk but is exactly the kind of "user-owned
   contract" change (schema migration) CLAUDE.md's Non-Negotiable Rules says must be escalated to
   the user before proceeding, not decided unilaterally by an implementer.
5. **Test-file collision risk is low**: #15's likely new tests live in a new file (e.g.
   `apps/server/src/events.test.ts` and/or a new `apps/web/src/App.audit.test.ts`); #16's likely
   new tests extend `apps/server/src/claim.test.ts`/`mcp.test.ts` (existing describe blocks) and
   possibly a new `apps/web/src/App.settings.test.ts`. Both add to the root `package.json` `test`
   script's file list if a new server test file is created — that one line is a shared edit point.

## Patterns to reuse (named files, for the orchestrator/implementer)
- **Session cookie auth**: `getSessionUser(db, request)` / `sendUnauthorized(request, reply)` —
  `apps/server/src/auth.ts:57-67,175-179`. Use for any new Web-facing (browser) audit/stats/settings
  route.
- **Bearer agent auth**: `addAgentBearerHook(app, db)` / `sendBearerUnauthorized(reply)` —
  `apps/server/src/agent-bearer.ts`. Decorates `request.agentAuth = { user, key }`. Used identically
  by `claim.ts`, `mcp.ts`, and the `/api/v1/agent/whoami` sub-context in `agent-keys.ts`.
- **`registerX` wiring**: every route module exports a `registerX(app, db)` function called once
  from `apps/server/src/app.ts:86-92` in a fixed order (`registerAuth`, `registerAgentKeys`,
  `registerCredentialProfiles`, `registerTasks`, `registerClaim`, `registerMcp`,
  `registerWebhooks`). A new `registerEvents`/`registerStats` module should follow this exact
  export shape and be added to that call sequence.
- **Web widget pattern**: any Naive-UI section in `App.vue` gated by a computed permission flag
  (`canApprove`, `canManageKeys`) with its own `ref`s, a `load*()` fetch-and-populate function
  called from `onMounted`, and `data-testid`-tagged elements — see the Agent Key widget
  (`App.vue:128-144,362-367,596-664`) and Credential Profile widget
  (`App.vue:146-172,369-376,680-731`) as the two most directly analogous precedents for both a new
  settings toggle (#16) and a new audit/stats read-only widget (#15).
- **`insertAuditEvent`** (`vault.ts:73-85`) — the only way to write an event; reuse, do not
  reimplement `db.insert(events)` elsewhere.
- **Chinese-first everything**: every user-facing string, every DB enum value that carries meaning
  (`status`, `type`, transition labels) is already Chinese in this codebase; English is reserved
  for identifiers/comments per CLAUDE.md's UI-language rule — matches DESIGN.md's actual practice.

## Out of scope / not done here
No design proposal, no code/test edits, no `docs/DESIGN.md` changes. This file only reports
measured ground truth as of the HEAD commit above.
