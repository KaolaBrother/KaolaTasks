# Code review — Issue #53 in-Kaola review loop (branch `workflow/bundle-53`)

Candidate: `git diff origin/main...HEAD` in
`/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/.kw/worktrees/bundle-53`
(43 files, +7255/-162; 5 commits `38d5035..400bd78`).

Contract read: `docs/DESIGN.md` §5, §6, §8, §9, §10, §17 (v0.6) and `docs/api.md`
(Review loop REST, `GET /api/v1/stream`, MCP rows, adapters, migrations, events).

## Verdict

**Findings** — 4 should-fix, 4 nits. No blocker. No token-leak path found. Every
verification command is green.

| command | result |
|---|---|
| `pnpm test` | 1016 pass / 0 fail (server, node:test) + 163 pass / 0 fail (web, vitest) |
| `pnpm typecheck` | clean, all 5 projects |
| `pnpm lint` | clean |

---

## Should-fix

### S1. A reopened task can never deliver a new PR (regression of the `已退回 → 待认领` edge)

- `apps/server/src/claim.ts:858` (`submit_pr`'s new prior-submission guard)
- `apps/server/src/review.ts:769` (`submit_revision`'s `pr_url` equality check)

`submitPr` now refuses whenever **any** `submissions` row exists for the task,
with no condition on `pr_state` or task status:

```ts
const priorSubmission = db.select({ id: submissions.id }).from(submissions).where(eq(submissions.taskId, row.task.id)).get()
if (priorSubmission != null) {
  return { ok: false, httpStatus: 409, body: { error: 'use_submit_revision', message: USE_SUBMIT_REVISION_MESSAGE } }
}
```

Scenario, entirely within the shipped state machine:

1. Agent delivers a Draft PR; task is `待验收`.
2. Somebody closes the PR on the forge. Poller/webhook drives `待验收 → 已退回`
   and sets `submissions.pr_state = 'closed'`.
3. The poster reopens: `PATCH { status: '待认领' }`. This edge is still legal
   (`POSTER_TRANSITIONS` in `tasks.ts`, §5, and it is pinned by
   `apps/server/src/poller.test.ts:733` and `apps/server/src/tasks.test.ts:1272`).
4. A new Agent claims the task and finishes the work on a fresh branch and a
   fresh PR.
5. `submit_pr` → `409 use_submit_revision`. `submit_revision` with the new PR URL
   → `422 pr_url_invalid`, because it requires canonical equality with the first
   submission's `pr_url`.

The only accepted call is `submit_revision` carrying the **closed** PR's URL,
which moves the task to `待验收` pointing at a dead PR; a later 「通过」 then calls
`markPullRequestReady` on a closed PR and fails.

On `origin/main` this worked: `submit_pr` had no prior-submission guard, the
per-lease unique index is per-Claim, and the cross-task duplicate check only
looks at `pr_state = 'open'` rows, so a reopened task accepted a new PR URL. The
candidate removes that without removing the reopen edge, so the reopen path is
now a dead end.

Note that `docs/DESIGN.md` §9 does say "任务已有 `submissions` 行时 `409`
`use_submit_revision`", so the code matches the frozen wording — but §5 keeps
`已退回 → 待认领`, and the two cannot both be right. The reopen test at
`poller.test.ts:733` stops at the reopen and never re-claims, so nothing catches
this.

**Minimal fix:** scope the guard to a live submission, i.e. treat a submission
whose `pr_state` is terminal (`closed` / `merged`) as no submission for the
purposes of `submit_pr`, and give the new row a fresh `review_round`. Correct
§9's wording to match. (Alternative, if the one-task-one-PR rule must hold
forever: drop `已退回 → 待认领` from §5, `LEGAL_TRANSITIONS` and
`POSTER_TRANSITIONS` — but that removes a feature the poster UI still offers.)

### S2. Sub-task `base_branch` never stacks on a webhook-managed instance

- `apps/server/src/poller.ts:142` (`backfillSubmissionHead`, the only writer of `submissions.head_branch`)
- `apps/server/src/tasks.ts:452` (`deriveBaseBranch`)

`deriveBaseBranch` returns the parent's PR head branch only when
`parentSubmissions.head_branch` is non-null. I grepped every writer of that
column:

```
apps/server/src/poller.ts:147:  if (row.headBranch == null && status.head_branch !== '') patch.headBranch = status.head_branch
```

That is the only one. `submit_pr` accepts an optional `head_sha` but has no
`head_branch` counterpart, and `submit_revision` does not write it either.

`pollPendingReviews` skips any task whose repo belongs to a
`syncMode: 'webhook'` forge instance (`isWebhookManaged`, `poller.ts:184`) — an
explicitly supported #13 deployment mode, and the one AGENTS.md names for
internal Gitea. On such an instance `pollOneTask` never runs, `head_branch` stays
null forever, and a child claimed while its parent sits in `待验收` / `待修改` /
`待合并` silently receives the **stored** base branch instead of the parent's PR
head branch.

`docs/DESIGN.md` §6: "父任务处于 `待验收` / `待修改` / `待合并` 时 = 父任务 PR 的 head
分支（堆叠）". Observed on a webhook instance: the publish-time value (typically
`main`). The Agent branches off the wrong base and the stack silently collapses.

