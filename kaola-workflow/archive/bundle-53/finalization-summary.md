# Finalization Summary — bundle-53 (Issue #53)

Branch `workflow/bundle-53`, candidate HEAD `4875bd7`, base `origin/main` `13ce1fb`. Sink: merge.

## Delivered

The in-Kaola review loop (DESIGN v0.6 §17): Draft PR delivery; two new canonical statuses `待修改` / `待合并` and a narrowed `已退回`; multi-round reviewer discussion with 提交本轮意见 / 通过 / 撤回通过 / 终止本次交付; revision Claims on `待修改` handed back through `submit_revision` on the same PR; four new MCP tools (`submit_revision`, `get_review_feedback`, `post_discussion_message`, `open_review_round`) plus `report_progress` percent/phase and `submit_pr` head_sha/head_branch; six review REST routes; Draft → ready flip off the response path with retry; `GET /api/v1/stream` SSE with write points at every transition; `parent_task_id` dependent sub-tasks with claim/approve gates, derived stacked base branch, automatic restack after the parent merges, and parent-ended notices; ForgeAdapter `getPullRequest` head fields, `markPullRequestReady`, `commentOnPullRequest` with shared three-backend specs; additive SQLite migration; Chinese Web board columns, cards, review panel, sub-task picker, EventSource refresh; forge smoke walking the whole loop.

Commits on the branch: 38d5035 docs contract · a56398f shared/schema/migration · 2497051 review core + MCP + adapters + SSE + sub-tasks · 2481d25 web · 400bd78 fixture re-premise · 9fb9099 smoke record + script fix · e5ddc3d security hardenings · 4875bd7 code-review repairs.

## Files Changed

- CHANGELOG.md
- README.md
- apps/server/src/app.ts
- apps/server/src/claim-confirm.test.ts
- apps/server/src/claim-fencing.test.ts
- apps/server/src/claim.test.ts
- apps/server/src/claim.ts
- apps/server/src/db-migration.test.ts
- apps/server/src/db.ts
- apps/server/src/leases.ts
- apps/server/src/mcp.test.ts
- apps/server/src/mcp.ts
- apps/server/src/poller.test.ts
- apps/server/src/poller.ts
- apps/server/src/review.test.ts
- apps/server/src/review.ts
- apps/server/src/schema.ts
- apps/server/src/stream.test.ts
- apps/server/src/stream.ts
- apps/server/src/tasks.test.ts
- apps/server/src/tasks.ts
- apps/server/src/webhook.test.ts
- apps/server/src/webhook.ts
- apps/server/src/workflow-default.test.ts
- apps/server/src/writeback.test.ts
- apps/server/src/writeback.ts
- apps/web/src/App.board.test.ts
- apps/web/src/App.review.test.ts
- apps/web/src/App.vue
- apps/web/src/review-anchor.ts
- apps/web/src/theme.css
- docs/DESIGN.md
- docs/api.md
- docs/architecture.md
- docs/smoke-test.md
- package.json
- packages/forge-adapters/src/comment-on-pull-request.shared.test.ts
- packages/forge-adapters/src/get-pull-request.shared.test.ts
- packages/forge-adapters/src/index.ts
- packages/forge-adapters/src/mark-pull-request-ready.shared.test.ts
- packages/shared/src/index.test.ts
- packages/shared/src/index.ts
- scripts/forge-smoke.ts

## Test Coverage

- `packages/shared/src/index.test.ts` — all 64 (from, to) pairs of the eight statuses; brief `parent_task_id` / `review_round` / `draft`.
- `apps/server/src/db-migration.test.ts` — pre-#53 SQLite file opens with new columns/tables and keeps rows (`review_round` 0, `is_draft` 0, `head_sha` NULL, `parent_task_id` NULL); idempotent reopen.
- `apps/server/src/review.test.ts` (13 cases) — full multi-round loop through real HTTP + MCP with the ordered seven-edge 状态迁移 chain and needle scans for token/ciphertext; non-blocking round; release/expiry → `待修改`; withdraw/terminate/closed-PR/ignored-merge/backfill; REST gates (401/403/404/409/400); percent/phase; stale_claim paths; Draft→ready failure/retry/opt-in comment; sub-task gates, downstream round, restack, parent-ended notice; security caps + `待批准` gate; reopen after `已退回`; `head_branch` stacking without a fetch; sibling Claims; stale Claim with new head.
- `apps/server/src/stream.test.ts` (8) — SSE auth, headers, frames, ping, shutdown, no dangling timer.
- `packages/forge-adapters/src/{get-pull-request,mark-pull-request-ready,comment-on-pull-request}.shared.test.ts` — 48 + 32 + 25 cases across github/gitlab/gitea stubs.
- Re-premised legacy suites (poller, webhook, writeback, claim-fencing, mcp, workflow-default) plus two new negative tests (merge while `待验收` is ignored by poller and webhook).
- `apps/web/src/App.review.test.ts` + extended `App.board.test.ts` — 163 web tests total.

