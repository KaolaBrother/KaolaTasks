# 导入型任务在认领、提交 PR、完成时回写源 Issue 评论（#14）

- item: Map the ground truth #14 must wrap — `commentOnIssue` still `notImplemented`, `IssueRef` is `unknown`, claim/submit_pr/complete paths do not write back. Known: DESIGN §5 §8 (imported tasks only; 认领/提交 PR/完成; comments carry 考拉任务链接 + PR 链接); issue #14 has no comments (body stands). Acceptance: three transitions write comments; write-back failure retries and does not block the main flow; uses the task's attached credential. Stay off audit-log UI (#15) and claim-confirmation (#16).
  status: done
  dispatched: code-explorer (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-14/.cache/ground-truth.md
  result: kaola-workflow/issue-14/.cache/ground-truth.md. HEAD a722c8b. commentOnIssue notImplemented; IssueRef unknown; submit_pr MCP-only; complete is applyPrTerminalTransition (also 已退回); no retry queue; no permalink helper; 回写 event named in DESIGN only.

- item: Look up the three forges' create-issue-comment APIs (GitHub/GitLab/Gitea) so `commentOnIssue` can POST with the same host rule as `importIssue`/`getPullRequest`. Pin auth headers, path shapes, IssueRef fields, and error statuses. Context7 may be unavailable — use official docs.
  status: done
  dispatched: knowledge-lookup (standard tier) over official forge docs; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-14/.cache/forge-comment-apis.md
  result: kaola-workflow/issue-14/.cache/forge-comment-apis.md. All three POST `{ body }`. GitHub `/issues/{n}/comments` 201; GitLab `/issues/{iid}/notes` (res.ok); Gitea `/issues/{index}/comments` 201 + unique 423. IssueRef `{ issue_url }`. No idempotency key.

- item: Author the failing suite for three-forge `commentOnIssue`, imported-task write-back on claim / submit PR / complete (with 考拉任务链接 and PR 链接 where applicable), retry-on-failure that does not block the main flow, and credential-from-task. Pin orchestrator rulings first. Do not implement production code. Stay off #15 and #16.
  status: done
  dispatched: tdd-guide (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14 against rulings at kaola-workflow/issue-14/.cache/orchestrator-rulings.md; tests to land at packages/forge-adapters/src/comment-on-issue.shared.test.ts, apps/server/src/writeback.test.ts, package.json test-script append; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-14/.cache/tests-writeback.md; RED baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-14/.cache/tests-writeback-baseline.txt
  result: RED on a722c8b. 34 tests / 6 pass (native / 已退回 / non-blocking vacuously true) / 28 fail. Adapter 19 all fail on notImplemented. writeback.test.ts 9 fail including missing retryPendingWritebacks. Orchestrator re-ran: exit 1, ℹ fail 28. Handoff kaola-workflow/issue-14/.cache/tests-writeback.md

- item: Implement `commentOnIssue` and server-side write-back against that suite. Do not touch the test files. Do not add audit-log UI (#15) or claim-confirmation (#16).
  status: done
  dispatched: implementer (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14 against comment-on-issue.shared.test.ts and writeback.test.ts; green proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-14/.cache/impl-writeback.md
  result: Production in adapter index.ts, writeback.ts, poller.ts, claim.ts, webhook.ts, app.ts, mcp.ts. Orchestrator re-ran CI=true pnpm test: node 479 pass / 0 fail; vitest 51 pass. Proof: kaola-workflow/issue-14/.cache/impl-writeback.md. IssueRef is { issue_url }. commentOnIssue posts via resolveImportedIssue+forgePost.

- item: Security-review the write-back path — forge tokens must not be logged or returned; write-back must not become a third reveal channel; retry must not amplify token leakage; host rule must not SSRF.
  status: done
  dispatched: security-reviewer (reasoning tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14 production diff; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-14/.cache/sec-review.md
  result: verdict pass, findings_blocking 0. No new reveal channel; webhook decrypt-to-comment is signature-pinned to instance/task/pr_url; host rule inherited from resolveImportedIssue. Evidence kaola-workflow/issue-14/.cache/sec-review.md

- item: Dock README/CHANGELOG/CLAUDE.md Commands snapshot, docs/api.md, and docs/architecture.md to the implemented commentOnIssue + write-back surface. Transcribe verified signatures; do not change DESIGN.md contracts as a side effect of scaffolding.
  status: done
  dispatched: doc-updater (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14; proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-14/.cache/doc-updater.md
  result: CLAUDE.md README.md CHANGELOG.md docs/api.md docs/architecture.md docked. DESIGN.md untouched. Proof kaola-workflow/issue-14/.cache/doc-updater.md. Docking: kaola-workflow/issue-14/.cache/doc-docking.md (DOCKED). Orchestrator then fixed leftover #12/#13 README sentences that still said commentOnIssue/webhook never-decrypt.

- item: Validate the worktree in-session: CI=true pnpm lint && typecheck && test && build all exit 0.
  status: done
  dispatched: self, worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14
  result: All four gates exit 0 after docs. node --test 479 pass / 0 fail (99 suites); vitest 51 pass. Record: kaola-workflow/issue-14/.cache/final-validation.md (to be written by validation-runner).
