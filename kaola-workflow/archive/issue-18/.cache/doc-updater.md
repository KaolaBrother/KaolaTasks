# doc-updater report — issue #18 (Eucalyptus Ink four-pane shell)

Role: Kaola workflow **doc-updater (standard tier)**  
Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18`  
Cache report (this file): `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-18/.cache/doc-updater.md`  
Did **not** commit. Did **not** edit the main checkout except this cache path. Did **not** invent `scripts/codemaps/` or `docs/CODEMAPS/`.

## Detection

- `scripts/codemaps/`: **absent** in worktree — skipped (do not invent).
- `docs/CODEMAPS/`: **absent** in worktree — skipped (do not invent).
- Reconciled declared doc surfaces against worktree source (App.vue / theme.ts / theme.css / App.shell.test.ts / apps/web/package.json / vite.config.ts).

## Files touched (worktree)

1. `CHANGELOG.md` — Unreleased `@kaola/web` (#18) bullet.
2. `README.md` — status / landed list / 任务看板 + 工作台四栏壳层 / 首次使用 / 项目结构 / 已落地段落.
3. `CLAUDE.md` — Project Snapshot `@kaola/web` sentence; Commands test line adds `App.shell.test.ts`.
4. `docs/architecture.md` — `@kaola/web` tree lines; `App.vue` Web paragraph; tests list.
5. `docs/api.md` — PATCH section: one sentence that web poster detail now calls the **existing** route.

## Files skipped (with reason)

- `docs/DESIGN.md` — **untouched** (contracts). `git status --porcelain -- docs/DESIGN.md` empty; `git diff --stat` did not list it.
- `docs/README.md` — index links only; no workbench layout to update.
- `docs/conventions.md` — no workbench layout.
- `.env.example` — does not exist (already recorded in api.md).
- Root `package.json` test script — web tests already `pnpm --filter @kaola/web test`; vitest `include` is `src/**/*.test.ts`, so `App.shell.test.ts` is picked up without listing the file individually.
- Any `*.test.ts` / production `.vue` / `.ts` / `.css` — docs only, as instructed.
- HTTP/MCP/server wire contracts — PATCH already existed; only noted that the **web UI now calls it**.

## Claims transcribed (source → docs)

Every fact below was read from the worktree, not invented.

### Four-pane shell, no vue-router

| Claim | Source |
|---|---|
| Member shell nav labels 看板 / 发布 / 钥匙 / 审计 | `apps/web/src/App.vue:840-851` (`navItems`: `{ id: 'board', label: '看板' }`, publish `'发布'` if `canApprove`, `'钥匙'`, `'审计'`) |
| `WorkbenchPane = 'board' \| 'publish' \| 'keys' \| 'audit'` | `App.vue:706` |
| Panes use `v-show` (publish also `v-if="canApprove"`) | `App.vue:74` board; `App.vue:228-229` publish; `App.vue:385` keys; `App.vue:530` audit |
| Header 「工作台」 when `view === 'member'` | `App.vue:8` |
| No vue-router; deps are vue + naive-ui only | `apps/web/package.json:13-16` (`"vue": "^3.5.0"`, `"naive-ui": "^2.45.0"`); no `vue-router` key |

### `claim_only` gates

| Claim | Source |
|---|---|
| `canApprove` = `status === 'active'` AND `permission_level === 'full'` | `App.vue:822-824` |
| Publish nav omitted unless `canApprove` | `App.vue:844-846` |
| Publish pane not in DOM unless `canApprove` | `App.vue:228` `v-if="canApprove"` |
| 凭证档案 gated by `canApprove` | `App.vue:463-464` |
| `claim_only` label 「仅认领」 | `App.vue:828-830` |
| Leaving `full` while on publish snaps pane back to board | `App.vue:965-967` |

### Form groups + `<details>` 高级

| Claim | Source |
|---|---|
| `task-group-task` | `App.vue:235` |
| `task-group-repo` | `App.vue:268` |
| `<details data-testid="task-group-advanced">` / `<summary>高级</summary>` | `App.vue:278-280` |
| `task-group-acceptance` | `App.vue:292` |
| `task-group-credential` | `App.vue:332` |
| Advanced closed by default (HTML details, no `open`) | `App.vue:278`; asserted `App.shell.test.ts:397-401` |

### Credential `base_url` prefills

| Claim | Source |
|---|---|
| github → `https://github.com`; gitlab → `https://gitlab.com`; else `''` (gitea) | `App.vue:943-947` `defaultBaseUrl` |
| Applied to profile + task forge watches; non-empty current value kept | `App.vue:949-963` |
| Same behavior pinned in tests | `App.shell.test.ts:418-443` |

