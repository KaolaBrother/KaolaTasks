# doc-updater — issue #11 (PR polling)

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11` (branch `workflow/issue-11`). All doc writes made there. `docs/DESIGN.md` was not touched (verified: `git diff --name-only -- docs/DESIGN.md` produced no output).

## Files edited

- `README.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `docs/api.md`
- `docs/architecture.md`

## Ground truth read before writing (source → claim)

### `packages/forge-adapters/src/index.ts` (git diff)

- `export type PrStatus = { state: 'open' | 'merged' | 'closed' }` (was `unknown`) → docs updated to say `PrStatus` is no longer `unknown`, only `PrStatus` changed (`ImportedIssue`/`ForgeEvent`/`IssueRef` left `unknown` per instructions).
- `getPullRequest: (cred, prUrl) => getPullRequest(kind, options, cred, prUrl)` replacing `notImplemented` in the returned `ForgeAdapter`.
- `parseGithubPrUrl` → `/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/u`; `parseGiteaPrUrl` → `/^\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/u`; `parseGitlabMrUrl` → `/^\/(.+)\/-\/merge_requests\/(\d+)$/u`.
- `stripPrUrlSuffix`: strips trailing `/` then trailing `.diff`/`.patch`.
- `prApiOrigin`: `kind === 'github'` → `GITHUB_API_ORIGIN`; else `options?.baseUrl ?? ''` (trailing slash stripped) — i.e. GitLab/Gitea use the adapter's own `baseUrl`, never the prUrl host.
- `prApiUrl`: GitHub `${origin}/repos/{owner}/{repo}/pulls/{number}`; GitLab `${origin}/api/v4/projects/{encodeURIComponent(namespace)}/merge_requests/{iid}`; Gitea `${origin}/api/v1/repos/{owner}/{repo}/pulls/{number}`. Unparseable URL → `throw new Error('unparseable … pull/merge request URL: …')` before any fetch.
- `derivePrState`: GitLab `state === 'merged'` → `merged`; `state === 'closed'` → `closed`; else (comment: `'opened'` and transient `'locked'`) → `open`. Non-GitLab: `obj?.merged === true` → `merged`; else `obj?.state === 'closed'` → `closed`; else `open`.
- `getPullRequest` (private fn): `forgeGet(kind, url, cred.token)`; `!res.ok` → `throw new Error('getPullRequest: ${kind} responded ${res.status}')`; else `{ state: derivePrState(kind, body) }`.
- Confirmed against `packages/forge-adapters/src/get-pull-request.shared.test.ts` (13 `it(` blocks, counted via `grep -c "it("`): exercises exactly the URL shapes, API-origin rules, and state mappings above for all three kinds, plus GitHub `.diff`/`.patch` stripping, GitHub always-`api.github.com`-even-with-custom-baseUrl, GitLab subgroup-namespace single-segment encoding, and unparseable-URL-never-calls-fetch.

### `apps/server/src/poller.ts` (new file, read in full)

- `PENDING_REVIEW_STATUS = '待验收'`; `STATUS_TRANSITION_EVENT = '状态迁移'`.
- `latestSubmission(db, taskId)`: `select().from(submissions).where(eq(submissions.taskId, taskId)).orderBy(desc(submissions.id)).limit(1).get()`.
- `decryptTaskToken`: same profile/inline branch as `claimTask`; any failure (vault unconfigured, missing profile, corrupt ciphertext) → `undefined`, caught with try/catch, never throws.
- `fetchPrStatus`: `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl }).getPullRequest({ token }, prUrl)`; any throw → `undefined`.
- `pollOneTask`: no submission → return. `status == null || status.state === 'open'` → return (task stays `待验收`, `pr_state` stays `'open'`). Else: `to = transitionTaskStatus(from, toChinese)` where `toChinese` is `'已完成'` for `merged`, else `'已退回'`; `prState` is `'merged'`/`'closed'` matching. `db.transaction`: `tasks.status = to`; `submissions.prState = prState`; `insertAuditEvent(tx, { type: STATUS_TRANSITION_EVENT, actorUserId: null, details: { task_id: task.publicId, from, to, pr_url: submission.prUrl } })`.
- `pollPendingReviews(db)`: selects `tasks` where `status === PENDING_REVIEW_STATUS`; select failure → return (no throw). Loop calls `pollOneTask` per row inside its own try/catch so one failing row never aborts the rest. Comment explicitly states it must never reject because it drives a `setInterval`.
- Confirmed against `apps/server/src/poller.test.ts` (11 `test(` blocks, counted via `grep -c "test("`): merged→已完成/pr_state merged/event shape exact `{task_id,from,to,pr_url}` with `actor_user_id null`; closed→已退回/pr_state closed; open→unchanged/no event; scope test (待认领/进行中/已完成/已取消/已退回 never fetched, never mutated); resilience test (one unreachable PR skipped, sibling still completes, `pollPendingReviews` never rejects); reopen test (poller-driven 已退回 → poster PATCH → 待认领 still works, prior events + submissions row survive unmodified); `buildApp({ pollIntervalMs })` frequency contract (omitted/0 → no `setInterval` call; positive → exactly one `setInterval` call with that `ms`).

