# Ground truth — GitHub issue #19 (发布导入：凭证档案下拉选仓库和 Issue)

Measured worktree (not main, not archive notes): `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-19`  
Branch: `workflow/issue-19`  
HEAD: `41e1e01` (`41e1e01ff4ec58e4651bb6825ee1bcfa7c158c3d`)  
`git status --short --branch`: `## workflow/issue-19` (clean)  
Tip: `41e1e01 chore: ignore generated Cursor workflow agent catalog` (`2026-08-23 14:25:02 +0800`)  
Measured: 2026-08-23. Explorer did not edit the worktree. This file is the only write, at `kaola-workflow/issue-19/.cache/ground-truth.md` (main checkout path, not inside the worktree).

Issue #19 (`https://github.com/KaolaBrother/KaolaTasks/issues/19`, labels `enhancement` `P2` `workflow:in-progress`, state open). Comments do **not** override the body: the only comment is workflow bookkeeping (`Kaola-Workflow started local work for issue-19`). Body stands.

Out of this issue (do not implement here): pagination >50, closed Issues, creating Issues from 考拉, MCP / Task Brief / 认领揭示 changes.

---

## Exploration

Issue #19 must wrap a tree that already has: three-forge `createForgeAdapter` with live `validateToken` / `importIssue` / `getPullRequest` / `registerWebhook` / `parseWebhook` / `commentOnIssue`; package-level `parseIssueUrl` that **rejects** GitLab `/-/work_items/`; session `POST /api/v1/tasks/import` (200 draft, no persist, no `validateToken`); session `POST /api/v1/tasks` (发布即校验 via `validateToken`); credential-profile CRUD with `active`+`full` gate; a Chinese 发布 form that still **hand-fills** forge / base_url / repo and **pastes** an Issue URL, even when a profile is selected.

What is **missing** for #19 (measured, not inferred from archives):

| Claim | Measured now |
|---|---|
| `ForgeAdapter.listIssues` | **Absent.** Interface at `packages/forge-adapters/src/index.ts:53-61` has seven methods; no `listIssues`. |
| Type `ListedIssue` | **Absent.** No symbol in `index.ts`, DESIGN.md, or tests. |
| `GET /api/v1/credential-profiles/:id/issues` | **Absent.** `registerCredentialProfiles` registers only GET list, POST create, DELETE `:id` (`credential-profiles.ts:88-179`). `architecture.md:20` lists `/api/v1/credential-profiles` without `/issues`. |
| DESIGN.md §7 §8 already describe dropdown-as-repo + `listIssues` | **No.** §7 still “发布任务时下拉选择” a profile (token reuse). §8 interface has `importIssue` only under `// 发布/导入时`. Zero matches for `listIssues` / `ListedIssue` / `credential-profiles/:id/issues` in `docs/DESIGN.md`. |
| UI: select profile → select Issue → 导入 preview → 发布; do not hand-fill forge/base_url/repo; do not paste URL | **No.** Publish pane still has `task-forge` / `task-base-url` / `task-repo` / `task-issue-url` (`App.vue:255-277`). Selecting `task-credential-profile` does **not** copy profile `forge`/`base_url`/`repo_full_name`. No Issue dropdown. No GET `.../issues`. |
| Stop pasting GitLab `/-/work_items/…` | Adapter **already rejects** it (`import-issue.shared.test.ts:498-515`; `parseGitlabIssueUrl` only `/-/issues/` then legacy `/issues/`). The **UI still asks the user to paste a URL**, so the work_items paste is still the live path. |
| `POST /import` and `POST /tasks` bodies unchanged | Already implemented (snake_case). UI currently fills them from **hand-typed** fields. |
| Not a third token-reveal channel | GET profiles / import 200 / events never return a forge token today. The new GET does not exist yet. Existing import **does** write `events.type` `token 揭示` on the profile path (`tasks.ts:713-735`). Issue #19 says the new GET must **not** write `token 揭示`. |

The reusable pattern is `importIssue` + `POST /api/v1/tasks/import` (`importForgeFailure`, `parseIssueUrl` before decrypt, `decryptToken` + `isVaultUnconfiguredError` → 500). Shared-spec shape is `import-issue.shared.test.ts` (`KINDS` loop + `t.mock.method(globalThis, 'fetch', …)`). A new spec file is **not** auto-discovered: root `package.json` `"test"` lists files by path.

---

## Entry Points

| Surface | Path | What it does today vs #19 |
|---|---|---|
| Adapter factory | `packages/forge-adapters/src/index.ts:73-89` `createForgeAdapter(kind, options?)` | Returns `ForgeAdapter`. No `listIssues` binding. |
| Adapter method (missing) | — | `listIssues` is not on the interface. |
| `parseIssueUrl` | `index.ts:418-428` (package-level export) | `{ full_name: string } \| undefined`. GitLab `/-/work_items/` → `undefined`. Used by HTTP import **before** decrypt (`tasks.ts:659`). |
| `importIssue` | `index.ts:471-493` | Live. Parses pasted web URL; GitHub `api.github.com`; GitLab/Gitea constructor `baseUrl`; returns pasted URL as `issue_url` (not JSON `web_url` / `html_url`). |
| Profile HTTP | `apps/server/src/credential-profiles.ts:88-179` | GET/POST `/api/v1/credential-profiles`, DELETE `/:id`. No GET `/:id`, no GET `/:id/issues`. GET never decrypts. |
| Import HTTP | `apps/server/src/tasks.ts:640-747` `POST /api/v1/tasks/import` | Session, `active`+`full`, `parseIssueUrl`, decrypt, `importIssue`, 200 draft. No persist. No `validateToken`. |
| Publish HTTP | `tasks.ts:499-638` `POST /api/v1/tasks` | Session, `active`+`full`, decrypt/encrypt, `validateToken`, insert `待认领`. Client supplies `source` + `repo.*`. |
| Publish form | `apps/web/src/App.vue:227-372` + `createTask` `:1542` + `importTask` `:1643` | Hand-filled forge/base_url/repo + pasted Issue URL + existing 导入 / 发布. Profile dropdown exists but does not drive repo fields. |
| 钥匙 pane profiles | `App.vue:463-510` | Create/list/delete profiles. Empty copy 「暂无凭证档案。」. Publish pane has **no** “go to 钥匙” empty-state. |
| MCP | `apps/server/src/mcp.ts:91-159` | Six tools. No import / list-issues tool. |

`buildApp` registrar order (`apps/server/src/app.ts:88-96`):

```
registerAuth
→ registerAgentKeys
→ registerCredentialProfiles
→ registerTasks
→ registerClaim
→ registerClaimConfirmations
→ registerEvents
→ registerMcp
→ registerWebhooks
```

HTTP verbs registered in those modules (complete list of `app.get`/`post`/`patch`/`delete` plus claim/mcp child `.post`):

