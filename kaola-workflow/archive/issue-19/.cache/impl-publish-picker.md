# impl: publish picker UI (issue #19)

- **worktree**: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-19`
- **branch**: `workflow/issue-19`
- **HEAD SHA**: `41e1e01ff4ec58e4651bb6825ee1bcfa7c158c3d` (uncommitted; not pushed)
- **file changed**: `apps/web/src/App.vue` (+111 / −5)
- **not touched**: `**/*.test.ts`, `docs/DESIGN.md`

## What changed

Publish form in profile mode uses the credential dropdown as the repo picker.

- `taskProfileOptions` labels are exactly `` `${forge} ${repo_full_name}` `` (values stay profile ids).
- Profile mode `v-if`-hides `task-forge` / `task-base-url` / `task-repo`. `task-group-repo` and `task-group-advanced` (`task-base-branch`, `task-suggested-dir`) stay mounted.
- Empty profiles: `task-profile-empty-hint` with copy containing `钥匙`. Hidden when `profiles.length > 0` or not profile mode.
- Selecting a profile copies that row into `taskForge` / `taskBaseUrl` / `taskRepo`. `watch(taskForge)` is gated off in profile mode so a previous profile’s `base_url` is not kept.
- Imported + profile + numeric profile id: `GET /api/v1/credential-profiles/:id/issues` with `credentials: 'include'` and `Accept: application/json`. No GET for native, inline, empty profiles, or imported before a profile is chosen. Switching 3 → 5 while imported GETs `.../5/issues`.
- `task-issue-select` only when imported AND profile. Options `{ label: \`#${number} ${title}\`, value: issue_url }`. Selecting does not POST `/import`.
- `task-issue-url` paste field only when imported AND inline.
- `importTask` / `createTask` still read `taskIssueUrl` (select value in profile mode, paste in inline). POST bodies unchanged.
- Listed issues + selected issue cleared when leaving imported, switching to inline, or changing profile. Stale in-flight GETs ignored via a request generation counter.

## Verification

**tier**: `tests-green`

**before** (`pnpm --filter @kaola/web test`):

```
Test Files  1 failed | 4 passed (5)
     Tests  27 failed | 66 passed (93)
exit 1
```

Form failures were the missing picker surface (`task-issue-select`, profile labels, hidden hand-fill repo, issues GET). Shell / board / settings / audit suites were already green.

**after** (`pnpm --filter @kaola/web test`):

```
$ vitest run

 Test Files  5 passed (5)
      Tests  93 passed (93)
exit 0
```

Includes `App.form.test.ts`, `App.shell.test.ts`, `App.board.test.ts`, `App.settings.test.ts`, `App.audit.test.ts`.
