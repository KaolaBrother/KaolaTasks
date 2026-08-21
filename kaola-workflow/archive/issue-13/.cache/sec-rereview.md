# Evidence-binding header (do not modify above this line)
project: issue-13
issue: 13
surface: R1 repair delta — instance bind on webhook match
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13
# End evidence-binding header

## Candidate inspected

Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13`, branch `workflow/issue-13`,
still uncommitted working-tree state (`git status --porcelain`: `M apps/server/src/app.ts`,
`M apps/server/src/index.ts`, `M apps/server/src/poller.test.ts`, `M apps/server/src/poller.ts`,
`M package.json`, `M packages/forge-adapters/src/index.ts`, plus untracked
`apps/server/src/webhook.ts`, `apps/server/src/webhook.test.ts`,
`packages/forge-adapters/src/webhook.shared.test.ts`).

Read in full for this re-review: `apps/server/src/webhook.ts`, `apps/server/src/poller.ts`,
the `git diff` of `packages/forge-adapters/src/index.ts`, `apps/server/src/app.ts`,
`apps/server/src/index.ts`, `apps/server/src/schema.ts`, the `PATCH /api/v1/tasks/:publicId` handler
and the task-insert mapping in `apps/server/src/tasks.ts`, the `repo` block of
`packages/shared/src/index.ts`, and both new test files as oracle evidence.

Because the re-review was heading to a clean result, the expensive validation was run rather than
short-circuited: see the Validation section below.

## R1 — closed

The repair implements exactly the safe pattern the previous review named, and nothing weaker.

anchors:
- `apps/server/src/webhook.ts:38-52` — `findPendingReviewMatch(db, instance, prUrl)` now takes the
  resolved instance and `continue`s past every `待验收` row that fails
  `taskMatchesForgeInstance(task, instance)` *before* it ever loads a submission or compares
  `submission.prUrl === prUrl`. The instance filter is therefore upstream of the attacker-controlled
  string comparison, not a post-hoc check on an already-chosen match.
- `apps/server/src/webhook.ts:98-104` — the call site passes the instance resolved from `:publicId`
  at `:73`, which is the same object whose `webhookSecret` the signature at `:86` was verified
  against. Authentication and authorization now read the same identity; there is no second lookup
  that could diverge.
- `apps/server/src/poller.ts:32-37` — `taskMatchesForgeInstance` is the one exported predicate,
  `instance.forge === task.repoForge && instance.baseUrl === task.repoBaseUrl`, and
  `isWebhookManaged` at `:39-44` consumes it. The webhook receiver and the poller's opt-out can no
  longer drift apart, which was a structural part of the original finding.
- A cross-instance delivery falls through to `webhook.ts:99-101` and answers `204` with no write:
  it is indistinguishable from an unmatched `pr_url`, so the response does not tell an attacker that
  a task with that `pr_url` exists on another instance.

why the binding cannot be re-pointed by an attacker: the authorization decision now rests on
`tasks.repo_forge` and `tasks.repo_base_url`, both `notNull` (`schema.ts:55-56`) and both written
once at creation from the poster's brief (`tasks.ts:620`). The only mutation route for an existing
task, `PATCH /api/v1/tasks/:publicId` (`tasks.ts:750-793`), requires a session, requires
`canPostTasks`, requires `row.task.posterUserId === user.id`, and writes `{ status: to }` and
nothing else. No HTTP or MCP surface in the tree updates `repo_forge` or `repo_base_url` after
insert, so an attacker holding instance A's secret cannot re-bind a victim's task to A and then
replay the original exploit. The residual case — a poster who declares a `base_url` that is not
where the PR actually lives — is that poster's own task and is the same declared-repo trust the
poller already extends when it builds an adapter from `task.repoBaseUrl` (`poller.ts:110`); it is
not a cross-principal escalation.

oracle strength, measured rather than assumed: the new test at `apps/server/src/webhook.test.ts:807`
signs a `pull_request` payload correctly for the *github* instance while setting
`pull_request.html_url` to the *gitea* task's stored `pr_url` and `repository.full_name` to
`unrelated/repo`, then asserts `204` (not `401`, correctly refusing to launder an authorization gap
as an authentication failure), asserts the task is still `待验收`, and asserts no `状态迁移` event
left `待验收`. To confirm the test actually detects the defect rather than passing vacuously, the
worktree was copied to `/tmp/kw-mut` (no repository or product file was modified) and the single
guard at `webhook.ts:45` was neutralized there. Result: `10 pass, 1 fail`, and the one failure is
the confused-deputy test with `'已完成' !== '待验收'` on `kt-2026-0001` — precisely the transition the
original R1 described. The scratch copy was deleted. The guard is therefore load-bearing and the
test is a real regression barrier for it.

finding: id=R1 scope=in_scope action=none status=closed severity=medium fix_role=security rationale=findPendingReviewMatch now filters every 待验收 candidate through taskMatchesForgeInstance against the signature-verified instance before comparing pr_url, the binding columns are immutable after insert, and a mutation of that guard makes the new confused-deputy test fail

## R2 — closed

`packages/forge-adapters/src/index.ts` now splits the Gitea path with `splitFullName` and encodes
each segment separately, `${origin}/api/v1/repos/${encodeURIComponent(giteaOwner)}/${encodeURIComponent(giteaName)}/hooks`,
matching what the GitHub branch does for its own two segments and what the GitLab branch does for
its single project identifier. The inconsistency the previous review recorded is gone: a `full_name`
containing `/` or other reserved characters can no longer inject additional path segments, and the
origin is still constructor `baseUrl` with `callback` confined to the request body, so no
user-controlled host is fetched. `packages/forge-adapters/src/webhook.shared.test.ts:504-543` still
passes with the plain `acme/app` fixtures, confirming the encoding did not change the legitimate
path shape.

finding: id=R2 scope=in_scope action=none status=closed severity=low fix_role=security rationale=gitea registerWebhook now encodes owner and repo separately so the three branches are consistent and no reserved character in full_name can add a path segment

## Checked in the repair delta and not admitted

1. Exact-string equality as the instance test. `repo.base_url` is an unconstrained
   `z.string()` (`packages/shared/src/index.ts:33`) stored verbatim, so `https://host` and
   `https://host/` are different instances to this predicate. Every mismatch direction fails
   closed — the delivery becomes a `204` no-op — so a normalization gap costs deliveries, never
   authorization. Not a security defect. Operationally worth knowing, and visible in the candidate's
   own fixture: a `github` entry configured with `baseUrl: 'https://api.github.com'`
   (`webhook.test.ts:775`) will never match a task whose poster typed `https://github.com`, and
   that github instance's webhooks would silently no-op.