## Validation

Frozen candidate `4875bd7` (tree hash `ba18a47562db358203c33cae4b570ae2987ccb092395c0d48965e54e1fbd0451`, `.cache/final-validation.md`, `verdict: pass`).

| leg | command | result |
|-----|---------|--------|
| automated | `pnpm lint` | exit 0 |
| automated | `pnpm typecheck` | 5/5 packages Done |
| automated | `pnpm test` | 1020/1020 node + 163/163 web |
| automated | `pnpm build` | 4/4 packages Done |
| local | secret scan of `origin/main...HEAD` product files | no tokens / keys / IPs / local paths |
| real forge | `pnpm smoke:forge -- gitlab` / `-- gitea` (PAT from the main-root gitignored `.env`, process env only; logs token-masked) | both exit 0: GitLab Issue #20 → MR !16 `已完成`; Gitea Issue #30 → PR #31 `已完成`; Draft → round → revision → approve (`draft=false`, head matches) → merge → `翻ready` 回写; token-free events. First attempts (Issue #19/!15, Issue #28/#29) stopped at `待修改` on a smoke-script bug, fixed in 9fb9099. |
| review | code-reviewer (`code-review.md`) | no blocker; 4 should-fix + 4 nits, all repaired in 4875bd7 with pinning tests |
| review | security-reviewer (`security-review.md`) | PASS; 3 low notes repaired in e5ddc3d |
| manual / UAT | browser review panel, SSE in a browser, wizard sub-task picker, GitHub Draft→ready on a live repo, human Merge click, STABLE_PUBLIC_CA | **not executed** (配合; recorded as such in `docs/smoke-test.md`) |

Issue statement walk (phases 0–7 acceptance + §6 总验收):
- Phase 0: DESIGN v0.6 header + summary; §5 diagram and edge table agree, `已退回` narrowing stated; every new tool/route has an api.md error-code entry — commit 38d5035 (+ 4875bd7 reconciliation).
- Phase 1: per-edge transition tests; legacy submissions keep defaults; typecheck — a56398f.
- Phase 2: full loop with events per step; no-blocking round; `pr_url_invalid` / `head_sha_unchanged` / idempotent; revision release/expiry → `待修改`; withdraw/terminate/closed-while-待合并; non-admin/full 403, no session 401; token scan — `review.test.ts`.
- Phase 3: MCP-only Agent side; `get_review_feedback` shape + `resolved`; `stale_claim`; percent 400 / omitted unchanged; serialized token scan — `review.test.ts`, `mcp.test.ts`, `workflow-default.test.ts`.
- Phase 4: shared specs for the three methods; GitHub GraphQL / GitLab-Gitea prefix; failure outcome + retry without rollback; #37 timeout; real GitLab/Gitea smoke recorded; GitHub + browser marked 配合 — adapter specs, `review.test.ts`, `docs/smoke-test.md`.
- Phase 5: `parent_not_ready`, stacked base branch, `parent_not_completed`, restack with `base_branch` = parent base, `open_review_round` (`downstream_finding`, 403), invalid parent 400/409, parent-returned notice — `review.test.ts`.
- Phase 6: `App.review.test.ts` panel/buttons/kinds/anchor parsing; board columns/progress/round; SSE update + reconnect; Chinese; lint — web suite.
- Phase 7: 401 gates; one `progress` frame without `note`; clean shutdown — `stream.test.ts`.
- §6: gates green; phases 0–7 items above; end-to-end demo on real forges done for the single-task loop by script (parent/child + browser SSE parts are 配合, not executed); repo scan clean; docs consistent.

