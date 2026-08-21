# Ground truth — issue #8 (Chinese task board UI)

Measured from worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17` on 2026-08-21. This file is the current tree, not DESIGN.md. Docs are cited only where they contradict the tree.

Issue: https://github.com/KaolaBrother/KaolaTasks/issues/8
Title: `M1: Task board UI (中文) — list/kanban views + task detail timeline`
Body (verbatim, comments do not override except the workflow-started comment which adds nothing):

> **目标**：任务看板 Web 界面（全中文）：列表/看板双视图、按状态/标签/forge 筛选、任务详情页含事件时间线。
>
> **验收标准**
> - [ ] 六个状态正确分列展示
> - [ ] 详情页时间线显示 events（发布/认领/心跳/提交/完结）
> - [ ] 界面文案全中文
>
> **设计参考**：docs/DESIGN.md §4 §5

Labels: `P1`, `M1`, `workflow:in-progress`. One comment: workflow started for `bundle-8-17`. No other comments.

---

## Entry Points

| Layer | Entry | What it does today |
|-------|--------|-------------------|
| Web boot | `apps/web/src/main.ts` | `createApp(App).use(naive).mount('#app')`. No router, no Pinia, no extra plugins. |
| Web HTML | `apps/web/index.html` | `lang="zh-CN"`, title `考拉任务`, single `#app` + `/src/main.ts`. |
| Web UI | `apps/web/src/App.vue` (647 lines) | One-file 工作台. Three mutually exclusive cards driven by `view`. Posting form exists. **No board, no list, no kanban, no detail, no timeline, no GET `/api/v1/tasks` from the client.** |
| Web tests | `apps/web/src/App.form.test.ts` (652 lines) | Only web test file. Vitest include `src/**/*.test.ts`. |
| Dev proxy | `apps/web/vite.config.ts` | Proxies `/api` and `/login` to `http://127.0.0.1:3000`. |
| Server boot | `apps/server/src/index.ts` | `buildApp({ sqlitePath: SQLITE_PATH ?? ':memory:' })`; `PORT` default `'3000'`; `HOST` default `'0.0.0.0'`. |
| Server app | `apps/server/src/app.ts` | `GET /` → `考拉任务服务占位`. Then `registerAuth`, `registerAgentKeys`, `registerCredentialProfiles`, `registerTasks`. **No events route.** |
| Task HTTP | `apps/server/src/tasks.ts` `registerTasks` | `GET/POST /api/v1/tasks`, `GET/PATCH /api/v1/tasks/:publicId`. |
| Shared schema | `packages/shared/src/index.ts` `taskBriefSchema` | Zod wire contract for the brief (the GET/POST-201/PATCH-200 body). |
| DB | `apps/server/src/db.ts` `createDb` | Raw `CREATE TABLE IF NOT EXISTS` including `events`. No migrations. No `leases` / `submissions` tables (grep of `*.ts`/`*.sql` in this tree: zero hits). |

HTTP surface registered in this tree (complete list of `app.get/post/patch/delete` in `apps/server/src`):

- `GET /` — placeholder
- `GET /login`, `GET /login/{github,gitlab,gitea}/callback` (OAuth start paths are `@fastify/oauth2` `startRedirectPath`)
- `GET /api/v1/me`
- `POST /api/v1/users/:id/approve`
- `POST/GET /api/v1/agent-keys`, `DELETE /api/v1/agent-keys/:id`
- `GET /api/v1/agent/whoami` (Bearer child)
- `GET/POST /api/v1/credential-profiles`, `DELETE /api/v1/credential-profiles/:id`
- `GET/POST /api/v1/tasks`, `GET/PATCH /api/v1/tasks/:publicId`

There is **no** `GET /api/v1/events`, **no** `GET /api/v1/tasks/:publicId/events`, **no** MCP tools.

---

## Execution Flow

### Web: boot → view → workbench (no board)

```
index.html → main.ts createApp(App).use(naive)
  → App.vue onMounted
       GET /api/v1/me   (credentials: 'include', Accept: application/json)
       if canManageKeys (status === 'active'): GET /api/v1/agent-keys
       if canApprove (status === 'active' && permission_level === 'full'): GET /api/v1/credential-profiles
  → view computed:
       !loaded || me == null     → card "登录"
       me.status === '待批准'    → card "账号待批准"   (no workbench, no form, no board)
       else                      → card "工作台"       (claim_only AND full)
```

`App.vue` never calls `GET /api/v1/tasks` or `GET /api/v1/tasks/:publicId`. The only tasks fetch is `POST /api/v1/tasks` inside `createTask()` (line 600), gated by local required-field checks then `canApprove` (the form itself is `v-if="canApprove"`).

`App.form.test.ts` `mountApp` **defensively** stubs `GET /api/v1/tasks` → `{ tasks: [] }` (lines 179–181) so an implementer who adds a board fetch on mount will not trip the unstubbed-call guard — **but only if the URL string is exactly `/api/v1/tasks` with no query string** (see Q6).

### Server: GET list / GET one

```
GET /api/v1/tasks
  getSessionUser(db, request)
    null → sendUnauthorized (401 JSON if Accept contains application/json, else 302 /login)
    any logged-in user including status 待批准 → 200 { tasks: selectTasks(db).map(taskBrief) }
  selectTasks: tasks ⟕ users ON poster_user_id, orderBy(tasks.id), NO WHERE, NO query-string read

GET /api/v1/tasks/:publicId
  same session gate
  selectTask by tasks.public_id
    missing → 404 { error: 'not_found' }
    hit    → 200 taskBrief(row)   (bare brief, NOT wrapped in { task: ... })
```

Param name in Fastify is `:publicId` (camelCase) at `tasks.ts:405`. Test describe titles say `:public_id`; the URL is `/api/v1/tasks/${publicId}`.

### Server: POST create (relevant because timeline 发布)

```
POST /api/v1/tasks
  session → 401/302
  !canPostTasks (active && full) → 403 { error: 'forbidden' }
  parse body → 400 { error: 'invalid_body' } (± message)
  profile decrypt / inline encrypt
  validateToken → 422 token_check_failed | 502 forge_unreachable
  profile path: insertAuditEvent type 'token 揭示' (including 422/502) — NO task_id
  insertTask status '待认领'
  201 taskBrief(...)
  DOES NOT write type '发布'
  DOES NOT write type '状态迁移'
  inline path writes NO event at all
```

### Server: PATCH (the only task-scoped event writer)

```
PATCH /api/v1/tasks/:publicId  body { status }
  session → 401/302
  !canPostTasks → 403
  missing → 404 { error: 'not_found' }
  poster_user_id !== session → 403
  illegal poster edge → 409 { error: 'illegal_transition', message }
  success → insertAuditEvent type '状态迁移', details { task_id: publicId, from, to }
            200 updated brief
```

Poster-only edges (`POSTER_TRANSITIONS`, `tasks.ts:30-33`): `待认领→已取消`, `已退回→已取消|待认领`. Claim / 验收 are 409 here.

