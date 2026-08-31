# Finalization summary — bundle-40-45 (#40, #45)

Branch `workflow/bundle-40-45`, forked from `fbdab34`. Closure: all_or_nothing. THE LAST TWO OPEN ISSUES.
Both were filed by this session during earlier bundles.

## Delivered

- **#40 — write-back ack-loss dedupe.** Measured against primary API docs: none of GitHub/GitLab/Gitea
  offers comment idempotency, so the write side cannot be made idempotent and only a read-back resolves
  the ambiguity. `ForgeAdapter` gained `listIssueComments(cred, issueRef): Promise<string[]>`, a GET to the
  same collection `commentOnIssue` POSTs to, inheriting the existing host/SSRF rule and #37's abort
  deadline. Failures are classified DEFINITE (4xx except 408/429 — the forge confirmed nothing was
  created) vs AMBIGUOUS (5xx, 408, 429, and every non-status throw). Definite reposts next tick with ZERO
  listing calls. Ambiguous makes ONE listing call and scans the whole array for the marker
  `commentBodyFor` already embeds; found -> record success without reposting; not found -> post. If the
  listing itself fails, the tick is skipped: no repost, no false success, nothing thrown, converging once
  listing recovers.
- **#45 — Chinese admin UI no longer shows Fastify's English 500 text.** `App.vue` gained
  `typedErrorMessage(body)`, surfacing `body.message` only when `body.error` is a snake_case machine code,
  applied at the four reachable failure sites.

## Files Changed

8 modified, 3 new test files.

## Test Coverage

New: `list-issue-comments.shared.test.ts` (three-forge shared contract), `writeback-dedupe.test.ts`,
`App.error-envelope.test.ts`. All authored under independent test custody and proven RED first, including
the R1/R2/R3 extension after review.

## Validation

`verdict: pass`. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — typecheck 5/5, lint clean,
**843 node + 131 web = 974 passing, 0 failing**, build 4 targets. Arithmetic reconciled: 831 -> 843 = +12,
exactly R1's 8 plus R3's 3 plus R2's 1.

**NOT executed and NOT claimed:** no UAT, no smoke test, no `pnpm smoke:forge`, and no live call against a
real GitHub/GitLab/Gitea. `listIssueComments`'s three-forge behaviour is asserted from its shared contract
spec and from primary API documentation only.

## Review

Independent review found NO hard gate (the listing branch is structurally unreachable on the webhook path,
since 已完成 is terminal and `findPendingReviewMatch` only considers 待验收), NO false-success path, and NO
lost write-back. It found two MEDIUM gaps where the fix silently did not fire — a gateway 5xx
misclassified as definite, and an unpaginated listing missing the marker on a busy issue. Both were
repaired under the original test custody and re-verified.

## Changed Paths

Reported by the finalize transaction (`--check`, `ok: true`, no reasons): 9 paths.
Implementation commit `4597ed1` staged 11: those 9 plus `CHANGELOG.md` and `docs/api.md`. Three are new
test files, staged EXPLICITLY — the root `package.json` `test` script names files, so a `git commit -a`
would omit them and the commit would then fail `pnpm test` on a missing file. This session has caught an
unregistered-suite gap twice, so registration was verified in the gate output itself, not just in the file.

## Mission List

14 missions recorded, 0 open.

## Documentation Docking

DOCKED — `.cache/doc-updater.md`, `.cache/doc-docking.md`. #40 changes a documented contract:
`docs/api.md` previously said a failed write-back "writes no event at all", which is no longer true. The
new `{ ok: false, ambiguous }` row, its state-change-only write rule, its honest flapping caveat, the
refined classification boundary, the `per_page=100` request for GitHub/GitLab, and Gitea's UNVERIFIED
truncation behaviour are all now documented without overclaiming.

## Run gaps

- manual:gitea-listing-truncation-unverified (whether Gitea's issue-comment endpoint returns every comment unbounded or applies an undocumented server-side cap could not be established this run (no live-docs access, and no live Gitea may be touched), so listIssueComments sends no page params to Gitea and the dedupe's coverage there is unverified rather than assured): noise: unresolvable from here — it needs a live Gitea this run must not touch, and the controller's independent end-to-end smoke is the very next activity and is exactly the instrument that settles it; it is recorded as an explicit unverified caveat in docs/api.md instead, and filing an issue nobody can close from here would leave the repository permanently non-zero for a question about to be answered.
- manual:flapping-forge-writes-one-row-per-tick (recordFailedWriteback compares only the immediately preceding outcome, so a forge alternating ambiguous and definite failures writes one 回写 ok:false row per poller tick indefinitely; growth is bounded by outcome transitions, not absolutely): noise: accepted known limitation, inherent to comparing only the immediately preceding outcome; growth stays bounded by real outcome transitions, docs/api.md was corrected to stop claiming it "cannot grow per tick", and a test explicitly labelled KNOWN LIMITATION pins the behaviour without asserting it is prevented.
- manual:failing-listing-suspends-writeback-silently (once an ambiguous outcome is stored, a permanently failing listIssueComments makes the write-back retry the listing forever without posting and without writing any new event, so the audit timeline shows one row then silence, indistinguishable from convergence): noise: narrow reachability (listing fails while a POST would have succeeded), self-heals the moment listing recovers, and the DEGRADATION test proves convergence; no write-back is lost or duplicated, only deferred.

## Follow-Up Items

NONE FILED. All three run gaps are honest residuals rather than deferred work — see their dispositions
above. Filing an issue for the Gitea unknown would leave the repository permanently non-zero for a
question the controller's imminent smoke test answers directly.

## Readiness

READY. Acceptance satisfied for both issues, four gates green on the final bytes, docs docked, review
findings repaired and re-verified. On merge the repository reaches ZERO open issues.

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/bundle-40-45/.cache/doc-docking.md
- kaola-workflow/archive/bundle-40-45/.cache/doc-updater.md
- kaola-workflow/archive/bundle-40-45/.cache/final-validation.md
- kaola-workflow/archive/bundle-40-45/.cache/origin/selection-record.json
- kaola-workflow/archive/bundle-40-45/.cache/run-gaps-manual.md
- kaola-workflow/archive/bundle-40-45/.cache/run-gaps.json
- kaola-workflow/archive/bundle-40-45/finalization-summary.md
- kaola-workflow/archive/bundle-40-45/mission-list.md
- kaola-workflow/archive/bundle-40-45/workflow-state.md
