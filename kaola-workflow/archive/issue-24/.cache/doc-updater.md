# Doc-updater docking report — issue #24

Measured 2026-08-25 on `/workspace` branch `cursor/issue-24-intranet-deploy-9906`.
Issue body: https://github.com/KaolaBrother/KaolaTasks/issues/24 (comments are claim-only; they do not amend the spec).
No production logic or tests were written. No commit.

Commands read (not inventing): `docker-compose.yml` full file; `apps/server/src/auth.ts`; `apps/server/src/app.ts`; `apps/server/src/index.ts`; `apps/server/src/writeback.ts` `publicUrl()`; `apps/server/Dockerfile`; `package.json` `scripts.test`; `apps/server/src/auth-cookie.test.ts`; `apps/server/src/hosting.test.ts` compose pin.

---

## Facts copied from code (source of truth)

### `cookieSecureFromPublicUrl` / cookies (`apps/server/src/auth.ts`)

- `publicUrlFromEnv()`: `trimTrailingSlash(process.env.PUBLIC_URL ?? 'http://localhost:31415')` where trim is `url.replace(/\/+$/, '')`.
- `cookieSecureFromPublicUrl()`: `publicUrlFromEnv().startsWith('https:')`.
- Session `@fastify/session`: `{ path: '/', secure: cookieSecure, httpOnly: true, sameSite: 'lax' }`, `saveUninitialized: false`.
- OAuth cookie: `{ path: '/' as const, secure: cookieSecure }` on github/gitlab/gitea plugins.
- Callback URIs: `` `${publicUrl}/login/{github|gitlab|gitea}/callback` ``.
- After OAuth login: if `request.session.cookie.secure === true && request.protocol !== 'https'`, skip `request.session.save()`, still `reply.redirect(outcome.redirect)`.

### `COOKIE_SECURE_TRUST_PROXY` (`auth.ts`) + `Fastify` (`app.ts`)

Exact array:

```
'127.0.0.1',
'::1',
'10.0.0.0/8',
'172.16.0.0/12',
'192.168.0.0/16',
```

- When `cookieSecureFromPublicUrl()`: `Fastify({ trustProxy: [...COOKIE_SECURE_TRUST_PROXY] })`.
- Else: `Fastify()` (no `trustProxy`).
- Comment in source: never hop-count `1` (Fastify 5.12.1 no-op) or `true`.

### `SQLITE_PATH` (`apps/server/src/index.ts`)

- `sqlitePath: process.env.SQLITE_PATH ?? ':memory:'`
- `PORT` default `'31415'`, `HOST` default `'0.0.0.0'`
- `POLL_INTERVAL_MS` empty/unset → `60000`
- `FORGE_INSTANCES` empty/unset → `[]`; invalid JSON throws

Compose does **not** set `POLL_INTERVAL_MS`; therefore compose inherits the `60000` default.

### `docker-compose.yml` (current file, 30 lines)

- `ports: "127.0.0.1:31415:31415"` (comment: loopback only)
- `env_file: .env`
- `environment`: `PORT: "31415"`, `HOST: "0.0.0.0"`, `SQLITE_PATH: /data/kaola.sqlite`, then `${PUBLIC_URL}`, `${SESSION_SECRET}`, `${VAULT_MASTER_KEY}`, nine `OAUTH_*` interpolations
- `volumes: kaola-data:/data`
- No secret literals

### Write-back `PUBLIC_URL` (`apps/server/src/writeback.ts`)

- `process.env.PUBLIC_URL ?? 'http://localhost:31415'` then `raw.replace(/\/+$/u, '')`
- Comment bodies include `task.publicId` and that URL

### Tests already in `package.json` `scripts.test`

`apps/server/src/auth-cookie.test.ts` is already in the node `--test` list after `auth.test.ts`. Root `CLAUDE.md` Commands list was missing it; now matches.

---

## Files updated

| File | What changed | Reconciled against |
|------|----------------|-------------------|
| `README.md` | Replaced 「生产向部署」 with eight Chinese points + topology ASCII from issue #24. Local-dev section unchanged. | Issue #24 README 指南 1–8; compose/auth/index facts above. Did not mention Tunnel/Tailscale. |
| `docs/DESIGN.md` | §12 **部署** paragraph expanded; D4 table row untouched; §5/§6 Task Brief / state machine untouched. | Issue “DESIGN §12 add topology still D4”; compose bind + `PUBLIC_URL` / `OAUTH_*_BASE_URL` split from `auth.ts`. |
| `docs/api.md` | Env: cookie Secure, `COOKIE_SECURE_TRUST_PROXY` list, skip-save, compose `SQLITE_PATH` vs `:memory:` default; `.env.example` sentence. | `auth.ts`, `app.ts`, `index.ts`, `docker-compose.yml`, `.env.example`. |
| `docs/architecture.md` | ASCII origin; Auth stack (replaced stale `secure: false`); Deployment (replaced stale `"31415:31415"` and “does not set SQLITE_PATH”). | Same sources. |
| `CHANGELOG.md` | Unreleased `#24` bullet. | Code + docs above. Historical #17 compose `"31415:31415"` left as past fact. |
| `CLAUDE.md` | Commands test file list: inserted `apps/server/src/auth-cookie.test.ts` after `auth.test.ts`. | `package.json` `scripts.test`. |
| `docs/README.md` | Added index line to README `#生产向部署`. | Issue optional index line. |
| `.env.example` | Empty keys matching compose pass-through only. | `docker-compose.yml` `environment` names. |
| `.gitignore` | `!.env.example` so `.env.*` does not ignore the example. `.env` still ignored. | Existing `.gitignore` `.env` / `.env.*`. |

## Files deliberately skipped

| File | Reason |
|------|--------|
| `docs/DESIGN.md` §5–§6, Task Brief, MCP §9 | Issue: do not change those contracts. |
| `docs/smoke-test.md` | Local `localhost:31415` smoke log; no stale compose/`secure: false` facts; no required change. |
| `docs/conventions.md` | No install/HTTP/deploy surface to dock. |
| `docs/api.md` MCP tool table / token-reveal paragraphs | Unchanged by #24. |
| Production code / tests | Out of role. |
| Commit | Orchestrator commits. |

## Local-dev README

「本机跑起来」 still says the repo does not load `.env` for `pnpm dev` (export into the shell). Compose `env_file: .env` is a different entrypoint; not a contradiction.