---

## Architecture Insights

1. **The board is a greenfield UI on a live read API.** List/get HTTP already exist and are session-gated. The web app does not consume them. Implementer work is primarily `App.vue` (or new components under `apps/web/src/` — that directory currently has only `main.ts`, `env.d.ts`, `App.vue`, `App.form.test.ts`).

2. **No routing.** Deep-linking a 详情页 would be new. Today there is no `vue-router`, no `window.location` / `hashchange` / `popstate` / `history` usage in `apps/` (`*.ts`/`*.vue` grep: zero). A detail “page” can be in-App state without adding a router. Adding `vue-router` is a new dependency (escalate).

3. **Filters already live on the brief, not on the query string.** `status`, `tags`, `repo.forge` are fields of every brief. `GET /api/v1/tasks` returns **every row** (including `已取消`) with no `request.query` handling anywhere in `apps/server/src`. Client-side filter of the full list matches the existing contract. Adding `?status=&tags=&forge=` would be a **new** HTTP contract (and would break `App.form.test.ts`’s exact-URL stub).

4. **Issue #8’s timeline event names are not this tree’s event `type` values, and most of them have no writer.** See Q4–Q5 and Q10. tdd-guide must not pin `发布/认领/心跳/提交/完结` as `events.type` unless they also author a new server writer + tests. Mission-list already says do not invent event types the server does not write, and do not implement claim/heartbeat/submit in this run.

5. **Permission split: server vs web.** Server `GET /api/v1/tasks` allows `待批准`. Web `view` sends `待批准` to a card that is not the 工作台. If the board is only mounted under `view === 'member'`, pending GitHub users cannot see it even though the API would serve it. DESIGN §11 and `tasks.test.ts:616-628` pin 查看任务板 for 待批准. Issue #8 does not mention this. This is a value call for tdd-guide: put the board on the pending card too, or accept that the web gate is stricter than the API.

6. **Token secrecy is already pinned on the brief.** GET list/get/create/patch responses are asserted to contain neither plaintext nor keys named `token` / `token_encrypted` / `inline_token_encrypted` / `access_token` (`tasks.test.ts` `SECRET_KEY_NAMES` + `assertNoTokenMaterial`). UI must render `credential` as `{ profile_id }` or `{ inline: true }` only. Never display forge tokens (the posting form’s password input is create-only and is cleared after success).

7. **`description_md` / `source.issue_url` are stored verbatim and not yet HTML sinks.** The moment the board interpolates them as HTML or `href`, they become XSS/javascript: sinks. `repo.base_url` is http(s)+host on POST; `issue_url` is only “non-empty string”.

8. **App.vue is already a monolith.** 647 lines, posting form + keys + profiles + approve. A board will grow it further. There is still no `components/` directory; splitting is optional and not required by existing conventions. Existing tests import `App from './App.vue'` and mount the whole app.

---

## Key Files

| File | Role for #8 |
|------|-------------|
| `apps/web/src/App.vue` | Only UI. 647 lines. Must grow (or spawn siblings) for list/kanban/filters/detail. |
| `apps/web/src/App.form.test.ts` | Existing vitest conventions, fetch stub, data-testid, mount helper. **Must stay green.** |
| `apps/web/src/main.ts` | Vue boot + `app.use(naive)`. |
| `apps/web/vite.config.ts` | `test.environment: 'happy-dom'`, `include: ['src/**/*.test.ts']`. |
| `apps/web/package.json` | deps: `vue ^3.5.0`, `naive-ui ^2.45.0` only. `test`: `vitest run`. |
| `apps/web/index.html` | `lang="zh-CN"`. |
| `apps/server/src/tasks.ts` | `registerTasks`, `taskBrief`, GET list/get, POST, PATCH, event writers. |
| `apps/server/src/tasks.test.ts` | Representative GET JSON, gates, token secrecy, 状态迁移 audit. |
| `apps/server/src/schema.ts` | Drizzle `tasks` + `events`. |
| `apps/server/src/db.ts` | Actual SQLite DDL (`EVENTS_DDL`, `TASKS_DDL`). |
| `apps/server/src/vault.ts` | `insertAuditEvent`, `revealCredentialProfile` (module export, not HTTP). |
| `apps/server/src/credential-profiles.ts` | Writes `变更` events (not task-scoped). |
| `apps/server/src/auth.ts` | `wantsJson` / `sendUnauthorized`; `GET /api/v1/me`; `publicUser`. |
| `apps/server/src/app.ts` | Route registration. No events HTTP. |
| `packages/shared/src/index.ts` | `taskBriefSchema`, `taskStatusSchema`, `transitionTaskStatus`. |
| `package.json` (root) | `pnpm test` = explicit node:test file list **plus** `pnpm --filter @kaola/web test`. New **web** `src/**/*.test.ts` files run automatically. New **server** test files do **not** unless appended to this script. |

---

## Dependencies

**`apps/web/package.json` (complete runtime + test stack):**

- dependencies: `naive-ui ^2.45.0`, `vue ^3.5.0`
- devDependencies: `@vitejs/plugin-vue ^6.0.0`, `@vue/test-utils ^2.4.11`, `happy-dom ^20.11.6`, `vite ^7.0.0`, `vitest ^4.1.11`, `vue-tsc ^3.0.0`
- **Absent:** `vue-router`, `pinia`, any markdown package (`marked` / `markdown-it` / `@mdit` / `md-editor`), any sanitizer (`dompurify` / `sanitize-html`)
- This worktree has **no** `apps/web/node_modules/naive-ui` (and no hoisted `naive-ui/package.json` under the worktree), so whether Naive ships `NTimeline` / `NDataTable` in `^2.45.0` was **not** inspected. Do not treat a specific Naive widget as verified.

**`apps/server`:** Fastify 5, Drizzle, better-sqlite3, `@kaola/shared` `workspace:*`, `@kaola/forge-adapters` `workspace:*`. No events HTTP library.

**`packages/shared`:** `zod ^4.4.3`. `taskBriefSchema` is `z.strictObject` — extra keys fail parse. Tests in `tasks.test.ts` `assertBriefShape` call `parseTaskBrief(brief)` on every GET/POST-201/PATCH-200 body.

**Root `pnpm test`** (`package.json:12`):

```
node --experimental-strip-types --test \
  packages/shared/src/index.test.ts \
  packages/forge-adapters/src/index.test.ts \
  packages/forge-adapters/src/validate-token.shared.test.ts \
  apps/server/src/placeholder.test.ts \
  apps/server/src/auth.test.ts \
  apps/server/src/agent-keys.test.ts \
  apps/server/src/vault.test.ts \
  apps/server/src/tasks.test.ts \
  && pnpm --filter @kaola/web test
```

Web half is `vitest run` with include `src/**/*.test.ts`.

---

## Q1. Exact `App.vue` structure

