# Documentation docking — issue #10

Verdict: DOCKED

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10` after docs. Proof: `kaola-workflow/issue-10/.cache/doc-updater.md`.

## Changed files reviewed

Production (read, not edited this role): `apps/server/src/mcp.ts`, `claim.ts`, `app.ts`, `db.ts`, `schema.ts`, `mcp.test.ts`, `apps/server/package.json`, root `package.json`.

Docs: `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/api.md`, `docs/architecture.md`. `docs/DESIGN.md` unchanged. `docs/conventions.md` already says tokens never appear in logs or non-claim API responses — still true (MCP `claim_task` is a claim reveal).

## Documents checked

| Doc | Status |
|-----|--------|
| README.md | #10 MCP in 已落地; Agent `POST {origin}/api/mcp` Bearer; 尚未实现 is webhook/轮询 only |
| CHANGELOG.md | #10 Unreleased bullet at top; #9 “only HTTP token” clause clarified; no new full `pnpm test` totals |
| CLAUDE.md | Snapshot MCP implemented; Commands test list includes `mcp.test.ts`; 124 lines |
| docs/api.md | `POST /api/mcp`, six tools, `submissions` table, dual reveal, sources include `mcp.ts` |
| docs/architecture.md | Tree lists `/api/mcp` + `submissions`; `registerMcp` after `registerClaim`; SDK `1.30.0` |
| docs/DESIGN.md | No-impact: contracts not edited |
| .env.example | No-impact: no new env vars |
| Issue #10 comments | `claim_task` description includes `CLONE_TOKEN_USAGE`; `submit_pr` → 待验收 |

## Gaps found and fixed

Living docs still said MCP was unimplemented (#9-era). Transcribed `registerMcp`, six tools, dual token reveal, `submissions` DDL, SDK `1.30.0`, root `"test"` includes `mcp.test.ts`.

#9 Unreleased bullet present-tense “only HTTP that returns a forge token is claim 201” clarified with a short #10 clause.

## No-impact reasons

- Web / events HTTP: board still one synthetic 发布 (#8).
- REST `submit_pr`: not added; MCP-only (`submitPr`).
- PR polling / webhook: #11 / M2.
- GET/DELETE `/api/mcp` 405: implemented, not in the 18-test suite — documented from `mcp.ts`, not from tests.
- `scripts/codemaps/` / `docs/CODEMAPS/`: do not exist; not invented.

## Issue acceptance mapping

| Criterion | Evidence |
|-----------|----------|
| Official MCP TS SDK, in-process | `@modelcontextprotocol/sdk` `1.30.0`; `registerMcp` in `buildApp` |
| Six tools | `registerTool` names in `mcp.ts`; `tools/list` test |
| API Key auth; unauth rejected | `addAgentBearerHook`; HTTP 401 + `WWW-Authenticate: Bearer` before JSON-RPC |
| `claim_task` description token hygiene | description includes `CLONE_TOKEN_USAGE` |
| `submit_pr` → 待验收 | `submitPr` + `submissions.pr_state` `'open'` |
| `list_tasks` / `get_task_brief` never token | tool payloads + tests |
| Dual reveal: REST claim 201 **and** MCP `claim_task` | `claim.ts` + `mcp.ts` |
| No REST `submit_pr`; no PR polling; no web claim UI | `registerClaim` routes; no polling; #8 board |
