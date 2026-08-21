# Forge Issue GET APIs (GitHub / GitLab / Gitea)

Lookup date: **2026-08-21**. Every claim below is tagged with source URL + retrieval date. Fetched pages are untrusted data; this memo records facts only.

**Context7 MCP:** no Context7 tools/servers were available in this environment (GetMcpTools pattern `context7|Context7` returned no matches). Sources are official docs via WebFetch/WebSearch, plus read-only local analog in `.kw/worktrees/issue-12/packages/forge-adapters/src/index.ts` (`getPullRequest` / `validateToken` / `authHeaders`).

**Kaola host rule to mirror (local analog, not a forge contract):**

- GitHub REST origin is always `https://api.github.com`. Constructor `baseUrl` and the pasted web URL host are ignored.
- GitLab and Gitea REST origin is constructor `options.baseUrl` (trim trailing `/`). Never the pasted issue URL’s host.
- Auth headers are those already used by `validateToken` / `forgeGet`.
- GET via global `fetch`.
- PR URL parsing already strips trailing `/` and a trailing `.diff`/`.patch` suffix, then matches `URL.pathname`. Issue parsers should reuse that strip + `new URL` approach so `?query` and `#fragment` do not break the path.

Do not invent Kaola DTO names here. Field names below are forge JSON as documented.

---

## 1. GitHub

### 1.1 Canonical web URL path

Canonical issue URL (official autolink table):

- `https://github.com/{owner}/{repo}/issues/{n}`
- Example from docs: `https://github.com/jlord/sheetsee.js/issues/26`

Source: https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls — retrieved 2026-08-21.

Owner and repo are **one path segment each** (no GitLab-style nested groups). GitHub.org/user names do not contain `/`.

Related, not an issue web path:

- Pull requests: `/{owner}/{repo}/pull/{n}` (different path; Issues REST may still return a PR — see 1.3).
- Short refs: `owner/repo#n` (not an HTTP URL).

Source: same autolink page, retrieved 2026-08-21.

Transferred issues: the **original web URL redirects** to the new issue URL. People without read access on the destination see a banner, not the issue body.

Source: https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/transferring-an-issue-to-another-repository — retrieved 2026-08-21.

### 1.2 REST GET a single issue

```
GET https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}
```

Example (placeholders from official curl):

```
GET https://api.github.com/repos/OWNER/REPO/issues/ISSUE_NUMBER
```

Path parameters (official):

| Param | Type | Notes |
| --- | --- | --- |
| `owner` | string, required | Account owner. **Not case sensitive.** |
| `repo` | string, required | Repository name **without** `.git`. **Not case sensitive.** |
| `issue_number` | integer, required | Number that identifies the issue. |

Encoding: path parameters must be URL-encoded; slashes in a parameter value must be `%2F`. A trailing slash on the API URL yields `404 Not Found`.

Sources:

- https://docs.github.com/en/rest/issues/issues — retrieved 2026-08-21 (section **Get an issue**).
- https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api — retrieved 2026-08-21 (encoding, trailing slash).

**Kaola analog:** `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}` — same origin rule as `getPullRequest` (`GITHUB_API_ORIGIN`). Ignore the pasted host even if it is GHE/`github.com`.

Docs curl examples use `curl -L` (follow redirects). Runtime `fetch` also follows redirects by default (`redirect: "follow"`). A `301` transfer may therefore surface as `200` from the destination unless redirects are disabled.

### 1.3 JSON title / body (markdown)

Get-an-issue 200 schema is **the same as Create an issue**. Documented fields:

- **`title`**: required, string
- **`body`**: string or **null** (empty body)

Create-an-issue example payload/docs treat `body` as the issue text. Get-an-issue custom media types (official):

- `application/vnd.github.raw+json` — raw **markdown** body; response includes `body`. Default if no specific media type is passed.
- `application/vnd.github.text+json` — `body_text`
- `application/vnd.github.html+json` — `body_html`
- `application/vnd.github.full+json` — `body`, `body_text`, and `body_html`

