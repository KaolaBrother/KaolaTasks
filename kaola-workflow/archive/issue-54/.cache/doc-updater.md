# doc-updater — issue-54

Checked files and outcome (transcribed from the real code / responses in the worktree, nothing invented):

- `docs/DESIGN.md` — FIXED: v0.7 header; §9 `submit_revision` note; §10 submissions/events rows; §17.2 route table (`GET …/review` shape, approve 409 + `{ task, round, head_sha, head_verified }`), 评审通过 details; §17.5 write points; §17.6 invariant; new §17.7 评审锚定核对 incl. forge-consistency note (GitLab MR `sha` refresh lag).
- `docs/api.md` — FIXED: review intro short fields; `GET …/review` #54 paragraph (`forge_head_sha`, `forge_head_seen_at`, `head_stale`); approve #54 head check + in-transaction re-check (409 `illegal_transition`); SSE `task_updated` note; PR polling #54 sentence; submissions #54 columns; events bullet.
- `docs/smoke-test.md` — FIXED: step 12b (drift leg), step 13 wording, run-record row for the #54 script on GitLab (Issue #23 → MR !19, earlier #22/!18 and first attempt #21/!17 noted) and Gitea (Issue #36 → PR #37, earlier #34/#35 and #32/#33 noted), #54 配合/forge-lag paragraph.
- `docs/architecture.md` — FIXED: poller line (records observed forge head every tick), submissions columns line, review routes line (approve live head read).
- `README.md` — FIXED: `submit_revision` row tells the Agent that 「通过」 verifies the forge head; no other README section describes head handling.
- `CHANGELOG.md` — FIXED: `#54` bullet under Unreleased.
- `docs/conventions.md` — NO IMPACT: coding/testing/git conventions unchanged.
- `docs/workflow-default.md`, `docs/runner-carrier.md` — NO IMPACT: client-side Workflow / Runner guidance does not describe the approve path.
- `apps/mcp/examples/*`, `.env.example` — NO IMPACT: no new env var, no MCP schema change (Review Brief unchanged).