- `app.ts`: `GET /` (placeholder or SPA)
- `auth.ts`: `GET /login`, OAuth callbacks, `GET /api/v1/me`, `PUT /api/v1/me/settings`, `POST /api/v1/users/:id/approve`
- `agent-keys.ts`: `POST/GET /api/v1/agent-keys`, `DELETE /api/v1/agent-keys/:id`, Bearer `GET /api/v1/agent/whoami`
- `credential-profiles.ts`: `GET/POST /api/v1/credential-profiles`, `DELETE /api/v1/credential-profiles/:id`
- `tasks.ts`: `GET/POST /api/v1/tasks`, `POST /api/v1/tasks/import`, `GET/PATCH /api/v1/tasks/:publicId`
- `claim.ts`: Bearer `POST /api/v1/tasks/:publicId/claim|progress|release`
- `claim-confirmations.ts`: `GET /api/v1/claim-confirmations`, `POST …/:id/approve|reject`
- `events.ts`: `GET /api/v1/events`, `GET /api/v1/stats`
- `mcp.ts`: Bearer `POST /api/mcp` (GET/DELETE 405)
- `webhook.ts`: `POST /api/v1/webhooks/:publicId`

**There is no `GET /api/v1/credential-profiles/:id/issues`.** `docs/api.md` credential-profile section (`:92-114`) documents only GET list / POST / DELETE.

---

## Execution Flow

### A. What exists: paste Issue URL → import draft → complete form → POST /tasks

```
browser importTask()
  → POST /api/v1/tasks/import
       { issue_url, repo:{ forge, base_url, full_name? }, credential:{ profile_id } XOR { token } }
  → getSessionUser  (401 { error:'unauthorized' } JSON / 302 /login)
  → canPostTasks: status==='active' && permissionLevel==='full'  else 403 { error:'forbidden' }
  → readImportBody
  → isHttpOrHttpsUrlWithHost(repo.base_url)  else 400 + 仓库地址不是合法的 http 或 https 地址。
  → parseIssueUrl(forge, issue_url)  else 400 + 无法解析 Issue 地址。  (zero fetch; no token 揭示)
  → optional repo.full_name === parsed.full_name  else 400 + Issue 地址与仓库不匹配。
  → profile: load row, bind forge/base_url/**parsed** full_name ===, decryptToken
    inline: use request token (no encrypt)
    vault miss (profile path) → 500 { error:'vault_unconfigured' }
  → createForgeAdapter(forge, { baseUrl }).importIssue({ token }, issue_url)
       404/410 → 404 { error:'issue_not_found', message:'无法读取该 Issue。' }
       401 → 422 { error:'token_check_failed', missing:['读'], message:'token 无效或无权读取该 Issue。' }
       other non-OK / throw → 502 { error:'forge_unreachable', message:'无法连接 forge 导入 Issue。' }
  → profile path: events.type `token 揭示` (ok | issue_not_found | token_check_failed | forge_unreachable)
  → 200 draft { title, description_md, source:{type:'imported', issue_url}, repo:{ forge, base_url, full_name } }
     no token; no tasks row

browser createTask()
  → POST /api/v1/tasks  (existing 发布即校验 via validateToken; persist 待认领)
```

`listIssues` is **not** on this path. The form still requires the user to type `issue_url` and `repo.*`.

### B. What #19 asks for (not implemented)

```
[missing DESIGN §7 §8 first]
→ 钥匙页 already stores credential_profiles
→ 发布页 (imported + profile): dropdown = profiles (label {forge} {repo_full_name})
     selecting a row fills repo.forge / base_url / full_name (stop hand-fill)
→ [missing] GET /api/v1/credential-profiles/:id/issues
     → [missing] listIssues(cred, repo)  open, ≤50, newest first
     → Issue dropdown #{number} {title}
→ user picks Issue (does NOT auto-import)
→ existing POST /import with constructed parseIssueUrl-legal issue_url
→ human checks title/body
→ existing POST /tasks
inline token fallback: keep paste URL + hand-fill repo (no profile to list)
empty profiles: empty repo dropdown, hint 钥匙, no list request
```

### C. Adapter `importIssue` (the host/parse pattern `listIssues` should reuse)

```
importIssue(kind, options, cred, issueUrl)
  → resolveImportedIssue → parseIssueUrl parsers + prApiOrigin
  → forgeGet(kind, apiUrl, token)
  → if !res.ok throw Error(`importIssue: ${kind} responded ${status}`)
  → map title / description_md / issue_url(=pasted, slash-stripped) / repo.full_name
```

Host rule (`index.ts:164-167` `prApiOrigin`, used by `resolveImportedIssue` `:435`): GitHub API origin is always `https://api.github.com`. GitLab/Gitea use constructor `options.baseUrl`, **never** the pasted URL's host. `validateToken`'s `apiUrl` is different: GitLab/Gitea origin is `options?.baseUrl ?? repo.base_url` (`index.ts:534`).

### D. `parseIssueUrl` vs GitLab `web_url` / `work_items`

`parseIssueUrl` returns only `{ full_name }` (GitLab: the namespace, which may be multi-segment). It does **not** return `number`/`iid`.

`importIssue` never reads GitLab JSON `web_url` (or GitHub `html_url`). `issue_url` in `ImportedIssue` is the **pasted** string after `replace(/\/+$/u, '')` (`index.ts:490`). There is no helper that **builds** `{base_url}/{full_name}/issues/{n}` or GitLab `/{namespace}/-/issues/{iid}`. That construction is exactly what #19 assigns to `listIssues`.

---

## Architecture Insights

1. **#19 is UI + one new adapter method + one new GET, not a new POST body.** `POST /import` and `POST /tasks` already accept snake_case `issue_url` + `repo.*` + `{ profile_id }` XOR `{ token }`. The UI must **fill those existing fields** from a profile row + a listed Issue.

2. **DESIGN.md must change first.** Issue body: 「`docs/DESIGN.md` §7 §8 先改契约，再改代码」. Current §7/§8 do not mention `listIssues`, `ListedIssue`, or GET `.../issues`. Project rule: DESIGN is the contract source of truth; change it before changing the adapter interface / HTTP surface.

3. **`importForgeFailure` is import-specific.** `tasks.ts:255-284` maps 404/410 → `issue_not_found`, 401 → 422 `token_check_failed` + 「token 无效或无权读取该 Issue。」, else 502 「无法连接 forge 导入 Issue。」. Listing has no 404-issue semantics. Reuse the **401→422** mapping and `forgeResponseStatus` (`/responded (\d+)\s*$/u`); do **not** reuse the 404/410 branch or the 导入 502 copy.

4. **502 copy is already three parallel strings**, not one shared helper:

| Constant | File | String |
|---|---|---|
| `FORGE_UNREACHABLE_MESSAGE` | `tasks.ts:19` | `无法连接 forge 校验 token，任务未发布。` |
| `IMPORT_FORGE_UNREACHABLE_MESSAGE` | `tasks.ts:27` | `无法连接 forge 导入 Issue。` |
| (missing) | — | issue suggests `无法连接 forge 列出 Issue。` |

Recommendation: write the **列出** parallel into DESIGN/api.md. Do not force list GET to share import's 导入 sentence.

5. **422 copy: issue says 与 import 同源文案.** Import's exact string is `IMPORT_TOKEN_INVALID_MESSAGE` = `token 无效或无权读取该 Issue。` (`tasks.ts:26`). Reuse that constant even though listing is not “该 Issue” singular — the issue body pins it.

6. **Profile GET never decrypts.** `publicProfile` (`credential-profiles.ts:28-36`) returns `id, forge, base_url, repo_full_name, scopes_checked, created_by`. Decrypt happens on POST tasks, POST import (profile path), claim, poller/writeback `decryptTaskToken`, and module `revealCredentialProfile` (not HTTP). The new GET **must** decrypt server-side to call `listIssues`, like import/poller, without putting plaintext on the wire.

