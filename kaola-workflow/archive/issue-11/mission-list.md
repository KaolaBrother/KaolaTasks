# submit_pr 后轮询 PR 终态并驱动状态机，发布者可从已退回重开（#11）

- item: Map the ground truth #11 must wrap — MCP `submit_pr` + `submissions`, `transitionTaskStatus` edges 待验收→已完成/已退回 and 已退回→待认领, poster PATCH reopen, ForgeAdapter `getPullRequest` vs existing `validateToken`, events/history retention, `buildApp` plugin lifecycle, DESIGN §5 §8. Known: #10 already moves 进行中→待验收 and writes `submissions.pr_state` `open`; other adapter methods throw `not implemented`; no REST `submit_pr`; no poller. Issue #11 has no comments (body stands). Do not implement webhook (#13) or import (#12).
  status: done
  dispatched: code-explorer over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-11/.cache/ground-truth.md
  result: kaola-workflow/issue-11/.cache/ground-truth.md. Shared edges already legal; poster PATCH reopen already preserves history; getPullRequest is notImplemented; no timer; nothing currently drives 待验收→已完成/已退回.

- item: Look up the three forges' PR/MR status APIs (how open vs merged vs closed is distinguished, how to parse a PR/MR URL into owner/repo/number) and a Fastify-safe configurable interval with `onClose` cleanup. Context7 may be unavailable in this runtime — use official docs.
  status: done
  dispatched: knowledge-lookup; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-11/.cache/forge-pr-apis.md
  result: kaola-workflow/issue-11/.cache/forge-pr-apis.md. GitHub/Gitea use state+merged; GitLab four-way state (locked→open by ruling); Fastify onClose + setInterval, no extra dep.

- item: Author the failing suite for the three PR terminal-state migrations, a poller that only scans 待验收 and respects a configurable frequency, and poster reopen 已退回→待认领 with history kept. Pin orchestrator rulings first. Do not implement production code.
  status: done
  dispatched: tdd-guide over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11; tests to land at packages/forge-adapters/src/get-pull-request.shared.test.ts and apps/server/src/poller.test.ts plus root package.json test-script append; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-11/.cache/tests-poller.md; RED baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-11/.cache/tests-poller-baseline.txt
  result: 27 adapter tests + 9 poller tests, RED on 1a6272c (297 pass / 28 fail). Custody: get-pull-request.shared.test.ts, poller.test.ts, package.json test script. Handoff kaola-workflow/issue-11/.cache/tests-poller.md

- item: Implement `getPullRequest`, the 待验收 poller, and reopen against that suite. Do not touch the test files. Do not add webhook receivers (#13) or REST `submit_pr` unless the suite already requires it.
  status: done
  dispatched: implementer over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11 against get-pull-request.shared.test.ts and poller.test.ts; green proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-11/.cache/impl-poller.md
  result: Orchestrator re-ran CI=true pnpm test → 333 pass / 0 fail + vitest 44. Production: getPullRequest, poller.ts, buildApp pollIntervalMs, POLL_INTERVAL_MS. Custody held (test files untouched).

- item: Security-review the poller credential path — decrypt for `getPullRequest` must not log or HTTP-return the token; audit details must not contain plaintext.
  status: done
  dispatched: security-reviewer re-review after implementer repaired the blocking unhandled-rejection DoS (plus transaction, in-flight guard, path encoding); first review at kaola-workflow/issue-11/.cache/sec-review.md; re-review to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-11/.cache/sec-rereview.md. pr_url-to-repo binding deferred (product decision).
  result: first review changes-requested (1 blocking); repair in impl-sec-fix.md; re-review verdict approved, findings_blocking 0. Token never in events/logs/HTTP. Deferred: pr_url not bound to task repo.

- item: Dock README/CHANGELOG/CLAUDE.md Commands snapshot, docs/api.md, and docs/architecture.md to the implemented poller and reopen surface. Transcribe verified signatures; do not change DESIGN.md contracts as a side effect of scaffolding.
  status: done
  dispatched: doc-updater over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11; proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-11/.cache/doc-updater.md
  result: README / CHANGELOG / CLAUDE.md / docs/api.md / docs/architecture.md docked. DESIGN.md untouched. Proof: kaola-workflow/issue-11/.cache/doc-updater.md. Docking: kaola-workflow/issue-11/.cache/doc-docking.md (DOCKED). Orchestrator corrected poller test count 11→9 and CLAUDE.md getPullRequest wording.

- item: Validate the worktree in-session: CI=true pnpm lint && typecheck && test && build all exit 0.
  status: done
  dispatched: self, worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11
  result: All four gates exit 0 after docs. node --test 333 pass / 0 fail (70 suites); vitest 44 pass. Record: kaola-workflow/issue-11/.cache/final-validation.md
