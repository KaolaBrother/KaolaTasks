# Ground truth — issue #20 (structured claim clone recipe)

Measured worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`

- `HEAD` = `0c2d15d53d6ce41b82fd8aa2ebf6028c019b1d50` (`0c2d15d chore: record the workflow claim for issues 20 and 21`) — matches the requested pin.
- `d5fe1b8` (`fix: GitLab OAuth token exchange and publish-form field order`) is an ancestor of `HEAD`. Those changes do not touch claim `clone` construction; this report still measures this tree.

Comments on GitHub issue #20 were empty at investigation time; the issue body (four-key `clone`, forge extra_header table, five-field `repo`, no new MCP tools, server must not run git) is treated as current. This file records **what the tree does now**, not a verdict on #20.

---

## 1. REST claim 201 — where `clone` is built today

**There is no named clone-builder helper.** Construction is an inline object literal inside `claimTask` after decrypt, status transition, lease insert, audit events, and `attemptWriteback`.

Constant (exported):

```34:35:apps/server/src/claim.ts
export const CLONE_TOKEN_USAGE =
  'token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。'
```

Exact `token_usage` string (verbatim, one line, full-width parentheses):

`token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。`

Type of the envelope (`ClaimSuccessBody`):

```82:87:apps/server/src/claim.ts
type ClaimSuccessBody = {
  task: ReturnType<typeof taskBrief>
  token: string
  lease: ReturnType<typeof leaseEnvelope>
  clone: { suggested_dir: string; token_usage: string }
}
```

Object keys today: exactly `suggested_dir` and `token_usage`. No `remote_url`, no `extra_header`.

Build site:

```211:224:apps/server/src/claim.ts
  const brief = taskBrief({ task: updated, posterUsername: row.posterUsername })
  return {
    ok: true,
    httpStatus: 201,
    body: {
      task: brief,
      token: plaintext,
      lease: leaseEnvelope(lease.expiresAt),
      clone: {
        suggested_dir: brief.repo.suggested_dir,
        token_usage: CLONE_TOKEN_USAGE,
      },
    },
  }
```

HTTP wrapper does not rebuild `clone`; it forwards `claimTask`'s result:

```406:411:apps/server/src/claim.ts
    child.post('/api/v1/tasks/:publicId/claim', async (request, reply) => {
      const auth = requireAgentAuth(request, reply)
      if (auth == null) return

      const publicId = (request.params as { publicId: string }).publicId
      return sendAgentResult(reply, await claimTask(db, auth, publicId, readAutonomous(request.body)))
    })
```

`#16` parked claim (`202` `confirmation_required`) returns `pendingConfirmationBody()` — no `clone`, no `token`.

Related helpers in the same file (not used for clone): `leaseEnvelope` (`claim.ts:49-54`), `sendAgentResult` (`claim.ts:78-80`).

---

## 2. MCP `claim_task` — reuse, not a second builder

`mcp.ts` imports `CLONE_TOKEN_USAGE` and `claimTask` from `./claim.ts`.

Tool description interpolates the same constant (hygiene sentence, not a rebuilt `clone` object):

```114:120:apps/server/src/mcp.ts
  server.registerTool(
    'claim_task',
    {
      description: `Claim a task and receive a one-shot forge token. ${CLONE_TOKEN_USAGE} Set autonomous: true when the Agent discovered and initiated this claim itself (not on human instruction) — an untrusted user may then need to confirm it in the web UI before a token is issued.`,
      inputSchema: { task_id: z.string(), autonomous: z.boolean().optional() },
    },
    async (args) => toToolResult(await claimTask(db, authHolder.auth, args.task_id, args.autonomous)),
  )
```

`toToolResult` (`mcp.ts:42-48`) JSON-stringifies `result.body` unchanged. Success `structuredContent` is therefore the same `ClaimSuccessBody` as REST `201`.

**Share-or-duplicate:** one builder (`claimTask` inline object). MCP does not reconstruct `clone`.

