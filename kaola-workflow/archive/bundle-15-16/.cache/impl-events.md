# Implementation proof — issue #15 (audit log HTTP + team stats)

Role: implementer. Custody of production code only — no test file touched.

## Task

Implement session-auth `GET /api/v1/events` and `GET /api/v1/stats`, plus Chinese 审计日志 / 团队统计
sections in `App.vue`, per `kaola-workflow/bundle-15-16/.cache/orchestrator-rulings.md` §15 and
`kaola-workflow/bundle-15-16/.cache/tests-events.md`.

## Verification tier

`tests-green` — judged by running the pinned test oracles (`apps/server/src/events.test.ts`,
`apps/web/src/App.audit.test.ts`) plus the sibling web suites that share `App.vue`
(`App.board.test.ts`, `App.form.test.ts`) and the full server suite (mcp.test.ts included) as a
regression check.

## Files changed

- `apps/server/src/events.ts` (new) — `registerEvents(app, db)`: session-cookie auth via
  `getSessionUser`/`sendUnauthorized` (same seam as `tasks.ts`); `待批准` → 401 on both routes
  (stricter than the board); `GET /api/v1/events` returns `{ events: EventRow[] }` newest-first
  (`id` desc), left-joining `users` for `actor_username`, `created_at` via
  `new Date(createdAt * 1000).toISOString()`, `details` via `JSON.parse` (falls back to `{}` on
  parse failure or non-object); `GET /api/v1/stats` returns exactly
  `{ completed_count, completed_by_username }`, counting `events` rows with
  `type === '状态迁移'` and parsed `details.to === '已完成'`, grouped by `actor_username`
  (`"系统"` when `actor_user_id` is null), zero-count users omitted.
- `apps/server/src/app.ts` — import + call `registerEvents(app, db)` next to the other
  `registerX` hooks (after `registerClaim`, before `registerMcp`).
- `apps/web/src/App.vue` — added 审计日志 (`audit-section`) and 团队统计 (`stats-section`) blocks
  to the member workbench (visible to `full` and `claim_only`, hidden on login/pending, same
  `view === 'member'` gate as the board):
  - New types `EventRow`, `StatsBody`; refs `auditEvents`, `auditFilterType`, `auditFilterActor`,
    `auditFilterTask`, `auditFilterFrom`, `auditFilterTo`, `stats`.
  - `loadEvents()`/`loadStats()` — fetch `/api/v1/events` / `/api/v1/stats` (no query,
    `credentials: 'include'`, `Accept: application/json`), swallow non-ok/failed responses via
    try/catch + `if (!res.ok) return` (same idiom as `loadTasks`/`loadProfiles`), called from
    `onMounted` right after `loadTasks()` inside the existing `if (view.value === 'member')`
    branch.
  - `auditTypeFilterOptions` (全部 + the 7 live type literals), `auditActorFilterOptions` (全部 +
    系统 + usernames present in loaded events), `filteredAuditEvents` (AND-combined client-side
    filter over type / actor (系统 sentinel for null actor) / `details.task_id` / inclusive
    `created_at` `[from, to]` window) — no refetch on filter change.
  - `statsByUsername` computed from `completed_by_username` for per-user rendering.
  - Template: `NSelect` for 类型/人, `n-input` for 任务/时间-from/时间-to, `audit-row` repeated
    div per filtered event, `stats-completed-count` text node, per-user stats lines including
    `系统`. Chinese-only copy (no `Audit`/`Stats`/`Timeline`).

Not touched: `claim.ts`, `mcp.ts`, `docs/DESIGN.md`, any `*.test.ts` file, `apps/server/src/schema.ts`,
root `package.json` (already carried the `events.test.ts` append from tdd-guide).

## Commands + exit codes

All run from `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16`.

1. `node --experimental-strip-types --test apps/server/src/events.test.ts`
   → exit 0, **9/9 pass** (0 fail).
2. `pnpm --filter @kaola/web exec vitest run src/App.audit.test.ts src/App.board.test.ts src/App.form.test.ts`
   → exit 0, **67/67 pass** (3 files: 16 + 25 + 26, 0 fail).
3. `pnpm --filter @kaola/web exec vitest run src/App.audit.test.ts --reporter=verbose`
   → exit 0, **16/16 pass** (isolated confirmation of the #15 web oracle alone).
4. Full server regression (`shared`/`forge-adapters`/`placeholder`/`auth`/`agent-keys`/`vault`/
   `tasks`/`hosting`/`claim`/`events`/`mcp` test files via
   `node --experimental-strip-types --test ...`) → exit 0, **306/306 pass**, confirming
   `registerEvents` wiring did not regress `claim.test.ts` or `mcp.test.ts` (#16's suites, not in
   scope for this task, were not run — `claim-confirm.test.ts` and `App.settings.test.ts` are
   correctly still RED per the task brief and were left untouched).

## Before / after

- Before: `GET /api/v1/events` and `GET /api/v1/stats` did not exist (404 `Route ... not found`);
  no 审计日志/团队统计 UI in `App.vue`. `events.test.ts` 9 fail / 0 pass; `App.audit.test.ts` 16
  fail / 0 pass (per `tests-events.md` baseline).
- After: both routes implemented and registered; both UI sections implemented with combinable
  client-side filters. `events.test.ts` 9/9 pass; `App.audit.test.ts` 16/16 pass;
  `App.board.test.ts` and `App.form.test.ts` stayed green (67/67 across the three web files
  together); full server suite 306/306 pass.

## Return summary

- Proof: `kaola-workflow/bundle-15-16/.cache/impl-events.md` (this file)
- Files changed: `apps/server/src/events.ts` (new), `apps/server/src/app.ts`, `apps/web/src/App.vue`
- `events.test.ts`: 9/9 pass
- `App.audit.test.ts`: 16/16 pass
- `App.board.test.ts` / `App.form.test.ts`: stayed green (67/67 combined with `App.audit.test.ts`)
- No test file edited; no findings to report — everything in scope for #15 passed.
