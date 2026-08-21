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
                /api/v1/tasks                    session list/create; POST /import 200 draft
                                                 (no persist, no validateToken, no token);
                                                 :publicId get/patch
                                                 GET list/one call sweepExpiredLeases then re-read
                /api/v1/tasks/:publicId/claim    Bearer POST (201 clone, lease, task, token)
                /api/v1/tasks/:publicId/progress Bearer POST (200 task, lease; no token)
                /api/v1/tasks/:publicId/release  Bearer POST (200 task; no token)
                POST /api/mcp                    Bearer Streamable HTTP (six MCP tools)
                GET/DELETE /api/mcp              405 JSON-RPC -32000 Method not allowed
                POST /api/v1/webhooks/:publicId  no session, no Bearer — forge signature is the sole auth
                                                 (registerWebhooks; :publicId is a forgeInstances[] id, not a task)
                pollPendingReviews(db, forgeInstances?)  not a route; setInterval per buildApp({ pollIntervalMs })
                                                 drives 待验收 → 已完成/已退回 via getPullRequest;
                                                 skips tasks matching a syncMode: 'webhook' instance
                SQLite users, agent_keys, credential_profiles, tasks, events, leases, submissions (createDb)
                unique index leases_one_active_per_task on leases(task_id) WHERE state = 'active'
                vault.ts encryptToken / decryptToken / revealCredentialProfile / insertAuditEvent
                  (forge token: REST claim 201 top-level token and MCP claim_task success token;
                   POST /api/v1/tasks/import 200 never contains it;
                   poller decrypts to call the forge but never returns it over HTTP;
                   the webhook receiver never decrypts a token and never calls getPullRequest)
@kaola/web              Vue 3 + Naive UI; vite.config proxy /api and /login → 127.0.0.1:31415
                        任务看板; 导入内容 label on imported detail; one synthetic 发布; no claim UI; no events HTTP
                        no webhook / forge-instance UI
@kaola/shared           Task Brief zod + transitionTaskStatus
@kaola/forge-adapters   createForgeAdapter (validateToken + getPullRequest + importIssue + registerWebhook +
                        parseWebhook are adapter methods; parseIssueUrl and WebhookSignatureError are
                        package-level exports)
                        imported by @kaola/server (workspace:*)
