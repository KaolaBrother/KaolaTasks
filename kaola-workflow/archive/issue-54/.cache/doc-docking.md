# doc-docking — issue-54

status: DOCKED

Public behaviour changed: `GET /api/v1/tasks/:publicId/review` (+3 fields), `POST …/review/approve` (live head check, `409 head_sha_stale`, `head_verified`, in-transaction re-check), `submissions` schema (+2 nullable columns), `评审通过` event details, poller SSE `task_updated` on forge-head change, `submit_revision` observation reset, Web review panel notice, forge smoke drift leg.

Each is documented in `docs/DESIGN.md` (contract, §17.7), `docs/api.md` (wire), `docs/architecture.md` (overview), `docs/smoke-test.md` (real-forge evidence), `README.md` (Agent-facing note), `CHANGELOG.md` (Unreleased). No setup / environment / MCP-schema change, so `.env.example` and MCP examples need nothing. See `doc-updater.md` for the per-file list.
