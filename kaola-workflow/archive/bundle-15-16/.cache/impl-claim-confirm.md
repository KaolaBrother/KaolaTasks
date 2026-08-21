# implementer handoff — issue #16 claim-confirmation for autonomous polling agents

Role: implementer (standard / sonnet tier). Custody: production code only. Read but never edited
any `*.test.ts` file.

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16`
Branch: `workflow/bundle-15-16`

## Verification tier: **tests-green**

All commands below were run from the worktree root, against the tests authored by tdd-guide
(`apps/server/src/claim-confirm.test.ts`, `apps/web/src/App.settings.test.ts`), plus the full
regression surface named in the task. None of the test files were modified.

## Oracle followed

`kaola-workflow/bundle-15-16/.cache/orchestrator-rulings.md` §"#16" (comment overrides body:
instructed claims stay 认领即授权; the gate is autonomous-poll only) +
`kaola-workflow/bundle-15-16/.cache/tests-claim-confirm.md` (tdd-guide handoff, read before
implementing). No ambiguity required stopping — every RED failure had a concrete, already-tested
shape to satisfy, and all 14 `claim-confirm.test.ts` tests plus all 8 `App.settings.test.ts` tests
passed against the implementation below without any test edits.

## Files changed

1. **`apps/server/src/schema.ts`** — added `users.trustedAutomation` (`integer(..., {mode:
   'boolean'})`, default `false`) and a new `claimConfirmations` sqlite table (`id, taskId
   (tasks.id PK), userId, agentKeyId, state ('pending'|'approved'|'rejected'), createdAt`) with
   its inferred `ClaimConfirmation` type.
2. **`apps/server/src/db.ts`** — added `trusted_automation INTEGER NOT NULL DEFAULT 0` to
   `USERS_DDL`; added a guarded `ALTER TABLE users ADD COLUMN trusted_automation …` run after
   `CREATE TABLE IF NOT EXISTS users` so a pre-existing file-backed sqlite DB (no such column yet)
   still migrates — duplicate-column errors are caught and ignored. Added
   `CREATE TABLE IF NOT EXISTS claim_confirmations` DDL exactly matching the oracle's column list,
   and wired the new `claimConfirmations` Drizzle table into `createDb`'s schema map.
3. **`apps/server/src/claim-confirmations.ts`** (new) — the confirmation-row helpers shared by
   `claim.ts` (`findClaimConfirmations`, `insertPendingConfirmation`,
   `consumeApprovedConfirmation` — deletes the row so a stale approval can never match twice,
   `recordPendingConfirmEvent`, `pendingConfirmationBody`) plus `registerClaimConfirmations`,
   which adds the three session-only routes:
   - `GET /api/v1/claim-confirmations` → `{ confirmations: [{ id, task_id (public id, via a join
     on `tasks`), state, created_at (ISO) }] }`, scoped to `claimConfirmations.userId ===
     session.user.id`.
   - `POST /api/v1/claim-confirmations/:id/approve` → owner-only 200, flips `state` to
     `'approved'`, writes `认领已确认` `{ task_id, agent_key_id }`; does not touch leases/token/task
     status. 404 for another user's id or a non-numeric id.
   - `POST /api/v1/claim-confirmations/:id/reject` → owner-only 200, flips `state` to
     `'rejected'`. 404 for another user's id.
   - All three gate through `requireActiveSessionUser`, which answers 401 (via the existing
     `sendUnauthorized` seam) both when there is no session and when the session's user is still
     `待批准` — matching the ruling's "待批准 cannot hit these (401)".
4. **`apps/server/src/claim.ts`** — `claimTask` gained an optional 4th parameter `autonomous?:
   boolean`. The existing `待批准` 403 and the task-lookup/409 checks stay exactly first and
   unchanged. A new branch, only entered when `autonomous === true && !auth.user.trustedAutomation`
   (placed after the 409 checks, before the decrypt/lease/reveal code):
   - reuses an existing `pending` row verbatim (202, no new insert) — the idempotent-replay case;
   - consumes (deletes) an existing `approved` row and falls through into the untouched
     decrypt→lease→`token 揭示`→`状态迁移`→201 code path;
   - otherwise inserts a fresh `pending` row, writes `认领待确认` `{ task_id, agent_key_id }`, and
     returns 202 `{ error: 'confirmation_required', message, pending: true }` — no `token` key,
     no lease, no status flip, no `token 揭示`.
   Instructed claims (`autonomous` not `true`, including the default `undefined` from a bodyless
   request) skip this branch entirely and ignore any leftover `claim_confirmations` row (ruling's
   pinned "ignores a leftover rejected row" case). `registerClaim`'s REST handler now parses an
   optional `{ autonomous?: boolean }` JSON body via a new `readAutonomous()` (missing/invalid
   body ⇒ `undefined` ⇒ instructed) and forwards it as the 4th argument.
5. **`apps/server/src/mcp.ts`** — `claim_task`'s `inputSchema` gained
   `autonomous: z.boolean().optional()` (required keys unchanged — still just `task_id`), and its
   handler forwards `args.autonomous` to `claimTask`. `toToolResult` was not touched: the pending
   result's `{ ok: true, httpStatus: 202, body: { pending: true, error: 'confirmation_required',
   … } }` shape already produces `isError` false with `structuredContent.pending === true` under
   the existing mapping.
6. **`apps/server/src/auth.ts`** — `publicUser()` now includes `trusted_automation: boolean` on
   every `GET /api/v1/me` response (mapped from `user.trustedAutomation`, so a legacy row without
   the column reads `false`). Added `PUT /api/v1/me/settings`: session-only, 401 for no
   session or a `待批准` session (same rationale as claim-confirmations), 400 `invalid_body` for a
   non-boolean `trusted_automation`, otherwise persists via `db.update(users)` and replies exactly
   `{ trusted_automation }`.
7. **`apps/server/src/app.ts`** — imports and calls `registerClaimConfirmations(app, db)` next to
   the other `registerX` hooks (after `registerClaim`, before `registerEvents`).
8. **`apps/web/src/App.vue`** — additive only; the #15 审计日志/团队统计 sections were left
   untouched.
   - `Me` type gained `trusted_automation?: boolean`; new `ClaimConfirmationRow` type.
   - New refs `trustedAutomation` (boolean, default `false`) and `claimConfirmations`
     (`ClaimConfirmationRow[]`).
   - `onMounted` sets `trustedAutomation` from `me.value?.trusted_automation === true` right after
     the `/api/v1/me` fetch, and — gated by the existing `canManageKeys` computed (`status ===
     'active'`, so both `full` and `claim_only`) alongside the Agent Key list — calls a new
     `loadClaimConfirmations()`.
   - New functions `setTrustedAutomation` (PUTs `/api/v1/me/settings`, updates the ref only from
     the server's returned value), `loadClaimConfirmations`, `approveClaimConfirmation`,
     `rejectClaimConfirmation` (POST the corresponding route, then refetch the list on success).
     All four swallow fetch/network failures (try/catch + `if (!res.ok) return`), matching the
     existing `loadEvents`/`loadStats` convention so `App.board.test.ts`/`App.form.test.ts`
     (which never stub `/api/v1/me/settings` or `/api/v1/claim-confirmations`) and
     `App.audit.test.ts` (which never stubs those two either) keep passing unmodified.
   - New template block (受信自动化 + 待确认认领), inserted right before the existing `Agent Key`
     divider, gated by `v-if="canManageKeys"` exactly like that widget: an `n-switch`
     `data-testid="trusted-automation-toggle"` driven by `:value` / `@update:value` (not
     `v-model`, so the displayed value only ever reflects what the server confirmed), and a
     `div data-testid="claim-confirmation-list"` that always renders (even when the list is
     empty) with one row per confirmation and per-row `claim-confirmation-approve` /
     `claim-confirmation-reject` buttons.

## Commands + exit codes

All run from `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16`.

```
$ node --experimental-strip-types --test apps/server/src/claim-confirm.test.ts
ℹ tests 14 / pass 14 / fail 0                                          exit 0

