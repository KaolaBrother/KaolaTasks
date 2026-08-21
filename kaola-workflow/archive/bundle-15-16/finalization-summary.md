# Finalization — Summary: bundle-15-16

## Delivered
M3 slices for issues #15 and #16.

#15: session `GET /api/v1/events` (newest-first EventRow, left-join `actor_username`, parsed `details`) and `GET /api/v1/stats` (`completed_count` / `completed_by_username` counted from `状态迁移` events with `details.to === '已完成'`, null actor → `系统` — not from `tasks.status`). 待批准 is 401 (stricter than the board); `claim_only` can read. Member workbench 审计日志 (combinable client-side 类型/人/任务/时间 filters) and 团队统计; Chinese; no vue-router.

#16: optional `autonomous` on REST claim body and MCP `claim_task`. Instructed claims (flag absent/false) stay 201+token. Autonomous + `trusted_automation` off parks a `claim_confirmations` row, writes `认领待确认`, returns REST 202 / MCP pending with no token, task stays 待认领. Owner approve writes `认领已确认` without revealing; agent retry then 201. `PUT /api/v1/me/settings` persists `users.trusted_automation` (default off). 受信自动化 on → autonomous claim 直通. Issue #16 comment overrides the body (and matches DESIGN §7): confirmation is autonomous-poll only.

Forge token reveal channels unchanged: REST claim 201 `token` and MCP `claim_task` success `token`. Events/stats/me/settings/confirmations/202 never contain it. `docs/DESIGN.md` untouched.

## Files Changed
Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16` on `workflow/bundle-15-16`. Tests by tdd-guide; production by implementer; docs by doc-updater.

## Test Coverage
`apps/server/src/events.test.ts` (9 `test(`) and `apps/web/src/App.audit.test.ts` (16 `it(`). `apps/server/src/claim-confirm.test.ts` (14 `test(`, of which 3 instructed/待批准 pins were green on the 637c304 baseline by design) and `apps/web/src/App.settings.test.ts` (8 `it(`). RED baselines in `.cache/tests-events-baseline.txt` and `.cache/tests-claim-confirm-baseline.txt`. Full `pnpm test` after implementation: node `--test` 502 pass / 0 fail, 110 suites; vitest 75 pass / 0 fail.

## Validation
verdict: pass
command: `CI=true pnpm lint && CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm build`
record: `kaola-workflow/bundle-15-16/.cache/final-validation.md`
validated_candidate_hash: `a60241decc5f8994f93a6154e5f5061c8e47ff5bc77be43c0fef416d5f6ae477`
tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16`

## Changed Paths
- `apps/server/src/events.ts` (added)
- `apps/server/src/events.test.ts` (added)
- `apps/server/src/claim-confirmations.ts` (added)
- `apps/server/src/claim-confirm.test.ts` (added)
- `apps/server/src/claim.ts`
- `apps/server/src/mcp.ts`
- `apps/server/src/auth.ts`
- `apps/server/src/db.ts`
- `apps/server/src/schema.ts`
- `apps/server/src/app.ts`
- `apps/web/src/App.vue`
- `apps/web/src/App.audit.test.ts` (added)
- `apps/web/src/App.settings.test.ts` (added)
- `package.json`
- `README.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `docs/api.md`
- `docs/architecture.md`

## Mission List
All items `done` in `kaola-workflow/bundle-15-16/mission-list.md`.

## Documentation Docking
DOCKED (`kaola-workflow/bundle-15-16/.cache/doc-docking.md`). DESIGN.md contracts untouched.

## Run gaps

## Follow-Up Items
Not filed (gap sweep `sweptClasses: []`). Security-review non-blocking notes (R1 client-supplied `autonomous` flag is the ruling; R2 uncapped events GET; R3 settings toggle writes no audit event) were explicit non-findings / deferred hardening, not seeded as run gaps.

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/bundle-15-16/.cache/doc-docking.md
- kaola-workflow/archive/bundle-15-16/.cache/doc-updater.md
- kaola-workflow/archive/bundle-15-16/.cache/final-validation.md
- kaola-workflow/archive/bundle-15-16/.cache/ground-truth.md
- kaola-workflow/archive/bundle-15-16/.cache/impl-claim-confirm.md
- kaola-workflow/archive/bundle-15-16/.cache/impl-events.md
- kaola-workflow/archive/bundle-15-16/.cache/orchestrator-rulings.md
- kaola-workflow/archive/bundle-15-16/.cache/origin/selection-record.json
- kaola-workflow/archive/bundle-15-16/.cache/run-gaps.json
- kaola-workflow/archive/bundle-15-16/.cache/sec-review.md
- kaola-workflow/archive/bundle-15-16/.cache/sink-meta.env
- kaola-workflow/archive/bundle-15-16/.cache/tests-audit-typecheck.md
- kaola-workflow/archive/bundle-15-16/.cache/tests-claim-confirm-baseline.txt
- kaola-workflow/archive/bundle-15-16/.cache/tests-claim-confirm.md
- kaola-workflow/archive/bundle-15-16/.cache/tests-events-baseline.txt
- kaola-workflow/archive/bundle-15-16/.cache/tests-events.md
- kaola-workflow/archive/bundle-15-16/finalization-summary.md
- kaola-workflow/archive/bundle-15-16/mission-list.md
- kaola-workflow/archive/bundle-15-16/workflow-state.md
