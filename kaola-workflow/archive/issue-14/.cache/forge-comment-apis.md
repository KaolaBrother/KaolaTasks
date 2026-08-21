# Forge "create issue comment" APIs — GitHub / GitLab / Gitea

Retrieval date for every cited fact below: **2026-08-21**.

Context7 MCP was checked (`GetMcpTools` with pattern `context7|Context7`) and returned **no matching
server** — it is not available in this environment. All facts below come from official vendor docs
via `WebFetch`/`WebSearch`, or (for one Gitea gap, noted inline) directly from the Gitea Go source on
GitHub, which is as authoritative as the swagger UI it renders.

## 0. What the worktree already does (read, not invented)

Read `packages/forge-adapters/src/index.ts` (worktree
`/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14`) in full.

- `ForgeAdapter.commentOnIssue(cred: Credential, issueRef: IssueRef, body: string): Promise<void>` is
  the target signature (line 58); `IssueRef` is currently `export type IssueRef = unknown` (line 40);
  `createForgeAdapter` wires `commentOnIssue: notImplemented` (line 85), which throws synchronously
  (`function notImplemented(): never { throw new Error('not implemented') }`, lines 89–91).
- **Host rule, already enforced by `getPullRequest`/`importIssue`/`registerWebhook`**: GitHub always
  `https://api.github.com` (`GITHUB_API_ORIGIN`, line 67; `prApiOrigin`, lines 166–169: `if (kind ===
  'github') return GITHUB_API_ORIGIN`); GitLab/Gitea use the adapter constructor's `options.baseUrl`
  (never the pasted URL's own host) — same function, `else` branch returns
  `(options?.baseUrl ?? '').replace(/\/+$/u, '')`. `importIssue`'s `resolveImportedIssue` (lines
  432–466) calls this same `prApiOrigin` helper, so the issue-GET and the PR-GET already share one
  origin rule. A comment endpoint must reuse the identical origin for the identical `(kind, options)` —
  there is no separate "comments API host."
- **Auth headers, already implemented** (`authHeaders`, lines 522–534):
  - GitHub: `Authorization: Bearer <token>` + `User-Agent: KaolaTasks` + `Accept:
    application/vnd.github+json`.
  - GitLab: `PRIVATE-TOKEN: <token>` (no `Authorization` header at all).
  - Gitea: `Authorization: token <token>`.
  `forgePost` (lines 330–341, used today only by `registerWebhook`) already adds `Content-Type:
  application/json` on top of `authHeaders(kind, token)` for POST bodies — this is the exact pattern a
  comment POST should reuse verbatim, not a new one.
- **URL parsing that already exists but is *not* exported wholesale**: the exported
  `parseIssueUrl(kind, issueUrl): { full_name: string } | undefined` (lines 420–430) is a thin wrapper
  that **discards** the issue number/iid — it only returns `{ full_name }`. The *internal* (non-exported)
  helpers that `importIssue` actually uses do keep the number/iid:
  - `parseOwnerRepoIssueUrl` (lines 400–406): regex `^/([^/]+)/([^/]+)/issues/(\d+)$` → `{ owner, repo,
    number }`. Used for both GitHub and Gitea (issue path shape is identical: `.../issues/{n}`).
  - `parseGitlabIssueUrl` (lines 408–418): tries canonical `^/(.+)/-/issues/(\d+)$` first, then falls
    back to legacy `^/(.+)/issues/(\d+)$` → `{ namespace, iid }`.
  - `resolveImportedIssue` (lines 432–466) combines these with `prApiOrigin` to build the exact GET URL
    already used to import the issue: `{origin}/repos/{owner}/{repo}/issues/{number}` (GitHub/Gitea) or
    `{origin}/api/v4/projects/{encodeURIComponent(namespace)}/issues/{iid}` (GitLab).
  - **Confirmed by reading**: no other file re-implements this parsing; `apps/server/src/tasks.ts`
    (lines 118–122, 239–245, 385, 740–744) only ever stores/reads `issue_url` (string) and
    `repo.full_name` on a task — never a parsed number/iid. So a stored imported task has exactly:
    `issue_url`, `repo.full_name`, the task's forge `kind`, and (via the credential/repo record, not
    shown in this file) the adapter's `base_url`. **No number/iid is persisted anywhere today.**

