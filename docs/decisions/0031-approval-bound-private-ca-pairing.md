# Approval-bound private-CA pairing for Claim clients

Status: accepted  
Issue: https://github.com/KaolaBrother/KaolaTasks/issues/63

## Decision

Private-CA Claim onboarding is an **approval-bound automatic pairing** flow outside the MCP
protocol. A generic client runs `kaola-mcp pair --url <kaola-origin>`. It generates a
high-entropy one-time pairing secret that **never** traverses the untrusted bootstrap link.
The claimant hands that secret to an admin through a channel the client does not treat as
trusted (copy, QR, or an already-trusted MDM/package channel). The admin submits it only on
an already-trusted workbench session. The server activates the exact device in one transaction
and issues an HMAC approval proof bound to instance, origin, device, root, nonces, owner, and
expiry. The client verifies that proof, atomically stages the public root, then opens a
**brand-new** strict TLS connection and requires same-device active `whoami` before writing
ready trust.

`kaola-mcp --url` stays strict and noninteractive. If a private-CA origin is not yet paired it
returns typed `pairing_required` plus the recovery command and exits. Bootstrap is a narrow
REST client used only by `pair`, never a reusable `--insecure` mode, and never MCP.

This ADR freezes encoding, test vectors, REST, schema, errors, local v2 trust, and rotation
**before** product behavior changes. Implementation must not invent a second encoding.

## Why this is the minimum

Issue #48 already ships operator `kaola-mcp trust install` with out-of-band PEM + fingerprint.
That remains the explicit recovery / operator path. It is not a claimant onboarding path:
generic Claim machines should not handle PEM, fingerprints, `NODE_EXTRA_CA_CERTS`, or an MCP
host restart.

TOFU (trust the first root returned on an untrusted socket) is still forbidden. Admin knowledge
of the client-generated secret, plus transcript commitment, is the out-of-band check that
replaces fingerprint distribution for the normal claimant path.

## Non-goals

- mTLS or CA-issued client certificates
- new MCP tools, Bearer enrollment tokens, Claim aggregates, or a coordinator service
- bind automatically claiming a task or revealing a forge token
- silent install/removal of OS or browser roots, or any elevation from a Kaola process
- the server running Agent, Workflow, Runner, git, or a worktree
- weakening token containment, device fencing, Claim/Lease, public-CA default trust, or the
  no-server-Agent boundary

## Threat model

Bootstrap TLS has no PKI trust. An on-path attacker can present any certificate, speak the
pairing REST, and substitute pairing id, origin, instance id, root PEM, or nonces.

