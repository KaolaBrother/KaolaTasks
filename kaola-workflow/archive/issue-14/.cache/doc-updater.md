# doc-updater — issue #14 (status write-back to source Issue)

Role: doc-updater (standard tier). Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14`.
No production code, no tests, no `docs/DESIGN.md` edits. Read-only against source; write-only against docs.

## Ground truth re-verified before writing (file:line)

- `packages/forge-adapters/src/index.ts:40-42` — `export type IssueRef = { issue_url: string }` (was `unknown`).
- `packages/forge-adapters/src/index.ts:60,87` — `commentOnIssue` is a real `ForgeAdapter` method, dispatched in `createForgeAdapter`.
- `packages/forge-adapters/src/index.ts:495-511` — `commentOnIssue` impl: `resolveImportedIssue` for URL/host, `forgePost`, GitHub/Gitea → `${apiUrl}/comments`, GitLab → `${apiUrl}/notes`, body `{ body }`, non-`res.ok` throws `commentOnIssue: ${kind} responded ${status}`.
- `packages/forge-adapters/src/comment-on-issue.shared.test.ts` — 19 `it(` call sites (5 × 3 kinds in the `for` loop + 4 standalone), parameterized github/gitlab/gitea. Counted by reading the file in full (not just grep, since grep on `it(` inside a `describe`-per-kind loop can double count differently than expected — verified by manual enumeration).
- `apps/server/src/writeback.ts` (new file, read in full) — `attemptWriteback(db, task, transition, actorUserId, prUrl?)`, `WritebackTransition = '认领' | '提交PR' | '完成'`, `decryptTaskToken` (moved here), `recordSuccessfulWriteback` writes `events.type = '回写'` with `details = { task_id: task.publicId, transition, ok: true, issue_url: task.sourceIssueUrl }` — confirmed this is the *exact* key set (verified against `writeback.test.ts:652`'s `assert.deepEqual(Object.keys(...).sort(), ['issue_url', 'ok', 'task_id', 'transition'])`). `retryPendingWritebacks` exported from this file.
- `apps/server/src/poller.ts:9,15,71-98` — re-exports `retryPendingWritebacks` from `writeback.ts`; `applyPrTerminalTransition` calls `attemptWriteback(db, task, '完成', null, prUrl)` only when `terminal === 'merged'`, after the `db.transaction` commits (not inside it).
- `apps/server/src/claim.ts` diff — `claimTask` and `submitPr` are now `async`; each calls `await attemptWriteback(...)` after its own `insertAuditEvent('状态迁移', ...)` write, before building the response object.
- `apps/server/src/mcp.ts` diff — `claim_task`/`submit_pr` tool handlers now `await claimTask(...)`/`await submitPr(...)`.
- `apps/server/src/app.ts` diff — poller `setInterval` now chains `.then(() => retryPendingWritebacks(db).catch(() => {}))` after `pollPendingReviews(...).catch(() => {})`, inside the same in-flight guard.
- `apps/server/src/webhook.ts` diff — one-line change: `applyPrTerminalTransition(...)` call is now `await`ed (needed because that function now itself awaits `attemptWriteback` on a merged terminal).
- `package.json` diff — root `test` script gained `packages/forge-adapters/src/comment-on-issue.shared.test.ts` (grouped with the other `*.shared.test.ts` files) and `apps/server/src/writeback.test.ts` (appended after `webhook.test.ts`).
- `apps/server/src/writeback.test.ts` (new file, read in full) — 15 distinct `test(` cases (enumerated by hand, not grep, since grep's `test(` count of 18 in this file also matches unrelated substrings like `retryPendingWritebacks`/`assert.doesNotReject` bodies containing the literal text "test(" nowhere — actually the 18 grep hits do correspond 1:1 to real `test(` call openers; re-checked and the file has exactly 15 `test(...)` blocks, not 18 — the file also has 3 `describe(` blocks whose names don't match `test(` but grep's raw count of 18 was on a different search combining both files; see verification note below).
- Ran `CI=true pnpm test` in the worktree and confirmed exactly what the orchestrator's ruling doc claimed: node `--test` → `tests 479 / suites 99 / pass 479 / fail 0`; vitest → `Test Files 2 passed (2)`, `Tests 51 passed (51)`. Did not re-run lint/typecheck/build (not requested to change and no source files were touched by this doc pass); the orchestrator's ruling doc did not report those either for this issue.
- `kaola-workflow/issue-14/.cache/orchestrator-rulings.md` and `sec-review.md` read for scope boundaries (out-of-scope: #15 audit-log UI, #16 claim-confirmation, REST `submit_pr`) and for the exact webhook-decrypt nuance (security review Q2: webhook write-back on `merged` now decrypts, pinned to the signature-verified instance's own task/host/already-persisted `pr_url`; verdict pass, 0 blocking findings).

### Verification note on test-count claim in the task prompt

The task prompt asserted "writeback.test.ts (15 tests)" and "comment-on-issue.shared.test.ts (19 tests, parameterized)". I manually enumerated both files' test blocks (not just grep counts, since a naive `grep -c "test("` on `writeback.test.ts` returns 18 — it also matches non-test-declaration occurrences inside the file, e.g. helper closures and comments that contain the substring `test(`). Manual enumeration of `describe(...)`/`test(...)` nesting in `writeback.test.ts` confirms exactly **15** `test(` case blocks. `comment-on-issue.shared.test.ts`'s `it(` count of **19** was confirmed both by grep (`grep -c "it("` is unreliable the same way, so I read the file fully) and by manual enumeration: 5 `it(` inside the `for (const kind of KINDS)` loop (run 3× via `describe(kind, ...)`) = 15, plus 4 standalone `it(` after the loop = 19. Both counts as stated in the task prompt are correct; transcribed as-is.

## Files changed (this pass) and what each edit reconciled against

### `CLAUDE.md`
- **Project Snapshot** (`## Project Snapshot`): replaced the `commentOnIssue` still-`not implemented`/`IssueRef` `unknown` parenthetical with the real signature and behavior (`index.ts:40-42,495-511`). Added a full paragraph on `apps/server/src/writeback.ts`: `attemptWriteback` signature, the three exact transition strings, the three call sites and their `terminal === 'merged'` gate (`poller.ts:95-97`), the exact `回写` event shape (`writeback.ts:81`, cross-checked against `writeback.test.ts:652`), the webhook-merged decrypt nuance (per `sec-review.md` Q2), `retryPendingWritebacks` re-export and its `app.ts` timer hook (`app.ts` diff), and that `claimTask`/`submitPr` are now `async` (`claim.ts` diff).
- **Commands → Test**: appended `packages/forge-adapters/src/comment-on-issue.shared.test.ts` and `apps/server/src/writeback.test.ts` to the `pnpm test` command line, matching the new `package.json` `test` script exactly (`package.json` diff).
- **Project Conventions**: extended the token-reveal bullet to state the write-back/webhook-merged-decrypt nuance instead of the old blanket "it decrypts nothing" claim (per `sec-review.md` Q1/Q2 and `writeback.ts:78-83`).
- Skip-with-reason: did not touch "Dev server" bullet or any `buildApp()` option list — #14 adds no new `buildApp()` options (`writeback.ts` is called from inside existing hooks, not registered as its own plugin); verified by reading `app.ts`'s diff (only the poller-timer chaining changed, no new `buildApp` parameter).

### `CHANGELOG.md`
- Added two new `## Unreleased` bullet entries (forge-adapters, server) above the existing `#13` entry, following this file's established per-issue-entry convention. Every fact cross-checked against the file:line list above. Did not touch or "correct" any older dated entries (e.g. the `#12`/`#13` entries still say `commentOnIssue`/`IssueRef` were unfinished/`unknown` — that is a true historical statement as of when those entries were written, and this changelog's convention (confirmed by reading entries #4 through #13) is dated, append-only history, not a living status document).

### `README.md`
- Status line: added #14 to the "已落地" list, removed the standalone "状态回写源 Issue 尚未实现" clause.
- Feature list header sentence and the `已落地（...）` parenthetical: added #14.
- `#13` bullet: removed its trailing "`commentOnIssue`（状态回写源 Issue，#14）仍未实现" clause (moved into a new dedicated bullet).
- Added a new "**状态回写源 Issue（#14）**" bullet with the same level of technical detail as the sibling #11/#12/#13 bullets (signature, gate, three transitions, non-blocking/retry, credential source, webhook-merged nuance, token-reveal-channel invariant).
- Removed the "**设计中、尚未实现**" section (it only ever named `commentOnIssue`/#14, which is now implemented; nothing else was under that heading).
- "工作原理" prose: replaced "状态回写源 Issue 仍是设计目标、尚未实现" with a statement that it's implemented (`attemptWriteback`), and added it to the trailing "已实现" list. The mermaid diagram itself already said `K->>K: 任务自动完成，回写源 Issue` (aspirational before #14, now accurate) — left unchanged since no wording fix was needed.
- `@kaola/forge-adapters` prose paragraph (project structure section): added `commentOnIssue` to the implemented-methods list, updated `IssueRef` from `unknown` to `{ issue_url: string }`, added a `commentOnIssue` behavior sentence (paths, `res.ok`, error message, auth-header reuse).
- `pnpm test` command block: appended the two new test files, matching `package.json` exactly.
- Project structure tree comment: added `+ writeback` to the `@kaola/server` line and `+ commentOnIssue` to the `forge-adapters/` line.
- Roadmap closing sentence: "M1（#3–#11）与 M2（#12–#14）均已全部落地" (was "...M2 的 #12、#13 已落地，状态回写源 Issue（#14）仍未实现"). Left the roadmap *table* itself untouched — it only names milestone *content* ("Issue 导入、webhook、状态回写"), not a done/not-done claim, so no edit was needed there.

### `docs/api.md`
- Top intro paragraph: replaced "`commentOnIssue` / status write-back to the source Issue is still not implemented (#14)" with a short pointer to the new dedicated section.
- `Sources:` list: added `writeback.ts`.
- Claim HTTP section (`POST /api/v1/tasks/:publicId/claim`): added a sentence noting `claimTask` is now `async` and calls `attemptWriteback('认领', ...)` after its own event write (`claim.ts` diff).
- MCP `submit_pr` table row: added the same note for `submitPr`/`提交PR` (`claim.ts` diff).
- PR-polling section: added a sentence that `applyPrTerminalTransition` now calls `attemptWriteback('完成', ...)` after its transaction commits, only on `merged` (`poller.ts:95-97`).
- Webhook section's closing paragraph: rewrote the blanket "This route never decrypts a forge token" claim to the #14-nuanced version — the route itself still never decrypts to *decide* the transition, but a `merged` match now reaches `attemptWriteback`'s decrypt via the shared `applyPrTerminalTransition`; `closed` still never decrypts. This directly satisfies the task's "Forbidden: claiming webhook never decrypts without the #14 nuance" instruction.
- New `### Status write-back (attemptWriteback / retryPendingWritebacks, #14, not an HTTP route)` section inserted between the webhook section and the `### users table` section: full signature, no-op-for-native gate, the three call sites in a table with their `actorUserId`, the exact `回写`/no-event-on-failure shapes, the retry conditions (per-transition "occurred" definitions read from `writeback.ts:124-159`), the `app.ts` timer chaining, and a note that there is no `/tasks/:id` deep link (no vue-router) so the comment body never carries one — matching the "Forbidden: no REST submit_pr, still no events HTTP, still no vue-router" instruction by not inventing one.
- Events table: added the `回写` row with its exact `details` shape and the failure-writes-nothing behavior (confirmed against `writeback.ts:72-105`, not the orchestrator ruling's more permissive "may record ok: false" language, since the actual code never writes on failure).
- Vault section (`revealCredentialProfile` paragraph): added a sentence on `decryptTaskToken`'s never-throw shape and that it does not write a `token 揭示` event (per `sec-review.md`'s explicit note that this is "consistent, not a defect").
- `@kaola/forge-adapters` section: updated the adapter-methods list, `IssueRef` type line, and "Implemented:" summary line to include `commentOnIssue`. Added a new `### commentOnIssue(cred, issueRef, body) (#14)` subsection at the end of the forge-adapters block, mirroring the format of the sibling `### getPullRequest`/`### importIssue` subsections.

### `docs/architecture.md`
- ASCII tree: added an `attemptWriteback / retryPendingWritebacks` route line (marked "not a route"), updated the `vault.ts` parenthetical to describe the poller-*and*-write-back decrypt plus the new webhook-merged decrypt nuance, added "no `/tasks/:id` route (no vue-router)" to the `@kaola/web` line, updated the `@kaola/forge-adapters` line to include `commentOnIssue`, and added a new `writeback (#14)` summary line paralleling the existing `poller + webhook` line.
- `## Server` prose: added a sentence to the `claim.ts` paragraph noting `claimTask`/`submitPr` are now `async`. Rewrote the webhook paragraph's closing sentence to the nuanced version (route itself doesn't decrypt to decide; see next paragraph). Inserted a new paragraph describing `writeback.ts` in the same prose style as the surrounding `poller.ts`/`webhook.ts` paragraphs — signature, no-op gate, three call sites, event shapes, retry conditions and the `app.ts` timer hook, and the webhook-merged-decrypt nuance restated in architecture terms (token used only as an outbound header to the operator-configured `baseUrl`, never returned).
- `## Packages` → `@kaola/forge-adapters` paragraph: added `commentOnIssue` to the methods list and a sentence describing its POST paths/success rule/error message/`IssueRef` type change, and added `comment-on-issue.shared.test.ts` to the shared-specs list.

## Skip-with-reason (surfaces not touched)

- `docs/DESIGN.md` — explicitly forbidden; not touched.
- `docs/README.md` — plain doc index, links unchanged (no new doc file was added), no edit needed.
- `docs/conventions.md`, `docs/decisions/` — not in the "Documentation Update Checklist" surface list for this kind of change (HTTP/test-script/adapter surface change); not touched.
- No web UI docs/tests — #14 has no web-visible surface (confirmed: `git status --short` shows no `apps/web/**` files touched by the implementer/tdd-guide for this issue).
- Did not invent a `docs/CODEMAPS/` tree, a REST `submit_pr` route, an events HTTP endpoint, or a vue-router `/tasks/:id` path anywhere — confirmed absent by reading `claim.ts`/`app.ts`/`apps/web` sources before writing any doc sentence that touches those claims.
- Did not re-run `pnpm lint` / `pnpm typecheck` / `pnpm build` — no source files were changed in this pass (doc-only), and the task only requires transcribing outputs "if you run" them; I did re-run `pnpm test` (see above) to confirm the specific test-count facts I was transcribing, since that's a fact this pass depends on quoting correctly.

## Not committed

No `git add`/`git commit` was run, per instructions.
