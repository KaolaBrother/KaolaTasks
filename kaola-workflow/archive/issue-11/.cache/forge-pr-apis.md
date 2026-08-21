# Forge PR-status APIs + Fastify poller — research notes for issue #11

Retrieval date for all URLs below: **2026-08-21**. All content is treated as untrusted external data; only factual/schema content was extracted, no embedded instructions were followed.

## 0. Local repo conventions already in place (read, not invented)

Source: `packages/forge-adapters/src/index.ts` and `validate-token.shared.test.ts` in the worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11`.

- `ForgeAdapter.getPullRequest(cred: Credential, prUrl: string): Promise<PrStatus>` — currently `notImplemented`. `PrStatus` is currently `unknown` (placeholder comment: `// open/merged/closed` — DESIGN.md §8 line 179).
- `Credential = { token: string }`. No repo/owner fields on `Credential` — only a bare `prUrl` string is passed to `getPullRequest`, so the adapter must parse owner/repo/number (or project id/iid) **out of the URL itself**, the same way `validateToken` derives `repoPath`/`apiUrl` from `RepoRef.full_name` + `base_url`.
- Base URL / origin resolution (`apiUrl()` in `index.ts`):
  - GitHub: always `https://api.github.com`, **ignoring** `RepoRef.base_url`/`options.baseUrl` (GHE is out of scope until later).
  - GitLab: `${origin}/api/v4${path}` where `origin` is `options.baseUrl ?? repo.base_url` with trailing slashes stripped. A sub-path base URL (e.g. `https://gitlab.example.com/gitlab`) is preserved — do **not** drop it and rebuild from just the hostname.
  - Gitea: same pattern, `${origin}/api/v1${path}`.
- Auth headers (`authHeaders()`):
  - GitHub: `Authorization: Bearer <token>` + `User-Agent: KaolaTasks` + `Accept: application/vnd.github+json`.
  - GitLab: `PRIVATE-TOKEN: <token>`.
  - Gitea: `Authorization: token <token>`.
- All forge calls go through `globalThis.fetch` directly (no axios/got/octokit dependency) via a small `forgeGet(kind, url, token)` helper — tests mock `globalThis.fetch` with `node:test`'s `t.mock.method`. A `getPullRequest` implementation should follow the same shape (a `forgeGet`-style call, `Response.json()`), not introduce a new HTTP client.
- GitLab project id in path segments must be `encodeURIComponent(full_name)` (e.g. `acme%2Fapp`), never the raw `owner/repo` string — this generalizes to whatever project identifier is derived from a project's own `id` when the PR URL is parsed.
- `apps/server/package.json` (checked directly): `"fastify": "^5.4.0"`, `"@kaola/forge-adapters": "workspace:*"`. No `fastify-plugin`, no cron/scheduler package, no HTTP client library dependency currently present.

## 1. GitHub REST — Get a pull request

**Source:** https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request (official GitHub REST API docs, GitHub REST API version header shown as `X-GitHub-Api-Version: 2026-03-10` in the fetched page).

