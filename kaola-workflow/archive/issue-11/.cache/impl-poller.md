# Implementer handoff — issue #11 (poller)

## Task

Implement `getPullRequest` for all three forge adapters and the server-side `pollPendingReviews`
poller (待验收 → 已完成/已退回), plus `buildApp({ pollIntervalMs })` and
`apps/server/src/index.ts`'s `POLL_INTERVAL_MS` wiring, per
`kaola-workflow/issue-11/.cache/orchestrator-rulings.md`. No test files were edited.

## Verification tier

`tests-green`.

## Files changed

Production code (worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11`):

- `packages/forge-adapters/src/index.ts` — `PrStatus` is now `{ state: 'open' | 'merged' | 'closed' }`
  (was `unknown`). Added `getPullRequest` for github/gitlab/gitea: URL parsing (`parseGithubPrUrl`,
  `parseGiteaPrUrl`, `parseGitlabMrUrl`, trailing-slash + `.diff`/`.patch` stripping via
  `stripPrUrlSuffix`), API-origin resolution (`prApiOrigin` — GitHub always
  `https://api.github.com`; GitLab/Gitea from constructor `options.baseUrl`, never the prUrl host),
  URL building (`prApiUrl`), and status derivation (`derivePrState` — GitHub/Gitea `merged===true`→
  merged else `state==='closed'`→closed else open; GitLab `state==='merged'`→merged,
  `'closed'`→closed, `'opened'`/`'locked'`→open). Reuses existing `authHeaders`/`forgeGet`; no new
  HTTP client. Wired into `createForgeAdapter`'s `getPullRequest` (was `notImplemented`).
- `apps/server/src/poller.ts` (new) — exports `pollPendingReviews(db: AppDb): Promise<void>`.
  Queries `tasks` where `status = '待验收'`; per task loads the latest `submissions` row (max id,
  skip if none); decrypts the credential via the same profile-XOR-inline branch as `claimTask`
  (`decryptToken`), skipping the row on any decrypt/vault failure or adapter/fetch throw (never
  throws out of the loop); calls `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl
  }).getPullRequest({ token }, submission.prUrl)`; `open` → no-op; `merged` →
  `transitionTaskStatus('待验收','已完成')` + `submissions.pr_state='merged'` + `状态迁移` event
  (`actorUserId: null`, `details: { task_id, from: '待验收', to: '已完成', pr_url }`); `closed` →
  same with `'已退回'`/`'closed'`. Never touches leases (no resurrection). Never writes a plaintext
  token into `events.details`.
- `apps/server/src/app.ts` — `buildApp` options gained `pollIntervalMs?: number`. Omitted or `<= 0`
  → no `setInterval` call at all (verified: existing tests calling naked `buildApp()` still see zero
  `setInterval` calls). Positive → registered inside a child plugin context (mirrors
  `mcp.ts`'s `mcpBearerContext` pattern) so Fastify's child-before-parent `onClose` ordering
  guarantees `clearInterval` fires before the root db-close hook; the interval body is
  `void pollPendingReviews(db)`.
- `apps/server/src/index.ts` — reads `POLL_INTERVAL_MS` (empty/unset → `60000`, else
  `Number.parseInt(...,10)`) and passes it as `pollIntervalMs` into `buildApp`. No new dependency.

Test/spec files (already authored by tdd-guide, **not edited by me**, only read and run):

- `packages/forge-adapters/src/get-pull-request.shared.test.ts` (untracked, pre-existing before my
  changes)
- `apps/server/src/poller.test.ts` (untracked, pre-existing before my changes)
- `package.json` `"test"` script (already had both new files appended before I started; left as-is)

## Verification commands + exit codes

All run from the worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11`.

1. Baseline (RED), before any production change:
   `CI=true pnpm test` → **exit 1**. `ℹ tests 325 / pass 297 / fail 28` (27 `get-pull-request.shared.test.ts`
   failures — `Error: not implemented` / one `non-OK HTTP` assertion failure — plus 1
   `apps/server/src/poller.test.ts` failure: `ERR_MODULE_NOT_FOUND` for `./poller.ts`). Full log
   captured at `/tmp/baseline-test.log` (session-local, not part of the repo).

2. Fast loop — forge-adapters only, after implementing `getPullRequest`:
   `node --experimental-strip-types --test packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts packages/forge-adapters/src/get-pull-request.shared.test.ts`
   → **exit 0**. `ℹ tests 47 / pass 47 / fail 0`.

3. Fast loop — poller only, after implementing `poller.ts` + `app.ts` + `index.ts`:
   `node --experimental-strip-types --test apps/server/src/poller.test.ts` → **exit 0**.
   `ℹ tests 9 / pass 9 / fail 0`.

4. Full suite (GREEN), after all production changes:
   `CI=true pnpm test` → **exit 0**. `ℹ tests 333 / pass 333 / fail 0` (node --test portion) followed
   by `pnpm --filter @kaola/web test` → `vitest run` → `Test Files 2 passed (2)`, `Tests 44 passed
   (44)`. No existing test was weakened, skipped, or edited; the 297-baseline node tests are still
   present and passing (297 + 27 get-pull-request + 9 poller = 333).

5. `pnpm lint` → **exit 0** (`eslint .`, no findings).

6. `pnpm typecheck` → **exit 0** (`packages/shared`, `packages/forge-adapters`, `apps/web`,
   `apps/server` all report `Done` with no errors).

## Before

- `ℹ tests 325 / pass 297 / fail 28` (node --test); web vitest not reached in the same run because
  the `&&` chain short-circuits on the node --test non-zero exit, but the same 44 web tests were
  independently unaffected by this change (no `apps/web` files touched).
- `packages/forge-adapters/src/index.ts`: `PrStatus = unknown`; `getPullRequest: notImplemented`.
- `apps/server/src/poller.ts`: did not exist.
- `apps/server/src/app.ts`: `buildApp` had no `pollIntervalMs` option; zero `setInterval` calls
  anywhere in `apps/server/src`.
- `apps/server/src/index.ts`: no `POLL_INTERVAL_MS` env read.

## After

- `ℹ tests 333 / pass 333 / fail 0` (node --test) + `Tests 44 passed (44)` (`pnpm --filter @kaola/web
  test`). `pnpm lint` and `pnpm typecheck` both exit 0.
- `packages/forge-adapters/src/index.ts`: `PrStatus = { state: 'open' | 'merged' | 'closed' }`;
  `getPullRequest` implemented for github/gitlab/gitea per the orchestrator ruling's URL-parsing and
  status-derivation rules; all 27 new shared-spec tests + all pre-existing `validateToken`/`index`
  tests pass.
- `apps/server/src/poller.ts`: new module, `pollPendingReviews(db)` exported; all 9 `poller.test.ts`
  tests pass (merged→已完成, closed→已退回, open stays 待验收, non-待验收 scope isolation, resilience
  skip-on-error with sibling completion, poster reopen after poller-driven 已退回 preserves history,
  and the three `pollIntervalMs` frequency-contract tests).
- `apps/server/src/app.ts`: `buildApp({ pollIntervalMs })` — omitted/`<=0` registers zero intervals
  (verified against the mocked-`setInterval` tests); a positive value registers exactly one
  `setInterval` with that delay, cleared on `onClose` via a child-plugin context registered before
  the root db-close hook.
- `apps/server/src/index.ts`: reads `POLL_INTERVAL_MS`, defaults to `60000`, passes through to
  `buildApp`.
- No regressions: all 297 baseline tests still pass unmodified; no test file was edited, weakened,
  or skipped.
