# implementer handoff — issue #14 (status write-back to source issues)

## Role & custody

I am `implementer` for issue #14. I wrote production code only: read the two authored test
files, ran them, iterated against them; touched no `*.test.ts` file, `docs/DESIGN.md`, the REST
`submit_pr` route, the audit-log UI (#15), claim-confirmation (#16), or any new queue/job table /
tasks column.

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14`
Baseline HEAD (unchanged by me): `a722c8b`

## Verification tier: **tests-green**

- The two authored suites (`comment-on-issue.shared.test.ts` 19 tests, `writeback.test.ts` 15
  tests) both pass in full.
- The full repo `pnpm test` (all node:test files + `@kaola/web` vitest) passes in full: 479
  node:test tests / 0 fail, 51 web tests / 0 fail — no regression to any pre-existing test.
- `pnpm typecheck` passes across all 4 workspace projects with typecheck scripts
  (`apps/web`, `apps/server`, `packages/forge-adapters`, `packages/shared`).
- `pnpm lint` (`eslint .`) passes with zero problems.

## Files changed (production only)

1. `packages/forge-adapters/src/index.ts`
   - `IssueRef` changed from `unknown` to `{ issue_url: string }`.
   - `createForgeAdapter`'s `commentOnIssue` wiring changed from `notImplemented` to
     `(cred, issueRef, body) => commentOnIssue(kind, options, cred, issueRef, body)`.
   - New `commentOnIssue` function (placed after `importIssue`): resolves the issue via the
     existing `resolveImportedIssue` (host/SSRF rule and unparseable-URL throw reused as-is),
     POSTs `{ body }` via the existing `forgePost` to `${apiUrl}/comments` (github/gitea) or
     `${apiUrl}/notes` (gitlab), throws `Error(\`commentOnIssue: ${kind} responded ${status}\`)`
     on a non-`res.ok` response.
   - `notImplemented()` deleted — no remaining callers after the above rewire.

2. `apps/server/src/writeback.ts` (**new**) — the write-back module:
   - `decryptTaskToken(db, task)` — moved here verbatim (never-throw shape) from `poller.ts`,
     since both the poller's PR-status lookup and write-back's `commentOnIssue` call need the
     task's own forge credential.
   - `attemptWriteback(db, task, transition, actorUserId, prUrl?)` — the non-blocking write-back
     attempt. Gate: `task.sourceType === 'imported' && task.sourceIssueUrl` non-empty (silent
     no-op otherwise — no comment call, no event). Builds a Chinese comment body containing the
     task's `publicId` and the trimmed `PUBLIC_URL` (default `http://localhost:31415`, mirroring
     `auth.ts`'s pattern) — plus `prUrl` for `提交PR`/`完成` — decrypts the task's own credential
     (never the Agent API key), calls `createForgeAdapter(task.repoForge, { baseUrl:
     task.repoBaseUrl }).commentOnIssue(...)`, and on success records exactly one `回写` event
     with `details: { task_id, transition, ok: true, issue_url }`. Every failure (decrypt miss,
     forge throw/non-ok, network failure) is caught and silently swallowed — the caller's own
     transition has already committed and must stay successful.
   - `retryPendingWritebacks(db)` — exported, never rejects. Selects every `sourceType ===
     'imported'` task and, per task, re-attempts any of the three transitions that (a) has
     occurred (认领: a `状态迁移` event to `进行中` exists; 提交PR: a `submissions` row exists;
     完成: `task.status === '已完成'`) and (b) has no existing `回写` event with `ok === true` for
     that `(task_id, transition)`. On retry, `actorUserId` is always `null` (system-driven).

3. `apps/server/src/poller.ts`
   - Removed the local `decryptTaskToken`; now imports it (plus `attemptWriteback`) from
     `writeback.ts`.
   - Added `export { retryPendingWritebacks } from './writeback.ts'` so
     `apps/server/src/poller.ts` exports the retry seam per the task's requirement (tests
     dynamic-import `./poller.ts` and assert `typeof retryPendingWritebacks === 'function'`).
   - `applyPrTerminalTransition` is now `async` (`Promise<void>`): the SQLite transaction is
     unchanged (still fully synchronous, still the sole writer of the status/submission/`状态迁移`
     rows), and only *after* it commits does the function `await attemptWriteback(db, task,
     '完成', null, prUrl)` — and only when `terminal === 'merged'` (never on `closed`/已退回).
   - `pollOneTask` now `await`s `applyPrTerminalTransition`.

4. `apps/server/src/webhook.ts`
   - The webhook handler's call to `applyPrTerminalTransition` is now `await`ed (the handler was
     already `async`); the route still replies `204` in every success path regardless of
     write-back outcome, and the `await` guarantees the test-visible POST is actually attempted
     before the response is asserted.

