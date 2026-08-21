# Ground truth — GitHub issue #12 (M2 Issue import + source labeling)

Measured worktree (not main, not archive notes): `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12`  
Branch: `workflow/issue-12`  
HEAD: `0e8bc4a` (`0e8bc4ac980d71a874ce7de38297a5de37bd768a`)  
`git status --short --branch`: `## workflow/issue-12` (clean)  
Tip: `0e8bc4a chore: archive issue-11 [sink]`  
Measured: 2026-08-21. Explorer did not edit the worktree.

Issue #12 (`https://github.com/KaolaBrother/KaolaTasks/issues/12`, labels `P2` `M2` `workflow:in-progress`, state open). Comments do **not** override the body: the only comment is workflow bookkeeping (`Kaola-Workflow started local work for issue-12`). Body stands:

> **目标**：三个 forge 的 `importIssue`：从 Issue URL 导入为任务卡草稿（标题/正文/源链接映射），带"导入内容"来源标记，进入发布表单补全后走发布即校验。
>
> **验收标准**
> - 三个 forge 的 Issue 均可导入（真实或录制响应）
> - 导入任务的 source 字段与源链接正确
> - UI 上导入正文有来源标记（提示注入防线之一）
>
> **设计参考**：docs/DESIGN.md §6 §7 §8

