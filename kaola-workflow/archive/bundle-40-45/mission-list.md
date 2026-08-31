# Goal: land #40 (idempotent write-back, dedupe before retry) and #45 (English 500 text in the Chinese UI)

Branch `workflow/bundle-40-45` · Worktree `.kw/worktrees/bundle-40-45` · Closure all_or_nothing
Base `fbdab34` (main, after bundle-41-42-43-44 merged). THE LAST TWO OPEN ISSUES.

PREMISES RE-MEASURED AT fbdab34 BY THE RUN OWNER BEFORE CLAIMING — both hold:
- #40 `retryTaskWritebacks` contains ZERO counter/delay/backoff logic — it is purely event-absence driven;
  `commentOnIssue(cred, issueRef, body)` takes no idempotency argument.
- #45 there is NO `setErrorHandler` anywhere in `apps/server/src`, and `apps/web/src/App.vue` has exactly
  6 sites trusting `body.message` for any non-ok status.
- ARCHITECTURAL FACT FOUND WHILE CLAIMING: `ForgeAdapter` exposes NO comment-listing method
  (validateToken, importIssue, listIssues, getPullRequest, registerWebhook, parseWebhook, commentOnIssue).
  So "dedupe before retry" requires a NEW adapter capability across all three forges — this is the largest
  single decision in the bundle and mission 1 must settle it before any code is written.

CONTROLLER'S DECISION FOR #40 (option B), binding: introduce a recognizable idempotency marker and dedupe
before retrying, WITHOUT changing #14's "retry until success" contract. An attempt cap is explicitly
REJECTED (it would permanently lose write-backs); accepting duplicates is explicitly REJECTED.

NO HARD GATES — the project's highest-priority constraint, binding on every mission here: a dedupe lookup
that is slow, unavailable, or failing must NEVER block Claim, Workflow, PR, or core server availability.
It must degrade. UAT/smoke remain forbidden; the controller runs the end-to-end smoke personally once open
issues reach zero.

## 1. Measure the three forges' comment-listing and dedupe capability, and the race
status: done
dispatched: knowledge-lookup (standard `sonnet`), primary-source research + local code reading
item: The decision requires measuring BEFORE implementing. Establish, per forge: whether issue comments
can be listed, with what pagination/ordering/filtering, whether any native idempotency key exists, and
what the race window is between "list" and "post" (a second poller tick can post in between). Then
recommend the MINIMAL approach that behaves IDENTICALLY across github/gitlab/gitea, since AGENTS.md
requires the three adapters stay behaviorally consistent and share the `*.shared.test.ts` contract.
Must also answer: is a NEW adapter method justified, or can the existing write-back body
(which already contains `task.publicId` and `PUBLIC_URL`) serve as the marker without one?
result: MEASURED WITH PRIMARY CITATIONS, and it settles the design.
LISTING, per forge: GitHub `GET /repos/{owner}/{repo}/issues/{n}/comments` — `since`/`per_page`(<=100)/
`page`, with a DOCUMENTED ordering guarantee (ascending ID). GitLab (notes, not comments)
`GET /projects/:id/issues/:iid/notes` — `sort`/`order_by`, NO `since` filter at all, offset paginated.
Gitea `GET /repos/{owner}/{repo}/issues/{index}/comments` — verified against the swagger annotation in
go-gitea source: its ONLY params are `since`/`before`, there is NO page/limit on that endpoint, and NO
documented ordering guarantee. So Gitea's order must be treated as UNKNOWN and no pagination controls may
be assumed there. NONE of the three supports server-side filtering by body text or author — any marker
match must happen client-side.
NATIVE IDEMPOTENCY: NONE. Definitive across all three (no idempotency key, no conditional create, no
create-if-absent), verified from the creation endpoints themselves. So the write side cannot be made
idempotent; only a read-back can resolve the ambiguity.
THE RACE, sharpened: this is NOT primarily a concurrent-tick race — `app.ts`'s `polling` boolean already
serializes ticks within a process. It is a SINGLE-WRITER ACK-LOSS race: the POST is flushed, the forge
COMMITS it, and the response is never read back (`AbortSignal.timeout(WRITEBACK_TIMEOUT_MS)` fires, or the
network drops after dispatch). `attemptWriteback` sees only a failure, records no `回写`, and the next
tick reposts. (A multi-process deployment would add a genuine concurrent race needing the same mitigation;
the agent found no evidence of that topology and flagged it UNKNOWN rather than assuming either way.)
AUTHOR FILTERING: all three inline author identity for free WHEN listing, but `postComment` never calls
`validateToken` at retry time, so that identity is not in memory — reusing it would need a cache or an
extra call. Not needed anyway: `commentBodyFor` already embeds `task.publicId` plus a transition-specific
Chinese phrase, which is a sufficient marker for a client-side body match.
CONFIRMED THE RUN OWNER'S TWO FINDINGS, independently and before being asked: (a) a purely server-side
marker is INSUFFICIENT — it is necessary bookkeeping but cannot break the epistemic symmetry, since only
the forge knows what happened; a forge-side read is NECESSARY. (b) The degradation rule (skip this tick,
retry next) is right — it defers without losing, preserves "retry until success", and never posts blind
into an unknown state.
THE REFINEMENT THAT MAKES THIS CHEAP, which the run owner had NOT considered: classify failures as
DEFINITE (the forge answered non-2xx, or the failure happened before dispatch) versus AMBIGUOUS (abort/
network failure AFTER dispatch). Definite failures repost immediately as today with ZERO new reads — the
forge already confirmed nothing was created. ONLY ambiguous failures trigger a single list-and-scan. The
classification lives in one place because all three forges share `forgePost` and the same
`AbortSignal.timeout` mechanism, so it cannot drift per-forge. This confines the extra GET to the rare
stuck case rather than one per retry per task per 60s tick, directly answering the GitHub rate-limit
concern: effectively zero added requests in the common path.
ADOPTED AS THE DESIGN for missions 2-3, under the controller's standing authorization to decide product
tradeoffs directly (correctness first, minimal design, existing contracts preserved, no irreversible side
effects): add `listIssueComments` to `ForgeAdapter` with a new shared spec; classify definite vs ambiguous
failure; list-and-scan only on ambiguous; marker is the EXISTING body content (no new hidden token); on
lookup failure skip the tick and retry. No attempt cap, no accepted duplicates, no blocking gate.

