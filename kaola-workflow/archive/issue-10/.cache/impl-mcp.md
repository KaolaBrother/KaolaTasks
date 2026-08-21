# implementer — issue #10 MCP (`tests-green`)

## Task

Make `mcp.test.ts` green. In-process MCP Streamable HTTP on Fastify, six tools, Agent API Key auth, `submit_pr` → 待验收. No PR polling. No REST `POST …/submit_pr`. No DESIGN.md contract edits. `mcp.test.ts` and the root `"test"` script were not edited.

Verification tier: **`tests-green`**.

## Files changed

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10`

| Path | Change |
|---|---|
| `apps/server/package.json` | `@modelcontextprotocol/sdk@1.30.0`; `zod@^4.4.3` (needed for v1 `registerTool` Zod raw shapes; same range as `@kaola/shared`) |
| `pnpm-lock.yaml` | lockfile from `pnpm --filter @kaola/server add` |
| `apps/server/src/schema.ts` | DESIGN §10 `submissions` drizzle table (`task_id`, `lease_id`, `pr_url`, `summary`, `pr_state`) |
| `apps/server/src/db.ts` | `submissions` DDL + drizzle schema registration |
| `apps/server/src/tasks.ts` | export `selectTasks` |
| `apps/server/src/claim.ts` | extract `claimTask` / `reportProgress` / `releaseTask` (HTTP wrappers unchanged in behavior); add `submitPr`; export `CLONE_TOKEN_USAGE` |
| `apps/server/src/mcp.ts` | **new** — encapsulated child + `addAgentBearerHook`, `POST /api/mcp`, GET/DELETE 405 JSON-RPC `-32000`, stateful Streamable HTTP sessions, six tools |
| `apps/server/src/app.ts` | `registerMcp` with the other `register*` calls, before hosting |

Not edited: `apps/server/src/mcp.test.ts`, root `package.json` `"test"` (already had `mcp.test.ts` from tdd-guide), `docs/DESIGN.md`.

## Commands + exit codes

Worktree cwd. RED treated as already recorded (18 fail on `64b123e`); not re-run before edits.

```
pnpm --filter @kaola/server add @modelcontextprotocol/sdk@1.30.0
```
exit **0**

```
pnpm --filter @kaola/server add zod@^4.4.3
```
exit **0** (zod was not listed on `@kaola/server`; MCP `inputSchema` imports it)

```
node --experimental-strip-types --test apps/server/src/mcp.test.ts
```
exit **0** — `tests 18` `pass 18` `fail 0`

```
node --experimental-strip-types --test apps/server/src/claim.test.ts apps/server/src/tasks.test.ts apps/server/src/agent-keys.test.ts
```
exit **0** — `tests 105` `pass 105` `fail 0`

```
pnpm --filter @kaola/server typecheck
```
exit **0** (`tsc --noEmit -p tsconfig.json`)

## Before / after

**Before:** `POST /api/mcp` did not exist. Unauthenticated cases: HTTP **404** vs expected **401**. Authenticated `initialize`: HTTP **404**. `submissions` table absent.

**After:** Bearer missing/wrong/non-Bearer → `sendBearerUnauthorized` HTTP **401** `{ error: 'unauthorized' }` + `WWW-Authenticate: Bearer` before JSON-RPC. Authenticated Streamable HTTP (`protocolVersion` `2025-11-25`) initializes with `mcp-session-id`; tools/list names the six tools; `claim_task` description includes the REST token-hygiene sentence. Business failures are JSON-RPC **result** `isError: true` with REST `{ error, message? }` in `structuredContent` (HTTP 200). `submit_pr` writes `submissions.pr_state = 'open'`, marks the live lease `released`, status `待验收`, event `状态迁移`. REST claim/progress/release still green.

## What this role did **not** cover

- GET/DELETE `/api/mcp` 405 JSON-RPC `-32000` is implemented (rulings) but not asserted by the suite
- No REST `POST …/submit_pr`, no PR polling / `getPullRequest`, no 待验收→已完成/已退回
- MCP `claim_task` profile-path not separately exercised (inline envelope is what the suite pins; REST profile claim still works)
- Protocol-error codes for unknown tool / malformed JSON-RPC / missing required args (SDK; not asserted)
- Pending-user `submit_pr` / `report_progress` (REST: progress/release do not re-check 待批准)
- Docs (`README`, `CHANGELOG`, `docs/api.md`, CLAUDE.md snapshot still says MCP is not implemented)