Six tools registered (`mcp.ts:91-159`): `list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `release_task`, `submit_pr`. Tests pin the same six names (`mcp.test.ts:37-44`, `842-853`). No seventh tool.

`list_tasks` / `get_task_brief` return `taskBrief(...)` only (`mcp.ts:58-86`) — no `clone` key.

---

## 3. Tests that pin `clone` keys (will break if keys are added without updating helpers)

Three files duplicate the hygiene string locally (they do **not** import `CLONE_TOKEN_USAGE` from `claim.ts`):

| File | Local constant |
|------|----------------|
| `apps/server/src/claim.test.ts:29-30` | same sentence |
| `apps/server/src/mcp.test.ts:32-33` | same sentence |
| `apps/server/src/claim-confirm.test.ts:30` | same sentence (same value; line is the const) |

### Exact key-set assertions (the ones that fail first)

`apps/server/src/claim.test.ts` `assertClaim201`:

```585:595:apps/server/src/claim.test.ts
  assert.deepEqual(Object.keys(body).sort(), ['clone', 'lease', 'task', 'token'])
  assertBriefShape(body.task)
  assert.equal(body.task.status, '进行中')
  assertClaimRevealToken(body, forgeToken)
  assert.deepEqual(Object.keys(body.lease).sort(), ['expires_at', 'ttl_seconds'])
  assert.equal(body.lease.ttl_seconds, TTL_SECONDS)
  assert.equal(body.lease.expires_at, expiresAtIso(nowUnix))
  assert.deepEqual(Object.keys(body.clone).sort(), ['suggested_dir', 'token_usage'])
  assert.equal(body.clone.suggested_dir, suggestedDir)
  assert.equal(body.clone.suggested_dir, body.task.repo.suggested_dir)
  assert.equal(body.clone.token_usage, CLONE_TOKEN_USAGE)
```

Call sites of `assertClaim201` in `claim.test.ts`: `829`, `851`, `936`, `954`, `1105`, `1334`. Named example: `'claiming an inline task returns 201 with task, forge token, lease TTL, and clone guidance'` (`820`).

`apps/server/src/mcp.test.ts` `assertClaimEnvelope`:

```781:791:apps/server/src/mcp.test.ts
  assert.deepEqual(Object.keys(body).sort(), ['clone', 'lease', 'task', 'token'])
  assertBriefShape(body.task)
  assert.equal(body.task.status, '进行中')
  assertClaimRevealToken(body, forgeToken)
  assert.deepEqual(Object.keys(body.lease).sort(), ['expires_at', 'ttl_seconds'])
  assert.equal(body.lease.ttl_seconds, TTL_SECONDS)
  assert.equal(body.lease.expires_at, expiresAtIso(nowUnix))
  assert.deepEqual(Object.keys(body.clone).sort(), ['suggested_dir', 'token_usage'])
  assert.equal(body.clone.suggested_dir, suggestedDir)
  assert.equal(body.clone.suggested_dir, body.task.repo.suggested_dir)
  assert.equal(body.clone.token_usage, CLONE_TOKEN_USAGE)
```

Call site: `'claim_task success envelope keys are exactly task, token, lease, clone with the REST clone pin'` (`1042-1056`).

`apps/server/src/claim-confirm.test.ts` — **two** helpers, both pin two clone keys:

`assertClaim201` (`559-568`) — same `Object.keys(body.clone).sort()` as REST; does **not** assert `clone.suggested_dir === body.task.repo.suggested_dir`.

`assertClaimEnvelope` (`810-819`) — same two-key pin; also omits the `suggested_dir` equality vs `task.repo`.

Call sites include `835`, `846`, `863`, `890`, `1025`, `1105`, `1147`.

### Nested-object leak checks (relevant once `extra_header` exists)

`assertClaimRevealToken` walks `body.task`, `body.lease`, `body.clone` (`claim.test.ts:561-577`, same pattern in `mcp.test.ts:496-508` and `claim-confirm.test.ts:535-551`):

- `JSON.stringify(part)` must not contain the forge plaintext.
- Nested object **keys** must not be in `SECRET_KEY_NAMES` = `{ token, token_encrypted, inline_token_encrypted, access_token }` (`claim.test.ts:51`).

A `value_pattern` of `Bearer ${token}` (literal placeholder) does not add a key named `token`. Interpolating the revealed forge token into `clone` **would** fail `dumped.includes(forgePlaintext)`.

### What does **not** pin clone keys

- `packages/shared/src/index.test.ts` — Task Brief `repo` nested fields only (`REQUIRED_NESTED_FIELDS` `repo.forge|base_url|full_name|base_branch|suggested_dir` at `45-50`). No `clone`.
- Progress/release envelopes: `['lease','task']` / `['task']` (`claim.test.ts:602`, `616`).
- `assertBriefShape` + `parseTaskBrief` on session GET / MCP list/get (`claim.test.ts:507-515`, `mcp.test.ts:434-443`) — 15 brief keys, no `clone`.

`claim_task` description pin (`mcp.test.ts:860-864`): `claim.description.includes(CLONE_TOKEN_USAGE)` — stays valid as long as the sentence is unchanged.

---

## 4. DESIGN.md §7 and §9

File: `docs/DESIGN.md` (v0.2 header at line 3). Headings are `## N. …` (no HTML anchors in source). Typical slug anchors: `#7-凭证与安全模型`, `#9-mcp-工具面`.

