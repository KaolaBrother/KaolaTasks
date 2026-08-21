# Evidence-binding header (do not modify above this line)
project: issue-14
issue: 14
surface: commentOnIssue + imported-task write-back on claim/submit_pr/complete + retryPendingWritebacks + webhook/poller decrypt-for-comment
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14
# End evidence-binding header

# Security review — issue #14 write-back surface

Reviewed the uncommitted production diff vs HEAD in the worktree on `workflow/issue-14`.
Read in full: `packages/forge-adapters/src/index.ts` (all 632 lines, not just the diff hunk),
`apps/server/src/writeback.ts`, `poller.ts`, `webhook.ts`, `claim.ts`, `app.ts`, `mcp.ts`,
`vault.ts`, plus the `repoBaseUrl` provenance in `tasks.ts` and the poll interval in `index.ts`.
Tests were read as intent evidence only. No production or test file was modified.

## Q1 — Does write-back become a third HTTP token-reveal channel? No.

Traced every sink the token could reach:

- **Claim `201`**: body is unchanged (`task`, `token`, `lease`, `clone`). `attemptWriteback` is
  called at `claim.ts:173`, between the audit inserts and the response object; it returns
  `Promise<void>` and contributes nothing to the body. The `token` there is the pre-existing
  sanctioned reveal, not a new one.
- **`submit_pr` result**: `{ task, pr_url, summary }` (`claim.ts:355-363`). No token.
- **Webhook**: `204` with an empty body (`webhook.ts:104`), unchanged.
- **`retryPendingWritebacks`**: `Promise<void>`, no HTTP surface at all.
- **`events.details`**: `recordSuccessfulWriteback` writes exactly
  `{ task_id, transition, ok: true, issue_url }` (`writeback.ts:81`). No token, no ciphertext, no
  `Authorization` value. `issue_url` is `task.sourceIssueUrl`, already stored plaintext on the
  task row. Confirmed no HTTP route reads the `events` table (`from(events)` appears only in
  `writeback.ts` and tests) — the audit-log UI is #15, still out of scope.
- **Logs**: `writeback.ts` contains no `console.*`, no `log.*`, no Fastify logger reference —
  grepped and confirmed zero matches. Both `catch` blocks in `attemptWriteback` and
  `retryPendingWritebacks` are deliberately empty. `insertAuditEvent` (`vault.ts:73-85`) only
  `JSON.stringify`s details into the row; it never logs.
- **Error message contents**: `postComment` throws `'writeback: no forge credential available for
  task'` (no token); `commentOnIssue` throws `` `commentOnIssue: ${kind} responded ${res.status}` ``
  (kind + status only, no URL, no header). Both are swallowed by `attemptWriteback` before any
  frame can reach Fastify's default error handler, so no stack with an undici cause can be logged
  or returned.

Verified: the two sanctioned channels (REST claim `201` `token`, MCP `claim_task` `token`) remain
the only ones. Write-back adds no third.

## Q2 — Webhook decrypt-to-commentOnIssue: not a confused deputy, equivalent to the poller.

The webhook path now reaches `attemptWriteback` (`poller.ts:95-97`) and therefore decrypts a task
token, which it previously never did. I checked whether that grants an attacker anything:

- **Auth is unchanged**: `parseWebhook` requires a non-empty configured `webhookSecret` and
  verifies HMAC-SHA256 over the raw bytes (GitHub `x-hub-signature-256`, Gitea
  `x-gitea-signature`) or a constant-time token compare (GitLab `x-gitlab-token`), all through
  `timingSafeEqualStrings`. The raw-body content-type parser is still scoped to the webhook plugin
  context, so HMAC is computed over the delivered bytes.
- **The attacker cannot choose the task**: `findPendingReviewMatch` (`webhook.ts:38-52`) requires
  `taskMatchesForgeInstance` — `instance.forge === task.repoForge && instance.baseUrl ===
  task.repoBaseUrl` — against the *signature-verified* instance. A delivery signed by instance A
  can never select a task belonging to instance B.
