# Doc docking — issue #2

**Verdict:** DOCKED  
**Date:** 2026-08-20  
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2`

Docs now match the measured `@kaola/shared` Task Brief schema + `transitionTaskStatus` surface. Product HTTP/MCP/adapters remain placeholders. `docs/DESIGN.md` contracts were not edited.

Detection: no `scripts/codemaps/`, no `docs/CODEMAPS/` — not invented.

## Docked against

| Fact | Source | Now in |
|------|--------|--------|
| `getSharedHealth(): string` → `'kaola-shared-ready'` | `packages/shared/src/index.ts` | README 项目结构, CHANGELOG, CLAUDE Snapshot, docs/api.md |
| `taskStatusSchema` = `z.enum(['待认领','进行中','待验收','已完成','已退回','已取消'])`; `type TaskStatus` | `packages/shared/src/index.ts` | docs/api.md, CHANGELOG |
| `taskBriefSchema` `z.strictObject`; `type TaskBrief`; `parseTaskBrief(input: unknown): TaskBrief` = `.parse` (throws on invalid) | same | README, CHANGELOG, CLAUDE Snapshot, docs/api.md, docs/architecture.md |
| `transitionTaskStatus(from, to): string` — legal edges return `to`, else throw | same `LEGAL_TRANSITIONS` Map | README, CHANGELOG, CLAUDE Snapshot, docs/api.md, docs/architecture.md |
| Legal edges: 待认领 → 进行中, 已取消; 进行中 → 待认领, 待验收; 待验收 → 已完成, 已退回; 已退回 → 待认领, 已取消 | `index.ts` lines 65–70 | docs/architecture.md, docs/api.md |
| Schema keys: id, title, description_md, source, repo, acceptance_criteria, test_command, constraints, pr_convention, credential, priority, tags, poster, status, created_at | `taskBriefSchema` | docs/api.md only (no JSON example) |
| `source` native (type only) \| imported (type + issue_url); `repo.forge` github\|gitlab\|gitea; credential `{ profile_id }` only; priority P0–P3; `created_at` `z.iso.datetime({ offset: true })`; unknown keys throw | `index.ts` | docs/api.md |
| DESIGN.md §6 example still parses | `index.test.ts` “accepts the DESIGN.md §6 Task Brief example…” | CHANGELOG, docs/api.md |
| `zod` `^4.4.3` / lockfile `zod@4.4.3` | `packages/shared/package.json`, `pnpm-lock.yaml` | README, CHANGELOG, docs/api.md |
| Package export `"."` → `./src/index.ts` | `packages/shared/package.json` | docs/api.md |
| `GET /` body still `考拉任务服务占位` | `apps/server/src/placeholder.ts` | README status, CHANGELOG, CLAUDE Snapshot, docs/architecture.md, docs/api.md |
| `getForgeAdaptersHealth()` → `kaola-forge-adapters-ready` only | `packages/forge-adapters/src/index.ts` | README, CHANGELOG, CLAUDE Snapshot, docs/architecture.md, docs/api.md |
| `pnpm test` still the same three files | root `package.json` | unchanged (README 开发, CLAUDE Commands) |
| issue #2 schema is implemented (was “尚未实现”) | `index.ts` + `final-validation.md` 89/89 | README 路线图 |
| MCP / adapters not implemented | tree | CLAUDE Snapshot (clause updated from “schema, MCP, and adapters are not implemented”) |

Validation cited (not re-run here): `kaola-workflow/issue-2/.cache/final-validation.md` — lint/typecheck/test/build exit 0; 89 tests pass.

## Explicit non-claims (honest gaps)

- No HTTP task API, no MCP tools, no OAuth, no board.
- Forge adapters still health-only.
- Did not re-run pnpm scripts in the doc-updater session.
- Did not copy DESIGN.md §6 JSON into docs/api.md (point + “tests pin it” only).
- Did not invent version numbers.

## Skipped surfaces

`docs/DESIGN.md` (contracts), `CLAUDE.md` Commands (still true), `docs/README.md`, `docs/conventions.md` (Chinese lifecycle labels still true), `docs/decisions/` (empty), tests, production `.ts`, `.env.example` (absent), `docs/CODEMAPS/` / `scripts/codemaps/` (absent).

README “核心特性 … 尚未实现” and “首次使用 / 发布 / 认领 … 无任务卡” left as product-flow statements (no login/MCP/board/task HTTP). CHANGELOG M0 scaffold bullet kept (health export still real; new bullet covers schema).

Full change list: `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-2/.cache/doc-updater.md`
