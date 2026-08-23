## Exploration: `@kaola/web` workbench as it exists NOW (issue #18 restyle baseline)

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18`
HEAD: `be2d963b792fced8360354cfc4530b91387d50ea`
Branch: `workflow/issue-18`
`git status --short`: empty (clean worktree)

Measured 2026-08-23 from this worktree only. No product files were edited. Identifiers, line numbers, testids, and Chinese copy below are quoted from source.

### Entry Points
- Browser: `apps/web/index.html` mounts `#app` via `apps/web/src/main.ts` (`createApp(App).use(naive).mount('#app')`).
- UI: a single SFC `apps/web/src/App.vue` (1177 lines). There is no vue-router, no other `.vue` file, and no CSS file under `apps/web`.
- Session bootstrap: `onMounted` always `GET /api/v1/me` (`credentials: 'include'`, `Accept: application/json`). `view` is then derived from `loaded` + `me`.
- Tests: four vitest files mount the same `App.vue` with `@vue/test-utils` + the naive-ui plugin and a keyed `fetch` stub.

### Execution Flow
1. `main.ts` registers naive-ui globally and mounts `App`.
2. `App.vue` wraps everything in `<n-config-provider :locale="zhCN" :date-locale="dateZhCN">` (no `theme-overrides`).
3. `onMounted` → `GET /api/v1/me`. 401 / network → `me = null`. OK → `me` + `trustedAutomation = me.trusted_automation === true`.
4. `loaded = true` → `view` becomes `'login' | 'pending' | 'member'`.
5. If `view === 'member'`: `GET /api/v1/tasks`, `GET /api/v1/events`, `GET /api/v1/stats` (no query string).
6. If `canManageKeys` (`me.status === 'active'`): `GET /api/v1/agent-keys`, `GET /api/v1/claim-confirmations`.
7. If `canApprove` (`me.status === 'active' && me.permission_level === 'full'`): `GET /api/v1/credential-profiles`.
8. Subsequent HTTP is click-driven (settings PUT, claim-confirmation approve/reject, user approve, agent-key CRUD, profile CRUD, POST task, POST import). **No `PATCH /api/v1/tasks/:publicId` call exists in the web app.**

### Architecture Insights
- **Single-file workbench:** all three views (login / pending / member) and every member widget live in one template, stacked with `n-space vertical` inside one `n-card title="工作台"`.
- **Gating is two computed flags, not routes:** `view` selects the card; `canApprove` / `canManageKeys` hide sections *inside* the member card. Field is `permission_level`, not `role`.
- **Client-side filters only:** board and audit never re-fetch on filter change; URLs stay query-free.
- **Status enum is local:** `BOARD_STATUSES` is a const in `App.vue`; `@kaola/shared` is **not** imported by the web app.
- **Naive-ui by global plugin:** production `app.use(naive)`; tests `mount(App, { global: { plugins: [naive] } })`. Components used as `n-*` tags.
- **Token chrome, never the token:** board detail shows `'共享档案'` or `'单任务临时 token'`. Session GET list/get are not called with `:id`. Claim of tasks (Bearer/MCP) has **no** UI button.

### Key Files
| File | Role | Importance |
|------|------|------------|
| `apps/web/src/App.vue` | Entire UI (1177 lines) | Canonical |
| `apps/web/src/main.ts` | Vue + naive mount | Entry |
| `apps/web/src/env.d.ts` | `*.vue` module shim | Types |
| `apps/web/src/App.board.test.ts` | 18 `it(` — 任务看板 | Pins testids + 「暂无任务。」/「导入内容」 |
| `apps/web/src/App.form.test.ts` | 33 `it(` — 发布任务 | Pins form testids + 「导入」/「导入内容」 + server error copy |
| `apps/web/src/App.audit.test.ts` | 16 `it(` — 审计/统计 | Pins audit/stats testids + 「审计日志」/「团队统计」 |
| `apps/web/src/App.settings.test.ts` | 8 `it(` — 受信自动化 / 待确认认领 | Pins toggle + confirmation testids |
| `apps/web/package.json` | `vue` `^3.5.0`, `naive-ui` `^2.45.0`; **no vue-router** | Deps |
| `apps/web/index.html` | `lang="zh-CN"`, title `考拉任务`, no fonts/CSS | Shell |
| `apps/web/vite.config.ts` | Vue plugin; proxy `/api`+`/login` → `:31415`; vitest `happy-dom`, `src/**/*.test.ts` | Tooling |
| `apps/server/src/tasks.ts` | `registerTasks` includes `PATCH /api/v1/tasks/:publicId` | Poster cancel/reopen |
| `apps/server/src/claim.ts` | Bearer `POST .../claim\|progress\|release` only — **no PATCH** | Agent claim |
| `packages/shared/src/index.ts` | `taskStatusSchema` / `transitionTaskStatus` | Used by **server**, not by `App.vue` |

