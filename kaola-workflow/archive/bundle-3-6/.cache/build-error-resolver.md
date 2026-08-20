# build-error-resolver — unused `kind` in `userPath`

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6`

## Before

`pnpm lint` failed with exactly one error:

```
packages/forge-adapters/src/index.ts
  96:19  error  'kind' is defined but never used  @typescript-eslint/no-unused-vars
```

Cause: `function userPath(kind: ForgeKind): string { return '/user' }` — GitHub, GitLab, and Gitea all use the same `/user` path, so `kind` was unused.

## Fix (minimal production diff)

File: `packages/forge-adapters/src/index.ts` (worktree)

- Dropped the unused `kind` parameter from the unexported helper.
- Updated the single call site `userPath(kind)` → `userPath()`.
- Runtime still returns `'/user'`. No tests, `apps/`, or `docs/DESIGN.md` touched.

```ts
function userPath(): string {
  return '/user'
}
```

Call site:

```ts
const userUrl = apiUrl(kind, options, repo, userPath())
```

## Commands (from worktree)

First `pnpm lint` without `CI=true` aborted at pnpm's modules-dir confirm (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Subsequent runs used `CI=true`.

| Command | Exit | Result |
|---|---|---|
| `CI=true pnpm lint` | 0 | `eslint .` clean (0 errors) |
| `CI=true pnpm typecheck` | 0 | 4 of 5 workspace projects (`apps/server`, `apps/web`, `packages/forge-adapters`, `packages/shared`) — all Done |
| `CI=true pnpm test` | 0 | **124** tests, **10** suites, **pass 124**, fail 0, skipped 0, cancelled 0, todo 0 |
| `CI=true pnpm build` | 0 | 4 of 5 workspace projects built; `apps/web` vite production build succeeded (2565 modules transformed) |

**build-green**