Out of this issue (do not implement here): webhook (`registerWebhook` / `parseWebhook`, #13); status write-back `commentOnIssue` (#14).

---

## Exploration

Issue #12 must wrap a tree that already has: three-forge `createForgeAdapter`; live `validateToken` and `getPullRequest`; a Task Brief whose `source` is already a native/imported discriminated union; session `POST /api/v1/tasks` that **stores** a client-supplied `source.type=imported` + `issue_url` and then runs **发布即校验** via `validateToken` (never `importIssue`); a Chinese publish form whose "从 Issue 导入" option only toggles an Issue URL field; a board that can render an imported `issue_url` as `a[href]` but does **not** mark imported body text.

What is **missing** for #12 (measured, not inferred from archives):

| Claim | Measured now |
|---|---|
| `ForgeAdapter.importIssue` | Wired to `notImplemented`; throws `Error('not implemented')` |
| Type `ImportedIssue` | `export type ImportedIssue = unknown` |
| HTTP import / draft endpoint | None. `app.ts` registrars: Auth, AgentKeys, CredentialProfiles, Tasks, Claim, Mcp. No `registerImport`. MCP tools: six names, no import. |
| Persist a 草稿 status | No. `taskStatusSchema` / `tasks.status` enum is the six Chinese labels only. POST inserts `status: '待认领'`. |
| Call `importIssue` on publish | POST calls only `adapter.validateToken`. Title/body/`issue_url` are client-asserted. |
| UI 来源标记 / 「导入内容」 | Zero matches under `apps/web`. Description is unlabeled `{{ selectedTask.description_md }}`. |
| Issue-URL parsers / Issue GET paths | None in `packages/forge-adapters`. Only **PR/MR** parsers exist (`parseGithubPrUrl` / `parseGiteaPrUrl` / `parseGitlabMrUrl`). |

The reusable pattern is `getPullRequest` (issue #11, already landed on this SHA): parse a pasted **web** URL, ignore GitHub `baseUrl`, use constructor `baseUrl` (never the pasted host) for GitLab/Gitea, GET via `forgeGet` + `authHeaders`, reject unparseable URLs without `fetch`. Shared-spec shape is `validate-token.shared.test.ts` / `get-pull-request.shared.test.ts` (`KINDS` loop + `t.mock.method(globalThis, 'fetch', …)`). A new spec file is **not** auto-discovered: root `package.json` `"test"` lists files by path.

---

## Entry Points

| Surface | Path | What it does today vs #12 |
|---|---|---|
| Adapter factory | `packages/forge-adapters/src/index.ts:45-61` `createForgeAdapter(kind, options?)` | Returns `ForgeAdapter`. `importIssue` is `notImplemented`. `validateToken` and `getPullRequest` are real. |
| Adapter method (missing) | `ForgeAdapter.importIssue(cred, issueUrl)` at `:29` | Signature exists; implementation throws. |
| Publish HTTP | `apps/server/src/tasks.ts:419-558` `POST /api/v1/tasks` | Session, `active`+`full`, parse snake_case, decrypt/encrypt, `validateToken`, insert `待认领`. Stores client `source`. Does **not** fetch the Issue. |
| List/get brief | `tasks.ts:399-417` + `taskBrief` `:298-335` | Projects `source_type`/`source_issue_url` → `{ type:'imported', issue_url }` or `{ type:'native' }`. Never a token. |
| Publish form | `apps/web/src/App.vue:170-290` + `createTask` `:745-834` | Selector 「从 Issue 导入」. User types title/description/`issue_url`. Single `POST /api/v1/tasks`. No forge fetch. |
| Board detail | `App.vue:90-113` | Imported `issue_url` may become `<a href>` if `http:`/`https:`. Description is escaped text with **no** 来源标记. |
| Poller (pattern only) | `apps/server/src/poller.ts:48-56` | Decrypt + `createForgeAdapter(repoForge, { baseUrl: repoBaseUrl }).getPullRequest`. Analog for how the **server** would call a live adapter method. Not an import path. |
| MCP | `apps/server/src/mcp.ts:91-159` | Six tools. No import tool. |
| Shared schema | `packages/shared/src/index.ts:18-30` `taskBriefSchema.source` | Already accepts imported + `issue_url`. |

`buildApp` registrar order (`apps/server/src/app.ts:76-81`):

```
registerAuth → registerAgentKeys → registerCredentialProfiles → registerTasks → registerClaim → registerMcp
```

HTTP verbs registered in those modules (complete list of `app.get`/`post`/`patch`/`delete` plus claim/mcp child `.post`):

- `app.ts`: `GET /` (placeholder or SPA)
- `auth.ts`: `GET /login`, OAuth callbacks, `GET /api/v1/me`, `POST /api/v1/users/:id/approve`
- `agent-keys.ts`: `POST/GET /api/v1/agent-keys`, `DELETE /api/v1/agent-keys/:id`, Bearer `GET /api/v1/agent/whoami`
- `credential-profiles.ts`: `GET/POST /api/v1/credential-profiles`, `DELETE /api/v1/credential-profiles/:id`
- `tasks.ts`: `GET/POST /api/v1/tasks`, `GET/PATCH /api/v1/tasks/:publicId`
- `claim.ts`: Bearer `POST /api/v1/tasks/:publicId/claim|progress|release`
- `mcp.ts`: Bearer `POST /api/mcp` (GET/DELETE 405)

**There is no import HTTP endpoint.** `docs/api.md:7` also records: "There is still no webhook route." It does not mention an import route because none exists.

---

## Execution Flow

### A. What exists: publish with `source.type=imported` (no forge Issue fetch)

```
browser createTask()
  → POST /api/v1/tasks  { title, description_md, source:{type:'imported', issue_url}, repo, credential, … }
  → getSessionUser  (401 unauthorized JSON / 302 /login)
  → canPostTasks: status==='active' && permissionLevel==='full'  else 403 { error:'forbidden' }
  → readCreateBody / readSource
  → isHttpOrHttpsUrlWithHost(repo.base_url)  else 400 invalid_body (Chinese message)
  → profile: load row, bind forge/base_url/full_name ===, decryptToken
    inline: encryptToken(request token)
    vault miss → 500 { error:'vault_unconfigured' }
  → createForgeAdapter(repo.forge, { baseUrl: repo.base_url }).validateToken({ token }, { full_name, base_url })
       throw → 502 { error:'forge_unreachable', message:'无法连接 forge 校验 token，任务未发布。' }
       missing.length>0 → 422 { error:'token_check_failed', missing, message }
  → insertTask status '待认领', sourceType, sourceIssueUrl (imported only)
  → 201 taskBrief  (source projected; no token)
```

`importIssue` is **not** on this path. A failing token check is never persisted (`tasks.ts:480` comment + `docs/api.md:122`).

### B. What #12 asks for (not implemented): Issue URL → draft → complete form → existing 发布即校验

```
[missing] importIssue(cred, issueUrl)
  → [missing] ImportedIssue  (title / body / source link — DESIGN does not type the payload)
  → [missing] task-card 草稿 in the publish form (not a persisted status)
  → user completes acceptance_criteria / repo / credential / …
  → existing POST /api/v1/tasks  (发布即校验 via validateToken — already live)
```

DESIGN §5 (`docs/DESIGN.md:82,97`): 发布/**导入** both go to 待认领 only after token check. There is no 草稿 in the state machine. "草稿" in the issue body is a **pre-publish form fill**, not a seventh status.

### C. Adapter `getPullRequest` (the pattern `importIssue` should reuse)

```
getPullRequest(kind, options, cred, prUrl)
  → prApiUrl(kind, options, prUrl)     // parse web URL; throw if unparseable (no fetch)
  → forgeGet(kind, url, cred.token)    // GET + authHeaders
  → if !res.ok throw Error(`getPullRequest: ${kind} responded ${status}`)
  → derivePrState
```

Host rule (`index.ts:96-99,140-143`): GitHub API origin is always `https://api.github.com`. GitLab/Gitea use constructor `options.baseUrl`, **never** the pasted URL's host. `validateToken`'s `apiUrl` is different: GitLab/Gitea origin is `options?.baseUrl ?? repo.base_url` (`index.ts:220`).

### D. `validateToken` fetch + auth (reuse `forgeGet` / `authHeaders`)

```
validateToken
  → GET userPath `/user`
  → 401 → { missing: ['读','推','PR'] }
  → GET repoPath
  → non-200 → all missing
  → kind-specific capability parse
```

Headers (`index.ts:224-236`):

| kind | headers |
|---|---|
| github | `Authorization: Bearer ${token}`, `User-Agent: KaolaTasks`, `Accept: application/vnd.github+json` |
| gitlab | `PRIVATE-TOKEN: ${token}` |
| gitea | `Authorization: token ${token}` |

`forgeGet` (`index.ts:238-243`): `globalThis.fetch(url, { method:'GET', headers: authHeaders(kind, token) })`. No timeout, no `AbortSignal` (repo-wide grep of `AbortSignal`/`timeout` under `apps/server` is empty). Network failure **rejects**; publish maps that to 502.

---

## Architecture Insights

1. **Import is a new adapter method + a pre-publish UI/HTTP seam, not a new task status.** Shared schema, `tasks.source_type` / `source_issue_url`, POST parse/store/project, and 发布即校验 already exist. #12 fills `importIssue` and the "paste Issue URL → fill title/body/source link → user completes form → existing POST" loop. Persist still happens only on POST → `待认领`.

2. **`source` today is client-asserted.** `readSource` copies `issue_url` from the JSON body. `taskBrief` copies columns back. Tests pin that round-trip (`tasks.test.ts:968-985`). They do **not** pin that `issue_url` was fetched from a forge or that title/body came from an Issue. After #12, "source 字段与源链接正确" means the imported draft (and the later published brief) carry the **forge** URL, not a user-typed mismatch — that is new behavior.

3. **`ImportedIssue` is unspecified in DESIGN and `unknown` in code.** DESIGN §8 only prints `Promise<ImportedIssue>`. DESIGN §6's imported source is `{ type:"imported", issue_url }`. Mapping Issue JSON → draft title/body/link is the issue body's "标题/正文/源链接映射". Typing `ImportedIssue` is in scope for #12; changing DESIGN.md contracts is not a side effect of scaffolding (project docs checklist).

4. **Host/SSRF rule to copy is `getPullRequest`, not `validateToken`.** Poller already does `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl }).getPullRequest({ token }, prUrl)` (`poller.ts:52-53`). GitLab/Gitea API origin is constructor `baseUrl`. Pasted Issue URL host must not become the fetch target. GitHub stays `api.github.com` (`GITHUB_API_ORIGIN` `:41`).

5. **`notImplemented` is synchronous.** `function notImplemented(): never { throw new Error('not implemented') }` (`index.ts:63-65`). `await adapter.importIssue(...)` throws rather than returning a rejected Promise. Same for `registerWebhook`, `parseWebhook`, `commentOnIssue`.

6. **Shared specs are parameterized copies, not a shared helper module.** `get-pull-request.shared.test.ts:5-8` says do not import `validate-token.shared.test.ts`; helpers are copied and trimmed. A third spec (`importIssue`) should copy that shape and be **appended** to root `"test"` or it will not run.

7. **DESIGN §8 `registerWebhook?` is optional in the doc, required on the TS interface.** `docs/DESIGN.md:180` vs `index.ts:31`. For #12 keep throwing `not implemented` — do not implement webhooks or `commentOnIssue`.

8. **Prompt-injection defense named by two strings.** DESIGN §7 `:166` and §14.3 `:270`: 「来源标记」. Issue body: 带**「导入内容」**来源标记. UI currently has neither. Board XSS tests pin escaped text + `javascript:` not becoming `href` (`App.board.test.ts:648-667`); that is XSS, not source labeling.

9. **Auth gate for any new session import HTTP, if added, already has a twin:** `canPostTasks` (`tasks.ts:82-84`) = `active`+`full`, same population as credential profiles and POST tasks. GET list is any logged-in user including `待批准`.

10. **Native vs imported parse mismatch (pre-existing).** HTTP `readSource`: `type==='native'` returns `{ type:'native' }` and **drops** extra `issue_url` (`tasks.ts:112`). Zod `parseTaskBrief` **rejects** native+`issue_url` (`packages/shared/src/index.test.ts:185-193`). `issue_url` is any non-empty string (not `isHttpOrHttpsUrlWithHost`); `repo.base_url` is the only URL with scheme/host check (`tasks.ts:430-435`). Whitespace-only `issue_url` is accepted (`!== ''` only).

---

## Key Files

| File | Role |
|---|---|
| `packages/forge-adapters/src/index.ts` | Interface, factory, `validateToken`, `getPullRequest`, stubs |
| `packages/forge-adapters/src/validate-token.shared.test.ts` | Shared spec pattern (KINDS × fetch stub) |
| `packages/forge-adapters/src/get-pull-request.shared.test.ts` | URL-parse + host-rule spec to mirror |
| `packages/forge-adapters/src/index.test.ts` | Health string only |
| `packages/shared/src/index.ts` | `taskBriefSchema.source` union |
| `packages/shared/src/index.test.ts` | DESIGN §6 example; imported without `issue_url` rejects |
| `apps/server/src/app.ts` | Registrar list — no import plugin |
| `apps/server/src/tasks.ts` | POST parse/store/validateToken/project |
| `apps/server/src/schema.ts` / `db.ts` | `source_type`, `source_issue_url` |
| `apps/server/src/poller.ts` | Server-side adapter call pattern |
| `apps/server/src/mcp.ts` | Six tools, no import |
| `apps/web/src/App.vue` | Form selector + board detail |
| `apps/web/src/App.form.test.ts` | Pins imported POST body; no forge fetch |
| `apps/web/src/App.board.test.ts` | Pins issue_url link / XSS; no 来源标记 |
| `docs/DESIGN.md` §6 §7 §8 §13 §14.3 | Contract |
| `docs/api.md` | Implemented vs DESIGN-only |
| `package.json` | Explicit test file list |

---

## Dependencies

- `@kaola/server` → `workspace:*` `@kaola/shared`, `@kaola/forge-adapters` (already).
- Adapter package has **no** runtime HTTP dependency (`docs/api.md:309`): global `fetch` only.
- Web: `vue` ^3.5.0, `naive-ui` ^2.45.0. No markdown/sanitizer package. Description is text interpolation, not `v-html`.
- Root test script (`package.json:13`) currently:

```
node --experimental-strip-types --test
  packages/shared/src/index.test.ts
  packages/forge-adapters/src/index.test.ts
  packages/forge-adapters/src/validate-token.shared.test.ts
  packages/forge-adapters/src/get-pull-request.shared.test.ts
  apps/server/src/placeholder.test.ts
  apps/server/src/auth.test.ts
  apps/server/src/agent-keys.test.ts
  apps/server/src/vault.test.ts
  apps/server/src/tasks.test.ts
  apps/server/src/hosting.test.ts
  apps/server/src/claim.test.ts
  apps/server/src/mcp.test.ts
  apps/server/src/poller.test.ts
&& pnpm --filter @kaola/web test
```

Web tests: `apps/web/package.json` `"test": "vitest run"`; include `src/**/*.test.ts` (`App.form.test.ts`, `App.board.test.ts`).

---

## Measurement memo (signatures, line citations)

### 1. `packages/forge-adapters`

**Health + kinds + credential** (`index.ts:1-24`):

```ts
export function getForgeAdaptersHealth(): string  // 'kaola-forge-adapters-ready'
export type ForgeKind = 'github' | 'gitlab' | 'gitea'
export type Credential = { token: string }
export type RepoRef = { full_name: string; base_url: string }
export type TokenCapability = '读' | '推' | 'PR'
export type TokenCheck = { missing: TokenCapability[] }
```

**Placeholder types** (`index.ts:20-24`):

```ts
/** Placeholder until later issues define DESIGN §8 payloads. */
export type ImportedIssue = unknown
export type PrStatus = { state: 'open' | 'merged' | 'closed' }
export type ForgeEvent = unknown
export type IssueRef = unknown
```

`ImportedIssue` is **unknown** (not a struct). `PrStatus` was filled by #11; `ForgeEvent` / `IssueRef` stay unknown (webhook / write-back — out of #12).

**Interface** (`index.ts:26-34`):

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

**Factory** (`index.ts:36-61`):

```ts
export type CreateForgeAdapterOptions = { baseUrl?: string }

export function createForgeAdapter(
  kind: ForgeKind,
  options?: CreateForgeAdapterOptions,
): ForgeAdapter
```

Unknown kind → `throw new Error(\`unknown forge kind: ${String(kind)}\`)` (`:49-51`). Wiring:

| method | binding |
|---|---|
| `kind` | constructor arg |
| `validateToken` | `(cred, repo) => validateToken(kind, options, cred, repo)` |
| `importIssue` | `notImplemented` |
| `getPullRequest` | `(cred, prUrl) => getPullRequest(kind, options, cred, prUrl)` |
| `registerWebhook` | `notImplemented` |
| `parseWebhook` | `notImplemented` |
| `commentOnIssue` | `notImplemented` |

```ts
function notImplemented(): never {
  throw new Error('not implemented')
}
```

`validateToken` is **not** a package-level named export. Package export `"."` → `./src/index.ts` (`packages/forge-adapters/package.json:6-8`).

**`getPullRequest` URL parse + API host** (reuse this):

- Strip (`index.ts:104-106`): trailing `/+`, then `\.(?:diff|patch)$`.
- GitHub web path (`:116-122`): `/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/` → `{ owner, repo, number }` → `https://api.github.com/repos/{owner}/{repo}/pulls/{number}` (`:150-156`). Unparseable → `Error(\`unparseable GitHub pull request URL: ${prUrl}\`)`.
- GitLab web path (`:132-138`): `/^\/(.+)\/-\/merge_requests\/(\d+)$/` → `{ namespace, iid }` → `{baseUrl}/api/v4/projects/{encodeURIComponent(namespace)}/merge_requests/{iid}` (`:157-162`). Multi-segment namespace is one encoded `:id`.
- Gitea web path (`:124-130`): `/^\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/` → `{ owner, repo, number }` → `{baseUrl}/api/v1/repos/{owner}/{repo}/pulls/{number}` (`:164-168`).
- `prApiOrigin` (`:140-143`): `kind==='github'` → `GITHUB_API_ORIGIN` (`https://api.github.com`); else `(options?.baseUrl ?? '').replace(/\/+$/u,'')` — **constructor option only**, not `prUrl` host.
- Non-OK HTTP (`:192-193`): `throw new Error(\`getPullRequest: ${kind} responded ${res.status}\`)` after `fetch`.
- Unparseable: throw in `prApiUrl` **before** `forgeGet`.

**There are no Issue URL regexes in this file.** GitHub `/issues/{n}`, Gitea `/issues/{n}`, GitLab `/-/issues/{n}` are **not** in source. Do not copy PR paths (`/pull`, `/pulls`, `/-/merge_requests/`) for Issues.

**`validateToken` fetch + headers** (`index.ts:67-94`, `210-243`):

- User GET: `apiUrl(..., userPath())` with `userPath() === '/user'`.
- Repo GET: GitLab `/projects/${encodeURIComponent(full_name)}`; GitHub/Gitea `/repos/${full_name}` (full_name **not** encoded for GH/Gitea).
- GitHub origin always `https://api.github.com` (`apiUrl` `:216-218`).
- GitLab/Gitea origin `options?.baseUrl ?? repo.base_url` (`:220`) — **this fallback is the validateToken SSRF residual**; `getPullRequest` does not use `repo.base_url` or the pasted host.

**Shared spec pattern**

`validate-token.shared.test.ts`:

- `KINDS = ['github','gitlab','gitea']` (`:12`).
- `createAdapter`: GitHub may omit `baseUrl`; GitLab/Gitea `createForgeAdapter(kind, { baseUrl: baseUrl ?? WEB_ORIGIN[kind] })` (`:49-56`).
- `installFetch` + `t.mock.method(globalThis, 'fetch', …)`.
- Per-kind cases: all-ok GET user+repo `missing []`; 404 → 读; 401 → 读+推+PR; no-push; no-PR; custom `baseUrl` (GitHub still `api.github.com`; GitLab `/gitlab/api/v4`, Gitea `/gitea/api/v1` keep subpath).
- Auth assertions (`:281-294`): Bearer / PRIVATE-TOKEN / `token ${token}`; GitHub requires non-empty User-Agent.
- GET-only, no `/forks`.

`get-pull-request.shared.test.ts` (mirrors the above, **does not import it**):

- Per-kind: GET exact API URL + auth; merged/closed/open; trailing slash stripped; non-OK rejects **after** fetch; unparseable rejects **without** extra fetch (`:241-258`).
- GitHub-only: `.diff`/`.patch` stripped (`:262-281`); custom `baseUrl` still `api.github.com` (`:283-291`).
- GitLab-only: `opened`→open; `locked`→open; subgroup namespace `encodeURIComponent` (`:293-321`).
- GitLab/Gitea: constructor `baseUrl` vs other-host `prUrl` (`:323-342`).

`index.test.ts`: only `getForgeAdaptersHealth() === 'kaola-forge-adapters-ready'`. No `importIssue` coverage.

### 2. `apps/server` task publish

**Auth gate** (`tasks.ts:81-84, 419-424`):

```ts
function canPostTasks(user: { status: string; permissionLevel: string }): boolean {
  return user.status === 'active' && user.permissionLevel === 'full'
}
```

POST: no session → `sendUnauthorized` (`auth.ts:62-66`): JSON `401 { error:'unauthorized' }` else `302 /login`. Not `active`+`full` → `403 { error:'forbidden' }` (no message). Tests: unauthenticated (`tasks.test.ts:585-603`); 待批准 GitHub (`:616-628`); approved `claim_only` (`:631-657`).

**`source.type=imported` parse** (`tasks.ts:42, 108-118`):

```ts
type SourceInput = { type: 'native' } | { type: 'imported'; issueUrl: string }

function readSource(value: unknown): SourceInput | undefined {
  if (value === undefined) return { type: 'native' }
  // …
  if (raw.type === 'native') return { type: 'native' }
  if (raw.type === 'imported') {
    if (typeof raw.issue_url !== 'string' || raw.issue_url === '') return undefined
    return { type: 'imported', issueUrl: raw.issue_url }
  }
  return undefined
}
```

Wire key is snake_case `issue_url`. Empty / missing / non-string / unknown `type` → `readCreateBody` undefined → `400 { error:'imported' wait: 'invalid_body' }` with **no** `message` (`:426-428`). Pinned: unknown type `'cloned'`, imported without `issue_url` (`tasks.test.ts:1040-1041, 1048-1056`). Default when `source` omitted: native (`readCreateBody` via `readSource(undefined)`); minimal-body test (`:987-1001`).

**Storage** (`tasks.ts:534-538`; columns `schema.ts:53-54`, DDL `db.ts:47-48`):

```ts
sourceType: input.source.type,                                    // 'native' | 'imported'
sourceIssueUrl: input.source.type === 'imported' ? input.source.issueUrl : null,
```

Drizzle: `sourceType: text('source_type', { enum: ['native','imported'] }).notNull()`, `sourceIssueUrl: text('source_issue_url')` (nullable). DDL: `source_type TEXT NOT NULL`, `source_issue_url TEXT`. No CHECK that imported ⇒ URL present (application-level only).

**Returned in the brief** (`tasks.ts:298-306`):

```ts
source:
  task.sourceType === 'imported'
    ? { type: 'imported', issue_url: task.sourceIssueUrl ?? '' }
    : { type: 'native' },
```

Round-trip test (`tasks.test.ts:968-985`): imported `issue_url` `https://gitea.internal.example/team/orders/issues/87` comes back equal; native `Object.keys(source) === ['type']`.

**Does publish call `importIssue` today?** No. After vault, only:

```ts
const adapter = createForgeAdapter(input.repo.forge, { baseUrl: input.repo.baseUrl })
check = await adapter.validateToken(
  { token: plaintext },
  { full_name: input.repo.fullName, base_url: input.repo.baseUrl },
)
```

(`tasks.ts:481-487`). Title/description come from `readCreateBody` (`:240-242, 269-271`): `description_md` default `''`. Client-supplied `id` / `pr_convention` / `poster` / `status` / `created_at` ignored (`:223-224`).

**Credential decrypt + `validateToken`**

- Profile (`:440-467`): load `credential_profiles` by id; missing → `400 invalid_body` + `所选凭证档案不存在。`; bind `repo.forge` / `repo.baseUrl` / `repo.fullName` with exact `===` **before** decrypt; mismatch → `400` + `所选凭证档案与仓库不匹配。`; then `plaintext = decryptToken(profile.tokenEncrypted)`.
- Inline (`:468-478`): `plaintext = input.credential.token`; `inlineTokenEncrypted = encryptToken(plaintext)`.
- Vault miss either path → `500 { error:'vault_unconfigured' }` (`tasks.test.ts:785-809`).
- `decryptToken` / `encryptToken` (`vault.ts:44-65`): AES-256-GCM, `VAULT_MASTER_KEY` 64 hex, not required at `buildApp()` boot.
- Request credential is `{ profile_id }` XOR `{ token }` (`tasks.ts:206-221`) — **not** the brief union `{ profile_id: string } | { inline: true }`. `{ inline: true }` with no token is 400 (`tasks.test.ts:1045`).

**Error shapes (400 / 422 / 502)** (`tasks.ts:18-22, 70-75, 426-520`):

| status | body | when |
|---|---|---|
| 400 | `{ error:'invalid_body' }` (no message) | generic parse fail, including imported without `issue_url` |
| 400 | `{ error:'invalid_body', message:'仓库地址不是合法的 http 或 https 地址。' }` | `repo.base_url` not http(s)+host |
| 400 | `{ error:'invalid_body', message:'所选凭证档案不存在。' }` | missing profile |
| 400 | `{ error:'invalid_body', message:'所选凭证档案与仓库不匹配。' }` | profile/repo bind fail |
| 401 | `{ error:'unauthorized' }` or 302 `/login` | no session |
| 403 | `{ error:'forbidden' }` | not `active`+`full` |
| 422 | `{ error:'token_check_failed', missing, message }` | `missing.length>0`; if includes `读`: `token 无效或无权访问该仓库，任务未发布。`; else `token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。` |
| 502 | `{ error:'forge_unreachable', message:'无法连接 forge 校验 token，任务未发布。' }` | `validateToken` throws |
| 500 | `{ error:'vault_unconfigured' }` | missing/invalid `VAULT_MASTER_KEY` |

Profile path writes `events.type` `token 揭示` with `outcome` `ok` | `token_check_failed` | `forge_unreachable` (`:159-181, 491-532`). Inline path does not.

Success: `201` Task Brief, `status: '待认领'`, no token (`:553-557`).

### 3. Import HTTP endpoint?

**No.** `register*` in `app.ts:76-81` listed above. Claim child (`claim.ts:362-381`): claim / progress / release only. MCP (`mcp.ts:91-159`): `list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `release_task`, `submit_pr`. Grep of `importIssue` under `apps/` is empty. Grep of `/import` as a route: none.

`docs/architecture.md:20-28` lists the same HTTP tree; poller is "not a route". `docs/api.md:7`: "There is still no webhook route." No import section exists because nothing is implemented.

### 4. `@kaola/shared` `taskBriefSchema.source`

`packages/shared/src/index.ts:18-30`:

```ts
export const taskBriefSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  description_md: z.string(),
  source: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('native') }),
    z.strictObject({
      type: z.literal('imported'),
      issue_url: z.string(),
    }),
  ]),
  // … repo, acceptance_criteria, credential union, status, created_at …
})
```

Discriminator is `"type"` on the source object. Native is type-only (extra `issue_url` throws). Imported requires `issue_url: z.string()` (empty string would parse; HTTP rejects `''` before persist). `issue_url` is **not** `z.url()`. Credential remains `{ profile_id: string } | { inline: true }` — never a token (`:48-53`).

Pins (`index.test.ts:56-64, 110-115, 178-193`): DESIGN §6 example (imported Gitea URL) parses; native with no `issue_url` parses; imported without `issue_url` throws; native with `issue_url` throws.

No 草稿 / DRAFT in `taskStatusSchema` (`:7-14`): `待认领 | 进行中 | 待验收 | 已完成 | 已退回 | 已取消`.

### 5. Web publish form and board

**Selector** (`App.vue:183-192, 403-406`):

```ts
const sourceTypeOptions = [
  { label: '平台自有', value: 'native' },
  { label: '从 Issue 导入', value: 'imported' },
]
```

`taskSourceType` default `'native'` (`:368`). `v-if="taskSourceType === 'imported'"` shows `data-testid="task-issue-url"`. **No button, no `importIssue`, no extra fetch** besides `POST /api/v1/tasks`.

**How `issue_url` is sent** (`createTask` `:745-806`):

- Guard: `if (taskSourceType.value === 'imported' && !issueUrl) return` (`:751`). Trimmed empty → no POST. Pinned `App.form.test.ts:523-528`.
- Body: `source: { type:'imported', issue_url: issueUrl }` or `{ type:'native' }` (`:773-776`). Native has **no** `issue_url` key. Pinned full snake_case body `App.form.test.ts:325-350` (imported Gitea URL `${FORGE_BASE_URL}/team/orders/issues/87`). Default native when not selected: `App.form.test.ts:376`.
- `description_md: taskDescription.value` — whatever the user typed; not filled from a forge.
- Form visible only `canApprove` = `active`+`full` (`App.vue:170, 433-435`). Pinned `App.form.test.ts:305-320`.

**Board / form labeling of imported description**

- Form: description is a generic textarea 「描述」 (`:175-181`). Switching to imported does **not** add 「导入内容」 or 来源标记.
- Detail (`:90-105`): `board-detail-description` is `{{ selectedTask.description_md }}` (escaped). `board-detail-issue-url` exists iff `source.type==='imported'` (`boardIssueUrl` `:500-502`). `http:`/`https:` (prefix check, not `URL` parse) → `<a :href>`; else text (`:99-105, 504-509`).
- Tests: native has no `board-detail-issue-url`; imported https is `a[href]` (`App.board.test.ts:617-627`, fixture `HTTPS_ISSUE_URL = 'https://github.com/org/app/issues/12'` `:21,129`); `javascript:alert(1)` is text (`:661-667`); description XSS is text not `script` (`:648-658`).
- Grep `来源标记|导入内容|提示注入` under `apps/web`: **zero hits**.

`loadTasks` (`:654-666`): `GET /api/v1/tasks` exactly, no query.

### 6. DESIGN §6 / §7 / §8 vs `docs/api.md`

**§6 Task Brief** (`DESIGN.md:101-140`): `source` native or imported; example is imported with `issue_url` Gitea `…/issues/87`. No `ImportedIssue` fields. No 草稿 status. Credential is a reference.

**§7** (`:154-166`): vault, reveal-on-claim, 认领即授权. Prompt-injection bullet `:166`:

> 任务描述是进入 Agent 上下文的非受信文本。即使是内部平台，导入的 Issue 正文也可能包含外部人写的内容，**UI 对导入内容打来源标记**，默认保留"人确认认领"这一道闸。

「人确认认领」is M3 / #16 (`:162`) — not #12. #12 owns the 来源标记 half.

**§8** (`:168-192`): interface including `importIssue(cred, issueUrl): Promise<ImportedIssue>` under comment `// 发布/导入时` next to `validateToken`. Points: three implementations, one shared integration-test spec; GitLab/Gitea constructor `baseUrl`; GitHub `api.github.com`. Webhook optional in the **doc** (`registerWebhook?`). Polling is already implemented (#11); webhook is #13.

