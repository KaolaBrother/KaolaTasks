# Evidence-binding header (do not modify above this line)
project: issue-23
issue: 23
surface: device identity + closed join + stdio MCP bridge
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23
# End evidence-binding header

# Security review — issue #23 (device identity + closed join + stdio MCP bridge)

Reviewer: security-reviewer. Read-only. Product files were not edited. The only write is this file.

**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`

**Scope (candidate-caused only):** `apps/server/src/device-proof.ts`, `devices.ts`, `auth.ts`, `claim.ts`, `mcp.ts`, `claim-confirmations.ts`, `schema.ts`/`db.ts` (devices/claimants/revoked/device_id), `agent-keys.ts` (whoami moved off Bearer); `packages/shared/src/device-proof.ts`; `apps/mcp/src/main.ts` + `apps/mcp/examples/mcp.json`; `apps/web/src/App.vue` bind/电脑 pane. Tests used as pins of intended HTTP shapes, not as a defect surface. #22 clone four keys and two-task decrypt were checked only to confirm they were not reopened.

**Trust model honoured (not a defect):** forge plaintext is returned only on REST claim `201` top-level `token` and MCP `claim_task` success `token` to an already-bound active device. Unpaired valid Ed25519 proof must `202 authorization_required` (pending insert) rather than `401`. Missing/invalid proof is `401`. Closed join: uninvited OAuth does not insert; revoked is not revived by re-login; GitLab/Gitea are not auto-full; `KAOLA_ADMINS` plus first-full bootstrap. Bind does not claim and does not return a forge token. Stdio bridge may show `command` + URL; private key on disk mode `0600` is allowed.

**Method:** full read of the candidate plus callers (claim/MCP hooks, bind/revoke, OAuth upsert, stdio forwarder, Vue bind handler, `taskBrief`, Fastify `Fastify()` with no logger). Walked OWASP classes against attacker-reachable paths. No product file was modified.

**Verdict: PASS.** No candidate-caused finding admitted.

---

## Admitted findings

None.

---

## Checked and clean — forge token only on claim 201 / claim_task success

Primary anchors: `claim.ts:107-154` (403/409/202 confirmation all return before decrypt); `claim.ts:164-251` (decrypt then `201` `{ task, token, lease, clone }`); `mcp.ts` device-proof hook then `claimTask`; `taskBrief` at `tasks.ts:378-415` (credential is `{ inline: true }` or `{ profile_id }`).

- **Unpaired / pending device:** hook returns `202` `{ error: 'authorization_required', pending: true, expires_at }` in `device-proof.ts:44-49` and `:217-220` before any claim handler. No decrypt. No `token` key.
- **#16 confirmation `202`:** `claim.ts:138-145` returns `pendingConfirmationBody()` (`error: 'confirmation_required'`) before `decryptToken`. Distinct from device `authorization_required`.
- **whoami:** `devices.ts:346-365` after the same hook; body is `device_id`, `fingerprint`, `hostname`, `status: 'active'`, `owner`. Pending never reaches the handler (hook 202). No forge token, no private key.
- **Device list / pending / claimants:** `pendingJson` / `deviceJson` (`devices.ts:48-69`) expose id, hostname, fingerprint, timestamps, owner ids/names. No `public_key`, no PKCS8, no PAT.
- **Bind `200`:** `devices.ts:261-265` `{ ok: true, device_id, owner }` only. No claim call, no decrypt.
- **Audit `events.details`:** bind `{ device_id, fingerprint, claimant_id|user_id }` (`devices.ts:251-258`); claim reveal `{ task_id, device_id, credential, profile_id?, claimant_id? }` (`claim.ts:157-192`, `:221-225`). No plaintext, no ciphertext.
- **GET `/api/v1/events`:** `events.ts` JSON-parses stored details; writers never put a PAT there.
- **examples/mcp.json:** `command` + `--url http://localhost:31415` only. No `headers`, no `ktk_`, no `ghp_`/`glpat-`.
- **`~/.kaola` / `KAOLA_HOME`:** stdio writes `device.json` with Ed25519 PKCS8+SPKI (`apps/mcp/src/main.ts:48-68`), `0700` dir / `0600` file. Successful claim JSON is returned to the MCP client and is not written back to `KAOLA_HOME` (`forwardMcpRequest` has no write after fetch).
- **Logger:** `buildApp` uses `Fastify()` with no logger (`app.ts:42`). Device hook does not log headers or bodies.