| Attack | Why it fails |
| --- | --- |
| Attacker root as TOFU | Client stores the advertised root but does not install it until the approval proof verifies `root_ca_sha256` against the local transcript. |
| Attacker relays commitment and later presents a different root | Transcript binds the root hash; proof for another root will not verify; PEM is not written. |
| Attacker learns the pairing secret from bootstrap | Secret is never sent on bootstrap. Only `HMAC-SHA256(secret, SHA-256(transcript))` is. |
| Attacker guesses the secret | ≥128-bit CSPRNG; constant-time compare; 8 failures reject the attempt. |
| Attacker tricks a non-admin into approving | Bind remains `active`+`admin` only. Publishers stay `403 forbidden`. |
| Admin types the secret into chat / Issue / MCP | Out of product scope to prevent; CLI copy warns. Workbench never displays the expected secret. |
| Attacker replays an old proof on another origin or device | Proof transcript binds origin, instance, device fingerprint, root, owner, times. |
| Attacker calls pairing REST then `list_tasks` / `claim_task` | Pairing routes are isolated; the device stays `pending` until bind; pending still cannot list or claim; responses never contain forge tokens. |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` or `--insecure` | Forbidden globally and as a launcher flag. Bootstrap is a private, one-shot agent inside `pair` only. |
| Hostname mismatch / expired leaf used to enter bootstrap | Only unknown-issuer class errors enter bootstrap. SAN/hostname is still checked on that socket. |
| Public CA origin installs the advertised private root | Default-store success never installs an extra root. |
| v1 host-neutral extra CA applied to the wrong host | v2 is origin/instance/device bound. v1 is never rewritten as v2. |
| Lost HTTP response / process restart mid-pair | Local `0600` receipt plus server idempotent recover of the same unexpired attempt. |
| Server restart | Pairing rows live in SQLite next to `devices`, not in a memory map. |

Root and leaf private keys never enter the app, client, DB, logs, Task Brief, MCP config, or
Git. The pairing secret is not stored on the server (commitment only). After success the client
deletes the secret. Logs, events, and list/detail payloads are secret-scanned for the secret,
PEM private-key blocks, and forge tokens.

## Actors and trust boundaries

```text
Claimant laptop                         Admin browser                    Kaola server
----------------                        -------------                    ------------
Ed25519 device.json                     already-trusted HTTPS           PUBLIC_URL terminator
pair bootstrap (no PKI)  ----REST---->  pairing descriptor              device_pairings
secret shown locally                    secret typed on 电脑 page      devices.status authority
receipt 0600 (deleted later)            session cookie, no expected     instance_id in app data
v2 trust after proof+strict whoami      secret displayed                public root PEM path
```

MDM or a signed installer may deliver the secret instead of a human copy. That does **not**
change the server transaction or the strict reconnect gate.

## Encoding

All multi-field transcripts use length-delimited binary, not JSON.

```text
field(bytes)  := uint32be(length) || bytes
transcript    := concat(field(f_i) for f_i in declared order)
```

`length` is the byte length of that field. Maximum field length is 65536; larger is invalid.
Integers in fields that are documented as Unix seconds are decimal ASCII with no sign and no
leading zeros (`1893456000`, never `01893456000`). Unix `0` is the single character `0`.

### Pairing transcript (`kaola-pairing/1`)

Order:

1. `protocol_version` UTF-8 `kaola-pairing/1`
2. `pairing_id` UTF-8 opaque `kpr_` + 32 lowercase hex (16 random bytes)
3. `instance_id` UTF-8 lowercase UUID
4. `origin` UTF-8 WHATWG origin: `protocol + '//' + host` after stripping trailing slashes from
   `PUBLIC_URL` / `--url`. This is the same string `apps/mcp` `originDigest` hashes. Hostnames
   are lowercased by WHATWG parse. Default ports are omitted (`https://host`, not `:443`).
5. `device_fingerprint` UTF-8 64 lowercase hex SHA-256 of the device Ed25519 SPKI DER
6. `client_nonce` 32 raw bytes
7. `server_nonce` 32 raw bytes
8. `root_ca_sha256` 32 raw bytes: SHA-256 of the **single certificate DER** (not PEM text)
9. `expires_at` UTF-8 Unix seconds of the pairing attempt

### Commitment

```text
commitment = HMAC-SHA256(pairing_secret, SHA-256(transcript))
```

The client sends `commitment` as 64 lowercase hex. The pairing secret is ≥16 bytes from
`crypto.randomBytes`. Display grouping is 8×4 lowercase hex with dashes; bind accepts hex with
optional dashes, spaces, or colons and is case-insensitive.

### Approval key and proof

```text
pairing_key = HKDF-SHA256(
  ikm  = pairing_secret,
  salt = SHA-256(transcript),
  info = UTF-8 "kaola-pairing-approval-v1",
  L    = 32
)
proof = HMAC-SHA256(pairing_key, SHA-256(approval_transcript))
```

Approval transcript (`kaola-pairing-approval/1`) order:

1. `protocol_version` UTF-8 `kaola-pairing-approval/1`
2. `pairing_id`
3. `instance_id`
4. `origin`
5. `device_fingerprint`
6. `root_ca_sha256` (32 raw bytes)
7. `owner_kind` UTF-8 `claimant` or `user`
8. `owner_id` UTF-8 decimal id (claimant id or user id)
9. `approved_at` UTF-8 Unix seconds
10. `expires_at` UTF-8 (same pairing expiry as the pairing transcript)