**File:** `apps/web/src/App.vue`, 647 lines. `<script setup lang="ts">`. **No `<style>` block. No CSS/SCSS files under `apps/web/`.** Styling is inline `style="..."` plus Naive props (`bordered`, `type="primary"`, `label-placement="top"`).

**Naive UI already in use.** `main.ts` does `app.use(naive)`. `App.vue` also wraps the tree in:

```1:7:apps/web/src/App.vue
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN">
    <n-layout style="min-height: 100vh">
      <n-layout-header bordered style="padding: 16px 24px">
        <n-text strong style="font-size: 18px">考拉任务</n-text>
      </n-layout-header>
      <n-layout-content style="padding: 24px">
```

Components present in the template: `n-config-provider`, `n-layout`, `n-layout-header`, `n-layout-content`, `n-card`, `n-space`, `n-text`, `n-button`, `n-alert`, `n-descriptions`, `n-descriptions-item`, `n-divider`, `n-input`, `n-select`, `n-form`, `n-form-item`. **Not used:** any table, tabs, timeline, drawer, modal, grid-for-kanban.

**Views (not routes).** Three `n-card`s, exclusive via `v-if` / `v-else-if`:

| `view` | Condition | Card title | Contents |
|--------|-----------|------------|----------|
| `'login'` | `!loaded \|\| me == null` | `登录` | Three `<n-button tag="a" href="/login/{github,gitlab,gitea}">` |
| `'pending'` | `me.status === '待批准'` | `账号待批准` | warning alert + descriptions |
| `'member'` | otherwise (active claim_only **or** full) | `工作台` | greeting; approve widget (`canApprove`); Agent Key (`canManageKeys`); credential profiles (`canApprove`); 发布任务 form (`canApprove`) |

```312:326:apps/web/src/App.vue
const view = computed(() => {
  if (!loaded.value || me.value == null) return 'login'
  if (me.value.status === '待批准') return 'pending'
  return 'member'
})

const canApprove = computed(
  () => me.value?.status === 'active' && me.value?.permission_level === 'full',
)

const canManageKeys = computed(() => me.value?.status === 'active')

const permissionLabel = computed(() =>
  me.value?.permission_level === 'full' ? '正式成员' : '仅认领',
)
```