7. **`token 揭示` on import is a pre-existing event, not a reveal channel.** Profile-path import writes `events.type` `token 揭示` after decrypt (`tasks.ts:713-735`) even though the HTTP 200 contains no token. Issue #19: the new GET **不写** `token 揭示` (decrypt like 轮询). Do not copy `insertTokenRevealEvent` onto the list route.

8. **Shared specs are parameterized copies.** `import-issue.shared.test.ts:6-8` says do not import `get-pull-request.shared.test.ts`; helpers are copied and trimmed. A `list-issues.shared.test.ts` should copy that shape and be **appended** to root `"test"` or it will not run.

9. **Session gates are not identical across modules.**

| Helper | Predicate | Used by |
|---|---|---|
| `canManageProfiles` | `active` && `full` | credential-profile CRUD |
| `canPostTasks` | `active` && `full` (same) | POST tasks, POST import, PATCH |
| `requireActiveSessionUser` | session && `status !== '待批准'` (claim_only **allowed**) | claim-confirmations, `/me/settings` |
| `canReadEvents` | `status !== '待批准'` | GET events/stats |
| GET `/api/v1/tasks` | any logged-in including 待批准 | list/get brief |

Issue #19: GET `.../issues` gate = 档案 CRUD = `active`+`full`, else `403 { error: 'forbidden' }`. Unauthenticated = same 401/302 oracle as `GET /api/v1/me` (`sendUnauthorized`). **Do not** copy `requireActiveSessionUser` (that would let `claim_only` through).

10. **`parsePositiveInt` is duplicated** (`credential-profiles.ts:60-64`, `claim-confirmations.ts:87-91`): non-integer / `<=0` → `404 { error: 'not_found' }` on DELETE. Issue wants the same 404 for missing row or non-positive id on GET issues.

11. **Selecting a profile today does not bind repo.** `taskProfileOptions` (`App.vue:859-864`) is label-only. `watch` exists for `profileForge` / `taskForge` default base_url (`:954-959`), **not** for `taskCredentialProfileId`. `createTask` / `importTask` read `taskForge` / `taskBaseUrl` / `taskRepo` independently of the selected profile. Server then **rejects** mismatch with `所选凭证档案与仓库不匹配。` if the human typed a different repo.

12. **Issue dropdown label vs current profile label.** Issue wants repo dropdown label `{forge} {repo_full_name}`. Current profile option label is `` `#${id} ${forge} ${repo_full_name}（${base_url}）` `` (`App.vue:861`). 钥匙 list row uses the same `#id forge repo（base_url）` (`:508`).

---

## Key Files

| File | Role |
|---|---|
| `docs/DESIGN.md` §6 §7 §8 | Contract — **must be edited before code** for #19 |
| `docs/api.md` | Implemented import / profile / token-reveal docs (no GET issues) |
| `packages/forge-adapters/src/index.ts` | Interface, factory, `parseIssueUrl`, `importIssue`, host rules |
| `packages/forge-adapters/src/import-issue.shared.test.ts` | KINDS spec + work_items rejection; pattern to copy |
| `packages/forge-adapters/src/get-pull-request.shared.test.ts` | “do not import sibling spec” comment |
| `packages/forge-adapters/src/index.test.ts` | Health string only |
| `apps/server/src/credential-profiles.ts` | Profile CRUD + `canManageProfiles` + `parsePositiveInt` + `publicProfile` |
| `apps/server/src/tasks.ts` | POST import + POST tasks + `importForgeFailure` + vault 500 |
| `apps/server/src/import.test.ts` | HTTP import oracle (401/403/200/400/404/422/502/500) |
| `apps/server/src/vault.ts` | `decryptToken` / `isVaultUnconfiguredError` / `insertAuditEvent` |
| `apps/server/src/vault.test.ts` | Profile CRUD 401/403/200-without-token |
| `apps/server/src/app.ts` | Registrar order |
| `apps/server/src/schema.ts` | `credential_profiles` columns |
| `apps/web/src/App.vue` | 发布 + 钥匙; single file (no split) |
| `apps/web/src/App.form.test.ts` | Pins paste-URL import + hand-filled repo POST body |
| `apps/web/src/App.shell.test.ts` | `claim_only` hides 发布; five `task-group-*` |
| `package.json` | Explicit test file list |

---

## Dependencies

- `@kaola/server` → `workspace:*` `@kaola/shared`, `@kaola/forge-adapters` (already).
- Adapter package has **no** runtime HTTP dependency: global `fetch` only (`docs/api.md:416`).
- Web: `vue` ^3.5.0, `naive-ui` ^2.45.0. Form lives in `App.vue`; no vue-router. Tests: `@vue/test-utils` + `happy-dom` + vitest `include: 'src/**/*.test.ts'` (`apps/web/vite.config.ts:12-14`).
- Root test script (`package.json:13`) currently (quoted):

```
node --experimental-strip-types --test
  packages/shared/src/index.test.ts
  packages/forge-adapters/src/index.test.ts
  packages/forge-adapters/src/validate-token.shared.test.ts
  packages/forge-adapters/src/get-pull-request.shared.test.ts
  packages/forge-adapters/src/import-issue.shared.test.ts
  packages/forge-adapters/src/webhook.shared.test.ts
  packages/forge-adapters/src/comment-on-issue.shared.test.ts
  apps/server/src/import.test.ts
  apps/server/src/placeholder.test.ts
  apps/server/src/auth.test.ts
  apps/server/src/agent-keys.test.ts
  apps/server/src/vault.test.ts
  apps/server/src/tasks.test.ts
  apps/server/src/hosting.test.ts
  apps/server/src/claim.test.ts
  apps/server/src/mcp.test.ts
  apps/server/src/poller.test.ts
  apps/server/src/webhook.test.ts
  apps/server/src/writeback.test.ts
  apps/server/src/events.test.ts
  apps/server/src/claim-confirm.test.ts
&& pnpm --filter @kaola/web test
```

A new `packages/forge-adapters/src/list-issues.shared.test.ts` (name not prescribed by the tree) **must** be added to this array or CI will not run it. Same for a new `apps/server/src/*issues*.test.ts` if HTTP tests are a new file. `pnpm --filter @kaola/forge-adapters test` does **not** exist (package has only `typecheck`/`build`). Web tests are globbed (`App.form.test.ts`, `App.shell.test.ts`, `App.board.test.ts`, `App.settings.test.ts`, `App.audit.test.ts`).

---

## Measurement memo (signatures, line citations)

### 1. DESIGN.md §6 §7 §8

**§6 Task Brief** (`docs/DESIGN.md:101-152`): JSON example has `source.type: "imported"` + `issue_url` Gitea `…/issues/87`, `repo.{forge,base_url,full_name,…}`, `credential: { "profile_id": "cp-gitea-orders" }` **or** `{ "inline": true }`. 「两种形态下任务卡都**不含 token 明文**」. No `ListedIssue`. No GET issues. No dropdown-as-repo. Issue #19: Brief unchanged.

**§7 凭证与安全模型** (`:154-166`), credential-profile bullet `:158`:

> **凭证档案（Credential Profile）**：按"forge + 仓库"维度存储可复用 token，团队连接一次、发布任务时下拉选择；也允许发布者为某个任务粘贴一次性 token（覆盖档案）。

Reveal-on-claim `:161`:

> token 只在 `claim_task` 成功时下发给认领 Agent；`list_tasks` / `get_task_brief` 永不含 token。

