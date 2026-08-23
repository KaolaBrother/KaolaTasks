# Tests — issue #21 (publish wizard: read-only imported Issue, drop Kaola extra fields)

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`  
Role: tdd-guide (tests only; `App.vue` / `apps/server/src/tasks.ts` not edited)  
Command: `cd …/bundle-20-21 && pnpm --filter @kaola/web test`

## Baseline

```
RED: 8 failed / 87 passed (2 files failed, 3 passed)
baseline: 0c2d15d53d6ce41b82fd8aa2ebf6028c019b1d50
```

`git merge-base --is-ancestor d5fe1b8 HEAD` holds. Title/description are still editable `n-input`s; `task-group-acceptance` is still in the DOM; POST `/api/v1/tasks` still sends extra keys. Tests describe the **new** UI and failed on this commit.

## Files changed (worktree only)

- `apps/web/src/App.form.test.ts`
- `apps/web/src/App.shell.test.ts`

No production files. No commit.

## Testids the implementer must match (do not invent a second set)

Imported path after successful `POST /api/v1/tasks/import` 200:

| testid | pin |
|--------|-----|
| `task-import-card` | read-only Issue card; **absent** before a successful import; **absent** on native source |
| `task-import-card-title` | title as **text**, not an input/textarea |
| `task-import-card-body` | description preview as text (no markdown library) |
| `task-import-card-url` | clickable `source.issue_url` (`<a href>` on the node or a descendant) |

On imported source after successful import: `task-title` and `task-description` **must not exist**.  
Native source still **has** `task-title` and `task-description`.

Both source types — must **not** exist:

- `task-group-acceptance`
- `task-acceptance-criteria`
- `task-test-command`
- `task-allowed-paths`
- `task-forbidden-paths`
- `task-priority`
- `task-tags`

`task-import-source-label`: suite prefers `task-import-card` absence until import 200; if the label is kept, it must **not** appear as an empty stand-in before import (asserted `exists === false` on imported-before-200).

## `it(` added / rewritten

### `App.form.test.ts`

Helpers: removed `fillEverything` (it filled extras). Added `expectNoKaolaExtraFields`, `expectOmittedExtraBodyKeys`, `importCardAnchor`. Import 200 fixture constants live once at the top (`IMPORT_TITLE` / `IMPORT_DESCRIPTION` / `IMPORT_ISSUE_URL` / `IMPORT_DRAFT`).

**Rewrote (request line):**

- `导入成功后发布：请求体含 title / description_md / source / repo / credential，省略验收等附加键`  
  (was: 完整填写 + extras in JSON). Import 200 first, then publish. Body is exactly `title`, `description_md`, `source`, `repo` (with filled `base_branch` / `suggested_dir`), `credential`. **Omits** `acceptance_criteria`, `test_command`, `constraints`, `priority`, `tags`. Title/description come from the import 200, not from inputs.
- `平台自有字段 id / pr_convention / poster / status / created_at 不出现在请求体里` — now uses `fillRequired` (native) instead of `fillEverything`.
- `未填写的 base_branch 与 suggested_dir 被省略，且不发送验收等附加键` — still omits empty repo extras; **no longer** expects empty/`P2` extra keys; exact remaining keys `{ title, description_md, source, repo, credential }`.
- **Removed** `四个 string[] 字段按行拆分…` (those inputs go away).
- Credentials/Accept loop: imported+profile + import 200 + publish (still covers GET …/issues and POST /import).

**Rewrote (import):**

- `导入成功前不渲染 task-import-card；native 来源也没有该卡片`  
  (was: `task-import-source-label` visible as soon as source is imported).
- `200 后渲染只读 Issue 卡片，不再有 task-title / task-description 输入`  
  (was: `fieldValue(..., 'task-title')` after import 200).

**Kept:** import POST shape, inline XOR token, empty native title blocks, missing Issue blocks, profile empty hint, credential XOR, 201 id message, failure copy.

**Added** describe `发布任务表单 — 发布向导不再收集附加字段（issue #21）`:

- native still has title/description inputs; no import card; no extras
- imported (before and after 200) has no extras
- native publish still types title/description; extras omitted from JSON

### `App.shell.test.ts`

- Rewrote `full 用户五个 task-group-* 都在` → `full 用户四个 task-group-* 都在，且没有验收分组与附加字段`  
  Still requires `task-group-task` / `repo` / `advanced` / `credential`. **Forbids** `task-group-acceptance` and the six extra field testids. Does **not** assert pre-`d5fe1b8` DOM sibling order.

## Failure signature (current production)

Command: `pnpm --filter @kaola/web test`  
Vitest: 8 failed | 87 passed | 2 failed files | 3 passed files.

```
RED: 导入成功后发布：请求体含 title / description_md / source / repo / credential，省略验收等附加键
     AssertionError: expected [ 'title', 'description_md', …(8) ] to not include 'acceptance_criteria'

RED: 未填写的 base_branch 与 suggested_dir 被省略，且不发送验收等附加键
     AssertionError: expected […] to not include 'acceptance_criteria'

RED: native 来源仍有标题/描述输入，没有导入卡片，也没有验收分组与附加字段
     AssertionError: expected exists false, received true  testid: "task-group-acceptance"

RED: imported 来源在导入成功前后都没有验收分组与附加字段
     AssertionError: expected exists false, received true  testid: "task-group-acceptance"

RED: native 发布把手填标题写入请求体，仍省略附加键
     AssertionError: expected […] to not include 'acceptance_criteria'

RED: 导入成功前不渲染 task-import-card；native 来源也没有该卡片
     AssertionError: expected true to be false
     (task-import-source-label still rendered as soon as source=imported — empty stand-in)

RED: 200 后渲染只读 Issue 卡片，不再有 task-title / task-description 输入
     AssertionError: expected false to be true
     (task-import-card missing; title/description remain n-inputs)

RED: full 用户四个 task-group-* 都在，且没有验收分组与附加字段
     AssertionError: expected true to be false
     task-group-acceptance still exists
baseline: 0c2d15d53d6ce41b82fd8aa2ebf6028c019b1d50
```

These are the near-misses the suite is meant to catch: extras still in the POST (empty/`P2`), extras still in the form, import still filling editable inputs, empty 「导入内容」 before import 200.

## Command tail

```
 Test Files  2 failed | 3 passed (5)
      Tests  8 failed | 87 passed (95)
   Duration  6.39s
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @kaola/web@0.0.0 test: `vitest run`
Exit status 1
```

Implementer: make these 8 green in `App.vue` (`createTask` omit extra keys; imported read-only card; drop `task-group-acceptance`). Do not author or “fix” this suite.
