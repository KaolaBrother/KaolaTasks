# Design measure: bundle-4-5 (#4 Agent API keys, #5 Token vault / credential profiles)

Measured from worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5` at commit `2e280c912b8e68df9a482eba9c8a89bc22315865` (`2e280c9 chore: archive bundle-3-6 [sink]`). Main checkout `/Users/ylpromax5/Workspace/KaolaTasks` is the same commit. No implementation in this note.

Issue sources (GitHub `KaolaBrother/KaolaTasks`):

- [#4](https://github.com/KaolaBrother/KaolaTasks/issues/4) body. The only comment is workflow-start (`5359483905`, 2026-08-20); it does not override the body.
- [#5](https://github.com/KaolaBrother/KaolaTasks/issues/5) body. The only comment is workflow-start (`5359484970`, 2026-08-20); it does not override the body.

This run must **not** implement claim/leases/MCP/task CRUD (issues #7 #8 #9 #10 #11). Adjacent issue texts are quoted only where they collide with #4/#5 wording.

---

## Measured facts

### Issue text in force (no comment override)

**#4 body:**

- Goal: Web 端自助生成/吊销个人 Agent API Key；服务端只存哈希；MCP/REST 的 Bearer 鉴权中间件。
- Acceptance still standing: key 明文只在创建时显示一次；吊销即时生效；错误 key 返回 401；`last_used_at` 更新。
- Design pointer: `docs/DESIGN.md` §10 §11.

**#5 body:**

- Goal: 凭证档案（Credential Profile）CRUD；token AES-256-GCM 加密存储，主密钥来自环境变量；所有揭示/变更写入 `events` 审计表；支持单任务临时 token 覆盖。
- Acceptance still standing: 数据库中不存在明文 token；删除档案即吊销（后续揭示失败），UI 提示去 forge 侧撤销；每次揭示均有审计记录（谁的哪个 key、何时、哪个档案）。
- Design pointer: `docs/DESIGN.md` §7 §10.

DESIGN.md header (v0.2, 2026-08-20) is the contract this note measures against.

---

### 1. DESIGN.md §7 — 凭证与安全模型 (quoted)

Bullet list, quoted in full from `docs/DESIGN.md` §7:

> - **凭证档案（Credential Profile）**：按"forge + 仓库"维度存储可复用 token，团队连接一次、发布任务时下拉选择；也允许发布者为某个任务粘贴一次性 token（覆盖档案）。
> - **推荐 token 类型**：GitHub fine-grained PAT（限定单仓库）、GitLab Project Access Token、Gitea 仓库级 scoped token——三者都天然按仓库隔离。
> - **加密存储**：AES-256-GCM，主密钥来自环境变量/密钥文件，不入库、不入代码。
> - **认领时揭示（reveal-on-claim）**：token 只在 `claim_task` 成功时下发给认领 Agent；`list_tasks` / `get_task_brief` 永不含 token。
> - **认领即授权（MVP）**：Agent API Key 即用户授权——用户明确指示 Agent 认领时无需二次确认；"人确认认领"开关只针对自主轮询式 Agent（M3，Issue #16）。"待批准"状态的 GitHub 登录用户无法认领（见 §11）。
> - **Agent 侧 token 卫生**：`claim_task` 返回中附带使用指引——token 走环境变量或 `git -c http.extraHeader` 按次传递，**不要**拼进 remote URL（会落盘到 `.git/config` 并在任务结束后残留）。
> - **全量审计**：每次揭示记录"谁的哪个 Agent Key、何时、拿走了哪个档案的 token"；档案页提供一键吊销（删除档案 + 提示去 forge 侧撤销）。
> - **无账号认领者（token 即访问权）**：认领者**不需要**在目标 forge 上有账号。Agent 用揭示的 token 走 HTTPS clone、向**同一仓库**推分支（不走 fork——fork 才需要账号）、再用同一 token 调 API 开 PR/MR。因此发布校验必须包含"能否推分支"。身份归属：PR 显示的是 token 所属身份（发布者或项目 bot），但 commit author 可自由设置为认领者姓名/邮箱（无需账号），PR 描述底部附"claimed by @认领者 via Kaola Tasks"，考拉侧审计日志保存真实认领记录。推荐用 GitLab Project Access Token（Developer 角色，`api` + `write_repository`）/ Gitea 仓库 token / GitHub fine-grained PAT 实现此模式。
> - **提示注入提醒**：任务描述是进入 Agent 上下文的非受信文本。即使是内部平台，导入的 Issue 正文也可能包含外部人写的内容，UI 对导入内容打来源标记，默认保留"人确认认领"这一道闸。

§2 D7 (token attachment), quoted in full:

> | D7 | Token 附着方式 | 凭证档案（Credential Profile）复用为主，允许单任务临时 token 覆盖 |

§2 D3 (credential mode), quoted in full:

> | D3 | 凭证模式 | 发布任务**强制**附带 token；Agent 认领后用该 token 直接访问 forge |

§6 Task Brief `credential` line, quoted in full (the only Task Brief mention of profiles / one-off tokens):

> `"credential": { "profile_id": "cp-gitea-orders" },  // 或单任务临时 token 的引用`

§4 names **Token Vault** as a box: 「凭证加密存储与"认领时揭示"机制（见 §7）」. Web 前端职责 includes 「凭证档案管理、审计日志、个人 Agent Key 管理」.

§9 REST sentence that is the only HTTP hint for profiles (no path):

