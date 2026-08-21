# Finalization — Summary: issue-12

## Delivered
M2 slice for issue #12.

Three-forge `importIssue` maps an Issue web URL to a typed `ImportedIssue` (`title`, `description_md`, `issue_url`, `repo.full_name`). Host rule matches `getPullRequest`: GitHub REST origin is always `https://api.github.com`; GitLab/Gitea use constructor `baseUrl`, never the pasted host. `POST /api/v1/tasks/import` is a pre-publish draft: session `active`+`full`, parse-before-decrypt, success **200** (no `tasks` row, no `validateToken`, never a token). The publish form's 导入 button fills the draft; 发布 still goes through existing `POST /api/v1/tasks` 发布即校验. UI 来源标记 text is exactly `导入内容` on the form and on board detail for `source.type === 'imported'`. Package export `parseIssueUrl`. `registerWebhook` / `parseWebhook` / `commentOnIssue` stay `notImplemented`. No webhook (#13). No write-back (#14). `docs/DESIGN.md` untouched.

## Files Changed
Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12` on `workflow/issue-12`. Tests by tdd-guide; production by implementer; docs by doc-updater.

## Test Coverage
`packages/forge-adapters/src/import-issue.shared.test.ts` (`it(` 19 source lines, 39 runtime cases across three forges) and `apps/server/src/import.test.ts` (24 `test(`). Web: +6 form / +1 board. Full `pnpm test`: node `--test` 396 pass / 0 fail, 79 suites; vitest 51 pass / 0 fail.

## Validation
verdict: pass
command: `CI=true pnpm lint && CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm build`
record: `kaola-workflow/issue-12/.cache/final-validation.md`
validated_candidate_hash: `49b805d388fcf3ec00fec563c85017c49de0af8c7d86fa24464bd68c98e50796`
tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12` after docs landed.

## Changed Paths
- `packages/forge-adapters/src/index.ts`
- `packages/forge-adapters/src/import-issue.shared.test.ts` (added)
- `apps/server/src/tasks.ts`
- `apps/server/src/import.test.ts` (added)
- `apps/web/src/App.vue`
- `apps/web/src/App.form.test.ts`
- `apps/web/src/App.board.test.ts`
- `package.json`
- `README.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `docs/api.md`
- `docs/architecture.md`

## Mission List
All items `done` in `kaola-workflow/issue-12/mission-list.md`.

## Documentation Docking
DOCKED (`kaola-workflow/issue-12/.cache/doc-docking.md`). DESIGN.md contracts untouched.

## Run gaps

## Follow-Up Items
Not filed (gap sweep `sweptClasses: []`).

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-12/.cache/doc-docking.md
- kaola-workflow/archive/issue-12/.cache/doc-updater.md
- kaola-workflow/archive/issue-12/.cache/final-validation.md
- kaola-workflow/archive/issue-12/.cache/forge-issue-apis.md
- kaola-workflow/archive/issue-12/.cache/ground-truth.md
- kaola-workflow/archive/issue-12/.cache/impl-import.md
- kaola-workflow/archive/issue-12/.cache/orchestrator-rulings.md
- kaola-workflow/archive/issue-12/.cache/origin/selection-record.json
- kaola-workflow/archive/issue-12/.cache/run-gaps.json
- kaola-workflow/archive/issue-12/.cache/sec-review.md
- kaola-workflow/archive/issue-12/.cache/tests-import-baseline.txt
- kaola-workflow/archive/issue-12/.cache/tests-import.md
- kaola-workflow/archive/issue-12/finalization-summary.md
- kaola-workflow/archive/issue-12/mission-list.md
- kaola-workflow/archive/issue-12/workflow-state.md
