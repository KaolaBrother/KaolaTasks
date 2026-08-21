# Orchestrator rulings — issue #12

Pinned 2026-08-21 from ground-truth.md (HEAD `0e8bc4a`) and forge-issue-apis.md (official docs, retrieval 2026-08-21). Comments on #12 do not override the body.

Out of scope: `registerWebhook` / `parseWebhook` (#13), `commentOnIssue` (#14), REST `submit_pr`, a seventh task status, DESIGN.md contract edits.

## 1. `ImportedIssue` (replaces `unknown`)

```ts
export type ImportedIssue = {
  title: string
  description_md: string
  issue_url: string
  repo: { full_name: string }
}
```

- `title` ← JSON `title` (all three forges). Missing/non-string → reject after fetch.
- `description_md` ← GitHub/Gitea JSON `body`; GitLab JSON `description`. `null` or missing → `''`.
- `issue_url` ← the **pasted** web URL after trailing-slash strip (not API `html_url` / `web_url`).
- `repo.full_name` ← GitHub/Gitea `owner/repo`; GitLab full namespace (may contain `/`).

`ForgeEvent` and `IssueRef` stay `unknown`.

## 2. `importIssue(cred, issueUrl)` host and parse

Mirror `getPullRequest`, not `validateToken`'s `repo.base_url` fetch:

- Parse with `new URL`; strip trailing `/` (same as PR helper). Query and hash are dropped by `pathname`.
- Unparseable → throw **before** any `fetch`.
- GitHub REST origin always `https://api.github.com`. Constructor `baseUrl` and pasted host are ignored.
- GitLab/Gitea REST origin is constructor `options.baseUrl` (trim trailing `/`). **Never** the pasted issue URL host.
- GET via existing `forgeGet` / `authHeaders`.
- Pathname regex after strip:
  - GitHub: `^/([^/]+)/([^/]+)/issues/(\d+)$`
  - Gitea: same
  - GitLab canonical: `^/(.+)/-/issues/(\d+)$`
  - GitLab legacy (also accept): `^/(.+)/issues/(\d+)$` — API example `web_url`s omit `/-/`.
- Reject `/pull/`, `/pulls/`, `/-/merge_requests/`, `/-/work_items/` as unparseable (no fetch).
- A GitHub/Gitea GET `/issues/{n}` that returns a PR (`pull_request` key) is **accepted** (title/body still map).
- GitLab nested groups: the namespace is everything before `/-/issues/` (or legacy `/issues/`).
- Encode GitLab project path with `encodeURIComponent` (slashes → `%2F`). Encode GitHub/Gitea owner and repo too.
- REST paths:
  - GitHub: `https://api.github.com/repos/{owner}/{repo}/issues/{n}`
  - GitLab: `{baseUrl}/api/v4/projects/{encodeURIComponent(namespace)}/issues/{iid}`
  - Gitea: `{baseUrl}/api/v1/repos/{owner}/{repo}/issues/{index}`
- Non-OK HTTP after fetch → throw (include status in the Error message, same spirit as `getPullRequest: ${kind} responded ${status}`).
- 401 from forge is a throw (HTTP layer maps it). Do not treat 404 as “definitely does not exist” in adapter messaging; the adapter just throws on non-OK.

## 3. HTTP draft seam — `POST /api/v1/tasks/import`

Pre-publish only. **Does not persist a task.** Does **not** call `validateToken` (发布即校验 stays on existing `POST /api/v1/tasks`).

Session cookie. Same gate as create: `active` + `full` → else `403 { error: 'forbidden' }`. Unauthenticated: same `sendUnauthorized` as `POST /api/v1/tasks` (`Accept: application/json` → `401 { error: 'unauthorized' }`).

Request (snake_case):

```jsonc
{
  "issue_url": "https://…",
  "repo": { "forge": "github|gitlab|gitea", "base_url": "https://…" },
  "credential": { "profile_id": 3 } // XOR { "token": "…" }
}
```

`repo.full_name` is optional. If present it must equal the parsed full_name, else `400 { error: 'invalid_body', message: 'Issue 地址与仓库不匹配。' }`.

Parse `issue_url` **before** decrypt so a profile can bind on parsed `full_name`. Profile bind is exact `===` on `forge` / `base_url` / parsed `full_name` (same messages as publish: missing profile / 所选凭证档案与仓库不匹配). Inline path encrypts nothing (no persist). Vault miss → `500 { error: 'vault_unconfigured' }`.

`repo.base_url` must be http(s)+host (same Chinese message as publish).

Success **200** (not 201 — nothing created), JSON:

```jsonc
{
  "title": "…",
  "description_md": "…",
  "source": { "type": "imported", "issue_url": "<stripped pasted URL>" },
  "repo": { "forge": "<request>", "base_url": "<request>", "full_name": "<parsed>" }
}
```

Never a token. Nested objects must not contain keys `token` / `token_encrypted` / `inline_token_encrypted` / `access_token`.

Error mapping:

| Case | Status | Body |
|---|---|---|
| generic parse / missing issue_url / missing forge | 400 | `{ error: 'invalid_body' }` (no message) |
| unparseable issue_url | 400 | `{ error: 'invalid_body', message: '无法解析 Issue 地址。' }` (no fetch) |
| forge 404 or 410 | 404 | `{ error: 'issue_not_found', message: '无法读取该 Issue。' }` |
| forge 401 | 422 | `{ error: 'token_check_failed', missing: ['读'], message: 'token 无效或无权读取该 Issue。' }` |
| importIssue throws for other non-OK | 502 | `{ error: 'forge_unreachable', message: '无法连接 forge 导入 Issue。' }` |
| fetch/network throw | 502 | same `forge_unreachable` message |

Profile path writes `events.type` `token 揭示` after decrypt (including failures): `details` `{ profile_id, forge, base_url, full_name, outcome }` with `outcome` `ok` | `issue_not_found` | `token_check_failed` | `forge_unreachable`. `profile_id` is the integer PK. No token / ciphertext / `agent_key_id`. Inline path does not write this event.

## 4. UI

- Form: when 来源 is `imported`, show button `data-testid="task-import"` label **导入**. Click `POST /api/v1/tasks/import` with `Accept: application/json`, `credentials: 'include'`, snake_case body from current forge/base_url/credential/issue_url. On 200, fill title, description, repo full_name (and keep source imported). Show server `message` or generic `导入失败（${status}）` on failure — do not change the existing 发布 error copy.
- 来源标记 text is exactly **导入内容**:
  - Form: `data-testid="task-import-source-label"` visible iff 来源 selector is `imported`.
  - Board detail: `data-testid="board-detail-import-label"` visible iff `selectedTask.source.type === 'imported'`; absent for native.
- Description stays text interpolation (no `v-html`). Existing `board-detail-issue-url` link is the source **link**, not the injection label.
- Do not add a 草稿 status. User still clicks 发布 → existing `POST /api/v1/tasks` + `validateToken`.

## 5. Tests — custody

tdd-guide owns:

- `packages/forge-adapters/src/import-issue.shared.test.ts` (new). Copy fetch-stub helpers from `get-pull-request.shared.test.ts`; do **not** import that file. `KINDS` loop. Pin: auth headers, REST URL, host rule (GitHub always api.github.com; GitLab/Gitea constructor baseUrl ≠ pasted host), GitLab nested-group `%2F`, GitLab `description` vs others `body`, null body → `''`, trailing slash, unparseable rejects with **zero** fetch, non-OK rejects with **one** fetch, `ImportedIssue` shape.
- `apps/server/src/import.test.ts` (new). Drive real `buildApp` + session like `tasks.test.ts` (copy seams, do not import that file). Pin the HTTP table above, token hygiene, profile reveal outcomes, no row inserted on success. Stub `fetch` for the Issue GET (and do not require a successful `validateToken` on this route).
- Web: **add** cases to `apps/web/src/App.form.test.ts` and `apps/web/src/App.board.test.ts`. Do not weaken or delete existing cases.
- Root `package.json` `"test"`: append the two new node:test paths immediately after `get-pull-request.shared.test.ts`. That one-line harness edit is the same exemption as #11.

Implementer later must not touch those test files.

## 6. Near-misses the suite must catch

- Calling the pasted issue host for GitLab/Gitea (SSRF).
- Using GitLab JSON `body` instead of `description`.
- Returning a token on the import response.
- Persisting a `tasks` row from import.
- Treating `/pull/n` as an issue.
- Skipping 来源标记 on board detail for imported tasks.
- `assert.rejects` that would pass on today's `notImplemented` — unparseable must be zero-fetch; non-OK must be one-fetch.
