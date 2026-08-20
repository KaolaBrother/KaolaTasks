# doc-updater — bundle-4-5 (#4 Agent API keys, #5 token vault / credential profiles)

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5`  
Report: `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-4-5/.cache/doc-updater.md`  
Date: 2026-08-21  
Verdict: **DOCKED**  
BLOCK lines: **none**

## Detection

- `scripts/codemaps/` — absent (0 files). Did not invent CODEMAPS.
- `docs/CODEMAPS/` — absent (0 files). Did not invent CODEMAPS.
- `.env.example` — absent (0 files). Documented the absence; did not create the file.

Reconciled the surfaces the repo already declares: `README.md`, `CHANGELOG.md`, `CLAUDE.md` Commands/Snapshot, `docs/architecture.md`, `docs/api.md`.

## Sources actually read (quotes)

### HTTP registration (`app.ts`)

```
registerAuth(app, db)
registerAgentKeys(app, db)
registerCredentialProfiles(app, db)
```

`GET /` still `getPlaceholderBody()`.

### Agent keys (`agent-keys.ts`)

Paths:

- `app.post('/api/v1/agent-keys'`
- `app.get('/api/v1/agent-keys'`
- `app.delete('/api/v1/agent-keys/:id'`
- `child.get('/api/v1/agent/whoami'`

Plaintext / hash:

```
return `ktk_${randomBytes(32).toString('hex')}`
return createHash('sha256').update(plaintext, 'utf8').digest('hex')
```

Create 201 body: `{ id, label, token, last_used_at: null }`.  
List: `{ keys: rows.map(publicKey) }` with `publicKey` = `{ id, label, last_used_at }`.  
Delete: `{ ok: true }`. Missing/not-owned: `{ error: 'not_found' }`.  
Pending generate message: `'你的账号待正式成员批准后方可生成 Agent Key。'`  
Bearer 401: `header('WWW-Authenticate', 'Bearer').code(401).send({ error: 'unauthorized' })`.  
Whoami: `{ id, key_id, label, status, permission_level }`.  
Parse: `/^Bearer\s+(\S+)/i`.

### Credential profiles (`credential-profiles.ts`)

Paths:

- `app.get('/api/v1/credential-profiles'`
- `app.post('/api/v1/credential-profiles'`
- `app.delete('/api/v1/credential-profiles/:id'`

Gate: `user.status === 'active' && user.permissionLevel === 'full'`.  
Forges: `new Set(['github', 'gitlab', 'gitea'])`.  
Create body fields: `forge`, `base_url`, `repo_full_name`, `token`.  
Public shape: `{ id, forge, base_url, repo_full_name, scopes_checked, created_by }`.  
`scopesChecked: '[]'` on insert.  
Errors: `400` `{ error: 'invalid_body' }`; `409` `{ error: 'conflict' }`; `500` `{ error: 'vault_unconfigured' }`; `404` `{ error: 'not_found' }`; `403` `{ error: 'forbidden' }`.  
Delete: `{ ok: true, message: '请同时到 forge 侧撤销该 token。' }`.  
Audit create/delete: `type: '变更'`, `details: { action: 'create'|'delete', profile_id }`.

### Vault (`vault.ts`)

```
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const MASTER_KEY_HEX_RE = /^[0-9a-fA-F]{64}$/
export const VAULT_UNCONFIGURED = 'vault_unconfigured'
```

`encryptToken` stores `Buffer.concat([iv, ciphertext, tag]).toString('base64')`.  
`revealCredentialProfile(db, { profileId, actorUserId, agentKeyId })` returns plaintext string; writes `type: 'token 揭示'`, `details: { agent_key_id, profile_id }`. Missing row: `throw new Error('credential profile not found')`.  
`VAULT_MASTER_KEY` is read inside encrypt/decrypt, not in `buildApp()`.

### Schema / DDL (`schema.ts`, `db.ts`)

`CREATE TABLE IF NOT EXISTS` for `users`, `agent_keys`, `credential_profiles`, `events`.  
`agent_keys`: `id`, `user_id`, `key_hash TEXT NOT NULL UNIQUE`, `label TEXT NOT NULL DEFAULT ''`, `last_used_at INTEGER`.  
`credential_profiles`: `forge`, `base_url`, `repo_full_name`, `token_encrypted`, `scopes_checked TEXT NOT NULL DEFAULT '[]'`, `created_by`; `UNIQUE (forge, base_url, repo_full_name)`.  
`events`: `type`, `actor_user_id`, `created_at`, `details`.  
No `tasks` table.

### Auth / boot (`auth.ts`, `index.ts`)

`registerAuth` still `requireEnv` for `SESSION_SECRET` and `OAUTH_*` (GitHub/GitLab/Gitea). Does not read `VAULT_MASTER_KEY`.  
`GET /api/v1/me` and `POST /api/v1/users/:id/approve` unchanged. No Bearer on `/api/v1/me`.  
`SQLITE_PATH ?? ':memory:'`; `PORT ?? '3000'`; `HOST ?? '0.0.0.0'`.

### UI (`App.vue`)

```
const canApprove = computed(() => me.value?.status === 'active' && me.value?.permission_level === 'full')
const canManageKeys = computed(() => me.value?.status === 'active')
const FORGE_REVOKE_MESSAGE = '请同时到 forge 侧撤销该 token。'
```

Agent Key block: `v-if="canManageKeys"`. Credential profiles: `v-if="canApprove"`. Fetches `/api/v1/agent-keys` and `/api/v1/credential-profiles`. No vue-router.

### Server package.json

Dependencies unchanged: `@fastify/cookie`, `@fastify/oauth2`, `@fastify/session`, `better-sqlite3`, `drizzle-orm`, `fastify`. No `@kaola/forge-adapters`. Vault/keys use `node:crypto`.

### Root `package.json` `"test"` (copied exactly)

```
node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts
```

### Binding names

`kaola-workflow/bundle-4-5/.cache/technical-decisions.md` — HTTP paths, table columns, `VAULT_MASTER_KEY`, `ktk_` prefix, event types `变更` / `token 揭示`, DELETE copy, `revealCredentialProfile` as module export. Cross-checked against source before documenting; no names taken from that file that were absent in source.

### Placeholder

`getPlaceholderBody()` returns `'考拉任务服务占位'`.

## Measured (transcribed, not re-run)

From `kaola-workflow/bundle-4-5/.cache/final-validation.md` (orchestrator, `CI=true`, 2026-08-21):

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` all exit 0
- tests **149 pass / 0 fail**, **26 suites**
- web vite **2565** modules; `dist/assets/index-BCXNNTa7.js` **1,452.16 kB** gzip **402.89 kB** (chunk-size warning only)
- `validated_candidate_hash: 48dfa271006740a67d1113229ef9a58fc356dc9789cf0fb36a5f4c3848100079`

## Files updated (worktree) and what each reconciled

| File | Reconciled against |
|------|--------------------|
| `README.md` | Source HTTP/UI/env; root `"test"`; final-validation counts transcribed into changelog not README; `.env.example` absence; compose still omits `VAULT_MASTER_KEY` |
| `CHANGELOG.md` | #4/#5 bullets prepended under Unreleased; prior Unreleased history kept (including older 124-test measurement); no version number invented |
| `CLAUDE.md` | Snapshot + Commands only. Test script copied from worktree `package.json`. `VAULT_MASTER_KEY` not a `buildApp()` boot env. KW-CLAUDE-MANAGED block untouched |
| `docs/architecture.md` | `createDb` four tables; new HTTP; vault module; UI gates; compose env omission; server still does not import `@kaola/forge-adapters` |
| `docs/api.md` | All new HTTP from `agent-keys.ts` / `credential-profiles.ts`; tables from `db.ts`; vault exports from `vault.ts`; env split (`registerAuth` vs `VAULT_MASTER_KEY`) |

## Surfaces skipped (with reason)

| Surface | Reason |
|---------|--------|
| `docs/DESIGN.md` | Forbidden (contracts). Did not edit. |
| `CLAUDE.md` `<!-- KW-CLAUDE-MANAGED-START -->` … `END` | Forbidden. Untouched. |
| `*.test.ts` and production `.ts` | Forbidden. Untouched. |
| `docs/CODEMAPS/*` / `scripts/codemaps/` | Do not exist; not invented. |
| `.env.example` | Does not exist; absence documented; file not created. |
| `docs/conventions.md` | No install/lint/test/build/workspace-member/HTTP-index change that requires it. Forge tokens still absent from list/get HTTP. |
| `docs/README.md` | Index still lists the same files; no new doc added. |
| `docs/decisions/` | No new ADR in source. |
| `docker-compose.yml` | Not a docs surface on the checklist. Still only `PORT`/`HOST`; README + architecture record that OAuth/`SESSION_SECRET`/`VAULT_MASTER_KEY`/`SQLITE_PATH` are unset. |

## Gaps found / fixed

Before this pass, README / CHANGELOG / CLAUDE snapshot / architecture / api still described vault as unimplemented, omitted `agent_keys` / `credential_profiles` / `events`, omitted Agent Key and credential-profile HTTP, omitted `VAULT_MASTER_KEY`, and root `"test"` was missing `agent-keys.test.ts` + `vault.test.ts`. Those surfaces now match source.

## Not in source — omitted (not invented)

- No HTTP `GET /api/v1/credential-profiles/:id` or `GET /api/v1/agent-keys/:id`
- No HTTP that returns a forge token
- No `tasks` table, no MCP, no claim HTTP
- Server does not import `@kaola/forge-adapters`
- No new npm dependency for crypto

## BLOCK

none
