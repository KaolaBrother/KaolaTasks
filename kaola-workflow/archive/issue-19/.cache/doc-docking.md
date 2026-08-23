# Documentation docking — issue-19

Changed files reviewed (worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-19`):

- Production: `packages/forge-adapters/src/index.ts` (`ListedIssue`, `listIssues`), `apps/server/src/credential-profiles.ts` (`GET /api/v1/credential-profiles/:id/issues`), `apps/web/src/App.vue` (profile/Issue pickers)
- Tests: `packages/forge-adapters/src/list-issues.shared.test.ts` (new), `apps/server/src/credential-profile-issues.test.ts` (new), `apps/web/src/App.form.test.ts`, root `package.json` test list
- Docs: `docs/DESIGN.md` §7 §8, `docs/api.md`, `docs/architecture.md`, `CHANGELOG.md`, `CLAUDE.md`, `README.md`

Documents checked:

- Issue #19 body (comments: only the workflow start marker; design is the body). Adapter `listIssues` / `ListedIssue`, GET issues, publish pickers, 502 「无法连接 forge 列出 Issue。」, not a third reveal channel, POST `/import` and POST `/tasks` unchanged.
- `docs/DESIGN.md` §7 §8 — contract written before code (mission order).
- `docs/api.md` — GET subsection + adapter `listIssues` URLs/query/`iid`/`pull_request`/`issue_url` from `repo.base_url`; 502/422 copy matches `LIST_FORGE_UNREACHABLE_MESSAGE` / `LIST_TOKEN_INVALID_MESSAGE` in `credential-profiles.ts`.
- `docs/architecture.md` — ASCII map GET issues; adapter method list includes `listIssues`.
- `CHANGELOG.md` Unreleased `#19` — files, 502 string, measured 540+93.
- `CLAUDE.md` snapshot + Commands `pnpm test` string byte-equal to root `package.json` `"test"`.
- `README.md` step 3 — profile dropdown vs inline paste.
- `.env.example` — none in repo; no new process env. No-impact.
- `docs/conventions.md` — no HTTP route table. No-impact.
- `docs/README.md` — still points at api.md; no per-route index to extend. No-impact.

Gaps found and fixed: none in this docking pass. Step 4 named `doc-updater` was skipped (`kaola-workflow-ensure-cursor-catalog.js` returned `copied` this session); existing [doc-updater](4d34fdf5-4225-4cb2-9073-2fac73ce38a2) output was re-checked against source.

No-impact reasons:

- `.env.example`: file does not exist; no new env vars.
- `docs/conventions.md`: no route table.
- MCP / Task Brief / claim reveal: unchanged by design.
- POST `/api/v1/tasks` and POST `/api/v1/tasks/import` request bodies: unchanged.

Verdict: DOCKED
