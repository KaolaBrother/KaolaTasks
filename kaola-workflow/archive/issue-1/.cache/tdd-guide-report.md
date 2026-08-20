# TDD-guide report — issue #1 (M0 pnpm monorepo scaffold)

Custody: test author. Tests only; no production source, no `package.json`, no install.

## RED

```
RED: apps/server/src/placeholder.test.ts — Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../apps/server/src/placeholder.ts'
RED: packages/forge-adapters/src/index.test.ts — Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/forge-adapters/src/index.ts'
RED: packages/shared/src/index.test.ts — Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/shared/src/index.ts'
baseline: 252877d356f7b7408ee3192d86c5db3653da07b2
```

Suite: 3 tests, 0 pass, 3 fail. Not green.

## Baseline it failed on

- **Commit SHA actually run against:** `252877d356f7b7408ee3192d86c5db3653da07b2`
- **Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-1`
- **Tree at that commit:** docs-only (README / CHANGELOG / CLAUDE / docs). No `package.json`, no `apps/`, no `packages/` production modules.
- **Node:** v24.14.0 (type-stripping on by default; `.test.ts` loads as ESM)

## Test paths written

Only these files (plus the directories needed to hold them):

- `packages/shared/src/index.test.ts`
- `packages/forge-adapters/src/index.test.ts`
- `apps/server/src/placeholder.test.ts`

Raw run log: `kaola-workflow/issue-1/.cache/tdd-guide-red-run.txt`

Command used (no `pnpm test` on this baseline; `pnpm` is not on PATH):

```bash
node --test \
  packages/shared/src/index.test.ts \
  packages/forge-adapters/src/index.test.ts \
  apps/server/src/placeholder.test.ts
```

## Failure signature (from the run)

Top-level static `import` of the missing production module fails before the inner `test()` callback registers, so `node:test` names the case after the file. The proving error is `ERR_MODULE_NOT_FOUND` (not a passing skip).

1. **`apps/server/src/placeholder.test.ts`**
   - `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-1/apps/server/src/placeholder.ts' imported from '.../apps/server/src/placeholder.test.ts'`
   - summary: `✖ apps/server/src/placeholder.test.ts` / `'test failed'`

2. **`packages/forge-adapters/src/index.test.ts`**
   - `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-1/packages/forge-adapters/src/index.ts' imported from '.../packages/forge-adapters/src/index.test.ts'`
   - summary: `✖ packages/forge-adapters/src/index.test.ts` / `'test failed'`

3. **`packages/shared/src/index.test.ts`**
   - `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-1/packages/shared/src/index.ts' imported from '.../packages/shared/src/index.test.ts'`
   - summary: `✖ packages/shared/src/index.test.ts` / `'test failed'`

Counts from the same process: `tests 3 / pass 0 / fail 3`, process exit 1.

Once those modules exist, the named assertions that must still hold are:

- `getSharedHealth returns the pinned non-empty shared package health string`
- `getForgeAdaptersHealth returns the pinned non-empty forge-adapters package health string`
- `getPlaceholderBody returns the pinned non-empty placeholder HTTP body`

A blank or wrong body fails `assert.ok(value.length > 0)` then `assert.equal(...)`. A missing named export fails load with `SyntaxError: The requested module does not provide an export named '...'`.

## Exact contract the implementer must satisfy

Do not rewrite these tests. Ship the modules they import.

| Production file (create this) | Named export | Kind | Exact return (string length > 0) |
| --- | --- | --- | --- |
| `packages/shared/src/index.ts` | `getSharedHealth` | `() => string` | `kaola-shared-ready` |
| `packages/forge-adapters/src/index.ts` | `getForgeAdaptersHealth` | `() => string` | `kaola-forge-adapters-ready` |
| `apps/server/src/placeholder.ts` | `getPlaceholderBody` | `() => string` | `考拉任务服务占位` |

Import specifiers the tests already use (relative, ESM, `.ts` extension):

- `packages/shared/src/index.test.ts` → `import { getSharedHealth } from './index.ts'`
- `packages/forge-adapters/src/index.test.ts` → `import { getForgeAdaptersHealth } from './index.ts'`
- `apps/server/src/placeholder.test.ts` → `import { getPlaceholderBody } from './placeholder.ts'`

**HTTP:** the Fastify (or other) placeholder route must call `getPlaceholderBody()` and send that return value as the **response body**. Do not hard-code a second copy of the string in the handler. Tests import the shipped helper; they do not re-implement the payload and they do not mock the subject.

**Not pinned (issue #2 / DESIGN §5–§6):** task-brief zod schema, lifecycle state machine, `ForgeAdapter` methods. M0 tests only require a trivial real export a consumer can import.

## What `pnpm test` should become

Keep `node:test` + `node:assert/strict` so these files do not need a rewrite. After workspace `package.json` exists, a sufficient root script is:

```json
"test": "node --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts apps/server/src/placeholder.test.ts"
```

Node 24 already strip-types `.ts`. Packages should be `"type": "module"` so these ESM tests keep loading. Vitest is optional later; do not add it to satisfy this suite.

`pnpm` is not on PATH in this environment (`command not found: pnpm`). The RED proof is `node --test` against the SHA above.

## Scope deliberately not encoded

Issue #1 also asks for `pnpm install/lint/typecheck/test/build`, CI lint+test, `docker compose up`, and `apps/web` (Vue 3 + Vite + Naive UI). Per the acceptance surface for this suite:

- no Vue UI test
- no docker test
- no GitHub Actions YAML test (file-existence would be allowed; not added)
- no invented workspace package names (`@kaola/shared` etc. are unspecified)

Those remain implementer work against the issue body; they are not frozen into this oracle.

## Production files written

None. `find packages apps -type f ! -name '*.test.ts'` is empty. No `package.json`, no CI, no `docker-compose.yml`, no install.
