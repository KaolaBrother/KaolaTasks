# Design measure: bundle-3-6 (#3 OAuth/users, #6 ForgeAdapter validateToken)

Measured from worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6` at commit `e01b5b2c325ba515514114bb9abe8edac9a26809` (`e01b5b2 chore: archive issue-2 [sink]`). Main checkout `/Users/ylpromax5/Workspace/KaolaTasks` is the same commit. No implementation in this note.

Issue sources (GitHub `KaolaBrother/KaolaTasks`):

- [#3](https://github.com/KaolaBrother/KaolaTasks/issues/3) body + comments. **Comment `5356075800` (2026-08-20) overrides the body** on identity-source cardinality and permission model. The later workflow-start comment does not change acceptance.
- [#6](https://github.com/KaolaBrother/KaolaTasks/issues/6) body. The only comment is workflow-start; it does not override the body.

---

## Measured facts

### Issue override (read this before DESIGN D6)

**#3 body (still in force except the pick-one identity source):**

- Goal text: configurable identity source, **self-hosted GitLab or Gitea pick-one**; `users` table `(provider / remote_id / username / 显示名)` and session management.
- Acceptance still standing: OAuth login callback works for a configured identity source; users row persisted and session usable; **unauthenticated access to protected pages is redirected**.
- Design pointer: `docs/DESIGN.md` §10 §11.

**#3 comment that wins** (`https://github.com/KaolaBrother/KaolaTasks/issues/3#issuecomment-5356075800`):

> 设计更新（DESIGN.md v0.2 §11，本评论覆盖正文）：改为**多源 OAuth + 分级权限**，不再二选一身份源。
> - GitLab / Gitea（自托管）登录 = 团队身份 → 完整权限（发布 / 认领 / 凭证管理）。
> - GitHub 登录 = 仅认领；首次登录进入**待批准**状态，任一正式成员在 Web 端一键批准后方可认领 / 生成 Agent Key。
> - users 表增加：状态（active / 待批准）、权限级（full / claim_only）。
> - 验收补充：待批准用户访问认领相关能力被拒并有中文提示；批准流程可用。

So #3 ships **three OAuth sources**, not pick-one. Body fields `provider / remote_id / username / 显示名` plus comment fields **状态** and **权限级** are all in scope. Body still requires **session management** and **unauthenticated → redirect**.

**#6 body (no overriding comment):**

- Define `ForgeAdapter` and implement `validateToken` on GitHub / GitLab / Gitea: empirically readable repo, pushable branch, creatable PR/MR. GitLab/Gitea support custom `baseUrl`.
- Acceptance: one shared test spec green on all three (mock or recorded responses OK); missing permissions returned as **structured missing items (读 / 推 / PR)**; **same-repo push** (prerequisite for a claimant with no forge account) is covered by validation.
- Design pointer: `docs/DESIGN.md` §7 §8.

DESIGN.md header (v0.2, 2026-08-20) matches the #3 comment, not the #3 body: 「v0.2 增补：多源登录分级权限、认领即授权、Agent 侧 token 卫生、无 forge 账号认领者」.