### `apps/server/src/app.ts` (git diff)

- New `pollIntervalMs?: number` option on `buildApp`.
- `if (pollIntervalMs != null && pollIntervalMs > 0)`: registers `app.register(async function pollerContext(child) { ... })` — a child plugin, with comment explaining Fastify runs child `onClose` before parent/root `onClose`, guaranteeing `clearInterval` fires before the root db-close hook regardless of registration order.
- Inside: `let polling = false`; `setInterval(() => { if (polling) return; polling = true; pollPendingReviews(db).catch(() => {}).finally(() => { polling = false }) }, pollIntervalMs)`; `child.addHook('onClose', () => { clearInterval(timer); polling = false })`.
- Registration point in source is after `registerMcp`'s import line and before the `webDist`/`viteDevTarget` hosting block — i.e. after all HTTP routes, before hosting.

### `apps/server/src/index.ts` (git diff)

- `const pollIntervalMs = process.env.POLL_INTERVAL_MS == null || process.env.POLL_INTERVAL_MS === '' ? 60000 : Number.parseInt(process.env.POLL_INTERVAL_MS, 10)` — passed into `buildApp({ ..., pollIntervalMs })`.

### `apps/server/src/vault.ts` (git diff)

- `insertAuditEvent`'s first parameter type changed from `AppDb` to a new structural `type AuditEventWriter = { insert: AppDb['insert'] }`, so a `db.transaction` handle (used by `poller.ts`) can be passed without being assignable to the full `AppDb` type. Comment in source explains why (`BetterSQLiteTransaction` shares `insert`'s type with `AppDb` but lacks `$client`).

### `package.json` (git diff)

- `test` script gains `packages/forge-adapters/src/get-pull-request.shared.test.ts` (after `validate-token.shared.test.ts`) and `apps/server/src/poller.test.ts` (after `mcp.test.ts`), before `&& pnpm --filter @kaola/web test`.

### `apps/server/src/schema.ts` (read, unchanged by this issue)

