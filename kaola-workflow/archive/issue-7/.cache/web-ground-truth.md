# Web ground truth for issue #7 — Chinese task posting / edit form

Read-only exploration of `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`.
No file was edited; nothing was installed or run. Everything below is transcribed from source.
Anything I could not confirm by reading is marked **UNVERIFIED**.

Two decisions arrived from the orchestrator and are treated as fixed here:
task identity is internal `id INTEGER PK AUTOINCREMENT` + `public_id TEXT UNIQUE` in
`kt-YYYY-NNNN` form (the wire addresses tasks by `public_id`), and `credential` is a union
`{ profile_id } | { inline: true }` backed by two nullable columns with exactly one non-null.
I re-read `docs/DESIGN.md` §6 in the worktree and confirmed both are now written there
(lines 134, 143, 145-152) — see §8.1 below for the verbatim text, because the form's field list
depends on it.

---

## 0. The whole of `apps/web`

Seven files. There is no other directory.

```
apps/web/index.html
apps/web/package.json
apps/web/tsconfig.json
apps/web/vite.config.ts
apps/web/src/App.vue        380 lines — the entire application
apps/web/src/env.d.ts
apps/web/src/main.ts
```

No `components/`, no `views/`, no `router/`, no `stores/`, no `composables/`, no `api/`,
no `assets/`, no `locales/`, no `__tests__/`, no `*.spec.*`, no `*.test.*`, no `*.css`.

> Tooling note: the `Glob` tool went flaky mid-session on this subtree (patterns that had
> returned results earlier began returning "No files found" while the files were demonstrably
> readable). The listing above is from earlier successful globs cross-checked by direct `Read`
> of each path. Probably index churn from the two `pnpm test` runs happening in the worktree.

`apps/web/src/main.ts`, in full — this is why no `n-*` component ever needs an import:

```ts
import { createApp } from 'vue'
import naive from 'naive-ui'
import App from './App.vue'

const app = createApp(App)
app.use(naive)
app.mount('#app')
```

`app.use(naive)` registers the **whole** Naive UI component set globally. Adding
`<n-form>`, `<n-dynamic-input>`, `<n-radio-group>` etc. to the template requires **no** import
change anywhere.

`apps/web/index.html`, in full:

```html
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

`apps/web/src/env.d.ts`, in full:

```ts
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
```

---

## 1. `App.vue` as it stands — one monolithic file

**Monolithic.** 380 lines: `<template>` at lines 1-87, `<script setup lang="ts">` at lines
89-380. **There is no `<style>` block at all** — every bit of styling is an inline `style="…"`
attribute (`style="width: 240px"`, `style="padding: 24px"`, `style="min-height: 100vh"`). New
markup should follow that; introducing a `<style>` block or scoped CSS would be the first in the
codebase.

### 1.1 Template skeleton (structure verbatim, feature bodies elided)

```
<n-config-provider :locale="zhCN" :date-locale="dateZhCN">      line 2
  <n-layout style="min-height: 100vh">                          line 3
    <n-layout-header bordered style="padding: 16px 24px">       line 4
      <n-text strong style="font-size: 18px">考拉任务</n-text>   line 5
    <n-layout-content style="padding: 24px">                    line 7

      <n-card title="登录" v-if="view === 'login'">              lines 8-17
        … three <n-button tag="a" href="/login/{github|gitlab|gitea}">

      <n-card title="账号待批准" v-else-if="view === 'pending'"> lines 19-25
        <n-alert type="warning" :title="me?.message ?? '…'" />
        <n-descriptions :column="1"> … <n-descriptions-item label="用户">

      <n-card title="工作台" v-else-if="view === 'member'">      lines 27-83
        <n-space vertical>                                      line 28
          <n-text>{{ me?.display_name }}，已登录（…）</n-text>   line 29
          <n-divider v-if="canApprove">批准 GitHub 用户</n-divider>      lines 30-35
          <n-divider v-if="canManageKeys">Agent Key</n-divider>          lines 37-53
          <n-divider v-if="canApprove">凭证档案</n-divider>              lines 55-81
        </n-space>                                              line 82
      </n-card>                                                 line 83
```

The whole member experience is **one `n-card` containing one vertical `n-space`, subdivided by
`n-divider` headings**. Each divider block is `<n-divider v-if="GATE">TITLE</n-divider>`
immediately followed by `<n-space v-if="GATE" vertical>…</n-space>` — the gate is repeated on
both elements, not wrapped in a single container. Copy that shape.

### 1.2 How state is held — flat module-scope refs, no store

Verbatim, lines 121-148:

```ts
const me = ref<Me | null>(null)
const loaded = ref(false)
const approveId = ref('')
const approving = ref(false)
const approveResult = ref('')
const approveOk = ref(false)