Display names are not in the MAC. The JSON returned to the client is a convenience copy of these
fields plus `proof` hex; verification always rebuilds the binary transcript.

### Test vectors

Canonical bytes live in
[`0031-pairing-test-vectors.json`](0031-pairing-test-vectors.json).
The primary vector uses only `example.test` and sequential nonces. Implementation tests import that
file. Any encoder that does not reproduce `transcript_hex`, `commitment_hex`, `pairing_key_hex`,
and `proof_hex` is wrong, even if a higher-level test is green.

XOR of any single transcript field’s first byte must match
`negative.field_substitution_commitment_hex` and must never equal the primary commitment.

## Server configuration (non-secret)

Pairing is off unless explicitly enabled. None of these values are forge tokens or pairing
secrets.

| Name | Meaning |
| --- | --- |
| `KAOLA_PAIRING_MODE` | `disabled` (default) or `private_ca` |
| `KAOLA_PUBLIC_ROOT_CA_PATH` | Path to the **public** root CA PEM (one `CERTIFICATE`, no private-key block) |
| `KAOLA_NEXT_PUBLIC_ROOT_CA_PATH` | Optional next root during overlap rotation |
| `KAOLA_PUBLIC_LEAF_CHAIN_PATH` | Optional leaf+intermediates PEM used at boot when the process cannot hairpin `PUBLIC_URL` |
| `KAOLA_PAIRING_TTL_SECONDS` | Attempt TTL. Default **`86400`**, minimum **`86400`**, maximum `604800`. Values below 86400 are invalid (fail closed at boot / request). The withdrawn 900 / 300–3600 draft is void. |

`instance_id` is a UUID created once and stored in SQLite `app_settings` (`k='instance_id'`),
alongside application data. Changing `PUBLIC_URL` does not rotate `instance_id`; it does
invalidate origin-bound v2 trust and requires re-pair.

### Pairing attempt lifetime

This is the clock for **one pairing application**, not the bound-device lifetime.

| Clock | Rule |
| --- | --- |
| New attempt | `created_at = now`; `expires_at = created_at + ttl` with `ttl >= 86400`. Window starts at **this** `POST /api/v1/device-pairings`, not at first-seen of an older pending row. |
| Live | `now < expires_at`: admin may bind; client may recover create/commit/status; receipt/secret/proof remain usable. No extra wait-until-24h gate. |
| Expired | `now >= expires_at`: `409 pairing_expired`; do not write ready trust. |
| Idempotent recover | Same unexpired row is returned unchanged. **Do not** add ttl, **do not** restamp `created_at` / `expires_at`, **do not** extend `pending_expires_at` again. |
| Already-pending device | DESIGN §7 / §10 pending window remains first-seen + 1 day. A **new** pair must still last ≥24h from this application. Set `devices.pending_expires_at = max(existing pending_expires_at, pairing.expires_at)` so a leftover 1-hour pending cannot expire before the pairing and block bind. Never shorten either deadline. |
| Receipt / secret / proof | Receipt `expires_at` equals the server pairing `expires_at`. Polling, HMAC verification, and restart recovery must not use a shorter timeout (900s, 15m, etc.). |
| After bind | `devices.expires_at = paired_at + owner.device_max_age_days * 86400`. Default `device_max_age_days` stays **30**. Pairing TTL does not become the bound-device TTL. |

Acceptance: bind and recover at `created_at + 1` and at `expires_at - 1` succeed; at `expires_at` they fail closed. A device that has already been pending for 20 hours and then starts pair remains approvable for a full 24 hours from that pair request.

When `KAOLA_PAIRING_MODE=private_ca`, boot fails closed unless:

1. The public root PEM is readable, exactly one CA certificate, and contains no `PRIVATE KEY`
   block.