### §6 `repo` (five keys — claimed to stay five)

JSONC example `docs/DESIGN.md:114-120`:

```jsonc
  "repo": {
    "forge": "gitea",                // github | gitlab | gitea
    "base_url": "https://gitea.internal.example",
    "full_name": "team/orders",
    "base_branch": "main",
    "suggested_dir": "orders"      // 建议的本地克隆目录名（Agent 可覆盖）
  },
```

### §7 凭证与安全模型 (`docs/DESIGN.md:154-168`)

Clone-related bullets (current wording, not a four-key object):

- **认领时揭示（reveal-on-claim）** (`163`): token only on REST `POST /api/v1/tasks/:publicId/claim` `201` and MCP `claim_task` success; `list_tasks` / `get_task_brief` / session GET list/detail / `POST /api/v1/tasks/import` `200` never contain token. (`GET …/issues` is called out as not a third reveal channel.)
- **Agent 侧 token 卫生** (`165`): `claim_task` 返回中附带使用指引——token 走环境变量或 `git -c http.extraHeader` 按次传递，**不要**拼进 remote URL（会落盘到 `.git/config` 并在任务结束后残留）。
- **无账号认领者** (`167`): Agent 用揭示的 token 走 HTTPS clone… (prose; no `remote_url` / `extra_header` JSON).

No forge extra_header table. No `clone` JSON shape. No `remote_url`.

### §9 MCP 工具面 (`docs/DESIGN.md:215-228`)

`claim_task` row (`223`):

> 建立租约；返回任务卡 + **揭示 token** + 租约 TTL + 克隆指引（`suggested_dir`、token 使用方式）。API Key 即授权，无需二次确认（自主轮询场景见 M3）

Parameters column: `task_id` only (source does not list `autonomous`; implementation and `docs/api.md` do).

Six-tool table; last sentence (`228`): REST 端点一一对应.

§3 (`34`) and architecture mermaid (`66`) mention Agent-side clone/push/PR; they do not define the claim envelope.

---

## 5. `docs/api.md` claim clone documentation

Intro (`docs/api.md:7`): two reveal channels — REST claim `201` top-level `token` and MCP `claim_task` success `token`. Session GET list/one never contain it.

### REST `POST /api/v1/tasks/:publicId/claim` (`182-208`)

`201` exact keys `clone`, `lease`, `task`, `token` (`195`):

- `task` — 15-key Task Brief (`parseTaskBrief`); `credential` remains `{ profile_id }` or `{ inline: true }`
- `token` — forge plaintext
- `lease` — `{ expires_at, ttl_seconds }` with `86400`
- `clone` (`200`): `{ suggested_dir, token_usage }` where `suggested_dir` equals `task.repo.suggested_dir` and `token_usage` is exactly the `CLONE_TOKEN_USAGE` sentence.

`202`: nested objects must not contain keys `token` / `token_encrypted` / `inline_token_encrypted` / `access_token`.

No `remote_url` / `extra_header`.

### MCP table (`250-256`)

`claim_task` success: same envelope as REST claim `201` — keys `clone`, `lease`, `task`, `token`. Tool description includes `CLONE_TOKEN_USAGE` (sentence quoted in full).

---

## 6. README — 「Agent 怎么接单」

Heading: `## Agent 怎么接单` (`README.md:73`).

- MCP endpoint `POST http://localhost:31415/api/mcp` (`75`)
- Six-tool table (`93-102`); `claim_task` row: `认领；成功时返回仓库令牌。自主轮询请设 autonomous: true` — does **not** mention `clone` keys.
- Hygiene paragraph (`104`): clone 时请把令牌放在环境变量或 `git -c http.extraHeader` 里按次传递，**不要写进 remote URL**（会落到 `.git/config`）。
- REST fallback (`106`): `POST /api/v1/tasks/:id/claim` etc.

No `remote_url`, no extra_header table, no `suggested_dir` field name.

`CHANGELOG.md:23-24` still documents two-key clone + `CLONE_TOKEN_USAGE` for #9/#10.

`docs/smoke-test.md:69,79` already names #20 as future (`remote_url` + forge `extra_header`); current smoke clone is Agent-assembled from `repo.*` plus `clone.suggested_dir`.

`docs/architecture.md`: no `clone` / `token_usage` hits.

---

