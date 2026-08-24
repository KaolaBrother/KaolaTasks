# Finalization — Summary: issue-22

## Delivered
Issue #22 user model is pinned and documented: MCP config has no repo token; REST claim `201` / MCP `claim_task` success returns **that** task's forge `token` plus four-key `clone`; a second `publicId`/`task_id` returns that other task's token. Production decrypt was already per-row; this run added the two-task tests and docked README / DESIGN §7 / api.md / CHANGELOG. Committed `mcpServers` example is URL-only. Reveal channels unchanged.

## Files Changed
- `apps/server/src/claim.test.ts` — REST two-`publicId` token pin
- `apps/server/src/mcp.test.ts` — MCP two-`task_id` token pin
- `README.md` — URL-only MCP snippet; `KAOLA_AGENT_KEY` env inject; user model
- `docs/DESIGN.md` — §7 user-model bullet
- `docs/api.md` — claim envelope / `claim_task` user-model sentences
- `CHANGELOG.md` — Unreleased `#22`

## Test Coverage
`claiming a second publicId returns that task's token, not the first task's`; `claim_task on a second task_id returns that task's token, not the first task's`. Existing envelope / clone / `202` / list-brief hygiene tests unchanged and still green.

## Validation
verdict: pass
command: `pnpm lint && pnpm typecheck && pnpm test`
validated_candidate_hash: `f2e14f4b02fcf0adeaf9823cc736029f951a964d1693c505edabeef6dc58eb67`
Reuse boundary: `pnpm lint` (eslint `.` exit 0), `pnpm typecheck` (4 packages), `pnpm test` (node `--test` ℹ tests 547 / pass 547 / fail 0; vitest 5 files / 95 tests) were run on this worktree after the test and doc edits. CHANGELOG `#22` bullet is documentation-only after those runs.

## Changed Paths
README.md
apps/server/src/claim.test.ts
apps/server/src/mcp.test.ts
docs/DESIGN.md
docs/api.md
CHANGELOG.md

## Mission List
Four items, all `done`: measure; two-task tests; no production code gap; doc docking including CHANGELOG.

## Documentation Docking
DOCKED — see `.cache/docs-docked.md`. `docs/smoke-test.md` not edited (reference; already on `2ce443a`).

## Run gaps

## Follow-Up Items
None. Optional local mcp.json writer from issue B (“可以做”) was not in the acceptance checkboxes and was not built.

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-22/.cache/doc-updater.md
- kaola-workflow/archive/issue-22/.cache/docs-docked.md
- kaola-workflow/archive/issue-22/.cache/final-validation.md
- kaola-workflow/archive/issue-22/.cache/ground-truth.md
- kaola-workflow/archive/issue-22/.cache/origin/selection-record.json
- kaola-workflow/archive/issue-22/.cache/run-gaps.json
- kaola-workflow/archive/issue-22/.cache/tests-22.md
- kaola-workflow/archive/issue-22/finalization-summary.md
- kaola-workflow/archive/issue-22/mission-list.md
- kaola-workflow/archive/issue-22/workflow-state.md