The sub-task test hides this — `review.test.ts:885` calls `pollPendingReviews(db)`
right after the parent's `submit_pr`, with the comment "head branch known after
the first poll", and the boot fixture uses no `forgeInstances`.

**Minimal fix:** accept an optional `head_branch` on `submit_pr` (and
`submit_revision`) and persist it, keeping the poller backfill as the fallback
for Agents that omit it.

### S3. Lease expiry publishes no SSE `task_updated`, though §17.5 lists 过期 as a write point

- `apps/server/src/leases.ts:151` (`sweepExpiredLeases`)

`sweepExpiredLeases` writes the `进行中 → 待认领` / `进行中 → 待修改` row and its
`状态迁移` audit event, but never calls `publishStreamEvent`. `leases.ts` does not
import `stream.ts` at all. Confirmed by enumerating every call site:

```
claim.ts:632, 708, 789, 921 · poller.ts:117 · review.ts:396, 400, 404 · tasks.ts:899
```

`docs/DESIGN.md` §17.5: "写入点：状态迁移（claim / release / **过期** / submit /
revision / 评审动作 / poller / webhook / 发布者 PATCH）". A task that falls out of
`进行中` because its lease expired therefore does not move on any open board until
some unrelated event or a manual reload arrives — exactly the case where a live
board matters most, since nobody triggered the change.

`stream.test.ts` only covers the transport (gate, headers, ping, shutdown), never
the write points, so nothing catches the omission.

**Minimal fix:** publish `task_updated` from the expiry branch of
`sweepExpiredLeases`, after the transaction commits, with the task's public id
and the new status.

### S4. `open_review_round` short-circuits on the wrong sibling sub-task

- `apps/server/src/review.ts:868`

```ts
for (const child of children) {
  const lease = selectActiveLease(db, child.id)
  if (lease != null && lease.deviceId === auth.device.id) {
    const fenced = resolveActiveLeaseForMutation(db, auth, child.id, claimId)
    if (fenced.ok) { childLease = { taskId: child.id }; break }
    return fenced.body.error === 'conflict' ? { …stale_claim } : fenced
  }
}
```

The `return` fires on the **first** child this device holds a lease on. The
one-active-lease index is per task, not per device
(`leases_one_active_per_task`, `db.ts:325`), so one device can legitimately hold
Claims on two sibling sub-tasks of the same parent at once. If the Agent passes
child B's `claim_id` and child A is iterated first (children are unordered here —
`childrenOf` orders by id, but this loop uses the unordered `select`), the fence
against A fails and the call answers `409 stale_claim` even though B's Claim is
valid and current.

Expected per `docs/api.md` MCP row for `open_review_round`: the caller's Claim on
*a* child of that parent is accepted; only "no active Claim / wrong `claim_id`"
is `stale_claim`.

**Minimal fix:** `continue` instead of `return` inside the loop, and fall through
to the existing post-loop `403` / `409` disambiguation once no child matched.

---

## Nits

### N1. `submit_revision` on a released Claim with a *different* head answers `head_sha_unchanged`

`apps/server/src/review.ts:780`. In the terminal-Claim branch, a revision row
exists for this lease but `existing.headSha !== headSha`, and the code returns
`409 head_sha_unchanged` with the message "head_sha 与上一轮相同，没有新的修订可交回。"
The sha is in fact different; the real condition is that the Claim is spent. The
Agent is told to produce a new commit when it actually needs a new Claim.
`submit_pr`'s analogous branch correctly answers `pr_url_conflict` / `stale_claim`.
Fix: return `stale_claim` here. Not covered by a test.

### N2. `GET …/review` is session-only, but both contract docs say `403` for non `admin` / `full`