No mention of listing Issues from a profile, of filling `repo.*` from the selected row, or of GET `.../issues`. The “下拉选择” that exists in code is the **credential** select (`task-credential-profile`), not a repo/Issue picker.

**§8 ForgeAdapter** (`:168-192`):

```ts
interface ForgeAdapter {
  readonly kind: 'github' | 'gitlab' | 'gitea'

  // 发布/导入时
  validateToken(cred: Credential, repo: RepoRef): Promise<TokenCheck>   // 可读？可开 PR？
  importIssue(cred: Credential, issueUrl: string): Promise<ImportedIssue>

  // 状态闭环
  getPullRequest(cred: Credential, prUrl: string): Promise<PrStatus>    // open/merged/closed
  registerWebhook?(cred: Credential, repo: RepoRef, callback: string): Promise<void>
  parseWebhook(headers: Headers, body: unknown): ForgeEvent | null

  // 回写
  commentOnIssue(cred: Credential, issueRef: IssueRef, body: string): Promise<void>
}
```

要点 (`:190-192`): three implementations, one shared spec; GitLab/Gitea constructor `baseUrl`; GitHub `api.github.com`. **`listIssues` / `ListedIssue` do not appear.** Doc `registerWebhook?` is optional; TS interface requires it (`index.ts:58`).

**`docs/api.md` vs DESIGN:** api.md already documents live `importIssue` + `parseIssueUrl` including 「`/-/work_items/` pathnames) rejects **without** calling `fetch`」 (`docs/api.md:487`). Credential profiles HTTP (`:92-114`) has no `/issues` sub-route.

### 2. Forge adapters

**Health + kinds + credential + repo** (`index.ts:3-20, 63-66`):

```ts
export function getForgeAdaptersHealth(): string  // 'kaola-forge-adapters-ready'
export type ForgeKind = 'github' | 'gitlab' | 'gitea'
export type Credential = { token: string }
export type RepoRef = { full_name: string; base_url: string }
export type TokenCapability = '读' | '推' | 'PR'
export type TokenCheck = { missing: TokenCapability[] }
export type CreateForgeAdapterOptions = { baseUrl?: string; webhookSecret?: string }
```

`RepoRef` **exists** and is what `validateToken` / `registerWebhook` take. `importIssue` / `getPullRequest` take a URL string, not `RepoRef`. Issue #19's `listIssues(cred, repo: RepoRef)` would be the first Issue-list method that takes `RepoRef` (like `validateToken`), not a pasted URL.

**Live payload types** (`index.ts:22-42`):

```ts
export type ImportedIssue = {
  title: string
  description_md: string
  issue_url: string
  repo: { full_name: string }
}
export type PrStatus = { state: 'open' | 'merged' | 'closed' }
export type ForgeEvent = {
  type: 'pull_request'
  state: 'merged' | 'closed'
  pr_url: string
  repo: { full_name: string }
}
export type IssueRef = { issue_url: string }
```

No `ListedIssue`.

**Interface — every method** (`index.ts:53-61`):

```ts
export interface ForgeAdapter {
  readonly kind: ForgeKind
  validateToken(cred: Credential, repo: RepoRef): Promise<TokenCheck>
  importIssue(cred: Credential, issueUrl: string): Promise<ImportedIssue>
  getPullRequest(cred: Credential, prUrl: string): Promise<PrStatus>
  registerWebhook(cred: Credential, repo: RepoRef, callback: string): Promise<void>
  parseWebhook(headers: Headers, body: unknown): ForgeEvent | null
  commentOnIssue(cred: Credential, issueRef: IssueRef, body: string): Promise<void>
}
```

**Factory** (`index.ts:73-89`):

```ts
export function createForgeAdapter(
  kind: ForgeKind,
  options?: CreateForgeAdapterOptions,
): ForgeAdapter
```

Unknown kind → `throw new Error(\`unknown forge kind: ${String(kind)}\`)` (`:77-79`). Wiring:

| method | binding |
|---|---|
| `kind` | constructor arg |
| `validateToken` | `(cred, repo) => validateToken(kind, options, cred, repo)` |
| `importIssue` | `(cred, issueUrl) => importIssue(kind, options, cred, issueUrl)` |
| `getPullRequest` | `(cred, prUrl) => getPullRequest(kind, options, cred, prUrl)` |
| `registerWebhook` | `(cred, repo, callback) => registerWebhook(kind, options, cred, repo, callback)` |
| `parseWebhook` | `(headers, body) => parseWebhook(kind, options, headers, body)` |
| `commentOnIssue` | `(cred, issueRef, body) => commentOnIssue(kind, options, cred, issueRef, body)` |
| `listIssues` | **not present** |

`validateToken` / `importIssue` / etc. are **not** package-level named exports. Package-level exports used by the server: `createForgeAdapter`, `parseIssueUrl`, `WebhookSignatureError`. Package export `"."` → `./src/index.ts`.

**`parseIssueUrl(kind, issueUrl): { full_name: string } | undefined`** (`index.ts:390-428`)

Strip: `parsedIssueUrl` = `new URL(url.replace(/\/+$/u, ''))` (`:390-396`). Query/hash dropped via `URL.pathname`.

| kind | accepted pathname | `full_name` |
|---|---|---|
| github | `/^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/` (`parseOwnerRepoIssueUrl` `:398-404`) | `${owner}/${repo}` |
| gitea | same owner/repo/issues regex | `${owner}/${repo}` |
| gitlab canonical (first) | `/^\/(.+)\/-\/issues\/(\d+)$/` (`:409-412`) | `namespace` (`.+` allows subgroups) |
| gitlab legacy (second) | `/^\/(.+)\/issues\/(\d+)$/` (`:413-415`) | `namespace` |

**Rejected (return `undefined`, no fetch when used via `importIssue`):** GitLab `/-/work_items/{n}` (no matching regex); GitHub `/pull/{n}`; Gitea `/pulls/{n}`; GitLab `/-/merge_requests/{n}`; garbage URLs. Pinned `import-issue.shared.test.ts:498-515` — pasted `https://gitlab.example.com/acme/app/-/work_items/46` → reject, `requests.length === 0`. Error from `resolveImportedIssue` is `unparseable GitLab issue URL: ${issueUrl}` (`index.ts:448-449`). HTTP import maps any `parseIssueUrl` miss to `400 { error:'invalid_body', message:'无法解析 Issue 地址。' }` **before** fetch (`tasks.ts:659-664`).

Return type is **only** `{ full_name }`. Number/iid is discarded by `parseIssueUrl` (parsers have it internally; the export does not).

**`importIssue` fetch host + mapping** (`index.ts:430-493`)

`resolveImportedIssue` + `prApiOrigin`:

| kind | API GET |
|---|---|
| github | `https://api.github.com/repos/{enc owner}/{enc repo}/issues/{number}` |
| gitlab | `{constructor baseUrl}/api/v4/projects/{enc namespace}/issues/{iid}` |
| gitea | `{constructor baseUrl}/api/v1/repos/{enc owner}/{enc repo}/issues/{number}` |

GitHub ignores constructor `baseUrl`. GitLab/Gitea **never** use the pasted host (`import-issue.shared.test.ts:517-547`; HTTP SSRF pin `import.test.ts:508-528`).

Mapping:

- `title` ← JSON `title` (missing/non-string → throw `importIssue: ${kind} issue is missing a title` after one fetch)
- `description_md` ← GitLab `description`, GitHub/Gitea `body` (`null`/missing/non-string → `''`) (`readIssueDescription` `:466-469`)
- `issue_url` ← **pasted** URL with trailing slashes stripped — **not** `web_url` / `html_url`
- `repo.full_name` ← parsed owner/repo or GitLab namespace

Non-OK: `throw new Error(\`importIssue: ${kind} responded ${res.status}\`)` (`:479-480`). HTTP `importForgeFailure` parses that `responded N` suffix (`tasks.ts:248-253`).

**Auth headers** (`authHeaders` `:538-550`), reused by `forgeGet`:

| kind | headers |
|---|---|
| github | `Authorization: Bearer ${token}`, `User-Agent: KaolaTasks`, `Accept: application/vnd.github+json` |
| gitlab | `PRIVATE-TOKEN: ${token}` |
| gitea | `Authorization: token ${token}` |

`forgeGet` (`:552-557`): `globalThis.fetch(url, { method:'GET', headers: authHeaders(kind, token) })`. No timeout, no `AbortSignal`. Network failure **rejects**; import maps that to 502.

**Existing list/issues helpers:** none. The only `/issues/` URL builders are **single-issue** GETs inside `resolveImportedIssue`. No `state=open`, no `per_page`, no GitHub `pull_request` filter.

**Shared spec pattern** (`import-issue.shared.test.ts`):

- Header `:6-8`: Issue #12; do not import `get-pull-request.shared.test.ts`; helpers copied/trimmed.
- `KINDS = ['github', 'gitlab', 'gitea']` (`:10`).
- `createAdapter`: GitHub may omit `baseUrl`; GitLab/Gitea `createForgeAdapter(kind, { baseUrl: baseUrl ?? WEB_ORIGIN[kind] })` (`:33-38`).
- `installFetch` + `t.mock.method(globalThis, 'fetch', …)` (`:79-96`).
- Per-kind: GET exact API URL + auth; trailing slash; null body → `''`; missing title rejects after fetch; non-OK rejects after fetch; unparseable (including PR/MR paths) rejects with **zero** extra fetch; GitHub custom `baseUrl` still `api.github.com`; GitLab canonical `/-/issues/` + legacy `/issues/`; GitLab `/-/work_items/` unparseable; GitLab/Gitea constructor `baseUrl` vs other-host issue URL (SSRF).
- `index.test.ts`: only `getForgeAdaptersHealth() === 'kaola-forge-adapters-ready'`. No `parseIssueUrl` unit tests as a named export (coverage is via `importIssue` + HTTP import).

### 3. HTTP credential profiles + import

**`registerCredentialProfiles`** (`credential-profiles.ts:88-179`)

| method | path | gate | success | errors |
|---|---|---|---|---|
| GET | `/api/v1/credential-profiles` | session; `canManageProfiles` = `active`+`full` | `200 { profiles: [publicProfile] }` | no session → `sendUnauthorized` (`401 { error:'unauthorized' }` if `Accept` has `application/json`, else `302 /login`); not `active`+`full` → `403 { error:'forbidden' }` (no `message`) |
| POST | same | same | `201` publicProfile; encrypts token; `events.type` `变更` `{ action:'create', profile_id }` | `400 { error:'invalid_body' }`; `409 { error:'conflict' }`; vault → `500 { error:'vault_unconfigured' }` |
| DELETE | `/api/v1/credential-profiles/:id` | same | `200 { ok:true, message:'请同时到 forge 侧撤销该 token。' }`; `变更` `{ action:'delete', profile_id }` | bad/missing id → `404 { error:'not_found' }` |

`publicProfile` (`:28-36`): `{ id, forge, base_url, repo_full_name, scopes_checked, created_by }`. **Never** `token` / `token_encrypted`. GET **does not decrypt**. `revealCredentialProfile` (`vault.ts:87-106`) is a module export used by claim, **not** an HTTP handler.

`parsePositiveInt` (`:60-64`): `Number.parseInt(raw, 10)`; reject non-integer or `<= 0`. DELETE uses it → 404.

Pinned: `vault.test.ts:317-330` JSON unauthenticated GET/POST/DELETE → `401 { error:'unauthorized' }`; `:333-341` browser-like GET → `302` `/login`; `:478-495` pending GitHub → `403 { error:'forbidden' }` on GET/POST/DELETE; `:498-538` approved `claim_only` → same 403; `:346-384` GitLab POST 201 + GET list `assertNoSecrets` (no `token` / `token_encrypted`, plaintext absent from JSON).

**`POST /api/v1/tasks/import`** (`tasks.ts:640-747`)

Body (`readImportBody` `:237-246`, `readImportRepo` `:225-235`, `readCredential` `:289-301`):

```
{
  issue_url: string (non-empty),
  repo: { forge: 'github'|'gitlab'|'gitea', base_url: string, full_name?: string },
  credential: { profile_id: number|numeric-string } XOR { token: string }
}
```

Generic parse fail → `400 { error:'invalid_body' }` **no** `message` (`:648-650`; `import.test.ts:548-550`).

Does it call `validateToken`? **No.** Comment `:640` + assertion `import.test.ts:472, 676`. Persist? **No.** `import.test.ts:475` `taskCount === 0`.

200 draft (`tasks.ts:737-746`; `import.test.ts:408-414` `assertImportDraft`):

```
{
  title, description_md,
  source: { type: 'imported', issue_url },
  repo: { forge, base_url, full_name }
}
```

Not a Task Brief. Nested keys must not include `token` / `token_encrypted` / `inline_token_encrypted` / `access_token` (`SECRET_KEY_NAMES` `import.test.ts:35`).

Exact error JSON:

| status | body | when |
|---|---|---|
| 400 | `{ error:'invalid_body' }` (no message) | generic parse |
| 400 | `{ error:'invalid_body', message:'仓库地址不是合法的 http 或 https 地址。' }` | `repo.base_url` not http(s)+host (`REPO_BASE_URL_INVALID_MESSAGE` `:22`) |
| 400 | `{ error:'invalid_body', message:'无法解析 Issue 地址。' }` | `parseIssueUrl` undefined (`:23`) |
| 400 | `{ error:'invalid_body', message:'Issue 地址与仓库不匹配。' }` | optional `full_name` ≠ parsed (`:24`) |
| 400 | `{ error:'invalid_body', message:'所选凭证档案不存在。' }` | missing profile (`:20`) |
| 400 | `{ error:'invalid_body', message:'所选凭证档案与仓库不匹配。' }` | profile bind fail vs parsed full_name (`:21`) |
| 401 | `{ error:'unauthorized' }` or 302 `/login` | no session (`import.test.ts:419-423`) |
| 403 | `{ error:'forbidden' }` | 待批准 or `claim_only` (`:426-451`) |
| 404 | `{ error:'issue_not_found', message:'无法读取该 Issue。' }` | forge HTTP 404 or 410 (`:25`, `:261-266`) |
| 422 | `{ error:'token_check_failed', missing:['读'], message:'token 无效或无权读取该 Issue。' }` | forge HTTP 401 (`:26`, `:268-277`; pin `:623-634`) |
| 502 | `{ error:'forge_unreachable', message:'无法连接 forge 导入 Issue。' }` | other non-OK or network throw (`:27`; pin `:637-654`) |
| 500 | `{ error:'vault_unconfigured' }` | profile decrypt, missing/invalid `VAULT_MASTER_KEY` (`:698-699`; pin `:824-841`) |

