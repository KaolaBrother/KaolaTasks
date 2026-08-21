# doc-updater report (issue #7)

Working tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`
Did not commit. Did not invent CODEMAPS (none in repo). Did not touch `docs/DESIGN.md`. Did not re-run the full suite.

## Files updated

### `CLAUDE.md`
- **Project Snapshot** (one paragraph, in place): task HTTP is implemented; MCP and claim are not; server depends on `@kaola/shared` and `@kaola/forge-adapters` (`workspace:*`); `createForgeAdapter` is the package export; `validateToken` is an adapter method; `credential` union transcribed.
  - Reconciled against: `packages/shared/src/index.ts:50-53`; `packages/forge-adapters/src/index.ts:45-54` (export `createForgeAdapter`; `validateToken` assigned as method; no `export function validateToken`); `packages/forge-adapters/package.json:6-8` (`exports` `"."` → `./src/index.ts`); `apps/server/package.json:16-17`; `apps/server/src/tasks.ts:1-4,396,478-484`; `apps/server/src/app.ts:21`; `apps/server/src/placeholder.ts` via `app.ts:15-16`.
- **Commands / Test**: full root `package.json` `"test"` script (8 node files `&& pnpm --filter @kaola/web test`).
  - Reconciled against: `package.json:12`.

### `CHANGELOG.md`
- New Unreleased bullets at the **top** (#7 shared credential union; server tasks table + HTTP + errors + events; web form + vitest; measured 2026-08-21 run). Older Unreleased bullets left as-is (historical “task CRUD unimplemented” remains on the #5/#3 bullets).
  - Reconciled against: `packages/shared/src/index.ts:50-53`; `apps/server/src/db.ts:41-88`; `apps/server/src/schema.ts:46-82`; `apps/server/src/tasks.ts` (routes `398-603`; messages `17-23`; XOR credential `208-219`; profile bind `446-454`; base_url `147-156,427-431`; 422/502 `498-517`; reveal event `158-180,520-528`; PATCH poster edges `30-33,557-602`; `insertAuditEvent` status `596-600`); `apps/server/src/tasks.test.ts` (401/403/404/409/422/502/500 strings; `BRIEF_KEYS`; `publishRevealDetails`); `apps/web/src/App.vue:83-203,318-320,328-333,557-646`; `apps/web/package.json:9,17-22`; `apps/web/vite.config.ts:12-14`; `package.json:12`; orchestrator measured run (transcribed, not re-run).

### `README.md`
- Status line, 已落地 (#7), 尚未实现 (removed “发布即校验接到任务上板” / “任务 CRUD 尚未实现”; kept board UI #8, MCP, claim), 工作原理, 首次使用 (发布任务 implemented), 快速开始 OAuth footgun, 部署 vault-read sentence, project structure, forge-adapters import, test command, measured run, roadmap.
  - Reconciled against: same HTTP/table/web sources as above; OAuth footgun: `apps/server/src/auth.ts:238` (`reply.redirect('/')`), `243` (`PUBLIC_URL ?? 'http://localhost:3000'`), `256-258` (cookie flags, no `domain`); `apps/web/vite.config.ts:6-9` (proxy to `127.0.0.1:3000`); briefing measured host-only cookie / `127.0.0.1:5173` (not a code fix). `VAULT_MASTER_KEY` also read on `POST /api/v1/tasks` (`tasks.ts:458-473`).

### `docs/architecture.md`
- Tree diagram: `/api/v1/tasks`, `tasks` table, server imports forge-adapters, MCP/claim only unimplemented.
- Server: `createDb` execs `TASKS_DDL` and maps `tasks`; `registerTasks`; workspace deps.
- Web: 发布任务 form + vitest.
- Packages: credential union; `validateToken` is a method.
  - Reconciled against: `apps/server/src/db.ts:80-87`; `apps/server/src/app.ts:7,21`; `apps/server/package.json:16-17`; `apps/web/src/App.vue:83-203,318-320`; `apps/web/package.json:9,17-22`; `apps/web/vite.config.ts:12-14`; `packages/forge-adapters/src/index.ts:45-54`.

### `docs/api.md`
- Lede: task CRUD implemented; MCP and claim not. Sources line includes `tasks.ts`.
- Four routes + `tasks` table + event shapes (`token 揭示` publish details; `状态迁移`).
- Shared `credential` union; vault `500` also on `POST /api/v1/tasks`; server workspace deps; forge-adapters export note.
  - Reconciled against: `apps/server/src/tasks.ts` handlers `396-603`; `db.ts:41-67`; `schema.ts:46-82`; `vault.ts:67-78,94-97`; `tasks.test.ts` status/error assertions; `packages/shared/src/index.ts:50-53`; `packages/forge-adapters/src/index.ts:45-54`.

## Surfaces skipped (reason)

| Surface | Reason |
|---|---|
| `docs/DESIGN.md` | Must not edit; §6 already changed deliberately |
| `scripts/codemaps/`, `docs/CODEMAPS/` | Do not exist; do not invent |
| `.env.example` | Must not create |
| Any `*.ts` / `*.vue` / `package.json` / tests / lockfile | Must not edit |
| MCP tools / `claim_task` / claim HTTP | Still unimplemented (`tasks.ts:28-29` comment; no MCP SDK in `apps/server/package.json`) |
| Board / kanban / edit UI | Not in `App.vue`; issue #8 |
| Older CHANGELOG Unreleased bullets | Instructed not to rewrite |
| `docs/README.md`, `docs/conventions.md`, `docs/decisions/` | Not in allowed edit list |
| `.github/workflows/ci.yml` | Already `pnpm test`; not in allowed list |
| OAuth-redirect-to-SPA code fix | Measured footgun only; do not invent a fix; do not file an issue |

## Ground-truth pins used (not invented)

- Brief `credential`: `{ profile_id: z.string() }` \| `{ inline: z.literal(true) }` (`packages/shared/src/index.ts:50-53`).
- Request `credential`: `{ profile_id }` XOR `{ token }` (`tasks.ts:205-219`).
- Public id format `kt-YYYY-NNNN` (`tasks.ts:354-367`); route param `:publicId` (`tasks.ts:405,558`).
- Chinese errors: `token 无效或无权访问该仓库，任务未发布。` / `无法连接 forge 校验 token，任务未发布。` / `所选凭证档案不存在。` / `所选凭证档案与仓库不匹配。` / `仓库地址不是合法的 http 或 https 地址。` / `token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。` / `任务状态不允许从「${from}」变更为「${to}」。` (`tasks.ts:17-21,69-77`).
- Event types: `token 揭示` / `状态迁移` (`tasks.ts:22-23,158-180,596-600`).
- Reveal details keys: `profile_id`, `forge`, `base_url`, `full_name`, `outcome` (`ok` \| `token_check_failed` \| `forge_unreachable`) (`tasks.ts:172-178`).
- `GET /` body still `考拉任务服务占位` (`app.ts:15-16`).
- Root test script transcribed verbatim from `package.json:12`.
- Measured run transcribed from orchestrator briefing (2026-08-21, `CI=true`).