2. SHA-256(DER) is computable.
3. That CA actually roots the current origin chain: either a successful TLS probe of
   `PUBLIC_URL` using **only** that extra root, or `KAOLA_PUBLIC_LEAF_CHAIN_PATH` verifies to
   that root with SAN covering the `PUBLIC_URL` hostname.

Root private keys stay on the issuing host. The app never loads them.

`STABLE_PUBLIC_CA` / `KAOLA_PAIRING_MODE=disabled`: pairing REST answers `404` /
`pairing_mode_disabled`. Clients must not bootstrap.

## REST (outside MCP)

Device proof headers are the existing `X-Kaola-Key` / `X-Kaola-Ts` / `X-Kaola-Nonce` /
`X-Kaola-Sig` over the **raw body bytes** of that pairing request (`deviceProofCanonical`).
Cookies are ignored. Leftover `ktk_` Bearer is `401` + `WWW-Authenticate: Kaola-Device`.
These routes never send `Set-Cookie`, never read Task/Claim/credential/event tables for
response bodies, and never return forge tokens.

Valid unknown or pending fingerprints **upsert a pending device** the same way MCP does
(`pending_expires_at` = first seen + 86400). That device still cannot list or claim.

### `POST /api/v1/device-pairings`

Creates or idempotently recovers the single unexpired attempt for this device.

Request body:

```json
{ "client_nonce": "<64 lowercase hex>" }
```

`client_nonce` is 32 bytes. Hostname may arrive in `X-Kaola-Hostname` (untrusted, same as today).

Success `201` (new) or `200` (idempotent recover) public descriptor:

```json
{
  "pairing_id": "kpr_…",
  "protocol_version": "kaola-pairing/1",
  "instance_id": "<uuid>",
  "origin": "https://<public-host>",
  "server_nonce": "<64 hex>",
  "root_pem": "<single CERTIFICATE PEM>",
  "root_sha256": "<64 hex>",
  "expires_at": "<ISO-8601>",
  "device_id": 12,
  "device_fingerprint": "<64 hex>",
  "status": "created"
}
```

Idempotent recover returns the **same** pairing id, server nonce, root, and expiry. It does
not mint a second live attempt.

Errors:

- pairing mode off → `404 { "error": "pairing_mode_disabled" }`
- invalid body / nonce length → `400 { "error": "invalid_body" }`
- device already `active` (use rotation preflight, not this) → `409 { "error": "conflict", "message": "电脑已授权，请走根轮换而不是重新配对。" }`
- revoked / expired-idle device → same `403` family as MCP (`forbidden` / `device_expired`)

### `POST /api/v1/device-pairings/:id/commit`

Same device. Body `{ "commitment": "<64 hex>" }`.

- First commit on `created` → `200 { "status": "committed", "pairing_id", "expires_at" }`
- Repeat identical commitment → idempotent `200`
- Different commitment → `409 { "error": "pairing_commitment_mismatch" }`
- Unknown / other device / expired → `404` / `409 pairing_expired`

The server stores the commitment. It never stores the secret.

### `POST /api/v1/device-pairings/:id/status`

Same device. Body `{}`.

| `status` | Body |
| --- | --- |
| `created` / `committed` | `{ status, pairing_id, expires_at }` — no proof, no secret |
| `approved` | `{ status, pairing_id, expires_at, approval: { payload, proof } }` until consumed or expiry |
| `rejected` / `expired` / `consumed` | `{ status, pairing_id, expires_at? }` — no proof replay after `consumed` |

`payload` is JSON with `v: 1`, `pairing_id`, `instance_id`, `origin`, `device_fingerprint`,
`root_sha256` (hex), `owner` (`{ kind, claimant_id }` or `{ kind, user_id }`), `approved_at`
(unix), `expires_at` (unix). `proof` is 64 hex. PEM may be omitted here; the client already has it
in the receipt from create. If present it must match `root_sha256`.

### `POST /api/v1/device-pairings/:id/complete`

**Strict TLS only** (normal extra-CA / default store). Same device, body `{}`. Marks
`consumed_at`. Idempotent if already consumed by this device. Bootstrap must not call this
(client destroys the bootstrap agent first). Missing proof verification on the client is not
healed by complete: complete is cleanup, not a trust gate.