Profile-path import **writes** `token 揭示` after decrypt including 404/422/502 (`:713-735`). Bind-mismatch **does not** (`:814-821`). Inline path writes **zero** `token 揭示` (`:476`).

**`POST /api/v1/tasks` body** (imported + profile) — `readCreateBody` `:305-361`; UI pin `App.form.test.ts:330-350`:

```
{
  title, description_md,
  source: { type:'imported', issue_url } | { type:'native' },
  repo: { forge, base_url, full_name, base_branch?, suggested_dir? },
  acceptance_criteria[], test_command,
  constraints: { allowed_paths[], forbidden_paths[] },
  priority, tags[],
  credential: { profile_id: <int> } XOR { token: <string> }
}
```

Profile bind is `repo.forge` / `repo.base_url` / `repo.full_name` exact `===` to the profile row **before** decrypt (`tasks.ts:529-537`) — unlike import, which binds **parsed** `full_name` from the Issue URL (`:684-687`). Then `validateToken` (not `importIssue`). 502 copy is **校验 token**, not 导入 Issue (`:19`, `:581-583`). 422 `token_check_failed` uses `tokenCheckMessage` (`:77-81`): if missing includes `读` → `token 无效或无权访问该仓库，任务未发布。`; else `token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。`.

**Vault 500 reuse:** `isVaultUnconfiguredError` (`vault.ts:22-29`) + `VaultUnconfiguredError.code === 'vault_unconfigured'`. Same `500 { error:'vault_unconfigured' }` object (no message) in: profile POST encrypt (`credential-profiles.ts:116-117`), POST tasks decrypt/encrypt (`tasks.ts:543-554`), POST import profile decrypt (`:698-699`), `claimTask` (`claim.ts:173-174`). Not a shared HTTP helper function — duplicated try/catch. `decryptTaskToken` (`writeback.ts:25-41`) **swallows** vault errors (returns `undefined`); do not reuse that for the new GET (issue wants 500).

**GET `.../issues`:** does not exist. Fastify would need a new `app.get` on `registerCredentialProfiles` (or a sibling registrar). `app.ts` order already has `registerCredentialProfiles` before `registerTasks`.

### 4. Web publish pane

Lives in **`apps/web/src/App.vue` only** (no split publish component). `view === 'member'` four-pane shell; 发布 pane `v-show="workbenchPane === 'publish'"` inside `v-if="canApprove"` (`:227-232`).

`canApprove` (`:822-824`): `me.status === 'active' && me.permission_level === 'full'`. `claim_only` / 待批准: no `workbench-nav-publish`, no `task-form` (`App.form.test.ts:305-320`; `App.shell.test.ts:364-373`). 钥匙 pane still visible for `claim_only`, but 凭证档案 block is also `v-if="canApprove"` (`App.vue:463`) — so `claim_only` cannot create profiles either.

**Source imported vs native** (`:247-266`, `:792-795`): `sourceTypeOptions` 「平台自有」/`native` vs 「从 Issue 导入」/`imported`. Imported shows 「导入内容」 (`task-import-source-label`), `task-issue-url` (placeholder `https://…`), button 「导入」 (`task-import`). Native hides all three (`App.form.test.ts:686-707`).

**Credential profile vs inline** (`:332-361`, `:804-807`): default `taskCredentialMode = 'profile'`. Profile → `n-select` `task-credential-profile` (`taskProfileOptions` from `GET /api/v1/credential-profiles`). Inline → password `task-credential-token` 「单任务临时 token」. Default mode is profile (`App.form.test.ts:436-439`).

**Hand-filled today** (`task-group-repo` `:268-277`):

| testid | field | default |
|---|---|---|
| `task-forge` | forge select | `'gitlab'` (`:742`) |
| `task-base-url` | 仓库地址 | github→`https://github.com`, gitlab→`https://gitlab.com`, gitea empty (`:943-959`) |
| `task-repo` | 仓库 `owner/repo` | `''` |
| `task-issue-url` | pasted Issue URL | `''` (imported only) |

Existing profile dropdown **does not** fill those three. No `watch(taskCredentialProfileId)`. No Issue `<n-select>`. No fetch to `credential-profiles/:id/issues`. Empty profiles: dropdown options `[]`, placeholder 「选择凭证档案」; 钥匙 pane empty copy 「暂无凭证档案。」 (`:505`) — publish pane has **no** “先去钥匙页添加” hint and **no** guard that skips a list request (there is no list request).

**导入 button** (`importTask` `:1643-1679`): always POST `/api/v1/tasks/import` with `{ issue_url: taskIssueUrl.trim(), repo: { forge, base_url }, credential }`. **Omits** `repo.full_name` on import (`App.form.test.ts:723-727`). 200 fills title, `description_md`, `taskRepo` from `repo.full_name`; keeps source imported. Failures show `body.message` or `导入失败（${status}）` (`:1664-1665`; pin `:764-772` including `无法解析 Issue 地址。`). No client-side empty-URL guard (unlike `createTask` `:1548`). Selecting an Issue cannot auto-import because there is no Issue select; the button is already “click to import” as #19 wants to keep.

**发布** (`createTask` `:1542-1641`): requires title, `taskRepo` trim, imported ⇒ issueUrl, profile ⇒ numeric profile id, inline ⇒ token. Body as `App.form.test.ts:330-350`. 422 `token_check_failed` → `taskCredentialFeedback`; 500 `vault_unconfigured` → 「凭证保险库未配置」.

**Tests (publish/import/shell):**

| file | how they mount / mock |
|---|---|
| `App.form.test.ts` | `mount(App, { global: { plugins: [naive] } })`; `installFetch` Map `METHOD url` (`:128-155`); default routes GET `/api/v1/me`, `/agent-keys`, `/credential-profiles` `{ profiles: PROFILES }`, `/tasks`, POST `/tasks` 201. `setSelect` via Naive `NSelect`. Pins imported POST body, import POST body, `claim_only` hides form. |
| `App.shell.test.ts` | Same mount+fetch pattern (comment `:9-11`). 11 `it(` in architecture.md; pins nav 发布 hidden for `claim_only`; five `task-group-*`; profile **create** fields on 钥匙 pane (`Credential profile prefills` `:407`). |
| `App.board.test.ts` | Board 「导入内容」 / issue_url link (not publish flow). |
| `App.settings.test.ts` / `App.audit.test.ts` | 钥匙 settings / 审计; not import. |

Vitest: `apps/web/package.json` `"test": "vitest run"`; `vite.config.ts` `include: ['src/**/*.test.ts']`, `environment: 'happy-dom'`.

### 5. Token reveal invariant

HTTP (or MCP-over-HTTP) paths that return a **forge** token plaintext:

| path | when | where |
|---|---|---|
| Bearer `POST /api/v1/tasks/:publicId/claim` | `201` | top-level `token` (`claim.ts:215-217`) |
| Bearer `POST /api/mcp` tool `claim_task` | success `ok` | `toToolResult` JSON-stringifies `claimTask` body including `token` (`mcp.ts:42-48, 120`) |

These two are documented as the only forge-token reveal channels (`docs/api.md:7`). Claim `202` `{ error:'confirmation_required', pending:true }` has **no** token (`claim.ts:125, 133`).

Confirmed **never** a forge token:

| path | evidence |
|---|---|
| `GET /api/v1/credential-profiles` | `publicProfile`; `vault.test.ts` `assertNoSecrets` |
| `POST /api/v1/credential-profiles` `201` | same |
| `DELETE …/:id` `200` | `{ ok, message }` revoke copy only |
| `POST /api/v1/tasks/import` `200` | `assertNoTokenMaterial`; `assertImportDraft` keys |
| `POST /api/v1/tasks` `201` | Task Brief `credential` is `{ profile_id }` or `{ inline:true }` (`tasks.ts:404-407`) |
| `GET /api/v1/tasks` and `GET …/:publicId` | same brief |
| `GET /api/v1/events` | `details` JSON-parsed; import's `token 揭示` details are `{ profile_id, forge, base_url, full_name, outcome }` (`tasks.ts:166-187`) — no token. `events.ts:48-57` maps those rows through. |
| `GET /api/v1/stats` | counts only |
| `POST /api/v1/webhooks/:publicId` | 401/204; write-back decrypts on merge but never puts token on the 204 |
| poller / `decryptTaskToken` | not HTTP |

**Not a forge token (do not confuse):** `POST /api/v1/agent-keys` `201` returns an **Agent API key** once (`App.vue` `newKeyToken`). Different secret class.

**Events import writes:**

| condition | `events.type` | `details.outcome` |
|---|---|---|
| import profile path after decrypt (success) | `token 揭示` | `ok` |
| import profile, forge 404/410 | `token 揭示` | `issue_not_found` |
| import profile, forge 401 | `token 揭示` | `token_check_failed` |
| import profile, other fail | `token 揭示` | `forge_unreachable` |
| import inline | none | — |
| import bind mismatch / unparseable (before decrypt) | none | — |
| successful POST /tasks profile | `token 揭示` | `ok` (no `issue_not_found` on this path) |
| profile CRUD | `变更` | n/a |

`LIVE_EVENT_TYPES` in the web (`App.vue:713`): `token 揭示`, `状态迁移`, `心跳`, `变更`, `回写`, `认领待确认`, `认领已确认`. Issue #19: new GET must **not** add a `token 揭示` row.

### 6. Gaps vs #19

| Claim in issue #19 | Measured now |
|---|---|
| DESIGN §7 §8 first: dropdown = profile row as repo; `listIssues`; GET issues | DESIGN §7 is “发布时下拉选择”档案 (token reuse). §8 has `importIssue` only. No `listIssues` / `ListedIssue` / GET issues in DESIGN. |
| `listIssues(cred, RepoRef): Promise<ListedIssue[]>` with `ListedIssue = { number, title, issue_url }` | Missing from interface and types. |
| Open only; max 50; newest first if sortable | No list fetch exists. |
| GitHub drop items with `pull_request` | No list fetch exists. |
| `issue_url` **constructed** from `repo.base_url` so `parseIssueUrl` accepts it; GitLab `{base}/{namespace}/-/issues/{iid}`; **forbid** returning GitLab `web_url` | `importIssue` returns the **pasted** URL, never constructs, never reads `web_url`. No list builder. `parseIssueUrl` already rejects `/-/work_items/`. |
| Host rule = `importIssue` / `getPullRequest` (GitHub `api.github.com`; GL/Gitea constructor `baseUrl`; never Issue/`web_url` host) | Pattern exists on `importIssue`. `listIssues` not implemented. |
| Throw on non-OK / network; HTTP maps | Pattern exists (`importForgeFailure`). Need a **list** mapper (no 404→`issue_not_found`; 502 列出 copy). |
| `GET /api/v1/credential-profiles/:id/issues` session `active`+`full`; 200 `{ issues:[{ number, title, issue_url }] }`; 404 not_found; 500 vault_unconfigured; 422 same as import 401 copy; 502 列出; no token in response/log/`events.details`; **不写** `token 揭示` | Route absent. Closest: GET profiles (no decrypt) and POST import (decrypt + **does** write `token 揭示`). |
| Publish imported+profile: select profile → select Issue → 导入 preview → 发布; do not hand-fill forge/base_url/repo; do not paste URL | Form still has those four inputs. Profile select does not fill repo. No Issue select. Import still POSTs pasted `issue_url`. |
| No profiles: empty repo dropdown; hint 钥匙; no list request | No repo-from-profile dropdown. Empty state only on 钥匙 pane. No list request (vacuously). |
| Native tasks: repo still from profile dropdown; title/body hand-filled | Native still hand-fills `task-forge` / `task-base-url` / `task-repo`. |
| Inline token fallback: still paste Issue URL + hand-fill repo | **Present** (`credentialModeOptions` + `task-issue-url` + repo fields). Keep. |
| POST `/import` and POST `/tasks` bodies unchanged | Already true on the server. UI currently fills them from hand-typed fields; after #19 it should fill the **same** keys from dropdowns. |
| Not a third reveal channel | Holds for existing GET profiles / import 200 / events. New GET must keep it. |
| Shared spec, three forges, recorded/stub responses | No `list-issues.shared.test.ts`. Must append to root `"test"`. |

### 7. Reuse map

| Need | Reuse (do not reinvent) | Do not copy blindly |
|---|---|---|
| Adapter host / auth | `prApiOrigin`, `forgeGet`, `authHeaders`, `splitFullName`, `asObject` in `index.ts` | `validateToken`'s `apiUrl` fallback `options?.baseUrl ?? repo.base_url` |
| Issue URL legality | `parseIssueUrl` to **verify** constructed URLs | Using GitLab JSON `web_url` as `issue_url` |
| Construct GitLab URL | New builder: `{baseUrl}/{namespace}/-/issues/{iid}` (canonical regex already in `parseGitlabIssueUrl`) | `importIssue`'s “return pasted URL” |
| Throw shape for HTTP mapping | `Error(\`${method}: ${kind} responded ${status}\`)` so `forgeResponseStatus` (`tasks.ts:248-253`) works | `importForgeFailure` 404/410 → `issue_not_found` |
| 401 → 422 | `IMPORT_TOKEN_INVALID_MESSAGE` + `{ error:'token_check_failed', missing:['读'] }` | Publish's `TOKEN_INVALID_MESSAGE` (「无权访问该仓库，任务未发布」) |
| 502 | New parallel const 「无法连接 forge 列出 Issue。」 | `IMPORT_FORGE_UNREACHABLE_MESSAGE` 「导入 Issue」 |
| Session gate | `canManageProfiles` (`credential-profiles.ts:15-17`) + `getSessionUser` + `sendUnauthorized` | `requireActiveSessionUser` (allows `claim_only`); `canReadEvents` |
| Id parse / 404 | `parsePositiveInt` + `404 { error:'not_found' }` (DELETE `:159-171`) | inventing a 400 for bad id |
| Decrypt / 500 | `decryptToken` + `isVaultUnconfiguredError` → `500 { error:'vault_unconfigured' }` (import `:695-701`) | `decryptTaskToken` (swallows) |
| Load profile row | `db.select().from(credentialProfiles).where(eq(..., id)).get()` as in DELETE and import | |
| Adapter call | `createForgeAdapter(profile.forge, { baseUrl: profile.baseUrl }).listIssues({ token }, { full_name: profile.repoFullName, base_url: profile.baseUrl })` — same construction as import `:707` | Passing pasted host |
| Public JSON | Keep `publicProfile` for GET list; new handler returns `{ issues: [...] }` only | Putting `token_encrypted` anywhere |
| Audit | **Skip** `insertTokenRevealEvent` on the new GET | Copying import's `token 揭示` |
| Fill POST import | Existing `importTask` body keys (`issue_url`, `repo.forge`, `repo.base_url`, `credential.profile_id`) | Changing `readImportBody` |
| Fill POST tasks | Existing `createTask` body; set `repo.*` from profile row + `source.issue_url` from listed `issue_url` | Changing `readCreateBody` |
| UI profile list | `loadProfiles` + `profiles` ref (`App.vue:1442-1450`) already loaded for `canApprove` | Extra GET profiles on each Issue open (form test pins a **single** GET `:472-486`) |
| Shared spec | Copy `import-issue.shared.test.ts` KINDS/`installFetch`/`createAdapter`; append path to root `package.json` `"test"` after `import-issue.shared.test.ts` | Importing that file; relying on package `"test"` (none) |
| HTTP tests | Copy `import.test.ts` / `vault.test.ts` inject + OAuth login + `assertNoSecrets` | |
| Web tests | `App.form.test.ts` `installFetch` + `mountApp`; extend rather than a new App file unless needed | Weakening paste-URL / inline fallback cases |

