# Ship multi-source OAuth users and ForgeAdapter validateToken

- item: Measure DESIGN.md §7–§11 and the current server/web/forge-adapters shells so user fields, OAuth sources, TokenCheck/Credential/RepoRef shapes, and adapter methods come from the document; issue #3 comment (multi-source OAuth + 待批准 / full vs claim_only) overrides the issue body that still says pick-one identity source
  status: done
  dispatched: code-explorer (standard tier); report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/design-measure.md
  result: Report at kaola-workflow/bundle-3-6/.cache/design-measure.md. #3 comment wins (three IdPs, active/待批准, full/claim_only). #6 ships validateToken + shared spec only; §8 other methods are on the printed interface but not this issue's acceptance. TokenCheck/Credential/RepoRef field names, session table, OAuth env vars, cookie names unspecified — do not invent in tests until a recorded technical decision. Write surfaces disjoint: #3 apps/server+web, #6 packages/forge-adapters; coordinate root package.json test file list. packages/shared left alone.

- item: Confirm Fastify 5 OAuth/session libraries compatible with this repo's Fastify ^5.4.0 and the three forges' token-permission probe APIs (read repo / push same-repo branch / create PR or MR) without inventing signatures
  status: done
  dispatched: knowledge-lookup (standard tier) twice in parallel — OAuth/session report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/oauth-libraries.md; forge probe-API report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/forge-validate-apis.md
  result: oauth-libraries.md (Fastify 5: @fastify/oauth2^8.3.0 + cookie^11 + session^11; GitLab /oauth/*; Gitea /login/oauth/*; drizzle-kit not required). forge-validate-apis.md (no REST dry-run for push/PR; use global fetch; mock.method on fetch; GitLab project-token write_repository not REST-provable). TokenCheck names recorded in technical-decisions.md.

- item: Author failing tests in packages/forge-adapters for the ForgeAdapter interface plus a shared validateToken spec that all three implementations must satisfy (structured missing read/push/PR items; same-repo push as the no-forge-account claimant prerequisite); keep getForgeAdaptersHealth; do not write production code
  status: done
  dispatched: tdd-guide (standard tier) in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6; tests land under that worktree packages/forge-adapters; red-run to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/tdd-guide-issue-6-red-run.txt; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/tdd-guide-issue-6-report.md; decisions at kaola-workflow/bundle-3-6/.cache/technical-decisions.md
  result: Worktree packages/forge-adapters/src/validate-token.shared.test.ts. Baseline RED: health pass 1 / shared spec fail 1 (missing createForgeAdapter export). Raw tdd-guide-issue-6-red-run.txt. Index.ts untouched.

- item: Author failing tests for the users table, multi-source OAuth callback, sessions, GitHub pending-approval, member approve, unauthenticated redirect, and pending-user claim denial with Chinese copy; do not write production code
  status: done
  dispatched: tdd-guide (standard tier) in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6; tests land under that worktree apps/server (and apps/web only if node:test can assert without a new runner); red-run record to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/tdd-guide-issue-3-red-run.txt; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/tdd-guide-issue-3-report.md; decisions at kaola-workflow/bundle-3-6/.cache/technical-decisions.md
  result: Worktree apps/server/src/auth.test.ts. RED 0 pass / 16 fail; placeholder still 1 pass. Raw tdd-guide-issue-3-red-run.txt. Production untouched.

- item: Implement ForgeAdapter and three validateToken adapters until those tests pass; do not write tests
  status: done
  dispatched: implementer (standard tier) in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6; production lands under that worktree packages/forge-adapters; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/implementer-issue-6-report.md
  result: packages/forge-adapters/src/index.ts — createForgeAdapter + GET-only validateToken for github/gitlab/gitea. Orchestrator re-ran worktree tests: pass 20 / fail 0. Report implementer-issue-6-report.md. Other §8 methods throw not implemented.

- item: Implement OAuth login, users/sessions, approval flow, and Chinese UI until those tests pass; do not write tests
  status: done
  dispatched: implementer (standard tier) in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6; production lands under that worktree apps/server and apps/web; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/implementer-issue-3-report.md
  result: Worktree apps/server (schema/auth/db/app) + App.vue login/approve UI. Orchestrator re-ran placeholder+auth: pass 17 / fail 0. Deps @fastify/oauth2, cookie, session. Report implementer-issue-3-report.md.

- item: Prove lint, typecheck, test, and build green in the bundle-3-6 worktree
  status: done
  dispatched: self in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6; record to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/final-validation.md; lint failure routed to build-error-resolver (reasoning tier), report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/build-error-resolver.md
  result: After dropping unused userPath kind, orchestrator CI=true re-run: lint/typecheck/test/build all exit 0. pnpm test 124 pass / 0 fail. Record final-validation.md.

- item: Dock README/CHANGELOG/docs against the measured public surface without changing DESIGN.md contracts
  status: done
  dispatched: doc-updater (standard tier) in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6; docs land under that worktree; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-3-6/.cache/doc-updater.md
  result: README/CHANGELOG/CLAUDE.md Commands+Snapshot/docs/api.md/docs/architecture.md docked to source. DESIGN.md untouched. Reports doc-updater.md and doc-docking.md. MCP/tasks/vault still documented as unimplemented.
