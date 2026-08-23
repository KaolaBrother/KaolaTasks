# Ground truth — GitHub issue #21 (publish: read-only imported Issue, drop Kaola extra fields)

Measured on worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`.

- `HEAD` = `0c2d15d53d6ce41b82fd8aa2ebf6028c019b1d50` (`0c2d15d chore: record the workflow claim for issues 20 and 21`).
- `git merge-base --is-ancestor d5fe1b8 HEAD` succeeds. `d5fe1b8` subject: `fix: GitLab OAuth token exchange and publish-form field order`.
- This tree already contains that commit as **baseline**, not dirty WIP. Form DOM order is credential → repo → issue/task. Title/description remain editable `n-input`. `task-group-acceptance` is still present.
- Issue https://github.com/KaolaBrother/KaolaTasks/issues/21 : state open; **one comment** is workflow bookkeeping (`Kaola-Workflow started local work for bundle-20-21`), not a design override. Body is current.

No tracked source was edited for this investigation.

---

## Exploration: Publish pane (issue #21)

### Entry Points

- Member workbench **发布** pane: `apps/web/src/App.vue` `workbench-pane-publish` (`v-if="canApprove"`, `canApprove` = `me.status === 'active' && me.permission_level === 'full'`).
- Import button `@click="importTask"` → `POST /api/v1/tasks/import` (`importTask`, ~1751).
- Publish button `@click="createTask"` → `POST /api/v1/tasks` (`createTask`, ~1650).
- Server: `registerTasks` in `apps/server/src/tasks.ts` (`POST /api/v1/tasks`, `POST /api/v1/tasks/import`).

### Execution Flow (current, 0c2d15d)

1. Default `taskSourceType = 'native'`, `taskCredentialMode = 'profile'`, `taskPriority = 'P2'`.
2. Profile path hides forge / base_url / repo hand-fills; selecting a profile copies forge/url/repo from the profile row and, when source is imported, `GET /api/v1/credential-profiles/:id/issues`.
3. Source `imported` reveals Issue URL (inline) or Issue select (profile), plus `task-import`, plus `task-import-source-label` **「导入内容」** (shown for imported even before a successful import).
4. Title + description are **the same two `n-input`s** for native and imported. Labels/placeholders swap. No `readonly` / `disabled` in the publish form template (lines 230–384).
5. `importTask` on 200 writes `body.title` → `taskTitle`, `body.description_md` → `taskDescription`, `body.repo.full_name` → `taskRepo`, forces `taskSourceType = 'imported'`. Does **not** copy `body.source.issue_url` (the form already holds `taskIssueUrl`). Inputs stay editable.
6. `createTask` requires `taskTitle.trim()`, repo `full_name`, imported `issue_url`, and credential. JSON body **always includes** extra Kaola keys (see §3).

---

## 1. Publish pane structure (`App.vue` on this commit)

DOM order of groups (after `d5fe1b8`):

| Order | testid | What it contains |
|------:|--------|------------------|
| 1 | `task-group-credential` | 235 | `task-credential-feedback`, `task-credential-mode` (`profile` / `inline`), `task-credential-profile`, `task-profile-empty-hint`, `task-credential-token` |
| 2 | `task-group-repo` | 272 | inline-only `task-forge`, `task-base-url`, `task-repo`; nested `<details data-testid="task-group-advanced">` (`task-base-branch`, `task-suggested-dir`) |
| 3 | `task-group-task` | 296 | `task-source-type`; imported+inline `task-issue-url`; imported+profile `task-issue-select`; imported `task-import` (button text `导入`); imported `task-import-source-label` (`导入内容`); **always** `task-title` + `task-description` |
| 4 | `task-group-acceptance` | 345 | `task-acceptance-criteria`, `task-test-command`, `task-allowed-paths`, `task-forbidden-paths`, `task-priority`, `task-tags` |
| — | `task-submit` / `task-message` | 385+ | 发布 |

Labels when `taskSourceType === 'imported'` (still wrapping `n-input`, not a read-only card):

- 331: `'标题（来自 Issue）'` vs `'标题'`
- 334–340: `'描述（Issue 正文）'` vs `'描述'`; placeholder `'Issue 正文（Markdown）'` vs `'Markdown 描述（可选）'`

`task-title` / `task-description` are **not** `v-if`'d by source type. Native and imported share one pair of editable inputs.

`n-form` testid: `task-form`. Pane: `workbench-pane-publish`.

---

## 2. After import success

`importTask` (`App.vue` 1751–1787):

- POST `/api/v1/tasks/import` with `{ issue_url, repo: { forge, base_url }, credential }` (`{ token }` XOR `{ profile_id }`).
- On 200: fill `taskTitle`, `taskDescription`, `taskRepo` from `title` / `description_md` / `repo.full_name`; set source to `'imported'`.
- Fields remain the same `n-input` testids `task-title` / `task-description` (editable).
- `task-import-source-label` is already visible whenever source is imported (330), not gated on a successful import.
- No read-only card, no markdown preview, no dedicated clickable Issue link in the publish pane (Issue URL lives in `task-issue-url` or the select; profile path hides the URL input).

`createTask` still `if (!title) return` (1654), so publish on the imported path still depends on the title ref (currently the editable input).

---

## 3. Publish POST body (`createTask` 1693–1711)

**Always sent** (keys present even when the user left extras blank):

- `title`, `description_md` (raw textarea value, not trimmed for description)
- `source` — `{ type: 'native' }` or `{ type: 'imported', issue_url }`
- `repo` — `forge`, `base_url`, `full_name`; `base_branch` / `suggested_dir` **omitted** when trim is empty (1673–1676)
- `acceptance_criteria`: `splitLines(taskAcceptanceCriteria)` → `string[]` (empty array if blank)
- `test_command`: `taskTestCommand` **as typed**, including `''`
- `constraints`: `{ allowed_paths: splitLines(...), forbidden_paths: splitLines(...) }`
- `priority`: `taskPriority` (default ref `'P2'`)
- `tags`: `splitLines(taskTags)`
- `credential`: `{ token }` or `{ profile_id }`

**Never sent:** `id`, `pr_convention`, `poster`, `status`, `created_at` (form tests pin this).

`splitLines` (1150–1155): split on `\n`, trim, drop empty lines.

Issue #21 wants extras **omitted** from the request so the server defaults apply. Today they are **always included**. Empty extras currently serialize as:

```
acceptance_criteria: []
test_command: ''
constraints: { allowed_paths: [], forbidden_paths: [] }
priority: 'P2'
tags: []
```

That happens to equal server defaults, but it is **not** omission.

---

## 4. Server defaults when keys omitted (`POST /api/v1/tasks`)

`readCreateBody` `apps/server/src/tasks.ts` 305–360:

| Key | Omitted | Invalid |
|-----|---------|---------|
| `description_md` | `''` (322) | non-string → `undefined` body → 400 |
| `source` | `readSource` (native if omitted — see `readSource`) | bad → 400 |
| `acceptance_criteria` | `readStringArray(..., [])` → `[]` (331) | non-array → 400 |
| `test_command` | `''` (334) | non-string → 400 |
| `constraints` | `readConstraints(undefined)` → `{ allowedPaths: [], forbiddenPaths: [] }` (193) | null/non-object → 400 |
| `priority` | `'P2'` (340) | not in P0–P3 → 400 |
| `tags` | `readStringArray(..., [])` → `[]` (343) | non-array → 400 |

Required still: non-empty `title`, `repo.forge/base_url/full_name`, `credential`.

Documented in `docs/api.md` 146 (same defaults).

Pinned by `apps/server/src/tasks.test.ts` 987–1009 (`a minimal request body is completed with the documented defaults`): POST with only `title` + `repo` + `credential.token` → brief `description_md ''`, `source { type: 'native' }`, `repo.base_branch 'main'`, `repo.suggested_dir` last segment, `acceptance_criteria []`, `test_command ''`, `constraints { allowed_paths: [], forbidden_paths: [] }`, `priority 'P2'`, `tags []`, `status '待认领'`.

---

## 5. Web tests that will break / already encode extras

### `apps/web/src/App.form.test.ts`

Helpers still drive extras and shared title inputs:

- `fillRequired` 317–320: **always** `setField(..., 'task-title', ...)`.
- `fillEverything` 323–341: fills title, description, imported source, extras (`task-acceptance-criteria`, `task-test-command`, `task-allowed-paths`, `task-forbidden-paths`, `task-priority`, `task-tags`).

Assertions that encode current behavior:

- 367–392 `完整填写后提交，请求体精确匹配…`: body **must** contain `acceptance_criteria` (two lines), `test_command: 'pnpm test'`, `constraints`, `priority: 'P1'`, `tags`.
- 406–424 `未填写的 base_branch 与 suggested_dir 被省略…`: **still expects extras present** as empty/`P2` (`priority 'P2'`, `test_command ''`, `acceptance_criteria []`, `tags []`, `constraints` empty arrays) — opposite of issue #21 “omit keys”.
- 427–442 `四个 string[] 字段按行拆分`: `setField` on `task-acceptance-criteria` / `task-tags` / `task-allowed-paths` / `task-forbidden-paths`.
- Native required / inline / empty-title tests (548+, 504, 534, 554, 570, 577, 666): `task-title` as an input.
- Import block 718+:
  - 731: `task-import-source-label` visible as soon as source is imported, text `导入内容`.
  - 743: POST `/api/v1/tasks/import` (must stay).
  - 780–794 `200 后填入标题、描述…`: `setField` old title/description then **`fieldValue(wrapper, 'task-title')` / `task-description`** equal to import payload — **requires editable inputs after import**.

Form-order vs `d5fe1b8`: `fillRequired` fills title then profile (not DOM order). **No test asserts group previous-sibling order.** Tests do not fail solely because credential is now first in the DOM.

### `apps/web/src/App.shell.test.ts`

387–395 `full 用户五个 task-group-* 都在`:

```
task-group-task
task-group-repo
task-group-advanced
task-group-acceptance
task-group-credential
```

Existence only, listed in **pre-`d5fe1b8` conceptual order** (task → repo → advanced → acceptance → credential). Actual DOM after `d5fe1b8` is credential → repo → task → acceptance. `task-group-acceptance` **must stay true** today; issue #21 removes that group for both sources → this `it` breaks.

397–403: `task-group-advanced` closed; `task-base-branch` / `task-suggested-dir` still in document (out of #21 scope).

Shell/form/board fixtures still type `acceptance_criteria` on board task objects (list/get shape — not the publish form).

### Other web tests

- `App.board.test.ts`, `App.audit.test.ts`, `App.settings.test.ts`: no `task-group-acceptance` / extra publish field testids.
- `App.board.test.ts` 649–658: `description_md` rendered as **text**, not HTML/markdown.
- `App.board.test.ts` 670–680: imported detail shows `board-detail-import-label` exactly `导入内容` plus `board-detail-issue-url`.

---

## 6. DESIGN.md wording

There is **no** dedicated 「发布向导」section. The only hit is architecture bullet:

- `docs/DESIGN.md` 71: Web includes 「发布向导」.

§6 Task Brief (`docs/DESIGN.md` 101–141): example JSON **includes** `acceptance_criteria`, `test_command`, `constraints.allowed_paths` / `forbidden_paths`, `priority`, `tags`. Example priority `"P1"`. **No omitted-key defaults** in DESIGN (those live in `docs/api.md` 146). Issue #21: do **not** delete Brief keys.

§7 档案下拉导入 (`docs/DESIGN.md` 158–159):

- Profile dropdown **is** the repo picker; native still hand-fills title/description.
- Imported + profile: load **open** Issue dropdown `#{number} {title}`; picking does **not** auto-import.
- 「导入」still `POST /api/v1/tasks/import` **预填标题/正文** (not 落库, not 发布即校验); then `POST /api/v1/tasks`.
- `POST /import` and `POST /tasks` request-body contracts unchanged; Brief unchanged.

