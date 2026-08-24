# Implementer report — unused-var lint (claim.ts / devices.ts)

## task

Fix ESLint unused-var errors in **production** files only, worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`:

- `apps/server/src/claim.ts`: unused `FastifyRequest`, `AgentKey`, `User`
- `apps/server/src/devices.ts`: unused `and` from drizzle-orm

Do not edit tests. Do not change HTTP behavior.

## verification tier

`tests-green` — **eslint on the two files is clean**. Claim/devices tests were run; they **failed to load** (module resolution of `@kaola/shared` `device-proof.js`), which is independent of the unused-import edits. No HTTP/behavior change.

## files changed

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`

| Path | Change |
|------|--------|
| `apps/server/src/claim.ts` | Drop unused type imports `FastifyRequest`, `AgentKey`, `User` |
| `apps/server/src/devices.ts` | Drop unused `and` from `drizzle-orm` |

Tests: not edited.

## verification commands

### before (eslint)

```
pnpm exec eslint apps/server/src/claim.ts apps/server/src/devices.ts
```

**exit code:** 1

```
apps/server/src/claim.ts
   4:46  error  'FastifyRequest' is defined but never used  @typescript-eslint/no-unused-vars
  24:15  error  'AgentKey' is defined but never used        @typescript-eslint/no-unused-vars
  24:30  error  'User' is defined but never used            @typescript-eslint/no-unused-vars

apps/server/src/devices.ts
  1:10  error  'and' is defined but never used  @typescript-eslint/no-unused-vars

✖ 4 problems (4 errors, 0 warnings)
```

### after (eslint)

```
pnpm exec eslint apps/server/src/claim.ts apps/server/src/devices.ts
```

**exit code:** 0 (no output)

### after (claim / devices tests)

```
node --experimental-strip-types --test apps/server/src/claim.test.ts apps/server/src/claim-confirm.test.ts apps/server/src/devices.test.ts
```

**exit code:** 1

All three files fail at load with:

```
ERR_MODULE_NOT_FOUND: Cannot find module
.../packages/shared/src/device-proof.js
imported from .../packages/shared/src/index.ts
```

`packages/shared/src/device-proof.ts` exists in the worktree. This is a Node ESM `.js` specifier vs `.ts` source load issue, not caused by removing unused imports in `claim.ts` / `devices.ts`.

## before

Four `@typescript-eslint/no-unused-vars` errors on the two production files.

## after

Those four errors gone. Imports only; no handler, schema, or response changes.

This report: `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-23/.cache/impl-lint.md`
