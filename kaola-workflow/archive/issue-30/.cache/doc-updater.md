# Documentation update review

Verdict: DOCKED

- `docs/DESIGN.md`: updated to v0.4 and added §15 as the governing product boundary and ordered delivery map.
- `docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md`: added the complete accepted decision, recovery/security contract, acceptance contract, and six child Issues.
- GitHub Issue #30: updated from the same ADR bytes and verified exact.
- `README.md`: no impact; this run changes no installed behavior, setup, command, or user workflow.
- `docs/api.md`: no impact; additive MCP/REST fields are planned in #36 and #31, not implemented in this run.
- `docs/architecture.md`: no impact; this run freezes a future compatibility boundary and explicitly introduces no runtime component.
- `docs/smoke-test.md`: no impact; no new runtime path exists to smoke yet.
- `CHANGELOG.md`: no impact; no product behavior shipped.
- `AGENTS.md` and `CLAUDE.md`: no impact; current minimal project facts and global Workflow contract already govern the design.

No documentation claims implementation or live-provider UAT.
