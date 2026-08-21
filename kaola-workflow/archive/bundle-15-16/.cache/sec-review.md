# Evidence-binding header (do not modify above this line)
project: bundle-15-16
issue: 15,16
surface: GET /api/v1/events + GET /api/v1/stats; claim confirmation (autonomous claim 202, trusted_automation, claim_confirmations approve/reject, PUT /api/v1/me/settings); App.vue audit/stats/settings
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16
# End evidence-binding header

# Security review — bundle-15-16 (#15 audit log + team stats, #16 claim confirmation)

Reviewer: security-reviewer. Read-only. No repository or product file was edited; the only write is
this file, below the evidence-binding header.

**Candidate:** uncommitted delta on `workflow/bundle-15-16` @ `637c304`
(`/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16`).
Production: `apps/server/src/events.ts` (new), `claim-confirmations.ts` (new), `claim.ts`,
`mcp.ts`, `auth.ts`, `db.ts`, `schema.ts`, `app.ts`, `apps/web/src/App.vue`.

**Method.** Full read of the production delta and of every surrounding seam it depends on
(`getSessionUser` / `sendUnauthorized` and the `@fastify/session` cookie options in `auth.ts`,
`addAgentBearerHook` in `agent-bearer.ts`, `insertAuditEvent` in `vault.ts`, `toToolResult` in
`mcp.ts`, `canManageProfiles` in `credential-profiles.ts`). Enumerated **all eight**
`insertAuditEvent` writers plus a `db.insert(events)` grep to establish what the new events GET can
actually surface. Then wrote my **own** probe suites outside the repo
(`/tmp/kaola-sec-probe/probe.test.ts`, `/tmp/kaola-sec-probe/mcp-probe.test.ts`, 6 tests, all
passing) against a real `buildApp()` — I did not rely on the candidate's own
`claim-confirm.test.ts` / `events.test.ts` to judge the token rule. Repo gates run in-session:
`pnpm lint` exit 0, `pnpm typecheck` exit 0, `pnpm test` 502 server tests + 75 web tests, 0 fail.

**Verdict: PASS.** No candidate-caused security defect at high confidence. Three non-blocking
observations are recorded below; all three are ruling-accepted design properties or follow-up
hardening, none is a regression of an existing control.

---

## OWASP walk — what was measured

### A01 Broken access control / IDOR — clean

Every one of the five new session routes derives identity from `request.session.userId` only, and
the two `claim_confirmations` mutators scope the row by owner in SQL, not after the fetch:

- `approve` selects with `and(eq(id), eq(userId, user.id))` (`claim-confirmations.ts:142`) and 404s
  when that misses; `reject` puts the same `and(...)` inside the `UPDATE ... RETURNING`
  (`claim-confirmations.ts:166`), so a non-owner's write affects **zero rows** rather than being
  filtered afterwards. `GET /api/v1/claim-confirmations` filters `eq(userId, user.id)`.
- Probed live with two real logged-in users: Bob's `approve` and `reject` against Alice's
  confirmation id both returned **404**, and Alice's row was still `pending` afterwards. Bob saw
  `confirmations: []`.
- `PUT /api/v1/me/settings` writes `where(eq(users.id, user.id))` — no id is read from the request.
  Probed mass assignment: `{ trusted_automation: false, permission_level: 'full', status: 'active',
  id: 999 }` changed **only** `trusted_automation`; `id`, `status`, `permission_level` were
  untouched in the sqlite row.
- `id` path params go through `parsePositiveInt` and then Drizzle `eq` (parameterised), so there is
  no injection or `NaN`-matches-everything case; `id == null` catches the `undefined` return.
- Trust is per-user and not transitive: probed that Bob turning **his** `trusted_automation` on
  leaves Alice's `GET /api/v1/me` at `trusted_automation: false` and her next autonomous claim
  still **202**. 受信自动化 grants nothing to any other user, and the flag never widens which token
  a claimer would have received anyway.
- 待批准 lockout probed on **all six** new entry points — `GET /api/v1/events`, `GET /api/v1/stats`,
  `GET /api/v1/claim-confirmations`, `POST …/approve`, `POST …/reject`, `PUT /api/v1/me/settings` —
  each **401** for a real GitHub 待批准 session, and 401 unauthenticated. `events.ts` gates 待批准
  deliberately (`canReadEvents`), stricter than `GET /api/v1/tasks`, matching the ruling.
- Bearer and session contexts stay separate: `registerEvents` / `registerClaimConfirmations` are
  called on `app` in `app.ts`, while `addAgentBearerHook` lives inside the encapsulated
  `app.register(async function … child)` scopes of `registerClaim` / `registerMcp`, so the new
  session routes are not reachable with an Agent key and vice versa.

### A02 / token secrecy — the standing repo rule holds on both revealing surfaces

The gate sits at `claim.ts:120-135`, **before** any `decryptToken` call (`claim.ts:137-177`), before
the status update, and before `insertActiveLease`. Measured end-to-end rather than read:

