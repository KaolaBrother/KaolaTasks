# Documentation docking — issue #24

Verdict: **DOCKED**

## Changed files reviewed

- `apps/server/src/auth.ts`, `apps/server/src/app.ts`
- `docker-compose.yml`, `.env.example`, `.gitignore`
- `apps/server/src/auth-cookie.test.ts`, `apps/server/src/auth.test.ts`, `apps/server/src/hosting.test.ts`, `package.json`
- `README.md`, `docs/DESIGN.md` §12, `docs/api.md`, `docs/architecture.md`, `CHANGELOG.md` Unreleased, `CLAUDE.md` Commands, `docs/README.md`

## Documents checked

| Document | Status |
|---|---|
| README 生产向部署 | 8-point intranet+public-IP topology; X-Forwarded-Proto overwrite; local-dev unchanged |
| DESIGN §12 | topology added; D4 / Task Brief / state machine untouched |
| api.md | PUBLIC_URL, cookie Secure, trustProxy list, skip-save, compose SQLITE_PATH vs :memory: |
| architecture.md | replaced stale `secure: false` and `"31415:31415"` |
| CHANGELOG Unreleased | #24 bullet |
| CLAUDE.md Commands | `auth-cookie.test.ts` in test list |
| docs/README.md | link to 生产向部署 |
| .env.example | empty keys matching compose |

## Gaps found and fixed

Security residual: README point 4 now says the reverse proxy must **overwrite** `X-Forwarded-Proto` from the client-facing scheme.

## No-impact

Task Brief, state machine, MCP tools, token reveal, closed join, session store → SQLite: unchanged.
