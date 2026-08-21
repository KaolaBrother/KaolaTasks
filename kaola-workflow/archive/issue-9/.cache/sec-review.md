# Evidence-binding header (do not modify above this line)
project: issue-9
issue: 9
surface: lease-based claiming (claim/progress/release + reveal-on-claim + expiry)
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9
# End evidence-binding header

# Security review — issue #9 (lease-based claiming)

Reviewer: security-reviewer. Read-only. Product files were not edited. The only write is this file.

**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-9` (uncommitted production delta on `workflow/issue-9` @ `1dae847` plus tdd-guide tests).

**Scope (candidate-caused only):** `apps/server/src/claim.ts`, `leases.ts`, `agent-bearer.ts` (new); `agent-keys.ts` (whoami now calls the extracted hook); `tasks.ts` (GET list/one sweep; exported `taskBrief`/`selectTask`); `db.ts`/`schema.ts` (`leases` + unique active index); `vault.ts` (`insertAuditEvent.actorUserId: number | null`); `app.ts` (`registerClaim`). `claim.test.ts` was used only as a pin of intended HTTP shapes, not as a defect surface. Pre-existing publish-time SSRF/exfil (#7 residuals) were not re-opened unless this delta worsened them; it does not touch `validateToken` or `repo.base_url` on the claim path.

**Trust model honoured (not a defect):** successful `POST /api/v1/tasks/:publicId/claim` must return forge plaintext in JSON key `token` to a Bearer Agent Key whose user is `active`. Pending (`待批准`) must not receive a token and must not decrypt.

**Method:** full read of the candidate plus callers (`taskBrief`, Bearer whoami plugin, vault, Fastify 5.12.1 default error handler). Then live probes against real `buildApp()` via `inject` only (no public listener): error/list/progress/release bodies, pending seeded key, IDOR, concurrent claims, planted unique-index 500, tampered ciphertext 500, `events.details` vs plaintext/ciphertext, SQLite file bytes, `app.log` no-op, and captured stdout/stderr. No repository file was modified by those probes.

**Verdict: PASS.** No candidate-caused finding. Reveal-on-claim is gated after authn + pending + status, and every reject/list/heartbeat/release/log/audit path measured here stayed free of forge plaintext and ciphertext.

---

## Admitted findings

None.

---

## Checked and clean — token leak on 401/403/409/404, session GET, progress, release, logs, audit details

Primary anchors: `claim.ts` handlers; `tasks.ts` `taskBrief` (explicit 15-key projection, credential is `{profile_id}` or `{inline:true}`); `app.ts:33` `Fastify()` with no logger option.

- **401 (missing / wrong / non-Bearer / session-cookie-only):** same oracle as whoami: `{error:'unauthorized'}` plus `WWW-Authenticate: Bearer`. Bodies contained neither forge plaintext nor a `token` key. Session cookies do not authorize claim/progress/release.

- **403 pending:** `users.status === '待批准'` returns `{error:'forbidden', message:'你的账号待正式成员批准后方可认领任务。'}` **before** `sweepExpiredLeases`, task lookup, and `decryptToken` (`claim.ts:63-65`). Isolated file-DB probe: status stayed `待认领`, `leases` stayed empty, `events` row count unchanged (0), response body did not contain the inline forge plaintext.

- **403 non-holder progress/release:** `lease.claimerUserId !== auth.user.id` (`claim.ts:186-188`, `225-227`) returns `{error:'forbidden'}` with no `token` key and no plaintext. Different-user Agent Keys cannot heartbeat or release a live lease.

- **409 second claim / holder re-claim:** `from === '进行中'` returns `{error:'conflict', message:'任务已被认领。'}` **before decrypt**. No `token` key, no plaintext. Claiming someone else's in-progress task does not reveal.

- **409 illegal_transition** (cancelled task) and **404** (unknown `kt-YYYY-NNNN` / numeric PK): no plaintext, no `token` key.

- **Progress 200 / release 200:** exact keys `{lease,task}` and `{task}`. Neither body contained forge plaintext or a `token` key.

- **Session GET list / GET one after a live claim (including a pending session):** `taskBrief` only. No forge plaintext, no secret key names `token` / `token_encrypted` / `inline_token_encrypted` / `access_token`. Sweep runs after session auth and does not decrypt (`tasks.ts:399-417`, `leases.ts:60-79`).

- **201 nested objects:** `task`, `lease`, and `clone` did not contain the forge plaintext. Top-level `token` matched the publish fixture (product intent). Response headers did not carry the secret.

- **Audit `details`:** every `events` row after a full lifecycle (inline claim, profile claim, heartbeat, release, expiry not required for this dump) was JSON-serialized without forge plaintext and without ciphertext blobs from `tasks.inline_token_encrypted` / `credential_profiles.token_encrypted`. Claim reveal details were `{task_id, agent_key_id, credential}` plus `profile_id` only on the profile path (`claim.ts:104-119`, `147-151`). Heartbeat details are `{task_id, note}`; release `状态迁移` is `{task_id, from, to, reason?}`. SQLite file bytes after close contained no plaintext forge markers.

- **Logger:** `buildApp` constructs `Fastify()` with no `logger` option. On the live app, `app.log.info` / `error` / `debug` are `noop`. No `console.*` and no stdout/stderr chunk written during the probes contained forge plaintext. Fastify 5 default error handler logs via that no-op controller, then `reply.send(error)` with `error.message` only — not the in-memory plaintext local.

- **500 paths (not success):** planted unique-index conflict after decrypt returned `SQLITE_CONSTRAINT_UNIQUE` / `UNIQUE constraint failed: leases.task_id` with no plaintext. Tampered ciphertext returned `invalid ciphertext` with no plaintext. Reveal audit is written **after** `insertActiveLease`, so a thrown insert does not record a reveal.

---

## Checked and clean — pending must not decrypt or write `token 揭示`

`claim.ts:63-65` is the authorization gate; decrypt is `claim.ts:93-126`. Pending GitHub users cannot mint keys via HTTP; the probe seeded `agent_keys` the same way the suite does. Outcome: 403, zero new events, no lease, task still `待认领`. The Bearer hook still authenticates a valid seeded key (`last_used_at` ticks; `GET /api/v1/agent/whoami` returns `status: 待批准`). That is authn-then-authz, inherited from the extracted whoami hook, not a reveal.

Progress/release do not re-check `待批准`. There is no HTTP path that demotes `active` to `待批准`, and pending cannot become a lease holder through claim, so that skip is not attacker-reachable as a decrypt.

---

## Checked and clean — IDOR

- Non-holder progress/release: 403, no token (measured).
- Other-user claim while `进行中`: 409 conflict, no token, no second `token 揭示` (measured).
- Holder identity is `leases.claimer_user_id === agentAuth.user.id` (not `agent_key_id`). A second Agent Key of the **same** user can progress; a different user cannot. That matches the stated trust model (Agent API Key = user authorization) and is not cross-user IDOR.
- `:publicId` is the public id string; numeric PK is 404.

---

## Checked and clean — race (two claimers)

`claim.ts` updates status and inserts the active lease with no `await` before `reply.send`. `leases_one_active_per_task` unique partial index (`db.ts:93-96`) rejects a second `state='active'` row for the same `task_id`. Concurrent `Promise.all` of two `inject` claims on one `待认领` task: **one** 201 with plaintext, **one** 409 `{error:'conflict'}` with no `token` key and no plaintext, exactly one active lease, exactly one `token 揭示` for that `task_id`. The loser did not receive the secret.

A second 201 would require both inserts to succeed; the unique index plus synchronous better-sqlite3 prevent that on this process model.

---

## Checked and clean — Bearer hook extraction (timing / hash)

`agent-bearer.ts` is a move of the previous `agent-keys.ts` hook: `sha256(utf8).hex` lookup, `timingSafeEqual` on equal-length decoded hashes, `WWW-Authenticate: Bearer`, 401 `{error:'unauthorized'}`, `last_used_at` tick on success. Mint in `agent-keys.ts` still uses the same hash. Live 401 oracles for whoami and claim matched. No plaintext compare of the Agent Key. Encapsulated child plugins (whoami and claim) each register the hook; session routes do not inherit it.

---

## Residual / pre-existing / product (not blocking, not admitted)

- **#7 leftovers, unchanged:** publish-time `validateToken` still follows caller `repo.base_url` on the **inline** path; claim does not call `validateToken` or `fetch` (outbound count is a suite pin). This delta does not widen that residual.
- **Decrypt before lease insert:** if insert threw, plaintext exists only in the handler local and the 500 body did not include it. Not reachable as a double-reveal over HTTP given the unique index and the 进行中 gate.
- **POST 201 has no `Cache-Control: no-store`:** Fastify default. POST responses are not cached without explicit freshness; not filed.
- **Session cookie `secure: false`:** pre-existing #5.

---

finding: none

verdict: pass
findings_blocking: 0

review_conclusion: Successful claim returns forge plaintext only on 201 to an active Bearer agent, and every reject, list, heartbeat, release, log, and audit path measured here stayed free of token material.