const keyLabel = ref('')
const keyCreating = ref(false)
const newKeyToken = ref('')
const keyMessage = ref('')
const keyOk = ref(false)
const agentKeys = ref<AgentKeyRow[]>([])

const profileForge = ref<'github' | 'gitlab' | 'gitea'>('gitlab')
const profileBaseUrl = ref('')
const profileRepo = ref('')
const profileToken = ref('')
const profileCreating = ref(false)
const profileMessage = ref('')
const profileOk = ref(false)
const profiles = ref<ProfileRow[]>([])

const forgeOptions = [
  { label: 'GitHub', value: 'github' },
  { label: 'GitLab', value: 'gitlab' },
  { label: 'Gitea', value: 'gitea' },
]
```

The convention is a **per-feature ref cluster** with a fixed naming shape:

| Suffix | Meaning | Rendered as |
|---|---|---|
| `<x>Creating` / `approving` | in-flight | `:loading` on the submit `n-button` |
| `<x>Message` / `approveResult` | feedback text (Chinese) | `<n-text v-if="…">` |
| `<x>Ok` | success vs failure | `:type="xOk ? 'success' : 'error'"` |
| `<x>s` (`profiles`, `agentKeys`) | list data | `v-for` |

Types are declared inline at the top of the script (lines 93-117): `Me`, `AgentKeyRow`,
`ProfileRow`. One module const for shared copy (line 119):

```ts
const FORGE_REVOKE_MESSAGE = '请同时到 forge 侧撤销该 token。'
```

Derived state, lines 150-169:

```ts
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

