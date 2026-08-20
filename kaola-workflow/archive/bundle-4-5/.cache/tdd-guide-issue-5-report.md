# tdd-guide issue #5 — RED report

**Role:** tdd-guide (test author only; no production code)  
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5`  
**Baseline:** `2e280c912b8e68df9a482eba9c8a89bc22315865` (`2e280c9 chore: archive bundle-3-6 [sink]`)  
**Recorded:** 2026-08-21

## Files authored

| Path | Role |
|------|------|
| `.kw/worktrees/bundle-4-5/apps/server/src/vault.test.ts` | Issue #5 HTTP + SQLite + vault oracle (`node:test` + Fastify `inject`) |

Unchanged (intentionally):

- `apps/server/src/auth.test.ts` — oauth stub / cookie jar / `applyOauthTestEnv` style copied, file not edited
- `apps/server/src/placeholder.test.ts` — still pins `getPlaceholderBody()` → `考拉任务服务占位`
- `apps/server/src/app.ts`, `db.ts`, `schema.ts`, `auth.ts`, `index.ts`, `placeholder.ts`
- `apps/web/**` (no Vue tests this run)
- `packages/**`, `docs/DESIGN.md`, root `package.json`
- `apps/server/src/agent-keys.test.ts` — not touched (sibling #4)

Root `package.json` `"test"` file list does **not** include `vault.test.ts` yet (orchestrator will add it). Prove RED by invoking the file directly.

`VAULT_MASTER_KEY` is set only in this test file (`'ab'.repeat(32)`). Not required at `buildApp()` boot.

## How RED was proved

From the worktree (`pnpm install` reported already up to date):

```
node --experimental-strip-types --test apps/server/src/vault.test.ts
```

Process exit **1**. Raw output: `kaola-workflow/bundle-4-5/.cache/tdd-guide-issue-5-red-run.txt`

Also:

```
node --experimental-strip-types --test apps/server/src/placeholder.test.ts
```

## Counts

| Suite | pass | fail |
|-------|------|------|
| `apps/server/src/vault.test.ts` | **1** | **15** |
| `apps/server/src/placeholder.test.ts` | **1** | **0** |

The one vault pass is the existing `GET /` pin (`考拉任务服务占位`). It is a regression constraint, not an oracle of #5. The other 15 cases failed on this baseline; a suite that already passed those would not be an oracle.

```
RED: JSON GET/POST/DELETE without a session return 401 unauthorized — AssertionError: GET list: 404 … 404 !== 401
RED: round-trips a one-off token string and ciphertext omits plaintext — ERR_MODULE_NOT_FOUND: Cannot find module …/vault.ts
baseline: 2e280c912b8e68df9a482eba9c8a89bc22315865
```

## Failure signatures (expected on this baseline)

Production has OAuth + `GET /` only. No `credential-profiles` routes, no `events` / `credential_profiles` tables, no `apps/server/src/vault.ts`.

Typical RED:

1. Unauthenticated JSON GET/POST/DELETE `/api/v1/credential-profiles` — `AssertionError: GET list: 404 {"message":"Route GET:/api/v1/credential-profiles not found",…} 404 !== 401`
2. Browser-like GET list — `404 !== 302`
3. GitLab/Gitea POST, duplicate 409, DELETE copy, team-shared list/delete, pending/claim_only 403, SQLite ciphertext + `变更`, `vault_unconfigured`, reveal-after-delete — all die first at missing route: `POST: 404 … Route POST:/api/v1/credential-profiles not found … 404 !== 201` (or `!== 403` / `!== 500`)
4. `encryptToken` / `decryptToken` round-trip — `ERR_MODULE_NOT_FOUND: Cannot find module '…/apps/server/src/vault.ts'`
5. `encryptToken` throws when `VAULT_MASTER_KEY` is missing — same `ERR_MODULE_NOT_FOUND`

Reveal uses `await import('./vault.ts')` **after** HTTP create; on this baseline it never reaches the import.

## What the suite encodes (binding names from `technical-decisions.md`)

HTTP via `buildApp()` + `inject`. OAuth token exchange stubbed on `githubOAuth2` / `gitlabOAuth2` / `giteaOAuth2`. Userinfo stubbed through `globalThis.fetch` (no live forges, no `@kaola/forge-adapters`). SQLite tempfile via `buildApp({ sqlitePath })` then `createDb(tmp)` for reveal / column checks. Outer suite `{ concurrency: false }` so `VAULT_MASTER_KEY` unset tests cannot race others.

- Session `POST /api/v1/credential-profiles` `{ forge, base_url, repo_full_name, token }` → 201 `{ id, forge, base_url, repo_full_name, scopes_checked: [], created_by }`; never `token` / `token_encrypted`
- Session `GET /api/v1/credential-profiles` → 200 `{ profiles: [...] }` same public fields
- Duplicate `(forge, base_url, repo_full_name)` (same user or another full member) → 409 `{ error: 'conflict' }`
- Session `DELETE /api/v1/credential-profiles/:id` → 200 `{ ok: true, message: '请同时到 forge 侧撤销该 token。' }`; missing → 404 `{ error: 'not_found' }`
- Team-shared: Gitea `active`+`full` lists/deletes a GitLab-created row
- Gate: pending GitHub and approved GitHub `claim_only` → 403 `{ error: 'forbidden' }` on POST/GET/DELETE
- Unauthenticated: JSON 401 `{ error: 'unauthorized' }` / browser 302 `/login`
- SQLite `token_encrypted` TEXT does not contain the plaintext substring; create writes `events.type` `变更` with `details.action` `create` + `profile_id`; delete writes `action` `delete`
- `revealCredentialProfile(db, { profileId, actorUserId, agentKeyId })` from `./vault.ts` (dynamic import): returns plaintext; `events` `token 揭示` with `actor_user_id`, unix-second `created_at`, `details` `{ agent_key_id, profile_id }`; after DELETE, throws. Prefers `POST /api/v1/agent-keys` 201 `id` when that #4 route exists; otherwise `agentKeyId: 1`. Does not create `agent_keys`.
- `encryptToken` / `decryptToken`: round-trip a one-off token string; encoded ciphertext omits plaintext. Missing `VAULT_MASTER_KEY`: HTTP POST → 500 `{ error: 'vault_unconfigured' }`; exported `encryptToken` throws
- Temp-token override: **not** a holding table / `tasks.inline_token_encrypted` — only the encrypt/decrypt primitive
- `GET /` still `考拉任务服务占位`

## Stop

No production implementation. Implementer owns making this suite green.
