# Evidence-binding header (do not modify above this line)
project: issue-11
issue: 11
surface: getPullRequest + pollPendingReviews decrypt-for-poll + 待验收→已完成/已退回 events + buildApp pollIntervalMs
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11
# End evidence-binding header

## Scope reviewed

Uncommitted delta on `workflow/issue-11` (`git status --porcelain`): `M apps/server/src/app.ts`,
`M apps/server/src/index.ts`, `M package.json`, `M packages/forge-adapters/src/index.ts`,
`?? apps/server/src/poller.ts`. Test files (`poller.test.ts`, `get-pull-request.shared.test.ts`)
treated as oracles, not reviewed as a defect surface.

Method: source read of the delta plus its call-graph neighbours (`vault.ts`, `claim.ts`,
`schema.ts`, `db.ts`, `mcp.ts`, `packages/shared/src/index.ts`), cross-checked against
`docs/DESIGN.md` §5/§7/§8 and issue #11, then four live probes run in-process from `/tmp/kw-sec-11/`
(no product file written, no listen):

- `probe1.mjs` — seed a `待验收` task with an inline-encrypted token + a submission, stub
  `globalThis.fetch`, run `pollPendingReviews`, dump every request URL/header, the resulting task
  status, and every `events` row; grep the whole DB dump for the plaintext token.
- `probe2.mjs` — adapter error messages/stacks, the skip-on-error path, rejection reachability,
  and two concurrent poll passes.
- `probe3.mjs` — Node's behaviour for a rejecting promise discarded with `void` inside `setInterval`.
- `probe4.mjs` — `buildApp({ pollIntervalMs })` ready/close cycle, `POLL_INTERVAL_MS` parsing.

## Focus-item verdicts (all four clean)