Internal DESIGN tension (do not “fix” D6 in code; follow D8 / §11 / #3 comment):

| | Text | File |
|--|------|------|
| D6 | 「通过团队自有 forge 的 OAuth 登录（GitLab 或 Gitea）」 | `docs/DESIGN.md` §2 |
| D8 | 「多源 OAuth：GitLab/Gitea（自托管）= 完整权限；GitHub = 仅认领，且首次登录需任一正式成员批准；发布任务与凭证管理仅限自托管身份」 | `docs/DESIGN.md` §2 |

### 1. `users` table — DESIGN.md §10 and §11

§10 table row, quoted in full:

> `users` | forge OAuth 身份（provider, remote_id, username）、显示名、状态（active / 待批准）、权限级（full / claim_only）

**Identifiers that appear as English tokens in that cell:**

| Token | Role in the sentence |
|-------|----------------------|
| `users` | table name |
| `provider` | forge OAuth identity |
| `remote_id` | forge OAuth identity |
| `username` | forge OAuth identity |
| `active` | one of two 状态 values |
| `待批准` | the other 状态 value (Chinese label used as the enum member) |
| `full` | one of two 权限级 values |
| `claim_only` | the other 权限级 value |

**Chinese labels in that cell with no English column name:**

| Label | Adjacent values |
|-------|-----------------|
| 显示名 | none |
| 状态 | `active` / `待批准` |
| 权限级 | `full` / `claim_only` |

#3 body independently lists `provider / remote_id / username / 显示名`. #3 comment independently repeats 状态 (`active` / `待批准`) and 权限级 (`full` / `claim_only`).

§11 capability matrix (not extra columns; behavior of 权限级 + 状态):

> | 能力 | GitLab / Gitea 登录（自托管 = 团队身份） | GitHub 登录 |
> |------|------------------------------------------|-------------|
> | 查看任务板 | ✓ | ✓ |
> | 发布任务 / 管理凭证档案 | ✓ | ✗ |
> | 认领任务 / 生成 Agent Key | ✓ | ✓（需先通过首登批准） |

§11 prose that binds GitHub first login to `待批准`:

> GitHub 账号任何人都能注册，而认领即 token 揭示，故 GitHub 登录首次进入"待批准"状态，由任一正式成员在 Web 端一键批准后方可认领。同一人多账号在 MVP 中视为多个用户，如有需要后续加身份关联。

§7 restates the claim denial for pending GitHub users:

> "待批准"状态的 GitHub 登录用户无法认领（见 §11）。

§11 also states: 「首次登录自动建号，权限按登录来源分级」and 「无独立账号体系」.

Implied but **not named as columns**: other tables reference a user (`agent_keys.user_id`, `leases.claimer_user_id`, `credential_profiles.created_by`). §10 does not list `users.id`, `created_at`, email, or avatar.

§10 does **not** list a sessions table. The #3 body still requires 「会话管理」; DESIGN never names a session relation.

§9 mentions OAuth only as 「Web 端专用的档案管理、审计查询、OAuth 回调等接口」— no path, no verb, no cookie.

### 2. `ForgeAdapter` TypeScript — DESIGN.md §8

Quoted in full from `docs/DESIGN.md` §8:

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

§8 bullets that are not in the interface body:

- Three implementations live in `packages/forge-adapters`, **one shared integration-test spec** (same assertions, three backends).
- GitLab / Gitea constructors receive `baseUrl`; GitHub is fixed `api.github.com` (future GHE would be another `baseUrl`).
- Unreachable webhooks → poll `待验收` PR status.

`kind` uses the same three literals as `@kaola/shared` `taskBriefSchema.repo.forge` (`github` | `gitlab` | `gitea`). That enum already exists in code (see Current tree). DESIGN does not say the adapter must import it from `@kaola/shared`.

#### Methods on the §8 interface vs what #6 must ship

| Method | On §8 interface? | #6 acceptance? | DESIGN milestone |
|--------|------------------|----------------|------------------|
| `validateToken` | yes | **yes** — this is the issue | M1 「发布即校验」 (§13) |
| `importIssue` | yes | no | M2 (§13) |
| `getPullRequest` | yes | no | M1 polling of PR state is later issues; method exists on the interface now |
| `registerWebhook?` | yes, **optional** (`?`) | no | M2 |
| `parseWebhook` | yes | no | M2 |
| `commentOnIssue` | yes | no | M2 「状态回写源 Issue」 |

#6 text: 「定义 `ForgeAdapter` 接口并实现 … 三份 `validateToken`」. The interface as printed includes the other five members; the **acceptance checkboxes only cover `validateToken` + shared spec + structured 读/推/PR + same-repo push**. This note does not decide whether unimplemented members are stubs, omitted, or typed-only.

#### Named types with no definition in DESIGN.md

| Type | Where named | Later section imply a shape? | Verdict |
|------|-------------|------------------------------|---------|
| `Credential` | §8 method args | **Not the adapter type.** §6 Task Brief `credential` is `{ profile_id }` only. §7 describes 凭证档案 (forge + 仓库, reusable token, optional one-off override). §10 `credential_profiles`: `forge`、`base_url`、`repo_full_name`、`token_encrypted`、`scopes_checked`、`created_by`. None of those is declared as TypeScript `Credential`. Adapter input is **unspecified**. | unspecified TS shape |
| `RepoRef` | §8 `validateToken` / `registerWebhook?` | §6 `repo` object: `forge`, `base_url`, `full_name`, `base_branch`, `suggested_dir`. §8 also passes constructor `baseUrl` separately from `RepoRef`. Whether `RepoRef` equals §6 `repo` is **not stated**. | unspecified; §6 is a candidate, not a definition |
| `TokenCheck` | §8 `validateToken` return | §8 comment only: `// 可读？可开 PR？` (push is **missing from this comment**). §5 and §7 require three empirical checks including push (see §3 below). #6 requires 「结构化的缺失项（读/推/PR）」. **No field names, no `ok` flag, no array key.** | unspecified TS fields |
| `ImportedIssue` | §8 `importIssue` return | §6 imported `source` is `{ type: "imported", issue_url }`. Mapping from a forge issue to a Task Brief is not typed. M2. | unspecified |
| `PrStatus` | §8 `getPullRequest` return | The only shape is the **inline comment** `// open/merged/closed`. §5 maps PR 开了 → 待验收, 合并 → 已完成, PR 被关闭 → 已退回. That is lifecycle, not a `PrStatus` object. | implied string union `open` \| `merged` \| `closed` from the comment only; no object fields |
| `ForgeEvent` | §8 `parseWebhook` return | §4/§5 mention webhook vs poll. No event discriminant, no payload fields. | unspecified |
| `IssueRef` | §8 `commentOnIssue` | No later section names `IssueRef`. §6 has `issue_url` on imported source. | unspecified |
| `Headers` | §8 `parseWebhook` first arg | Not defined in DESIGN. Name matches the Web `Headers` type; that identification is not in the document. | unspecified in DESIGN |

Do not invent `TokenCheck` keys such as `canRead`, `missing`, `permissions`, `ok`. They do not appear in DESIGN.md or in current code.

### 3. Token-validation rules — DESIGN.md §5 and §7 (plus §8 comment)

**§5 「发布即校验」** (the board never lists a task whose token failed):

> 任务发布/导入时，适配层用所附 token 实测权限（能否读仓库、能否推分支、能否创建 PR）。token 失效或权限不足的任务不会出现在看板上。

Three empirical checks, Chinese: 读仓库 / 推分支 / 创建 PR.

**§7 「无账号认领者（token 即访问权）」** — same-repo push, not fork:

> 认领者**不需要**在目标 forge 上有账号。Agent 用揭示的 token 走 HTTPS clone、向**同一仓库**推分支（不走 fork——fork 才需要账号）、再用同一 token 调 API 开 PR/MR。因此发布校验必须包含"能否推分支"。

Same paragraph’s recommended token kinds (not `TokenCheck` fields): GitLab Project Access Token（Developer，`api` + `write_repository`）/ Gitea 仓库 token / GitHub fine-grained PAT.

**§8 `validateToken` comment is narrower than §5/§7:**

> `validateToken(cred: Credential, repo: RepoRef): Promise<TokenCheck>   // 可读？可开 PR？`

Push is required by §5 and §7 and by #6, but **not** mentioned in that one-line comment. Later TDD should treat §5/§7 and #6 as the check list, not the truncated comment.

**#6 structured missing items:** 「权限不足时返回结构化的缺失项（读/推/PR）」. DESIGN never names the property that holds those items.

**#6 same-repo coverage:** 「无 forge 账号认领者场景可行的前提（推分支到同仓库）被校验覆盖」. That is §7’s 同一仓库 / 不走 fork rule, not a new type.

§7 also: AES-256-GCM, master key from 「环境变量/密钥文件」— **no env var name**. Vault work is not #6; do not invent a key name while implementing adapters.

### 4. Auth behavior that #3 must match (DESIGN + winning comment)

From §11 + D8 + #3 comment, without extra columns:

| Login source | 状态 on first login | 权限级 | 查看任务板 | 发布 / 凭证档案 | 认领 / 生成 Agent Key |
|--------------|---------------------|--------|------------|-----------------|------------------------|
| GitLab or Gitea (self-hosted) | not stated as `待批准`; D8/§11 treat as 团队身份 / 完整权限 | `full` | yes | yes | yes |
| GitHub | `待批准` until a 正式成员 approves | `claim_only` (cannot 发布 / 管理凭证 even after approve) | yes | no | only after approve |

#3 comment extra acceptance: pending users denied **认领相关能力** with **中文提示**; **批准流程可用**. Exact prompt string is not in DESIGN or the comment.

#3 body extra acceptance: unauthenticated access to **受保护页面** redirects. No route list exists in DESIGN or in `apps/web`.

§11 Agent path (out of #3 UI, but related): 「Bearer API Key，用户在 Web 端自助生成/吊销，服务端只存哈希」. Generating Agent Key is gated by the matrix above.

§11 Webhook signatures (not #3/#6): GitHub HMAC, Gitea/GitLab secret token.

### 5. Other §10 tables (so they are not silently reused as `users` fields)

Quoted from §10:

> | `agent_keys` | user_id、key_hash、label、last_used_at |
> | `credential_profiles` | forge、base_url、repo_full_name、token_encrypted、scopes_checked、created_by |
> | `tasks` | §6 各字段 + status、credential_profile_id / inline_token_encrypted（二选一） |
> | `leases` | task_id、claimer_user_id、agent_key_id、claimed_at、expires_at、last_heartbeat、state |
> | `submissions` | task_id、lease_id、pr_url、summary、pr_state |
> | `events` | 审计与时间线：类型（状态迁移 / token 揭示 / 心跳 / 回写）、主体、时间、详情 JSON |

None of these is a session table. None of these is in #3/#6 acceptance except that #3 creates `users` so later FKs have a target.

---

## Unspecified (do not invent)

Later TDD/implementer must not fill these with guessed names. They are open questions, not proposed defaults.

### Users / OAuth / session (#3)

1. **SQL column names** for 显示名, 状态, 权限级 (DESIGN gives Chinese labels + mixed-language enum **values**, not `display_name` / `status` / `permission_level`).
2. **Primary key / timestamps** on `users` (`id`, `created_at`, …).
3. **Uniqueness**: implied by 「forge OAuth 身份」and 「同一人多账号在 MVP 中视为多个用户」, but no unique `(provider, remote_id)` constraint is written down.
4. **显示名 source**: which OAuth profile field (name, username, full_name, login, …) is not stated.
5. **GitLab/Gitea first-login 状态**: §11 spells `待批准` only for GitHub. It never says the self-hosted first row is `active`. Implied by 团队身份, not specified.
6. **「正式成员」predicate** for the approve button: not a column. Not defined as `full` + `active`, “any non-pending user”, or “any GitLab/Gitea user”.
7. **Session table / store**: absent from §10. #3 body still requires 会话管理.
8. **Session cookie name**, cookie flags, TTL, CSRF, OAuth `state` storage.
9. **OAuth client env var names** (client id/secret, redirect URI, GitLab/Gitea instance URL for OAuth). README.md: 「仓库没有 `.env.example`；主密钥 / OAuth 尚未实现」. DESIGN §7/§12: 主密钥经环境变量注入 — **no name**.
10. **OAuth callback URL path**. §9 only says 「OAuth 回调等接口」.
11. **Approve HTTP path / MCP vs Web**. 「Web 端一键批准」only.
12. **Protected page list** and redirect target (login URL). No vue-router, no routes.
13. **Exact Chinese copy** for pending-user denial. Comment only requires 「中文提示」.
14. **How `claim_only` is stored vs derived** from `provider === 'github'` — both 权限级 column and login-source matrix exist; DESIGN does not say one is computed from the other.
15. **Config for three IdPs at once** (three client apps vs one). Comment says 多源, not how they are configured.
16. **Self-hosted OAuth `baseUrl` vs adapter `baseUrl`**: two different uses; no config key for the IdP base URL.

### ForgeAdapter / TokenCheck (#6)

1. **`TokenCheck` field names** and whether success is a boolean, a list of missing 读/推/PR items, or both.
2. **How to encode the three missing items** (Chinese 读/推/PR vs English read/push/PR). Issue uses Chinese; DESIGN uses 读仓库 / 推分支 / 创建 PR. No identifier.
3. **`Credential` TypeScript shape** (plaintext token? profile id + vault lookup? `{ token, baseUrl }`?).
4. **`RepoRef` TypeScript shape** (whether it includes `forge`, `base_url`, `full_name`, `base_branch`).
5. **Constructor signatures** beyond 「GitLab / Gitea 构造时接收 `baseUrl`」.
6. **Whether GitHub `baseUrl` is typed at all** (fixed `api.github.com` in prose).
7. **How same-repo push is probed** (create+delete a branch? dry-run? permission API?). Not in DESIGN. Probe HTTP details belong to a library lookup, not this file.
8. **Whether the TypeScript interface in M1 includes `importIssue` / `getPullRequest` / webhooks / `commentOnIssue`** or only `validateToken`. DESIGN prints all of them; #6 ships validateToken.
9. **`Headers`, `ForgeEvent`, `IssueRef`, `ImportedIssue` bodies**.
10. **HTTP client / Octokit / gitlab SDK package names** — not in DESIGN, not in `packages/forge-adapters/package.json` (that package currently has **no runtime dependencies**).

### Env vars that **do** exist in code (do not invent others)

| Name | Where | Default |
|------|--------|---------|
| `SQLITE_PATH` | `apps/server/src/db.ts` | `':memory:'` |
| `PORT` | `apps/server/src/index.ts`, `docker-compose.yml`, `apps/server/Dockerfile` | `3000` |
| `HOST` | same | `0.0.0.0` |

Compose does not set `SQLITE_PATH`. Volume `kaola-data:/data` is declared and unused by the default path.

---

## Current tree

Worktree and main: **identical at `e01b5b2`**. Product code cited below is under the worktree path; the same files exist at the repo root.

### Root `package.json` test script (explicit file list)

```
"test": "node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts apps/server/src/placeholder.test.ts"
```

CI (`.github/workflows/ci.yml`) runs `pnpm test`, so it only executes those three files. New test **files** require a root `package.json` edit unless they replace/extend a listed file.

Other root scripts: `lint` → `eslint .`; `typecheck` → `pnpm -r --if-present typecheck`; `build` → `pnpm -r --if-present build`. `packageManager` `pnpm@11.19.0`; `engines.node` `>=22`. No root `pnpm dev`.

`pnpm-workspace.yaml`: `apps/*` + `packages/*`.

### `apps/server`

| File | What is there |
|------|----------------|
| `src/app.ts` | `buildApp()`: Fastify, **only** `GET /`, `text/plain; charset=utf-8`, body from `getPlaceholderBody()`. No auth plugin, no cookie, no OAuth routes. |
| `src/placeholder.ts` | `getPlaceholderBody()` → `'考拉任务服务占位'` |
| `src/placeholder.test.ts` | pins that string; comment forbids duplicating it in the route |
| `src/index.ts` | imports `db`, `db.$client.prepare('select 1').get()`, then `app.listen({ port, host })` |
| `src/db.ts` | **drizzle-orm/better-sqlite3** `createDb(path = ':memory:')` → `drizzle(sqlite)` with **no schema argument**. Module singleton `db = createDb(process.env.SQLITE_PATH ?? ':memory:')` |
| `package.json` | `@kaola/server`. Deps: `better-sqlite3` `^12.2.0`, `drizzle-orm` `^0.44.4`, `fastify` `^5.4.0`. **No** `@kaola/shared`, **no** `@kaola/forge-adapters`, **no** `@fastify/cookie` / session / oauth. Scripts: `start` / `dev` (`node --experimental-strip-types` / `--watch`), `typecheck`/`build` = `tsc --noEmit`. |
| `Dockerfile` | `node:22-bookworm-slim`, `pnpm install --frozen-lockfile`, `CMD pnpm --filter @kaola/server start` |
| schema / drizzle-kit | **none** (no `schema.ts`, no `drizzle.config.*`) |

`createDb` is the entire DB surface. Tables are not declared.

### `apps/web`

| File | What is there |
|------|----------------|
| `src/App.vue` | Naive UI `n-config-provider` / `n-card title="考拉任务"` / `n-text` 「占位界面」. Empty `<script setup lang="ts">`. |
| `src/main.ts` | `createApp(App)`, `app.use(naive)`, `mount('#app')`. **No vue-router.** |
| `index.html` | `lang="zh-CN"`, title 考拉任务 |
| `vite.config.ts` | `@vitejs/plugin-vue` only; no proxy, no port override |
| `package.json` | `vue` `^3.5.0`, `naive-ui` `^2.45.0`. **No vue-router, no HTTP client.** |

No login view, no route guards, no approve UI.

### `packages/forge-adapters`

| File | What is there |
|------|----------------|
| `src/index.ts` | **only** `getForgeAdaptersHealth(): string` → `'kaola-forge-adapters-ready'` |
| `src/index.test.ts` | pins that string |
| `package.json` | `@kaola/forge-adapters`, export `"."` → `./src/index.ts`. **No runtime dependencies.** No `ForgeAdapter` type. |

### `packages/shared` (already has forge enum)

`packages/shared/src/index.ts`:

- `getSharedHealth()` → `'kaola-shared-ready'`
- `taskStatusSchema` / `TaskStatus`: `'待认领' \| '进行中' \| '待验收' \| '已完成' \| '已退回' \| '已取消'`
- `taskBriefSchema` **`repo.forge`: `z.enum(['github', 'gitlab', 'gitea'])`**
- `repo` also: `base_url`, `full_name`, `base_branch`, `suggested_dir` (all strings)
- `credential`: **`{ profile_id: string }` only** (strict). Tests reject a raw `token` on the brief or inside `credential`.
- `parseTaskBrief`, `transitionTaskStatus`
- **No user, session, OAuth, `ForgeAdapter`, `TokenCheck`, or `Credential` (adapter) types.**

`packages/shared/src/index.test.ts` already asserts `repo.forge` ∈ `{github, gitlab, gitea}` and rejects `bitbucket`.

`packages/shared/package.json`: runtime dep `zod` `^4.4.3` only.

### Docs vs code

- `docs/DESIGN.md` v0.2 is the contract.
- `docs/architecture.md` / `docs/api.md`: HTTP/MCP/adapters unimplemented; shared schema documented; forge-adapters still health-only.
- `docs/conventions.md`: Chinese UI copy; English identifiers; one shared adapter spec; tokens never in logs / non-claim responses.
- `docs/decisions/`: index links it; **no ADR files** in the tree.
- `README.md` login matrix already matches §11 (GitHub claim-only + first-login approval). README also records no `.env.example`.

---

## Write surfaces

Directories either issue can own without colliding, plus the one shared foot-gun (`packages/shared` and root `package.json` test list).

### #3 (OAuth + user model) — own these

| Path | Why |
|------|-----|
| `apps/server/src/` except the existing placeholder body contract | users schema via drizzle, OAuth callback, session, approve, auth gate. `createDb` already lives here with no schema. |
| `apps/server/package.json` | OAuth/session Fastify plugins would be server deps. Today: fastify + drizzle + better-sqlite3 only. |
| `apps/web/src/` | login, redirect of unauthenticated visits, pending Chinese copy, member approve control. No router yet. |
| `apps/web/package.json` | only if a router/client is added for those pages. |

#3 does **not** need to implement `ForgeAdapter` or `validateToken`. Login OAuth is identity; adapter token probe is #6.

### #6 (ForgeAdapter + validateToken) — own these

| Path | Why |
|------|-----|
| `packages/forge-adapters/src/` | §8: 「三份实现放在 `packages/forge-adapters`」. Keep `getForgeAdaptersHealth`. Add interface + three `validateToken` + shared spec. |
| `packages/forge-adapters/package.json` | currently no runtime deps; HTTP/SDK deps belong here if #6 needs them. |

#6 does **not** need `apps/server` or `apps/web` for its acceptance. Server will consume the package in later credential/publish issues.

### Must not casually write: `packages/shared`

Shared **already** encodes `repo.forge` as `github | gitlab | gitea`. That is the Task Brief contract (#2 / DESIGN §6), not the adapter interface.

| If someone… | Effect |
|-------------|--------|
| Changes `taskBriefSchema.repo.forge` | Breaks the existing shared test pin of the §6 example. **Neither #3 nor #6 needs this.** |
| Adds `ForgeAdapter` / `TokenCheck` / adapter `Credential` to shared | Moves §8 types out of `packages/forge-adapters` (where DESIGN places implementations). Not required. Duplicating the three `kind` literals in the adapter package matches §8 as printed. |
| Adds user 状态 / 权限级 enums to shared so web+server import them | A **new** shared contract. DESIGN §10 puts `users` under Drizzle/SQLite, not under the Task Brief package. Optional and **not specified**. Prefer server-owned schema unless a later decision says otherwise. |
| Makes `forge-adapters` depend on `@kaola/shared` only to reuse the forge enum | New package edge. Today forge-adapters has zero runtime deps. Not required for #6. |

**Warning:** if either issue edits `packages/shared/src/index.ts`, it is expanding a shipped M0 contract. Default: **do not**.

### Overlap to plan, not to invent APIs

1. **Root `package.json` `"test"` file list.** #6 can keep using `packages/forge-adapters/src/index.test.ts` (already listed). #3 can extend `apps/server/src/placeholder.test.ts` only by crowding unrelated tests into the placeholder file. Adding new test files **is a shared write** on root `package.json` (and is how CI will see them). Coordinate that edit; do not each assume glob discovery — there is none.
2. **`docs/DESIGN.md`**: project rule — do not change DESIGN contracts as a side effect of scaffolding. Doc docking is a later mission (`README.md` / `CHANGELOG.md` / `docs/architecture.md` / `docs/api.md`).
3. **Placeholder HTTP body** `'考拉任务服务占位'` is pinned by `apps/server/src/placeholder.test.ts`. #3 should not replace `GET /` with an authenticated-only root unless tests and docs are updated on purpose. Unauthenticated redirect applies to **受保护页面**, which are unspecified; `GET /` is currently the public placeholder.

### Disjointness summary

```
#3  →  apps/server (users, OAuth, session, approve) + apps/web (login, redirect, 待批准 copy)
#6  →  packages/forge-adapters (interface + validateToken ×3 + shared spec)
leave alone unless a later mission says so → packages/shared, docs/DESIGN.md
coordinate → root package.json test script if new test files appear
```

---

## Sources

- `docs/DESIGN.md` §2 D6/D8, §5 发布即校验, §6 repo/credential JSON, §7 凭证与无账号认领者, §8 ForgeAdapter, §9 OAuth 回调 mention, §10 users, §11 认证, §13 M1/M2
- GitHub issue #3 body + comment 5356075800 (overrides pick-one)
- GitHub issue #6 body
- Worktree files listed under Current tree, commit `e01b5b2c325ba515514114bb9abe8edac9a26809`