`apps/server/src/review.ts:1194` gates the read on `getSessionUser` alone, while
`docs/DESIGN.md` §17.2 lists `GET /api/v1/tasks/:publicId/review` under a table
whose preamble says "非 `admin` / `full` → `403`", and `docs/api.md:328` repeats
"Session routes. Reviewer = any `active` user with `permission_level` `admin` or
`full`; anyone else → `403`". The looser gate is deliberate and pinned
(`review.test.ts:751`, "any active user may read the review view"), so this is a
doc/code disagreement rather than an accident. Worth noting that a `待批准` user is
`401` on `/api/v1/events` and on `/api/v1/stream` (which carries only ids and
statuses) yet can read the full review thread including every `body_md` — the
same posture as the existing `GET /api/v1/tasks` board, but inconsistent with the
stream gate defined in the same issue. Fix: state the read gate explicitly in
both docs, or tighten the route.

### N3. `notifyChildrenParentEnded` writes two rows outside a transaction

`apps/server/src/review.ts:1027` calls `insertMessage(db, …)` then
`insertAuditEvent(db, …)` directly on `db`. Every sibling path wraps the pair —
`restackChildren` (`review.ts:970`), `reviewerPostMessage`, `postDiscussionMessage`
all use `db.transaction`. A fault between the two leaves a child with a system
notice and no `评审消息` audit row. Fix: wrap the body in `db.transaction`, keeping
the existing per-child `try` isolation outside it.

### N4. `docs/api.md:360` names the wrong Fastify hook

api.md says "`buildApp` closes every open stream and clears the ping timer in
`onClose`". The implementation uses `preClose` (`stream.ts:137`) and carries a
comment explaining that an `onClose` hook would never be reached, because
`server.close()` waits on the still-open SSE response. The doc line should say
`preClose`.

---

## Checked and clean

**Token leakage (AGENTS.md constraint).** The only `token` references in the new
modules are `review.ts:1110-1140`: `decryptTaskToken` feeding
`markPullRequestReady` / `commentOnPullRequest` server-side, inside a `try` whose
`catch` swallows everything. No new response body, SSE frame, `events.details`,
log line, or thrown message carries a token or ciphertext. `stream.ts` never
touches the vault. The `翻ready` `回写` event records only
`{ task_id, transition, ok, ambiguous | pr_url }`. Adapter throw idioms are
`markPullRequestReady: ${kind} responded ${status}` and
`commentOnPullRequest: …` — status only. `taskBrief` still projects explicit keys
(the widened `selectTaskRows` selects the whole `tasks` row, including
`inline_token_encrypted`, but that was already true on `main` and no route
returns the raw row). `assertNoSecrets` is applied across the new suite.

**State machine.** `LEGAL_TRANSITIONS` matches the §5 edge table exactly,
including the removal of `待验收 → 已完成`; `packages/shared/src/index.test.ts`
enumerates all 8×8 pairs. `prTerminalTarget` applies `merged` only from `待合并`
and `closed` from all three open-PR states, and both the poller and the webhook
receiver share it. A merge observed at `待验收` correctly leaves the task and
`submissions.pr_state` untouched, with a `204` on the webhook path.

**Lease/Claim fencing on the new tools.** `submit_revision` uses
`resolveMutationLease` (terminal fallback + idempotent repeat keyed on
`submission_revisions.lease_id` UNIQUE); `post_discussion_message` and
`open_review_round` use `resolveActiveLeaseForMutation` and map `conflict` to
`stale_claim`. `get_review_feedback` is read-only by design (§9) and reveals no
token. #31 and #36 paths are untouched apart from the `submit_pr` guard in S1.

**Transaction boundaries.** Every multi-row review write is inside one
`db.transaction` — `reviewerPostMessage`, `reviewerSubmitRound`, `reviewerApprove`,
`reviewerWithdraw`, `reviewerTerminate`, `submitRevision`, `postDiscussionMessage`,
`openReviewRound`, `restackChildren` — except N3. No outbound HTTP inside any
transaction: `scheduleMarkReady` is called after `reviewerApprove`'s transaction
returns and rides `trackBackgroundWork`, mirroring `scheduleWriteback`.

**Draft → ready retry.** `attemptMarkReady` never rejects and never rolls the task
back; `latestMarkReadyOutcome` reproduces #40's dedupe (a repeat outcome with the
same `ok` / `ambiguous` writes no second event) and `isDefiniteFailure` reuses the
same 4xx-except-408/429 boundary. `retryPendingMarkReady` self-terminates once the
PR is no longer draft, because all three adapter branches return early on an
already-ready PR without mutating.

