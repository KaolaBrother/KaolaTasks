# Orchestrator rulings — bundle-15-16 (#15 + #16)

Recorded after `ground-truth.md` (worktree HEAD `637c304`). These pin the suites. Evidence: DESIGN.md §3 §7 §9 §10; issue #15 body (no comments); issue #16 **comment overrides body**; measured events writers, claim path, users/agent_keys schemas, App.vue workbench.

Tie-break: additive schema + request-flag distinction are technical means to the issue's already-stated values (persist the toggle; unconfirmed autonomous claim must not reveal). Not a DESIGN.md contract rewrite. Same class of change as `leases` / `submissions` in M2.

## Shared / out

In for #15: session-auth events list + stats derived from `events`; Chinese audit + stats UI in the existing member workbench; combinable client-side filters.
In for #16: optional `autonomous` on claim; pending confirmation without revealing token; per-user `trusted_automation` default off; confirm/reject in the Web UI; instructed claims unchanged.
Out: DESIGN.md rewrites; vue-router; new task-lifecycle status (no `待确认`); REST `submit_pr`; changing instructed-claim `201` keys `['clone','lease','task','token']`; putting a forge token on any session GET, events payload, stats payload, pending payload, or log; MCP tool besides `claim_task` growing a required arg.

Shared event vocabulary (both suites must use these exact `type` strings if they assert them):

| type | when |
|---|---|
| existing | `状态迁移` `token 揭示` `心跳` `变更` `回写` — already written; do not rename |
| `认领待确认` | autonomous claim parked (no token, task still `待认领`) |
| `认领已确认` | owner approved a pending confirmation (still no token; agent must retry claim) |

`details.task_id` remains the **public id string**. `actor_user_id` is the acting user (never null on these two new types).

Collision: both issues edit `apps/web/src/App.vue` and root `package.json` `test` script. Tests live in disjoint files (below). Implementers land #15 first, then #16.

---

## #15 — Audit log UI + team stats

### HTTP

Session cookie auth (`getSessionUser` / `sendUnauthorized`), same as `GET /api/v1/tasks`. `待批准` → 401 (they never see the member workbench). `claim_only` **can** read (same as the board).

1. `GET /api/v1/events` — no query string (board precedent: `GET /api/v1/tasks` has none). `200` `{ events: EventRow[] }` newest-first (`id` descending is fine). Each `EventRow`:

```ts
{
  id: number
  type: string
  actor_user_id: number | null
  actor_username: string | null  // left-join users.username; null when actor_user_id is null
  created_at: string            // ISO-8601, same convention as task briefs' created_at
  details: object               // JSON.parse of the TEXT column, never re-serialized as a string
}
```

Pin: response JSON (including nested `details`) contains **none** of `token`, `token_encrypted`, `inline_token_encrypted`, `access_token`, and no forge-token plaintext from fixtures. System rows (`actor_user_id` null) still appear, with `actor_username` null.

2. `GET /api/v1/stats` — session auth, no query. `200` body **exactly**:

```ts
{
  completed_count: number
  completed_by_username: Record<string, number>
}
```

Definition (acceptance: 统计数字与 events 表一致 — **not** `SELECT COUNT(*) FROM tasks WHERE status='已完成'`):

- `completed_count` = number of `events` rows with `type === '状态迁移'` whose parsed `details.to === '已完成'`.
- `completed_by_username` groups those same rows by `actor_username`, using the key `"系统"` when `actor_user_id` is null (poller/webhook completion). Users with zero completions are omitted.

Empty DB → `{ completed_count: 0, completed_by_username: {} }`.

Register as `registerEvents(app, db)` from `apps/server/src/events.ts`, called from `app.ts` next to the other `registerX` hooks. Do not put these routes on the Bearer agent context.

### Web (no vue-router)

Still `view === 'member'` in `apps/web/src/App.vue`. Add two Naive UI sections (Chinese copy), visible to every member (including `claim_only`), hidden on login/pending:

- **审计日志** — table/list of `GET /api/v1/events`. Combinable client-side filters (AND across dimensions): 类型, 人 (`actor_username`; include a way to pick `系统`/empty actor), 任务 (`details.task_id`), 时间 (from/to). Types offered must include every live literal so rows are not silently dropped: `token 揭示`, `状态迁移`, `心跳`, `变更`, `回写`, `认领待确认`, `认领已确认`. Fetch URL stays exactly `/api/v1/events` (no query) so stubs stay simple.
- **团队统计** — renders `GET /api/v1/stats`: 完成数 = `completed_count`; per-user breakdown from `completed_by_username`. Fetch URL exactly `/api/v1/stats`.

`data-testid` contract (stable, required by the web suite):