### Dependencies
- External (web runtime): `vue` `^3.5.0`, `naive-ui` `^2.45.0`.
- External (web test/build): `@vitejs/plugin-vue`, `@vue/test-utils`, `happy-dom`, `vite`, `vitest`, `vue-tsc`.
- Internal: **none**. `App.vue` imports only `vue` (`computed`, `onMounted`, `ref`) and `naive-ui` (`dateZhCN`, `zhCN`). No `@kaola/shared`, no `@kaola/forge-adapters`.
- HTTP: same-origin `/api/v1/*` and `<a href="/login/{github\|gitlab\|gitea}">`. Vite dev proxies those prefixes to Fastify `127.0.0.1:31415`.

### Recommendations for New Development
- Follow the existing `data-testid` strings and the Chinese literals the four vitest files pin (especially 「导入内容」, 「导入」, 「暂无任务。」). Changing those **will** fail CI even if the restyle is visually correct.
- Reuse `view` / `canApprove` / `canManageKeys` as the gate; do not invent `me.role`.
- Avoid adding vue-router, `themeOverrides`, a 768px stylesheet, or PATCH/claim/MCP/webhook buttons unless a later ruling says so — none of those exist today.
- If UI later needs poster cancel/reopen, the server contract is already `PATCH /api/v1/tasks/:publicId` with body `{ status }` and the poster subset below. The web app does **not** call it today.

---

## 1. Views and gates

There is **no `me.role`**. The session body field is `permission_level` (`App.vue` `Me` type at 411–421; server `publicUser` in `apps/server/src/auth.ts:69–88` emits `permission_level: user.permissionLevel`).

### How `view` is chosen

```573:577:apps/web/src/App.vue
const view = computed(() => {
  if (!loaded.value || me.value == null) return 'login'
  if (me.value.status === '待批准') return 'pending'
  return 'member'
})
```

- `'login'`: `loaded === false` **or** `me === null` (401 / fetch throw / not OK).
- `'pending'`: `me.status === '待批准'` (exact string).
- `'member'`: any other logged-in user (tests use `status: 'active'`).

Template (`App.vue:8–27`): three mutually exclusive `n-card`s — `v-if="view === 'login'"` title **登录**; `v-else-if="view === 'pending'"` title **账号待批准**; `v-else-if="view === 'member'"` title **工作台**. Header **考拉任务** (`n-layout-header`, line 5) is always visible.

### `me.status` and `me.permission_level`

```579:587:apps/web/src/App.vue
const canApprove = computed(
  () => me.value?.status === 'active' && me.value?.permission_level === 'full',
)

const canManageKeys = computed(() => me.value?.status === 'active')

const permissionLabel = computed(() =>
  me.value?.permission_level === 'full' ? '正式成员' : '仅认领',
)
```

Greeting on the member card (line 29): `{{ me?.display_name }}，已登录（{{ me?.provider }} / {{ permissionLabel }}）`.

`trusted_automation` is additive and optional on `Me` (`trusted_automation?: boolean`). Missing key → toggle defaults off (`trustedAutomation.value = me.value?.trusted_automation === true` at 739).

### Exact conditions for each named block

All of the following except login/pending sit **inside** `view === 'member'`.

| Block | Gate in template | Condition (identifiers) |
|-------|------------------|-------------------------|
| 发布 form | `v-if="canApprove"` on `n-form data-testid="task-form"` (271–272) | `status === 'active'` **and** `permission_level === 'full'` |
| 凭证档案 | `v-if="canApprove"` (243–244) | same as 发布 |
| 批准用户 | `v-if="canApprove"` (185–186) | same as 发布 |
| Agent Key | `v-if="canManageKeys"` (225–226) | `status === 'active'` (full **or** claim_only) |
| 受信自动化 | `v-if="canManageKeys"` (192–193) | same as Agent Key |
| 待确认认领 | nested inside the 受信自动化 `canManageKeys` block (205–222) | same as Agent Key |
| 审计 | `data-testid="audit-section"` with **no extra v-if** (121–169) | any `view === 'member'` |
| 统计 | `data-testid="stats-section"` with **no extra v-if** (171–183) | any `view === 'member'` |
| 任务看板 | `data-testid="board"` with **no extra v-if** (31) | any `view === 'member'` |

`claim_only` therefore sees: 工作台 + 看板 + 审计 + 统计 + 受信自动化 + 待确认认领 + Agent Key. It does **not** see 发布 / 凭证档案 / 批准用户.

Pending (`status === '待批准'`) never reaches those blocks because `view === 'pending'`. Logged-out never reaches them because `view === 'login'`.

---

## 2. Every `data-testid` currently in `App.vue`

Static ids appear once unless noted. Dynamic ids are documented as patterns.

