# App.audit.test.ts — typecheck fix (tdd-guide)

File touched: `apps/web/src/App.audit.test.ts` (worktree `bundle-15-16`). No other file edited.

## Changes

1. `optionValues` (line ~273): the map callback previously annotated its parameter as
   `(option: { value: unknown })`, which doesn't match Naive UI's `SelectMixedOption` (whose
   `value` is optional / union-typed, not a required `unknown`). Changed the callback to accept
   `option: unknown` and narrow with a `typeof option === 'object' && option != null && 'value' in
   option` guard before reading `.value`, falling back to `undefined` otherwise. The set of values
   returned for every real option in the tests is unchanged (all real options carry a `value`
   key), so no assertion behavior changed.

2. `mountMember`'s options parameter (line ~197): added a `StatsBody` type alias
   (`{ completed_count: number; completed_by_username: Record<string, number> }`) and changed the
   `stats` field's annotation from `typeof STATS` (which vue-tsc inferred with specific required
   keys because of `STATS`'s literal object shape) to `StatsBody`. `EMPTY_STATS` (`{
   completed_count: 0, completed_by_username: {} }`) now type-checks as a valid `StatsBody`. `STATS`
   and `EMPTY_STATS` runtime values are unchanged, and every `expect(...)` in the file is unchanged.

## Verification

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16
CI=true pnpm --filter @kaola/web typecheck
```
Exit code: 0 (`vue-tsc --noEmit -p tsconfig.json` — clean, no errors)

```
pnpm --filter @kaola/web exec vitest run src/App.audit.test.ts
```
Exit code: 0 — Test Files: 1 passed (1), Tests: 16 passed (16)
