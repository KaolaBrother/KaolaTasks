# Finalization summary — issue-54

Issue: #54 评审循环：submit_revision 的 head_sha 未与 forge 核对，交回后再推的提交不可见
Branch: `workflow/issue-54` · base `1897007` · candidate `9fa1c15` · sink: merge

## Delivered

- 「通过」 is now anchored to the recorded `head_sha`: the approve route reads the live PR head with the task credential (bounded by `MARK_READY_TIMEOUT_MS`) and refuses `409 head_sha_stale` (both shas in the body, no state change / round / event) when the forge head differs; a null recorded head is backfilled; an unreachable forge falls back to the last stored observation and otherwise approves fail-open with `head_verified: false`, recorded on the response and the `评审通过` event.
- The poller records the forge head on every tick into new nullable `submissions.forge_head_sha` / `forge_head_seen_at` (idempotent ALTER) and publishes SSE `task_updated` when it changes; `GET …/review` exposes `forge_head_sha`, `forge_head_seen_at`, `head_stale`; the Web panel shows 「forge 头已变化」 and maps `head_sha_stale` to Chinese.
- `submit_revision` resets the observation when it records a new head; its response path stays forge-free (documented trade-off).
- Review repair (both reviewers, R1): the approve transaction re-reads task + submission and refuses `409 illegal_transition` if the task left `待验收` or the submission closed during the forge round-trip, or a second 「通过」 committed first (previously an overwrite or a 500); the fallback re-reads the stored forge head.
- Real-forge smoke drift leg (`scripts/forge-smoke.ts`): undeclared push after `submit_revision` → 409 → blocking round → second revision claim → `submit_revision(new head)` → 200 `head_verified: true` → merge → 已完成.

## Files Changed

- `CHANGELOG.md`
- `README.md`
- `apps/server/src/db-migration.test.ts`
- `apps/server/src/db.ts`
- `apps/server/src/poller.test.ts`
- `apps/server/src/poller.ts`
- `apps/server/src/review.test.ts`
- `apps/server/src/review.ts`
- `apps/server/src/schema.ts`
- `apps/web/src/App.review.test.ts`
- `apps/web/src/App.vue`
- `docs/DESIGN.md`
- `docs/api.md`
- `docs/architecture.md`
- `docs/smoke-test.md`
- `scripts/forge-smoke.ts`