## 1–6, 8–10: Per-forge API facts

### GitHub — Create an issue comment

Source: [docs.github.com — REST API endpoints for issue comments, "Create an issue comment"](https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#create-an-issue-comment) (retrieved 2026-08-21); auth header confirmed at [docs.github.com — Authenticating to the REST API](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api?apiVersion=2026-03-10) (retrieved 2026-08-21).

1. **Method + path**: `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` — same `/repos/{owner}/{repo}/issues/{n}` resource family `importIssue` already GETs (`GET /repos/{owner}/{repo}/issues/{issue_number}`), just with `/comments` appended. Lives on the same `https://api.github.com` origin as `importIssue`/`getPullRequest`.
2. **Auth + content-type**: `Authorization: Bearer <token>` (docs: "In most cases, you can use `Authorization: Bearer` or `Authorization: token`... if passing a JWT you must use `Bearer`" — matches the worktree's existing `authHeaders` choice of `Bearer` exactly, no change needed). Docs recommend `Accept: application/vnd.github+json`. Request content-type is `application/json` (body is JSON, per the `-d '{"body": "..."}'` curl example).
3. **JSON body field**: `body` (string, required) — **same field name** `commentOnIssue`'s own parameter is already named (`body: string` in the interface signature), no translation needed for GitHub.
4. **Success status + response shape**: `201 Created`. Response body is an `Issue Comment` object (`id`, `body`, `html_url`, `issue_url`, `created_at`, `user`, etc. — full schema in the doc). For `commentOnIssue`'s `Promise<void>` contract, the only thing that matters is `res.ok` / status `201`; no field needs to be read out of the response.
5. **Error statuses**: `403` Forbidden, `404` Resource not found, `410` Gone, `422` Validation failed or "the endpoint has been spammed" (secondary rate limit). No `401` is listed on *this specific* operation's table, but `401` is the standard "bad/missing credentials" response for the API as a whole (seen on other GitHub endpoints in the same doc set, e.g. "Pin an issue comment" lists `401`). Issue-number vs iid: **not applicable to GitHub** — GitHub has only one identifier, the plain issue number, same as `importIssue` already uses.
6. **Identify issue from URL**: same shape `importIssue` already parses — `.../issues/{n}` → `owner`, `repo`, `number` via the existing (internal) `parseOwnerRepoIssueUrl` regex `^/([^/]+)/([^/]+)/issues/(\d+)$`.
7. **Host rule**: `https://api.github.com`, always — confirmed same origin as `importIssue`/`getPullRequest` (GitHub never varies its API host in this codebase, per `GITHUB_API_ORIGIN`).
8. **API family**: Issues API (there is no separate "Notes" concept on GitHub — comments are a sub-resource of Issues, and PRs are issues too). No scopes are explicitly named on the comment-creation page itself; GitHub's general REST auth docs describe scoped PATs/fine-grained PATs but the comment endpoint's own doc page lists no `required scopes` field (fine-grained PATs need "Issues" repository permission — this is general GitHub PAT knowledge, not stated on the operation page itself, so treat the *exact* scope name as **not confirmed on this specific page**).
9. **Rate limit / idempotency**: doc explicitly warns "Creating content too quickly using this endpoint may result in secondary rate limiting" and links to "Rate limits for the API" / "Best practices for using the REST API" — but **no idempotency key is documented** for this endpoint. Do not invent one.
10. **Markdown**: Yes. The endpoint supports `application/vnd.github.raw+json` / `.text+json` / `.html+json` / `.full+json` custom media types specifically to control *how the stored Markdown body is rendered back* (`body`, `body_text`, `body_html`) — this only makes sense if the stored `body` is Markdown source. Default (no special `Accept`) returns raw Markdown in `body`.

### GitLab — Create an issue note

Source: [docs.gitlab.com — Notes API, "Issues" → "Create an issue note"](https://docs.gitlab.com/api/notes/#create-an-issue-note) (retrieved 2026-08-21). GLFM confirmed at [docs.gitlab.com — GitLab Flavored Markdown (GLFM)](https://docs.gitlab.com/17.6/user/markdown/) (retrieved 2026-08-21).

1. **Method + path**: `POST /projects/:id/issues/:issue_iid/notes` — GitLab's terminology is **"notes,"** not "comments." `:id` is "The ID or URL-encoded path of the project" — exactly what the worktree's `resolveImportedIssue`/`prApiUrl` already pass as `encodeURIComponent(parsed.namespace)` when building the issue-GET URL (`{origin}/api/v4/projects/{namespace}/issues/{iid}`). Same origin, same project-id encoding, `/notes` appended after `/issues/{iid}`.
2. **Auth + content-type**: `PRIVATE-TOKEN: <your_access_token>` header — **identical** to the worktree's existing `authHeaders` for `kind === 'gitlab'` (`{ 'PRIVATE-TOKEN': token }`), no `Authorization` header used at all. The doc's own curl examples pass `body` as a URL query parameter (`?body=note`) rather than a JSON payload, but the `body` **attribute** in the parameters table is documented as a normal request attribute (`Attribute: body`, `Type: string`, `Required: yes`) — GitLab's API accepts attributes either as query-string params or as a JSON request body (this is a general GitLab REST API convention, not specific to this endpoint's doc text); the worktree's existing `forgePost` sends a JSON body with `Content-Type: application/json` for every other adapter POST (webhooks), so mirror that: JSON body, not query string.
3. **JSON body field**: `body` — **same field name as GitHub**, and the same name as `commentOnIssue`'s own `body` parameter, so no translation needed here either (contrary to a "note vs body" assumption — GitLab's *resource* is called a "note," but the payload field itself is still `body`, not `note`).
4. **Success status + response shape**: The doc doesn't print an explicit status-code table for "Create an issue note" (unlike GitHub's per-status breakdown), but it returns the created note object (`id`, `body`, `author`, `created_at`, `noteable_type: "Issue"`, `noteable_iid`, etc.) — same shape as "Retrieve an issue note." GitLab's REST convention for `POST` note-creation is `201 Created` (standard GitLab API behavior for resource-creating POSTs); treat any `2xx`/`res.ok` as success for the `Promise<void>` contract, consistent with how `registerWebhook` today only checks `res.ok` and not a specific status.
5. **Error statuses**: not enumerated on this specific page either, but GitLab's project/`:id` resolution (`404` if project not found), note creation (`400`/`422` on validation, e.g. empty `body`), and standard auth failures (`401` missing/bad token, `403` forbidden if the token lacks the needed access level) are the general GitLab API error conventions — **not explicitly re-stated on the Notes API page itself**, so treat the exact codes as inferred-from-general-GitLab-convention rather than page-confirmed. Issue-number vs iid: **matters** — GitLab's path parameter is explicitly `issue_iid` (the *project-scoped* issue number shown in the UI/URL), never the global `issue_id`. This is exactly the `iid` the worktree's `parseGitlabIssueUrl` already extracts (both canonical `.../-/issues/{iid}` and legacy `.../issues/{iid}` map to the same `iid` group).
6. **Identify issue from URL**: same two shapes `importIssue` already parses — canonical `.../-/issues/{iid}` (regex `^/(.+)/-/issues/(\d+)$`) tried first, legacy `.../issues/{iid}` (regex `^/(.+)/issues/(\d+)$`) as fallback — both yield `{ namespace, iid }`.
7. **Host rule**: adapter constructor `options.baseUrl`, **never** the pasted URL's own host — confirmed same as `importIssue`/`getPullRequest`/`registerWebhook` (all GitLab calls in the worktree go through `prApiOrigin`/`apiUrl`, which only ever reads `options?.baseUrl`, and the note-creation URL just appends `/notes` onto the identical `{origin}/api/v4/projects/{namespace}/issues/{iid}` path `resolveImportedIssue` already builds).
8. **API family**: **Notes API**, a *separate* named API from GitLab's Issues API (GitLab explicitly documents "Notes" as its comment/system-record resource, distinct from the Issues resource that `importIssue` calls). No specific token scope is named on the Notes API page; general GitLab PAT scope for write access to project resources is `api` (this is general GitLab knowledge, not stated verbatim on this specific page — flag as not directly confirmed here).
9. **Rate limit / idempotency**: page has a "Rate limits" section: "To help avoid abuse, you can limit your users to a specific number of `Create` requests per minute... see Rate limits on note creation" (an admin-configurable limit, not a fixed documented number). **No idempotency key is documented.** Do not invent one.
10. **Markdown**: Yes — GitLab Flavored Markdown (GLFM) is explicitly documented as usable in "Comments" (GitLab's docs list "Comments" first in the set of GLFM-supporting surfaces, alongside "Issues," "Merge requests," etc.).

### Gitea — Add a comment to an issue

Source: [docs.gitea.com — API operations, "Add a comment to an issue"](https://docs.gitea.com/api/1.24/operations/issue-create-comment/) (retrieved 2026-08-21; same content also at the unversioned `https://docs.gitea.com/api/operations/issue-create-comment/` per search-result cache, not independently re-fetched). Response-schema/error-code detail cross-checked against the Gitea source's swagger annotations: [`routers/api/v1/repo/issue_comment.go` (tag `v1.27.2`)](https://github.com/go-gitea/gitea/blob/v1.27.2/routers/api/v1/repo/issue_comment.go) (retrieved 2026-08-21) — the swagger UI at `docs.gitea.com/api/1.24/#tag/issue/operation/issueCreateComment` itself rendered as an empty JS shell when fetched directly, so the per-operation page above and the Go source (which is the literal source the swagger UI is generated from) were used instead; both agree.

1. **Method + path**: `POST /repos/{owner}/{repo}/issues/{index}/comments` — Gitea calls the path parameter `index`, not `issue_number`, but it is the **same plain incrementing issue number** as GitHub's `issue_number` and the same shape `.../issues/{n}` that `importIssue` already GETs (`GET /repos/{owner}/{repo}/issues/{index}` per the existing `resolveImportedIssue` Gitea branch). `/comments` appended.
2. **Auth + content-type**: doc's own curl/JS examples show `Authorization: Basic <credentials>` (Basic auth is one *supported* scheme per Gitea's general auth docs — `AccessToken` query param, `AuthorizationHeaderToken`, `BasicAuth`, etc.), but the worktree already uses (and Gitea's own "API Usage" doc separately confirms as an accepted alternative) `Authorization: token <token>` — the doc's "AuthorizationHeaderToken" scheme, described elsewhere in Gitea's docs as "API tokens must be prepended with 'token' followed by a space" (`Authorization: token <token>` — the header parameter name is `Authorization`, matching the worktree's existing Gitea branch exactly). Request content-type: `Content-Type: application/json`.
3. **JSON body field**: `body` (string, required) — request schema is named `CreateIssueCommentOption { body: string }`. **Same field name as GitHub/GitLab**, matches `commentOnIssue`'s own `body` parameter.
4. **Success status + response shape**: `201`, response object named `Comment` (`id`, `body`, `html_url`, `issue_url`, `pull_request_url`, `created_at`, `updated_at`, `user`, `assets`, etc.). For `Promise<void>`, only the `201`/`res.ok` matters.
5. **Error statuses**: `403` (forbidden — e.g. issue locked and caller lacks write access, or caller is blocked by the repo owner/issue poster per the Go source's `user_model.ErrBlockedUser` check), `404` (not found — repo/issue lookup failure), `423` (repo archived — Gitea-specific: `APIRepoArchivedError`, "raised when an archived repo should be modified"). **`423` has no GitHub/GitLab equivalent documented on their comment-creation pages** — this is a Gitea-only status the shared adapter code must be prepared to see only from Gitea. `401`/`422` are not listed on this specific operation's response table (unlike GitHub, which does list `422`); a missing/bad token still fails via Gitea's general auth layer (typically `401`), but that is not stated on *this* page's response table specifically. Issue-number vs iid: **not applicable** — Gitea, like GitHub, has only the one plain issue number/`index`, same as `importIssue` already uses for Gitea.
6. **Identify issue from URL**: same shape as GitHub — `.../issues/{n}` → `owner`, `repo`, `number`/`index`, via the same existing (internal) `parseOwnerRepoIssueUrl` regex already shared between GitHub and Gitea in `resolveImportedIssue`.
7. **Host rule**: adapter constructor `options.baseUrl`, never the pasted URL's own host — confirmed same as `importIssue`/`getPullRequest`/`registerWebhook` Gitea branches (all go through `prApiOrigin`, which reads `options?.baseUrl` for any non-GitHub kind), and the comment URL is `{origin}/api/v1/repos/{owner}/{repo}/issues/{index}/comments` — identical origin+prefix to the existing `resolveImportedIssue` Gitea branch (`{origin}/api/v1/repos/{owner}/{repo}/issues/{number}`), just with `/comments` appended.
8. **API family**: Issues API — the same `issue` swagger tag/operation group the Go source's `// swagger:operation ... issue issueCreateComment` comment shows GitEA's issue-GET/issue-list endpoints also belong to. No separate "Notes" concept in Gitea. No specific token *scope* is named on the operation page itself; Gitea's general "API Usage" doc (`docs.gitea.com/development/api-usage`) documents a coarse `issue` permission category with `read`/`write` granularity (`write:issue` would be the applicable scope name by that general convention), but that scope name is **not stated on the comment-creation operation page itself** — flag as inferred from a different, general doc page, not this one.
9. **Rate limit / idempotency**: **neither is mentioned** on the operation page or in the Go source snippet reviewed. Do not invent a rate limit or an idempotency key for Gitea.
10. **Markdown**: Not stated verbatim on this specific operation page, but Gitea's issue/comment `body` fields are universally documented elsewhere (Gitea's Markdown docs, its issue/PR UI) as rendering Markdown ("Gitea Flavored Markdown") the same way GitHub/GitLab do — this is well-established Gitea behavior but, to be strict about not overclaiming from *this* page alone: the create-comment operation page itself does not print a "supports Markdown" note the way GitHub's page's media-type list implicitly does. Treat as **very likely true but not verified on this exact page**.

## 7. Host/API-origin rule — explicit re-confirmation

**Rule** (already enforced by `importIssue`/`getPullRequest`/`registerWebhook`, must not be violated by `commentOnIssue`):

- GitHub: always `https://api.github.com`.
- GitLab / Gitea: always the adapter constructor's `options.baseUrl`, **never** derived from the host of the pasted issue URL.

All three vendor docs above describe the comment/note-creation endpoint as living on the exact same API namespace as the issue-GET endpoint each adapter already calls (`/repos/{owner}/{repo}/issues/{n}/...` for GitHub/Gitea; `/api/v4/projects/{id}/issues/{iid}/...` for GitLab) — there is no vendor-documented separate host or API version for comments vs. issues on any of the three forges. Confirmed by reading `prApiOrigin`/`resolveImportedIssue` in the worktree: the comment URL for each kind is literally `{same origin + prefix + issue path resolveImportedIssue already builds} + {comment suffix}`.

## Recommended `IssueRef` shape — buildable from a stored task, zero extra GET

**Constraint from the worktree** (confirmed by reading, §0 above): a stored imported task record has
`issue_url` (string) + `repo.full_name` (string) + the task's forge `kind` + (elsewhere) the adapter's
`base_url` for that forge instance. **No issue number/iid is persisted.** The exported `parseIssueUrl`
helper deliberately drops the number/iid, so it cannot be reused as-is to build a comment URL.

Because every vendor's comment/note endpoint is `{issue-GET path} + {comment suffix}` on the identical
origin, and the worktree's *internal* (non-exported) URL parsers (`parseOwnerRepoIssueUrl`,
`parseGitlabIssueUrl`) already extract the number/iid from exactly this `issue_url` string with zero
network calls, the number/iid **can and should be re-parsed from the stored `issue_url` at call time** —
there is no need to persist a number/iid separately, and no need for an extra GET round-trip before
commenting.