### 8. Open questions / ambiguities (would change DESIGN)

1. **502 Chinese copy.** Issue body: import's 「无法连接 forge 导入 Issue。」 is “不合适的话用并列文案「无法连接 forge 列出 Issue。」——选定后写进 `docs/api.md`”. Measurement: there is **no** shared message helper; publish / import already use different sentences (`tasks.ts:19` vs `:27`). **Recommend the 列出 parallel** in DESIGN §8 / api.md. Do not require list GET to reuse import's 导入 string.

2. **422 copy vs listing.** Issue pins import's 「token 无效或无权读取该 Issue。」 for forge 401. That sentence names a single Issue. Reuse anyway (issue: 与 import 同源文案). DESIGN should quote the exact string so tests copy it.

3. **Repo dropdown label.** Issue: `{forge} {repo_full_name}`. Current profile option: `#${id} ${forge} ${repo_full_name}（${base_url}）`. DESIGN §7 should pick one; changing the label is a UI contract, not HTTP.

4. **`listIssues` sort key.** Issue: “有排序则最新优先”. GitHub/Gitea/GitLab list endpoints differ; DESIGN should say “pass the vendor's created/updated desc query if one exists; otherwise keep response order” rather than inventing a client-side sort that tests cannot pin without fixtures.

5. **GitHub `pull_request` filter.** Issue requires dropping items with a `pull_request` key. DESIGN §8 should state that; no current code does it.

6. **`RepoRef.base_url` vs constructor `baseUrl`.** `listIssues(cred, repo)` receives `RepoRef`. HTTP will also pass `{ baseUrl: profile.baseUrl }` into `createForgeAdapter`. DESIGN should say list fetch origin follows `importIssue` (`prApiOrigin` / constructor), using `repo.full_name` for the path, **not** `validateToken`'s `repo.base_url` fallback. (Publish always sets them equal; still write the host rule explicitly.)

7. **Native + profile.** Issue: 平台自有 still takes `repo.*` from the profile dropdown; title/body hand-filled. Current native form still shows forge/base_url/repo inputs. DESIGN §7 should say those three are hidden/disabled when mode is 共享档案.

8. **Empty profiles + imported.** Issue: 不发 Issue 列表请求. Vacuous today. DESIGN should say: no profile selected ⇒ no GET `.../issues`.

9. **Whether GET issues 404 on unknown id matches DELETE.** Issue says 缺行或非正整数 id → `404 { error:'not_found' }`. Matches DELETE. Confirmed. No ambiguity.

10. **Import still writes `token 揭示`; list must not.** DESIGN/api.md should contrast the two so implementers do not “reuse import's event writer”.

---

## What DESIGN §7 §8 must add

Grounded in the **current** headings (do not add a new top-level section):

**§7 凭证与安全模型** (extend the 凭证档案 bullet and the 认领时揭示 bullet; Brief stays in §6):

- After a profile exists, 发布页的仓库选择 **就是** 档案下拉：选中行带出该行的 `forge` / `base_url` / `repo_full_name`，不再手填这三项（平台自有与 imported 都如此）。
- 来源 = 从 Issue 导入 + 凭证 = 共享档案时：再加载该仓库 **open** Issue 下拉；点「导入」仍走现有 `POST /api/v1/tasks/import` 预览（不落库、不 `validateToken`）；点「发布」仍走现有 `POST /api/v1/tasks`。选 Issue 不自动导入。
- 无档案：仓库下拉为空，提示去钥匙页添加；不请求 Issue 列表。
- 回退「单任务临时 token」：仍可贴 Issue URL + 手填仓库（没有档案可列 Issue）。
- `GET /api/v1/credential-profiles/:id/issues` 是服务端解密后列 Issue，**不是** 第三条 token 揭示通道：响应 / 日志 / `events.details` 不得出现 token / ciphertext / `access_token`；**不写** `token 揭示`（对比：现有 import 档案路径仍写 `token 揭示`）。
- POST `/import` 与 POST `/tasks` 请求体契约不变；UI 只负责把档案和下拉选中的 `issue_url` 填进现有字段。

**§8 ForgeAdapter 层** (add under `// 发布/导入时`, next to `importIssue`; keep existing methods):

- `listIssues(cred: Credential, repo: RepoRef): Promise<ListedIssue[]>`
- `ListedIssue = { number: number; title: string; issue_url: string }`
- 只列 open；最多 50；有排序则最新优先。
- GitHub issues API 夹带 PR：丢掉带 `pull_request` 的项。
- `issue_url` **由适配层按 `repo.base_url` 拼出**，必须能被现有 `parseIssueUrl` 解析：GitHub/Gitea `{base_url}/{full_name}/issues/{number}`；GitLab `{base_url}/{namespace}/-/issues/{iid}`（用 `iid`）。**禁止**原样返回 GitLab `web_url`。
- 拉列表的 HTTP 源遵循 `importIssue` / `getPullRequest`：GitHub → `api.github.com`；GitLab / Gitea → 构造函数 `baseUrl`。禁止拿 Issue/`web_url` 的 host 当 fetch origin。
- 非 OK / 网络失败：像 `importIssue` 一样 throw（建议 `listIssues: ${kind} responded ${status}`），由 HTTP 层映射。
- HTTP 映射（写进 §8 或指向 api.md，三端一致）：会话门闩与档案 CRUD 相同；`404 { error:'not_found' }`；`500 { error:'vault_unconfigured' }`；forge 401 → `422 { error:'token_check_failed', missing:['读'], message:'token 无效或无权读取该 Issue。' }`；其它非 OK / 网络 → `502 { error:'forge_unreachable', message:'无法连接 forge 列出 Issue。' }`（并列于 import 的「导入 Issue」，不要共用那一句）。
- 三份实现行为相同，共享一套 spec（同一组行为断言跑三个后端）— 沿用 §8 现有要点，把 `listIssues` 算进那套规格。

Do **not** change §6 Task Brief, MCP §9, or 认领揭示. `registerWebhook?` optional-in-doc vs required-in-TS is pre-existing; out of #19.

---

## Exploration / Entry Points / Execution Flow / Architecture Insights / Key Files / Dependencies / Recommendations

(Those headings are the sections above. Measurement citations are in **Measurement memo** and **Gaps vs #19**.)
