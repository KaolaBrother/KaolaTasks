# tdd-guide handoff — issue #11 (RED baseline)

## Baseline commit

`1a6272c109c204f6c3d3c23eef6b39dde987c363` (`chore: archive issue-10 [sink]`), branch
`workflow/issue-11`, worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11`.
Tree was clean before I started; only the files listed below were added/changed.

## What I wrote

1. `packages/forge-adapters/src/get-pull-request.shared.test.ts` — new. Shared spec for
   `ForgeAdapter.getPullRequest`, parameterized over github/gitlab/gitea (copies the
   fetch-stub/URL-recording helper shapes from `validate-token.shared.test.ts`, does **not**
   import that file). 27 test cases: per-kind auth-header + URL assertions, the three terminal
   mappings (merged/closed/open) + GitLab's `locked → open`, trailing-slash and `.diff`/`.patch`
   stripping, non-OK-HTTP and unparseable-URL rejection, GitHub always-`api.github.com`,
   GitLab subgroup-path `encodeURIComponent`, and "the API origin comes from the constructor
   `baseUrl` option, not the `prUrl` host" for gitlab/gitea.
2. `apps/server/src/poller.test.ts` — new. Drives the **real** MCP `submit_pr` tool (via a real
   `buildApp` + real HTTP/MCP JSON-RPC calls) to put a task into 待验收 with a real `submissions`
   row, then calls `pollPendingReviews(db)` against a **second** `createDb(sqlitePath)` connection
   to the same sqlite file — per role contract, `pollPendingReviews` and `buildApp` are never
   mocked. 9 test cases: merged→已完成/pr_state merged/system 状态迁移 (`actor_user_id: null`),
   closed→已退回/pr_state closed, open stays 待验收, non-待验收 statuses are never fetched (asserted
   both on unchanged status and on absence of the PR URL in the recorded fetch calls), one
   unreachable-PR task is skipped while a sibling 待验收 task still completes, poster PATCH
   `{status: '待认领'}` succeeds after a poller-driven 已退回 and prior events + the submissions row
   survive byte-for-byte, and the `pollIntervalMs` frequency contract (omitted/0 → no
   `setInterval`; positive → exactly one `setInterval` call with that delay). Token-hygiene
   assertion (`INLINE_TOKEN` never appears in `events.details`) is folded into the merged-PR test.
3. `package.json` — appended the two new test file paths to the root `"test"` script (same
   exemption used for issue #10). No other field touched (see `git diff package.json` — 1 line
   changed).

No production files were touched in the final state (`app.ts`, the forge-adapters `index.ts`,
`claim.ts`, etc. are all untouched — see "Self-check" below).

## Self-check performed (and reverted) before declaring RED

Per "Correct first," I did not want to hand off assertions I hadn't verified are satisfiable and
that fail for the *right* reason. I temporarily wrote scratch implementations —
`packages/forge-adapters/src/index.ts` (`getPullRequest` per the rulings) and
`apps/server/src/poller.ts` + a `pollIntervalMs` option in `apps/server/src/app.ts` — ran both new
suites plus the full `CI=true pnpm test` against them, fixed two real problems this surfaced, then
**reverted every scratch production change** (`git checkout -- apps/server/src/app.ts
packages/forge-adapters/src/index.ts && rm apps/server/src/poller.ts`) before capturing the RED
baseline below. `git status --short` at handoff shows only `package.json` (modified) and the two
new test files (untracked) — no production diff.

Problems the scratch run caught and how I fixed the **tests** (not production):

- Two adapter-spec assertions (`non-OK HTTP response rejects`, `an unparseable prUrl rejects`)
  passed trivially against the current `notImplemented()` placeholder, since a bare
  `assert.rejects` can't distinguish "rejects because not implemented" from "rejects because of
  the pinned reason." Strengthened both to also assert on `fetch` call counts (the non-OK-HTTP
  case must have actually called fetch once; the unparseable-URL case must reject *before* any
  fetch call, verified alongside a passing valid-URL call in the same test). Confirmed this
  produces 0 passes on HEAD (was 6/28 passing before the fix, i.e. a real defect per the role
  contract; the fix is now 0/28 passing on HEAD, 27/27 passing against a correct scratch impl —
  the file ended up with 27 tests, not 28, after also removing the item below).
- I had written a "gitlab/gitea: a subpath baseUrl is preserved... not dropped" test that assumed
  an un-pinned parsing policy (that the pasted web PR/MR URL itself is nested under the same
  subpath as `options.baseUrl`, requiring the implementation to strip that prefix before parsing
  owner/repo). Nothing in the orchestrator rulings or `forge-pr-apis.md` pins this — it's a
  plausible but invented extra product policy for the get-pull-request path specifically (the
  ground-truth's subpath-preservation fact is about `validateToken`'s `apiUrl()`, not about
  parsing a bare `prUrl`). Deleted the test rather than force that undocumented design choice on
  the implementer.

## RED baseline

Captured at `kaola-workflow/issue-11/.cache/tests-poller-baseline.txt` (full `CI=true pnpm test`
stdout/stderr against the reverted-to-HEAD worktree, commit SHA on line 1).

```
ℹ tests 325
ℹ pass 297
ℹ fail 28
EXIT_CODE=1
```

- **297 pass** — every pre-existing test, unmodified, still green (no existing suite was weakened).
- **28 fail**, all newly added and all failing for the pinned reasons:
  - **27** in `packages/forge-adapters/src/get-pull-request.shared.test.ts`, every one with
    signature `Error: not implemented` thrown from
    `packages/forge-adapters/src/index.ts:64` (`notImplemented()` — `getPullRequest` is still
    wired to the placeholder, and `PrStatus` is still `unknown`).
  - **1** for the whole `apps/server/src/poller.test.ts` file, signature
    `Error [ERR_MODULE_NOT_FOUND]: Cannot find module
    '.../apps/server/src/poller.ts' imported from '.../apps/server/src/poller.test.ts'`
    — `pollPendingReviews` does not exist yet (the task brief explicitly names this a valid RED
    signature; every one of the 9 `test()` cases inside that file is blocked by this single
    module-load failure and none of them ran).

No test that exercises new behavior currently passes on this HEAD.

## Notes for whoever implements

- The poller test's fetch stub treats a URL as a PR/MR endpoint (`/pulls/{n}` or
  `/merge_requests/{n}` at the end of the path) **before** treating it as a repo/user endpoint —
  this fixes the exact `isRepoEndpoint` pitfall called out in the rulings (`/repos/{owner}/{repo}`
  is a substring of `/repos/{owner}/{repo}/pulls/{n}`).
- The poller test's PR stub is keyed by the trailing numeric PR/MR id parsed out of whatever URL
  the implementation's `getPullRequest` actually requests, not by an exact string match — so it is
  tolerant of exactly how the implementation builds the API URL (gitea `pulls`, gitlab
  `merge_requests`), as long as the number is the last path segment.
- `pollPendingReviews(db)` is expected to return a value `pollPendingReviews` can be `await`-ed
  (an `async function` or a function returning `Promise<void>`); the frequency-contract tests only
  check that `setInterval`/`clearInterval` are (or aren't) called with the right delay, not that
  the interval callback itself resolves.