Recommended shape (mirrors how `prUrl`/`issueUrl` are already the sole per-call identifier for
`getPullRequest`/`importIssue` — no `RepoRef` needed on those two either):

```ts
// IssueRef carries exactly what a stored imported task already has; the adapter
// re-derives owner/repo/number (or namespace/iid) from issue_url the same way
// resolveImportedIssue() already does — no extra GET.
export type IssueRef = {
  issue_url: string
}
```

`cred`/`kind`/`options.baseUrl` already flow in separately via the existing `(kind, options, cred, ...)`
parameter pattern every other adapter function uses — `IssueRef` itself only needs to carry the one
thing that varies per call and isn't already implied by which `ForgeAdapter` instance you're holding:
the issue's URL. This keeps `commentOnIssue`'s call site identical in shape to `getPullRequest(cred,
prUrl)` — just swap `prUrl: string` for an object wrapping `issue_url` if a richer `IssueRef` is wanted
for future fields (e.g. a cached number/iid) — but the **minimum viable, zero-round-trip shape is just
`{ issue_url: string }`**, reusing `resolveImportedIssue`'s existing (internal) parsing verbatim (it
already returns an `apiUrl` for the issue resource itself; a `commentOnIssue` implementation would call
the same resolver and append the per-forge comment suffix, or add a sibling resolver that does the same
regex work and returns the comments-collection URL directly).

