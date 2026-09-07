# Documentation docking — bundle-53 (#53)

Checked against the issue's acceptance items and the project Documentation list (AGENTS.md):

- README.md — entry flow, Draft PR, review loop, sub-tasks, tool table: docked.
- docs/DESIGN.md — source of truth changed first (commit 38d5035), reconciled after code review (4875bd7): docked.
- docs/architecture.md — docked.
- docs/api.md — every new tool / route has an error-code entry (issue phase 0 acceptance): docked.
- docs/conventions.md — no impact.
- docs/smoke-test.md — real GitLab/Gitea run recorded; 配合 items explicitly not executed: docked.
- docs/workflow-default.md / docs/runner-carrier.md — no impact.
- CHANGELOG.md — docked.

Verification: signatures and field names transcribed from `apps/server/src/review.ts`, `stream.ts`, `claim.ts`, `mcp.ts`, `packages/forge-adapters/src/index.ts`, `packages/shared/src/index.ts`; `pnpm test` at 4875bd7 pins the ten-tool list, the Review Brief keys, the transition table, and the review REST error codes that the docs state.

DOCKED
