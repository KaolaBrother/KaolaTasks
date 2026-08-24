# Implementation Plan: Issue #23 — Device proof + claimant identity

## Overview

Replace copy-paste `ktk_` Bearer as the MCP/REST claim identity with a per-machine Ed25519 device. Unpaired valid signatures become HTTP `202` `{ error: 'authorization_required', pending: true, expires_at }` (never `401` for “unknown device”, never a forge token). An admin (`full`) binds that pending row to a **claimant** (new table, no web login) or to **self** (smoke). Web publishers stay OAuth `users` with `permission_level: 'full'`. Server MCP remains Streamable HTTP `POST /api/mcp`; a new `apps/mcp` stdio binary (`kaola-mcp`) signs and forwards. `#22` clone four keys, two reveal channels, and two-task different forge tokens do not change.

Comments win: `5390219462` (admin bootstrap + claimants ≠ web accounts), `5390135367` (MCP-first pending, 1-day window, no 10-minute pairing code), `5390094441` (Ed25519, hard expiry, per-person policy — minus the withdrawn pairing code). Orchestrator rulings at `kaola-workflow/issue-23/.cache/orchestrator-rulings.md`.

## Requirements

- Claim identity is a **device** bound to exactly one owner: `claimant_id` XOR `user_id` when `active`; pending has neither.
- MCP/REST proof is a per-request Ed25519 signature. Product does not teach `ktk_` in mcp.json.
- Unpaired/unknown pubkey with a valid signature → HTTP `202` `authorization_required`, distinct from #16 `confirmation_required`.
- Admin-only bind / revoke person / revoke device / set max age (new pairings only).
- First web OAuth when zero `full` rows → `active`+`full`. Later uninvited OAuth does not insert. `KAOLA_ADMINS` optional. GitLab/Gitea no longer auto-full. Re-login does not revive `revoked`.
- Stdio bridge under `apps/`, bin `kaola-mcp`, `~/.kaola/` mode `0700`/`0600`, talks to existing `POST /api/mcp`.
- Web: 我的电脑 / 待授权电脑 / bind UI; delete generate-key-to-claim copy. Claimants cannot log into the workbench.
- Do not reopen #22. Do not add MCP OAuth. Do not invent a local password admin. Do not execute git on the server.

## Architecture Changes

| Path | Change |
|------|--------|
| `packages/shared/src/device-proof.ts` (new) | Canonical string, skew constant, fingerprint — shared by server verify and `kaola-mcp` sign |
| `apps/server/src/schema.ts` / `db.ts` | `claimants`, `devices`; user policy columns; leases/confirmations gain `device_id` |
| `apps/server/src/device-proof.ts` (new) | Verify headers, replay cache, pending insert/reuse, expire/revoke gates |
| `apps/server/src/agent-bearer.ts` | Stop using on MCP/claim/whoami. Leave file + `ktk_` hash helpers for leftover `agent_keys` CRUD |
| `apps/server/src/auth.ts` | Closed join, first-full bootstrap, optional `KAOLA_ADMINS`, no GitLab/Gitea auto-full, `revoked` |
| `apps/server/src/devices.ts` (new) | Session admin HTTP: pending list, bind, revoke device, revoke claimant, policy PATCH |
| `apps/server/src/claim.ts` / `leases.ts` / `claim-confirmations.ts` / `mcp.ts` | `AgentPrincipal` = device + owner; `device_id` on lease/confirm/audit |
| `apps/server/src/agent-keys.ts` | Keep table + session CRUD (compat). Whoami moves to device hook |
| `apps/server/src/app.ts` | `registerDevices` after `registerClaim`, before `registerMcp` |
| `apps/mcp/` (new workspace app) | `kaola-mcp` stdio → signed Streamable HTTP |
| `apps/web/src/App.vue` | 电脑 pane: 我的电脑 / 待授权电脑 / bind; drop Agent Key mint copy |
| `README.md` / `docs/*` | doc-updater after code; committed MCP example = command + URL, no secrets |

---

## 1. Schema

### Decision: policy columns live on **both** `claimants` and `users`

Comment `5390094441`: 「管理员按人设」`device_max_age_days` / `max_devices` / `device_idle_days`. After `5390219462`, “人” is not `users.permission_level: claim_only`. The owner of an active device is exactly one of:

- a **claimant** (normal path), or
- a **full user** (smoke: bind to self).

Putting the three integers only on `users` would leave claimants without a per-person knob. Putting them only on `claimants` would force a synthetic claimant for the admin, which the orchestrator forbids (“bind a device to the admin `users.id` … without turning claimants into a web-account model”). Pending devices have no owner, so they have no policy until bind; `expires_at` is computed **at bind time** from that owner’s `device_max_age_days`.

Defaults (both tables): `device_max_age_days = 30` (min 1, max 365, no permanent), `max_devices = 5`, `device_idle_days = 0` (off). Changing max age later does **not** rewrite existing `devices.expires_at`.

### `claimants` (new `CREATE TABLE IF NOT EXISTS`)

```sql
CREATE TABLE IF NOT EXISTS claimants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL, -- 'active' | 'revoked'
  device_max_age_days INTEGER NOT NULL DEFAULT 30,
  max_devices INTEGER NOT NULL DEFAULT 5,
  device_idle_days INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
```

`display_name` is **not** unique (admin types a label; bind to existing uses `claimant_id`). No OAuth columns. No password. Rows are created only on bind (`claimant_display_name` that is not an id lookup).

Drizzle: `apps/server/src/schema.ts` export `claimants`, type `Claimant`.

### `devices` (new)

