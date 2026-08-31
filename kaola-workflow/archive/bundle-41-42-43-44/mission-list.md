# Goal: land #41, #42, #43, #44 — the four machine-decidable follow-ups this session's own run discovered

Branch `workflow/bundle-41-42-43-44` · Worktree `.kw/worktrees/bundle-41-42-43-44` · Closure all_or_nothing
Base `5e5acb3` (main, immediately after bundle-37-38-39 merged).
#40 is DELIBERATELY EXCLUDED: its resolution is a public-contract tradeoff reserved for the user.
UAT remains forbidden; the controller runs the end-to-end smoke personally once open issues reach zero.

PREMISES RE-MEASURED AT 5e5acb3 BY THE RUN OWNER BEFORE CLAIMING — all four hold:
- #41 `apps/web/src/App.vue` reads the response `body` then discards it, setting
  `profileMessage.value = ` + backtick + `删除失败（${res.status}）` + backtick.
- #42 `apps/server/src/tasks.ts` `POSTER_TRANSITIONS` allows `已取消` only from `待认领` and `已退回`.
- #43 `apps/server/src/writeback.test.ts:188` pushes `{ url, method, headers, body }` into
  `commentRequests`, and NINE failure messages `JSON.stringify(stub.commentRequests)`.
- #44 `apps/server/src/db.ts` has ZERO logging calls, so an orphan `*__rebuild` is silently dropped when
  the guard is reachable and silently retained when it short-circuits.

## 1. Correct issue #42's own overstatement, BY EDITING ITS BODY (never a comment)
status: done
item: The run owner re-read `docs/smoke-test.md:151` at 5e5acb3 and found it says "先把那条任务取消**或走
完到** `已完成`/`已取消`" — it offers a SECOND, actionable path. Issue #42 (which this session wrote) says
the advice "is not actionable", which OVERSTATES it: only the 取消 half is unavailable from `进行中`.
CORRECTED PROCEDURE per the user's standing instruction: edit #42's BODY in place with
`gh issue edit 42 --body-file`. Do NOT add a comment. This supersedes this mission's original wording,
which said to post a comment — that conflicted with the instruction and was fixed before any action was
taken, so no comment was ever posted on #42.
STANDING RULE FOR THIS AND EVERY LATER BUNDLE: when an issue's content needs correcting, edit the issue
BODY directly; never add a comment. Applies to every issue, not only #39.
NOTE FOR THE USER, surfaced not buried: a correction comment WAS posted on #37 earlier in this session
(issuecomment-5480778739) recording that #37's remedy had an unanticipated side effect. That predates the
generalization of this instruction, when "no comments" was scoped to #39. #37 is closed and merged; its
body has not been edited. Folding that comment into #37's body and removing the comment is available on
request — not done unilaterally, because rewriting a closed issue's record is the user's call.
result: DONE by `gh issue edit 42 --body-file`; NO comment added. The body now says the real defect is
AMBIGUOUS WORDING, not an unactionable instruction: `docs/smoke-test.md:151` offers TWO paths
("取消**或走完到** `已完成`/`已取消`"), and the second is genuinely available from `进行中` — only the
取消 half is not, while the sentence presents both as freely choosable. It also records that opening
`进行中 → 已取消` is a PRODUCT decision (live Claims, pushed branches, open PRs) explicitly out of scope.
VERIFIED after editing: `bodyLen=898`, and the single comment on #42 is the CLAIM SCRIPT's mechanical
marker `<!-- kw:claim project=bundle-41-42-43-44 -->` posted at 15:52:25Z by
`kaola-workflow-claim.js startup`, not commentary from the run owner. Recorded because the user's standing
rule forbids comments: this one is emitted automatically by the claim tooling on every claimed issue and
cannot be suppressed without changing that script.

## 2. #43: the write-back test stub must not print an Authorization header on failure
status: done
dispatched: tdd-guide (standard `sonnet`), test custody owns the artifact
item: Highest-value of the four — a failing assertion currently leaks a forge token into CI logs and
terminal scrollback, which AGENTS.md's token constraint exists to prevent. Redact the recorded headers (or
stop stringifying them) WITHOUT weakening any of the nine assertions that use those messages, and confirm
no assertion actually depends on header contents.
result: DONE — AND TEST CUSTODY FALSIFIED THE RUN OWNER'S OWN DIAGNOSIS, which the run owner had written
into issue #43's body. Verified independently by the run owner with `node -e`:
- `JSON.stringify({url:'u', headers: new Headers({authorization:'Bearer glpat-…'})})` yields
  `{"url":"u","headers":{}}`. `commentRequests[].headers` is a real `Headers` instance and `Headers` has
  no own enumerable properties, so the NINE `JSON.stringify(stub.commentRequests)` messages DO NOT leak
  today. The original diagnosis was wrong. This safety is INCIDENTAL — nothing in the file guarantees it,
  and recording plain header objects instead would reinstate the leak.
