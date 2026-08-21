# Issue #10 doc-updater proof

- **task:** dock README / CHANGELOG Unreleased / CLAUDE.md snapshot+Commands / docs/api.md / docs/architecture.md to implemented MCP (`POST /api/mcp`, six tools, `submissions`)
- **worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10`
- **docs edited:** `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/api.md`, `docs/architecture.md`
- **docs not edited:** `docs/DESIGN.md` (untouched), `docs/README.md` (index already lists api/architecture), `docs/conventions.md` (still true: tokens never in logs or non-claim API responses), `docs/decisions/` (none)
- **not invented:** `scripts/codemaps/`, `docs/CODEMAPS/`
- **pnpm test:** not run this role; no new measured lint/test/build totals; `mcp.test.ts` `test(` count 18 only
- **CLAUDE.md** line count after edit: 124 (under 200 recommendation)

`git diff --stat` (docs only): `README.md` `CHANGELOG.md` `CLAUDE.md` `docs/api.md` `docs/architecture.md` — 5 files, +63/−28 (architecture vault wording: one extra clause after a follow-up tweak). `docs/DESIGN.md` not in the diff.

---

## Sentences changed → source

### README.md

| Changed sentence (summary) | Source |
|---|---|
| Status: #10 MCP landed; PR 轮询 / webhook still unimplemented | `app.ts:53` `registerMcp`; no webhook/`getPullRequest` in `apps/server/src` |
| 已落地 header includes #10 | same |
| Reveal channels: REST claim `201` `token` **and** MCP `claim_task` `token` | `claim.ts:173-185`; `mcp.ts:114-120` |
| REST #9: no REST `POST …/submit_pr` | `claim.ts:361-388` (claim/progress/release only) |
| MCP #10: `POST {origin}/api/mcp` Bearer; Streamable HTTP; tests `protocolVersion` `2025-11-25`; `mcp-session-id`; unauth `401` + `WWW-Authenticate: Bearer`; GET/DELETE `405`; six tools + envelopes; `isError`; SDK `1.30.0` `zod` `^4.4.3` | `mcp.ts:227-243,91-159,42-48,202-208`; `mcp.test.ts:35-36,712,718-722`; `apps/server/package.json:20,24`; `agent-bearer.ts:34-36` |
| 尚未实现: only 自动闭环 (webhook/轮询) | MCP present; no polling writer |
| 工作原理 caption: MCP `claim_task`/`submit_pr` landed; Agent `POST {origin}/api/mcp` | `mcp.ts:238-239,114-159` |
| 首次使用: Agent configures Bearer on `POST {origin}/api/mcp` | `mcp.ts:227-239` |
| Project structure server comment: `+ mcp` | `mcp.ts` exists |
| `pnpm test` list appends `apps/server/src/mcp.test.ts` after `claim.test.ts` | worktree `package.json:13` |
| Roadmap: #10 landed; remaining M1 is PR 轮询 | `registerMcp` present; no PR polling |

### CHANGELOG.md

| Changed sentence (summary) | Source |
|---|---|
| New Unreleased #10 bullet at top: `registerMcp` after `registerClaim` before hosting | `app.ts:51-53` |
| SDK `1.30.0` exact; `zod` `^4.4.3` | `apps/server/package.json:20,24`; lockfile `@modelcontextprotocol/sdk@1.30.0` |
| `addAgentBearerHook` on MCP child | `mcp.ts:228-229` |
| Streamable HTTP `enableJsonResponse: true`; stateful `mcp-session-id`; tests `protocolVersion` `2025-11-25` | `mcp.ts:202-208,37-39`; `mcp.test.ts:36,712,721-722` |
| GET/DELETE `405` JSON-RPC `-32000` `Method not allowed.` | `mcp.ts:29-35,241-242` |
| Unauth `401 { error: 'unauthorized' }` + `WWW-Authenticate: Bearer` before JSON-RPC | `mcp.ts:171-173`; `agent-bearer.ts:34-36` |
| `McpServer` `{ name: 'kaola-tasks', version: '0.0.0' }` | `mcp.ts:89` |
| Six `registerTool` names; `claim_task` description includes `CLONE_TOKEN_USAGE` | `mcp.ts:91-159,26-27` via `claim.ts:26-27` |
| Extracted `claimTask`/`reportProgress`/`releaseTask`/`submitPr`; no REST `submit_pr` | `claim.ts:67,188,234,287,361-388` |
| Tool envelopes `{ tasks }`, top-level brief, `clone`/`lease`/`task`/`token`, `{ task, lease }`, `{ task }`, `{ task, pr_url, summary }` `待验收` | `mcp.ts:76,85,120`; `claim.ts:173-185,224-230,278-284,350-358` |
| Business errors `isError` + REST body, HTTP 200 | `mcp.ts:42-48`; `mcp.test.ts:760,683-691` |
| `submissions` DDL columns; insert `pr_state` `'open'` | `db.ts:98-107`; `claim.ts:334-342`; `schema.ts:104-111` |
| Dual reveal; session GET never token; no PR polling; no web claim UI | `claim.ts:178`; `mcp.ts:120`; `tasks.ts` GET; `App.vue` no claim UI |
| Root test script includes `mcp.test.ts`; `test(` count 18 | `package.json:13`; `mcp.test.ts` 18 `test(` |
| #9 bullet: short clause — as of #9 claim `201` was the HTTP reveal; #10 also MCP `claim_task` | user instruction; `claim.ts:178`; `mcp.ts:120` |

### CLAUDE.md

| Changed sentence (summary) | Source |
|---|---|
| Snapshot: extracted claim fns; `registerMcp`; six tools; SDK `1.30.0`; `zod` `^4.4.3`; `submissions`; no REST `submit_pr` | `claim.ts:67+`; `mcp.ts:227,91-159`; `apps/server/package.json:20,24`; `db.ts:98-107` |
| Dual reveal: REST claim `201` `token` and MCP `claim_task` `token` | `claim.ts:178`; `mcp.ts:120` |
| Dropped “MCP is not implemented” | `mcp.ts` exists |
| Commands Test: append `apps/server/src/mcp.test.ts` after `claim.test.ts` | `package.json:13` |
| Conventions: reveal via REST claim **and** MCP `claim_task` | `claim.ts:178`; `mcp.ts:120` |

### docs/api.md

| Changed sentence (summary) | Source |
|---|---|
| Lede: six MCP tools implemented; no REST `submit_pr`; dual reveal | `mcp.ts`; `claim.ts:361-388` |
| Sources include `mcp.ts` | `apps/server/src/mcp.ts` |
| whoami hook also used by MCP plugin | `mcp.ts:229`; `agent-bearer.ts:38` |
| Claim `201` `token` is one of two reveal channels | `claim.ts:178`; `mcp.ts:120` |
| `POST /api/mcp` Streamable HTTP; 401-before-JSON-RPC; GET/DELETE 405; session 400/404 JSON-RPC; six-tool table; `sweepExpiredLeases`; `registerMcp` after `registerClaim` | `mcp.ts:164-243,58-86,91-159`; `app.ts:52-53`; `mcp.test.ts:36,712` |
| `submissions` DDL + drizzle maps; `pr_state` `'open'` | `db.ts:98-107`; `schema.ts:104-111`; `claim.ts:340` |
| Events: MCP `submit_pr` `状态迁移` `{ task_id, from, to, pr_url, summary }` | `claim.ts:344-348` |
| Vault reveal dual channel; `vault_unconfigured` via same `claimTask` (MCP `isError`, HTTP 200) | `claim.ts:136-137`; `mcp.ts:42-48,120` |
| Server deps: `@modelcontextprotocol/sdk` `1.30.0`, `zod` `^4.4.3`; dropped “No MCP SDK” | `apps/server/package.json:20,24` |

### docs/architecture.md

| Changed sentence (summary) | Source |
|---|---|
| Tree: `POST /api/mcp`; GET/DELETE 405; `submissions`; dual reveal; MCP implemented | `mcp.ts:238-242`; `db.ts:98-120`; `apps/server/package.json:20` |
| `createDb` execs `submissions` after leases index; drizzle schema includes `submissions` | `db.ts:116-120` |
| Bearer hook used by whoami, claim, and MCP | `mcp.ts:229`; `claim.ts:363`; `agent-keys.ts` whoami |
| `registerMcp` after `registerClaim` before hosting; sweep on MCP list/get/mutating; SDK + zod | `app.ts:51-53`; `mcp.ts:62,80`; `claim.ts:81,197,240,298`; `apps/server/package.json:20,24` |

---

## Explicit non-claims

| Not claimed | Why |
|---|---|
| Full `pnpm test` / lint / typecheck / build totals | This role did not run those gates; only counted `test(` in `mcp.test.ts` (18) |
| GET/DELETE `/api/mcp` covered by the 18 tests | Implemented in `mcp.ts:241-242`; suite does not assert 405 (`tests-mcp.md`) |
| REST `POST …/submit_pr` | `registerClaim` has claim/progress/release only (`claim.ts:361-388`) |
| PR polling / webhook / `getPullRequest` / 待验收→已完成\|已退回 | No writers in `apps/server/src` |
| Web claim UI / events HTTP | Board still one synthetic 发布 (`architecture.md` web; `App.vue`) |
| `pr_state` enum beyond `'open'` | Drizzle `text('pr_state').notNull()` with no enum (`schema.ts:110`); insert uses `'open'` |
| Claude Code live MCP JSON config | Not in source; README only says Agent configures `POST {origin}/api/mcp` with Bearer |
| `docs/DESIGN.md` changed | File not in `git diff` |
| `scripts/codemaps/` or `docs/CODEMAPS/` | Do not exist; not invented |
| `mcp.test.ts` edited | This role did not write tests |

---

## Measured signatures (verbatim)

`registerMcp` (`apps/server/src/mcp.ts:227`):

```ts
export function registerMcp(app: FastifyInstance, db: AppDb) {
```

`CLONE_TOKEN_USAGE` (`apps/server/src/claim.ts:26-27`):

```ts
export const CLONE_TOKEN_USAGE =
  'token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。'
```

`SUBMISSIONS_DDL` (`apps/server/src/db.ts:98-106`):

```sql
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  lease_id INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  summary TEXT NOT NULL,
  pr_state TEXT NOT NULL
)
```

`mcp.test.ts` `test(` occurrences (18): 797, 805, 830, 842, 869, 891, 973, 999, 1018, 1042, 1059, 1083, 1130, 1169, 1226, 1254, 1272, 1333.