```sql
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,          -- SPKI DER, base64 (standard alphabet)
  hostname TEXT NOT NULL DEFAULT '', -- untrusted; first-seen only; never used to match
  status TEXT NOT NULL,              -- 'pending' | 'active' | 'expired' | 'revoked'
  claimant_id INTEGER,               -- NULL until bind-to-claimant
  user_id INTEGER,                   -- NULL until bind-to-self
  created_at INTEGER NOT NULL,       -- first MCP sighting (unix seconds)
  pending_expires_at INTEGER,        -- first_seen + 86400; not refreshed on retry
  paired_at INTEGER,                 -- set on bind
  expires_at INTEGER,                -- paired_at + owner.device_max_age_days * 86400
  last_seen INTEGER,
  CHECK (
    (status = 'pending' AND claimant_id IS NULL AND user_id IS NULL)
    OR
    (status != 'pending' AND (claimant_id IS NULL) != (user_id IS NULL))
  )
)
```

Owner invariant (application + CHECK):

| `status` | `claimant_id` | `user_id` |
|----------|---------------|-----------|
| `pending` | NULL | NULL |
| `active` / `expired` / `revoked` | exactly one non-NULL | the other NULL |

`fingerprint` = lowercase hex SHA-256 of the **SPKI DER** bytes (same bytes as `public_key` decoded). Unique: one row per pubkey.

Pending reuse (`5390135367`): same fingerprint + still `pending` + `now < pending_expires_at` → reuse row, **do not** bump `pending_expires_at`. After pending timeout (`expired` without ever binding): same pubkey **may** open a new 1-day window (reset that row to `pending`, new `pending_expires_at = now + 86400`, keep `created_at` as original first_seen **or** set `created_at` to this new window — pick **new `created_at` / new window**, same `id`+`fingerprint`, so the admin list shows a fresh 申请时间). After `active` then hard-expire / idle-expire: pubkey is **dead**; do not re-pending it; bridge must mint a new keypair (`5390094441` 旧公钥作废). `revoked` device: do not re-pending that fingerprint (admin kicked this machine).

### `users` additive columns (ALTER + duplicate-column swallow, same pattern as `trusted_automation` in `db.ts:31-42`)

```sql
ALTER TABLE users ADD COLUMN device_max_age_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE users ADD COLUMN max_devices INTEGER NOT NULL DEFAULT 5;
ALTER TABLE users ADD COLUMN device_idle_days INTEGER NOT NULL DEFAULT 0;
```

`status` union becomes `'active' | '待批准' | 'revoked'`. Keep `'待批准'` in the type for leftover rows; **new OAuth never inserts it**. `permission_level` stays `'full' | 'claim_only'` in the schema; **new OAuth always writes `'full'`**. Do not drop `claim_only` (irreversible). Do not add an invite table (out of scope; extra publishers = `KAOLA_ADMINS` only).

### `leases` / `claim_confirmations` → `device_id`

Fresh `CREATE TABLE IF NOT EXISTS` DDL (what `:memory:` tests get):

