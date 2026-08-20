# Doc docking — bundle-4-5

verdict: **DOCKED**

## Changed files reviewed (implementation)

- `apps/server/src/agent-keys.ts`
- `apps/server/src/vault.ts`
- `apps/server/src/credential-profiles.ts`
- `apps/server/src/schema.ts`
- `apps/server/src/db.ts`
- `apps/server/src/app.ts`
- `apps/server/src/auth.ts`
- `apps/server/src/index.ts`
- `apps/server/src/placeholder.ts`
- `apps/server/package.json`
- `apps/web/src/App.vue`
- `package.json` (root `"test"`)
- `kaola-workflow/bundle-4-5/.cache/technical-decisions.md`
- `kaola-workflow/bundle-4-5/.cache/final-validation.md`

## Documents checked

- Updated: `README.md`, `CHANGELOG.md`, `CLAUDE.md` (Commands + Snapshot only), `docs/architecture.md`, `docs/api.md`
- Left unchanged on purpose: `docs/DESIGN.md` (contracts), KW-CLAUDE-MANAGED block in `CLAUDE.md`, `docs/conventions.md`, `docs/README.md`, `docs/decisions/`, `docker-compose.yml`
- Absent, not invented: `docs/CODEMAPS/`, `scripts/codemaps/`, `.env.example` (absence documented)

## Gaps found / fixed

Docs still said vault/Agent Key/credential profiles were unimplemented and listed the pre-#4/#5 `pnpm test` file set. Reconciled HTTP (`POST/GET /api/v1/agent-keys`, `DELETE /api/v1/agent-keys/:id`, `GET /api/v1/agent/whoami`, `GET/POST/DELETE /api/v1/credential-profiles`), tables (`agent_keys`, `credential_profiles`, `events`), `VAULT_MASTER_KEY` (64 hex, encrypt/decrypt only), AES-256-GCM `iv||ciphertext||tag` base64, `ktk_` + sha256 hex `key_hash`, DELETE copy `请同时到 forge 侧撤销该 token。`, `revealCredentialProfile` as module export not HTTP, UI gates (`active` vs `active`+`full`), and transcribed validation (149/26, vite 2565, `index-BCXNNTa7.js`).

## No-impact reasons

- `docs/DESIGN.md`: product contract; not edited as a side effect of scaffolding.
- MCP / task CRUD / claim / `tasks` table: still unimplemented in source; docs continue to say so.
- Server still does not import `@kaola/forge-adapters`; `GET /` still `考拉任务服务占位`.
- No new npm deps (`node:crypto` only); `apps/server/package.json` unchanged.
- Workspace members unchanged (`apps/*` + `packages/*`).
- `docs/conventions.md` / `docs/README.md` / ADRs: no new files or convention breaks to record.

## BLOCK

none
