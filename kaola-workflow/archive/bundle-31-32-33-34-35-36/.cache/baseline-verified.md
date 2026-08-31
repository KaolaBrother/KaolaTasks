# Baseline verification at df98907 (read directly from the worktree bytes)

Every "measured baseline" bullet in #36/#31/#32 was re-read against the real files. Result: all confirmed, with three refinements recorded at the end.

## #36 claims — CONFIRMED
- `request_id` / `claim_id` appear nowhere. `leaseEnvelope` returns only `expires_at` + `ttl_seconds` — `apps/server/src/claim.ts:48-53`.
- Acquisition is 5 separate statements, no transaction, no CAS: confirmation consume `claim.ts:148`, task UPDATE by id only `claim.ts:203-208` (predicate is `eq(tasks.id, row.task.id)` — no status guard), lease insert `claim.ts:213-219`, token-reveal audit `claim.ts:221-225`, status-transition audit `claim.ts:226-230`.
- Write-back awaited before the 201 — `claim.ts:232` (`await attemptWriteback(...)`).
- `leases_one_active_per_task` partial unique index exists — `db.ts:262-265` (also recreated inside the rebuild path at `db.ts:146-147`).
- `DELETE /api/v1/credential-profiles/:id` deletes unconditionally — `credential-profiles.ts:238-242`. Downstream damage confirmed: `claim.ts:171-172` throws `credential profile not found` → 500; `writeback.ts:31-34` and `poller.ts:102-103` return `undefined` and silently strand.
- `tryAddColumn` + `CREATE ... IF NOT EXISTS` migration idiom exists — `db.ts:92-98`, used at `db.ts:326-345`.

## #31 claims — CONFIRMED
- `ownerMatchesLease` compares only `claimerUserId` / `claimerClaimantId`, never `deviceId` — `claim.ts:76-81`; `leases.deviceId` is stored and NOT NULL — `schema.ts:104`.
- Release returns 409 when the lease is already terminal — `claim.ts:314-316` (`selectActiveLease` returns undefined).
- `submissions` has no unique index; DDL at `db.ts:267-276`, table at `schema.ts:113-120`.
- `submit_pr` performs zero `pr_url` validation — `claim.ts:401-409`; MCP input is bare `z.string()` — `mcp.ts:155`.
- Expiry sweep is a non-transactional loop — `leases.ts:76-87`.
- Webhook matches the stored `pr_url` byte-for-byte — `webhook.ts:47` (`submission.prUrl === prUrl`); the poller passes `submission.prUrl` straight to the adapter — `poller.ts:115,118`.

## #32 claims — CONFIRMED
- Bridge is a line forwarder; the transport session id is a single in-memory `let sessionId` — `apps/mcp/src/main.ts:221`, reassigned only via `onSessionId` at `main.ts:239-241`. No receipt of any kind exists.
- Server answers HTTP 404 + JSON-RPC `-32001` "Session not found" — `apps/server/src/mcp.ts:181`; the bridge passes any parsed body through verbatim — `main.ts:195` — with no re-initialize and no replay.
- `KAOLA_HOME` `0700`/`0600` handling exists for the device identity — `main.ts:49-68`.
- The stdin loop is strictly sequential (`for await ... await forwardMcpRequest`) — `main.ts:223-243`.

## #33 claims — CONFIRMED
- `new McpServer({ name, version })` with no `instructions` — `mcp.ts:89`.
- `claim_task` description literally says "Claim a task and receive a one-shot forge token." — `mcp.ts:117`.
- No tool description mentions Workflow (grep over `mcp.ts`: zero hits).

## Refinements found while measuring (not contradictions)
1. **#36 "deleted or replaced"** — there is no PUT/PATCH credential-profile route at df98907; the surface is GET list, GET `/:id/issues`, POST create, DELETE `/:id` (`credential-profiles.ts:117-252`). "Replaced" therefore has no existing endpoint to guard on the profile resource itself; the retention guard applies to DELETE, and to any task-level credential swap that re-points `tasks.credential_profile_id` / `inline_token_encrypted`. The task-side surface must be measured before the guard is written.
2. **#31 PR-URL parsing** — the per-forge PR/MR URL parsers already exist but are module-private: `parseGithubPrUrl` (`packages/forge-adapters/src/index.ts:148`), `parseGiteaPrUrl` (`:156`), `parseGitlabMrUrl` (`:164`), plus `stripPrUrlSuffix` (`:136`). `parseIssueUrl` (`:426`) is the existing exported precedent for exactly this shape, so the repo-identity export for submit validation follows an established pattern rather than inventing one.
3. **`applyPrTerminalTransition` is already transactional** — `poller.ts:85-93` — and is the in-repo precedent for the transaction shape #36/#31 must apply to claim/heartbeat/release/expiry/submit.

## Refinement 1 resolved (measured after the fact)
`PATCH /api/v1/tasks/:publicId` (`apps/server/src/tasks.ts:751-795`) reads only a status body
(`readStatusBody`) and updates only `status`. It cannot re-point `credential_profile_id` or
`inline_token_encrypted`. `POST /api/v1/credential-profiles` returns `409` on the unique
`(forge, base_url, repo_full_name)` conflict rather than overwriting
(`credential-profiles.ts:218-223`). Therefore at df98907 **no credential-replace surface exists
anywhere** — neither on the profile resource nor task-side. #36's "cannot be deleted or replaced"
guard has exactly one reachable enforcement point: `DELETE /api/v1/credential-profiles/:id`.