```sql
-- leases: drop NOT NULL on claimer_user_id; add nullable claimer_claimant_id; add NOT NULL device_id;
-- agent_key_id becomes nullable and unused by new writes
CREATE TABLE IF NOT EXISTS leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  claimer_user_id INTEGER,          -- set iff owner is a user
  claimer_claimant_id INTEGER,      -- set iff owner is a claimant
  device_id INTEGER NOT NULL,       -- claiming device (audit); holder check is owner, not this id
  agent_key_id INTEGER,             -- leftover; new inserts write NULL
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,         -- only the bind-to-self / web-user path (#16)
  device_id INTEGER NOT NULL,       -- replaces agent_key_id in the lookup triple
  agent_key_id INTEGER,             -- leftover; new inserts write NULL
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Pre-existing sqlite files: `CREATE TABLE IF NOT EXISTS` is a no-op. Follow with `ALTER TABLE … ADD COLUMN` for `device_id`, `claimer_claimant_id`, and nullable `agent_key_id` is already present as NOT NULL on old files — **do not DROP** `agent_key_id` in this issue. New inserts on an old file that still has `agent_key_id INTEGER NOT NULL` write `0` as a sentinel **only if** a NOT NULL constraint remains; `:memory:` tests use the new DDL and write `NULL`. Implementer detects via `PRAGMA table_info` or always writes `agent_key_id: 0` on leases if the insert throws — prefer: new DDL for tests, ALTER ADD `device_id` / `claimer_claimant_id` for files, keep writing `agent_key_id` as `0` on leases **and** confirmations when the column is still NOT NULL. Document in `db.ts` comments.

Holder identity for progress/release/submit_pr: **owner**, not `device_id` (same person, another computer, may heartbeat — analogue of #9 “second key of the same user”). Compare `(claimer_user_id, claimer_claimant_id)` to the current principal’s owner. Acting `device_id` is still stored and audited.

### `events.details` (claim path)

`token 揭示` (claim success only; still no plaintext):

```ts
{ task_id: string, device_id: number, credential: 'inline' | 'profile', profile_id?: number, claimant_id?: number }
```

`claimant_id` present iff owner is a claimant. `actor_user_id` is the full user’s id on bind-to-self claims, **`null` on claimant claims** (no `users` row). Do **not** put `agent_key_id` on new rows. Do not change publish-time `token 揭示` (`{ profile_id, forge, base_url, full_name, outcome }`).

New event types (admin actions): `电脑待授权`, `电脑授权`, `电脑解除`, `认领者解除`. Details: `{ device_id, fingerprint, claimant_id? | user_id? }` — no pubkey, no token.

`GET /api/v1/stats` shape stays `{ completed_count, completed_by_username }` (#15). Claimant completions have `actor_user_id: null` and therefore bucket under `'系统'`. Do not add a third stats key in this issue (see Open questions).

### `createDb` wiring

`db.ts` `createDb`: after existing tables, `sqlite.exec` claimants DDL, devices DDL, then the three user ALTERs in try/catch `isDuplicateColumnError`, then lease/confirmation ALTERs. Register drizzle `schema: { …, claimants, devices }`.

---

## 2. Auth envelope (MCP + REST)

### Headers (stdio bridge → Fastify)

| Header | Value |
|--------|--------|
| `X-Kaola-Key` | standard-base64 SPKI DER of the Ed25519 public key (Node `publicKey.export({ type: 'spki', format: 'der' })`) |
| `X-Kaola-Ts` | unix seconds, decimal string, no leading zeros |
| `X-Kaola-Nonce` | 32 hex chars (`randomBytes(16)`) |
| `X-Kaola-Sig` | standard-base64 64-byte Ed25519 signature over the canonical UTF-8 payload |
| `X-Kaola-Hostname` | optional; `os.hostname()`; untrusted; stored on **first** pending insert only |

No `Authorization: Bearer`. Missing any of Key/Ts/Nonce/Sig → **`401` `{ error: 'unauthorized' }`** plus `WWW-Authenticate: Kaola-Device` (not `Bearer`). This is “no proof presented”, not “unknown device”.

Do not accept `ktk_` Bearer on `/api/mcp` or claim/progress/release/whoami.

### Canonical string (pin in `@kaola/shared`)

```
kaola-device-v1
${ts}
${nonce}
${METHOD}
${pathname}
${body_sha256_hex}
```

- Five `\n`-separated lines, **no trailing newline after the hash**.
- `METHOD` = HTTP method upper-case (`POST`).
- `pathname` = path only, no query (`/api/mcp` or `/api/v1/tasks/{publicId}/claim`). No host (bridge and server may see different `Host`).
- `body_sha256_hex` = SHA-256 of the **raw request body bytes** as lowercase hex. Empty body → hash of empty buffer (`e3b0c442…`).
- `DEVICE_PROOF_SKEW_SECONDS = 300`. Reject if `|now - ts| > 300` → `401 unauthorized` (treat as bad proof, not unknown device).
- Replay cache: in-memory `Map<string, number>` keyed by `${fingerprint}:${nonce}`, value = expiry unix (`ts + 300`). Duplicate key while cached → `401`. Sweep on access. Single-process SQLite already; no Redis. Cache lives on the Fastify instance (module-level Map is acceptable; cleared on process exit).

Verify with Node `crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, sig)`. On failure → `401 unauthorized`. Never log the raw key material beyond fingerprint.

Fingerprint helper (shared): `sha256(spkiDer).digest('hex')`.

### Hook outcomes (ordered)

`addDeviceProofHook(child, db)` — encapsulated child `onRequest`, same pattern as today’s `addAgentBearerHook` (`mcp.ts` `mcpBearerContext`, `claim.ts` `claimBearerContext`, whoami child).

1. Missing/malformed headers, bad key parse, bad sig, skew, replay → **`401` `{ error: 'unauthorized' }`**. No `devices` insert.
2. Valid sig, no row **or** row `pending` with `now < pending_expires_at` → insert/reuse pending (`pending_expires_at = created_at + 86400` on insert only). **HTTP `202`**:

   ```ts
   { error: 'authorization_required', pending: true, expires_at: string /* ISO from pending_expires_at */ }
   ```

   Optional additive `message` (Chinese): `'这台电脑尚未授权。请让管理员在「待授权电脑」中绑定。'`. **No `token`, no `lease`, no `clone`, no `task`, no JSON-RPC wrapper.** MCP POST never reaches `handleMcpPost`. Distinct from #16:

   | | Device wait | #16 autonomous confirm |
   |--|-------------|------------------------|
   | HTTP | `202` | `202` |
   | `error` | `authorization_required` | `confirmation_required` |
   | When | hook, before tools | inside `claimTask` after identity is already active |
   | `pending` | `true` | `true` |
   | Forge token | never | never |

3. Valid sig, pending row **expired** (never bound) → reset to a new 1-day pending window (same fingerprint), then same `202` as (2).
4. Valid sig, row `active`, owner `active`, `now < expires_at`, idle check pass → tick `last_seen`, set `request.deviceAuth`, continue. Idle: if owner.`device_idle_days > 0` and `last_seen` is set and `now - last_seen > idle_days * 86400` → flip device to `expired`, then (5).
5. Valid sig, row `expired` after having been `active` (hard max age or idle) → **`403` `{ error: 'device_expired' }`**. No forge token. Bridge may rotate the local keypair and retry (new pending).
6. Valid sig, row `revoked`, **or** owner `claimants.status === 'revoked'` / `users.status !== 'active'` → **`403` `{ error: 'forbidden' }`**. Do not re-pending that fingerprint. Do not rotate automatically (a new keypair would look like a new computer; that is a **new** pending only if the bridge mints a new key — product: revocation means this machine fails until a **human** starts a fresh pair; the bridge on `forbidden` must **not** auto-rotate).
7. Never `401` for “I don’t know this pubkey” when the signature is valid.

TypeScript:

```ts
// FastifyRequest augmentation (replace agentAuth on these routes)
deviceAuth?: {
  device: Device
  owner:
    | { kind: 'user'; user: User }
    | { kind: 'claimant'; claimant: Claimant }
}