2. `event.repo.full_name` is parsed but still not compared against `tasks.repo_full_name`, so within
   one instance the receiver trusts any holder of that instance's secret to name any `pr_url` on it.
   The data for a tighter binding exists on both sides. This is not admitted because the trust unit
   the design establishes is the instance: one `webhookSecret` per `FORGE_INSTANCES` entry covers
   every repo on that host, and I could not establish an attacker-reachable precondition in which a
   party holds that secret without already speaking for the instance. Deciding whether a repo admin
   on a managed host can read a registered hook secret is forge-specific behavior I did not verify
   here, and the admission policy forbids guessing it. Recorded as an available hardening, with no
   finding row, because the precondition is unproven.
3. Two `FORGE_INSTANCES` entries sharing `(forge, baseUrl)` with different secrets would let either
   secret move the other's tasks. Same root as item 2 — the model has no sub-host instance identity —
   and it is an operator configuration shape, not a reachable defect in the candidate.
4. Nothing in the repair delta widened the earlier clean results. `webhook.ts` still imports no vault
   function and never calls `getPullRequest`; the test at `webhook.test.ts:649-655` asserts zero
   `/pulls/` fetches and asserts the plaintext inline token appears in neither the response nor
   `events.details`. Responses remain `{ error: 'not_found' }`, `{ error: 'invalid_signature' }`,
   and empty `204`s, and `webhook.test.ts:573` asserts the 401 body never contains the configured
   secret. Signature verification, the plugin-scoped raw-body parser, and the `FORGE_INSTANCES` cast
   are unchanged from the previous review and were re-read, not re-litigated.
5. Newly exporting `latestSubmission`, `applyPrTerminalTransition`, and `taskMatchesForgeInstance`
   from `poller.ts` widens only the intra-package surface. All three consumers are in-repo, none is
   reachable over HTTP or MCP, and sharing the predicate is what makes the two paths agree. No
   defect.

## Validation

`pnpm test` in the worktree: exit code `0`, `tests 445 / pass 445 / fail 0` for the Node suite and
`Test Files 2 passed (2) / Tests 51 passed (51)` for `@kaola/web`. The mutation probe described under
R1 was run in a deleted scratch copy outside the repository and left no artifact behind. Type and
lint validation are not this role's verdict and were not run.

## Receipt

verdict: pass
findings_blocking: 0

review_conclusion: The repair closes R1 at the right place, filtering every pending-review candidate through the shared instance predicate before the attacker-controlled pull request URL is ever compared, and the columns that decision rests on are immutable after task creation, so a delivery signed by one forge instance can no longer reach another instance's task; a deliberate mutation of that single guard makes the new confused-deputy test fail with exactly the transition the original finding predicted, which shows the guard is load-bearing rather than incidentally passing, and the Gitea path-encoding inconsistency is resolved as well, leaving only unproven intra-instance hardening that the design's per-instance secret model does not currently breach.