**§13 M2** (`:263`): 「三 forge 的 Issue 导入、webhook 接入…、状态回写源 Issue 评论」— one milestone, three issues. #12 is **only** Issue import + source labeling.

**§14.3** (`:270`): 提示注入缓解 = 来源标记 + 人确认认领; 后续可加注入模式扫描 (not #12).

**§5** (`:82,97`): 发布/导入 both require 发布即校验 before 待认领. Import does not skip `validateToken`.

**`docs/api.md` (implemented vs DESIGN-only)**

- Header `:5`: "Product contracts that are not yet in source remain in DESIGN.md §6, §8, §9. This file records what is implemented."
- Tasks POST `:120-136`: documents `source.type imported` requires non-empty `issue_url`; 发布即校验 via `validateToken`; 400/422/502/500 as measured. **Does not mention `importIssue`.**
- Forge adapters `:307-342`: `ImportedIssue`, `ForgeEvent`, `IssueRef` are `unknown`; `PrStatus` is live. **Implemented: `kind` + `validateToken` + `getPullRequest`. Other interface methods throw `Error('not implemented')`.** `getPullRequest` URL/host/auth documented in full. No `importIssue` subsection.
- Shared `:344-360`: source discriminated union as in source. DESIGN §6 example still parses.
- Architecture.md `:37-38,69`: same — `validateToken` + `getPullRequest`; other §8 methods `not implemented`.

CHANGELOG Unreleased first bullet (`CHANGELOG.md:5`) matches #11 `getPullRequest`. A **stale later bullet** (`:22`) still says `PrStatus` is `unknown` and "other interface methods throw not implemented" — that line is historical #6 text, contradicted by `:5` and by source.

### 7. Root `package.json` test script

Quoted in Dependencies. Adapter shared specs are **explicit paths**, not a glob:

- `packages/forge-adapters/src/validate-token.shared.test.ts`
- `packages/forge-adapters/src/get-pull-request.shared.test.ts`

`pnpm --filter @kaola/forge-adapters test` does **not** exist (`package.json` of that package has only `typecheck`/`build`). A new `import-issue.shared.test.ts` (or similar) **must** be added to the root `"test"` array or CI will not run it. Same custody note as #7/#11: whoever authors the spec also updates that one script line; implementer does not.

### 8. Remaining adapter methods that must stay `notImplemented`

For issue #12, **keep throwing** (do not implement):

| method | why |
|---|---|
| `registerWebhook` | #13 |
| `parseWebhook` | #13 |
| `commentOnIssue` | #14 write-back |

**Already implemented — do not regress:**

| method | owner |
|---|---|
| `validateToken` | #6 / publish 发布即校验 |
| `getPullRequest` | #11 poller |

**This issue owns:** `importIssue` (and typing `ImportedIssue`).

`ForgeEvent` / `IssueRef` stay `unknown` until #13/#14.

---

## Gaps vs issue #12

| Acceptance | Gap |
|---|---|
| Three forges' Issues can be imported (real or recorded responses) | `importIssue === notImplemented`. No Issue GET URLs, no parsers, no shared spec, no recorded fixtures. `getPullRequest` proves the three-kind + fetch-stub harness works. |
| Imported task `source` + source link correct | Storage/projection of **client-supplied** `issue_url` already works. Nothing binds title/body/`issue_url` to a live Issue. Publish never calls `importIssue`. |
| UI marks imported body with 来源标记 (issue body quotes 「导入内容」) | Form and board render description as unlabeled text. Issue URL link ≠ source label on the body. |
| Flow: importIssue(URL) → task-card 草稿 (title/body/source link) → user completes publish form → existing 发布即校验 | Second half (form + POST + validateToken) exists. First half (fetch Issue → prefill draft) does not. No draft HTTP. No 草稿 status (and DESIGN does not add one). |
| DESIGN §6 §7 §8 | Schema §6 source union is already in `@kaola/shared`. §7 label and §8 `importIssue` are not implemented. Do not edit DESIGN.md as a scaffolding side effect. |

**Pre-existing seams #12 should not silently widen**

- `issue_url` is not http(s)+host validated (unlike `repo.base_url`).
- `validateToken` GitLab/Gitea still follow caller `repo.base_url` when constructor `baseUrl` is set (publish always passes both equal). `importIssue` should follow **`getPullRequest`'s constructor-`baseUrl` / GitHub-api.github.com rule**, not the pasted Issue host.
- `notImplemented` is sync throw.
- Tokens must not appear in list/get/import responses (claim 201 `token` and MCP `claim_task` remain the only reveal channels — `docs/api.md:7`).

---

## Recommendations

Scoped to wrapping #12. **Do not implement #13 webhooks or #14 write-back.**

1. **Adapter:** Implement `importIssue` next to `getPullRequest`: parse Issue **web** URLs (new regexes — not the PR ones), `forgeGet` + `authHeaders`, GitHub `api.github.com`, GitLab/Gitea constructor `baseUrl` never pasted host, unparseable → reject without fetch, non-OK → reject after fetch. Replace `export type ImportedIssue = unknown` with a real type that can map to draft **title / body / source link** (issue body). Leave `registerWebhook` / `parseWebhook` / `commentOnIssue` as `notImplemented`.

2. **Tests:** New shared spec copied from `get-pull-request.shared.test.ts` (do not import that file), `KINDS` × recorded JSON. Append the file path to root `package.json` `"test"` immediately after `get-pull-request.shared.test.ts`. Custody: tdd-guide owns tests; implementer does not.

3. **HTTP/UI:** Keep existing `POST /api/v1/tasks` as the 发布即校验 gate (`validateToken`, persist `待认领`). Add a **pre-publish** seam that calls `importIssue` and returns a draft the form can apply (title, description_md, `source: { type:'imported', issue_url }`). Do not add a 草稿 row to `taskStatusSchema`. Reuse `canPostTasks` if the seam is session HTTP. Credential for the GET is the same union the form already has (`profile_id` XOR `token`) — decrypt like publish; never return the token.

4. **Source labeling:** Mark imported **body text** in the form (after draft fill) and in board detail when `source.type==='imported'`. Issue body names the mark 「导入内容」; DESIGN names the mechanism 来源标记. Keep description as text interpolation (`v-html` still forbidden). The existing `issue_url` `<a href>` is the source **link**, not the injection label.

5. **Docs after implementation (not this explorer):** `docs/api.md` + `docs/architecture.md` + CHANGELOG + CLAUDE.md snapshot. Transcribe the real `ImportedIssue` signature. Do not change DESIGN.md contracts as scaffolding.

6. **Out of scope reminders:** no `registerWebhook` / `parseWebhook`; no `commentOnIssue`; no REST `submit_pr`; no DESIGN.md contract edits; no seventh task status.

---

## Exploration / Entry Points / Execution Flow / Architecture Insights / Key Files / Dependencies / Recommendations

(Those headings are the sections above. Measurement citations are in **Measurement memo** and **Gaps vs issue #12**.)