export type AgentPrincipal = NonNullable<FastifyRequest['deviceAuth']>
```

Pending never sets `deviceAuth`.

`GET /api/v1/agent/whoami` (device hook): `200`

```ts
{
  device_id: number
  fingerprint: string
  hostname: string
  status: 'active'
  owner: { kind: 'user'; user_id: number } | { kind: 'claimant'; claimant_id: number; display_name: string }
}
```

Pending whoami → same `202` as MCP. No `ktk_`, no forge token.

---

## 3. `addAgentBearerHook` and `agent_keys`

### Pick: **stop using `agent_keys` for MCP / REST claim / whoami**. Keep the table and session CRUD as unused-compat.

- `registerMcp`, `registerClaim`, and whoami **must not** call `addAgentBearerHook`. They call `addDeviceProofHook`.
- `registerAgentKeys` session `POST/GET/DELETE /api/v1/agent-keys` stays. Web **stops calling it**. README **stops teaching it**. Tests in `agent-keys.test.ts` may remain as leftover CRUD; they are not the claim path.
- `leases.agent_key_id` / `claim_confirmations.agent_key_id` are leftover columns; new writes use `device_id` (and `claimer_claimant_id` / `claimer_user_id`). Lookup triple for #16 becomes `(task_id, user_id, device_id)`.
- Do not auto-mint `ktk_` on OAuth or bind (withdrawn A, `5390023681`).
- Do not delete the `agent_keys` table in this issue (irreversible). Product identity is the device.

`AgentPrincipal` no longer contains `key: AgentKey`.

---

## 4. Admin HTTP (session, `active`+`full` only)

New module `apps/server/src/devices.ts`, `registerDevices(app, db)`. Gate: `getSessionUser`; no session → existing `sendUnauthorized`; `status !== 'active'` or `permission_level !== 'full'` → `403 { error: 'forbidden' }`. Claimants have no session, so they cannot hit these routes.

| Method | Path | Body | Success |
|--------|------|------|---------|
| `GET` | `/api/v1/devices/pending` | — | `{ devices: PendingDevice[] }` |
| `GET` | `/api/v1/devices` | — | `{ devices: DeviceRow[] }` all non-deleted rows (admin overview: pending + active + expired + revoked), newest-first |
| `GET` | `/api/v1/me/devices` | — | `{ devices: DeviceRow[] }` where `user_id = session.id` (我的电脑) |
| `POST` | `/api/v1/devices/:id/bind` | bind body | `200 { ok: true, device_id, owner }` |
| `POST` | `/api/v1/devices/:id/revoke` | — | `200 { ok: true }` |
| `GET` | `/api/v1/claimants` | — | `{ claimants: ClaimantRow[] }` |
| `POST` | `/api/v1/claimants/:id/revoke` | — | `200 { ok: true }` — sets claimant `revoked`; flips **all** that claimant’s devices to `revoked` immediately |
| `PATCH` | `/api/v1/claimants/:id/settings` | policy body | `200` echo stored policy — **new pairings only** |
| `PATCH` | `/api/v1/me/device-settings` | policy body | same, for the session user’s columns (bind-to-self path) |
| `POST` | `/api/v1/users/:id/revoke` | — | `200 { ok: true }` — `users.status = 'revoked'`; revoke **all** that user’s devices; refuse if the row matches `KAOLA_ADMINS` (`403`) |

`POST /api/v1/users/:id/approve` (GitHub 待批准 queue): **leave the route** for leftover rows but the web widget is removed. New product does not invite `claim_only` publishers. Optional: approve leftover `待批准` → still only `status: 'active'` without granting a claimant identity. Prefer tests: leftover pending GitHub still cannot claim via OAuth session; they are not devices.

Bind body (exactly one variant; otherwise `400 { error: 'invalid_body' }`):

```ts
type BindBody =
  | { claimant_id: number }                 // existing claimant, must be status active
  | { claimant_display_name: string }       // trim; non-empty; INSERT new claimant active + defaults
  | { bind_to_self: true }                  // owner = session user; smoke exception