| probe | result |
|---|---|
| REST autonomous claim, trust off, unconfirmed | **202**, body `{error:'confirmation_required',message,pending:true}`; no `token`/`token_encrypted`/`inline_token_encrypted`/`access_token` key at any depth; fixture plaintext absent |
| task status after that 202 | still `待认领` |
| events after that 202 | contains `认领待确认`, contains **no** `token 揭示` |
| idempotent re-request while pending | 202 again, exactly **one** `pending` row |
| `approve` response + task after approve | 200, no secret keys, task still `待认领`, no lease |
| retry autonomous after approve | **201** with the real token (intended) |
| release, then autonomous re-claim | **202** again — the consumed approval cannot be replayed |
| MCP `claim_task {autonomous:true}` | `isError` false, `structuredContent.pending === true`, `error: 'confirmation_required'`, `token` **undefined**; full SSE/JSON body scanned clean |
| `GET /api/v1/events`, `/api/v1/stats`, `/api/v1/claim-confirmations`, `/api/v1/me`, settings 200 | all clean of the four secret key names and of the fixture token, including after a genuine 201 reveal happened |

Replay resistance is real, not nominal: `consumeApprovedConfirmation` **deletes** the row
(`claim-confirmations.ts:68-70`) rather than parking it in a state that a later `find` could still
match, and the release-then-reclaim probe confirms the second attempt parks again.

The events feed cannot carry a token by construction, not just by test: all eight
`insertAuditEvent` writers were enumerated and every `details` payload is metadata only —
`{task_id, agent_key_id, credential, profile_id}` (claim reveal), `{task_id, from, to, pr_url,
summary}` (transitions), `{task_id, note}` (heartbeat), `{action, profile_id}` (变更),
`{task_id, transition, ok, issue_url}` (回写), `{profile_id, forge, base_url, full_name, outcome}`
(publish-time validation), and the two new `{task_id, agent_key_id}` rows. No writer has ever put
plaintext in `details`, so `GET /api/v1/events` re-serving `JSON.parse(details)` adds no channel.
`parseDetails` also fails closed to `{}` on malformed or non-object JSON instead of echoing the raw
TEXT column.

### A03 Injection / A07 Auth — clean

All new SQL is Drizzle builder with bound parameters; there is no string concatenation and no raw
`prepare` in the new code. The new `ALTER TABLE` and `CREATE TABLE` are static literals. Bearer
auth is unchanged and still constant-time (`timingSafeEqual` in `agent-bearer.ts`). The gate reads
`auth.user.trustedAutomation` from a user row re-selected in the `onRequest` hook on **every**
request, so toggling trust off takes effect on the very next claim — no cached trust decision. If
that column were ever absent the expression `!auth.user.trustedAutomation` fails **closed** (gate
applies), which is the safe direction.

### A04 Insecure design — the gate is advisory by ruling, and that is a widening of nothing

`autonomous` is client-supplied, so any agent-key holder can skip the confirmation by omitting the
flag; I probed this and a bodyless claim after a parked pending returns 201 with the token. This is
the orchestrator's recorded decision, not a candidate slip (rulings §#16 "How the Agent is
distinguished": no `agent_keys.kind` column exists, instructed claims stay MVP 认领即授权 per the
issue #16 **comment**, and DESIGN D4's honest-internal-agent model). Crucially it removes no
existing control — before this delta **every** claim revealed a token — so the change is
monotonically restrictive. Recorded as R1 for the user's awareness, not as a defect.

### A05 Misconfiguration / A08 Integrity — clean

The out-of-band `ALTER TABLE users ADD COLUMN trusted_automation` swallows only errors whose message
matches `/duplicate column name/i` and **rethrows** everything else (`db.ts:32-39`), so a real
migration failure still fails boot loudly instead of running on a half-migrated schema. The column
is `NOT NULL DEFAULT 0`, so every pre-existing user lands on the gated side; `upsertUser`'s existing
branch never resets it, so a re-login cannot silently re-grant trust. Probed persistence: after
`PUT` true the sqlite file holds `trusted_automation = 1`, and the ruling's same-file rebuild case is
covered.

### A10 SSRF / CSRF — no new exposure

The three new mutating routes are session-cookie only, and the cookie is `httpOnly: true,
sameSite: 'lax'` (`auth.ts:266`), so a cross-site form POST does not carry it; `PUT` with
`application/json` additionally cannot be issued by an HTML form at all, and no `@fastify/cors`
plugin is registered anywhere in the server (grep: none), so no cross-origin reader is authorised.
`secure: false` on that cookie is pre-existing #5 deployment/TLS surface, untouched here. None of
the new code performs an outbound fetch, so there is no new SSRF reach.

### XSS — clean

`App.vue` renders every new value through Vue `{{ }}` / `<n-text>` text vnodes. Repo-wide grep for
`v-html`, `innerHTML`, and `eval(` across `apps/web/src` returns **zero** matches, so the audit
row's `auditRowDetailsText` (a `JSON.stringify` of attacker-influenced `details`) and the actor /
task-id strings stay inert text. No token is interpolated anywhere in the new template; the
confirmation list renders only `id`, public `task_id`, and `created_at`.

