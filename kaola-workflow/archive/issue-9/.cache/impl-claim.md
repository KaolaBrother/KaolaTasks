# Issue #9 implementer proof — lease-based claiming

- **task:** REST claim / progress / release, `leases` table, reveal-on-claim + audit, expiry back to 待认领, clone guidance
- **verification tier:** `tests-green`
- **worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9` (`workflow/issue-9`)
- **finding against the suite:** none

## Files changed

Production only (this role). Did **not** edit `apps/server/src/claim.test.ts` or root `package.json`.

Modified:

- `apps/server/src/agent-keys.ts` — whoami child plugin now calls extracted Bearer hook
- `apps/server/src/app.ts` — `registerClaim`
- `apps/server/src/db.ts` — `leases` DDL + unique active index + schema map
- `apps/server/src/schema.ts` — drizzle `leases`
- `apps/server/src/tasks.ts` — export `taskBrief` / `selectTask`; session GET list/one sweep then re-read
- `apps/server/src/vault.ts` — `insertAuditEvent.actorUserId: number | null`

Added:

- `apps/server/src/agent-bearer.ts` — reusable encapsulated `addAgentBearerHook` (hash + `request.agentAuth` + 401 `WWW-Authenticate: Bearer`)
- `apps/server/src/leases.ts` — TTL 86400, insert/renew/release, check-on-read/write sweep
- `apps/server/src/claim.ts` — Bearer `POST …/claim|progress|release`

Pre-existing in this worktree (tdd-guide custody, not edited here):

- `apps/server/src/claim.test.ts` (untracked)
- `package.json` `"test"` script append of `claim.test.ts`

`git diff --stat` of **this role's** production edits does not include `claim.test.ts`. The worktree `package.json` hunk is tdd-guide's test-script append only (`claim.test.ts` added to the `node --test` list).

## Commands + exit codes

cwd = worktree.

| step | command | exit |
|------|---------|------|
| before | `CI=true node --experimental-strip-types --test apps/server/src/claim.test.ts` | **1** |
| after | same | **0** |
| siblings | `CI=true node --experimental-strip-types --test apps/server/src/tasks.test.ts apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts` | **0** |
| typecheck | `pnpm --filter @kaola/server typecheck` (`tsc --noEmit -p tsconfig.json`) | **0** |
| eslint | `pnpm exec eslint` on the nine production files listed above | **0** |

## Before / after counts

- **claim.test.ts before:** tests 27, pass 0, fail 27
- **claim.test.ts after:** tests 27, pass 27, fail 0
- **siblings after:** tests 94, pass 94, fail 0 (tasks + agent-keys + vault)

## Beyond-suite changes (with evidence)

1. **`insertAuditEvent` actor widened to `number | null`.** Required so expiry can persist SQL NULL; existing callers still pass `number`. `vault.test.ts` not edited; suite stayed  green.
2. **Bearer hook extracted** to `agent-bearer.ts` and reused by whoami + claim plugins (no `fastify-plugin`). `agent-keys.test.ts` stayed green (same 401 oracle).
3. **Partial unique index** `leases_one_active_per_task` on `leases(task_id) WHERE state = 'active'`. Suite only asserts “at most one active after HTTP”; the index encodes that invariant in SQLite. No FOREIGN KEY.
4. **`leases.id` INTEGER PRIMARY KEY AUTOINCREMENT** — not selected by the suite; matches other tables so heartbeat can UPDATE by row id.
5. **Exported `taskBrief` / `selectTask` / `TaskWithPoster`** from `tasks.ts` for claim serialization. Poster PATCH still uses `POSTER_TRANSITIONS` only (`待认领 → 进行中` remains 409) — confirmed by tasks.test.ts “is claim territory, not a poster edit”.

## Unpinned choices (tests did not specify)

1. **Holder identity** for progress/release 403: `leases.claimer_user_id === agentAuth.user.id` (not `agent_key_id`). A second key of the same user can heartbeat/release; a different user cannot.
2. **Pending 403 runs before task lookup** (and before decrypt). Pending + unknown `publicId` would be 403, not 404 (untested).
3. **Claim event order:** `token 揭示` then `状态迁移` (orchestrator left order unpinned).
4. **Sweep is global** (every `active` lease with `expires_at <= now`), not scoped to the requested `publicId`.
5. **Progress/release do not re-check `users.status === '待批准'`** — only claim does (the pending test is claim-only).
6. **Non-string `note` / `reason`:** treated as omitted (`note` → `''`; `reason` key omitted).
7. **Decrypt only after status gates** so 409 conflict / illegal_transition never call `decryptToken`.
8. **Chinese literals** (`PENDING_CLAIM_MESSAGE`, illegal-transition template) duplicated in `claim.ts` rather than exporting from `auth.ts` / `tasks.ts`.