function formatLastUsed(value: number | null): string {
  if (value == null) return '从未使用'
  return `最近使用 ${new Date(value * 1000).toLocaleString('zh-CN')}`
}
```

`canApprove` is the **`active` + `full`** gate — the same population DESIGN §11 grants
发布任务 to. It is (confusingly) named for the approve widget but already reused for the
credential-profile block; reuse it again for the posting form rather than adding a synonym, or
rename it in one place — see OPEN QUESTIONS Q9.

Bootstrap, lines 179-201:

```ts
onMounted(async () => {
  try {
    const res = await fetch('/api/v1/me', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (res.ok) {
      me.value = (await res.json()) as Me
    } else {
      me.value = null
    }
  } catch {
    me.value = null
  } finally {
    loaded.value = true
  }
  if (canManageKeys.value) {
    await loadAgentKeys()
  }
  if (canApprove.value) {
    await loadProfiles()
  }
})
```

Note the pattern: `loaded` is flipped in `finally`, then permission-gated list loads run
**sequentially** after it. A posting form needs one more line here
(`if (canApprove.value) { await loadTasks() }`).

---

## 2. How the existing UI calls the server

### 2.1 No wrapper, no message API

- **No fetch wrapper, no API client module, no axios.** Eight bare `fetch(...)` call sites:
  `onMounted` (`/api/v1/me`), `approveUser`, `loadAgentKeys`, `createAgentKey`,
  `revokeAgentKey`, `loadProfiles`, `createProfile`, `deleteProfile`.
- **No `useMessage`, no `useNotification`, no `useDialog`** — grepped, zero occurrences. There is
  no `<n-message-provider>` / `<n-dialog-provider>` / `<n-notification-provider>` in the tree.
  Feedback is rendered inline as `<n-text>` (and one `<n-alert>` in the pending card).
  Naive UI's `useMessage()` requires an ancestor `n-message-provider`; adopting it means adding
  a provider wrapper that does not exist today. **UNVERIFIED** what it does without one (I did
  not run it) — but it is definitively not the established idiom here.
- Every request carries **both** `credentials: 'include'` and `Accept: 'application/json'`.
  The `Accept` header is load-bearing: the server's `sendUnauthorized` returns
  `401 { error: 'unauthorized' }` when `accept` contains `application/json`, and a `302` to
  `/login` otherwise. Dropping it turns an auth failure into an opaque redirect.
- POSTs with a body add `'Content-Type': 'application/json'` and `body: JSON.stringify({...})`.
- Session cookie: set by the server as `path: '/', secure: false, httpOnly: true,
  sameSite: 'lax'` (from `apps/server/src/auth.ts:258`). Because it is `httpOnly`, JS never
  touches it — `credentials: 'include'` is the entire client-side story.

The one shared helper, lines 171-177:

```ts
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}
```

### 2.2 One complete request-and-error-handling path, end to end

`createProfile`, lines 318-355, verbatim. **This is the exact template for `createTask`:**

```ts
async function createProfile() {
  profileCreating.value = true
  profileMessage.value = ''
  try {
    const res = await fetch('/api/v1/credential-profiles', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        forge: profileForge.value,
        base_url: profileBaseUrl.value,
        repo_full_name: profileRepo.value,
        token: profileToken.value,
      }),
    })
    const body = await readJson(res)
    if (!res.ok) {
      profileOk.value = false
      if (res.status === 409) {
        profileMessage.value = '该仓库档案已存在'
      } else if (res.status === 500 && body?.error === 'vault_unconfigured') {
        profileMessage.value = '凭证保险库未配置'
      } else {
        profileMessage.value = `添加失败（${res.status}）`
      }
      return
    }
    profileOk.value = true
    profileMessage.value = '档案已保存（token 已加密，不会再次显示）。'
    profileToken.value = ''
    await loadProfiles()
  } catch {
    profileOk.value = false
    profileMessage.value = '添加档案失败'
  } finally {
    profileCreating.value = false
  }
}
```

Read off the six-step contract this establishes:

1. set `<x>Creating = true`, clear `<x>Message` — **before** the try.
2. `fetch` with `credentials: 'include'` + `Accept` (+ `Content-Type` when there's a body).
3. `const body = await readJson(res)` **before** checking `res.ok` — so the error branch can read
   `body.error`.
4. `if (!res.ok)` → set `<x>Ok = false`, map to a Chinese string, **`return`**. The mapping is a
   hand-written per-call-site chain: specific `res.status` cases first, then a
   `res.status` + `body?.error` case, then a `` `…失败（${res.status}）` `` fallback.
5. success → `<x>Ok = true`, Chinese confirmation, clear the sensitive input
   (`profileToken.value = ''`), re-fetch the list.
6. `catch {}` (bare, no binding) → the **network-failure** message; `finally` clears the loading
   flag.

Note that step 4's `body?.error === 'vault_unconfigured'` case is the existing precedent for
**discriminating on the server's machine-readable `error` code rather than the status alone** —
which is exactly the mechanism the 权限不足 / 不可达 split will need (§8.3).

The paired list-fetch, lines 304-316, verbatim:

```ts
async function loadProfiles() {
  try {
    const res = await fetch('/api/v1/credential-profiles', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const body = await readJson(res)
    profiles.value = Array.isArray(body?.profiles) ? (body.profiles as ProfileRow[]) : []
  } catch {
    profiles.value = []
  }
}
```

List loaders are **silent** — `if (!res.ok) return` with no message at all. A failed refresh
leaves stale data on screen and says nothing. (Worth knowing; not necessarily worth copying for
the task list.)

One more idiom, from `deleteProfile` (lines 365-373) — prefer a server-provided Chinese message
when present, fall back to a local constant:

```ts
const body = await readJson(res)
if (!res.ok) { … }
profileOk.value = true
profileMessage.value =
  typeof body?.message === 'string' ? body.message : FORGE_REVOKE_MESSAGE
```

---

## 3. Naive UI components in use, and the (absent) validation idiom

**Every component used anywhere in the app** (exhaustive, from the template):

`n-config-provider`, `n-layout`, `n-layout-header`, `n-layout-content`, `n-card`, `n-space`,
`n-divider`, `n-text`, `n-button`, `n-alert`, `n-descriptions`, `n-descriptions-item`,
`n-input`, `n-select`.

Fourteen. **Not used anywhere:** `n-form`, `n-form-item`, `n-modal`, `n-drawer`, `n-dialog`,
`n-data-table`, `n-table`, `n-list`, `n-tag`, `n-switch`, `n-radio`/`n-radio-group`,
`n-checkbox`, `n-input-number`, `n-dynamic-input`, `n-dynamic-tags`, `n-tabs`, `n-collapse`,
`n-popconfirm`, `n-spin`, `n-empty`, `n-pagination`, and all three providers.

Input idioms that already exist and should be reused verbatim:

```html
<n-select v-model:value="profileForge" :options="forgeOptions" style="width: 140px" />
<n-input v-model:value="profileBaseUrl" placeholder="base_url" style="width: 240px" />
<n-input
  v-model:value="profileToken"
  type="password"
  show-password-on="click"
  placeholder="forge token"
  style="width: 360px"
/>
<n-button type="primary" :loading="profileCreating" @click="createProfile">添加档案</n-button>
<n-text v-if="profileMessage" :type="profileOk ? 'success' : 'error'">{{ profileMessage }}</n-text>
<n-text v-if="profiles.length === 0">暂无凭证档案。</n-text>
```

Rows of inputs are grouped as `<n-space align="center">` — there is no grid/columns layout.

### 3.1 There is NO form-validation idiom — none

No `n-form`, no `n-form-item`, no `:rules`, no `formRef.validate()`, no `required` markers, no
field-level error text, no submit-disabling. Client-side validation in the entire application is
**one** guard, in `approveUser` (lines 204-209):

```ts
const id = approveId.value.trim()
if (!id) {
  approveOk.value = false
  approveResult.value = '请填写待批准用户 ID'
  return
}
```

That is it. `createProfile` and `createAgentKey` perform **zero** client-side validation —
`createProfile` will happily POST empty strings and let the server answer
`400 { error: 'invalid_body' }`, which its own mapping then renders as the generic
`添加失败（400）` (there is no 400 case in its chain).

Consequence for issue #7: the posting form has ~12 user-entered fields, several required. The
implementer must either (a) extend the single-guard idiom — a `validateTaskForm()` returning the
first Chinese error string into `taskMessage` — or (b) introduce `n-form` + `n-form-item` +
`rules`, which would be the **first** use of Naive UI's form system in this codebase and brings
per-field error placement with it. (b) is the better fit for a form this size and is the only way
to get an error next to the token field rather than at the bottom of the block; (a) is
lower-risk and matches house style. **Nothing in the code decides this** — see Q5.

---

## 4. The credential-profile widgets (bundle-4-5) — directly reusable for the dropdown

### 4.1 Template block, lines 55-81, verbatim

```html
<n-divider v-if="canApprove">凭证档案</n-divider>
<n-space v-if="canApprove" vertical>
  <n-text>按 forge + 仓库保存可复用 token，团队共享。删除档案后请到 forge 侧撤销该 token。</n-text>
  <n-space align="center">
    <n-select v-model:value="profileForge" :options="forgeOptions" style="width: 140px" />
    <n-input v-model:value="profileBaseUrl" placeholder="base_url" style="width: 240px" />
    <n-input v-model:value="profileRepo" placeholder="owner/repo" style="width: 200px" />
  </n-space>
  <n-space align="center">
    <n-input
      v-model:value="profileToken"
      type="password"
      show-password-on="click"
      placeholder="forge token"
      style="width: 360px"
    />
    <n-button type="primary" :loading="profileCreating" @click="createProfile">添加档案</n-button>
  </n-space>
  <n-text v-if="profileMessage" :type="profileOk ? 'success' : 'error'">{{ profileMessage }}</n-text>
  <n-text v-if="profiles.length === 0">暂无凭证档案。</n-text>
  <n-space v-for="profile in profiles" :key="profile.id" align="center">
    <n-text>
      #{{ profile.id }} {{ profile.forge }} {{ profile.repo_full_name }}（{{ profile.base_url }}）
    </n-text>
    <n-button size="small" @click="deleteProfile(profile.id)">删除</n-button>
  </n-space>
</n-space>
```

### 4.2 The exact response shape the dropdown consumes

`GET /api/v1/credential-profiles` → `200 { profiles: [ … ] }`. The client type, verbatim
(lines 110-117):

```ts
type ProfileRow = {
  id: number
  forge: string
  base_url: string
  repo_full_name: string
  scopes_checked: unknown[]
  created_by: number
}
```

Cross-checked against the server's projector (`apps/server/src/credential-profiles.ts:28-37`) —
the client type matches the server exactly:

```ts
function publicProfile(row: CredentialProfile) {
  return {
    id: row.id,                                  // integer
    forge: row.forge,                            // 'github' | 'gitlab' | 'gitea'
    base_url: row.baseUrl,
    repo_full_name: row.repoFullName,
    scopes_checked: parseScopes(row.scopesChecked),   // always [] today
    created_by: row.createdBy,                   // user id, integer
  }
}
```

Facts that bear on the dropdown:

- **`id` is a `number`**, not a string. An `n-select` option `value` would therefore be a number,
  and `profiles` is already `ref<ProfileRow[]>([])` — no new fetch is needed at all.
- `scopes_checked` is **always `[]`** in practice — the server writes the literal `'[]'` on
  create and never updates it. Do not build UI that expects real scope data in it.
- The list is **team-shared and unfiltered**: the server returns every row to any `active`+`full`
  user (no `WHERE created_by = …`). There is no client-side filtering today. A posting form
  probably wants to narrow options to the chosen forge/repo — that behavior does not exist and
  would be new (Q7).
- Access is gated `active` + `full` on the server; `loadProfiles()` is only called when
  `canApprove.value`. Since the posting form is gated the same way, the already-loaded `profiles`
  ref is available with no extra call — **reuse it, do not re-fetch**.
- A ready-made option label exists in the `v-for`:
  `#{{ profile.id }} {{ profile.forge }} {{ profile.repo_full_name }}（{{ profile.base_url }}）`.
  Reuse that exact format for `options`:
  `profiles.value.map((p) => ({ label: \`#${p.id} ${p.forge} ${p.repo_full_name}（${p.base_url}）\`, value: p.id }))`.
- Ordering: the server does `db.select().from(credentialProfiles).all()` with **no ORDER BY** —
  insertion order in practice, but not guaranteed. Sort client-side if order matters.

---

## 5. `apps/web/vite.config.ts` — the dev proxy

In full:

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/login': 'http://127.0.0.1:3000',
    },
  },
})
```

What follows for the form:

- Use **relative** URLs only (`/api/v1/tasks`, never an absolute origin). There is no
  `VITE_API_BASE_URL`, no `import.meta.env` usage anywhere, no `.env` file in `apps/web`.
- No `server.port` is set → Vite's default (5173). No `base`, no `build` options, no path alias
  (`@/…` will not resolve — use relative imports).
- No CORS configuration anywhere, on either side; same-origin-through-proxy is the entire design.
- Only `/api` and `/login` are proxied. Any new server route the form calls **must live under
  `/api/`** or the proxy will not forward it.

**Dev-login caution (UNVERIFIED, but check it before burning time).** The server builds OAuth
callbacks as `` `${publicUrl}/login/${provider}/callback` `` where `publicUrl` defaults to
`http://localhost:3000` (`apps/server/src/auth.ts:243, 269, 285, 300`). So an OAuth round trip
started from the Vite origin returns the browser to **`localhost:3000`**, and the session cookie
(`path: '/'`, `sameSite: 'lax'`, `secure: false`) is scoped to that origin — not to the Vite
origin the SPA is served from. Requests the SPA proxies to `/api/...` would then carry no session
cookie, and `/api/v1/me` would 401 forever. If that's what happens, the fix is to run the server
with `PUBLIC_URL` pointed at the Vite origin. I did not run either server, so I cannot confirm
the failure — but the implementer will hit it immediately on first manual test if it's real.

