# tdd-guide handoff — issue #10 MCP tests (RED)

Role: **tdd-guide**. Custody of the test artifact only. No production code was written.

## Test paths written

- Worktree tests: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10/apps/server/src/mcp.test.ts`
- Root `package.json` `"test"` script (worktree): appended `apps/server/src/mcp.test.ts` after `claim.test.ts`. No other package.json churn.
- Subject: Fastify `buildApp` + `app.inject` against `POST /api/mcp` (JSON-RPC `initialize` / `tools/list` / `tools/call`). Parses `application/json` and `text/event-stream` `event: message`. `{ concurrency: false }`. Seams copied from `claim.test.ts` (not imported).

## Baseline SHA actually run

`64b123e5ac2fe77aa176bd5deea055be7d77f758` (worktree `git rev-parse HEAD`)

Command (worktree cwd, after `pnpm install` so `@kaola/shared` resolves — the worktree had no `node_modules` until then):

```
node --experimental-strip-types --test apps/server/src/mcp.test.ts
```

Raw output: `kaola-workflow/issue-10/.cache/tests-mcp-baseline.txt`

Result: **18 fail, 0 pass**. Intended RED. `POST /api/mcp` does not exist (`Route POST:/api/mcp not found`).

Old suites still pass (not broken by this change):

```
node --experimental-strip-types --test apps/server/src/claim.test.ts apps/server/src/tasks.test.ts apps/server/src/agent-keys.test.ts
```

→ 105 pass, 0 fail.

## Failure signature

Unauthenticated / wrong-scheme cases fail on **HTTP 401** vs current **404**:

| Test | Assertion proving expected fail |
|---|---|
| `unauthenticated POST /api/mcp (missing Authorization) is 401 unauthorized with WWW-Authenticate Bearer` | `assertBearerUnauthorized`: `expected 401, got 404: {"message":"Route POST:/api/mcp not found",...}` (`404 !== 401`) |
| `Token scheme, Basic, and wrong Bearer on POST /api/mcp are 401 with WWW-Authenticate Bearer` | same `404 !== 401` |
| `a session cookie without Bearer does not authorize POST /api/mcp` | same `404 !== 401` |

Authenticated cases fail one step later, on **initialize HTTP 200** vs **404** (`readyMcp` → `client.initialize`):

`AssertionError: MCP initialize HTTP: 404 {"message":"Route POST:/api/mcp not found","error":"Not Found","statusCode":404}` (`404 !== 200`)

Applies to all remaining 15 tests, including:

- `authenticated tools/list includes the six tools and claim_task describes token hygiene`
- `list_tasks returns { tasks } briefs that parse and never contain forge secrets`
- `list_tasks filters by exact status, tag membership of one tag, and exact repo.forge`
- `list_tasks and get_task_brief apply sweepExpiredLeases so an expired 进行中 task shows as 待认领`
- `a pending 待批准 Agent Key may list_tasks`
- `get_task_brief returns a top-level brief; missing and numeric ids are isError not_found`
- `claim_task success envelope keys are exactly task, token, lease, clone with the REST clone pin`
- `pending claim_task is isError matching REST 403, reveals no token, and writes no token 揭示`
- `second claim_task is conflict; list_tasks and get_task_brief still omit the forge token`
- `report_progress wraps REST: optional note (omit → empty string), envelope { task, lease }, no token`
- `release_task wraps REST: optional reason, envelope { task } 待认领, no token`
- `non-holder report_progress and release_task are isError forbidden with no message`
- `report_progress and release_task with no live lease are isError 任务未被认领`
- `submit_pr success is { task, pr_url, summary } 待验收, persists submissions, clears the lease, writes 状态迁移`
- `submit_pr fails for non-holder, no lease, and not 进行中`

Once `/api/mcp` exists with Bearer 401-before-JSON-RPC, the unauth trio should go green first; the rest then pin tools/list, filters, claim envelope, wrap-REST progress/release, and submit_pr persistence.

## Contract the suite asserts (for the implementer)

Drive with Bearer on every authenticated POST. Send `initialize` (`protocolVersion` `2025-11-25`); if the response carries `mcp-session-id`, replay it (and `notifications/initialized`). Then `tools/list` / `tools/call`. HTTP 200 for authenticated JSON-RPC; business failures are `result.isError === true` with REST `{ error, message? }` in `structuredContent` (or JSON text `content`). Success payloads from `structuredContent` (fallback: parse first text content block).

1. **Auth / tools/list:** missing header, `Token ` scheme, Basic, session-cookie-only, wrong Bearer → HTTP 401 `{ error: 'unauthorized' }` + `WWW-Authenticate: Bearer`. `tools/list` names **exactly** the six tools. `claim_task.description` must include the REST sentence `token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。`
2. **list/get:** `{ tasks: [...] }` ordered by PK; each brief `parseTaskBrief`; no keys `token` / `token_encrypted` / `inline_token_encrypted` / `access_token` and no fixture forge plaintext. Filters: `status` exact, `tags` membership of one tag, `forge` exact `repo.forge`. `sweepExpiredLeases` on list/get. Pending user **may** list. `get_task_brief` is a top-level brief; missing/`"1"` → isError `{ error: 'not_found' }`.
3. **claim_task:** success keys exactly `clone`, `lease`, `task`, `token`; clone pin as REST (`suggested_dir` + exact `token_usage`). Pending: isError forbidden + REST message, no token, no `token 揭示`. Second claim: isError conflict `任务已被认领。`. list/get after claim still no token.
4. **report_progress / release_task:** wrap REST. Omit `note` → event `note: ''`. Omit `reason` → event details have no `reason` key. Non-holder: isError `{ error: 'forbidden' }` **without** `message`. No lease: isError `{ error: 'conflict', message: '任务未被认领。' }`. No token in result.
5. **submit_pr:** required `task_id`, `pr_url`, `summary`. Success `{ pr_url, summary, task }` with `task.status === '待验收'`, no token. `submissions` row: `task_id` = integer `tasks.id`, `lease_id` = the lease that was active, `pr_url`, `summary`, `pr_state` `open`. Active lease `released`. Event `状态迁移` `{ task_id: public_id, from: '进行中', to: '待验收', pr_url, summary }`. Non-holder / no lease / not 进行中 (forced `已取消` with live lease) fail as forbidden / `任务未被认领。` / `illegal_transition` Chinese message to `待验收`.

Setup uses REST `POST /api/v1/tasks` (inline `INLINE_TOKEN` / gitlab filter token) and REST claim where the MCP tool under test is not claim. Pending keys via `seedAgentKey` SQL.

## What this role did **not** implement

- No `POST /api/mcp` route, no `registerMcp`, no `McpServer`, no Streamable HTTP transport
- No `@modelcontextprotocol/sdk` install (implementer adds v1 `1.30.0`)
- No schema/DDL (`submissions` table still absent — success test will query it after the route exists)
- No handler extraction from `claim.ts` / `tasks.ts`
- No REST `POST …/submit_pr`
- No GET/DELETE `/api/mcp` 405 cases (rulings mention them; the five claims did not require them)
- No PR polling, no `getPullRequest`, no 待验收→已完成/已退回
- No mock of `McpServer`

## Open questions refused to invent

- Protocol-error codes for unknown tool / malformed JSON-RPC / missing `submit_pr` args (SDK schema vs `isError`). Not asserted.
- Whether `tools/list` may advertise extra tools. Suite requires **exactly** the six names (DESIGN §9 surface).
- `submissions.task_id` column type is not named in DESIGN beyond `task_id`; suite treats it as integer `tasks.id` to match `leases.task_id`. If the implementer stores `public_id` text, that assertion will fail on purpose — confirm before changing the test.
- GET/DELETE 405 JSON-RPC `-32000` shape: not in the five claims; not tested.
- Profile-path `claim_task` (only inline success envelope is required by the claims).
