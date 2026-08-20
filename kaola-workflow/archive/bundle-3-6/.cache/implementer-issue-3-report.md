# implementer issue #3 — GREEN report

**Role:** implementer (production code only; tests untouched)  
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6`  
**Branch:** `workflow/bundle-3-6`  
**Issue:** #3 only (multi-source OAuth + users + sessions + approve)  
**Recorded:** 2026-08-21

## Task

Implement GitHub / GitLab / Gitea OAuth login, per-app SQLite `users` table, cookie sessions, `GET /api/v1/me`, `POST /api/v1/users/:id/approve`, and a Chinese Vue login/pending/approve surface. Oracle: `apps/server/src/auth.test.ts` (read-only) plus `placeholder.test.ts`.

## Verification tier

`tests-green`

## Before

```
node --experimental-strip-types --test apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts
```

- tests 17
- pass 1 (placeholder only)
- fail 16 (auth)

Typical RED: `GET /login` 404; OAuth start 404; `/api/v1/me` 404; `githubOAuth2.getAccessTokenFromAuthorizationCodeFlow` undefined.

## After

Same command from the worktree:

```
node --experimental-strip-types --test apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts
```

- tests **17**
- pass **17**
- fail **0**

Also: `pnpm --filter @kaola/server typecheck` exit 0; `pnpm --filter @kaola/web typecheck` exit 0.

## Files changed (this implementer)

Touched only worktree paths. Main checkout `apps/` / `packages/` / `docs/` / root `package.json` not edited.

| Path | Change |
|------|--------|
| `apps/server/package.json` | Added `@fastify/oauth2`, `@fastify/cookie`, `@fastify/session` |
| `pnpm-lock.yaml` | Lockfile for those deps |
| `apps/server/src/schema.ts` | **new** — Drizzle `users` sqliteTable |
| `apps/server/src/db.ts` | Per-call `createDb` + `CREATE TABLE IF NOT EXISTS users` |
| `apps/server/src/auth.ts` | **new** — cookie → session → three oauth2 registers + routes |
| `apps/server/src/app.ts` | `buildApp()` opens its own db (`:memory:` default); `GET /` still `getPlaceholderBody()` |
| `apps/server/src/index.ts` | `buildApp({ sqlitePath: process.env.SQLITE_PATH ?? ':memory:' })` |
| `apps/web/src/App.vue` | Chinese login / pending / approve UI |
| `apps/web/vite.config.ts` | Dev proxy `/api` and `/login` → `127.0.0.1:3000` |

**Not written/edited:** `apps/server/src/auth.test.ts`, `placeholder.test.ts`, `packages/forge-adapters/**`, `packages/shared/**`, `docs/DESIGN.md`, root `package.json`.

Worktree also has unrelated `packages/forge-adapters` edits from the other implementer (issue #6); those were not part of this work.

## Deps added (`@kaola/server`)

- `@fastify/oauth2@^8.3.0`
- `@fastify/cookie@^11.1.2`
- `@fastify/session@^11.1.2`

## Behavior notes

- Register order: `@fastify/cookie` → `@fastify/session` → three `@fastify/oauth2` (`githubOAuth2` / `gitlabOAuth2` / `giteaOAuth2`). OAuth cookie `path: '/'`.
- GitHub uses plugin `GITHUB_CONFIGURATION`; GitLab/Gitea use instance `OAUTH_*_BASE_URL` with `/oauth/authorize`+`/oauth/token` and `/login/oauth/authorize`+`/login/oauth/access_token`.
- Each `buildApp()` creates a fresh SQLite handle (default `:memory:`) so tests do not share dirty user rows.
- Upsert is unique `(provider, remote_id)`. Re-login updates username/display_name only; does not reset `active` GitHub users back to `待批准`.
- Session stores platform `userId` only (not forge access tokens).
- Unauthenticated `GET /api/v1/me`: `Accept: application/json` → 401; otherwise 302 `/login`.

## UI notes

Tests do not cover Vue. `App.vue` is a no-router Chinese surface:

- Three login buttons (`使用 GitHub / GitLab / Gitea 登录`) as `n-button tag="a"` to `/login/github|gitlab|gitea`.
- On load, `GET /api/v1/me` with `credentials: 'include'` and `Accept: application/json`.
- `status === 待批准` shows the API `message` (same copy as the oracle).
- 正式成员 (`active` + `full`) get an approve control: user-id input + **批准**. There is no list-pending HTTP API in this issue, so the operator supplies the target id.
- Vite dev proxy forwards `/api` and `/login` to the Fastify process. `GET /` on the server remains the placeholder `考拉任务服务占位`.

## Corner (recorded)

In-memory `@fastify/session` store: sufficient for `inject` tests and a single Node process; a multi-process deploy would need a shared store. Approve UI is id-entry, not a pending-user list.
