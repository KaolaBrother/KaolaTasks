# Finalization summary — bundle-37-38-39 (#37, #38, #39)

Branch `workflow/bundle-37-38-39`, forked from `8d3504e`. Closure policy: all_or_nothing.

## Delivered

- **#37 — adapter fetch timeouts.** `CreateForgeAdapterOptions` gained `timeoutMs?: number`;
  `DEFAULT_TIMEOUT_MS = 10_000`; both central helpers `forgePost`/`forgeGet` pass
  `signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)`, threaded through the 7 existing
  call sites. Behaviour identical across github/gitlab/gitea. All 6 production `createForgeAdapter` call
  sites are now bounded.
- **#38 — submit_pr write-back off the response path.** `claim.ts` submitPr now uses `scheduleWriteback`
  instead of `await attemptWriteback`, mirroring #36's claim-side seam. `retryPendingWritebacks` needed no
  change.
- **#39 — narrowed to the Claim MCP contract.** `docs/DESIGN.md` §15 and the shipped MCP `instructions`
  now state Workflow is REQUIRED after a successful claim (not merely 默认) and that submitting a PR is
  the required completion; `submit_pr`'s description says so too. `apps/server/src/workflow-target.ts`
  (zero production callers) deleted with its retired `issueless_project` model.

Four defects that no issue named were found and fixed inside this bundle:

- A **duplicate-comment regression** #37 itself created: an abort after the forge already committed a
  comment left no `回写` event, and the uncapped retry sweep re-posted it. Fixed by giving the write-back
  path its own `WRITEBACK_TIMEOUT_MS = 30_000`.
- A **server-wouldn't-boot migration bug** shipped by #36 and already on `main`: the legacy `leases`
  rebuild read `request_id` before the ALTER added it, so `createDb` threw `no such column: request_id`.
- **That fix not actually repairing real deployments** — `sqlite.exec` is non-transactional, so a
  pre-fix crash left a durable orphan `leases__rebuild` that then collided forever. Fixed with a leading
  `DROP TABLE IF EXISTS` plus transaction wrapping, applied to BOTH rebuilds.
- A **discarded operator diagnostic**: `apps/mcp/src/main.ts` computed an advisory carrier `observation`
  and threw it away, so a mistyped `KAOLA_RUNNER` produced total silence.

## Files Changed

16 modified, 1 deleted (`apps/server/src/workflow-target.ts`), 4 new test files.

## Test Coverage

