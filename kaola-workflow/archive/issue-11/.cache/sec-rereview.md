# Evidence-binding header (do not modify above this line)
project: issue-11
issue: 11
surface: re-review after unhandled-rejection / transaction / in-flight / encodeURIComponent repair
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11
prior_review: /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-11/.cache/sec-review.md
# End evidence-binding header

## Scope reviewed

Current uncommitted delta on `workflow/issue-11` at `1a6272c` (`git status --porcelain`):
`M apps/server/src/app.ts`, `M apps/server/src/index.ts`, `M apps/server/src/vault.ts`,
`M package.json`, `M packages/forge-adapters/src/index.ts`, `?? apps/server/src/poller.ts`.
`vault.ts` is new to the candidate set since the first review (writer type widened so a transaction
handle can be passed). Test files (`poller.test.ts`, `get-pull-request.shared.test.ts`) treated as
oracles, not as a defect surface.

Method: full source read of the current delta (not the first review's copy) plus `db.ts`,
`schema.ts` and every `insertAuditEvent` call site, then live probes run in-process from
`/tmp/kw-sec-11r/` against the worktree modules (no product file written, no listen except one
throwaway loopback stub in probe F):

- `probeA.mjs` / `probeA2.mjs` — six injected write-fault shapes (dropped table, ABORT triggers on
  `tasks` / `submissions` / `events`, dropped select target, one-of-two-rows fault); each records
  whether `pollPendingReviews` rejects, the post-fault row state, and whether the transaction rolled
  back.
- `probeB.mjs` — the real `buildApp({ pollIntervalMs })` timer under a *persistent* write fault, with
  **no** `unhandledRejection` listener installed, so Node's default `--unhandled-rejections=throw`
  would kill the probe if anything escaped. `probeB2.mjs` runs the pre-repair (`void p`) and shipped
  (`p.catch().finally()`) interval shapes side by side against a function that does reject.
- `probeC.mjs` — the new in-flight guard: slow forge vs. tick rate (overlap + duplicate-event
  count), `app.close()` while a pass is mid-flight (db closed under the poller), and a never-settling
  forge.
- `probeF.mjs` — a real loopback HTTP peer that sends headers then trickles the body forever, to
  measure how long one pass can hold the guard.
- `probeE.mjs` — twelve `pr_url` vectors through the encoding repair, recording the exact URL and
  headers fetched. `probeG.mjs` — token hygiene across five outcome shapes with
  `process.stdout/stderr.write` wrapped.

Repo gates run in-session on the worktree: `pnpm typecheck` (5 projects, Done), `pnpm lint`
(`eslint .`, no output), `pnpm test` (`tests 333 / pass 333 / fail 0`, plus web `44 passed`).

## Prior blocking finding — CLOSED

`apps/server/src/app.ts:50-59` now runs the poll inside a child plugin context as
`pollPendingReviews(db).catch(() => {}).finally(() => { polling = false })`, and
`poller.ts:88-102` wraps both the initial select and every per-task iteration (including the whole
write phase, which moved *inside* the per-task `try` via `db.transaction`) so the function has no
reachable rejection path left. Both halves measured:

- `probeA`: all six injected fault shapes report `pollPendingReviews -> resolved`, including the two
  that made the first review's probe reject (`events` table dropped, `tasks` table dropped). A6
  confirms a faulting row no longer aborts the pass — `T-A` stays `待验收` while sibling `T-B`
  completes.
- `probeB`: the real interval, ticking every 20 ms for 400 ms against a permanently faulting audit
  insert, issued 19 poll passes and the process still exited `0`. `probeB2` isolates the shape
  difference on the same Node (v24.14.0): `void p` → `exit=1` with `Error: injected rejection` from
  `Timeout._onTimeout`; the shipped shape → `exit=0`, `ticks=9`, `polling flag reset=true`.
- The `.catch()` is genuinely belt-and-suspenders rather than the only guard, so the process survives
  both ways: neither the swallow-inside-`pollPendingReviews` layer nor the interval layer is load-
  bearing alone.

## Prior non-blocking findings — status

**Transactional three writes — CLOSED.** `poller.ts:73-81` wraps the status update, the
`submissions.pr_state` update and `insertAuditEvent` in one `db.transaction`, and the callback is
synchronous (no `await` inside), so drizzle/better-sqlite3 commits it atomically and never holds a
write lock across I/O. `probeA2` injects the exact first-review scenario — the audit insert (third
statement) faults after both updates have run — and the outcome inverted: `tasks` stays `待验收`,
`submissions.pr_state` stays `open`, `events` empty, `in_transaction after: false` (no leaked open
transaction). Clearing the fault and re-polling then produces the correct
`待验收 → 已完成` with `actor_user_id: null`, so the transition is retried rather than lost. The
"advanced with no audit event" state the first review observed is no longer reachable.

**In-flight guard — CLOSED (for the duplicate-event defect it was filed against).** `probeC1` runs a
20 ms interval against a 150 ms forge: `max concurrent fetches: 1`, `fetch calls: 1`, exactly one
`状态迁移` event. `probeC2` closes the app mid-pass so the orphaned pass's write phase meets an
already-closed db handle: `app.close()` resolves, the process is still alive 400 ms later, no rows
were mutated, and no rejection escaped (probe exits `0` with no listener installed) — the failed
write is caught by the same per-task `try`. `probeB` also shows the flag resets across 19 passes and
that `clearInterval` fires on close (fetch count frozen after `app.close()`), confirming the child-
context `onClose` ordering the comment claims.

**`encodeURIComponent` on owner/repo — CLOSED.** `probeE` fetched, per vector:
`%2e%2e%2f%2e%2e` → `%252e%252e%252f%252e%252e` (gitea and github alike), `o/..%2f..%2fetc` →
`o/..%252f..%252fetc`, `o%2f..%2fx` → `o%252f..%252fx`, and the GitLab namespace stays `ns%2Fp`.
Every separator is now double-encoded, so no path segment can be smuggled; `https://x.example/../r/pulls/7`
is still normalised away by WHATWG URL and skipped with `(no request)`. Host pinning is unchanged
(`evil.example.com` in `pr_url` still yields `api.github.com` / the task's `repo_base_url` host).

**`pr_url` not bound to `task.repo_full_name` — DEFERRED, not re-admitted.** Still present and
reproduced by `probeE` V-2/V-7 (a task on `owner/repo` transitions off a `pr_url` whose host is
`evil.example.com`, with only its path used). Per this dispatch it is recorded as a deferred product
decision, not a defect: adding the binding tightens a user-visible contract that neither issue #11
nor `docs/DESIGN.md` §5/§8 specifies.

## Token hygiene — still holds

`probeG` re-ran five outcome shapes (merged, 401, `fetch` throwing, audit-insert fault, vault key
removed) with `process.stdout/stderr.write` wrapped: `token in DB? false` in all five and no captured
write contained the plaintext. The transaction path did not add a sink — `insertAuditEvent` from the
poller still writes only `{ task_id, from, to, pr_url }`, and grep over the four changed server files
for `console.`/`log.`/`app.log`/`process.std` returns no matches, so the poller still has no logging
call at all. `probeE` confirms the token appears only in the request headers to the pinned forge host.

## New candidate surface (`vault.ts`) — CLEAN

`vault.ts:67-75` replaces the `AppDb` parameter of `insertAuditEvent` with the structural
`AuditEventWriter = { insert: AppDb['insert'] }`. This is a compile-time widening with no runtime
change: the body is untouched, the value passed is either the same `AppDb` (all nine pre-existing
call sites in `tasks.ts`, `claim.ts`, `leases.ts`, `credential-profiles.ts`, `vault.ts` itself) or
the drizzle transaction handle (`poller.ts:76`, the only new caller). It grants no new capability and
weakens no check — `insert` is still drizzle-typed, so nothing arbitrary can be substituted — and it
does not touch `readMasterKey`, `encryptToken`, `decryptToken`, or `revealCredentialProfile`.
`probeA1`/`probeG1` confirm the event still lands with `actor_user_id: null` and the same `details`
shape; `pnpm typecheck` and all 333 server tests pass.

## Findings

finding: [non-blocking][availability][high confidence] `packages/forge-adapters/src/index.ts:238-243`
+ `apps/server/src/app.ts:51-59` — carry-over, *not* newly caused: `forgeGet` still passes no
`signal`, so one poll pass can be held open indefinitely by a forge that trickles response bytes, and
the new in-flight guard means every later tick is skipped for that whole time. `probeF` measures it
against a real loopback peer that sends headers then writes a space every 400 ms: after 8002 ms and
40 elapsed ticks the forge had seen exactly one request, and the healthy sibling `待验收` task was
never polled (`T-2 (healthy) polled? : false`); `probeC3` shows the same with a promise that never
settles (`fetch calls over 400ms / 20 ticks: 1`). Recorded as the unfixed half of the first review's
in-flight finding rather than a regression, because `pollPendingReviews`'s `for` loop already awaits
each row in `tasks` order, so any pass that reaches a hanging row already starved every row behind it
and every subsequent pass re-selected the same set in the same order — the starvation is a property
of the sequential loop, not of the guard. On every other axis the guard is strictly better: it
replaces an unbounded pile-up of parallel passes (1440/day at the default 60 s interval, each opening
a fresh connection to the hanging host) and the duplicated `状态迁移` events the first review
measured with a single in-flight pass. Impact is confined to the background status-sync feature — no
HTTP route, no data corruption, no token exposure — and recovery is automatic once the hang ends. Fix
is the one already recommended: `AbortSignal.timeout` on the adapter fetch.

finding: [deferred][out_of_scope][product decision] `apps/server/src/poller.ts:63` +
`packages/forge-adapters/src/index.ts` PR-URL parsers — `submission.prUrl` is still not bound to
`task.repo_full_name` / `repo_base_url`, so a lease holder can drive `待验收 → 已完成` off an
unrelated already-merged PR on the same forge (reproduced again, `probeE` V-2/V-7). Carried forward
from the first review verbatim in substance; the orchestrator deferred the binding to the user
because it changes a user-visible contract that neither issue #11 nor `docs/DESIGN.md` §5/§8
specifies. Explicitly **not** re-admitted as a defect of this candidate. Confidentiality is unchanged
(the claimer already holds the same token in plaintext at claim time) and the fetch host stays
pinned; what is deferred is the acceptance-gate tightening.

## Observations (not defects)

- Fault-swallow blindness widened slightly: `poller.ts:92-94` now also swallows a fault on the
  initial select, on top of the two pre-existing bare `catch` blocks. Given the codebase has no
  logger (confirmed by grep above), a persistently faulting poller is indistinguishable from an idle
  one from outside. `probeB` is the shape of that: 19 consecutive failing passes, zero signal
  anywhere. Consistent with the requested skip-on-error behaviour; an operability gap, not a security
  hole, since polling only ever advances status.
- `apps/server/src/index.ts:3-6` — the `POLL_INTERVAL_MS` → `NaN` → silently-disabled-polling wart
  from the first review is unchanged. Still fail-silent misconfiguration, still not a security hole.
- The interval is not `unref`'d, so `app.close()` is required for a clean process exit; `probeB` and
  `probeC2` confirm close works and stops the timer.
- `probeC2` shows an in-flight pass that outlives `app.close()` silently loses its result (write hits
  a closed handle, caught). Correct behaviour given the transaction: nothing is half-applied and the
  row is re-polled on the next boot.

verdict: approved
findings_blocking: 0
review_conclusion: The prior blocking defect is closed and independently measured — `pollPendingReviews` has no reachable rejection path left (six injected write-fault shapes all resolve, including the two that rejected before), the interval callback carries `.catch().finally()`, and the real timer survived 19 consecutive faulting passes with no `unhandledRejection` listener installed and exited `0`, where the pre-repair `void p` shape exits `1` on the same Node v24.14.0. The three claimed non-blocking repairs also verify: the single `db.transaction` now rolls back the exact scenario that previously advanced a task to `已完成` with no audit event (row stays `待验收`, no leaked open transaction, transition correctly retried once the fault clears), the in-flight guard holds concurrency at one pass with exactly one `状态迁移` event and survives `app.close()` mid-flight, and `encodeURIComponent` double-encodes every smuggled separator on both GitHub and Gitea owner/repo while host pinning stays intact. Token hygiene from the first review still holds across all five outcome shapes, and the newly added candidate file `vault.ts` is a compile-time-only widening of `insertAuditEvent`'s writer parameter that grants no capability and changes no behaviour. No new candidate-caused defect is admitted. One non-blocking carry-over remains — the still-absent fetch timeout, whose effect the guard reshapes from duplicated events into a bounded-by-nothing stall (measured: 8 s and 40 skipped ticks against a body-trickling peer), though the sequential loop already starved those rows before the repair — plus the deferred `pr_url`-to-task-repo binding, recorded as a product decision for the user and not as a defect. Repo gates run in-session on the worktree: typecheck Done, `eslint .` clean, 333/333 server tests and 44/44 web tests pass.
