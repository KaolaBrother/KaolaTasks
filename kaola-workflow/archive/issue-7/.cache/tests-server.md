# tests-server — `apps/server/src/tasks.test.ts` (issue #7)

**Artifact:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7/apps/server/src/tasks.test.ts`
**Wired into:** worktree root `package.json` `test` script (appended after `apps/server/src/vault.test.ts`).
**Baseline:** `b8f27d91d4e8b17c9e2120b41244e5ea7dc81a48` (plus the uncommitted worktree changes that
were already present when I started: `docs/DESIGN.md` §6 update, `apps/server/package.json`
workspace deps, `packages/shared/src/index.test.ts`, `pnpm-lock.yaml`).
**Full verbatim baseline capture:** `kaola-workflow/issue-7/.cache/tests-server-baseline.txt` (1214 lines).

I wrote tests only. I did not create or modify `tasks.ts`, `schema.ts`, `db.ts`, or `app.ts`.

---

## 1. Baseline proof

```
$ CI=true node --experimental-strip-types --test apps/server/src/tasks.test.ts
ℹ tests 59
ℹ suites 12
ℹ pass 0
ℹ fail 59
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 418.819667
```

**59 tests, 0 pass, 59 fail.** Not one test passes before the implementation exists.

Representative failure signatures, verbatim:

```
test at apps/server/src/tasks.test.ts:528:5
✖ unauthenticated JSON GET/POST/PATCH return 401 unauthorized (33.320375ms)
  AssertionError [ERR_ASSERTION]: GET list: 404 {"message":"Route GET:/api/v1/tasks not found","error":"Not Found","statusCode":404}

  404 !== 401

test at apps/server/src/tasks.test.ts:548:5
✖ browser-like GET /api/v1/tasks redirects to /login (2.737542ms)
  AssertionError [ERR_ASSERTION]: GET list as browser: 404 {"message":"Route GET:/api/v1/tasks not found","error":"Not Found","statusCode":404}

  404 !== 302

test at apps/server/src/tasks.test.ts:757:5
✖ a token missing 推 and PR is refused with 422 and names both capabilities (2.066334ms)
  AssertionError [ERR_ASSERTION]: POST: 404 {"message":"Route POST:/api/v1/tasks not found","error":"Not Found","statusCode":404}

  404 !== 422

test at apps/server/src/tasks.test.ts:1386:5
✖ SQLite refuses a row with BOTH credential columns set (3.164ms)
  AssertionError [ERR_ASSERTION]: POST /api/v1/tasks: 404 {"message":"Route POST:/api/v1/tasks not found","error":"Not Found","statusCode":404}

  404 !== 201
```

Note the 404/401 and 404/404 traps: every "not found" and "unauthorized" test asserts the **body**
(`error === 'not_found'` / `'unauthorized'`) as well as the status, so Fastify's own
`{"error":"Not Found"}` 404 cannot make them pass by accident.

### Nothing else broke

```
$ CI=true pnpm test
ℹ tests 233   ℹ pass 174   ℹ fail 59
```

The 59 failures are exactly mine. Every pre-existing suite (including `tests-shared`'s new
`parseTaskBrief credential union` block) still passes:

```
$ CI=true node --experimental-strip-types --test packages/shared/src/index.test.ts \
    packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts \
    apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts \
    apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts
ℹ tests 174   ℹ pass 174   ℹ fail 0
```

`CI=true pnpm lint` is clean (`eslint .`, no output).

---

## 2. The HTTP surface these tests demand

All five routes live behind a `registerTasks(app, db)` registered in `buildApp` **after**
`registerCredentialProfiles(app, db)` (it needs `request.session`). Signature must match the house
form: synchronous, non-async, void-returning, `(app: FastifyInstance, db: AppDb)`.

Wire format is **snake_case**; internals camelCase; bodies hand-parsed from `unknown` (no zod at the
HTTP boundary, no Fastify schema) — same as `credential-profiles.ts`.

### 2.1 `POST /api/v1/tasks` → `201` + brief

Request body (snake_case). Required: `title` (non-empty), `repo.forge`, `repo.base_url`,
`repo.full_name`, `credential`. Everything else optional with the defaults in §2.6.

```jsonc
{
  "title": "为订单导出接口增加分页",
  "description_md": "……（Markdown 详述）",
  "source": { "type": "native" },
  // or { "type": "imported", "issue_url": "https://gitea.internal.example/team/orders/issues/87" }
  "repo": {
    "forge": "gitea",                      // github | gitlab | gitea
    "base_url": "https://gitea.forge.example.test",
    "full_name": "team/orders",
    "base_branch": "main",                 // optional, default "main"
    "suggested_dir": "orders"              // optional, default = last segment of full_name
  },
  "acceptance_criteria": ["…", "…"],
  "test_command": "pnpm test",
  "constraints": { "allowed_paths": ["src/api/**"], "forbidden_paths": ["migrations/**"] },
  "priority": "P1",                        // P0 | P1 | P2 | P3
  "tags": ["backend", "api"],
  "credential": { "profile_id": 3 }        // XOR  { "token": "<one-off forge token>" }
}
```

- `credential` is a **request-side** union with exactly one of two keys:
  `{ profile_id }` (number **or** numeric string — both accepted, both tested) or
  `{ token: "<non-empty string>" }`. Both keys at once, neither, `{}`, `{ inline: true }` with no
  token, or `{ token: "" }` → `400 invalid_body`.
- `id`, `pr_convention`, `poster`, `status`, `created_at` in the request are **ignored** — the
  server owns them. (Pinned: a body carrying `id: "kt-1999-0001"`, `status: "已完成"`,
  `poster: "someone.else"`, an evil `pr_convention` and a 1999 `created_at` must still produce a
  server-generated id, `待认领`, the session user's username, a derived `pr_convention` and a
  current `created_at`. Ignoring unknown keys matches the existing hand-parsed readers.)

Response `201` is the §6 brief itself (see §2.5), never a wrapper.

### 2.2 `GET /api/v1/tasks` → `200 { "tasks": [ <brief>, … ] }`

Returns **all** tasks, unfiltered (including `已取消`). No ordering is pinned — the tests look tasks
up by id, not by index. No `?status=` filter is specified or tested; do not add one for #7.

### 2.3 `GET /api/v1/tasks/:public_id` → `200` + brief

Addressed by **public_id only** (`GET /api/v1/tasks/kt-2026-0142`). Must **not** use
`parsePositiveInt`. `1`, `0`, `-1`, `not-a-task`, `kt-2026-9999` all → `404 { error: 'not_found' }`.

### 2.4 `PATCH /api/v1/tasks/:public_id` → `200` + updated brief

Body: `{ "status": "已取消" }`. This is the **poster's** cancel/reopen endpoint and permits exactly
three transitions:

| from | to |
|---|---|
| `待认领` | `已取消` |
| `已退回` | `已取消` |
| `已退回` | `待认领` |

Anything else → `409 illegal_transition`, including `待认领 → 进行中` (legal in
`transitionTaskStatus`, but claim territory, not a poster edit) and `已取消 → 待认领`.
A refused transition must leave the task unchanged and write **no** audit event.

### 2.5 Response brief — exactly the DESIGN §6 key set

```
id, title, description_md, source, repo, acceptance_criteria, test_command,
constraints, pr_convention, credential, priority, tags, poster, status, created_at
```

`assertBriefShape` pins `Object.keys(brief).sort()` against exactly that list **and** runs the real
`parseTaskBrief` from `@kaola/shared` over it. Any extra key fails twice (key-set mismatch and
`z.strictObject`). Field-by-field:

| field | value |
|---|---|
| `id` | the public_id, `kt-YYYY-NNNN` |
| `pr_convention` | derived: `{ branch_prefix: \`kaola/${id}-\`, title_prefix: \`[${id}] \` }` |
| `credential` | `{ profile_id: String(credential_profile_id) }` — a **decimal string**, `z.string()` — or `{ inline: true }` |
| `poster` | the session user's `users.username` (not the id) |
| `status` | `待认领` on create |
| `created_at` | ISO-8601 **with** offset; `Math.floor(Date.parse(created_at)/1000)` must equal the stored integer |

### 2.6 Defaults for a minimal body

```
description_md      -> ""
source              -> { "type": "native" }
repo.base_branch    -> "main"
repo.suggested_dir  -> last "/" segment of repo.full_name   ("team/orders" -> "orders")
acceptance_criteria -> []
test_command        -> ""
constraints         -> { "allowed_paths": [], "forbidden_paths": [] }
priority            -> "P2"
tags                -> []
status              -> "待认领"
```

### 2.7 Status codes and exact bodies

| Status | Body | When |
|---|---|---|
| `201` | the brief | create succeeded |
| `200` | `{ tasks: [...] }` / the brief | list / get / patch |
| `302` → `/login` | — | unauthenticated **non**-JSON `Accept` (use `sendUnauthorized`) |
| `400` | `{ error: 'invalid_body' }` | any body-shape violation; also a bad PATCH `status` |
| `400` | `{ error: 'invalid_body', message: '所选凭证档案不存在。' }` | `credential.profile_id` names no row |
| `401` | `{ error: 'unauthorized' }` | JSON request with no session |
| `403` | `{ error: 'forbidden' }` | not `active`+`full` on POST/PATCH; or PATCH by a non-poster |
| `404` | `{ error: 'not_found' }` | unknown public_id on GET-one / PATCH |
| `409` | `{ error: 'illegal_transition', message: … }` | PATCH transition not permitted |
| `422` | `{ error: 'token_check_failed', missing: [...], message: … }` | 发布即校验 verdict is non-empty |
| `500` | `{ error: 'vault_unconfigured' }` | `VAULT_MASTER_KEY` absent — **both** credential paths |
| `502` | `{ error: 'forge_unreachable', message: … }` | `validateToken` **rejected** |

### 2.8 The exact Chinese strings asserted on

```ts
const TOKEN_INVALID_MESSAGE     = 'token 无效或无权访问该仓库，任务未发布。'
const FORGE_UNREACHABLE_MESSAGE = '无法连接 forge 校验 token，任务未发布。'
const PROFILE_MISSING_MESSAGE   = '所选凭证档案不存在。'

// missing.join('、') — the adapter's array order is 读, 推, PR and is deterministic.
tokenInsufficientMessage(missing) => `token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。`
illegalTransitionMessage(from, to) => `任务状态不允许从「${from}」变更为「${to}」。`
```

Concrete strings pinned literally in the suite (copy these, character for character — note the
regular spaces around the ASCII words and the full-width 。、「」):

```
token 权限不足：缺少 推、PR 权限，任务未发布。
token 权限不足：缺少 PR 权限，任务未发布。
token 无效或无权访问该仓库，任务未发布。
无法连接 forge 校验 token，任务未发布。
所选凭证档案不存在。
任务状态不允许从「待认领」变更为「已完成」。
任务状态不允许从「待认领」变更为「进行中」。
任务状态不允许从「已取消」变更为「待认领」。
```

**Selection rule for the two token messages** (this is the load-bearing distinction):
`missing.includes('读')` → `TOKEN_INVALID_MESSAGE`; otherwise the `权限不足` message naming exactly
the missing capabilities. A test explicitly asserts the all-missing case does **not** produce
`token 权限不足：缺少 读、推、PR 权限，任务未发布。`.

---

## 3. 发布即校验 — how the route must call the adapter

```ts
import { createForgeAdapter } from '@kaola/forge-adapters'   // already a workspace dep, already linked
const adapter = createForgeAdapter(repo.forge, { baseUrl: repo.base_url })
let check
try {
  check = await adapter.validateToken({ token: plaintext }, { full_name: repo.full_name, base_url: repo.base_url })
} catch {
  return reply.code(502).send({ error: 'forge_unreachable', message: FORGE_UNREACHABLE_MESSAGE })
}
if (check.missing.length > 0) { /* 422, see §2.7/§2.8 */ }
```

- There is **no** standalone `validateToken` export (CLAUDE.md is wrong about this). The only path
  is `createForgeAdapter(kind, options).validateToken(cred, repo)`.
- `validateToken` has **no try/catch and no timeout**. Network failure or a non-JSON body makes the
  promise **reject** with a `TypeError('fetch failed')` — it does not degrade to `{ missing: [...] }`.
  The `try/catch` above is mandatory; that is exactly what the 502 test drives.
- **The profile path is validated too.** The token to validate comes from decrypting
  `credential_profiles.token_encrypted`, so the profile path needs the vault before it can
  validate — which is why the `vault_unconfigured` test covers both paths.
- **A refused post persists nothing.** Three tests assert the board is still empty afterwards
  (`一个校验失败的任务不会出现在看板上`, DESIGN §5).

I verified my stub payloads against the **real** adapter before pinning the expected arrays:

```
REPO_FULL_ACCESS         => missing: []
REPO_READ_ONLY           => missing: ["推","PR"]
REPO_NO_PULL_REQUESTS    => missing: ["PR"]
userStatus 401           => missing: ["读","推","PR"]
repoStatus 404           => missing: ["读","推","PR"]
unreachable              => rejected: TypeError "fetch failed"
```

---

## 4. Storage the tests read directly

Table `tasks`, read by raw SQL in the suite — these names are pinned:

```
id, public_id, status, poster_user_id, credential_profile_id, inline_token_encrypted, created_at
```

- `public_id TEXT NOT NULL UNIQUE` — `kt-YYYY-NNNN`. A test does
  `UPDATE tasks SET public_id = <other task's> …` and requires it to throw `/UNIQUE/i`, so the
  UNIQUE constraint must be real, not handler-side.
- `created_at INTEGER` — unix **seconds** (`typeof(created_at)` must be `'integer'`), matching
  `events.created_at` / `agent_keys.last_used_at`. The ISO string is a projection.
- `poster_user_id INTEGER` — asserted equal to the session user's id on the inline-path row.
- **The 二选一 invariant must be a real SQLite `CHECK` constraint**, not just handler discipline.
  Two tests take an existing row and try to break it:
  - `UPDATE tasks SET credential_profile_id = 1 WHERE public_id = ?` on an inline row → must throw
  - `UPDATE tasks SET inline_token_encrypted = NULL WHERE public_id = ?` on an inline row → must throw

  Both assert against `/CONSTRAINT|CHECK/i`. A `CHECK ((credential_profile_id IS NULL) != (inline_token_encrypted IS NULL))`
  satisfies this. A trigger using `RAISE(ABORT, '…')` would **not** match the regex.
  I used UPDATE rather than a raw INSERT deliberately: an INSERT would couple the test to your
  full column list and could pass for the wrong reason (a NOT NULL error instead of the CHECK).
- Registration is the usual three edits: `schema.ts` `sqliteTable`, a `TASKS_DDL` +
  `sqlite.exec(TASKS_DDL)` in `createDb`, and `tasks` added to the `drizzle(sqlite, { schema: … })`
  map. The tests open a **second** `createDb(sqlitePath)` connection, so the DDL must be in
  `createDb` (not run once at app boot).

Audit rows go through the existing `insertAuditEvent(db, { type, actorUserId, details })`:

```jsonc
{ "type": "状态迁移", "actor_user_id": <poster id>, "details": { "task_id": "kt-2026-0001", "from": "待认领", "to": "已取消" } }
```

`details.task_id` is the **public_id string**, and `details` keys are snake_case (house convention).
Assertions are **filter-based** (`type === '状态迁移' && details.task_id === id && details.to === to`,
count `=== 1`), so you are free to also log task creation — the tests do not forbid it.
Do **not** use `变更` for status changes; that label belongs to credential-profile CRUD.

---

## 5. How I solved the fetch-stub collision

`vault.test.ts` / `agent-keys.test.ts` replace `globalThis.fetch` with a userinfo-only stub that
answers **500 to any unrecognised Authorization header**. 发布即校验 needs the same global hook for
forge-API calls, so a second stub would clobber the first.

My seam is **one router keyed on the bare token identity**, not on the URL:

```
beginFetch(t) -> { oauth: Map<accessToken, profileJson>, forge: Map<forgeToken, descriptor> }
```

`stubbedToken(input, init)` extracts the credential from any of the three header forms the codebase
actually emits — `Authorization: Bearer <t>` (auth.ts userinfo and the GitHub adapter),
`Authorization: token <t>` (Gitea adapter), `PRIVATE-TOKEN: <t>` (GitLab adapter) — and the router
dispatches: `forge` hit → forge-API response, `oauth` hit → userinfo, otherwise a loud 500 with the
URL and token in the body. Registration is explicit per test, so an unexpected outbound call can
never pass silently.

Two further belts:
- Task repos live on `FORGE_BASE_URL = 'https://gitea.forge.example.test'`, a **different origin**
  from the Gitea OAuth provider `GITEA_BASE_URL = 'https://gitea.example.test'`, so the two
  `/api/v1/user` endpoints cannot collide even by URL.
- Endpoint classification checks `/repos/` or `/projects/` **first**, then `endsWith('/user')`, so a
  repo named `.../repos/team/user` cannot be misread as the user endpoint.

I verified the extractor and the classifier against the exact header objects `auth.ts` and all three
adapter branches pass to `fetch` — 10/10 cases correct.

`login{Gitlab,Gitea,Github}(app, stub, label)` take the router object instead of the bare profiles
Map; otherwise the login/session helpers are `vault.test.ts`'s verbatim.

---

## 6. Judgement calls the implementer must respect

Each of these was undetermined by code or by the settled decisions. I picked one, and the suite now
pins it. If you disagree with any, raise it — do not quietly implement something else, and do not
edit the test to match the code.

1. **`PATCH` (not `POST /cancel` + `POST /reopen`).** One endpoint taking `{ status }` covers both
   poster actions and maps straight onto `transitionTaskStatus(from, to)`. DESIGN §9's REST mapping
   is about MCP tools; cancel/reopen are Web-side poster actions with no MCP tool.
2. **PATCH permits only the three poster transitions.** `待认领 → 进行中` is legal in the shared
   state machine but is claim territory (MCP, lease), and `待验收 → 已完成` belongs to the PR
   webhook — DESIGN §5 says 验收在 forge 上完成. Both are `409 illegal_transition` here.
3. **Only the 发布者 may PATCH.** DESIGN §5 says 发布者取消 / 发布者重新开放. Another `active` +
   `full` member gets `403 forbidden`.
4. **Reading the board is open to every authenticated user, including `待批准` GitHub users.**
   DESIGN §11's table gives 查看任务板 ✓ to GitHub login with **no** "需先通过首登批准" caveat
   (that caveat attaches only to 认领任务 / 生成 Agent Key). This is deliberately looser than
   `credential-profiles.ts`, which 403s a pending user on GET. Posting and patching use the
   `active` + `full` gate (`canManageProfiles`'s predicate).
5. **`credential.profile_id` in the brief is a decimal string** (`String(row.credentialProfileId)`),
   because `taskBriefSchema.profile_id` is `z.string()` and `tests-shared` pins that a number is
   rejected. The request accepts a number **or** a numeric string; the response always renders a
   string.
6. **`pr_convention` is derived, never accepted.** DESIGN §6: 分支前缀与标题前缀由它派生. The
   derivation is exactly the §6 example: `kaola/<id>-` and `[<id>] `.
7. **`created_at`: unix seconds in SQLite, ISO-8601 in the brief.** I verified empirically that
   `z.iso.datetime({ offset: true })` accepts the bare-`Z` form, so
   `new Date(sec * 1000).toISOString()` parses (the ground-truth note left this UNVERIFIED — it is
   now verified). The test's regex also accepts a `+08:00`-style offset if you prefer that.
8. **`public_id` counter policy is left open.** The tests pin the `kt-YYYY-NNNN` shape, the year
   segment being the current year, uniqueness, and a strictly increasing sequence within a run.
   Per-year reset and a global counter both pass. Behaviour past `9999` is not tested.
9. **The request `credential` union is `{ profile_id }` XOR `{ token }`** — the request needs to
   carry the actual one-off token, while the brief must never contain token material. So the
   request-side shape is deliberately *not* the brief-side shape (`{ inline: true }`). A request
   carrying a bare `{ inline: true }` with no token is `400 invalid_body`.
10. **Defaults exist for a minimal body** (§2.6). Nothing in DESIGN specifies them; `priority: 'P2'`
    and `test_command: ''` in particular are my picks. The full-body path is the primary contract —
    one test pins the minimal path.
11. **Unknown `profile_id` → `400 invalid_body` + `'所选凭证档案不存在。'`**, not a 404 (a 404 on
    `POST /api/v1/tasks` reads as "route not found") and not a new error code.
12. **`422` for the token verdict, `502` for an unreachable forge.** 502 follows the existing
    `auth.ts` precedent for a failed upstream call; 422 keeps a semantic-validation failure distinct
    from `400 invalid_body`. Both are new status codes for this codebase.
13. **A client-supplied `id` / `status` / `poster` / `pr_convention` / `created_at` is ignored, not
    rejected** — consistent with every existing hand-parsed body reader, which only reads the keys
    it knows.
14. **Task repo vs. profile repo mismatch is unspecified.** My tests always use matching values, so
    either choice passes. Out of scope for #7 — don't add a rule the suite doesn't pin.
15. **No placeholder-pin test.** `GET /` returning `考拉任务服务占位` is already guarded by
    `vault.test.ts` and `agent-keys.test.ts`; including it here would have been a test that passes
    at baseline.
16. **`已退回` is reached in tests by direct SQL** (`forceStatus`), because no route reaches
    `待验收` / `已退回` until `submit_pr` and webhooks land. This is a test-side fixture, not a
    demand on your implementation.

---

## 7. Every test name

### `authentication and DESIGN §11 permissions`
1. unauthenticated JSON GET/POST/PATCH return 401 unauthorized
2. browser-like GET /api/v1/tasks redirects to /login
3. 待批准 GitHub user may read the board (§11 查看任务板 ✓) but not post
4. approved GitHub claim_only user may read the board but not post or patch
5. only the 发布者 may cancel — another active full member gets 403

### `POST /api/v1/tasks — 凭证档案下拉选择 path`
6. profile path creates a 待认领 task whose credential is { profile_id }
7. profile_id is accepted as a number and as a numeric string
8. an unknown profile_id is refused with 400 invalid_body and a Chinese message

### `POST /api/v1/tasks — 单任务临时 token path`
9. inline token path creates a 待认领 task whose credential is { inline: true }
10. inline token is stored as ciphertext and recoverable through the vault
11. both credential paths return 500 vault_unconfigured without VAULT_MASTER_KEY

### `发布即校验 — DESIGN §5`
12. a token missing 推 and PR is refused with 422 and names both capabilities
13. a token that can push but cannot open PRs is refused naming only PR
14. a 401 token is refused with the token-invalid message, not the 权限不足 one
15. a token with no access to the repo is refused with the token-invalid message
16. an unreachable forge is a DIFFERENT outcome: 502 with its own Chinese message
17. the profile path is validated too — an under-scoped profile token is refused

### `任务卡字段完整符合 §6 schema`
18. a full request body round-trips every DESIGN §6 field
19. pr_convention is derived from the public id, per DESIGN §6
20. a client-supplied pr_convention or id or status is ignored — the server owns them
21. an imported source round-trips issue_url; a native source carries only type
22. a minimal request body is completed with the documented defaults
23. created_at is ISO-8601 with offset and matches the stored unix seconds
24–36. POST with … returns 400 invalid_body — 13 parameterised cases:
   no title · an empty title · no repo · an unknown forge · no repo.full_name ·
   an unknown priority · an unknown source type · an imported source without issue_url ·
   no credential · an empty credential · both credential forms at once ·
   a bare inline marker and no token · an empty inline token

### `public_id — kt-YYYY-NNNN`
37. public_id has the kt-YYYY-NNNN form and carries the current year
38. public ids are distinct and their sequence increases
39. public_id is UNIQUE in SQLite

### `token secrecy — DESIGN §7`
40. no create/list/get response carries the inline token in any field
41. no create/list/get response carries the profile token in any field

### `GET /api/v1/tasks and GET /api/v1/tasks/:public_id`
42. list returns every task under a tasks key, each a §6 brief
43. get by public_id returns exactly the brief that create returned
44. an unknown public_id returns 404 not_found
45. a numeric-looking id returns 404 not_found — tasks are addressed by public_id only

### `PATCH /api/v1/tasks/:public_id — 取消 / 重新开放`
46. 待认领 → 已取消 by the poster returns the updated brief
47. 已退回 → 待认领 reopens the task
48. 已退回 → 已取消 by the poster
49. an illegal transition 待认领 → 已完成 returns 409 with a Chinese message
50. 待认领 → 进行中 is claim territory, not a poster edit: 409 illegal_transition
51. 已取消 is terminal — 已取消 → 待认领 returns 409
52. an unknown status value returns 400 invalid_body
53. PATCH on an unknown public_id returns 404 not_found

### `audit — 状态迁移 events (DESIGN §10)`
54. cancelling writes one 状态迁移 event naming the task, from, to and actor
55. reopening writes a 状态迁移 event from 已退回 to 待认领
56. a refused transition writes no 状态迁移 event

### `tasks table invariants (DESIGN §10: credential_profile_id / inline_token_encrypted 二选一)`
57. the profile path stores credential_profile_id and leaves inline_token_encrypted NULL
58. SQLite refuses a row with BOTH credential columns set
59. SQLite refuses a row with NEITHER credential column set

---

## 8. Token-secrecy assertion, for reference

`assertNoTokenMaterial` runs against the **serialized** response body, not field by field:

```js
// 1. substring scan of res.body for each plaintext token
// 2. recursive key scan rejecting any of: token, token_encrypted, inline_token_encrypted, access_token
```

It is applied to create, list and get responses for **both** credential paths, and to the 422/502
rejection bodies too.