- The REAL, currently-exploitable leak is elsewhere: three assertions compared auth header values EXACTLY
  (gitea `token X`, github `Bearer X`, gitlab `PRIVATE-TOKEN`). `assert.equal('glpat-DEADBEEF…','wrong',
  'custom message')` attaches BOTH values to `AssertionError.actual`/`.expected`, and node's built-in
  reporter prints them regardless of any custom message — owner-verified: `util.inspect(err)` contains the
  token = true. By contrast `assert.ok(a === b, msg)` yields `actual: false` and inspect contains the
  token = false.
Fix, and it is STRONGER than the fallback the brief suggested: a helper
`assertCredentialHeaderEquals(actual, expected, message)` = `assert.ok(actual === expected, message)` at
the three sites. EXACT-value equality is preserved — the brief had offered "assert presence + prefix",
which would have weakened the check; test custody declined that and kept full equality. Plus
defence-in-depth: `redactedRequests()`/`redactedHeaders()` project `{url, method, headers-with-auth-values
-replaced, body}` and replaced all 9 messages, so the leak cannot return if the `Headers` accident ever
goes away; a second test pins that projection under BOTH the current Headers shape and a plausible
plain-object regression. url, method and body stay visible, so all 9 messages still identify the failing
request.
Owner verification: writeback + db-orphan-warning + db-migration = 28 tests / 28 pass / 0 fail. No
production file touched.
ISSUE BODY CORRECTED (body edit, no comment): #43's body now records the measured mechanism — that the
nine messages do not leak, why that is incidental, and that the real leak was the three exact comparisons
via `AssertionError.actual`. Closing against the original wrong text would have been dishonest.

## 3. #41: surface the server's 409 explanation in the credential-profile delete UI
status: done
dispatched: tdd-guide (standard `sonnet`) for acceptance in worktree `.kw/worktrees/bundle-41-42-43-44`;
output lands in `apps/web/`'s vitest suite.
result: DONE and verified by the run owner. Test custody authored `apps/web/src/App.credential-profile-delete.test.ts`
(3 cases) and proved RED: the rendered DOM showed the bare `删除失败（409）` and nowhere contained the
server's message — 1 failed / 119 passed. Its contract: a failing delete whose JSON body carries a string
`message` must render THAT text (asserted via `wrapper.text()`, so wiring stays free); a body with no
usable message must still show something meaningful and never render the literal `undefined`; a successful
delete is unchanged.
Implementation: a ONE-LINE change in `apps/web/src/App.vue`'s `deleteProfile` failure branch —
`typeof body?.message === 'string' ? body.message : ` + backtick + `删除失败（${res.status}）` + backtick.
The response body was already being read into `body` and thrown away, so nothing new is fetched.
NOTABLY it reuses the idiom ALREADY used at five other sites in the same file (App.vue:1828, :1892,
:1960, :1968, :2015) rather than inventing a pattern — `readJson` returns null for an absent/invalid body,
and the `typeof` check also rejects a non-string `message`, so no path can render `undefined` or
`[object Object]`.
Owner verification: `pnpm --filter @kaola/web test` = 7 files / 120 tests / 120 pass; the diff is exactly
those two lines; no server file touched; the `删除` button label (which the acceptance selects by, since it
has no data-testid) is unchanged.
item: The server already returns a Chinese explanation for `credential_profile_in_use`; the UI reads the
body and throws it away. Show it. Chinese UI per AGENTS.md.