Issue #21 wants DESIGN 发布向导 text updated to: imported = read-only Issue copy; extras not collected.

---

## 7. Markdown rendering already in the app

**None.** `apps/web/package.json` dependencies: `naive-ui`, `vue` only (no `marked` / markdown-it / naive `n-text` markdown helper).

Board detail (`App.vue` 171–188):

- `board-detail-title` / `board-detail-description`: `{{ selectedTask.title }}` / `{{ selectedTask.description_md }}` (interpolation → text).
- imported: `board-detail-import-label` text `导入内容`.
- `board-detail-issue-url`: `<a :href>` only if `boardIssueUrlIsHttp` (http/https); else text (`boardIssueUrl` 1139–1148 returns `task.source.issue_url` for imported).

`App.board.test.ts` 649 explicitly requires description **not** to grow `script` / `img` nodes.

Reuse for a publish read-only card: same **text** (or monospace) preview + the http(s) `<a>` pattern + 「导入内容」label. A real Markdown renderer would be new.

---

## 8. Native vs imported UI (`taskSourceType`)

Ref: `taskSourceType` `'native' | 'imported'`, default `'native'` (768). Options: `平台自有` / `从 Issue 导入` (822–825).

| UI | native | imported |
|----|--------|----------|
| `task-issue-url` | hidden | inline credential only |
| `task-issue-select` | hidden | profile credential only |
| `task-import` | hidden | shown |
| `task-import-source-label` | hidden | shown (even pre-import) |
| `task-title` / `task-description` | shown, editable | **same inputs**, different labels |
| `task-group-acceptance` | shown | shown |
| `createTask` source | `{ type: 'native' }` | `{ type: 'imported', issue_url }` |
| `createTask` guard | title + repo + cred | also non-empty `issue_url` |
| watch issues GET | skip | profile mode only |

