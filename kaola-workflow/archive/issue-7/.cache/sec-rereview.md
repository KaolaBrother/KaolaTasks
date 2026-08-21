# Security re-review — issue #7 repair delta (F1 / F2 / F3)

Reviewer: security-reviewer. Read-only. Product files were not edited.

**Scope:** the repair delta in `apps/server/src/tasks.ts` against original findings F1/F2/F3, plus `apps/web/src/App.vue` only for whether the form re-breaks the server credential invariant.

**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`

**Method:** static read of the POST handler (bind → decrypt → fetch → audit order, column names, `insertTokenRevealEvent` payload), `credential-profiles.ts` / `schema.ts` / `vault.ts` / `packages/forge-adapters` `apiUrl`, and `App.vue` `createTask`. Then a read-only live PoC (`/tmp/kaola-sec-rereview-poc.mts`) against real `buildApp()` with two loopback HTTP sinks and native `fetch` for forge calls (OAuth userinfo still stubbed). Unit tests were not re-run; this pass is bypass-hunting, not a test-suite echo.

**Orchestrator rulings honoured (not re-opened as blocking):** RFC1918 / loopback are allowed; residual blind SSRF with the *caller's own* inline token, and on a matching profile to that profile's own forge, is accepted for #7. No host allowlist / `redirect: 'manual'` demand (adapter-layer, global).

**Verdict: pass.** F1, F2 (at the accepted bar), and F3 are closed. No new in-scope hole that restores stored-token exfiltration, writes token material into `events.details`, or re-breaks `{profile_id}` XOR `{token}`.

---

## F1 — CLOSED — profile-to-repo binding holds; original exfil does not reproduce

**Original:** `POST /api/v1/tasks` decrypted any profile and sent plaintext to caller-controlled `base_url` (forge lie `gitlab` profile → `gitea` + attacker origin).

**What the repair does (verified in source):** after body parse and the dedicated URL gate, the profile row is loaded; missing → 400 `所选凭证档案不存在。`. Then exact `===` of `input.repo.forge` / `input.repo.baseUrl` / `input.repo.fullName` against `profile.forge` / `profile.baseUrl` / `profile.repoFullName` (schema columns `forge`, `base_url`, `repo_full_name` — not `token_encrypted`). Mismatch returns 400 `所选凭证档案与仓库不匹配。` **before** `decryptToken`. No `insertTokenRevealEvent`, no adapter/`fetch`. Decrypt uses the already-fetched row's ciphertext; outbound `createForgeAdapter(input.repo.forge, { baseUrl: input.repo.baseUrl })` therefore cannot target a host that failed the triple match.

**Live PoC (native fetch, attacker sink on `127.0.0.1`):**

| probe | HTTP | attacker received victim plaintext |
|---|---|---|
| Original F1: gitlab profile `https://gitlab.internal.example` + `gitea` + attacker `base_url` + `full_name: anything/at-all` | 400 mismatch | **no** (0 hits, 0 outbound forge fetches) |
| GitHub-forge lie: github PAT profile `https://github.com` + `gitea` + attacker URL | 400 mismatch | **no** |
| Trailing slash / `HTTPS://` case / userinfo `stolen@host` / userinfo `gitlab.internal.example@attacker` / `full_name` `%2F` / matching forge+url different `full_name` | 400 mismatch | **no** |
| Encoded host `https://gitlab.internal.example%2f` | 400 URL gate (`仓库地址不是合法的…`) | **no** |
| `profile_id` numeric string of victim + attacker repo | 400 mismatch (id accepted; binding still applied) | **no** |
| `profile_id` float (`id+0.1`) | 400 generic `invalid_body` | **no** |
| `{profile_id, token}` both set | 400 generic `invalid_body` | **no** |
| Control: profile whose stored URL **is** the attacker sink, request matches all three | 201 | own token yes; **victim token no** |

Bypass attempts that fail closed (string `===`, not origin-normalization):

