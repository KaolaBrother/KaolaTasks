# Architecture overlay — real repo names (orchestrator)

Planner file mixed some foreign identifiers. Implementers and tests MUST use the worktree as it exists.

## Paths

- Server: `apps/server/src/` (`schema.ts`, `db.ts`, `auth.ts`, `claim.ts`, `mcp.ts`, `agent-bearer.ts`, `agent-keys.ts`, `app.ts`)
- Web: `apps/web/src/App.vue` (not App.vue)
- Shared: `packages/shared` (`@kaola/shared`)
- New stdio app: `apps/mcp`, bin `kaola-mcp`
- Device canonical helpers: `packages/shared` or `apps/server/src` + `apps/mcp` duplicate-free; prefer `packages/shared` if both need it

## Names that already exist (do not rename)

- Agent key prefix `ktk_`, env `KAOLA_AGENT_KEY` (stop teaching; do not invent `ktk_` / `KAOLA_AGENT_KEY`)
- MCP `POST /api/mcp`; tools `list_tasks` / `get_task_brief` / `claim_task` / `report_progress` / `submit_pr` / `release_task`
- REST claim `POST /api/v1/tasks/:publicId/claim`
- #16 error `confirmation_required` (not `confirmation_required`)
- Device wait HTTP 202 `{ error: 'authorization_required', pending: true, expires_at }` (ISO). Distinct string from #16.
- User `status`: `active` | `待批准`; add `revoked`. Permission `full` | `claim_only`
- `trusted_automation` (not `trusted_automation`)
- Audit types stay Chinese: `token 揭示`, `状态迁移`
- Clone four keys (tests are oracle, do not change): `extra_header`, `remote_url`, `suggested_dir`, `token_usage`. `extra_header` is `{ name, value_pattern }` with literal `${token}` — never embed the forge token. `CLONE_TOKEN_USAGE` exact sentence in `claim.ts`.

## Env

- `KAOLA_ADMINS` optional (`provider:username` or `provider:id:<remote_id>`), comma/whitespace separated. Empty/unset still boots.

## Filesystem

- `~/.kaola/` directory `0700`; key file `~/.kaola/device` (or `device.json` inside) `0600`. Override `KAOLA_HOME` for tests.

## Open questions — decided

1. Claimant-owned devices skip #16 (no workbench). Bind-to-self still uses `trusted_automation`.
2. Stats envelope unchanged; claimant completions stay under `系统`.
3. No invite table. Leftover `待批准` / `claim_only` rows: no new inserts; leftover pending card may remain.