5. `apps/server/src/app.ts`
   - Imports `retryPendingWritebacks` alongside the existing `pollPendingReviews` import from
     `poller.ts`.
   - The existing `setInterval` (guarded by the pre-existing `polling` in-flight flag) now runs
     `retryPendingWritebacks(db)` sequentially after `pollPendingReviews(db, forgeInstances)` on
     the same tick (via `.then()`), each independently `.catch(() => {})`-guarded so neither can
     ever throw out of the timer callback.

6. `apps/server/src/claim.ts`
   - `claimTask` and `submitPr` are now `async` (`Promise<AgentServiceResult<...>>`).
   - `claimTask`: after the status-transition update, lease insert, and the two existing audit
     events are committed, `await attemptWriteback(db, updated, '认领', auth.user.id)` runs before
     building/returning the response body (so the `201` response and its `token` field are
     unaffected by write-back outcome either way).
   - `submitPr`: same shape — after the status update, `submissions` insert, and `状态迁移` event
     are committed, `await attemptWriteback(db, updated, '提交PR', auth.user.id, prUrl)` runs
     before the return.
   - `registerClaim`'s `POST /api/v1/tasks/:publicId/claim` handler now `await`s `claimTask`.
     `progress`/`release` routes are unchanged (no write-back hook on those per scope).

7. `apps/server/src/mcp.ts`
   - The `claim_task` and `submit_pr` tool handlers now `await` `claimTask`/`submitPr`
     respectively (both are the sole non-REST entry point for `submit_pr`, and MCP's own path for
     `claim_task`).

No other production file was touched. `docs/DESIGN.md`, the audit-log UI, claim-confirmation UI,
and every REST/queue/schema boundary named as forbidden were left untouched — confirmed by
`git status --short` in the worktree, which shows exactly: `app.ts`, `claim.ts`, `mcp.ts`,
`poller.ts`, `webhook.ts` (modified), `packages/forge-adapters/src/index.ts` (modified),
`package.json` (pre-existing tdd-guide diff, untouched by me), and three new files
(`writeback.ts`, plus the two test files that were already present from `tdd-guide` and remain
byte-for-byte unmodified by me).

## Commands run + exit codes

1. `node --experimental-strip-types --test packages/forge-adapters/src/comment-on-issue.shared.test.ts`
   → **exit 0**, 19/19 pass (confirmed both before my adapter change — RED, matching the
   orchestrator's/tdd-guide's measured baseline — and after — GREEN).
2. `node --experimental-strip-types --test apps/server/src/writeback.test.ts`
   → **exit 0**, 15/15 pass (after the server-side changes; RED baseline already established by
   `tdd-guide`'s handoff: 6 pass / 9 fail pre-implementation).
3. `CI=true pnpm test` (root, worktree) → **exit 0**. Node:test summary: `tests 479 / pass 479 /
   fail 0`. Vitest (`@kaola/web`) summary: `Test Files 2 passed (2)` / `Tests 51 passed (51)`.
4. `pnpm typecheck` → **exit 0** across `apps/web`, `apps/server`, `packages/forge-adapters`,
   `packages/shared`.
5. `pnpm lint` (`eslint .`) → **exit 0**, no output (zero problems).

## Before / after

- **Before** (HEAD `a722c8b`, per the tdd-guide handoff and re-confirmed by me before editing):
  `comment-on-issue.shared.test.ts` 19 fail / `writeback.test.ts` 6 pass + 9 fail. Full suite:
  451 pass / 28 fail.
- **After** (this implementation): `comment-on-issue.shared.test.ts` 19/19 pass;
  `writeback.test.ts` 15/15 pass. Full suite: 479/479 node:test pass, 51/51 web tests pass — the
  exact 28 prior failures are now green and zero pre-existing test regressed.

## Remaining failures

None. All authored tests pass; the full pre-existing suite (claim/mcp/poller/webhook/tasks/
auth/vault/hosting/agent-keys/import/placeholder + shared + forge-adapters + web) is unchanged
and green.

## Notes / judgment calls (all within the rulings' stated latitude)

- Chose not to write a `回写` `ok: false` failure record on write-back failure (the rulings say
  failures *may* record `ok: false`, not that they must). Retry eligibility is derived instead
  from the underlying transition markers (`状态迁移`→进行中, a `submissions` row, `status ===
  已完成`) exactly as the ruling specifies, so this omission does not affect retry correctness and
  keeps the write path simpler with no risk of ever leaking token material through a second event
  shape.
- `retryPendingWritebacks`' 完成/提交PR retry picks the *latest* `submissions` row
  (`orderBy(desc(id))`) for the task's `pr_url`, since in every real lifecycle there is at most
  one relevant submission per completed transition; this matches (and is exercised by) the
  authored retry tests.
- `latestSubmission` remains defined in `poller.ts` (webhook.ts already imports it from there);
  only `decryptTaskToken` was moved into `writeback.ts`, per the task's explicit allowance,
  avoiding a poller↔writeback import cycle (writeback.ts imports nothing from poller.ts).
