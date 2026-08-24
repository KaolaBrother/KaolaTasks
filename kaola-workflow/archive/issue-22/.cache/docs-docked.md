# Docs docking — issue-22

Changed files reviewed: `README.md`, `docs/DESIGN.md` §7, `docs/api.md` claim envelope / `claim_task` row, `CHANGELOG.md` Unreleased `#22`, `apps/server/src/claim.test.ts`, `apps/server/src/mcp.test.ts`.

Documents checked: README「Agent 怎么接单」, DESIGN §7, api.md claim + MCP table, CHANGELOG Unreleased. CLAUDE.md Commands: no HTTP/script change — no-impact. `docs/smoke-test.md`: reference only, already on `2ce443a`, not edited.

Gaps found and fixed: committed MCP example had Agent Key placeholder; replaced with URL-only. User-model sentences (MCP 平时无仓库钥匙 / claim 成功才有该任务 token / 换任务换 token) added to README, DESIGN §7, api.md. CHANGELOG `#22` recorded.

No-impact: production `claim.ts` / `mcp.ts` unchanged (per-task decrypt already correct). No new routes. No env var required at boot (`KAOLA_AGENT_KEY` is client-side).

Verdict: DOCKED
