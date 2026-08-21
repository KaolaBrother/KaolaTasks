# Evidence-binding header (do not modify above this line)
project: issue-13
issue: 13
surface: parseWebhook + registerWebhook + POST /api/v1/webhooks/:publicId + poller skip + FORGE_INSTANCES
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13
# End evidence-binding header

## Candidate inspected

Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13`, branch `workflow/issue-13`.
The change is uncommitted working-tree state (`git diff main...HEAD` is empty; `git status --porcelain`
shows `M apps/server/src/app.ts`, `M apps/server/src/index.ts`, `M apps/server/src/poller.ts`,
`M packages/forge-adapters/src/index.ts`, `M package.json`, plus untracked `apps/server/src/webhook.ts`,
`apps/server/src/webhook.test.ts`, `packages/forge-adapters/src/webhook.shared.test.ts`).
Production files read in full: `apps/server/src/webhook.ts`, the `poller.ts` and
`packages/forge-adapters/src/index.ts` deltas, `apps/server/src/app.ts`, `apps/server/src/index.ts`.
Context read: `apps/server/src/schema.ts` (tasks columns), `docs/DESIGN.md` webhook sections,
`kaola-workflow/issue-13/.cache/orchestrator-rulings.md`, and the new test files as intent evidence only.

Per the role's expensive-validation rule, `pnpm test` was not run: an admitted defect short-circuits
ahead of the expensive validation run.

## Admitted findings

### R1 — webhook signature authenticates an instance but authorizes every task on every instance

failure_class: broken access control (missing object-level authorization / confused deputy)

primary anchor: `apps/server/src/webhook.ts:93` — `const match = findPendingReviewMatch(db, event.pr_url)`
secondary anchors:
- `apps/server/src/webhook.ts:35-47` — `findPendingReviewMatch` selects every `待验收` row in the
  database and matches on `submission.prUrl === prUrl` alone, with no instance predicate.
- `apps/server/src/webhook.ts:98` — `applyPrTerminalTransition(db, match.task, ...)` commits the
  transition to whatever task that global scan returned.
- `apps/server/src/poller.ts:29-40` — `isWebhookManaged` in the same change binds an instance to a
  task with exactly `instance.forge === task.repoForge && instance.baseUrl === task.repoBaseUrl`,
  proving the scoping data exists and is already the accepted ownership test on the sibling path.
- `apps/server/src/schema.ts:55-56` — `repoForge` and `repoBaseUrl` are `notNull` columns on `tasks`.
- `packages/forge-adapters/src/index.ts:292-322` — `parseWebhook` returns `repo.full_name`, and
  `webhook.ts` never reads it, so even the payload's own repo identity is discarded.

precondition: the deployment configures two or more `FORGE_INSTANCES` entries (the premise of the
feature; `docs/DESIGN.md:192` names an intranet Gitea alongside a hosted forge as the reason the
mode switch exists). The attacker holds, or is, one configured instance — either the operator-supplied
`webhookSecret` of the lower-trust instance A, or instance A's forge server itself, which signs every
delivery it sends and controls the full payload body. The attacker also needs the target PR URL, which
any session member can read from `GET /api/v1/tasks` task detail.

trigger and input: a single unauthenticated-by-session HTTP request.
`POST /api/v1/webhooks/{publicId-of-A}` with `Content-Type: application/json`,
`X-Gitea-Event: pull_request`, a body whose `pull_request.html_url` is the PR URL of a `待验收` task
belonging to unrelated instance B, `pull_request.merged` true, `action` `closed`, and any
`repository.full_name`; `X-Gitea-Signature` is the correct HMAC-SHA256 hex of that body under
instance A's secret.

expected behavior: a delivery signed by instance A may only advance tasks whose
`(repoForge, repoBaseUrl)` belong to instance A — the same binding `isWebhookManaged` already applies
when deciding which tasks that instance owns for polling.

observed behavior: `parseWebhook` verifies the signature against instance A's secret and succeeds;
control reaches `findPendingReviewMatch`, which scans `待验收` tasks globally and matches instance B's
task purely on the attacker-supplied `pr_url` string; `applyPrTerminalTransition` then drives that task
`待验收 -> 已完成` (or `-> 已退回` for a non-merged close), flips the submission's `prState`, and writes a
`状态迁移` audit event with `actorUserId: null`. The instance resolved from `:publicId` is used only to
pick the adapter and secret at `webhook.ts:66-76`; it is never compared against the task.

why existing controls do not prevent it: the route is deliberately outside session and Bearer auth
(the orchestrator ruling and `docs/DESIGN.md` both make the signature the sole authentication), so no
upstream authorization runs. Signature verification is sound in itself but only proves the sender
knows *some* configured instance's secret; it carries no statement about which task the sender may
act on. `event.repo.full_name` is parsed and then dropped, so no downstream code re-derives the repo.
`transitionTaskStatus` only validates that the state edge is legal, not that the actor may take it.
No test covers the cross-instance case: `apps/server/src/webhook.test.ts` exercises unknown
`publicId` (404), bad signature (401), poll-mode acceptance, and per-forge scheme dispatch, and never
asserts that a delivery for one instance cannot move another instance's task.

exploitability: one crafted HTTP request, no race, no session, fully repeatable. Gated only on
possession of one configured instance's secret.

blast radius: integrity of the task board across every configured forge instance. An attacker can
force-complete or force-return any `待验收` task in the deployment, and the resulting audit record
attributes the change to no user. The security of every task collapses to the weakest configured
instance's secret. No forge token, ciphertext, or credential is disclosed by this path, which is what
keeps the severity at medium rather than high.

safe pattern (described, not implemented): before acting on the match, require the matched task's
`repoForge`/`repoBaseUrl` to equal the resolved instance's `forge`/`baseUrl` — the predicate
`isWebhookManaged` already encodes — and answer 204 without a transition when it does not.

finding: id=R1 scope=in_scope action=fix status=open severity=medium fix_role=security rationale=webhook receiver matches 待验收 tasks globally by attacker-supplied pr_url without binding the task to the signature-verified forge instance, so one instance's secret completes any instance's task

## Non-blocking observations

### R2 — Gitea registerWebhook interpolates repo.full_name into the URL path unencoded

`packages/forge-adapters/src/index.ts:375` builds
`${origin}/api/v1/repos/${repo.full_name}/hooks` with no `encodeURIComponent`, while the GitHub branch
(`:354`) and the GitLab branch (`:367`) both encode. The origin is still constructor `baseUrl`, so the
host rule in focus item 4 holds: no user-controlled origin is fetched, and `callback` is placed in the
request body, never in the request URL. A traversal-shaped `full_name` could only rewrite the path
within that same origin, and `registerWebhook` has no HTTP caller in the candidate, so there is no
attacker-reachable trigger today. Recorded as a consistency gap that becomes reachable the moment a
route calls it, not as a current defect.

finding: id=R2 scope=in_scope action=none status=open severity=low fix_role=security rationale=gitea registerWebhook omits encodeURIComponent on repo.full_name unlike the github and gitlab branches, same-origin only and no HTTP caller exists so there is no reachable trigger today

## Focus items checked and not admitted

1. Signature verification. `parseWebhook` (`index.ts:292-322`) verifies before `JSON.parse`, over the
   raw body string preserved by the plugin-scoped `application/json` parser at `webhook.ts:58-64`
   (`parseAs: 'string'`, `done(null, body)`), so no re-serialization can occur before the HMAC. The
   parser override is registered inside `app.register(async function webhookContext(child) ...)`, so
   Fastify encapsulation keeps it off every other route. Comparison is `timingSafeEqual` on equal-length
   buffers with a length pre-check (`index.ts:234-239`); the length pre-check leaks only digest length,
   which is fixed and public for all three schemes. GitHub compares the full `sha256=` prefixed hex,
   Gitea the bare hex, GitLab the `X-Gitlab-Token` plaintext against the secret timing-safely. A missing
   header, and a missing or empty configured `webhookSecret`, both throw `WebhookSignatureError`, so the
   route fails closed rather than open.
2. Secret and token exposure. Responses are `{ error: 'invalid_signature' }` (401),
   `{ error: 'not_found' }` (404), and empty 204 bodies. `WebhookSignatureError`'s message is the fixed
   string `invalid webhook signature`, carrying neither the received nor the expected digest.
   `registerWebhook` error messages carry only kind and HTTP status. `events.details` is
   `{ task_id, from, to, pr_url }` (`poller.ts` `applyPrTerminalTransition`) with no secret material.
   No logging statement is added anywhere in the change, and `Fastify()` is constructed without a logger.
3. Second token reveal. `apps/server/src/webhook.ts` imports no vault function; `decryptToken`,
   `revealCredentialProfile`, and `getPullRequest` appear nowhere on the webhook path, and
   `applyPrTerminalTransition` was factored out of `pollOneTask` strictly below the credential
   resolution step. The webhook is not a third token reveal.
4. SSRF in `registerWebhook`. GitHub uses the `GITHUB_API_ORIGIN` constant (`index.ts:67,354`);
   GitLab and Gitea use constructor `options.baseUrl`, never `repo.base_url` and never the callback.
   `callback` is a body field only. The host rule is respected; see R2 for the unencoded-path nit.
5. Cross-instance authorization. Admitted as R1.
6a. `publicId` enumeration. Unknown instance answers 404 while a bad signature answers 401, which does
   distinguish configured `publicId` values, and the route has no rate limit. This response split is the
   behavior the orchestrator ruling specifies, `publicId` is a routing identifier rather than the
   authentication secret, and discovering it yields nothing without the secret. Not a defect.
6b. Body parser confusion. Covered in item 1: the string parser is encapsulated to the webhook plugin
   context, Fastify's default 1MB body limit still applies, and non-JSON content types still fall
   through to Fastify's normal 415 handling.
6c. `FORGE_INSTANCES` unsanitized cast. `readForgeInstances` (`apps/server/src/index.ts`) validates only
   that the parsed value is an array and then casts. The input is an operator-supplied environment
   variable, not attacker-reachable. The failure modes are safe: a missing or empty `webhookSecret`
   makes `parseWebhook` throw immediately, so a malformed entry rejects every delivery rather than
   accepting any, and invalid JSON fails boot instead of silently reverting to poll-everything. Worth
   noting for operators, not a security defect: a `forge` value outside `github`/`gitlab`/`gitea` is not
   validated at runtime and falls through `parseWebhook`'s final `else` to the Gitea scheme, and a
   duplicated `publicId` resolves to the first entry via `Array.prototype.find`.
6d. Not scoping the receiver by `syncMode` is explicitly blessed by the orchestrator ruling and is a
   separate axis from R1's identity binding; it is not raised as its own finding.

## Receipt

verdict: fail
findings_blocking: 1

review_conclusion: The webhook implementation gets its cryptography right, verifying each forge scheme timing-safely over the raw body before any JSON parse and keeping tokens, secrets and ciphertext out of every response, event detail, thrown message and log, but it stops short of binding the authenticated forge instance to the task it mutates, so a delivery signed with one instance secret can drive an unrelated instance's task through its terminal transition on nothing but an attacker-chosen pull request URL.
