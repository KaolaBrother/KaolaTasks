# Finalization — Summary: issue-9

## Delivered
M1 slice for issue #9.

Lease-based REST claiming: Bearer `POST /api/v1/tasks/:publicId/claim|progress|release`, `leases` table (TTL 86400, unique one-active-per-task), reveal-on-claim with clone guidance, audited `token 揭示` on both credential forms, expiry sweep on session GET and Bearer writes (`actor_user_id` null). Pending `待批准` is 403 with no decrypt. Session GET list/get never contain the forge token. MCP and `submit_pr` unchanged (unimplemented). No web claim UI.

## Files Changed
Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9` on `workflow/issue-9`. Tests by tdd-guide; production by implementer; docs by doc-updater.

## Test Coverage
`apps/server/src/claim.test.ts` (27). Full `pnpm test`: node `--test` 279 pass / 0 fail, 54 suites; vitest 44 pass / 0 fail.

## Validation
verdict: pass
command: `CI=true pnpm lint && CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm build`
record: `kaola-workflow/issue-9/.cache/final-validation.md`
validated_candidate_hash: `6c3336da96967c61ee993c2997f76f7c3a2363223924aad184eb3a86047298d7`
tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9` after docs landed.

## Changed Paths
- `apps/server/src/claim.ts` (added)
- `apps/server/src/leases.ts` (added)
- `apps/server/src/agent-bearer.ts` (added)
- `apps/server/src/claim.test.ts` (added)
- `apps/server/src/agent-keys.ts`
- `apps/server/src/app.ts`
- `apps/server/src/db.ts`
- `apps/server/src/schema.ts`
- `apps/server/src/tasks.ts`
- `apps/server/src/vault.ts`
- `package.json`
- `README.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `docs/api.md`
- `docs/architecture.md`

## Mission List
All items `done` in `kaola-workflow/issue-9/mission-list.md`.

## Documentation Docking
DOCKED (`kaola-workflow/issue-9/.cache/doc-docking.md`). DESIGN.md contracts untouched.

## Run gaps

## Follow-Up Items
Not filed (gap sweep `sweptClasses: []`). Carried in conversation, not a new issue:
- DESIGN §5 "可按任务配置" TTL has no §6 field and no column; this slice uses a process-wide 86400s default.
- Board timeline still has no 认领/心跳 writers over HTTP (no events HTTP; #8).

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-9/.cache/doc-docking.md
- kaola-workflow/archive/issue-9/.cache/doc-updater.md
- kaola-workflow/archive/issue-9/.cache/final-validation.md
- kaola-workflow/archive/issue-9/.cache/ground-truth.md
- kaola-workflow/archive/issue-9/.cache/impl-claim.md
- kaola-workflow/archive/issue-9/.cache/orchestrator-rulings.md
- kaola-workflow/archive/issue-9/.cache/origin/selection-record.json
- kaola-workflow/archive/issue-9/.cache/run-gaps.json
- kaola-workflow/archive/issue-9/.cache/sec-review.md
- kaola-workflow/archive/issue-9/.cache/tests-claim-baseline.txt
- kaola-workflow/archive/issue-9/.cache/tests-claim.md
- kaola-workflow/archive/issue-9/finalization-summary.md
- kaola-workflow/archive/issue-9/mission-list.md
- kaola-workflow/archive/issue-9/workflow-state.md
