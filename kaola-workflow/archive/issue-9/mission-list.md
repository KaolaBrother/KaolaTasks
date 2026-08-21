# Lease-based claiming: claim, heartbeat, expiry, release, and reveal-on-claim (#9)

- item: Map the ground truth claiming must fit — `registerTasks` brief serialization and events, Bearer agent-key auth (`whoami` / `last_used_at`), vault `decryptToken` vs `revealCredentialProfile`, DESIGN §5/§7/§10 lease+events taxonomy, and `transitionTaskStatus` which already allows 待认领↔进行中. Facts already known: no `leases` table; MCP and claim HTTP unimplemented; REST is supposed to mirror MCP (§9) so this issue owns REST claim/heartbeat/release, not the MCP server (#10) and not `submit_pr` (#11). Comments override the body: 认领即授权 (no confirm; that is #16), 待批准 claim must be rejected without revealing token, claim success includes clone guidance (`suggested_dir` + token hygiene from the #10 comment).
  status: done
  dispatched: code-explorer over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-9/.cache/ground-truth.md
  result: kaola-workflow/issue-9/.cache/ground-truth.md. Load-bearing: session-only task CRUD; Bearer plugin encapsulated (only whoami); no leases; two `token 揭示` shapes; `assertNoTokenMaterial` forbids a `token` key; pending cannot mint keys; no cron. Orchestrator rulings in kaola-workflow/issue-9/.cache/orchestrator-rulings.md.

- item: Author the failing test suite for lease claiming — Bearer claim/heartbeat/release, default 24h TTL, expiry returning the task to 待认领 without a leftover live lease, pending-user claim rejected with no token and no reveal event, list/get never contain token even after a claim, every successful reveal audited, clone guidance on the claim success body. Do not implement MCP or submit_pr. Append the new test file to the root package.json test script or it will not run. Pin the orchestrator rulings at kaola-workflow/issue-9/.cache/orchestrator-rulings.md.
  status: done
  dispatched: tdd-guide over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9; tests to land at apps/server/src/claim.test.ts plus root package.json test-script append; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-9/.cache/tests-claim.md; RED baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-9/.cache/tests-claim-baseline.txt
  result: 27 tests, 0 pass / 27 fail on HEAD 1dae847c7af888aff8a92905a9cf2f448df68c74 (Fastify missing-route 404). Old tasks+agent-keys 78/78. Custody: claim.test.ts + package.json test script. Open questions closed by orchestrator: non-holder 403 need not include message; event order unpinned; heartbeat UPDATEs the same active lease row.

- item: Implement leases + claim/heartbeat/expiry/release + reveal-on-claim against that suite. Do not touch the test files. Do not add the MCP server.
  status: done
  dispatched: implementer over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9 against apps/server/src/claim.test.ts; green proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-9/.cache/impl-claim.md
  result: Orchestrator re-ran claim.test.ts → 27 pass / 0 fail; tasks+agent-keys+vault → 94 pass / 0 fail. Production: agent-bearer.ts, claim.ts, leases.ts, plus schema/db/tasks/vault/app/agent-keys. Custody held (claim.test.ts and package.json not edited by implementer).

- item: Security-review the token-reveal path — claim must not leak token on reject/list/get, audit details must not contain plaintext or ciphertext, pending users must not trigger decrypt.
  status: done
  dispatched: security-reviewer read-only over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9; findings to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-9/.cache/sec-review.md
  result: verdict pass, findings_blocking 0. Live inject PoCs: pending 403 before decrypt; second claim 409 no token; GET list/get/progress/release leak-free; concurrent inject one 201 one 409. Evidence: kaola-workflow/issue-9/.cache/sec-review.md

- item: Dock README/CHANGELOG/CLAUDE.md Commands snapshot, docs/api.md, and docs/architecture.md to the implemented REST surface. Transcribe verified signatures; do not change DESIGN.md contracts as a side effect of scaffolding.
  status: done
  dispatched: doc-updater over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9; proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-9/.cache/doc-updater.md
  result: README / CHANGELOG / CLAUDE.md / docs/api.md / docs/architecture.md docked. DESIGN.md untouched. Proof: kaola-workflow/issue-9/.cache/doc-updater.md. Docking: kaola-workflow/issue-9/.cache/doc-docking.md (DOCKED). Orchestrator added measured 279/279 + vitest 44 after gates.

- item: Validate the worktree in-session: CI=true pnpm lint && typecheck && test && build all exit 0.
  status: done
  dispatched: self, worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9
  result: All four gates exit 0. node --test 279 pass / 0 fail (54 suites); vitest 44 pass. Record: kaola-workflow/issue-9/.cache/final-validation.md

