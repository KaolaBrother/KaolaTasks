# Security review — Issue #53 candidate (branch `workflow/bundle-53`)

Candidate: `git diff origin/main...HEAD` in
`/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/.kw/worktrees/bundle-53`
(43 files, +7255 / -162). Read-only review; no repository file was modified.

Threat model: `docs/DESIGN.md` §7 (token reveal channels), §11 (session permission levels),
§17.6 (review-loop invariants).

## Verdict

**Pass — no blocking security defect.** No candidate-caused defect breaches the token-reveal
channel, the Claim fencing model, the session authorization model, or the outbound-request host
rule. Three low, non-blocking observations are recorded below; each is a judgement call for the
production owner rather than a demonstrated trust-model breach.

| id | severity | class | anchor | action |
|----|----------|-------|--------|--------|
| R1 | low | authorization contract mismatch | `apps/server/src/review.ts:1194` | note |
| R2 | low | unbounded input on authenticated write surfaces | `apps/server/src/review.ts:442` | note |
| R3 | low | no per-session cap on long-lived connections | `apps/server/src/stream.ts:117` | note |

## R1 — `GET …/review` has no permission-level gate, while the candidate's own contract says it does

- **Severity:** low. **Class:** broken access control (documented contract vs. implementation).
- **Primary anchor:** `apps/server/src/review.ts:1194-1201`.
- **Secondary anchors:** `docs/api.md:328`, `apps/server/src/stream.ts:99-100`,
  `apps/server/src/events.ts:26-32`, `apps/server/src/review.test.ts:751-752`.

`docs/api.md:328` opens the review-loop REST section — the section that lists all six routes,
including `GET /api/v1/tasks/:publicId/review` — with:

```
Session routes. Reviewer = any `active` user with `permission_level` `admin` or `full`
(`canPublish`); anyone else → `403` `{ error: 'forbidden' }`
```

The five mutating routes enforce that through `requireReviewer` (`review.ts:1180-1191`). The GET
route does not: it calls `getSessionUser` and nothing else. Any session, regardless of permission
level or account status, reads the full review view — every discussion message across every round,
the resolved author usernames, `pr_url` and `head_sha`.

Reachable populations that the doc sentence says must get `403`:

- a legacy `claim_only` user (asserted to receive `200` by `review.test.ts:751-752`),
- a `待批准` (pending, not yet approved) account,
- a `revoked` account whose session cookie is still live.

The inconsistency is sharpest against the candidate's own sibling route: the new SSE endpoint
(`stream.ts:99-100`) deliberately refuses `待批准` with `401`, copying the existing gate on
`GET /api/v1/events` (`events.ts:26`). So within one change set, one new read route blocks pending
accounts and the other does not.

Why this is a note and not an admitted defect: `review.test.ts:751` asserts `200` with the comment
"any active user may read the review view", so the open read is a deliberate implementation
decision, and it mirrors the pre-existing posture of `GET /api/v1/tasks/:publicId`, which those
same accounts can already read. The exposed data is task discussion content, never a credential.
I cannot prove the trust model is breached, only that the documented authorization contract and the
code disagree on one route.