## Changed Paths

As reported by `finalize --check` (`changed_paths`; docs and README/CHANGELOG changes are listed under Files Changed above):

- apps/server/src/app.ts
- apps/server/src/claim-confirm.test.ts
- apps/server/src/claim-fencing.test.ts
- apps/server/src/claim.test.ts
- apps/server/src/claim.ts
- apps/server/src/db-migration.test.ts
- apps/server/src/db.ts
- apps/server/src/leases.ts
- apps/server/src/mcp.test.ts
- apps/server/src/mcp.ts
- apps/server/src/poller.test.ts
- apps/server/src/poller.ts
- apps/server/src/review.test.ts
- apps/server/src/review.ts
- apps/server/src/schema.ts
- apps/server/src/stream.test.ts
- apps/server/src/stream.ts
- apps/server/src/tasks.test.ts
- apps/server/src/tasks.ts
- apps/server/src/webhook.test.ts
- apps/server/src/webhook.ts
- apps/server/src/workflow-default.test.ts
- apps/server/src/writeback.test.ts
- apps/server/src/writeback.ts
- apps/web/src/App.board.test.ts
- apps/web/src/App.review.test.ts
- apps/web/src/App.vue
- apps/web/src/review-anchor.ts
- apps/web/src/theme.css
- package.json
- packages/forge-adapters/src/comment-on-pull-request.shared.test.ts
- packages/forge-adapters/src/get-pull-request.shared.test.ts
- packages/forge-adapters/src/index.ts
- packages/forge-adapters/src/mark-pull-request-ready.shared.test.ts
- packages/shared/src/index.test.ts
- packages/shared/src/index.ts
- scripts/forge-smoke.ts

## Mission List

Nine missions, all `done`: Phase 0 contract; Phase 1 shared/storage; Phase 2 server review core; Phase 3 MCP tools; Phase 4 adapters + ready flip; Phase 5 sub-tasks/restack; Phase 7 SSE; Phase 6 Web; validation. Results are recorded immutably in `mission-list.md`.

## Documentation Docking

`.cache/doc-updater.md` and `.cache/doc-docking.md`: DOCKED (README, DESIGN, architecture, api, CHANGELOG, smoke-test updated; conventions / workflow-default / runner-carrier no impact).

## Run gaps

- manual:unverified-head-sha (submit_revision / submit_pr record the Agent-supplied head_sha; the poller backfills only when the stored value is null, so a push made after 交回 and before 「通过」 is not detected (security review residual, 4875bd7).): filed: #54
- manual:smoke-residue (first #53 smoke attempts left GitLab MR !15 (Issue #19) and Gitea PR #29 (Issue #28) open in 待修改 on the public smoke repos after a smoke-script rev-parse bug (fixed 9fb9099); the second attempts merged.): noise: residue on the dedicated public smoke repos from a script bug fixed in 9fb9099; the second attempts merged and are the recorded evidence

## Follow-Up Items

- #54 (P3): verify `head_sha` against the forge before 「通过」 or on each poll.
- Issue #53 phase 8 optional items remain optional and unfiled (parseWebhook non-terminal events, bridge receipts hint for `待修改`, `reviewers` field, one-click merge).
- Open question 3 of #53 resolved as: summary comment on approve is default-off, opt-in via `KAOLA_REVIEW_SUMMARY_COMMENT=1`.

## Final readiness

READY — all gates green at the frozen candidate, reviews reconciled, docs docked, real-forge smoke recorded, unexecuted UAT legs stated honestly. Closure decision: close #53 on merge.

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/bundle-53/.cache/doc-docking.md
- kaola-workflow/archive/bundle-53/.cache/doc-updater.md
- kaola-workflow/archive/bundle-53/.cache/final-validation.md
- kaola-workflow/archive/bundle-53/.cache/origin/selection-record.json
- kaola-workflow/archive/bundle-53/.cache/run-gaps-manual.md
- kaola-workflow/archive/bundle-53/.cache/run-gaps.json
- kaola-workflow/archive/bundle-53/code-review.md
- kaola-workflow/archive/bundle-53/finalization-summary.md
- kaola-workflow/archive/bundle-53/mission-list.md
- kaola-workflow/archive/bundle-53/security-review.md
- kaola-workflow/archive/bundle-53/workflow-state.md