---

## 6. Test tooling and what the web scripts actually run

### 6.1 There is no web test tooling. At all.

`apps/web/package.json`, in full:

```json
{
  "name": "@kaola/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "vue-tsc --noEmit -p tsconfig.json",
    "preview": "vite preview"
  },
  "dependencies": {
    "naive-ui": "^2.45.0",
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^6.0.0",
    "vite": "^7.0.0",
    "vue-tsc": "^3.0.0"
  }
}
```

- **No `test` script.** No `vitest`, no `@vue/test-utils`, no `jsdom`, no `happy-dom`, no
  `playwright`, no `cypress` — I grepped the whole of `apps/web` case-insensitively for all of
  them: zero matches.
- The root `pnpm test` script names seven files explicitly, all under `packages/` and
  `apps/server/` — **zero** web files. A web test file would not run even if one existed.

### 6.2 What the commands do run

| Command | Actually runs |
|---|---|
| `pnpm --filter @kaola/web build` | `vite build` |
| `pnpm --filter @kaola/web typecheck` | `vue-tsc --noEmit -p tsconfig.json` |
| `pnpm --filter @kaola/web dev` | `vite` |
| root `pnpm build` | `pnpm -r --if-present build` → includes the web `vite build` |
| root `pnpm typecheck` | `pnpm -r --if-present typecheck` → includes `vue-tsc` |
| root `pnpm lint` | `eslint .` from the repo root |

