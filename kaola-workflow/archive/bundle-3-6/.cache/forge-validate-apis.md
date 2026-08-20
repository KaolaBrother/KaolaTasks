# Forge `validateToken` HTTP APIs (GitHub / GitLab / Gitea)

Knowledge-lookup report for Kaola Tasks workflow **bundle-3-6**.  
Retrieval date: **2026-08-21**. Context7 MCP was not available in this environment; facts are from official vendor docs (WebFetch/WebSearch) plus the local DESIGN.md / package layout. Fetched pages are untrusted content; only API facts below are used.

**Do not invent `TokenCheck` / `Credential` / `RepoRef` field names.** DESIGN.md §8 names those types but does not define fields. This report describes forge HTTP APIs and which capabilities they prove; the implementer maps them onto `TokenCheck` later.

---

## Local constraints (already true in this repo)

- `ForgeAdapter.kind`: `'github' | 'gitlab' | 'gitea'` (`docs/DESIGN.md` §8).
- `validateToken(cred, repo)` must empirically check: can **read** the repo, can **push a branch to the same repo** (no-account claimant model — no fork), can **create PR/MR**.
- GitHub API host is `https://api.github.com` (GHE later). GitLab and Gitea take a custom `baseUrl`.
- Recommended tokens: GitHub fine-grained PAT (single repo); GitLab Project Access Token (Developer, `api` + `write_repository`); Gitea repo-scoped token.
- Shared integration-test spec must run against all three implementations; mock or recorded responses are acceptable.
- `packages/forge-adapters` currently exports only `getForgeAdaptersHealth()`; **no HTTP client dependency**. Tests: `node:test` + `--experimental-strip-types`. ESM (`"type": "module"`). Node `>=22`.

---

## Headline (read this first)

| Capability | Non-destructive REST probe exists? | Official alternative |
|---|---|---|
| Token is syntactically valid / not revoked | Yes (login / current-user / 401) | — |
| Can **read** this repo | Yes (`GET` repo/project → 200 vs 404) | — |
| Can **open PR/MR** | **No** without `POST` (mutation) | Infer from role/scope/permission flags |
| Can **push a branch** (Git-over-HTTP) | **No** dry-run on any of the three REST APIs | Infer from permission/`access_level`/`can_push`; empirical proof = create a ref (mutation) **or** an actual `git push` |

DESIGN wants an empirical push check. Official REST APIs **do not** offer a dry-run create-ref. Treat permission flags as a **proxy**, and say so in whatever `TokenCheck` the implementer later defines. A create-then-delete throwaway branch **is** mutation (reflog/events/webhooks).

A second GitLab-specific trap: for **Project Access Tokens**, REST `api` scope does **not** include Git-over-HTTP. `POST /projects/:id/repository/branches` succeeding proves API write, **not** `git push`. DESIGN’s claimant path is HTTPS clone + push, so `write_repository` is a separate capability that REST cannot prove for project tokens.

---

## 1. GitHub