### `POST /api/v1/devices/:id/bind` (existing, extended)

Still `active`+`admin`. Owner remains **exactly one** of `bind_to_self: true`, `claimant_id`,
`claimant_display_name`.

If this device has any `device_pairings` row, bind **additionally** requires `pairing_id` and
`pairing_secret`. Missing → `400 invalid_body`. Wrong secret → `403 { "error": "pairing_secret_invalid" }`
(constant-time). Eight failures → attempt `rejected`, subsequent bind `409 pairing_secret_invalid`
until the claimant starts a new pair.

Legacy pending devices (trusted-TLS MCP upsert, **no** pairing row) keep today’s bind body.
Publishers still cannot bind.

Success envelope is unchanged: `{ ok: true, device_id, owner }`. No forge token. No automatic
claim. Audit `电脑授权` details may add `pairing_id` but never the secret, commitment, proof, or
PEM.

The bind transaction (one SQLite transaction) must:

1. Re-read the live pending device and the committed, unexpired pairing row.
2. Constant-time verify `HMAC-SHA256(secret, SHA-256(transcript))` equals the stored commitment,
   after rebuilding the transcript from stored fields (not from the client).
3. Apply the existing owner / `max_devices` rules.
4. Set `devices.status='active'` with owner, `paired_at`, `expires_at`.
5. Persist approval payload + proof, `approved_at`, status `approved`.
6. Write `电脑授权`.

If any step fails, no active binding and no proof.

### Rotation preflight

`POST /api/v1/device-trust/next-root` — **strict TLS + active device proof**. During overlap
returns `{ "root_pem", "root_sha256", "trust_epoch" }`. If no next root: `404 { "error": "not_found" }`.
Pending devices cannot call it (`202 authorization_required`).

## Schema

`device_pairings` is **not** a second authorization authority. `devices.status` / owner remain
the only authorization fact.

```text
device_pairings
  id                 INTEGER PK
  pairing_id         TEXT UNIQUE NOT NULL    -- kpr_ + 32 hex
  device_id          INTEGER NOT NULL        -- FK devices.id
  protocol_version   TEXT NOT NULL          -- kaola-pairing/1
  client_nonce       BLOB NOT NULL          -- 32
  server_nonce       BLOB NOT NULL          -- 32
  origin             TEXT NOT NULL        -- normalized origin
  instance_id        TEXT NOT NULL
  root_sha256        TEXT NOT NULL          -- 64 hex
  commitment_hex     TEXT                   -- 64 hex, null until commit
  status             TEXT NOT NULL        -- created|committed|approved|consumed|rejected|expired
  approval_payload   TEXT                   -- JSON, null until approved
  approval_proof     TEXT                   -- 64 hex
  failed_attempts    INTEGER NOT NULL DEFAULT 0
  created_at         INTEGER NOT NULL
  expires_at         INTEGER NOT NULL
  approved_at        INTEGER
  consumed_at       INTEGER
```

Partial unique: at most one live (`created`/`committed`/`approved`, `expires_at > now`) row per
`device_id`.

`app_settings(k TEXT PRIMARY KEY, v TEXT NOT NULL)` stores `instance_id`.

No pairing secret column. No private-key column. No forge token column.

Pending list (`GET /api/v1/devices/pending`) may add
`{ pairing_id, pairing_expires_at, requires_pairing_secret: true }` when a live committed
attempt exists. It still never includes the secret, commitment, proof, PEM, or public key.

`GET /api/v1/agent/whoami` for an active device additionally returns `instance_id`. Pending
whoami remains `202 authorization_required`. No forge token.

## Client

### `kaola-mcp pair --url <https-origin>`

Not an MCP tool. HTTPS only (http loopback is not a private-CA pairing target).

1. Ensure `device.json` (existing Ed25519).
2. Generate `client_nonce` (32) and pairing secret (≥16). Write a `0600` receipt **before** the
   first network call so a crash is recoverable.