- **Trailing slash / case / encoding:** request string ≠ stored string → mismatch, no decrypt. Not an exfil path.
- **GitHub-forge lie:** `forge` must `===` `'github'`. `apiUrl` for github is pinned to `https://api.github.com` anyway; the lie that made a GitHub PAT ride a gitea `base_url` is gone.
- **`profile_id` type confusion:** `readProfileId` accepts integer `> 0` or `/^\d+$/` strings and then binds; floats/`both keys` never reach decrypt. Inline XOR cannot name a stored profile.
- **Decrypt-before-check:** control flow is missing → mismatch return → `decryptToken`. Mismatch PoC recorded **zero** outbound URLs, so plaintext did not leave via `fetch`.
- **Inline token to steal a stored profile:** `readCredential` rejects unless exactly one of `profile_id` / `token` is present. Confirmed: both keys → 400, attacker sink never saw `VICTIM_TOKEN`. An inline POST to the attacker sink with the *caller's* token is residual F2 (own token), not vault theft.

**Parser vs fetcher:** `isHttpOrHttpsUrlWithHost` uses `new URL`; adapter `fetch` uses the raw string. A bypass would need the **same** raw string to match the profile **and** resolve to a different host than the profile owner intended. Exact `===` makes “looks like the profile host, fetches elsewhere” require a *different* request string, which is a mismatch. Decimal/octal/hex IPv4 (`http://2130706433` parses as `127.0.0.1`) also fails `===` against a profile stored as `http://127.0.0.1`. Fail closed.

**TOCTOU:** no profile PATCH; only create/delete. The handler binds and decrypts the in-memory row already selected. Another request cannot retarget that ciphertext to a new `base_url` mid-handler.

**Wrong-column check:** a swapped compare (`fullName` vs `baseUrl`) would 400 the happy path. Matching-profile 201 delivered `MATCH_TOKEN` to the profile's own sink and wrote `full_name: "team/orders"` in the audit row — columns are the intended three.

Missing vs mismatch remain distinct Chinese messages. That split is already public via `GET /api/v1/credential-profiles` (ids + forge + `base_url` + `repo_full_name`). Not a new leak.

---

## F2 — CLOSED at the accepted bar — scheme+host gate landed; residual blind SSRF not re-opened as blocking

**Original:** any non-empty `base_url` string reached the adapter (file / javascript / schemeless / empty host), plus an internal reachable-vs-closed oracle.

**What landed:** `readRepo` still accepts any non-empty string (generic `invalid_body` if missing). POST then applies `isHttpOrHttpsUrlWithHost`: `new URL` must succeed, protocol `http:` or `https:`, `hostname !== ''`. Failure is a **dedicated** 400 `{error:'invalid_body', message:'仓库地址不是合法的 http 或 https 地址。'}` — not folded into generic parse failure. Verified: `file://example.com/tmp` is `file:` + host `example.com` and is rejected by the scheme allowlist (empty-host-only would have missed this). PoC: `file:` → 400 that message, no forge hit.

Node 22 probes (same predicate): `javascript:`, `ftp:`, `ws:`, schemeless `gitea.example`, `https:///`, CRLF-injected URLs fail the gate. `http://127.0.0.1`, `[::1]`, `169.254.169.254`, decimal/hex/octal IPv4 forms that parse as loopback **pass** — accepted residual.

**Surviving F1 on the inline path (accepted residual, not a new CRITICAL):** an `active`+`full` member can still point `credential: { token: <their own> }` at any http(s) host with a hostname. The sink PoC showed the caller's `INLINE_TOKEN` arriving on a loopback gitea-shaped server (201). Reachable-vs-closed (`502` vs `422`) for those URLs is unchanged. Binding does not apply on this path by design. Do not demand an allowlist or `redirect: 'manual'` here.

---

## F3 — CLOSED — `token 揭示` on profile decrypt; no token material in `details`

**When written:** only after **successful** `decryptToken` on the profile path, then once per request on 201 / 422 / 502:

- 502: `validateToken` throw → `outcome: 'forge_unreachable'`
- 422: `check.missing.length > 0` → `outcome: 'token_check_failed'`
- 201: before `insertTask` → `outcome: 'ok'`

