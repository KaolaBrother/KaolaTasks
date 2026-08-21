# tdd-guide handoff — issue #14 (status write-back to source issues)

## Role & custody

I am `tdd-guide` for issue #14. I authored tests only; I wrote **no production code**. Custody
boundary respected: only test files + the root `package.json` `scripts.test` line were touched.

## Files written (all in the worktree, all "Allowed writes")

1. `packages/forge-adapters/src/comment-on-issue.shared.test.ts` (new) — adapter-level shared spec
   for `commentOnIssue`, parameterized over `github`/`gitlab`/`gitea`.
2. `apps/server/src/writeback.test.ts` (new) — server-level spec for the three write-back hooks
   (认领 / 提交PR / 完成) plus `retryPendingWritebacks`.
3. `package.json` — appended both new node:test paths to `scripts.test`, explicitly (no glob):
   `comment-on-issue.shared.test.ts` grouped with the other `packages/forge-adapters/src/*.shared.test.ts`
   files, and `writeback.test.ts` placed immediately after `webhook.test.ts`, matching the ordering
   instruction exactly.

I also had to run `pnpm install` in the worktree (node_modules was absent — `better-sqlite3` was
unresolvable, causing every test file, not just the new ones, to fail to load). This is a
workspace dependency install, not a change to any tracked file — `git status --short` after
installing shows only the three files above as touched.

## Baseline

- Baseline SHA: **`a722c8b`** (worktree HEAD, unchanged — `chore: archive issue-13 [sink]`, on
  branch `workflow/issue-14`).
- Full RED capture: `kaola-workflow/issue-14/.cache/tests-writeback-baseline.txt`.
- Headline: `comment-on-issue.shared.test.ts` → 19 tests, 0 pass, 19 fail (every case runs its
  body and fails on real behavior, none are load errors). `writeback.test.ts` → 15 tests, 6 pass,
  9 fail (the 6 passes are vacuously-true-today negative-space assertions — "must not comment" /
  "must not block" — that remain required and true once the feature is implemented; the 9
  failures are the actual missing-behavior oracle).
- Harness sanity: ran all 18 non-web node:test files together (matches the appended
  `scripts.test`, minus the `pnpm --filter @kaola/web test` tail) → 479 tests, 451 pass, 28 fail
  (exactly the 19 + 9 above). **Zero pre-existing tests regressed.**
- `pnpm --filter @kaola/forge-adapters typecheck` passes. `pnpm eslint` on both new files: 0
  problems.

## Rulings encoded (from `orchestrator-rulings.md` + `ground-truth.md` + `forge-comment-apis.md`)

**Adapter (`comment-on-issue.shared.test.ts`)**
- `commentOnIssue(cred, { issue_url }, body)` per kind: GitHub `POST
  https://api.github.com/repos/{owner}/{repo}/issues/{n}/comments` (Bearer, always api.github.com
  regardless of constructor `baseUrl` or the pasted host); GitLab `POST
  {baseUrl}/api/v4/projects/{encodeURIComponent(namespace)}/issues/{iid}/notes` (PRIVATE-TOKEN);
  Gitea `POST {baseUrl}/api/v1/repos/{owner}/{repo}/issues/{n}/comments` (`Authorization: token`).
  JSON body `{ body }` for all three (confirmed field name from `forge-comment-apis.md`).
- Success = `res.ok`, not a hard-coded 201 (explicit GitLab exception — no status table on the
  vendor page — pinned with a dedicated "any 2xx" test).
- Non-ok → `Error("commentOnIssue: ${kind} responded ${status}")`.
- Unparseable `issue_url` (including a pull/MR path) → rejects **before** calling fetch, and the
  rejection is asserted to **not** be the `'not implemented'` placeholder — every "rejects" test
  in the file uses a predicate function (`assertNotPlaceholder`) rather than a bare
  `assert.rejects`/`assert.throws`, per the explicit trap called out in the rulings and mirrored
  from `webhook.shared.test.ts`'s convention.
- SSRF: gitlab/gitea always use the constructor `baseUrl`, never the pasted URL's host — asserted
  with an "other-host.test" tripwire URL, same pattern as `import-issue.shared.test.ts`.
