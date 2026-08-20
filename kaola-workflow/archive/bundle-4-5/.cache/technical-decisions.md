# Technical decisions for bundle-4-5

Orchestrator judgments. Not DESIGN.md contracts. Evidence in parentheses. Do not treat these names as if DESIGN specified them.

Recorded 2026-08-21 after `design-measure.md` and `crypto-bearer.md`.

## Scope split

- **#4** owns `agent_keys`, session generate/list/revoke, Bearer middleware, `GET /api/v1/agent/whoami`.
- **#5** owns `credential_profiles`, `events`, AES-256-GCM vault, profile CRUD, `revealCredentialProfile`, 吊销 UI copy.
- **Not this run:** `tasks` / `leases` / MCP / board / `claim_task`. Do not add `@kaola/forge-adapters` to the server (发布即校验 is #7). Do not put vault/key types in `@kaola/shared`.

## Single-task temp token (#5 goal vs §10)

DESIGN’s holding area is `tasks.inline_token_encrypted` (#7). This run does **not** invent a holding table. Vault `encryptToken` / `decryptToken` are the reusable primitive; profile rows use them. One-off override storage waits for `tasks`.

## Reveal without `claim_task`

Product reveal stays `claim_task` (#9). This run exports `revealCredentialProfile` from `apps/server/src/vault.ts` so #5’s 「后续揭示失败」and 「每次揭示均有审计」are closeable. **No HTTP that returns a forge token** (would widen DESIGN §7). Tests `await import('./vault.ts')` inside the reveal cases and use `createDb(sqlitePath)` on the same tempfile `buildApp` used.

## Hash / key material (#4)

- High-entropy random keys, not passwords → `crypto.createHash('sha256').update(plaintext, 'utf8').digest()` stored as **hex TEXT** in `key_hash`. Unique on `key_hash`. Compare with `timingSafeEqual` on the digest buffers (`crypto-bearer.md`; Argon2 is not in Node 22).
- Plaintext: `ktk_` + hex(`randomBytes(32)`) (64 hex chars). Prefix is invented so UI/tests can tell a key from a forge token.
- `label`: optional string, default `''`. No uniqueness.
- Revoke: **DELETE the row** (no revoked column in §10). Immediate 401 on that plaintext.
- `last_used_at`: nullable integer unix **seconds**. Ticks only on **successful** Bearer auth. Failed/revoked/wrong key does not tick.
- PK `id` integer autoincrement (same as `users`). `user_id` integer → `users.id`. Own keys only for list/revoke/generate (自助; §11). A `full` member does not revoke someone else’s key.

## Bearer

- Custom `onRequest` on a **child Fastify context**, not `@fastify/bearer-auth` (hashed keys do not fit the plugin’s plaintext `keys` Set; `crypto-bearer.md`).
- Header: `authorization`, scheme **case-insensitive** `Bearer`, remainder is the key (RFC 9110; RFC 6750 example spelling).
- 401 JSON stays Kaola `{ error: 'unauthorized' }`. Bearer 401 also sends `WWW-Authenticate: Bearer` (RFC 6750 MUST). Session `/api/v1/me` unchanged (no WWW-Authenticate).
- Do **not** accept Bearer on `/api/v1/me` (would change the #3 contract).
- Probe route: `GET /api/v1/agent/whoami` (Bearer only). 200 `{ id, key_id, label, status, permission_level }` (`id` = user id). Updates `last_used_at`.

## Vault crypto (#5)

- `node:crypto` `createCipheriv` / `createDecipheriv`, algorithm `'aes-256-gcm'`, `{ authTagLength: 16 }`. IV `randomBytes(12)` per encrypt. Tag 16 bytes. Wrong tag → `final()` throws (`crypto-bearer.md`).
- Layout **A**: `iv || ciphertext || tag` (12+n+16), stored as **base64 TEXT** in `token_encrypted`.
- Env `VAULT_MASTER_KEY`: 64 hex chars = 32 raw bytes. Unprefixed like `SESSION_SECRET`. Required **when encrypting/decrypting**, not at `buildApp()` boot (so existing `auth.test.ts` stays valid without this var). Missing/invalid on encrypt → 500 `{ error: 'vault_unconfigured' }`. Not `SESSION_SECRET`.
- No drizzle-kit; `CREATE TABLE IF NOT EXISTS` next to `users`.

## Tables

### `agent_keys`

`id`, `user_id` NOT NULL, `key_hash` NOT NULL UNIQUE, `label` NOT NULL DEFAULT '', `last_used_at` INTEGER NULL.

### `credential_profiles`

`id`, `forge` (`github`|`gitlab`|`gitea`), `base_url`, `repo_full_name`, `token_encrypted`, `scopes_checked` TEXT JSON default `[]`, `created_by` INTEGER (`users.id`). UNIQUE `(forge, base_url, repo_full_name)`. Team-shared: any `active`+`full` member lists/deletes all rows. GitHub `claim_only` cannot manage (D8 / §11). Do **not** call `validateToken` on create; `scopes_checked` starts `[]`.

### `events`

| DESIGN label | Column |
|--------------|--------|
| 类型 | `type` TEXT |
| 主体 | `actor_user_id` INTEGER |
| 时间 | `created_at` INTEGER unix seconds |
| 详情 JSON | `details` TEXT JSON |

`type` values: DESIGN `状态迁移` / `token 揭示` / `心跳` / `回写`, plus **`变更`** because issue #5 requires writing 变更 and §10’s list has no CRUD type. Do not edit DESIGN.md.

- Reveal: `type` = `token 揭示`, `details` = `{"agent_key_id":<n>,"profile_id":<n>}`. 谁 = `actor_user_id`, 何时 = `created_at`.
- Profile create/delete: `type` = `变更`, `details` = `{"action":"create"|"delete","profile_id":<n>}`.

## HTTP (invented; §9 unnamed)

Unauthenticated session routes: same oracle as `/api/v1/me` (JSON 401 / browser 302 `/login`).

### Agent keys (session cookie)

- `POST /api/v1/agent-keys` body `{ "label"?: string }` → 201 `{ id, label, token, last_used_at: null }`. `token` only here.
- `GET /api/v1/agent-keys` → 200 `{ keys: [{ id, label, last_used_at }] }` (no `token`, no `key_hash`).
- `DELETE /api/v1/agent-keys/:id` → 200 `{ ok: true }`. Missing/not-owned → 404 `{ error: 'not_found' }`.
- Generate gate: `status === 'active'` (pending GitHub denied). Approved GitHub `claim_only` **may** generate/list/revoke own keys. Pending: 403 `{ error: 'forbidden', message: '你的账号待正式成员批准后方可生成 Agent Key。' }`.

### Profiles (session cookie)

- `GET /api/v1/credential-profiles` → 200 `{ profiles: [{ id, forge, base_url, repo_full_name, scopes_checked, created_by }] }` never token / `token_encrypted`.
- `POST /api/v1/credential-profiles` body `{ forge, base_url, repo_full_name, token }` → 201 same shape as a list item. Duplicate unique triple → 409 `{ error: 'conflict' }`. Writes `变更`.
- `DELETE /api/v1/credential-profiles/:id` → 200 `{ ok: true, message: '请同时到 forge 侧撤销该 token。' }`. Writes `变更`. Then `revealCredentialProfile` throws (no row / decrypt fail). Missing → 404 `{ error: 'not_found' }`.
- Gate: `status === 'active'` AND `permission_level === 'full'`. `claim_only` or pending → 403 `{ error: 'forbidden' }`.

### `revealCredentialProfile(db, { profileId, actorUserId, agentKeyId })`

Returns plaintext string. Writes `token 揭示`. After delete, throws. Does not log the token.

## UI (`App.vue`, no vue-router, no new test runner)

Chinese copy. Agent Key widget on member workbench when `status === 'active'`. Profile widget only when `active` && `full`. Delete shows `请同时到 forge 侧撤销该 token。`. No Vue tests this run (same as bundle-3-6).

## Tests

- `apps/server/src/agent-keys.test.ts` (#4)
- `apps/server/src/vault.test.ts` (#5)
- Reuse `auth.test.ts` oauth stub / cookie jar / `applyOauthTestEnv`. Do not weaken those oracles. Do not add vault env to `auth.test.ts` (vault key not required at boot).
- Prove RED with `node --experimental-strip-types --test <file>` from the worktree. Orchestrator adds paths to root `"test"` later.
- `GET /` stays `考拉任务服务占位`.