### Poster PATCH UI (existing route)

| Claim | Source |
|---|---|
| Buttons 「取消」 / 「重新开放」 | `App.vue:190-204` (`board-detail-cancel` / `board-detail-reopen`) |
| Cancel when poster+full and status 待认领 or 已退回 | `App.vue:900-907` `canPosterCancel` |
| Reopen when poster+full and status 已退回 | `App.vue:909-916` `canPosterReopen` |
| `PATCH /api/v1/tasks/${task.id}` body `{ status }` (`'已取消'` \| `'待认领'`) | `App.vue:1456-1466` |
| No new HTTP routes; wire contract unchanged | `docs/api.md` PATCH section was already present; only a web-caller sentence was added |
| No Agent claim UI / no logout testid | `App.shell.test.ts:329-331` `expectNoClaimOrLogout`; App.vue has no `board-detail-claim` |

### Eucalyptus Ink tokens + 768px

| Claim | Source |
|---|---|
| Paper `#F3F6F4` | `apps/web/src/theme.ts:3` (`paper`) / `:17` (`--paper`) |
| Ink `#1C2420` | `theme.ts:4` / `:18` |
| Leaf `#3D6B54` | `theme.ts:5` / `:19` |
| Bark `#6B746F` | `theme.ts:8` / `:20` |
| Slip `#FFFEFB` | `theme.ts:9` / `:21` |
| Clay `#B4532A` | `theme.ts:10` / `:22` |
| Comment names the palette 「Eucalyptus Ink」 | `theme.ts:15` |
| `themeOverrides` exported and bound on `n-config-provider` | `theme.ts:57`; `App.vue:3`, `App.vue:640` |
| `theme.css` imported from App.vue | `App.vue:639`, `App.vue:1682` |
| Narrow breakpoint `@media (max-width: 768px)` (nav row, stacked workbench) | `apps/web/src/theme.css:555-618` |

### Tests

| Claim | Source |
|---|---|
| `App.shell.test.ts` exists; **11** `it(` | `apps/web/src/App.shell.test.ts` lines 342, 364, 376, 388, 397, 408, 418, 433, 447, 494, 519 |
| vitest `include` already `src/**/*.test.ts` | `apps/web/vite.config.ts:12-14` |
| Root web test invocation is `pnpm --filter @kaola/web test` | worktree `package.json` (unchanged by this pass); `CLAUDE.md` Commands line |

### Token reveal (unchanged)

| Claim | Source |
|---|---|
| Reveal still REST claim 201 top-level `token` + MCP `claim_task` | Restated from existing docs + App.vue `patchTaskStatus` never returning a token; no new reveal route invented |

## DESIGN.md

**Untouched.** No edit, no contract change. Confirmed by `git status --porcelain -- docs/DESIGN.md` (empty) in the worktree.

## Commands run

```
git diff --stat -- CHANGELOG.md README.md CLAUDE.md docs/architecture.md docs/api.md docs/README.md docs/DESIGN.md
# CHANGELOG.md | 1 +; CLAUDE.md | 4 ++--; README.md | 15 ++++++++-------;
# docs/api.md | 2 +-; docs/architecture.md | 9 ++++++---
# 5 files changed, 18 insertions(+), 13 deletions(-)

git status --porcelain -- docs/DESIGN.md
# (empty)

# it( count: 11 sites listed above from Read of App.shell.test.ts
```

No `pnpm test` / lint / build in this pass (docs-only transcription).

## Output contract

Updated docs vs source as listed. Skipped surfaces listed with reasons. Result landed in the five worktree files above plus this cache report.
