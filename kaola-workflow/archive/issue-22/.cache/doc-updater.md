# Doc docking — issue #22

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-22`  
Branch: `workflow/issue-22`  
Role: doc-updater. No tests, no production code, no `docs/smoke-test.md`.  
No `scripts/codemaps/` and no `docs/CODEMAPS/` in this repo — skipped codemap generation.

Issue body is the contract (comment 2 voids earlier comments).

## Commands

- Python one-shot extract of `apps/server/src/claim.ts` + `apps/server/src/mcp.ts` (CLONE_TOKEN_USAGE, clone type keys, `registerTool` names, POST paths).
- Read of existing `docs/api.md` claim envelope + MCP `claim_task` row, `docs/DESIGN.md` §7 extra_header table.
- GitHub issue #22 body via MCP (`KaolaBrother/KaolaTasks`).

## Transcribed from source (not invented)

### `apps/server/src/claim.ts`

```
export const CLONE_TOKEN_USAGE =
  'token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。'
```

`ClaimSuccessBody` keys: `task`, `token`, `lease`, `clone`.

`clone` four keys (do not rename):

- `suggested_dir`
- `token_usage`
- `remote_url`
- `extra_header` `{ name: string; value_pattern: string }`

Construction:

- `suggested_dir: brief.repo.suggested_dir`
- `token_usage: CLONE_TOKEN_USAGE`
- `remote_url: \`${brief.repo.base_url.replace(/\/+$/u, '')}/${brief.repo.full_name}.git\``
- `extra_header`: gitea `{ name: 'Authorization', value_pattern: 'token ${token}' }`; else `{ name: 'Authorization', value_pattern: 'Bearer ${token}' }`

REST: `child.post('/api/v1/tasks/:publicId/claim', …)` → `claimTask` success `httpStatus: 201`.

### `apps/server/src/mcp.ts`

```
new McpServer({ name: 'kaola-tasks', version: '0.0.0' })
child.post('/api/mcp', …)
```

`registerTool` names (exact, python extract): `list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `release_task`, `submit_pr`.

`claim_task` input: `task_id: z.string()`, `autonomous: z.boolean().optional()`.  
Handler: `claimTask(db, authHolder.auth, args.task_id, args.autonomous)` — same success body as REST.  
Description interpolates `CLONE_TOKEN_USAGE`.

`toToolResult` assigns `const structuredContent = result.body as Record<string, unknown>` (existing `docs/api.md` MCP table header already used `structuredContent`; left as in that file).

### `apps/server/src/agent-keys.ts`

`generatePlaintextKey`: `` return `ktk_${randomBytes(32).toString('hex')}` ``

### Env name `KAOLA_AGENT_KEY`

Not a server identifier. Taken from issue #22 body (and `docs/smoke-test.md` reference only). Docs state it as the local injection source into user-level `~/.cursor/mcp.json`. No production code path reads this name.

## Files changed (worktree)

| Path | Reconciled against |
|------|--------------------|
| `README.md` section `## Agent 怎么接单` | URL-only `mcpServers` / `kaola-tasks` / `url` `http://localhost:31415/api/mcp`; env-inject Agent Key; MCP 平时无仓库钥匙; claim 成功才有该任务顶层 `token` + `clone`; 换 `task_id`/`publicId` 换 token; clone via `extra_header` + `remote_url`; never put forge PAT in MCP `Authorization`. Envelope keys `task`, `token`, `lease`, `clone`. Clone keys and `CLONE_TOKEN_USAGE` sentence unchanged. |
| `docs/DESIGN.md` §7 | Added user-model bullet **MCP 平时无仓库钥匙（用户模型）**. Did **not** rewrite the extra_header table (still github/gitlab `Bearer ${token}`, gitea `token ${token}`). Did **not** rename clone keys. `CLONE_TOKEN_USAGE` sentence unchanged. |
| `docs/api.md` | Claim `201` envelope: same user-model sentences; keys stay `clone`, `lease`, `task`, `token`. MCP `claim_task` row: same user-model sentences; clone four keys unchanged; `CLONE_TOKEN_USAGE` quoted in full. |

## Skipped (with reason)

| Surface | Reason |
|---------|--------|
| `docs/smoke-test.md` | Issue D / orchestrator: reference only; already on `2ce443a`. |
| `docs/architecture.md` | No committed MCP example; no user-model gap vs #22 D list. |
| `CHANGELOG.md` | No HTTP surface / command / workspace-member change; issue D did not list it. |
| `CLAUDE.md` Commands | Commands unchanged. |
| `docs/CODEMAPS/*` / `scripts/codemaps/` | Neither exists. |
| tests / `apps/server/src/*` production | Out of role. |
| MCP writer script | Issue B “可以做”; not an acceptance checkbox. |

## URL-only JSON snippet (committed)

```json
{
  "mcpServers": {
    "kaola-tasks": {
      "url": "http://localhost:31415/api/mcp"
    }
  }
}
```

Server `name` `kaola-tasks` and path `/api/mcp` transcribed from `mcp.ts`. Port `31415` transcribed from `scripts/dev.mjs` `PORT` default and README `PUBLIC_URL`.