$ node --experimental-strip-types --test apps/server/src/claim.test.ts apps/server/src/mcp.test.ts apps/server/src/auth.test.ts apps/server/src/events.test.ts
ℹ tests 70 / pass 70 / fail 0                                          exit 0

$ pnpm --filter @kaola/web exec vitest run src/App.settings.test.ts src/App.audit.test.ts src/App.board.test.ts src/App.form.test.ts
Test Files 4 passed (4) / Tests 75 passed (75)                          exit 0

$ pnpm lint            # eslint .                                       exit 0
$ pnpm test            # full repo suite (node --test × 502 + vitest × 75)
ℹ tests 502 / pass 502 / fail 0   +   Test Files 4 passed / Tests 75 passed   exit 0
```

## Before / after

- **Before**: `claim_confirmations` table and `users.trusted_automation` did not exist;
  `claimTask` had no autonomous branch and always returned 201+token regardless of any
  `autonomous` flag; `claim_task`'s MCP schema had no `autonomous` key; `GET /api/v1/me` had no
  `trusted_automation` field; no `/api/v1/me/settings` or `/api/v1/claim-confirmations*` routes
  existed; `App.vue` had no 受信自动化/待确认认领 UI. 11 of 14 `claim-confirm.test.ts` tests and
  all 8 `App.settings.test.ts` tests were RED (per `tests-claim-confirm.md`'s captured baseline).
- **After**: all 14 + 8 tests pass; the full pre-existing suite (`claim.test.ts`, `mcp.test.ts`,
  `auth.test.ts`, `events.test.ts`, plus every other suite in `pnpm test`, plus
  `App.board.test.ts`/`App.form.test.ts`/`App.audit.test.ts`) is unaffected — 502 node tests + 75
  web tests, all green, `pnpm lint` clean.

## Findings (not fixed — out of my custody / out of scope)

- `pnpm typecheck` fails on **`apps/web/src/App.audit.test.ts`** (lines 275 and 430) with two
  pre-existing `vue-tsc` type errors (an `NSelect` filter-option-typing mismatch, and a `stats`
  fixture object narrowed to a specific `completed_by_username` key set that a later empty-object
  assignment doesn't satisfy). Verified this is **not** caused by my change: `git stash` (leaving
  the untracked `App.audit.test.ts` in place) reproduces the identical two errors against the
  pre-#16 production code. This is a defect in a test file authored by the #15 tdd-guide, which I
  must not edit per role custody; `pnpm typecheck` was also not in this task's required "Verify"
  command list. Reporting it here rather than silently ignoring it, per instructions to report a
  test defect rather than route around it.
