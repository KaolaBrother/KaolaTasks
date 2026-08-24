# Docs dock — issue #23 (device proof / 电脑)

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`  
Date: 2026-08-24  
Role: doc-updater. Transcribed **implemented** behavior only. No invented routes.

## Detection

- `scripts/codemaps/` — **absent**
- `docs/CODEMAPS/` — **absent**
- Codemaps: **skipped** (do not invent that tree)

## Commands run

- Read oracles: `apps/server/src/auth.ts`, `devices.ts`, `device-proof.ts`, `mcp.ts`, `claim.ts`, `apps/mcp/src/main.ts`, `apps/mcp/examples/mcp.json`, `apps/web/src/App.vue` (电脑 pane), `docs/DESIGN.md`, `docs/api.md`, `README.md`, `docs/smoke-test.md`, `CHANGELOG.md`, `docs/architecture.md`, `CLAUDE.md`, root `package.json` `test` script, `apps/server/src/db.ts`, `apps/server/src/app.ts`
- `Grep` / `Read` against those files for header names, JSON keys, routes, UI copy
- `python3` identifier counts on `docs/api.md` (no-op when already aligned)
- `mkdir -p kaola-workflow/issue-23/.cache`
- Did **not** run `pnpm test` / lint / build (documentation-only pass)

## Oracles quoted (code)

Device-proof headers (bridge `apps/mcp/src/main.ts`; Fastify reads lowercased): `X-Kaola-Key`, `X-Kaola-Ts`, `X-Kaola-Nonce`, `X-Kaola-Sig`, optional `X-Kaola-Hostname`.  
`WWW-Authenticate: Kaola-Device`.  
`401` `{ error: 'unauthorized' }`.  
`202` `{ error: 'authorization_required', pending: true, expires_at }` (ISO). Pending window `86400`.  
`403` `{ error: 'forbidden' }` or `{ error: 'device_expired' }`.  
Hook export: `addDeviceProofHook`.

stdio: bin `kaola-mcp`; `--url` or `KAOLA_URL`; default origin `http://localhost:31415`; `POST {origin}/api/mcp`; identity `~/.kaola/device.json` (`KAOLA_HOME`). Example `apps/mcp/examples/mcp.json`: `command` `kaola-mcp`, `args` `["--url", "http://localhost:31415"]` only.