---

## Checked and clean — unpaired valid signature is 202 with pending insert; missing headers 401; replay/skew

Primary anchors: `device-proof.ts:171-220`; shared canonical `packages/shared/src/device-proof.ts`.

Order of the `preHandler`:

1. Missing `X-Kaola-Key` / `X-Kaola-Ts` / `X-Kaola-Nonce` / `X-Kaola-Sig` → `401 { error: 'unauthorized' }` + `WWW-Authenticate: Kaola-Device` (`:178-179`). No DB write.
2. Non-unix `ts` or `|now-ts| > 300` (`DEVICE_PROOF_SKEW_SECONDS`) → `401`. No insert.
3. Unparseable SPKI → `401`. No insert.
4. Signature fail over canonical `kaola-device-v1\\nts\\nnonce\\nMETHOD\\npathname\\nsha256(body)` → `401` (`:203-204`). **Does not insert pending.**
5. Replay `fingerprint:nonce` in-process map → `401` (`:209-211`).
6. **Valid signature and unknown or `pending` fingerprint** → `upsertPending` then **`202 authorization_required`** (`:217-220`). First insert sets `pending_expires_at = first_seen + 86400`. Retry of a still-live pending only ticks `lastSeen` and **does not refresh** `pendingExpiresAt` (`:132-136`).

Leftover `ktk_` Bearer without device headers is step 1 (`401`), not `202`. Tests pin this (`devices.test.ts` leftover ktk_ on MCP).

Revoked / hard-expired / idle-expired / inactive owner after a valid signature are `403`, not a new pending (`:223-254`). A revoked fingerprint cannot self-requeue via `upsertPending` (that branch is only `null` or `status === 'pending'`).

---

## Checked and clean — closed join

Primary anchors: `auth.ts:175-228` `completeUserLogin`.

- **Uninvited OAuth after a `full` exists:** `invited` false and `countActiveFull !== 0` → redirect `/login?reason=uninvited`, **no insert**, no session (`:206-209`, `:325-326`).
- **Revoked not revived:** existing row updates only `username` / `displayName`; if `status === 'revoked'` redirect, no `session.userId` (`:187-202`). Status is not rewritten to `active`.
- **GitLab / Gitea not auto-full:** all three providers share `completeUserLogin`. No provider branch grants `full`. After bootstrap, uninvited GitLab is the same uninvited path as GitHub.
- **`KAOLA_ADMINS`:** `parseKaolaAdmins` (`:112-132`); `provider:username` or `provider:id:<remote_id>`. Match inserts `active`+`full` even after bootstrap (`:206`, `:212-220`). Empty/unset env parses to `[]` and `registerAuth` still boots (`:334`).
- **First-full bootstrap:** `countActiveFull === 0` allows that one insert as `active`+`full` (`:167-172`, `:207`). `completeUserLogin` has **no `await` between count and insert**; better-sqlite3 is synchronous on one connection, so two overlapping OAuth callbacks cannot both observe zero full rows in-process. Multi-process SQLite is outside this app’s process model.

Leftover `POST /api/v1/users/:id/approve` still sets `status: 'active'` without checking 待批准 vs revoked (`auth.ts:462`). That is an **admin** action, not re-login revival. Not admitted (trusted full actor; product left the approve route).

---

## Checked and clean — bind does not auto-claim; revoke next request