| testid | role |
|---|---|
| `audit-section` | 审计日志 section root |
| `audit-filter-type` | type filter control |
| `audit-filter-actor` | person filter |
| `audit-filter-task` | task public-id filter |
| `audit-filter-from` | time from |
| `audit-filter-to` | time to |
| `audit-row` | one visible event row (repeat) |
| `stats-section` | 团队统计 section root |
| `stats-completed-count` | the completed_count number |

Reuse `credentials: 'include'` + `Accept: application/json` + `readJson()`. Copy mount/stub style from `App.board.test.ts`; do not import that file. `ME_FULL` fixtures may omit `trusted_automation` (treat missing as off) so existing board/form tests keep working.

### Tests to author (custody) — #15 only

- `apps/server/src/events.test.ts` — real `buildApp`, copy OAuth/session/agent-key seams from `claim.test.ts` / `tasks.test.ts` (do **not** import those files). Pin: unauth 401; list returns writers' rows with parsed details + actor_username; combinable-filter *UI* is web-side, so HTTP list is unfiltered; stats `completed_count` matches inserted `状态迁移`+`to:已完成` rows including a null-actor row counted under `"系统"`; a `已完成` **task row** with **no** matching event must **not** inflate stats (this is the near-miss vs counting `tasks`); no secret keys / fixture tokens on the wire. Drive a few real writers (claim → `token 揭示`+`状态迁移`, progress → `心跳`) rather than only raw SQL inserts, plus SQL/helper inserts for a null-actor completion event.
- `apps/web/src/App.audit.test.ts` — vitest + test-utils. Stub `GET /api/v1/me`, `/api/v1/tasks`, `/api/v1/events`, `/api/v1/stats` (and whatever else `onMounted` already fetches). Pin: member view shows 审计日志/团队统计 in Chinese; combinable filters hide/show `audit-row`; stats section shows `completed_count` from the stub; pending view has neither section; no vue-router; fetch paths are exactly `/api/v1/events` and `/api/v1/stats`.
- Root `package.json` `test` script: append `apps/server/src/events.test.ts` after `writeback.test.ts` (explicit path, no glob). Web vitest already picks up `App.audit.test.ts`.
- Do **not** edit production files. Do **not** edit `claim.test.ts` / `mcp.test.ts`. Do **not** add claim-confirmation tests.

---

## #16 — Claim-confirmation for autonomous polling agents

**Comment wins.** Instructed claims (user told the Agent to claim) stay MVP 认领即授权: API Key is enough, `201` + `token`. The new gate applies only when the Agent declares the claim as autonomous.

### How the Agent is distinguished (judgment + evidence)

Optional boolean `autonomous` on the claim request. Absent, `false`, or empty REST body → instructed → today's path unchanged.