3. Try **default strict TLS** to `origin` (plus v2/v1 extra CA if already ready for this origin).
   Success with public CA → do **not** install a private root; exit explaining pairing is not
   required.
4. Only if the strict failure is unknown-issuer class (below) start a **one-shot bootstrap
   agent**:
   - not process-global `NODE_TLS_REJECT_UNAUTHORIZED`
   - not a documented `--insecure`
   - still enforce hostname/SAN, expiry, not-before, and “is a well-formed cert”
   - only `POST` the three pairing URLs (+ nothing else)
   - no cookies, no forge token, no Task bodies, no `/api/mcp`
5. Validate advertised `root_pem` with the existing CA-only rules and `root_sha256`.
   Client `--url` origin must equal descriptor `origin`. `instance_id` is stored, not trusted
   yet.
6. Commit, display the secret and fingerprint / pairing id, poll status (same bootstrap).
7. On `approved`, rebuild transcripts from the receipt (not solely from the payload), verify
   proof, check owner/expiry/device/origin/instance/root.
8. Atomically write v2 trust (temp files + rename). Destroy the bootstrap agent.
9. Open a **new** strict TLS connection with that extra root (add to the default store, do not
   replace, do not disable verification). Verify chain, SAN, validity.
10. `GET /api/v1/agent/whoami` on that connection: `status: 'active'`, same fingerprint, same
    `instance_id`. No token in the body.
11. Only then is trust **ready**. Delete the pairing secret from disk (delete the whole receipt).
    `complete` over strict TLS is cleanup.

`kaola-mcp pair --url <origin> --cancel` deletes the local receipt and does not revoke the
server attempt (admin can ignore an expired pending device).

Restart recovery: if a receipt exists for that origin digest and is unexpired, reuse secret,
nonces, and pairing id; `POST` create recovers the server row.

### Typed `pairing_required`

`kaola-mcp --url` never waits for an admin. On HTTPS unknown-issuer without v2 (and without a
usable v1 extra CA) it prints a stable machine line and Chinese hint, then exits non-zero
(`2`):

```text
pairing_required
运行: kaola-mcp pair --url <origin>
```

It must not start the stdio MCP bridge.

### Bootstrap TLS classification

Enter bootstrap only for:

- `UNABLE_TO_GET_ISSUER_CERT`
- `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`
- `SELF_SIGNED_CERT_IN_CHAIN`
- `DEPTH_ZERO_SELF_SIGNED_CERT`

Fail closed, no bootstrap, for at least:

- hostname / SAN mismatch (`ERR_TLS_CERT_ALTNAME_INVALID` and equivalent)
- `CERT_HAS_EXPIRED` / `CERT_NOT_YET_VALID`
- malformed certificates, wrong TLS version, protocol errors
- `NODE_TLS_REJECT_UNAUTHORIZED` already `0`/`false` in the caller environment
- `--insecure` / `-k` argv

After bootstrap, those sockets are destroyed before the strict reconnect. A later unknown-issuer
on the strict connection is a hard failure, not a second bootstrap.

### Local receipt (ephemeral)

`$KAOLA_HOME/pairings/<origin-digest>/receipt.json` (dir `0700`, file `0600`, atomic write).

May contain normalized origin, pairing id, instance id, device fingerprint, both nonces, secret,
commitment, root PEM, root SHA-256, expiry. Receipt `expires_at` **is** the server pairing
`expires_at` (≥24h from that create). A local 15-minute or 900-second wait is not a valid expiry.
Must not contain the device private key (it stays in `device.json`), forge tokens, Task data,
cookies, or MCP session ids.

Delete on success, cancel, or **server** expiry (`now >= expires_at`). POSIX modes are not
enforced on win32; contents still must not leak into logs.

### v2 trust (durable)

```text
$KAOLA_HOME/trust/v2/<origin-digest>/
  root-ca.pem     0600   one public CA (overlap: two CERTIFICATE blocks, old then new)
  state.json      0600
```

