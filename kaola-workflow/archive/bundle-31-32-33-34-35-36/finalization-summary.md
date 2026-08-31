# Finalization — bundle-31-32-33-34-35-36

Closed set: **#36, #31, #32, #33, #34, #35** (all-or-nothing). Branch `workflow/bundle-31-32-33-34-35-36`, candidate `bc8b01f`. Parent design #30 = `docs/DESIGN.md` §15 + ADR-0030.

## Delivered

Executed in the dependency order the user specified: #36 → #31 → #32 → #33 → #34 → #35.

- **#36 — idempotent Claim identity and atomic acquisition.** Nullable `leases.request_id` with a `(device_id, request_id)` partial unique identity, threaded through the legacy `leases__rebuild` path so a rebuild cannot drop it. `claim_id` is a **derived** opaque encoding of the lease row — no table, no column — computed only from immutable fields, so it survives heartbeats and the lease going terminal. Acquisition is one transaction with a real Task compare-and-swap on `status = '待认领'`. Replaying one `(device, request_id)` returns the same Claim; a mismatched `(task public id, autonomous flag)` digest is a typed conflict that changes nothing. Credential profiles referenced by any non-terminal task can no longer be deleted. The forge claim comment left the response path.
- **#31 — fencing and transactions.** `claim_id` on `report_progress` / `release_task` / `submit_pr`, with `claim_id_required` (400) and `stale_claim` (409). Every mutation matches Task, active lease, owner, **exact device**, and Claim identity — including the deliberate legacy tightening. Heartbeat, release and submit are each one transaction; the expiry sweep is one transaction **per lease**. Release is idempotent for the same terminal Claim, `submissions.lease_id` is unique, and `submit_pr` validates PR-repo ownership, stores a canonical `pr_url` that webhook and poller still match, and refuses a URL already held by another task's live submission.
- **#32 — secret-free bridge receipts.** One atomic receipt per `(server origin digest, task id)` under `KAOLA_HOME`, `0700`/`0600`, hashing both origin and task id into path components so a hostile task id cannot escape. `request_id` is persisted before the claim is forwarded; `claim_id` is attached to the three mutations even from a cold process. A stale MCP session re-initializes once and replays once. Cross-process origination is guarded by an atomic `open(...,'wx')` lock.
- **#33 — Workflow direct is the default.** Server MCP `instructions` carry the subtraction-first default; six tools stay six. `claim_task`'s misleading "one-shot forge token" wording is replaced by ADR-0030's corrected semantics. Pure target mapping plus 中文 `docs/workflow-default.md`.
- **#34 — explicit Runner carrier.** Local env intent only — never an MCP input, never DB state. Pure carrier module pinned to Runner snapshot `fa19c63d`, receipt carrier fields, and 中文 `docs/runner-carrier.md`. The controlling Agent keeps heartbeat, validation, settlement and `submit_pr`.
- **#35 — end-to-end proof, documentation docking, traceability.** A cross-layer matrix that boots the real Fastify app and drives the real bridge as a spawned child through real device pairing. It **found two production defects** in the already-landed #32 bridge and drove their repair. All named documentation drift corrected.

## Files Changed

34 files, +8889 / −288 across `8a49a63~1..bc8b01f`.

## Test Coverage

Net new: `claim-identity.test.ts` (23), `claim-fencing.test.ts` (47), `claim-receipt.test.ts` (26), `workflow-default.test.ts` (18), `runner-carrier.test.ts` (41), `lifecycle-matrix.test.ts` (12) — **167 new tests**, every one registered in the root `test` script. Suite grew 606 → 773 node tests; web stayed 117.

## Validation

`verdict: pass`. Exact command: `pnpm test && pnpm lint && pnpm typecheck && pnpm build`, run from the candidate worktree at `bc8b01f`. Result: **773/773 node tests, 117/117 web tests, lint clean, typecheck clean, build clean**. Receipt at `.cache/final-validation.md`; full output at `.cache/final-gates.log`.

**Acceptance legs, honestly separated.** Automated: the four gates above, all executed. Local integration: the #35 cross-layer matrix, executed — real server, real spawned bridge, real device pairing, real SIGKILL, a real TCP proxy to sever a response mid-flight, and a poisoned `kaola-tmux.sh` on `PATH` proving the direct path never shells out. Live runtime: **executed with the user's explicit approval** — one real Claude Code runtime completed preflight/start/observe/send/observe/capture/stop, recorded at `.cache/runner-live-evidence.md`. **Not executed:** live-provider forge smoke (GitLab/Gitea/GitHub), because no credentials exist in this environment; and any real Kaola Workflow run, since that capability was measured read-only instead. No browser, OAuth, token or 配合-marked manual step is claimed as executed anywhere.

Every one of ADR-0030's 13 acceptance items is mapped to a passing child artifact in `.cache/traceability-30.md`, with an explicit section naming what was not executed.

## Changed Paths

Reported by the finalize transaction (`checks.changed_paths`, 25 paths, `dirty_paths` empty):

