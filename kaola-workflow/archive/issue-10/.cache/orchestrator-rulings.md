# Orchestrator rulings — issue #10

Evidence: `kaola-workflow/issue-10/.cache/ground-truth.md`, `kaola-workflow/issue-10/.cache/mcp-sdk.md`. Comments on #10 override the body.

## SDK and mount

- Install **`@modelcontextprotocol/sdk` (v1 line, 1.30.0 as of 2026-08-21)**. DESIGN.md §12 names that package; v2 split packages are the current “stable line” but are a different import graph and protocol era. Claude Code still speaks 2025-era `initialize` + Streamable HTTP; v1 implements that. Do not change DESIGN.md to rename the SDK as a side effect of this slice.
- Transport: **Streamable HTTP**, stateless (`sessionIdGenerator: undefined`), same Fastify process. Per-request `McpServer` + `StreamableHTTPServerTransport.handleRequest(request.raw, reply.raw, request.body)` as in the official v1 Express example. No stdio.
- HTTP path: **`POST /api/mcp`** (and GET/DELETE → 405 JSON-RPC `-32000` Method not allowed, matching the v1 stateless example). Not `/mcp`: `isApiOrLoginPath` only shields `/api` and `/login*`; a GET `/mcp` would hit SPA/`vite` proxy.
- Auth: **do not** use SDK `requireBearerAuth` (it is an OAuth resource-server gate that requires `expiresAt`). Reuse **`addAgentBearerHook`** on an encapsulated Fastify child that owns `/api/mcp`, same 401 `{ error: 'unauthorized' }` + `WWW-Authenticate: Bearer` as whoami/claim. Pending users are not 401’d by the hook.
- Register MCP with the other `register*` calls, **before** hosting plugins.

## Tool surface

Mirror REST behavior via **shared functions**, not by injecting session routes (list/get have no Bearer twin).

| Tool | Args | Success | Errors |
|---|---|---|---|
| `list_tasks` | `status?` `tags?` `forge?` all optional strings | `{ tasks: TaskBrief[] }` same order as REST (PK `id`). Filter like the Vue board: `status` exact, `tags` **membership of one tag**, `forge` exact `repo.forge`. Always `sweepExpiredLeases`. Pending users **may** list. |
| `get_task_brief` | `task_id` (public_id) | top-level brief | missing → tool error |
| `claim_task` | `task_id` | same 201 envelope as REST: `task`, `token`, `lease`, `clone` (`suggested_dir` + `token_usage` exact REST string) | pending 403-equivalent **before decrypt**; conflicts as REST |
| `report_progress` | `task_id` `note?` | `{ task, lease }` no token. `note` optional; omit → `''`. Wrap REST. |
| `release_task` | `task_id` `reason?` | `{ task }` no token. `reason` optional; omit → no `reason` key on event details. Wrap REST. |
| `submit_pr` | `task_id` `pr_url` `summary` all required | `{ task, pr_url, summary }` with `task.status === '待验收'`, **no token**. Require live holder lease and `status === '进行中'`. `transitionTaskStatus('进行中','待验收')`. **Mark the active lease `released`** (unique index + illegal `待验收→待认领`). Persist DESIGN §10 **`submissions`** row: `task_id`, `lease_id`, `pr_url`, `summary`, `pr_state` (`open`). Event `状态迁移` `{ task_id, from, to, pr_url, summary }`. |

`claim_task` **description** (tools/list) must include token-hygiene language (the REST `token_usage` sentence is the pin). Other tools: descriptions in English or Chinese, not pinned beyond being present.

No REST `POST …/submit_pr` in this issue (issue text is MCP; #11 may add HTTP + polling). No `getPullRequest`, no 待验收→已完成/已退回.

## Error channels

- Missing/wrong Bearer on `/api/mcp`: **HTTP 401**, never JSON-RPC.
- Unknown tool / malformed JSON-RPC: protocol errors (SDK).
- Business failures (not found, pending, conflict, illegal transition, vault): JSON-RPC **result** with `isError: true`. Put the REST error body (`error`, `message` when REST has one) in `structuredContent` and a text `content` block so the model sees the same Chinese strings. HTTP status of that MCP POST stays 200.

## Tests

Drive the **Fastify subject** with `app.inject` against `POST /api/mcp` (JSON-RPC `initialize` / `tools/list` / `tools/call`). Do not mock `McpServer`. Do not add the SDK package from the test author — implementer adds `@modelcontextprotocol/sdk`. Copy claim.test.ts seams; do not import other test files. `{ concurrency: false }`. Append the new file to root `package.json` `"test"`.

## Out of scope

PR polling, reopen, webhook, REST submit_pr, claim-confirmation (#16), changing DESIGN.md contracts.