- Helpers (fetch stub, URL builders, auth-header assertions) are **copied and trimmed**, not
  imported, from `import-issue.shared.test.ts` — per this project's one-shared-spec-per-file
  convention. Header comment pins HEAD `a722c8b`'s exact stub behavior, mirroring
  `webhook.shared.test.ts`'s convention.

**Server (`writeback.test.ts`)**
- Gate: only `sourceType === 'imported'` tasks ever trigger a comment POST; native tasks never do,
  at any of the three hooks (one dedicated native-claim test + one full-lifecycle
  claim+submit+complete native test asserting zero comment POSTs and zero `回写` events).
- 认领 driven via the real REST `POST /api/v1/tasks/:publicId/claim` (covers `claimTask`, shared by
  REST+MCP). 提交PR driven via the real MCP `submit_pr` tool call (the only entry point — no REST
  route exists, confirmed in `ground-truth.md`). 完成 driven twice — once via
  `pollPendingReviews(db)` directly, once via a real signed webhook delivery to
  `POST /api/v1/webhooks/:publicId` with a `merged: true` payload — both routes share
  `applyPrTerminalTransition`.
- 已退回 (`terminal: 'closed'`) is asserted to **never** add a completion comment, even though it
  shares the same `applyPrTerminalTransition` function as 已完成.
- Non-blocking: for each of the three hooks, a forge 5xx or thrown/unreachable fetch on the
  comment POST is asserted to **never** fail the surrounding operation (claim still 201 with
  `token`; `submit_pr` still succeeds; completion still reaches 已完成) and to leave **no
  successful** `回写` event recorded.
- Success shape: a successful write-back records exactly one `回写` event whose `details` is
  `{ task_id, transition, ok: true, issue_url }` (exact key set asserted via
  `Object.keys(...).sort()`) — `transition` is `'认领'` / `'提交PR'` / `'完成'` per the ruling's
  literal spelling.
- `actorUserId`: 认领/提交PR write-backs assert `actor_user_id === poster.body.id` (the acting
  user, same as the underlying `claimTask`/`submitPr` audit events); 完成 (poller- and
  webhook-driven) and retry-driven write-backs assert `actor_user_id === null`
  (system-driven), per the ruling's explicit split.
- Credential: the comment POST's `Authorization`/`PRIVATE-TOKEN` header is asserted to equal the
  **task's own inline credential**, and explicitly asserted to **not** contain the Agent API key
  used to authenticate the claim/submit_pr call itself (`req.headers.get('authorization')?.includes(key.token) === false`).
- Token hygiene: every test that touches an inline token asserts
  `JSON.stringify(eventRows(db)).includes(<token>) === false`.