## 7. How `task.repo` exposes `forge`, `base_url`, `full_name`, `suggested_dir` on claim success

Claim success `task` is `taskBrief(...)` (`claim.ts:211`, `216`). Serializer:

```378:393:apps/server/src/tasks.ts
export function taskBrief({ task, posterUsername }: TaskWithPoster) {
  return {
    id: task.publicId,
    ...
    repo: {
      forge: task.repoForge,
      base_url: task.repoBaseUrl,
      full_name: task.repoFullName,
      base_branch: task.repoBaseBranch,
      suggested_dir: task.repoSuggestedDir,
    },
```

Five `repo` keys always present (plus `base_branch`). Same function feeds:

- session `GET /api/v1/tasks` (`tasks.ts:479-484` → `{ tasks: selectTasks(db).map(taskBrief) }`)
- session `GET /api/v1/tasks/:publicId` (`487-496` → `taskBrief(row)`)
- MCP `list_tasks` / `get_task_brief`
- claim/progress/release `task` field

Zod: `packages/shared/src/index.ts:31-37` — `repo: z.strictObject({ forge: z.enum(['github','gitlab','gitea']), base_url, full_name, base_branch, suggested_dir })`. Tests call `parseTaskBrief(body.task)` via `assertBriefShape`.

Persist path: `readRepo` (`tasks.ts:127-150`) copies `raw.base_url` and `raw.full_name` **as given** into `RepoInput`; create writes `repoBaseUrl` / `repoFullName` (`619-623`). No trailing-slash strip on store.

UI defaults (`App.vue:980-984`): github `https://github.com`, gitlab `https://gitlab.com`, gitea `''`. Publish `trim()`s (`1670`) but does not strip a trailing `/`.

Claim fixtures (`claim.test.ts:15-16, 357-362`): `FORGE_BASE_URL = 'https://gitea.forge.example.test'`, `REPO_FULL_NAME = 'team/orders'`, `suggested_dir: 'orders'`. MCP gitlab filter fixture (`mcp.test.ts:17-18, 907-909`): `https://gitlab.forge.example.test` + `team/payments`.

---

## 8. Zod and `clone`

**Confirmed: no schema validates `clone`.**

- `taskBriefSchema` is `z.strictObject` on the brief only (`packages/shared/src/index.ts:18-60`). Extra keys on a **whole claim envelope** would fail `parseTaskBrief` if applied to the envelope; tests parse **`body.task` only**.
- Grep of `packages/` for `clone`: no matches.
- Server `ClaimSuccessBody.clone` is a TypeScript structural type, not zod.

---

## 9. Ambiguities for `remote_url` = `strip_trailing_slash(base_url) + '/' + full_name + '.git'`

**No production code builds a git remote today.** Closest existing join is issue web URLs, which **do** strip trailing slashes:

```523:526:packages/forge-adapters/src/index.ts
function listedIssueWebUrl(kind: ForgeKind, repo: RepoRef, number: number): string {
  const base = repo.base_url.replace(/\/+$/u, '')
  if (kind === 'gitlab') return `${base}/${repo.full_name}/-/issues/${number}`
```

Adapter API origin also strips (`apiUrl` `604`: `(options?.baseUrl ?? repo.base_url).replace(/\/+$/u, '')`).

Facts that would make a naive concat wrong:

1. **Trailing slash on stored `base_url`.** `readRepo` does not strip. `isHttpOrHttpsUrlWithHost` (`tasks.ts:155-164`) accepts `https://github.com/` via `new URL`. Fixtures in this tree use **no** trailing slash (grep `base_url: 'https://…/'` in `*.ts`/`*.vue`: zero). Naive `base + '/' + full_name` without strip would yield `https://host//owner/repo.git` if a slash were stored. Issue #20's strip clause matches `listedIssueWebUrl`, not `readRepo`.

2. **GitLab subgroup `full_name`.** Parser keeps multi-segment namespaces (`parseGitlabIssueUrl` pathname `^/(.+)/-/issues/(\d+)$` → `namespace` as `full_name`, `index.ts:414-432`). Adapter tests use `'group/subgroup/app'` (`list-issues.shared.test.ts:466`, `import-issue.shared.test.ts:452`, `webhook.shared.test.ts:491`). Git HTTPS remotes use literal slashes (`https://host/group/subgroup/app.git`). **Do not** reuse `repoPath('gitlab')` (`index.ts:587-590`) which is `/projects/${encodeURIComponent(fullName)}` (`group%2Fsubgroup%2Fapp`) — that is the **API** project id, not a git remote.

