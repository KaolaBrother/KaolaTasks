# Previous Codex UAT reference

Verified by reading Codex thread `01a07c55-3885-7351-a52a-3aa9ed053485`, exact title `0907｜功能｜Linux VPS UAT`.

User clarified this time's delta is **Private CA**, not Privacy AI. Extend prior smoke mechanism; do not redesign unrelated workflow.

Relevant sequence: user requested local server to finish UAT and cleanup of external VPS. Earlier assistant incorrectly stopped for manual approval/OAuth/confirmation. User then explicitly explained tokens/keys were in .env so Agent should finish automatically. Later completed report records real OAuth, browser binding, independent Linux claimant flow, termination confirmation/reopen/writeback finished, then full Workflow finalization. That earlier manual stop is superseded, not a pattern to copy.

Reusable baseline: local isolated Linux service and separate Linux claimant, real GitLab/Gitea forge, production MCP, claim recovery/fencing, eight states/ten tools, multiple review rounds, unreported-head rejection, dependency/restack, SSE, terminate/reopen, merge and writebacks. Inspect existing docs/smoke-test.md local continuation section and `.kw/local-receipts/uat-20260907/` helpers read-only if still present. Prior containers were stopped/cleaned; verify current state before reuse, preserve old evidence and DB. Historical PASS is not this run's evidence.

This run's change: replace manual trust-install/old bind startup with clean Linux claimant automatic Private CA pairing, approved trust handoff, strict TLS, and restoration/rotation negative cases; carry the same production MCP task delivery all the way through. All steps Agent-operated under current explicit authorization, including Computer Use as needed. Write durable project AGENTS.md guidance and update smoke design. No secret contents in documentation.
