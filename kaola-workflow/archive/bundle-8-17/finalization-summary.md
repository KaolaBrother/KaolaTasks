# Finalization — Summary: bundle-8-17

## Delivered
M1 slice for issues #8 and #17.

**#8** Chinese task board on the member workbench: 列表/看板, six status columns, client-side filters (状态/标签/Forge), in-app detail, one synthetic 发布 timeline from `created_at`+`poster`. `GET /api/v1/tasks` exactly (no query, no events HTTP). Title/description are text interpolation; `javascript:` issue URLs are not `href`. `claim_only` sees the board, not the posting form. Pending users stay on 账号待批准.

**#17** Advertised origin `http://localhost:31415`. `buildApp({ sqlitePath?, webDist?, viteDevTarget? })`: naked `GET /` remains `考拉任务服务占位`; `webDist` serves SPA via `@fastify/static@^10.1.3` + SPA fallback; only `viteDevTarget` uses `@fastify/http-proxy@^11.6.0`. Root `pnpm dev` (`scripts/dev.mjs`) occupies 31415 with loopback Vite. Docker `31415:31415`, image builds web dist and sets `WEB_DIST`. MCP and claim unchanged (unimplemented).

## Files Changed
Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17` on `workflow/bundle-8-17`. Tests by tdd-guide; production by implementer; docs by doc-updater.

## Test Coverage
`apps/web/src/App.board.test.ts` (17) + existing `App.form.test.ts` (27). `apps/server/src/hosting.test.ts` (9). Full `pnpm test`: node `--test` 252 pass / 0 fail, 44 suites; vitest 44 pass / 0 fail.

## Validation
verdict: pass
command: `CI=true pnpm lint && CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm build`
record: `kaola-workflow/bundle-8-17/.cache/final-validation.md`
validated_candidate_hash: `0466f207ddadeb07c09aba7c9fba2a44789b4788976e6264a47aba5fddfff229`
tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17` after docs landed.

## Changed Paths
- `apps/web/src/App.vue`
- `apps/web/src/App.board.test.ts` (added)
- `apps/server/src/app.ts`
- `apps/server/src/index.ts`
- `apps/server/src/auth.ts`
- `apps/server/src/hosting.test.ts` (added)
- `apps/server/package.json`
- `apps/server/Dockerfile`
- `apps/web/vite.config.ts`
- `docker-compose.yml`
- `package.json`
- `pnpm-lock.yaml`
- `eslint.config.js`
- `scripts/dev.mjs` (added)
- `README.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `docs/api.md`
- `docs/architecture.md`

## Mission List
All items `done` in `kaola-workflow/bundle-8-17/mission-list.md`.

## Documentation Docking
DOCKED (`kaola-workflow/bundle-8-17/.cache/doc-docking.md`). DESIGN.md contracts untouched.

## Run gaps

## Follow-Up Items
Not filed (gap sweep `sweptClasses: []`). Carried in conversation, not a new issue:
- Issue #8 body lists timeline types 认领/心跳/提交/完结 that have no writers in this tree; they belong to #9 / #11.
- DESIGN §11 allows 待批准 to read the board API; the web pending card still has no board (pre-existing view split).

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/bundle-8-17/.cache/doc-docking.md
- kaola-workflow/archive/bundle-8-17/.cache/doc-updater.md
- kaola-workflow/archive/bundle-8-17/.cache/fastify-hosting-plugins.md
- kaola-workflow/archive/bundle-8-17/.cache/final-validation.md
- kaola-workflow/archive/bundle-8-17/.cache/ground-truth-board.md
- kaola-workflow/archive/bundle-8-17/.cache/ground-truth-hosting.md
- kaola-workflow/archive/bundle-8-17/.cache/impl-board.md
- kaola-workflow/archive/bundle-8-17/.cache/impl-hosting.md
- kaola-workflow/archive/bundle-8-17/.cache/orchestrator-rulings.md
- kaola-workflow/archive/bundle-8-17/.cache/origin/selection-record.json
- kaola-workflow/archive/bundle-8-17/.cache/run-gaps.json
- kaola-workflow/archive/bundle-8-17/.cache/sec-review.md
- kaola-workflow/archive/bundle-8-17/.cache/tests-board-baseline.txt
- kaola-workflow/archive/bundle-8-17/.cache/tests-board.md
- kaola-workflow/archive/bundle-8-17/.cache/tests-hosting-baseline.txt
- kaola-workflow/archive/bundle-8-17/.cache/tests-hosting.md
- kaola-workflow/archive/bundle-8-17/finalization-summary.md
- kaola-workflow/archive/bundle-8-17/mission-list.md
- kaola-workflow/archive/bundle-8-17/workflow-state.md