Recommended `Accept` on the endpoint: `application/vnd.github+json` (matches Kaola `validateToken`).

Also: REST “Issues” endpoints may return **pull requests**. Identify PRs by the presence of the **`pull_request`** key. The `id` in that payload is an **issue id**, not the pull-request id. `number` is the repo-local number.

Sources:

- https://docs.github.com/en/rest/issues/issues — retrieved 2026-08-21 (Get an issue; Create an issue response schema `title` / `body`; PR note).
- https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api — retrieved 2026-08-21 (`Accept: application/vnd.github+json`).

### 1.4 404 vs 401/403; missing issue

Get-an-issue documented status codes: **200**, **301**, **304**, **404**, **410**. (401/403 are documented on the auth/troubleshooting pages, not in this endpoint’s status list.)

Official transfer/delete behavior:

- **301 Moved Permanently** — issue was **transferred** to another repository.
- **404 Not Found** — transferred to **or deleted from** a repository where the authenticated user **lacks read access**; also generic “resource not found”.
- **410 Gone** — issue was **deleted** from a repository where the authenticated user **has read access**.

Auth layer (all REST):

- Invalid credentials → initially **401 Unauthorized**.
- No token / insufficient permissions → **404 Not Found** or **403 Forbidden**.
- Private resource without proper auth → **404 Not Found** (GitHub uses 404 **instead of 403** so as not to confirm private repos exist).
- Rate limit → **403** or **429**.
- Missing/invalid `User-Agent` → rejected; invalid `User-Agent` → **403**.
- SAML SSO on a classic PAT: **404** or **403**; `403` may include `X-GitHub-SSO` with an authorize URL.

Sources:

- https://docs.github.com/en/rest/issues/issues — retrieved 2026-08-21.
- https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api — retrieved 2026-08-21.
- https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api — retrieved 2026-08-21.
- https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api — retrieved 2026-08-21 (`User-Agent`).

**Practical distinction for import:** `401` ⇒ bad/missing token. `404` ⇒ missing **or** private-and-inaccessible **or** transferred into an unread repo (do not treat 404 as “definitely does not exist”). `410` ⇒ deleted but caller can see the repo. `301` ⇒ transferred (unless `fetch` already followed it). `403` ⇒ forbidden / rate limit / SAML / bad User-Agent — **not** the documented “missing issue” code.

### 1.5 Auth header scheme vs Kaola `validateToken`

Official: send the token in `Authorization`. Example:

```
Authorization: Bearer YOUR-TOKEN
```

Also: “In most cases, you can use `Authorization: Bearer` or `Authorization: token`. However, if you are passing a JSON web token (JWT), you must use `Authorization: Bearer`.”

Also required: valid `User-Agent`. Recommended `Accept: application/vnd.github+json`. Optional version header `X-GitHub-Api-Version` (docs examples currently show `2026-03-10`).

Kaola `authHeaders('github')` today:

```
Authorization: Bearer ${token}
User-Agent: KaolaTasks
Accept: application/vnd.github+json
```

**Matches** the documented Bearer + Accept + User-Agent scheme. No `X-GitHub-Api-Version` is sent today (optional).

Sources:

- https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api — retrieved 2026-08-21.
- Local `packages/forge-adapters/src/index.ts` `authHeaders` (read-only analog).

### 1.6 URL-parsing traps

