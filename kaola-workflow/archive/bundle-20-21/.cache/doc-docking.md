# Doc docking — #20 / #21

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`  
Date: 2026-08-23  
No commit. No `pnpm lint` / `pnpm test` / `pnpm build` this pass (do not invent counts).

## Detection

- No `scripts/codemaps/` and no `docs/CODEMAPS/` in the worktree → did not invent codemaps.

## Measured sources (transcribed, not invented)

- `apps/server/src/claim.ts` ~216–232 / `ClaimSuccessBody.clone`: keys `suggested_dir`, `token_usage`, `remote_url`, `extra_header`. `remote_url` = `brief.repo.base_url.replace(/\/+$/u, '')` + `/` + `full_name` + `.git`. `extra_header`: forge `gitea` → `{ name: 'Authorization', value_pattern: 'token ${token}' }`, else `{ name: 'Authorization', value_pattern: 'Bearer ${token}' }`.
- `apps/web/src/App.vue`: no `task-group-acceptance`. `task-import-card` under `v-if="showImportedIssueCard"` after import 200. `createTask` `JSON.stringify({ title, description_md, source, repo, credential })`.
- `apps/web/src/App.form.test.ts` omitted POST extras: `acceptance_criteria`, `test_command`, `constraints`, `priority`, `tags`.
- Cache: `kaola-workflow/bundle-20-21/.cache/impl-20.md`, `impl-21.md` (read only).

## Changed

1. **`CHANGELOG.md` (worktree)** — Unreleased: prepended two short bullets `#20` (REST+MCP clone four keys + extra_header table) and `#21` (read-only import card; omitted extra POST keys). No lint/test counts.

2. **`CLAUDE.md` Project Snapshot (worktree)** — replaced stale clauses only:
   - claim HTTP: four-key `clone` (gitea `token ${token}` else `Bearer ${token}`; `remote_url` strip trailing slashes); `202` omits clone. Snapshot previously had **no** clone keys (not a two-key sentence).
   - 发布 pane: credential→repo→task; no `task-group-acceptance`; `task-import-card` after import 200; POST JSON five keys omitting extras.
   - imported form: 导入 button → `POST /import`; 导入内容 only on the card after 200.

3. **`docs/smoke-test.md` (worktree)** — step 13 expected `clone.remote_url` + `clone.extra_header` (status still 未做). Stopped treating #20/#21 as “next round”. Pit now uses four-key clone. Did not mark any smoke step done.

4. **`docs/DESIGN.md` (worktree)** — 「无账号认领者」 duplicate extra_header table collapsed to `见上表` (identical to the table under 「Agent 侧 token 卫生」). Pointer `（下表）` → `（见上表）`. **Did not change §6 Task Brief JSON keys.**

5. **`README.md` (worktree)** — one lie vs #21 UI: 「填标题、说明、验收标准等」 / 「点导入带出标题和正文」. Replaced with native title/description vs import 200 read-only card; extras not collected. Rest of README clone paragraph already four-key.

## Skipped (with reason)

| Surface | Reason |
|---------|--------|
| `docs/api.md` | Already four-key `clone` + extra_header table; POST `/tasks/import` shape left untouched as instructed. |
| `docs/DESIGN.md` §6 Task Brief JSON | Instructed not to change. |
| `docs/architecture.md` | Silent on two-key clone and on collecting extra form fields (`form groups + 高级` only). Skip if already silent. |
| `docs/README.md`, `docs/conventions.md`, `docs/decisions/` | No #20/#21 contract text to dock. |
| Root `CLAUDE.md` Commands / test file list | No new test files in the root `pnpm test` string this docking. |
| Codemaps | Tooling absent. |
| `impl-20.md` / `impl-21.md` | Inputs, not edited. |
| Smoke step statuses (配合/未做) | Not re-run. |
| Lint/test/build counts in CHANGELOG | Later filled from measured `pnpm lint && pnpm typecheck && pnpm test` (545 node / 95 vitest). |

## Commands run this session

- Glob: `scripts/codemaps/**`, `docs/CODEMAPS/**` (0 hits).
- Read/grep on worktree `claim.ts`, `App.vue`, DESIGN/api/README/CHANGELOG/CLAUDE/smoke/architecture, impl caches.
- Python: extract CLAUDE.md needles; surgical CLAUDE.md string replace.

Result landed in the worktree paths listed under Changed, plus this file:
`kaola-workflow/bundle-20-21/.cache/doc-docking.md`

Also docked after implementation: `docs/api.md` (four-key clone, already true vs `claim.ts`); `OAuth2Decorator` 2-arg PKCE type in `auth.ts` (typecheck only, not an issue contract).

verdict: DOCKED