MCP                     registerMcp; @modelcontextprotocol/sdk 1.30.0
poller + webhook        pollPendingReviews and registerWebhooks share applyPrTerminalTransition;
                        buildApp({ forgeInstances? }) config, no new table; no REST submit_pr;
                        commentOnIssue / status write-back to source Issue still not implemented (#14)
```

## Server

`apps/server/src/index.ts` listens `HOST` default `0.0.0.0`, `PORT` default `31415`, `buildApp({ sqlitePath: process.env.SQLITE_PATH ?? ':memory:', webDist: process.env.WEB_DIST, viteDevTarget: process.env.VITE_DEV_TARGET, pollIntervalMs, forgeInstances })` where `pollIntervalMs` is computed from `process.env.POLL_INTERVAL_MS` (unset or `''` → `60000`; otherwise `Number.parseInt(value, 10)`) and `forgeInstances` from `process.env.FORGE_INSTANCES` (`readForgeInstances()`: unset or `''` → `[]`; non-array or invalid JSON throws, failing boot rather than silently falling back to poll-everything).

`buildApp({ sqlitePath?, webDist?, viteDevTarget?, pollIntervalMs?, forgeInstances? })`: omit/empty both hosting options → `GET /` `text/plain; charset=utf-8` body `考拉任务服务占位` via `getPlaceholderBody()`. Non-empty `webDist` → `@fastify/static` `^10.1.3` + exact `GET /` `sendFile` `index.html` + SPA fallback for other GET except `/api` and `/login*`. Both set → `webDist` wins. Only `viteDevTarget` → `@fastify/http-proxy` `^11.6.0`. `pollIntervalMs` omitted or `<= 0` → no poller timer registered; a positive value registers exactly one `setInterval(pollPendingReviews-driven fn, pollIntervalMs)` in its own child plugin (mirrors `mcp.ts`'s bearer context) so its `onClose` `clearInterval` runs before the root db-close hook; an in-flight guard skips a tick while the previous pass is still running. `forgeInstances` (`Array<{ publicId, forge, baseUrl, syncMode: 'webhook' | 'poll', webhookSecret }>`, no new table) is passed both into that timer's `pollPendingReviews(db, forgeInstances)` calls and into `registerWebhooks(app, db, forgeInstances)` (#13).

`createDb` runs `CREATE TABLE IF NOT EXISTS` for `users`, `agent_keys`, `credential_profiles`, `tasks`, `events`, and `leases`, then `CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_task ON leases(task_id) WHERE state = 'active'`, then `submissions`, then drizzle with `{ schema: { users, agentKeys, credentialProfiles, tasks, events, leases, submissions } }`. Default path `:memory:` unless `SQLITE_PATH`. `tasks` INTEGER PK `id` plus `public_id` TEXT NOT NULL UNIQUE (`kt-YYYY-NNNN`); CONSTRAINT `tasks_credential_xor` CHECK `((credential_profile_id IS NULL) != (inline_token_encrypted IS NULL))`. `leases` columns: `id`, `task_id` (integer `tasks.id`), `claimer_user_id`, `agent_key_id`, `claimed_at`, `expires_at`, `last_heartbeat`, `state`. TTL `86400` in `leases.ts` (`LEASE_TTL_SECONDS`); no per-task TTL column. `submissions` columns: `id`, `task_id` (integer `tasks.id`), `lease_id`, `pr_url`, `summary`, `pr_state`.

Auth stack: `@fastify/cookie@^11.1.2`, `@fastify/session@^11.1.2`, `@fastify/oauth2@^8.3.0`. Session field: `userId?: number`. Cookie flags in source: `path: '/'`, `secure: false`, `httpOnly: true`, `sameSite: 'lax'`; `saveUninitialized: false`. Agent Bearer uses `addAgentBearerHook` in `apps/server/src/agent-bearer.ts` (child Fastify `onRequest`; used by whoami, claim, and MCP plugins), not `@fastify/bearer-auth`. Vault uses `node:crypto` `createCipheriv` / `createDecipheriv` (`aes-256-gcm`); vault does not add an npm package. `insertAuditEvent` accepts `actorUserId: number | null`.

`registerAuth` throws if required OAuth / session env vars are empty (names in [api.md](api.md)). `VAULT_MASTER_KEY` is not read at `buildApp()` / `registerAuth` boot; `encryptToken` / `decryptToken` read it when encrypting or decrypting.

`buildApp` wires `registerTasks(app, db)` (`apps/server/src/tasks.ts`) then `registerClaim(app, db)` (`apps/server/src/claim.ts`) then `registerMcp(app, db)` (`apps/server/src/mcp.ts`) then `registerWebhooks(app, db, forgeInstances)` (`apps/server/src/webhook.ts`, #13), before the optional poller registration and before hosting. Session GET list/one call `sweepExpiredLeases` then re-read (check-on-read). Claim/progress/release and MCP list/get/mutating tools also call `sweepExpiredLeases` (check-on-write / check-on-read). No cron. POST 发布即校验 calls `createForgeAdapter(forge, { baseUrl }).validateToken`. `POST /api/v1/tasks/import` (same `registerTasks`) calls `parseIssueUrl` then `adapter.importIssue` and does **not** persist or call `validateToken`. Server dependencies include `"@kaola/shared": "workspace:*"`, `"@kaola/forge-adapters": "workspace:*"`, `"@modelcontextprotocol/sdk": "1.30.0"`, `"zod": "^4.4.3"`, `@fastify/static@^10.1.3`, `@fastify/http-proxy@^11.6.0`. Extracted `claimTask`/`reportProgress`/`releaseTask`/`submitPr`; REST still has no `POST …/submit_pr`.

`apps/server/src/poller.ts` exports `pollPendingReviews(db: AppDb, forgeInstances?: ForgeInstanceConfig[]): Promise<void>` — not a route. Together with the webhook receiver below (#13), it is one of the two drivers of `待验收` → `已完成`/`已退回`. Per `待验收` task not managed by a `syncMode: 'webhook'` `forgeInstances` entry (`isWebhookManaged` / exported `taskMatchesForgeInstance(task, instance)`, exact `(repoForge, repoBaseUrl)` equality), it reads the latest `submissions` row, decrypts the task's credential (same branch as `claimTask`), and calls `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl }).getPullRequest({ token }, submission.prUrl)`. `merged` → task `已完成`, `submissions.pr_state` `'merged'`; `closed` → task `已退回`, `pr_state` `'closed'`; `open` → unchanged. The transition is written by the exported `applyPrTerminalTransition(db, task, submissionId, terminal, prUrl)` — the status write, the `submissions.pr_state` write, and one `insertAuditEvent` (`状态迁移`, `actorUserId: null`, `details` `{ task_id, from: '待验收', to, pr_url }`) inside one `db.transaction`, shared verbatim with `webhook.ts`. Never rejects: a fault fetching or writing one task is caught and only that task is skipped. `insertAuditEvent`'s first parameter is typed as a structural `{ insert: AppDb['insert'] }` so it also accepts a `db.transaction` handle.

`apps/server/src/webhook.ts` exports `registerWebhooks(app: FastifyInstance, db: AppDb, forgeInstances?: ForgeInstanceConfig[])` (#13) — `POST /api/v1/webhooks/:publicId`, no session, no Bearer, the forge signature is the sole auth. Registered inside its own child plugin with a content-type parser override (`parseAs: 'string'`) scoped to that plugin only, so the exact raw body reaches `adapter.parseWebhook` for HMAC verification. `:publicId` looks up a `forgeInstances` entry (not a task); unknown → `404` `{ error: 'not_found' }`. `adapter.parseWebhook(headers, body)` throwing `WebhookSignatureError` → `401` `{ error: 'invalid_signature' }`; returning `null` → `204`. A concrete `ForgeEvent` is matched against `待验收` tasks first filtered to the signature-verified instance's `(forge, baseUrl)` (`taskMatchesForgeInstance`, shared with the poller) and then to the task's latest `submissions.prUrl` — binding the completion to the verified instance closes a cross-instance confused-deputy path found in security review and fixed before this state. A match calls the same `applyPrTerminalTransition` the poller uses, then `204`; no match also `204` (never `404` a valid signed delivery). This route never decrypts a token and never calls `getPullRequest`.

## Web

`apps/web/src/App.vue`: Naive UI, `zhCN` / `dateZhCN`. Views: login buttons, pending card (`status` `待批准`, title 账号待批准 — no board), member workbench (`view === 'member'`) with 任务看板 (列表 / 看板; client-side filters 状态 / 标签 / Forge; detail + one synthetic 发布 from `created_at`+`poster`; imported detail shows 导入内容 plus existing `board-detail-issue-url` link; `GET /api/v1/tasks` exactly, no query; no events HTTP; no claim UI). `claim_only` sees the board, not the posting form. Approve-by-id, credential-profile widget, and 发布任务 form when `status === 'active'` and `permission_level === 'full'` (`canApprove`). Agent Key widget when `status === 'active'`. Form reuses loaded `profiles` for the credential dropdown; two request-side paths `{ profile_id }` XOR `{ token }`; create (`POST /api/v1/tasks`) plus, when 来源 is `imported`, 导入 (`POST /api/v1/tasks/import`) with 导入内容 label. Fetches `GET /api/v1/me` with `Accept: application/json` and `credentials: 'include'`. No vue-router (`apps/web/package.json` has `vue` `^3.5.0`, `naive-ui` `^2.45.0` only). Description stays text interpolation (no `v-html`).

`apps/web/package.json` `"test": "vitest run"`; devDeps `@vue/test-utils` `^2.4.11`, `happy-dom` `^20.11.6`, `vitest` `^4.1.11`. Tests: `apps/web/src/App.board.test.ts` and `App.form.test.ts`. `vite.config.ts` proxy: `/api` and `/login` → `http://127.0.0.1:31415`. Vitest: `environment` `happy-dom`, `include` `src/**/*.test.ts`. Root `pnpm dev` is `node scripts/dev.mjs`.

