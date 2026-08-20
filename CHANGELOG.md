# Changelog

## Unreleased

- `@kaola/shared`: Task Brief zod schema (`taskStatusSchema`, `type TaskStatus`, `taskBriefSchema`, `type TaskBrief`, `parseTaskBrief`) and `transitionTaskStatus` matching [DESIGN.md](docs/DESIGN.md) §5–§6. `getSharedHealth()` still returns `kaola-shared-ready`. Dependency `zod` `^4.4.3` (lockfile `zod@4.4.3`). DESIGN.md §6 example still parses (tests pin it). HTTP `GET /`, MCP, and `@kaola/forge-adapters` unchanged.
- M0 scaffold: pnpm workspaces (`apps/*` + `packages/*`) with `@kaola/web` (Vue 3 + Vite + Naive UI placeholder), `@kaola/server` (Fastify + drizzle-orm + better-sqlite3), `@kaola/shared` (`getSharedHealth()` → `kaola-shared-ready`), `@kaola/forge-adapters` (`getForgeAdaptersHealth()` → `kaola-forge-adapters-ready`). Root scripts: `pnpm install`, `pnpm lint` (`eslint .`), `pnpm typecheck` (`pnpm -r --if-present typecheck`), `pnpm test` (`node --experimental-strip-types --test` on `packages/shared/src/index.test.ts`, `packages/forge-adapters/src/index.test.ts`, `apps/server/src/placeholder.test.ts`), `pnpm build` (`pnpm -r --if-present build`). Server: `pnpm --filter @kaola/server start` listens `HOST` default `0.0.0.0`, `PORT` default `3000`; `GET /` body `考拉任务服务占位`. `docker-compose.yml` skeleton (service `server`, port 3000). CI job `lint-test` on Node 22 (`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`).
- Initialized Kaola-Workflow documentation structure.
- Added design document v0.1 (`docs/DESIGN.md`).
- Design v0.2: multi-provider login with tiered permissions (GitHub = claim-only + first-login approval), claim-as-authorization, agent-side token hygiene, `suggested_dir` in task brief.
