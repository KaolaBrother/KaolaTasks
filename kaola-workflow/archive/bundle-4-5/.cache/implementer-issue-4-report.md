# Implementer report — issue #4 Agent keys + Bearer

**Role:** implementer (production code only; tests untouched)  
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5`  
**Branch:** `workflow/bundle-4-5`  
**Verification tier:** `tests-green`

## Task

Ship Agent API Key self-service and Bearer middleware so `apps/server/src/agent-keys.test.ts` is green, without requiring `VAULT_MASTER_KEY` at `buildApp()` boot, and without changing `GET /` or `GET /api/v1/me`.

## What shipped

- Drizzle table `agent_keys` in `apps/server/src/schema.ts` plus `CREATE TABLE IF NOT EXISTS` in `apps/server/src/db.ts` (no drizzle-kit). Columns: `id`, `user_id`, `key_hash` UNIQUE, `label` default `''`, `last_used_at` nullable unix seconds.
- Session cookie routes in `apps/server/src/agent-keys.ts`:
  - `POST /api/v1/agent-keys` → 201 `{ id, label, token, last_used_at: null }`; plaintext `ktk_` + hex(`randomBytes(32)`); stored hash is sha256 hex of utf8 plaintext.
  - `GET /api/v1/agent-keys` → 200 `{ keys: [{ id, label, last_used_at }] }` (no `token` / `key_hash`).
  - `DELETE /api/v1/agent-keys/:id` → 200 `{ ok: true }`; missing/not-owned → 404 `{ error: 'not_found' }`. Own keys only.
- Generate/list/revoke gate: `status === 'active'`. Pending GitHub POST → 403 `{ error: 'forbidden', message: '你的账号待正式成员批准后方可生成 Agent Key。' }`. Approved GitHub `claim_only` may generate.
- Session 401 `{ error: 'unauthorized' }` with no `WWW-Authenticate`; HTML Accept redirects to `/login`.
- Custom Fastify **child** `onRequest` hook (not `@fastify/bearer-auth`). `GET /api/v1/agent/whoami` Bearer-only. Scheme case-insensitive. Compare hashes with `timingSafeEqual` on digest buffers. Successful auth ticks `last_used_at`; failed/revoked/wrong key does not. Bearer 401 same JSON plus `WWW-Authenticate: Bearer`. `/api/v1/me` still session-only.
- UI: Agent Key widget on the member workbench when `status === 'active'` (`apps/web/src/App.vue`).

`VAULT_MASTER_KEY` is not read at boot (issue #5 encrypt/decrypt only).

## Files changed (this issue’s surface; shared files also carry #5)

- `apps/server/src/schema.ts` — `agent_keys` (shared file; also `credential_profiles` / `events` for #5)
- `apps/server/src/db.ts` — `AGENT_KEYS_DDL` (shared)
- `apps/server/src/auth.ts` — export `getSessionUser`, `wantsJson`, `sendUnauthorized`
- `apps/server/src/agent-keys.ts` — **new**
- `apps/server/src/app.ts` — `registerAgentKeys` (shared)
- `apps/web/src/App.vue` — Agent Key widget (shared)

## Verification commands

From the worktree:

```
node --experimental-strip-types --test apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts apps/server/src/auth.test.ts apps/server/src/placeholder.test.ts
```

Exit code **0**.

Also: `pnpm --filter @kaola/server typecheck`, `pnpm --filter @kaola/web typecheck`, eslint on touched files — all exit 0.

## Before / after

- **Before:** `agent-keys.test.ts` RED — 0 pass / 9 fail (routes missing). `VAULT_MASTER_KEY` deleted by the oracle; `buildApp()` already booted.
- **After (combined four-file run):** 42 pass / 0 fail.
  - `agent-keys.test.ts`: **9 pass / 0 fail**
  - `vault.test.ts`: 16 pass / 0 fail
  - `auth.test.ts`: 16 pass / 0 fail
  - `placeholder.test.ts`: 1 pass / 0 fail

## Corner cuts

None for the oracle. Bearer is only attached to `/api/v1/agent/whoami` in this slice (MCP tools are later issues).