API host (github.com): `https://api.github.com`.  
Auth: `Authorization: Bearer <token>` (or `Authorization: token <token>`).  
Recommended headers: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` (docs examples also show `2026-03-10`).  
**User-Agent is required**; requests without a valid `User-Agent` are rejected.

Token prefixes (official):

| Type | Prefix |
|---|---|
| PAT (classic) | `ghp_` |
| Fine-grained PAT | `github_pat_` |
| OAuth app | `gho_` |

Sources: [Authenticating to the REST API](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api), [About authentication to GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github), [Troubleshooting the REST API](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api). Retrieved 2026-08-21.

### 1.1 Status codes that matter (401 / 403 / 404)

Quoted / paraphrased from official docs:

- **Invalid credentials** → initially **`401 Unauthorized`**. After several bad-auth attempts, GitHub temporarily rejects **all** auth attempts for that user (including valid ones) with **`403 Forbidden`** (failed-login limit).
- **Private resource + missing/insufficient auth** → **`404 Not Found`**, **not** 403. Quote: *“GitHub uses a 404 Not Found response instead of a 403 Forbidden response to avoid confirming the existence of private repositories.”*
- **Fine-grained PAT / GitHub App, token lacks the permission** → often `"Resource not accessible by personal access token"` plus **`X-Accepted-GitHub-Permissions`** listing the missing permission set (e.g. `contents=write`, `pull_requests=write,contents=read`).
- `GET /repos/{owner}/{repo}` documented statuses: **200**, **301**, **403**, **404**.
- `GET /user` documented statuses: **200**, **304**, **401**, **403**.

So for `validateToken` against a **private** repo:

| Observation | What it proves |
|---|---|
| `GET /user` → 401 | Token missing, revoked, or garbage. Do not keep retrying (failed-login lockout). |
| `GET /repos/...` → 200 | Token can **see** the repo (read-metadata at least). |
| `GET /repos/...` → 404 | Repo does not exist, **or** it is private and this token cannot see it, **or** wrong URL/trailing slash/wrong HTTP method. **Cannot distinguish missing vs private-not-found.** |
| `GET /repos/...` → 403 | Forbidden for a reason other than “hide private existence” (rate limit, SAML SSO needed, org policy, etc.). Check `X-GitHub-SSO` for classic PAT + SAML. |

Sources: [Authenticating to the REST API — Failed login limit](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api), [Troubleshooting — 404 for an existing resource](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api), [Get a repository](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28). Retrieved 2026-08-21.

### 1.2 (a) Can read the repo — `GET /repos/{owner}/{repo}`

```
GET https://api.github.com/repos/{owner}/{repo}
Authorization: Bearer <token>
Accept: application/vnd.github+json
```

**Fine-grained PAT:** repository permission **Metadata: read**. That is the permission listed for `GET /repos/{owner}/{repo}` under “Repository permissions for Metadata”. Metadata is granted automatically when any repo permission is selected.

**Classic PAT:** `repo` for private repos; public repos are readable with no scope (or `public_repo`).

**200 body fields that are useful as capability *hints* (not token-scope proof):**

```json
{
  "private": true,
  "permissions": {
    "admin": false,
    "maintain": false,
    "push": true,
    "triage": false,
    "pull": true
  }
}
```

Schema (official): `permissions.admin | maintain | push | triage | pull` booleans.

**Critical limitation:** this `permissions` object is the authenticated **identity’s role on the repository**, not a dump of the token’s granted fine-grained permissions. A fine-grained PAT with **only Metadata: read** can still return `permissions.push: true` if the user is a writer, while `POST /git/refs` will fail with “Resource not accessible by personal access token”. Do **not** treat `permissions.push` as proof of Contents: write for fine-grained PATs.

Optional companion: `GET /repos/{owner}/{repo}/collaborators/{username}/permission` (Metadata: read). Returns `permission`: `admin | write | read | none` (maintain→write, triage→read) plus `role_name`. Same limitation: it is the **user’s** calculated role, not the token’s Contents/PR grants. Need `GET /user` first to know `{username}`.

Sources: [Get a repository](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28), [Permissions required for fine-grained PATs — Metadata](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens), [Get repository permissions for a user](https://docs.github.com/en/rest/collaborators/collaborators?apiVersion=2022-11-28). Retrieved 2026-08-21.

### 1.3 Token “check” / rate-limit / login endpoints

| Endpoint | Use for PAT `validateToken`? | Notes |
|---|---|---|
| `GET /user` | **Yes** — proves the token authenticates | 401 if invalid. Classic PAT needs `user` scope only for *private* profile fields; login still returns. Fine-grained: works as the authenticated-user endpoint. |
| `GET /rate_limit` | Weak liveness only | “Accessing this endpoint does not count against your REST API rate limit.” Does **not** prove repo access. Documented 200/304/404. |
| `POST /applications/{client_id}/token` (“Check a token”) | **No** for this slice | OAuth/GitHub App only. Needs `client_id` + `client_secret` Basic auth. Invalid tokens → 404. Kaola publishes user PATs, not an OAuth app secret. |

Classic PAT **scope listing** (the useful non-destructive probe):

```
GET https://api.github.com/user
→ header X-OAuth-Scopes: repo, user
→ header X-Accepted-OAuth-Scopes: ...
```

Official: *“`X-OAuth-Scopes` lists the scopes your token has authorized. `X-Accepted-OAuth-Scopes` lists the scopes that the action checks for.”*

Fine-grained PATs **do not** use OAuth scopes. There is **no** documented header that lists granted fine-grained permissions. The documented header is `X-Accepted-GitHub-Permissions`, which lists what the **endpoint requires**, typically on insufficient-permission errors — not what the token currently has.

Sources: [Get the authenticated user](https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28), [Get rate limit status](https://docs.github.com/en/rest/rate-limit/rate-limit), [Check a token](https://docs.github.com/en/rest/apps/oauth-applications), [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), [Troubleshooting — Resource not accessible](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api). Retrieved 2026-08-21.

### 1.4 (b) Can push to that repo

**Fine-grained PAT needed to create a ref:** Contents **write** (and, if the ref update touches workflow files, also Workflows write). Listed for `POST /repos/{owner}/{repo}/git/refs`.

**Classic PAT:** `repo` (private) or `public_repo` (public). Official description of `repo`: *“Grants full access to public and private repositories including read and write access to code…”*

**Mutating empirical API:**

```
POST /repos/{owner}/{repo}/git/refs
{ "ref": "refs/heads/featureA", "sha": "<existing commit sha>" }
```

Documented statuses: **201**, **409**, **422**. No dry-run parameter. Empty repos cannot create refs. Cleanup would be `DELETE /repos/{owner}/{repo}/git/refs/{ref}` (also mutation).

**Non-destructive proxies (none are Git-over-HTTP proof):**

1. Classic PAT: `X-OAuth-Scopes` contains `repo` or (public repo) `public_repo`, **and** `permissions.push === true`.
2. Fine-grained: **no official list-of-grants.** `permissions.push` is necessary-but-not-sufficient. The only REST way to *observe* missing Contents:write is to attempt a write and read `X-Accepted-GitHub-Permissions`.
3. There is **no** GitHub REST dry-run for push.

Git `ls-remote` proves fetch, not push. `git push --dry-run` is Git protocol, not REST, and still requires a local clone.

Sources: [Git refs — Create a reference](https://docs.github.com/en/rest/git/refs), [Permissions — Contents](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens), [OAuth scopes — repo / public_repo](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps). Retrieved 2026-08-21.

### 1.5 (c) Can open a pull request

```
POST /repos/{owner}/{repo}/pulls
{ "title": "...", "head": "branch", "base": "main" }
```

This **creates** a PR. Statuses: **201**, **403**, **422**. Not a probe.

Official extra constraints (quote-level):

- *“To open or update a pull request in a public repository, you must have write access to the head or the source branch.”*
- *“For organization-owned repositories, you must be a member of the organization that owns the repository to open or update a pull request.”*

**Fine-grained PAT:** Pull requests **write** for `POST /repos/{owner}/{repo}/pulls` (table: Repository permissions for “Pull requests”, Access: write). Creating a same-repo PR from a pushed branch also needs Contents write to have created the head ref.

**Classic PAT:** `repo` / `public_repo` (same as code write; there is no separate `pull_request` classic scope).

**Non-destructive proxy:**

- Classic: `X-OAuth-Scopes` includes `repo` or `public_repo`.
- Fine-grained: no grant listing. `GET /repos/.../pulls` only needs Pull requests **read** — that does **not** prove write.
- Repo flags `has_pull_requests` / `pull_request_creation_policy` are **repository settings**, not token capability.

Sources: [Create a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28), [Permissions — Pull requests](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens). Retrieved 2026-08-21.

### 1.6 Suggested GitHub probe sequence (non-mutating)

1. `GET /user` — 401 ⇒ dead token.
2. `GET /repos/{owner}/{repo}` — 404 ⇒ cannot read (or repo missing); 200 ⇒ can read.
3. If token prefix `ghp_`: parse `X-OAuth-Scopes`; require `repo` (or `public_repo` if `private === false`); treat `permissions.push` as the role half.
4. If token prefix `github_pat_`: record `permissions.push` / `permissions.pull` as **role hints only**; do not claim Contents:write or Pull requests:write were verified.
5. Do not call `POST /applications/{client_id}/token`.

Recommended token (DESIGN): fine-grained PAT, single repo, **Contents: write** + **Pull requests: write** (Metadata comes along). That matches clone+push+open-PR on the same repo.

---

## 2. GitLab (self-hosted `baseUrl`, path prefix `/api/v4`)

### 2.1 URL joining and trailing slashes

Official REST intro:

- Root endpoint = **GitLab host name** (plus any relative URL install path).
- Path **must start with `/api/v4`**.
- Example: `https://gitlab.example.com/api/v4/projects`.
- Project paths in `:id` must be URL-encoded: `GET /api/v4/projects/diaspora%2Fdiaspora` (`/` → `%2F`). Reverse proxies that decode slashes yield 404 (`AllowEncodedSlashes NoDecode`).

