# impl-server — tasks HTTP surface (issue #7)

**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`
**Verification tier:** `tests-green` — the authored suite `apps/server/src/tasks.test.ts` passes,
and the whole pre-existing suite stayed green.

I wrote production code only. I did not create, modify, or delete any `*.test.ts`, and I did not
touch the root `package.json` test list.

---

## 1. Final gate output, verbatim

```
$ CI=true pnpm test
ℹ tests 233
ℹ suites 39
ℹ pass 233
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 511.237416
test exit=0
```

Run three consecutive times, identical each time (233/233, exit 0) — no ordering dependence.

```
$ CI=true pnpm typecheck
typecheck exit=0
$ pnpm -r --if-present typecheck
Scope: 4 of 5 workspace projects
apps/web typecheck$ vue-tsc --noEmit -p tsconfig.json
packages/forge-adapters typecheck$ tsc --noEmit -p tsconfig.json
packages/shared typecheck$ tsc --noEmit -p tsconfig.json
packages/forge-adapters typecheck: Done
packages/shared typecheck: Done
apps/web typecheck: Done
apps/server typecheck$ tsc --noEmit -p tsconfig.json
apps/server typecheck: Done
```

```
$ CI=true pnpm lint
lint exit=0
$ eslint .
```

(no eslint output — clean)

```
$ CI=true pnpm build
build exit=0
$ pnpm -r --if-present build
Scope: 4 of 5 workspace projects
apps/web build$ vite build
packages/forge-adapters build$ tsc --noEmit -p tsconfig.json
packages/shared build$ tsc --noEmit -p tsconfig.json
apps/web build: vite v7.3.6 building client environment for production...
apps/web build: transforming...
packages/forge-adapters build: Done
packages/shared build: Done
apps/web build: ✓ 2565 modules transformed.
apps/web build: rendering chunks...
apps/web build: computing gzip size...
apps/web build: dist/index.html                    0.33 kB │ gzip:   0.25 kB
apps/web build: dist/assets/index-BCXNNTa7.js  1,452.16 kB │ gzip: 402.89 kB
apps/web build: (!) Some chunks are larger than 500 kB after minification. Consider:
apps/web build: - Using dynamic import() to code-split the application
apps/web build: - Use build.rollupOptions.output.manualChunks to improve chunking
apps/web build: - Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
apps/web build: ✓ built in 1.53s
apps/web build: Done
apps/server build$ tsc --noEmit -p tsconfig.json
apps/server build: Done
```

The 500 kB chunk warning is pre-existing (it is in the baseline build too) and is a warning, not a
failure — build exits 0.

### Before (baseline, my own capture before any edit)

```
$ CI=true pnpm test
ℹ tests 233
ℹ suites 39
ℹ pass 174
ℹ fail 59
```

typecheck / lint / build were already green at baseline. So the delta is exactly +59 passing,
−59 failing, with all four gates green after.

---

## 2. Files changed

Confirmed by `git status --short` — the only files I touched are these four:

| File (absolute) | Change |
|---|---|
| `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7/apps/server/src/schema.ts` | +45 lines: the `tasks` drizzle table, plus `Task` / `NewTask` inferred types |
| `.../apps/server/src/db.ts` | +34 lines: `TASKS_DDL`, `sqlite.exec(TASKS_DDL)`, `tasks` in the import list and in the drizzle schema map |
| `.../apps/server/src/tasks.ts` | new, 517 lines: `registerTasks(app, db)` and its readers/projector |
| `.../apps/server/src/app.ts` | +2 lines: import and `registerTasks(app, db)` after `registerCredentialProfiles` |

Untouched but relevant: `packages/shared/src/index.ts` already carried the `credential` union
(`{ profile_id } | { inline: true }`) when I started — that was impl-shared's work, not mine.
`apps/server/package.json` already declared both workspace deps.

### `schema.ts` — the `tasks` table

Nested brief fields are flattened to columns (`source` → `source_type` + `source_issue_url`,
`repo` → five `repo_*` columns, `constraints` → `allowed_paths` + `forbidden_paths`), and the brief's
string arrays are stored as JSON text — the same shape `credential_profiles.scopes_checked` already
uses. Chinese status labels are a `text(..., { enum: [...] })`, consistent with
`users.status`'s existing `待批准`.

The drizzle model mirrors the raw DDL on both constraints: `unique('tasks_public_id')` (the house
pattern already used by `agent_keys`) and a `check('tasks_credential_xor', ...)`. The `check` mirror
is metadata only — there is no drizzle-kit in this repo, so the runtime constraint comes from the
raw DDL — but omitting it would leave the model asserting the two credential columns are
independently nullable, which is false.

### `db.ts` — `TASKS_DDL`

```sql
  credential_profile_id INTEGER,
  inline_token_encrypted TEXT,
  ...
  CONSTRAINT tasks_credential_xor
    CHECK ((credential_profile_id IS NULL) != (inline_token_encrypted IS NULL))
