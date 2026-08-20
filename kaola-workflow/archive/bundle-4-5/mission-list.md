# Ship Agent API keys and token vault (credential profiles + AES-256-GCM audit)

- item: Measure DESIGN.md §7 §10 §11 and the current server/web so agent_keys, credential_profiles, events, permission gates, and HTTP shape come from the document; #4 and #5 have no overriding comments; reveal-on-claim leases stay #9 — this run needs a vault reveal+audit primitive without tasks/MCP
  status: done
  dispatched: code-explorer (standard tier); report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/design-measure.md
  result: kaola-workflow/bundle-4-5/.cache/design-measure.md at worktree commit 2e280c9. No comment override on #4/#5. Temp-token holding is tasks.inline_token_encrypted; reveal product path is claim_task. UNSPECIFIED HTTP/hash/env listed for technical-decisions.

- item: Confirm Node 22 crypto AES-256-GCM (iv, auth tag, key length) and a Fastify 5 Bearer pattern that fits this repo's Fastify ^5.4.0 without inventing env var or plugin names until recorded
  status: done
  dispatched: knowledge-lookup (standard tier); report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/crypto-bearer.md
  result: kaola-workflow/bundle-4-5/.cache/crypto-bearer.md. GCM via createCipheriv aes-256-gcm, 32-byte key, 12-byte IV, 16-byte tag. Custom Fastify hook; bearer-auth plugin not required.

- item: Author failing tests for Agent API keys — generate/revoke, hashed storage, plaintext once, revoke → 401, last_used_at, pending user denied generating keys, Bearer middleware; do not write production code
  status: done
  dispatched: tdd-guide (standard tier) in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5; tests land at that worktree apps/server/src/agent-keys.test.ts; red-run to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/tdd-guide-issue-4-red-run.txt; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/tdd-guide-issue-4-report.md; bind kaola-workflow/bundle-4-5/.cache/technical-decisions.md
  result: Worktree apps/server/src/agent-keys.test.ts. RED 0 pass / 9 fail; auth+placeholder still 17 pass. Raw tdd-guide-issue-4-red-run.txt. Production untouched.

- item: Author failing tests for credential profiles — AES-256-GCM so the DB has no plaintext token, delete is revoke, reveal writes events (who / which key / when / which profile), single-task temp token override, claim_only cannot manage profiles; do not write production code
  status: done
  dispatched: tdd-guide (standard tier) in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5; tests land at that worktree apps/server/src/vault.test.ts; red-run to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/tdd-guide-issue-5-red-run.txt; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/tdd-guide-issue-5-report.md; bind kaola-workflow/bundle-4-5/.cache/technical-decisions.md
  result: Worktree apps/server/src/vault.test.ts. RED 1 pass (GET / pin) / 15 fail. Raw tdd-guide-issue-5-red-run.txt. Production untouched. Temp-token is encryptToken/decryptToken only.

- item: Implement Agent API keys, hashed storage, Bearer auth, and Chinese key UI until those tests pass; do not write tests
  status: done
  dispatched: implementer (standard tier) in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5 covering both #4 and #5 oracles (shared schema.ts/db.ts/app.ts/App.vue); production lands under that worktree; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/implementer-issue-4-report.md
  result: agent-keys.ts + Bearer whoami + App.vue key widget. Orchestrator re-ran four server files: 42 pass / 0 fail. Report implementer-issue-4-report.md.

- item: Implement credential-profile vault, AES-256-GCM, events audit, and Chinese profile UI until those tests pass; do not write tests
  status: done
  dispatched: implementer (standard tier) same dispatch as #4 (one writer, both oracles); report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/implementer-issue-5-report.md
  result: vault.ts + credential-profiles.ts + events. Orchestrator re-ran 42 pass / 0 fail. Report implementer-issue-5-report.md.

- item: Prove lint, typecheck, test, and build green in the bundle-4-5 worktree
  status: done
  dispatched: self in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5; record to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/final-validation.md
  result: CI=true lint/typecheck/test/build all exit 0. pnpm test 149 pass / 0 fail, 26 suites. Hash 48dfa271006740a67d1113229ef9a58fc356dc9789cf0fb36a5f4c3848100079. Record final-validation.md. Root test list now includes agent-keys.test.ts and vault.test.ts.

- item: Dock README/CHANGELOG/docs against the measured public surface without changing DESIGN.md contracts
  status: done
  dispatched: doc-updater (standard tier) in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5; docs land under that worktree; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/doc-updater.md
  result: README/CHANGELOG/CLAUDE.md Commands+Snapshot/docs/api.md/docs/architecture.md docked. DESIGN.md untouched. Reports doc-updater.md and doc-docking.md (DOCKED). MCP/tasks/claim still documented as unimplemented.