Do **not** try to parse a number/iid out of `repo.full_name` — that field is deliberately just
`owner/repo` (GitHub/Gitea) or `namespace` (GitLab), with no issue identifier in it at all (confirmed:
`parseIssueUrl`'s return type is `{ full_name: string }`, nothing else).

## Summary table

| kind | method | path template | auth header | JSON body | success status | issue id field |
|---|---|---|---|---|---|---|
| github | `POST` | `/repos/{owner}/{repo}/issues/{issue_number}/comments` (origin always `https://api.github.com`) | `Authorization: Bearer <token>` (+ `Accept: application/vnd.github+json`) | `{ "body": string }` | `201` | plain issue number (no iid distinction) |
| gitlab | `POST` | `/api/v4/projects/{id}/issues/{issue_iid}/notes` (origin = adapter `options.baseUrl`) | `PRIVATE-TOKEN: <token>` | `{ "body": string }` | not stated on this doc page; standard GitLab creation convention is `201` — treat any `res.ok`/`2xx` as success | `issue_iid` (project-scoped; canonical URL is `.../-/issues/{iid}`, legacy `.../issues/{iid}`) — **iid, not a global issue id** |
| gitea | `POST` | `/api/v1/repos/{owner}/{repo}/issues/{index}/comments` (origin = adapter `options.baseUrl`) | `Authorization: token <token>` | `{ "body": string }` | `201` | plain issue number/`index` (no iid distinction) |

## "Do not invent" list

- **GitLab exact success status code** for `POST .../notes` — the Notes API page does not print a status-code table for this operation (unlike GitHub's explicit `201`). Treated above as "standard GitLab creation convention, verify with `res.ok`," not as a confirmed `201` from this page.
- **GitLab full error-status table** for note creation (`400`/`401`/`403`/`404`/`422`) — not enumerated on the Notes API page itself; only inferred from general GitLab REST conventions used elsewhere in GitLab's docs, not from this specific operation's documented response table.
- **Any idempotency key or idempotency mechanism for any of the three forges** — none of the three official docs mention one for comment/note creation. Do not add an `Idempotency-Key` header or client-generated dedup token unless a future doc pass finds one documented.
- **Exact token scope names required** — GitHub's fine-grained PAT "Issues" permission, GitLab's `api` scope, and Gitea's `write:issue` scope are all **general platform knowledge from other doc pages**, not stated verbatim on each vendor's specific comment/note-creation operation page. Don't assert a specific scope string as "required by this endpoint" without re-checking a scopes-focused doc page.
- **Gitea `401` on this specific endpoint** — not listed in the operation's own response table (only `201`/`403`/`404`/`423` are). A bad/missing token almost certainly still fails (via Gitea's general auth middleware), but that specific status code is not confirmed *for this operation* by the page fetched.
- **Whether Gitea's create-comment endpoint renders Markdown** — inferred from Gitea's general Markdown support, not stated on the operation page itself. Don't cite the operation page as the source for "Gitea comments are Markdown."
- **A generic/unified "comment" payload shape across all three forges** — do not build one. Field name (`body` in all three, confirmed) happens to coincide, but success status, error status sets (`423` is Gitea-only; GitLab's table is unconfirmed), and the issue-id semantics (`iid` vs plain number) genuinely differ, matching this project's existing "one shared spec, three implementations" pattern for `getPullRequest`/`importIssue`/`registerWebhook`.
