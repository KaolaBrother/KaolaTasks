# Ground truth for issue #9 (lease-based claiming)

Measured against worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9` on branch `workflow/issue-9` (HEAD `1dae847 chore: archive bundle-8-17 [sink]`). Code wins where DESIGN.md / CLAUDE.md disagree. Facts that cannot be confirmed from this tree are labelled UNVERIFIED.

Issue #9 body: 租约式认领 — claim 建租约（默认 TTL 24h，可按任务配置）、report_progress 心跳续约、过期自动回待认领、release 主动释放；认领成功时揭示 token 并写审计.

Acceptance: (1) 过期未心跳的任务自动回到待认领 (2) list_tasks / get_task_brief 响应中永不含 token (3) 每次揭示均有审计记录. Design: docs/DESIGN.md §5 §7.

Winning comment: 认领即授权 — Agent API Key 即用户授权，claim 无需二次确认（自主轮询确认开关属 #16）. 待批准（claim_only 未批准）用户的 claim 必须被拒，且不揭示 token. claim 成功的返回中附带克隆指引（suggested_dir + token 使用方式）.

Out of scope: MCP server (#10), submit_pr / PR polling (#11). DESIGN §9 says REST mirrors MCP, so this issue is expected to add REST claim/heartbeat/release, not MCP tools.

## Exploration: Lease-based claiming (current tree)

### Entry Points

- `buildApp()` in `apps/server/src/app.ts:26`: constructs Fastify + SQLite, then `registerAuth` → `registerAgentKeys` → `registerCredentialProfiles` → `registerTasks`. No claim/heartbeat/release plugin exists.
- Session task HTTP in `registerTasks` (`apps/server/src/tasks.ts:396`): `GET/POST /api/v1/tasks`, `GET/PATCH /api/v1/tasks/:publicId`. Triggered by browser/session cookie. PATCH is poster cancel/reopen only.
- Bearer agent context in `registerAgentKeys` (`apps/server/src/agent-keys.ts:132`): encapsulated child plugin; only route is `GET /api/v1/agent/whoami`. Triggered by `Authorization: Bearer ktk_…`.
- Vault module export `revealCredentialProfile` (`apps/server/src/vault.ts:81`): not an HTTP handler. Tests call it directly. Production HTTP never calls it today.
- Process listen in `apps/server/src/index.ts:11`: `await app.listen({ port, host })`. Tests use `buildApp` + `app.inject` and **must not** import `index.ts` (hosting.test.ts comment).
- Web board in `apps/web/src/App.vue:654`: `GET /api/v1/tasks` with session cookies. No claim UI. Timeline is a single synthetic 发布 row.

There is no `claim_task` / `report_progress` / `release_task` string anywhere in `*.ts` / `*.vue` / `*.json` of this worktree (grep: zero hits). MCP SDK is not a server dependency.

### Execution Flow

1. Poster (session, `active`+`full`) `POST /api/v1/tasks` → parse snake_case body → (profile: bind forge/base_url/full_name then `decryptToken`; inline: `encryptToken`) → `createForgeAdapter(forge, { baseUrl }).validateToken({ token }, { full_name, base_url })` → persist `status: '待认领'` → `201` Task Brief with no token.
2. Anyone logged in (including `待批准`) `GET /api/v1/tasks` / `GET /api/v1/tasks/:publicId` → `taskBrief()` serialization. Credential on the wire is `{ profile_id: String(pk) }` or `{ inline: true }`.
3. Poster `PATCH /api/v1/tasks/:publicId` `{ status }` → `POSTER_TRANSITIONS` subset of `transitionTaskStatus` → write `events.type` `状态迁移`. `待认领 → 进行中` is **explicitly refused** here (`409 illegal_transition`); comment in source: claiming belongs to MCP (stale — this issue is REST).
4. Agent mints a key via session `POST /api/v1/agent-keys` (`201` `{ token: "ktk_…" }`) then calls Bearer `GET /api/v1/agent/whoami`. The Bearer `onRequest` hook hashes the presented key, looks up `agent_keys.key_hash`, loads `users`, ticks `last_used_at`, sets `request.agentAuth = { user, key }`. The hook does **not** check `user.status`.
5. Claim / heartbeat / expiry / release: **not implemented**. Shared state machine already allows `待认领 → 进行中` and `进行中 → 待认领`.

### Architecture Insights

- **Hand-parsed snake_case HTTP, no Zod at the Fastify boundary.** Same idiom in `auth.ts`, `agent-keys.ts`, `credential-profiles.ts`, `tasks.ts`. `@kaola/shared` `taskBriefSchema` is used to *validate the serialized brief* in tests (`parseTaskBrief(brief)`), not to parse request bodies.
- **Session vs Bearer are disjoint.** Session uses `getSessionUser` + `sendUnauthorized` (JSON `401 { error: 'unauthorized' }` or `302 /login`). Bearer uses a child-plugin `onRequest` + `WWW-Authenticate: Bearer`. A session cookie does not authorize whoami; a Bearer token does not authorize `/api/v1/me` or task GET/POST/PATCH.
- **Encapsulated Fastify plugin, not `fastify-plugin`.** `request.agentAuth` is a global TypeScript augmentation, but the hook only runs on routes registered *inside* `agentBearerContext`. Sibling plugins do not inherit the hook.
- **Two `token 揭示` writers with different `details` shapes.** Publish-time (session, profile decrypt for 发布即校验) vs `revealCredentialProfile` (agent-key-oriented). Inline publish writes no reveal event.
- **Integer PK + public_id.** Wire `id` is `kt-YYYY-NNNN`. Nested resource params that are integers use `parsePositiveInt` and 404 on junk (`agent-keys/:id`, `credential-profiles/:id`); approve uses `400 invalid_id`. Tasks use the raw `publicId` string.
- **DDL in `createDb`, no migrations.** New tables = DDL const + `sqlite.exec` + drizzle `sqliteTable` + schema map in `createDb`.
- **No job runner.** Expiry cannot "just happen" today; `buildApp` does not start timers; only `index.ts` listens.

### Key Files

| File | Role | Importance |
|------|------|------------|
| `apps/server/src/tasks.ts` | Session task CRUD + brief serialization + publish-time reveal | Load-bearing |
| `apps/server/src/tasks.test.ts` | HTTP contract + fetch seam + never-token + events | Load-bearing for the new claim suite |
| `apps/server/src/agent-keys.ts` | Session key CRUD + encapsulated Bearer plugin | Load-bearing |
| `apps/server/src/agent-keys.test.ts` | How to mint `ktk_` and call Bearer | Load-bearing |
| `apps/server/src/vault.ts` | encrypt/decrypt/reveal/insertAuditEvent | Load-bearing |
| `apps/server/src/schema.ts` / `db.ts` | Tables; no `leases` | Load-bearing |
| `packages/shared/src/index.ts` | Brief schema + `transitionTaskStatus` | Load-bearing |
| `packages/forge-adapters/src/index.ts` | `validateToken` for publish, not claim | Supporting |
| `apps/server/src/app.ts` | Plugin order | Supporting |
| `apps/server/src/index.ts` | Listen only; no cron | Supporting |
| `apps/web/src/App.vue` | Board; synthetic 发布; no events HTTP | Likely untouched by #9 |
| `docs/DESIGN.md` §5 §7 §9 §10 | Intended lease/MCP/REST contract | Design, not code |

### Dependencies

- External (server): `fastify`, `@fastify/cookie`, `@fastify/session`, `@fastify/oauth2`, `@fastify/static`, `@fastify/http-proxy`, `better-sqlite3`, `drizzle-orm`, `node:crypto`. No MCP SDK, no `@fastify/bearer-auth`, no cron library, no `fastify-plugin`.
- Internal: `@kaola/shared` (`taskStatusSchema`, `transitionTaskStatus`, `parseTaskBrief` in tests), `@kaola/forge-adapters` (`createForgeAdapter` / `validateToken` used at publish). Server already imports forge-adapters (CLAUDE.md snapshot in this worktree agrees; older CLAUDE text in the *main* checkout snapshot said it did not).
- Shared utilities to reuse: `insertAuditEvent`, `decryptToken`, `encryptToken`, `isVaultUnconfiguredError`, `transitionTaskStatus`, `taskBrief` / `selectTask`, `getSessionUser` / `sendUnauthorized`, Bearer hash+hook pattern, test helpers (`beginFetch`, `loginViaCallback`, `assertNoTokenMaterial`, `createApp` + `app.ready()`).

### Recommendations for New Development

- Follow the existing `registerX(app, db)` + hand-parsed snake_case + `{ error, message? }` error bodies + Chinese `message` strings.
- Reuse `transitionTaskStatus` for `待认领 ↔ 进行中`; do not open those edges on poster PATCH.
- Reuse the tasks.test.ts `beginFetch` router if the claim suite creates tasks via HTTP (the agent-keys userinfo-only stub will 500 forge `validateToken`).
- Avoid treating DESIGN §6 `credential.profile_id: "cp-gitea-orders"` as the wire form — code emits `String(integer PK)`.
- Avoid calling `parseTaskBrief` on the whole claim-success body: `taskBriefSchema` is `z.strictObject` and will reject extra keys (`token`, TTL, clone guidance).
- Avoid reusing `assertNoTokenMaterial` on a successful claim response: it forbids any JSON key named `token`.
- Avoid assuming `revealCredentialProfile` covers inline tokens or publish-shaped audit details.
- Avoid adding MCP tools or `submit_pr` in this issue.

---

## Facts

### 1. Task HTTP (`apps/server/src/tasks.ts` + `tasks.test.ts`)

#### Routes (all session cookie; `getSessionUser` + `sendUnauthorized`)

| Method | Path | Auth gate after session | Success | Errors |
|--------|------|-------------------------|---------|--------|
| GET | `/api/v1/tasks` | any logged-in user including `待批准` | `200` `{ tasks: Brief[] }` ordered by integer PK | unauth: `401 { error: 'unauthorized' }` if `Accept` contains `application/json`, else `302 /login` |
| GET | `/api/v1/tasks/:publicId` | same | `200` Brief | `404 { error: 'not_found' }` |
| POST | `/api/v1/tasks` | `status === 'active' && permission_level === 'full'` else `403 { error: 'forbidden' }` | `201` Brief, `status: '待认领'` | see below |
| PATCH | `/api/v1/tasks/:publicId` | `active`+`full`, then must be poster else `403 { error: 'forbidden' }` | `200` Brief | see below |

No claim / heartbeat / release route. No Bearer on these routes. `GET` takes no query string (`status`/`tags`/`forge` filters are client-side on the web).

#### Request JSON (POST create) — snake_case

Hand-parsed in `readCreateBody` (`tasks.ts:224`). Required: non-empty `title`; `repo.forge` ∈ `{github,gitlab,gitea}`; non-empty `repo.base_url`, `repo.full_name`; `credential` as `{ profile_id }` XOR `{ token }` (`profile_id` integer or numeric string; `token` non-empty string).

Defaults when omitted: `description_md` `''`; `source` `{ type: 'native' }`; `repo.base_branch` `'main'`; `repo.suggested_dir` last path segment of `full_name`; `acceptance_criteria` `[]`; `test_command` `''`; `constraints` `{ allowed_paths: [], forbidden_paths: [] }`; `priority` `'P2'`; `tags` `[]`.

`source.type === 'imported'` requires non-empty `issue_url`. Client-supplied `id` / `pr_convention` / `poster` / `status` / `created_at` are ignored.

Generic parse failure → `400 { error: 'invalid_body' }` with **no** `message`. Tests pin this for empty title, unknown forge, both credential forms, `{ inline: true }` without a token, etc.

Pinned Chinese 400s:

- `repo.base_url` not `http:`/`https:` with hostname → `400 { error: 'invalid_body', message: '仓库地址不是合法的 http 或 https 地址。' }` (`tasks.ts:18`, `427-431`)
- missing profile → `400 { error: 'invalid_body', message: '所选凭证档案不存在。' }` (`tasks.ts:19`, `443-444`)
- profile forge/base_url/full_name `!==` request repo → `400 { error: 'invalid_body', message: '所选凭证档案与仓库不匹配。' }` **before decrypt**, no `token 揭示` (`tasks.ts:20`, `446-454`)

Other POST errors:

- vault missing/invalid → `500 { error: 'vault_unconfigured' }`
- `validateToken` throws → `502 { error: 'forge_unreachable', message: '无法连接 forge 校验 token，任务未发布。' }`
- `check.missing.length > 0` → `422 { error: 'token_check_failed', missing, message }`
  - if `missing` includes `'读'`: `message` = `'token 无效或无权访问该仓库，任务未发布。'`
  - else: `'token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。'`
  - `missing` values are Chinese `'读' | '推' | 'PR'`

PATCH body: `{ status }` must parse `taskStatusSchema` else `400 { error: 'invalid_body' }`. Illegal (including legal-for-claim `待认领 → 进行中`) → `409 { error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「${to}」。' }`.

#### Brief serialization (`taskBrief`, `tasks.ts:297-334`)

Exact keys (tests `BRIEF_KEYS`, `tasks.test.ts:44-60`; `assertBriefShape` requires `Object.keys` equal this set **and** `parseTaskBrief`):

`id`, `title`, `description_md`, `source`, `repo`, `acceptance_criteria`, `test_command`, `constraints`, `pr_convention`, `credential`, `priority`, `tags`, `poster`, `status`, `created_at`.

Wire shapes:

- `id`: `task.publicId` (`kt-YYYY-NNNN`), **not** integer PK
- `source`: `{ type: 'native' }` or `{ type: 'imported', issue_url }`
- `repo`: `{ forge, base_url, full_name, base_branch, suggested_dir }`
- `pr_convention`: `{ branch_prefix: \`kaola/${publicId}-\`, title_prefix: \`[${publicId}] \` }`
- `credential`: `credentialProfileId == null` → `{ inline: true }`; else `{ profile_id: String(credentialProfileId) }`
- `poster`: `users.username` or `''`
- `created_at`: `new Date(task.createdAt * 1000).toISOString()` (house timestamps are unix seconds)

**Never-token invariant as tested today** (`assertNoTokenMaterial`, `tasks.test.ts:500-517`): serialized body must not contain the plaintext forge token, and no key at any depth may be in `SECRET_KEY_NAMES = {'token','token_encrypted','inline_token_encrypted','access_token'}`. Applied to POST 201, GET list, GET one. **A claim-success body that includes a `token` key would fail this helper.**

#### `transitionTaskStatus` over HTTP

`nextPosterStatus` (`tasks.ts:289-293`) first restricts to `POSTER_TRANSITIONS` (`tasks.ts:30-33`):

- `待认领` → `{ 已取消 }`
- `已退回` → `{ 已取消, 待认领 }`

then calls `transitionTaskStatus(from, to)`. Exercised over HTTP:

- `待认领 → 已取消` (200)
- `已退回 → 待认领` (200, status forced in SQLite)
- `已退回 → 已取消` (200)
- `待认领 → 已完成` (409)
- `待认领 → 进行中` (409) — test title: "is claim territory, not a poster edit"
- `已取消 → 待认领` (409)

HTTP does **not** exercise `进行中 → 待认领` or `进行中 → 待验收`.

#### Events written from tasks.ts

Constant names (`tasks.ts:22-23`): `STATUS_TRANSITION_EVENT = '状态迁移'`, `TOKEN_REVEAL_EVENT = 'token 揭示'`.

1. PATCH success (`tasks.ts:596-600`): `insertAuditEvent({ type: '状态迁移', actorUserId: user.id, details: { task_id: publicId, from, to } })`. `task_id` is the **public_id string**.
2. POST profile path after decrypt (`insertTokenRevealEvent`, `tasks.ts:158-180`), including 422/502: `type: 'token 揭示'`, `details: { profile_id, forge, base_url, full_name, outcome }` where `outcome` ∈ `'ok' | 'token_check_failed' | 'forge_unreachable'`. `profile_id` is integer PK. **No `agent_key_id`.** Tests assert that (`tasks.test.ts:1696-1700`). Inline path writes **no** reveal event.

#### public_id vs integer PK

- SQLite: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `public_id TEXT NOT NULL UNIQUE`
- Allocation: `nextPublicId` (`tasks.ts:356-368`) `kt-${UTC year}-${NNNN}` with numeric suffix
- HTTP params: Fastify `:publicId` compared with `eq(tasks.publicId, publicId)`. Numeric `'1'` is 404 (`tasks.test.ts:1205-1216`). Contrast `parsePositiveInt` on agent-keys/credential-profiles which 404s non-integers rather than looking them up as public ids.

#### Test bootstrap (claim suite must copy these seams)

`apps/server/src/tasks.test.ts`:

1. `applyOauthTestEnv()` at **module load** (`:64-78`): sets all OAuth env + `SESSION_SECRET = '0'.repeat(32)` + `PUBLIC_URL = 'http://localhost:3000'` + `VAULT_MASTER_KEY = 'cd'.repeat(32)`.
2. **Then** `const { buildApp } = await import('./app.ts')` (`:80`). `registerAuth` throws if env is empty, so import must follow env.
3. `createApp(t, sqlitePath?)` (`:291-298`): `buildApp({ sqlitePath })`, `t.after(app.close)`, `await app.ready()`. Does **not** listen.
4. Login: stub `app[decoratorName].getAccessTokenFromAuthorizationCodeFlow`, `inject GET callback?code=…`, collect `response.cookies`, `GET /api/v1/me` with `{ accept: 'application/json' }`.
5. **THE FETCH SEAM** `beginFetch(t)` (`:182-214`): one `globalThis.fetch` router keyed on **bare token identity**, not URL.
   - Tokens in `stub.forge` → forge API (`/repos/` or `/projects/` → repo JSON; `/user` → user JSON; `unreachable: true` throws `TypeError('fetch failed')`).
   - Tokens in `stub.oauth` → userinfo 200.
   - **Anything else → `500 { error: 'unstubbed fetch', url, token }`.**
6. Gitea forge origin is `https://gitea.forge.example.test`, deliberately **not** the OAuth Gitea base `https://gitea.example.test`.
7. Outer describe `{ concurrency: false }`.
8. `jsonHeaders = { accept: 'application/json' }` — no `content-type`; Fastify `inject` `payload` object is still JSON.

**Collisions with sibling suites:**

- `agent-keys.test.ts` / `vault.test.ts` `stubUserinfoByAccessToken` answers 500 for any unrecognised `Authorization`. If a claim test creates a task (needs forge `validateToken` GET with `Authorization: token <gitea>` or `PRIVATE-TOKEN`) under that stub, publish 502/500s. Use `beginFetch`, not the userinfo-only stub.
- Root `pnpm test` is **one** `node --test` process listing files in order. Each file's top-level `applyOauthTestEnv` mutates `process.env`. After all ESM evaluation, last file that sets `VAULT_MASTER_KEY` wins until a test mutates it. Today `tasks.test.ts` (`'cd'.repeat(32)`) loads after `vault.test.ts` (`'ab'.repeat(32)`). A new file appended **after** `tasks.test.ts` that sets a different master key at import will change decrypt for any later-running concurrent test.
- `assertNoTokenMaterial` forbids key `token` — do not reuse it on claim success.
- Fetch stub is irrelevant to Bearer whoami / claim-if-decrypt-only: those do not call `fetch`. It **is** relevant to creating fixtures via `POST /api/v1/tasks`.
- Gitea adapter sends `Authorization: token <forgeToken>` (`forge-adapters/src/index.ts:132`). `beginFetch.stubbedToken` accepts `Bearer|token` and `PRIVATE-TOKEN`. An Agent Key `Bearer ktk_…` that is not in `oauth`/`forge` maps yields 500 **if some code path fetches with it**. whoami does not.

---

### 2. Agent key Bearer auth (`apps/server/src/agent-keys.ts`)

#### Session routes (not Bearer)

- `POST /api/v1/agent-keys` — session; `status === 'active'` else `403 { error: 'forbidden', message: '你的账号待正式成员批准后方可生成 Agent Key。' }`. `201 { id, label, token, last_used_at: null }`. Plaintext `ktk_` + 64 hex (`randomBytes(32).toString('hex')`). Stored `key_hash = sha256(utf8).hex`.
- `GET /api/v1/agent-keys` — session; active else `403 { error: 'forbidden' }` (no message). `200 { keys: [{ id, label, last_used_at }] }`.
- `DELETE /api/v1/agent-keys/:id` — session; active; own row only. `parsePositiveInt`; bad/missing/not-owned → `404 { error: 'not_found' }`. `200 { ok: true }`.

Pending GitHub (`status: '待批准'`, `permission_level: 'claim_only'`) **cannot mint a key**. Approved GitHub (`active` + `claim_only`) **can**.

#### Bearer plugin

```132:168:apps/server/src/agent-keys.ts
  app.register(async function agentBearerContext(child) {
    child.addHook('onRequest', async (request, reply) => {
      const token = parseBearerToken(request.headers.authorization)
      // /^Bearer\s+(\S+)/i — scheme Token/Basic fail
      // hashAgentKey → select agent_keys by key_hash → timingSafeEqual
      // load users by key.userId
      // lastUsedAt = unix seconds; request.agentAuth = { user, key }
    })
    child.get('/api/v1/agent/whoami', ...)
  })
```

Signatures:

- `hashAgentKey(plaintext: string): string` — `createHash('sha256').update(plaintext, 'utf8').digest('hex')` (`:16-18`)
- `parseBearerToken`: `^Bearer\s+(\S+)/i` (`:35-38`)
- `sendBearerUnauthorized`: `WWW-Authenticate: Bearer`, `401 { error: 'unauthorized' }` (`:41-43`)
- Module augmentation (`:10-14`): `FastifyRequest.agentAuth?: { user: User; key: AgentKey }`

`last_used_at` updates **on every successful hook**, before the handler. Failed lookup does not tick. Tests pin this (`agent-keys.test.ts:444-472`, `:683-699`).

**Pending-user behavior:** hook does **not** read `user.status`. whoami of a pending user who somehow has a key would return `status: '待批准'`. There is **no test** for that path because pending cannot `POST /api/v1/agent-keys`. Session generate is 403; Bearer whoami for pending is UNVERIFIED without a seeded `agent_keys` row.

#### `GET /api/v1/agent/whoami` 200 body (exact keys from tests `:453-460`)

```json
{ "id": <user.id>, "key_id": <agent_keys.id>, "label": "<label>", "status": "<users.status>", "permission_level": "<users.permission_level>" }
```

No `token`, no `key_hash`. Lowercase / mixed-case `bearer` works. Session cookie alone → 401 + `WWW-Authenticate`. `GET /api/v1/me` with Bearer and no cookie → session 401 without `WWW-Authenticate`.

#### Can a sibling plugin reuse the decorator?

- **TypeScript shape:** yes. `declare module 'fastify'` is global.
- **Runtime hook:** no, not automatically. The plugin is **not** wrapped in `fastify-plugin` (repo-wide grep: zero). Encapsulated `onRequest` applies only to routes registered on that child. `registerTasks` runs on the parent (`app.ts:49`) and will never see `request.agentAuth` unless claim routes:
  1. are registered **inside** the same `agentBearerContext` callback (requires exporting/moving the plugin), or
  2. register their **own** encapsulated plugin that duplicates/extracts the hook, or
  3. break encapsulation (not done anywhere today).

There is no exported `requireAgentAuth` helper.

#### How tests mint a real `ktk_` key

`agent-keys.test.ts`: `applyOauthTestEnv()` (**deletes** `VAULT_MASTER_KEY`) → dynamic `import('./app.ts')` → `loginViaCallback` with fetch userinfo stub → `postAgentKey` = `inject POST /api/v1/agent-keys` with cookies → `created.json().token` matching `/^ktk_[0-9a-f]{64}$/` → `agentWhoami(app, { token })` sets `headers.authorization = \`Bearer ${token}\``.

Claim tests that also need vault + task create must **set** `VAULT_MASTER_KEY` (tasks.test.ts style), not delete it.

---

### 3. Vault (`apps/server/src/vault.ts`)

#### Signatures (exact)

```ts
export function encryptToken(plaintext: string): string
export function decryptToken(encoded: string | Buffer): string
export function insertAuditEvent(
  db: AppDb,
  input: { type: string; actorUserId: number; details: unknown },
): void
export function revealCredentialProfile(
  db: AppDb,
  input: { profileId: number; actorUserId: number; agentKeyId: number },
): string
```

AES-256-GCM; IV 12 bytes; auth tag 16; blob `iv||ciphertext||tag` base64. `VAULT_MASTER_KEY` must be 64 hex chars; else `VaultUnconfiguredError` with `code === 'vault_unconfigured'`. **Not read at `buildApp()` boot.**

`insertAuditEvent` always sets `createdAt` unix seconds and `details: JSON.stringify(input.details)`. **`actorUserId` is required `number`** even though `events.actor_user_id` is nullable in SQL. Expiry-with-no-actor cannot use this helper as-is.

#### `revealCredentialProfile` audit

Writes `type: 'token 揭示'` (`vault.ts:94-98`), `details: { agent_key_id, profile_id }` (both numbers). **Does log `agent_key_id`.** Does not log token. Missing row throws `Error('credential profile not found')`. Tests (`vault.test.ts:649-707`) also assert the event dump omits plaintext.

#### Publish path vs reveal helper

`tasks.ts` profile publish calls **`decryptToken(profile.tokenEncrypted)` directly** (`:458`), then `insertTokenRevealEvent` with session-oriented details. It does **not** call `revealCredentialProfile`. Inline publish calls `encryptToken` then `validateToken`; no reveal event.

#### Can claim reuse `revealCredentialProfile` as-is?

Only for the **profile** credential path, and only if the desired audit details are `{ agent_key_id, profile_id }` with **no** `task_id` / `outcome` / `forge`. That matches DESIGN §7's sentence "谁的哪个 Agent Key、何时、拿走了哪个档案的 token" better than the publish writer, but:

- Inline tasks have `inline_token_encrypted` and **no** profile row — helper cannot decrypt them.
- Publish-time events already use a different details schema under the **same** `type` string `'token 揭示'`. Consumers cannot distinguish claim vs publish without inspecting keys.
- Claim of a profile would double-up type `'token 揭示'` with two shapes.
- Helper requires `agentKeyId: number` even if a hypothetical session claim existed.

Claim almost certainly needs either a new writer (or an extended `insertAuditEvent` details object) plus `decryptToken` for the inline path.

---

### 4. Schema / DB (`schema.ts`, `db.ts`)

#### How tables are created

`createDb(path = ':memory:')` (`db.ts:80-88`): `better-sqlite3` + `sqlite.exec` of five DDL constants (`USERS_DDL`, `AGENT_KEYS_DDL`, `CREDENTIAL_PROFILES_DDL`, `TASKS_DDL`, `EVENTS_DDL`) then `drizzle(sqlite, { schema: { users, agentKeys, credentialProfiles, tasks, events } })`. **No migrations folder. No `leases`.**

**Recipe to add `leases`:** (1) `LEASSES_DDL` `CREATE TABLE IF NOT EXISTS leases (...)` const next to the others; (2) `sqlite.exec(LEASES_DDL)` in `createDb`; (3) `sqliteTable('leases', { ... })` in `schema.ts`; (4) add the drizzle table to the `schema: { ... }` map and export types. Existing DBs that already ran `createDb` will get the new table on next `IF NOT EXISTS` exec (in-memory tests always start empty). There is no ALTER path for existing on-disk files beyond `IF NOT EXISTS`.

DESIGN §10 intended columns (not in code): `task_id`, `claimer_user_id`, `agent_key_id`, `claimed_at`, `expires_at`, `last_heartbeat`, `state`.

#### `tasks` columns — no lease fields

From `TASKS_DDL` (`db.ts:41-68`) / drizzle (`schema.ts:46-82`): `id`, `public_id`, `title`, `description_md`, `source_type`, `source_issue_url`, `repo_forge`, `repo_base_url`, `repo_full_name`, `repo_base_branch`, `repo_suggested_dir`, `acceptance_criteria`, `test_command`, `allowed_paths`, `forbidden_paths`, `priority`, `tags`, `credential_profile_id`, `inline_token_encrypted`, `poster_user_id`, `status`, `created_at`.

**No** `lease_ttl`, `ttl`, `claimer`, `claimer_user_id`, `claimed_at`, `expires_at`. CHECK `tasks_credential_xor`: exactly one of `credential_profile_id` / `inline_token_encrypted` is non-null.

#### `events.type`

SQL: `type TEXT NOT NULL` — **free text**, no CHECK/enum. `details TEXT NOT NULL` (JSON string). `actor_user_id INTEGER` **nullable**. `created_at INTEGER NOT NULL`.

Type strings that exist in **code/tests today**:

| type | writer | details keys |
|------|--------|--------------|
| `变更` | credential-profiles.ts | `{ action: 'create' \| 'delete', profile_id }` |
| `token 揭示` | vault.revealCredentialProfile | `{ agent_key_id, profile_id }` |
| `token 揭示` | tasks.insertTokenRevealEvent | `{ profile_id, forge, base_url, full_name, outcome }` |
| `状态迁移` | tasks PATCH | `{ task_id: public_id, from, to }` |

DESIGN §10 also names `心跳` and `回写`. **Neither string appears in source.** No `leases.state` / revoke-reveal column.

#### Foreign keys

**None.** Grep of `REFERENCES` / `FOREIGN KEY` / drizzle `foreignKey` over the worktree: zero. `agent_keys.user_id`, `tasks.poster_user_id`, `tasks.credential_profile_id`, `credential_profiles.created_by`, `events.actor_user_id` are bare integers.

---

### 5. Shared package (`packages/shared/src/index.ts`)

Package `"exports": { ".": "./src/index.ts" }`. Runtime exports:

- `getSharedHealth(): string` → `'kaola-shared-ready'`
- `taskStatusSchema` / type `TaskStatus` — `'待认领' \| '进行中' \| '待验收' \| '已完成' \| '已退回' \| '已取消'`
- `taskBriefSchema` / type `TaskBrief` / `parseTaskBrief(input: unknown): TaskBrief`
- `transitionTaskStatus(from: string, to: string): string` — throws `Error(\`Illegal task status transition: ${from} → ${to}\`)`

**Allowed edges** (`LEGAL_TRANSITIONS`, `:68-73`; tests enumerate the cartesian product):

- `待认领` → `进行中`, `已取消`
- `进行中` → `待认领`, `待验收`
- `待验收` → `已完成`, `已退回`
- `已退回` → `待认领`, `已取消`
- `已完成` / `已取消` have no outbound edges

So claim (`待认领 → 进行中`) and expiry/release (`进行中 → 待认领`) are already legal in the shared machine. HTTP poster subset does not expose them.

**`taskBriefSchema` fields** (`:18-60`): `z.strictObject` — extra keys fail parse. `credential` union `{ profile_id: string }` | `{ inline: true }`. **No** lease / ttl / claimer / token fields. `created_at` is `z.iso.datetime({ offset: true })`. DESIGN example `profile_id: "cp-gitea-orders"` still parses (string). HTTP emits decimal PK strings (`"3"`), which also parse.

Tests explicitly reject a raw `token` field on the brief and inside `credential` (`packages/shared/src/index.test.ts:202-228`, `:334-344`).

---

### 6. Forge adapters

`createForgeAdapter(kind, options?: { baseUrl?: string }): ForgeAdapter`. `validateToken(cred: { token: string }, repo: { full_name, base_url }): Promise<{ missing: Array<'读'\|'推'\|'PR'> }>`. Other methods throw `Error('not implemented')`. `validateToken` is **not** a package-level named export (it is a method).

Used today only for **publish-time** 发布即校验. Claim should reveal the **stored** ciphertext (`credential_profiles.token_encrypted` or `tasks.inline_token_encrypted`) via `decryptToken`. Re-calling `validateToken` on claim is **not** required by issue #9 and would re-introduce the fetch-stub seam on the claim path.

**"撤销该次 token 揭示的有效性记录"** (DESIGN §5): no table or column implements this. No revoke-reveal flag on `events`. `leases.state` is design-only. UNVERIFIED how expiry should mark a prior reveal invalid beyond returning the task to `待认领` and dropping a live lease row.

---

### 7. Web

Board loads **only** `GET /api/v1/tasks` (`App.vue:654-666`). Detail is the in-memory brief; **no** `GET /api/v1/tasks/:id`. Timeline (`App.vue:107-111`): one synthetic line `发布 {{ poster }} {{ created_at }}`. `App.board.test.ts:7-10` and `:597-614` pin: no events HTTP; timeline must not contain `心跳` / `token 揭示`; no `board-timeline-认领` nodes.

Pending users (`status === '待批准'`) see the pending card, **not** the board (`view === 'pending'`). Approved `claim_only` sees the board, not the posting form.

Issue #9 acceptance is server-side (expiry, never-token on list/get, audit on reveal). **#9 does not require a web change** to meet those bars. Heartbeat notes on the timeline would need events HTTP (out of scope unless someone expands #9).

---

### 8. Nested-route patterns / listen / TTL gap / secret key name

Closest existing nested routes:

- `POST /api/v1/users/:id/approve` — integer `:id`, `400 invalid_id` on junk, `404 not_found` if missing
- `DELETE /api/v1/agent-keys/:id` — integer, junk → `404 not_found`
- `DELETE /api/v1/credential-profiles/:id` — same
- `GET|PATCH /api/v1/tasks/:publicId` — **string public_id**, junk/numeric PK → `404 { error: 'not_found' }`
- `GET /api/v1/agent/whoami` — Bearer collection under `/api/v1/agent/…`

DESIGN §9: "REST 端点一一对应（`/api/v1/tasks` 等）" — **does not name** `/claim`, `/heartbeat`, or MCP tool names as URL segments.

Expiry runner: `index.ts` only `listen`s. `buildApp` has `onClose` to close SQLite, no `setInterval`/`cron`. hosting.test.ts: "Do not import('./index.ts') (it listens)." Any sweeper must be started from `buildApp` (so tests can invoke it) or be lazy (check-on-read). **Neither exists.**

Per-task TTL: **no column** and **no brief field**. DESIGN §5 says "默认 TTL 建议 24h（可按任务配置）"; §6 JSON has no ttl. Recorded as a gap, not a contract.

Only HTTP that returns a secret today: `POST /api/v1/agent-keys` → JSON key **`token`** (the `ktk_` key). Forge plaintext is never returned by any current HTTP. Claim success DESIGN: 任务卡 + 揭示 token + 租约 TTL + 克隆指引 (`suggested_dir` already lives at `brief.repo.suggested_dir`; #10 comment says also token-hygiene guidance). JSON keys for the revealed forge token / TTL / hygiene blob are **not specified in code**. Naming the forge secret `token` matches agent-keys but collides with `assertNoTokenMaterial` and with `taskBriefSchema` strictness if merged into one object.

Clone guidance from issue #10 comment (issue #9 comment points here): `suggested_dir` from `repo.suggested_dir` (default repo name); instruct env var or `git -c http.extraHeader`; never embed token in remote URL. Exact JSON key for the hygiene string: **UNVERIFIED** (not in this tree).

---

### 9. Test wiring

Root `package.json` `"test"` (worktree):

```
node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts apps/server/src/tasks.test.ts apps/server/src/hosting.test.ts && pnpm --filter @kaola/web test
```

**New files must be appended to this list or they do not run.** (Custody: tdd-guide may edit `package.json` + the new test file; implementer must not.)

Worktree **`node_modules` is missing** (not a symlink; `ls` missing). Main checkout `/Users/ylpromax5/Workspace/KaolaTasks/node_modules` exists. Running tests inside the worktree requires `pnpm install` in that worktree (or otherwise providing modules). UNVERIFIED whether the orchestrator already installs before tdd-guide/implementer.

---

## Gaps vs DESIGN / issue #9 / CLAUDE.md

Code is the tree; these are disagreements or missing pieces, not implementation decisions.

1. **No leases table, no claim/heartbeat/release HTTP, no MCP server.** DESIGN §9–§10 describe them. `docs/api.md` and `docs/architecture.md` already record "Claim HTTP is not implemented" / "MCP / claim not implemented". This is the #9 gap, not a doc bug.
2. **DESIGN §6 example `credential.profile_id: "cp-gitea-orders"`** vs HTTP `{ profile_id: String(<integer PK>) }`. Shared schema accepts both (plain string). Code never emits `cp-…` ids.
3. **DESIGN §5 "可按任务配置" TTL** vs §6 brief and `tasks` table: **no ttl field**. Default 24h is design prose only.
4. **DESIGN §5 "撤销该次 token 揭示的有效性记录"** vs schema: **no such record** besides a free-text `events` row that is never updated.
5. **DESIGN §10 `events` types `心跳` / `回写`**: not used in code.
6. **DESIGN §10 `leases` / `submissions`**: not in DDL.
7. **Poster comment in `tasks.ts:28-29`** says every non-poster edge "belongs to a claim (MCP)". Issue #9 (and DESIGN §9 REST mirror) say REST claim is this issue; MCP is #10. The comment is stale relative to the issue split.
8. **`taskBriefSchema` is `z.strictObject`**: a claim response that is "brief + token + ttl + clone guidance" cannot pass `parseTaskBrief` as a whole. DESIGN §9 says claim returns 任务卡 + extra fields — those extras must live beside or around the brief, not inside the strict object unless §6 is widened (out of scope unless someone changes DESIGN).
9. **Two `token 揭示` details shapes** already share one type string. Claim adds a third unless it reuses one of them.
10. **`revealCredentialProfile` cannot reveal inline tokens.** DESIGN §6 says both forms reveal on `claim_task`.
11. **Pending users cannot mint Agent Keys**, so "pending claim must 403 and not reveal" cannot be hit through the public HTTP mint path without seeding `agent_keys` (or adding a session claim route).
12. **Bearer hook does not reject `待批准`.** whoami would succeed for a seeded pending key. Claim must add the status check itself.
13. **`insertAuditEvent` requires `actorUserId: number`.** Expiry has no actor; SQL allows NULL.
14. **No interval/cron** to implement "过期自动回待认领" except check-on-read/check-on-write.
15. **GET list/get are session-only.** MCP `list_tasks` / `get_task_brief` would be Bearer (#10). If #9 only adds Bearer claim, an Agent still cannot list via REST without a session cookie unless list also gains Bearer.
16. **Web timeline will not show claim/heartbeat** even after #9, because there is no events HTTP and the UI synthesizes one 发布 row. Not an #9 acceptance failure unless the issue is widened.
17. **CLAUDE.md in this worktree** (snapshot line 7) already says task HTTP exists, server depends on forge-adapters, MCP and claim are not implemented, PORT default 31415. That matches code. (The *parent* session's always-applied CLAUDE text still said "Server does not import `@kaola/forge-adapters`" and "MCP, task CRUD, and claim are not implemented" and PORT 3000 — that text is **stale vs this worktree**.)
18. **`PUBLIC_URL` test default `http://localhost:3000`** vs process default `http://localhost:31415` (`auth.ts:243`, `index.ts:7`). Tests pin 3000; production listen is 31415. Not a claim blocker.
19. **Issue acceptance names MCP tools** `list_tasks` / `get_task_brief`; the implemented never-token surface is REST GET list/get. Mapping is by DESIGN §9 "REST 端点一一对应", not by identical path names.

---

## Open questions

Questions only — not decided here.

1. What exact REST paths and methods for claim / heartbeat / release? Candidates include `POST /api/v1/tasks/:publicId/claim`, `/report_progress`, `/release` vs MCP names `claim_task` / `report_progress` / `release_task` vs a `/api/v1/agent/…` collection like whoami.
2. Does heartbeat map to DESIGN `report_progress` with body `{ note }` (and write an `events.type` `心跳` row), or is a nameless TTL-only ping enough for #9?
3. How does expiry run: check-on-read (list/get/claim), check-on-write, `setInterval` inside `buildApp`, or an exported `expireLeases(db, now)` that tests call directly? Who is `events.actor_user_id` on automatic expiry (`null` vs last claimer vs system)?
4. Where is per-task TTL stored if "可按任务配置" is in scope for #9 despite no §6 field and no column? Or is 24h a process-wide constant until a later issue?
5. What JSON keys wrap the revealed forge token, lease TTL, and token-hygiene guidance on claim success? `token` (agent-keys convention) vs something that does not collide with `assertNoTokenMaterial` / `taskBriefSchema`? Is the brief nested (`{ task: Brief, token, … }`) or flattened?
6. Exact string/object for "token 使用方式" / clone guidance (issue #10 comment is prose, not a schema)? Is `suggested_dir` duplicated at the top level or only via `brief.repo.suggested_dir`?
7. Must claim routes live inside `agentBearerContext`, or is a second encapsulated Bearer plugin (extracted helper) acceptable?
8. Should GET list / GET one stay session-only, also accept Bearer, or gain parallel `/api/v1/agent/tasks` routes so an Agent can list then claim without MCP (#10)?
9. Is there any session-cookie claim route at all, or is claim Bearer-only?
10. Pending-user claim tests: seed `agent_keys` for a `待批准` user, or is another seam expected? What status code/body (`403 forbidden` vs `401`) and must `message` reuse `'你的账号待正式成员批准后方可认领任务。'` (`auth.ts:10`)?
11. Must approved `claim_only` (active GitHub) be allowed to claim? DESIGN §11 says yes after 批准.
12. Concurrent claims on the same `待认领` task: 409 vs first-writer-wins vs lease uniqueness constraint? DESIGN does not specify the error body.
13. Heartbeat/release by a non-holder Agent Key: 403 vs 404 vs 409? Error `error` string?
14. After expiry, is the previous `token 揭示` row updated, a new event written, or is "撤销有效性" just "no live lease"?
15. Does successful claim also write `状态迁移` `{ from: '待认领', to: '进行中' }` in addition to `token 揭示` (and maybe a lease row)? PATCH already uses `状态迁移` for poster edges.
16. Does claim of an inline token write `token 揭示` (publish currently does not)? Issue says 每次揭示均有审计记录.
17. Does claim re-validate the forge token (`validateToken`) or only decrypt? Re-validate reintroduces fetch stub + 422/502 on the claim path.
18. `leases.task_id`: integer PK or `public_id` text? Other FKs in this DB are integers without SQL FOREIGN KEY.
19. `leases.state` enum values? DESIGN lists the column, not the enum.
20. Default TTL 24h: 86400 seconds vs 24*60*60 with test clock control? How do tests freeze time (`Date.now` patch) given unix-seconds house style?
21. New test file name/path, and whether it may import helpers from `tasks.test.ts` (Node test files are not a package; extracting shared test helpers would be a third file that also must be imported, not appended as a `--test` entry).
22. Worktree has no `node_modules`: who runs `pnpm install` before the claim suite can execute?

---

## Issue #9 comment overlay (measured)

Forge issue: https://github.com/KaolaBrother/KaolaTasks/issues/9

- Body + acceptance as given in the objective. State open; labels `P1`, `M1`, `workflow:in-progress`.
- Winning comment (`#issuecomment-5356076134`): 认领即授权; pending claim refused without token reveal; success includes clone guidance (`suggested_dir` + token 使用方式, see #10 comment).
- #10 comment (`#issuecomment-5356076474`): `suggested_dir` from `repo.suggested_dir` (default repo name); hygiene = env var or `git -c http.extraHeader`; do not put token in remote URL; MCP tool description should mention hygiene (MCP is #10, not this issue).

---

Landed at:

`/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-9/.cache/ground-truth.md`
