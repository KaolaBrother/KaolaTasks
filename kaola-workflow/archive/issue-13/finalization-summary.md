# Finalization — Summary: issue-13

## Delivered
M2 slice for issue #13.

Three-forge `parseWebhook` verifies GitHub `X-Hub-Signature-256` (HMAC-SHA256, `sha256=` prefix), GitLab `X-Gitlab-Token` (timing-safe plaintext secret token, not `signing_token`), and Gitea `X-Gitea-Signature` (HMAC-SHA256 hex, no prefix) over the raw body, then maps terminal PR/MR events to `ForgeEvent` `{ type: 'pull_request', state: 'merged'|'closed', pr_url, repo: { full_name } }`. Bad/missing signature or missing `webhookSecret` throws `WebhookSignatureError`. Ping/irrelevant events return `null`. `registerWebhook` POSTs a hook on the same host rule as `getPullRequest` (GitHub always `api.github.com`; GitLab/Gitea constructor `baseUrl`). `POST /api/v1/webhooks/:publicId` is unauthenticated except the forge signature; 404 unknown instance, 401 bad signature, otherwise 204. Completes a `待验收` task through shared `applyPrTerminalTransition` without decrypting a token or calling `getPullRequest`, and only when the task's `(repoForge, repoBaseUrl)` matches the signature-verified instance (R1). `buildApp({ forgeInstances })` plus env `FORGE_INSTANCES` (JSON; unset/`''` → `[]`; invalid JSON fails boot) configures per-instance `syncMode` `webhook`|`poll`; webhook-mode instances are skipped by `pollPendingReviews`. No new table. `commentOnIssue` / write-back (#14) still `notImplemented`. `docs/DESIGN.md` untouched.

## Files Changed
Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13` on `workflow/issue-13`. Tests by tdd-guide; production by implementer; docs by doc-updater.

## Test Coverage
`packages/forge-adapters/src/webhook.shared.test.ts` (18 `it(` source lines, 34 runtime cases across three forges) and `apps/server/src/webhook.test.ts` (11 `test(`). Poller skip cases added to `apps/server/src/poller.test.ts` (13 `test(` total). Full `pnpm test`: node `--test` 445 pass / 0 fail, 89 suites; vitest 51 pass / 0 fail.

## Validation
verdict: pass
command: `CI=true pnpm lint && CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm build`
record: `kaola-workflow/issue-13/.cache/final-validation.md`
validated_candidate_hash: `5e9097deeee721d6afa54c18d088889a356c9d2c4e5072ce29a7a654bedf197c`
tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13` after docs landed.

## Changed Paths
- `packages/forge-adapters/src/index.ts`
- `packages/forge-adapters/src/webhook.shared.test.ts` (added)
- `apps/server/src/webhook.ts` (added)
- `apps/server/src/webhook.test.ts` (added)
- `apps/server/src/poller.ts`
- `apps/server/src/poller.test.ts`
- `apps/server/src/app.ts`
- `apps/server/src/index.ts`
- `package.json`
- `README.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `docs/api.md`
- `docs/architecture.md`

## Mission List
All items `done` in `kaola-workflow/issue-13/mission-list.md`.

## Documentation Docking
DOCKED (`kaola-workflow/issue-13/.cache/doc-docking.md`). DESIGN.md contracts untouched.

## Run gaps

## Follow-Up Items
Not filed (gap sweep `sweptClasses: []`).

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-13/.cache/doc-docking.md
- kaola-workflow/archive/issue-13/.cache/doc-updater.md
- kaola-workflow/archive/issue-13/.cache/final-validation.md
- kaola-workflow/archive/issue-13/.cache/forge-webhook-apis.md
- kaola-workflow/archive/issue-13/.cache/ground-truth.md
- kaola-workflow/archive/issue-13/.cache/impl-r1.md
- kaola-workflow/archive/issue-13/.cache/impl-webhook.md
- kaola-workflow/archive/issue-13/.cache/orchestrator-rulings.md
- kaola-workflow/archive/issue-13/.cache/origin/selection-record.json
- kaola-workflow/archive/issue-13/.cache/run-gaps.json
- kaola-workflow/archive/issue-13/.cache/sec-rereview.md
- kaola-workflow/archive/issue-13/.cache/sec-review.md
- kaola-workflow/archive/issue-13/.cache/tests-r1.md
- kaola-workflow/archive/issue-13/.cache/tests-webhook-baseline.txt
- kaola-workflow/archive/issue-13/.cache/tests-webhook-helper-fix.md
- kaola-workflow/archive/issue-13/.cache/tests-webhook.md
- kaola-workflow/archive/issue-13/finalization-summary.md
- kaola-workflow/archive/issue-13/mission-list.md
- kaola-workflow/archive/issue-13/workflow-state.md
