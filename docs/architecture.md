# Architecture

Document system boundaries, major components, data flow, and deployment shape.

Product architecture is in [DESIGN.md](DESIGN.md) §4 (架构), §10 (数据模型), §12 (部署). This file records what the tree actually contains.

Tree: `apps/web`, `apps/server`, `packages/shared`, `packages/forge-adapters`.

```
browser  →  advertised origin localhost:31415 (@kaola/server Fastify)
         →  Vite 127.0.0.1:5173 is loopback-only under root pnpm dev (not the advertised origin)
                GET /                            placeholder when naked buildApp();
                                                 SPA when webDist; Vite proxy when only viteDevTarget
                /login*                          OAuth + HTML login
                /api/v1/me                       session user
                /api/v1/users/:id/approve
                /api/v1/agent-keys               session generate/list/revoke
                /api/v1/agent/whoami             Bearer (`addAgentBearerHook` in agent-bearer.ts)
                /api/v1/credential-profiles      session (active+full)
                /api/v1/tasks                    session list/create; :publicId get/patch
                                                 GET list/one call sweepExpiredLeases then re-read
                /api/v1/tasks/:publicId/claim    Bearer POST (201 clone, lease, task, token)
                /api/v1/tasks/:publicId/progress Bearer POST (200 task, lease; no token)
                /api/v1/tasks/:publicId/release  Bearer POST (200 task; no token)
                POST /api/mcp                    Bearer Streamable HTTP (six MCP tools)
                GET/DELETE /api/mcp              405 JSON-RPC -32000 Method not allowed
                SQLite users, agent_keys, credential_profiles, tasks, events, leases, submissions (createDb)
                unique index leases_one_active_per_task on leases(task_id) WHERE state = 'active'
                vault.ts encryptToken / decryptToken / revealCredentialProfile / insertAuditEvent
                  (forge token: REST claim 201 top-level token and MCP claim_task success token)
@kaola/web              Vue 3 + Naive UI; vite.config proxy /api and /login → 127.0.0.1:31415
                        任务看板; one synthetic 发布; no claim UI; no events HTTP
@kaola/shared           Task Brief zod + transitionTaskStatus
@kaola/forge-adapters   createForgeAdapter (validateToken is an adapter method)
                        imported by @kaola/server (workspace:*)
MCP                     registerMcp; @modelcontextprotocol/sdk 1.30.0; no PR polling
```

## Server

`apps/server/src/index.ts` listens `HOST` default `0.0.0.0`, `PORT` default `31415`, `buildApp({ sqlitePath: process.env.SQLITE_PATH ?? ':memory:', webDist: process.env.WEB_DIST, viteDevTarget: process.env.VITE_DEV_TARGET })`.

`buildApp({ sqlitePath?, webDist?, viteDevTarget? })`: omit/empty both hosting options → `GET /` `text/plain; charset=utf-8` body `考拉任务服务占位` via `getPlaceholderBody()`. Non-empty `webDist` → `@fastify/static` `^10.1.3` + exact `GET /` `sendFile` `index.html` + SPA fallback for other GET except `/api` and `/login*`. Both set → `webDist` wins. Only `viteDevTarget` → `@fastify/http-proxy` `^11.6.0`.

`createDb` runs `CREATE TABLE IF NOT EXISTS` for `users`, `agent_keys`, `credential_profiles`, `tasks`, `events`, and `leases`, then `CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_task ON leases(task_id) WHERE state = 'active'`, then `submissions`, then drizzle with `{ schema: { users, agentKeys, credentialProfiles, tasks, events, leases, submissions } }`. Default path `:memory:` unless `SQLITE_PATH`. `tasks` INTEGER PK `id` plus `public_id` TEXT NOT NULL UNIQUE (`kt-YYYY-NNNN`); CONSTRAINT `tasks_credential_xor` CHECK `((credential_profile_id IS NULL) != (inline_token_encrypted IS NULL))`. `leases` columns: `id`, `task_id` (integer `tasks.id`), `claimer_user_id`, `agent_key_id`, `claimed_at`, `expires_at`, `last_heartbeat`, `state`. TTL `86400` in `leases.ts` (`LEASE_TTL_SECONDS`); no per-task TTL column. `submissions` columns: `id`, `task_id` (integer `tasks.id`), `lease_id`, `pr_url`, `summary`, `pr_state`.

Auth stack: `@fastify/cookie@^11.1.2`, `@fastify/session@^11.1.2`, `@fastify/oauth2@^8.3.0`. Session field: `userId?: number`. Cookie flags in source: `path: '/'`, `secure: false`, `httpOnly: true`, `sameSite: 'lax'`; `saveUninitialized: false`. Agent Bearer uses `addAgentBearerHook` in `apps/server/src/agent-bearer.ts` (child Fastify `onRequest`; used by whoami, claim, and MCP plugins), not `@fastify/bearer-auth`. Vault uses `node:crypto` `createCipheriv` / `createDecipheriv` (`aes-256-gcm`); vault does not add an npm package. `insertAuditEvent` accepts `actorUserId: number | null`.

