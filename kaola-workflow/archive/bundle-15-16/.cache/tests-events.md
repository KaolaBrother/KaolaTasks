# Test handoff — issue #15 (audit log HTTP + team stats)

Role: tdd-guide. Custody of tests only — no production code touched.

## Baseline

- Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16`
- Branch: `workflow/bundle-15-16`
- Baseline SHA (`git rev-parse HEAD` in the worktree, unchanged by this run): `637c3041f7e20513929b7230bd7d394e77ffc1a1`
- `pnpm install` was run in the worktree to materialize `node_modules` (was missing — `@fastify/static` etc unresolved); this is a harness step, no source file changed by it.
- Full RED output: `kaola-workflow/bundle-15-16/.cache/tests-events-baseline.txt`

## Files written

1. `apps/server/src/events.test.ts` (new) — `node --experimental-strip-types --test`. 9 tests, 9 failing on HEAD, 0 passing.
2. `apps/web/src/App.audit.test.ts` (new) — vitest + `@vue/test-utils`. 16 tests, 16 failing on HEAD, 0 passing.
3. Root `package.json` `test` script — appended `apps/server/src/events.test.ts` immediately after `apps/server/src/writeback.test.ts` (explicit path, no glob). One-line diff, no other reformatting. Web vitest already globs `src/**/*.test.ts` (`apps/web/vite.config.ts`), so `App.audit.test.ts` needs no script change.

Not touched (confirmed via `git status --porcelain=v1`): no production file, no `claim.test.ts`/`mcp.test.ts`/`App.board.test.ts`/`App.form.test.ts`, no `apps/web/package.json`. `apps/server/src/claim-confirm.test.ts` and `apps/web/src/App.settings.test.ts` already exist untracked in the worktree (the sibling #16 tdd-guide's files) — left untouched.

## What each test pins

### `apps/server/src/events.test.ts`

Seams copied from `claim.test.ts` (OAuth/session/agent-key/buildApp scaffolding, secret-key scan idiom) — not imported.

- **`describe('authentication — session cookie, same mechanism as GET /api/v1/tasks')`**
  - unauthenticated `GET /api/v1/events` and `GET /api/v1/stats` → 401 `{ error: 'unauthorized' }`.
  - a 待批准 GitHub login → 401 on both (per ruling: different from `GET /api/v1/tasks`, which lets 待批准 read; events/stats explicitly gate them out).
  - an approved GitHub `claim_only` user → 200 on both.
- **`describe('GET /api/v1/events')`**
  - envelope is exactly `{ events: EventRow[] }`; each row's keys are exactly `actor_user_id, actor_username, created_at, details, id, type`; `created_at` matches the ISO-8601 regex used for task briefs; `details` is a parsed object (fails if the route ever re-serializes JSON as a string); rows are newest-first (`id` strictly descending).
  - a real claim (drives `token 揭示` + `状态迁移` 待认领→进行中) + a real `progress` call (drives `心跳`) appear with `actor_username` resolved to the poster's username via left-join, and exact `details` shapes matching `claim.ts`'s known write shapes. Also asserts the secret-key scan (no `token`/`token_encrypted`/`inline_token_encrypted`/`access_token` key, no fixture plaintext) on this response.
  - a system row (`actor_user_id: null`, seeded via raw SQL `INSERT INTO events`) still appears, with `actor_username: null`.
- **`describe('GET /api/v1/stats')`**
  - empty DB → `{ completed_count: 0, completed_by_username: {} }`.
  - seeds (via raw SQL) 2 null-actor `状态迁移`→`已完成` rows, 1 rows for user "alice", and deliberately-non-counting noise (a `进行中→待验收` transition and a `心跳`, both attributed to "bob"). Asserts `completed_count === 3`, `completed_by_username === { 系统: 2, <alice's username>: 1 }`, and that bob (present in `users` but with zero completions) is absent from the map (`Object.hasOwn` false).
  - **near-miss pin**: forces a task's `status` column to `已完成` via raw SQL with **no** matching event, then asserts stats stay at `{ completed_count: 0, completed_by_username: {} }` — this is the test that would catch an implementation that (wrongly) does `SELECT COUNT(*) FROM tasks WHERE status='已完成'` instead of counting `events`.

### `apps/web/src/App.audit.test.ts`

Seams copied from `App.board.test.ts` (fetch stub router, `mount`/`vi.waitFor`/`settle`, `data-testid` DOM helpers, `NSelect` helpers) — not imported.

- Visibility: `full` and `claim_only` both see `audit-section` + `stats-section`; 待批准 and unauthenticated see neither, and never call `/api/v1/events` or `/api/v1/stats`.
- Fetch contract: both URLs are called exactly once, with no query string, `credentials: 'include'`, `Accept: application/json`; applying filters afterward does **not** trigger a second fetch of either URL (filters are client-side).
- Combinable AND filters over a 7-row fixture spanning every live `type` literal (`token 揭示`/`状态迁移`/`心跳`/`变更`/`回写`/`认领待确认`/`认领已确认`): type-only, actor-only (including a `系统` selection for null-actor rows), task-only, a time `[from, to]` window, and a two-dimension AND narrowing (actor + type) that provably shrinks the visible `audit-row` count in two steps.
- `audit-filter-type` options include all 7 live literals; `audit-filter-actor` options include `系统` and the real usernames present in the fixture.
- `团队统计`: `stats-completed-count` shows the stub's `completed_count`; the section's text also carries every key of `completed_by_username` (including `系统`) — no dedicated per-user `data-testid` exists (not in the pinned contract), so this is a broad text-contains check, not a structural one.
- Chinese-copy check (`审计日志`/`团队统计` present, no English `Audit`/`Stats`/`Timeline`) and an explicit check that `$router` is `undefined` after mount (no vue-router).

## RED failure signature

- **Server**: every one of the 9 tests fails with the same class of error — `getEvents`/`getStats` inject calls return `404 { error: 'Not Found', message: 'Route GET:/api/v1/events not found' }` (or `/api/v1/stats`) instead of the expected `200`/`401`. Two tests (`list carries real writers rows...`, `system-driven rows...`) fail one step later with `TypeError: Cannot read properties of undefined (reading 'filter')` in the `rowsForTask` helper, because `jsonBody(res).events` is `undefined` on a 404 body — same root cause, different assertion line. This is expected and correct: verified by grep that no `app.get('/api/v1/events'...)` or `/api/v1/stats` route exists anywhere in `apps/server/src` today.
- **Web**: every one of the 16 tests fails with the same signature — `vi.waitFor(...)` inside `mountMember` times out after 2000ms because `App.vue`'s `onMounted` never calls `fetch('/api/v1/events', ...)` or `fetch('/api/v1/stats', ...)` (no such call exists in `App.vue` today), so `calls.some((call) => call.url === '/api/v1/events')` stays `false` until the helper's `expect(...).toBe(true)` throws inside the `vi.waitFor` retry loop.
- Full transcript: `kaola-workflow/bundle-15-16/.cache/tests-events-baseline.txt`.

## Judgement calls made that were NOT explicit in the rulings

The rulings and ground-truth cover the wire contract and acceptance bullets in detail, but leave a few implementation-shape choices to whoever writes the test oracle. Recorded here per instructions (none of these change the pinned wire contract, HTTP semantics, event vocabulary, or `data-testid` names — they only fix DOM/data shapes the ruling left open):

1. **Non-null-actor `已完成` completion events don't exist in production.** Ground truth explicitly verified that the *only* real writer of a `状态迁移`→`已完成` event is `poller.ts`'s `applyPrTerminalTransition`, and it *always* passes `actorUserId: null`. The ruling only explicitly authorizes "SQL/helper inserts for a null-actor completion event." To pin the `completed_by_username` per-user grouping acceptance bullet at all, I also seeded a **non-null-actor** completion via the same raw-SQL helper (there is no other way to produce one against current code). This is a mechanical extension of an already-authorized technique, not a new interpretation of the wire contract.
2. **`audit-filter-actor` and `audit-filter-type` are `NSelect` components; `audit-filter-task`/`audit-filter-from`/`audit-filter-to` are plain text inputs (`n-input`).** The ruling names the four filter dimensions and their `data-testid`s but not their widget type. I followed the closest existing precedent: `board-filter-status`/`board-filter-tag`/`board-filter-forge` are all `NSelect` with dynamically- or statically-built option lists, which matches "类型" (fixed enum) and "人" (dynamic, needs a `系统` sentinel) well. For "任务" (free-text public id) and "时间" (from/to), the codebase has no date-picker precedent anywhere, so I chose plain text inputs, tested via the same `fieldElement`/`setValue` idiom `App.form.test.ts` already uses for `n-input`. If the implementer instead reaches for `NDatePicker` for from/to, this test file's `setField` helper for those two fields would need adjusting (not a wire-contract change).
3. **The literal value used to select "empty actor" in `audit-filter-actor` is `系统`.** The ruling's phrase is "include a way to pick 系统/empty actor," and `系统` is already the pinned label for null-actor rows in `completed_by_username` — I reused the same literal for the filter's selectable value rather than inventing a second sentinel (e.g. an empty string, which is already reserved for "全部" per the board's existing `{ label: '全部', value: '' }` convention).
4. **Stats section per-user breakdown has no dedicated `data-testid`.** The pinned contract only names `stats-section` and `stats-completed-count`. My test for "展示 completed_count 与按用户名（含「系统」）的分布" therefore does a broad `textOf(wrapper, 'stats-section')`-contains check for each username/`系统` rather than asserting a specific per-row structure — intentionally the weakest assertion that still pins the acceptance bullet ("per-user breakdown from completed_by_username" must render).

None of these touch the parts of the ruling that were unambiguous (route paths, response envelope keys, event type vocabulary, `data-testid` names that were given, the 401/200 permission matrix, the near-miss stats definition). Flagging for the implementer/orchestrator in case a different widget choice is preferred — the test file would need small (not structural) edits to `setField`/`setSelect` call sites in that case, not to any assertion about behavior.

## Return summary

- Handoff: `kaola-workflow/bundle-15-16/.cache/tests-events.md` (this file)
- Baseline SHA: `637c3041f7e20513929b7230bd7d394e77ffc1a1`
- Server (`events.test.ts`): 9 fail / 0 pass
- Web (`App.audit.test.ts`): 16 fail / 0 pass
- No test passed on HEAD before implementation — oracle is not defective.