## Packages

`@kaola/shared`: Task Brief schema and lifecycle transitions specified in [DESIGN.md](DESIGN.md) §5–§6 (`taskBriefSchema` / `parseTaskBrief`, `transitionTaskStatus`). `credential` is `z.union` of `{ profile_id: z.string() }` and `{ inline: z.literal(true) }`. Legal edges in `packages/shared/src/index.ts`: 待认领 → 进行中, 已取消; 进行中 → 待认领, 待验收; 待验收 → 已完成, 已退回; 已退回 → 待认领, 已取消.

`@kaola/forge-adapters`: package export `createForgeAdapter`, `parseIssueUrl`, and `WebhookSignatureError`. `validateToken`, `getPullRequest`, `importIssue`, `registerWebhook`, `parseWebhook` are methods on the returned adapter (not package-level exports); all use global `fetch` except `parseWebhook`, which never fetches. GitHub API host `https://api.github.com`. GitLab `/api/v4`, Gitea `/api/v1`. `getPullRequest(cred, prUrl)` parses owner/repo/number (or GitLab namespace/iid) out of the pasted PR/MR web URL and returns `PrStatus` `{ state: 'open' | 'merged' | 'closed' }`; GitLab/Gitea always call the constructor `baseUrl`, never the prUrl's own host. `importIssue(cred, issueUrl)` uses the same host rule (`prApiOrigin`) and returns `ImportedIssue` `{ title, description_md, issue_url, repo: { full_name } }`. `parseWebhook(headers, body)` (#13) verifies a per-forge signature over the raw body (GitHub `X-Hub-Signature-256` HMAC-SHA256 with `sha256=` prefix; GitLab `X-Gitlab-Token` plaintext compare; Gitea `X-Gitea-Signature` HMAC-SHA256 without prefix) — missing/wrong signature or a missing `webhookSecret` throws `WebhookSignatureError`; a signature-valid but irrelevant delivery (ping, wrong event type, non-`closed`) returns `null`; a merge/close returns `ForgeEvent` `{ type: 'pull_request', state: 'merged' | 'closed', pr_url, repo: { full_name } }` (`ForgeEvent` is no longer `unknown`). `registerWebhook(cred, repo, callback)` (#13) `POST`s a hook to the forge's create-hook endpoint (same host rule as `getPullRequest`) with `config.secret`/`token` set to `webhookSecret`; non-OK response rejects. `commentOnIssue` still throws `Error('not implemented')` (#14). Push/PR are REST permission proxies. Shared specs: `packages/forge-adapters/src/validate-token.shared.test.ts`, `packages/forge-adapters/src/get-pull-request.shared.test.ts`, `packages/forge-adapters/src/import-issue.shared.test.ts`, `packages/forge-adapters/src/webhook.shared.test.ts`. `@kaola/server` imports `createForgeAdapter`, `parseIssueUrl`, and `WebhookSignatureError`.

## Deployment

`docker-compose.yml`: service `server`, `"31415:31415"`, `PORT: "31415"`, `HOST: 0.0.0.0`, volume `kaola-data:/data`. Does not set `SQLITE_PATH`, OAuth env, `VAULT_MASTER_KEY`, or `WEB_DIST` (image `ENV WEB_DIST=/app/apps/web/dist`). Dockerfile `node:22-bookworm-slim`, `RUN pnpm --filter @kaola/web build`, `ENV PORT=31415`, `ENV HOST=0.0.0.0`, `ENV WEB_DIST=/app/apps/web/dist`, `EXPOSE 31415`, `CMD pnpm --filter @kaola/server start`.