```

Bind rules:

- Device must be `pending` and `now < pending_expires_at`; else `409 { error: 'conflict', message: '电脑申请已过期或不在待授权状态。' }`.
- Count owner’s `status = 'active'` devices; if `>= max_devices` → `409 { error: 'conflict', message: '已达该身份的电脑台数上限。' }`.
- Set `paired_at = now`, `expires_at = now + device_max_age_days * 86400`, `status = 'active'`, exactly one owner column, `pending_expires_at` left as-is or nulled (nulled is cleaner).
- **Does not** call `claimTask`, does not decrypt, does not push a forge token (`5390135367` point 4).
- Audit `电脑授权`, `actor_user_id` = admin.

PendingDevice JSON (no pubkey):

```ts
{ id: number, hostname: string, fingerprint: string, created_at: string, expires_at: string }
```

`expires_at` here is ISO of `pending_expires_at`. DeviceRow adds `status`, `paired_at`, `expires_at` (authorization life), `last_seen`, `owner: { kind, claimant_id?, display_name?, user_id? }`.

Policy body: `{ device_max_age_days?: number, max_devices?: number, device_idle_days?: number }`. Integers; max age 1–365; max devices 1–50; idle 0–365. Missing keys leave stored values. `400 invalid_body` otherwise.

Revoke device: `status = 'revoked'`. Next MCP is (6) above. Owner row unchanged.

Only `full` can approve/revoke people and devices — even `GET /api/v1/devices/pending`. `GET /api/v1/me/devices` is the session user’s own machines (still `full` in practice, because workbench users are publishers).

---

## 5. OAuth / closed join

Replace `mapProfile` + `upsertUser` insert policy in `auth.ts`. Provider still yields `remoteId` / `username` / `displayName` only — **no** per-provider status/permission.

`completeOAuthLogin` after userinfo, in a SQLite transaction:

1. Parse `KAOLA_ADMINS` once at `registerAuth` (not required). Unset/empty → `[]`, **boot succeeds**. Malformed entry → throw (fail boot), same class as missing `OAUTH_*`. Format: comma and/or whitespace separated `provider:username` or `provider:id:<remote_id>`. `provider` ∈ `github|gitlab|gitea`.
2. Load existing `(provider, remote_id)`.
3. If existing:
   - Update `username` / `display_name` only (today’s behavior).
   - **Never** change `status` or `permission_level` (re-login does not revive `revoked`, does not auto-full GitLab).
   - If `status === 'revoked'`: do **not** set `session.userId`; redirect to `/login?reason=revoked` (HTML login page shows 「该身份已被解除」).
   - If `status === '待批准'` leftover: keep session (today’s pending card) — no new inserts of this kind.
   - If `status === 'active'`: set session, redirect `/`.
4. If no row:
   - If `KAOLA_ADMINS` matches this identity (`provider`+username **or** `provider`+`id:`+remote_id) → INSERT `active`+`full` with policy defaults. Session. Redirect `/`.
   - Else if `COUNT(*) FROM users WHERE permission_level = 'full' AND status = 'active' = 0` → INSERT `active`+`full` (bootstrap; any of the three OAuth buttons). Session. Redirect `/`.
   - Else → **do not insert**. No session. Redirect `/login?reason=uninvited`. Copy: 「未被邀请」. Not a `待批准` queue.

GitLab/Gitea first login is **not** auto-full unless (bootstrap) or (whitelist match).

`GET /api/v1/me`: if `status === 'revoked'` should not happen with a session under (3); if it does, `200` with `status: 'revoked'` and no workbench (web `view === 'revoked'`). Drop additive pending message for new users; leftover `待批准` may still send `PENDING_CLAIM_MESSAGE`.

`PUT /api/v1/me/settings`: treat `revoked` like unauth (`sendUnauthorized`). `trusted_automation` remains a **user** column (bind-to-self / #16 only).

Login HTML (`loginPageHtml`) and `App.vue` login copy: remove 「GitLab/Gitea 正式成员」. Show `reason=uninvited` / `revoked`.

`registerAuth` still requires the same OAuth env vars. `KAOLA_ADMINS` is extra optional. `buildApp()` tests that do not set `KAOLA_ADMINS` keep working.

---

## 6. Stdio app

### Location and bin

- New workspace member `apps/mcp` (`pnpm-workspace.yaml` already globs `apps/*`).
- Package name `@kaola/mcp`, private, `"type": "module"`.
- Bin name **`kaola-mcp`**.
- Entry: `apps/mcp/src/main.ts` + tiny `apps/mcp/bin/kaola-mcp.mjs` shebang that `spawn`s `node --experimental-strip-types` on `main.ts` with `stdio: 'inherit'` (matches `@kaola/server` not compiling). No Fastify, no `OAUTH_*`, no `VAULT_MASTER_KEY`.
- Depends on `@modelcontextprotocol/sdk` `1.30.0` and `@kaola/shared` `workspace:*` (canonical string only). Node `node:crypto` / `node:fs` / `node:os` / `node:http(s)`. **No new npm dependency.**

### `~/.kaola/` layout (directory `0700`, files `0600`)

```
~/.kaola/                 # mkdir 0o700
  device.json             # 0o600 — keypair, never uploaded
  config.json             # 0o600 — optional { "url": "http://localhost:31415" }
```

`device.json`:

```ts
{ v: 1, privateKeyPkcs8: string /* base64 PKCS8 DER */, publicKeySpki: string /* base64 SPKI DER */, createdAt: string }
```

If missing, generate Ed25519 (`generateKeyPairSync('ed25519')`), write `0o600`, then continue. Private key never in HTTP, logs, or mcp.json. Override home with `KAOLA_HOME` for tests only (do not document as a product flag in README beyond a one-liner).

URL resolution, first wins: `--url` CLI arg, else `KAOLA_URL`, else `config.json.url`, else `http://localhost:31415`. Trailing slash trimmed. Non-localhost should be HTTPS (warn on stderr if `http:` and host is not localhost/127.0.0.1); still connect if the user passed it (do not invent a TLS policy that blocks smoke).

### How it talks to `POST /api/mcp`

Thin **forwarder**, not a second `McpServer` with duplicated tools:

1. Speak stdio MCP to Cursor/Claude/Codex (`StdioServerTransport` **or** a line-delimited JSON-RPC stdin/stdout loop). Prefer SDK `StdioServerTransport` plus a client `StreamableHTTPClientTransport` **only if** the client transport accepts a custom `fetch`. If `1.30.0`’s client cannot inject headers, implement a small POST loop: initialize without `mcp-session-id`, store response header `mcp-session-id`, send it on later POSTs. `GET`/`DELETE /api/mcp` stay unused (server `405`).
2. Every POST: sign headers from §2, `Content-Type: application/json`, body = JSON-RPC from the runtime.
3. HTTP **202** `authorization_required`: do **not** crash silently. Synthesize a JSON-RPC error the Agent can read, e.g. `{ jsonrpc:'2.0', error: { code: -32000, message: 'authorization_required pending until <expires_at>' }, id }` for initialize, and `isError` tool results if a session already exists. Include `expires_at` in the message. Never invent a forge `token` field.
4. HTTP 401/403: JSON-RPC error with `unauthorized` / `forbidden` / `device_expired`. On `device_expired` only: rotate `device.json` (new keypair) **once** and retry the same POST; if 202, surface pending. On `forbidden`, do not rotate.
5. HTTP 201/200 JSON-RPC success: pass through unchanged — including `claim_task` structuredContent with top-level `token` + `clone` four keys. The bridge must not persist the forge token to `~/.kaola/` or mcp.json.

### Committed example (replaces URL-only snippet; still no secrets)