**Minimal fix (owner's choice, one of):**

1. Add the pending gate to the GET route so it matches SSE and `/api/v1/events`:
   `if (user == null || user.status === '待批准') return sendUnauthorized(request, reply)`; or
2. Narrow `docs/api.md:328` so the `403` sentence scopes to the five `POST` routes and state
   explicitly that the GET view is readable by any session, as `GET /api/v1/tasks/:publicId` is.

## R2 — No length or count cap on the new authenticated write surfaces

- **Severity:** low. **Class:** resource consumption / unbounded input.
- **Primary anchor:** `apps/server/src/review.ts:442-454` (`readMessageInput`).
- **Secondary anchors:** `apps/server/src/review.ts:829-843` (`readReviewItems`),
  `apps/server/src/claim.ts` `readProgressExtras` (`phase`).

`body_md` (reviewer REST and MCP `post_discussion_message`), `phase` (`report_progress`), and the
`items` array of `open_review_round` are validated for type and non-emptiness only. No maximum
length, no maximum item count, and `apps/server/src/app.ts` sets no `bodyLimit`, so the only bound
is Fastify's 1 MiB default per request. `phase` additionally lands in `events.details` and is
broadcast verbatim to every connected SSE client on every heartbeat.

Precondition: an authenticated reviewer session, or a device holding a live Claim. Blast radius is
database and stream growth, not confidentiality. Comparable pre-existing fields (`title`,
`description_md`, `summary`, the heartbeat `note`) are equally uncapped, so this is not a new class
of exposure — it is new surface with the same gap.

**Minimal fix:** cap `body_md` and `phase` (8 KiB is generous for both) inside `readMessageInput`
and `readProgressExtras`, and cap `items.length` in `readReviewItems`; return the existing
`invalid_body` on overflow.

## R3 — No per-session cap on SSE connections

- **Severity:** low. **Class:** missing rate limit on a new long-lived-connection endpoint.
- **Primary anchor:** `apps/server/src/stream.ts:117-129`.

Each accepted `GET /api/v1/stream` allocates a `setInterval` heartbeat and is retained in the
module-level `connections` set until its socket closes. Nothing limits how many connections one
session may hold. A single authenticated account can open connections until file descriptors or
timers are exhausted, and each `publishStreamEvent` then fans out to all of them.

Mitigations already present: the endpoint requires a session and refuses `待批准`; connections are
released on socket `close` and on `preClose`; the ping timer is cleared in `forget`. So this is a
bound on an already-authenticated internal user, not an anonymous vector.

**Minimal fix:** track connections per `request.session.userId` and refuse beyond a small cap
(for example 5) with `429`.

## Checked and found clean

**Token and ciphertext containment (§7, §17.6).**
`review.ts` decrypts a task credential in exactly one place, `attemptMarkReady`
(`review.ts:1108-1147`), which runs off the response path via `trackBackgroundWork` and returns
nothing to any caller. No `console.*`, request logger, or `app.log` call exists in `review.ts` or
`stream.ts`. Every review response is assembled from an explicit field list — `getReviewView`,
`buildReviewBrief`, `messageWire`, `roundWire` — never from a raw `tasks` row (which does carry
`inline_token_encrypted`). `events.details` for the seven new event types carries only `task_id`,
`round`, `kind`, `verdict`, `pr_url`, `head_sha`, `message_id`, `base_branch`, `parent_task_id`,
`transition`, `ok`, `ambiguous`. The `翻ready` writeback event records `{ task_id, transition, ok,
pr_url }`. The smoke script asserts both `get_review_feedback` and the whole `events` table are free
of the revealed token, and folds git output through the existing redaction list.

**SSE payloads and frame injection.**
All five `publishStreamEvent` call sites (`claim.ts:632,708,789,921`, `poller.ts:117`,
`tasks.ts:899`, `review.ts:396,400,404`) carry only `task_id` plus short scalars. No `note`, no
`body_md`, no token, no ciphertext ever enters a frame; `report_progress`'s free-text `note` is
explicitly excluded while `percent`/`phase` are included, matching §17.5. Frame injection is not
possible: `JSON.stringify` escapes CR and LF, verified empirically — a `phase` containing
`"\n\ndata: {...}\n\n"` produces a frame with exactly three real newlines (event line, data line,
terminator). The event name is a closed TypeScript union supplied by call sites, never by input.
U+2028/U+2029 survive `JSON.stringify` but are not SSE line terminators, which split only on
CR/LF/CRLF.

**Session authorization on the mutating routes.**
All five `POST` review routes go through `requireReviewer` → `canPublish` (active AND
admin-or-full). `待批准`, `revoked`, and `claim_only` all fail the `status === 'active'` or
permission test and receive `403 { error: 'forbidden' }`; no session receives `401`/redirect.
`review.test.ts:744-748` exercises the `claim_only` `403` on all five.

**CSRF on the new POST surface.**
The session cookie is `httpOnly`, `sameSite: 'lax'`, and `secure` when `PUBLIC_URL` is https
(`auth.ts:445-449`). SameSite=Lax suppresses the cookie on cross-site `POST`, and the new routes
consume JSON bodies, which are not simple requests. The new SSE `GET` is a subresource fetch, also
Lax-blocked cross-site.

**Claim fencing on the three new Agent tools.**
`postDiscussionMessage` and `openReviewRound` use `resolveActiveLeaseForMutation`; `submitRevision`
uses `resolveMutationLease`. Both funnel into `checkClaimFencing` (`claim.ts:143-158`), which
requires the exact `leases.device_id`, the exact owner (user id or claimant id, `ownerMatchesLease`
at `claim.ts:125-134`), and a matching derived `claim_id` when the lease was minted with a
`request_id`. A device cannot act on another device's Claim even under the same owner.
`submitRevision`'s idempotent replay resolves `submission_revisions` by `lease_id`, and that lease
was already fenced.

**`open_review_round` cannot reach an unrelated task.**
`review.ts:846-885` enumerates only the direct children of the named parent, requires an active
lease on one of them whose `device_id` equals the caller's, and then re-fences it through
`resolveActiveLeaseForMutation` with the presented `claim_id`. A caller holding a Claim on a task
that is not a child of the named parent gets `403 forbidden`; a caller with no live Claim gets
`409 stale_claim`. Grandparents are unreachable. The parent flips `待验收 → 待修改` only when it
actually holds a submission; in any other state the items are appended without a status change,
matching §17.4.

**Cross-task message references.**
`validateMessageRefs` (`review.ts:458-476`) resolves both `resolves` and `reply_to` with an explicit
`eq(discussionMessages.taskId, taskId)` predicate, and additionally requires the `resolves` target
to be `kind === 'blocking'`. A message id belonging to another task is refused as `invalid_body`,
so ids cannot be used to probe or link across tasks.

**Anchor parsing and prototype pollution.**
`readAnchor` (`review.ts:130-147`) walks `Object.keys` and accepts only `path`, `head_sha`, `url`
(strings) and `line` (non-negative integer); any other key — including `__proto__` or
`constructor` — rejects the entire body. The stored value is `JSON.stringify` of a fresh object
literal, so `parseAnchor` on read can only ever see the four documented keys.

**SSRF on the new outbound calls.**
`attemptMarkReady` builds its adapter with `baseUrl: task.repoBaseUrl` — a value set by a publisher
at task creation, never by an Agent or by the PR URL. `prApiOrigin` returns the hard-coded
`https://api.github.com` for GitHub and `options.baseUrl` otherwise; the GitHub GraphQL hop posts to
the same hard-coded origin. The submitted PR URL contributes only path segments, each passed through
`encodeURIComponent`, and `submitRevision` additionally requires it to equal the first submission's
canonicalized URL byte for byte. No user-supplied address is ever fetched.

**GitHub Draft→ready mutation.**
The `node_id` travels as a GraphQL variable (`variables: { id: nodeId }`) against a constant query
string; there is no interpolation and therefore no GraphQL injection. A `200` response carrying a
non-empty `errors` array is correctly treated as failure, so a silently-failed flip is not recorded
as success. The read-before-write makes a retry after an ack loss idempotent.

**Draft-prefix regexes.**
`GITEA_WIP_PREFIX` = `/^\s*wip:\s*/iu` and `GITLAB_DRAFT_PREFIX` =
`/^\s*(?:draft:|wip:|\[draft\]|\(draft\))\s*/iu`. Both are anchored, contain no nested quantifier,
and the leading `\s*` cannot overlap the alternation (every alternative starts with a non-space).
Matching is linear; no ReDoS. Only a leading prefix is stripped from a forge-supplied title before
it is written back.

**`forgeRequest` consolidation.**
Every verb (GET/POST/PUT/PATCH) now inherits the same `AbortSignal.timeout` and the same per-kind
auth header; `markPullRequestReady` passes an explicit 30 s deadline. A bodyless GET sends no
`Content-Type`. No credential is placed in a URL or a query string.

**Optional summary comment.**
Gated behind `KAOLA_REVIEW_SUMMARY_COMMENT=1` (default off). The body contains only the task's
public id, the round count, and `PUBLIC_URL`; it can carry no discussion text and no token. Its
failure is swallowed and never recorded as a failure of the approval.

**Web rendering (XSS).**
`apps/web/src` contains no `v-html`, no `innerHTML`, and no other raw-HTML sink. `body_md`, the
author label, the anchor label, and the progress `phase` all render through `{{ }}` text
interpolation, which Vue escapes. The only attribute sink is the anchor `<a :href>` at
`App.vue:339-343`, guarded by `anchorIsHttp` → `urlLooksHttp`, which trims and requires an `http:`
or `https:` prefix. A stored `javascript:` anchor therefore renders as inert text via the
`v-else` branch. `parseAnchorLink` (`review-anchor.ts:62`) independently rejects non-http(s)
schemes before extracting `path`/`head_sha`, so a pasted `javascript:` link degrades to a
url-only anchor rather than a path anchor.

**`pr_url` scheme.**
`canonicalizePrUrl` rebuilds the stored string as `origin + pathname`; for a non-special scheme the
WHATWG `origin` is the literal string `"null"` (verified in Node), so a crafted
`javascript:/owner/repo/pull/1` is stored as `null/owner/repo/pull/1` and fails `urlLooksHttp`.
This code is unchanged by the candidate apart from being exported.

**Re-claiming `待修改`.**
The claim CAS predicate now matches the observed status rather than a literal `待认领`
(`claim.ts:584`), which keeps it a real compare-and-swap for the new claimable state. Every path
that parks a task in `待修改` terminates the lease first — `sweepExpiredLeases` marks the lease
`expired` before the status write, `releaseTask` marks it released, `submitRevision` calls
`markLeaseReleased` inside the same transaction, and the reviewer paths run from `待验收`/`待合并`
where no active lease exists. A second device cannot claim a task another device still holds.

**Sub-task parent selection.**
`parent_task_id` is accepted only at creation, requires the parent to exist (`400`), to be
non-terminal, and to share the child's forge, base URL and full name (`409 parent_invalid`). It is
not settable through `PATCH /api/v1/tasks/:publicId`, which remains restricted to the task's own
poster.

**Poller and webhook widening.**
Both now match `待验收`/`待修改`/`待合并`, but `prTerminalTarget` applies `merged` only from
`待合并`. A human merging a PR that Kaola never approved no longer completes the task — a
tightening relative to `main`. The webhook remains authenticated by forge signature only, unchanged.

**Database migration.**
All new columns go through `tryAddColumn` and all new tables through `CREATE TABLE IF NOT EXISTS`,
with `NOT NULL DEFAULT` on the two non-nullable additions. No destructive statement, no table
rebuild, no change to any credential or permission column.

**Secret scan of the full diff.**
No real token, private key, JWT, email address, certificate identity, or absolute local path
(`/Users/`, `/Volumes/`, `/home/`) appears on any added line, in product files, docs, or fixtures.
The only credential-shaped literals are synthetic and confined to `*.test.ts`:
`INLINE_TOKEN = 'gitea-REVIEW-INLINE-TOKEN-zz91'` (a marker used to assert non-leakage),
`github_pat_test-token`, and `test-*-client-secret` env values. Hostnames are `api.github.com`,
`github.com`, the established public smoke repo `gitlab.com`/`gitea.com` `KaolaBrother/
kaola-tasks-smoke`, `localhost`, `127.0.0.1`, and `.example`/`.test` placeholders.

## Residual risk noted, not a finding

`head_sha` is supplied by the Agent on `submit_pr` and `submit_revision` and is never verified
against the forge; `backfillSubmissionHead` writes only when the stored value is null, so a
value the Agent invented is never corrected. An Agent could also push further commits between
handing a revision back and the reviewer's 「通过」, after which Kaola flips the Draft to ready
automatically. The consequence is that a PR containing commits the reviewer did not read can become
non-draft — not that unreviewed code merges. The merge itself stays a human action on the forge,
which §17.1 designates as the code-fact layer, so the trust model holds. Worth stating in the
reviewer-facing docs: Kaola's `head_sha` is a claim by the Agent, not a forge-verified fact.