| `data-testid` | Element / purpose | Asserted by |
|---------------|-------------------|-------------|
| `board` | 任务看板 wrapper | board (exists, empty copy, chrome); form does not query it |
| `board-view-list` | 列表 toggle button | board |
| `board-view-kanban` | 看板 toggle button | board |
| `board-filter-status` | 状态 `n-select` | board |
| `board-filter-tag` | 标签 `n-select` | board |
| `board-filter-forge` | Forge `n-select` | board |
| `board-kanban` | kanban flex container | board |
| `board-column-${status}` | one column per `BOARD_STATUSES` entry | board (`board-column-待认领` … `已取消`) |
| `board-card-${task.id}` | card in kanban **or** list | board |
| `board-list` | list layout container | board |
| `board-detail` | detail pane (when `selectedTask`) | board |
| `board-detail-title` | title | board |
| `board-detail-description` | `description_md` | board (XSS) |
| `board-detail-status` | status | board |
| `board-detail-poster` | poster | board |
| `board-detail-tags` | `tags.join(' ')` | board |
| `board-detail-forge` | `repo.forge` | board |
| `board-detail-credential` | chrome string | board |
| `board-detail-import-label` | imported-only; text 导入内容 | board |
| `board-detail-issue-url` | imported issue URL (link or text) | board |
| `board-detail-close` | 关闭 | board |
| `board-timeline` | timeline wrapper | board (`textOf(..., 'board-timeline')`) |
| `board-timeline-item` | **one** synthetic 发布 row | board |
| `audit-section` | 审计日志 section | audit |
| `audit-filter-type` | 类型 `n-select` | audit |
| `audit-filter-actor` | 人 `n-select` | audit |
| `audit-filter-task` | 任务 `n-input` | audit |
| `audit-filter-from` | 起始时间 `n-input` | audit |
| `audit-filter-to` | 结束时间 `n-input` | audit |
| `audit-row` | one event row (repeats) | audit (`findAll`) |
| `stats-section` | 团队统计 section | audit |
| `stats-completed-count` | `完成数：{{ count }}` | audit |
| `trusted-automation-toggle` | `n-switch` | settings |
| `claim-confirmation-list` | 待确认认领 list (always rendered when `canManageKeys`) | settings |
| `claim-confirmation-approve` | 批准 per row | settings |
| `claim-confirmation-reject` | 拒绝 per row | settings |
| `task-form` | 发布 `n-form` | form + board visibility |
| `task-title` | 标题 | form |
| `task-description` | 描述 textarea | form |
| `task-source-type` | 来源 select | form |
| `task-import-source-label` | imported-only `n-text` | form |
| `task-issue-url` | Issue URL (imported) | form |
| `task-forge` | Forge select | form |
| `task-base-url` | 仓库地址 | form |
| `task-repo` | 仓库 | form |
| `task-base-branch` | 默认分支 | form |
| `task-suggested-dir` | 建议目录 | form |
| `task-acceptance-criteria` | 验收标准 textarea | form |
| `task-test-command` | 测试命令 | form |
| `task-allowed-paths` | 允许路径 textarea | form |
| `task-forbidden-paths` | 禁止路径 textarea | form |
| `task-priority` | 优先级 select | form |
| `task-tags` | 标签 textarea | form |
| `task-credential-feedback` | 凭证 `n-form-item` (error feedback) | form |
| `task-credential-mode` | 共享档案 / 单任务临时 token | form |
| `task-credential-profile` | profile select (mode=profile) | form |
| `task-credential-token` | password token (mode=inline) | form |
| `task-import` | 导入 button (imported only) | form |
| `task-submit` | 发布 button | form + board visibility |
| `task-message` | submit-level message | form |

**Not present as testids (verified):** 登录 card, 账号待批准 card, 批准 GitHub 用户 input/button, Agent Key widget, 凭证档案 widget, `n-divider` titles, header.

**Asserted absent (do not exist in App.vue):** board tests look up `board-timeline-认领`, `board-timeline-心跳`, `board-timeline-提交`, `board-timeline-完结` and expect `.exists() === false` (`App.board.test.ts:611–614`).

---

## 3. Pinned Chinese literals

Only strings the **existing vitest files actually assert**. Production copy that is **not** asserted is listed separately so a restyle does not confuse the two.

### Exact equality (`toBe`)

| Literal | Where | File |
|---------|-------|------|
| `导入内容` | `textOf(..., 'task-import-source-label').trim()` | `App.form.test.ts:704, 761` |
| `导入` | `textOf(..., 'task-import').trim()` | `App.form.test.ts:692` |
| `导入内容` | `textOf(..., 'board-detail-import-label').trim()` | `App.board.test.ts:680` |
| `全部` | first status-filter option **label** | `App.board.test.ts:519` |

### `toContain` on chrome / messages (must remain substrings of rendered text)

