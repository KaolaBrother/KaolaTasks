# tdd-guide report — issue #2 Task Brief schema + lifecycle state machine

## RED

```
RED: parseTaskBrief accepts the DESIGN.md §6 Task Brief example including Chinese ellipsis description
     — AssertionError [ERR_ASSERTION]: parseTaskBrief must be exported as a function
       actual: 'undefined'  expected: 'function'  operator: 'strictEqual'
RED: transitionTaskStatus allows 待认领 → 进行中
     — AssertionError [ERR_ASSERTION]: transitionTaskStatus must be exported as a function
       actual: 'undefined'  expected: 'function'  operator: 'strictEqual'
baseline: eb479691dce6fb93fca7617c7fcfe95dee66866f
```

All 86 new tests fail on that same missing-export signature. The pre-existing health test still passes (mixed RED, as required).

```
ℹ tests 87
ℹ suites 2
ℹ pass 1
ℹ fail 86
```

Pass: `getSharedHealth returns the pinned non-empty shared package health string`

## Baseline it failed on

- Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2`
- Branch: `workflow/issue-2`
- SHA (from `git rev-parse HEAD` in that worktree): `eb479691dce6fb93fca7617c7fcfe95dee66866f`
- `packages/shared/src/index.ts` at this SHA exports only `getSharedHealth`.

## Command run

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2
node --experimental-strip-types --test packages/shared/src/index.test.ts
```

Raw TAP/assertion output: `kaola-workflow/issue-2/.cache/tdd-guide-red-run.txt`

Root `pnpm test` already lists `packages/shared/src/index.test.ts`. No sibling `*.test.ts` files were added; **do not require a package.json test-script edit for these tests**.

## Test path

- `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2/packages/shared/src/index.test.ts`

Existing `getSharedHealth` test is unchanged (not deleted, skipped, or weakened).

## Public exports the implementer must satisfy

Export all of the following from `packages/shared/src/index.ts` (keep `getSharedHealth`):

### `getSharedHealth(): string`

Already implemented. Must remain `'kaola-shared-ready'`.

### `parseTaskBrief(input: unknown): <parsed brief>`

- **Valid input:** return a plain object **deep-equal** to the accepted input (same field names and values; `created_at` stays the offset datetime **string**; do not coerce to `Date`).
- **Invalid input:** **throw** (any `Error` is fine; tests use `assert.throws`, not a zod class).
- Do not return `{ ok: true, data }` / `{ ok: false }`. Tests call the function and `deepEqual` the result to the fixture.

### `transitionTaskStatus(from: string, to: string): string`

- **Legal edge:** do not throw; **return `to`**.
- **Illegal edge (including same-state no-ops and unknown labels):** **throw**.
- Do not return a boolean or `{ ok }`. Tests `assert.equal(transitionTaskStatus(from, to), to)` and `assert.throws(...)`.

Optional extras (`taskBriefSchema`, status const arrays, TypeScript types) are allowed but **not required** by the suite. Tests import only `node:test`, `node:assert/strict`, and `./index.ts` — they do **not** import `zod`.

## Behavior pinned

### Status labels (canonical Chinese strings)

`待认领` | `进行中` | `待验收` | `已完成` | `已退回` | `已取消`

### Schema accept

- DESIGN.md §6 example object (including `description_md: "……（Markdown 详述）"`).
- Same object with `source: { type: "native" }` and no `issue_url`.
- `status` any of the six labels.
- `repo.forge` `github` | `gitlab` | `gitea`.
- `priority` `P0` | `P1` | `P2` | `P3`.
- `credential` is `{ profile_id: string }` only. No temp-token field is named in DESIGN.md; do not invent one.

Required fields (missing any must throw):  
`id`, `title`, `description_md`, `source`, `repo`, `acceptance_criteria`, `test_command`, `constraints`, `pr_convention`, `credential`, `priority`, `tags`, `poster`, `status`, `created_at`,  
plus nested `repo.{forge,base_url,full_name,base_branch,suggested_dir}`, `constraints.{allowed_paths,forbidden_paths}`, `pr_convention.{branch_prefix,title_prefix}`.

### Schema reject

- missing required fields above
- `status: "open"` (or any non-enum)
- `repo.forge: "bitbucket"`
- `source: { type: "imported" }` without `issue_url`
- `source: { type: "native", issue_url: "..." }`
- `priority: "high"`
- extra `token` on the brief (must **throw**, not strip)
- `credential: {}` (no `profile_id`)
- `credential: { token: "..." }`
- `credential: { profile_id, token }` (has profile_id but still carries a secret)

### Eight legal transitions (all covered)

| from | to |
|------|----|
| 待认领 | 进行中 |
| 进行中 | 待认领 |
| 进行中 | 待验收 |
| 待验收 | 已完成 |
| 待验收 | 已退回 |
| 已退回 | 待认领 |
| 待认领 | 已取消 |
| 已退回 | 已取消 |

### Illegal transitions (full 6×6 complement, plus unknown labels)

Every other pair among the six labels, including:

- terminals `已完成` / `已取消` to anything (including self)
- `待认领` → `待验收` / `已完成` / `已退回`
- `进行中` → `已完成` / `已取消` / `已退回`
- `待验收` → `待认领` / `进行中` / `已取消`
- `已退回` → `进行中` / `待验收` / `已完成`
- same-state no-ops for all six
- `from: "open"` or `to: "closed"`

## Out of scope (tests do not require)

Database, HTTP, MCP, forge adapters, a named temp-token credential key, `id` regex, or `created_at` → `Date`.

## Custody

Tests only. Production code, `package.json`, lockfile, and docs were not edited. Adding `zod` is the implementer's job if the schema needs it.
