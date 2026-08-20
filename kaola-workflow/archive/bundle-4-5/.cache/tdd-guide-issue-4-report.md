# tdd-guide issue #4 — RED report

**Role:** tdd-guide (test author only; no production code)  
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5`  
**Baseline:** `2e280c912b8e68df9a482eba9c8a89bc22315865` (`2e280c9`)  
**Recorded:** 2026-08-21

## Files authored

| Path | Role |
|------|------|
| `.kw/worktrees/bundle-4-5/apps/server/src/agent-keys.test.ts` | Issue #4 HTTP + SQLite oracle (`node:test` + Fastify `inject` + second `better-sqlite3` handle) |

Unchanged (intentionally):

- `apps/server/src/auth.test.ts` — oauth stub / cookie jar / `applyOauthTestEnv` style copied; oracles not weakened
- `apps/server/src/placeholder.test.ts` — still pins `getPlaceholderBody()` → `考拉任务服务占位`
- `apps/server/src/app.ts`, `db.ts`, `schema.ts`, `auth.ts`, `index.ts`, `placeholder.ts`
- `apps/web/**`, `packages/**`, `docs/DESIGN.md`, root `package.json`
- `apps/server/src/vault.test.ts` — sibling #5 file appeared mid-run; not edited

Root `package.json` `"test"` file list does **not** include `agent-keys.test.ts` yet (orchestrator will add it). Prove RED by invoking the file directly. `VAULT_MASTER_KEY` is not set in this file (vault key is not required at boot).

## How RED was proved

From the worktree, after `pnpm install` (worktree had no `node_modules`; not a production edit):

```
node --experimental-strip-types --test apps/server/src/agent-keys.test.ts
```

Raw output: `kaola-workflow/bundle-4-5/.cache/tdd-guide-issue-4-red-run.txt`

Also (existing suites still invokable, not broken):

```
node --experimental-strip-types --test apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts
```

## Counts

| Suite | pass | fail |
|-------|------|------|
| `apps/server/src/agent-keys.test.ts` | **0** | **9** |
| `apps/server/src/placeholder.test.ts` + `apps/server/src/auth.test.ts` | **17** | **0** |

Agent-key tests that passed on this baseline would not be oracles. None passed.

## Failure signatures (expected on this baseline)

Production has session OAuth (`/login`, `/api/v1/me`, approve) and `GET /`, but **no** `agent_keys` table, no `/api/v1/agent-keys`, and no `/api/v1/agent/whoami`. Typical RED is Fastify default 404 (`Route … not found`) against the new surface:

1. `JSON Accept is 401 unauthorized without WWW-Authenticate; browser-like requests redirect to /login` — `AssertionError: expected 401, got 404: {"message":"Route GET:/api/v1/agent-keys not found",…}` (`404 !== 401`)
2. `missing, wrong, and non-Bearer credentials are 401 with WWW-Authenticate Bearer` — `404 !== 401` (`Route GET:/api/v1/agent/whoami not found`)
3. `a session cookie does not authorize whoami; GET /api/v1/me does not accept Bearer` — `POST /api/v1/agent-keys: 404 … 404 !== 201`
4. `pending GitHub POST /api/v1/agent-keys returns 403 with the generate-gate message` — `404 !== 403`
5. `approved GitHub claim_only can generate, list without plaintext, update last_used_at, and revoke immediately` — `GET /api/v1/agent-keys: 404 !== 200`
6. `GitLab full+active can generate keys without VAULT_MASTER_KEY; GET / stays 考拉任务服务占位` — `POST unlabeled: 404 !== 201`
7. `Gitea full+active can generate, list, and use Bearer whoami` — `POST /api/v1/agent-keys: 404 !== 201`
8. `a full member cannot list or revoke another user's key; missing and not-owned DELETE are 404 not_found` — `alice create: 404 !== 201` (body oracle `{ error: 'not_found' }` is what distinguishes this from Fastify’s default 404)
9. `SQLite stores sha256 hex of plaintext utf8, never the token, unique key_hash; failed Bearer does not set last_used_at` — `first create: 404 !== 201`

## What the suite encodes (binding names from `technical-decisions.md`)

HTTP surface via `buildApp()` + `inject`. OAuth token exchange is stubbed on `githubOAuth2` / `gitlabOAuth2` / `giteaOAuth2`. `getAccessTokenFromAuthorizationCodeFlow`; userinfo is stubbed through `globalThis.fetch` (same style as `auth.test.ts`). Env fixtures: `OAUTH_*`, `SESSION_SECRET` 32 zeros, `PUBLIC_URL`; **`VAULT_MASTER_KEY` deleted**.

- `POST /api/v1/agent-keys` session, body `{ label? }` → 201 `{ id, label, token, last_used_at: null }`. `token` is `ktk_` + 64 hex chars. Only create returns `token` (list / whoami / delete stringify must not contain it; no `key_hash` on the wire)
- `GET /api/v1/agent-keys` → 200 `{ keys: [{ id, label, last_used_at }] }`
- `DELETE /api/v1/agent-keys/:id` → 200 `{ ok: true }`. Missing / not-owned / already-deleted → 404 `{ error: 'not_found' }`
- `GET /api/v1/agent/whoami` **Bearer only**. `Authorization: Bearer <token>` (scheme case-insensitive). 200 `{ id, key_id, label, status, permission_level }` (`id` = user id). Session cookie without a valid Bearer is 401. `Token` / `Basic` schemes are 401
- Bearer 401 `{ error: 'unauthorized' }` plus `WWW-Authenticate` containing `Bearer`. Session JSON 401 (including `/api/v1/me` and unauthenticated agent-key routes) has **no** `WWW-Authenticate`. Bearer does **not** authenticate `GET /api/v1/me`
- Unauthenticated session routes: JSON Accept → 401 `{ error: 'unauthorized' }`; `Accept: text/html` → 302 `/login`
- Pending GitHub (`status` `待批准`) POST generate → 403 `{ error: 'forbidden', message: '你的账号待正式成员批准后方可生成 Agent Key。' }`
- Approved GitHub `claim_only` **can** generate / list / revoke own keys and use Bearer whoami
- GitLab / Gitea `full`+`active` can too. Optional `label` defaults to `''`; labels are not unique
- List / revoke are **own keys only** (a `full` member cannot revoke someone else’s key)
- `buildApp({ sqlitePath: tempfile })` + a second `better-sqlite3` handle: `key_hash` is sha256 hex of the plaintext utf8; must not equal the plaintext; row dump must not contain the plaintext substring; `UNIQUE` on `key_hash`
- `last_used_at` is unix seconds integer and ticks only on **successful** Bearer whoami. Failed / wrong / revoked Bearer does **not** set it
- `GET /` still `考拉任务服务占位`

## Stop

No production implementation. Implementer owns making this suite green.
