# doc-updater — issue #13 (webhook receivers + configurable polling fallback)

## Role

Kaola role **doc-updater** (standard / sonnet tier). Doc writes only, in the worktree
`/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13` (branch `workflow/issue-13`), on top
of the implementation + R1 security fix already landed there (uncommitted). No production or test
file was read for the purpose of editing it, and none was edited — `git status --short` before and
after this pass differs only in `README.md`, `CHANGELOG.md`, `docs/api.md`, `docs/architecture.md`,
`CLAUDE.md`. `docs/DESIGN.md` was not touched (no contract rewrite).

## Ground truth actually read before writing

- `packages/forge-adapters/src/index.ts` (current, post-R1) — `ForgeEvent`, `WebhookSignatureError`,
  `CreateForgeAdapterOptions.webhookSecret`, `parseWebhook`, `registerWebhook`, `commentOnIssue`
  still `notImplemented`.
- `apps/server/src/webhook.ts` (current, post-R1) — `registerWebhooks`, `findPendingReviewMatch`
  bound to the signature-verified `instance` via `taskMatchesForgeInstance` before comparing
  `pr_url` (the R1 fix).
- `apps/server/src/poller.ts` (current, post-R1) — `ForgeInstanceConfig`, exported
  `taskMatchesForgeInstance`, `isWebhookManaged`, exported `applyPrTerminalTransition`, exported
  `latestSubmission`, `pollPendingReviews(db, forgeInstances?)`.
- `apps/server/src/app.ts`, `apps/server/src/index.ts` — `buildApp({ forgeInstances? })` wiring,
  `readForgeInstances()` (`FORGE_INSTANCES` env parsing).
- `package.json` — the actual `test` script string (transcribed verbatim into README/CLAUDE.md,
  not retyped from memory).
- `packages/forge-adapters/src/webhook.shared.test.ts`, `apps/server/src/webhook.test.ts`,
  `apps/server/src/poller.test.ts` — read in full (or by targeted grep for `test(`/`it(` names) to
  confirm behavior described in docs matches actual assertions, not the ticket prose. Test-name
  grep: `webhook.test.ts` has 11 `test(` cases (404 unknown instance, 401 wrong secret, 401 missing
  signature header, ping→204, merge→204+已完成, closed→204+已退回, no-match pr_url→204, poll-mode
  instance still completes via webhook, no session/Bearer required or accepted, cross-forge
  dispatch, confused-deputy R1 regression case); `poller.test.ts` has 4 `test(` cases naming
  `forgeInstance`/`syncMode`/`webhook`/`skip` (webhook-mode skip with zero fetches, poll-mode
  instance still polled, empty array same as omitted, plus the pre-existing fetch-failure
  resilience case, unchanged).
- Cache files from earlier missions in this run (`ground-truth.md`, `forge-webhook-apis.md`,
  `orchestrator-rulings.md`, `impl-webhook.md`, `impl-r1.md`, `sec-review.md`, `sec-rereview.md`)
  — read for narrative/history context, but every field name, status code, header name, and event
  shape written into the docs was cross-checked against the source files above, not copied from
  the cache prose. Two corrections from the ruling/handoff prose vs. actual code: GitLab's
  scheme is a plaintext `X-Gitlab-Token` compare (not HMAC) — confirmed directly in
  `verifyGitlabToken`; Gitea's `registerWebhook` path segments are individually
  `encodeURIComponent`-ed post-R1 (the R2 fix), confirmed in the current `index.ts`.
- `scripts/` and `docs/` directory listings — confirmed no `scripts/codemaps/` and no
  `docs/CODEMAPS/` exist; did not invent either.

## Verification gates run in-session (not skipped)

