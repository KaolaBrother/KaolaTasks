# impl-web — 发布任务 form in `apps/web/src/App.vue` (issue #7)

**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`
**Verification tier:** `tests-green`

I wrote production code only. I did not create, modify, weaken, delete, or skip any `*.test.ts`.

---

## task

Build the Chinese **发布任务** form in `apps/web/src/App.vue` so `apps/web/src/App.form.test.ts` (27 tests, previously all RED) goes green. Honour `tests-web.md` data-testid contract (§3) and all 18 judgement calls (§5).

## verification tier

`tests-green`

## files changed

- `apps/web/src/App.vue` only (worktree path: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7/apps/web/src/App.vue`)

No other files were written.

## verification commands + exit codes

```
$ cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7
$ CI=true pnpm --filter @kaola/web test
exit 0

 Test Files  1 passed (1)
      Tests  27 passed (27)
   Duration  2.46s
```

```
$ CI=true pnpm --filter @kaola/web typecheck
exit 0
$ vue-tsc --noEmit -p tsconfig.json
```

## before (baseline)

Ran **before** any edit to `App.vue`:

```
$ CI=true pnpm --filter @kaola/web test
exit 1

 RUN  v4.1.11 .../apps/web
 ❯ src/App.form.test.ts (27 tests | 27 failed) 548ms

 Test Files  1 failed (1)
      Tests  27 failed (27)

[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @kaola/web@0.0.0 test: `vitest run`
Exit status 1
```

Representative failures (form missing): `task-form` not present; `no input/textarea under [data-testid="task-title"]`; `no n-select with data-testid="task-credential-mode"`.

## after

```
$ CI=true pnpm --filter @kaola/web test
exit 0
Tests  27 passed (27)
```

```
$ CI=true pnpm --filter @kaola/web typecheck
exit 0
```

## what landed

Form is gated by existing `canApprove` (`active` + `full`) inside the 工作台 card. Naive `n-form` / `n-form-item`; submit via `n-button` `@click` (`createTask`). House idiom: flat refs `taskCreating` / `taskMessage` / `taskOk` plus `taskCredentialFeedback` for the 422 slot. Dropdown options come from the already-loaded `profiles` ref; no extra `GET /api/v1/credential-profiles`.

Request body follows §5/§7:

- empty `repo.base_branch` / `repo.suggested_dir` omitted (never `''`)
- `description_md`, `test_command`, `acceptance_criteria`, `tags`, `constraints` always sent
- native source is `{ type: 'native' }` with no `issue_url` key
- four `string[]` fields: newline-split, trim, drop empties
- `credential.profile_id` is a number; XOR is structural `v-if` on mode
- defaults: credential mode `'profile'`, priority `'P2'`, source `'native'`
- `POST /api/v1/tasks` with `credentials: 'include'` and `Accept: application/json`

Error placement: `422 token_check_failed` at `task-credential-feedback` using the server `message` as-is; 502 / 400-with-message / generic / `vault_unconfigured` (`凭证保险库未配置`) / network / success at `task-message`. Inline token cleared on 201 only.

Client guards (no POST): empty title, empty `repo.full_name`, imported without `issue_url`, profile mode with no selection, inline mode with empty token.

## findings

None. The 27 tests match `tests-web.md`; none were defective relative to that spec.