`apps/web/tsconfig.json` — note `strict: true` and that the `include` covers `.vue` files, so
`vue-tsc` **does** typecheck the `<script setup>` block and template bindings:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "useDefineForClassFields": true,
    "resolveJsonModule": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "src/**/*.d.ts", "vite.config.ts"]
}
```

Lint config for web (root `eslint.config.js`): `pluginVue.configs['flat/essential']` plus

```js
{
  files: ['apps/web/**/*.{ts,vue}'],
  languageOptions: {
    globals: globals.browser,
    parserOptions: { parser: tseslint.parser },
  },
}
```

**The consequence matters for how you dispatch:** the only automated verdicts available for web
work today are `vue-tsc`, `vite build`, and `eslint`. None of them observes behavior. Under the
`tdd-guide` / `implementer` custody split, `tdd-guide` **cannot author a failing web test**
without first adding test tooling — which is a new dependency, i.e. an escalation. See Q1.

---

## 7. Where the form attaches, and what to reuse vs. add

### 7.1 Attachment point

A **fourth divider block inside the 工作台 card**: insert after line 81's `</n-space>` (which
closes the 凭证档案 block) and before line 82's `</n-space>` (which closes the card's outer
vertical space). Gate it `v-if="canApprove"` — DESIGN §11's table grants 发布任务 to
GitLab/Gitea登录 only, which is exactly `status === 'active' && permission_level === 'full'`.

If the form and a task list are both wanted, the house structure suggests two dividers
(`发布任务`, then `任务看板`) inside the same card rather than a new card — every feature so far
lives in the one 工作台 card.

In `<script setup>`: put `type TaskRow` after `ProfileRow` (line 117), the ref cluster after the
profile cluster (line 142), and `loadTasks` / `createTask` after `deleteProfile` (line 379),
preserving the file's existing "types → refs → computeds → helpers → onMounted → per-feature
functions in template order" layout.

### 7.2 Reuse (already exists, don't rewrite)

- `forgeOptions` — the forge `n-select` options, verbatim.
- `profiles` + `ProfileRow` + `loadProfiles()` — the credential dropdown source; already loaded
  under the same `canApprove` gate.
- `readJson(res)`.
- The ref-cluster naming (`taskCreating` / `taskMessage` / `taskOk` / `tasks`).
- The `<n-text v-if="…" :type="…Ok ? 'success' : 'error'">` feedback line.
- The password-input idiom for the inline token:
  `type="password" show-password-on="click"`.
- The `#id forge repo（base_url）` label format.
- The six-step fetch contract from `createProfile` (§2.2).
- The `onMounted` conditional-load line.