**Board (`App.board.test.ts`):**
- `'工作台'` (claim_only visibility, 398)
- `'账号待批准'` (pending, 404)
- `'登录'` (unauthorized, 409)
- `'暂无任务。'` (empty board, 490) — **includes the ideographic full stop**
- `'列表'` (497, 690)
- `'看板'` (498, 691)
- `'任务看板'` (689)
- `'全部'` (692)
- `'状态'` (693)
- `'标签'` (694)
- `'关闭'` (590, 700)
- `'待认领'` as detail status and as each column heading via `STATUSES` loop (463, 585)
- `'发布'` on the single timeline item (603)
- `'共享档案'` / `'单任务临时 token'` (634, 638)
- Status enum values used as column headings and filter values: `待认领`, `进行中`, `待验收`, `已完成`, `已退回`, `已取消` (`STATUSES` at 25; column order and `toContain(status)` at 456–463)
- Must **not** contain: `'Kanban'`, `'Timeline'`, `'Backlog'` (695–697, 701); timeline must not contain `'心跳'`, `'token 揭示'`, `'完结'` (608–610)

**Form (`App.form.test.ts`):**
- `'工作台'` (claim_only, 312)
- `'账号待批准'` (pending, 318)
- `'导入内容'` / `'导入'` (exact, above)
- Server-owned messages copied character-for-character (constants at 20–28, asserted 569–624, 771–779):
  - `token 无效或无权访问该仓库，任务未发布。`
  - `无法连接 forge 校验 token，任务未发布。`
  - `所选凭证档案不存在。`
  - `token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。` with fixtures `['推', 'PR']` and `'token 权限不足：缺少 PR 权限，任务未发布。'`
  - client fallback `凭证保险库未配置`
  - client fallback `` `发布失败（${status}）` `` e.g. `发布失败（400）`
  - `无法解析 Issue 地址。`
  - `导入失败（404）`
- Must **not** contain `'发布失败'` on import-failure paths (772, 780); 422-PR-only must **not** contain `'推'` (583); token-invalid path must **not** contain `'权限不足'` (594)

**Audit (`App.audit.test.ts`):**
- `'审计日志'` inside `audit-section` (442)
- `'团队统计'` inside `stats-section` (443)
- `'系统'` as actor-filter value and stats username (`SYSTEM_ACTOR_LABEL`, 23, 371, 390, 430)
- Live event **type** literals as filter option values (22, 359–365): `'token 揭示'`, `'状态迁移'`, `'心跳'`, `'变更'`, `'回写'`, `'认领待确认'`, `'认领已确认'`
- Must **not** contain `'Audit'`, `'Stats'`, `'Timeline'` (445–447)

**Settings (`App.settings.test.ts`):**
- `'账号待批准'` (227)
- `'登录'` (235)
- Does **not** `toContain` `'受信自动化'`, `'待确认认领'`, `'暂无待确认认领。'`, `'批准'`, or `'拒绝'` — only testids / HTTP.

### Empty-state copy in production **not** pinned by tests

Present in `App.vue` but **no** vitest `toContain`:

- `'暂无审计记录。'` (161) — empty-events test only checks `audit-row` count `0` (416–419)
- `'暂无完成记录。'` (178) — empty-stats test only checks `stats-completed-count` contains `'0'` (433–435)
- `'暂无待确认认领。'` (207) — empty-list test only checks container exists and 0 buttons (325–329)
- `'暂无 Agent Key。'` (236)
- `'暂无凭证档案。'` (262)

---

## 4. Layout as it is

### Shell
- `n-config-provider` → `n-layout style="min-height: 100vh"` → `n-layout-header bordered style="padding: 16px 24px"` + `n-layout-content style="padding: 24px"`.
- Member UI is **one** `n-card title="工作台"` containing **one** `<n-space vertical>` (28–400). Sections are stacked: greeting → board → `n-divider>审计日志` → audit → `n-divider>团队统计` → stats → (gated) 批准 / 受信自动化 / Agent Key / 凭证档案 / 发布.
- Confirmed: **no vue-router** (`package.json` deps are only `vue` + `naive-ui`; `App.audit.test.ts:450–452` asserts `(wrapper.vm as …).$router` is `undefined`; `App.vue` never imports `vue-router`).
- Confirmed: **no `themeOverrides` / `theme-overrides`** anywhere under `apps/web`.
- Confirmed: **no 768px CSS**, no media query, no stylesheet, no `<style>` block in `App.vue`.

### Kanban markup
Default `boardLayout` is `'kanban'` (`App.vue:526`).

```62:68:apps/web/src/App.vue
                <div v-if="boardLayout === 'kanban'" data-testid="board-kanban" style="display: flex; gap: 8px">
                  <div
                    v-for="status in BOARD_STATUSES"
                    :key="status"
                    :data-testid="'board-column-' + status"
                    style="flex: 1; min-width: 120px"
                  >
```

- Container: `display: flex; gap: 8px` (no wrap).
- Column: `flex: 1; min-width: 120px` — **not** 768.
- Column title is the raw status string (`待认领` …).
- Card is a `div` with the title text; click → `openBoardDetail`.
- List mode (`board-list`) is a flat stack of the same cards; columns are not rendered (`v-if` / `v-else`).

`BOARD_STATUSES` (`App.vue:524`):
`['待认领', '进行中', '待验收', '已完成', '已退回', '已取消']`

### 发布 form field order (DOM order)

