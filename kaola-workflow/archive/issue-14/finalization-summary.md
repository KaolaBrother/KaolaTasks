# Finalization — Summary: issue-14

## Delivered
M2 slice for issue #14.

Shared `ForgeAdapter.commentOnIssue` posts a comment on the imported source Issue using the same host rule as `importIssue`/`getPullRequest` (`IssueRef` is `{ issue_url: string }`; GitHub/Gitea `POST …/comments`, GitLab `POST …/notes`; success any `res.ok`). Imported tasks (`sourceType === 'imported'` with a non-empty `sourceIssueUrl`) write back on **认领** (`claimTask`, REST + MCP), **提交PR** (`submitPr`, MCP-only), and **完成** (`applyPrTerminalTransition` when `terminal === 'merged'` — poller and webhook). Native tasks, `releaseTask`, and `已退回` (`terminal === 'closed'`) do not write back. Failures are swallowed after the status transition commits, so claim still returns `201`+token, submit still lands `待验收`, and complete still lands `已完成`. Success records `events.type` `'回写'` with details `{ task_id, transition, ok: true, issue_url }`; failures write no event. Comment bodies carry `PUBLIC_URL` + `publicId`; 提交PR/完成 also include `pr_url`. Credential is `decryptTaskToken` (task profile or inline ciphertext), never the Agent API key. `retryPendingWritebacks` retries imported tasks whose transition occurred but have no successful `回写`, chained after `pollPendingReviews` in the same in-flight timer. `docs/DESIGN.md` untouched. Stayed off audit-log UI (#15) and claim-confirmation (#16).

## Files Changed
Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14` on `workflow/issue-14`. Tests by tdd-guide; production by implementer; docs by doc-updater. Implementation commit `fea7228`.

## Test Coverage
`packages/forge-adapters/src/comment-on-issue.shared.test.ts` (19 `it(` across three forges) and `apps/server/src/writeback.test.ts` (15 `test(`). RED baseline on `a722c8b`: 34 tests / 6 pass / 28 fail. Full `pnpm test` after implementation: node `--test` 479 pass / 0 fail, 99 suites; vitest 51 pass / 0 fail.

## Validation
verdict: pass
command: `CI=true pnpm lint && CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm build`
record: `kaola-workflow/issue-14/.cache/final-validation.md`
validated_candidate_hash: `3fd9719773ca54169bb54e8285486f0da55a54c5aaa00a24b67f3b568069a7fe`
tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14` at `fea7228`. Four gates were run after production + first doc pass; README docking sentence fixes after that run are docs-only and were not a code/test rerun trigger.

## Changed Paths
- `packages/forge-adapters/src/index.ts`
- `packages/forge-adapters/src/comment-on-issue.shared.test.ts` (added)
- `apps/server/src/writeback.ts` (added)
- `apps/server/src/writeback.test.ts` (added)
- `apps/server/src/claim.ts`
- `apps/server/src/poller.ts`
- `apps/server/src/webhook.ts`
- `apps/server/src/mcp.ts`
- `apps/server/src/app.ts`
- `package.json`
- `README.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `docs/api.md`
- `docs/architecture.md`

## Mission List
All items `done` in `kaola-workflow/issue-14/mission-list.md`.

## Documentation Docking
DOCKED (`kaola-workflow/issue-14/.cache/doc-docking.md`). DESIGN.md contracts untouched. Orchestrator then corrected leftover README sentences under #12/#13 that still claimed `commentOnIssue` unimplemented / webhook never-decrypts.

## Run gaps

## Follow-Up Items
Not filed (gap sweep `sweptClasses: []`). Security-review non-blocking notes (uncapped retry, no fetch timeout, O(tasks×events) retry reads) were explicit non-findings, not seeded as run gaps.

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-14/.cache/doc-docking.md
- kaola-workflow/archive/issue-14/.cache/doc-updater.md
- kaola-workflow/archive/issue-14/.cache/final-validation.md
- kaola-workflow/archive/issue-14/.cache/forge-comment-apis.md
- kaola-workflow/archive/issue-14/.cache/ground-truth.md
- kaola-workflow/archive/issue-14/.cache/impl-writeback.md
- kaola-workflow/archive/issue-14/.cache/orchestrator-rulings.md
- kaola-workflow/archive/issue-14/.cache/origin/selection-record.json
- kaola-workflow/archive/issue-14/.cache/run-gaps.json
- kaola-workflow/archive/issue-14/.cache/sec-review.md
- kaola-workflow/archive/issue-14/.cache/tests-writeback-baseline.txt
- kaola-workflow/archive/issue-14/.cache/tests-writeback.md
- kaola-workflow/archive/issue-14/finalization-summary.md
- kaola-workflow/archive/issue-14/mission-list.md
- kaola-workflow/archive/issue-14/workflow-state.md
