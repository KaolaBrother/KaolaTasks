# API

Document public APIs, endpoints, schemas, events, and integration contracts.

Currently defined in [DESIGN.md](DESIGN.md) §6 (任务卡 Schema), §8 (ForgeAdapter), §9 (MCP 工具面 / REST). This file takes over once endpoints are implemented and stable.

HTTP and MCP are still unimplemented (`GET /` body `考拉任务服务占位`; no MCP tools). `@kaola/forge-adapters` still exports only `getForgeAdaptersHealth()`.

`@kaola/shared` (`packages/shared/src/index.ts`, package export `"."` → `./src/index.ts`) now exposes a library contract matching [DESIGN.md](DESIGN.md) §5–§6:

- `getSharedHealth(): string` → `'kaola-shared-ready'`
- `taskStatusSchema` — `z.enum(['待认领', '进行中', '待验收', '已完成', '已退回', '已取消'])`
- `type TaskStatus`
- `taskBriefSchema` — `z.strictObject` (unknown keys throw)
- `type TaskBrief`
- `parseTaskBrief(input: unknown): TaskBrief` — `taskBriefSchema.parse(input)` (throws on invalid)
- `transitionTaskStatus(from: string, to: string): string` — legal edges return `to`; others throw

`taskBriefSchema` keys in source: `id`, `title`, `description_md`, `source`, `repo`, `acceptance_criteria`, `test_command`, `constraints`, `pr_convention`, `credential`, `priority`, `tags`, `poster`, `status`, `created_at`. `source` is a discriminated union on `type`: `native` (type only) | `imported` (type + `issue_url` string). `repo`: `forge` enum `github` | `gitlab` | `gitea`; `base_url`, `full_name`, `base_branch`, `suggested_dir` strings. `acceptance_criteria`: `string[]`. `test_command`: string. `constraints`: `allowed_paths`, `forbidden_paths` `string[]`. `pr_convention`: `branch_prefix`, `title_prefix`. `credential`: `{ profile_id: string }` only (strict). `priority`: `P0` | `P1` | `P2` | `P3`. `tags`: `string[]`. `poster`, `title`, `description_md`, `id`: string. `status`: `taskStatusSchema`. `created_at`: `z.iso.datetime({ offset: true })`.

Legal `transitionTaskStatus` edges in source: 待认领 → 进行中, 已取消; 进行中 → 待认领, 待验收; 待验收 → 已完成, 已退回; 已退回 → 待认领, 已取消.

The DESIGN.md §6 example still parses (`packages/shared/src/index.test.ts` pins it). Field names and enums live in source and DESIGN.md §6 — this file does not duplicate that JSON example. Dependency: `zod` `^4.4.3`.

