# tests-board — `apps/web/src/App.board.test.ts` (issue #8)

**Artifact (worktree):** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17/apps/web/src/App.board.test.ts`
**Handoff (MAIN checkout):** `kaola-workflow/bundle-8-17/.cache/tests-board.md`
**Verbatim RED capture:** `kaola-workflow/bundle-8-17/.cache/tests-board-baseline.txt`
**Baseline SHA:** `190a79aa5bc806286cb62ad8cddba5d40e65fb47` (worktree HEAD; `App.vue` has no board)

I wrote tests only. **`App.vue`, `main.ts`, server sources, `DESIGN.md`, `App.form.test.ts`, and `package.json` were not modified.** `App.form.test.ts` still has 27 tests, all green.

---

## 1. Command and baseline proof

From the worktree:

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17
CI=true pnpm --filter @kaola/web test
```

```
 Test Files  1 failed | 1 passed (2)
      Tests  17 failed | 27 passed (44)
```

- **`App.board.test.ts`: 17 failed, 0 passed** — RED on baseline is the outcome.
- **`App.form.test.ts`: 27 passed** — not modified. Isolation re-check: `CI=true pnpm --filter @kaola/web exec vitest run src/App.form.test.ts` → `Tests  27 passed (27)`.
- Web typecheck after the suite was added: `CI=true pnpm --filter @kaola/web typecheck` → exit 0.

Do **not** treat a later green board suite as tdd-guide success. Green is the implementer's job.

---

## 2. RED signatures

Two failure shapes. Vitest collapses the 16 `mountBoard` failures onto one stack.

**A. Board seam missing** (16 tests) — `mountBoard` waits for `[data-testid="board"]`:

```
AssertionError: expected false to be true // Object.is equality
 ❯ src/App.board.test.ts:284:53
    expect(node(mounted.wrapper, 'board').exists()).toBe(true)
```

Once `board` exists, these tests fall through to the next missing seam (`board-kanban`, `board-column-待认领`, `board-filter-status`, `board-card-kt-2026-0001`, `board-detail`, …). Honour the table in §3; do not rename.

**B. List fetch missing** (1 test) — member workbench never calls the list URL:

```
AssertionError: expected 0 to be greater than 0
 ❯ src/App.board.test.ts:419:38
    expect(listGets(calls).length).toBeGreaterThan(0)
```

`listGets` is `GET` + url **exactly** `/api/v1/tasks`. A query string (`?status=…`) does not match, and will also trip `App.form.test.ts`'s defensive stub.

---

## 3. THE SEAM — the `data-testid` contract

Put the attribute on the Naive (or native) root, same as the form suite. Prefix is `board-*` so nothing collides with `task-form` / `task-submit` / `task-title` / ….

| testid | element | notes |
|---|---|---|
| `board` | board root (inside the 工作台 / `view === 'member'` card) | presence = member gate; `.text()` is the chrome oracle |
| `board-view-list` | clickable (n-button is fine) | `.text()` contains `列表`; suite `trigger('click')`s it |
| `board-view-kanban` | clickable | `.text()` contains `看板`; default view after mount |
| `board-kanban` | kanban layout root | **XOR** with `board-list`: exists only in 看板 mode |
| `board-list` | list layout root | exists only in 列表 mode; columns must **not** exist |
| `board-column-待认领` | column | heading text contains `待认领`; always present in 看板 |
| `board-column-进行中` | column | same; fixture places `kt-2026-0002` here |
| `board-column-待验收` | column | empty in the fixture — still rendered |
| `board-column-已完成` | column | empty in the fixture |
| `board-column-已退回` | column | empty in the fixture |
| `board-column-已取消` | column | fixture places `kt-2026-0003` here |
| `board-card-kt-2026-0001` | clickable card/row | title `为订单导出接口增加分页`; 待认领 + gitea + tags `backend`,`api` |
| `board-card-kt-2026-0002` | clickable | 进行中 + github + `{ inline: true }` |
| `board-card-kt-2026-0003` | clickable | 已取消 + gitlab |
| `board-card-kt-2026-0004` | clickable | XSS fixture; title is the literal `<img src=x onerror=alert(1)>` |
| `board-filter-status` | `n-select` | driven with `vm.$emit('update:value', …)` |
| `board-filter-tag` | `n-select` | same |
| `board-filter-forge` | `n-select` | same |
| `board-detail` | detail pane | in-app state; no vue-router |
| `board-detail-title` | text | |
| `board-detail-description` | text | `{{ }}` / `n-text` / `<pre>` — never `v-html` |
| `board-detail-status` | text | enum string |
| `board-detail-poster` | text | brief `poster` |
| `board-detail-tags` | text | |
| `board-detail-forge` | text | `repo.forge` |
| `board-detail-credential` | text | Chinese only — see §5.12 |
| `board-detail-issue-url` | imported only | https → `<a href>`; `javascript:` → text, **no** `<a>` |
| `board-detail-close` | clickable | `.text()` contains `关闭`; removes `board-detail` |
| `board-timeline` | timeline root | |
| `board-timeline-item` | exactly one child | the synthetic 发布 row |