**Adapter parity (#37, §8).** `getPullRequest` now returns `head_sha` / `draft` /
`head_branch` with per-kind derivation (GitLab `sha` / `source_branch` /
`draft|work_in_progress`; GitHub and Gitea `head.sha` / `head.ref`; Gitea also the
`WIP:` title prefix), degrading to `''` / `false` rather than throwing.
`markPullRequestReady` reads first (idempotent, and needed for GitHub's `node_id`),
checks GraphQL application errors inside a `200`, and strips the documented title
prefixes for GitLab / Gitea. `commentOnPullRequest` uses issue comments for
GitHub / Gitea and MR `notes` for GitLab. The `AbortSignal` deadline moved down
into a single `forgeRequest` helper, so the new PUT and PATCH verbs inherit it;
both new shared specs assert the bounded signal on the read and on the mutation
(`mark-pull-request-ready.shared.test.ts:403`,
`comment-on-pull-request.shared.test.ts:282`), and all three backends run the same
assertions.

**Migration.** Every #53 column goes through `tryAddColumn`; the three new tables
are `CREATE TABLE IF NOT EXISTS` with their unique indexes. `tasks.status` has no
`CHECK` constraint, so the two new Chinese values open on an existing database
without a rebuild. `db-migration.test.ts` gained 120 lines covering the additive
open.

**Parent gates.** Claim gate = parent ∈ {待验收, 待修改, 待合并, 已完成} → else `409
parent_not_ready`; approve gate = parent `已完成` → else `409 parent_not_completed`;
both match §17.4. Cycles are structurally impossible because `parent_task_id` is
only settable at creation and a brand-new task has no descendants. One deviation
worth knowing about: `tasks.ts:604` also requires the parent to share the child's
forge / base_url / full_name and answers `409 parent_invalid` otherwise. §17.4
does not list that condition. It is a sensible restriction (a cross-repo stack is
meaningless) but it is undocumented; either add it to §17.4 or drop it.

**Restack.** Runs only from the `merged` branch of `applyPrTerminalTransition`,
i.e. only on `待合并 → 已完成`, per child, each in its own transaction with `try`
isolation so one child's fault cannot abort the rest. A `待验收` child moves to
`待修改`; every other state gets the message (and a `restack` round when a
submission exists) without a transition, as §17.4 requires. `notifyChildrenParentEnded`
fires on `closed` (→ `已退回`), on reviewer terminate, and on poster `已取消`.

**Web.** SSE reconnect is bounded — one 3s timer at a time, guarded by
`streamRetryTimer !== 0`, cleared in `closeStream` and on unmount; `EventSource`
absence (happy-dom) degrades silently. `loadReview` is guarded by a monotonic
`reviewRequest` counter against out-of-order responses. Failure copy stays Chinese
via `reviewFailureMessage` (#45 discipline preserved), with local fallbacks for the
two codes the server may send without a `message`. Anchors render as links only
when `urlLooksHttp`, with `rel="noreferrer noopener"`. Board columns cover all
eight statuses and only the three #53 columns carry a subtitle. No runtime bug
found.

**Test quality.** `review.test.ts` (967 lines, 10 cases) pins the full loop
end-to-end, both non-blocking and blocking rounds, release and expiry parking in
`待修改`, withdraw / terminate from all three states, the REST gate matrix, the
`percent` boundary, Claim requirements on the Agent tools, the mark-ready failure
and retry, and the whole sub-task story. It asserts exact `events.details` shapes
and exact Review Brief key sets, and calls `assertNoSecrets` throughout. The
fixture re-premise in `poller.test.ts`, `webhook.test.ts`, `writeback.test.ts` and
`claim-fencing.test.ts` is honest: each adds a `forceStatus(db, id, '待合并')`,
which is exactly what a Kaola 「通过」 writes, and leaves the assertion under test
(URL canonicalization, write-back dedupe, instance routing) unchanged. Two new
negative cases were added for the removed `待验收 → 已完成` edge, one on the poller
and one on the webhook. Nothing was weakened. The stale `describe('scope: only
待验收 tasks are ever fetched')` title in `poller.test.ts:615` now covers three
statuses; cosmetic only.

**Gaps in coverage** (beyond the findings above): the reopen-then-redeliver path
(S1), the webhook-mode `head_branch` path (S2), SSE write points including expiry
(S3), the two-sibling-Claim `open_review_round` case (S4), and the terminal-Claim
`submit_revision` mismatch (N1) are all unexercised.