`registerAuth` throws if required OAuth / session env vars are empty (names in [api.md](api.md)). `VAULT_MASTER_KEY` is not read at `buildApp()` / `registerAuth` boot; `encryptToken` / `decryptToken` read it when encrypting or decrypting.

`buildApp` wires `registerTasks(app, db)` (`apps/server/src/tasks.ts`) then `registerClaim(app, db)` (`apps/server/src/claim.ts`) then `registerMcp(app, db)` (`apps/server/src/mcp.ts`), before hosting. Session GET list/one call `sweepExpiredLeases` then re-read (check-on-read). Claim/progress/release and MCP list/get/mutating tools also call `sweepExpiredLeases` (check-on-write / check-on-read). No cron. POST 发布即校验 calls `createForgeAdapter(forge, { baseUrl }).validateToken`. Server dependencies include `"@kaola/shared": "workspace:*"`, `"@kaola/forge-adapters": "workspace:*"`, `"@modelcontextprotocol/sdk": "1.30.0"`, `"zod": "^4.4.3"`, `@fastify/static@^10.1.3`, `@fastify/http-proxy@^11.6.0`. Extracted `claimTask`/`reportProgress`/`releaseTask`/`submitPr`; REST still has no `POST …/submit_pr`.

## Web

`apps/web/src/App.vue`: Naive UI, `zhCN` / `dateZhCN`. Views: login buttons, pending card (`status` `待批准`, title 账号待批准 — no board), member workbench (`view === 'member'`) with 任务看板 (列表 / 看板; client-side filters 状态 / 标签 / Forge; detail + one synthetic 发布 from `created_at`+`poster`; `GET /api/v1/tasks` exactly, no query; no events HTTP; no claim UI). `claim_only` sees the board, not the posting form. Approve-by-id, credential-profile widget, and 发布任务 form when `status === 'active'` and `permission_level === 'full'` (`canApprove`). Agent Key widget when `status === 'active'`. Form reuses loaded `profiles` for the credential dropdown; two request-side paths `{ profile_id }` XOR `{ token }`; create only (`POST /api/v1/tasks`). Fetches `GET /api/v1/me` with `Accept: application/json` and `credentials: 'include'`. No vue-router (`apps/web/package.json` has `vue` `^3.5.0`, `naive-ui` `^2.45.0` only).

`apps/web/package.json` `"test": "vitest run"`; devDeps `@vue/test-utils` `^2.4.11`, `happy-dom` `^20.11.6`, `vitest` `^4.1.11`. Tests: `apps/web/src/App.board.test.ts` and `App.form.test.ts`. `vite.config.ts` proxy: `/api` and `/login` → `http://127.0.0.1:31415`. Vitest: `environment` `happy-dom`, `include` `src/**/*.test.ts`. Root `pnpm dev` is `node scripts/dev.mjs`.

## Packages

`@kaola/shared`: Task Brief schema and lifecycle transitions specified in [DESIGN.md](DESIGN.md) §5–§6 (`taskBriefSchema` / `parseTaskBrief`, `transitionTaskStatus`). `credential` is `z.union` of `{ profile_id: z.string() }` and `{ inline: z.literal(true) }`. Legal edges in `packages/shared/src/index.ts`: 待认领 → 进行中, 已取消; 进行中 → 待认领, 待验收; 待验收 → 已完成, 已退回; 已退回 → 待认领, 已取消.

`@kaola/forge-adapters`: package export `createForgeAdapter`. `validateToken` is a method on the returned adapter (not a package-level export); uses global `fetch`, GET-only. GitHub API host `https://api.github.com`. GitLab `/api/v4`, Gitea `/api/v1`. Other §8 methods throw `Error('not implemented')`. Push/PR are REST permission proxies. Shared spec: `packages/forge-adapters/src/validate-token.shared.test.ts`. `@kaola/server` imports `createForgeAdapter`.

## Deployment

`docker-compose.yml`: service `server`, `"31415:31415"`, `PORT: "31415"`, `HOST: 0.0.0.0`, volume `kaola-data:/data`. Does not set `SQLITE_PATH`, OAuth env, `VAULT_MASTER_KEY`, or `WEB_DIST` (image `ENV WEB_DIST=/app/apps/web/dist`). Dockerfile `node:22-bookworm-slim`, `RUN pnpm --filter @kaola/web build`, `ENV PORT=31415`, `ENV HOST=0.0.0.0`, `ENV WEB_DIST=/app/apps/web/dist`, `EXPOSE 31415`, `CMD pnpm --filter @kaola/server start`.
