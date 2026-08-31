# Goal: deliver #37 (adapter fetch timeouts), #38 (submit_pr writeback off the response path), and #39 (native-Task Workflow target gap) as one all-or-nothing set

Branch: `workflow/bundle-37-38-39` · Worktree: `.kw/worktrees/bundle-37-38-39` · Closure: all_or_nothing
Baseline measured at `8d3504e`: adapters have `AbortSignal:0 timeout:0 fetch(:2`; `claim.ts:853` still
`await attemptWriteback(... '提交PR' ...)`; upstream Workflow still refuses `no_target` and
`claim_issue_numbers_invalid`, so issue-less projects remain unsupported.
UAT is explicitly out of scope for this run and must never be recorded as passed.

## 1. Establish exactly what in #39 is machine-decidable and reduce the rest to one minimal decision point
status: done
dispatched: self (inline, main context); measurement complete, but this mission stays OPEN until the
user makes the value choice — it must not be closed on the model's own judgment.
findings: MEASURED. (i) Upstream re-verified locally at this run: `cmdStartup` still refuses with
`no_target` (kaola-workflow-claim.js:2133-2134, NO_TARGET_USAGE:1971) and `normalizeIssueNumbers` still
throws `claim_issue_numbers_invalid` without a positive integer issue number
(kaola-workflow-adaptive-schema.js:163-169). Issue-less projects remain NOT SUPPORTED, so #39's premise
holds. (ii) MACHINE-DECIDABLE DEFECT FOUND: `docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md`
lines 213-214 assert as product contract that "For a native Task, the Agent uses an issue-less Workflow
project named from the Task id" — a capability the measurement disproves. The contract therefore states
something measurably false and must be docked to measured truth regardless of which remedy is chosen.
`docs/workflow-default.md` and `apps/server/src/workflow-target.ts` are already truthful; the stale claim
is confined to 0030. (iii) SECONDARY OBSERVATION: `workflowTargetForTask` has zero production callers —
it is exercised only by `workflow-default.test.ts`; the mapping reaches Agents solely as prose inside
`KAOLA_MCP_INSTRUCTIONS` in mcp.ts. Wiring it into a tool response would change the public MCP contract
and is out of #39's scope. (iv) RESIDUAL VALUE CHOICE (not machine-decidable): WHAT the corrected
contract should say — remedy (a) upstream request, (b) publisher promotes a native Task to a real forge
Issue, or (c) formally contract that native Tasks do not use Workflow. Escalated to the user as mission
1's single minimal decision point. The user has NOT chosen; no remedy is assumed and nothing in #39 is
implemented on the model's judgment. #37/#38 proceed unblocked; the all-or-nothing closure waits on this.
result: DECISION RECEIVED FROM THE USER, superseding the earlier (a)/(b)/(c) menu entirely. Kaola Tasks is
an internal company system: every Task MUST originate as a real GitLab or Gitea Issue and be imported
directly. There is NO product scenario for a "native" Task detached from a forge Issue, and GitHub is NOT
in scope as a supported forge. This resolves #39 not by correcting one sentence but by narrowing the
product surface: contract, API, UI, MCP, adapters, docs and tests keep only what GitLab/Gitea Issue import
requires; the native-Task and GitHub product surfaces are removed or disabled. Constraints the user
attached: measure the deviation from current docs/history/code FIRST; revise Issue #39's body directly
(edit the body, never add a comment); then implement by the simplest design; do NOT perform speculative
mechanical mass-deletion; explicitly measure compatibility/migration risk to existing persistent data and
public interfaces, and ask again ONLY if irreversible data disposal turns out to be required; do not redo
the already-correct #37/#38 work; UAT remains forbidden.
item: Re-measure #39 against the real repo surface (workflow-target.ts, mcp.ts, workflow-default.test.ts,
docs). Separate what code/tests can settle from the genuine product-value choice among remedies (a)
upstream request, (b) publisher promotes a native Task to a real forge Issue, (c) formally contract that
native Tasks do not use Workflow. Produce the smallest decision the user must make; do not block #37/#38.

## 2. #37 acceptance suite under independent test custody, proven failing on the baseline
status: done
dispatched: tdd-guide (standard `sonnet`) in worktree `.kw/worktrees/bundle-37-38-39`; output lands as
test files under `packages/forge-adapters/src/`
result: RED PROVEN at 8d3504e. New file (production untouched):
`packages/forge-adapters/src/timeout.shared.test.ts`. Acceptance contract, parameterized over
github/gitlab/gitea and over both a `forgeGet`-backed op (getPullRequest) and a `forgePost`-backed op
(commentOnIssue): (1) every outbound fetch receives a real `AbortSignal` via `init.signal`; (2) a hung
forge causes that signal to fire within a bounded time AND the operation's promise to reject rather than
hang; (3) the bound is configurable per adapter — a longer configured deadline aborts measurably later
than a shorter one (15ms vs 90ms real deadlines); (4) a fast response is never spuriously aborted even
at a 15ms deadline; (5) shape is identical across all three kinds. Baseline run
(`node --experimental-strip-types --test packages/forge-adapters/src/timeout.shared.test.ts`): 15 tests,
6 pass / 9 fail; the 6 passes are the deliberate false-positive guards, the 9 failures are exactly the
hung-abort and configurability cases, all failing because no AbortSignal is ever attached today.
Cross-check: run together with all pre-existing forge-adapters shared specs = 179 tests, 170 pass / 9
fail, zero collateral damage; `pnpm --filter @kaola/forge-adapters typecheck` clean.
IMPLEMENTER-ALIGNMENT GUESS (flagged by test custody, not binding): no config surface exists today, so
the suite's local `createAdapterWithTimeout` helper assumes a new `timeoutMs: number` field on
`CreateForgeAdapterOptions`. Every assertion targets the observable fetch/AbortSignal contract, so if the
real option is named differently ONLY that one helper needs realigning — the acceptance meaning does not
move.
item: Author the focused acceptance surface for a configurable adapter fetch timeout across all three
forges via the shared contract tests, and record it failing at `8d3504e`. Test custody owns acceptance
meaning; no production code.

## 3. #38 acceptance suite under independent test custody, proven failing on the baseline
status: done
dispatched: tdd-guide (standard `sonnet`) in worktree `.kw/worktrees/bundle-37-38-39`; output lands as
test files under `apps/server/src/`
result: RED PROVEN at 8d3504e. Touched (production untouched): `apps/server/src/claim-identity.test.ts`
— one new test `'a slow forge write-back comment cannot delay the committed submit_pr response'` added
inside the existing `describe('write-back off the response path')` block; and
`apps/server/src/writeback.test.ts` — `await settleWritebacks()` added at 6 sites as mechanical fixture
maintenance. Acceptance contract: once `submitPr`'s transaction commits, the MCP `submit_pr` response
must return without awaiting the outbound forge HTTP call (mirroring `claimTask`'s `scheduleWriteback` at
claim.ts:603); the write-back must still eventually run, observable ONLY through the deterministic
`settleWritebacks()` seam; `retryPendingWritebacks` keeps failure recovery (its `提交PR` branch at
writeback.ts:182-184 already suffices, no change needed); and the test additionally asserts no successful
`回写` event for `提交PR` exists immediately after the response, so the fix must genuinely background the
work rather than merely be fast. Baseline run (`node --experimental-strip-types --test
apps/server/src/claim-identity.test.ts apps/server/src/writeback.test.ts`): 39 tests, 38 pass / 1 fail;
the single failure is the new acceptance — "submit_pr did not resolve within 1500ms". NOTE: this repo
uses node's built-in test runner, not vitest.
The 6 `settleWritebacks()` sites and why each was required: (1) the gitea submit_pr write-back comment
assertion would observe nothing once backgrounded; (2) the forge-network-failure case would pass
vacuously instead of proving a real failed attempt; (3)+(4) the `已完成` merged poll and webhook cases
index `commentPosts[last]`, so an in-flight submit_pr comment could silently swap which comment is
asserted (both bodies contain publicId/PUBLIC_URL/pr_url, so it would false-pass); (5) the `已退回`
case captures `beforeCount` and an in-flight comment could falsely trip its must-not-grow assertion;
(6) the 5xx-on-completion pair uses a one-shot `setNextCommentResponse({status:502})` that a pending
submit_pr comment could consume instead. Deliberately NOT touched: the native-task case (~line 924),
since native tasks skip write-back before anything is scheduled.
ENVIRONMENT NOTE: the worktree had no `node_modules`; test custody ran `pnpm install` there to execute
the focused suite.
item: Author the symmetric "a hung forge cannot delay a committed submit_pr response" acceptance test
mirroring the existing claim-side case, plus the mechanical `settleWritebacks()` maintenance the existing
提交PR writeback assertions will need. Record failing at `8d3504e`. No production code.