| Trap | What official docs say |
| --- | --- |
| Trailing `/` | API: trailing slash → **404**. Web: strip before matching, as PR helper already does. Source: troubleshooting REST, retrieved 2026-08-21. |
| Query string / fragment | Autolink canonical path is `/issues/{n}`. `?…` and `#issuecomment-…` are not part of the number. `new URL(…).pathname` drops them. |
| `.md` suffix | **Not** in official issue URL docs (autolink table is `/issues/{n}`). Do not treat `…/issues/123.md` as a documented GitHub issue URL. (PR analog strips `.diff`/`.patch`; that is local PR behavior, not an official issue-URL rule.) |
| `.git` on repo | REST `repo` is the name **without** `.git`. Source: Get an issue params, retrieved 2026-08-21. |
| Transferred issue | Web redirects; REST **301** (or **404** if no read on destination). Source: Get an issue + transfer docs, retrieved 2026-08-21. |
| PR pasted as issue | Web path is `/pull/{n}`, not `/issues/{n}`. REST GET `/issues/{n}` **can** return a PR (`pull_request` key). Source: Get an issue note, retrieved 2026-08-21. |
| Case | Owner/repo **not case sensitive** on the API. Source: Get an issue params. |
| GHES / non-github.com host | Official github.com API host is `api.github.com`. Kaola analog **ignores** pasted host. GHES would need a different API origin (`{host}/api/v3`); that is **out of band** with current `getPullRequest`. |
| Wrong HTTP method | Unsupported method → **404** (not 405). Source: troubleshooting REST. |

---

## 2. GitLab

Current Issues API (the `docs.gitlab.com/ee/api/issues.html` URL is archived and served the same Issues API content): https://docs.gitlab.com/18.6/api/issues/ — retrieved 2026-08-21. Authentication: https://docs.gitlab.com/api/rest/authentication/ — retrieved 2026-08-21.

### 2.1 Canonical web URL path

Official issue-reference formats include the **full URL**:

```
https://gitlab.example.com/<project_full_path>/-/issues/123
```

Nested groups: `<project_full_path>` is the **full project path**, including subgroups, e.g. `group/otherproject` or `group/subgroup/project`. Example in the same page:

```
https://gitlab.example.com/group/otherproject/-/issues/23
```

Short ref: `namespace/project-name#123` (`namespace` is a group **or** a username).

Work-item URLs (same page; **not** the classic issues path):

- Project: `https://gitlab.example.com/<project_full_path>/-/work_items/123`
- Group: `https://gitlab.example.com/groups/<group_full_path>/-/work_items/123`

Source: https://docs.gitlab.com/user/project/issues/managing_issues/ — retrieved 2026-08-21 (section on available issue reference formats).

Why `/-/` exists: GitLab introduced the `/-/` scope so **nested group/project paths** are not ambiguous with app routes. “Every project route must be under the `/-/` scope” except Git-client exceptions. Legacy routes have redirects.

Source: https://docs.gitlab.com/development/routing/ — retrieved 2026-08-21.

**`/issues/` vs `/-/issues/`:** product docs’ canonical **shareable issue URL** uses `/-/issues/{iid}`. The Issues API **example** `web_url` still shows the older shape without `/-/`:

```
"web_url": "http://gitlab.example.com/my-group/my-project/issues/1"
```

Treat `/{namespace}/-/issues/{iid}` as canonical; treat `/{namespace}/issues/{iid}` as a **legacy form that may still appear** (API examples, old bookmarks). Do **not** assume they are identical without a redirect.

Sources: managing_issues URL above; https://docs.gitlab.com/18.6/api/issues/ example response — both retrieved 2026-08-21.

Group issue **list** URLs like `https://gitlab.com/groups/{group}/-/issues` are **not** a single project issue.

### 2.2 REST GET a single project issue

**Use this** (project-scoped, `iid` as shown in the UI):

```
GET /api/v4/projects/:id/issues/:issue_iid
```

`:id` = global project ID **or URL-encoded path** of the project. `:issue_iid` = **internal ID** unique **within the project** (the number in the web URL).

Example from docs (numeric project id):

```
GET https://gitlab.example.com/api/v4/projects/4/issues/41
Authorization analog: header PRIVATE-TOKEN
```

Namespaced path example (REST index, ` / ` → `%2F`):

```
GET /api/v4/projects/diaspora%2Fdiaspora
```

Nested-group issue GET would be:

```
GET {baseUrl}/api/v4/projects/{encodeURIComponent("group/subgroup/project")}/issues/{iid}
```

e.g. `https://gitlab.example.com/api/v4/projects/group%2Fsubgroup%2Fproject/issues/123`