Do **not** create `board-timeline-认领` / `board-timeline-心跳` / `board-timeline-提交` / `board-timeline-完结`.

### How each kind is driven

- **cards / view buttons / close** — `trigger('click')` on the tagged root. Handler on `@click`.
- **`n-select`** — `findAllComponents(NSelect)` filtered on `attributes('data-testid')`, then `vm.$emit('update:value', v)`. Bind `v-model:value`. The suite also reads `props('options')`.
- **filtered-out cards** — must **not exist** in the DOM (`v-if`), not `display:none`. `node(wrapper, 'board-card-…').exists()` is the oracle.
- **kanban vs list** — structural XOR (`v-if` / `v-else`), same as the form's credential XOR.

---

## 4. How fetch is stubbed

Copied from `App.form.test.ts`: router keyed on `` `${METHOD} ${url}` ``, restored in `afterEach`. Unrouted → `500 { error: 'unstubbed', method, url }` and still recorded.

Default `mountApp` routes:

| route | response |
|---|---|
| `GET /api/v1/me` | `200` the `me` fixture (default `active` + `full`) |
| `GET /api/v1/agent-keys` | `200 { keys: [] }` |
| `GET /api/v1/credential-profiles` | `200 { profiles: [ #3 gitea team/orders, #5 gitlab team/billing ] }` |
| `GET /api/v1/tasks` | `200 { tasks: BOARD_TASKS }` (empty array for the empty-board test) |
| `POST /api/v1/tasks` | `201` a §6 brief (unused by the board; keeps an accidental submit from looking like an unstubbed 500) |

**`GET /api/v1/tasks/:publicId` is not registered.** Opening detail must use the list payload. An extra GET one is 500 + fails `taskItemGets(calls) === []`.

List envelope is `{ tasks: Brief[] }`. Brief keys are the live set only: `id` `title` `description_md` `source` `repo` `acceptance_criteria` `test_command` `constraints` `pr_convention` `credential` `priority` `tags` `poster` `status` `created_at`. `credential` is `{ profile_id: '3' }` XOR `{ inline: true }`.

Every fetch — including `GET /api/v1/tasks` — must carry `credentials: 'include'` and `Accept: application/json`. The suite iterates **all** recorded calls.

---

## 5. Judgement calls the implementer must respect

Orchestrator rulings in `orchestrator-rulings.md` are not reopened. These are the remaining pins the suite now freezes.

1. **Board lives only on `view === 'member'`** (active `claim_only` **and** `full`). Pending card (`账号待批准`) and login card have no `board`. Server GET would allow 待批准; the web gate stays stricter. `claim_only` sees 工作台 + board and still does **not** see `task-form`.
2. **Default layout is 看板.** After mount, `board-kanban` exists and `board-list` does not. Click `board-view-list` / `board-view-kanban` to XOR. Filters sit **outside** that XOR so they survive a toggle.
3. **List fetch URL is exactly `GET /api/v1/tasks`** (no query string), once on member mount. Filters do not refetch. No `GET /api/v1/tasks/:id`.
4. **Detail is in-app selected-task state** from the list payload. No vue-router, no Pinia, no markdown/sanitizer packages.
5. **Six kanban columns are the six status strings in enum order** left-to-right: `待认领` `进行中` `待验收` `已完成` `已退回` `已取消`. Empty columns stay. A 进行中 fixture is stubbed so the mapping is observable even though no live writer produces that status.
6. **Within a column, card order follows the list array** (`kt-2026-0001` then `kt-2026-0004` under 待认领). Do not re-sort by title.
7. **Filter `n-select` “all” value is `''` (empty string), label `全部`.** Status options: `['', '待认领', '进行中', '待验收', '已完成', '已退回', '已取消']`. Forge options: `['', 'github', 'gitlab', 'gitea']` (values; labels may reuse existing `GitHub` / `GitLab` / `Gitea`). Tag options: `''` first, then at least `backend` / `frontend` / `security` derived from the list (order of tags after `全部` is yours).
8. **Filters are AND across the three controls.** Tag match is `tags.includes(selected)`, not array equality. A card that fails any active filter is omitted from **both** layouts.
9. **Timeline synthesizes exactly one 发布 row** from brief `created_at` + `poster`. Render the ISO string verbatim (`2026-08-21T08:00:00Z` for `kt-2026-0001`) so the field is used, not `Date.now()`. Do **not** invent 认领 / 心跳 / 提交 / 完结 rows. Do **not** relabel `token 揭示` as 发布. There is no events HTTP in this run.
10. **`source.type === 'native'` → `board-detail-issue-url` absent.** Imported `http:` / `https:` `issue_url` **is** an `<a href>` with that exact URL (the ruling’s “MAY” is pinned as yes, so the javascript: deny-list has a positive counterpart). `javascript:alert(1)` is **text** under `board-detail-issue-url` and must not become any `a[href]`.
11. **`description_md` / title / tags / poster render as escaped text.** `<script>alert(1)</script>` must appear in `.text()` and must not create a `<script>` descendant. The XSS card title `<img src=x onerror=alert(1)>` must appear as text (card + detail) with no `<img>` descendant. No `v-html`.
12. **Credential chrome is the already-pinned Chinese:** `{ profile_id }` → `共享档案`; `{ inline: true }` → `单任务临时 token`. Never render `token` / `token_encrypted` / `inline_token_encrypted` / `access_token` / ciphertext / a PAT. The secrecy test mounts **claim_only** so the posting form’s `placeholder="forge token"` is out of the board/detail text.
13. **Chinese copy pinned by this suite** (character for character):

    ```
    任务看板
    列表
    看板
    全部
    关闭
    暂无任务。
    共享档案
    单任务临时 token
    发布
    ```

    Filter field labels asserted in chrome: `状态`, `标签`. Forge filter label may be `Forge` (already used on the posting form). Status column headings are the enum strings themselves. Do not ship `Kanban` / `Timeline` / `Backlog` in board or detail text.