## 4. #37 implementation: bounded, configurable timeouts on both adapter fetch sites
status: done
dispatched: implementer (standard `sonnet`) in worktree `.kw/worktrees/bundle-37-38-39`; output lands in
`packages/forge-adapters/src/index.ts` plus the `test` script in root `package.json` (harness plumbing:
`timeout.shared.test.ts` is not yet in the explicit file list, so it would not run in `pnpm test`).
RED independently re-verified by the run owner before dispatch: 9 failures, all "never rejected before
the external test guard fired".
result: GREEN, independently re-verified by the run owner (not taken on the implementer's word).
Changed exactly two files. `packages/forge-adapters/src/index.ts`: added `timeoutMs?: number` to
`CreateForgeAdapterOptions`; added `DEFAULT_TIMEOUT_MS = 10_000` with a comment naming the rationale;
`forgeGet` and `forgePost` each take `options?: CreateForgeAdapterOptions` and pass
`signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)` to `fetch`; the 7 existing call
sites (validateToken x2, getPullRequest, registerWebhook x3, importIssue, listIssues, commentOnIssue)
thread the `options` already in their scope. No third fetch site, no restructuring. Root `package.json`:
`timeout.shared.test.ts` added to the explicit `test` file list after `comment-on-issue.shared.test.ts`,
nothing else on that line changed. No deviation from test custody's `timeoutMs` guess, so
`timeout.shared.test.ts` was NOT edited by production custody — acceptance meaning fully preserved
(15 assertions intact, file still untracked-and-unmodified; only `index.ts` shows `M`).
Owner-run verification: `timeout.shared.test.ts` 15 tests / 15 pass / 0 fail; the 7 pre-existing
forge-adapters suites 164 tests / 164 pass / 0 fail; `pnpm --filter @kaola/forge-adapters typecheck`
clean. Token safety: no new catch/log/error-formatting code exists — an abort surfaces as fetch's own
DOMException and existing messages only interpolate `kind` and `res.status`, never a URL, token or
header. Coverage note: all 6 production `createForgeAdapter` call sites (credential-profiles.ts:176,
poller.ts:104, webhook.ts:78, tasks.ts:562, tasks.ts:708, writeback.ts:68) pass no `timeoutMs`, so every
one of them is now bounded by the 10s default — the hardening reaches production without further wiring.
item: Give `forgePost` and `forgeGet` a conservative, configurable `AbortSignal.timeout(...)` with
identical behavior across GitHub/GitLab/Gitea, satisfying mission 2's acceptance without weakening it.

## 5. #38 implementation: move the 提交PR writeback off the response path
status: done
dispatched: implementer (standard `sonnet`) in worktree `.kw/worktrees/bundle-37-38-39`; output lands in
`apps/server/src/claim.ts` (~line 853). RED independently re-verified by the run owner before dispatch:
"submit_pr did not resolve within 1500ms" at claim-identity.test.ts:1240.
result: PRODUCTION CHANGE CORRECT AND ACCEPTED, diff independently reviewed by the run owner. Exactly two
edits in `apps/server/src/claim.ts`: line 31 import narrowed to `import { scheduleWriteback } from
'./writeback.ts'` (attemptWriteback became unused here; still exported and used by writeback.ts/poller.ts),
and the submitPr call site (~851-854) changed from `await attemptWriteback(db, updated, '提交PR',
actorUserId(auth), canonicalPrUrl)` to `scheduleWriteback(db, updated, '提交PR', actorUserId(auth),
canonicalPrUrl)` with a comment mirroring the claim-side seam. `writeback.ts`, `packages/forge-adapters`
and root `package.json` untouched by this mission. `retryPendingWritebacks` (writeback.ts:182-184) needed
NO change — its 提交PR branch keys off "no successful 回写 event yet" and is agnostic to what fired it.
Verified: 8 other server suites (claim, claim-fencing, claim-confirm, mcp, poller, webhook,
lifecycle-matrix, events) = 160 tests / 160 pass / 0 fail; `pnpm --filter @kaola/server typecheck` clean.
The backgrounding is positively proven by the assertions that DO pass: submit_pr resolves in <1500ms
against a 4000ms-delayed comment; `successfulWritebackEventsFor(db, brief.id, '提交PR').length === 0`
immediately after the response (in flight, not merely fast); and that count becomes 1 after
`settleWritebacks()` (not lost). CUSTODY NOTE: the implementer hit the failing fixture assertion,
diagnosed it independently as a test defect, and correctly REFUSED to touch the test file or to bend
production to satisfy it — it explicitly declined both suppressing the legitimate 认领 comment and adding
a same-issue heuristic. The residual failure is mission 10's, not this mission's.
item: Replace `await attemptWriteback` in `submitPr` with `scheduleWriteback`, matching #36's claim-side
seam and leaving `retryPendingWritebacks` owning failure recovery, satisfying mission 3's acceptance.

## 6. #39 resolution landed per the user's decision
status: done
dispatched: tdd-guide (standard `sonnet`) for the A1-A4 acceptance, then implementation; worktree
`.kw/worktrees/bundle-37-38-39`. Output lands in `docs/DESIGN.md` §15, `apps/server/src/mcp.ts`
instructions + `submit_pr` description, and the four places duplicating the issueless_project claim.
result: LANDED AND VERIFIED. Acceptance `apps/server/src/workflow-default.test.ts` = 15 tests / 15 pass /
0 fail (owner-run), from an owner-verified RED of 15/7/8 taken while production was provably untouched.
Regression: mcp + claim + claim-identity + lifecycle-matrix = 89 tests / 89 pass; `pnpm --filter
@kaola/server typecheck` clean.
A1 `docs/DESIGN.md` §15: the "默认" bullet now states `claim_task` 成功后 Agent 必须直接启动并运行 Kaola
Workflow（强制要求，不再只是默认值）, plus that submitting a PR/MR after Workflow completes is 默认且必须.
A2 `KAOLA_MCP_INSTRUCTIONS` rewritten to carry both requirements while keeping every #33 keyword
(Workflow/Runner/explicit/directly/advisory, still no "allowlist"). A3 `submit_pr`'s description now opens
"The required completion of the Workflow path: ..." — inputSchema byte-identical, six tools still six.
A4 `apps/server/src/workflow-target.ts` DELETED (68 lines, zero production callers); the retired terms
`issueless_project` / `available: false` / `advisory-unavailable` now appear ZERO times in
`docs/workflow-default.md` and `docs/architecture.md`; `docs/api.md:11` dropped the stale Sources entry;
a new `## Unreleased` #39 CHANGELOG entry was added without rewriting any historical entry.
NON-GOALS VERIFIED BY THE RUN OWNER, measured not assumed: `apps/server/src/claim.ts` still has ZERO
`sourceType`/`sourceIssueUrl` references (claim accept/refuse untouched — the file was never edited);
`git diff --stat` shows `apps/server/src/tasks.ts`, `apps/server/src/schema.ts` and ALL of `apps/web/`
absent entirely; the only `packages/forge-adapters` change is #37's timeout work; all three forges remain.
No migration, no data disposal.

## 22b. (result for mission 22)
status: done
result: CORRECTED. The first implementation made all 15 tests green but asserted a MEASURABLE
IMPOSSIBILITY in two docs — that a native Task with no forge Issue "统一进入 Workflow / still requires
Workflow to start". Upstream cannot start without an issue number (`no_target`,
`claim_issue_numbers_invalid`), re-verified twice this round, so that text was untrue and it had REPLACED
the truthful measurement that explained why. Green tests would have shipped it: the assertion
(`assertSentenceContainsAll`, workflow-default.test.ts:484-486) only requires one sentence containing
(每|所有)+(成功)+(认领), Workflow, and (必须|required|must) — satisfiable truthfully, so the acceptance
never forced the overclaim; the wording did.
Final wording, verified by the run owner across `docs/workflow-default.md`, `docs/architecture.md`,
`docs/DESIGN.md` and `apps/server/src/mcp.ts`: the contract is scoped to Tasks originating from an
external forge Issue that carries that Issue's token, that Issue (`source.issue_url`) is the Workflow
target, and every successful claim on such a task must start Workflow — and the measured
`no_target`/`claim_issue_numbers_invalid` refusal is named as the REASON the contract is scoped that way,
rather than being deleted. Grep confirms the overclaim strings appear ZERO times anywhere in docs/ and
apps/, the three retired terms appear ZERO times, and the measured constraint is cited in both docs.
Acceptance still 15/15 green after the correction — truth and green are not in tension here.
note: superseded in scope by the user's decision recorded in mission 1. This mission now means "the
GitLab/Gitea-only, import-only product surface is landed", and depends on missions 11-13's measurement
plus the Issue #39 body revision in mission 14. It stays todo until those land.
item: Implement whatever mission 1's decision point resolves to, keeping the measured advisory truthful.