**id vs iid (REST primer):** issues have `id` (instance-global) and `iid` (per-project, shown in UI). Fetch with **iid**. Example: project `id: 42`, issue `id: 46`, `iid: 5` → valid `GET /projects/42/issues/5`; invalid `GET /projects/42/issues/46`.

**Do not use** `GET /issues/:id` for import: that “Single issue” endpoint is documented **“Only for administrators”** and takes the **global** issue `id`.

**Kaola analog:** `{constructor baseUrl}/api/v4/projects/${encodeURIComponent(namespace)}/issues/${iid}` — same encoding as `getPullRequest` MRs. **Never** use the pasted URL’s host.

Sources:

- https://docs.gitlab.com/18.6/api/issues/ — retrieved 2026-08-21 (**Single project issue**).
- https://docs.gitlab.com/api/rest/ and https://docs.gitlab.com/18.6/api/rest/ — retrieved 2026-08-21 (namespaced paths; id vs iid). Search/snippets used because a full fetch of `/api/rest/` timed out; content matches 17.11/18.6 REST index pages.

If the encoded slash is decoded by a reverse proxy, GitLab returns **404**. That is an instance-ops issue, not a client encoding bug.

Source: https://docs.gitlab.com/api/rest/troubleshooting/ — retrieved 2026-08-21.

### 2.3 JSON title / body (markdown)

Single project issue example response (official field names):

- **`title`**: string (example: `"Ut commodi ullam eos dolores perferendis nihil sunt."`)
- **`description`**: string **or `null`** (example: `"Omnis vero earum sunt corporis dolor et placeat."`; other examples show `"description": null`)

There is **no** `body` field on the GitLab issue JSON.

Create/update attributes: `description` = “The description of an issue. Limited to 1,048,576 characters.” `title` = “The title of an issue.”

Markdown: GitLab Flavored Markdown is used in **Issues** (and “issue … descriptions”). Titles do **not** support full GLFM.

Also useful (not title/body): `iid`, `id`, `web_url`, `moved_to_id` (null unless moved).

Sources:

- https://docs.gitlab.com/18.6/api/issues/ — retrieved 2026-08-21.
- https://docs.gitlab.com/user/markdown/ — retrieved 2026-08-21.

### 2.4 404 vs 401/403; missing issue

Issues API preface: if a user is **not a member of a private project**, a `GET` on that project results in **`404`**.

Single project issue: if the project is **private** or the issue is **confidential**, credentials are required.

REST status table (instance-wide):

| Code | Official meaning |
| --- | --- |
| **401** | User isn’t authenticated. A valid user token is necessary. Invalid/missing auth JSON: `{"message": "401 Unauthorized"}` |
| **403** | Request isn’t allowed (e.g. cannot delete a project; also sudo-without-admin) |
| **404** | Resource couldn’t be accessed — ID not found **or** user **isn’t authorized** to access the resource |
| **301** | Resource moved; `Location` header |

So a missing issue, a wrong `iid`, a private project the token cannot see, and a confidential issue without rights can all look like **404**. **401** is the documented “token missing/invalid” signal. **403** is “authenticated but operation not allowed,” not the usual “issue doesn’t exist.”

Moved issues: `POST /projects/:id/issues/:issue_iid/move` creates the issue in the target project (new `iid` / `project_id`). Response `web_url` in the move example still uses `/issues/{n}` without `/-/`. A later GET on the **old** project `iid` is not documented here as 301; the issue object carries `moved_to_id`. Do not assume GitHub-style 301 on the Issues GET.

Sources:

- https://docs.gitlab.com/18.6/api/issues/ — retrieved 2026-08-21.
- https://docs.gitlab.com/api/rest/authentication/ — retrieved 2026-08-21.
- https://docs.gitlab.com/api/rest/troubleshooting/ — retrieved 2026-08-21.

### 2.5 Auth header scheme vs Kaola `validateToken`

Personal/project/group access tokens: pass via **`PRIVATE-TOKEN` header (recommended)**:

```
PRIVATE-TOKEN: <your_access_token>
```