- Bind (`devices.ts:173-265`) requires `active`+`full` session. It only updates the pending device to `active`, sets owner, writes `电脑授权`. It does not call `claimTask`, does not decrypt, does not insert a lease.
- Device revoke sets `status: 'revoked'` (`:275`). Claimant revoke sets claimant `revoked` and all that claimant’s devices `revoked` (`:307-308`).
- The proof hook re-reads SQLite on **every** request (`:215` onward). MCP sessions copy `request.deviceAuth` from the current proof (`mcp.ts` `session.authHolder.auth = auth`) only after the hook succeeds. A revoked device’s next POST is `403` in the hook and never reaches tools.
- User `status !== 'active'` fails the hook (`device-proof.ts:248-249`) even if the device row is still `active`.

---

## Checked and clean — stdio bridge

Primary anchors: `apps/mcp/src/main.ts`, `apps/mcp/examples/mcp.json`.

- Example has no secrets (command + `--url` only).
- HTTP `202` is mapped to a JSON-RPC **error** (`:160-169`): `jsonRpcError(id, message)`. It does not invent `result.token` even if a trap field is present on the 202 body (202 is handled before `if (parsed != null) return parsed`).
- Forge plaintext on a later successful `claim_task` is returned to stdout as MCP protocol (the intended reveal channel) and is not persisted under `KAOLA_HOME`.
- Stderr on 202/401/403 logs `MCP ${errName}` only, not the body.

---

## Checked and clean — web bind trap token

Primary anchors: `App.vue:1520-1543`.

On bind success the handler `await res.json().catch(() => null)` and **discards** the value, then sets `deviceBindMessage` to the literal `'已绑定。'`. Failure messages are status-only (`绑定失败（${res.status}）`). A trap `token` on `POST /bind` cannot be interpolated. Pending rows render `hostname · fingerprint · expires_at` only (`:468-470`). `claim_only` / non-`canApprove` skips pending/bind/claimant GETs (`:457`, `:893`). Login copy does not say GitLab/Gitea auto-full (`:17`).

---

## Checked and clean — #22 clone keys not reopened

`claim.ts:91-96` and `:242-249` still emit exactly `suggested_dir`, `token_usage`, `remote_url`, `extra_header` (Gitea `token ${token}` else `Bearer ${token}`). Envelope remains `task` / `token` / `lease` / `clone`. Two-task decrypt pins in `claim.test.ts` / `mcp.test.ts` were not rewritten as a product change. Not reopened.

---

## Residual / pre-existing / product (not blocking, not admitted)

- **In-memory nonce replay cache** (`device-proof.ts:28`, `:213`): a process restart opens a skew-window replay of a captured signed request. Acceptable for single-process SQLite; not a forge-token leak.
- **`POST /api/v1/agent-keys` still mints `ktk_`** (`agent-keys.ts:63-67`). That is an Agent Key, not a forge PAT. Leftover Bearer is `401` on claim/MCP/whoami, not a second forge-reveal channel. Dead `agent-bearer.ts` is unused by claim/MCP.
- **Admin `approve` can set a revoked publisher to `active`:** admin-only; re-login of revoked still does not revive.
- **Unsigned `X-Kaola-Hostname`:** not in the canonical string. Admin UI also shows fingerprint. Social-engineering of bind-by-hostname is a UX footgun, not a broken signature check.
- **Empty `KAOLA_ADMINS` + first OAuth wins `full`:** product bootstrap, not a candidate defect.
- **Session cookie `secure: false`:** pre-existing.

---

finding: none

verdict: pass
findings_blocking: 0

review_conclusion: Device proof returns 202 with a pending insert for unpaired valid signatures and 401 without insert for missing or invalid headers, forge plaintext stays on claim 201 and claim_task success, closed join does not insert uninvited or revive revoked, bind does not claim or render a trap token, and the stdio bridge does not persist secrets.