## 7. Independent review of the exact candidate bytes
status: done
result: SUPERSEDED IN PLACE by the whole-candidate reviews. This mission's promised outcome (independent
review of the frozen bytes) was delivered twice over: mission 24 records the final review's FAIL verdict
with 4 blocking findings, and mission 29 records the adversarial verification of the repairs. Recorded
here so no successor re-dispatches a review that already happened.
dispatched: code-reviewer (reasoning `opus`) in worktree `.kw/worktrees/bundle-37-38-39`, scoped to the
frozen CODE candidate (production + tests for #37/#38); findings return inline. Documentation accuracy is
verified separately by the run owner against mission 9's output.
item: Adversarial review of the frozen candidate for correctness, scope creep, token leakage, and
acceptance-meaning preservation across all three issues.

## 8. Full integration validation on the frozen candidate
status: done
dispatched: self (inline, run owner), executed in worktree `.kw/worktrees/bundle-37-38-39`
item: Run the repository's required gates (`pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`) and
record real outcomes. No UAT, no "配合" browser/OAuth/token steps.
result: ALL FOUR REQUIRED GATES GREEN, run by the run owner against the frozen code candidate.
`pnpm typecheck` — all 5 workspace projects (apps/web, apps/mcp, apps/server, packages/shared,
packages/forge-adapters) Done, exit 0. `pnpm lint` (`eslint .`) — exit 0, no output.
`pnpm test` — node runner 789 tests / 209 suites / 789 pass / 0 fail, then `@kaola/web` vitest 6 files /
117 tests / 117 pass. Total 906 passing, 0 failing. `pnpm build` — packages/shared,
packages/forge-adapters, apps/server, apps/mcp tsc Done; apps/web vite built in 2.09s; exit 0. The only
build output that is not a plain success line is vite's pre-existing >500kB chunk-size advisory for
apps/web, which is unrelated to this bundle and present before it.
HARNESS PLUMBING CONFIRMED, not merely assumed: re-ran `pnpm test` and grepped its real output for the
new suite — "forge fetch timeout shared spec (issue #37)" appears as both an opening and a passing line,
proving #37's acceptance actually executes inside the repository gate rather than only when invoked
directly. Without the package.json change it would have been silently skipped.
NOT RUN, and NOT claimed: no UAT, and none of the browser / OAuth / device-pairing / real-token "配合"
steps in docs/smoke-test.md were executed. `pnpm smoke:forge` was not run. No manual or human-in-the-loop
acceptance is asserted anywhere in this run.

## 9. Documentation docked to implemented truth
status: done
dispatched: doc-updater (standard `sonnet`) in worktree `.kw/worktrees/bundle-37-38-39`, scoped to the
#37/#38 portion ONLY; output lands in `docs/architecture.md`, `docs/api.md`, `CHANGELOG.md`. The #39
portion (`docs/decisions/0030-...md:213-214`) is explicitly EXCLUDED and stays blocked on the user's value
choice. `docs/workflow-default.md` is also excluded — it is #39 territory AND is read at runtime by
`workflow-default.test.ts`.
result: DOCKED for the #37/#38 portion; independently verified by the run owner. Three files changed:
`docs/api.md`, `docs/architecture.md`, `CHANGELOG.md`.
#38 stale-sentence repair — all five sentences the run owner had measured as false are now corrected:
api.md:286 (claim paragraph's now-false contrast), api.md:341 (submit_pr tool row), api.md:395
(`scheduleWriteback` now documented as wrapping BOTH fire-and-forget call sites, claimTask #36 and
submitPr #38), api.md:399-403 (submitPr's "Awaited by the caller?" table cell Yes -> No), api.md:405
(closing sentence: only `applyPrTerminalTransition`'s 完成 write-back is still a direct `await`),
architecture.md:118 and :124. Owner re-grepped for `still \`await\`s|stays on the response path|still
awaits its own writeback` across `docs/*.md`: ZERO remaining hits.
#37 new material — api.md:523 (`createForgeAdapter` signature gains `timeoutMs?: number`), api.md:531
(type list), api.md:533 (new "Outbound fetch timeout (#37)" paragraph), architecture.md:160 (same content
in that file's single-paragraph style, plus `timeout.shared.test.ts` added to the shared-specs list).
Content checked for accuracy against the diff: the 10s default, both helpers, the six bounded methods with
`parseWebhook` correctly excluded as never fetching, per-adapter-instance semantics, and all six
production call sites named with the correct files — every claim matches the code.
`CHANGELOG.md`: two new `## Unreleased` entries (#38 then #37) in the existing per-issue Chinese prose
style. Deliberately no "Measured" line — doc-updater ran no gates itself, and the run owner's gate results
are recorded in mission 8 rather than being restated as the doc author's own evidence.
EXCLUSIONS VERIFIED BY THE RUN OWNER, not just asserted: `git diff --stat` over `docs/decisions/`,
`docs/workflow-default.md`, `docs/smoke-test.md` and `docs/DESIGN.md` is EMPTY. #39 territory is untouched
and no claim about native Tasks, issue-less Workflow projects, or Workflow target availability was added.
No manual/browser/OAuth/device/UAT verification is claimed anywhere.
INTENTIONAL NON-EDITS, reviewed and agreed: the historical `#36` CHANGELOG entry still reads "submitPr
自己的回写仍保持 `await`，未变" — correct as a record of what #36 itself did, and superseded by the #38
entry directly above it; architecture.md's terse ASCII module-inventory lines were left alone because they
already omit sibling options like `webhookSecret` and assert no false behavior. README.md,
docs/DESIGN.md and docs/conventions.md were grepped and contain zero hits for the affected symbols, so
they held no stale claim.
EVIDENCE NOTE: the mission 8 gate ran before these doc edits. The edited files are non-executable and the
only doc read at runtime by a test (`docs/workflow-default.md`, read by `workflow-default.test.ts`) was
NOT touched, so the 906-passing evidence remains valid for the executable candidate. The full gate will be
re-run once more on the final frozen bytes before finalization.
item: Dock DESIGN/architecture/api/workflow-default/changelog to what actually landed for #37/#38/#39.
inventory (measured at 8d3504e by the run owner, before implementation, so the exact stale sentences are
known): #38 — `docs/architecture.md:118` "`submitPr` still `await`s `attemptWriteback` on its own response
path (#14)"; `docs/architecture.md:124` "`submitPr` (`提交PR`, `claim.ts`, now `async`, still `await`ed on
its own response path)"; `docs/api.md:286` "contrast `submitPr` below, which still awaits its own
writeback"; `docs/api.md:341` "still `await`s `attemptWriteback(...)` before returning — unlike claim's
writeback (#36), this one stays on the response path"; `docs/api.md:395` describes `scheduleWriteback` as
wrapping "the fire-and-forget call site below: ... the caller — `claimTask`", which must become BOTH call
sites. Plus `CHANGELOG.md`. #37 — grep for `timeout|超时` across `docs/*.md` returns ZERO hits, so the
adapter timeout is entirely NEW documentation (api.md adapter section + architecture.md), not an edit of a
stale sentence. #39 — blocked on the user's value choice; the stale contract sentence is
`docs/decisions/0030-...md:213-214`.

## 10. #38 acceptance artifact repaired under test custody after a GREEN-only counting defect
status: done
dispatched: tests-38-writeback (the original tdd-guide author, resumed with its context) in worktree
`.kw/worktrees/bundle-37-38-39`; output lands in `apps/server/src/claim-identity.test.ts` (~line 1296)
and possibly `apps/server/src/writeback.test.ts`.
item: `claim-identity.test.ts:1296` counts comments with
`stub.commentRequests.filter((r) => r.url === giteaCommentUrl(901))` and asserts exactly 1, but the
claim's own 认领 write-back was posted to that same issue URL earlier in the test, so the filter observes
2. The assertion was UNREACHABLE during the RED run because the 1500ms guard fired first; it only became
observable once the production fix let submit_pr return promptly. Production is correct — the timing
assertions and the "no successful 提交PR 回写 event immediately after the response" assertion both pass,
which is what actually proves the backgrounding. Test custody must repair its own artifact so it counts
the 提交PR comment specifically, WITHOUT relaxing to `>= 1` or deleting the check. This is appended
rather than folded into mission 3 because mission 3's result is immutable and this needs its own
dispatch and its own result. The parallel implementer was explicitly ordered to stop and to touch no
test file, so acceptance meaning stays with test custody.
result: REPAIRED AND GREEN, diff independently reviewed by the run owner. Only
`apps/server/src/claim-identity.test.ts` changed; no production code touched. The fix captures
`const commentsBeforeSubmit = stub.commentRequests.length` immediately before the submit (after the 认领
write-back was already drained) and counts
`stub.commentRequests.slice(commentsBeforeSubmit).filter((r) => r.url === giteaCommentUrl(901))`.
ACCEPTANCE MEANING PRESERVED, NOT WEAKENED: the assertion is still `assert.equal(commentPosts.length, 1,
...)` with its original message — not relaxed to `>= 1` and not deleted; only the array being counted was
scoped to "what arrived after this point". All five assertions in the test remain intact (sub-1500ms
response, status 待验收, zero successful 提交PR 回写 events immediately after the response, exactly one
comment post, exactly one 回写 event after settleWritebacks). Test custody also swept for the same
URL-only-filter pattern elsewhere and found none: `writeback.test.ts`'s stub records
`{url, method, headers, body}` and its count/index assertions rely on ordering-after-settle, which the 6
added `settleWritebacks()` calls guarantee — no changes needed there.
Owner-run verification: `claim-identity.test.ts` + `writeback.test.ts` = 39 tests / 39 pass / 0 fail.

## 11. Measured inventory of the GitHub product surface
status: done (WITHDRAWN)
dispatched: code-explorer (standard `sonnet`), READ-ONLY, in worktree `.kw/worktrees/bundle-37-38-39`;
findings return inline for the run owner to record.
item: Exhaustively inventory every place GitHub exists as a supported forge — packages/shared type
unions and zod schemas, packages/forge-adapters (kind branches, API origin, signature verification),
apps/server (schema/enum/validation/webhook/OAuth/config), apps/web Chinese UI, apps/mcp, tests, docs,
env/config. Classify each hit as must-remove, must-keep, or ambiguous. No edits.

## 12. Measured inventory of the native-Task product surface
status: done (WITHDRAWN)
dispatched: code-explorer (standard `sonnet`), READ-ONLY, in worktree `.kw/worktrees/bundle-37-38-39`;
findings return inline for the run owner to record.
item: Exhaustively inventory every place a Task can exist without a forge Issue — the
`source.type: 'native' | 'imported'` union, DB columns, task-creation paths, publish UI, MCP brief,
write-back's native no-op, `workflow-target.ts`'s issueless_project, tests and docs. Classify each hit as
must-remove, must-keep, or ambiguous. No edits.

## 13. Measured compatibility and migration risk for persistent data and public interfaces
status: done (WITHDRAWN)
dispatched: investigator (standard `sonnet`), READ-ONLY on tracked files, in worktree
`.kw/worktrees/bundle-37-38-39`; findings return inline for the run owner to record.
item: Measure what narrowing the surface would actually break: the SQLite schema and any drizzle
migrations, whether any real database contains rows with `repo_forge = 'github'` or a native
`source_type`, which public HTTP/MCP contract shapes change, and whether ANY irreversible disposal of
existing data would be required. This mission decides whether the run must stop and ask the user again.

## 14. Issue #39 body revised to the decided acceptance scope
status: done (SUPERSEDED — this entry was written under the scope the user later corrected; the mission
that actually ran is the second "## 14. Issue #39 body revised to the narrowed Claim MCP scope" below,
which is recorded done. Kept, not deleted, so the correction remains auditable.)
item: Rewrite GitHub Issue #39's BODY in place (`gh issue edit 39 --body-file`), never a comment, so it
states the decided product scope and a verifiable acceptance range grounded in missions 11-13's
measurements. Outward-facing edit to the user's own tracked issue, authorized by the user's instruction.

## 15. Measured contract-layer and historical deviation from the user's #39 decision
status: done
dispatched: self (inline, run owner), read-only over AGENTS.md / README.md / docs/DESIGN.md
item: Measure how far the decided scope (GitLab/Gitea Issue import ONLY; no native Tasks; GitHub out of
scope) departs from the CONTRACT and its recorded history, as distinct from the code inventories in
missions 11-13.
result: THE DECISION REVERSES SEVERAL EXPLICITLY FROZEN PRIOR DECISIONS. This is not a docs typo; per
AGENTS.md `docs/DESIGN.md` is the source of truth and must be changed BEFORE schema/state machine/adapter
/MCP surface. Measured:
- `docs/DESIGN.md:22` decision D2 — "Forge 支持 | GitHub / GitLab / Gitea 三者从第一天起走统一适配层".
  A first-day foundational decision, now reversed.
- `docs/DESIGN.md:13` 使用场景 — "团队的代码分散在 GitHub、自托管 GitLab、自托管 Gitea 三种 forge 上".
  The stated premise of the whole product; the user now says GitHub is not in scope.
- `docs/DESIGN.md:26` decision D6 and `docs/DESIGN.md:293` — v0.3 already removed GitHub LOGIN but
  explicitly preserved the rest: "（GitHub 适配器与发布表单里的 GitHub 仓库仍在）" and the flat directive
  "不删 GitHub 适配器". The new decision reverses precisely that preserved remainder.
- `docs/DESIGN.md:9` — "手工创建，或从 GitHub / GitLab / Gitea 的 Issue 导入" states manual (native)
  creation as a first-class product capability; `docs/DESIGN.md:111` carries the `native | imported`
  union. Both must go.
- `AGENTS.md:9` — "没有 GitHub 登录，但仍支持 GitHub 仓库任务" is now false.
- `AGENTS.md:24` — "GitHub、GitLab、Gitea adapter 保持行为一致，并共享集成测试合同" is the standing
  three-forge parity constraint that every shared `*.shared.test.ts` encodes, including #37's brand-new
  `timeout.shared.test.ts`. Narrowing to two forges touches this constraint directly.
- `README.md:5`, `:16`, `:62` describe GitHub import/PAT guidance to users.
TWO OPERATOR/DATA-FACING FACTS FOUND AT THE CONTRACT LAYER, flagged for missions 11-13 to confirm in code:
- `README.md:104` and `:107` — `OAUTH_GITHUB_CLIENT_ID` / `OAUTH_GITHUB_CLIENT_SECRET` are still
  `requireEnv` non-empty AT BOOT even though GitHub login is already 404. Any change here is
  operator-facing (an existing deployment's .env), not merely internal.
- `docs/DESIGN.md:273` and `:288` — `users.provider` can legitimately already hold a leftover `'github'`
  row, and the open-DB migration rule explicitly reasons about "只有 GitHub `full`" databases. So GitHub
  is present in PERSISTED IDENTITY data, not only in task/forge code. This is the single most likely
  source of irreversible-disposal risk and is exactly what mission 13 must settle before anything is cut.

## CORRECTION — user narrowed the scope; missions 11-13 and 15 were premised on a misreading
status: done
dispatched: self (inline, run owner)
result: The user corrected the premise before any of this landed. Recorded here rather than by rewriting
the immutable results above, so the trail stays honest.
WHAT THE USER ACTUALLY MEANS: (1) this round's scope runs from Issue #31 to now and its ONLY theme is
Claim MCP; the task-publishing server and every other existing framework stay UNCHANGED. (2) The tasks
Claim MCP faces always have an external forge original Issue and can reach the repo with the token the
task carries — the user's latest wording is "GitHub or GitLab"; this must NOT be used to alter the
publishing server's existing forge support matrix, and emphatically NOT to remove GitHub, Gitea, native
publishing, or to run any data migration or contract-level restructuring. (3) The earlier "does a native
Task go through Workflow" three-way choice is therefore a FALSE PREMISE: for Claim MCP, every successful
claim must uniformly enter Workflow — there is no non-Workflow path. (4) Opening a PR after Workflow
completes is default and REQUIRED, not optional, and needs no further user question.
RESULT OF MISSIONS 11-13: WITHDRAWN, stopped mid-flight via TaskStop before completion. All three were
dispatched READ-ONLY and produced NO file edits. One dispatch, one result: this is theirs.
RESULT OF MISSION 15: its individual measurements of DESIGN.md/AGENTS.md/README.md line content remain
factually accurate as quotations, but its FRAMING — that those frozen decisions should be reversed — is
withdrawn. D2, D6, "不删 GitHub 适配器", the native/imported union and the three-forge parity constraint
all STAND UNCHANGED. Nothing in this run may touch them.
OUT-OF-BOUNDS CHECK, measured not assumed: worktree `git status --short` shows exactly the nine expected
#37/#38 paths and nothing else; main root shows only the untracked workflow bookkeeping folder
`kaola-workflow/bundle-37-38-39/`. GitHub Issue #39's body was NEVER edited (mission 14 never ran). So
there is nothing to revert and no recovery action is required. #37/#38's completed work is untouched.

## 14. Issue #39 body revised to the narrowed Claim MCP scope
status: done
item: SUPERSEDES the earlier framing. Rewrite Issue #39's BODY in place (never a comment) to state the
real, narrow gap: within Claim MCP, every successful claim must uniformly enter Kaola Workflow, and a PR
after Workflow completion is default and required. Ground the acceptance range in evidence from the #31
-to-now issues, the commit history since #31, and current code. No contract-level restructuring, no forge
matrix change, no migration.
result: BODY REVISED IN PLACE via `gh issue edit 39 --body-file` (no comment added; verified). The new
body states the confirmed product line, six MEASURED evidence items with file:line, the gap, five
verifiable acceptance criteria A1-A5, and explicit non-goals.
Acceptance recorded on the issue: A1 `docs/DESIGN.md` §15 must say Workflow is REQUIRED after a successful
`claim_task` (not merely 默认) and that the post-Workflow PR is required — design changes first per
AGENTS.md, and `docs/DESIGN.md:356` is the exact line the audit identified. A2 the MCP `initialize`
instructions carry both requirements and are assertable via `workflow-default.test.ts` Section C's
existing real-HTTP technique. A3 `submit_pr`'s description states it is the required completion, with NO
input-schema change (six tools stay six). A4 the four places duplicating the "claim succeeded but no
Workflow target" claim are reconciled (`mcp.ts:100-105`, `workflow-target.ts:34-51`,
`docs/workflow-default.md:38-46`, `docs/architecture.md:142`); `workflow-target.ts` is zero-caller dead
code so its disposition has no runtime effect.
result: DONE and verified by the run owner. Test custody authored
`apps/mcp/src/runner-carrier-observation.test.ts` (registered in the root `test` script) and proved RED:
47 tests, 3 fail — "expected stderr to contain the resolveCarrierIntent observation, got: \"\"". Its
contract is deliberately the least forgiving version: the observation must reach stderr AT STARTUP with
ZERO RPCs sent, so a fix that only reported inside a claim handler would fail by design; plus
exactly-once across two successful claims, and NEGATIVES proving a well-formed runner id, the default
direct path, and stray `KAOLA_RUNNER_*` without `KAOLA_CARRIER` all emit NOTHING (an always-warn fix is
wrong). Expected text is derived by calling `resolveCarrierIntent` inside the test, so wording stays free.
Implementation: 6 inserted lines in `apps/mcp/src/main.ts` only, right after `carrierIntent` is resolved
once per process (~:807) — `if (carrierIntent.carrier === 'advisory') { writeStderr(stderr,
carrierIntent.observation) }`, reusing the existing `writeStderr` helper.
Owner verification: all four MCP suites (runner-carrier-observation, runner-carrier, main, claim-receipt)
= 83 tests / 83 pass / 0 fail; `git diff --stat -- apps/mcp/` shows ONLY `main.ts`, 6 insertions;
`pnpm --filter @kaola/mcp typecheck` clean. Owner additionally checked a risk the brief raised: on
`runner-carrier.ts:32` the advisory variant is `{ carrier: 'advisory'; observation: string }` — observation
is REQUIRED, not optional, so the discriminated union narrows and there is no `undefined` printed to
stderr. Keying is generic on the `carrier === 'advisory'` discriminant, never on runner-id text, so all
four advisory subtypes (bad KAOLA_CARRIER value, unknown runner id, missing session, non-absolute repo)
report uniformly. `runner-carrier.ts`, the receipt schema, `receiptCarrierFields` and all JSON-RPC
behavior are untouched; the test's own token/Authorization canary assertions passed. A5 all four gates green with the new assertions RED first.
Non-goals recorded explicitly: NO change to `claim_task` accept/refuse behavior (ruled out by the 13-file
+ `DESIGN.md:83` evidence in mission 19); NO change to the publishing server, forge matrix (GitHub/GitLab/
Gitea all stay), import framework, native publishing, identity, or publishing schema; no migration; no
irreversible data disposal; no UAT.
COMMENT-COUNT NOTE, checked because the user forbade adding comments: issue #39 shows exactly ONE comment,
authored by the Kaola-Workflow CLAIM SCRIPT at 2026-08-31T12:34:06Z (seconds after claim_ts
12:33:40.699Z), body `<!-- kw:claim project=bundle-37-38-39 -->`. It is the standard mechanical claim
marker written by `node kaola-workflow-claim.js startup`, predates the instruction, and is not commentary.
The run owner added no comment.
OPEN, NOT ACTED ON: the issue TITLE still reads "原生任务没有可用的 Kaola Workflow 目标：上游实测不支持
issue-less 项目", which no longer matches the narrowed body. The user's instruction named the BODY
specifically, so the title was deliberately left untouched and surfaced to the user instead.

## 16. Scope audit of the Claim series first half (#36, #31, #32) against the round's product line
status: done
dispatched: code-reviewer (reasoning `opus`), READ-ONLY, main root
`/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks`; findings return inline.
item: Audit commits 8a49a63 (#36), 5e79230 (#31), 6df018a (#32) against the round's product line —
external forge Issue + token -> Claim MCP -> Workflow MUST start -> PR submitted by default on
completion. Evidence must be the real diff and current code, never impression. Confirm specifically that
this Claim MCP work did NOT expand into the task-publishing server or other existing frameworks.
result: SCOPE-CLEAN — OUT-OF-SCOPE ITEMS FOUND: NONE. All three commits audited from the full diffs
(8a49a63 16 files, 5e79230 11 files, 6df018a 3 files) plus `gh issue view` on each (no comment overrides
any body). Publishing (`tasks.ts`), Issue import (`import.ts`, `parseIssueUrl`), native publishing,
identity/OAuth and ALL of `apps/web` are byte-for-byte untouched across the three commits; GitHub, GitLab
and Gitea all remain with no forge-specific divergence.
CREDENTIAL-PROFILE DELETE GUARD — VERDICT: IN-SCOPE, keep it. The `409 credential_profile_in_use` guard
(credential-profiles.ts:70-78, :253-258) is Claim-lifecycle RETENTION, not a publishing feature: deleting
a profile under a live Claim makes `claim.ts:294-301` throw untyped (claim/replay 500s),
`writeback.ts:24-40` return no token, and `poller.ts:100-108` silently skip the task FOREVER so a 待验收
task never reaches 已完成/已退回 — i.e. it silently kills the verification tail of "-> Workflow -> PR
required". #36's own final body scopes it explicitly. Reverting would restore an irreversible
data-disposal path (admin delete destroys the only copy of the encrypted credential a live Claim and a
pending PR verification still need; the vault holds no second copy) AND withdraw a documented public
contract (named in api.md:166, DESIGN.md:203, architecture.md:35, smoke-test.md:151). NOT REVERTED.
DB SCHEMA, per item: `leases.request_id`, `leases_device_request_identity`, and `submissions_lease_id`
are all CLAIM-LIFECYCLE and in-scope; no publishing table/column/index was added, altered or dropped.
`packages/forge-adapters/src/index.ts` (#31) was scrutinized hardest as the only forge-matrix file in
range: `parsePrUrl` is purely additive, and `stripPrPathnameSuffix` widens PR-URL parsing IDENTICALLY for
all three forges (no forge added, removed, or diverged); `parseIssueUrl`, the import framework's entry
point, is untouched.
PRODUCT LINE: nothing in range permits a claim to skip Workflow or makes the PR optional — Workflow
selection did not exist until #33.
TWO DISCLOSED CROSS-ISSUE LANDINGS, both TEST-ONLY and stated in their commit messages: 8a49a63 also
landed #32's `claim-receipt.test.ts` and 5e79230 also landed #33's `workflow-default.test.ts`, both RED
and unregistered at the time. No production code for another issue rode along.
ALSO REPORTED, NOT ACTED ON (separate decisions, not scope violations): `apps/web/src/App.vue:1884-1887`
renders any non-OK profile delete as a bare `删除失败（409）`, discarding the server's Chinese
explanation; and a task stuck in `进行中` cannot be cancelled directly (`tasks.ts:40-41`), so
`docs/smoke-test.md:151`'s "先把那条任务取消" advice is not directly actionable from that state.
ONE HIGH-SEVERITY DEFECT FOUND — see mission 21.

## 21. AUDIT-HIGH repaired: #36's migration ordering bricks server startup on any legacy database
status: done (result recorded under "21b" below; further repaired under missions 25 and the R1 work)
item: REPRODUCED INDEPENDENTLY BY THE RUN OWNER, not taken on the auditor's word. `apps/server/src/db.ts`
runs `rebuildLeasesIfAgentKeyStillRequired(sqlite)` at line 361 but
`tryAddColumn(sqlite, LEASES_ADD_REQUEST_ID_DDL)` only at line 363 — while 8a49a63 edited that rebuild's
`INSERT INTO leases__rebuild (... request_id) SELECT ... request_id FROM leases` (db.ts:123-145) to
reference the new column. `LEASES_DDL` (db.ts:240-252) does NOT contain `request_id`, so on any database
whose `leases` table still has `agent_key_id NOT NULL` or `claimer_user_id NOT NULL` — exactly the
condition the rebuild exists to repair — the rebuild SELECTs a column that does not yet exist.
OWNER REPRODUCTION: built a legacy sqlite file (leases with `claimer_user_id NOT NULL`, no `request_id`,
one active row) and called the real `createDb` from this worktree. Output:
`RESULT: createDb FAILED -> no such column: request_id`. The WHOLE server, publishing included, cannot
boot. Severity high; introduced by #36 (8a49a63) and already merged to main.
Why no test caught it: `tryAddColumn` (db.ts:92-98) only swallows duplicate-column errors and the failing
statement is the rebuild's own `sqlite.exec`; every existing suite starts from a FRESH database, so
nothing exercises `createDb` against a legacy file. That missing coverage is itself the defect's cause.
Minimal fix: move the single line `tryAddColumn(sqlite, LEASES_ADD_REQUEST_ID_DDL)` to just ABOVE the
rebuild call, and correct the now-stale comment at db.ts:269-272 which asserts the current order is
deliberate. Additive ALTER, idempotent on already-migrated DBs: no data disposal, no public-contract
tradeoff — so per the user's standing instruction this is repaired directly rather than escalated.

## 17. Scope audit of the Claim series second half (#33, #34, #35) against the round's product line
status: done
dispatched: code-reviewer (reasoning `opus`), READ-ONLY, main root; findings return inline.
item: Audit commits 56422fc (#33), cfe50ff (#34), 398bd7f + 1ec170a + bc8b01f (#35) against the same
product line and the same non-expansion requirement. #33 is the highest-risk item because it introduced
`workflow-target.ts` and the issueless_project advisory that #39 is about.
result: SCOPE-CLEAN. All five commits (56422fc, cfe50ff, 398bd7f, 1ec170a, bc8b01f) audited from the real
diffs and rendered IN-SCOPE. Decisive boundary evidence: `git diff --name-only 5e79230..bc8b01f` = 18
files — 4 production (`apps/server/src/mcp.ts`, `apps/server/src/workflow-target.ts`,
`apps/mcp/src/main.ts`, `apps/mcp/src/runner-carrier.ts`), 3 test files, `package.json` (test-list only),
10 docs. UNTOUCHED across the whole range: `tasks.ts`, import, `credential-profiles.ts`, `auth.ts`,
identity, `schema.ts`, `db.ts`, ALL of `packages/forge-adapters/`, ALL of `apps/web/`. GitHub, GitLab and
Gitea all remain, and `lifecycle-matrix.test.ts:1059` exercises shared fixtures across all three. So this
half did NOT expand Claim MCP work into the publishing server or any other existing framework.
Answers to the four questions put to it:
(1) `workflow-target.ts:34-38/42-53/55-68` DOES model a successfully-claimed task with no Workflow target,
but the underlying measurement is FAITHFUL, not a modeling error — the auditor independently re-verified
upstream read-only (kaola-workflow package.json:3 = 10.2.1, `git log -1` = 7e93763e;
kaola-workflow-claim.js:2132-2135 `no_target`; kaola-workflow-adaptive-schema.js:162-170
`claim_issue_numbers_invalid`). The conflict arose because the product line was CORRECTED after the
measurement, not because #33 got the measurement wrong.
(2) `workflowTargetForTask` has ZERO production callers — definitively: 16 grep hits, 15 in
`workflow-default.test.ts` and one definition at `workflow-target.ts:55`; the only import anywhere is the
test's dynamic import at `workflow-default.test.ts:226`. Consequences: the `available:false` branch has NO
runtime effect, so #39's gap cannot currently produce a wrong response, DB row, or forge call; the claim
reaches Agents through exactly ONE production surface, the prose at `apps/server/src/mcp.ts:100-105`; and
the dead code is openly disclosed (`docs/architecture.md:142`, `CHANGELOG.md:8`), which is the opposite of
overreach.
(3) NEITHER the instructions nor any tool description makes Workflow or the PR optional. `mcp.ts:95-98`
says "没有 explicit 请求就永远走 Workflow 直连，也绝不在两者之间静默切换" — the opposite of optional. The
real nuance: it says 默认值 (default), never "required". CRITICAL POINTER FOR MISSION 14: the frozen
contract `docs/DESIGN.md:356` also says only "默认由当前 MCP Agent 直接运行 Kaola Workflow", and it was
frozen by 5458e1b — BEFORE this audit range, so no audited commit weakened it. If "every successful claim
MUST enter Workflow" is now the contract, `docs/DESIGN.md:356` is exactly where that must be written.
(4) Project Runner is NOT a non-Workflow path — `apps/mcp/src/runner-carrier.ts` contains no execution
path at all (pure env interpretation, never spawns), and `docs/runner-carrier.md:49-52` makes the Workflow
worktree/checkout a PRECONDITION of Runner start, while `:66-72` keeps Claim control, credentials and
`submit_pr` with the MCP Agent. Runner selects WHERE Workflow runs, never WHETHER. No conflict.
ESCALATED TO THE FIRST-HALF AUDIT (outside this range): 398bd7f only DOCUMENTS that
`DELETE /api/v1/credential-profiles/:id` now refuses `409 credential_profile_in_use`, which IS
publishing-server behavior; the code lives in `credential-profiles.ts` and was implemented by 8a49a63
(#36), i.e. the first half. A verdict on it has been formally requested from that auditor.

## 20. AUDIT-R1 repaired: the explicit Runner advisory observation is computed and then silently discarded
status: done
dispatched: tdd-guide (standard `sonnet`) for acceptance, then implementation; worktree
`.kw/worktrees/bundle-37-38-39`. Output lands in `apps/mcp/src/main.ts` and its test.
item: Found by the second-half scope audit; low severity, in-scope, no contract tradeoff, no data
disposal. `resolveCarrierIntent` (`apps/mcp/src/runner-carrier.ts:58-63`) returns
`{ carrier: 'advisory', observation: 'unknown or missing KAOLA_RUNNER ...' }` for a malformed explicit
Runner selection, but its sole consumer `receiptCarrierFields` (`apps/mcp/src/main.ts:491-505`) reads only
`intent.carrier` and discards `observation` — grep for "observation" in `apps/mcp/src/main.ts` returns
ZERO hits, so it never reaches stderr. Trigger: run kaola-mcp with `KAOLA_CARRIER=runner` and
`KAOLA_RUNNER=claude` (the pinned id is `claude-code`). A user who mistypes the runner id and never claims
gets TOTAL SILENCE; the only trace is `carrier:"advisory"` inside a 0600 receipt, and only if a later
claim succeeds. This contradicts `docs/runner-carrier.md:88-94`. The bridge already has `writeStderr` and
uses it at `apps/mcp/src/main.ts:718-721`. Minimal fix: one `writeStderr` of `intent.observation` at
bridge startup when `carrier === 'advisory'`, under independent test custody since
`runner-carrier.test.ts` currently asserts only the pure function's return value, never a reporting side
effect.
result: DONE and verified by the run owner. Test custody authored
`apps/mcp/src/runner-carrier-observation.test.ts` (registered in the root `test` script) and proved RED:
47 tests, 3 fail — "expected stderr to contain the resolveCarrierIntent observation, got: \"\"". Its
contract is deliberately the least forgiving version: the observation must reach stderr AT STARTUP with
ZERO RPCs sent, so a fix that only reported inside a claim handler would fail by design; plus
exactly-once across two successful claims, and NEGATIVES proving a well-formed runner id, the default
direct path, and stray `KAOLA_RUNNER_*` without `KAOLA_CARRIER` all emit NOTHING (an always-warn fix is
wrong). Expected text is derived by calling `resolveCarrierIntent` inside the test, so wording stays free.
Implementation: 6 inserted lines in `apps/mcp/src/main.ts` only, right after `carrierIntent` is resolved
once per process (~:807) — `if (carrierIntent.carrier === 'advisory') { writeStderr(stderr,
carrierIntent.observation) }`, reusing the existing `writeStderr` helper.
Owner verification: all four MCP suites (runner-carrier-observation, runner-carrier, main, claim-receipt)
= 83 tests / 83 pass / 0 fail; `git diff --stat -- apps/mcp/` shows ONLY `main.ts`, 6 insertions;
`pnpm --filter @kaola/mcp typecheck` clean. Owner additionally checked a risk the brief raised: on
`runner-carrier.ts:32` the advisory variant is `{ carrier: 'advisory'; observation: string }` — observation
is REQUIRED, not optional, so the discriminated union narrows and there is no `undefined` printed to
stderr. Keying is generic on the `carrier === 'advisory'` discriminant, never on runner-id text, so all
four advisory subtypes (bad KAOLA_CARRIER value, unknown runner id, missing session, non-absolute repo)
report uniformly. `runner-carrier.ts`, the receipt schema, `receiptCarrierFields` and all JSON-RPC
behavior are untouched; the test's own token/Authorization canary assertions passed.


## 18. R1 repaired: #37's client deadline must not turn a working-but-slow forge into duplicate Issue comments
status: done
dispatched: tdd-guide (standard `sonnet`) for acceptance, then implementer, in worktree
`.kw/worktrees/bundle-37-38-39`.
item: The independent review of the frozen #37/#38 candidate found ONE real defect, R1 (medium,
candidate-caused). Mechanism, traced: a self-hosted GitLab/Gitea whose comment POST takes >10s but DOES
create the comment now gets aborted client-side at `DEFAULT_TIMEOUT_MS`; `attemptWriteback`
(writeback.ts:96-104) swallows the abort and writes no `回写 ok` event even though the comment exists on
the forge; `retryPendingWritebacks` has no attempt cap, no backoff and no idempotency key, so it re-posts
on EVERY 60s tick (app.ts:65-74), each pass leaving another visible comment on a real customer's Issue.
Before #37 the slow POST simply completed and posted exactly once.
CHOSEN FIX AND WHY IT IS THE MINIMAL ONE: give the write-back call site (writeback.ts:68) its own longer
deadline than the read paths, using the `timeoutMs` option #37 already added. This needs no new
mechanism, no change to the retry framework, and no public-contract tradeoff. The alternative the reviewer
raised — capping or backing off `retryTaskWritebacks` attempts — WOULD change #14's established
recovery-forever semantics, which is a public-contract tradeoff, so per the user's standing instruction it
is NOT taken unilaterally; it is recorded below as an open observation for the user instead.
HONEST LIMIT OF THIS FIX, to be carried into the final summary: a longer deadline NARROWS the window, it
does not eliminate it. A forge persistently slower than the write-back deadline would still loop. That
residual is pre-existing in shape (a forge returning 5xx already retries forever) and is left to the
user's judgment rather than silently resolved.
result: DONE and verified by the run owner. Test custody authored `apps/server/src/writeback-timeout.test.ts`
(registered in the root `test` script) asserting at the writeback.ts seam that the write-back configures an
EXPLICIT `AbortSignal.timeout(ms)` distinct from, and strictly greater than, what a no-`timeoutMs`
`createForgeAdapter` produces — measured empirically in-run so it neither hardcodes the constant nor can be
satisfied by globally bumping `DEFAULT_TIMEOUT_MS` (a global bump moves baseline and write-back together and
still fails the strict inequality). RED first: "write-back must configure an EXPLICIT deadline distinct from
the adapter default (both were 10000ms)". Implementation: `apps/server/src/writeback.ts` gained a named
`WRITEBACK_TIMEOUT_MS = 30_000` (3x the read default) with a comment naming the abort-after-commit ->
duplicate-comment failure mode, passed only at the single `createForgeAdapter` call site in `postComment`.
Verified: writeback-timeout 1/1 pass; writeback + claim-identity + poller + webhook = 63 tests / 63 pass;
`pnpm --filter @kaola/server typecheck` clean. Confirmed no read path touched, `DEFAULT_TIMEOUT_MS` and
`packages/forge-adapters/src/index.ts` unchanged, and NO retry cap/backoff/idempotency key added — #14's
recovery-forever semantics are intact, leaving that public-contract tradeoff with the user.

## 21b. (result for mission 21)
status: done
result: FIXED AND VERIFIED TWO INDEPENDENT WAYS. Test custody authored `apps/server/src/db-migration.test.ts`
(registered in the root `test` script — the missing registration is why no suite covered this) with 4 cases:
the `claimer_user_id NOT NULL` legacy shape, the `agent_key_id NOT NULL` variant (a separately reachable
branch of the same OR guard at db.ts:120), idempotence on a second `createDb` call, and a fresh-database
regression check. RED at 8d3504e: 3 fail / 1 pass, all three failing with SQLITE_ERROR
"no such column: request_id"; the fresh-DB case passing proves it is a targeted regression test, not a false
failure.
Fix applied by the run owner in `apps/server/src/db.ts`: moved the single line
`tryAddColumn(sqlite, LEASES_ADD_REQUEST_ID_DDL)` to ABOVE `rebuildLeasesIfAgentKeyStillRequired(sqlite)`,
and rewrote the stale comment which had asserted the opposite reasoning ("added after
rebuildLeasesIfAgentKeyStillRequired so that rebuild's own INSERT ... SELECT ... runs against whatever the
on-disk table looked like beforehand") — that reasoning was exactly backwards, since the rebuild's SELECT
READS request_id and so needs the column to exist first.
Verification: `db-migration.test.ts` 4 tests / 4 pass / 0 fail. AND the run owner's own original
reproduction, unchanged, now prints `RESULT: createDb SUCCEEDED` where it previously printed
`RESULT: createDb FAILED -> no such column: request_id`. No data disposal (the ALTER is additive, the
rebuild's INSERT...SELECT is unchanged, and the test pins row survival), no public-contract change.

## 19. Measured evidence for #39's narrowed acceptance (feeds mission 14)
status: done
dispatched: self (inline, run owner), read-only over main root
result: MEASURED, and it rules one candidate reading OUT.
(a) `apps/server/src/claim.ts` contains ZERO references to `sourceType` / `sourceIssueUrl` — Claim MCP
today does not care whether the task it is claiming has an external forge Issue. `apps/server/src/tasks.ts:618`
persists whatever `source.type` the publisher chose, so native tasks remain creatable (publishing server
unchanged, as required).
(b) So a task with no forge Issue CAN be successfully claimed today, and such a claim has no Workflow
target — which is exactly the "无 Workflow 路径" the corrected product line forbids. That is the real gap
#39 names.
(c) BUT the candidate fix "make claim_task refuse a task without a forge Issue" is RULED OUT as
non-minimal and contract-level: 13 existing test files both create AND claim a native task
(claim.test.ts, claim-identity.test.ts, claim-fencing.test.ts, claim-confirm.test.ts, mcp.test.ts,
devices.test.ts, events.test.ts, identity.test.ts, lifecycle-matrix.test.ts, poller.test.ts,
webhook.test.ts, writeback.test.ts, workflow-default.test.ts). And `docs/DESIGN.md:83` freezes the state
machine entry as "[*] --> 待认领: 发布/导入", i.e. BOTH manual publish and import reach 待认领;
`docs/DESIGN.md:9` states manual creation as a first-class capability. Enforcing refusal would strip
native publishing of its purpose — precisely the contract-level restructuring the user forbade.
(d) `apps/server/src/mcp.ts:95-96` states Workflow as "默认路径 … 减法优先的默认值（default）" — DEFAULT,
not required. Under the corrected line every successful claim must UNIFORMLY enter Workflow, so this
wording is weaker than the contract now requires.
(e) No MCP tool description states that submitting a PR after Workflow completion is required;
`submit_pr`'s description (mcp.ts:181) is purely mechanical ("After a PR or MR exists on the forge …").
(f) `workflowTargetForTask` remains DEAD production code — called only from `workflow-default.test.ts`;
the mapping reaches Agents solely as prose in `KAOLA_MCP_INSTRUCTIONS`.
CONCLUSION CARRIED INTO MISSION 14: #39's minimal, in-scope acceptance is about the Claim MCP CONTRACT
SURFACE — Workflow required for every successful claim rather than merely default, PR required on
completion, and no modeled "claim succeeded but no Workflow" outcome — NOT about enforcing refusal at
claim time and NOT about touching publishing, the forge matrix, import, or native publishing.

## RUN POSTURE UPDATE — continuation and termination conditions (from the user, mid-run)
status: standing instruction, not a mission
- Do NOT stop after #37/#38/#39. After this all-or-nothing bundle is complete, merged (sink), closed and
  archived, FRESHLY query the forge for ALL open issues.
- If any open issue remains — including follow-ups created from this round's own discoveries — continue
  via /workflow-next, by priority, one at a time or in sensible groups. Never redo a done Mission and
  never reopen a closed Issue.
- Only when the repository genuinely has ZERO open issues, AND all completed work is verified, merged,
  closed and archived, report to the controller that Cloud Code may stop.
- Do NOT perform a final smoke/UAT. After zero open issues, the CONTROLLER personally runs an independent
  end-to-end smoke test in this environment: real server start, existing GitLab/Gitea accounts and tokens,
  publish/import a task, MCP claim, Workflow, PR/MR, and the completion loop. They are authorized to use
  Computer Use, CLI, the Codex app, and to install/use this project's MCP.
- UAT remains FORBIDDEN during the issue-implementation phase, and no smoke/UAT result may ever be
  recorded as Issue acceptance.
FOLLOW-UPS ALREADY IDENTIFIED THIS ROUND that may warrant issues once the bundle closes (do NOT act on
them inside this bundle): (a) `retryPendingWritebacks` has no attempt cap/backoff/idempotency key, so a
forge persistently slower than the write-back deadline still re-posts duplicate comments — deliberately
left as a public-contract tradeoff for the user; (b) `apps/web/src/App.vue:1884-1887` renders any non-OK
credential-profile delete as a bare `删除失败（409）`, discarding the server's Chinese explanation;
(c) a task stuck in `进行中` cannot be cancelled directly (`tasks.ts:40-41`), so `docs/smoke-test.md:151`'s
"先把那条任务取消" advice is not actionable from that state; (d) `writeback.test.ts`'s stub records
`headers` and some failure messages `JSON.stringify` that array, which would print an Authorization header
into test output (pre-existing, not candidate-caused).

## 22. #39 docs must not assert the impossible (caught by the run owner during verification)
status: done (result recorded under "22b" below)
dispatched: impl-39-contract (resumed with its context), worktree `.kw/worktrees/bundle-37-38-39`
item: The #39 implementation made all 15 acceptance tests green, and the run owner verified every stated
NON-GOAL was honored — `claim.ts` still has ZERO `sourceType`/`sourceIssueUrl` references (claim
accept/refuse unchanged), `tasks.ts` / `schema.ts` / `apps/web/` are absent from the diff entirely, all
three forges remain, and the only `packages/forge-adapters` change is #37's timeout work. BUT the docs now
assert something MEASURABLY IMPOSSIBLE: `docs/workflow-default.md` says "native 任务（没有既有 Issue）与
imported 任务统一进入 Workflow，没有 issue-less 例外" and `docs/architecture.md:142` says "a native Task
still requires Workflow to start even though it has no forge Issue". Upstream refuses `no_target`
(kaola-workflow-claim.js:2132-2135) and throws `claim_issue_numbers_invalid`
(kaola-workflow-adaptive-schema.js:162-170) without an issue number — re-verified twice this round — so a
task with no Issue CANNOT start Workflow. The truthful measurement documenting this was deleted and
replaced by an assertion that the impossible is mandatory, which is worse than the stale text it replaced.
CRITICALLY, the acceptance does NOT force this: `assertSentenceContainsAll` at
workflow-default.test.ts:484-486 needs only ONE sentence containing (每|所有)+(成功)+(认领), Workflow, and
(必须|required|must). It is satisfiable truthfully. The correct framing is the user's own premise — Claim
MCP operates on tasks originating from an external forge Issue, and every such successful claim must enter
Workflow — without claiming anything about the impossible issue-less case.

## 23. Full four-gate validation re-run on the FINAL frozen candidate
status: done
dispatched: self (inline, run owner), worktree `.kw/worktrees/bundle-37-38-39`
item: Mission 8's gate predated five later changes (write-back deadline, db migration fix, mcp stderr,
#39 contract, #39 docs), so its evidence no longer covered the candidate. Re-run everything on the frozen
bytes rather than cite stale green.
result: ALL FOUR GATES GREEN on the final candidate.
`pnpm typecheck` — all 5 workspace projects Done, exit 0. `pnpm lint` (`eslint .`) — no output, clean.
`pnpm test` — node runner 797 tests / 213 suites / 797 pass / 0 fail, then `@kaola/web` vitest 6 files /
117 tests / 117 pass. TOTAL 914 passing, 0 failing. `pnpm build` — packages/shared,
packages/forge-adapters, apps/server, apps/mcp tsc Done; apps/web vite built in 2.17s; exit 0. The only
non-success line is vite's pre-existing >500kB chunk advisory for apps/web, present before this bundle.
TEST-COUNT ARITHMETIC RECONCILED (not just observed): 789 -> 797 = +10 genuinely new tests
(db-migration 4, runner-carrier-observation 5, writeback-timeout 1) minus 2 net in
`workflow-default.test.ts`, where #39 retired 10 assertions pinning the now-retired `issueless_project`
contract and added 8 pinning the new one. The delta is fully explained; no test silently vanished.
FROZEN CANDIDATE = 16 modified files, 1 deletion (`apps/server/src/workflow-target.ts`), 4 new test files
(`timeout.shared.test.ts`, `writeback-timeout.test.ts`, `db-migration.test.ts`,
`runner-carrier-observation.test.ts`).
NOT RUN AND NOT CLAIMED: no UAT, no smoke test, none of `docs/smoke-test.md`'s 配合 browser/OAuth/device/
real-token steps, and `pnpm smoke:forge` was not run. The controller performs the independent end-to-end
smoke test personally after the repository reaches zero open issues.

## 24. FINAL REVIEW verdict: FAIL, 4 blocking findings — recorded before repair
status: done
dispatched: code-reviewer (reasoning `opus`), whole 7-change frozen candidate
result: VERDICT FAIL, 4 blocking. The gate being green (914 tests) did NOT mean the candidate was correct
— this is the second time this run that an independent reviewer overturned green evidence.
R1 HIGH — THE MIGRATION FIX DOES NOT REPAIR A REAL LEGACY DEPLOYMENT. `sqlite.exec()` is NOT
transactional. On the PRE-fix build the rebuild's first statement `CREATE TABLE leases__rebuild` COMMITTED
and only the following `INSERT ... SELECT ... request_id` threw, so the orphan table is durably on disk.
Every realistic legacy deployment is in that state — that failed boot is HOW the bug was discovered. On
the fixed build the same CREATE now fails with `table leases__rebuild already exists`, permanently, on
every boot. REPRODUCED BY THE RUN OWNER: seeded a legacy DB plus an orphan `leases__rebuild`, then
`RESULT boot#1: FAILED -> table leases__rebuild already exists` and `boot#2` identical. My own earlier
reproduction seeded a PRISTINE legacy table and so missed this entirely — as does
`db-migration.test.ts`, which is green while the real upgrade path stays bricked. Fix shape:
`DROP TABLE IF EXISTS leases__rebuild` before the CREATE, and wrap the rebuild in a transaction so a
mid-way fault leaves no residue.
R2 MEDIUM — the INVERSE overclaim. The `no_target` overclaim is genuinely gone, but the docs and the MCP
instructions now assert unconditionally that every successful claim carries an Issue, while the server
still mints issue-less claims: `tasks.ts:117` defaults an omitted `source` to `{ type: 'native' }` and
`claimTask` has zero `sourceType`/`sourceIssueUrl` references. An Agent that claims a native task and
obeys `KAOLA_MCP_INSTRUCTIONS` would start Workflow with no issue number and hit the very
`no_target`/`claim_issue_numbers_invalid` refusal this bundle cites. Anchors mcp.ts:98,
docs/DESIGN.md:356, docs/workflow-default.md:31-37, docs/architecture.md:142.
R3 MEDIUM — three documents (docs/api.md:533, docs/architecture.md:160, CHANGELOG.md:7) still assert
"None of the six production `createForgeAdapter` call sites ... passes `timeoutMs`", contradicted by
`writeback.ts:75` which passes 30_000; the CHANGELOG also cites the stale line `writeback.ts:68`. The 30s
deadline is documented NOWHERE, and neither the db.ts migration fix (operator-facing — it decides whether
a server boots) nor the mcp stderr fix has any CHANGELOG entry.
R4 LOW — the #39 A3 assertion cannot fail on the property it names.
`assertSentenceContainsAll`'s split regex finds no sentence boundary in submit_pr's English description
(no 。, and its only ". " is followed by lowercase `claim_id`), so "sentence-scoped" degenerates to
whole-text matching and the pre-existing "claim_id is required..." clause satisfies the requirement token.
A description that merely mentions Workflow anywhere passes. A2's Chinese prose is unaffected.
R5 LOW, note only — backgrounding the 提交PR write-back allows a fast merge's awaited 完成 comment to
precede the still-in-flight 提交PR comment. Cosmetic ordering on a real Issue, no state effect.
REVIEWER CONFIRMATIONS, all independently useful: the 30s deadline is NOT a regression on the awaited
完成 path (at base those fetches had NO timeout, so unbounded became bounded); it cannot wedge app.ts's
`polling` guard; a held-open webhook may be redelivered but redelivery is harmless because
`applyPrTerminalTransition` commits before the write-back so `findPendingReviewMatch` then returns
undefined. Nothing imports the deleted module. The stderr write cannot carry credential material. Scope
is unchanged — publishing, the three-forge matrix, import, identity and the publishing schema untouched.
The #39 assertion retirement was judged LEGITIMATE contract retirement, not weakening, with one coverage
observation: "Kaola Tasks never creates a forge Issue" is still true but now unasserted (no production
code can create an Issue, so this is an observation, not a defect).

## 25. R1's causal class inventoried: BOTH rebuilds are non-atomic and non-idempotent
status: done
dispatched: self (inline, run owner), read-only over `apps/server/src/db.ts`
item: Before repairing R1, inventory the causal class rather than patching only the reported instance.
result: TWO instances of the identical defect pattern, not one.
(a) `rebuildLeasesIfAgentKeyStillRequired` (db.ts:117-150) — the reported R1. Its `sqlite.exec` runs
`CREATE TABLE leases__rebuild` / `INSERT ... SELECT` / `DROP TABLE leases` / `ALTER ... RENAME` as four
separately-committing statements with no transaction and no `IF NOT EXISTS`/`DROP IF EXISTS` guard.
(b) `rebuildClaimConfirmationsIfAgentKeyStillRequired` (db.ts:152-176) — the SAME shape:
`CREATE TABLE claim_confirmations__rebuild` / `INSERT ... SELECT` / `DROP TABLE claim_confirmations` /
`ALTER ... RENAME`, equally unguarded and equally non-atomic.
DIFFERENCE IN CURRENT REACHABILITY: (b) does NOT carry #36's specific column bug — its SELECT reads only
columns that exist on the old table, so it has no known trigger today. But the FAILURE MODE is identical:
any mid-rebuild fault, crash, power loss or killed container between the CREATE and the RENAME leaves an
orphan `*__rebuild` table on disk, after which every subsequent boot dies on
`table ..._rebuild already exists` — permanently, with no self-recovery, because neither rebuild is
guarded and `tryAddColumn`'s swallow (db.ts:92-98) covers only duplicate-column errors and does not apply
here at all.
DECISION: repair BOTH under the same causal class, since the fix is the same two changes (a
`DROP TABLE IF EXISTS <name>__rebuild` before the CREATE, and wrapping the statement group in a
transaction so a mid-way fault leaves no residue). Fixing only (a) would leave an identical
boot-bricking landmine one crash away in the sibling. This is causal-class repair, not scope creep: the
reviewer named the non-atomic multi-statement `exec` as R1's ROOT CAUSE, and (b) is that same root cause.

## 26. R2 repaired: the required-Workflow contract is now scoped instead of asserted unconditionally
status: done
dispatched: implementer (standard `sonnet`) in worktree `.kw/worktrees/bundle-37-38-39`; verified by the
run owner directly (the agent went idle without transmitting a report, so the work was inspected rather
than taken on its word).
item: Fix the inverse overclaim — docs and the shipped MCP instructions asserted unconditionally that
every successful claim carries a forge Issue, while `tasks.ts:117` still defaults an omitted `source` to
`{ type: 'native' }` and `claim.ts` never checks, so an Agent could claim a native task, obey the
instructions, and attempt a Workflow start that upstream refuses.
result: FIXED on all four surfaces, and verified by the run owner reading each one.
`apps/server/src/mcp.ts` `KAOLA_MCP_INSTRUCTIONS` now opens the requirement with its scope — "本约定覆盖
来自外部 forge Issue、随任务携带该 Issue 凭证（source.issue_url）的任务——该 Issue 就是 Workflow 目标。
对这类任务，认领任务成功后…必须（required）…启动并运行 Kaola Workflow" — keeps 必须 for the PR
(“Kaola Workflow 完成后，Agent 必须（required）调用 submit_pr”), and adds the honest negative: "若认领到
的任务没有随附的 forge Issue（例如 native 任务），则不在本约定范围内：Kaola Workflow 本身启动要求至少
一个 Issue 编号（已实测 no_target / claim_issue_numbers_invalid 拒绝），因此无法为其启动 Workflow."
`docs/DESIGN.md:356` and `docs/workflow-default.md:37` carry the same scoping and the same honest
negative. `docs/architecture.md:142` was already scoped by the earlier overclaim correction ("#39's scope
is tasks that originate from an external forge Issue … every successful claim on such a task now must
start Workflow").
Verification: `workflow-default.test.ts` = 15 tests / 15 pass / 0 fail — the scoped sentences still
satisfy the sentence-scoped assertions, so truth and green are compatible here.
DESIGN NOTE FOR THE USER, surfaced not buried: "every successful claim enters Workflow" can only be
LITERALLY true if native tasks stop being claimable, which the user ruled out as contract-level
restructuring (and #39 records as a non-goal with 13-file evidence). So the contract is now SCOPED rather
than unconditional. The requirement's strength is unchanged for the tasks Claim MCP actually faces; what
changed is that the docs no longer assert something the server contradicts. Gating the claim path
remains available to the user as a larger, separate decision.
MINOR, ACCEPTED AS-IS: `docs/architecture.md:142`'s opening sentence still summarizes the instructions
unconditionally before scoping them two sentences later. Imprecise summary, not a false claim, and the
scoping follows immediately — not worth another edit cycle.

## 27. R4 repaired: the #39 A3 assertion could not fail on the property it named
status: done
dispatched: tdd-guide (standard `sonnet`), test custody, worktree `.kw/worktrees/bundle-37-38-39`
result: FIXED WITH PROOF IN BOTH DIRECTIONS. Root cause confirmed: `assertSentenceContainsAll`'s split
regex `/(?<=。)|(?<=\.)\s+(?=[A-Z一-鿿])/` never fires on `submit_pr`'s English description (no `。`, and
its single ". " is followed by lowercase `claim_id`), so the whole string was ONE "sentence" and the
unrelated pre-existing clause "claim_id is required for a Claim minted with request_id" supplied the
requirement token for a completely separate Workflow mention. A test titled "states it is the required
completion of the Workflow path" therefore passed for any description merely mentioning Workflow.
Fix: a new narrowly-scoped helper `assertClauseContainsAll` splitting on `/(?<=[.。])\s*/` (any boundary,
case-insensitive to what follows), applied ONLY to the A3 test. `assertSentenceContainsAll` and every
other call site — A2's Chinese instruction tests and the doc-text tests — were left untouched, since that
prose has `。` separators and splits correctly.
PROOF, which is what makes this credible rather than asserted: real shipped description passes = true;
a weakened description that mentions Workflow but never calls it required fails = true; and the OLD
helper on that same weakened string incorrectly passes = true, independently confirming the reported bug.
`workflow-default.test.ts` stays 15/15 with an unchanged test count.

## 28. R3 repaired: three docs contradicted the shipped 30s deadline; two landed changes were undocumented
status: done
dispatched: doc-updater (standard `sonnet`), docs only, worktree `.kw/worktrees/bundle-37-38-39`
result: FIXED. `docs/api.md:533`, `docs/architecture.md:160` and the `#37` CHANGELOG entry now state the
true 5+1 split — five call sites run under the 10s default, and the sixth (`writeback.ts`'s `postComment`)
deliberately passes `timeoutMs: WRITEBACK_TIMEOUT_MS` (30_000). The stale `writeback.ts:68` citation was
DROPPED rather than replaced with a number that will drift again (the call site is now :75).
The previously-undocumented 30s deadline is now documented in `docs/api.md:391/:395` (the shown
`createForgeAdapter` call includes `timeoutMs`, plus a new paragraph) and `docs/architecture.md:124` —
including WHY (an abort after the forge already committed the comment leaves no successful `回写` event,
and the uncapped `retryPendingWritebacks` sweep then reposts it every tick) and, importantly, the honest
caveat that 30s NARROWS but does NOT eliminate the window: a forge persistently slower than 30s still
loops.
Two CHANGELOG entries added for landings that had none: the `#34` mcp stderr observation fix, and the
`#36` migration ordering fix — the latter operator-facing, naming the exact `no such column: request_id`
failure mode.
NOTABLE HONESTY, unprompted: the doc-updater independently checked `apps/server/src/db.ts`, confirmed
`rebuildLeasesIfAgentKeyStillRequired` still has no `DROP TABLE IF EXISTS leases__rebuild` guard, and
therefore deliberately did NOT claim the legacy upgrade path is fully repaired — exactly the overclaim
this run has had to correct twice already.
REPORTED, NOT TOUCHED: the historical `#39` and `#33` CHANGELOG entries still contain the literal strings
`issueless_project` / `available: false` / `advisory-unavailable`, but as RETROSPECTIVE descriptions of
what those issues did and retired, not live claims; the token/term scans only cover live doc and
instruction text and remain green.

## 29. Adversarial verification of the four repairs, and the one contradiction it refuted
status: done
dispatched: adversarial-verifier (reasoning `opus`), read-only on tracked files
result: CLAIMS 1, 3, 4 CONFIRMED EMPIRICALLY; CLAIM 2 REFUTED and then repaired by the run owner.
CLAIM 1 (the merge blocker) — CONFIRMED SAFE, and the data-loss scenario the run owner feared is NOT
real. The verifier constructed the exact dangerous on-disk state (`leases` ABSENT, `leases__rebuild`
holding the ONLY copy, 2 rows) and ran the real `createDb`: `boot#1 SUCCEEDED`, `boot#2 SUCCEEDED`, and
`leases__rebuild rows = 2` afterwards — the only copy SURVIVES, never dropped. The mechanism is exactly
as the run owner reasoned: `LEASES_DDL` declares `claimer_user_id INTEGER` / `agent_key_id INTEGER`
nullable, so the guard at db.ts:126-130 returns early and the `DROP TABLE IF EXISTS` is never reached.
General argument the test confirms: the DROP is reachable ONLY when `leases` exists AND still declares
one of those columns NOT NULL, which entails the pre-crash `DROP TABLE leases` never ran, which entails
`leases` still holds the authoritative rows — so the orphan is ALWAYS a copy whenever the DROP can run.
Also tested the reachable non-empty-orphan case (crash after INSERT, before DROP): all rows intact,
orphan cleared, no residue, idempotent, and `sqlite_sequence` AUTOINCREMENT monotonicity preserved.
TRANSACTION ATOMICITY — proven two ways, with a DISCRIMINATING CONTROL, which is what makes it credible:
`journal_mode` is `delete`, not WAL. An injected exception mid-script rolled back every DDL step
including the DROP and RENAME, verified after reopening the file from disk. Then a real SIGKILL sweep
across 300-1900ms of a ~1.7s migration on a 6M-row legacy DB: 33/33 killed-while-alive trials produced
0 orphan tables, 0 rows lost, 0 failed reboots — while the SAME sweep against the PRE-repair shape
produced a durable orphan in 28/28 trials. The harness detects precisely the fixed failure and the
repaired code never produces it. The verifier also self-corrected: its first two sweeps were invalid
(the baseline file had already migrated) and it re-seeded and redid them rather than report the bad runs.
`rebuildClaimConfirmationsIfAgentKeyStillRequired` got the same treatment and the same answers
(only-copy survives; exception rollback verified; 12/12 clean SIGKILL trials).
CLAIM 3 CONFIRMED — all five previously-unverified line citations (credential-profiles.ts:176,
poller.ts:104, webhook.ts:78, tasks.ts:562, tasks.ts:708) are still correct; the sixth is writeback.ts:75
passing `timeoutMs: WRITEBACK_TIMEOUT_MS` (= 30_000 at :24); the adapter has exactly two `fetch(` sites
(:379, :666) both carrying the signal, so "every method except parseWebhook" is accurate, not approximate;
and the "narrows but does not eliminate" caveat matches the code (retryPendingWritebacks still has no
attempt counter and no backoff).
CLAIM 4 CONFIRMED — against the degenerate description (Workflow mentioned, never stated required) the
old helper PASSES and the new one FAILS, with the shipped description passing both.
`assertClauseContainsAll` has exactly one call site, and `assertSentenceContainsAll` did not exist at the
fork point, so all its call sites are new in this bundle rather than modified. Nothing weakened.
ALSO CONFIRMED: migration ORDER intact (the only non-comment db.ts changes vs 8d3504e are the two
transaction wrappers, the two DROP lines, and the ALTER moving to :388 before the rebuild at :389); ZERO
column or index definitions changed; and no forge token can reach logs because there is no log surface at
all (zero console.*/app.log/logger calls in any production source).
TWO NON-BLOCKING OBSERVATIONS, neither candidate-caused: (a) the only-copy state migrates but silently
retains the orphan forever while `leases` comes up empty — caused by the OLD crash, made unreachable
going forward by the transaction; (b) a legacy DB with two `active` leases on one task_id fails to boot
on the pre-existing unique index — and the transaction IMPROVES it, leaving the file fully un-migrated
with data intact instead of half-migrated.

## 30. CLAIM 2's refutation repaired: workflow-default.md's headline section contradicted the rest of the file
status: done
dispatched: self (inline, run owner)
item: The verifier refuted Claim 2. `docs/workflow-default.md:8-13` — the file's HEADLINE section, which
the R2 repair never touched — still said "认领任务成功后，当前 Agent 的默认（default）行为是直接运行
Kaola Workflow …这是减法优先的默认值". It failed in BOTH directions at once: it OVER-claimed scope
("认领任务成功后" unconditionally over every claim, implicitly re-asserting that every claim has an
Issue — the very thing R2 removed elsewhere), and it UNDER-claimed the requirement (默认/default, never
必须), contradicting `docs/DESIGN.md` §15, `apps/server/src/mcp.ts` and `docs/architecture.md:142` inside
the same document. No test caught it: the suite only requires the file to match /Workflow/i, /default/i
and /explicit/i, and a DIFFERENT bullet already satisfied the 必须 sentence assertion — 21/21 passed with
the contradiction present.
result: REWRITTEN by the run owner. Title now "直连 Kaola Workflow：默认承载，且是强制要求
（Issue #33 → #39）"; the section heading is now "必须直连 Workflow：无需显式请求，也不允许省略"; the
body scopes to tasks carrying an external forge Issue, states the Agent 必须（required）直接
（directly）运行 Kaola Workflow, and adds the same honest negative about no-Issue tasks used elsewhere.
"默认（default）承载" is retained deliberately — "default" is still TRUE and load-bearing for the CARRIER
choice (Workflow is the default carrier; Runner requires an explicit request), which is also what the
/default/i assertion legitimately checks. Verified: `workflow-default.test.ts` + `db-migration.test.ts`
= 21 tests / 21 pass / 0 fail, and the unconditional "默认行为" claim is gone.

## 31. FINAL four-gate validation on the post-repair frozen candidate
status: done
dispatched: self (inline, run owner), worktree `.kw/worktrees/bundle-37-38-39`
item: Mission 23's gate predated the four blocking repairs (R1 rebuild guards, R2 scoping, R3 docs, R4
assertion) and the workflow-default.md headline rewrite, so re-run everything rather than cite it.
result: ALL FOUR GATES GREEN on the final bytes. `pnpm typecheck` — 5 projects Done. `pnpm lint` — clean.
`pnpm test` — node runner 799 tests / 799 pass / 0 fail, plus `@kaola/web` vitest 117/117. TOTAL 916
passing, 0 failing. `pnpm build` — 4 build targets Done, exit 0.
FINAL CANDIDATE: 16 modified files, 1 deletion (`apps/server/src/workflow-target.ts`), 4 new test files.
PROCESS NOTE CARRIED FORWARD FROM THE FIRST REVIEW, still live and easy to get wrong at commit time: the
four new test files are UNTRACKED — `packages/forge-adapters/src/timeout.shared.test.ts`,
`apps/server/src/writeback-timeout.test.ts`, `apps/server/src/db-migration.test.ts`,
`apps/mcp/src/runner-carrier-observation.test.ts`. A `git commit -a` would silently OMIT all four, and
because the root `package.json` `test` script lists files EXPLICITLY, the resulting commit would then
FAIL `pnpm test` on missing files. They must be explicitly `git add`ed.
NOT RUN AND NOT CLAIMED: no UAT, no smoke test, none of `docs/smoke-test.md`'s 配合 browser/OAuth/device/
real-token steps, and `pnpm smoke:forge` was not run. The controller performs the independent end-to-end
smoke test personally once the repository reaches zero open issues.