Also accepted: `Authorization: Bearer <your_access_token>` (OAuth-compliant header). OAuth tokens: `Authorization: Bearer OAUTH-TOKEN` or `access_token` query (query is worse for logs). Job tokens: `JOB-TOKEN` (CI only). Deploy tokens: **cannot** be used with the public API.

Invalid/missing auth → **401** `{"message": "401 Unauthorized"}`.

Kaola `authHeaders('gitlab')` today:

```
PRIVATE-TOKEN: ${token}
```

**Matches** the documented recommended PAT header. Kaola does **not** use Bearer for GitLab (also valid per docs, but not what `validateToken` sends).

Sources:

- https://docs.gitlab.com/api/rest/authentication/ — retrieved 2026-08-21.
- Local `authHeaders` analog.

Issues API examples use the same `PRIVATE-TOKEN` header on GET `/projects/:id/issues/:issue_iid`.

Source: https://docs.gitlab.com/18.6/api/issues/ — retrieved 2026-08-21.

### 2.6 URL-parsing traps

| Trap | Fact |
| --- | --- |
| Nested groups | Path **before** `/-/issues/` is the full project path and may contain multiple `/`. Regex analog to MR: `^/(.+)/-/issues/(\d+)$` on `pathname`. Source: managing_issues + routing docs, 2026-08-21. |
| `/-/issues/` vs `/issues/` | Canonical share URL uses `/-/`. API `web_url` examples omit `/-/`. Matching only one form drops real paste URLs. |
| `/-/work_items/{n}` | Documented alternate for work items; **not** `/issues/`. Group-level `/groups/…/-/work_items/` is not a project issue. |
| `/-/merge_requests/{iid}` | MR, not issue (Kaola already parses this for `getPullRequest`). |
| Trailing `/`, query, `#note_…` | Same as GitHub: strip `/`, use `URL.pathname`. Comment fragment `#note_*` is documented as a comment permalink, not the issue id. Source: https://docs.gitlab.com/user/markdown/ — retrieved 2026-08-21. |
| `iid` vs `id` | Web number is **iid**. Using global `id` in `/issues/:issue_iid` is wrong. Source: REST id vs iid, 2026-08-21. |
| Encode the **whole** namespace | `encodeURIComponent("a/b/c")` → `a%2Fb%2Fc`. Unencoded `/` makes the path not match → **404**. Source: REST namespaced paths, 2026-08-21. |
| Pasted host | Self-managed hosts vary. **Kaola analog: constructor `baseUrl` only.** |
| Admin `GET /issues/:id` | Wrong endpoint for import. |
| Moved issue | New project/`iid`; `moved_to_id` on payload. Old URL may 404. Source: Move an issue, 2026-08-21. |

---

## 3. Gitea

Docs used: https://docs.gitea.com/api (API 1.27.2) — retrieved 2026-08-21; https://docs.gitea.com/api/1.27/operations/issue-get-issue/ — retrieved 2026-08-21; https://docs.gitea.com/development/api-usage/ — retrieved 2026-08-21. Swagger UI on an instance: `{gitea}/api/swagger` (official API Usage page).

### 3.1 Canonical web URL path

Official Go model `HTMLURL` (Gitea v1.26.2 tag):

- Issues: `{repoHTMLURL}/issues/{index}`
- Pull requests: `{repoHTMLURL}/pulls/{index}`

So the web path is **GitHub-like**, two segments, **not** GitLab nested groups:

```
https://{gitea-host}/{owner}/{repo}/issues/{n}
```

Example consistent with API curl host:

```
https://gitea.com/example/example/issues/1
```

Owner is a user **or** organization — still **one** path segment. Gitea orgs are not nested `group/sub/project` paths.

Web view: if the path type is `issues` but the object is a pull, Gitea **redirects** to the `pulls` URL (and vice versa).

Sources:

- https://github.com/go-gitea/gitea/blob/v1.26.2/models/issues/issue.go (`HTMLURL`) — retrieved 2026-08-21.
- https://github.com/go-gitea/gitea/blob/cfd72183/routers/web/repo/issue_view.go (`ViewIssue` type mismatch redirect) — retrieved 2026-08-21.