## 4. #44: an orphaned database must not boot empty in silence
status: done
dispatched: tdd-guide (standard `sonnet`) for acceptance in worktree `.kw/worktrees/bundle-41-42-43-44`;
output lands in a NEW file `apps/server/src/db-orphan-warning.test.ts` (5 cases), leaving
`db-migration.test.ts`'s existing 6 untouched.
acceptance (RED: 3 pass / 2 fail, "expected exactly one console.error call ... got 0"): `createDb` must
call global `console.error` EXACTLY ONCE, synchronously, when a live table is empty while its sibling
`<name>__rebuild` still holds >0 rows; the call's arguments must contain the orphan's exact name AND its
row count; covered symmetrically for leases and claim_confirmations. NEGATIVES pin silence for a fresh DB,
an already-migrated DB across two boots, and a successful legacy migration.
NO-HARD-GATE CONSTRAINT VERIFIED IN THE ACCEPTANCE ITSELF, not merely promised: every positive case uses
`assert.doesNotThrow(() => { db = createDb(sqlitePath) })`, so a fix that blocks boot FAILS the test just
as much as silence does; and both positive cases assert, after `createDb` returns, that the live table is
still empty, the orphan still exists, and its row count is unchanged — so auto-migration and deletion are
pinned as FAILURES, not merely left unrequired. The test author was messaged mid-flight with the
constraint and confirmed the suite already conformed, changing nothing.
result: DONE and verified by the run owner. `apps/server/src/db.ts` gained a single shared helper
`reportStrandedRebuildOrphan(sqlite, liveTable, orphanTable)` plus small `tableExists`/`rowCount` helpers,
called once after EACH guarded rebuild — for `leases`/`leases__rebuild` and
`claim_confirmations`/`claim_confirmations__rebuild`. It returns early unless the orphan exists AND holds
>0 rows AND the live table is empty, then emits ONE `console.error` naming the orphan table and its row
count and stating the data was left untouched pending manual review.
NO-HARD-GATE COMPLIANCE, verified by the run owner rather than accepted: the diff is +36 lines with ZERO
deletions (purely additive); the reporter function contains ZERO `throw`/`DROP`/`INSERT`/`UPDATE`/`DELETE`
statements; `createDb` still returns a usable database. The acceptance's own
`assert.doesNotThrow` + unchanged-orphan + still-empty-live-table assertions mean a blocking, migrating,
or deleting fix would FAIL.
FALSE-POSITIVE CHECK, the specific risk of adding the first logging call to the bootstrap EVERY server
suite uses: the run owner ran claim + tasks + lifecycle-matrix + poller + webhook and grepped the output
for `[kaola-server]` — ZERO stray warnings. The negative cases (fresh DB, already-migrated across two
boots, successful legacy migration) pin that silence.
Message carries only table names and row counts — no credential material.
item: When `*__rebuild` exists and the corresponding real table is empty, say so to the operator instead of
starting up as though nothing is wrong. Do NOT auto-migrate the orphan's data — it may be an incomplete
intermediate copy, and that judgment belongs to a human.