- **The attacker cannot choose the comment body**: the match also requires
  `submission.prUrl === event.pr_url` byte-for-byte. The `prUrl` that reaches
  `commentBodyFor` is therefore a value the claiming agent already persisted, not free text from
  the payload. This is the detail that closes the injection question for the 完成 path.
- **The attacker cannot choose the destination host**: because the match pins
  `instance.baseUrl === task.repoBaseUrl`, the write-back's `createForgeAdapter(task.repoForge,
  { baseUrl: task.repoBaseUrl })` resolves to the *operator-configured* `FORGE_INSTANCES` baseUrl
  on this path — strictly tighter than the poller's, which accepts any poster-supplied
  `repoBaseUrl`.
- **The token does not egress**: it becomes an `Authorization`/`PRIVATE-TOKEN` header on a POST to
  that pinned host. It is not returned, logged, or stored.

Residual capability of a webhook-secret holder: trigger one templated comment on an issue whose
token they already effectively command, at a moment of their choosing — one tick earlier than the
poller would have done it anyway. They could already force the 已完成 transition itself (#13),
which is strictly more powerful. No escalation. This is the same trust posture as the poller's
existing decrypt-for-`getPullRequest`.

Note (consistent, not a defect): the write-back decrypt does not emit a `token 揭示` event. That
event denotes a reveal *to a principal*; the poller's existing decrypt does not emit one either.

## Q3 — SSRF: no new reach beyond importIssue/getPullRequest.

`commentOnIssue` (`index.ts:498-511`) delegates URL construction to the existing
`resolveImportedIssue`, so it inherits the host rule verbatim:

- **GitHub**: origin is `prApiOrigin` → the `GITHUB_API_ORIGIN` constant `https://api.github.com`.
  The pasted `issue_url`'s host is **discarded entirely** — only `url.pathname` is matched against
  `^\/([^/]+)\/([^/]+)\/issues\/(\d+)$`. Userinfo (`@evil.com`) and port tricks in the pasted URL
  cannot survive, because the host is never read.
- **GitLab/Gitea**: origin is `options.baseUrl` = `task.repoBaseUrl`, the identical value
  `fetchPrStatus` already passes at `poller.ts:104` and that `tasks.ts:561`/`707` already pass to
  `validateToken`/`importIssue`.
- **No path escape**: `owner`/`repo`/`namespace` are `encodeURIComponent`'d (so a GitLab namespace
  matched by the greedy `.+` has its slashes encoded as `%2F`), the issue number is `\d+`, and the
  appended suffix is the literal `/notes` or `/comments`. There is no way to redirect the request
  off the resolved origin.
- **Unparseable URL throws** and is caught by `attemptWriteback` — no fetch is issued.

A malicious `repoBaseUrl` (e.g. link-local metadata) is reachable, but it was already reachable
pre-#14 through `validateToken` at task creation, `importIssue` at import, and `getPullRequest`
in the poller — and a task is only persisted after `validateToken` succeeded against that host.
`commentOnIssue` sends the poster's own token to the poster's own declared host. Pre-existing
posture, no new capability, not candidate-caused.

## Q4 — Retry behavior, Agent-key misuse, plaintext logging.

- **Agent API key is never used as a forge token.** `postComment` sources the credential solely
  from `decryptTaskToken(db, task)` (task-attached profile or inline ciphertext). The caller's
  `auth` reaches `attemptWriteback` only as `actorUserId` for the audit row. Confirmed at both
  call sites (`claim.ts:173`, `claim.ts:353`).
- **No retry storm.** Default `POLL_INTERVAL_MS` is `60000` (`index.ts:4-7`). The retry sweep runs
  inside the *same* in-flight guard as `pollPendingReviews` (`app.ts:59-69`), and the chaining is
  correct: `.then(() => retryPendingWritebacks(db).catch(...))` returns the promise, so `.finally`
  releases `polling` only after the retry completes — no overlapping sweeps. Within a sweep,
  tasks and transitions are awaited sequentially: at most one POST per (task, transition) per
  minute. No concurrency fan-out, no exponential amplification.