- REST `POST /api/v1/tasks/:publicId/claim` may parse JSON `{ autonomous?: boolean }`. Missing/invalid body = instructed (today's clients send no body).
- MCP `claim_task` input adds **optional** `autonomous: z.boolean().optional()`. Required keys stay `{ task_id }`.

Evidence: no `agent_keys.kind` column exists; forcing a new key type would break current keys and is not in the issue. A client-supplied flag matches "Agent 自行发现并发起认领". Internal honest-agent model (DESIGN D4). Existing `assertClaim201` / MCP structuredContent key set must keep passing for the instructed path.

Do **not** add an `autonomous` column on `agent_keys`.

### Persistence

1. `users.trusted_automation` — INTEGER NOT NULL DEFAULT 0 (0 off, 1 on). Add to `USERS_DDL` and `schema.ts`. After `sqlite.exec(USERS_DDL)`, also try `ALTER TABLE users ADD COLUMN trusted_automation INTEGER NOT NULL DEFAULT 0` and ignore duplicate-column errors so a pre-existing file DB still boots. Default off = autonomous claims need confirm.
2. New table `claim_confirmations` (CREATE TABLE IF NOT EXISTS), Drizzle in `schema.ts`, wired in `createDb`:

```sql
CREATE TABLE IF NOT EXISTS claim_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  agent_key_id INTEGER NOT NULL,
  state TEXT NOT NULL, -- 'pending' | 'approved' | 'rejected'
  created_at INTEGER NOT NULL
)
```

Do **not** add a task status. Task stays `待认领` until a later successful claim. Do **not** insert a lease and do **not** decrypt the forge token while `pending`.

### Claim behavior (`claimTask` is the single choke point — REST + MCP)

Keep the existing 待批准 403 first. Then, only when `autonomous === true`:

| user.trusted_automation | confirmation row for (task, user, key) | result |
|---|---|---|
| 1 (on) | (ignored) | identical to instructed: 201 + token + lease + `token 揭示` + `状态迁移` |
| 0 (off) | none, or `rejected`, or stale `approved` after a successful claim consumed it | **do not** decrypt, **do not** lease, **do not** flip status. Insert `claim_confirmations` `pending`. Write `认领待确认` `{ task_id, agent_key_id }`. REST **202** `{ error: 'confirmation_required', message }` (Chinese message, no `token` key). MCP: `isError` **false**, `structuredContent` has `pending: true` and `error: 'confirmation_required'`, **no** `token` |
| 0 | `approved` (unconsumed) | proceed as instructed 201 + token; mark that row consumed (delete or `state` that cannot match again — pick one and pin it) |

Instructed (`autonomous` not true): ignore confirmation rows; always today's 201 path (unless 待批准 / 409 / 404).

Pin: 202/pending bodies fail the same secret-key scan as non-claim responses in `claim.test.ts` (`token|token_encrypted|inline_token_encrypted|access_token` absent; fixture plaintext absent). Unconfirmed autonomous claim writes **no** `token 揭示` event.

Idempotent re-request while still `pending`: return 202 / pending again; do not duplicate infinitely — one pending row per (task_id, user_id, agent_key_id) is enough (reuse it).

### Confirm / reject / settings (session, not Bearer)

Chinese UI in `App.vue` member view, near the Agent Key widget, gated like `canManageKeys` (active user). `claim_only` **can** toggle their own automation and confirm their own pending claims.

- `GET /api/v1/me` additive field `trusted_automation: boolean` (default false). Do not remove existing keys. Existing web stubs without the field must keep working.
- `PUT /api/v1/me/settings` body `{ trusted_automation: boolean }` → 200 `{ trusted_automation }`. Persist. Turning **off** must stick (next autonomous claim 202's again). Turning **on** lets the next autonomous claim 201 without a prior confirm.
- `GET /api/v1/claim-confirmations` → `{ confirmations: [{ id, task_id /* public id */, state, created_at }] }` current user only, typically `pending`.
- `POST /api/v1/claim-confirmations/:id/approve` → 200; owner-only; writes `认领已确认`; does **not** reveal token, does **not** flip task status, does **not** insert lease. Agent retries `claim_task`.
- `POST /api/v1/claim-confirmations/:id/reject` → 200; owner-only; `state='rejected'`; retry of autonomous claim starts a new pending (202), still no token.

404 for other users' ids. 待批准 cannot hit these (401).

`data-testid`:

| testid | role |
|---|---|
| `trusted-automation-toggle` | 受信自动化 switch |
| `claim-confirmation-list` | pending list |
| `claim-confirmation-approve` | approve action (per row ok) |
| `claim-confirmation-reject` | reject action |

### Tests to author (custody) — #16 only

- `apps/server/src/claim-confirm.test.ts` — real `buildApp`, copy seams from `claim.test.ts` (do not import it). Pin all three acceptance bullets: (1) autonomous + automation off + unconfirmed → 202, no token, no `token 揭示`, task still `待认领`; (2) `PUT` settings true then autonomous claim → 201 + token (直通); settings false again → 202; (3) persist across a new `buildApp` on the **same** sqlite file path. Also: instructed claim (no body / `autonomous: false`) still `assertClaim201` shape; MCP `claim_task` without `autonomous` still returns token; MCP with `autonomous: true` pending has no token; approve then retry autonomous → 201 + token; 待批准 still 403 before this gate. Secret-key scan on 202, confirmations GET, me, settings.
- `apps/server/src/mcp.test.ts` — **do not rewrite existing tests**. If you need MCP autonomous coverage, put it in `claim-confirm.test.ts` by posting `/api/mcp` (copy the MCP helper from `mcp.test.ts`, do not import that file) **or** add a new describe at the **end** of `mcp.test.ts` only if copying the helper would be a large duplicate. Prefer `claim-confirm.test.ts` so #15's files and this file stay the only new paths.
- `apps/web/src/App.settings.test.ts` — stub me/settings/confirmations. Pin Chinese 受信自动化 control; toggle issues `PUT /api/v1/me/settings`; pending list + approve/reject post the routes above; pending view hides the widget.
- Root `package.json` `test` script: **do not edit it** (the #15 suite owns that line in parallel). Record in the handoff that orchestrator must append `apps/server/src/claim-confirm.test.ts` after `events.test.ts`.
- Do **not** edit production files. Do **not** weaken `assertClaim201` or the secret-key scan in `claim.test.ts`. Do **not** add audit-log UI tests.

---

## Check-the-premise notes (do not freeze into DESIGN.md)

- DESIGN §3 still says "默认需要人对认领做一次确认"; §7 / §9 / the issue comment are the current rule. Suites follow §7 + the comment.
- DESIGN §10's type list omits live `变更` and the two new confirmation types. The UI filter lists them anyway so the log matches the table.
- #16 does not hold the task while pending (race is accepted; no new lifecycle state).
