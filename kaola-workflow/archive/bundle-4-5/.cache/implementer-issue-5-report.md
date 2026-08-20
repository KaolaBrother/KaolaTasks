# Implementer report — issue #5 Vault + profiles + events

**Role:** implementer (production code only; tests untouched)  
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5`  
**Branch:** `workflow/bundle-4-5`  
**Verification tier:** `tests-green`

## Task

Ship AES-256-GCM vault, team-shared credential-profile CRUD, `events` audit rows, and `revealCredentialProfile`, so `apps/server/src/vault.test.ts` is green. No `@kaola/forge-adapters`, no `tasks` table, no forge token on any HTTP response.

## What shipped

- Tables `credential_profiles` and `events` in `schema.ts` + `CREATE TABLE IF NOT EXISTS` in `db.ts`. Unique `(forge, base_url, repo_full_name)`. `scopes_checked` TEXT JSON default `[]`.
- Session CRUD in `apps/server/src/credential-profiles.ts`:
  - `GET /api/v1/credential-profiles` → `{ profiles: [{ id, forge, base_url, repo_full_name, scopes_checked, created_by }] }`
  - `POST /api/v1/credential-profiles` `{ forge, base_url, repo_full_name, token }` → 201 public fields; duplicate → 409 `{ error: 'conflict' }`; writes `变更` `{ action: "create", profile_id }`
  - `DELETE /api/v1/credential-profiles/:id` → 200 `{ ok: true, message: '请同时到 forge 侧撤销该 token。' }`; missing → 404 `{ error: 'not_found' }`; writes `变更` `{ action: "delete", profile_id }`
- Gate: `status === 'active'` AND `permission_level === 'full'`. Pending / approved GitHub `claim_only` → 403 `{ error: 'forbidden' }`. Any `active`+`full` member lists/deletes all rows (team-shared).
- `apps/server/src/vault.ts` exports:
  - `encryptToken` / `decryptToken` — `createCipheriv`/`createDecipheriv`, `'aes-256-gcm'`, 12-byte IV, 16-byte tag, layout `iv||ciphertext||tag` base64 TEXT
  - `revealCredentialProfile(db, { profileId, actorUserId, agentKeyId })` — returns plaintext, writes `token 揭示` with details `{ agent_key_id, profile_id }`; throws after DELETE (no row)
- Env `VAULT_MASTER_KEY` = 64 hex chars, required **only** at encrypt/decrypt. Missing/invalid → `encryptToken` throws; HTTP POST → 500 `{ error: 'vault_unconfigured' }`. Not required at `buildApp()` boot.
- UI: credential-profile widget only when `active` && `full`. Delete shows `请同时到 forge 侧撤销该 token。`. No vue-router. Existing login/pending/approve kept.

Did **not** add `@kaola/forge-adapters`, `tasks`, or return forge tokens over HTTP. Tokens are not logged.

## Files changed (this issue’s surface; shared files also carry #4)

- `apps/server/src/schema.ts` — `credential_profiles`, `events` (shared)
- `apps/server/src/db.ts` — profile/events DDL (shared)
- `apps/server/src/vault.ts` — **new**
- `apps/server/src/credential-profiles.ts` — **new**
- `apps/server/src/app.ts` — `registerCredentialProfiles` (shared)
- `apps/web/src/App.vue` — profile widget + revoke copy (shared)

## Verification commands

From the worktree:

```
node --experimental-strip-types --test apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts apps/server/src/auth.test.ts apps/server/src/placeholder.test.ts
```

Exit code **0**.

Also: `pnpm --filter @kaola/server typecheck`, `pnpm --filter @kaola/web typecheck`, eslint on touched files — all exit 0.

## Before / after

- **Before:** `vault.test.ts` RED — 1 pass (`GET /`) / 15 fail.
- **After (combined four-file run):** 42 pass / 0 fail.
  - `vault.test.ts`: **16 pass / 0 fail**
  - `agent-keys.test.ts`: 9 pass / 0 fail
  - `auth.test.ts`: 16 pass / 0 fail
  - `placeholder.test.ts`: 1 pass / 0 fail

## Corner cuts

One-off override storage is not a table: `encryptToken`/`decryptToken` are the reusable primitive; `tasks.inline_token_encrypted` waits for #7. Product reveal stays `claim_task` (#9); this run only exports `revealCredentialProfile`. No audit **UI** (M3).
