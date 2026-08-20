# Implementer report — issue #2 (`@kaola/shared` Task Brief schema + status machine)

**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2`  
**Branch:** `workflow/issue-2`  
**Baseline SHA tests failed on:** `eb479691dce6fb93fca7617c7fcfe95dee66866f`  
**Date:** 2026-08-20

## task

Implement production code for Kaola Tasks issue #2 in `@kaola/shared`:

- Add Zod 4 (`"zod": "^4.4.3"`) as a runtime dependency of `@kaola/shared`.
- Export `parseTaskBrief(input: unknown)` — valid briefs return a plain object deep-equal to the input (`created_at` stays an offset string, not a Date); invalid input throws.
- Export `transitionTaskStatus(from: string, to: string): string` — legal edges return `to`; illegal edges (including same-state no-ops and unknown labels) throw.
- Keep `getSharedHealth()` → `'kaola-shared-ready'`.
- Do not write, weaken, delete, or skip tests. Do not touch `docs/DESIGN.md`, apps, forge-adapters, or MCP/HTTP/vault.

Status labels: `待认领` | `进行中` | `待验收` | `已完成` | `已退回` | `已取消`.

Legal transitions only:

- 待认领→进行中
- 进行中→待认领
- 进行中→待验收
- 待验收→已完成
- 待验收→已退回
- 已退回→待认领
- 待认领→已取消
- 已退回→已取消

Schema accepts the DESIGN.md §6 example and `source: { type: "native" }` (no `issue_url`). Unknown keys throw (`z.strictObject()`, including nested objects and discriminated-union variants). Credential is `{ profile_id: string }` only — no temp-token field.

## verification tier

`tests-green`

The authored shared suite (`packages/shared/src/index.test.ts`) passes: 87 tests, 0 fail. The other two existing tests remain green (full suite 89 pass / 0 fail). `@kaola/shared` typecheck is green.

## files changed

Production files actually touched in this implementer pass (test files were not edited):

| Path | Change |
|------|--------|
| `packages/shared/src/index.ts` | Export `parseTaskBrief`, `transitionTaskStatus`, plus `taskBriefSchema` / `taskStatusSchema` / `TaskBrief` / `TaskStatus`. Keep `getSharedHealth`. |
| `packages/shared/package.json` | Add `"zod": "^4.4.3"` under `dependencies`. |
| `pnpm-lock.yaml` | Lock `zod@4.4.3` for `packages/shared`. |

Not edited by implementer: `packages/shared/src/index.test.ts` (already present from tdd-guide; git shows it dirty vs HEAD because the authored suite landed before this pass). `docs/DESIGN.md`, apps, forge-adapters: untouched.

### Implementation notes

- `import * as z from 'zod'`
- Status: `z.enum(['待认领', '进行中', '待验收', '已完成', '已退回', '已取消'])` with the array inline
- `source`: `z.discriminatedUnion('type', [native strictObject, imported strictObject])`
- Native source is `{ type: z.literal('native') }` only (strict) so `issue_url` on native throws
- Imported source requires `issue_url: z.string()`
- `created_at`: `z.iso.datetime({ offset: true })` so `+08:00` is accepted and remains a string
- Top-level and nested objects use `z.strictObject()` so extra keys (including raw `token`) throw instead of being stripped
- Credential: `z.strictObject({ profile_id: z.string() })` only
- `parseTaskBrief` is `taskBriefSchema.parse(input)` — throws `z.ZodError` on invalid input
- `transitionTaskStatus` looks up `from` in a `Map<string, Set<string>>` of the eight legal edges; missing edge throws `Error`

No MCP, HTTP, vault, or adapter code.

## verification commands

### 1. RED baseline (before production change)

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2
node --experimental-strip-types --test packages/shared/src/index.test.ts
```

**Exit code:** 1

**Summary:**

```
ℹ tests 87
ℹ suites 2
ℹ pass 1
ℹ fail 86
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 66.874583
```

The single pass is `getSharedHealth`. Failures are `AssertionError: parseTaskBrief must be exported as a function` / `transitionTaskStatus must be exported as a function`.

### 2. Install (after adding zod to package.json)

PATH `pnpm` is a Corepack shim that hung on `Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-11.19.0.tgz`. Install used the matching pnpm 11.19.0 binary:

```
node /Users/ylpromax5/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.cjs install --fetch-timeout 300000 --fetch-retries 5
```

**Exit code:** 0

**Tail:**

```
Packages: +269
...
devDependencies:
+ @eslint/js 9.39.5 (10.0.1 is available)
+ @types/node 22.20.1 (26.2.0 is available)
+ eslint 9.39.5 (10.8.1 is available)
+ eslint-plugin-vue 10.10.0
+ globals 16.5.0 (17.11.0 is available)
+ typescript 5.9.3 (7.0.2 is available)
+ typescript-eslint 8.67.0

Done in 4m 52.2s using pnpm v11.19.0
```

Confirmed: `packages/shared/node_modules/zod` → `zod@4.4.3`. Lockfile importer `packages/shared` now has `zod` specifier `^4.4.3` version `4.4.3`.

### 3. GREEN shared suite (after production change)

```
node --experimental-strip-types --test packages/shared/src/index.test.ts
```

**Exit code:** 0

```
✔ getSharedHealth returns the pinned non-empty shared package health string (0.265208ms)
▶ parseTaskBrief
  ✔ parseTaskBrief accepts the DESIGN.md §6 Task Brief example including Chinese ellipsis description (1.502958ms)
  ✔ parseTaskBrief accepts a valid brief whose source is native with no issue_url (0.295292ms)
  … (all parseTaskBrief cases pass)
✔ parseTaskBrief (4.837875ms)
▶ transitionTaskStatus
  … (all 6×6 status pairs + unknown from/to pass)
✔ transitionTaskStatus (1.2245ms)
ℹ tests 87
ℹ suites 2
ℹ pass 87
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 86.715042
```

### 4. Typecheck

```
pnpm --filter @kaola/shared typecheck
```

(via the same pnpm 11.19.0 binary)

**Exit code:** 0

```
$ tsc --noEmit -p tsconfig.json
```

### 5. Full existing suite (shared + forge-adapters + server placeholder)

```
node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts apps/server/src/placeholder.test.ts
```

**Exit code:** 0

```
✔ getPlaceholderBody returns the pinned non-empty placeholder HTTP body
✔ getForgeAdaptersHealth returns the pinned non-empty forge-adapters package health string
✔ getSharedHealth …
… parseTaskBrief and transitionTaskStatus all pass …
ℹ tests 89
ℹ suites 2
ℹ pass 89
ℹ fail 0
ℹ duration_ms 80.555458
```

## before

- Shared suite at the worktree HEAD / pre-implementation: **87 tests, 1 pass, 86 fail** (`parseTaskBrief` / `transitionTaskStatus` not exported).
- `@kaola/shared` had no `zod` dependency.
- Worktree had no `node_modules` until `pnpm install`.

## after

- Shared suite: **87 tests, 87 pass, 0 fail**.
- Full existing suite: **89 tests, 89 pass, 0 fail**.
- `@kaola/shared` typecheck: **pass**.
- `@kaola/shared` depends on `zod@^4.4.3` (resolved `4.4.3`).
- Public API: `getSharedHealth`, `parseTaskBrief`, `transitionTaskStatus`, plus optional `taskBriefSchema`, `taskStatusSchema`, `TaskBrief`, `TaskStatus`.

## custody

Tests were treated as read-only. No `*.test.ts` file was written, weakened, deleted, or skipped.
