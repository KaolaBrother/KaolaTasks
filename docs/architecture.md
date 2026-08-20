# Architecture

Document system boundaries, major components, data flow, and deployment shape.

Product architecture is in [DESIGN.md](DESIGN.md) §4 (架构), §10 (数据模型), §12 (部署). This file records what the tree actually contains.

Tree: `apps/web`, `apps/server`, `packages/shared`, `packages/forge-adapters`.

```
browser  →  @kaola/web (Vite; proxy /api and /login → 127.0.0.1:3000)
         →  @kaola/server Fastify
                GET /                 placeholder body
                /login*               OAuth + HTML login
                /api/v1/me            session user
                /api/v1/users/:id/approve
                SQLite users (createDb)
@kaola/shared           Task Brief zod + transitionTaskStatus
@kaola/forge-adapters   createForgeAdapter / validateToken (library; server does not import it)
MCP / vault / tasks     not implemented
```

## Server

`apps/server/src/index.ts` listens `HOST` default `0.0.0.0`, `PORT` default `3000`, `buildApp({ sqlitePath: process.env.SQLITE_PATH ?? ':memory:' })`.

`createDb` runs `CREATE TABLE IF NOT EXISTS users` then drizzle with `{ schema: { users } }`. Default path `:memory:` unless `SQLITE_PATH`.

Auth stack: `@fastify/cookie@^11.1.2`, `@fastify/session@^11.1.2`, `@fastify/oauth2@^8.3.0`. Session field: `userId?: number`. Cookie flags in source: `path: '/'`, `secure: false`, `httpOnly: true`, `sameSite: 'lax'`; `saveUninitialized: false`.

`registerAuth` throws if required OAuth / session env vars are empty (names in [api.md](api.md)).

No MCP SDK in `apps/server/package.json`. No `@kaola/forge-adapters` or `@kaola/shared` dependency on the server.

## Web

`apps/web/src/App.vue`: Naive UI, `zhCN` / `dateZhCN`. Views: login buttons, pending card (`status` `待批准`), member workbench with approve-by-id when `status` `active` and `permission_level` `full`. Fetches `GET /api/v1/me` with `Accept: application/json` and `credentials: 'include'`. No vue-router (`apps/web/package.json` has `vue` `^3.5.0`, `naive-ui` `^2.45.0` only).

`vite.config.ts` proxy: `/api` and `/login` → `http://127.0.0.1:3000`.

## Packages

`@kaola/shared`: Task Brief schema and lifecycle transitions specified in [DESIGN.md](DESIGN.md) §5–§6 (`taskBriefSchema` / `parseTaskBrief`, `transitionTaskStatus`). Legal edges in `packages/shared/src/index.ts`: 待认领 → 进行中, 已取消; 进行中 → 待认领, 待验收; 待验收 → 已完成, 已退回; 已退回 → 待认领, 已取消.

`@kaola/forge-adapters`: health string plus `ForgeAdapter`. `validateToken` uses global `fetch`, GET-only. GitHub API host `https://api.github.com`. GitLab `/api/v4`, Gitea `/api/v1`. Other §8 methods throw `Error('not implemented')`. Push/PR are REST permission proxies. Shared spec: `packages/forge-adapters/src/validate-token.shared.test.ts`.

## Deployment

`docker-compose.yml`: service `server`, `3000:3000`, `PORT=3000`, `HOST=0.0.0.0`, volume `kaola-data:/data`. Does not set `SQLITE_PATH` or OAuth env. Dockerfile `node:22-bookworm-slim`, `CMD pnpm --filter @kaola/server start`.