API `html_url` is a string field on the Issue object.

Source: https://docs.gitea.com/api/1.27/operations/issue-get-issue/ — retrieved 2026-08-21.

### 3.2 REST GET a single issue

```
GET {baseUrl}/api/v1/repos/{owner}/{repo}/issues/{index}
```

Official curl (docs; they show Basic in the snippet, but token header is the documented API-token method — see 3.5):

```
GET https://gitea.com/api/v1/repos/example/example/issues/1
```

Path parameters:

| Param | Type | Meaning |
| --- | --- | --- |
| `owner` | string, required | Owner of the repo |
| `repo` | string, required | Name of the repo |
| `index` | integer (int64), required | **Index** of the issue to get |

**Kaola analog:** `{constructor baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}` — same origin/prefix as `getPullRequest` pulls (`/api/v1/repos/.../pulls/{n}`).

Source: https://docs.gitea.com/api/1.27/operations/issue-get-issue/ — retrieved 2026-08-21.

Handler (v1.27.2): loads by repo ID + path `index`. Missing issue → `APIErrorNotFound`. No permission to read issues/pulls → **also** `APIErrorNotFound`. Success: `convert.ToAPIIssue`.

Source: https://github.com/go-gitea/gitea/blob/v1.27.2/routers/api/v1/repo/issue.go (`GetIssue`) — retrieved 2026-08-21.

### 3.3 JSON title / body (markdown)

OpenAPI Issue object (Get an issue 200) includes **top-level**:

- **`title`**: string
- **`body`**: string

Create-issue example in API Usage uses the same names:

```
{ "body": "testing", "title": "test 20" }
```

There is **no** GitLab-style `description` on the Issue object (nested objects such as milestone/label/user have their own `description` / `title` — do not confuse those with the issue).

Also: `number` (int64), `id` (int64), `html_url`, `pull_request` (present when the issue is a PR). **Use `index`/`number` in the URL, not `id`.**

`body` is the issue description text (markdown in the Gitea UI; OpenAPI types it as `string` without a separate HTML field).

Sources:

- https://docs.gitea.com/api/1.27/operations/issue-get-issue/ — retrieved 2026-08-21.
- https://docs.gitea.com/development/api-usage/ — retrieved 2026-08-21.

### 3.4 404 vs 401/403; missing issue

OpenAPI for this operation documents **200** and **404** only. 404 is described as “APINotFound is a not found empty response.”