Commits:
- 9fa1c15 docs: dock #54 in CHANGELOG, architecture overview, and README tool table
- 70b434a docs: record post-repair #54 smoke reruns on GitLab and Gitea
- c7de3fc fix: re-check 待验收 and the open submission inside the approve transaction (#54 review R1) — a terminal transition or second 「通过」 landing during the live head check is refused 409, never overwritten or 500; fallback reads the stored forge head fresh
- 19a20a4 docs: record #54 drift-leg forge smoke on GitLab and Gitea; smoke waits for the forge to report the pushed head (GitLab MR sha refresh lag)
- 6896f9a feat: anchor 「通过」 to the recorded head_sha (#54) — poller forge-head observation, head_stale in review view, live approve check with 409 head_sha_stale / head_verified, submit_revision reset, web notice, smoke drift leg
- d0e8db1 test: #54 acceptance — forge head observation, head_stale view, approve live check (409 head_sha_stale / head_verified), submit_revision reset, migration, web notice
- 80d3603 docs: #54 anchor 「通过」 to the recorded head_sha — forge head observation, head_stale, 409 head_sha_stale, head_verified

## Test Coverage

- `apps/server/src/review.test.ts` — `describe('issue #54 head_sha anchoring')`: equal head 200 + event shape; stale head 409 (no state/round/event, observation persisted, view `head_stale`); null recorded head backfill; unreachable forge fail-open `head_verified:false`; unreachable forge + stored drift → 409; `submit_revision` reset; view exposure; interleaved terminal transition during the live check → 409 (proven 200 on the unfixed code); two concurrent approves → 200 + 409.
- `apps/server/src/poller.test.ts` — forge head recorded and overwritten each tick, `head_sha` never rewritten, status unchanged, real SSE socket sees `task_updated` only on change.
- `apps/server/src/db-migration.test.ts` — legacy `submissions` gains the two columns idempotently, rows keep NULL.
- `apps/web/src/App.review.test.ts` — `review-head-stale` notice text; Chinese fallback for a bodiless `409 head_sha_stale`.
- Two pre-existing #53 tests received fixture syncs only (event deepEqual gains the two keys; PR stub head advanced before approve); no assertion weakened.

## Validation

- `pnpm lint && pnpm typecheck && pnpm test` at `9fa1c15` (worktree, 2026-09-07): exit 0 — eslint clean; tsc clean in 5 packages; node --test 1035 tests / 253 suites / 0 fail; vitest 9 files / 165 tests / 0 fail. Output: scratchpad `issue-54-final-validation-2.txt`. Receipt: `.cache/final-validation.md`.
- Real forge smoke (`pnpm smoke:forge -- gitlab|gitea`, local gitignored PATs, token never printed — checked): post-repair runs GitLab Issue #23 → MR !19 `已完成`, Gitea Issue #36 → PR #37 `已完成`; earlier runs listed in `docs/smoke-test.md`. First GitLab attempt exposed GitLab's async MR `sha` refresh (approve right after push saw the old head) — server behaved per contract against what the forge reported; smoke now waits for the forge; lag documented in DESIGN §17.7 and smoke-test.md.
- Not executed (配合 items, per `docs/smoke-test.md`): browser-side notice rendering and the 409 message in a real browser; GitHub Draft → ready; human Merge click. Covered only by vitest / node --test.
- Run-chains: not applicable (consumer repo, no `test:kaola-workflow:*` scripts).

## Changed Paths

- `CHANGELOG.md`
- `README.md`
- `apps/server/src/db-migration.test.ts`
- `apps/server/src/db.ts`
- `apps/server/src/poller.test.ts`
- `apps/server/src/poller.ts`
- `apps/server/src/review.test.ts`
- `apps/server/src/review.ts`
- `apps/server/src/schema.ts`
- `apps/web/src/App.review.test.ts`
- `apps/web/src/App.vue`
- `docs/DESIGN.md`
- `docs/api.md`
- `docs/architecture.md`
- `docs/smoke-test.md`
- `scripts/forge-smoke.ts`

## Mission List

- 1 done — contract update (DESIGN v0.7 §17.7, api.md) — `80d3603`
- 2 done — 15 RED acceptance tests (tdd-guide) — `d0e8db1`
- 3 done — implementation (implementer) + main's null-head fix; gates green — `6896f9a`
- 4 done — smoke drift leg, real GitLab + Gitea runs, docs — `19a20a4`, `70b434a`
- 5 done — code + security review (R1 race), repair + regression tests, re-gate, smoke reruns — `c7de3fc`, `70b434a`

## Documentation Docking

DOCKED — see `.cache/doc-docking.md` / `.cache/doc-updater.md`: DESIGN.md, api.md, smoke-test.md, architecture.md, README.md, CHANGELOG.md fixed; conventions / workflow-default / runner-carrier / .env.example / MCP examples no impact.

## Issue statement walk

- Measured (self-reported `head_sha` written unchecked; poller NULL-only backfill) → replaced by every-tick observation + live check at approve; covered by poller.test.ts and review.test.ts #54 blocks.
- Hypothesis (push after `submit_revision` invisible; 「通过」 flips a head the verdict never targeted) → confirmed on real GitLab/Gitea by the smoke drift leg, now refused `409 head_sha_stale`.
- Proposed remedy → adopted: compare at approve and on every poll; refuse 409; panel notice. The optional `submit_revision`-time forge round-trip was deliberately not adopted (response path stays forge-free, DESIGN §17.7).

## Run gaps

(none swept — `.cache/run-gaps.json` reports no classes)

## Follow-Up Items

- None filed. Known forge property (GitLab async MR `sha` refresh) is documented, not a defect in Kaola.

## Readiness

READY — all missions done, validation recorded at the candidate, docs docked, no run gaps, no open follow-ups. Closure decision: close #54 on merge sink.

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-54/.cache/doc-docking.md
- kaola-workflow/archive/issue-54/.cache/doc-updater.md
- kaola-workflow/archive/issue-54/.cache/final-validation.md
- kaola-workflow/archive/issue-54/.cache/origin/selection-record.json
- kaola-workflow/archive/issue-54/.cache/run-gaps.json
- kaola-workflow/archive/issue-54/finalization-summary.md
- kaola-workflow/archive/issue-54/mission-list.md
- kaola-workflow/archive/issue-54/workflow-state.md
