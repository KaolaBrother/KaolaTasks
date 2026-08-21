# Finalization — Summary: issue-11

## Delivered
M1 slice for issue #11.

After MCP `submit_pr` leaves a task in 待验收 with `submissions.pr_state` `open`, an in-process poller (`pollPendingReviews`) scans only 待验收 rows and calls adapter `getPullRequest`: merged → 已完成, closed (unmerged) → 已退回, open stays 待验收. Frequency is `buildApp({ pollIntervalMs })`; omit/`<=0` disables the timer; prod `POLL_INTERVAL_MS` empty/unset → 60000. Events are `状态迁移` with `actorUserId: null` and details `{ task_id, from: '待验收', to, pr_url }`. Poster PATCH 已退回→待认领 already existed and keeps history. No REST `submit_pr`. No webhook (#13). No import (#12). `docs/DESIGN.md` untouched.

## Files Changed
Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11` on `workflow/issue-11`. Tests by tdd-guide; production by implementer; docs by doc-updater.

## Test Coverage
`packages/forge-adapters/src/get-pull-request.shared.test.ts` (27 cases across three forges) and `apps/server/src/poller.test.ts` (9 `test(`). Full `pnpm test`: node `--test` 333 pass / 0 fail, 70 suites; vitest 44 pass / 0 fail.

## Validation
verdict: pass
command: `CI=true pnpm lint && CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm build`
record: `kaola-workflow/issue-11/.cache/final-validation.md`
validated_candidate_hash: `a6aa85876b0a06cc32f27b6626a93b7eb4aba7ee9aaae1c5c56d8396b15e32ef`
tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11` after docs landed. Re-recorded after CHANGELOG poller-test-count and CLAUDE.md `getPullRequest` wording corrections; hash unchanged.

## Changed Paths
- `packages/forge-adapters/src/index.ts`
- `packages/forge-adapters/src/get-pull-request.shared.test.ts` (added)
- `apps/server/src/poller.ts` (added)
- `apps/server/src/poller.test.ts` (added)
- `apps/server/src/app.ts`
- `apps/server/src/index.ts`
- `apps/server/src/vault.ts`
- `package.json`
- `README.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `docs/api.md`
- `docs/architecture.md`

## Mission List
All items `done` in `kaola-workflow/issue-11/mission-list.md`.

## Documentation Docking
DOCKED (`kaola-workflow/issue-11/.cache/doc-docking.md`). DESIGN.md contracts untouched.

## Run gaps

## Follow-Up Items
Not filed (gap sweep `sweptClasses: []`). Carried in conversation, not a new issue:
- `pr_url` is not bound to `task.repo_full_name` / `repo_base_url` (product decision; neither #11 nor DESIGN §5/§8 specifies the binding).
- Adapter fetch has no `AbortSignal.timeout`; a hanging forge can starve later 待验收 rows in the same sequential pass (non-blocking availability carry-over).

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-11/.cache/doc-docking.md
- kaola-workflow/archive/issue-11/.cache/doc-updater.md
- kaola-workflow/archive/issue-11/.cache/final-validation.md
- kaola-workflow/archive/issue-11/.cache/forge-pr-apis.md
- kaola-workflow/archive/issue-11/.cache/ground-truth.md
- kaola-workflow/archive/issue-11/.cache/impl-poller.md
- kaola-workflow/archive/issue-11/.cache/impl-sec-fix.md
- kaola-workflow/archive/issue-11/.cache/orchestrator-rulings.md
- kaola-workflow/archive/issue-11/.cache/origin/selection-record.json
- kaola-workflow/archive/issue-11/.cache/run-gaps.json
- kaola-workflow/archive/issue-11/.cache/sec-rereview.md
- kaola-workflow/archive/issue-11/.cache/sec-review.md
- kaola-workflow/archive/issue-11/.cache/tests-poller-baseline.txt
- kaola-workflow/archive/issue-11/.cache/tests-poller.md
- kaola-workflow/archive/issue-11/finalization-summary.md
- kaola-workflow/archive/issue-11/mission-list.md
- kaola-workflow/archive/issue-11/workflow-state.md
