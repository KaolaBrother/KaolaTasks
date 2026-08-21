# Documentation docking — issue #9

Verdict: DOCKED

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9` after docs + measured CHANGELOG line.

## Changed files reviewed

Production: `apps/server/src/claim.ts`, `leases.ts`, `agent-bearer.ts`, `agent-keys.ts`, `app.ts`, `db.ts`, `schema.ts`, `tasks.ts`, `vault.ts`, `claim.test.ts`, root `package.json`.

Docs: `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/api.md`, `docs/architecture.md`. `docs/DESIGN.md` unchanged. `docs/conventions.md` already says tokens never appear in logs or non-claim API responses — still true.

## Documents checked

| Doc | Status |
|-----|--------|
| README.md | #9 REST claim in 已落地; 尚未实现 drops 租约/揭示; MCP still unimplemented |
| CHANGELOG.md | #9 Unreleased bullet with routes, envelope keys, leases DDL, events, measured 279/279 + vitest 44 |
| CLAUDE.md | Snapshot + Commands test list include claim.test.ts; conventions reveal via Bearer POST claim |
| docs/api.md | Three Bearer routes, leases table, claim-shaped events, only claim 201 returns forge token |
| docs/architecture.md | Tree lists claim/progress/release, leases + unique index, sweep on GET |
| docs/DESIGN.md | No-impact: REST paths implement §9 mirror; no contract edit |
| .env.example | No-impact: no new env vars |
| Issue #9 comments | Clone guidance lives on REST claim 201 `clone`; MCP tool description remains #10 |

## Gaps found and fixed

CHANGELOG #9 had "see later validation"; replaced with measured 2026-08-21 lint/typecheck/test/build counts after this run's gates.

## No-impact reasons

- Web / events HTTP: #9 acceptance is server-side; board still one synthetic 发布 (#8).
- MCP: still unimplemented (#10).
- `submit_pr` / PR polling: #11.
- Per-task TTL column: DESIGN §6 has no field; default 86400 only.

## Issue acceptance mapping

| Criterion | Evidence |
|-----------|----------|
| 过期未心跳的任务自动回到待认领 | `sweepExpiredLeases` on session GET and Bearer write; claim.test.ts expiry describe |
| list_tasks / get_task_brief 永不含 token | session GET list/one; tests pin never-token after claim |
| 每次揭示均有审计记录 | claim `token 揭示` for inline and profile |
| 待批准 claim 拒且不揭示 | 403 + no decrypt; pending test |
| 认领即授权 | Bearer API key, no confirm |
| 克隆指引 | `clone.suggested_dir` + exact `token_usage` |