## 2. #40 acceptance under independent test custody
status: done
dispatched: tdd-guide (standard `sonnet`), RE-DISPATCHED — the first dispatch produced NO files in the
worktree and delivered no report, so it is treated as never having run rather than trusted. Output lands
as a new shared spec under `packages/forge-adapters/src/` plus write-back dedupe cases under
`apps/server/src/`.
RUN OWNER ERROR, recorded honestly: the re-dispatch was WRONG. The original agent was slow, not dead — it
delivered a complete report shortly after, and both agents were briefly live on the same mission. The
second one wrote to `list-issue-comments.shared.test.ts` before it was stopped. No work was lost and
nothing conflicted, but "no files yet" is not evidence a dispatch has failed, and the original author
should have been asked first. The original test author flagged the unexpected edit rather than silently
reverting it, which is exactly right.
DISPOSITION OF THAT EDIT: KEPT, after the run owner verified the file is coherent rather than a
half-written artifact of a killed agent — `pnpm --filter @kaola/forge-adapters typecheck` clean, braces
balanced, file terminates properly, both files still registered, and the combined RED baseline UNCHANGED
at exactly `tests 25, pass 8, fail 17` with the same failure reasons. The revision is a tightening, not a
regression: it pins the exact `listIssueComments: ${kind} responded ${status}` message (matching every
sibling method's convention), asserts the request carries NO query string (consistent with the measured
fact that Gitea's endpoint has no page/limit params), and makes the body comparison order-agnostic for all
three kinds — superset-safe, since an implementation preserving GitHub's documented order still passes.
result: RED PROVEN, 25 tests / 8 pass / 17 fail, owner-verified. Two new files, both registered in the
root `package.json` `test` script: `packages/forge-adapters/src/list-issue-comments.shared.test.ts` (a
shared spec parameterized over all three kinds, mirroring `comment-on-issue.shared.test.ts`) and
`apps/server/src/writeback-dedupe.test.ts` (drives `attemptWriteback`/`retryPendingWritebacks` against a
scripted stub modelling "forge commits, client's fetch rejects"). Production untouched.
CONTRACT: add `listIssueComments(cred, issueRef): Promise<string[]>` GETting the SAME collection
`commentOnIssue` POSTs to, with the same auth headers and the same host/SSRF rule, rejecting on non-OK and
on an unparseable issue_url without ever calling fetch. In write-back, classify DEFINITE (a real status
came back) vs AMBIGUOUS (the fetch itself rejected). DEFINITE -> repost next tick as today with ZERO
listing calls. AMBIGUOUS -> list once, scan bodies for the marker `commentBodyFor` already embeds; FOUND ->
record the `回写` success without reposting; NOT FOUND -> post as today. Listing itself fails -> SKIP the
tick: no repost, no false success, no throw upward, converging once listing recovers. No attempt cap, no
backoff, no accepted duplicates; retry-forever preserved.
TWO LOAD-BEARING DESIGN CHOICES BY THE TEST AUTHOR, worth naming: (a) the marker is seeded in the MIDDLE
of the comment array with decoys BEFORE and AFTER, so an implementation scanning only index 0 or the last
element cannot pass — this converts Gitea's undocumented ordering from a hazard into a tested constraint;
(b) GET calls are counted separately from POSTs and asserted ZERO on the definite path, a forward-guard
that passes trivially today and therefore prevents a future implementation from "fixing" dedupe by listing
unconditionally and silently reintroducing the rate-limit cost.
item: Pin the dedupe contract across all three forges, including the DEGRADATION path when listing fails.

## 3. #40 implementation
status: done
dispatched: implementer (standard `sonnet`), with the unbounded-growth repair applied inline by the run
owner after the implementer went idle without acting on it (see mission 9).
result: LANDED. `packages/forge-adapters/src/index.ts` gained
`listIssueComments(cred, issueRef): Promise<string[]>` on the interface and the per-kind dispatch,
mirroring `commentOnIssue` exactly — same `resolveImportedIssue` (so an unparseable issue_url rejects
before any fetch, same host/SSRF rule), same URL (`/notes` for gitlab, `/comments` otherwise), via
`forgeGet` so it inherits #37's `AbortSignal.timeout`, same throw idiom on non-OK, no query string and no
pagination params (Gitea has none). One body extractor serves all three, since github/gitea comments and
gitlab notes all carry text in a top-level `body`.
`apps/server/src/writeback.ts` classifies failures with `/ responded \d+$/u` against the adapter's shared
throw idiom `commentOnIssue: ${kind} responded ${status}` — FORGE-AGNOSTIC BY CONSTRUCTION, since that
idiom is emitted from one shared helper and so cannot drift per forge. Definite -> repost next tick with
ZERO listing calls. Ambiguous -> one `listIssueComments`, scan the WHOLE array for the existing marker;
found -> record success without reposting; not found -> post as before. Listing itself fails -> return
immediately: no repost, no false success, nothing thrown upward, `ambiguous` left intact so a later tick
converges. `retryPendingWritebacks`/`retryTaskWritebacks` untouched — retry-forever preserved, no cap, no
backoff. The whole `attemptWriteback` body is wrapped in one outer try/catch, restoring the never-rejects
invariant its own header documents.
Verification by the run owner: acceptance 25/25 pass; regression across writeback, writeback-timeout,
poller, webhook, claim-identity AND events = 75 tests / 75 pass; `pnpm --filter @kaola/server typecheck`
clean.
ACCEPTED, with reasons: the implementer added a `GET` handler to `claim-identity.test.ts`'s fetch stub
returning `[]`. That file is not #40's acceptance, no assertion was touched, and `[]` is the honest answer
for a model where the POST failed before anything was created. It also self-caught an unhandled-rejection
bug in its own first draft.

## 4. #45 acceptance under independent test custody
status: done
dispatched: tdd-guide (standard `sonnet`), worktree `.kw/worktrees/bundle-40-45`
item: Pin that a Fastify default 500 envelope does NOT render its raw English `message` in the Chinese UI,
while the app's own typed Chinese messages still surface, across all 6 sites.
result: RED PROVEN. New file `apps/web/src/App.error-envelope.test.ts`, 11 cases: 3 fail (the defect),
8 already pass (they pin pre-existing correct behavior). Failures are all "expected ... not to contain
'SQLITE_BUSY: database is locked'" — the English text rendered verbatim.
DISCRIMINATOR CHOSEN AND VERIFIED: surface `body.message` only when `body.error` matches
`/^[a-z][a-z0-9_]*$/` (a snake_case machine code). Test custody grepped every
`reply.code(...).send(...)` in `apps/server/src` and found every typed app code matches with zero
exceptions. THE RUN OWNER INDEPENDENTLY RE-RAN THAT GREP: of every `error: '...'` literal in the server
source, the ONLY value that does not match snake_case is `'Not Found'` — which is exactly the
Fastify-synthesized `setNotFoundHandler` shape (`app.ts:108-117`) the discriminator is meant to exclude,
alongside the default `'Internal Server Error'`. The rule holds with no false exclusions.
COVERAGE: 3 of the 6 sites, spanning two panels (deleteProfile :1888, createTask :1969, importTask :2016)
so the fix must read as ONE SHARED RULE rather than a one-site patch. `:1961` was deliberately excluded
with a reason: it already gates on `body.error === 'token_check_failed'` before touching `message`, so a
Fastify-default envelope cannot reach it, and `App.form.test.ts` already covers it with real typed bodies.
A TRAP THE TEST AUTHOR CAUGHT THAT THE RUN OWNER HAD NOT CONSIDERED, and the most valuable part of this
acceptance: `deleteProfile`'s SUCCESS branch (`:1893`) uses the SAME idiom, but on a 2xx the server sends
NO `error` field at all (`credential-profiles.ts:273` sends `{ ok: true, message: FORGE_REVOKE_MESSAGE }`).
Applying the new "require a snake_case `error`" guard UNIFORMLY would therefore silently break custom
SUCCESS messages. A test now asserts a custom 200-body message still renders, so that plausible near-miss
implementation fails. The implementer was briefed on this explicitly.

## 5. #45 implementation
status: done
dispatched: implementer (standard `sonnet`), worktree `.kw/worktrees/bundle-40-45`
result: DONE and verified by the run owner. `apps/web/src/App.vue` only, +19/-4.
Added ONE shared predicate rather than repeating a condition six times — the point of #45 being that this
is a shared rule, not a one-site patch:
  `const TYPED_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]*$/`
  `function typedErrorMessage(body)` -> returns `body.message` only when `body.error` is a snake_case
  machine code, else null.
Applied at the four reachable FAILURE sites, each keeping its own Chinese fallback via `?? ...`:
`patchTaskStatus` (操作失败), `deleteProfile` (删除失败), `createTask` general branch (发布失败),
`importTask` (导入失败).
THE TRAP WAS AVOIDED, which is what this mission was really about: `deleteProfile`'s SUCCESS branch was
left completely untouched, because a 2xx from `credential-profiles.ts:273` carries
`{ ok: true, message }` with NO `error` key — gating it on "snake_case `error` present" would have
silently broken custom success messages. The suite's case
'删除成功（200）且服务端返回自定义 message（无 error 字段）' passes precisely because that line is
unchanged. `createTask`'s `:1961` branch was also left intact: it already gates on
`body.error === 'token_check_failed'`, which itself matches the pattern, so it was never exposed.
OWNER VERIFICATION, not taken on report: grepped the file — exactly four sites now call
`typedErrorMessage(body)`, and the only remaining raw `typeof body.message === 'string'` occurrences are
inside the helper itself, the untouched success path, and the untouched token_check_failed gate.
`pnpm --filter @kaola/web test` = 8 files / 131 tests / 131 pass; `pnpm --filter @kaola/web typecheck`
clean; `git diff --stat` confirms NO server or adapter file was touched, so the public error envelope is
unchanged (adding `setErrorHandler` was explicitly out of scope).

## 6. Independent review, full four-gate validation, docs docking
status: todo

## 7. Run owner's analysis feeding mission 1: a server-side-only marker CANNOT close the window
status: done
dispatched: self (inline, run owner), read-only over `writeback.ts` and `schema.ts`
item: Before the forge-API measurement returns, test the cheapest candidate design — a purely server-side
marker requiring no forge read — against the actual failure mode.
result: THE SERVER-SIDE-ONLY OPTION IS INSUFFICIENT. Measured shape: `recordSuccessfulWriteback` writes an
`events` row of type `回写` with `details = { task_id, transition, ok: true, issue_url }`, and
`hasSuccessfulWriteback` keys on `details?.ok === true`. So an extra "attempt started" row (e.g.
`ok: false`) could be written BEFORE the HTTP call without disturbing that check.
BUT it does not solve the problem. The duplicate arises precisely when the forge COMMITTED the comment and
the client aborted, so the server never learned the outcome. An attempt marker records only "we tried
once" — it cannot distinguish "committed but the response was lost" from "never arrived". On the next
tick the server faces the same ambiguity it had before, and must either skip (permanently losing a
write-back, which the controller REJECTED) or re-post (a duplicate, also REJECTED). The marker therefore
adds a row and resolves nothing.
CONSEQUENCE: only the FORGE knows whether the comment landed, so resolving the ambiguity REQUIRES a
forge-side read. That makes a comment-listing capability necessary rather than merely convenient, which
raises the cost of #40 above what its issue body assumed — the adapter has no such method today, so one
must be added consistently across github/gitlab/gitea under the shared `*.shared.test.ts` contract.
DEGRADATION, derived from the no-hard-gate constraint: when the dedupe listing fails, is rate-limited, or
is slow, the safe fallback is to SKIP THIS TICK and retry on the next one — not to post blindly. Skipping
defers the write-back without losing it, because `retryPendingWritebacks` keeps retrying forever, so the
"retry until success" contract is preserved; posting blindly would produce exactly the duplicate this
issue exists to prevent. Degrading to "slower" is acceptable; degrading to "wrong" is not. This is offered
to mission 1 as the run owner's reasoning, to be confirmed or refuted by its measurement, not as a
conclusion that overrides it.

## 8. Run owner de-risking for mission 3: the new adapter method is smaller than it looked
status: done
dispatched: self (inline, run owner), read-only over `packages/forge-adapters/src/index.ts`
item: Before implementing, check how much surface `listIssueComments` really adds, since "a new capability
across three forges" sounded like the largest cost in the bundle.
result: SMALLER THAN FEARED — the LIST URL IS THE SAME URL AS THE POST URL. `commentOnIssue` resolves
`resolveImportedIssue(kind, options, issueRef.issue_url)` then builds
`${resolved.apiUrl}/notes` for gitlab and `${resolved.apiUrl}/comments` for github/gitea, and calls
`forgePost`. So `listIssueComments` is that identical URL through `forgeGet` — a GET where the existing
method does a POST.
CONSEQUENCES, all favourable: it inherits `resolveImportedIssue`'s existing host and SSRF rules for free
(no new "which origin do we call" decision, which is exactly where the three forges diverge and where a
new method could have drifted); it inherits #37's `AbortSignal.timeout` bounding automatically, because
both `forgeGet` and `forgePost` already carry it; and cross-forge consistency comes BY CONSTRUCTION rather
than by carefully duplicating three code paths. The only genuinely per-forge concern left is response
PARSING — extracting comment bodies from three different JSON shapes — plus the measured Gitea caveat that
its endpoint has no page/limit params and no documented ordering, so no order or pagination may be
assumed there.
This is offered to the implementer as de-risking, not as a design override: test custody owns the
acceptance and may pin a different observable contract.

## 9. Run owner caught an unbounded-growth defect in #40's implementation before merge
status: done
dispatched: impl-40-dedupe (resumed with its context)
item: The #40 implementation is sound in design and its 25 acceptance tests pass, but the run owner
inspected the new persistence rather than accepting green, and found a real defect.
`recordFailedWriteback` performs an UNCONDITIONAL `insertAuditEvent` on EVERY failure. Because
`retryPendingWritebacks` runs each poller tick (`POLL_INTERVAL_MS` default 60000) and retries FOREVER by
design, a write-back that stays broken — a forge down for a week, a revoked token — writes one `回写`
`ok:false` row every 60 seconds indefinitely: ~1,440 rows per day per stuck task, into `events`, which is
the audit timeline users actually read through `GET /api/v1/events`. Before this change a failure wrote
nothing, so the table was bounded by real lifecycle activity rather than by elapsed time.
It ALSO contradicts a documented public contract. `docs/api.md:488` states verbatim: "A failed attempt
writes no event at all (retried later, not marked `ok: false`)." The standing instruction is to PRESERVE
existing contracts, so it cannot ship as written.
ALTERNATIVES CONSIDERED AND REJECTED before sending it back, so the fix is a narrowing rather than a
redesign: the ambiguity MUST survive a process restart, so it has to be persisted somewhere; always
listing before every repost would reintroduce exactly the per-tick rate-limit cost this design exists to
avoid (and the acceptance asserts `listCalls === 0` on the definite path); a new column or table is a
larger schema change than this issue warrants. `events` is the right store — the write frequency is the
defect, not the choice of store.
FIX REQUESTED: make the write STATE-CHANGE-driven rather than attempt-driven — reuse the existing
`latestWritebackOutcome` and skip the insert when the latest row already carries the same `ok:false` and
the same `ambiguous` value. Repeated identical failures then collapse to ONE row, while a genuine
ambiguous<->definite transition still records, because the next tick's behavior depends on it. Growth
becomes bounded by real state transitions instead of elapsed time.
ALSO REQUESTED: dock `docs/api.md:488` and `:393`, since the contract DOES legitimately change — a failure
can now write an event, just not one per attempt. And `apps/server/src/events.test.ts` was added to the
regression command because it is the suite most likely to encode the old "failures write no event"
assumption.
ACCEPTED AS-IS in the same review: the implementer's `claim-identity.test.ts` GET-handler addition
(mechanical stub plumbing, no assertion touched, `[]` is the honest answer for a model where the POST
failed before anything was created), and its self-caught unhandled-rejection bug fix restoring
`attemptWriteback`'s documented never-rejects invariant.
result: FIXED BY THE RUN OWNER INLINE, after the implementer went idle without applying it (verified by
reading the code rather than inferring from the idle notice). `recordFailedWriteback` now reads
`latestWritebackOutcome` first and RETURNS EARLY when the latest row already carries the same `ok:false`
and the same `ambiguous` value, with a comment explaining why. Repeated identical failures therefore
collapse to ONE row while a genuine ambiguous<->definite transition still records, so growth is bounded by
real state transitions rather than by elapsed time.
Verified after the change: acceptance still 25/25; the six regression suites INCLUDING `events.test.ts` —
the one most likely to encode the old "failures write no event" assumption — 75/75 pass; typecheck clean.
DOCS DOCKED for the contract that genuinely changed: `docs/api.md:488` no longer says "A failed attempt
writes no event at all"; it now states the exact `{ task_id, transition, ok: false, ambiguous }` shape,
what `ambiguous` means, that the row is written ONLY on an outcome change and therefore cannot grow per
tick, and why it exists. `docs/api.md:393` cross-references it, and a new "Ack-loss dedupe (#40)" section
documents the whole mechanism including the measured absence of forge idempotency, the definite/ambiguous
split, the zero-listing-calls common path, the whole-array scan given Gitea's undocumented ordering, and
the skip-don't-post degradation. `CHANGELOG.md` gained entries for #40 and #45.

## 10. Full four-gate validation on the frozen candidate
status: done
dispatched: self (inline, run owner), worktree `.kw/worktrees/bundle-40-45`
result: ALL FOUR GATES GREEN.
`pnpm typecheck` — 5 projects Done. `pnpm lint` — clean. `pnpm test` — node runner 831 tests / 831 pass /
0 fail, plus `@kaola/web` vitest 131 tests / 131 pass. TOTAL 962 passing, 0 failing. `pnpm build` — 4
targets Done.
TEST-COUNT ARITHMETIC RECONCILED rather than merely observed: node 806 -> 831 = +25, exactly #40's
acceptance (21 in the three-forge shared spec plus 4 write-back dedupe cases); web 120 -> 131 = +11,
exactly #45's `App.error-envelope.test.ts`. Every delta accounted for; nothing vanished.
FROZEN CANDIDATE: 7 modified (`CHANGELOG.md`, `apps/server/src/claim-identity.test.ts`,
`apps/server/src/writeback.ts`, `apps/web/src/App.vue`, `docs/api.md`, `package.json`,
`packages/forge-adapters/src/index.ts`) plus 3 new test files, all three registered in the root `test`
script — checked, because an unregistered suite has silently failed to run twice in this session.
NOT RUN AND NOT CLAIMED: no UAT, no smoke test, none of `docs/smoke-test.md`'s 配合 steps, no
`pnpm smoke:forge`. The controller runs the independent end-to-end smoke personally once open issues
reach zero.

## 11. Concurrent-edit reconciliation on the bounded-growth fix, and gate re-run
status: done
dispatched: self (inline, run owner)
item: The run owner and `impl-40-dedupe` applied the SAME fix concurrently. The owner's code read was
accurate at the moment it was taken — `recordFailedWriteback` was genuinely unguarded — but the implementer
was mid-edit rather than idle, so both fixes landed: a self-guard inside `recordFailedWriteback` AND an
equivalent guard at the call site, plus duplicated doc comments and two near-duplicate "Ack-loss dedupe"
paragraphs in `docs/api.md`. The implementer consolidated to a single self-guarding implementation and one
doc section, and flagged the collision rather than quietly leaving the duplication.
RUN OWNER ERROR, recorded: this is the SECOND concurrency misstep in this bundle (the first was
re-dispatching test custody that was merely slow). Reading the code was the right instinct, but a code read
only proves the state at that instant — it does not prove the agent has stopped working. The correct move
was to ask the implementer before editing its file.
result: RECONCILED AND VERIFIED COHERENT by the run owner, not taken on report.
`grep` confirms exactly ONE guard: `latestWritebackOutcome` appears twice in `writeback.ts` — once inside
`recordFailedWriteback` (the self-guard, :142) and once inside `attemptWriteback` (:195,
`if (latest?.ambiguous === true)`), which is the LEGITIMATE check-first decision, not a leftover duplicate.
`recordFailedWriteback` has exactly one call site (:222), now unconditional, which is correct because the
function self-guards. `docs/api.md` has ONE "Ack-loss dedupe" section (:395) plus two deliberate
cross-references (:393 in the write-back paragraph, :494 in the events enumeration), and the stale
"writes no event at all" claim appears ZERO times.
GATE RE-RUN ON THE ACTUAL FINAL BYTES, because mission 10's run predated these consolidations and
`writeback.ts` is executable: typecheck 5/5, lint clean, `pnpm test` 831 node + 131 web = 962 passing /
0 failing, build 4 targets. Identical to mission 10's numbers, now covering the real candidate.
CONFIRMED BY THE IMPLEMENTER AND CHECKED HERE: no acceptance test asserts a failure-event COUNT
(`writeback-dedupe.test.ts` filters on `ok === true` and separately scans raw events for token absence), so
the bounded-growth change could not have been "satisfied" by weakening a test. And `events.test.ts` — the
suite flagged as most likely to encode the old "failures write no event" assumption — passed with zero
changes, because it never asserted that.

## 12. Independent review of bundle-40-45: two MEDIUM gaps where the dedupe silently does not fire
status: done
dispatched: code-reviewer (reasoning `opus`) on the frozen candidate
result: NOTHING SEVERE, NO HARD GATE, NO LOST WRITE-BACK — but two medium findings where #40's fix
silently fails to apply. Both are being repaired (mission 13) rather than shipped.
A. NO HARD GATE — traced definitively. The listing branch is STRUCTURALLY UNREACHABLE on the webhook path:
it runs only when `latestWritebackOutcome(task,'完成')?.ambiguous === true`, which needs a prior 完成
attempt, which needs a prior 待验收->已完成 transition; 已完成 is terminal and `findPendingReviewMatch`
only considers 待验收, so a redelivery returns 204 first. The webhook's worst case is UNCHANGED from HEAD:
one POST bounded at 30s. Claim and submit_pr use fire-and-forget `scheduleWriteback`, so a listing there
never touches a response path.
B. NO FALSE SUCCESS — success is recorded only when `bodies.includes(body)` matches the exact
`commentBodyFor` text; `hasSuccessfulWriteback` still requires `ok === true`, so the new `{ok:false}` rows
cannot make a pending write-back look done; the listing-fails path records nothing and converges later.
E/F. #45 CLEAN and token/scope CLEAN — failure event details are `{task_id, transition, ok, ambiguous}`
only: no token, no ciphertext, not even `issue_url`, which matters because `GET /api/v1/events` echoes
details verbatim. `listIssueComments` becoming a required interface member breaks nothing.
R1 (MEDIUM) — A STATUS-BEARING GATEWAY ERROR IS MISCLASSIFIED AS DEFINITE. `isDefiniteFailure` asks only
whether a status arrived, never whether that status implies the request reached the origin. A self-hosted
Gitea/GitLab behind nginx or Cloudflare can COMMIT the comment while the proxy's upstream read times out
and returns 504; `commentOnIssue: gitea responded 504` matches the pattern, so `ambiguous:false` is
recorded and the next tick blind-reposts with ZERO listing calls — the exact duplicate #40 exists to
prevent. THIS IS THE HEADLINE CASE FOR THIS PRODUCT'S OWN DEPLOYMENT MODEL: AGENTS.md describes
self-hosted GitLab/Gitea, i.e. precisely the proxied topology. The existing DEFINITE test uses 403, where
the classification is correct, so nothing caught it.
R2 (MEDIUM) — THE LISTING IS A SINGLE UNPAGINATED GET. GitHub returns at most 30 comments per page in
ASCENDING order, so the just-committed marker is on the LAST page. On an imported issue with 30+ comments
— the busiest ones — `bodies.includes(body)` is false and the code reposts. The docs' "scans the whole
returned array" is accurate but "the whole array" is not "all comments", and api.md's "no page/limit
params" reads as a deliberate safety decision when it is actually the cost. Order-agnosticism is preserved
by requesting a larger page; dropping page params is what costs coverage, not what buys ordering safety.
R3 (LOW) — the growth guard compares only the immediately-preceding outcome, so a FLAPPING forge
(timeout, then 502, then timeout) still writes one row per tick. api.md discloses that an
ambiguous<->definite change records, but "cannot grow per tick" in the same paragraph overstates it. No
test covers the growth guard at all.
R4 (LOW, observation) — a permanently-failing listing suspends the write-back invisibly: every tick
retries the listing forever, nothing is posted, and no new event is written, so the audit timeline shows
one row then silence, indistinguishable from convergence. Narrow reachability, self-heals when listing
recovers.

## 13. #40 acceptance extended for R1/R2/R3 under the ORIGINAL test custody
status: done
dispatched: tests-40-dedupe (the original author, resumed with its context — R2 required relaxing a pin it
had written, so custody had to make that call, not the run owner)
result: RED PROVEN, 37 tests / 29 pass / 8 fail (5 from R1, 3 from R2), owner-verified. No production file
touched by test custody; no new files needed.
R1: a new describe adds 5 parameterized cases (502/503/504/408/429) where the stub COMMITS the comment and
then returns that status — all fail today with "a <status> response must be resolved via listIssueComments,
not blindly reposted, got 2 POSTs", i.e. a real second POST against the fake forge. Plus 3 already-passing
cases (403/404/422) pinning the CONVERSE, so the fix cannot widen the definite set beyond what was
specified. Contract: DEFINITE = 4xx except 408/429; AMBIGUOUS = 5xx, 408, 429, and every non-status throw.
R2: the "no query string" assertion is now PER-KIND — gitea keeps it, github/gitlab require
`per_page=100` — plus a coverage case placing the marker at position 31 behind 30 decoys.
A GOOD CATCH BY TEST CUSTODY: three PRE-EXISTING SSRF/host tests compared exact full URLs and would have
FALSE-FAILED the moment a legitimate query string appeared, even though they test host/SSRF and nothing
about pagination. They now compare origin+pathname, preserving their real meaning instead of being
"fixed" by loosening what they check.
R3: 3 new cases, all passing today — this closes a coverage gap on already-correct behaviour rather than
chasing a defect. An unbroken run of identical failures collapses to exactly ONE row; an
ambiguous->definite change writes exactly 2; and a third case, explicitly LABELLED "KNOWN LIMITATION",
pins that a flapping forge writes one row per tick WITHOUT asserting that is prevented — matching the
api.md sentence the run owner corrected rather than pretending the limitation does not exist.
A RESIDUAL UNKNOWN, RECORDED HONESTLY AND NOT GUESSED: whether Gitea's comment endpoint returns every
comment unbounded or applies an undocumented server-side cap could NOT be established — test custody had
no live-docs access this session and, per instruction, said UNKNOWN rather than asserting either way. No
query param is sent to Gitea and NO coverage claim is made about Gitea truncation.
RUN OWNER'S DECISION on that unknown, under the standing authorization: DOCUMENT IT, do NOT file an issue.
Reasons: it cannot be resolved without a live Gitea, which this run must not touch; the controller is
about to run an independent end-to-end smoke against real GitLab/Gitea instances, which is exactly the
instrument that settles it; and filing an issue nobody can close from here would leave the repository
permanently non-zero for a question the very next activity answers. It is instead written into
`docs/api.md` as an explicit unverified caveat and surfaced to the controller directly. If the smoke shows
Gitea truncating, that is a real issue to file THEN, with evidence.