> REST 端点一一对应（`/api/v1/tasks` 等），另加 Web 端专用的档案管理、审计查询、OAuth 回调等接口。

§9 Agent auth sentence:

> MCP Server 以个人 API Key 鉴权（key 在 Web 端自助生成，绑定用户）

§11 Agent auth sentence:

> **Agent（MCP/REST）**：Bearer API Key，用户在 Web 端自助生成/吊销，服务端只存哈希。

§12 deployment sentence on the master key:

> **部署**：内部服务器 docker-compose 单机部署（server + 静态前端 + 挂载 SQLite 卷）。主密钥经环境变量注入。

§5 「发布即校验」 (publish-time; **#7**, not this run’s acceptance, but it names `validateToken` as the probe this vault must not reimplement):

> 任务发布/导入时，适配层用所附 token 实测权限（能否读仓库、能否推分支、能否创建 PR）。token 失效或权限不足的任务不会出现在看板上。

`docs/conventions.md`: 「Tokens never appear in logs or non-claim API responses.」

---

### 2. DESIGN.md §10 — tables in scope for this run

Quoted in full, every §10 row, so later work does not silently reuse `tasks` / `leases` / `submissions` as vault fields. **Only `agent_keys`, `credential_profiles`, and `events` are in this run’s schema scope.** `users` already exists (bundle-3-6). `tasks` / `leases` / `submissions` are out of scope (see § Out of scope).

> | 表 | 关键字段 |
> |----|----------|
> | `users` | forge OAuth 身份（provider, remote_id, username）、显示名、状态（active / 待批准）、权限级（full / claim_only） |
> | `agent_keys` | user_id、key_hash、label、last_used_at |
> | `credential_profiles` | forge、base_url、repo_full_name、token_encrypted、scopes_checked、created_by |
> | `tasks` | §6 各字段 + status、credential_profile_id / inline_token_encrypted（二选一） |
> | `leases` | task_id、claimer_user_id、agent_key_id、claimed_at、expires_at、last_heartbeat、state |
> | `submissions` | task_id、lease_id、pr_url、summary、pr_state |
> | `events` | 审计与时间线：类型（状态迁移 / token 揭示 / 心跳 / 回写）、主体、时间、详情 JSON |

SQLite/Drizzle closing sentence of §10:

> SQLite 足够内部团队规模；Drizzle 之上留好升级 Postgres 的余地（不用 SQLite 特有特性）。

#### `agent_keys` — English tokens in that cell

| Token | Role in the sentence |
|-------|----------------------|
| `agent_keys` | table name |
| `user_id` | FK-shaped name; target table is `users` (implied, not declared as a constraint) |
| `key_hash` | hashed Agent API Key; algorithm **not named** |
| `label` | key label |
| `last_used_at` | timestamp of use; timezone / SQL type / when it ticks **not named** |

No English token in that cell for: primary key, `created_at`, revoked flag, prefix, plaintext. Later `leases.agent_key_id` implies a key row identity; that column is on an **out-of-scope** table.

#### `credential_profiles` — English tokens in that cell

| Token | Role in the sentence |
|-------|----------------------|
| `credential_profiles` | table name |
| `forge` | forge identity of the stored token |
| `base_url` | instance origin (same word as Task Brief `repo.base_url` and adapter `RepoRef.base_url`; equality is not stated) |
| `repo_full_name` | repo; Task Brief uses `full_name`, this table uses `repo_full_name` |
| `token_encrypted` | AES-256-GCM ciphertext; encoding of nonce/tag/ciphertext **not named** |
| `scopes_checked` | result of some permission check; field type **not named** |
| `created_by` | creator; type (user id vs username) **not named** |

No English token in that cell for: primary key, display name, timestamps, uniqueness of `(forge, base_url, repo_full_name)`.

§6 example `profile_id` value `"cp-gitea-orders"` is a **string slug**. §10 does not name `id` or `profile_id` on `credential_profiles`. Whether the Task Brief `credential.profile_id` is that slug or a numeric PK is **UNSPECIFIED**.

#### `events` — English vs Chinese in that cell

| Token / label | Kind |
|---------------|------|
| `events` | table name (English) |
| 类型 | Chinese label; values `状态迁移` / `token 揭示` / `心跳` / `回写` (mixed: three Chinese phrases + one English-containing `token 揭示`) |
| 主体 | Chinese label; **no English column** |
| 时间 | Chinese label; **no English column** |
| 详情 JSON | Chinese 详情 + English `JSON`; **no English column** for the JSON body |

DESIGN does **not** name an event type `变更`. #5 body says 「所有揭示/变更写入 `events` 审计表」. That word **变更** is issue language, not a §10 enum member. Flag for `technical-decisions.md`; do not treat `变更` as a DESIGN token.

#### `tasks` row (quoted so #5’s “单任务临时 token 覆盖” is located)

The only DESIGN storage for a one-off override is on **`tasks`**:

> `credential_profile_id` / `inline_token_encrypted`（二选一）

That column pair is **not** on `credential_profiles`. See tension below. Do not implement `tasks` in this run.

---

### 3. DESIGN.md §11 — capability matrix (must gate; do not invent)

Quoted in full (table + the two surrounding sentences that bind GitHub first login):

> - **人（Web）**：多源 OAuth，无独立账号体系，首次登录自动建号，权限按登录来源分级：
>
>   | 能力 | GitLab / Gitea 登录（自托管 = 团队身份） | GitHub 登录 |
>   |------|------------------------------------------|-------------|
>   | 查看任务板 | ✓ | ✓ |
>   | 发布任务 / 管理凭证档案 | ✓ | ✗ |
>   | 认领任务 / 生成 Agent Key | ✓ | ✓（需先通过首登批准） |
>
>   GitHub 账号任何人都能注册，而认领即 token 揭示，故 GitHub 登录首次进入"待批准"状态，由任一正式成员在 Web 端一键批准后方可认领。同一人多账号在 MVP 中视为多个用户，如有需要后续加身份关联。
> - **Agent（MCP/REST）**：Bearer API Key，用户在 Web 端自助生成/吊销，服务端只存哈希。

D8 restates the same split:

> 多源 OAuth：GitLab/Gitea（自托管）= 完整权限；GitHub = 仅认领，且首次登录需任一正式成员批准；发布任务与凭证管理仅限自托管身份

§7 restates pending GitHub cannot **认领** (not “cannot generate a key” in that sentence):

> "待批准"状态的 GitHub 登录用户无法认领（见 §11）。

The **生成 Agent Key** gate is the third matrix row, not a separate table. The **管理凭证档案** gate is the second matrix row, glued to 发布任务.

#### Permission table this run must implement (derived only from that matrix + §10 状态 values)

| Actor (already stored on `users`) | 生成 Agent Key | 管理凭证档案 |
|-----------------------------------|----------------|--------------|
| GitLab / Gitea, `permission_level` `full`, `status` `active` (first login mapping from bundle-3-6) | ✓ (matrix cell) | ✓ (matrix cell) |
| GitHub, `permission_level` `claim_only`, `status` `待批准` | ✗ — matrix says ✓ only after 首登批准; pending is denied | ✗ |
| GitHub, `permission_level` `claim_only`, `status` `active` (after `POST /api/v1/users/:id/approve`) | ✓ (matrix 「需先通过首登批准」) | ✗ (matrix cell is ✗ even after approve; D8 「凭证管理仅限自托管身份」) |

「正式成员」is not a column. Bundle-3-6 already bound approve to `status=active` AND `permission_level=full`. This note does not re-decide that. It does **not** appear as a third 权限级.

Who may **吊销** a key: §11 「用户在 Web 端自助生成/吊销」— own keys, self-service. Whether a `full` member may revoke another user’s key is **UNSPECIFIED**.

Who may **删除** a credential profile: §7 「档案页提供一键吊销」under 全量审计; §11 管理凭证档案 is the GitLab/Gitea cell. Whether only `created_by` may delete, or any `full` member, is **UNSPECIFIED**. §7 「团队连接一次、发布任务时下拉选择」implies team-shared profiles, not private-to-creator.

---

### 4. Tension: 单任务临时 token 覆盖 vs no `tasks` table (do not resolve)

Recorded for the orchestrator. Not a recommendation.

| Source | What it says |
|--------|----------------|
| #5 goal | 「支持单任务临时 token 覆盖」 |
| DESIGN D7 | 档案复用为主，允许单任务临时 token 覆盖 |
| DESIGN §7 | 发布者可为某个任务粘贴一次性 token（覆盖档案） |
| DESIGN §6 | `credential: { profile_id }` **or** comment 「单任务临时 token 的引用」 |
| DESIGN §10 `tasks` | `credential_profile_id` / `inline_token_encrypted`（二选一） |
| #7 acceptance (out of this run) | 「凭证档案下拉选择 + 单任务临时 token 两种路径均可用」 |
| `packages/shared` today | `credential` is **strict** `{ profile_id: string }`; tests reject a raw `token` on the brief and inside `credential` |
| This run | must **not** build the `tasks` table / posting flow (#7) |

So DESIGN’s named holding area for the override is **`tasks.inline_token_encrypted`**, which is on a table this run is forbidden to create. DESIGN does **not** name a vault-side “holding” table or an API that stores a one-off token without a task. A vault-only blob API would be an identifier not in DESIGN. Implementing `inline_token_encrypted` on `tasks` would be #7. **Blocked-until-#7 vs vault-side holding is an orchestrator call.**

Related: #5 acceptance 「删除档案即吊销（后续揭示失败）」and 「每次揭示均有审计记录」use **揭示**. DESIGN §7 names the reveal channel as **`claim_task` success only**. `claim_task` is #9 / #10, out of this run. #9 body independently requires 「每次揭示均有审计记录」and list/get never contain token. #9 comment `5356076134` (overrides #9 body on 认领即授权) does not change #5. Whether #5 can satisfy “后续揭示失败” / “每次揭示均有审计” without `claim_task` (internal decrypt helper vs waiting for #9) is the same class of tension. **Do not resolve here.**

Double-count: both #5 and #9 require 揭示审计. Both #5 and #7 mention 单任务临时 token.

---

### 5. Identifiers DESIGN actually names vs Chinese labels with no English column

#### Named in DESIGN (use these; do not rename)

**Tables:** `users`, `agent_keys`, `credential_profiles`, `tasks`, `leases`, `submissions`, `events`.

**`agent_keys` columns as printed:** `user_id`, `key_hash`, `label`, `last_used_at`.

**`credential_profiles` columns as printed:** `forge`, `base_url`, `repo_full_name`, `token_encrypted`, `scopes_checked`, `created_by`.

**Crypto algorithm (named):** `AES-256-GCM`.

**Auth scheme words (named):** `Bearer API Key` (§11); MCP 「以个人 API Key 鉴权」 (§9).

**MCP tool names (named, out of this run except as the reveal trigger):** `list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `submit_pr`, `release_task`.

**REST prefix example (named):** `/api/v1/tasks` (§9). OAuth callbacks already exist in code (`/login/...`).

**Task Brief:** `credential.profile_id` (string). Example value `cp-gitea-orders`.

**Event type values (named):** `状态迁移`, `token 揭示`, `心跳`, `回写`.

**User 状态 / 权限级 values (already in code):** `active` / `待批准`; `full` / `claim_only`.

**Forge literals (already in code):** `github` / `gitlab` / `gitea`.

**Adapter types already in `packages/forge-adapters` (do not re-define in vault):** `Credential` `{ token: string }`, `RepoRef` `{ full_name, base_url }`, `TokenCheck` `{ missing: ('读'\|'推'\|'PR')[] }`, `createForgeAdapter`.

#### Chinese labels with no English column (same class as 显示名 → prior `display_name`)

| Label | Where | Adjacent English / values |
|-------|--------|---------------------------|
| 显示名 | §10 `users` | already mapped in code to `display_name` (bundle-3-6 decision, not DESIGN) |
| 状态 | §10 `users` | values `active` / `待批准`; column in code is `status` (decision, not DESIGN) |
| 权限级 | §10 `users` | values `full` / `claim_only`; column in code is `permission_level` |
| 类型 | §10 `events` | values `状态迁移` / `token 揭示` / `心跳` / `回写` |
| 主体 | §10 `events` | none |
| 时间 | §10 `events` | none |
| 详情 | §10 `events` | “JSON” is English; no column identifier |
| 凭证档案 / Credential Profile | §7 title | table is `credential_profiles` |
| 哈希 | §11 「只存哈希」 | column is `key_hash`; **algorithm unnamed** |
| 主密钥 | §7 / §12 | **env var name unnamed**; §7 also says 密钥文件 |
| 单任务临时 token 覆盖 | D7 / §7 | column `inline_token_encrypted` lives on `tasks` |
| 一键吊销 | §7 | behavior = 删除档案 + 提示去 forge 侧撤销; no HTTP verb |
| 变更 | #5 body only | **not** a §10 event type |

Prior bundle-3-6 `technical-decisions.md` pattern to **reuse when the orchestrator names the new columns**: English identifier for a Chinese label; store mixed-language enum **values** as DESIGN printed them; integer PK autoincrement; `CREATE TABLE IF NOT EXISTS` with **no drizzle-kit**; unprefixed env vars like `SESSION_SECRET` / `OAUTH_*` / `SQLITE_PATH`; do not put user/vault types in `@kaola/shared`. Those names are **not** DESIGN tokens.

---

### 6. UNSPECIFIED (do not invent in TDD/implementer; flag for `technical-decisions.md`)

Later work must not fill these with guessed names inside DESIGN-quoting docs. Open questions, not proposed defaults.

#### Agent API keys (#4)

1. **Hash algorithm** for `key_hash` (SHA-256, HMAC, argon2, bcrypt, …). DESIGN: 「哈希」/ `key_hash` only.
2. **Plaintext key format** (length, alphabet, prefix). DESIGN does not name one.
3. **HTTP paths** for generate / list / get / revoke. §9 only: REST mirrors MCP (`/api/v1/tasks` 等) + 「Web 端专用的档案管理」. Agent Key management is named as a Web UI concern (§4), not as a path.
4. **JSON field** that carries the one-time plaintext on create, and the JSON fields for list/get (whether `last_used_at` is in the HTTP body).
5. **Bearer header format** beyond 「Bearer API Key」. Typical `Authorization: Bearer <key>` is **not** written. Header name, extra scheme (`token` vs `Bearer`), case, and `Bearer` vs `bearer` are unspecified.
6. **Which REST routes** the Bearer middleware attaches to in this slice. MCP tools are #10. `/api/v1/tasks*` is #7/#9. Existing `/api/v1/me` is **session** (302/401). Binding Bearer onto `/api/v1/me` would change the #3 contract; DESIGN does not say to do that. A dedicated probe path is unnamed.
7. **Revoke representation:** DELETE the `agent_keys` row vs a revoked column. Table has no revoked field.
8. **`agent_keys` primary key / `created_at`.** Implied later by `leases.agent_key_id`; not in the §10 cell.
9. **Uniqueness of `label` per `user_id`.** Multiple keys are implied by a `label` column; uniqueness is not stated.
10. **When `last_used_at` ticks:** any Bearer success? only MCP tools? including failed auth? DESIGN names the column; #4 says it 更新.
11. **SQL type / timezone** of `last_used_at` (unix integer vs ISO text vs SQLite `CURRENT_TIMESTAMP`).
12. **401 body** for 错误 key. Existing session JSON errors use `{ error: 'unauthorized' }` (code, not DESIGN).
13. **Pending-user denial copy** when generating a key. #3 pending message is about 认领, not keys: `你的账号待正式成员批准后方可认领任务。`
14. **Whether GitHub `claim_only` after approve may list/revoke their own keys** — matrix only names 生成. 自助吊销 is §11 for 「用户」generally.

#### Vault / profiles / events (#5)

1. **Master-key environment variable name.** §7 「环境变量/密钥文件」; §12 「主密钥经环境变量注入」; README: no `.env.example`. Existing env names are unprefixed (`SESSION_SECRET`, `OAUTH_*`, `SQLITE_PATH`, `PORT`, `HOST`, `PUBLIC_URL`).
2. **Key-file path** if the file alternative is used. Unnamed.
3. **AES-256-GCM wire format** inside `token_encrypted` (nonce, ciphertext, tag, encoding).
4. **HTTP paths** for profile CRUD and 审计查询. §9: 「Web 端专用的档案管理、审计查询」only.
5. **`scopes_checked` type** (JSON array of `读`/`推`/`PR`? boolean? text?).
6. **Whether creating a profile calls `validateToken`.** §5 发布即校验 is publish/import time (#7). The column `scopes_checked` exists anyway. Calling the adapter on profile create is **not** written. Server today does **not** depend on `@kaola/forge-adapters`.
7. **`created_by` type** (integer `users.id` vs username string).
8. **`forge` enum** on `credential_profiles` — implied `github|gitlab|gitea` by the rest of DESIGN, not printed on this row.
9. **Profile primary key vs `profile_id` slug** (`cp-gitea-orders`).
10. **Uniqueness** of `(forge, base_url, repo_full_name)`.
11. **Exact Chinese UI string** for 「提示去 forge 侧撤销」. DESIGN/issue require the prompt; they do not give the sentence.
12. **Event column identifiers** for 类型 / 主体 / 时间 / 详情.
13. **`变更` as an event 类型.** #5 asks to write 变更 into `events`; §10’s closed list does not include it.
14. **详情 JSON shape** for 「谁的哪个 Agent Key、何时、拿走了哪个档案的 token」. Prose, not keys.
15. **Reveal API without `claim_task`.** Unnamed. Product reveal **is** `claim_task`.
16. **One-off override storage without `tasks.inline_token_encrypted`.** Unnamed.
17. **Whether `credential_profiles` rows are team-global or filtered by `created_by` on list.**

#### Shared / docs (do not quietly expand)

1. Putting Agent Key or vault types in `@kaola/shared`. DESIGN §12 puts 「类型、任务卡 schema（zod）、状态机」in `packages/shared`. Vault is a server component (§4). Task Brief `credential` is already `{ profile_id }` only. **DESIGN does not require key/vault types in shared.**
2. New root `package.json` `"test"` file names (see Write surfaces). No glob.

---

### 7. How `last_used_at` and plaintext-once can be observed with current Fastify `inject`

Measured from `apps/server/src/auth.test.ts` and `apps/server/src/app.ts`. Not a prescribed API.

**App construction**

- `buildApp(options?: { sqlitePath?: string })` creates `createDb(options?.sqlitePath ?? ':memory:')`, registers `GET /` + `registerAuth`, returns the Fastify instance. **Does not export `db`.**
- Each `buildApp()` is an isolated in-memory SQLite unless `sqlitePath` is a file.
- Tests: `await app.ready()` then `t.after(() => app.close())`. `onClose` closes `db.$client`.

**Session cookie jar (existing)**

```
function cookieJar(response) {
  const jar = {}
  for (const cookie of response.cookies) {
    jar[cookie.name] = cookie.value
  }
  return jar
}
```

Login: stub `@fastify/oauth2` `getAccessTokenFromAuthorizationCodeFlow`, stub `globalThis.fetch` userinfo, `app.inject({ method: 'GET', url: callback + '?code=...' })`, pass `cookies` into later `inject`. JSON calls set `headers: { accept: 'application/json' }`.

Env: tests mutate `process.env` (`SESSION_SECRET`, `OAUTH_*`, `PUBLIC_URL`) **before** importing `buildApp`. A new required env (master key) would collide with this global fixture style if `registerAuth` (or a new register) throws on empty — **name still UNSPECIFIED**.

**Bearer `inject` (pattern that exists in Fastify; no current test uses it)**

`app.inject({ method, url, headers: { authorization: '…' }, cookies? })`. Wrong/revoked key → assert `statusCode === 401` (#4). **The `url` is UNSPECIFIED** until a Bearer-protected route exists. Do not assume `/api/v1/me` accepts Bearer: today it is session-only (`getSessionUser` via `request.session.userId`).

**`last_used_at` observation paths that exist without inventing HTTP fields**

1. **HTTP, if list/get JSON includes `last_used_at`** (that field-on-the-wire is UNSPECIFIED): session `inject` create → session `inject` list (expect empty/null) → Bearer `inject` on a protected route → session `inject` list again (expect a timestamp). `better-sqlite3` writes are synchronous; Fastify `inject` is `await`ed; no fake clock exists in `auth.test.ts`. Tests can assert “was missing, then present” rather than an exact clock. Format of the value is UNSPECIFIED.
2. **SQLite file:** `buildApp({ sqlitePath: tempfile })` then a second `better-sqlite3` handle `SELECT last_used_at, key_hash FROM agent_keys`. This uses the **existing** `sqlitePath` option; it does not require exporting `db`. `:memory:` cannot be opened from a second connection.
3. **In-process `db` export** does not exist today. Adding it would be a new surface.

**Plaintext-once observation (issue #4; DESIGN 「只存哈希」)**

1. Create response **must** include the plaintext (acceptance: 只在创建时显示一次). Exact JSON key UNSPECIFIED.
2. A later list/get of the same key **must not** include that plaintext. Requires a list/get route (path UNSPECIFIED).
3. SQLite: `key_hash` column must not equal the plaintext; a dump of the row must not contain the plaintext as a substring. Algorithm unspecified, so tests cannot pin a digest without a later decision.
4. `docs/conventions.md` also forbids tokens in logs / non-claim responses — claim responses are #9.

Revoke: create → capture plaintext → revoke (path UNSPECIFIED) → same Bearer `inject` → 401, with no delay (「即时生效」). Isolated per-app DB means no cache-invalidation across processes to measure.

---

### 8. `events` types: what this run needs vs what DESIGN lists

DESIGN §10 closed list: **状态迁移 / token 揭示 / 心跳 / 回写**.

| Type | In DESIGN §10? | Product trigger in DESIGN | This run (#4/#5) |
|------|----------------|---------------------------|------------------|
| `token 揭示` | yes | `claim_task` success (§7); 详情 prose 「谁的哪个 Agent Key、何时、拿走了哪个档案的 token」 | **In scope as a type this vault must be able to record** (#5 acceptance). The **product call** that reveals is `claim_task` (#9/#10), out of this run. Tension: type vs trigger. |
| 变更 (issue word) | **no** | #5: profile CRUD / 「所有揭示/变更」 | #5 asks to write 变更. Not a DESIGN enum member. Flag for `technical-decisions.md`. |
| `状态迁移` | yes | task lifecycle (§5) | **Out of scope** (needs `tasks`) |
| `心跳` | yes | `report_progress` / leases | **Out of scope** |
| `回写` | yes | comment on source Issue (M2) | **Out of scope** |

#4 does **not** mention `events`. Generating/revoking an Agent Key is not a named event type.

#8 (board timeline) wants events 发布/认领/心跳/提交/完结 — different labels, later issue, out of this run.

---

## Current tree

Worktree and main: **identical at `2e280c9`**. Product code cited below is under the worktree path; the same files exist at the repo root.

### Root `package.json` test script (explicit file list)

```
"test": "node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts"
```

CI (`.github/workflows/ci.yml`) runs `pnpm test`, so it only executes those five files. **New test files are invisible until root `package.json` `"test"` is edited.** There is no glob. Name new files so the orchestrator can add them; do not assume discovery.

Other root scripts: `lint` → `eslint .`; `typecheck` → `pnpm -r --if-present typecheck`; `build` → `pnpm -r --if-present build`. `packageManager` `pnpm@11.19.0`; `engines.node` `>=22`. No root `pnpm dev`.

`pnpm-workspace.yaml`: `apps/*` + `packages/*`.

### `apps/server`

| File | What is there |
|------|----------------|
| `src/schema.ts` | **Only** `users`. Columns: `id` integer PK autoincrement; `provider` `github\|gitlab\|gitea`; `remote_id`; `username`; `display_name`; `status` `active\|待批准`; `permission_level` `full\|claim_only`; UNIQUE `(provider, remote_id)`. Exports `User`, `UserProvider`. **No** `agent_keys` / `credential_profiles` / `events`. |
| `src/db.ts` | `USERS_DDL` `CREATE TABLE IF NOT EXISTS users (...); UNIQUE (provider, remote_id)`. `createDb(path=':memory:')` → `better-sqlite3` + `sqlite.exec(USERS_DDL)` + `drizzle(sqlite, { schema: { users } })`. **No drizzle-kit**, no `drizzle.config.*`. Type `AppDb`. |
| `src/app.ts` | `buildApp({ sqlitePath? })`: Fastify, `GET /` placeholder, `registerAuth(app, db)`, `onClose` closes sqlite. **No Bearer hook.** |
| `src/index.ts` | `buildApp({ sqlitePath: process.env.SQLITE_PATH ?? ':memory:' })`, listen `PORT`/`HOST`. |
| `src/auth.ts` | Session OAuth (`@fastify/cookie`, `@fastify/session`, `@fastify/oauth2`). `GET /login`, `/login/{github\|gitlab\|gitea}` + callbacks. `GET /api/v1/me` (session; JSON 401 or 302 `/login`). `POST /api/v1/users/:id/approve` (actor `active`+`full`). Pending message `你的账号待正式成员批准后方可认领任务。`. Session field `userId?: number`. **No Authorization Bearer parsing.** |
| `src/auth.test.ts` | `app.inject` + cookie jar + oauth decorator stub + `fetch` userinfo stub. Does not query SQLite. Does not send `Authorization`. |
| `src/placeholder.ts` / `placeholder.test.ts` | `GET /` body `考拉任务服务占位`. |
| `package.json` | Deps: `fastify`, `drizzle-orm`, `better-sqlite3`, `@fastify/cookie`, `@fastify/oauth2`, `@fastify/session`. **No** `@kaola/shared`, **no** `@kaola/forge-adapters`, **no** `@fastify/auth` / bearer plugin, **no** crypto library (Node `node:crypto` is available on Node 22 and **unused**). Scripts: `start` / `dev` (`node --experimental-strip-types`). `tsconfig.json` **excludes** `src/**/*.test.ts`. |

`createDb` is the entire DDL surface. Adding tables means extending `schema.ts` **and** a `CREATE TABLE IF NOT EXISTS` string in `db.ts` (the bundle-3-6 pattern).

### `apps/web`

| File | What is there |
|------|----------------|
| `src/App.vue` | No vue-router. Views: `login` (three forge buttons), `pending` (`status === '待批准'`), `member` (everyone else). Approve-by-id only if `status === 'active'` && `permission_level === 'full'`. Fetches `GET /api/v1/me` with `credentials: 'include'`, `Accept: application/json`. **No Agent Key UI. No credential profile UI. No audit UI.** |
| `src/main.ts` | `createApp(App)`, `app.use(naive)`, mount. |
| `vite.config.ts` | proxy `/api` and `/login` → `http://127.0.0.1:3000`. |
| `package.json` | `vue` `^3.5.0`, `naive-ui` `^2.45.0`. **No vue-router, no HTTP client package** (`fetch` in `App.vue`). |

`canApprove` is the only permission gate in the UI. A GitHub user who is `active` + `claim_only` already lands on `member` workbench (not pending) — that is the screen where 生成 Agent Key would appear; 管理凭证档案 must stay hidden for that actor per §11.

### `packages/shared`

`taskBriefSchema.credential`: **`{ profile_id: string }` only (strict)**. Tests reject `token` on the brief, `credential: { token }`, and `credential: { profile_id, token }`. No Agent Key types, no vault types, no event types.

DESIGN does not require those types here. Expanding `credential` to carry a raw token would **break** existing tests and contradict §6 「Agent 侧不含 token」.

### `packages/forge-adapters`

`createForgeAdapter` / `validateToken` implemented (GET-only permission proxy). `Credential = { token: string }` — **plaintext token in memory**, not a profile id. Vault must decrypt then pass `{ token }` into `validateToken` if it calls the adapter; it must **not** reimplement 读/推/PR probes. Server does not import this package today. #5 acceptance does not name `validateToken`; #7 does (发布即校验).

### Docs vs code

- `docs/DESIGN.md` v0.2 is the contract.
- `docs/api.md`: HTTP surface is placeholder + OAuth + `/api/v1/me` + approve. 「Task CRUD, vault, and claim HTTP are not implemented.」 Env names: unprefixed `SESSION_SECRET`, `OAUTH_*`, `SQLITE_PATH`, `PUBLIC_URL`, `PORT`, `HOST`.
- `docs/architecture.md`: 「MCP / vault / tasks not implemented」; server does not import forge-adapters.
- `docs/decisions/`: `.gitkeep` only; **no ADR files**.
- `README.md`: Agent Key / 凭证档案 listed as not implemented. Login matrix already matches §11 (GitHub ✗ for 发布/凭证管理).
- `docker-compose.yml`: `PORT`/`HOST` only; volume `kaola-data:/data` unused (`SQLITE_PATH` still default `:memory:`). No master-key env.

### Env vars that **do** exist in code (do not invent others in this file)

| Name | Where | Default / required |
|------|--------|-------------------|
| `SQLITE_PATH` | `index.ts` / `createDb` | `':memory:'` |
| `PORT` | `index.ts`, compose, Dockerfile | `3000` |
| `HOST` | same | `0.0.0.0` |
| `SESSION_SECRET` | `registerAuth` | required nonempty |
| `OAUTH_GITHUB_CLIENT_ID` / `OAUTH_GITHUB_CLIENT_SECRET` | `registerAuth` | required |
| `OAUTH_GITLAB_CLIENT_ID` / `OAUTH_GITLAB_CLIENT_SECRET` / `OAUTH_GITLAB_BASE_URL` | `registerAuth` | required |
| `OAUTH_GITEA_CLIENT_ID` / `OAUTH_GITEA_CLIENT_SECRET` / `OAUTH_GITEA_BASE_URL` | `registerAuth` | required |
| `PUBLIC_URL` | `registerAuth` | `http://localhost:3000` |

Master-key name: **UNSPECIFIED**. Do not treat `SESSION_SECRET` as the vault key; DESIGN never says that.

---

## Write surfaces

Directories either issue can own, plus shared foot-guns. **Disjoint tables; shared files.**

### Shared files (both issues will touch; coordinate)

| Path | Why both |
|------|----------|
| `apps/server/src/schema.ts` | #4 adds `agent_keys`; #5 adds `credential_profiles` + `events`. Same Drizzle module. `users` stays. |
| `apps/server/src/db.ts` | Both add `CREATE TABLE IF NOT EXISTS` next to `USERS_DDL`; both must appear in `drizzle(..., { schema: { ... } })`. |
| `apps/server/src/app.ts` | Both register routes/hooks on the same `buildApp()`. |
| `apps/web/src/App.vue` | #4: 个人 Agent Key 管理 on the member workbench. #5: 凭证档案 CRUD + 吊销提示. Same single-file UI (no router). Permission gates differ (§11). |
| root `package.json` `"test"` | New test **files** are a shared write. CI will not see them otherwise. |

`apps/server/src/auth.ts` is #4-adjacent (session user for “who may generate”) and #5-adjacent (session user for “who may manage profiles”). Bearer middleware is #4. Whether Bearer lives in `auth.ts` or a new server file is **UNSPECIFIED** (file split is not a DESIGN identifier). Existing `/api/v1/me` and approve contracts must not be silently redefined.

### #4 (Agent API keys + Bearer) — own these tables / behaviors

| Path / concern | Why |
|----------------|-----|
| Table `agent_keys` | §10. Columns named above. |
| Web 自助生成/吊销 | §11 + #4. Gate: 认领任务 / 生成 Agent Key matrix. Pending GitHub denied; approved GitHub `claim_only` allowed; GitLab/Gitea `full` allowed. |
| Hashed storage | `key_hash` only; plaintext once on create. |
| Bearer middleware | #4 goal: MCP/REST. MCP tools themselves are #10 — middleware can exist without the six tools; **protected URL is UNSPECIFIED**. |
| `last_used_at` | #4 acceptance. |

#4 does **not** need `credential_profiles`, AES, or `events` per its own text.

### #5 (vault + profiles + events) — own these tables / behaviors

| Path / concern | Why |
|----------------|-----|
| Table `credential_profiles` | §10. |
| Table `events` | §10 + #5. Types in DESIGN: see §8 of this note. |
| AES-256-GCM encrypt/decrypt | §7. Master key from env (name UNSPECIFIED). |
| Profile CRUD + 一键吊销 UI copy | §7 + #5. Gate: 发布任务 / 管理凭证档案 matrix — GitHub ✗. |
| Call into `createForgeAdapter`/`validateToken` **if** a later decision says profile create probes | Do not copy probe logic. Server currently has **no** package dependency on `@kaola/forge-adapters` (`apps/server/package.json`). Adding that dependency is a coordinated write if chosen. |
| Not `tasks.inline_token_encrypted` | Column is on `tasks`; tension recorded. |

#5 does **not** need to implement Agent Key generate/revoke, but 揭示审计 names 「谁的哪个 Agent Key」— a `user_id`/`agent_key_id` on an event 详情 would **read** #4’s table. Order: `agent_keys` must exist before a reveal event can name a key. That is a data dependency, not a permission to implement `claim_task`.

### Must not casually write

| Path | Why |
|------|-----|
| `packages/shared/src/index.ts` | Shipped Task Brief contract. `credential: { profile_id }` only. Neither issue’s DESIGN pointer puts keys/vault types here. |
| `packages/forge-adapters/src/` except **calling** `validateToken` | Probe implementation is #6, done. Vault must not reimplement 读/推/PR. |
| `docs/DESIGN.md` | Project rule: do not change DESIGN contracts as a side effect of scaffolding. |
| `tasks` / `leases` / `submissions` schema | #7 / #9 / #11. |
| MCP SDK / six tools | #10. |
| Task board / posting forms beyond profile + key widgets | #7 / #8. |

**Placeholder `GET /`:** stays public `考拉任务服务占位` (`placeholder.test.ts`). Unauthenticated redirect applies to 受保护页面; `GET /` is still the public placeholder.

### Disjointness summary

```
#4  →  agent_keys + Bearer middleware + Web Agent Key self-service
#5  →  credential_profiles + events + AES-256-GCM vault + Web profile CRUD / 吊销提示
share → schema.ts, db.ts, app.ts, App.vue, root package.json test list
leave alone unless a later mission says so → packages/shared, docs/DESIGN.md, tasks/leases/MCP
coordinate → apps/server/package.json if #5 adds @kaola/forge-adapters; root test file list
```

Suggested **test file locations** (pattern only, names not in DESIGN): existing tests sit next to the module (`apps/server/src/auth.test.ts`). New files under `apps/server/src/*.test.ts` will **not** run until listed in root `"test"`. `apps/server/tsconfig.json` excludes `src/**/*.test.ts` from `tsc` (same as today).

---

## Out of scope (this run must NOT build)

From the parent prompt and from DESIGN/issue split:

| Item | Owner issue | DESIGN locus |
|------|-------------|--------------|
| Task CRUD, 发布表单, 发布即校验 on a task | #7 | §5, §6, `tasks` |
| `tasks` table including `credential_profile_id` / `inline_token_encrypted` | #7 (column) / this run’s tension | §10 `tasks` |
| Task board UI (list/kanban/timeline) | #8 | §4 |
| `claim_task`, leases, heartbeat, expiry, release, reveal-on-claim **product** path | #9 | §5, §7, `leases` |
| MCP Server + six tools | #10 | §9 |
| `submit_pr` + PR polling | #11 | §5, §8 `getPullRequest` |
| `submissions` table | #11 | §10 |
| Webhook signatures | not this bundle | §11 Webhook |
| M3 人确认认领 / 审计日志**界面** as a product milestone | #16 / M3 | §13 M3 「审计日志界面」— #5 writes `events` rows; M3 is the audit **UI**. §4 already lists 审计日志 as a Web concern; #5 acceptance is 每次揭示均有审计**记录**, not the M3 screen. |
| Reimplement forge 读/推/PR probes | done in #6 | §8 `validateToken` |

`list_tasks` / `get_task_brief` must never contain token — that constraint is DESIGN §7 and #9; this run must not add token fields to those (unimplemented) responses either.

---

## Adjacent issue comments (not overrides of #4/#5)

- #9 comment `5356076134`: 认领即授权; pending claim must be denied **and not reveal**; claim response includes clone guidance. Applies to #9, not this body.
- #7 body (no comment fetched as override): both 档案下拉 **and** 单任务临时 token paths at **posting** time.

---

## Sources

- `docs/DESIGN.md` §2 D3/D7/D8, §4 Token Vault / Web 职责, §5 发布即校验 / `claim_task`, §6 `credential.profile_id`, §7 full, §8 `validateToken` (do not reimplement), §9 MCP + 「档案管理、审计查询」, §10 tables quoted in full, §11 matrix + Bearer, §12 主密钥经环境变量注入, §13 M1 vs M3
- GitHub issue #4 body + workflow-start comment 5359483905 (no override)
- GitHub issue #5 body + workflow-start comment 5359484970 (no override)
- Adjacent: #7, #8, #9 (+ comment 5356076134), #10, #11 titles/bodies for out-of-scope
- Prior decisions: `kaola-workflow/archive/bundle-3-6/.cache/technical-decisions.md` (naming/env/test style to reuse; **not** DESIGN)
- Worktree files listed under Current tree, commit `2e280c912b8e68df9a482eba9c8a89bc22315865`