```

Placed inside `createDb` (not at app boot) so the suite's second `createDb(sqlitePath)` connection
sees the table.

---

## 3. Where a test forced a choice I would not otherwise have made

1. **`public_id` is ordered numerically, not lexically — my own call, and the tests do not force
   it.** See §4; flagging it here because it is the one place I went beyond what the suite pins.
2. **`GET /api/v1/tasks` and `GET /api/v1/tasks/:public_id` gate on "logged in" only.** Every other
   read surface in this codebase (`credential-profiles`) additionally requires `active` + `full`, so
   this is deliberately looser than the neighbouring module. Judgement call 4 and DESIGN §11's
   查看任务板 ✓ are the basis; test 3 (`待批准 GitHub user may read the board`) pins it.
3. **PATCH checks the `active` + `full` gate before the poster check.** Test 4 patches an existing
   task as an approved `claim_only` user and demands `403`; test 5 patches as a different
   `active`+`full` member and also demands `403`. Both land on 403 either way, but the ordering
   means a `claim_only` user gets 403 rather than 404 on a task that does not exist. Untested;
   I chose permission-before-existence because it leaks less.
4. **The inline token is encrypted *before* 发布即校验 runs.** Nothing requires that order, but the
   `vault_unconfigured` test needs the inline path to 500 without ever reaching the forge, and
   failing on the cheap local condition first is the honest ordering. Consequence: a task rejected
   at 422/502 has had its token encrypted and thrown away. Nothing is persisted either way.
5. **`missing` is echoed verbatim in the 422 body.** No precedent existed in this codebase for a
   structured detail array alongside `error`; test 12 pins `deepEqual(body.missing, ['推','PR'])`.
6. **`created_at` renders as UTC `...Z`** via `new Date(sec * 1000).toISOString()`. I verified
   against the real `parseTaskBrief` (not just the regex) that `z.iso.datetime({ offset: true })`
   accepts the millisecond-bearing `Z` form, and that both credential shapes parse — see §5.
7. **`public_id`'s year segment is `getUTCFullYear()`**, so the id's year always agrees with the
   year shown in the brief's UTC `created_at`. The test accepts local or UTC year; I picked the one
   that cannot disagree with the rendered timestamp.

## 4. Anything in the spec I had to interpret

- **Judgement call 8 (`public_id` counter policy) — resolved per the orchestrator's ruling:** a
  per-year sequence, zero-padded to 4, `UNIQUE` as the backstop, bounded retry (5 attempts) on
  collision. `isPublicIdCollision` matches on the message `UNIQUE constraint failed:
  tasks.public_id`; I verified empirically that drizzle's better-sqlite3 driver surfaces the raw
  `SqliteError` unwrapped (`code === 'SQLITE_CONSTRAINT_UNIQUE'`, no `cause` chain), so the 4-level
  `cause` walk that `credential-profiles.ts` uses is not needed here.

  **I ordered the sequence numerically rather than lexically, which the tests do not require.**
  Lexical `desc` on the TEXT column is correct only while the suffix is exactly 4 digits: I measured
  that with `kt-2026-9999` and `kt-2026-10000` both present, lexical order returns `kt-2026-9999`
  and numeric order returns `kt-2026-10000`. Under lexical order the 10001st task of a year would
  re-propose `kt-2026-10000` five times and then throw a 500. `ORDER BY CAST(substr(public_id, N)
  AS INTEGER) DESC` removes that cliff for one import and one expression. Both orderings pass the
  suite; I chose the one that is right for every input rather than only for the tested ones.

- **Judgement call 14 (task repo vs. profile repo mismatch) left unimplemented**, as instructed. A
  task may currently name a profile registered against a different repo; the forge check then
  validates that profile's token against the *task's* repo, so an unrelated profile still gets
  caught by 发布即校验 unless its token happens to cover both repos. Worth a rule later; not one
  the suite pins, so I added none.

- **Strictness on optional fields is mine to pick.** The suite pins 13 invalid-body cases but says
  nothing about, say, `acceptance_criteria: "not an array"` or `description_md: 42`. I chose strict:
  a present-but-wrong-typed optional field is `400 invalid_body`, rather than silently falling back
  to the default. Only *absent* fields take defaults.

- **`repo.base_url` is required** (non-empty string). §2.1 lists it as required; no test covers its
  absence.

- **`full_name` ending in `/`** (so the derived `suggested_dir` would be empty) is `400
  invalid_body` rather than a task with an empty suggested dir. Untested corner, stated here.

- **`source.issue_url` must be non-empty** for `imported`. The test only pins the missing-key case;
  `taskBriefSchema` itself would accept `''`.

- **Reuse over duplication, twice.** `readStatusBody` validates via `taskStatusSchema.safeParse`
  from `@kaola/shared` instead of a local copy of the six labels, and `nextPosterStatus` narrows to
  the three poster edges and then defers to `transitionTaskStatus` for the actual transition, so
  `@kaola/shared` remains the authority on the lifecycle graph. `canPostTasks` duplicates
  `credential-profiles.ts`'s module-private `canManageProfiles` predicate rather than exporting it —
  exporting would have edited a file outside my assigned scope, and duplication is the existing
  house style (`parsePositiveInt` is already duplicated twice).

## 5. Facts I verified by running rather than assuming

| Claim | How | Result |
|---|---|---|
| `parseTaskBrief` accepts `new Date(sec*1000).toISOString()` | fed a full brief through the real `@kaola/shared` parser | accepted, for both `{profile_id}` and `{inline:true}` |
| same for `+08:00` and bare `Z` | same | both accepted |
| drizzle surfaces SQLite unique errors unwrapped | insert a duplicate through drizzle, inspect the error | `SqliteError`, `code=SQLITE_CONSTRAINT_UNIQUE`, `msg=UNIQUE constraint failed: <table>.<col>`, `cause=undefined` |
| the XOR `CHECK` fires on both hostile UPDATEs | raw `UPDATE` against a live table | `CHECK constraint failed: ...` — matches the suite's `/CONSTRAINT\|CHECK/i` |
| `check` is exported by `drizzle-orm/sqlite-core` at the installed version | `typeof core.check` | `function` |
| numeric vs. lexical `public_id` ordering diverges at 5 digits | inserted `kt-2026-9999` + `kt-2026-10000`, ran both orderings | numeric → `kt-2026-10000`; lexical → `kt-2026-9999` |
| year scoping excludes other years and handles an empty year | same probe with a `kt-2025-` row and a `kt-2027-` query | other year excluded; empty year → `undefined` → sequence starts at 1 |

Probes were throwaway files under `apps/server/src/` (needed for workspace module resolution),
deleted immediately after each run. `git status` confirms none remain.

## 6. Findings for the orchestrator

**No test is wrong.** I did not have to work around anything in `tasks.test.ts`; every assertion I
hit was satisfiable by writing the behaviour the spec describes.

Two notes that are not defects but are worth carrying forward:

1. **CLAUDE.md's Project Snapshot is stale in two places** and should be corrected when docs are
   docked: it says `@kaola/forge-adapters` "exports `createForgeAdapter` / `validateToken`" (there
   is no standalone `validateToken` export — only `createForgeAdapter(kind, opts).validateToken`),
   and it says "Server does not import `@kaola/forge-adapters`" plus "task CRUD … not implemented",
   both of which this change makes untrue. The `Commands` section's `pnpm test` line also still
   omits `apps/server/src/tasks.test.ts`, which the root `package.json` now runs.
2. **`docs/api.md:130` states "There is no `tasks` table."** — now false.