### 7.3 Add (no precedent in the codebase)

- A credential-mode toggle (共享档案 vs 单任务临时 token). `n-radio-group` is unused; `n-select`
  is already used and would need no new idiom.
- **Array-valued inputs.** DESIGN §6 has four `string[]` fields — `acceptance_criteria`, `tags`,
  `constraints.allowed_paths`, `constraints.forbidden_paths`. **Nothing in the app collects a
  list today.** Options: `n-dynamic-input`, `n-dynamic-tags`, or a newline-split
  `<n-input type="textarea">`. No precedent; pick one and use it for all four (Q6).
- A multi-line Markdown field for `description_md` (`n-input type="textarea"` — the component is
  used, that `type` is not).
- Whatever list/table renders existing tasks (`n-data-table` is unused; the `v-for` +
  `n-space` idiom from the profile list is the low-risk match).
- Form validation of any real depth (§3.1).

### 7.4 DESIGN §6 field → form mapping

From the worktree's current §6 (lines 105-152). **Not every §6 field is a form field** — line 143
says the id is platform-generated and that `pr_convention` is *derived from it*:

> **`id` 形式**：`kt-<年份>-<四位序号>`（如 `kt-2026-0142`），全局唯一且可读；`pr_convention` 的分支前缀与标题前缀由它派生。平台内部另有自增主键，不对外暴露。

| §6 field | Form? | Widget |
|---|---|---|
| `id` | **no** — server-generated `kt-YYYY-NNNN` | display-only after create |
| `title` | yes, required | `n-input` |
| `description_md` | yes | `n-input type="textarea"` |
| `source.type` | yes (`native` \| `imported`) | `n-select` / `n-radio-group` |
| `source.issue_url` | yes, only when `imported` | `n-input`, `v-if` on the mode |
| `repo.forge` | yes | `n-select` + `forgeOptions` (reuse) |
| `repo.base_url` | yes | `n-input` |
| `repo.full_name` | yes | `n-input` (`owner/repo`) |
| `repo.base_branch` | yes | `n-input` |
| `repo.suggested_dir` | yes | `n-input` |
| `acceptance_criteria` | yes | list input (new) |
| `test_command` | yes | `n-input` |
| `constraints.allowed_paths` | yes | list input (new) |
| `constraints.forbidden_paths` | yes | list input (new) |
| `pr_convention.*` | **no** — derived from `id` per line 143 | — |
| `credential` | yes — the union, see §8.1 | dropdown XOR password input |
| `priority` | yes | `n-select` P0/P1/P2/P3 |
| `tags` | yes | list input (new) |
| `poster` | **no** — server takes it from the session | — |
| `status` | **no** — server sets `待认领` on create | display-only |
| `created_at` | **no** — server-generated | display-only |

So roughly **twelve** user-entered fields plus the credential choice — large enough that the
single-`n-text`-at-the-bottom error idiom starts to strain (§8.4).

---

## 8. The two credential paths and the two 发布即校验 errors

### 8.1 What DESIGN §6 now says (verbatim, worktree lines 134 and 145-152)

```jsonc
  "credential": { "profile_id": "cp-gitea-orders" },  // 二选一，见下方说明
```

> **`credential` 是引用，不是 token 本身**，两种形态二选一：
>
> | 形态 | 含义 |
> |------|------|
> | `{ "profile_id": "cp-gitea-orders" }` | 引用团队共享的凭证档案（§7） |
> | `{ "inline": true }` | 该任务附带单任务临时 token，密文随任务存储 |
>
> 两种形态下任务卡都**不含 token 明文**——`inline` 只声明"有一份专属凭证在等着"，不携带任何凭证内容；两者都只在 `claim_task` 成功时经揭示通道下发。

The load-bearing consequence for the form: the **task brief** never carries a token, but the
**create request** must — the inline path needs a plaintext token field posted once and encrypted
server-side. These are two different payloads. The form's submit body is therefore *not* a task
brief; it is a create-request that the server turns into one. (The same split already exists for
credential profiles: `POST` takes `token`, the response never returns it.)

Note also that §6's example still shows `profile_id` as the **string** `"cp-gitea-orders"`, while
`GET /api/v1/credential-profiles` returns `id` as an **integer** (§4.2). What the create request
sends is undetermined — Q2.