`n-form` `label-placement="top"` `@submit.prevent`. Every `n-form-item` in order:

1. **标题** — `task-title` (`placeholder="标题"`)
2. **描述** — `task-description` textarea (`placeholder="Markdown 描述（可选）"`)
3. **来源** — `task-source-type` (options 平台自有=`native`, 从 Issue 导入=`imported`)
4. *(not a form-item)* `n-text` **导入内容** — `task-import-source-label`, only if `taskSourceType === 'imported'`
5. **Issue URL** — `task-issue-url` (`placeholder="https://…"`), only if imported
6. **Forge** — `task-forge` (GitHub/GitLab/Gitea)
7. **仓库地址** — `task-base-url` (`placeholder="base_url"`)
8. **仓库** — `task-repo` (`placeholder="owner/repo"`)
9. **默认分支（可选）** — `task-base-branch` (`placeholder="留空则由服务端默认"`)
10. **建议目录（可选）** — `task-suggested-dir` (same placeholder)
11. **验收标准** — `task-acceptance-criteria` textarea (`placeholder="每行一条"`)
12. **测试命令** — `task-test-command` (`placeholder="例如 pnpm test"`)
13. **允许路径** — `task-allowed-paths` textarea (`placeholder="每行一条"`)
14. **禁止路径** — `task-forbidden-paths` textarea (`placeholder="每行一条"`)
15. **优先级** — `task-priority` (P0–P3, default `P2`)
16. **标签** — `task-tags` textarea (`placeholder="每行一个"`)
17. **凭证** — `task-credential-feedback` wrapping:
    - `task-credential-mode` (共享档案=`profile` default, 单任务临时 token=`inline`)
    - `task-credential-profile` if profile
    - `task-credential-token` type=password if inline
18. Button **导入** — `task-import`, only if imported
19. Button **发布** — `task-submit`
20. `task-message` if `taskMessage` is set

Form tests drive fields by testid; they do **not** assert this label order or the labels themselves (except 导入 / 导入内容).

### Audit ISO text inputs

Not `n-date-picker`. Two plain `n-input`s:

```148:159:apps/web/src/App.vue
                  <n-input
                    data-testid="audit-filter-from"
                    v-model:value="auditFilterFrom"
                    placeholder="起始时间（ISO-8601）"
                    style="width: 200px"
                  />
                  <n-input
                    data-testid="audit-filter-to"
                    v-model:value="auditFilterTo"
                    placeholder="结束时间（ISO-8601）"
                    style="width: 200px"
                  />
```

Filter compare is **string lexicographic** on `row.created_at` (`App.vue:670–673`). Tests type `'2026-08-21T10:00:00Z'` / `'2026-08-21T10:45:00Z'` (`App.audit.test.ts:400–404`). Placeholders themselves are **not** asserted.

Task filter placeholder: `"任务编号"` (`App.vue:144`).

### Approve-user is a numeric-id **text** form

```185:189:apps/web/src/App.vue
            <n-divider v-if="canApprove">批准 GitHub 用户</n-divider>
            <n-space v-if="canApprove" align="center">
              <n-input v-model:value="approveId" placeholder="待批准用户 ID" />
              <n-button type="primary" :loading="approving" @click="approveUser">批准</n-button>
            </n-space>
```

- `approveId = ref('')` (string). **No** `type="number"`, **no** `data-testid`.
- Empty trim → message `'请填写待批准用户 ID'` (826).
- Else `POST /api/v1/users/${encodeURIComponent(id)}/approve` (832–836).
- Success copy `'已批准，该用户可认领任务（GitHub 仍为仅认领）'` (843).
- None of the four vitest files cover this widget.

---

## 5. HTTP the UI already calls

All `fetch` calls use `credentials: 'include'` and `Accept: application/json`. Mutations that send JSON also set `Content-Type: application/json`.

### On mount (after `GET /api/v1/me`)

| When | Method | Path | Function |
|------|--------|------|----------|
| always | GET | `/api/v1/me` | `onMounted` 733 |
| `view === 'member'` | GET | `/api/v1/tasks` | `loadTasks` 925 — **no query, no `/:id`** |
| `view === 'member'` | GET | `/api/v1/events` | `loadEvents` 939 |
| `view === 'member'` | GET | `/api/v1/stats` | `loadStats` 953 |
| `canManageKeys` | GET | `/api/v1/agent-keys` | `loadAgentKeys` 855 |
| `canManageKeys` | GET | `/api/v1/claim-confirmations` | `loadClaimConfirmations` 782 |
| `canApprove` | GET | `/api/v1/credential-profiles` | `loadProfiles` 974 |

### Click / toggle driven