```json
{
  "v": 2,
  "alg": "sha256",
  "originDigest": "<64 hex>",
  "instanceId": "<uuid>",
  "deviceFingerprint": "<64 hex>",
  "fingerprintSha256": "<64 hex of the current extra root, or of the new root during overlap>",
  "previousFingerprintSha256": "<64 hex or omitted>",
  "trustEpoch": 1,
  "pairedAt": 1700000000
}
```

v2 state contains **no** literal origin, pairing secret, private key, forge token, or Task
data. `originDigest` is `sha256(origin utf8)` using the same origin string as the transcript.

Launcher `kaola-mcp --url` resolution order:

1. If v2 for this origin digest is present, it must verify (PEM ↔ fingerprints, device
   fingerprint matches `device.json`, PEM still a CA without private keys). Then inject **that**
   PEM path into the child `NODE_EXTRA_CA_CERTS`. Caller env is still not a trust source.
2. Else if v1 `$KAOLA_HOME/trust/root-ca.pem` + `state.json` `v: 1` is ready, keep the Issue #48
   path. This is explicit operator compatibility, never advertised as approval-bound.
3. Else public default (no extra CA). Unexpected caller `NODE_EXTRA_CA_CERTS` still fail
   closed.

v1 files are never rewritten in place as `v: 2`. A successful pair writes v2 beside them.

Ready trust is forbidden until proof verification **and** the new strict TLS + active whoami
succeed. A failed strict reconnect must not leave a half-written v2 directory (rename is the
commit).

### “No restart” vs v1

v1 `trust install` still requires the operator to restart an already-running MCP host so a new
bridge process can pick up extra CA.

`pair` itself performs install + new strict connection + whoami in-process. The claimant does
not run `trust install`, does not set env, and does not restart `pair`. Starting `kaola-mcp
--url` afterwards is the first MCP launch, not an in-pairing restart. `--url` remains
noninteractive and does not hot-reload roots.

## Rotation and public-CA migration

Overlap (already-paired v2 client):

1. Admin deploys `KAOLA_NEXT_PUBLIC_ROOT_CA_PATH` while the terminator still serves the old
   leaf.
2. Client, over **old** strict TLS + active device proof, `POST /api/v1/device-trust/next-root`.
3. Client atomically writes old+new PEM (two blocks) and bumps `trustEpoch` /
   `previousFingerprintSha256`.
4. Operator switches the leaf to the new CA.
5. Next strict connection must prove the **new** chain (SAN, validity). Only then may the
   client drop the old root.

Missed overlap (unknown issuer again): `pairing_required`. No insecure resume. Admin approval
pairing runs again.

Public-CA migration: prove a strict connection to the **same** origin with the **default store
only** (no extra CA), `whoami` active + matching device fingerprint + `instance_id`, then delete
the v2 extra root for that origin digest. Do not silently remove OS/browser roots. Claimant-only
machines never need elevation.

`--url` may complete this migration automatically when default-store proof succeeds; it must not
install anything. `kaola-mcp trust uninstall` remains the operator hammer and still must not
delete `device.json` or Claim receipts.

## Workbench (Chinese)

电脑 → 待授权电脑, for rows with `requires_pairing_secret`:

- show hostname, fingerprint, pairing id, pairing expiry
- input placeholder `配对密语` (`data-testid="device-bind-pairing-secret"`)
- existing owner controls + 绑定 / 绑到我自己
- never render an expected secret, commitment, proof, or PEM
- wrong secret shows a generic Chinese error, not the stored commitment

Publishers still see no bind controls.

## Errors (machine `error` codes)

