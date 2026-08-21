# tests-web — `apps/web/src/App.form.test.ts` (issue #7)

**Artifact:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7/apps/web/src/App.form.test.ts`
**Verbatim RED capture:** `kaola-workflow/issue-7/.cache/tests-web-baseline.txt` (full `CI=true pnpm test` from the repo root)
**Baseline:** `b8f27d91d4e8b17c9e2120b41244e5ea7dc81a48`, plus the uncommitted worktree changes already present when I started (`docs/DESIGN.md` §6, `apps/server/src/{app,db,schema,tasks,tasks.test}.ts`, `packages/shared/src/index*.ts`, `apps/server/package.json`, `package.json`, `pnpm-lock.yaml`).

I wrote tests and test tooling only. **`apps/web/src/App.vue` is untouched** — `git status` shows it unmodified.

---

## 1. Tooling added

`apps/web/package.json` devDependencies (installed with `pnpm --filter @kaola/web add -D`):

```
vitest           ^4.1.11
@vue/test-utils  ^2.4.11
happy-dom        ^20.11.6
```

`apps/web/package.json` gained one script, placed between `build` and `typecheck`:

```json
"test": "vitest run"
```

`apps/web/vite.config.ts` now imports `defineConfig` from `vitest/config` (a superset of vite's —
one config file keeps it inside the existing `tsconfig.json` `include`, so `vue-tsc` still checks
it) and gained a `test` block. The `server.proxy` block is unchanged:

```ts
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/login': 'http://127.0.0.1:3000' } },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
```

### How root `pnpm test` now composes

The root script keeps its single `node --experimental-strip-types --test <8 files>` invocation and
appends the web run with `&&`:

```
node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts apps/server/src/tasks.test.ts && pnpm --filter @kaola/web test
```

Both halves execute from the repo root — see §2. `&&` (not `;`) so a red server suite short-circuits,
matching the existing single-verdict behaviour. The vitest "no test files found" trap does not apply:
`src/App.form.test.ts` was written before the root script was wired, and vitest's `include` only ever
matches `apps/web/src/**/*.test.ts`.

**Documentation not updated.** Per CLAUDE.md's Documentation Update Checklist, a change to the test
command means `README.md`, `CHANGELOG.md`, the CLAUDE.md Commands section, `docs/architecture.md` and
`docs/api.md` need docking. That is `doc-updater`'s work, not mine — flagging it so it is not lost.

---

## 2. Baseline proof

```
$ CI=true pnpm test          # from the repo root
ℹ tests 233
ℹ suites 39
ℹ pass 233
ℹ fail 0
...
 RUN  v4.1.11 /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7/apps/web
 Test Files  1 failed (1)
      Tests  27 failed (27)
   Duration  936ms
```

**Server/package suites: 233/233 pass — unchanged by the tooling.** **Web: 27 tests, 0 pass, 27 fail.**
Not one web test passes before the form exists.

Representative failure signatures, verbatim:

```
FAIL src/App.form.test.ts > 发布任务表单 — 可见性（DESIGN §11） > 只对 active + full 成员可见，claim_only 与待批准用户都看不到
  AssertionError: expected false to be true // Object.is equality

FAIL src/App.form.test.ts > 发布任务表单 — 请求线格式 > 完整填写后提交，请求体精确匹配服务端的 snake_case 契约
  Error: no input/textarea under [data-testid="task-title"]

FAIL src/App.form.test.ts > 发布任务表单 — 两条凭证路径（{profile_id} XOR {token}） > 切到单任务临时 token：渲染 token 输入框，不渲染档案下拉
  Error: no n-select with data-testid="task-credential-mode"

FAIL src/App.form.test.ts > 发布任务表单 — 两条凭证路径（{profile_id} XOR {token}） > 档案下拉复用已加载的 profiles，不再发一次 GET /api/v1/credential-profiles
  Error: no n-select with data-testid="task-credential-profile"