---

## Admitted findings

finding: id=R1 scope=in_scope action=none status=open severity=low fix_role=none rationale=the autonomous flag is client-supplied so any agent-key holder bypasses the confirmation gate by omitting it, verified by probe returning 201 with the token after a pending row already existed; this is the orchestrator ruling's explicit choice under the honest-internal-agent model and it weakens no prior control because every claim revealed a token before this delta, so it is recorded as a value-laden design property for the user rather than a defect
finding: id=R2 scope=in_scope action=defer status=open severity=low fix_role=implementer rationale=GET /api/v1/events selects the whole events table with no LIMIT and GET /api/v1/stats loads every 状态迁移 row and aggregates in JS on synchronous better-sqlite3 reads, so any authenticated member can drive unbounded memory and latency growth as the audit log ages; the ruling pinned no query string which excluded pagination but not a server-side cap, and on an internal tool this is a follow-up hardening rather than a merge blocker
finding: id=R3 scope=in_scope action=defer status=open severity=low fix_role=implementer rationale=PUT /api/v1/me/settings writes no audit event even though enabling 受信自动化 removes the human-in-the-loop gate, and reject writes none while approve writes 认领已确认, so the audit log this bundle ships cannot show who disabled their own confirmation requirement; the rulings enumerated only the two new event types so the candidate matches spec, and closing the A09 gap is a follow-up issue

---

## Checked and explicitly not filed

1. **`approve` accepts a row in any state** (including `rejected`, and it is idempotent on an
   already-`approved` row) and does not require the task to still be `待认领`. Every reachable
   caller is the row's own owner, so re-approving one's own rejection is legitimate owner authority,
   not privilege escalation. No cross-user effect exists (R1-independent, probed 404).
2. **An `approved` row has no expiry.** If the task is claimed by someone else the claim returns 409
   *before* the gate, so the approval stays unconsumed and can be redeemed much later. It remains
   pinned to the same (task, user, agent key) triple the owner approved, so the blast radius is
   exactly what was consented to; a TTL would be hardening, not a fix.
3. **A `pending` row shadows an `approved` row** because `findClaimConfirmations` checks `pending`
   first. Reaching that state needs two rows for one triple, which needs a concurrent insert; the
   find-then-insert window at `claim.ts:123-131` contains **no** `await` and better-sqlite3 is
   synchronous, so it is not interleavable in-process. Availability nuisance at worst, no token
   consequence.
4. **Team-wide visibility of the audit log to `claim_only` members**, including `变更`
   (`{action, profile_id}`) and publish-time validation rows (`{profile_id, forge, base_url,
   full_name, outcome}`) whose repo names can come from a task creation that **failed** and so never
   appeared on the board that `full`-gated `GET /api/v1/credential-profiles` protects. The values
   are opaque integers and internal repo names with no credential material, and a team-visible audit
   log including `claim_only` is the ruling's stated intent. Not a defect.
5. **`POST /api/v1/users/:id/approve` now returns the target's `trusted_automation`** via the
   extended `publicUser`. The caller is already `active` + `full`, the target is a 待批准 user whose
   flag is necessarily the `0` default, and no other key was added. Not a leak.
6. **Rejection is not sticky and not rate-limited** — a rejected agent can immediately re-request.
   Amplification is bounded: the second request finds the fresh `pending` row and returns 202
   without inserting, so both rows and `认领待确认` events grow only with human reject actions.
7. **`sendUnauthorized` 302s to `/login`** for non-JSON requests on the new GETs. Fixed internal
   path, no request-controlled component, so no open redirect.
8. **Session cookie `secure: false`** and the #7 OAuth leftovers are pre-existing and out of scope;
   this delta does not touch them.

## Conclusion

The one thing this bundle could have broken — the rule that only REST claim 201 and MCP
`claim_task` success may carry a forge token — holds under independent measurement on both
surfaces, and the new gate short-circuits ahead of every decrypt, lease, and status write. The new
session surface is owner-scoped in SQL, fails closed for 待批准 and anonymous callers, and the new
events feed can only re-serve metadata that no writer has ever put a secret into.

finding: R1 non-blocking, R2 non-blocking, R3 non-blocking

verdict: pass
findings_blocking: 0
review_conclusion: The autonomous claim gate short-circuits before every decryptToken, lease insert, and status write, so an unconfirmed autonomous claim was measured returning 202 and MCP pending with no token, no token 揭示 event, and the task still 待认领, while a consumed approval could not be replayed after release; the new session routes scope approve, reject, list, and settings to the owner in SQL with cross-user attempts answering 404 and 待批准 plus anonymous callers answering 401, and the events feed can only re-serve metadata because all eight insertAuditEvent writers were enumerated and none has ever written plaintext into details.