- **Success marker cannot be forged or suppressed.** `writeback.ts` is the only writer of `回写`
  events, and all three matched fields (`task_id`, `transition`, `ok`) are server-constructed.
  `claimOccurred` matches `状态迁移` on `details.to === '进行中'`, which is computed by
  `transitionTaskStatus`; the user-supplied `summary`/`reason` values live under different keys and
  cannot influence it. No attacker-controlled path can either fabricate a suppressing marker or
  induce a write-back for another task.
- **No plaintext logging** — established above in Q1.
- **No DB lock held across HTTP**: every `attemptWriteback` call is placed after its transaction
  commits (`poller.ts:85-97`) or after the plain writes complete (`claim.ts`), never inside
  `db.transaction`.

## Q5 — Comment body injection: in-trust-model, no XSS or token leak.

`commentBodyFor` interpolates three things: the server-generated `publicId`, `PUBLIC_URL` from the
operator's env (trailing slashes trimmed), and `prUrl`.

`prUrl` is agent-supplied and unvalidated — MCP `submit_pr` declares `pr_url: z.string()`
(`mcp.ts:153`), so arbitrary markdown can land in the 提交PR comment. This confers nothing: to
call `submit_pr` an agent must hold the task lease, which means it already received the poster's
plaintext forge token from the sanctioned claim reveal, and could post any comment to that issue
directly with far more freedom. On the 完成 path the string is additionally constrained to the
already-persisted `submission.prUrl` (poller) or must byte-equal it (webhook, per Q2). Rendering
and sanitization happen on the forge; Kaola never renders these bodies, and the web UI does not
display `回写` events. No token appears in any body. In-trust-model.

## Non-blocking observations (explicitly NOT findings)

Recording these for the record because they are candidate-adjacent, but none is a security defect
in this trust model and none is candidate-caused in a way that warrants a fix here.

1. **Retry has no attempt cap or backoff.** A permanently failing write-back (token lacking issue
   scope, deleted issue) re-POSTs once per poll interval indefinitely — ~1440 attempts/day per
   transition against the poster's own forge. This is exactly the retry condition the orchestrator
   ruling §4 specifies ("imported task whose transition has occurred and which has no successful
   回写 for it"), with no cap requested. Bounded rate, poster's own credential, no token exposure.
2. **Claim now blocks on an outbound forge POST before returning the token.** `claimTask` was
   previously pure-synchronous; a slow `repoBaseUrl` host can now stall a claim request (no fetch
   timeout exists anywhere in this repo — `AbortSignal`/`timeout` grep returns zero matches), and
   the transition, lease, and `token 揭示` event are already committed if the client gives up. The
   audit then over-reports a reveal that the agent never received, which is the safe direction, and
   the lease is releasable. `POST /api/v1/tasks` (create/import) already has the identical
   characteristic against the same poster-supplied host, and ruling §4 mandates the inline
   placement ("attempt write-back after the status transition is committed, at each of the three
   hooks"). Adding fetch timeouts would be a repo-wide convention change, out of scope for #14 and
   better raised as its own issue.
3. **Retry-sweep reads are O(tasks x events).** `hasSuccessfulWriteback` and `claimOccurred` each
   load and `JSON.parse` every `回写` / `状态迁移` row per task per transition check, on
   synchronous better-sqlite3 reads on the event loop. This is a performance characteristic that
   degrades as the audit log grows; framing it as a DoS would require an already-approved member
   who has cheaper options. Not a security defect.

## Conclusion

No high-confidence candidate-caused security defect. The two token-reveal channels are intact and
write-back adds none; the webhook's new decrypt is authenticated by forge signature and pinned to
the delivering instance's own task, host, and previously-persisted PR URL, so the token never
leaves the server; `commentOnIssue` inherits the established host rule and discards the pasted
URL's host entirely; the Agent API key is never used as a forge credential; nothing is logged.

verdict: pass
findings_blocking: 0
review_conclusion: The issue-14 write-back surface introduces no new token-reveal channel, no SSRF reach beyond the pre-existing importIssue/getPullRequest host rule, and no confused-deputy path — the webhook's new decrypt-to-comment is authenticated by forge signature and triple-pinned to the delivering instance's own task, base URL, and already-persisted PR URL, keeping the token server-side exactly as the poller already did.

