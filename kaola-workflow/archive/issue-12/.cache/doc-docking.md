# DOCKED — issue #12 docs (not finalization)

Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12` (`workflow/issue-12`).  
`docs/DESIGN.md` untouched (`git diff --name-only -- docs/DESIGN.md` empty).  
Codemaps skipped: no `scripts/codemaps/`, no `docs/CODEMAPS/`.

## Checklist

- [x] **README.md** — #12 listed as landed (三 forge `importIssue` → `POST /api/v1/tasks/import` 200 草稿, UI「导入内容」); #11 poller facts kept; webhook / `commentOnIssue` still 尚未实现; `pnpm test` file list includes `import-issue.shared.test.ts` and `import.test.ts`; import 200 never contains a forge token; claim `201` `token` + MCP `claim_task` remain the only reveal channels.
- [x] **CHANGELOG.md** — three #12 Unreleased bullets **above** #11; adapter / HTTP error table / UI 导入内容; measured this run (`CI=true`): lint/typecheck/test/build exit 0; node 396 pass / 0 fail, suites 79; vitest 51 passed; `index-MeXOcpNK.js` 1,465.50 kB gzip 406.21 kB. Not copied from issue-11 archives.
- [x] **CLAUDE.md Commands** — `"test"` script matches root `package.json` exactly (new files after `get-pull-request.shared.test.ts`). Project Snapshot: `importIssue`, `parseIssueUrl`, typed `ImportedIssue`, `POST /api/v1/tasks/import` 200, remaining three methods `notImplemented`, poller facts kept.
- [x] **docs/api.md** — records implemented `POST /api/v1/tasks/import` (200 shape, no persist, no `validateToken`, never a token) and `importIssue` / `ImportedIssue` / `parseIssueUrl`; error table from `tasks.ts`; `registerWebhook`/`parseWebhook`/`commentOnIssue` still `not implemented`; still no webhook route; #11 `getPullRequest` / poller kept.
- [x] **docs/architecture.md** — tree + packages + web mention import draft + 导入内容; host rule = `getPullRequest`; poller still the only `待验收` driver.

Not claimed: issue close, archive, commit, or push.
