# Finalization — Summary: issue-19

## Delivered
Publish-import for GitHub issue #19. After a credential profile exists, the 发布 pane picks the archive (label `{forge} {repo_full_name}`) and an open Issue (`#{number} {title}`), then uses the existing 导入 preview and 发布. Forge / base_url / repo are not re-typed on the profile path; GitLab `/-/work_items/…` is not pasted. Inline token still pastes an Issue URL.

`@kaola/forge-adapters` `listIssues(cred, repo)` returns `ListedIssue[]` `{ number, title, issue_url }`. Fetch origin matches `importIssue` (GitHub `https://api.github.com`; GitLab/Gitea constructor `baseUrl`). `issue_url` is built from `repo.base_url` (GitLab `iid` → `/-/issues/{iid}`); GitHub drops `pull_request`. `@kaola/server` `GET /api/v1/credential-profiles/:id/issues` (session `active`+`full`) decrypts server-side; `502` message is `无法连接 forge 列出 Issue。`; does not write `token 揭示`; not a third reveal channel. POST `/import` and POST `/tasks` bodies unchanged.

## Files Changed
Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-19` on `workflow/issue-19`. Tests by tdd-guide; production by implementer; docs by doc-updater then inline docking (catalog `copied` this session, no named re-dispatch).

## Test Coverage
- `packages/forge-adapters/src/list-issues.shared.test.ts` (25 `it`, three forges)
- `apps/server/src/credential-profile-issues.test.ts` (13 `test`)
- `apps/web/src/App.form.test.ts` (#19 picker describe; helpers switch to inline before filling repo)
RED baselines in `.cache/tests-list-issues-baseline.txt`, `.cache/tests-profile-issues-baseline.txt`, `.cache/tests-publish-picker-baseline.txt`.
Finalize-time `pnpm test`: node `--test` 540 pass / 0 fail, 119 suites; vitest 93 pass / 0 fail.

## Validation
verdict: pass
command: `pnpm test && pnpm lint && pnpm typecheck && pnpm build`
record: `kaola-workflow/issue-19/.cache/final-validation.md`
validated_candidate_hash: `374103bc027a74e271bb69992d91fa9936c301efcab4d53cdab6a5ea5727ef54`
tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-19`

Reuse boundary: lint/typecheck/test/build were re-run on this candidate (including the CHANGELOG measured-count prefix). Security review (`sec-review.md`) covered uncommitted production vs `41e1e01` before that prefix; no production files changed after the review.

## Changed Paths
- `packages/forge-adapters/src/index.ts`
- `packages/forge-adapters/src/list-issues.shared.test.ts` (added)
- `apps/server/src/credential-profiles.ts`
- `apps/server/src/credential-profile-issues.test.ts` (added)
- `apps/web/src/App.vue`
- `apps/web/src/App.form.test.ts`
- `package.json`
- `docs/DESIGN.md`
- `docs/api.md`
- `docs/architecture.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `README.md`

## Mission List
All items `done` in `kaola-workflow/issue-19/mission-list.md`.

## Documentation Docking
DOCKED (`kaola-workflow/issue-19/.cache/doc-docking.md`). DESIGN.md §7 §8 updated as the #19 contract, not as scaffolding.

## Run gaps

## Follow-Up Items
Not filed (gap sweep `sweptClasses: []`). Live OAuth browser smoke of 选档案 → 选 Issue → 导入 → 发布 was not run (needs 配合 login); covered by vitest `App.form.test.ts`. Security-review residuals (inner-circle GitLab/Gitea `baseUrl`, `forgeGet` redirect follow) are pre-existing, not seeded as run gaps.

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-19/.cache/doc-docking.md
- kaola-workflow/archive/issue-19/.cache/doc-updater.md
- kaola-workflow/archive/issue-19/.cache/final-validation.md
- kaola-workflow/archive/issue-19/.cache/forge-list-issues-apis.md
- kaola-workflow/archive/issue-19/.cache/ground-truth.md
- kaola-workflow/archive/issue-19/.cache/impl-list-issues.md
- kaola-workflow/archive/issue-19/.cache/impl-profile-issues.md
- kaola-workflow/archive/issue-19/.cache/impl-publish-picker.md
- kaola-workflow/archive/issue-19/.cache/origin/selection-record.json
- kaola-workflow/archive/issue-19/.cache/run-gaps.json
- kaola-workflow/archive/issue-19/.cache/sec-review.md
- kaola-workflow/archive/issue-19/.cache/tests-list-issues-baseline.txt
- kaola-workflow/archive/issue-19/.cache/tests-profile-issues-baseline.txt
- kaola-workflow/archive/issue-19/.cache/tests-publish-picker-baseline.txt
- kaola-workflow/archive/issue-19/finalization-summary.md
- kaola-workflow/archive/issue-19/mission-list.md
- kaola-workflow/archive/issue-19/workflow-state.md