**Routing / deep links: none.** No vue-router. No hash. No query parsing. Login uses full-page navigations to `/login/...` (Vite proxies `/login` to the API). After OAuth the server redirects to `/`, which is still the Fastify placeholder `考拉任务服务占位` (issue #17 territory, not #8). The SPA is only what Vite serves in `pnpm --filter @kaola/web dev`.

**Fetch wrapper: none.** No `api.ts`, no axios, no ofetch. Each call is inline `fetch`. Shared helper is only `readJson(res)` (`App.vue:347-353`) which `res.json()`s or returns `null`.

**Load-bearing Accept / credentials** (every call in this file uses both; POSTs also set `Content-Type: application/json`):

```357:360:apps/web/src/App.vue
    const res = await fetch('/api/v1/me', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
```

Create:

```600:603:apps/web/src/App.vue
    const res = await fetch('/api/v1/tasks', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
```

Why Accept is load-bearing — `auth.ts:57-66`:

```57:66:apps/server/src/auth.ts
export function wantsJson(request: FastifyRequest): boolean {
  const accept = request.headers.accept
  return typeof accept === 'string' && accept.includes('application/json')
}

export function sendUnauthorized(request: FastifyRequest, reply: FastifyReply) {
  if (wantsJson(request)) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
  return reply.redirect('/login')
}
```

`App.form.test.ts:414-431` pins: every fetch in a submit run has `credentials: 'include'` and `accept: 'application/json'`. Comment: “没有它，服务端的 sendUnauthorized 会 302 到 /login 而不是回 401 JSON。”

**onMounted does not load tasks.** After me: keys if `canManageKeys`, profiles if `canApprove`. That is the whole boot.

**Posting form:** create only. Success copy: `` `任务已发布：${id}` `` where `id` is `body.id` (the public id string). Does not navigate, does not refresh a board (there is none), does not clear title/repo.

---

## Q2. Exact GET `/api/v1/tasks` and GET `/api/v1/tasks/:publicId`

### Auth / status codes

From `tasks.ts:397-414` and `tasks.test.ts:585-628, 1159-1216`:

| Request | Session | Accept contains `application/json` | Result |
|---------|---------|--------------------------------------|--------|
| GET list or GET one | missing | yes | `401` `{ "error": "unauthorized" }` |
| GET list | missing | no (e.g. `text/html`) | `302` `Location: /login` (`tasks.test.ts:605-614`) |
| GET list or GET one | any logged-in user, including `status: "待批准"` | yes | `200` (list) or `200`/`404` (one) |
| GET one unknown / numeric-looking id (`1`,`0`,`-1`,`not-a-task`) | logged in | yes | `404` `{ "error": "not_found" }` |

No 403 on GET. `claim_only` and `待批准` may read (`tasks.test.ts:616-628, 631-662`).

### List request

- Method/URL: `GET /api/v1/tasks`
- Cookie session (web: `credentials: 'include'`)
- Header `Accept: application/json` (or any Accept whose string includes `application/json`)
- **No query parameters are read.** Handler signature uses only `request` for `getSessionUser`. `apps/server/src` grep for `request.query` / `querystring` / `?status`: zero.

Test helper (`tasks.test.ts:419-425`):

```419:425:apps/server/src/tasks.test.ts
async function listTasks(app, cookies) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/tasks',
    cookies,
    headers: jsonHeaders,
  })
}
```

`jsonHeaders` is `{ accept: 'application/json' }` (line 100).

### List response `200`

```json
{ "tasks": [ <brief>, ... ] }
```

Pinned at `tasks.test.ts:1160-1177`: `tasks` is an array; each element is a §6 brief (`assertBriefShape` → exact key set + `parseTaskBrief`). Order: SQL `orderBy(tasks.id)` i.e. integer PK ascending (`tasks.ts:336-342`), **not** `created_at`, **not** status. Empty board: `{ "tasks": [] }` (pending-user test line 624).

### GET one request

- `GET /api/v1/tasks/${publicId}` where `publicId` is `kt-YYYY-NNNN` (`nextPublicId`, `tasks.ts:356-367`).
- Same session + Accept.
- Addressed **only** by `tasks.public_id`. Integer PK is not accepted (`tasks.test.ts:1205-1216`).

### GET one response `200`

Bare brief object — **not** `{ task: ... }`. `tasks.test.ts:1180-1190`: `assert.deepEqual(jsonBody(fetched), brief)` where `brief` is the POST 201 body. So list items, GET one, POST 201, and successful PATCH 200 share one shape.

### Brief JSON — exact keys (no more, no less)

`BRIEF_KEYS` in `tasks.test.ts:44-60` and `taskBrief()` in `tasks.ts:297-334`:

```
id, title, description_md, source, repo, acceptance_criteria, test_command,
constraints, pr_convention, credential, priority, tags, poster, status, created_at
```

Projection (`tasks.ts:297-334`):

```297:334:apps/server/src/tasks.ts
function taskBrief({ task, posterUsername }: TaskWithPoster) {
  return {
    id: task.publicId,
    title: task.title,
    description_md: task.descriptionMd,
    source:
      task.sourceType === 'imported'
        ? { type: 'imported', issue_url: task.sourceIssueUrl ?? '' }
        : { type: 'native' },
    repo: {
      forge: task.repoForge,
      base_url: task.repoBaseUrl,
      full_name: task.repoFullName,
      base_branch: task.repoBaseBranch,
      suggested_dir: task.repoSuggestedDir,
    },
    acceptance_criteria: parseStringArray(task.acceptanceCriteria),
    test_command: task.testCommand,
    constraints: {
      allowed_paths: parseStringArray(task.allowedPaths),
      forbidden_paths: parseStringArray(task.forbiddenPaths),
    },
    pr_convention: {
      branch_prefix: `kaola/${task.publicId}-`,
      title_prefix: `[${task.publicId}] `,
    },
    credential:
      task.credentialProfileId == null
        ? { inline: true }
        : { profile_id: String(task.credentialProfileId) },
    priority: task.priority,
    tags: parseStringArray(task.tags),
    poster: posterUsername ?? '',
    status: task.status,
    created_at: new Date(task.createdAt * 1000).toISOString(),
  }
}
```

**Representative 200 body** (from `taskPayload` round-trip `tasks.test.ts:906-926` + credential tests `684-752`; values as the suite actually sends):

```json
{
  "id": "kt-2026-0001",
  "title": "为订单导出接口增加分页",
  "description_md": "……（Markdown 详述）",
  "source": { "type": "native" },
  "repo": {
    "forge": "gitea",
    "base_url": "https://gitea.forge.example.test",
    "full_name": "team/orders",
    "base_branch": "main",
    "suggested_dir": "orders"
  },
  "acceptance_criteria": [
    "GET /api/orders/export 支持 page/page_size 参数",
    "新增单元测试覆盖分页边界"
  ],
  "test_command": "pnpm test",
  "constraints": {
    "allowed_paths": ["src/api/**", "tests/**"],
    "forbidden_paths": ["migrations/**"]
  },
  "pr_convention": {
    "branch_prefix": "kaola/kt-2026-0001-",
    "title_prefix": "[kt-2026-0001] "
  },
  "credential": { "inline": true },
  "priority": "P1",
  "tags": ["backend", "api"],
  "poster": "<poster's users.username>",
  "status": "待认领",
  "created_at": "<ISO-8601 from Date#toISOString, typically ...Z>"
}
```

Imported source (pinned `tasks.test.ts:968-984`):

```json
{ "type": "imported", "issue_url": "https://gitea.internal.example/team/orders/issues/87" }
```

Native source carries **only** `type` (`Object.keys(native.brief.source)` equals `['type']`).

### Credential shape on GET (never a token)

| Storage | GET `credential` | Test |
|---------|------------------|------|
| `credential_profile_id` set, `inline_token_encrypted` NULL | `{ "profile_id": "<integer PK as string>" }` e.g. `{ "profile_id": "3" }` | `tasks.test.ts:684-700` `assert.deepEqual(brief.credential, { profile_id: String(profile.id) })` |
| inline ciphertext set, profile id NULL | `{ "inline": true }` | `tasks.test.ts:742-752` |

**Request-side POST credential is a different union** (`{ profile_id }` XOR `{ token }`). GET never returns `{ token }`. `profile_id` on the brief is a **string** (zod `z.string()`), even when POST accepted a number. It is the numeric PK string, **not** DESIGN’s example `"cp-gitea-orders"`.

`created_at`: unix seconds in DB; brief uses `new Date(task.createdAt * 1000).toISOString()` (`tasks.ts:332`). Test regex (`tasks.test.ts:1021-1024`) allows `Z` or `±HH:MM`. Live code always produces `Z` because `toISOString()` is UTC.

### Token cannot appear

`tasks.test.ts:1118-1156` (`token secrecy — DESIGN §7`): create/list/get dumped bodies must not contain the plaintext inline or profile token, and must not contain keys in `SECRET_KEY_NAMES = token | token_encrypted | inline_token_encrypted | access_token` at any depth. `parseTaskBrief` rejects a top-level `token` and `credential: { token: ... }` (`packages/shared/src/index.test.ts:202-221`).

`id` in JSON is `public_id` (`kt-YYYY-NNNN`), never the integer PK (`tasks.ts:299`, unique constraint `tasks_public_id`).

---

## Q3. Filter fields on the brief; query-string filters

### On the brief (usable for client-side filters)

| Filter the issue wants | Wire field | Type (zod / drizzle) | Where |
|------------------------|------------|----------------------|--------|
| 状态 | `status` | `taskStatusSchema` enum: `待认领` \| `进行中` \| `待验收` \| `已完成` \| `已退回` \| `已取消` | `packages/shared/src/index.ts:7-14`; DB `tasks.status` `schema.ts:69-71`; projected `taskBrief` `status: task.status` |
| 标签 | `tags` | `z.array(z.string())`; stored as JSON text column `tasks.tags`; parsed with `parseStringArray` | `taskBriefSchema.tags`; `schema.ts:65`; `tasks.ts:328` |
| forge | `repo.forge` | `z.enum(['github','gitlab','gitea'])` | `taskBriefSchema.repo.forge`; DB `tasks.repo_forge`; `tasks.ts:307` |

Also present and useful for a card but **not** named by issue #8: `priority` (`P0`–`P3`), `repo.full_name`, `poster`, `title`, `id`.

### Query-string filters on GET `/api/v1/tasks`

**None.** The handler is:

```398:403:apps/server/src/tasks.ts
  app.get('/api/v1/tasks', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)

    return reply.send({ tasks: selectTasks(db).map(taskBrief) })
  })
```

`selectTasks` (`tasks.ts:336-343`) has no `WHERE`. Fastify will still *accept* `GET /api/v1/tasks?status=待认领`; the query is ignored and the full list returns.

DESIGN §9 MCP `list_tasks` documents params `status?` `tags?` `forge?`. MCP is **not implemented**. That is not an HTTP contract.

**Implication for #8:** implement filters in the Vue layer over `body.tasks`. Do not invent `?status=` unless tdd-guide also authors a failing **server** test and appends it to root `pnpm test`. Client-side filtering keeps `GET /api/v1/tasks` URL identical to the form-test stub.

---

## Q4. Events: DDL, writers, `task_id`, HTTP, timeline feasibility

### DDL (source of truth = `createDb`, not drizzle alone)

`apps/server/src/db.ts:70-78`:

```
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  actor_user_id INTEGER,
  created_at INTEGER NOT NULL,
  details TEXT NOT NULL
)
```

Drizzle (`schema.ts:84-90`): `id`, `type` text notNull, `actorUserId` integer **nullable**, `createdAt` integer notNull, `details` text notNull. **No `task_id` column.** Any task association must live inside `details` JSON.

`created_at` is unix seconds (`insertAuditEvent` `Math.floor(Date.now() / 1000)`, `vault.ts:75`).

Writer helper (`vault.ts:67-78`):

```ts
export function insertAuditEvent(
  db: AppDb,
  input: { type: string; actorUserId: number; details: unknown },
): void {
  db.insert(events).values({
    type: input.type,
    actorUserId: input.actorUserId,
    createdAt: Math.floor(Date.now() / 1000),
    details: JSON.stringify(input.details),
  }).run()
}
```

`type` is a free `string` (no enum in DDL or drizzle).

### Who writes which `type` today (complete)

| `type` | Writer | When | `details` JSON (after `JSON.stringify`) | `task_id` in details? |
|--------|--------|------|------------------------------------------|------------------------|
| `变更` | `credential-profiles.ts:138-142` | POST profile 201 | `{ "action": "create", "profile_id": <int> }` | no |
| `变更` | `credential-profiles.ts:172-176` | DELETE profile 200 | `{ "action": "delete", "profile_id": <int> }` | no |
| `token 揭示` | `tasks.ts` `insertTokenRevealEvent` (158-180), called from POST profile path on 201/422/502 | after `decryptToken` of a **profile** | `{ "profile_id": <int PK>, "forge", "base_url", "full_name", "outcome": "ok" \| "token_check_failed" \| "forge_unreachable" }` | **no** |
| `token 揭示` | `vault.ts:94-98` `revealCredentialProfile` | module export only (HTTP/MCP do not call it; only `vault.test.ts`) | `{ "agent_key_id": <n>, "profile_id": <n> }` | **no** |
| `状态迁移` | `tasks.ts:596-600` | PATCH success only | `{ "task_id": <public_id string>, "from": <status>, "to": <status> }` | **yes — the public_id string, not integer PK** |

Constants in `tasks.ts:22-23`: `STATUS_TRANSITION_EVENT = '状态迁移'`, `TOKEN_REVEAL_EVENT = 'token 揭示'`.

**Not written by anyone in this tree:** `发布`, `认领`, `心跳`, `提交`, `完结`, `回写`. DESIGN §10 lists types `状态迁移 / token 揭示 / 心跳 / 回写`. Issue #8 lists `发布/认领/心跳/提交/完结`. Intersection with live writers: **empty**, except one could stretch `状态迁移` to cover 取消/重新开放 (not named in the issue body).

Inline-token POST writes **zero** events (`tasks.test.ts:1702-1707`: after a profile publish (1 reveal) an inline publish leaves reveal count at 1). Failed F1 profile/repo mismatch writes **zero** `token 揭示`. Refused PATCH writes **zero** `状态迁移` (`tasks.test.ts:1405-1418`).

### HTTP that lists events

**None.** `app.ts` does not register an events plugin. Grep of `app.(get|post|...)` has no events path. `docs/api.md:167` (docs, matching code): “No events HTTP.”

### Can a timeline be built from existing rows **without** a new endpoint?

**The browser cannot read SQLite.** Without an HTTP (or embedding events inside GET task — also a new contract), the SPA cannot list `events` rows.

What the SPA **can** do with **existing** GET `/api/v1/tasks/:publicId` only:

| Timeline item issue #8 wants | Feasible from current HTTP? |
|------------------------------|------------------------------|
| 发布 | **Synthesize** from brief `created_at` + `poster`. There is no event row. |
| 认领 | **No.** No leases table, no claim HTTP, no event. Status stays `待认领` until something else (not in this tree) moves it. |
| 心跳 | **No.** No `report_progress`, no writer for type `心跳`. |
| 提交 | **No.** No `submit_pr`, no `submissions` table. |
| 完结 | **No.** Poster PATCH cannot go to `已完成` (`待认领→已完成` is 409, `tasks.test.ts:1272-1287`). No webhook. |
| 取消 / 重新开放 (not in issue list) | Stored as `状态迁移` **in SQLite**, but **not exposed over HTTP**. Invisible to the board unless a new read is added. |

So: a honest MVP timeline without a new endpoint is **one synthetic 发布 row per task**, plus whatever the current `status` is as a badge — not a history of 认领/心跳/提交/完结.

### If a new GET is required — do **not** invent; report the gap

There is **no** existing path, query, envelope, or field list for listing events. Closest **patterns** (not a contract):

- Session cookie + `Accept: application/json` / `sendUnauthorized` (same as GET tasks)
- List envelopes already in tree: `{ tasks: [...] }`, `{ keys: [...] }`, `{ profiles: [...] }`
- Event row fields if projected 1:1 from DDL: `id`, `type`, `actor_user_id`, `created_at` (unix seconds in DB — briefs project timestamps to ISO; **events HTTP would have to choose**, and nothing pins it)
- The only task-scoped details key already pinned: `task_id` = public_id string, and only on `状态迁移`

DESIGN §9 says REST mirrors MCP and mentions “审计查询” as a Web-only interface — **no path, no JSON**.

If tdd-guide decides the board must show stored `状态迁移` rows, that is a **new public API**. Custody: failing tests in `apps/server/src/*.test.ts` **and** append the file to root `package.json` `"test"` or it will not run. Do not silently extend GET `/api/v1/tasks/:publicId` with an `events` key — `assertBriefShape` / `parseTaskBrief` **strictObject** would 500/fail every get/list/create/patch test if an extra key appeared on the brief.

Do not pin response keys that do not exist in DDL (`claimer`, `note`, `pr_url`, `ttl`, …).

---

## Q5. Does publish write a 发布 event?

**No.** `POST /api/v1/tasks` after `insertTask` returns 201 with no `insertAuditEvent` for the insert (`tasks.ts:531-554`). Search of that handler: the only audit call is `insertTokenRevealEvent` on the **profile decrypt** path, **before** insert, including when insert never happens (422/502).

So:

- Profile publish 201: one `token 揭示` `{ profile_id, forge, base_url, full_name, outcome: "ok" }` — **no `task_id`**, written **before** the row exists, cannot be joined to the new `public_id` except by time/actor heuristics (unreliable; 422/502 also write this type with no task).
- Inline publish 201: **no event**.
- Profile 422/502: `token 揭示` with `outcome` `token_check_failed` / `forge_unreachable` and **no task** (task not persisted). Putting these on a task timeline would be wrong.

### How 发布 should appear given what exists

Do **not** map `token 揭示` to 发布. It is a vault-audit event, not a task-lifecycle event; it lacks `task_id`; it fires on failed publishes; it is absent on the inline path (the path `App.form.test.ts` and `taskPayload()` default to).

**Given this tree, a 发布 timeline entry has to be synthesized from the task row:** `poster` + `created_at` (and `id`). That is data GET already returns. Writing a new `type: '发布'` would be a new server behavior (new tests, append to root `pnpm test`) and a new `type` string not in DESIGN §10’s list (`状态迁移 / token 揭示 / 心跳 / 回写`) nor in today’s writers (`变更` / `token 揭示` / `状态迁移`).

Issue body “时间线显示 events（发布/认领/心跳/提交/完结）” assumes those rows exist. They do not. Mission-list for this run: do not implement claim/heartbeat/submit. Therefore tdd-guide should pin a timeline that is honest about **currently available facts** (synthetic 发布 from the brief; optional 状态迁移 **only if** a read API is added), and must **not** require 认领/心跳/提交/完结 rows that no writer produces.

---

## Q6. Web test conventions

### Vitest block (`apps/web/vite.config.ts:12-15`)

```12:15:apps/web/vite.config.ts
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
```

- Environment: `happy-dom` (declared in `apps/web/package.json` `happy-dom ^20.11.6`).
- Include: **only** files under `apps/web/src/` ending in `.test.ts`.
- **Will run** from root `pnpm test` (via `pnpm --filter @kaola/web test` → `vitest run`): `src/App.board.test.ts`, `src/App.form.test.ts`, `src/board.test.ts`, `src/components/Foo.test.ts`.
- **Will not run:** `App.spec.ts`, `src/App.board.spec.ts`, `tests/board.test.ts`, `src/App.board.test.tsx`, anything outside `apps/web/src/`.
- **Recommended name to match existing custody:** `apps/web/src/App.board.test.ts` (sibling of `App.form.test.ts`, which is labeled “Oracle for the 发布任务 form in App.vue (issue #7)”).

If events HTTP tests are added on the server, they belong in `apps/server/src/*.test.ts` **and** the filename must be appended to root `"test"`. Web vitest will not run server files.

### `mountApp` helper (`App.form.test.ts:174-198`)

```ts
async function mountApp(me: Record<string, unknown> = ME_FULL) {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/me', () => jsonResponse(200, me))
  routes.set('GET /api/v1/agent-keys', () => jsonResponse(200, { keys: [] }))
  routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles: PROFILES }))
  // Registered defensively: a task board is not required by these tests, but an implementer who
  // adds one to onMounted must not trip the unstubbed-call guard.
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks: [] }))
  routes.set('POST /api/v1/tasks', () => jsonResponse(201, CREATED_BRIEF))

  const wrapper = mount(App, { global: { plugins: [naive] } })
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/me')).toBe(true)
  })
  await settle()
  if (me.status === 'active' && me.permission_level === 'full') {
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/credential-profiles')).toBe(true)
    })
    await settle()
  }
  return { wrapper, calls, routes }
}
```

Fixtures: `ME_FULL` (gitlab, `status: 'active'`, `permission_level: 'full'`), `ME_CLAIM_ONLY`, `ME_PENDING`. Naive is passed as `global.plugins: [naive]` because tests mount `App` without going through `main.ts` (which also `app.use(naive)`).

`settle()`: 5 rounds of `flushPromises` + `nextTick`.

**Fetch stub** (`installFetch`, lines 128-155):

- Replaces `globalThis.fetch`.
- Records `{ url, method, headers (lowercased keys), credentials, body (JSON.parsed if string) }`.
- Routes keyed on `` `${METHOD} ${url}` `` where `url = String(input)` — **exact string match**.
- Unrouted → `500 { error: 'unstubbed', method, url }` **and stays in `calls`**.
- `afterEach`: restore real `fetch`, `vi.restoreAllMocks()`.

**Board-test implication:** `GET /api/v1/tasks?status=待认领` will **not** hit the defensive stub (`GET /api/v1/tasks`) and will 500 inside `App.form.test.ts` if the production board adds a query string on mount. Keep the list URL query-less, or update the form suite’s stub (form tests are tdd-guide custody for the form; do not casually edit them to make a board pass — prefer not changing the GET URL).

`CREATED_BRIEF` in the form suite (`App.form.test.ts:66-88`) is a full §6 object including `credential: { profile_id: '3' }` and `status: '待认领'`. Board tests should reuse that shape, not invent keys.

### `data-testid` table (all that exist today)

| testid | Host | Notes |
|--------|------|--------|
| `task-form` | `n-form` | `v-if="canApprove"` |
| `task-title` | `n-input` | |
| `task-description` | `n-input` textarea | |
| `task-source-type` | `n-select` | |
| `task-issue-url` | `n-input` | only if imported |
| `task-forge` | `n-select` | |
| `task-base-url` | `n-input` | |
| `task-repo` | `n-input` | |
| `task-base-branch` | `n-input` | |
| `task-suggested-dir` | `n-input` | |
| `task-acceptance-criteria` | `n-input` textarea | |
| `task-test-command` | `n-input` | |
| `task-allowed-paths` | `n-input` textarea | |
| `task-forbidden-paths` | `n-input` textarea | |
| `task-priority` | `n-select` | |
| `task-tags` | `n-input` textarea | |
| `task-credential-feedback` | `n-form-item` | `:feedback` + `:validation-status` |
| `task-credential-mode` | `n-select` | |
| `task-credential-profile` | `n-select` | profile mode |
| `task-credential-token` | `n-input` password | inline mode |
| `task-submit` | `n-button` | click, not form submit (`@submit.prevent` on form; handler is `@click="createTask"`) |
| `task-message` | `n-text` | |

Helpers board tests should copy: `node` / `textOf` / `optionalTextOf` via `[data-testid="..."]`; `selectOf` finds `NSelect` by `attributes('data-testid')` then `vm.$emit('update:value', value)` (Naive selects do not `setValue` like inputs); `fieldElement` looks under the testid for `input, textarea`.

**No testids exist for a board.** tdd-guide owns new ones (`task-board`, columns, filters, detail, timeline, …). Do not collide with the `task-*` form ids above.

Form suite currently asserts claim_only still sees text `工作台` and does **not** see `task-form`. A board inside the member card would be visible to claim_only — that matches DESIGN §11 查看任务板.

---

## Q7. XSS / markdown

**No HTML interpolation of task fields today.**

- Grep of `apps/` `*.vue`/`*.ts`/`*.html` for `v-html`, `innerHTML`, `markdown`, `marked`, `mdit`, `DOMPurify`, `sanitize`: **zero matches**.
- `description_md` is only bound as `v-model` on the posting textarea (`App.vue:89-93`). It is not rendered as HTML after load.
- `title` of **other** tasks is never rendered (no list). The word “标题” is a form label.
- `source.issue_url` is only an input, never `<a :href>`.
- User-controlled strings that **are** shown use Vue text interpolation `{{ }}` (auto-escaped): `me.display_name`, `me.username`, `me.provider`, `me.message` (also passed to `n-alert :title`), `taskMessage` (includes server `id`), Agent Key token (not a forge token), profile labels, etc.

**Storage is verbatim.** `readCreateBody` accepts any string `description_md` (`tasks.ts:241-242`) and `insertTask` writes `descriptionMd: input.descriptionMd` with no sanitization. Round-trip test (`tasks.test.ts:917`): `assert.equal(brief.description_md, payload.description_md)` for `'……（Markdown 详述）'`. `issue_url` is any non-empty string (`readSource` `tasks.ts:112-114`) — **not** passed through `isHttpOrHttpsUrlWithHost` (that check is POST `repo.base_url` only, `tasks.ts:427-432`). A stored `javascript:...` issue_url is legal today.

**No markdown renderer in `apps/web` dependencies.** Rendering `description_md` as Markdown requires a new dependency (escalate) **or** showing it as preformatted/escaped text (`{{ description_md }}` / `n-text` / `<pre>`). Mission-list: “Sanitize description_md / event details before they become an HTML sink.” If tdd-guide requires rendered Markdown, they must also pin sanitization; if they pin text-only, implementer must not add `v-html`.

**`n-alert :title="me?.message"`** passes a string prop; not `v-html`. Naive’s title rendering was not inspected (no naive-ui sources in this worktree). Pending message is server-pinned Chinese, not task markdown.

DESIGN §7 “提示注入提醒”: imported Issue body is untrusted. UI should mark imported source (`source.type === 'imported'`). Not implemented.

---

## Q8. vue-router / pinia / `components/`

| Item | Present? | Evidence |
|------|----------|----------|
| `vue-router` | **Absent** | `apps/web/package.json` dependencies are only `naive-ui` and `vue`. Grep `createRouter` / `vue-router`: zero. |
| `pinia` | **Absent** | Same package.json. Grep `pinia` / `createPinia`: zero. State is `ref`/`computed` in `App.vue`. |
| `apps/web/src/components/` | **Absent** | `apps/web/src/` contains exactly: `main.ts`, `env.d.ts`, `App.vue`, `App.form.test.ts`. `apps/web/` has those plus `vite.config.ts`, `tsconfig.json`, `package.json`, `index.html`. No CSS. |

A 详情页 does not require vue-router; in-component selected-task state matches current architecture. Adding vue-router or Pinia is a new dependency.

---

## Q9. Permission gates

### Server GET `/api/v1/tasks` (and GET one)

```397:407:apps/server/src/tasks.ts
  // DESIGN.md §11 grants 查看任务板 to every logged-in user, 待批准 GitHub accounts included.
  app.get('/api/v1/tasks', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)

    return reply.send({ tasks: selectTasks(db).map(taskBrief) })
  })

  app.get('/api/v1/tasks/:publicId', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
```

Gate is **session exists**. No check of `status` or `permission_level`.

| Caller | GET list/one | POST create | PATCH cancel/reopen |
|--------|--------------|-------------|---------------------|
| Anonymous + JSON Accept | 401 `{ error: 'unauthorized' }` | 401 | 401 |
| Anonymous + HTML Accept | 302 `/login` | 302 | 302 |
| GitHub `待批准` (`claim_only`) | **200** | 403 `{ error: 'forbidden' }` | 403 |
| GitHub approved `active` + `claim_only` | **200** | 403 | 403 |
| GitLab/Gitea `active` + `full` | **200** | 201/4xx if canPostTasks | 200 if poster, else 403 |

`canPostTasks` (`tasks.ts:81-83`): `user.status === 'active' && user.permissionLevel === 'full'`. Same population as credential-profile management.

### Web `view` computed (quoted in Q1)

| `GET /api/v1/me` | `view` | Sees 工作台? | Sees 发布任务 form? | Sees board today? |
|------------------|--------|----------------|----------------------|-------------------|
| 401 / network fail (`me = null`) | `login` | no | no | no |
| `status: '待批准'` | `pending` | **no** (different card) | no | no |
| `status: 'active'`, `permission_level: 'claim_only'` | `member` | yes | no (`canApprove` false) | no (board not built) |
| `status: 'active'`, `permission_level: 'full'` | `member` | yes | yes | no (board not built) |

`GET /api/v1/me` fields (`auth.ts:69-91`): `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`; plus `message: '你的账号待正式成员批准后方可认领任务。'` when `status === '待批准'`.

**Conflict to brief tdd-guide:** API allows pending users to read the board; the pending card has no place for it. DESIGN §11 table: 查看任务板 ✓ for GitHub with the 批准 caveat only on 认领/生成 Agent Key, not on 查看任务板. `tasks.test.ts:616` title: “待批准 GitHub user may read the board (§11 查看任务板 ✓) but not post”.

---

## Q10. Issue body vs this tree (explicit contradictions)

Issue #8 + DESIGN §4/§5 assume things this tree does not have. Comments do not override (the only comment is workflow bookkeeping).

1. **“详情页时间线显示 events（发布/认领/心跳/提交/完结）”** — None of those five strings are `events.type` values in this tree. Writers are `变更`, `token 揭示`, `状态迁移`. No 认领/心跳/提交/完结 pipeline (no MCP, no leases, no submissions, no webhooks). PATCH cannot produce `已完成`.

2. **DESIGN §10 event types** (`状态迁移 / token 揭示 / 心跳 / 回写`) **≠** issue #8’s five names **≠** live writers (adds `变更`, lacks `心跳`/`回写`).

3. **DESIGN §13 M3** lists “任务时间线” as M3 polish; issue #8 is labeled M1 and asks for a timeline now. M1 in DESIGN §13 is “任务 CRUD 与看板” plus MCP/claim — MCP/claim are still unimplemented. This run’s mission-list says do not implement claim/heartbeat/submit.

4. **“详情页”** implies a route. There is no router and no URL scheme for `/tasks/kt-...`. OAuth returns to `GET /` placeholder, not the SPA (#17).

5. **“按状态/标签/forge 筛选”** as if they were API filters. They are brief fields. HTTP list has no query parser. MCP `list_tasks` filters are design-only.

6. **“六个状态正确分列展示”** is implementable from `status` on each brief. GET returns **all** statuses in one array including `已取消`; columns are a UI grouping, not six endpoints. Empty columns are expected (nothing creates `进行中`/`待验收`/`已完成` via current HTTP except raw SQL `forceStatus` in tests).

7. **Pending users vs 查看任务板:** issue is silent; server test + DESIGN §11 grant read; web `view === 'pending'` hides the workbench.

8. **`App.form.test.ts` header comment still says “The form does not exist yet”** (lines 3-5). The form **does** exist. Stale comment; do not take it as ground truth.

9. **DESIGN §6 example `credential.profile_id`: `"cp-gitea-orders"`.** Live HTTP uses `String(integer PK)`. Board UI that expects `cp-...` will mis-render.

10. **DESIGN §6 example `created_at`: `"2026-08-20T12:00:00+08:00"`.** Live GET uses `toISOString()` (`...Z`). Both parse under `z.iso.datetime({ offset: true })`.

11. **Issue does not mention XSS.** Archived #7 and this run’s mission-list do: `description_md` / `source.issue_url` become live sinks once rendered. `issue_url` is not http(s)-validated.

12. **No board fetch in `onMounted`.** Form tests stub GET tasks defensively; production App does not call it yet.

13. **Kanban as a Naive primitive:** not used; cannot confirm NTimeline/NDataTable from this worktree’s files (naive-ui sources not present). Issue does not name a component.

14. **Tokens on the board:** issue does not say this; CLAUDE.md / DESIGN §7 / `assertNoTokenMaterial` / mission-list do. Brief `credential` must never be shown as a secret; `{ inline: true }` is a marker, not a token.

---

## Recommendations for New Development

1. **Consume existing GET `/api/v1/tasks` with the same fetch idiom** (`credentials: 'include'`, `Accept: application/json`). Parse `body.tasks`. Do not add query strings unless a server contract is tested and root `pnpm test` is updated.

2. **Filter client-side** on `status`, `tags` (array membership), `repo.forge`. Six kanban columns = group by the six Chinese `status` values. List view = same array, different layout. Empty columns are correct while claim/PR are unimplemented.

3. **Detail without vue-router:** selected `publicId` in `App.vue` (or a child), load from the already-fetched list and/or `GET /api/v1/tasks/${publicId}`. Do not add vue-router/pinia unless asked.

4. **Timeline:** synthesize **发布** from `created_at` + `poster`. Do not invent 认领/心跳/提交/完结 rows. Do not relabel `token 揭示` as 发布. If 取消/重新开放 history is in scope, that requires a **new** events GET (tdd-guide must pin path+JSON in a **server** test file appended to root `package.json` `"test"`); there is no contract to copy. Prefer not expanding the brief object (strict zod).

5. **Place the board on `view === 'member'` at minimum** (active claim_only + full). Decide explicitly whether `view === 'pending'` also shows it (API yes, current UI no). Keep `canApprove` gating on the posting form only.

6. **New tests:** `apps/web/src/App.board.test.ts`. Copy `installFetch` / `mountApp` / `settle` / data-testid helpers. Stub `GET /api/v1/tasks` with real-shaped briefs (copy `CREATED_BRIEF` / `BRIEF_KEYS`). Keep URL exactly `/api/v1/tasks` so `App.form.test.ts` stays green. Add testids that do not collide with `task-form` / `task-submit` / ….

7. **XSS:** render `title` / `description_md` / `poster` / tags via text interpolation, not `v-html`. If `issue_url` becomes a link, only bind `href` when it is http(s). Do not add a markdown package unless tdd-guide pins one plus sanitization.

8. **Never render `credential.token`** (field does not exist on GET). Showing `profile_id` as a numeric string or a “共享档案” label is fine; showing `{ inline: true }` as “单任务临时 token” is fine; showing ciphertext or forge PATs is not. Agent Key plaintext widget is unrelated and must stay gated.

9. **Reuse Naive + Chinese copy already on the 工作台.** Header stays `考拉任务`. New chrome should be Chinese. Status labels must be the six enum strings exactly (no `open`/`cancelled`/`todo`).

10. **Do not implement claim, heartbeat, submit, or PATCH-to-进行中** in this issue. Poster PATCH remains cancel/reopen. Kanban columns for `进行中`/`待验收`/`已完成` can exist empty.

---

## Facts the implementer must not invent

### Wire keys (brief — GET list items, GET one, POST 201, PATCH 200)

`id` `title` `description_md` `source` `repo` `acceptance_criteria` `test_command` `constraints` `pr_convention` `credential` `priority` `tags` `poster` `status` `created_at`

Nested:

- `source`: `{ type: "native" }` XOR `{ type: "imported", issue_url }`
- `repo`: `forge` `base_url` `full_name` `base_branch` `suggested_dir`
- `constraints`: `allowed_paths` `forbidden_paths` (string arrays)
- `pr_convention`: `branch_prefix` = `` `kaola/${id}-` ``, `title_prefix` = `` `[${id}] ` ``
- `credential` (brief): `{ profile_id: "<string>" }` XOR `{ inline: true }` — **never** `token`

List envelope: `{ tasks: Brief[] }` — not `{ items }`, not `{ data }`, not a bare array.

GET one: **bare** Brief — not `{ task: Brief }`.

Errors already pinned: `{ error: "unauthorized" }` `401`; `{ error: "forbidden" }` `403`; `{ error: "not_found" }` `404`; `{ error: "invalid_body" }` `400`; `{ error: "illegal_transition", message }` `409`; `{ error: "token_check_failed", missing, message }` `422`; `{ error: "forge_unreachable", message }` `502`; `{ error: "vault_unconfigured" }` `500`.

`id` format: `kt-YYYY-NNNN`. `forge`: `github` \| `gitlab` \| `gitea`. `priority`: `P0` \| `P1` \| `P2` \| `P3`.

POST create credential (not used by the board read path): `{ profile_id }` XOR `{ token }` — different from the brief.

### Event `type` strings that actually exist

`变更` · `token 揭示` · `状态迁移`

`状态迁移` details keys: `task_id` (public_id string), `from`, `to`.

`token 揭示` (publish-time) details keys: `profile_id` (int), `forge`, `base_url`, `full_name`, `outcome` (`ok` \| `token_check_failed` \| `forge_unreachable`). No `task_id`. No `agent_key_id` on this path.

`变更` details keys: `action` (`create` \| `delete`), `profile_id`. No `task_id`.

Do not emit or expect `发布` `认领` `心跳` `提交` `完结` `回写` as stored `type` values unless a new server test pins a new writer.

### Chinese copy already pinned (do not rephrase)

**Status enum (canonical):** `待认领` `进行中` `待验收` `已完成` `已退回` `已取消`

**App chrome:** `考拉任务` · `登录` · `账号待批准` · `工作台` · `正式成员` · `仅认领` · `发布任务` · `发布` · ``任务已发布：${id}`` · `平台自有` / `从 Issue 导入` · `共享档案` / `单任务临时 token`

**Pending:** `你的账号待正式成员批准后方可认领任务。`

**Permission labels (web):** `正式成员` iff `permission_level === 'full'`, else `仅认领`.

**Server task messages (form already depends on these; board should not duplicate as inventable copy):**  
`token 无效或无权访问该仓库，任务未发布。`  
`无法连接 forge 校验 token，任务未发布。`  
`所选凭证档案不存在。`  
`所选凭证档案与仓库不匹配。`  
`仓库地址不是合法的 http 或 https 地址。`  
``token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。``  
``任务状态不允许从「${from}」变更为「${to}」。``  
`凭证保险库未配置`

**Fetch headers (every call):** `credentials: 'include'` and `Accept: application/json`.

**Existing form data-testid prefix `task-*`:** do not reuse `task-form` / `task-submit` / `task-message` / `task-title` / … for board chrome.

**Users.status:** `active` \| `待批准` (not `pending`). **permission_level:** `full` \| `claim_only` (not `admin`).