Ran in the worktree, in this order, before writing any doc changes (to know the true baseline) and
again after (to confirm the doc-only edits didn't disturb anything — markdown is not linted/typed):

```
CI=true pnpm lint        → exit 0 (eslint . reports nothing)
CI=true pnpm typecheck   → exit 0 (apps/web, packages/forge-adapters, packages/shared, apps/server all "Done")
CI=true pnpm test        → exit 0
  node --test: ℹ tests 445  ℹ suites 89  ℹ pass 445  ℹ fail 0
  vitest: Test Files 2 passed (2); Tests 51 passed (51)
CI=true pnpm build       → exit 0 (tsc --noEmit across packages; apps/web vite build 2565 modules,
                            dist/assets/index-MeXOcpNK.js 1,465.50 kB │ gzip: 406.21 kB, chunk-size
                            warning only)
```

Re-ran `CI=true pnpm lint` a second time after all doc edits landed — still exit 0. Did not re-run
the full `test`/`typecheck`/`build` a second time after doc-only edits since no `.ts`/`.vue`/config
file was touched (`git status --short` confirms only the five doc files changed); this is stated
as a skip-with-reason, not a fabricated re-run.

This 445/445 + 51/51 figure supersedes the two numbers mentioned in the mission list narrative
(444 baseline pre-implementation, "444 then 445 after R1 test" from an earlier orchestrator run) —
it is the number from the run I actually executed, on the current worktree HEAD state, and is what
got written into CHANGELOG.md/README's "Measured" note pattern (matching #9–#12's own precedent of
recording the exact measured run).

## Files changed

