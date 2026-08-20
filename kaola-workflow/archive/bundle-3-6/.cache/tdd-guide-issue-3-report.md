# tdd-guide issue #3 — RED report

**Role:** tdd-guide (test author only; no production code)  
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6`  
**Baseline:** `e01b5b2c325ba515514114bb9abe8edac9a26809` (`e01b5b2`)  
**Recorded:** 2026-08-21

## Files authored

| Path | Role |
|------|------|
| `.kw/worktrees/bundle-3-6/apps/server/src/auth.test.ts` | Issue #3 HTTP oracle (`node:test` + Fastify `inject`) |

Unchanged (intentionally):

- `apps/server/src/placeholder.test.ts` — still pins `getPlaceholderBody()` → `考拉任务服务占位`
- `apps/server/src/app.ts`, `db.ts`, `index.ts`, `placeholder.ts`
- `apps/web/**`, `packages/**`, `docs/DESIGN.md`, root `package.json`

Root `package.json` `"test"` file list does **not** include `auth.test.ts` yet (orchestrator will add it). Prove RED by invoking the file directly.

## How RED was proved

From the worktree, after `pnpm install` (worktree had no `node_modules`; not a production edit):

```
node --experimental-strip-types --test apps/server/src/auth.test.ts
```

Raw output: `kaola-workflow/bundle-3-6/.cache/tdd-guide-issue-3-red-run.txt`

Also:

```
node --experimental-strip-types --test apps/server/src/placeholder.test.ts
```

## Counts

| Suite | pass | fail |
|-------|------|------|
| `apps/server/src/auth.test.ts` | **0** | **16** |
| `apps/server/src/placeholder.test.ts` | **1** | **0** |

Auth tests that passed on this baseline would not be oracles. None passed.

## Failure signatures (expected on this baseline)

Production has only `GET /`. Typical RED:

1. `GET /login is allowed without a session` — `AssertionError: GET /login: 404 … 404 !== 200`
2. `GET /login/github redirects to GitHub authorize` — `404 !== 302` (same for gitlab/gitea start paths)
3. `browser-like GET /api/v1/me redirects to /login…` — `404 !== 302`
4. `JSON GET /api/v1/me without a session returns 401…` — `404 !== 401`
5. GitHub/GitLab/Gitea callback tests and approve tests — `AssertionError: githubOAuth2.getAccessTokenFromAuthorizationCodeFlow must exist so tests can stub token exchange` (`actual: 'undefined'`, `expected: 'function'`) — same for `gitlabOAuth2` / `giteaOAuth2`

## What the suite encodes (binding names from `technical-decisions.md`)

HTTP surface via `buildApp()` + `inject`. OAuth token exchange is stubbed on `githubOAuth2` / `gitlabOAuth2` / `giteaOAuth2`. `getAccessTokenFromAuthorizationCodeFlow`; userinfo is stubbed through `globalThis.fetch` (no live forges, no `nock`).

- `users` fields on `GET /api/v1/me`: `id`, `provider`, `remote_id` (string), `username`, `display_name`, `status` (`active` \| `待批准`), `permission_level` (`full` \| `claim_only`)
- GitHub first login → `待批准` + `claim_only`; GitLab/Gitea first login → `active` + `full`
- Session usable after `/login/{github,gitlab,gitea}/callback`
- Unauthenticated `/api/v1/me`: `Accept: text/html` → 302 `/login`; `Accept: application/json` → 401; neither returns a user
- Pending GitHub `message` exactly `你的账号待正式成员批准后方可认领任务。`; cannot `POST /api/v1/users/:id/approve`
- `full`+`active` member can approve: target `status` → `active`, GitHub stays `claim_only`; re-login does not revert to `待批准`; `claim_only` still cannot approve others
- Identity: same `(provider, remote_id)` reuses `id`; same numeric remote id on GitHub vs GitLab is two users
- Display-name fallbacks from the decisions table (GitHub `name` → `login`; Gitea `full_name` → `login`)
- Login start: `GET /login` 200; OAuth start paths 302 to GitHub authorize / `{OAUTH_GITLAB_BASE_URL}/oauth/authorize` / `{OAUTH_GITEA_BASE_URL}/login/oauth/authorize`

Env fixtures set in the test file (`OAUTH_*`, `SESSION_SECRET` 32 zeros, `PUBLIC_URL`).

## Stop

No production implementation. Implementer owns making this suite green.