`type` is `'token 揭示'`. `actorUserId` is the poster. `details` is exactly `{ profile_id, forge, base_url, full_name, outcome }` with `profile_id` = DB PK (`profile.id`), not the brief string form. No `agent_key_id`. `insertAuditEvent` only `JSON.stringify`s that object (`vault.ts`).

**Not written:** F1 mismatch (PoC reveal count 2 → 2), missing profile, generic `invalid_body`, URL gate, `vault_unconfigured` (decrypt throws before fetch), inline-token path (PoC 201 left reveal count unchanged).

**Token material:** PoC dump of every `token 揭示` row contained neither `MATCH_TOKEN` / `VICTIM_TOKEN` / GitHub PAT nor ciphertext. `base_url` in details is the request string, which after `===` equals the profile's already-public `base_url`.

**Inline path:** encrypts the caller-supplied token into `inline_token_encrypted` and writes no reveal event — correct for “stored vault token decrypted”.

---

## New holes introduced by the repair

None blocking.

Checked specifically:

- **Audit on mismatch:** no.
- **Wrong bind columns:** no (happy-path token landed on the matched origin).
- **TOCTOU rebind:** no update API; in-memory row.
- **Missing vs mismatch oracle:** pre-existing public metadata; URL-invalid now fails *before* lookup, which reveals *less*.
- **Decrypt then crash before audit:** if `validateToken` never returns, the outcome-bearing event is missing. Same class as any audit-after-I/O; the spec requires `outcome`, so the write must sit after the check. Not a token leak.
- **Web form (`App.vue`):** in scope only for the server invariant. `createTask` sends `{ profile_id }` **or** `{ token }` from `taskCredentialMode`, never both, never a stored secret. `ProfileRow` has no token field; list UI prints `id / forge / repo_full_name / base_url` only. Profile create clears the password input and says the token will not be shown again. Successful publish clears the inline token input. The form does **not** auto-copy the selected profile's forge/`base_url`/`full_name` into the repo fields — a mismatch is a 400 from the server, not a decrypt. That does not re-break the invariant.

---

## Residual (accepted for #7 — not findings)

- Blind SSRF + reachable-vs-closed oracle on **http(s)** targets, including loopback / RFC1918 / link-local / decimal IPv4, using the caller's **own** inline token, and using a **matching** profile toward that profile's stored origin.
- Adapter still follows redirects; GitLab `PRIVATE-TOKEN` is not stripped on cross-origin redirect (`forge-adapters` `forgeGet`). Out of issue scope per ruling.
- Exact `===` is fail-closed for aliases (`http://x` vs `http://x/`, `HTTPS://`, IDN vs punycode). Availability, not exfil.
- Client trims task `base_url` but profile create does not — a trailing space on a stored profile 400s at bind. Fail closed.

---

finding: id=R1 scope=in_scope action=fix status=closed severity=critical fix_role=security rationale=F1 closed: exact forge/base_url/full_name bind before decryptToken; original gitlab→gitea attacker PoC and github-forge lie reproduce as 400 mismatch with zero victim plaintext on the attacker sink
finding: id=R2 scope=in_scope action=fix status=closed severity=medium fix_role=security rationale=F2 closed at accepted bar: dedicated http(s)+hostname 400 rejects file/javascript/schemeless/empty-host; residual http(s) blind SSRF with caller-owned inline token is in-scope accepted, not re-opened
finding: id=R3 scope=in_scope action=fix status=closed severity=medium fix_role=security rationale=F3 closed: token 揭示 with pinned details on profile-path 201/422/502; omitted on mismatch and inline; events.details contained no plaintext or ciphertext in live dump

verdict: pass
findings_blocking: 0

review_conclusion: The repair closes stored-token exfiltration. Decrypt and outbound fetch of a vault token now require an exact match to that profile's forge + base_url + repo_full_name, so a caller-controlled origin cannot ride another profile's ciphertext; the original F1 PoC and the github-forge lie return 400 with no attacker-sink hit. Scheme+host validation stops non-http(s) adapters without touching accepted internal http(s) SSRF. Profile decrypts are audited as token 揭示 without token material. The web form preserves {profile_id} XOR {token} and never redisplays stored forge tokens. Residual blind SSRF remains on the inline path by product ruling, not as an open finding.