**1. Token must not reach `events.details`, logs, thrown errors, or HTTP — CLEAN.**
`insertAuditEvent` from the poller writes only `{ task_id, from, to, pr_url }`
(`poller.ts:73-77`). Probe 1 grepped the serialized `events` + `tasks` dump for the plaintext in
all seven scenarios: `TOKEN IN DB? : no` every time. Probe 2 §A: the three reachable throw sites
carry no token — `getPullRequest: github responded 401`, `unparseable GitHub pull request URL:
not-a-url`, `fetch failed`; the stack was also checked (`token present? false`). Probe 2 §B wrapped
`process.stdout.write`/`process.stderr.write` across a 500-response poll and a
vault-unconfigured poll: `any output containing token? false`. The poller has no logging call at
all, and probe 4 shows `app.log.level` is `undefined` (Fastify's default no-op logger), so there is
no sink for a token to reach even accidentally. The poller adds no route (probe 4: the naked app
still answers only `GET /` → `考拉任务服务占位`), so it has no HTTP response to leak into. Session
GET stays clean for an independent reason: `tasks.ts`'s `taskBrief` never reads
`inlineTokenEncrypted` (grep for `inlineTokenEncrypted|tokenEncrypted` shows the only readers are
`claim.ts:117/128`, `poller.ts:39/42`, `vault.ts:93`, `tasks.ts` write path).

**2. SSRF via attacker-controlled `pr_url` host — CLEAN.**
`prApiOrigin` (`index.ts:140-143`) returns the constant `https://api.github.com` for GitHub and
constructor `options.baseUrl` for GitLab/Gitea; the parsed `prUrl` contributes path components
only. Probe 1 confirms the host is never taken from `pr_url`:

| task forge / base_url | submitted `pr_url` | URL actually fetched |
|---|---|---|
| gitea / `https://gitea.internal` | `https://evil.example.com/o/r/pulls/7` | `https://gitea.internal/api/v1/repos/o/r/pulls/7` |
| github / `https://ghe.internal` | `https://evil.example.com/o/r/pull/7` | `https://api.github.com/repos/o/r/pulls/7` |
| gitlab / `https://gitlab.internal` | `https://user:pw@evil.example.com/ns/p/-/merge_requests/7` | `https://gitlab.internal/api/v4/projects/ns%2Fp/merge_requests/7` |

The `\`-as-`/` trick (`https://x.example/o\..\..\r/pulls/7`) is neutralised by WHATWG URL
normalisation before the regex runs, so the row is skipped with zero requests. `GITHUB_API_ORIGIN`
being used even when `repo_base_url` is a GHE host matches `docs/DESIGN.md` §8 ("GitHub 固定
api.github.com") and the committed `apiUrl`/`validateToken` behaviour, so it is out of scope as
stated in the dispatch trust model.

**3. Skip-on-error must not leak the token — CLEAN.**
Both `catch` blocks (`poller.ts:43-45`, `54-56`) are bare `catch {}` with no binding, so nothing
derived from the error can be re-emitted. Probe 2 §B: after a 500 response the task stays `待验收`
with `events` empty; with `VAULT_MASTER_KEY` deleted the task stays `待验收`. No output, no rows.

**4. Timer must not log the token — CLEAN.**
`app.ts:46-53` runs `void pollPendingReviews(db)` and nothing else; there is no logger call on the
path, and the default Fastify logger is a no-op (probe 4).

## Findings

finding: [blocking][availability][high confidence] `apps/server/src/app.ts:47-49` — the interval
callback discards the poll promise with `void` and installs no rejection handler, so any rejection
out of `pollPendingReviews` becomes an unhandled rejection and, under Node's default
`--unhandled-rejections=throw` (repo pins `engines.node >=22`; measured on the worktree's v24.14.0),
terminates the whole API process. Rejection is reachable: the write phase of `pollOneTask`
(`poller.ts:71-77` — two `db.update` calls plus `insertAuditEvent`) sits outside every `try`, so a
DB-layer fault (`SQLITE_BUSY` on a file-backed `SQLITE_PATH` shared with another process, read-only
FS, disk full) propagates. Probe 2 §C reproduces the rejection (`pollPendingReviews REJECTS: no
such table: events`, injected as a stand-in for any write fault); probe 3 shows the timer shape
exits `1` with an uncaught `Error`. A background status-sync fault taking down `/api/v1/*` is a
denial-of-service the candidate introduces. Fix is local: `.catch()` inside the interval callback
(and/or wrap the per-task body in `poller.ts`), swallowing or counting the error the same way the
existing per-row `catch` blocks do. No token is exposed by this path — the crash stack contains no
token (probe 2 §C: `token in message? false`).

finding: [non-blocking][integrity/audit][high confidence] `apps/server/src/poller.ts:71-77` — the
status write, the `submissions.pr_state` write and the `状态迁移` event are three separate
statements with no enclosing transaction, so a fault after `line 71` leaves the task advanced to
`已完成`/`已退回` with no audit event recording who/what moved it. Probe 2 §C observed exactly this
state: `task status now : {"status":"已完成"}` while the event insert failed. `events` is the audit
log per `docs/DESIGN.md` §10, so a silently unaudited terminal transition is an audit-integrity
gap. Fix: wrap the three writes in a single `db.transaction`.

finding: [non-blocking][authorization/integrity][high confidence] `apps/server/src/poller.ts:63` +
`packages/forge-adapters/src/index.ts:145-169` — `submission.prUrl` is never bound to the task's own
repository, and nothing upstream validates it either (`mcp.ts:153` types `pr_url` as bare
`z.string()`; `submitPr` in `claim.ts:287-342` stores it unvalidated). The adapter parses
owner/repo/number out of whatever URL was submitted and ignores `task.repo_full_name`, so a claimer
holding the lease can submit any already-merged PR on the same forge and the poller will drive
`待验收 → 已完成` on their behalf, bypassing the poster review that `docs/DESIGN.md` §5 defines as
the acceptance gate ("验收在 forge 上完成"). Probe 1, last row, reproduces it: a task on
`owner/repo` transitions to `已完成` off `https://github.com/other-owner/other-repo/pull/1`, and the
poster's token is presented to `https://api.github.com/repos/other-owner/other-repo/pulls/1` — a
confused-deputy read at a claimer-chosen path. Classified non-blocking, not clean: the dispatch
trust model grants the claimer the same token in plaintext at claim time, so there is no
confidentiality escalation (they can already issue that request themselves with full response
bodies), and the fetch host stays pinned per finding 2 above. What remains is the acceptance-gate
bypass. It is also not specified away: neither issue #11 nor `docs/DESIGN.md` §5/§8 states whether
`pr_url` must belong to the task repo, so adding the check tightens a user-visible contract and,
per `CLAUDE.md`'s escalation rule, is the user's call. Recommended shape: reject at `submit_pr`
(better than at poll time, so the claimer gets an error) when the URL's host is not the task's
`repo_base_url` host (or github.com for `github`) or its owner/repo path does not equal
`task.repo_full_name`.

finding: [non-blocking][audit/robustness][high confidence] `apps/server/src/app.ts:47-49` +
`poller.ts:80-85` — there is no in-flight guard, so whenever a poll pass outlives `pollIntervalMs`
the next tick re-selects the same `待验收` rows and repeats the transition. Probe 2 §D runs two
overlapping passes against one task and gets `fetch calls: 2`, `events rows: 2` with two byte-
identical `待验收 → 已完成` events, i.e. duplicated audit history. Two amplifiers make this the
normal case rather than the rare one for exactly the deployment `docs/DESIGN.md` §8 designates for
polling (firewalled self-hosted Gitea): `forgeGet` passes no `signal`, so a hanging forge is bounded
only by undici's ~300 s `headersTimeout` — five stacked passes at the default 60 s interval — and
the `for` loop awaits each task in turn, so one unreachable host stalls polling for every other
`待验收` task behind it. Fix: a module-level in-flight flag, plus `AbortSignal.timeout` on the
adapter fetch.

finding: [non-blocking][hardening][high confidence] `packages/forge-adapters/src/index.ts:155,168` —
GitHub `owner`/`repo` and Gitea `owner`/`repo` are interpolated into the API path without
`encodeURIComponent`, unlike the GitLab namespace on line 162 which is encoded. `[^/]+` admits
percent-encoded separators, and probe 1 confirms they survive into the request:
`pr_url = https://x.example/%2e%2e%2f%2e%2e/r/pulls/7` produces
`GET https://gitea.internal/api/v1/repos/%2e%2e%2f%2e%2e/r/pulls/7` with the poster's token
attached. Impact is limited to same-host path confusion (the origin cannot be pivoted, and a forge
that routes on the raw path simply 404s), so this is hardening rather than an exploit: encode the
segments, or constrain the regex to `[A-Za-z0-9._-]+`.

## Observations (not defects)

- `apps/server/src/index.ts:3-6` — a non-numeric `POLL_INTERVAL_MS` parses to `NaN`, which fails the
  `> 0` guard in `app.ts:42`, silently disabling polling (probe 4 enumerates: `"abc"`→disabled,
  `""`→60000, `"0"`/`"-5"`→disabled, `"5"`→enabled). Fail-silent misconfiguration; polling only ever
  advances status, so it is an operability wart, not a security hole.
- `decryptTaskToken`'s bare `catch` (`poller.ts:43-45`) also swallows `VaultUnconfiguredError`, so a
  missing or rotated `VAULT_MASTER_KEY` makes every poll a silent no-op with no signal anywhere.
  Consistent with the requested skip-on-error behaviour; noted because the codebase has no logger to
  surface it.
- The `待验收 → 已完成/已退回` pair is the only transition the poller can produce, and `from` is
  always `待验收` because the row set is filtered on that status, so `transitionTaskStatus`
  (`packages/shared/src/index.ts:71`) cannot be driven into its illegal-transition throw here.
- `state === 'open'` short-circuits before any write (`poller.ts:64`), so an open PR produces no row
  churn and no event.
- Redirect handling was considered: `forgeGet` uses default `redirect: 'follow'`, and per the fetch
  spec's cross-origin redirect rule (implemented in undici) `Authorization` is stripped on an
  origin-changing redirect; the only host that could attempt it is the task's own forge. Not a
  finding.

verdict: changes-requested
findings_blocking: 1
review_conclusion: The four dispatched focus items are all clean and independently verified — the decrypted token never reaches `events.details`, any log sink, any thrown Error or stack, or any HTTP response, and the fetch host is pinned to `api.github.com` / the task's `repo_base_url` with `pr_url` contributing path components only, so a claimer-supplied URL cannot redirect the poster's credential to a host they choose. One blocking defect stands outside those items: the interval callback discards the poll promise with `void`, so a DB-layer write fault in `pollOneTask` becomes an unhandled rejection that kills the whole server process (measured: exit 1). Four non-blocking findings follow — non-transactional writes that can advance a task with no audit event, a missing `pr_url`-to-task-repo binding that lets a claimer self-certify `已完成` off an unrelated merged PR (needs a product decision, since neither the issue nor DESIGN specifies the binding), overlapping ticks that duplicate `状态迁移` events with no in-flight guard or fetch timeout, and unencoded owner/repo path segments.