### 8.2 What the server offers today: nothing

I grepped the whole worktree for `/api/v1/tasks`. Three hits: `docs/DESIGN.md`, and two archived
research files under `kaola-workflow/archive/`. **There is no task route, no task handler, and no
task test anywhere in `apps/server/src`.** `docs/architecture.md:24` still says
`MCP / tasks / claim     not implemented`, and `docs/api.md:130` still says
`There is no tasks table.`

So the web implementer has **no contract to code the fetch layer against**: not the endpoint
path, not the request body key names, not the status codes, and — most importantly for this
task — not the `error` strings or the field carrying `missing`. This is a hard sequencing
dependency, not a detail. See Q1.

### 8.3 What the two errors need, and what exists to build them from

The requirement is two distinct Chinese messages: **token 权限不足** naming which of 读/推/PR are
missing, versus **forge 不可达**.

What the adapter layer produces (from `packages/forge-adapters/src/index.ts`, confirmed in my
earlier server report):

- Insufficient permissions → `validateToken` **resolves** with
  `{ missing: TokenCapability[] }` where `TokenCapability = '读' | '推' | 'PR'` — the Chinese
  labels are already the wire values, so the client can render them directly with no mapping
  table.
- Unreachable forge / non-JSON body → `validateToken` **rejects** (undici `TypeError`); it does
  *not* return a `TokenCheck`. There is no timeout.

So the two cases are cleanly distinguishable **on the server**. The question is purely how the
server projects them into HTTP, and nothing has decided that (Q3). The client-side precedent for
consuming such a split already exists — `createProfile`'s
`else if (res.status === 500 && body?.error === 'vault_unconfigured')` branch — so the mechanism
is idiomatic; only the values are missing.

Assuming the server returns something like `{ error: 'token_insufficient', missing: ['推','PR'] }`
and `{ error: 'forge_unreachable' }`, the client code that matches house style is:

```ts
if (!res.ok) {
  taskOk.value = false
  if (body?.error === 'token_insufficient' && Array.isArray(body.missing)) {
    taskMessage.value = `token 权限不足：缺少 ${(body.missing as string[]).join('、')}`
  } else if (body?.error === 'forge_unreachable') {
    taskMessage.value = 'forge 不可达，请检查 base_url 与网络后重试'
  } else {
    taskMessage.value = `发布失败（${res.status}）`
  }
  return
}
```

