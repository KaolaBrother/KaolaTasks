# DESIGN.md pin — issue #23

**File:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23/docs/DESIGN.md`  
**Against:** architecture.md + architecture-corrections.md (names/paths win) + orchestrator-rulings.md + ground-truth comments (claimants ≠ web; first-full bootstrap; device pending 1 day; no ktk in mcp.json).

## Changed

- **Header / D8:** identity is device proof + named claimants; GitLab/Gitea auto-full + GitHub 待批准 queue dropped as product rule.
- **§3:** 认领者 = no Web login; publishers/admins = OAuth `users` `full`; admin bind-to-self for smoke only.
- **§7:** two credentials (Ed25519 under `~/.kaola/`, never mcp.json / never forge PAT; forge token still only claim `201` / `claim_task` success `token`). Removed teaching `ktk_…` / `KAOLA_AGENT_KEY` in mcp.json. Committed example is `command` `kaola-mcp` + `--url`. Unpaired valid sig → `202` `{ error: 'authorization_required', pending: true, expires_at }` ≠ #16 `confirmation_required`. Revoke person/device next request.
- **§9:** six tools unchanged; auth = stdio device proof not Agent Key Bearer; pending cannot list/claim; success envelope unchanged. Clone four-key sentences left as they were.
- **§10:** `claimants`, `devices`; users `revoked` + policy `device_max_age_days` (30, 1–365)/`max_devices` (5)/`device_idle_days` (0); leases/confirmations keyed by `device_id`; active owner XOR; pending neither.
- **§11:** empty `KAOLA_ADMINS` boots; zero `full`+`active` → first OAuth `active`+`full`; later uninvited does not insert; whitelist → `full`; no provider auto-full; re-login does not revive `revoked`; Agent signed device headers not `ktk_` Bearer; only `full` bind/revoke; bind does not claim/push token.
- **Supporting (no new HTTP paths):** §4 copy (电脑 pane / stdio, not API Key); §12 tree adds `apps/mcp`.

## Skipped (later mission)

README, `docs/api.md`, CHANGELOG, smoke-test, production code. Did not list device admin routes. Did not reopen #22 (clone keys / two reveal channels / two-task tokens).