| Trigger | Method | Path |
|---------|--------|------|
| 受信自动化 `n-switch` | PUT | `/api/v1/me/settings` body `{ trusted_automation: boolean }` (764) |
| 待确认 批准 | POST | `/api/v1/claim-confirmations/${id}/approve` (798) |
| 待确认 拒绝 | POST | `/api/v1/claim-confirmations/${id}/reject` (811) |
| 批准 GitHub 用户 | POST | `/api/v1/users/${id}/approve` (832) |
| 生成 Agent Key | POST | `/api/v1/agent-keys` body `{ label }` (872) |
| 吊销 | DELETE | `/api/v1/agent-keys/${id}` (903) |
| 添加档案 | POST | `/api/v1/credential-profiles` body `{ forge, base_url, repo_full_name, token }` (990) |
| 删除档案 | DELETE | `/api/v1/credential-profiles/${id}` (1028) |
| 发布 | POST | `/api/v1/tasks` (1092) |
| 导入 | POST | `/api/v1/tasks/import` (1149) |

Login buttons are **not** fetch: `<n-button tag="a" href="/login/github|gitlab|gitea">` (`App.vue:12–14`).

### PATCH from the web app: **no**

`apps/web` has zero matches for `PATCH`, `method: 'PATCH'`, or `app.patch`. `App.vue` never calls `/api/v1/tasks/${id}` (neither GET nor PATCH). Board tests explicitly assert no `GET /api/v1/tasks/:id` (`App.board.test.ts:440–451`).

### No Agent-claim / MCP / webhook buttons

- Human **task claim** UI is absent. `claim-confirmation-approve` / `claim-confirmation-reject` confirm an *already requested autonomous Agent claim*; they do not `POST .../claim` and do not reveal a token.
- `App.vue` has no `href`/`fetch` to `/api/mcp`, `/api/v1/webhooks`, or `/api/v1/tasks/:publicId/claim|progress|release`.
- The word `webhook` appears only in a comment (`App.vue:474–475`).

`createTask` success does **not** call `loadTasks` again (sets `taskMessage` to `` `任务已发布：${id}` `` only).

---

## 6. PATCH server contract

**Exists** on the session task API, **not** on the claim Bearer API.

`claim.ts` `registerClaim` (`apps/server/src/claim.ts:402–429`) registers only:

- `POST /api/v1/tasks/:publicId/claim`
- `POST /api/v1/tasks/:publicId/progress`
- `POST /api/v1/tasks/:publicId/release`

all behind `addAgentBearerHook`. **No PATCH there.**

### Function / handler

Inside `export function registerTasks(app: FastifyInstance, db: AppDb)` (`tasks.ts:477`):

```749:795:apps/server/src/tasks.ts
  // DESIGN.md §5: 发布者取消 / 发布者重新开放. Claiming and 验收 are not poster edits.
  app.patch('/api/v1/tasks/:publicId', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
    if (!canPostTasks(user)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    // … load row, 404 not_found, 403 if row.task.posterUserId !== user.id …
    const requested = readStatusBody(request.body)
    if (requested == null) {
      return reply.code(400).send({ error: 'invalid_body' })
    }
    const from = row.task.status
    const to = nextPosterStatus(from, requested)
    if (to == null) {
      return reply
        .code(409)
        .send({ error: 'illegal_transition', message: illegalTransitionMessage(from, requested) })
    }
    // UPDATE status, insertAuditEvent type 状态迁移, return taskBrief
    return reply.send(taskBrief({ task: updated, posterUsername: row.posterUsername }))
  })
```

### Auth
- Session cookie via `getSessionUser` (`auth.ts:183–187`: `request.session.userId` → `users` row). **Not** Agent Bearer.
- No session → `sendUnauthorized` (`auth.ts:62–67`): JSON `401 { error: 'unauthorized' }` if `wantsJson`, else redirect `/login`.
- `canPostTasks` (`tasks.ts:89–91`): `user.status === 'active' && user.permissionLevel === 'full'`. Else `403 { error: 'forbidden' }` (claim_only included).
- Must be the **poster** (`row.task.posterUserId !== user.id` → `403 { error: 'forbidden' }`).

### Body shape
`readStatusBody` (`tasks.ts:364–368`) accepts an object and parses **only** `body.status` with `taskStatusSchema`. Success → that `TaskStatus`; otherwise `undefined` → `400 { error: 'invalid_body' }`. No other PATCH fields are read.

### Allowed from→to (poster subset, **not** the full shared machine)

```38:41:apps/server/src/tasks.ts
const POSTER_TRANSITIONS: ReadonlyMap<string, ReadonlySet<TaskStatus>> = new Map([
  ['待认领', new Set<TaskStatus>(['已取消'])],
  ['已退回', new Set<TaskStatus>(['已取消', '待认领'])],
])
```

`nextPosterStatus` (`tasks.ts:370–374`) requires `POSTER_TRANSITIONS.get(from)?.has(to)` **and** then `transitionTaskStatus(from, to)` from `@kaola/shared`.

| from | allowed `status` in body | meaning |
|------|--------------------------|---------|
| 待认领 | 已取消 | 发布者取消 |
| 已退回 | 已取消 | 发布者取消 |
| 已退回 | 待认领 | 发布者重新开放 |

