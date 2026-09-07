# Finalization summary — bundle-56-57-58

Issue: #56 #57 #58 forge-smoke harness: unexpected UAT flag, `--web` listen bind, `waitForForgeHead` timeout
Branch: `cursor/smoke-uat-fixes-772b` · base `3d04f28` · implementation freeze `fc405db` · live Path C wait `57b1daa` · sink: merge (Cloud `gh` is read-only; PR registered via ManagePullRequest for user approval)

## Delivered

- `#56` `waitForUatFlag`: only `ENOENT` is missing; empty/whitespace `go` waits; unexpected non-empty fails immediately after `redact` + `JSON.stringify`.
- `#57` Path C `--web` default listen `127.0.0.1`; `UAT_WEB_HOST` non-empty still overrides; Path B always loopback + ephemeral port.
- `#58` `waitForForgeHead` continues after a single adapter `TimeoutError`; production `DEFAULT_TIMEOUT_MS` remains 10s; `KAOLA_FORGE_TIMEOUT_MS` still unimplemented.
- Path C merge assert: `ensureSmokeCompletionWritebacks` drains `settleWritebacks` and `retryPendingWritebacks` so a 2s in-process poller cannot lose the sqlite `回写 完成` row.

## Files Changed

- `CHANGELOG.md`
- `docs/smoke-test.md`
- `package.json`
- `scripts/forge-smoke.ts`
- `scripts/forge-smoke.test.ts`

Commits:
- `e00de57` fix: repair forge-smoke UAT flag, listen bind, and forge-head timeout
- `fc405db` docs: dock smoke-test and CHANGELOG for #56 #57 #58
- `a13e5f8` docs: record #56-58 Path B GitLab and Gitea smoke reruns
- `15941fe` chore: archive bundle-56-57-58
- `57b1daa` fix: wait for Path C in-flight 完成 writeback

## Test Coverage

- `scripts/forge-smoke.test.ts` — hold protocol, listen host, continue-poll (14 tests).
- Live Path B and Path C GitLab and Gitea: `docs/smoke-test.md` 本轮记录.

## Validation

Frozen tree hash `08842ffa1d60cfb0e5430eae0e55b69116e66b61ff431a77f5c21f80a3d38cc5` (`.cache/final-validation.md`, `verdict: pass`) bound to the automated command at `fc405db`. Path C live wait landed after that freeze as `57b1daa`.

| leg | command | result |
|-----|---------|--------|
| automated | `pnpm lint && pnpm typecheck && pnpm test` | exit 0 at freeze — eslint clean; tsc clean in 5 packages; node --test 1049 / 256 suites / 0 fail; vitest 9 files / 166 tests / 0 fail |
| focused after `57b1daa` | `node --experimental-strip-types --test scripts/forge-smoke.test.ts` | 14/14 pass |
| real forge Path B (first) | `pnpm smoke:forge -- gitlab` / `-- gitea` | both exit 0; GitLab Issue #28 → MR !24; Gitea Issue #42 → PR #43 |
| real forge Path B (rerun) | same | both exit 0; GitLab Issue #29 → MR !25; Gitea Issue #44 → PR #45 |
| real forge Path C | `pnpm smoke:uat -- gitlab\|gitea --web` + browser | GitLab first Issue #30 → MR !26 UI+forge merge then `missing 回写 完成`; after `57b1daa` GitLab Issue #31 → MR !27 `ok`; Gitea Issue #46 → PR #47 `ok` |
| review | code-reviewer + security-reviewer on `fc405db` | both PASS, 0 blocking |

Not executed (配合, recorded as such): real GitLab OAuth, public TLS, GitHub publish, forge-page Merge, 向导「拆为子任务」.

## Changed Paths

- `package.json`
- `scripts/forge-smoke.ts`
- `scripts/forge-smoke.test.ts`

## Mission List

- 1 done — ground truth — `.cache/ground-truth.md`
- 2 done — RED `scripts/forge-smoke.test.ts` 14/8/6 — `.cache/tests.md`
- 3 done — three harness repairs; focused 14/14 — `.cache/impl.md`
- 4 done — handbook + CHANGELOG docked — `.cache/doc-docking.md`
- 5 done — code + security review PASS — `.cache/code-review.md` / `.cache/sec-review.md`
- 6 done — lint/typecheck/test + live Path B — `.cache/final-validation.md` / `.cache/live-smoke.md`

## Documentation Docking

DOCKED — see `.cache/doc-docking.md` / `.cache/doc-updater.md`. DESIGN.md / api.md / architecture.md / conventions.md / workflow-default.md / runner-carrier.md / `.env.example` / MCP examples: no impact (harness-only). Public docs that changed: `docs/smoke-test.md`, `CHANGELOG.md`.

## Issue statement walk

- #56 missing `go` waits — `waitForUatFlag` `isEnoent`; `scripts/forge-smoke.test.ts`; live Path C `uat_wait` / `uat_flag round-done` / `uat_flag approved`.
- #56 empty/whitespace waits — same suite; handbook hold paragraph.
- #56 unexpected non-empty fails immediately with redacted actual — same suite; catch no longer swallows `fail()`.
- #56 Path B without `--web` unchanged — Path B never calls `waitForUatFlag`; listen tests pin loopback; live Path B rerun `ok`.
- #57 default `--web` listen `127.0.0.1` — `resolveSmokeListenHost`; tests; handbook HTTP row; live Path C `127.0.0.1:31416` connect 0 while browser used `http://localhost:31416`.
- #57 `UAT_WEB_HOST` override including explicit `0.0.0.0` — tests.
- #57 no product login / token-reveal change — security review PASS; no `apps/` / `packages/` diff; Path C used local admin only.
- #58 single adapter timeout continues poll — tests inject `TimeoutError` then match; live Path B/C GitLab/Gitea exit 0 without `KAOLA_FORGE_TIMEOUT_MS`.
- #58 production `getPullRequest` 10s default unchanged — `packages/forge-adapters` not in the diff.
- #58 handbook pit no longer treats unimplemented env as a live knob — `docs/smoke-test.md`.

## Run gaps

## Follow-Up Items

none

## Readiness

READY — all missions done, Path B and Path C live UAT recorded, docs docked, no swept run gaps. Closure decision: close #56 #57 #58 when the PR merges. This Cloud host cannot auto-create or merge the PR (`ManagePullRequest` registered for user approval; `gh` cannot write PRs). Branch `cursor/smoke-uat-fixes-772b` is pushed.

## Sink Findings

sink: merge is the recorded kind. Cloud `gh` is read-only, so `kaola-workflow-sink-merge.js` cannot complete publication here. PR creation is registered for user approval on `cursor/smoke-uat-fixes-772b`. Issues remain `close-pending` until merge. Worktree kept.
