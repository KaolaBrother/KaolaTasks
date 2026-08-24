# Orchestrator rulings for #23

Comments win. These are implementation choices so planner / tests / code share one reading. Value calls already made in issue comments.

## Identity

- Web `users` are publishers/admins only (`full`). After the first `full` exists, uninvited OAuth does **not** insert a row (page: 未被邀请). Drop the GitHub `待批准` join-queue for new logins.
- Bootstrap: empty `KAOLA_ADMINS` may boot. Zero `full` rows → that one web OAuth insert is `active`+`full`. Later web logins are not auto-full. If `KAOLA_ADMINS` is set (`provider:username` or `provider:id:<remote_id>`), those identities become `full` on first login even after bootstrap.
- Extra publishers: `KAOLA_ADMINS` only in this issue (no invite table). Do not keep GitLab/Gitea auto-full.
- Claimants are a **new table**, not `permission_level: claim_only` users. They cannot get a session. Admin names them when binding a pending device. Smoke exception: bind a device to the admin `users.id` (full user as claimer) without turning claimants into a web-account model.
- Device owner when `active`: exactly one of `claimant_id` or `user_id`. Pending devices have neither until bind.

## Auth proof

- Product identity for MCP/REST claim is a **device**, not a copy-paste `ktk_` Bearer. Stop teaching mint-a-key-to-claim. Do not require `ktk_` in mcp.json.
- Crypto: Node `ed25519`. Private key stays in `~/.kaola/` mode 0600; server stores public key + fingerprint only.
- Each MCP/REST agent request: signed timestamp (reject skew and replay). Unpaired/unknown pubkey → create/reuse `devices` `pending` with `pending_expires_at = first_seen + 86400` (do not refresh on retry). HTTP **202** `{ error: 'authorization_required', pending: true, expires_at }` — no forge token, no lease. Distinct from #16 `{ error: 'confirmation_required' }`.
- Pending device cannot list or claim. Approve does not auto-claim and does not push a forge token.
- Revoke claimant or `users.status` off `active` → all their devices fail next request. Re-login must not revive a revoked identity.
- `device_max_age_days` default 30, min 1 max 365, no permanent. Hard expiry from `paired_at`, not idle-extended. `max_devices` default 5. `device_idle_days` default 0 (off).

## Keep

- #22: two-task different forge tokens; clone four keys; two reveal channels only (claim 201 / claim_task success).
- Committed MCP example has no secrets. It may show `command` + Kaola URL for the stdio bridge; still no token.
- #16 autonomous confirmation stays, retargeted off `agent_key_id` onto `device_id`.
- Server MCP remains Streamable HTTP `POST /api/mcp`. Stdio bridge is a **thin local client** that signs and forwards. New app under `apps/` (workspace already globs `apps/*`).

## Out of scope

- Do not reopen #22.
- Do not add MCP OAuth (withdrawn B).
- Do not invent a local password admin.
- Do not execute git on the server.