- Comment body content: asserted to contain the task's `publicId` and the exact `PUBLIC_URL`
  origin (`http://localhost:3000`, matching `poller.test.ts`'s convention) on every transition, and
  additionally the submitted/merged `pr_url` on 提交PR and 完成. No specific web route/path is
  required (per the ruling: "Web has no `/tasks/:id` route — do not require a specific path").
- Retry: `retryPendingWritebacks` is asserted to be exported as a function from
  `apps/server/src/poller.ts`, taking `db` and returning a promise; two scenarios prove it
  re-attempts a previously-failed comment (one on 认领, one on 完成 via the poller) and that a
  second call after success does **not** duplicate the POST; a third "no-op when nothing pending"
  safety test guards against a naive implementation that throws on an empty result set.
  **Deliberately imported via a scoped `await import('./poller.ts')` inside each test body, not a
  static top-level named import** — this was a considered choice: a static
  `import { retryPendingWritebacks } from './poller.ts'` would throw at ES module link time today
  (the export does not exist) and crash the *entire* file's module load, preventing every other
  test in `writeback.test.ts` from ever running. The dynamic, per-test import means the missing
  export fails only the 3 retry tests with a clear assertion message, while the other 12 tests
  still execute and independently prove their own behavioral RED. This satisfies the task's "how
  to get to RED" guidance in its preferred form ("prefer structuring... so some cases still
  execute") rather than its fallback form (accepting a whole-file load-failure RED).
- Fixtures reuse (not import) the OAuth login / agent-key / MCP-client / SSE-parsing / sqlite
  row-reading helpers from `poller.test.ts`, `claim.test.ts`, and `webhook.test.ts`, per the
  instruction. `buildApp` is real; only `globalThis.fetch` is mocked (per-request dispatch on
  method+URL shape, distinguishing `validateToken`'s repo/user GETs, the poller's PR-status GET,
  and the write-back comment/note POST — comment-endpoint routing is checked *before* the
  general repo/user branch so it can never be misclassified). `claimTask`, `submitPr`,
  `applyPrTerminalTransition`, and `commentOnIssue` itself are never mocked/stubbed directly.
- A gitlab-specific `repo` fixture body was required (`gitlabCapabilities` in
  `packages/forge-adapters/src/index.ts` reads `permissions.project_access.access_level` +
  `can_create_merge_request_in`, a different shape from github/gitea's `permissions.push`) — this
  was discovered and fixed during RED verification (see below), it is a test-fixture-only change.

## What I deliberately did NOT test (per "Forbidden" / scope)

- No production/source file was touched (`packages/forge-adapters/src/index.ts`,
  `apps/server/src/claim.ts`, `poller.ts`, `webhook.ts`, `tasks.ts`, `mcp.ts`, `app.ts`, `auth.ts`,
  `vault.ts`, `schema.ts` are all untouched — confirmed by `git status --short` showing only the
  three allowed-write paths as changed).
- No `docs/DESIGN.md`, `CLAUDE.md`, `README.md`, or `CHANGELOG.md` edits.
- No audit-log UI (#15), claim-confirmation (#16), or REST `submit_pr` route — I drove 提交PR only
  via the existing MCP tool, and did not add or expect any new REST route.
- No web/vue-router tests, and no test requires a specific `/tasks/:id` deep-link path.
- I did not implement `commentOnIssue`, the write-back hooks, or `retryPendingWritebacks` to make
  any of this pass. `commentOnIssue`'s current stub (`notImplemented`, throws
  `Error('not implemented')` for every kind) and the total absence of write-back calls in
  `claim.ts`/`poller.ts`/`webhook.ts` are exactly what makes every behavioral assertion above fail
  today.
- I did not weaken, rewrite, or delete any existing test. `git diff` on every pre-existing test
  file is empty; the full-suite sanity run (479 tests) shows the same 451 passes as before this
  change, with the new 28 failures isolated to the two new files.

## Process note (fixed during RED verification, not scope creep)

While establishing RED I found the worktree's `node_modules` was not installed at all (`git status`
confirmed nothing under `node_modules/` is tracked, and no test file — old or new — could load
`better-sqlite3`). I ran `pnpm install` to fix this so the baseline could actually be measured; this
is a dependency-manager operation reproducing the committed lockfile, not a change to any tracked
source or config file, and `git status --short` after the install still shows only the three
allowed-write files as modified/untracked.

## Failure signature (headline, for the completion contract)

- **Adapter**: `packages/forge-adapters/src/comment-on-issue.shared.test.ts::commentOnIssue shared spec > github > POSTs { body } to the comment endpoint with the same per-kind auth headers as the sibling methods` — `Error: not implemented` thrown synchronously from `notImplemented` at `packages/forge-adapters/src/index.ts:90:9` (same failure shape repeats, per-kind, for all 19 cases).
- **Server**: `apps/server/src/writeback.test.ts::issue #14 write-back > 完成 (complete) write-back > imported gitea task: pollPendingReviews posts a write-back comment on 已完成 (merged)` — `AssertionError [ERR_ASSERTION]: expected a write-back comment after completion, got []` (`actual: undefined, expected: true`), i.e. zero comment POSTs were observed where exactly one was required.
- **Retry seam**: `apps/server/src/writeback.test.ts::... > retry ... > re-posts a write-back comment that failed on 完成 (via pollPendingReviews)` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + 'undefined' - 'function'` (asserts `typeof poller.retryPendingWritebacks === 'function'`; today `apps/server/src/poller.ts` exports no such binding).

## Paths (per the output contract)

- Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14`
- This handoff: `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-14/.cache/tests-writeback.md`
- RED baseline capture: `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-14/.cache/tests-writeback-baseline.txt`
- Baseline SHA: `a722c8b`