- `README.md` — status line (M2 now includes #13; #14 status-write-back explicitly not claimed
  done); 核心特性 intro + bullet header (added #13); new bullet for #13 (registerWebhook/parseWebhook
  signatures, ForgeEvent shape, WebhookSignatureError, per-forge signature schemes, `POST
  /api/v1/webhooks/:publicId` behavior including the R1 instance-bind, `buildApp({ forgeInstances })`
  shape, `FORGE_INSTANCES` env contract); "设计中、尚未实现" section narrowed to just 状态回写源 Issue
  (`commentOnIssue`, #14); mermaid-flow follow-up paragraph (both webhook and 轮询 now landed);
  快速开始 env var paragraph (added `FORGE_INSTANCES`); 项目结构 tree comments (webhook.ts,
  registerWebhook/parseWebhook); `@kaola/forge-adapters` detail paragraph (webhookSecret option,
  WebhookSignatureError export, ForgeEvent shape, parseWebhook/registerWebhook per-forge mechanics,
  commentOnIssue still not implemented); 开发 pnpm test command (added `webhook.shared.test.ts` and
  `webhook.test.ts` at the exact positions `package.json`'s script uses); 路线图 closing paragraph
  (added #13 to the landed list, #14 to the not-landed list).
- `CHANGELOG.md` — two new Unreleased bullets prepended (before the #12 bullets, after the header,
  matching the file's newest-first convention): one for `@kaola/forge-adapters` (#13) transcribing
  the real `ForgeEvent`/`WebhookSignatureError`/`CreateForgeAdapterOptions.webhookSecret` shapes,
  the real per-forge signature-check code paths, the real event-mapping field paths, the real
  `registerWebhook` request bodies/URLs per forge (including the R2 Gitea encoding fix), and the
  real shared-spec file name/parameterization; one for `@kaola/server` (#13) transcribing the real
  `POST /api/v1/webhooks/:publicId` behavior (404/401/204, raw-body content-type-parser scoping,
  the R1 instance-bind before `pr_url` matching, `applyPrTerminalTransition` extraction,
  `ForgeInstanceConfig`, `taskMatchesForgeInstance`, `pollPendingReviews`'s new skip parameter,
  `buildApp({ forgeInstances })`, `index.ts`'s `readForgeInstances()`, the real new/changed test
  file names and counts, and the security-review R1/R2 findings + their fixes) ending with the
  measured gate numbers from this session.
- `CLAUDE.md` — Project Snapshot bullet rewritten to include `registerWebhook`/`parseWebhook`
  implemented, `ForgeEvent`'s concrete shape, `WebhookSignatureError`, `webhookSecret` option, the
  webhook HTTP route contract, `buildApp({ forgeInstances? })`, the poller's skip logic, and the
  `FORGE_INSTANCES` env contract; Commands → Test line (added `webhook.shared.test.ts` and
  `webhook.test.ts` at the positions matching the real `package.json` script, verified by direct
  comparison, not retyped from memory); Commands → Dev server line (added `forgeInstances` to the
  `buildApp` options list and described the env parsing); Project Conventions → token-hygiene
  bullet (added a sentence stating the webhook route is not a third reveal channel). File stayed at
  124 lines, under the 200-line recommendation.
- `docs/api.md` — top summary paragraph (both drivers of `待验收` exit now named, `commentOnIssue`
  still not implemented called out); `buildApp` options + sources list (added `webhook.ts`,
  `forgeInstances?`); PR-polling section rewritten to name the skip logic and the extracted
  `applyPrTerminalTransition`, and its closing sentence changed from "the only thing" to naming
  both drivers; new `### POST /api/v1/webhooks/:publicId` section (full contract: auth model,
  raw-body parser scoping, 404/401/204 paths, the R1 instance-bind, the shared transaction helper,
  the "not a third reveal channel" statement, the poll-mode-still-completes note); `events` table
  row for the transition event renamed to `applyPrTerminalTransition` and credited to both callers;
  `@kaola/forge-adapters` section rewritten (new package export `WebhookSignatureError`, adapter
  method list, `CreateForgeAdapterOptions.webhookSecret`, `ForgeEvent`'s concrete shape,
  `commentOnIssue` still-not-implemented framing) plus a new `### parseWebhook(...) and
  registerWebhook(...)` subsection transcribing the real per-forge signature headers/formulas,
  event-field paths, and `registerWebhook` request shapes per forge (verified against
  `packages/forge-adapters/src/index.ts`, not the ticket prose).
- `docs/architecture.md` — ASCII component map (added the `POST /api/v1/webhooks/:publicId` row,
  updated the poller row to mention the skip, added a no-webhook-UI note under `@kaola/web`,
  updated the forge-adapters row, replaced the closing `poller` row with a `poller + webhook` row
  naming the shared helper and the still-not-implemented `commentOnIssue`); `buildApp` intro
  sentence and options-behavior paragraph (added `forgeInstances`, `readForgeInstances()`); the
  route-registration-order sentence (added `registerWebhooks`); the poller paragraph (rewritten to
  name the skip logic and the extracted `applyPrTerminalTransition`); a new paragraph for
  `webhook.ts` (auth model, raw-body parser scoping, the R1 instance-bind, the shared transaction
  helper, no-token-no-fetch statement); the `@kaola/forge-adapters` packages-section paragraph
  (rewritten with the same real per-forge mechanics as `api.md`, at a shorter grain appropriate to
  this file's summary style).

## What was deliberately not done

- `scripts/codemaps/` and `docs/CODEMAPS/` were confirmed absent (`ls scripts/`, `ls docs/`) and
  were not created or referenced.
- `docs/DESIGN.md` was read for cross-reference (§8/§11/§14 already describe the intent) but not
  edited — no contract rewrite as a side effect of this docking pass.
- No claim that #14 (`commentOnIssue` / status write-back to the source Issue) is done anywhere —
  every doc file that touches the M2 milestone explicitly still lists #14 as not implemented.
- `apps/web` was not touched and no doc claims a webhook/forge-instance UI exists — there is none
  in the diff (`git diff --stat -- apps/web` was empty before this pass).
- No new database table was described anywhere — `forgeInstances` is documented consistently as
  process config (`buildApp` option / `FORGE_INSTANCES` env), matching the orchestrator ruling and
  the actual `schema.ts`/`db.ts` diff (empty).
