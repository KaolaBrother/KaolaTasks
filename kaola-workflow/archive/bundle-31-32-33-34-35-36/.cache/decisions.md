# Integrator decisions for the series (recorded before implementation)

## D1 — `claim_id` is derived, never stored (#36)
ADR-0030 §Claim:94-107 says "The existing lease row is the Claim attempt. `claim_id` is its public
opaque encoding; no parallel record is introduced." §Database changes:143-147 enumerates adding
`request_id` as a column but for `claim_id` says only "expose … without a new Claim table".
Decision: `claim_id` is computed deterministically from the lease row's IMMUTABLE fields
(`id`, `task_id`, `device_id`, `claimed_at`, `request_id`, `claimer_user_id`,
`claimer_claimant_id`) — never `state`, `expires_at`, or `last_heartbeat`, which change over the
lease's life. Exported as `claimIdForLease(lease)` from `leases.ts`. Consequences: stable across
heartbeat and across the lease becoming terminal; present for legacy leases that never sent a
`request_id`; verification is recompute-and-compare, which is exactly "the server matches … Claim
identity"; no migration and no column beyond `request_id`.

## D2 — the replay digest's `autonomous` half lives in the reveal audit (#36)
#36 fixes the digest as exactly `(task public id, autonomous flag)`. The task half is recoverable
from `lease.task_id`. The `autonomous` half is not on the lease and may not become a new column.
ADR-0030 §Database changes:147 explicitly directs "add `claim_id` to relevant event details rather
than creating an event foreign-key schema". Decision: the `token 揭示` audit event carries
`claim_id`, `request_id`, and the `autonomous` flag in its details; replay reads it back for the
digest comparison and writes a further reveal event marked as a replay. `writeback.ts:116-130`
is the in-repo precedent for reading state back out of `events.details`. The token itself never
enters event details.

## D3 — credential retention has exactly one enforcement point (#36)
Measured: no credential-replace surface exists at df98907 (see `baseline-verified.md`,
"Refinement 1 resolved"). `DELETE /api/v1/credential-profiles/:id` is the only reachable point,
and the guard is #36's corrected rule — refuse while ANY task referencing the profile is in
`待认领` / `进行中` / `待验收` / `已退回`; allow when only `已完成` / `已取消` (or nothing)
reference it. This is deliberately wider than ADR-0030's draft ("referenced by an active Claim"),
because the poller still needs the credential during `待验收` after the lease is terminal and
`已退回` tasks can be re-claimed. #36's body states the correction explicitly and is authority.

## D4 — write-back leaves the claim response path via an explicit test seam (#36)
The forge comment moves after the commit and is not awaited by the response. Because
`writeback.test.ts` asserts the 认领 comment's effect after a claim, production gains an exported
`settleWritebacks(): Promise<void>` that resolves when in-flight background write-backs settle.
Updating existing tests to await it is mechanical harness plumbing that preserves their meaning;
no assertion is weakened. `retryPendingWritebacks` keeps owning failure recovery.

## D5 — Kaola Workflow issue-less projects: measured NOT SUPPORTED, so #33 documents the fallback
Measured against Kaola-Workflow 10.2.1 (commit 7e93763e): `cmdStartup` refuses with `no_target`
absent a target issue, and `normalizeIssueNumbers` requires >=1 positive integer issue number
before `workflow-state.md` can be written; a non-`issue-N` project name throws
`claim_issue_numbers_invalid`. #33's scope anticipates exactly this: "if absent, the mapping
documents the measured fallback instead of assuming support."
Decision for the mapping (pure functions, fixtures, zero forge calls):
- **imported** Task → Workflow target is the existing `source.issue_url`. Supported today.
- **native** Task → the mapping still computes the Task-id-derived project name it WOULD use, and
  returns it alongside an advisory `unavailable` observation carrying the measured reason and the
  Workflow snapshot identity. Kaola Tasks does NOT create a forge Issue (explicitly forbidden by
  #33), does NOT fabricate an `issue-<N>` project to slip past the existence probe (finalize would
  then call `gh issue close` on a number that does not exist), and does NOT hard-gate the Claim.
  The client guidance states the measured fallback: the Agent executes the native Task directly
  without a Workflow project, or a human files a real Issue for it first.
This is advisory evidence for Agent judgment, never a server refusal — ADR-0030 §Acceptance:303.

## D6 — #34 binds to the pinned Runner snapshot, not to the live external repo
Pinned variant list (snapshot commit fa19c63d; the Runner carries no semver, so the hash IS the
version): `grok`, `claude-code`, `opencode`, `kimi-cli`, `cursor-cli`. Session locator is the pair
`(--repo ABS_PATH, --session NAME)` where ABS_PATH must be the exact git top-level. `capture` is
text-only — there is no screenshot surface, so #34's "frame/capture" secret scan is a scan over
text. The Runner never clones, so Kaola Tasks must establish the Workflow worktree before start.
Acceptance binds to this pinned list, per #34's own instruction, not to whatever the external
repository exposes later.
