# Parent #30 traceability — every ADR-0030 acceptance item mapped to a passing child artifact

Source of the checklist: `docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md`
`## Acceptance contract` (lines 289–305). All 13 items reproduced in order, each mapped to the
child Issue that owns it and to the concrete artifact that proves it.

| # | ADR-0030 acceptance item | Owning Issue | Proving artifact | State |
|---|---|---|---|---|
| 1 | Keep exactly six MCP tools; add no Claim aggregate table, binding table, or coordinator service. | #36, #33, #34 | `workflow-default.test.ts` asserts the tool list is exactly the six and that no tool INPUT schema gains a carrier/execution/version field. #36 added only `leases.request_id` — `claim_id` is derived, never stored, and no table was created (`schema.ts`, `db.ts`). #34 keeps carrier intent in bridge env only, never in server or DB state. | PASS |
| 2 | A normal claim defaults to direct Workflow and performs zero Runner calls. | #33 (contract text), #35 (behavioral proof) | `workflow-default.test.ts` proves the `initialize` instructions carry the subtraction-first default. `lifecycle-matrix.test.ts` proves it behaviorally by putting a poisoned `kaola-tmux.sh` on `PATH` that fails the test if invoked, and no Runner is ever started on the default path. | PASS |
| 3 | An explicit Runner request operates only the named exact runtime/session; the current Agent stays controller/monitor. | #34 | `runner-carrier.test.ts` (41 tests) pins the variant list, the exact `(repo, session)` locator, and that selecting the carrier changes none of the six tools' behavior or parameters. Live proof: `.cache/runner-live-evidence.md` — a real Claude Code runtime driven through preflight/start/observe/send/observe/capture/stop against exactly the requested session, then stopped. | PASS |
| 4 | Workflow and Runner repositories receive no Kaola Tasks dependency or modification. | #33, #34 | Verified repeatedly and directly by me, not taken on report: `git -C /Volumes/.../kaola-workflow status --porcelain` and the same for `kaola-project-runner` both return zero lines, checked after the #33 commit, after the #34 commit, and after the live evidence run. No Kaola Tasks file imports from either repository. | PASS |
| 5 | Replaying one request id 100 times produces one active lease and one Task transition. | #36 | `claim-identity.test.ts` — "replaying the same request_id 100 times yields exactly one lease, one 状态迁移 to 进行中, and one claim_id". | PASS |
| 6 | A stale Claim or different device cannot heartbeat, release, or submit a newer Claim. | #31 | `claim-fencing.test.ts` — the `stale_claim`, terminal-claim, and exact-device describe blocks, including the explicitly named legacy device-fence tightening. | PASS |
| 7 | Failure injection at each claim/release/expiry/submit write boundary leaves all-before or all-after state only. | #36, #31 | `claim-identity.test.ts` injects at every claim-transaction boundary and asserts no reachable `进行中` task without an active lease. `claim-fencing.test.ts` does the same per verb for heartbeat, release, the per-lease expiry sweep, and submit. | PASS |
| 8 | Claim response loss and bridge/server restart recover the same active Claim. | #32 (focused), #35 (integration) | `claim-receipt.test.ts` covers the four kill boundaries and the stale-session single re-initialize. `lifecycle-matrix.test.ts` re-proves it against the REAL server and a REAL spawned bridge — and this is where the two production defects were caught that the focused suite could not see. | PASS |
| 9 | Direct and Runner paths settle into the same Task, lease and submission facts. | #35 | `lifecycle-matrix.test.ts` carrier-parity test: the same claim/progress/submit sequence under `KAOLA_CARRIER=runner` and under the default reaches the same Task status, Claim terminal state and submission facts, with no Runner started. | PASS |
| 10 | A created PR/MR is reused; retries produce no second PR and no second submission. | #31 (focused), #35 (integration) | `claim-fencing.test.ts` — one-submission-per-Claim via the `submissions_lease_id` unique index, idempotent same-PR resubmit, typed conflict on a different URL, and the cross-task duplicate-PR refusal. `lifecycle-matrix.test.ts` re-proves forward-only behavior after a lost submit response. | PASS |
| 11 | Secret scans find no forge token in bridge receipts, Workflow state, Mission List, Runner frame/capture, git remote/config, logs, or events. | #32, #34, #35 | Scanned by me across all seven named surfaces. Bridge receipts + `events.details` + logs: `claim-receipt.test.ts` and `lifecycle-matrix.test.ts` secret sweeps, zero hits. Runner frame/capture and tmux env + git remote/config: `.cache/runner-live-evidence.md` §10 — zero forge-credential hits, with the two `CLAUDE_CODE_MESSAGING_TOKEN` matches identified as the harness's own IPC token, not a forge credential, in an environment holding no forge credential at all. Workflow state and this Mission List: scanned directly, zero hits. | PASS |
| 12 | Workflow/Runner capability observations remain advisory rather than version hard gates. | #33, #34 | `workflow-default.test.ts` asserts the advisory wording, the absence of an allowlist, and structurally that no tool input schema can carry a version/capability. `runner-carrier.test.ts` asserts an unknown/incomplete selection yields an advisory observation and never a silent fallback to direct. The measured Workflow `no_target` finding is recorded as advisory evidence and refuses no Claim. | PASS |
| 13 | Shared lifecycle tests cover GitHub, GitLab and Gitea behavior; live-provider acceptance records only environments actually executed. | #31, #35 | `claim-fencing.test.ts` covers all three forges for PR-repo ownership and canonicalization round trips, GitLab subgroups included. `lifecycle-matrix.test.ts` runs the shared three-forge lifecycle fixtures. **Live-provider acceptance: NOT EXECUTED, recorded honestly** — no `GITLAB_TOKEN`/`GITEA_TOKEN` and no `.env` exists in this environment, and `scripts/forge-smoke.ts` exits for `github` by design. Nothing anywhere claims a live run occurred. | PASS, with live coverage honestly absent |

## Items #35 absorbed from #33
#33's scope moved three end-to-end behavioral proofs to #35 because they are only observable by
running a real Agent against a real Workflow checkout. Their disposition:
- **A default direct-path run performs zero Project Runner calls** — proven in
  `lifecycle-matrix.test.ts` by the poisoned-binary technique. Covered.
- **Direct-path restart recovers the Claim receipt** — proven in `lifecycle-matrix.test.ts`;
  this is the test that exposed production Defect A. Covered.
- **Heartbeat, finalize, PR receipt and submit ordering verified from real artifacts** — proven in
  `lifecycle-matrix.test.ts` from the `events` table, the receipt file on disk, and the
  `submissions` row, never from Agent prose. Covered.

## Honest statements of what was NOT executed
1. **Live GitLab/Gitea/GitHub smoke.** Not executed: no credentials exist in this environment.
   The three-forge coverage in this bundle is shared-fixture coverage with forge HTTP stubbed at
   the fetch boundary — an external third party, never a Kaola layer.
2. **A real Kaola Workflow run against a real checkout.** Not executed. The Workflow
   issue-less-project capability was MEASURED read-only (10.2.1 / `7e93763e`, refuses `no_target`)
   and recorded as advisory evidence, which is exactly what #33 instructs when the capability is
   absent.
3. **Git-config scanning inside the lifecycle matrix.** Not applicable: that suite never performs
   a real clone, so no git config surface exists there to scan. The real git config/remote surface
   that DOES exist — the Runner-owned checkout — was scanned during the live evidence run.