No other `v-if` on extras by source type.

---

## 9. Import POST and tasks POST contracts (issue: do not change)

### `POST /api/v1/tasks/import` (`docs/api.md` 158–174, `tasks.ts` ~641–746)

- Gate: session `active`+`full`; no persist; no `validateToken`.
- Request: `{ issue_url, repo: { forge, base_url, full_name? }, credential: { profile_id } XOR { token } }`.
- 200: `{ title, description_md, source: { type: 'imported', issue_url }, repo: { forge, base_url, full_name } }` — **not** a Task Brief; **no** forge token.

Adapter return (`packages/forge-adapters/src/index.ts` 22–27, 493–497): `{ title, description_md, issue_url, repo: { full_name } }`. Issue #21: do not change this shape.

Web already uses this POST; only the **display** of the 200 payload should become a read-only card.

### `POST /api/v1/tasks` (`docs/api.md` 140–156)

- Request `credential` `{ profile_id } XOR { token }` (not Brief `{ inline: true }`).
- Response 201 = Task Brief (`status` `待认领`), including defaulted extra keys if omitted.
- Issue #21: **request/response shape unchanged**; client may omit optional keys.

### Must not change (issue body)

- Task Brief key set (`packages/shared/src/index.ts` `taskBriefSchema` still requires `acceptance_criteria`, `test_command`, `constraints`, `priority`, `tags`).
- MCP `get_task_brief` / claim reveal channels.
- Import adapter return shape.

