# doc-updater report — issue #2 Task Brief schema / state machine

**Verdict:** DOCKED  
**Date:** 2026-08-20  
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2`

Detection: no `scripts/` directory, no `scripts/codemaps/`, no `docs/CODEMAPS/`. Did not invent that tree. Reconciled declared doc surfaces against the measured `@kaola/shared` export surface. Did not edit `docs/DESIGN.md`, tests, or production `.ts`.

## Commands / reads

```
list_dir worktree root, docs/, docs/decisions/, scripts/ (missing)
read packages/shared/src/index.ts          # public exports
read packages/shared/package.json          # zod ^4.4.3, exports "." → ./src/index.ts
read packages/shared/src/index.test.ts     # DESIGN.md §6 example pin
read packages/forge-adapters/src/index.ts  # getForgeAdaptersHealth only
read apps/server/src/placeholder.ts        # GET / body
read package.json                          # test command unchanged
read pnpm-lock.yaml (packages/shared zod)  # specifier ^4.4.3, version 4.4.3
read README.md CHANGELOG.md CLAUDE.md docs/{architecture,api,conventions,README,DESIGN}.md
read kaola-workflow/issue-2/.cache/final-validation.md
grep zod in pnpm-lock.yaml
grep parseTaskBrief / DESIGN.md §6 in index.test.ts
```

Did not re-run `pnpm lint/typecheck/test/build` in this session. Those were measured 2026-08-20 in this worktree (`kaola-workflow/issue-2/.cache/final-validation.md`): lint 0, typecheck 0 (4 packages), test 0 (89 pass / 0 fail), build 0. Test command still `node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts apps/server/src/placeholder.test.ts`.

Did not run `npx tsx scripts/codemaps/generate.ts` (no such script).

## Files changed (worktree)

### `README.md`

| Sentence / clause | Measured fact | Source |
|-------------------|---------------|--------|
| Status: `@kaola/shared` 已导出任务卡 schema 与状态机 | `taskBriefSchema`, `parseTaskBrief`, `transitionTaskStatus` exported | `packages/shared/src/index.ts` |
| Status: HTTP 仍为占位 | `getPlaceholderBody()` → `考拉任务服务占位` | `apps/server/src/placeholder.ts` |
| Status: 登录 / MCP / 看板尚未实现 | no OAuth/MCP/board in tree (unchanged) | tree vs DESIGN §9; issue brief |
| Structure comment: 任务卡 zod schema + 状态机；`getSharedHealth()` → `kaola-shared-ready` | both schema/state machine and health exist | `packages/shared/src/index.ts` lines 2–4, 18–78 |
| Paragraph: exports `taskBriefSchema` / `parseTaskBrief` / `transitionTaskStatus`; keeps `getSharedHealth()` → `kaola-shared-ready` | public exports | same file |
| Paragraph: 依赖 `zod` `^4.4.3` | `"zod": "^4.4.3"` | `packages/shared/package.json`; lockfile `version: 4.4.3` |
| Paragraph: forge-adapters 仍只有健康检查占位 `getForgeAdaptersHealth()` → `kaola-forge-adapters-ready` | single export | `packages/forge-adapters/src/index.ts` |
| Roadmap: issue #1 脚手架与 issue #2 schema/状态机已落地（`@kaola/shared`） | diff vs `eb479691…` is shared schema only | `final-validation.md` diff; `index.ts` |
| Roadmap: 登录 / MCP / 看板仍未实现 | unchanged product surface | tree |

Replaced the false claims “只有健康检查占位导出，没有任务卡 schema、状态机” and “issue #2 … 尚未实现”.

### `CHANGELOG.md`

| Sentence / clause | Measured fact | Source |
|-------------------|---------------|--------|
| New Unreleased bullet: Task Brief zod schema exports `taskStatusSchema`, `type TaskStatus`, `taskBriefSchema`, `type TaskBrief`, `parseTaskBrief` and `transitionTaskStatus` | those are the actual exports | `packages/shared/src/index.ts` |
| matching DESIGN.md §5–§6 | DESIGN headings exist; implementation follows those enums/edges/fields | `docs/DESIGN.md` §5–§6; `index.ts` |
| `getSharedHealth()` still returns `kaola-shared-ready` | unchanged function | `index.ts` lines 3–5 |
| Dependency `zod` `^4.4.3` (lockfile `zod@4.4.3`) | package.json + lockfile | `packages/shared/package.json`; `pnpm-lock.yaml` |
| DESIGN.md §6 example still parses (tests pin it) | test title + `designExample()` | `packages/shared/src/index.test.ts` lines 56–107 |
| HTTP `GET /`, MCP, and `@kaola/forge-adapters` unchanged | placeholder body; adapters health-only | `placeholder.ts`; `forge-adapters/src/index.ts` |
| Kept existing M0 scaffold bullet | it does not claim shared is health-only; health export still exists | previous CHANGELOG |

Did not invent a version number.

### `CLAUDE.md` (Project Snapshot only)

| Sentence / clause | Measured fact | Source |
|-------------------|---------------|--------|
| Dropped “package shells only” / “schema, MCP, and adapters are not implemented” | schema is implemented | `packages/shared/src/index.ts` |
| `@kaola/shared` implements Task Brief zod schema (`taskBriefSchema` / `parseTaskBrief`) and `transitionTaskStatus` | exports | same |
| MCP and adapters are not implemented | adapters still health-only; no MCP server | `packages/forge-adapters/src/index.ts`; tree |
| Health strings and `GET /` body unchanged | same as M0 | `index.ts`; `placeholder.ts` |

Commands section not edited: `pnpm test` file list is still the three paths in root `package.json`.

### `docs/architecture.md`

| Sentence / clause | Measured fact | Source |
|-------------------|---------------|--------|
| M0 tree members | workspace layout | `pnpm-workspace.yaml` / listing |
| HTTP, MCP, forge adapters unimplemented; `GET /` body `考拉任务服务占位`; adapters only `getForgeAdaptersHealth()` | measured placeholders | `placeholder.ts`; `forge-adapters/src/index.ts` |
| no product HTTP/MCP public API yet | no MCP/REST task routes | tree vs DESIGN §9 |
| `@kaola/shared` implements Task Brief schema and transitions from DESIGN.md §5–§6 (`taskBriefSchema` / `parseTaskBrief`, `transitionTaskStatus`) | exports + DESIGN headings | `index.ts`; DESIGN.md |
| Legal edges: 待认领 → 进行中, 已取消; 进行中 → 待认领, 待验收; 待验收 → 已完成, 已退回; 已退回 → 待认领, 已取消 | `LEGAL_TRANSITIONS` Map | `packages/shared/src/index.ts` lines 65–70 |

### `docs/api.md`

| Sentence / clause | Measured fact | Source |
|-------------------|---------------|--------|
| HTTP/MCP unimplemented; `GET /` body `考拉任务服务占位`; no MCP tools | placeholders | `placeholder.ts`; tree |
| `@kaola/forge-adapters` still only `getForgeAdaptersHealth()` | single export | `forge-adapters/src/index.ts` |
| package export `"."` → `./src/index.ts` | `"exports"` | `packages/shared/package.json` |
| Export list: `getSharedHealth`, `taskStatusSchema` enum of six Chinese labels, `type TaskStatus`, `taskBriefSchema` `z.strictObject`, `type TaskBrief`, `parseTaskBrief(input: unknown): TaskBrief` via `.parse`, `transitionTaskStatus(from, to): string` legal → `to` else throw | quoted from source | `packages/shared/src/index.ts` |
| Keys, discriminated `source`, `repo` fields, arrays, `credential.profile_id` only, `priority` P0–P3, `created_at` `z.iso.datetime({ offset: true })` | `taskBriefSchema` object | same, lines 18–57 |
| Legal transition edges | `LEGAL_TRANSITIONS` | same, lines 65–70 |
| DESIGN.md §6 example still parses | test `parseTaskBrief accepts the DESIGN.md §6 Task Brief example…` | `index.test.ts` line 102 |
| Did not duplicate DESIGN.md JSON example | instruction | — |
| Dependency `zod` `^4.4.3` | package.json | `packages/shared/package.json` |

## Surfaces skipped (with reason)

| Surface | Reason |
|---------|--------|
| `docs/DESIGN.md` | Instructed not to change contracts. §5/§6 already match the implemented labels, edges, and fields. |
| `CLAUDE.md` Commands | Test/lint/typecheck/build/dev commands and the three test-file list are still true in root `package.json`. |
| `docs/conventions.md` | “Lifecycle state enum labels use the Chinese names from DESIGN.md §5” is still true; no false sentence. |
| `docs/README.md` | Index still matches files that exist; no new doc file added. |
| `docs/decisions/` | Empty; nothing to reconcile. |
| `.env.example` | Does not exist; OAuth/main key still unimplemented. Did not create one. |
| `docs/CODEMAPS/` / `scripts/codemaps/` | Neither exists; not invented. |
| Test files / production `.ts` | Instructed not to edit. |
| README “核心特性 … M0 **尚未实现**” | Those product features (board, MCP, forge adapters, credentials UI) are still unimplemented. |
| README “首次使用 / 发布 / 认领 … 无登录、无 Agent Key、无 MCP 端点、无任务卡” | Product usage flow still has no login/MCP/board/task HTTP. “无任务卡” here means no post/claim surface, not the library schema. Left as-is. |
| README 开发 command list | Unchanged measured scripts. |
| CHANGELOG M0 scaffold bullet | Does not claim shared is health-only; health export still exists. New bullet covers schema. |

## Not claimed

- MCP, OAuth, kanban, forge adapter implementations.
- HTTP task/REST/MCP tools.
- A version number for this change.
- Re-running lint/test/build in this session (used `final-validation.md`).
- Invented schema fields, enum values, or example numbers. Field list transcribed from `taskBriefSchema` keys only.
- Codemap tree.

## Result landing

Doc edits: worktree paths listed above.  
This record: `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-2/.cache/doc-updater.md`  
Docking notes: `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-2/.cache/doc-docking.md`