`AGENTS.md`, `apps/mcp/src/claim-receipt.test.ts`, `apps/mcp/src/main.ts`, `apps/mcp/src/runner-carrier.test.ts`, `apps/mcp/src/runner-carrier.ts`, `apps/server/src/claim-confirm.test.ts`, `apps/server/src/claim-confirmations.ts`, `apps/server/src/claim-fencing.test.ts`, `apps/server/src/claim-identity.test.ts`, `apps/server/src/claim.test.ts`, `apps/server/src/claim.ts`, `apps/server/src/credential-profiles.ts`, `apps/server/src/db.ts`, `apps/server/src/events.test.ts`, `apps/server/src/leases.ts`, `apps/server/src/lifecycle-matrix.test.ts`, `apps/server/src/mcp.test.ts`, `apps/server/src/mcp.ts`, `apps/server/src/schema.ts`, `apps/server/src/workflow-default.test.ts`, `apps/server/src/workflow-target.ts`, `apps/server/src/writeback.test.ts`, `apps/server/src/writeback.ts`, `package.json`, `packages/forge-adapters/src/index.ts`.

Recorded as observed, not reconciled against a guessed write set. Note the branch diff `8a49a63~1..bc8b01f` is a superset at 34 files: it additionally carries the documentation commit `398bd7f` (`README.md`, `CHANGELOG.md`, `docs/DESIGN.md`, `docs/api.md`, `docs/architecture.md`, `docs/smoke-test.md`) plus `docs/README.md`, `docs/workflow-default.md` and `docs/runner-carrier.md`. Both figures are stated rather than silently reconciled.

## Mission List

17 missions, all `done`, none `BLOCKED`. Two repair loops occurred and both closed: three harness defects in the #36 suite, and the two production defects #35 exposed in #32 plus three harness defects in the matrix. Test custody stayed independent throughout — implementers reported suspect tests rather than editing them, and every acceptance-meaning change was made by the suite's own author.

## Documentation Docking

`DOCKED`. `.cache/doc-docking.md` records the file-by-file substance. Both named drift lines are corrected — `README.md:30`'s "一次性仓库令牌（默认 24 小时）" and `docs/DESIGN.md` §5's "撤销该次 token 揭示的有效性记录" — and I re-ran the whole-repo drift sweep myself: every surviving hit is a negation, the genuinely different single-task inline-credential concept, ADR-0030 describing its own correction, a test asserting the wording's absence, or archived prior-run history. Three pieces of pre-existing drift were found and fixed in passing and disclosed: two stale "Bearer" route labels, the token-reveal event details shape, and the claim write-back call site.

## Run gaps

- manual:deferred-hardening (forge adapter has zero fetch timeouts): filed: #37
- manual:deferred-hardening (submitPr still awaits attemptWriteback on the response path while claimTask no longer does): filed: #38
- manual:external-capability (Kaola Workflow 10.2.1 / 7e93763e refuses issue-less projects with no_target): filed: #39
- manual:unexecuted-acceptance (live-provider smoke for GitLab, Gitea and GitHub was not executed): noise: no credentials exist in this environment and the user explicitly chose to record all three as unexecuted rather than supply tokens; recorded honestly in the traceability map and never represented as covered.
- manual:untested-edge (an imported task with a missing or empty source.issue_url falls back to the advisory issueless_project variant): noise: the fallback is the conservative reading of #33's "never fabricate" rule, is unreachable through any current publish path since imported tasks always carry an issue url, and pinning it would freeze an interpretation #33 never states.
- manual:test-shaped-production (the #36 claim CAS UPDATE issues through the outer db handle rather than tx): noise: still inside the transaction — better-sqlite3 has no per-object transaction context — and independently proven atomic by three failure-injection tests; documented in a code comment, and the alternative would break the race test's observation seam for no behavioral gain.

## Follow-Up Items

- **#37** (P1) — add fetch timeouts to the forge adapter.
- **#38** (P2) — move `submit_pr`'s forge write-back off the response path.
- **#39** (P2) — native Tasks have no usable Kaola Workflow target; the resolution is a value decision for the user, not a machine-decidable fact.

## Readiness

**Ready.** Every mission done, all four gates green on the exact candidate bytes, all 13 parent acceptance items traced, documentation docked, three follow-ups filed and verified, and both external repositories (`kaola-workflow`, `kaola-project-runner`) verified byte-identical at every checkpoint. Net backlog delta: −6 closed, +3 filed = −3.

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/baseline-gates.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/baseline-verified.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/decisions.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/design-30-contract.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/doc-docking.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/final-gates.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/final-validation.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/full-test-run.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/green-31.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/green-32.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/green-33.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/green-34.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/green-35-repair.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/green-36.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/matrix-35.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/origin/selection-record.json
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/red-31.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/red-32-envelope.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/red-32.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/red-33.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/red-34.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/red-36.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/run-gaps-manual.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/run-gaps.json
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/runner-capability.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/runner-live-evidence.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/traceability-30.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/web-test-run.log
- kaola-workflow/archive/bundle-31-32-33-34-35-36/.cache/workflow-capability.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/finalization-summary.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/mission-list.md
- kaola-workflow/archive/bundle-31-32-33-34-35-36/workflow-state.md