**Join rule for Kaola `baseUrl`:** treat `baseUrl` as the GitLab **web origin including subpath**, **without** `/api/v4`.

```text
# strip trailing slashes, then append /api/v4 + path
https://gitlab.example.com          + /api/v4 + /projects/group%2Frepo
https://gitlab.example.com/gitlab   + /api/v4 + /projects/group%2Frepo
```

**Do not** use `new URL('/api/v4/projects', 'https://host/gitlab')` — a path starting with `/` **drops** the `/gitlab` prefix and yields `https://host/api/v4/projects`.

Safe join:

```js
function gitlabApiUrl(baseUrl, pathWithLeadingSlash) {
  const origin = String(baseUrl).replace(/\/+$/, '')
  return `${origin}/api/v4${pathWithLeadingSlash}`
}
```

Auth (official, both PAT and Project Access Token):

```http
PRIVATE-TOKEN: <token>
# or
Authorization: Bearer <token>
```

`PRIVATE-TOKEN` is the documented recommended header. Invalid/missing auth → **`401`** `{ "message": "401 Unauthorized" }`.

Sources: [REST API](https://docs.gitlab.com/api/rest/) (versioned copies 17.11 / 18.6 / 18.8 agree on `/api/v4`), [REST API authentication](https://docs.gitlab.com/api/rest/authentication/), [Troubleshooting the REST API](https://docs.gitlab.com/api/rest/troubleshooting/). Retrieved 2026-08-21.

### 2.2 Token types and scopes

**Personal access token (PAT):** attached to a user; can reach every project that user can.  
**Project access token:** scoped to **one** project; GitLab creates a **bot user** (`project_{id}_bot_{random}`). Git-over-HTTPS username = any non-blank value, password = the token.

Scope table (official, both types unless noted):

| Scope | What it grants |
|---|---|
| `api` | Complete read/write access to the **API** (and registry). |
| `read_api` | Read API only. |
| `read_repository` | Git-over-HTTP **pull** + repository files API. |
| `write_repository` | Git-over-HTTP **pull and push**. Quote: *“Uses Git-over-HTTP. Does not support API authentication.”* |

**Footnote that DESIGN depends on:**

> For a **personal** access token, `api` also grants complete read and write access to the registry and repository through Git-over-HTTP. **Group and project access tokens do not include this Git-over-HTTP clause.**

So DESIGN’s recommended Project Access Token **must** have **`api` + `write_repository`**. `api` alone on a project token can create MRs via REST and even `POST .../repository/branches` via REST, and still **fail `git push`**.

Role (access_level) on a project token is independent of scopes. Developer = **30**.

Sources: [Access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/), [Project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/), [Project access tokens API](https://docs.gitlab.com/api/project_access_tokens/). Retrieved 2026-08-21.

### 2.3 Status codes: 401 vs 403 vs 404

From [Troubleshooting the REST API](https://docs.gitlab.com/api/rest/troubleshooting/):

| Code | Meaning |
|---|---|
| 401 | User isn’t authenticated. Valid token required. |
| 403 | Request isn’t allowed (authenticated but forbidden). |
| 404 | Resource couldn’t be accessed — *“an ID … couldn’t be found, **or** the user isn’t authorized to access the resource.”* |

Same hide-private-existence pattern as GitHub. Issues API spells it out: *“If a user is not a member of a private project, a GET request on that project results in a 404 status code.”*

Sources: [Troubleshooting the REST API](https://docs.gitlab.com/api/rest/troubleshooting/), [Issues API](https://docs.gitlab.com/api/issues/), [Search API](https://docs.gitlab.com/api/search/). Retrieved 2026-08-21.

### 2.4 (a) Can read the project — `GET /projects/:id`

`:id` = numeric id **or** URL-encoded `group%2Fproject`.

```
GET {baseUrl}/api/v4/projects/{urlencoded_path}
PRIVATE-TOKEN: <token>
```

Useful **200** fields (official Projects API):

| Field | Proves / hints |
|---|---|
| `visibility` | `private` / `internal` / `public` |
| `empty_repo` | Cannot create refs from nothing if true |
| `repository_access_level` | `disabled` / `private` / `enabled` — repo feature on/off |
| `merge_requests_access_level` | MR feature on/off |
| `can_create_merge_request_in` | **boolean: whether the current user can create MRs in this project** |
| `permissions.project_access.access_level` | integer or `null` |
| `permissions.group_access.access_level` | integer or `null` |

Example from official docs:

```json
"permissions": {
  "project_access": { "access_level": 10, "notification_level": 3 },
  "group_access": { "access_level": 50, "notification_level": 3 }
}
```

Effective role ≈ `max(project_access?.access_level ?? 0, group_access?.access_level ?? 0)`.

Access-level constants (members / tokens / `min_access_level` filters — official):

| Value | Role |
|---|---|
| 10 | Guest |
| 15 | Planner |
| 20 | Reporter |
| 25 | Security Manager |
| 30 | Developer |
| 40 | Maintainer |
| 50 | Owner |

Project Access Tokens typically show a non-null `permissions.project_access` matching the token’s role (bot is a direct project member).

`GET /user` (`{baseUrl}/api/v4/user`) proves the token authenticates; returns `id`, `username`, `bot`, etc. Project-token bots have `username` like `project_123_bot_…`.

Sources: [Projects API](https://docs.gitlab.com/api/projects/), [Users API — Retrieve the current user](https://docs.gitlab.com/api/users/), [Project members — access_level](https://docs.gitlab.com/api/project_members/). Retrieved 2026-08-21.

### 2.5 (b) Can push — role table + `can_push` + scopes

Official [Roles and permissions](https://docs.gitlab.com/user/permissions/) (retrieved 2026-08-21):

| Action | First role that has it |
|---|---|
| Create new branches | Developer |
| Push to **non-protected** branches | Developer |
| Force push to non-protected branches | Developer |
| Push to **protected** branches | Maintainer (unless the protected-branch rule grants Developers) |
| Create merge request | Developer |

Developer blurb: *“Push code to non-protected branches, create merge requests, and run CI/CD pipelines.”*

**Best official non-destructive per-branch flag** — Branches API:

```
GET /projects/:id/repository/branches/:branch
```

Response includes `can_push` (boolean): *“If `true`, the authenticated user can push to this branch.”* Also `protected`, `default`, `developers_can_push`.

**Do not** require `can_push` on the **default** branch. Default is usually protected; Developer tokens **should** have `can_push: false` there and still be able to push a **new** feature branch. For DESIGN’s “push a branch to the same repo”, the proxy is:

- effective `access_level >= 30` (Developer), **and**
- `repository_access_level !== 'disabled'`.

That still does **not** prove Git-over-HTTP `write_repository` on a **project** token (see §2.2 footnote).

**PAT-only scope listing (non-destructive):**

```
GET /api/v4/personal_access_tokens/self
```

Returns `scopes: ["api", "write_repository", ...]`. Docs: `id` may be the keyword `self`. **405** if the token is not a personal access token (rotate docs: *“405 Method Not Allowed if the token is not a personal access token”*). **Do not rely on this for Project Access Tokens.**

There is **no** documented Project Access Token “self-inform scopes” endpoint.

**Mutating REST (proves API write, not git push for project tokens):**

```
POST /projects/:id/repository/branches?branch=newbranch&ref=main
```

201 Created. Cleanup: `DELETE /projects/:id/repository/branches/:branch` (204). Official docs: cannot delete default or protected branches.

Sources: [Roles and permissions](https://docs.gitlab.com/user/permissions/), [Branches API](https://docs.gitlab.com/api/branches/), [Personal access tokens API — Self-inform](https://docs.gitlab.com/api/personal_access_tokens/). Retrieved 2026-08-21.

### 2.6 (c) Can create a merge request

Non-destructive: `can_create_merge_request_in === true` **and** `merge_requests_access_level !== 'disabled'` **and** role ≥ Developer. That is the official boolean.

Mutating:

```
POST /projects/:id/merge_requests
```

Required: `source_branch`, `target_branch`, `title`. Needs an actual source branch that differs from target — so you cannot empirically open an MR without a branch (which itself is mutation if you created it).

Sources: [Projects API — `can_create_merge_request_in`](https://docs.gitlab.com/api/projects/), [Merge requests API — Create a merge request](https://docs.gitlab.com/api/merge_requests/). Retrieved 2026-08-21.

### 2.7 Suggested GitLab probe sequence (non-mutating)

1. `GET /user` — 401 ⇒ dead token.
2. `GET /projects/{urlencoded}` — 404 ⇒ cannot read (or missing); 200 ⇒ can read.
3. Effective access_level ≥ 30 ⇒ role can push non-protected branches and create MRs.
4. `can_create_merge_request_in` ⇒ MR-create flag.
5. Optional: `GET .../repository/branches/{default}` and record `can_push` / `protected` (do not fail solely because default is protected).
6. If `GET /personal_access_tokens/self` returns 200, require `api` in `scopes`; for PAT, `api` already includes Git-over-HTTP. If 401/403/405, assume Project/Group token: **cannot** REST-prove `write_repository`.

---

## 3. Gitea (`/api/v1`, custom `baseUrl`)

### 3.1 URL joining and auth

Official examples: `https://gitea.your.host/api/v1/...` and `https://gitea.com/api/v1/repos/{owner}/{repo}`.

Join the same way as GitLab: `baseUrl` = origin + optional subpath, **no** `/api/v1`; strip trailing slashes; append `/api/v1` + path. Same `new URL('/api/v1/...', baseWithSubpath)` trap.

Auth methods (official):

- `Authorization: token <token>` — *“Gitea needs the word `token` included before the API key”* (historical).
- `token=` or `access_token=` query (avoid — leaks to logs).
- HTTP Basic.
- OAuth2: `Authorization: bearer ...`.

Swagger / OpenAPI: `{base}/swagger.v1.json` or `{base}/api/swagger`.

Token scopes (create token): `read:repository` / `write:repository` (and `issue`, `user`, …). `write` implies read. `"scopes":["all"]` is full. Default new tokens have **very limited** permissions — DESIGN’s “repo-scoped token” must explicitly include **`write:repository`**.

Sources: [API Usage](https://docs.gitea.com/development/api-usage). Retrieved 2026-08-21.

### 3.2 (a) Can read the repo — `GET /repos/{owner}/{repo}`

```
GET {baseUrl}/api/v1/repos/{owner}/{repo}
Authorization: token <token>
```

Documented success: **200** `Repository`. Documented error: **404** `APINotFound`. Swagger for this operation does not list 401; treat unauthorized as 401 in practice (Gitea swagger often omits auth error codes).

Official `permissions` object on the repository:

```json
"permissions": {
  "admin": false,
  "push": true,
  "pull": true
}
```

Docs label: *“Permission represents a set of permissions”* with booleans `admin`, `push`, `pull`.

Also useful: `private`, `empty`, `has_pull_requests`, `clone_url`.

**Same caution as GitHub:** docs do not state that `permissions.push` is intersected with the **token’s** `write:repository` scope. Treat it as the authenticated identity’s repo permission. A `read:repository` token for a user who is a writer may still show `push: true` while write endpoints 403.

Sources: [Get a repository](https://docs.gitea.com/api/operations/repo-get/). Retrieved 2026-08-21.

### 3.3 Collaborator permission endpoint

```
GET /repos/{owner}/{repo}/collaborators/{collaborator}/permission
```

200 `RepoCollaboratorPermission`:

- `permission`: `none | read | write | admin | owner`
- `role_name`
- `user`

Errors: **403**, **404**.

Need the authenticated login from `GET /user` (`login` field) to query “this token’s user”. Owners may not appear as collaborators; this endpoint can 404 for the owner even when `GET /repos` succeeded with `permissions.admin: true`. Prefer the repo `permissions` object as the primary flag; use collaborator permission as a supplement.

Sources: [Get repository permissions for a user](https://docs.gitea.com/api/operations/repo-get-repo-permissions/), [Get the authenticated user](https://docs.gitea.com/api/operations/user-get-current/). Retrieved 2026-08-21.

### 3.4 (b) Can push / (c) Can open a PR

**Push (mutating):**

```
POST /repos/{owner}/{repo}/branches
{ "new_branch_name": "...", "old_ref_name": "main" }
```

No dry-run field in `CreateBranchRepoOption`. `old_branch_name` is deprecated.

**PR (mutating):**

```
POST /repos/{owner}/{repo}/pulls
{ "title": "...", "head": "branch", "base": "main" }
```

Needs `write:repository` (and typically issue/PR unit access). Repo flag `has_pull_requests: false` means the unit is disabled regardless of token.

**Non-destructive proxies:**

- `GET /user` → token lives.
- `GET /repos/...` 200 + `permissions.pull` → can read.
- `permissions.push === true` (and/or collaborator `permission` in `write|admin|owner`) → **role** can push.
- `has_pull_requests === true` → PRs enabled on the repo.
- No official Gitea “list my token scopes” endpoint analogous to GitLab `/personal_access_tokens/self` or GitHub `X-OAuth-Scopes`.

Sources: [Create a branch](https://docs.gitea.com/api/operations/repo-create-branch/), [Create a pull request](https://docs.gitea.com/api/operations/repo-create-pull-request/). Retrieved 2026-08-21.

### 3.5 Suggested Gitea probe sequence (non-mutating)

1. `GET /user` — not 200 ⇒ bad token (expect 401).
2. `GET /repos/{owner}/{repo}` — 404 ⇒ cannot read / missing; 200 ⇒ can read.
3. Record `permissions.pull` / `permissions.push` / `has_pull_requests`.
4. Do not claim Git-over-HTTP push or PR-create were empirically verified.

---

## 4. Safe non-destructive “can push” vs creating a branch

**Plain statement: none of the three forges document a REST dry-run for creating a ref or for Git-over-HTTP push.**

| Forge | Closest official non-mutating signal | What it is **not** |
|---|---|---|
| GitHub classic PAT | `X-OAuth-Scopes` contains `repo`/`public_repo` **and** `permissions.push` | Not a receive-pack check |
| GitHub fine-grained PAT | **None for Contents:write.** `permissions.push` is role, not token grant. `X-Accepted-GitHub-Permissions` appears when a write **fails**. | Cannot list grants |
| GitLab | Effective `access_level >= 30`; Branches API `can_push` on a **specific** branch | `can_push` on protected default is often false for Developer; REST branch create ≠ `write_repository` on project tokens |
| Gitea | Repo `permissions.push` | Not documented as token-scope ∩ role |

**Official mutating alternatives (if DESIGN’s “empirically check” is taken literally):**

- GitHub: `POST /repos/{owner}/{repo}/git/refs` then `DELETE .../git/refs/{ref}`.
- GitLab: `POST /projects/:id/repository/branches` then `DELETE .../branches/:branch`. Still does not prove project-token `write_repository` (Git-over-HTTP). Empirical Git-over-HTTP would be an actual `git push` (and optional delete).
- Gitea: `POST /repos/{owner}/{repo}/branches` (then delete the branch if an endpoint exists; swagger “create branch” is the documented write).

`git push --dry-run` is **not** a REST API. It still contacts `git-receive-pack`, needs a clone, and is out of scope for a thin HTTP `validateToken` unless you spawn git.

**Recommendation for this slice:** implement the **permission-proxy** probes above; document in comments that Git-over-HTTP push and PR/MR create are **inferred**, not executed. If product later requires true empirical push, that is a **mutating** probe with cleanup, and for GitLab project tokens it must be Git protocol, not REST.

---

## 5. HTTP client choice (thin `validateToken` only)

Repo today: Node ≥22, ESM, `node --experimental-strip-types`, `packages/forge-adapters` has **no** runtime HTTP dependency.

| Option | Covers 3 forges? | Extra prod dep? | Mock story | Cost vs slice |
|---|---|---|---|---|
| **Node 22 global `fetch`** (bundled undici) | Yes — it is just HTTP | **None** | `t.mock.method(globalThis, 'fetch', ...)` works with zero extra packages. Optional: npm `undici` `MockAgent` | **Cheapest sufficient** |
| npm `undici` + `fetch` from `'undici'` | Yes | Yes (`undici`) | Official `MockAgent` | Only if you want MockAgent interceptors in prod-shaped code |
| `octokit` / `@octokit/rest` | GitHub only | Heavy; conditional exports want `moduleResolution: node16`/`nodenext` | Pass `request.fetch` | Does not help GitLab/Gitea; overkill for 2–3 GETs |
| `@gitbeaker/rest` | GitLab only | Yes; `host` + `token` | Custom `requesterFn` | Same |
| `gitea-js` | Gitea only | Yes; README still tells Node to polyfill with `cross-fetch` (stale for Node 22) | `customFetch` | Same |

Evidence:

- Node 22 globals: `fetch` is stable (since v21 no longer experimental), “implementation is based upon undici”, `process.versions.undici`. Custom `dispatcher` option exists. Source: [Node.js v22 globals — fetch](https://nodejs.org/docs/latest-v22.x/api/globals.html). Retrieved 2026-08-21.
- Octokit requires Node 18+ native fetch; GitHub-only. Source: [octokit/octokit.js](https://github.com/octokit/octokit.js/). Retrieved 2026-08-21.
- `@gitbeaker/rest`: Node 18+, `host` defaults to `https://gitlab.com`. Source: [npm @gitbeaker/rest](https://www.npmjs.com/package/@gitbeaker/rest). Retrieved 2026-08-21.
- `gitea-js`: generated from `swagger.v1.json`, uses Fetch; Node sample still shows `cross-fetch`. Source: [gitea-js README](https://github.com/anbraten/gitea-js/). Retrieved 2026-08-21.

**Recommend:** one tiny `forgeFetch(url, { token, headerStyle })` using **global `fetch`**. Three header styles (`Authorization: Bearer` GitHub, `PRIVATE-TOKEN` GitLab, `Authorization: token` Gitea). No octokit/gitbeaker/gitea-js for this slice. Revisit SDKs when `importIssue` / webhooks / full adapter surface lands.

`strip-types` + ESM: keep the helper in `.ts` with explicit types; do not add a bundler. `fetch` and `Response` are global — no `@types` extra beyond existing `@types/node`.

---

## 6. Shared-spec testing pattern (Node 22 `node:test`)

One file, parameterized over `kind`. Production code must call `globalThis.fetch` (or accept an injectable `fetch` argument — even cheaper to mock). Do **not** import `fetch` from npm `undici` in production if tests stub `globalThis.fetch`.

### 6.1 Preferred: `node:test` `mock.method(globalThis, 'fetch')` — zero deps

Official: `mock.method(object, methodName[, implementation])` — added v19.1.0 / v18.13.0. Source: [Node.js v22 test runner](https://nodejs.org/docs/latest-v22.x/api/test.html). Retrieved 2026-08-21.

```ts
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { jsonResponse, installFetchScript } from './http-mock-helpers.ts'
import { createAdapter } from '../src/index.ts' // illustrative

const forges = [
  {
    kind: 'github' as const,
    origin: 'https://api.github.com',
    readPath: '/repos/acme/app',
    okBody: {
      private: true,
      permissions: { admin: false, maintain: false, push: true, triage: false, pull: true },
    },
  },
  {
    kind: 'gitlab' as const,
    origin: 'https://gitlab.example.com',
    readPath: '/api/v4/projects/acme%2Fapp',
    okBody: {
      visibility: 'private',
      can_create_merge_request_in: true,
      repository_access_level: 'enabled',
      merge_requests_access_level: 'enabled',
      permissions: {
        project_access: { access_level: 30, notification_level: 0 },
        group_access: null,
      },
    },
  },
  {
    kind: 'gitea' as const,
    origin: 'https://gitea.example.com',
    readPath: '/api/v1/repos/acme/app',
    okBody: {
      private: true,
      has_pull_requests: true,
      permissions: { admin: false, push: true, pull: true },
    },
  },
]

describe('validateToken shared spec', () => {
  for (const fx of forges) {
    it(`${fx.kind}: 200 on repo GET is treated as readable`, async (t) => {
      t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/user') || url.includes('/api/v4/user') || url.endsWith('/api/v1/user')) {
          return new Response(JSON.stringify({ login: 'bot', username: 'bot', id: 1 }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-oauth-scopes': 'repo',
            },
          })
        }
        if (url.includes(fx.readPath) || url.endsWith(fx.readPath)) {
          return new Response(JSON.stringify(fx.okBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('unexpected ' + url, { status: 599 })
      })

      const adapter = createAdapter(fx.kind, { baseUrl: fx.origin })
      const result = await adapter.validateToken(
        { token: 'test-token' },
        { owner: 'acme', name: 'app' },
      )
      // assert on whatever TokenCheck mapping the implementer defines
      assert.ok(result)
    })

    it(`${fx.kind}: 404 on repo GET is not readable`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
      const adapter = createAdapter(fx.kind, { baseUrl: fx.origin })
      const result = await adapter.validateToken(
        { token: 'test-token' },
        { owner: 'acme', name: 'app' },
      )
      assert.ok(result)
    })
  }
})
```

`t.mock.method` restores automatically when the test ends. `globalThis.fetch` **is** a function in Node 22, so `mock.method` accepts it.

Run with the repo’s existing pattern:

```bash
node --experimental-strip-types --test packages/forge-adapters/src/*.test.ts
```

### 6.2 Alternative: undici `MockAgent` (extra **dev** dependency)

Official Node learn page: undici’s `MockAgent` is bundled in Node but **not exported as `node:undici`**, so tests must `pnpm add -D undici`. Official intercept example uses `setGlobalDispatcher`. Caveat from undici’s own “vs builtin fetch” guide: installing npm `undici` does **not** replace global `fetch` unless you `install()` **or** `import { fetch } from 'undici'` in the code under test. `setGlobalDispatcher` from npm undici intercepting **builtin** `fetch` has also regressed in some undici 8.x versions.

For this repo, **prefer §6.1** so production stays on global `fetch` and tests stay zero-dep.

If MockAgent is used, official pattern ([Mocking Request](https://undici.nodejs.org/best-practices/mocking-request), [Node.js Learn — Mocking](https://nodejs.org/learn/test-runner/mocking), retrieved 2026-08-21):

```ts
import { beforeEach, afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, fetch } from 'undici'

describe('github adapter with MockAgent', () => {
  let agent: MockAgent
  const previous = getGlobalDispatcher()

  beforeEach(() => {
    agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
  })

  afterEach(async () => {
    await agent.close()
    setGlobalDispatcher(previous)
  })

  it('GET repo 200', async () => {
    agent.get('https://api.github.com')
      .intercept({ path: '/repos/acme/app', method: 'GET' })
      .reply(200, { permissions: { push: true, pull: true } })

    const res = await fetch('https://api.github.com/repos/acme/app')
    assert.equal(res.status, 200)
  })
})
```

**Only works if the adapter’s `fetch` is the same undici instance** (`import { fetch } from 'undici'` or `undici.install()`). Mixing global fetch + npm MockAgent is the footgun.

### 6.3 Shared spec shape

Keep **one** `validate-token.shared.test.ts` (or `*.spec.ts`) that loops `forges`. Per-kind differences belong in the fixture table (origin, path prefix, headers, 200 body). Assertions should be behavioral (“readable / not readable / role-can-push inferred”) once `TokenCheck` exists — not three copied test files.

Recorded fixtures (HAR / JSON files under `src/fixtures/`) are also acceptable per DESIGN; still drive them through the same loop.

---

## Mapping cheat sheet (for the implementer — still not `TokenCheck` fields)

| Need | GitHub | GitLab | Gitea |
|---|---|---|---|
| Auth header | `Authorization: Bearer` | `PRIVATE-TOKEN` (or Bearer) | `Authorization: token` |
| API root | `https://api.github.com` (not github.com) | `{baseUrl}/api/v4` | `{baseUrl}/api/v1` |
| Prove token lives | `GET /user` (401 invalid) | `GET /user` (401 invalid) | `GET /user` |
| Prove can read repo | `GET /repos/{o}/{r}` 200 | `GET /projects/{urlencoded}` 200 | `GET /repos/{o}/{r}` 200 |
| Hide private existence | 404 | 404 | 404 (swagger) |
| Role can push (proxy) | `permissions.push` | `access_level >= 30` and/or branch `can_push` | `permissions.push` |
| Token can push (scope) | classic: `X-OAuth-Scopes`; fine-grained: **unverifiable without write** | PAT: `/personal_access_tokens/self`; **project token: unverifiable via REST** | **no scope listing API** |
| Role can open PR/MR (proxy) | classic scopes; fine-grained unverifiable | `can_create_merge_request_in` | `has_pull_requests` + `permissions.push` |
| Empirical PR/MR | `POST /repos/.../pulls` (mutates) | `POST /projects/:id/merge_requests` (mutates) | `POST /repos/.../pulls` (mutates) |
| Empirical branch | `POST /git/refs` (mutates) | `POST /repository/branches` (mutates; ≠ git push for project tokens) | `POST /repos/.../branches` (mutates) |

---

## Source index (URL + retrieval date 2026-08-21)

**GitHub**

- https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
- https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
- https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28
- https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28
- https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28
- https://docs.github.com/en/rest/git/refs
- https://docs.github.com/en/rest/collaborators/collaborators?apiVersion=2022-11-28
- https://docs.github.com/en/rest/rate-limit/rate-limit
- https://docs.github.com/en/rest/apps/oauth-applications
- https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens

**GitLab**

- https://docs.gitlab.com/api/rest/
- https://docs.gitlab.com/api/rest/authentication/
- https://docs.gitlab.com/api/rest/troubleshooting/
- https://docs.gitlab.com/api/projects/
- https://docs.gitlab.com/api/users/
- https://docs.gitlab.com/api/merge_requests/
- https://docs.gitlab.com/api/branches/
- https://docs.gitlab.com/api/personal_access_tokens/
- https://docs.gitlab.com/api/project_access_tokens/
- https://docs.gitlab.com/api/project_members/
- https://docs.gitlab.com/security/tokens/access_token_scopes/
- https://docs.gitlab.com/user/permissions/
- https://docs.gitlab.com/user/project/settings/project_access_tokens/
- https://docs.gitlab.com/api/issues/ (404-for-private quote)

**Gitea**

- https://docs.gitea.com/development/api-usage
- https://docs.gitea.com/api/operations/repo-get/
- https://docs.gitea.com/api/operations/repo-get-repo-permissions/
- https://docs.gitea.com/api/operations/user-get-current/
- https://docs.gitea.com/api/operations/repo-create-branch/
- https://docs.gitea.com/api/operations/repo-create-pull-request/

**Node / HTTP clients**

- https://nodejs.org/docs/latest-v22.x/api/globals.html (fetch)
- https://nodejs.org/docs/latest-v22.x/api/test.html (`mock.method`)
- https://nodejs.org/learn/test-runner/mocking
- https://undici.nodejs.org/best-practices/mocking-request
- https://undici.nodejs.org/api/MockAgent
- https://undici.nodejs.org/best-practices/undici-vs-builtin-fetch
- https://github.com/octokit/octokit.js/
- https://www.npmjs.com/package/@gitbeaker/rest
- https://github.com/anbraten/gitea-js/

**Local**

- `docs/DESIGN.md` §7–§8
- `packages/forge-adapters/package.json` (no HTTP deps)
- `packages/forge-adapters/src/index.ts` (`getForgeAdaptersHealth` only)