## 5. #42: make the documented remedy accurate
status: done
dispatched: self (inline, run owner)
item: Correct `docs/smoke-test.md:151` so it does not imply 取消 is available from `进行中`. Whether to
allow `进行中 → 已取消` is a product decision involving live Claims and pushed branches, and is NOT taken
here.
result: DONE — `docs/smoke-test.md:151` rewritten to state the actions available PER STATE instead of
presenting 取消 and 走完 as freely interchangeable. It now says: `待认领`/`已退回` can be cancelled directly
by the poster; `进行中`/`待验收` cannot (`已取消` is reachable only from `待认领`/`已退回`, citing
`tasks.ts`'s `POSTER_TRANSITIONS`); `进行中` can wait for lease expiry
(`LEASE_TTL_SECONDS = 86400`, 24h) to fall back to `待认领` and then be cancelled, or be released by the
claimant via `release_task`; `待验收` has NO expiry to wait for and can only reach `已完成` (PR merged) or
`已退回` (PR closed, after which it is cancellable).
SELF-CAUGHT ERROR, recorded because it is exactly the failure mode this run kept finding in others: the
run owner's FIRST version of this edit offered the lease-expiry path for BOTH `进行中` and `待验收`. That
is false. Verified in code rather than assumed: `leases.ts:149-154` transitions only `进行中 -> 待认领` on
expiry, and `claim.ts:824` calls `markLeaseReleased(tx, lease.id)` inside `submitPr`'s own transaction, so
a `待验收` task's lease is ALREADY released and there is nothing left to expire; `sweepExpiredLeases`
(leases.ts:146) only touches active leases. The sentence was corrected before anything was committed.
Also verified: `LEASE_TTL_SECONDS = 86400` (leases.ts:9) really is 24h, and `已退回 -> 已取消` really is
permitted (tasks.ts:41). No test reads `docs/smoke-test.md`, so this change is doc-only.
SCOPE HELD: whether to permit `进行中 -> 已取消` is a product decision touching live Claims, pushed
branches and open PRs. NOT taken here — the state machine is untouched.

## 6. Independent review, full four-gate validation, and docs docking
status: done
dispatched: code-reviewer (reasoning `opus`) on the frozen candidate; gate and docking by the run owner
item: Review the frozen candidate, run `pnpm typecheck`/`lint`/`test`/`build`, and dock any doc surface the
changes touch.
result: REVIEW COMPLETE — one LOW finding, nothing severe; the three architectural questions were settled
BY CONSTRUCTION rather than argued.
(1) CAN `reportStrandedRebuildOrphan` THROW? NO, definitively. Every input that could make it throw
ALREADY throws at `db.ts:407` (`sqlite.exec(USERS_DDL)`, the first statement in `createDb`), because
SQLite validates the schema and takes its locks when preparing any statement. Built and observed: a
locked file -> SQLITE_BUSY at :407; a garbage file -> SQLITE_NOTADB at :407; and even SELECTIVE corruption
of only `leases__rebuild`'s rootpage -> SQLITE_CORRUPT at :407. A VIEW named `leases__rebuild` neither
throws nor warns (`tableExists` filters `type = 'table'`), and an alien orphan schema is fine because
`COUNT(*)` is schema-agnostic. The `SELECT COUNT(*) FROM ${table}` interpolation is unreachable with
anything but the two hardcoded literals — never data, env, config, or `sqlite_master` derived. So #44
cannot turn a booting server into a non-booting one: it is NOT a gate.
(2) CAN THE `console.error` CORRUPT A PROTOCOL STREAM? NO. It writes to fd 2 (verified: stdout receives 0
bytes). `createDb` is imported only by `app.ts` and a test helper; grep across `apps/mcp/src` and
`packages/*/src` finds NO reference, so the MCP bridge cannot execute it in any process. The bridge
reserves stdout for JSON-RPC and already uses stderr for advisories. `scripts/dev.mjs` uses
`stdio: 'inherit'`; nothing parses the server's streams.
(3) FALSE POSITIVES? NO. Six boots against a healthy database with a real user row and empty `leases`
produced ZERO warnings — the guard is a CONJUNCTION (orphan exists AND holds rows AND live table empty),
so "nothing claimed yet" alone cannot fire it. And no healthy install can have a stray `__rebuild`: only
the two rebuild functions create one, both now end in `RENAME` inside a transaction. A crash BEFORE
`DROP TABLE leases` leaves the live table non-empty and short-circuits; only the genuine stranded shape
reports.
#43: exact equality preserved — the file imports `node:assert/strict`, so the replaced call was already
`strictEqual`, and `assert.ok(a === b)` differs only on NaN/±0, impossible for `string | null` operands. No
site can pass vacuously: all three expected values are non-empty literals, so a missing header (`null`)
still fails. #41: `profileMessage` is text-bound at `App.vue:621` via `{{ }}` inside `<n-text>`, no
`v-html` — a server-controlled message cannot render as HTML or script. #42: EVERY doc claim verified
true, in both layers (`packages/shared` LEGAL_TRANSITIONS and `tasks.ts` POSTER_TRANSITIONS are the only
places `已取消` appears as a target, so no admin bypass exists).

## 10. Review finding R1 decided under the standing authorization: follow-up, not a merge blocker
status: done
dispatched: self (inline, run owner)
item: The review found `App.vue`'s new line trusts `body.message` for ANY non-ok status, so Fastify's
default 500 envelope (`{"statusCode":500,"error":"Internal Server Error","message":"SQLITE_BUSY: ..."}`,
observed by the reviewer against this repo's own Fastify) would render raw ENGLISH internal error text in
the Chinese-only admin UI — against AGENTS.md's 用户界面使用中文.
result: DECIDED — do NOT hold the merge; filed as #45 (P3) covering ALL SIX sites.
DECISIVE MEASUREMENT the run owner made before deciding: `App.vue` contains SIX instances of this exact
idiom — :1828, :1888 (the new one), :1893, :1961, :1969, :2016. FIVE are pre-existing. So the finding is
NOT candidate-introduced behavior; #41 merely adds a sixth instance of an established convention.
REASONING, per the standing authorization (correctness first, minimal design, preserve existing contracts,
no irreversible side effects): fixing only :1888 would leave it inconsistent with five siblings and make
the file harder to reason about; fixing all six is scope creep beyond #41 onto five paths this bundle does
not test. Impact is display copy only — not exposure, since that body already reached the admin's browser
before this change and those paths carry no token material. Filing one issue covering all six is the
better engineering outcome and loses nothing.
PROCESS NOTE from the reviewer, recorded honestly: `package.json` was absent from `git status` on its
first call and present on its second, so the candidate was NOT frozen at dispatch — the run owner
registered `db-orphan-warning.test.ts` mid-review. The edit was correct and necessary, but the archive
record must reflect the real write set, which is FIVE modified files plus two new ones, not four plus two.

## STANDING INSTRUCTIONS — updated by the user mid-run (2026-09-01)
status: standing instruction, not a mission

### A. Product tradeoffs are now decided, not escalated
The controller authorizes deciding product tradeoffs directly, following the recommendation, provided the
recommendation obeys: correctness first; minimal product design; PRESERVE existing contracts; avoid
irreversible side effects. Stop asking item by item.

### B. NO HARD GATES — highest-priority architectural constraint
This project must NEVER copy blocking gates from other projects. Do NOT add any blocking gate that lets an
auxiliary check, an observation, a diagnostic, a hint, a write-back, or a slow/temporarily-failing external
service block Claim, Workflow, PR, or core server availability.
PREFER: idempotency, SOFT warnings, graceful degradation, background retry, recoverable state.
A local operation may fail honestly ONLY when that operation itself cannot guarantee data correctness or
safety — and even then it must never be widened into global blocking.
APPLIED TO #44 (binding on this bundle): emit a clear operational warning/diagnostic ONLY. The server MUST
still start. No startup hard gate on the orphan `*__rebuild` state, no auto-migration of its data, and no
deletion of it. The test-custody agent was messaged mid-flight to lock this before it chose a surface.

### C. #40's decision — option (B), taken by the controller
Introduce a RECOGNIZABLE IDEMPOTENCY MARKER and dedupe before retrying, so duplicate comments are avoided
WITHOUT changing #14's "retry until success" contract.
Explicitly rejected: an attempt cap (would permanently lose write-backs) and accepting duplicates.
Required first step: MEASURE all three forges' comment-listing / dedupe capability and their race
behavior, then adopt the MINIMAL approach that behaves consistently across GitHub, GitLab and Gitea.
#40 enters a LATER bundle, not this one. Its body is to be edited in place to record this decision; no
comment is to be added.

### D. Issue corrections are body edits, never comments
Applies to every issue. Note the claim script itself posts a mechanical `<!-- kw:claim … -->` marker on
each claimed issue; that is tooling, not commentary, and cannot be suppressed without changing the script.

### E. Continuation
Finish #41-#44, archive, then FRESH-query the forge and continue — including #40 — until the repository
has zero open issues. UAT stays forbidden throughout; the controller runs the end-to-end smoke personally
once open issues reach zero.

## 7. Harness plumbing caught by the run owner: the new server suite was not registered
status: done
dispatched: self (inline, run owner)
item: `apps/server/src/db-orphan-warning.test.ts` was created but NOT added to the root `package.json`
`test` script. That script lists files EXPLICITLY, so the suite would have SILENTLY NEVER RUN in
`pnpm test` — #44's entire acceptance would have been decorative while the gate reported green. This is
the same class of gap caught in the previous bundle for `timeout.shared.test.ts`; it recurred because
`package.json` was absent from the candidate's changed-file list, which is what made it visible.
result: REGISTERED, immediately after `db-migration.test.ts`. `package.json` re-parsed as valid JSON.
VERIFIED THE SUITE ACTUALLY RUNS IN THE REAL GATE, not merely that the line exists: grepped `pnpm test`'s
own output for the suite's describe name "only-copy __rebuild orphan" — 2 hits.
The web-side file needs no registration: `apps/web` uses vitest, which globs `*.test.ts` automatically,
confirmed by its file count moving 6 -> 7.

## 8. Full four-gate validation on the frozen candidate
status: done
dispatched: self (inline, run owner), worktree `.kw/worktrees/bundle-41-42-43-44`
result: ALL FOUR GATES GREEN.
`pnpm typecheck` — 5 projects Done. `pnpm lint` — clean. `pnpm test` — node runner 806 tests / 806 pass /
0 fail, plus `@kaola/web` vitest 7 files / 120 tests / 120 pass. TOTAL 926 passing, 0 failing.
`pnpm build` — 4 targets Done, 0 errors.
TEST-COUNT ARITHMETIC RECONCILED rather than merely observed: node 799 -> 806 = +5 (`db-orphan-warning`)
+2 (`writeback.test.ts`: the new credential-diagnostic RED case plus the redaction-safety case); web
117 -> 120 = +3 (`App.credential-profile-delete.test.ts`). Every delta is accounted for; nothing vanished.
NOT RUN AND NOT CLAIMED: no UAT, no smoke test, none of `docs/smoke-test.md`'s 配合 steps, no
`pnpm smoke:forge`. The controller runs the end-to-end smoke personally once open issues reach zero.
