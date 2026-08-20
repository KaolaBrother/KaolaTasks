# DESIGN.md §5/§6 measure (issue #2)

Measured from `docs/DESIGN.md` v0.2 and `packages/shared` at worktree HEAD (same as origin/main `eb47969`). Retrieval: 2026-08-20.

## packages/shared shell

- `@kaola/shared` exports `./src/index.ts`; only `getSharedHealth()` → `kaola-shared-ready`.
- Tests: `packages/shared/src/index.test.ts` via root `pnpm test` (`node --experimental-strip-types --test` with an explicit file list).
- No zod dependency. Typecheck excludes `src/**/*.test.ts`.
- Do not drop `getSharedHealth`.

## Status enum (canonical Chinese labels, DESIGN.md §5)

`待认领` | `进行中` | `待验收` | `已完成` | `已退回` | `已取消`

## Legal transitions (exactly these eight)

| from | to | trigger in diagram |
|------|----|--------------------|
| 待认领 | 进行中 | claim_task |
| 进行中 | 待认领 | 租约过期 / release_task |
| 进行中 | 待验收 | submit_pr |
| 待验收 | 已完成 | PR 合并 |
| 待验收 | 已退回 | PR 被关闭 / 验收不通过 |
| 已退回 | 待认领 | 发布者重新开放 |
| 待认领 | 已取消 | 发布者取消 |
| 已退回 | 已取消 | 发布者取消 |

Terminal: `已完成`, `已取消`. No self-transitions in the diagram.

## Main illegal transitions (not exhaustive)

Any edge not in the table: including from terminals; `待认领` → `待验收`/`已完成`/`已退回`; `进行中` → `已完成`/`已取消`/`已退回`; `待验收` → `待认领`/`进行中`/`已取消`; `已退回` → `进行中`/`待验收`/`已完成`.

## §6 Task Brief fields present in the example

`id`, `title`, `description_md`, `source`, `repo` (`forge`, `base_url`, `full_name`, `base_branch`, `suggested_dir`), `acceptance_criteria`, `test_command`, `constraints` (`allowed_paths`, `forbidden_paths`), `pr_convention` (`branch_prefix`, `title_prefix`), `credential` (`profile_id`), `priority`, `tags`, `poster`, `status`, `created_at`.

- `repo.forge`: `github` | `gitlab` | `gitea` (comment).
- `source.type`: comment says native or imported; **example only shows** `{ type: "imported", issue_url }`.
- `credential`: example is `{ profile_id }`. Comment says 或单任务临时 token 的引用 — **the temp-token reference key is not named**. Agent-side JSON must not contain a raw token (DESIGN.md §6 intro + §7 reveal-on-claim).
- `priority`: example `"P1"`; repo labels are P0–P3.
- `created_at`: offset datetime `2026-08-20T12:00:00+08:00`.
- `id` example `kt-2026-0142`; format is not specified as a regex.

## Judgements (applied unless a later measurement contradicts)

1. Pin the §6 JSON example as a must-accept fixture (issue acceptance).
2. `source`: discriminated on `type`. `imported` requires `issue_url`. `native` is named in the comment with no extra fields shown → `{ type: "native" }` only; do not invent `issue_url` on native.
3. Do **not** invent a temp-token credential field name. Accept `{ profile_id }`. Reject unknown keys / a raw `token` field so Agent-side briefs cannot carry secrets.
4. `priority`: `P0` | `P1` | `P2` | `P3`.
5. Transition API is a pure function over the Chinese labels (no DB). Exact export names are for tdd-guide to freeze in tests.

## Out of scope for #2

OAuth, vault, MCP, adapters, persistence, HTTP. Schema + state machine live in `packages/shared` only.