MCP tools (`mcp.ts`): `list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `release_task`, `submit_pr`. GET/DELETE `/api/mcp` `405`.

Devices (`devices.ts`, session `active`+`full`):  
`GET /api/v1/devices/pending` `{ devices: [{ id, hostname, fingerprint, created_at, expires_at }] }`  
`GET /api/v1/devices`, `GET /api/v1/me/devices`  
`POST /api/v1/devices/:id/bind` exactly one of `bind_to_self: true` | `claimant_id` | `claimant_display_name`  
`POST /api/v1/devices/:id/revoke`  
`GET /api/v1/claimants`; `POST /api/v1/claimants/:id/revoke`; `PATCH /api/v1/claimants/:id/settings` (`device_max_age_days`, `max_devices`, `device_idle_days`)  
`GET /api/v1/agent/whoami` (device proof) `{ device_id, fingerprint, hostname, status: 'active', owner }`  
409 Chinese: `电脑申请已过期或不在待授权状态。` / `已达该身份的电脑台数上限。`  
Audit types: `电脑授权`, `电脑解除`, `认领者解除`.

Auth (`auth.ts`): empty `KAOLA_ADMINS` still boots. Entries `github:username` or `github:id:<remote_id>` (gitlab/gitea same). Bootstrap `countActiveFull === 0` → insert `active`+`full`. Else only admin match; else `/login?reason=uninvited` (no row, no session). Existing `revoked` → `/login?reason=revoked`. GitLab/Gitea are **not** auto-full after a full user exists.

Claim `201` keys: `task`, `token`, `lease`, `clone`. Clone four keys: `suggested_dir`, `token_usage`, `remote_url`, `extra_header` `{ name, value_pattern }`. Leftover `ktk_` Agent Key HTTP remains but is **not** MCP/claim identity.

Web (`App.vue`): nav label **电脑** (pane id still `'keys'`); **待授权电脑**; **绑到我自己**; **认领者**; bind body `{ bind_to_self: true }`.

Root `package.json` `test` already includes `apps/server/src/devices.test.ts` and `apps/mcp/src/main.test.ts`.

## Files updated (what each change reconciled)

### `README.md`

Reconciled against `auth.ts` bootstrap/closed join, `apps/mcp/examples/mcp.json`, `main.ts` headers/`--url`/`KAOLA_URL`/`~/.kaola/device.json`, `mcp.ts` tool names, `claim.ts` `201`/`clone` four keys + `CLONE_TOKEN_USAGE`, `device-proof.ts` `202` JSON, `devices.ts` bind keys, `App.vue` 电脑 copy.

- MCP example = `kaola-mcp --url …` only (no `ktk_`, no forge token)
- Claimants do not mint Agent Keys
- First web OAuth bootstrap; `KAOLA_ADMINS` optional
- Device-proof headers and `202` `authorization_required` quoted from code
- UI terms: **电脑**, **待授权电脑**, **绑到我自己**, **认领者**

### `docs/api.md`

Already contained device-proof headers, `202` `authorization_required`, bind/pending/whoami, closed join, leftover `ktk_` not identity, claim `201` `token` + clone four keys `suggested_dir` / `token_usage` / `remote_url` / `extra_header` (`value_pattern`). Identifier pass confirmed match to oracles (`addDeviceProofHook`, bind 409 strings, `device_idle_days`). No new routes invented.

### `docs/smoke-test.md`

Replaced “generate Agent Key to claim” / “#23 未落地 / POST still 401” with implemented path:

1. First OAuth → admin (`active`+`full`)
2. Agent MCP once (`kaola-mcp --url`) → `202` pending
3. **电脑** → **待授权电脑** → **绑到我自己**
4. Retry claim for forge `token`

Live table: #10 still **取消**; #11 notes code landed (`202` not `ktk_`); #12–#18 still 未做 (no fake live smoke). Duplicate 认领怎么走 block removed.

### `CHANGELOG.md`

Unreleased `#23` bullet: headers, `202` keys, bind/pending/whoami routes, closed join, leftover `ktk_`, web 电脑 copy, clone four-key pin, test files.

### `docs/architecture.md`

Reconciled against `app.ts` (`registerDevices` after `registerClaim`), `db.ts` (`claimants`/`devices` DDL + drizzle schema keys), `device-proof.ts` (not Agent Key Bearer), `auth.ts` (no GitLab auto-full), `App.vue` nav **电脑**.

- Tree includes `apps/mcp`
- ASCII: device-proof whoami/bind/pending; claim/MCP `202` `authorization_required`
- Poller child plugin: device-proof context (not bearer)
- Nav 看板/发布/电脑/审计; 受信自动化 gated like 电脑 pane (not Agent Key widget)

### `CLAUDE.md`

Test script list now includes `apps/server/src/devices.test.ts` and `apps/mcp/src/main.test.ts` (matches root `package.json` `test`).

## Skipped (with reason)

- **`docs/DESIGN.md` clone four-key names** — already `extra_header` / `value_pattern` (#22 pin). Left unchanged.
- **`docs/DESIGN.md` mcp.json identity** — already `kaola-mcp` + `--url`, no `ktk_` in the example. `ktk_` remains only as “not Bearer identity”. Left unchanged.
- **`docs/CODEMAPS/*` / `scripts/codemaps/`** — tooling absent; not invented.
- **`docs/README.md`, `docs/conventions.md`, `.env.example`** — no HTTP/install contract change beyond surfaces above; no extra invented sections.
- **Leftover `POST/GET/DELETE /api/v1/agent-keys`** — still in code; docs keep it as leftover, not MCP identity. Not removed from api.md.
- **Did not invent** REST `submit_pr`, webhook UI, or a third token-reveal channel.

## Result landing

Edits are in the issue-23 worktree under:

- `README.md`
- `docs/api.md` (verified; no further route invention)
- `docs/smoke-test.md`
- `CHANGELOG.md`
- `docs/architecture.md`
- `CLAUDE.md`

This record: `kaola-workflow/issue-23/.cache/docs-dock.md`

## Verdict
DOCKED