| Code | HTTP | When |
| --- | --- | --- |
| `pairing_required` | client exit `2` | `--url` private CA, not paired |
| `pairing_mode_disabled` | 404 | pairing REST while mode off |
| `invalid_body` | 400 | missing/invalid fields |
| `unauthorized` | 401 | bad device proof |
| `forbidden` | 403 | non-admin bind; revoked |
| `pairing_secret_invalid` | 403 | wrong secret / locked out |
| `pairing_commitment_mismatch` | 409 | second distinct commitment |
| `pairing_expired` | 409 | attempt past `expires_at` |
| `pairing_proof_invalid` | client fail-closed | proof/MAC mismatch |
| `conflict` | 409 | already active; max devices; not pending |
| `authorization_required` | 202 | pending whoami / MCP (unchanged) |
| `device_expired` | 403 | existing idle/expiry |

Client-only (stderr, non-zero): `strict_tls_failed`, `whoami_not_active`,
`trust_origin_mismatch`, `trust_instance_mismatch`, `trust_device_mismatch`. None of these write
ready trust.

## Failure assertions (acceptance, later missions)

These are frozen now so implementation cannot weaken them to get green:

1. Fresh generic client: `pair` → admin secret on 电脑 → strict whoami → MCP
   `initialize` / `list_tasks`. Claimant never supplied PEM, fingerprint, env, or an MCP restart.
   Pending before bind still cannot `list_tasks` / `claim_task`.
2. Client restart and server restart recover the same unexpired attempt. Repeated create /
   commit / status / bind are idempotent and **do not slide** `expires_at`. One active binding.
   Bind/recover succeed for the whole `[created_at, expires_at)` interval (at least 24 hours).
   An already-pending device that starts pair keeps a ≥24h pairing window from that request;
   pending is extended if it would otherwise expire first. After bind, device authorization
   is still `device_max_age_days` (default 30), not the pairing TTL.
3. Wrong secret, root/instance/origin/device/nonce substitution, expiry, replay, non-admin
   approval, and fake bootstrap all fail closed; trust bytes unchanged.
4. Pairing routes cannot read or claim tasks or touch credential plaintext. Responses, logs,
   and `events.details` pass a secret scan (no pairing secret, no private-key PEM, no forge
   token).
5. Final reconnect checks chain, SAN, and validity. Only unknown-issuer class enters bootstrap.
   Public CA does not install an extra root.
6. v1 remains loadable and is never disguised as v2. v2 binds origin digest, instance, and
   device.
7. Overlap rotation, missed-overlap re-pair, and public-CA migration have focused proofs.
8. macOS / Windows / Linux package-bin UAT and live browser/OAuth are recorded only for
   environments actually executed.
9. Three-forge behavior, Claim lifecycle, and token containment regressions stay green.
10. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check` pass before UAT.

Physical, browser, service, and user UAT are **not** claimed by design freeze.

## Unchanged product contracts

- MCP tool inventory and Claim/Lease semantics
- Device Ed25519 proof canonical string (`kaola-device-v1`)
- Token reveal channels: REST claim `201` and MCP `claim_task` success only
- Task status Chinese enum
- Server does not run Agent / Workflow / Runner / git / worktree
- `STABLE_PUBLIC_CA` default trust (no extra CA)
- System/browser trust remains explicit elevation, never silent

## Contradiction handled

§16.4 previously forbade using a CA obtained from `<kaola-origin>` as a trust anchor. That
prohibition still holds as **install-time** TOFU. Bootstrap may **carry** the advertised public
root as untrusted data. Installation happens only after admin-bound proof verification and the
new strict chain check. The operator v1 fingerprint path is unchanged for recovery.

The first freeze of this ADR used pairing TTL default `900` (range 300–3600). The owner
corrected that on 2026-09-09: keep the attempt at least one day, matching DESIGN §7 / §10
pending (1 day). The 900s draft is void. Bound-device default remains 30 days and is not that
clock.

## Implementation order

1. This freeze (no product behavior change except documentation).
2. Failure-first tests, then server pairing state / REST / admin transaction / Chinese UI.
3. `kaola-mcp pair`, receipt, v2, strict handoff.
4. Restart / replay / legacy / rotation / public-CA harness.
5. Independent security review of the candidate.
6. Full repo validation and a UAT-ready checklist. No fake UAT PASS.