---

## Gap vs issue #21 (facts, not a plan)

| Issue wants | On `0c2d15d` |
|-------------|--------------|
| Imported: read-only title / markdown-or-mono body / clickable `source.issue_url` | Editable `task-title` / `task-description`; no publish-pane issue link card |
| No `task-title` / `task-description` **inputs** on imported path | Both exist for both sources |
| Drop extras UI for **both** sources | Entire `task-group-acceptance` + six field testids present unconditionally |
| POST omit extra keys | POST always sends them (empty/`P2`) |
| Empty card not shown before import | `task-import-source-label` shows for all imported |
| DESIGN 发布向导 matches | No 发布向导 section; §7 still says 预填标题/正文 |

---

## Key Files

| File | Role | Importance |
|------|------|------------|
| `apps/web/src/App.vue` | Publish form + import + POST body + board detail preview | Critical |
| `apps/web/src/App.form.test.ts` | Encodes extras-in-body + post-import editable title/description | Critical |
| `apps/web/src/App.shell.test.ts` | Requires `task-group-acceptance` | High |
| `apps/server/src/tasks.ts` | Omit-key defaults; import 200 shape | Critical (read, not change for #21 UI) |
| `apps/server/src/tasks.test.ts` 987 | Minimal-body defaults | High |
| `docs/api.md` 140–174 | HTTP contracts | High |
| `docs/DESIGN.md` §6–§7 | Brief keys; 预填 wording | High |
| `packages/shared/src/index.ts` | Brief key set (leave) | High |
| `packages/forge-adapters/src/index.ts` | `ImportedIssue` (leave) | High |
| `apps/web/src/App.board.test.ts` | Text preview + 导入内容 + issue `<a>` | Reuse |

### Dependencies

- External: Vue 3, Naive UI `n-form` / `n-input` / `n-select` / `n-text` (no markdown lib).
- Internal: `@kaola/shared` brief schema; `@kaola/forge-adapters` `importIssue`; server `registerTasks`.

### Recommendations for New Development (for implementers; not done here)

- Follow existing `board-detail-import-label` + `board-detail-issue-url` http(s) `<a>` pattern for the imported card; keep description as text/monospace unless a markdown lib is explicitly added.
- Reuse `taskTitle` / `taskDescription` / `taskIssueUrl` refs for POST; drop `n-input` testids on imported only.
- Omit extra keys in `JSON.stringify` rather than sending empty arrays (tests today require the opposite).
- Avoid changing import/tasks HTTP parsers, Brief schema, MCP, or adapter `ImportedIssue`.
