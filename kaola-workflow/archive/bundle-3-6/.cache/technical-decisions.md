# Technical decisions for bundle-3-6

Orchestrator judgments. Not DESIGN.md contracts. Evidence in parentheses. Do not treat these names as if DESIGN specified them.

Recorded 2026-08-21 after `design-measure.md` and `oauth-libraries.md`. Forge probe-API report was still pending; adapter/`TokenCheck` names wait for that report.

## Users table (#3)

- SQL table `users`. Columns:
  - `id` integer PK autoincrement (Drizzle sqlite default; §10 omits PK)
  - `provider` text not null: `github` | `gitlab` | `gitea` (same literals as `taskBriefSchema.repo.forge`)
  - `remote_id` text not null (stringify forge `id`)
  - `username` text not null
  - `display_name` text not null (English identifier for 显示名)
  - `status` text not null: `active` | `待批准` (store DESIGN §10 tokens as-is; same mixed-language pattern as task statuses)
  - `permission_level` text not null: `full` | `claim_only` (English identifier for 权限级; values from §10)
- Unique `(provider, remote_id)` (implied by forge OAuth identity + 「多账号视为多个用户」)
- Bootstrap with `CREATE TABLE IF NOT EXISTS` on the better-sqlite3 handle at process/test setup. No drizzle-kit in this issue (not a runtime requirement; cheapest sufficient).
- Do not add user types to `@kaola/shared`.

## First login mapping

| Source | `status` | `permission_level` |
|--------|----------|-------------------|
| GitHub | `待批准` | `claim_only` |
| GitLab or Gitea | `active` | `full` |

Profile fields after token exchange (`oauth-libraries.md`):

| DESIGN | GitHub | GitLab | Gitea |
|--------|--------|--------|-------|
| `remote_id` | `id` | `id` | `id` |
| `username` | `login` | `username` | `login` |
| `display_name` | `name` or fallback `login` | `name` | `full_name` or fallback `login` |

## Session / OAuth libraries

- `@fastify/oauth2@^8.3.0`, `@fastify/cookie@^11.1.2`, `@fastify/session@^11.1.2` (Fastify 5 line; session holds platform user id, not forge access tokens)
- Three `register`s: names `githubOAuth2` / `gitlabOAuth2` / `giteaOAuth2`
- Paths (cookie Path prefix): `/login/github` + `/login/github/callback` (and gitlab/gitea). Not under `/api/v1` (oauth2 cookie-path caveat; DESIGN only says 「OAuth 回调」)
- GitLab/Gitea: custom `authorizeHost`/`tokenHost` = instance origin; GitLab paths `/oauth/authorize` + `/oauth/token`; Gitea `/login/oauth/authorize` + `/login/oauth/access_token`
- Tests: `app.inject` + stub the oauth decorator (`getAccessTokenFromAuthorizationCodeFlow` + a stubbed userinfo fetch). Do not hit live forges. `nock` optional, not required if the decorator is stubbed.
- No vue-router. `GET /` stays the public placeholder (`考拉任务服务占位`).

## HTTP surface invented for #3 (DESIGN unnamed)

- `GET /api/v1/me` — session user; 401/redirect if unauthenticated. When `status` is `待批准`, JSON includes Chinese `message`: `你的账号待正式成员批准后方可认领任务。`
- Unauthenticated access to `/api/v1/me` is the protected-page oracle: redirect `302` to `/login` (HTML/page clients) or `401` for `Accept: application/json`. Prefer testing both if cheap; minimum is: browser-like GET without session does not return the user and sends the client to login.
- `POST /api/v1/users/:id/approve` — only `status=active` AND `permission_level=full` (正式成员). Sets target `status` to `active`. GitHub stays `claim_only`. Pending users cannot approve.
- `GET /login` — login page/start; unauthenticated OK.

## Env vars (none in DESIGN; unprefixed like existing `PORT`/`HOST`/`SQLITE_PATH`)

- `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`
- `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`
- `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL`
- `SESSION_SECRET` (≥32 chars; tests may hardcode a fixture)
- `PUBLIC_URL` — origin used to build `callbackUri` (default `http://localhost:3000`)

