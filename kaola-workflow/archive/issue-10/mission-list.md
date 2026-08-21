# MCP server with six tools, API Key auth, and claim-time clone guidance (#10)

- item: Map the ground truth MCP must wrap — Bearer agent-key auth, `registerTasks` list/get (no token), `registerClaim` claim/progress/release (reveal-on-claim + clone hygiene already on REST), `transitionTaskStatus`, events/leases, `buildApp` plugin pattern, and DESIGN §9 tool table. Facts already known: no `@modelcontextprotocol/sdk` dependency; docs/api.md says MCP tools are unimplemented; REST claim exists; `submit_pr` HTTP and PR polling are #11 — this issue owns the MCP tool surface including a `submit_pr` that turns the task 待验收, not polling/reopen. Comment on #10 overrides the body: `claim_task` must return `suggested_dir` plus token-hygiene guidance, and the tool description text must include token hygiene.
  status: done
  dispatched: code-explorer over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-10/.cache/ground-truth.md
  result: kaola-workflow/issue-10/.cache/ground-truth.md. No MCP/SDK/`submit_pr` HTTP; list/get are session-only; claim envelope already has clone hygiene; `进行中→待验收` is legal in shared; `/mcp` collides with SPA.

- item: Look up how the official MCP TypeScript SDK mounts on Fastify in-process (Streamable HTTP or the current recommended transport), authenticates with a Bearer API key, registers tools with descriptions, and how an in-process test drives tools without a live Claude Code. Context7 is not available in this runtime — use official SDK docs and the GitHub repo.
  status: done
  dispatched: knowledge-lookup; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-10/.cache/mcp-sdk.md
  result: kaola-workflow/issue-10/.cache/mcp-sdk.md. v1 `@modelcontextprotocol/sdk@1.30.0` Streamable HTTP vs v2 split packages; auth is a wrapper in front of the handler; `requireBearerAuth` needs expiresAt so it is the wrong gate for personal API keys.

- item: Author the failing test suite for the six MCP tools — unauthenticated calls rejected; list/get never contain token; claim reveals token plus clone guidance; progress/release/submit_pr match §9; tool descriptions include token hygiene. Append the new test file to the root package.json test script or it will not run. Do not implement production code. Pin the orchestrator rulings at kaola-workflow/issue-10/.cache/orchestrator-rulings.md.
  status: done
  dispatched: tdd-guide over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10; tests to land at apps/server/src/mcp.test.ts plus root package.json test-script append; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-10/.cache/tests-mcp.md; RED baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-10/.cache/tests-mcp-baseline.txt
  result: 18 tests, 0 pass / 18 fail on HEAD 64b123e5ac2fe77aa176bd5deea055be7d77f758 (POST /api/mcp 404). Old claim+tasks+agent-keys 105/105. Custody: mcp.test.ts + package.json test script.

- item: Implement the in-process MCP server and six tools against that suite. Do not touch the test files. Do not add PR-status polling (that is #11).
  status: done
  dispatched: implementer over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10 against apps/server/src/mcp.test.ts; green proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-10/.cache/impl-mcp.md
  result: Orchestrator re-ran mcp.test.ts + claim.test.ts → 45 pass / 0 fail. Production: mcp.ts, claim handler extract, submissions DDL, SDK 1.30.0. Custody held (mcp.test.ts untracked from tdd-guide only).

- item: Security-review the MCP token-reveal path — unauthenticated and list/get must not leak token; claim reject paths must not decrypt; audit details must not contain plaintext.
  status: done
  dispatched: security-reviewer read-only over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10; findings to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-10/.cache/sec-review.md
  result: verdict pass, findings_blocking 0. Live inject: 401 before JSON-RPC; list/get/progress/release/submit_pr leak-free; pending claim no decrypt; concurrent claim_task one token one error. Evidence: kaola-workflow/issue-10/.cache/sec-review.md

- item: Dock README/CHANGELOG/CLAUDE.md Commands snapshot, docs/api.md, and docs/architecture.md to the implemented MCP surface. Transcribe verified signatures; do not change DESIGN.md contracts as a side effect of scaffolding.
  status: done
  dispatched: doc-updater over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10; proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-10/.cache/doc-updater.md
  result: README / CHANGELOG / CLAUDE.md / docs/api.md / docs/architecture.md docked. DESIGN.md untouched. Proof: kaola-workflow/issue-10/.cache/doc-updater.md. Docking: kaola-workflow/issue-10/.cache/doc-docking.md (DOCKED).

- item: Validate the worktree in-session: CI=true pnpm lint && typecheck && test && build all exit 0.
  status: done
  dispatched: self, worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10
  result: All four gates exit 0. node --test 297 pass / 0 fail (60 suites); vitest 44 pass. Record: kaola-workflow/issue-10/.cache/final-validation.md

- item: Implement the in-process MCP server and six tools against that suite. Do not touch the test files. Do not add PR-status polling (that is #11).
  status: todo

- item: Security-review the MCP token-reveal path — unauthenticated and list/get must not leak token; claim reject paths must not decrypt; audit details must not contain plaintext.
  status: todo

- item: Dock README/CHANGELOG/CLAUDE.md Commands snapshot, docs/api.md, and docs/architecture.md to the implemented MCP surface. Transcribe verified signatures; do not change DESIGN.md contracts as a side effect of scaffolding.
  status: todo

- item: Validate the worktree in-session: CI=true pnpm lint && typecheck && test && build all exit 0.
  status: todo
