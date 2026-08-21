# Issue #9 doc-updater proof

- **task:** dock README / CHANGELOG / CLAUDE.md Commands+snapshot / docs/api.md / docs/architecture.md to the implemented REST claim surface
- **worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9`
- **docs edited:** `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/api.md`, `docs/architecture.md`
- **docs not edited:** `docs/DESIGN.md` (untouched), `docs/README.md` (index already lists api/architecture), `docs/conventions.md` (still true: tokens never in logs or non-claim responses), `docs/decisions/` (none)
- **not invented:** `scripts/codemaps/`, `docs/CODEMAPS/`
- **pnpm test:** not run this role; CHANGELOG #9 says "see later validation"; old measured bullets left with their original counts

`git diff --stat` (docs only): `README.md` `CHANGELOG.md` `CLAUDE.md` `docs/api.md` `docs/architecture.md` — 5 files, +92/−35. `docs/DESIGN.md` and `apps/server/src/claim.test.ts` not in the diff (test file remains untracked; this role did not edit it).

---

## Sentences changed → source

### README.md

| Changed sentence (summary) | Source |
|---|---|
| Status line: #9 REST 租约认领 landed; MCP not | `app.ts:51` `registerClaim`; no MCP SDK in `apps/server/package.json` |
| 已落地 header includes #9 | same |
| `revealCredentialProfile` is not itself HTTP; only successful Bearer `POST /api/v1/tasks/:publicId/claim` `201` top-level `token` returns a forge token | `vault.ts:81-99`; `claim.ts:159-167` |
| 任务看板: 无认领 UI; still one synthetic 发布 | existing board docs; `architecture.md` web section vs `App.vue` (no claim UI in #8 surface) |
| REST 租约认领 (#9) routes, 201 keys `clone`/`lease`/`task`/`token`, `ttl_seconds` number `86400`, progress 200 `{ task, lease }` no token, release 200 `{ task }` `待认领` no token, session GET never token, `sweepExpiredLeases` no cron, MCP `claim_task` 未实现 | `claim.ts:59,159-167,170-206,209-255`; `leases.ts:8,60-80`; `tasks.ts:403,411`; tests-claim.md Request/response shapes |
| 尚未实现: dropped 认领时揭示 and 租约认领; MCP (`claim_task` / `submit_pr`) still unimplemented; auto-close still unimplemented | `claim.ts` exists; no MCP; no `submit_pr` route |
| 工作原理 caption: diagram remains DESIGN target; current Agent path is Bearer REST claim | `claim.ts:59`; mermaid still names MCP tools as design |
| 首次使用: REST claim implemented; 看板无认领按钮 / 一条合成「发布」; MCP 未实现 | `claim.ts`; #8 board (no claim UI) |
| 项目结构 server comment: `+ claim/leases` | `claim.ts`, `leases.ts`, `db.ts:80-106` |
| `pnpm test` list appends `apps/server/src/claim.test.ts` after `hosting.test.ts` | worktree `package.json:13` |
| Roadmap: #9 landed; remaining M1 is MCP / PR 轮询 | `registerClaim` present; no MCP; no webhook auto-close |

### CHANGELOG.md

| Changed sentence (summary) | Source |
|---|---|
| New Unreleased #9 bullet at top: `registerClaim` after `registerTasks` | `app.ts:50-51` |
| `leases` DDL columns + unique index `leases_one_active_per_task` | `db.ts:80-96` |
| Drizzle `state` `'active' \| 'released' \| 'expired'` | `schema.ts:92-101` |
| TTL `LEASE_TTL_SECONDS` `86400`; no per-task TTL column | `leases.ts:8`; `db.ts:80-91` (no TTL column) |
| `addAgentBearerHook` in `agent-bearer.ts`; not `@fastify/bearer-auth`; whoami + claim | `agent-bearer.ts:38-60`; `agent-keys.ts:107`; `claim.ts:57` |
| Unauth `401 { error: 'unauthorized' }` + `WWW-Authenticate: Bearer` | `agent-bearer.ts:34-36`; tests-claim.md Errors |
| Claim `201` keys `clone`,`lease`,`task`,`token`; lease `{ expires_at, ttl_seconds }` with `ttl_seconds` 86400; `clone.token_usage` exact string | `claim.ts:26-27,33-37,159-167`; tests-claim.md Claim 201 |
| Progress `{ note?: string }` → `200 { task, lease }` no token; release `{ reason?: string }` → `200 { task }` `待认领` no token | `claim.ts:170-206,209-255`; tests-claim.md |
| Pending message `你的账号待正式成员批准后方可认领任务。` | `claim.ts:20,63-64` |
| 404 `not_found`; 409 `任务已被认领。`; 409 `illegal_transition` template; non-holder 403; no-lease `任务未被认领。`; `500 vault_unconfigured` | `claim.ts:72,76-83,122-123,186-188,183-184`; tests-claim.md Errors |
| Events: claim `token 揭示` `{ task_id, agent_key_id, credential, profile_id? }` then `状态迁移`; progress `心跳`; release `状态迁移` + optional `reason`; expiry `状态迁移` `进行中`→`待认领` actor null | `claim.ts:87-92,147-156,193-197,242-251`; `leases.ts:74-78` |
| `insertAuditEvent` `actorUserId: number \| null` | `vault.ts:67-69` |
| Sweep check-on-read (session GET) and check-on-write (claim/progress/release); no cron | `tasks.ts:403,411`; `claim.ts:67,174,213`; `leases.ts:60` |
| Only claim `201` top-level `token` is HTTP that returns a forge token; session GET never | `claim.ts:159-167`; tests-claim.md “session GET list and GET one … omit forge token” |
| MCP, `submit_pr`, web claim UI not implemented | no MCP SDK; no `submit_pr` route; #8 board still synthetic 发布 |
| Root `pnpm test` includes `apps/server/src/claim.test.ts` after `hosting.test.ts`; no new measured totals | `package.json:13` |
| #7 bullet: “Task CRUD responses contain no token”; MCP still unimplemented (REST claim is #9) | `tasks.ts` POST/GET never send forge token; `claim.ts` is #9 |
| #5 bullet: replaced “No HTTP that returns a forge token.” with claim `201` top-level `token` (#9); #5-era MCP/CRUD/claim unimplemented kept as past tense | user hard rule; `claim.ts:161` |

### CLAUDE.md

| Changed sentence (summary) | Source |
|---|---|
| Snapshot: `registerClaim`; `leases` table; TTL `86400`; `addAgentBearerHook` in `agent-bearer.ts` | `app.ts:51`; `db.ts:80-106`; `leases.ts:8`; `agent-bearer.ts:38` |
| Snapshot: `revealCredentialProfile` is a module export, not itself HTTP; only claim `201` top-level `token` returns a forge token; session GET never | `vault.ts:81-99`; `claim.ts:159-167`; `tasks.ts:399-417` |
| Snapshot: `insertAuditEvent` `actorUserId: number \| null` | `vault.ts:67-69` |
| Snapshot: web 看板 no claim UI; one synthetic 发布 | #8 surface (unchanged) |
| Snapshot: MCP is not implemented (claim REST is) | no MCP SDK |
| Commands Test: append `apps/server/src/claim.test.ts` after `hosting.test.ts` | `package.json:13` |
| Project Conventions: reveal via Bearer POST claim; MCP `claim_task` not implemented | `claim.ts:159-167`; no MCP |

### docs/api.md

| Changed sentence (summary) | Source |
|---|---|
| Lede: claim HTTP implemented; MCP tools including `submit_pr` not; only claim `201` top-level `token` returns a forge token; session GET never | `claim.ts`; tests-claim.md; no MCP |
| Sources include `claim.ts`, `leases.ts`, `agent-bearer.ts` | those files |
| whoami: `addAgentBearerHook` in `agent-bearer.ts`, used by whoami and claim; not `@fastify/bearer-auth` | `agent-bearer.ts:38`; `agent-keys.ts:107`; `claim.ts:57` |
| GET list/one: `sweepExpiredLeases` then re-read; never forge token / secret key names | `tasks.ts:403-416`; tests-claim.md |
| Three Bearer routes: paths, 201/200 keys, `ttl_seconds` 86400, exact `token_usage`, pending message, error table, holder `claimer_user_id`, no `validateToken` | `claim.ts` throughout; `leases.ts:8`; tests-claim.md tables |
| `registerClaim(app, db)` after `registerTasks` | `app.ts:50-51` |
| `leases` DDL column list + `leases_one_active_per_task` + `state` enum + `task_id` = `tasks.id` + TTL 86400 + `expires_at <= now` + no cron | `db.ts:80-96`; `schema.ts:92-101`; `leases.ts:8,60-80` |
| Events: claim-shaped `token 揭示`; claim/release/expiry `状态迁移`; progress `心跳`; expiry actor null | `claim.ts:147-156,193-197,242-251`; `leases.ts:74-78` |
| `insertAuditEvent(db, { type, actorUserId, details })` with `actorUserId: number \| null` | `vault.ts:67-69` |
| Vault: reveal helper is not HTTP; claim `201` is the HTTP that returns a forge token | `vault.ts:81-99`; `claim.ts:161` |
| `VAULT_MASTER_KEY` unconfigured also mapped on claim → `500 { error: 'vault_unconfigured' }` | `claim.ts:122-123` |
| No MCP SDK; Bearer is encapsulated hook | `apps/server/package.json`; `agent-bearer.ts` |

### docs/architecture.md

| Changed sentence (summary) | Source |
|---|---|
| Tree: claim/progress/release routes; GET list/one sweep; `leases` + unique index; only claim 201 top-level token; web no claim UI; MCP not implemented | `claim.ts:59,170,209`; `tasks.ts:403,411`; `db.ts:80-106`; `apps/server/package.json` |
| `createDb` execs leases then unique index; drizzle schema includes `leases`; TTL 86400; no per-task TTL column | `db.ts:98-109`; `leases.ts:8` |
| Bearer hook module; `insertAuditEvent` `number \| null` | `agent-bearer.ts:38`; `vault.ts:67-69` |
| `registerClaim` after `registerTasks`; check-on-read/write; no cron; no MCP SDK | `app.ts:50-51`; `tasks.ts:403,411`; `claim.ts:67,174,213` |
| Web: no claim UI; one synthetic 发布 | #8 board (unchanged) |

---

## Explicit non-claims

| Not claimed | Why |
|---|---|
| MCP implemented (`list_tasks` / `get_task_brief` / `claim_task` / `report_progress` / `submit_pr` / `release_task`) | No MCP SDK in `apps/server/package.json`; docs say MCP not implemented |
| `submit_pr` HTTP/MCP exists (#11) | No such route in `claim.ts` / `app.ts` |
| Web claim UI / events HTTP | Board still one synthetic 发布; no events HTTP (`docs/api.md` events table; #8) |
| Per-task TTL column | `LEASES_DDL` has no TTL column; default `LEASE_TTL_SECONDS` `86400` only (`leases.ts:8`) |
| `docs/DESIGN.md` changed | File not in `git diff`; REST paths are implementation of DESIGN §9 “REST 端点一一对应” |
| `claim.test.ts` edited | This role did not write it |
| `scripts/codemaps/` or `docs/CODEMAPS/` | Do not exist; not invented |
| New measured `pnpm test` / lint counts | This role did not run `pnpm test`; #9 CHANGELOG says “see later validation”; old measured bullets untouched as counts |

---

## `insertAuditEvent`

Transcribed from `apps/server/src/vault.ts:67-69`:

```ts
export function insertAuditEvent(
  db: AppDb,
  input: { type: string; actorUserId: number | null; details: unknown },
): void {
```

Expiry in `leases.ts:74-77` passes `actorUserId: null`.
