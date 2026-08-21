# Doc docking — issue-7

verdict: **DOCKED**

## Changed files reviewed (implementation)

- `apps/server/src/tasks.ts` (new)
- `apps/server/src/tasks.test.ts` (new)
- `apps/server/src/schema.ts`
- `apps/server/src/db.ts`
- `apps/server/src/app.ts`
- `apps/server/package.json` (`@kaola/shared` / `@kaola/forge-adapters` `workspace:*`)
- `packages/shared/src/index.ts`
- `packages/shared/src/index.test.ts`
- `apps/web/src/App.vue`
- `apps/web/src/App.form.test.ts` (new)
- `apps/web/package.json` (vitest / `@vue/test-utils` / `happy-dom`)
- `apps/web/vite.config.ts`
- `package.json` (root `"test"`)
- `pnpm-lock.yaml`
- `docs/DESIGN.md` §6 (`id` form + credential union) — changed earlier in this run on purpose; not re-touched at docking

## Documents checked

- Updated: `README.md`, `CHANGELOG.md`, `CLAUDE.md` (Commands + Snapshot), `docs/architecture.md`, `docs/api.md`
- Left unchanged on purpose: `docs/DESIGN.md` at docking (contract already updated in a prior item), KW-CLAUDE-MANAGED block in `CLAUDE.md`, `docs/conventions.md`, `docs/README.md`, `docs/decisions/`, `docker-compose.yml`
- Absent, not invented: `docs/CODEMAPS/`, `scripts/codemaps/`, `.env.example`

## Gaps found / fixed

Docs still said task CRUD / `tasks` table / 发布即校验 were unimplemented, that the server does not import `@kaola/forge-adapters`, and that the package exports `validateToken`. Reconciled: four task routes, `tasks` table + XOR CHECK, request `{profile_id}` XOR `{token}` vs brief `{profile_id}` | `{inline:true}`, profile-to-repo bind, http(s) `base_url` gate, `422`/`502` Chinese errors, publish-time `token 揭示` details shape, Chinese posting form, vitest root composition, measured 243+27. CLAUDE.md snapshot now names `createForgeAdapter` as the export and `validateToken` as a method. Dev OAuth landing on `:3000` placeholder documented in README (not fixed).

## No-impact reasons

- MCP / claim / lease / board UI: still unimplemented; docs continue to say so (#8 / #9 / #10).
- `GET /` still `考拉任务服务占位`.
- `docs/DESIGN.md` at docking: already edited in the contract item; docking must not retouch it.
- `docs/conventions.md` / `docs/README.md` / ADRs: no new files or convention breaks to record.
- Residual RFC1918 SSRF on the inline-token path: accepted product constraint, not a doc omission.

## BLOCK

none