Swagger on most endpoints **omits** middleware **401/403** (Gitea issue #37307 documents that convention). Auth middleware facts from Gitea source (cite as source code, not swagger):

- No signed-in user when a token is required → **401**, message `"token is required"`.
- Auth parse failure → **401**, `"invalid username, password or token"` (or a more specific user-auth message).
- GetIssue: issue not exist **or** cannot read issues/pulls → **404**.

So: **401** ⇒ not authenticated / bad token. **404** ⇒ missing issue **or** no permission (same collapsing as GitHub/GitLab private-404). Do not rely on swagger to list 401 for this route.

Sources:

- https://docs.gitea.com/api/1.27/operations/issue-get-issue/ — retrieved 2026-08-21.
- https://github.com/go-gitea/gitea/blob/v1.27.2/routers/api/v1/repo/issue.go — retrieved 2026-08-21.
- https://github.com/go-gitea/gitea/blob/356f589f/routers/api/v1/api.go (`reqToken`, `apiAuth`) — retrieved 2026-08-21.
- https://github.com/go-gitea/gitea/issues/37307 — retrieved 2026-08-21 (swagger omits middleware 401/403).

### 3.5 Auth header scheme vs Kaola `validateToken`

OpenAPI (Gitea API 1.27.2) **AuthorizationHeaderToken**: “API tokens must be prepended with `token` followed by a space.” Header name: `Authorization`. Query `access_token` / `token` are **deprecated for removal in Gitea 1.23**; use the Authorization header.

API Usage page (same scheme, with example):

```
Authorization: token 65eaa9c8ef52460d22a93307fe0aee76289dc675
```

Other methods: HTTP basic; `token=` / `access_token=` query (deprecated); HTTP signatures. OAuth2 access tokens: `Authorization bearer ...` (wording on that page) plus the same query params.

Kaola `authHeaders('gitea')` today:

```
Authorization: token ${token}
```

**Matches** AuthorizationHeaderToken / API Usage. Do **not** send GitHub-style `Bearer` for a Gitea **API key** (Bearer is documented for OAuth2 tokens; API keys want the `token ` prefix).

Sources:

- https://docs.gitea.com/api — retrieved 2026-08-21 (Authentication).
- https://docs.gitea.com/development/api-usage/ — retrieved 2026-08-21.
- Local `authHeaders` analog.

### 3.6 URL-parsing traps

| Trap | Fact |
| --- | --- |
| Path vs GitHub | Same `/owner/repo/issues/n` shape. **Cannot** reuse GitLab’s greedy namespace regex. |
| `/issues/` vs `/pulls/` | Issues vs PRs in the **web** URL. REST GET `/issues/{index}` still returns PRs (`pull_request` object). Web UI redirects mismatched type. |
| No nested groups | Owner and repo are single segments. |
| Trailing `/`, query, hash | Strip like PR helper. Gitea markup even matches optional `?`/`#` after `/(issues\|pulls)/{n}`. Source: https://github.com/go-gitea/gitea/blob/v1.27.1/modules/markup/html.go `issueFullPattern` — retrieved 2026-08-21. |
| `.diff` / `.patch` | Defined on **pulls**, not issues (`DiffURL`/`PatchURL`). Source: issue.go HTML helpers, 2026-08-21. |
| External trackers | Markup regex allows an optional `{1,10}-` prefix before the number (`ABC-123`). Built-in API `index` is still **integer**. Don’t parse prefixed indexes as Gitea API indexes unless you know the instance uses internal issues. |
| Pasted host | Self-hosted. **Constructor `baseUrl` only.** |
| `id` vs `number`/`index` | Path uses **index** (repo-local). JSON `id` is the global row id. |

---

## 4. Fastify 5 — session JSON import-draft (secondary)

No extra Fastify plugin is required. Fastify 5 already serializes objects as JSON.

Official:

- Shorthand: `fastify.get` / `fastify.post` with async handlers.
- `reply.send({ … })` — “if you are sending JSON objects, `send` will serialize the object with fast-json-stringify if you set an output schema, otherwise `JSON.stringify()`.”
- Async handler may `return { hello: 'world' }` instead of `reply.send` (native promise handling).
- Default status is **200** if `.code` is not set. POST create conventionally uses `.code(201)` when returning a created resource (GitLab REST table: POST → 201; that is GitLab, not Fastify). Fastify does not force 201.

Sources:

- https://fastify.dev/docs/latest/Reference/Routes/ — retrieved 2026-08-21 (Fastify **v5.12.1** “latest”).
- https://fastify.dev/docs/latest/Reference/Reply/ — retrieved 2026-08-21 (`.send`, Objects, Async-Await).

**Kaola-safe pattern already in tree** (`registerTasks`, read-only analog): session cookie auth, then JSON. No new dependency.

```
app.post('/api/v1/…', async (request, reply) => {
  const user = getSessionUser(db, request)
  if (user == null) return sendUnauthorized(request, reply)
  // … importIssue …
  return reply.send({ /* JSON object */ })
})
```

`sendUnauthorized` returns **`401 { error: 'unauthorized' }` only when `Accept` includes `application/json`**; otherwise it **redirects to `/login`**. An import-draft JSON client **must** send `Accept: application/json` (or the existing helper must be taught another JSON signal). Existing `GET /api/v1/tasks` uses this exact pair.

GET vs POST: Fastify accepts both. POST + JSON body is the same family as `POST /api/v1/tasks`. GET + query is fine for a short URL. Neither needs a plugin.

Do not add `@fastify/sensible` (or similar) unless already a dependency; `reply.code(4xx).send({ error })` is already the local style.

---

## 5. Cross-forge notes for `importIssue(cred, issueUrl)`

1. **Parse the web URL; call REST on the analog origin** (GitHub → `api.github.com`; GitLab/Gitea → constructor `baseUrl`).
2. **Reuse `authHeaders` / `forgeGet`.** Schemes match official docs.
3. **Title/body field names differ:** GitHub+Gitea `title`+`body`; GitLab `title`+`description` (`description` may be `null`).
4. **`fetch` follows 301** — GitHub transferred issues may look like 200.
5. **404 is overloaded** on all three forges (missing **or** no access). Use **401** for bad token; do not map 404 → “does not exist” only.
6. GitHub/Gitea GET-issue can return a **PR**; GitLab issues and MRs are different URLs/endpoints.
7. GitLab **must** `encodeURIComponent` the full namespace (slashes → `%2F`). GitHub/Gitea owner/repo encoding is still correct and matches `getPullRequest`.

---

## 6. Compact mapping table

| Forge | Web URL regex hint (after strip trailing `/`; match `URL.pathname`) | REST path (origin per analog) | Title field | Body field |
| --- | --- | --- | --- | --- |
| **GitHub** | `^/([^/]+)/([^/]+)/issues/(\d+)$` e.g. `/octocat/Hello-World/issues/1347` | `https://api.github.com/repos/{owner}/{repo}/issues/{n}` | `title` | `body` (string \| null; markdown at default/raw media type) |
| **GitLab** | Canonical `^/(.+)/-/issues/(\d+)$` e.g. `/group/sub/project/-/issues/123`; also accept legacy `^/(.+)/issues/(\d+)$` if you need API-example `web_url`s | `{baseUrl}/api/v4/projects/{encodeURIComponent(namespace)}/issues/{iid}` | `title` | `description` (string \| null; GLFM) |
| **Gitea** | `^/([^/]+)/([^/]+)/issues/(\d+)$` e.g. `/owner/repo/issues/1` | `{baseUrl}/api/v1/repos/{owner}/{repo}/issues/{index}` | `title` | `body` (string) |

Auth (already in Kaola `authHeaders`): GitHub `Authorization: Bearer …` + `Accept: application/vnd.github+json` + `User-Agent`; GitLab `PRIVATE-TOKEN`; Gitea `Authorization: token …`.

---

## Source index (retrieval 2026-08-21)

- GitHub Issues REST: https://docs.github.com/en/rest/issues/issues
- GitHub REST auth: https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
- GitHub REST troubleshooting: https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
- GitHub REST getting started: https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
- GitHub autolinks: https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
- GitHub transfer issue: https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/transferring-an-issue-to-another-repository
- GitLab Issues API: https://docs.gitlab.com/18.6/api/issues/ (ee URL archived to this content)
- GitLab REST auth: https://docs.gitlab.com/api/rest/authentication/
- GitLab REST troubleshooting / status codes: https://docs.gitlab.com/api/rest/troubleshooting/
- GitLab REST namespaced paths / id vs iid: https://docs.gitlab.com/18.6/api/rest/ and https://docs.gitlab.com/api/rest/
- GitLab managing issues (web URL): https://docs.gitlab.com/user/project/issues/managing_issues/
- GitLab routing `/-/`: https://docs.gitlab.com/development/routing/
- GitLab markdown: https://docs.gitlab.com/user/markdown/
- Gitea API index (1.27.2) + auth schemes: https://docs.gitea.com/api
- Gitea Get an issue: https://docs.gitea.com/api/1.27/operations/issue-get-issue/
- Gitea API usage: https://docs.gitea.com/development/api-usage/
- Gitea `HTMLURL` / GetIssue handler: gitea `models/issues/issue.go` v1.26.2, `routers/api/v1/repo/issue.go` v1.27.2
- Fastify 5 Routes: https://fastify.dev/docs/latest/Reference/Routes/
- Fastify 5 Reply: https://fastify.dev/docs/latest/Reference/Reply/
