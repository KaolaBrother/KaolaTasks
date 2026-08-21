# tdd-guide handoff — issue #13 (RED baseline)

## Baseline commit

`44eca32b297d8aa15e3966c1bb29090ce6e336cb`, branch `workflow/issue-13`, worktree
`/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13`. Tree was clean before I started
(confirmed by `ground-truth.md`'s own measurement); only the files listed below were
added/changed.

Per role instructions for this issue, I did **not** write a scratch production implementation to
self-verify GREEN before reverting (unlike issue #12's tdd-guide handoff, which did and whose
format I otherwise followed). I proved RED by running every new/changed file directly against
HEAD `44eca32b`, then ran the full suite, and read every failure to confirm it fails for the
pinned reason (see "RED baseline" below) rather than trusting a bare `assert.rejects`/404.

## What I wrote

1. `packages/forge-adapters/src/webhook.shared.test.ts` — **new**. Shared spec for
   `ForgeAdapter.parseWebhook` + `ForgeAdapter.registerWebhook`, parameterized over
   github/gitlab/gitea (copies the fetch-stub/URL-recording helper shapes from
   `get-pull-request.shared.test.ts`; does **not** import that file, per the isolation
   convention). 34 test cases:
   - `parseWebhook`, 7 cases × 3 kinds (21) + 4 kind-independent/kind-specific (25 total): valid signature → concrete
     `merged`/`closed` `ForgeEvent` (`{type:'pull_request', state, pr_url, repo:{full_name}}`
     via `assert.deepEqual`, not a loose shape check); non-terminal action/state (`opened`) →
     `null`; irrelevant event type (`push`/`Push Hook`) → `null`; wrong-secret signature and
     missing-signature-header both → throw with `err.name === 'WebhookSignatureError'` **and**
     `err.message !== 'not implemented'`; adapter constructed with `webhookSecret: undefined`
     or `''` → same signature-error failure. Plus: body accepted as a `Buffer` (all 3 kinds),
     GitHub `ping` → `null` without throwing, Gitea tampered-body (signed bytes ≠ parsed bytes)
     → signature error, GitLab irrelevant-event-with-correct-token → `null` (not an error).
     Every "reject" assertion uses a predicate function (`assertSignatureError`), not a bare
     `assert.throws(fn)` with no check — a bare version would pass against today's synchronous
     `Error('not implemented')` throw.
   - `registerWebhook`, 1 case × 3 kinds (3) + 6 kind-specific happy-path/host-rule cases (9
     total): non-OK HTTP → reject with `${kind} responded ${status}` in the message **and**
     `message !== 'not implemented'` **and** exactly one fetch call; then per kind: GitHub
     `POST https://api.github.com/repos/{owner}/{repo}/hooks` (`name:'web'`,
     `events:['pull_request']`, `config:{url,content_type:'json',secret,...}`, Bearer+User-Agent
     auth) and its api.github.com-regardless-of-baseUrl host rule; GitLab
     `POST {baseUrl}/api/v4/projects/{encoded}/hooks` (`merge_requests_events:true`,
     `token:webhookSecret`, explicitly asserts `signing_token` is **not** set, `PRIVATE-TOKEN`
     auth) and its constructor-baseUrl-not-repo.base_url host rule (nested-group namespace
     encoded); Gitea `POST {baseUrl}/api/v1/repos/{owner}/{repo}/hooks`
     (`type:'gitea'`, `events:['pull_request']`, `config:{url,content_type:'json',secret}`,
     `token` auth) and its constructor-baseUrl host rule.
2. `apps/server/src/webhook.test.ts` — **new**. Drives the **real** `buildApp({ forgeInstances })`
   (seams copied from `poller.test.ts` — OAuth login, agent-key mint, HTTP claim, MCP
   `submit_pr`, sqlite row readers; that file is not imported). No fetch stub for any
   `/pulls/`\|`/merge_requests/` URL is ever installed — hitting one returns a tripwire 500,
   and `stub.requests` is asserted to contain zero PR-endpoint hits after every webhook POST.
   10 test cases: unknown `:publicId` → `404 {error:'not_found'}` (no signature needed); bad
   signature (wrong secret, and separately a missing signature header) → `401
   {error:'invalid_signature'}` with the response body asserted to never contain the configured
   secret; ping/irrelevant event with a correct signature → `204` empty body; a merge delivery
   whose `pr_url` matches the latest submission of a real 待验收 task (built via
   login→claim→MCP `submit_pr`) → `204`, `tasks.status` `已完成`, `submissions.pr_state`
   `merged`, exactly one `状态迁移` event with `actor_user_id: null` and
   `details === {task_id, from:'待验收', to:'已完成', pr_url}` (`assert.deepEqual`, not a
   subset check), plus zero PR-endpoint fetches and no token in the response or in
   `events.details`; the closed-unmerged mirror (`已退回`/`closed`); a delivery whose `pr_url`
   matches no submission → `204` no-op with **zero** status/event changes to the unrelated task;
   a `syncMode: 'poll'` instance's webhook still completes the task (mode gates the poller, not
   this receiver — ruling §4's last bullet); a correctly-signed request sent with **no** session
   cookie and **no** Bearer header still succeeds (signature is the sole auth); and a
   cross-forge-dispatch case using a `github` `forgeInstances` entry verified with
   `X-Hub-Signature-256` (proves the route reads `forge` off the matched instance rather than
   hardcoding gitea).
3. `apps/server/src/poller.test.ts` — **4 cases added**, existing 9 cases untouched (verified
   individually: `node --test apps/server/src/poller.test.ts` → 13 total, 9 pre-existing +
   3 of the 4 new cases pass, only the skip case is RED). All four call
   `pollPendingReviews(db, forgeInstances)` —
   HEAD's `pollPendingReviews` takes only `db`, so today the second argument is silently ignored
   by JS call semantics:
   - **RED (fails today, 1 case)**: a `syncMode: 'webhook'` instance whose `(forge, baseUrl)`
     exactly matches a 待验收 task's `(repoForge, repoBaseUrl)` must be skipped — task stays
     待验收, and (tripwire) a `merged: true` PR stub for that task's PR number is never fetched.
     Fails today because nothing skips; the tripwire stub flips the task to 已完成, caught by
     `assert.equal(after.status, '待验收', ...)`.
   - **Regression guards (pass today, 3 cases, by design — they pin *today's* still-correct
     default behavior so a careless implementation of the skip can't accidentally start
     skipping too much)**: an unlisted/mismatched-tuple instance (one entry with the right forge
     but wrong `baseUrl`, another with the right `baseUrl` but wrong forge — proves the match is
     the exact `(forge, baseUrl)` pair, not either field alone) is still polled; a
     `syncMode: 'poll'` instance matching the task's repo is still polled; an explicit `[]` polls
     everything, same as omitting the argument.
4. Root `package.json` `test` script — **1 line changed**. Inserted
   `packages/forge-adapters/src/webhook.shared.test.ts` immediately after
   `import-issue.shared.test.ts`, and `apps/server/src/webhook.test.ts` immediately after
   `poller.test.ts`. No other script or field touched (`git diff package.json` — 1 line).

No production files were touched: `git status --short` at handoff shows only
`apps/server/src/poller.test.ts` (modified), `package.json` (modified), and the two new test
files (untracked, `??`). `git diff --stat` confirms exactly 2 files changed
(`apps/server/src/poller.test.ts` +154/-0, `package.json` +1/-1); `packages/forge-adapters/src/index.ts`,
`apps/server/src/app.ts`, `apps/server/src/poller.ts`, `docs/DESIGN.md` are all untouched.

## RED baseline

Captured at `kaola-workflow/issue-13/.cache/tests-webhook-baseline.txt` (full `CI=true pnpm test`
stdout/stderr against HEAD `44eca32b297d8aa15e3966c1bb29090ce6e336cb`, SHA + command on the
header lines I prepended). Because the root `"test"` script is `node … && pnpm --filter
@kaola/web test`, the `@kaola/web` vitest suite did not run in this capture (the node:test step
exits 1 first) — no web UI tests are in scope for this issue.

```
ℹ tests 444
ℹ pass 399
ℹ fail 45
EXIT_CODE=1
```

- **399 pass** — every pre-existing node:test, unmodified, still green (no existing suite was
  weakened; individually re-ran `poller.test.ts` alone and confirmed all 9 pre-existing cases in
  it still pass, alongside 3 of the 4 newly added cases — see point 3 above).
- **45 fail**, all newly added, all failing for the pinned reason:
  - **34** in `packages/forge-adapters/src/webhook.shared.test.ts`. `parseWebhook` cases:
    `Error: not implemented` thrown synchronously from `packages/forge-adapters/src/index.ts:68`
    (`notImplemented()`), so every assertion that expects a concrete `ForgeEvent`/`null`/
    `WebhookSignatureError` instead sees the placeholder throw (or, in the two `assert.throws`
    cases, would see the right *shape* of failure — a throw — but `assertSignatureError`'s
    `name === 'WebhookSignatureError'` check catches that today's `name` is plain `'Error'`).
    `registerWebhook` cases: same `notImplemented()` throw — non-OK-response cases fail the
    `${kind} responded ${status}` regex match against the literal string `'not implemented'`;
    happy-path/host-rule cases fail outright since the `await adapter.registerWebhook(...)` call
    itself throws before any assertion runs.
  - **10** in `apps/server/src/webhook.test.ts`. Every one has the signature
    `AssertionError: expected <204|401> for ..., got 404: {"message":"Route
    POST:/api/v1/webhooks/<publicId> not found","error":"Not Found","statusCode":404}` (or the
    same generic Fastify 404 body compared against the pinned `{error:'not_found'}` /
    `{error:'invalid_signature'}` JSON) — confirmed by direct inspection of
    `/tmp/webhook_http_out.txt` during authoring: the route does not exist at all yet, so
    Fastify's own not-found handler answers every request regardless of publicId, signature, or
    payload.
  - **1** in `apps/server/src/poller.test.ts` (the new webhook-mode-skip case):
    `AssertionError: a webhook-mode instance's task must not be advanced by the poller, got
    {"id":1,"public_id":"kt-2026-0001","status":"已完成"}` — `'已完成' !== '待验收'`. The poller
    fetched and completed the task despite the `webhook`-mode instance entry, because
    `pollPendingReviews` has no second parameter yet and therefore no skip logic exists at all.

No test that exercises new behavior currently passes on this HEAD.

## Notes for whoever implements

- `:publicId` in `POST /api/v1/webhooks/:publicId` is a **`forgeInstances[].publicId`**, not a
  task's public id — confirmed by the ruling's own §4/§5 pairing (`forgeInstances` entries each
  carry a `publicId`, and §5 says "Unknown publicId → 404"). The instance record supplies
  `forge` (which adapter's `parseWebhook` to call) and `webhookSecret` (what to verify against);
  the *task* is found afterward, purely by matching `event.pr_url` against
  `submissions.prUrl` — not by the instance's `baseUrl`/`forge` at all.
- `pollPendingReviews`'s new second parameter is exercised directly in `poller.test.ts` as
  `pollPendingReviews(db, forgeInstances)` — this is the contract those 4 added cases pin.
  Wiring `buildApp`'s `setInterval` closure to pass `options?.forgeInstances` through is not
  separately tested here (the existing `pollIntervalMs` timer-contract tests only assert on
  `setInterval` call count/delay, not on what the captured callback does when invoked); get it
  right by inspection, not by a passing test in this file.
- `webhook.test.ts`'s "no matching submission" case and the "poll-mode instance webhook still
  completes" case both intentionally return `204` on success — per ruling §5, *every* successful
  delivery (ping, irrelevant, no-match, completed) is `204` with an empty body; only unknown
  `publicId` (`404`) and bad signature (`401`) differ.
- Webhook completion must reuse `pollOneTask`'s transaction shape (`tasks.status` +
  `submissions.prState` + one `insertAuditEvent` call, atomically) but must **not** decrypt a
  token or call `getPullRequest` — `webhook.test.ts` asserts zero PR-endpoint fetches on every
  case, including the merge/closed cases where the poller equivalent *would* have fetched.
- GitHub/Gitea signature verification must happen over the **raw bytes** captured before any
  JSON parsing (Fastify's default JSON body parser must be bypassed/overridden for this one
  route) — `webhook.test.ts` sends the exact JSON string it also HMACs, via `app.inject({
  payload: rawBodyString, headers: {'content-type': 'application/json', ...} })`; if the
  implementation lets Fastify's default parser re-serialize the body before verification, the
  digest will not match and every currently-RED signature/merge case will still fail after
  implementation, for a *new*, wrong reason — that would itself be a signal to fix the raw-body
  capture, not the tests.
- Out of scope (confirmed untouched by every test above): `commentOnIssue` / status write-back
  (issue #14), REST `submit_pr`, a seventh task status, audit-log UI (#15), claim-confirmation
  (#16), DESIGN.md contract edits.