14. **Close is a click on `board-detail-close`.** After it, `board-detail` is gone. Clicking another card may replace the open detail (the https-link test does this).
15. **Empty list (`{ tasks: [] }`) still shows `board` + six empty columns + `暂无任务。`** Same full-width `。` as `暂无 Agent Key。`.
16. **Do not implement claim / heartbeat / submit / PATCH-to-进行中.** Columns for those statuses may be empty in production; the 进行中 card is test-only JSON.

---

## 6. Claim that cannot be tested as the issue stated

Issue #8’s checkbox “详情页时间线显示 events（发布/认领/心跳/提交/完结）” assumes stored rows and writers that this tree does not have (no events HTTP; POST create does not write `发布`; no 认领/心跳/提交/完结 writers). Per orchestrator ruling #1 the suite **does not** invent those oracles. The honest MVP pin is one synthetic 发布 item. There is no failing test that requires a 认领/心跳/提交/完结 timeline row — do not add fake events to pass a sentence the server cannot satisfy.

---

## 7. Fixtures (brief shape, not invented keys)

| id | status | forge | tags | credential | source |
|---|---|---|---|---|---|
| `kt-2026-0001` | 待认领 | gitea | backend, api | `{ profile_id: '3' }` | native |
| `kt-2026-0002` | 进行中 | github | frontend | `{ inline: true }` | imported `https://github.com/org/app/issues/12` |
| `kt-2026-0003` | 已取消 | gitlab | backend | `{ inline: true }` | native |
| `kt-2026-0004` | 待认领 | gitea | security | `{ profile_id: '3' }` | imported `javascript:alert(1)`; `description_md` `<script>alert(1)</script>` |

---

## 8. Every test name (17)

### `任务看板 — 可见性（view === member）`
1. full 与 claim_only 看得到看板；待批准与未登录看不到

### `任务看板 — GET /api/v1/tasks`
2. 成员工作台拉取列表：URL 无 query，credentials 与 Accept 承重
3. 筛选与打开详情都不改 list URL，也不发 GET /api/v1/tasks/:id

### `任务看板 — 六个状态列`
4. 看板默认六列按枚举顺序，空列保留，卡片落在对应 status
5. 空列表仍渲染六个空列，并给出暂无任务。

### `任务看板 — 列表 / 看板切换`
6. 点「列表」只见列表，点「看板」只见看板；列表仍展示各标题

### `任务看板 — 客户端筛选`
7. 状态筛「待认领」藏起已取消；恢复「全部」后回来
8. 标签筛是 tags 数组成员资格，不是整列相等
9. forge 筛只留下 repo.forge 匹配的卡片
10. 状态与标签是 AND；列表视图共用同一套过滤

### `任务看板 — 详情与发布时间线`
11. 点击卡片打开详情，关闭后详情消失
12. 时间线恰好一条「发布」，文案带 poster 与 created_at；不发明心跳或 token 揭示
13. native 不渲染 issue 链接；imported 的 http(s) issue_url 是 a[href]

### `任务看板 — 凭证不泄露`
14. 详情只显示共享档案或单任务临时 token，不出现密文键名

### `任务看板 — XSS`
15. description_md 与危险标题按文本渲染，不长出 script / img 节点
16. javascript: issue_url 显示为文本，不变成 href

### `任务看板 — 中文文案`
17. 界面文案是中文：任务看板 / 列表 / 看板 / 全部 / 关闭，不含 Kanban 或 Timeline

---

## 9. Form suite custody

`apps/web/src/App.form.test.ts` was **not** edited. It still passes (27/27), including in isolation. Keep the board list URL query-less so its `GET /api/v1/tasks` stub continues to match. Do not add board assertions to that file.