- Endpoint: `GET /repos/{owner}/{repo}/pulls/{pull_number}` — `owner`, `repo` (string, case-insensitive), `pull_number` (integer) are path params.
- Response schema is the same as "Create a pull request" (§ same doc page). Verified relevant fields on the PR object (all directly transcribed from the docs' response schema list):
  - `state`: required, string, enum `open`, `closed` — **not** three-valued; GitHub encodes "merged" separately.
  - `merged`: required, boolean — `true` once the PR has been merged.
  - `merged_at`: required, string or null, format date-time — non-null once merged.
  - `merged_by`: required, any of `null` / `Simple User`.
  - `draft`: boolean.
  - `html_url`, `diff_url`, `patch_url`: required string (uri) — the PR's web URL and diff/patch download URLs.
  - `number`: required integer (the PR number, matches the URL path segment).
- **Derivation rule for a 3-way `open | merged | closed` status** (not itself a literal field, must be derived): if `merged === true` → `merged`; else if `state === 'closed'` (and not merged) → `closed`; else (`state === 'open'`) → `open`. This mirrors GitHub's own convention documented on this page and matches the separate "Check if a pull request has been merged" endpoint (`GET /repos/{owner}/{repo}/pulls/{pull_number}/merge`, 204 if merged / 404 if not) which exists specifically because `state` alone conflates closed-unmerged and closed-merged.
- Auth: this repo already uses `Authorization: Bearer <token>` + `User-Agent` + `Accept: application/vnd.github+json` for `validateToken`; the docs page's note block confirms: "Most endpoints use `Authorization: Bearer` and `Accept: application/vnd.github+json` headers, plus `X-GitHub-Api-Version`" — consistent with existing `authHeaders()`.
- Media type note (relevant to URL-parsing pitfall #4 below): passing `Accept: application/vnd.github.diff` on the *same* `GET .../pulls/{pull_number}` endpoint returns the diff instead of JSON — so the adapter must send `Accept: application/vnd.github+json` (as it already does) and must not accidentally hit a `.diff`-suffixed URL if a user pastes one.

## 2. GitLab REST — Merge request status

**Source:** https://docs.gitlab.com/api/merge_requests/ (official GitLab API docs, "Merge requests API" page).

- Endpoint to retrieve one MR: `GET /projects/:id/merge_requests/:merge_request_iid` ("Retrieve a merge request" section). `id` = integer or string (numeric project ID **or** URL-encoded path, e.g. `namespace%2Fproject` — same encoding convention already used by this repo's `repoPath()` for GitLab). `merge_request_iid` = integer, the *project-scoped* IID (not the global MR id).
- Response field, verified verbatim from the docs' attribute table (appears for both the list and single-MR response tables): `state` — string — "The current state of the merge request. Possible values: `opened`, `closed`, `merged`, or `locked`."
- So GitLab's `state` is **four-valued**, not three: `opened`, `closed`, `merged`, `locked`. `locked` is documented elsewhere on the same page as "generally short-lived and transitional" (used while a merge is being carried out). For the `open | merged | closed` `PrStatus` contract, a reasonable mapping (not itself given verbatim by GitLab, since GitLab's own vocabulary has 4 states) is: `opened` → `open`, `merged` → `merged`, `closed` → `closed`, and `locked` needs an explicit decision (treat as `open` since it is a transient state en route to `merged`, per GitLab's own description) — this is a design choice, not a verified vendor fact, and should be called out as such in the PR/implementation.
- Other confirmed fields on the same response: `merged_at` (dateTime, timestamp of when merged), `merge_commit_sha` (string, null until merged), `closed_at` (dateTime), `web_url` (string, web URL of the MR).
- Self-hosted `base_url` matters: GitLab API is always mounted at `<base_url>/api/v4/...` (already implemented in this repo's `apiUrl()`); confirmed by the docs' curl example `--url "https://gitlab.example.com/api/v4/projects/1/merge_requests"`.
- Auth: docs' curl example uses `--header "PRIVATE-TOKEN: <your_access_token>"` — matches this repo's existing `authHeaders()` for GitLab exactly.

## 3. Gitea REST — Pull request get API

Gitea's own hosted API docs (`docs.gitea.com/api/1.20/...` anchor guessed) returned **404 — could not be fetched**; documenting that explicitly rather than guessing an anchor. Falling back to Gitea's actual server-side source code on GitHub, which is the authoritative implementation of the documented Swagger/OpenAPI contract (Gitea's docs are auto-generated from these same Go struct tags and route comments, per `docs.gitea.com/development/api-usage/`, itself fetched and confirmed: "API Reference guide is auto-generated by swagger... The OpenAPI document is at `https://gitea.your.host/swagger.v1.json`" — i.e. there is no single stable vendor-hosted swagger page to fetch; it's per-instance).

**Sources (fetched from github.com/go-gitea/gitea, the vendor's own repository):**
- Route/handler: https://github.com/go-gitea/gitea/blob/v1.27.2/routers/api/v1/repo/pull.go — `GetPullRequest` handler, swagger comment block:
  ```
  swagger:operation GET /repos/{owner}/{repo}/pulls/{index} repository repoGetPullRequest
  parameters: owner (path, string, required), repo (path, string, required), index (path, integer/int64, required)
  responses: "200" -> "#/responses/PullRequest", "404" -> "#/responses/notFound"
  ```
- Struct: https://github.com/go-gitea/gitea/blob/v1.27.1/modules/structs/pull.go (and the same struct at a later ref, `356f589f`) — the `PullRequest` API struct's JSON tags, verified verbatim:
  - `state`: (via the embedded `Issue`-like fields — the struct also carries a top-level pull `State *string \`json:"state"\`` on the *edit* option, and the response struct includes `HTMLURL string \`json:"html_url"\``, etc.) — for status specifically:
  - `Mergeable bool \`json:"mergeable"\`` — whether it *can* be merged (not whether it *has been*).
  - `HasMerged bool \`json:"merged"\`` — whether the PR **has been** merged.
  - `Merged *time.Time \`json:"merged_at"\`` — pointer/nullable timestamp.
  - `MergedCommitID *string \`json:"merge_commit_sha"\``.
  - `MergedBy *User \`json:"merged_by"\``.
  - `Closed *time.Time \`json:"closed_at"\``.
  - `HTMLURL string \`json:"html_url"\``, `DiffURL string \`json:"diff_url"\``, `PatchURL string \`json:"patch_url"\``.
- Cross-checked against a third-party JSON-Schema mirror of the same Gitea Swagger spec, https://apis.io/schemas/gitea/gitea-rest-api-pullrequest/ (fetched, mirrors the same field set: `merge_base`, `merge_commit_sha`, `mergeable`, `merged`, `merged_at`, `merged_by`, `milestone`, `number` — consistent with the Go source above, used only as corroboration, not as the primary source).
- A Gitea docs mirror (`go-gitea-gitea.mintlify.app/api/pull-requests`, third-party-hosted, **not** `docs.gitea.com` — treat as lower-confidence corroboration only) shows an example response with **`"state": "open"`** alongside `"mergeable": true, "merged": false` — confirming Gitea's `PullRequest` JSON does carry a separate top-level `state` string (`open`/`closed`) in addition to the `merged` boolean, matching the same "state + merged boolean" shape as GitHub, not GitLab's single 4-way enum.
- **Derivation rule** (same shape as GitHub, verified consistent across both primary source and mirror): `merged === true` → `merged`; else `state === 'closed'` → `closed`; else `state === 'open'` → `open`.
- Endpoint pattern for self-hosted `base_url`: `{base_url}/api/v1/repos/{owner}/{repo}/pulls/{index}` — consistent with this repo's existing `apiUrl()` (`${origin}/api/v1${path}`) and `repoPath()` conventions.
- Merge-check-only endpoint also exists (mirrors GitHub's): `GET /repos/{owner}/{repo}/pulls/{index}/merge` for a boolean-only merged check, not needed if the full PR object already carries `merged`/`merged_at`.
- Auth header: not independently re-verified against Gitea's docs in this pass (docs.gitea.com page fetch failed); this repo's existing `authHeaders()` already sends `Authorization: token <token>` for Gitea and that convention is unchanged by this research — do not alter it without a separate check against a live Gitea instance/docs page if that becomes contentious.

## 4. URL parsing pitfalls (owner/repo/number extraction from `prUrl`)

Verified web-URL path shapes, one per forge:

- **GitHub**: `https://github.com/{owner}/{repo}/pull/{number}` — singular path segment `pull` (not `pulls`). The REST API path is `pulls` (plural) — `/repos/{owner}/{repo}/pulls/{pull_number}` — so a naive string-replace of `github.com` → `api.github.com` on the web URL will *not* produce a valid API path; the `pull` → `pulls` segment rename must be explicit. Source: GitHub REST docs path syntax (`GET /repos/{owner}/{repo}/pulls/{pull_number}`) fetched above; the `/pull/{number}` web URL shape is GitHub's long-standing, well-known convention (not independently re-fetched from a GitHub docs page in this pass, since the REST docs page only documents the API path, not the web URL — flagging this as based on general, but very stable, GitHub product knowledge rather than a freshly fetched vendor doc).
- **GitLab**: `https://{host}/{namespace}/{project}/-/merge_requests/{iid}` — the `/-/` scope segment is mandatory in current GitLab and was introduced specifically to disambiguate project routes; confirmed from GitLab's own source, https://gitlab.com/gitlab-org/gitlab/-/commit/e700c232711f0fab7a4608d4db816d1ecd7b762a ("Move merge request routes under /-/ scope") which shows the route change from `{project}/merge_requests/{id}` to `{project}/-/merge_requests/{id}`. Also, `{namespace}/{project}` can itself contain multiple slashes (subgroups), so "owner/repo" is not a fixed 2-segment split for GitLab — the project path is "everything before `/-/merge_requests/`". Getting from a web URL to the API requires two hops: (1) resolve the numeric/URL-encoded project id via `GET /projects/:id` (id = URL-encoded full path), then (2) `GET /projects/:id/merge_requests/:iid` — confirmed by GitLab's own docs and by a GitLab internal skill/recipe doc found in the search (`gitlab.com/gitlab-org/orbit/knowledge-graph` issue #725) describing exactly this 2-step lookup, though this repo's adapter can skip the extra `GET /projects/:id` round trip if it already encodes the path directly as the `:id` path segment (GitLab's `:id` accepts "integer or string" = numeric ID or URL-encoded path per the docs table fetched above) — so `GET /projects/{urlencode(namespace/project)}/merge_requests/{iid}` should work directly without a resolve step.
- **Gitea**: `https://{host}/{owner}/{repo}/pulls/{index}` — web and API both use the plural `pulls` segment (unlike GitHub, where web is singular `pull` and API is plural `pulls`), per the Gitea source/mirror docs fetched above (`GET /repos/{owner}/{repo}/pulls/{index}` API, and the mintlify mirror's example matching a `pulls/{index}` shape).
- **Trailing slash**: none of the three vendor docs pages fetched mention special trailing-slash handling for these specific PR/MR routes; treat a trailing slash as cosmetic (strip before parsing), consistent with this repo's existing `pathnameOf()` helper in `validate-token.shared.test.ts` (`.replace(/\/+$/u, '')`) and `apiUrl()`'s origin trimming — no vendor-documented special case found, this is inference from existing repo conventions, not a fetched fact.
- **`.diff` suffix**: GitHub supports fetching a PR as a diff either via `Accept: application/vnd.github.diff` on the same JSON endpoint, or (per stable GitHub convention) via a `.diff`-suffixed URL on `github.com` itself (not independently re-verified against a fetched docs page this pass — the fetched GitHub docs page only documents the `Accept` header method). If a user pastes a `.diff`-suffixed GitHub PR URL, the adapter's URL parser should strip that suffix before extracting `{owner}/{repo}/{number}`, since `.diff` is not part of the pull request identity.
- **API vs HTML host**: confirmed — GitHub's API host is always `api.github.com` regardless of the `github.com` web host (this repo's `apiUrl()` already hardcodes this and ignores `RepoRef.base_url`/`options.baseUrl` for GitHub, matching how `pull_request.html_url` (`github.com/...`) and the API's own `url` field (`api.github.com/...`) differ in the fetched GitHub PR response schema). GitLab and Gitea, by contrast, serve both their web UI and REST API from the *same* host, just under different path prefixes (`/api/v4` and `/api/v1` respectively) — confirmed by every curl example fetched from both vendors' docs, which all target the same hostname as the product's web UI.

## 5. Fastify — repeating timer inside a plugin, cleared on close

**Sources:** https://fastify.dev/docs/latest/Reference/Hooks/ (fetched in full) and https://fastify.dev/docs/latest/Reference/Server/ (fetched in full, "Shutdown lifecycle" section) and https://fastify.dev/docs/latest/Guides/Plugins-Guide/ (fetched in full). Version banner on the fetched Hooks page shows `latest (v5.12.1)`, and the version list includes `v5.4.0`; this repo pins `fastify: "^5.4.0"` in `apps/server/package.json` (checked directly, not guessed) — the `onClose` hook API is unchanged across the v5 line, no version-specific divergence found.

- **`onClose` is the mechanism**, and per the same page's "Scope" section, quoted verbatim: *"Except for `onClose`, all hooks are encapsulated."* — i.e. `onClose` is the **one** hook not subject to plugin encapsulation, so it does not require `fastify-plugin` to "escape" a `register()` scope and be seen at the app level; it always fires on `fastify.close()` regardless of which encapsulated context registered it.
- API shape (verbatim from the fetched Hooks page):
  ```js
  // callback style
  fastify.addHook('onClose', (instance, done) => {
    // Some code
    done()
  })

  // or async/await style
  fastify.addHook('onClose', async (instance) => {
    // Some async code
    await closeDatabaseConnections()
  })
  ```
  The hook receives the Fastify `instance` as first argument (useful if the interval needs `instance.log`, decorators, etc.).
- **Execution order** (fetched, verbatim pattern): child-plugin `onClose` hooks run *before* parent-plugin `onClose` hooks. Relevant if the poller is registered inside a nested plugin and other `onClose` cleanup (e.g. DB pool) exists at the root — the poller's `clearInterval` will run before root-level cleanup, which is the safe order (stop producing DB writes before the DB pool itself closes).
- **Full shutdown lifecycle** (fetched, verbatim from the Server/Factory reference page, "Shutdown lifecycle" section), in order: (1) server flagged closing / new requests get `503` or `Connection: close`; (2) `preClose` hooks; (3) connection draining; (4) `server.close()` — Node waits for in-flight requests; (5) **`onClose` hooks** — "server stopped, all requests done"; (6) the `close()` callback/Promise resolves. This confirms `onClose` fires *after* the HTTP server has stopped accepting connections and all in-flight requests finished — i.e. it is safe for `app.close()` in tests to `await` and get a guarantee the interval has been cleared by the time it resolves, with **no leaked timer** keeping the Node process/test runner alive.
- **`fastify-plugin` / `decorate` need**: **not required** just to register the interval + its `onClose` cleanup, since `onClose` isn't encapsulated (see above). `fastify-plugin` (and `decorate`) would only become necessary if the poller needs to expose something (e.g. a `fastify.pollerStop()` method, or a shared decorator) to sibling/parent plugins outside its own `register()` scope — confirmed by the fetched Plugins-Guide page's Decorators section ("if you need a utility that is available in every part of your application, take care that it is declared in the root scope of your application. If that is not an option, you can use the `fastify-plugin` utility"). No such cross-scope decorator requirement was stated in the issue-11 task description, so plain `fastify.addHook('onClose', ...)` directly on whatever instance the interval is created in is sufficient, and this repo's `apps/server/package.json` (checked directly) does **not** currently depend on `fastify-plugin`, so introducing it should only happen if the implementer actually needs cross-scope decoration — do not add the dependency speculatively.
- **No third-party scheduler package needed or recommended**: Fastify's own docs describe no built-in cron/interval abstraction beyond hooks + plain `setInterval`/`clearInterval`; a general web search surfaced third-party libraries (`fastify-schedule`, `node-cron`) as *optional* conveniences for "professional/complex" cases, but these are **not vendor-documented Fastify recommendations** and were not verified against any official doc — flagging explicitly that adding such a dependency is a choice, not a documented requirement, and per `apps/server/package.json` (checked directly) no such package is currently a dependency.
- Suggested pattern synthesizing the verified facts above (illustrative, not itself fetched from a single doc page — assembled from the verified `onClose` API shape + the "no fastify-plugin needed" fact):
  ```ts
  const timer = setInterval(() => { /* poll PR status */ }, intervalMs)
  app.addHook('onClose', (_instance, done) => {
    clearInterval(timer)
    done()
  })
  ```
  or the async/await form `app.addHook('onClose', async () => { clearInterval(timer) })`, per the fetched docs' two documented styles.

## Open questions / things NOT verified in this pass (do not guess)

- GitLab's `locked` MR state has no vendor-documented mapping onto a 3-valued `open | merged | closed` `PrStatus` — this is a design decision for the implementer/tdd-guide to make explicitly, not a fact this lookup can resolve.
- Gitea's official `docs.gitea.com` API reference page could not be fetched (404 on the guessed anchor); the Gitea facts above rest on the vendor's own Go source code (`go-gitea/gitea` on GitHub) plus one third-party mirror, which is strong but not identical to fetching `docs.gitea.com` directly. If exact wording of Gitea's *own* published docs page is needed later, re-attempt with the correct current anchor/version path (this pass tried `/api/1.20/...`, which no longer resolves).
- GitHub's PR *web* URL shape (`/pull/{number}` singular) was not independently re-confirmed against a freshly fetched GitHub docs page in this pass (the fetched page documents only the API path); it is extremely stable, well-known GitHub product behavior but is flagged here per the "don't guess, name what you don't know" instruction.
- Gitea's auth header convention (`Authorization: token <token>`) was not re-verified against a live Gitea docs page in this pass; it matches the code already in this repo, which was treated as sufficient given the task's instruction to make new facts match existing adapter HTTP style.