```json
{
  "mcpServers": {
    "kaola-tasks": {
      "command": "kaola-mcp",
      "args": ["--url", "http://localhost:31415"]
    }
  }
}
```

No `headers`, no `ktk_`, no `KAOLA_AGENT_KEY`, no forge PAT. Orchestrator allows command + URL; #22 URL-only HTTP snippet is retired as the **recommended** example because that path cannot present device headers.

Root `package.json` `test` script must list new files (Documentation Checklist). Optional: `"kaola-mcp": "pnpm --filter @kaola/mcp …"` is not required for smoke if `pnpm install` links the bin.

---

## 7. Web (`App.vue`)

Four-pane shell, no vue-router. Relabel nav **钥匙 → 电脑** (`testid` `workbench-nav-keys` may stay to limit shell churn, or become `workbench-nav-devices` — tdd-guide pins one). Pane still `v-show`.

Workbench users are `active`+`full` only. `canApprove` remains that pair. `canManageKeys` collapses into `canApprove` (claimants never log in). Leftover `claim_only` / `待批准` fixtures in `App.shell.test.ts` / `App.settings.test.ts`: pending card stays for leftover `待批准`; `claim_only` member without 发布 stays as a defensive view (no bind UI). Login: GitLab/Gitea are **not** described as 正式成员.

电脑 pane sections (`canApprove`):