New: `packages/forge-adapters/src/timeout.shared.test.ts` (15, all three forges),
`apps/server/src/writeback-timeout.test.ts` (1), `apps/server/src/db-migration.test.ts` (6),
`apps/mcp/src/runner-carrier-observation.test.ts` (5). Extended: `claim-identity.test.ts` (submit_pr
twin), `writeback.test.ts` (6 `settleWritebacks()` seams), `workflow-default.test.ts` (#39 A1-A4).
Every suite was authored under independent test custody and proven RED before implementation.
Retired: 10 assertions in `workflow-default.test.ts` pinning the `issueless_project` contract the product
owner retired — judged legitimate contract retirement by an independent reviewer, not weakening.

## Validation

`verdict: pass`. Command: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
Result: typecheck 5/5 projects clean; lint clean; `pnpm test` 799 node + 117 web = **916 passing, 0
failing**; build exit 0. Receipt: `.cache/final-validation.md`,
`validated_candidate_hash: 0ee3dbf456c7361afc8d27a3ff492349dc1977f5493651f4a0df590440a0999f`.

**NOT executed and NOT claimed:** no UAT, no smoke test, none of `docs/smoke-test.md`'s 配合
browser/OAuth/device/real-token steps, and `pnpm smoke:forge` was not run. The controller performs the
independent end-to-end smoke test personally after the repository reaches zero open issues.

## Acceptance against each issue statement

- **#37** — "give the two `fetch(` sites a configurable `AbortSignal.timeout(...)`, conservative default,
  consistent across three forges, sharing the existing `*.shared.test.ts` contract": satisfied by
  `timeout.shared.test.ts` (parameterized over all three kinds and both helpers) and the implementation.
- **#38** — "swap `submitPr`'s write-back to `scheduleWriteback`, add `settleWritebacks()` to existing
  提交PR assertions, add a claim-symmetric acceptance case": all three satisfied; the 6 seam sites are
  enumerated in the mission record.
- **#39** — acceptance A1-A5 as rewritten in its body: A1 DESIGN §15, A2 live `initialize` instructions,
  A3 `submit_pr` description (schema untouched, six tools still six), A4 retired model removed from all
  four surfaces plus module deleted, A5 all gates green with the new assertions RED first.

## Changed Paths

Reported by the finalize transaction (`--check`, `ok: true`, no reasons), 15 paths:

- `apps/mcp/src/main.ts`
- `apps/mcp/src/runner-carrier-observation.test.ts`
- `apps/server/src/claim-identity.test.ts`
- `apps/server/src/claim.ts`
- `apps/server/src/db-migration.test.ts`
- `apps/server/src/db.ts`
- `apps/server/src/mcp.ts`
- `apps/server/src/workflow-default.test.ts`
- `apps/server/src/workflow-target.ts`
- `apps/server/src/writeback-timeout.test.ts`
- `apps/server/src/writeback.test.ts`
- `apps/server/src/writeback.ts`
- `package.json`
- `packages/forge-adapters/src/index.ts`
- `packages/forge-adapters/src/timeout.shared.test.ts`

Implementation commit `9dc656f` staged 20 paths: these 15 plus `CHANGELOG.md`, `docs/DESIGN.md`,
`docs/api.md`, `docs/architecture.md` and `docs/workflow-default.md`. Of the 20, four are new test
files and one (`apps/server/src/workflow-target.ts`) is a deletion. The four new files were staged
EXPLICITLY: the root `package.json` `test` script lists files by name, so a `git commit -a` would have
omitted them and the resulting commit would then have failed `pnpm test` on missing files.

## Mission List

31 missions recorded, 0 open. Three were withdrawn intact when the user corrected an over-broad scope
reading, with the correction appended rather than the record rewritten.

## Documentation Docking

DOCKED — `.cache/doc-updater.md`, `.cache/doc-docking.md`. Two overclaims were caught and corrected
before docking was accepted: one asserting a task with no forge Issue could start Workflow (measurably
false), and its inverse asserting such tasks do not exist (contradicted by `tasks.ts:117`). A third,
in `workflow-default.md`'s headline section, was caught by an adversarial verifier.

## Run gaps

- manual:deferred-contract-decision (retryPendingWritebacks has no attempt cap, backoff, or idempotency key, so a forge persistently slower than WRITEBACK_TIMEOUT_MS (30s) still re-posts a duplicate 回写 comment on a real Issue every poller tick; capping it would change #14's recovery-forever semantics, which is a public-contract tradeoff reserved for the user): filed: #40
- manual:ui-error-detail-discarded (apps/web/src/App.vue:1884-1887 renders any non-OK credential-profile delete as a bare 删除失败（409）, discarding the server's Chinese explanation for credential_profile_in_use): filed: #41
- manual:unreachable-documented-remedy (a task stuck in 进行中 cannot be cancelled directly (tasks.ts:40-41 allows 已取消 only from 待认领 and 已退回), so docs/smoke-test.md:151's advice to 先把那条任务取消 is not actionable from that state until the 24h lease expires): filed: #42
- manual:test-output-credential-exposure (writeback.test.ts's stub records headers in commentRequests and several failure messages JSON.stringify that array, so a failing assertion would print an Authorization header into test output): filed: #43
- manual:silent-orphan-retained (a database orphaned by a pre-repair crash in the only-copy state migrates successfully but silently retains the orphan *__rebuild table forever while leases/claim_confirmations come up empty, with no warning to the operator): filed: #44
- manual:retired-guarantee-uncovered (deleting workflow-target.ts removed the only assertion of "Kaola Tasks never creates a forge Issue"; the guarantee is still true and structurally enforced (ForgeAdapter exposes no createIssue), but is now unasserted): noise: the guarantee is structurally enforced rather than test-enforced — ForgeAdapter exposes no createIssue method at all, so no production code can create an Issue; a replacement test could only assert the absence of a method that was never added.

## Follow-Up Items

#40 (P2), #41 (P3), #42 (P3), #43 (P2), #44 (P3) — all verified OPEN with non-empty bodies and priority
labels.

## Readiness

READY. All acceptance satisfied, four gates green on the frozen candidate, docs docked, follow-ups filed.
Two independent review rounds returned FAIL and were fully repaired; the final adversarial verification
confirmed the migration repair cannot lose data (empirically, including a 33/33 SIGKILL sweep with a
discriminating 28/28 control) and refuted one doc contradiction, which was then fixed.

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/bundle-37-38-39/.cache/doc-docking.md
- kaola-workflow/archive/bundle-37-38-39/.cache/doc-updater.md
- kaola-workflow/archive/bundle-37-38-39/.cache/final-validation.md
- kaola-workflow/archive/bundle-37-38-39/.cache/origin/selection-record.json
- kaola-workflow/archive/bundle-37-38-39/.cache/run-gaps-manual.md
- kaola-workflow/archive/bundle-37-38-39/.cache/run-gaps.json
- kaola-workflow/archive/bundle-37-38-39/finalization-summary.md
- kaola-workflow/archive/bundle-37-38-39/mission-list.md
- kaola-workflow/archive/bundle-37-38-39/workflow-state.md