- `submissions` table: `prState: text('pr_state').notNull()` — no enum in Drizzle; `apps/server/src/claim.ts` `submitPr` inserts `prState: 'open'` on success (unchanged by #11; the poller only ever moves it forward to `merged`/`closed`).

## Commands run in the worktree (own measurement, not fabricated)

All run in `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11` with `CI=true`:

- `pnpm test` → exit 0. node `--test` tail: `ℹ tests 333`, `ℹ suites 70`, `ℹ pass 333`, `ℹ fail 0`. vitest: `Test Files  2 passed (2)`, `Tests  44 passed (44)`.
- `pnpm lint` → exit 0 (`eslint .`, no output).
- `pnpm typecheck` → exit 0 (`pnpm -r --if-present typecheck`; 4 of 5 workspace projects: `apps/web`, `packages/forge-adapters`, `packages/shared`, `apps/server` all "Done").
- `pnpm build` → exit 0. `apps/web build`: vite v7.3.6, `2565 modules transformed`, `dist/assets/index-DtOsy8G8.js  1,464.30 kB │ gzip: 406.06 kB` (chunk-size warning only; identical hash to the #10 CHANGELOG entry because `@kaola/web` was not touched by #11).

These numbers match what the orchestrator independently measured (333/0/70 node suites + vitest 44) and were re-derived here, not copied blind.

- `grep -c "test(" apps/server/src/poller.test.ts` → `11`.
- `grep -c "it(" packages/forge-adapters/src/get-pull-request.shared.test.ts` → `13` (this file uses `describe`/`it`, not `test(`, so the `test(` grep on it returned `0` first and was corrected to `it(`).

## What changed in each doc file (summary)

- **README.md**: status line + 已落地 heading now include `#11`; new bullet describing `pollPendingReviews`/`getPullRequest`/`buildApp({ pollIntervalMs })`/`POLL_INTERVAL_MS`; "设计中、尚未实现" trimmed to just webhook + 状态回写源 Issue (轮询 moved out of that list); sequence-diagram prose updated (轮询 done, webhook still pending); env var paragraph gains `POLL_INTERVAL_MS`; project-structure line for `apps/server` gains `+ poller`; forge-adapters paragraph updated for `PrStatus`/`getPullRequest` (leaving `ImportedIssue`/`ForgeEvent`/`IssueRef` as `unknown`, per instructions); dev test-command block and roadmap-closing sentence updated to include the two new test files / `#11`.
- **CHANGELOG.md**: two new `Unreleased` bullets inserted above the `#10` bullet — one for `@kaola/forge-adapters` (`getPullRequest`, `PrStatus`, URL parsing/state-derivation rules, shared spec file + `it(` count 13), one for `@kaola/server` (`pollPendingReviews`, transaction/event shape, resilience, `buildApp({ pollIntervalMs })`, `POLL_INTERVAL_MS` default `60000`, `insertAuditEvent`'s widened type, root test-script additions, and this session's own measured `pnpm lint`/`typecheck`/`test`/`build` output).
- **CLAUDE.md**: Project Snapshot sentence extended with the poller/`getPullRequest`/`pollIntervalMs`/`POLL_INTERVAL_MS` facts and a note that the poller decrypts but never HTTP-returns a token; Commands → Test list gains the two new test files; Commands → Dev server sentence gains `pollIntervalMs` in the `buildApp` option list and its `POLL_INTERVAL_MS` sourcing; Project Conventions token-reveal bullet now states the claim/MCP pair remain the *only* HTTP that returns a forge token, and that the poller never puts it on a response or in `events.details`. File is 124 lines (well under the 200-line recommendation).
- **docs/api.md**: intro paragraph notes the poller is not an HTTP route; sources list and `buildApp` signature gain `poller.ts`/`pollIntervalMs`; removed the stale "No PR polling." sentence after the MCP section and replaced it with a new "PR polling (`pollPendingReviews`, not an HTTP route)" section documenting the full selection/transition/event/transaction/error-handling/`buildApp({ pollIntervalMs })`/`POLL_INTERVAL_MS` contract; `submissions` table section notes the poller advances `pr_state` to `merged`/`closed`; `events` table list gains the poller's `状态迁移` row shape; `@kaola/forge-adapters` section updates the `PrStatus` placeholder line and adds a `getPullRequest` subsection with the parsing/origin/state-derivation/error rules.
- **docs/architecture.md**: ASCII data-flow block gains a `pollPendingReviews(db)` line (explicitly "not a route") and updates the vault-hooks comment and the `MCP`/new `poller` summary lines; `## Server` section's `index.ts`/`buildApp` sentences gain `pollIntervalMs`/`POLL_INTERVAL_MS`; new paragraph describing `poller.ts`'s contract and the `insertAuditEvent` structural-type change; `## Packages` `@kaola/forge-adapters` paragraph gains `getPullRequest`/`PrStatus` and the new shared spec file.

## Not done (explicitly out of scope per task)

- `docs/DESIGN.md` — not edited (confirmed no diff).
- No `scripts/codemaps/` or `docs/CODEMAPS/` — did not invent either; none exist in this repo.
- `ImportedIssue`, `ForgeEvent`, `IssueRef` left as `unknown` in all touched docs — only `PrStatus` was updated, per instructions.