Everything else (including `待认领 → 进行中`, `待认领 → 已完成`, reopen of 已取消) is `409 { error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「${to}」。' }` (`illegalTransitionMessage` at 84–86). Unknown publicId → `404 { error: 'not_found' }`. 200 body is the same `taskBrief` envelope as GET.

Shared `LEGAL_TRANSITIONS` (`packages/shared/src/index.ts:68–73`) is wider (claim/PR edges). PATCH **narrows** to the poster subset above. `App.vue` does not import this.

---

## 7. Existing vitest shape

Shared pattern in all four files:
- `import App from './App.vue'`
- `mount(App, { global: { plugins: [naive] } })`
- Replace `globalThis.fetch` with a `Map` keyed `${METHOD} ${url}`; unrouted calls return `500 { error: 'unstubbed' }`
- `afterEach` restores `fetch`
- `settle()` = 5× `flushPromises` + `nextTick`
- Wait for `GET /api/v1/me` via `vi.waitFor`
- Naive controls driven by `NSelect`/`NSwitch` `vm.$emit('update:value', …)` (not native `<select>`)
- `node`/`textOf` look up `[data-testid="…"]`

No file uses `test(` — only `it(`. Counts below are `it(` occurrences.

### `App.board.test.ts` — 18 `it(`, 703 lines
- Helpers: `mountApp(me, tasks)` stubs `GET /api/v1/me`, `GET /api/v1/agent-keys` `{ keys: [] }`, `GET /api/v1/credential-profiles`, `GET /api/v1/tasks` `{ tasks }`, `POST /api/v1/tasks`. **Does not stub** events/stats/claim-confirmations (those fire unstubbed 500s on member mount; tests do not wait on them).
- `mountBoard` = `mountApp` + wait for `[data-testid="board"]`.
- `mountUnauthorized`: `GET /api/v1/me` → 401.
- Fixtures: `ME_FULL` (`status: 'active'`, `permission_level: 'full'`), `ME_CLAIM_ONLY`, `ME_PENDING` (`status: '待批准'`). **No** `trusted_automation` key (settings suite pins that this still works).
- Breaks if: any board/detail/filter/column/card testid renamed; 「暂无任务。」 / 「导入内容」 / 「列表」/「看板」/「任务看板」/「全部」/「状态」/「标签」/「关闭」/「发布」 timeline / credential chrome / six status strings change; kanban default or column order changes; list URL gains a query; vue-router not relevant here except chrome must not say Kanban/Timeline/Backlog.

### `App.form.test.ts` — 33 `it(`, 783 lines
- `mountApp(me)` same me/keys/profiles/tasks stubs as board (empty tasks). Waits for credential-profiles when full.
- `fillRequired` / `fillEverything` / `submit` click `task-submit`.
- Breaks if: `task-*` testids renamed or removed; 「导入」/「导入内容」 change; credential mode default is not profile; POST `/api/v1/tasks` body snake_case contract changes; 422 feedback is not on `task-credential-feedback`; fallbacks `凭证保险库未配置` / ``发布失败（${status}）`` / ``导入失败（${status}）`` change; token input is not `type=password`.
- Does **not** pin form **labels** (标题, 描述, …) or button text **发布**.

### `App.audit.test.ts` — 16 `it(`, 454 lines
- `mountMember` stubs me, agent-keys, profiles, tasks, **plus** `GET /api/v1/events` and `GET /api/v1/stats`, and **waits** for both.
- `mountPending` / `mountUnauthorized` do not stub events/stats (and assert those URLs are never requested).
- Breaks if: `audit-section` / `stats-section` / filter testids / `audit-row` / `stats-completed-count` change; 「审计日志」/「团队统计」 leave those sections; event type option values change; 「系统」 actor sentinel changes; filters re-fetch; `$router` is injected; English Audit/Stats/Timeline appears in those sections.
- Does **not** pin 「暂无审计记录。」 / 「暂无完成记录。」 or ISO placeholders.

### `App.settings.test.ts` — 8 `it(`, 343 lines
- `mountApp(me, { confirmations })` stubs me (with `trusted_automation` on `ME_FULL`), agent-keys, profiles, tasks, `GET /api/v1/claim-confirmations`, `PUT /api/v1/me/settings`. Waits for claim-confirmations when `me.status === 'active'`. **Does not stub** events/stats.
- Toggle must be `n-switch` with `data-testid="trusted-automation-toggle"` (`switchOf` searches `NSwitch`).
- Breaks if those four testids change; PUT path/body `{ trusted_automation }` changes; GET claim-confirmations URL gains a query; widget becomes visible on pending/login; missing `trusted_automation` on `/me` no longer defaults the switch to off.
- Does **not** pin 「受信自动化」 / 「待确认认领」 / 「暂无待确认认领。」 / 批准 / 拒绝 labels.

### Cross-cutting breakage
Renaming a shared testid (`board`, `task-form`, `task-submit`) hits multiple files. Changing `view` / `canApprove` / `canManageKeys` logic fails visibility `it(` in all four. Introducing vue-router only fails if `$router` becomes defined (`App.audit.test.ts:450`). Agent Key and 凭证档案 and 批准用户 have **no** vitest coverage in these files.