Missing GitHub client id/secret: GitHub login start fails closed. Same for the other two. Tests set fixtures.

## ForgeAdapter / validateToken (#6)

Recorded 2026-08-21 after `forge-validate-apis.md`. These names are not in DESIGN.md; they exist so tests and code share one mapping.

### Types (live in `packages/forge-adapters`, not `@kaola/shared`)

```ts
type Credential = { token: string }

type RepoRef = {
  full_name: string // GitHub/Gitea `owner/repo`; GitLab path `group/project` (may contain extra slashes)
  base_url: string  // GitLab/Gitea web origin without `/api/v4` or `/api/v1`; GitHub adapter ignores it
}

type TokenCapability = '读' | '推' | 'PR'

type TokenCheck = {
  missing: TokenCapability[]
}
```

`missing` empty ⇒ token is usable for 发布即校验. Issue #6: 「结构化的缺失项（读/推/PR）」. No `ok` field (derive in tests as `missing.length === 0`).

### Factory

`createForgeAdapter(kind: 'github' | 'gitlab' | 'gitea', options?: { baseUrl?: string }): ForgeAdapter`

- GitHub: `kind` only; API host always `https://api.github.com`.
- GitLab/Gitea: `options.baseUrl` required (strip trailing slashes, then append `/api/v4` or `/api/v1`). Never `new URL('/api/...', baseUrl)` — that drops a subpath.

### Interface vs this issue

Export the full DESIGN.md §8 `ForgeAdapter` interface. This issue implements `kind` + `validateToken` only. Other methods throw `Error('not implemented')`. Tests must not require them to succeed. Keep `getForgeAdaptersHealth()`.

### Probe (non-mutating permission proxy)

Official REST has **no dry-run** for push or PR/MR create. Do not create/delete branches. Infer:

| Item | Present in `missing` when |
|------|---------------------------|
| `读` | `GET` repo/project is not 200 (404/401/403), or token `GET /user` is 401 |
| `推` | readable but role/scope proxy says cannot push a **new non-protected branch** on the **same** repo |
| `PR` | readable but role/scope proxy says cannot open PR/MR |

GitHub: `GET /user` then `GET /repos/{owner}/{repo}`. Auth `Authorization: Bearer`. `User-Agent` required. Classic `ghp_`: `X-OAuth-Scopes` must include `repo` (or `public_repo` if public) **and** `permissions.push` for 推; same scopes for PR. Fine-grained `github_pat_`: `permissions.push` / `permissions.pull` are **role hints**; treat `permissions.push === true` as 推 proxy and `permissions.pull === true` as not sufficient for PR — require `permissions.push === true` for both 推 and PR (same-repo PR needs contents write + a writer identity; finest REST can do without mutating). Dead token (user 401) ⇒ missing `读`,`推`,`PR`.

GitLab: `GET /user` then `GET /projects/{urlencoded full_name}` with `PRIVATE-TOKEN`. 推 iff effective `access_level >= 30` and `repository_access_level !== 'disabled'`. PR iff `can_create_merge_request_in === true` and `merge_requests_access_level !== 'disabled'`. Do **not** fail because default branch `can_push` is false (protected). Cannot REST-prove project-token `write_repository`; the access_level proxy **is** the same-repo-push coverage for this issue.

Gitea: `GET /user` then `GET /repos/{owner}/{repo}` with `Authorization: token`. 读 iff 200. 推 iff `permissions.push === true`. PR iff `permissions.push === true` and `has_pull_requests !== false`.

Same-repo / no-fork: `RepoRef.full_name` is the repo being checked; adapters never call fork APIs. Tests must include a case where 读 succeeds and 推 is missing (Reporter / `permissions.push: false`) — that is the no-account-claimant prerequisite covering 「推分支到同仓库」.

HTTP: global `fetch` only. No octokit / gitbeaker / gitea-js. Tests: `t.mock.method(globalThis, 'fetch', ...)`.

Join helper: `baseUrl.replace(/\/+$/, '') + '/api/v4' + path` (GitLab) / `'/api/v1'` (Gitea). GitLab project path: encode `full_name` as `encodeURIComponent` so `/` → `%2F`.