3. **GitHub `base_url` vs API host.** Task `repo.base_url` is the **web** origin (`https://github.com` in UI default). Forge HTTP always uses `api.github.com` (`apiUrl` `600-602`). Using the API host as `remote_url` would be wrong; using stored `repo.base_url` matches public GitHub clone URLs.

4. **GitLab git auth vs adapter HTTP auth.** Issue #20 table: gitlab extra_header `Authorization` / `Bearer ${token}`. Adapter `authHeaders` for GitLab API is `{ 'PRIVATE-TOKEN': token }` (`index.ts:616-618`), GitHub API `Authorization: Bearer ${token}`, Gitea API `Authorization: token ${token}` (`608-619`). Gitea/GitHub git header names match the issue table; GitLab **git** recipe in #20 is **not** a copy of `authHeaders('gitlab')`.

5. **`full_name` edges.** Empty `full_name` rejected at publish (`tasks.ts:138`). `full_name` ending in `/` with omitted `suggested_dir` → empty last segment → `400` (`110-113`, `141-143`). Leading `/` on `full_name` is not stripped → `https://host//ns/repo.git`. No claim test covers github vs gitlab vs gitea clone URLs (almost all claim tasks are gitea `team/orders`).

6. **Username/password in URL.** Nothing in claim construction puts credentials in a URL today (there is no remote URL). `CLONE_TOKEN_USAGE` and DESIGN §7 already forbid embedding token in remote URL.

7. **Server git.** Grep of `apps/server/src` for `child_process` / `spawn` / `execFile` / `git clone`: no git execution. `db.ts` `sqlite.exec` is SQL only.

---

## 10. list_tasks / get_task_brief / session GET never include `clone` extra_header or token

| Surface | Serializer | Token | `clone` |
|---------|------------|-------|---------|
| MCP `list_tasks` | `{ tasks: briefs }` (`mcp.ts:76`) | `assertNoForgeSecretMaterial` (`mcp.test.ts:887`, after claim `1115-1119`) | Briefs are 15 DESIGN keys (`assertBriefShape`); no `clone` |
| MCP `get_task_brief` | top-level `taskBrief(row)` (`mcp.ts:85`) | `mcp.test.ts:996`, `1121-1125` | Same; `Object.hasOwn(payload, 'tasks')` false (`1029`) |
| Session `GET /api/v1/tasks` | `{ tasks: map(taskBrief) }` (`tasks.ts:484`) | `claim.test.ts:859-874` after 201 claim | `assertBriefShape` — no `clone` |
| Session `GET /api/v1/tasks/:publicId` | `taskBrief(row)` (`496`) | `claim.test.ts:876-880` | same |

`SECRET_KEY_NAMES` forbids a **key** named `token` on those bodies. `extra_header` cannot appear unless someone adds it to `taskBrief` (it is not there).

Claim `201` / MCP `claim_task` success remain the only HTTP that return forge plaintext (`docs/api.md:7`, `CLAUDE.md` project conventions). Nested `clone` today does not contain the plaintext (`assertClaimRevealToken`).

`202` autonomous park (`claim.ts:125-133`) and pending `403` also have no `clone`.

---

## Adjacent facts (not requested, cheap)

- `CLONE_TOKEN_USAGE` is also the MCP tool-description pin; changing the sentence would break `mcp.test.ts:860-864` and docs that quote it.
- Thickening `clone` on `claimTask` automatically thickens REST and MCP.
- `packages/shared` Task Brief contract does not need new fields for #20 if `clone` stays beside the brief.
- Existing join to copy for `remote_url`: `listedIssueWebUrl`'s `base.replace(/\/+$/u, '') + '/' + full_name`, suffix `.git` instead of `/issues/{n}`.
- Forge extra_header table is **not** in DESIGN yet (issue says write DESIGN then code).

---

## Pointers for implementers (locations only)

| Piece | Path |
|-------|------|
| Constant + inline clone object | `apps/server/src/claim.ts:34-35`, `82-87`, `219-222` |
| REST route | `apps/server/src/claim.ts:406-411` |
| MCP reuse | `apps/server/src/mcp.ts:9-16`, `114-120` |
| `task.repo` | `apps/server/src/tasks.ts:387-393` |
| Brief zod | `packages/shared/src/index.ts:31-37` |
| Tests to update | `claim.test.ts` `assertClaim201`; `mcp.test.ts` `assertClaimEnvelope`; `claim-confirm.test.ts` both helpers |
| Trailing-slash pattern | `packages/forge-adapters/src/index.ts:523-526` |
)