---

## 8. CSS / Naive / fonts

### `n-config-provider`
```1:2:apps/web/src/App.vue
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN">
```
Props used: `locale`, `date-locale` only. No `theme-overrides`, `hljs`, `abstract`, `inline-theme-disabled`, or CSS-vars theme.

`zhCN` / `dateZhCN` imported from `'naive-ui'` (`App.vue:409`). Production also `app.use(naive)` (`main.ts:5–6`), which globally registers all `n-*` components.

Naive tags in the template: `n-config-provider`, `n-layout`, `n-layout-header`, `n-layout-content`, `n-card`, `n-space`, `n-text`, `n-button`, `n-alert`, `n-descriptions`, `n-descriptions-item`, `n-select`, `n-input`, `n-divider`, `n-form`, `n-form-item`, `n-switch`.

### CSS variables / files
- **No** `.css` file under `apps/web`.
- **No** `<style>` in `App.vue`.
- **No** `--n-*` or custom properties in source.
- Styling is **inline `style=` attributes** only: `min-height: 100vh`; header `padding: 16px 24px`; title `font-size: 18px`; content `padding: 24px`; descriptions `margin-top: 16px`; kanban `display: flex; gap: 8px`; columns `flex: 1; min-width: 120px`; various `width: 140px|160px|200px|220px|240px|360px` on filters/inputs.

Naive-ui injects its own styles at runtime via JS (not a repo CSS file).

### Fonts / `index.html`
```1:12:apps/web/index.html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>考拉任务</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```
No `<link rel="stylesheet">`, no Google Fonts, no `@font-face`, no favicon.

---

## 9. File split today

- `apps/web/src/App.vue`: **1177** lines (`wc -l`). Entire UI. No `<style>` section. Ends at `</script>`.
- Other files under `apps/web/src/` (complete list):
  - `App.vue`
  - `main.ts` (7 lines)
  - `env.d.ts` (7 lines)
  - `App.board.test.ts`
  - `App.form.test.ts`
  - `App.audit.test.ts`
  - `App.settings.test.ts`
- **Zero** other `.vue` files. **Zero** `.css` files. No `components/` directory.
- Sibling: `package.json`, `index.html`, `vite.config.ts`, `tsconfig.json`.

---

## 10. `claim_only` vs `full` vs 待批准 vs logged-out — render matrix

Gates used: `view` (573–577), `canApprove` (579–581), `canManageKeys` (583). Columns are the four states the tests actually mount.

| UI block | logged-out (`me=null`, view=login) | 待批准 (`status==='待批准'`, view=pending) | claim_only + active (view=member) | full + active (view=member) |
|----------|-------------------------------------|--------------------------------------------|-----------------------------------|-----------------------------|
| Header 「考拉任务」 | yes | yes | yes | yes |
| Card 登录 + `/login/*` buttons | **yes** | no | no | no |
| Card 账号待批准 | no | **yes** | no | no |
| Card 工作台 | no | no | **yes** | **yes** |
| Greeting + 正式成员/仅认领 | no | no | yes (仅认领) | yes (正式成员) |
| 任务看板 `board` | no | no | **yes** | **yes** |
| 审计 `audit-section` | no | no | **yes** | **yes** |
| 统计 `stats-section` | no | no | **yes** | **yes** |
| 批准 GitHub 用户 | no | no | no | **yes** (`canApprove`) |
| 受信自动化 toggle | no | no | **yes** (`canManageKeys`) | **yes** |
| 待确认认领 list | no | no | **yes** | **yes** |
| Agent Key widget | no | no | **yes** | **yes** |
| 凭证档案 | no | no | no | **yes** |
| 发布任务 `task-form` | no | no | no | **yes** |
| Task claim / MCP / webhook buttons | no | no | no | no |
| PATCH cancel/reopen buttons | no | no | no | no |

Mount-time HTTP implied by the same gates:

| Request | login | pending | claim_only | full |
|---------|-------|---------|------------|------|
| GET `/api/v1/me` | yes | yes | yes | yes |
| GET `/api/v1/tasks` | no | no | yes | yes |
| GET `/api/v1/events` | no | no | yes | yes |
| GET `/api/v1/stats` | no | no | yes | yes |
| GET `/api/v1/agent-keys` | no | no | yes | yes |
| GET `/api/v1/claim-confirmations` | no | no | yes | yes |
| GET `/api/v1/credential-profiles` | no | no | no | yes |

---

## Worktree measurement

```
HEAD     be2d963b792fced8360354cfc4530b91387d50ea
branch   workflow/issue-18
status   (empty — clean)
App.vue  1177 lines
```

`@kaola/shared` is **not** imported by `App.vue`. Status strings on the board are the local `BOARD_STATUSES` const (`App.vue:524`), which happens to match `taskStatusSchema` in `packages/shared/src/index.ts:7–14`.
