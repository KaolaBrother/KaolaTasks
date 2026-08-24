# Finalization — Summary: issue-23

## Delivered
Issue #23 claimant identity: Kaola proves a **paired device** (Ed25519, stdio `kaola-mcp`), not a copy-paste Agent Key. Claimants are named identities without web login. Closed-join OAuth: empty `KAOLA_ADMINS` boots; zero `full` → first web login is admin; later uninvited logins do not insert. Pending device MCP/REST is HTTP `202` `{ error: 'authorization_required', pending: true, expires_at }` with no forge token. Admin binds to a claimant or to self; bind does not claim. Forge token still only on REST claim `201` and MCP `claim_task` success. #22 two-task tokens and clone four keys unchanged.

## Files Changed
Server: `auth.ts`, `device-proof.ts`, `devices.ts`, `schema.ts`/`db.ts`, `claim.ts`, `mcp.ts`, `leases.ts`, `claim-confirmations.ts`, `agent-keys.ts`, `app.ts` plus tests. New `@kaola/mcp` (`kaola-mcp`). Web `App.vue` 电脑 pane. Docs: DESIGN §3/§7/§9–§11, README, api, architecture, smoke-test, CHANGELOG, CLAUDE.md test list.

## Test Coverage
`devices.test.ts` pending 202 / bind / revoke / whoami; `auth.test.ts` closed join; claim/MCP two-task token pin and clone four keys retargeted to device proof; `apps/mcp/src/main.test.ts` stdio signing + 202 JSON-RPC; `App.devices.test.ts` / shell 电脑 pane. Leftover `ktk_` Bearer is 401 on MCP/claim.

## Validation
verdict: pass
command: `pnpm typecheck && pnpm lint && pnpm test`
validated_candidate_hash: `4205539c2646743e00ebefd0e64418bd9164253cc3c86abf7a55d157c86aff4b`
Reuse boundary: `pnpm typecheck`, `pnpm lint`, and `pnpm test` were run on this worktree immediately before commit `f28d88f02c719c8d9cac4dd052714b3e5e6ed2c4` (node ℹ tests 579 / pass 579; vitest 6 files / 109 tests). That commit is the same tree the recorder hashed. Security review: PASS (`.cache/sec-review.md`).

## Changed Paths
CHANGELOG.md
CLAUDE.md
README.md
apps/mcp/bin/kaola-mcp.mjs
apps/mcp/examples/mcp.json
apps/mcp/package.json
apps/mcp/src/main.test.ts
apps/mcp/src/main.ts
apps/mcp/tsconfig.json
apps/server/src/agent-keys.test.ts
apps/server/src/agent-keys.ts
apps/server/src/app.ts
apps/server/src/auth.test.ts
apps/server/src/auth.ts
apps/server/src/claim-confirm.test.ts
apps/server/src/claim-confirmations.ts
apps/server/src/claim.test.ts
apps/server/src/claim.ts
apps/server/src/credential-profile-issues.test.ts
apps/server/src/db.ts
apps/server/src/device-proof.test-helpers.ts
apps/server/src/device-proof.ts
apps/server/src/devices.test.ts
apps/server/src/devices.ts
apps/server/src/events.test.ts
apps/server/src/import.test.ts
apps/server/src/leases.ts
apps/server/src/mcp.test.ts
apps/server/src/mcp.ts
apps/server/src/poller.test.ts
apps/server/src/schema.ts
apps/server/src/tasks.test.ts
apps/server/src/vault.test.ts
apps/server/src/webhook.test.ts
apps/server/src/writeback.test.ts
apps/web/src/App.audit.test.ts
apps/web/src/App.board.test.ts
apps/web/src/App.devices.test.ts
apps/web/src/App.form.test.ts
apps/web/src/App.settings.test.ts
apps/web/src/App.shell.test.ts
apps/web/src/App.vue
docs/DESIGN.md
docs/api.md
docs/architecture.md
docs/smoke-test.md
package.json
packages/shared/src/device-proof.ts
packages/shared/src/index.ts
packages/shared/tsconfig.json
pnpm-lock.yaml

## Mission List
Seven items, all `done`: measure; DESIGN pin; failing server tests; server implementation; stdio bridge; web 电脑 pane; docs dock.

## Documentation Docking
DOCKED — see `.cache/doc-docking.md`.

## Run gaps

## Follow-Up Items
None. Leftover `POST /api/v1/agent-keys` CRUD remains as unused-compat (not MCP identity). Optional publisher invite table was out of scope.

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-23/.cache/architecture-corrections.md
- kaola-workflow/archive/issue-23/.cache/architecture.md
- kaola-workflow/archive/issue-23/.cache/design-pin.md
- kaola-workflow/archive/issue-23/.cache/doc-docking.md
- kaola-workflow/archive/issue-23/.cache/doc-updater.md
- kaola-workflow/archive/issue-23/.cache/docs-dock.md
- kaola-workflow/archive/issue-23/.cache/final-validation.md
- kaola-workflow/archive/issue-23/.cache/ground-truth.md
- kaola-workflow/archive/issue-23/.cache/impl-lint.md
- kaola-workflow/archive/issue-23/.cache/impl-mcp.md
- kaola-workflow/archive/issue-23/.cache/impl-server.md
- kaola-workflow/archive/issue-23/.cache/impl-web.md
- kaola-workflow/archive/issue-23/.cache/mcp-stdio-ed25519.md
- kaola-workflow/archive/issue-23/.cache/orchestrator-rulings.md
- kaola-workflow/archive/issue-23/.cache/origin/selection-record.json
- kaola-workflow/archive/issue-23/.cache/run-gaps.json
- kaola-workflow/archive/issue-23/.cache/sec-review.md
- kaola-workflow/archive/issue-23/.cache/tdd-fix.md
- kaola-workflow/archive/issue-23/.cache/tdd-leftover.md
- kaola-workflow/archive/issue-23/.cache/tdd-lint.md
- kaola-workflow/archive/issue-23/.cache/tdd-mcp.md
- kaola-workflow/archive/issue-23/.cache/tdd-server.md
- kaola-workflow/archive/issue-23/.cache/tdd-web.md
- kaola-workflow/archive/issue-23/finalization-summary.md
- kaola-workflow/archive/issue-23/mission-list.md
- kaola-workflow/archive/issue-23/workflow-state.md
