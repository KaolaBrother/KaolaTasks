# Webhook 接收端签名校验，并按 forge 实例配置 webhook 或轮询兜底（#13）

- item: Map the ground truth #13 must wrap — `registerWebhook`/`parseWebhook` still `notImplemented`, `ForgeEvent` is `unknown`, #11 poller already drives every 待验收 row with no per-instance mode, no webhook HTTP. Known: DESIGN §8 §11 §14; issue #13 has no comments (body stands). Stay off write-back (#14) and `commentOnIssue`.
  status: done
  dispatched: code-explorer (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/ground-truth.md
  result: kaola-workflow/issue-13/.cache/ground-truth.md. HEAD 44eca32b. No webhook route; parseWebhook/registerWebhook throw; ForgeEvent unknown; poller scans every 待验收 row; no per-instance mode; Fastify has no raw-body capture; tokens only via claim.

- item: Look up the three forges' webhook signature schemes and PR-merged/closed event payloads (GitHub HMAC, GitLab/Gitea secret token) so `parseWebhook` can reject bad signatures and map merge/close onto the existing poller outcomes. Host rule should mirror `getPullRequest`/`importIssue`. Context7 may be unavailable — use official docs.
  status: done
  dispatched: knowledge-lookup (standard tier) over official forge docs; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/forge-webhook-apis.md
  result: kaola-workflow/issue-13/.cache/forge-webhook-apis.md. GitHub HMAC sha256= prefix; GitLab X-Gitlab-Token (HMAC signing_token out of scope); Gitea X-Gitea-Signature hex no prefix; do not unify parsers.

- item: Author the failing suite for signature/secret rejection, webhook PR-merge completing a 待验收 task (and closed→已退回), and per-forge-instance webhook-vs-poll mode that actually skips polling. Pin orchestrator rulings first. Do not implement production code. Stay off `commentOnIssue` (#14).
  status: done
  dispatched: tdd-guide (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13 against rulings at kaola-workflow/issue-13/.cache/orchestrator-rulings.md; tests to land at packages/forge-adapters/src/webhook.shared.test.ts, apps/server/src/webhook.test.ts, poller.test.ts additions, package.json test-script append; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/tests-webhook.md; RED baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/tests-webhook-baseline.txt
  result: 34 adapter + 10 HTTP + 1 poller-skip RED on 44eca32b (node 444 tests, 399 pass / 45 fail). 3 extra poller cases are intentional green regression guards. Custody: webhook.shared.test.ts, webhook.test.ts, poller.test.ts, package.json test script. Handoff kaola-workflow/issue-13/.cache/tests-webhook.md

- item: Implement `parseWebhook`/`registerWebhook`, webhook HTTP, and per-instance poll/webhook mode against that suite. Do not touch the test files. Do not add status write-back (#14).
  status: done
  dispatched: implementer (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13 against webhook.shared.test.ts, webhook.test.ts, poller.test.ts; green proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/impl-webhook.md
  result: Production in adapter index.ts, poller.ts, webhook.ts, app.ts, index.ts. 441/444 pass; 3 remaining are one defective it() × 3 kinds (createAdapter default-param swallows `undefined`). Proof: kaola-workflow/issue-13/.cache/impl-webhook.md. commentOnIssue still notImplemented.

- item: Fix the webhook.shared.test.ts helper so `createAdapter(kind, undefined)` actually omits `webhookSecret` (JS default params replace explicit undefined). Empty-string half is already correct. Do not weaken production assertions or rewrite other cases.
  status: done
  dispatched: tdd-guide (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13; only packages/forge-adapters/src/webhook.shared.test.ts; note at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/tests-webhook-helper-fix.md
  result: NO_SECRET sentinel; 34/34 adapter + full CI=true pnpm test 444 pass / 51 vitest pass (orchestrator re-ran). Note: kaola-workflow/issue-13/.cache/tests-webhook-helper-fix.md

- item: Security-review the webhook path — bad signatures must be rejected; secrets must not be logged or returned; webhook must not become a second token reveal; host/callback registration must not SSRF.
  status: done
  dispatched: security-reviewer (reasoning tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13 production diff; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/sec-review.md
  result: verdict fail, findings_blocking 1. R1: signed instance A can complete any 待验收 task by attacker-chosen pr_url (no bind to instance forge/baseUrl). R2 low/non-blocking: Gitea registerWebhook leaves full_name unencoded. Evidence kaola-workflow/issue-13/.cache/sec-review.md

- item: Author a failing webhook.test.ts case that a correctly signed delivery for instance A does not complete a 待验收 task whose (repoForge, repoBaseUrl) belongs to a different instance. Pin R1. Do not implement production code.
  status: done
  dispatched: tdd-guide (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13; add only to apps/server/src/webhook.test.ts; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/tests-r1.md
  result: One new RED case in webhook.test.ts (10 pass / 1 fail). Confused-deputy github-signed payload with gitea pr_url currently completes the gitea task. kaola-workflow/issue-13/.cache/tests-r1.md

- item: Bind webhook completion to the signature-verified instance's (forge, baseUrl) so R1 fails closed; do not touch tests.
  status: done
  dispatched: implementer (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13; production only; proof at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/impl-r1.md
  result: findPendingReviewMatch requires taskMatchesForgeInstance (forge, baseUrl). Gitea registerWebhook encodes owner/repo. CI=true pnpm test 445+51 green. kaola-workflow/issue-13/.cache/impl-r1.md

- item: Re-review the R1 repair delta (instance bind on webhook match) and confirm R1 is closed.
  status: done
  dispatched: security-reviewer (reasoning tier) over the worktree repair delta; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/sec-rereview.md
  result: verdict pass, findings_blocking 0. R1 closed (instance bind before pr_url). R2 closed (Gitea path encoding). Evidence kaola-workflow/issue-13/.cache/sec-rereview.md

- item: Dock README/CHANGELOG/CLAUDE.md Commands snapshot, docs/api.md, and docs/architecture.md to the implemented webhook + poll-mode surface. Transcribe verified signatures; do not change DESIGN.md contracts as a side effect of scaffolding.
  status: done
  dispatched: doc-updater (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13; proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-13/.cache/doc-updater.md
  result: README/CHANGELOG/CLAUDE.md/docs/api.md/docs/architecture.md docked. DESIGN.md untouched. Proof kaola-workflow/issue-13/.cache/doc-updater.md. Docking: kaola-workflow/issue-13/.cache/doc-docking.md (DOCKED).

- item: Validate the worktree in-session: CI=true pnpm lint && typecheck && test && build all exit 0.
  status: done
  dispatched: self, worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13
  result: All four gates exit 0 after docs. node --test 445 pass / 0 fail (89 suites); vitest 51 pass. Record: kaola-workflow/issue-13/.cache/final-validation.md hash 5e9097deeee721d6afa54c18d088889a356c9d2c4e5072ce29a7a654bedf197c

- item: Implement `parseWebhook`/`registerWebhook`, webhook HTTP, and per-instance poll/webhook mode against that suite. Do not touch the test files. Do not add status write-back (#14).
  status: todo

- item: Security-review the webhook path — bad signatures must be rejected; secrets must not be logged or returned; webhook must not become a second token reveal; host/callback registration must not SSRF.
  status: todo

- item: Dock README/CHANGELOG/CLAUDE.md Commands snapshot, docs/api.md, and docs/architecture.md to the implemented webhook + poll-mode surface. Transcribe verified signatures; do not change DESIGN.md contracts as a side effect of scaffolding.
  status: todo

- item: Validate the worktree in-session: CI=true pnpm lint && typecheck && test && build all exit 0.
  status: todo
