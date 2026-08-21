# Deliver M3 audit-log UI + team stats (#15) and claim-confirmation for autonomous polling agents (#16)

- item: Map the ground truth both issues wrap — events table writers/types/details shapes, absence of events HTTP, member workbench (no audit/stats UI), users schema, REST+MCP claim token-reveal path, agent-keys. Known: DESIGN §7 already matches #16's comment (API Key = auth for instructed claims; confirm switch is autonomous-poll only); CLAUDE.md says no events HTTP; #15 comments empty so body stands; #16 comment overrides body. Stay off implementing either issue.
  status: done
  dispatched: code-explorer (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-15-16/.cache/ground-truth.md
  result: kaola-workflow/bundle-15-16/.cache/ground-truth.md. HEAD 637c304. No events HTTP; events types 状态迁移/token 揭示/心跳/变更/回写; claimTask 201+token with no confirm gate; users has no settings column; no autonomous flag on keys or MCP; App.vue single-file workbench, no vue-router.

- item: Pin orchestrator rulings for both issues (events query shape, stats definition, how autonomous-poll claims are distinguished from instructed claims, pending-confirm wire, 受信自动化 persistence) from that ground truth plus DESIGN §3/§7/§10 and #16's comment.
  status: done
  dispatched: self
  result: kaola-workflow/bundle-15-16/.cache/orchestrator-rulings.md. #15 GET /api/v1/events + /stats, client-side filters, stats from events not tasks. #16 optional autonomous flag; users.trusted_automation default 0; claim_confirmations table; 202 no token until approve+retry; instructed 201 unchanged.

- item: Author the failing suite for #15 — combinable audit-log filters (person/task/time, types token 揭示 / 状态迁移 / 心跳), team stats matching the events table, Chinese UI. Do not implement production. Stay off #16's claim-confirm path except shared fixtures.
  status: done
  dispatched: tdd-guide (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16 against rulings at kaola-workflow/bundle-15-16/.cache/orchestrator-rulings.md; tests to land at apps/server/src/events.test.ts, apps/web/src/App.audit.test.ts, package.json test-script append; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-15-16/.cache/tests-events.md; RED baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-15-16/.cache/tests-events-baseline.txt
  result: RED on 637c304. events.test.ts 9 fail / 0 pass (routes 404). App.audit.test.ts 16 fail / 0 pass (no fetch). package.json appends events.test.ts. Handoff kaola-workflow/bundle-15-16/.cache/tests-events.md

- item: Author the failing suite for #16 — autonomous-poll unconfirmed claim does not reveal token; 受信自动化 on → claim passes through; setting persists and can be turned off; instructed (API-key) claims still reveal without confirm. Do not implement production. Stay off #15's audit UI.
  status: done
  dispatched: tdd-guide (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16 against rulings at kaola-workflow/bundle-15-16/.cache/orchestrator-rulings.md; tests to land at apps/server/src/claim-confirm.test.ts, apps/web/src/App.settings.test.ts; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-15-16/.cache/tests-claim-confirm.md; RED baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-15-16/.cache/tests-claim-confirm-baseline.txt; do not edit package.json (orchestrator appends)
  result: RED on 637c304. claim-confirm.test.ts 11 fail / 3 pass (the 3 pass are instructed-path + 待批准 invariance pins). App.settings.test.ts 8 fail / 0 pass. Orchestrator appended claim-confirm.test.ts to package.json after events.test.ts.

- item: Implement #15 against its suite. Do not touch the test files. Do not add claim-confirmation (#16).
  status: done
  dispatched: implementer (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16 against events.test.ts and App.audit.test.ts; green proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-15-16/.cache/impl-events.md
  result: kaola-workflow/bundle-15-16/.cache/impl-events.md. events.ts + app.ts + App.vue audit/stats. events.test.ts 9/9; App.audit+board+form 67/67; no test files edited.

- item: Implement #16 against its suite. Do not touch the test files. Do not add audit-log UI (#15).
  status: done
  dispatched: implementer (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16 against claim-confirm.test.ts and App.settings.test.ts; green proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-15-16/.cache/impl-claim-confirm.md
  result: kaola-workflow/bundle-15-16/.cache/impl-claim-confirm.md. claim-confirmations.ts + claim/mcp/auth/db/schema/App.vue. claim-confirm 14/14; settings 8/8; full pnpm test 502+75 green.

- item: Fix vue-tsc errors in App.audit.test.ts (optionValues SelectMixedOption; EMPTY_STATS vs typeof STATS) so pnpm typecheck exits 0. Do not weaken assertions.
  status: done
  dispatched: tdd-guide (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16; only App.audit.test.ts; proof at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-15-16/.cache/tests-audit-typecheck.md
  result: kaola-workflow/bundle-15-16/.cache/tests-audit-typecheck.md. optionValues narrows unknown; StatsBody Record. web typecheck 0; App.audit.test.ts 16/16.

- item: Security-review the new events HTTP and the claim-confirm path — events GET must never contain a forge token; unconfirmed autonomous claims must not reveal; 受信自动化 must not leak tokens to other users.
  status: done
  dispatched: security-reviewer (reasoning tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16 production diff; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-15-16/.cache/sec-review.md
  result: verdict pass, findings_blocking 0. R1 client-supplied autonomous is ruling-accepted. R2 unbounded events GET deferred. R3 settings toggle has no audit event deferred. Evidence kaola-workflow/bundle-15-16/.cache/sec-review.md

- item: Dock README/CHANGELOG/CLAUDE.md Commands snapshot, docs/api.md, and docs/architecture.md to the implemented audit HTTP/UI and claim-confirm surface. Transcribe verified signatures; do not change DESIGN.md contracts as a side effect of scaffolding.
  status: done
  dispatched: doc-updater (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16; proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-15-16/.cache/doc-updater.md
  result: kaola-workflow/bundle-15-16/.cache/doc-updater.md. README + CHANGELOG edited; CLAUDE.md / docs/api.md / docs/architecture.md already current. DESIGN.md untouched.

- item: Validate the worktree in-session: CI=true pnpm lint && typecheck && test && build all exit 0.
  status: done
  dispatched: self, worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16
  result: All four gates exit 0. node --test 502 pass / 0 fail (110 suites); vitest 75 pass. Record: kaola-workflow/bundle-15-16/.cache/final-validation.md hash a60241decc5f8994f93a6154e5f5061c8e47ff5bc77be43c0fef416d5f6ae477