```

Every failure names a missing seam element — no test fails for a harness reason.

### The other three gates, AFTER the tooling change

```
$ CI=true pnpm build      -> exit 0
$ CI=true pnpm typecheck  -> exit 0   (packages/shared, packages/forge-adapters, apps/web, apps/server all Done)
$ CI=true pnpm lint       -> exit 0   (eslint ., no output)
```

`vue-tsc` **does** typecheck the new test file — verified by temporarily appending
`const __typecheckCanary: number = "not a number"`, which produced
`src/App.form.test.ts(654,7): error TS2322: Type 'string' is not assignable to type 'number'.`
and `Exit status 2`. The canary was removed and typecheck returned to exit 0.

### The seam is provably satisfiable

Before shipping, I ran a throwaway probe (since deleted; it never touched `App.vue`) that mounted an
**inline fixture component** honouring the contract below and drove it with the suite's own helpers.
Every mechanism round-tripped: testids resolve on Naive roots, the credential `v-if` XOR flips,
`props('options')` reads the dropdown, newline-splitting reaches the POST body, a 422 lands in the
form-item feedback while a 502 does not, the inline token clears on 201 and survives a network
failure, and a blocked submit issues zero calls. So the 27 RED tests are red because the form is
missing, not because they are unsatisfiable.

---

## 3. THE SEAM — the `data-testid` contract

**This is the load-bearing part of the handoff.** The suite finds the form exclusively through these
attributes. An implementer who guesses names produces a form the tests cannot see.

Put the attribute directly on the Naive component (`<n-input data-testid="task-title" …>`). Naive
inherits it onto the component's root element, which is what the selectors match — verified
empirically for `n-input`, `n-select`, `n-button`, `n-form-item`.

| testid | element | notes |
|---|---|---|
| `task-form` | the posting-form container | presence = the §11 gate |
| `task-title` | `n-input` | required |
| `task-description` | `n-input type="textarea"` | `description_md` |
| `task-source-type` | `n-select` | values `'native'` \| `'imported'`, **default `'native'`** |
| `task-issue-url` | `n-input` | rendered **only** when source is `imported` |
| `task-forge` | `n-select` | values `'github'` \| `'gitlab'` \| `'gitea'` (reuse `forgeOptions`) |
| `task-base-url` | `n-input` | required |
| `task-repo` | `n-input` | required, `owner/repo` |
| `task-base-branch` | `n-input` | optional |
| `task-suggested-dir` | `n-input` | optional |
| `task-acceptance-criteria` | `n-input type="textarea"` | newline-separated list |
| `task-test-command` | `n-input` | |
| `task-allowed-paths` | `n-input type="textarea"` | newline-separated list |
| `task-forbidden-paths` | `n-input type="textarea"` | newline-separated list |
| `task-priority` | `n-select` | values `'P0'`…`'P3'`, **default `'P2'`** |
| `task-tags` | `n-input type="textarea"` | newline-separated list |
| `task-credential-mode` | `n-select` | values `'profile'` \| `'inline'`, **default `'profile'`** |
| `task-credential-profile` | `n-select` | rendered **only** in `profile` mode; option `value` is the **number** `ProfileRow.id` |
| `task-credential-token` | `n-input type="password"` | rendered **only** in `inline` mode; must have `type="password"` |
| `task-credential-feedback` | `n-form-item` | credential-scoped errors (the 422 verdict) |
| `task-submit` | `n-button` | the 发布 button; the suite `trigger('click')`s it |
| `task-message` | element holding the submit-level message | success + every non-credential error |

### How each kind is driven

- **`n-input` / textarea** — the suite does `wrapper.findAll('[data-testid="X"] input, [data-testid="X"] textarea')[0].setValue(v)`.
  The native element must live **inside** the tagged root. Standard `n-input` markup already satisfies this.
- **`n-select`** — the suite finds the component via `findAllComponents(NSelect)` filtered on
  `attributes('data-testid')`, then `vm.$emit('update:value', v)`. So the select **must** be bound
  with `v-model:value` (the house idiom). It also reads `props('options')` on `task-credential-profile`.
- **`n-button`** — `trigger('click')`, so the handler must be on `@click` (not a native form submit).
- **`task-credential-feedback` / `task-message`** — read with `.text()` and `toContain`. For the
  form-item, `.text()` includes its label and its slotted content; that is fine for `toContain`.
  Rendering the credential message through `n-form-item`'s `feedback` prop
  (`:feedback="…" :validation-status="… ? 'error' : undefined"`) is verified to work.

### The XOR is structural, not merely validated

In `profile` mode `task-credential-token` must **not exist in the DOM**, and in `inline` mode
`task-credential-profile` must **not exist**. Use `v-if` on the mode, not `disabled`. Two tests
assert the absence directly, which makes the request-side `{profile_id}` XOR `{token}` impossible
to violate by construction.

---

## 4. How fetch is stubbed

`globalThis.fetch` is replaced per test by a **router keyed on `` `${METHOD} ${url}` ``** and restored
in `afterEach`. Every call is recorded verbatim (`url`, `method`, lowercased `headers`,
`credentials`, JSON-parsed `body`), which is how the header and body contracts are asserted.

Default routes registered by `mountApp(me)`:

| route | response |
|---|---|
| `GET /api/v1/me` | `200` the `me` fixture (default `active` + `full`) |
| `GET /api/v1/agent-keys` | `200 { keys: [] }` |
| `GET /api/v1/credential-profiles` | `200 { profiles: [ #3 gitea team/orders, #5 gitlab team/billing ] }` |
| `GET /api/v1/tasks` | `200 { tasks: [] }` — registered **defensively**; a board is not required by these tests, but if you add one to `onMounted` it will not trip the guard |
| `POST /api/v1/tasks` | `201` a full §6 brief with `id: 'kt-2026-0042'` |

An **unrouted** call answers `500 { error: 'unstubbed', method, url }` and is still recorded, so an
unexpected outbound request can never pass silently.

`mountApp` waits on the recorded `GET /api/v1/me`, drains, and — for an `active`+`full` `me` — also
waits on `GET /api/v1/credential-profiles` before returning, so the dropdown's source data is loaded
deterministically rather than by tick-counting. `settle()` (5 × `flushPromises` + `nextTick`) drains
the handler chain after every click, so the suite is **not** sensitive to how many awaits deep your
`createTask` is.

Header normalisation lowercases keys and accepts a plain object, a `Headers` instance or an entry
array — so `headers: { Accept: …, 'Content-Type': … }` (the house idiom) and a `Headers` object both
satisfy the assertions.

---

## 5. Judgement calls the implementer must respect

Each was undetermined by code, by DESIGN, or by the orchestrator rulings. I picked one and the suite
now pins it. If you disagree, raise it — do not quietly implement something else, and do not edit the
test to match the code.

1. **Empty optional `repo` fields are OMITTED from the request, not sent as `''`.** This is the
   highest-value item here. `apps/server/src/tasks.ts` `readRepo` rejects `base_branch: ''` and
   `suggested_dir: ''` with `400 invalid_body`; only `undefined` triggers the `'main'` / last-segment
   defaults. A form that posts `base_branch: baseBranch.value` unconditionally 400s on every task
   where the user left the field blank. One test pins `body.repo` deep-equalling
   `{ forge, base_url, full_name }` for a minimal fill.
2. **`description_md`, `test_command`, `acceptance_criteria`, `tags`, `constraints` ARE always sent**,
   as `''` / `[]` / `{ allowed_paths: [], forbidden_paths: [] }`. The server accepts all of those.
   Only the two `repo` fields above are omission-sensitive.
3. **`source` is `{ type: 'native' }` with no `issue_url` key** when the mode is native — even if the
   user typed a URL and switched back.
4. **All four `string[]` fields use one idiom: a newline-separated `n-input type="textarea"`**, split
   on `\n`, each line trimmed, empty lines dropped. Ground truth flagged this as undecided (its Q6)
   and recommended picking one and applying it to all four. Newline-split is the least code and the
   only option that is cleanly drivable through `setValue`. A test feeds
   `'  第一条  \n\n第二条\n'` and requires `['第一条', '第二条']`, which a naive `.split('\n')` fails.
5. **Credential mode defaults to `'profile'`** — DESIGN §7 makes the shared profile the primary path
   ("团队连接一次、发布任务时下拉选择").
6. **`priority` defaults to `'P2'`** and is always sent, matching the server's own default.
   `source.type` defaults to `'native'`. The `task-forge` default is deliberately **not** pinned —
   every test sets it explicitly.
7. **`credential.profile_id` is sent as a NUMBER**, straight from `ProfileRow.id`. The server accepts
   a number or a numeric string; the number is what the already-loaded `profiles` ref holds, so no
   conversion. (The *brief* renders it back as a decimal string — that is the server's projection,
   not yours.)
8. **Error placement splits two ways.** The `422 token_check_failed` verdict is a credential problem
   and must render at `task-credential-feedback`; **everything else** — `502 forge_unreachable`, the
   generic fallback, `vault_unconfigured`, network failure, and the success message — renders at
   `task-message`. This is what the orchestrator's `n-form-item` ruling buys: the 权限不足 message sits
   next to the credential inputs that caused it, rather than at the bottom of a twelve-field form.
   One test asserts positively that the 502 string is in `task-message` **and** negatively that it is
   **not** in the credential feedback, so mapping both errors into one slot fails.
9. **The 422 text is the server's `message`, used as-is.** The server already sends the exact Chinese
   string and selects between the 权限不足 and 无效 variants itself
   (`missing.includes('读')` → `token 无效或无权访问该仓库，任务未发布。`). Re-deriving it client-side
   from `missing` would duplicate the copy in two repos' worth of code, and the house idiom
   (`deleteProfile`) already prefers a server-provided `message`. Three tests drive three different
   `missing` sets, so a hardcoded string fails.
10. **Two client strings are mine, both extending existing house copy**:
    `凭证保险库未配置` for `500 vault_unconfigured` (verbatim from `createProfile`) and
    `` `发布失败（${res.status}）` `` for an error with no server `message` (the `添加失败（N）` pattern).
11. **Client-side guards block the POST** for: empty title, empty `repo.full_name`, `imported` with an
    empty `issue_url`, `profile` mode with nothing selected, and `inline` mode with an empty token.
    The tests assert only that **no request is issued** — where you put the per-field feedback is
    yours, so this does not fight the `n-form` rules approach. One test blocks on an empty title,
    then fills it and requires the POST to go out, so an unconditional "never submit" also fails.
12. **The success message must contain the server-returned task id** (`kt-2026-0042`), which forces
    reading the 201 body. The surrounding wording is yours.
13. **The inline token input is cleared on 201 and NOT cleared on failure.** Mirrors
    `createProfile`'s `profileToken.value = ''`; the negative half stops a failure being treated as
    success and losing what the user typed.
14. **Exactly one `POST /api/v1/tasks` per submit.** The helper throws if it sees zero or two, so a
    handler wired to both `@click` and a native form submit fails.
15. **Every fetch — including the three existing `onMounted` ones — carries `credentials: 'include'`
    and `Accept: 'application/json'`.** The assertion iterates *all* recorded calls, so any new fetch
    you add (a task board, say) must carry both. `Accept` is load-bearing: without it the server's
    `sendUnauthorized` 302s to `/login` instead of returning `401` JSON.
16. **Gating reuses the existing `canApprove` computed** (`active` + `full`). One test mounts all
    three populations — full member sees the form, `claim_only` sees 工作台 without it, 待批准 sees the
    pending card. Ground truth's Q9 (renaming `canApprove` to something honest) is **not** settled by
    this suite; the tests only observe the rendered result, so a rename is free.
17. **No task board / list / edit is required.** Ground truth's Q4 flagged "what does edit mean?" as
    undecided; this suite scopes issue #7's web half to **create only**. `GET /api/v1/tasks` is
    stubbed but nothing asserts a board exists.
18. **`profiles` is reused, never re-fetched.** A test flips the credential mode to `inline` and back
    and requires the `GET /api/v1/credential-profiles` count to still be exactly 1. Dropdown option
    `value`s must be `[3, 5]` in that order and the labels must contain the repo full names — the
    ready-made `#{id} {forge} {repo_full_name}（{base_url}）` format from the existing profile list
    satisfies this.

---

## 6. Every test name (27)

### `发布任务表单 — 可见性（DESIGN §11）`
1. 只对 active + full 成员可见，claim_only 与待批准用户都看不到

### `发布任务表单 — 请求线格式`
2. 完整填写后提交，请求体精确匹配服务端的 snake_case 契约
3. 平台自有字段 id / pr_convention / poster / status / created_at 不出现在请求体里
4. 未填写的 base_branch 与 suggested_dir 被省略，而不是发送空字符串
5. 四个 string[] 字段按行拆分：逐行去空白并丢弃空行
6. 创建请求是 POST /api/v1/tasks，带 Content-Type: application/json
7. 每一个 fetch 都带 credentials: include 与 Accept: application/json

### `发布任务表单 — 两条凭证路径（{profile_id} XOR {token}）`
8. 默认走共享档案：渲染档案下拉，不渲染内联 token 输入框
9. 切到单任务临时 token：渲染 token 输入框，不渲染档案下拉
10. 档案路径发送 credential: { profile_id }，且不带任何 token 键
11. 内联路径发送 credential: { token }，且不带 profile_id
12. 档案下拉复用已加载的 profiles，不再发一次 GET /api/v1/credential-profiles
13. 发布成功后清空内联 token 输入框

### `发布任务表单 — 提交前校验`
14. 标题为空时不发请求；补上标题后才发
15. 仓库 full_name 为空时不发请求
16. 选择 imported 却没填 issue_url 时不发请求
17. 档案模式下没选档案时不发请求
18. 内联模式下 token 为空时不发请求

### `发布任务表单 — 发布即校验的两种失败（DESIGN §5）`
19. 422 缺少 推 与 PR：凭证字段旁点名两项能力
20. 422 只缺少 PR：文案只点名 PR，说明它不是写死的字符串
21. 422 连 读 都缺失：显示 token 无效文案，而不是权限不足文案
22. 502 forge 不可达是另一种结局：提交级消息，且不落在凭证字段旁
23. 400 所选凭证档案不存在：原样显示服务端的中文消息
24. 400 invalid_body 且没有 message：回落到通用中文提示
25. 500 vault_unconfigured：沿用凭证档案那套文案
26. 网络失败：给出提示，并且不把已填的 token 当成功清掉

### `发布任务表单 — 发布成功`
27. 201 之后提交级消息带上服务端生成的任务 id

---

## 7. The exact request body the suite pins

Full fill (test 2), `toEqual` — so this is the **exact** key set, no more and no less:

```json
{
  "title": "为订单导出接口增加分页",
  "description_md": "……（Markdown 详述）",
  "source": { "type": "imported", "issue_url": "https://gitea.forge.example.test/team/orders/issues/87" },
  "repo": {
    "forge": "gitea",
    "base_url": "https://gitea.forge.example.test",
    "full_name": "team/orders",
    "base_branch": "develop",
    "suggested_dir": "orders"
  },
  "acceptance_criteria": ["GET /api/orders/export 支持 page/page_size 参数", "新增单元测试覆盖分页边界"],
  "test_command": "pnpm test",
  "constraints": { "allowed_paths": ["src/api/**", "tests/**"], "forbidden_paths": ["migrations/**"] },
  "priority": "P1",
  "tags": ["backend", "api"],
  "credential": { "profile_id": 3 }
}
```

Minimal fill (test 4) — title + forge + base_url + full_name + profile only:

```json
{
  "title": "…",
  "description_md": "",
  "source": { "type": "native" },
  "repo": { "forge": "gitea", "base_url": "https://gitea.forge.example.test", "full_name": "team/orders" },
  "acceptance_criteria": [],
  "test_command": "",
  "constraints": { "allowed_paths": [], "forbidden_paths": [] },
  "priority": "P2",
  "tags": [],
  "credential": { "profile_id": 3 }
}
```

## 8. Chinese strings, character for character

Copied out of `apps/server/src/tasks.ts` (note the regular spaces around ASCII words and the
full-width 。、：）：

```
token 权限不足：缺少 推、PR 权限，任务未发布。
token 权限不足：缺少 PR 权限，任务未发布。
token 无效或无权访问该仓库，任务未发布。
无法连接 forge 校验 token，任务未发布。
所选凭证档案不存在。
```

Client-side (§5.10):

```
凭证保险库未配置
发布失败（400）
```