1. **受信自动化** + **待确认认领** — keep (#16, bind-to-self users only). Same `GET/POST /api/v1/claim-confirmations*`.
2. **我的电脑** — `GET /api/v1/me/devices`. Columns: hostname, fingerprint (short), paired_at, expires_at, last_seen, status. Button **解除这台电脑** → `POST /api/v1/devices/:id/revoke`. Empty: `暂无已绑定的电脑。`.
3. **待授权电脑** — `GET /api/v1/devices/pending`. Hostname, fingerprint, 申请时间, 到期. Bind UI per row:
   - input 认领者显示名 (`claimant_display_name`)
   - select 已有认领者 (`claimant_id` from `GET /api/v1/claimants`, empty hint `暂无认领者，请输入显示名新建。`)
   - button **绑到我自己** (`bind_to_self: true`)
   - submit → `POST /api/v1/devices/:id/bind`
4. **认领者** — list + **解除认领者** + policy inputs (`PATCH …/claimants/:id/settings`). Caption: 修改有效期只作用于之后的新配对.
5. **凭证档案** — unchanged (`canApprove`).
6. **Delete** the Agent Key block (`生成 Agent Key`, `自助生成与吊销…`, empty `暂无 Agent Key。`) and the **批准 GitHub 用户** widget. Stop fetching `/api/v1/agent-keys`.

Do not add an Agent claim button on 看板.

`view`: `login` | `pending` (leftover) | `uninvited` (query `reason=uninvited` without session) | `member`. Claimants have no `me` row → they never reach `member`.

Chinese copy only in the UI.

---

## 8. Claim / MCP / #16 mapping

`claimTask(db, auth: AgentPrincipal, …)`:

- Delete `auth.user.status === '待批准'` as the primary gate (pending devices never arrive). If `owner.kind === 'user'` and `user.status !== 'active'` → `403 forbidden` (defense in depth). Claimant owner must be `active`.
- #16: **only** `owner.kind === 'user' && autonomous === true && !user.trustedAutomation`. Lookup `(task.id, user.id, device.id)`. Events `认领待确认` details `{ task_id, device_id }` (no `agent_key_id`). Claimants **skip** #16 (they cannot open 待确认认领). Instructed claims unchanged.
- `insertActiveLease`: `deviceId`, `claimerUserId` **or** `claimerClaimantId`, not `agentKeyId` (except sentinel on old files).
- Reveal audit: `device_id`, optional `claimant_id`; `actorUserId` = user id or `null`.
- `attemptWriteback(..., actorUserId)`: user id or `null`.
- Success envelope **unchanged**: `{ task, token, lease, clone }` with clone keys exactly `suggested_dir`, `token_usage`, `remote_url`, `extra_header`. `CLONE_TOKEN_USAGE` sentence unchanged.
- REST `202` from `claimTask` remains **only** `confirmation_required`. Device wait is the **hook** `202` `authorization_required` and never enters `claimTask`.

`list_tasks` / `get_task_brief`: only after active `deviceAuth`. Pending cannot list (`5390135367`). Rewrite `mcp.test.ts` “pending GitHub seeded key may list_tasks”.

MCP tool names stay six. `submit_pr` still MCP-only.

---

## 9. #22 pins (must not change)

| Pin | Oracle |
|-----|--------|
| Clone four keys | `Object.keys(clone)` sorted `['extra_header', 'remote_url', 'suggested_dir', 'token_usage']`. `token_usage` exact `CLONE_TOKEN_USAGE`. `extra_header` gitea `token ${token}` else `Bearer ${token}`. |
| Two reveal channels | Forge plaintext **only** REST claim `201` top-level `token` and MCP `claim_task` success `token`. Session GET, import `200`, profile issues, both flavors of `202`, whoami, device list, bind, events `details` — never. |
| Two-task different tokens | Same device, two `publicId`s, `INLINE_TOKEN` then `PROFILE_TOKEN` (or the existing fixtures); second body `token` is the second task’s, tokens unequal. Keep `claim.test.ts` ~911 and `mcp.test.ts` ~1100; **re-auth via device proof**, not `ktk_`. |

Do not reopen #22. Do not change clone key names to accommodate the bridge. The committed MCP example **may** gain `command` + URL; that is #23, not a #22 break.

---

## Data flow

```
Runtime (Cursor/Claude/Codex)
  stdio JSON-RPC
    kaola-mcp (apps/mcp)
      ~/.kaola/device.json  (Ed25519, 0600)
      POST /api/mcp  + X-Kaola-*
        Fastify addDeviceProofHook
          pending ──202 authorization_required──► Agent stops
          active+owner ──► registerMcp tools
                            claimTask
                              #16? 202 confirmation_required (user owner only)
                              else 201 { task, token, lease, clone }
Admin browser session (full)
  GET pending → POST bind (new claimant | existing | self)
  revoke claimant / device / user
```

Approve/bind never auto-claims and never pushes a forge token. Agent retries MCP with the **same** keypair after bind.

---

## Implementation Steps

### Phase 1 — Shared canonical + server schema/OAuth (tests first)

1. **Pin canonical string** (`packages/shared/src/device-proof.ts`)
   - Action: export `DEVICE_PROOF_SKEW_SECONDS`, `deviceProofCanonical`, `deviceFingerprint`. Add `packages/shared/src/device-proof.test.ts`; append to root `package.json` `test` list.
   - Why: server and bridge must not drift.
   - Dependencies: none
   - Risk: Low

2. **Schema + `createDb`** (`schema.ts`, `db.ts`)
   - Action: tables/columns as §1; duplicate-column swallow; drizzle register.
   - Dependencies: none
   - Risk: Medium (old sqlite `agent_key_id` NOT NULL)

3. **OAuth closed join** (`auth.ts`)
   - Action: §5. Tests in `auth.test.ts` rewrite GitLab/Gitea auto-full; add bootstrap, second login uninvited, whitelist, revoked re-login.
   - Dependencies: schema `revoked`
   - Risk: Medium (many existing auth fixtures)

### Phase 2 — Device hook + admin HTTP (server tests)

4. **`addDeviceProofHook`** (`device-proof.ts` server)
   - Action: §2 outcomes. Replay Map. Pending insert/reuse.
   - Dependencies: schema, shared canonical
   - Risk: High (authz)

5. **Admin routes** (`devices.ts`, `app.ts` wire `registerDevices`)
   - Action: §4. Tests `apps/server/src/devices.test.ts` (new; add to root `test` script).
   - Dependencies: hook pending rows exist
   - Risk: Medium

6. **Retarget claim/MCP/whoami** (`claim.ts`, `leases.ts`, `claim-confirmations.ts`, `mcp.ts`, `agent-keys.ts` whoami)
   - Action: §3 + §8. Keep #22 oracles. New `202 authorization_required` tests in `mcp.test.ts` / `claim.test.ts`. Delete “missing Bearer → 401 then JSON-RPC” only insofar as headers change; missing device headers still 401 before JSON-RPC.
   - Dependencies: hook
   - Risk: High

### Phase 3 — Bridge

7. **`apps/mcp`**
   - Action: §6. Tests `apps/mcp/src/main.test.ts` (sign headers; 202 synthesis; do not write forge token to disk). Root `test` script append. `pnpm` bin.
   - Dependencies: server hook live in `buildApp()`
   - Risk: Medium (SDK client header injection)

### Phase 4 — Web

8. **`App.vue` + vitest**
   - Action: §7. Extend `App.shell.test.ts` / new `App.devices.test.ts` (`include` already `src/**/*.test.ts`). Remove generate-key assertions; add 待授权电脑 / 绑到我自己.
   - Dependencies: admin HTTP JSON
   - Risk: Medium (shell testids)

### Phase 5 — Docs (doc-updater, after behavior exists)

9. `docs/DESIGN.md` §3/§7/§9/§10/§11, `docs/api.md`, `README.md`, `CHANGELOG.md`, `docs/smoke-test.md`, `docs/architecture.md`, CLAUDE.md Commands `test` file list.
   - Transcribe this file; do not invent extra error strings.

---

## Testing Strategy

Custody: **tdd-guide writes tests; implementer writes production code.** Server tests first (fail on current HEAD), then implementer Phase 1–2, then bridge tests+code, then web tests+code.

### Unit / integration (server) — `apps/server/src/*.test.ts`

| File | Focus |
|------|--------|
| `auth.test.ts` | Zero-full first GitHub/GitLab/Gitea → `full`; second uninvited → no insert; `KAOLA_ADMINS=gitlab:x` after bootstrap still inserts that identity as `full`; GitLab first login is **not** auto-full when a full already exists; revoked re-login does not set `active`; empty `KAOLA_ADMINS` boots |
| `devices.test.ts` (new) | Pending 202 shape; reuse does not refresh `pending_expires_at`; bind to new display name; bind to existing claimant; bind_to_self; bind does not claim; revoke claimant → next proof 403; max age 1–365; PATCH max age does not change existing `expires_at`; `max_devices` 409; only `full` can bind |
| `claim.test.ts` | Device proof instead of `ktk_`; two-`publicId` token pin; clone four keys; `202 confirmation_required` still that `error` string; unpaired claim is hook `202 authorization_required` with no `token` |
| `mcp.test.ts` | Same pins; unpaired initialize/list HTTP 202 not 401; pending cannot `list_tasks` as success; after bind, `claim_task` two-task tokens; GET/DELETE still 405 once active |
| `claim-confirm.test.ts` | Triple uses `device_id`; user owner only |
| `agent-keys.test.ts` | May keep CRUD; whoami no longer Bearer `ktk_` — move whoami cases to device tests |

Helper for tests: generate Ed25519, build headers with shared canonical (do not paste `ktk_` into MCP). Prefer a `signDeviceRequest({ privateKey, method, path, body, hostname? })` test helper in the server test file or shared.

### Bridge

- Signatures verify against the server hook.
- `~/.kaola/device.json` mode `0600` (skip strict mode assert on Windows; this repo is darwin/linux smoke).
- HTTP 202 → JSON-RPC error containing `authorization_required` and ISO `expires_at`.
- Successful claim JSON-RPC contains `token`; file under `KAOLA_HOME` has no forge plaintext.

### Web

- No button text `生成 Agent Key`.
- 待授权电脑 list + bind-to-self control (`data-testid` pinned by tdd-guide).
- `claim_only` does not see bind (no 发布, no 待授权).
- Login copy does not say GitLab/Gitea are 正式成员.

### E2E / smoke (human; `docs/smoke-test.md`)

Localhost, empty `KAOLA_ADMINS`, first GitLab login = admin, Agent MCP once → pending, admin bind to self, Agent retries, claim reveals that task’s token only. Do not write guessed progress into GitHub issues.

---

## Build order (tdd-guide then implementer)

Do **not** write production code in the same role that authors the failing tests.

1. **tdd-guide (server)** — failing tests: `packages/shared` canonical; `auth.test.ts`; `devices.test.ts`; rewrite claim/mcp/claim-confirm/whoami oracles. `#22` tests stay green in intent (they fail until device helper replaces `ktk_`, then must pass).
2. **implementer (server)** — schema, auth, hook, admin HTTP, claim/MCP retarget. Loop until that gate is green. Route type/lint noise to `build-error-resolver`.
3. **tdd-guide (bridge)** — `apps/mcp` tests against `buildApp()`.
4. **implementer (bridge)** — `kaola-mcp`.
5. **tdd-guide (web)** — App tests for 电脑 pane / deleted mint copy.
6. **implementer (web)** — `App.vue`. Browser-verify 待授权电脑 bind if tools exist; else curl + mount tests and say so.
7. **doc-updater** — DESIGN/api/README/CHANGELOG/smoke-test/CLAUDE test list. No new contracts.

Parallelism: shared canonical tests + auth tests are independent of web. Do not start web implementer before admin JSON exists.

---

## Risks & Mitigations

- **Risk**: MCP Streamable HTTP clients treat HTTP 202 as transport failure.  
  **Mitigation**: 202 is the **server** contract; `kaola-mcp` translates to JSON-RPC error. Raw `url`-only mcp.json **cannot** present device headers — stop recommending it.

- **Risk**: Old sqlite `leases.agent_key_id INTEGER NOT NULL`.  
  **Mitigation**: new DDL for `:memory:`; ALTER ADD `device_id`; write `0` sentinel if NOT NULL remains. Do not rebuild-drop in this issue unless tests on file sqlite force it (escalate).

- **Risk**: Replay cache is in-memory; multi-process deploy could replay across workers.  
  **Mitigation**: product is single Fastify + SQLite. Document the corner cut. Changing it requires shared cache — out of scope.

- **Risk**: Bootstrap race (two first OAuth).  
  **Mitigation**: one transaction: count `full`+`active` then insert. SQLite serializes writes.

- **Risk**: Auto-rotate on every 403 re-queues a kicked machine.  
  **Mitigation**: rotate only on `device_expired`, never on `forbidden`.

- **Risk**: `GET /api/v1/stats` attributes claimant work to `'系统'`.  
  **Mitigation**: keep #15 envelope; listed under Open questions.

---

## Success Criteria

- [ ] Unpaired signed MCP/REST → HTTP `202` `{ error: 'authorization_required', pending: true, expires_at }`, no forge token, no lease
- [ ] Missing device headers → `401 unauthorized`, not 202
- [ ] `confirmation_required` still only #16; string not reused for devices
- [ ] Bind to new claimant display name **or** `bind_to_self`; bind does not claim / does not push token
- [ ] Retry after bind: `list_tasks` ok; `claim_task` / REST `201` with that task’s token
- [ ] Two-task claims still return different forge tokens; clone still four keys; only two reveal channels
- [ ] Revoke claimant or `users.status = 'revoked'` → next request `403`; re-login does not revive
- [ ] Zero `full` → first web OAuth is admin; later uninvited OAuth inserts nothing; GitLab/Gitea not auto-full; empty `KAOLA_ADMINS` boots
- [ ] `kaola-mcp` + `~/.kaola/device.json` `0600`; committed example is command + URL, no secrets
- [ ] App.vue has 我的电脑 / 待授权电脑 / bind; no 「生成 Agent Key」; claimants cannot use the workbench
- [ ] `agent_keys` unused by MCP/claim; leases/confirmations keyed by `device_id`

---

## Open questions

These are value calls. Do **not** invent a third auth scheme (no MCP OAuth, no pairing code, no local password, no invite table) while waiting.

1. **#16 for claimant-owned devices.** Recommendation in this blueprint: skip confirmation (claimants have no session / 待确认认领). Alternative: admin-proxy confirmation — not specified in comments. If product wants a gate, that is a new comment, not a new proof type.
2. **Stats for claimant claims.** Recommendation: keep `{ completed_count, completed_by_username }` and let `actor_user_id: null` fall under `'系统'`. Changing the stats envelope is a #15 contract change.
3. **Leftover `待批准` / `claim_only` rows** in existing sqlite files. Recommendation: no migration UI; whitelist match on **insert only**; existing revoked stays revoked; leftover pending GitHub keeps today’s pending card until someone deletes the row. Extra publishers this issue = `KAOLA_ADMINS` only.

Clock skew (300s), header names, canonical `kaola-device-v1`, `device_expired` vs `forbidden`, and dual policy columns are **implementation choices** pinned above, not open questions.

## Out of scope (do not plan past)

- Reopening #22
- MCP OAuth (withdrawn B)
- Local password admin
- 10-minute pairing code (withdrawn)
- Copy `ktk_` into mcp.json (withdrawn A)
- Invite table / `claim_only` publishers
- Server-side `git`
- Dropping the `agent_keys` table