(The `、` ideographic comma is the correct Chinese list separator here. The exact copy is the
implementer's to write — the above is shape, not mandated wording.)

### 8.4 What in the current UI makes this awkward

1. **One flat string, one slot.** Feedback is a single ref rendered by a single `<n-text>` at the
   bottom of the block. A structured result (which capabilities are missing) has to be
   string-joined into that one slot. That's fine and cheap — but it means the error appears at
   the *bottom of a twelve-field form*, far from the credential inputs that caused it. Fixing
   that properly means `n-form-item` + per-field `feedback`, i.e. adopting the form system the
   app has never used (§3.1).
2. **No `n-alert` in the workbench.** The only `n-alert` uses are the pending card and the
   one-time Agent Key reveal. A 权限不足 failure is arguably alert-worthy (it's actionable and
   the user must go fix a token on the forge), but that would be a new pattern in this card.
3. **Messages are cleared on every action start** (`taskMessage.value = ''` at the top of the
   handler) and there is only one slot per feature — so a validation warning and a submit error
   cannot coexist. Acceptable, but it means a "your token is missing 推" message vanishes the
   moment the user retries.
4. **No retry affordance.** Nothing in the app has a retry button; the user re-clicks the submit
   button. For 不可达 (a transient condition) that's the natural gesture anyway.
5. **`credentials`/`Accept` discipline is manual.** Every new fetch must remember both headers;
   there's no wrapper enforcing it, and forgetting `Accept` silently converts a 401 into a 302
   whose body is HTML — `readJson` then returns `null` and the error branch falls through to the
   generic `（302）` message. Easy trap in a form with two fetches (create + list).
6. **No per-field disable logic**, so the "shared profile XOR inline token" exclusivity has to be
   enforced by hand — either `v-if` on the mode toggle (only one control rendered at a time) or a
   validation guard. `v-if` is the simpler match for house style and makes the XOR structurally
   impossible to violate.

---

## 9. OPEN QUESTIONS

**Q1 — The server task contract does not exist, and the web work is blocked on it.**
No `/api/v1/tasks` route, handler, or test exists anywhere in `apps/server/src` (grepped; hits
only in DESIGN.md and archived research). The web implementer cannot write a single `fetch`
without: the endpoint paths (create / list / edit — and per the settled decision, addressed by
`public_id`, so `/api/v1/tasks/:public_id` with **no** `parsePositiveInt`), the request body key
names, the success body shape, and the `error` codes for the two 发布即校验 failures plus the
field carrying `missing`. Recommend the server contract be fixed first and handed to the web
implementer as a written spec, or that one agent own both halves. Dispatching web work in
parallel with server work will produce a client coded against invented key names.

**Q2 — `credential.profile_id`: string or integer on the wire?**
DESIGN §6's example still shows the string `"cp-gitea-orders"`; `GET /api/v1/credential-profiles`
returns `id: number` and the DB column is `INTEGER PRIMARY KEY AUTOINCREMENT`. Does the create
request send `{ credential: { profile_id: 3 } }`, `{ credential_profile_id: 3 }`, or a string
form? And does the *brief* then project the integer as a string to satisfy
`taskBriefSchema.credential.profile_id: z.string()`? The dropdown's `value` type follows directly
from this.

**Q3 — HTTP projection of the two 发布即校验 failures.**
Which status code for 权限不足 (400? 422?), which for 不可达 (502? 504?), which `error` strings,
and which key carries the missing capabilities (`missing: ['推','PR']`?). Server-side decisions,
but the Chinese copy and the client branch depend on all four. Note the capability values are
already the Chinese labels `读`/`推`/`PR`, so no client-side mapping table is needed if they pass
through unchanged.

**Q4 — "posting/edit form": what does edit mean?**
The brief says posting *and* edit. DESIGN §5's state machine covers `status` transitions only and
says nothing about mutating a task's content. Which fields are editable after 发布, whether edit
re-runs 发布即校验 (it must if `repo` or `credential` changed), and whether an edit is blocked
once a task leaves 待认领 — none of it is determined by code or DESIGN. If this is undecided,
scoping the form to *create only* for issue #7 is the smaller, safer deliverable.

**Q5 — Form validation: extend the one-guard idiom, or adopt `n-form`?**
No `n-form`/`n-form-item`/rules exist; the app's entire client-side validation is one `if (!id)`
guard. Twelve-plus fields with a required/optional split and a XOR credential choice is past the
point where the guard idiom reads well, and per-field errors (which the 权限不足 message wants)
require `n-form-item`. But adopting it is a new pattern. No new dependency either way — Naive UI
is fully registered globally, so this is a style decision, not a dependency one. Recommend
`n-form` + `n-form-item` for this form specifically; it needs a ruling so the implementer doesn't
guess.

**Q6 — How should the four `string[]` fields be entered?**
`acceptance_criteria`, `tags`, `allowed_paths`, `forbidden_paths`. No list-input precedent exists.
`n-dynamic-input` (structured, more code), `n-dynamic-tags` (good for `tags`, poor for
multi-sentence acceptance criteria), or newline-split `n-input type="textarea"` (simplest,
matches the app's minimalism, but silently trims/normalizes). Pick one and apply it to all four.

**Q7 — Should the profile dropdown filter by the selected forge/repo?**
`GET /api/v1/credential-profiles` returns every team profile unfiltered, and the profiles are
keyed `(forge, base_url, repo_full_name)`. Selecting a profile that doesn't match the task's repo
would fail 发布即校验 at post time — a filter would prevent that class of error entirely, but no
such filtering exists anywhere and nobody specified it.

**Q8 — Web test custody.** There is no web test tooling of any kind (§6.1), and the root `test`
script names only server/package files. `tdd-guide` cannot author a failing test for the form
without adding `vitest` + `@vue/test-utils` + a DOM implementation — a new dependency, i.e. an
escalation under CLAUDE.md. Three options: add the tooling (escalate), accept
typecheck + build + lint as the only web verdicts and cover posting behavior through server-side
tests, or hand the web half to the implementer with an explicit "no behavioral test" note.
This needs deciding before the web work is dispatched, not after.

**Q9 — `canApprove` is now doing three jobs.** It gates the approve widget, the credential-profile
widget, and (proposed) the posting form — it really means "is an `active` + `full` member". A
rename to something like `isFullMember` would be honest, but it touches existing lines that other
issues' work may be editing concurrently. Low stakes; flagging so the implementer doesn't rename
it unilaterally mid-run.

**Q10 — Dev-login cookie origin (UNVERIFIED).** `PUBLIC_URL` defaults to `http://localhost:3000`,
callbacks are built as `${PUBLIC_URL}/login/{provider}/callback`, and the session cookie is
`path: '/'`, `sameSite: 'lax'`, `secure: false`. An OAuth round trip started from the Vite origin
(default :5173) therefore appears to land the session on `localhost:3000`, leaving the proxied
SPA unauthenticated. I did not run either server, so this is reasoning from source, not an
observation. If real, the workaround is running the API with `PUBLIC_URL` set to the Vite origin —
worth confirming before the implementer starts manual testing.
