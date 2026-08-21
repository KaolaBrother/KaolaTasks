# Orchestrator rulings — issue #11

Evidence: `kaola-workflow/issue-11/.cache/ground-truth.md`, `kaola-workflow/issue-11/.cache/forge-pr-apis.md`. Issue #11 has no comments; the body is the scope. DESIGN.md §5 “验收不通过” and §8 webhook-conditional polling would misroute this slice — ignore those clauses.

## Scope

- Drive **待验收 → 已完成** when `getPullRequest` reports `merged`, **待验收 → 已退回** when it reports `closed` (unmerged).
- Poll **only** tasks with `status === '待验收'`. Frequency is configurable.
- Poster **已退回 → 待认领** already exists (`POSTER_TRANSITIONS` + PATCH). Do not reimplement it. The new suite must still prove reopen keeps history (events + submissions survive).
- **No** REST `submit_pr`. **No** webhook (`registerWebhook` / `parseWebhook`). **No** `importIssue`. **No** DESIGN.md contract edits. **No** `@kaola/shared` change (edges already legal).

## `PrStatus` and `getPullRequest`

Replace the `unknown` placeholder:

```ts
export type PrStatus = { state: 'open' | 'merged' | 'closed' }
```

Implement `getPullRequest(cred, prUrl)` for all three kinds, same HTTP style as `validateToken` (`forgeGet` / `apiUrl` / `authHeaders`, `globalThis.fetch`). Parse owner/repo/number (GitLab: namespace path + iid) **from `prUrl`**. Constructor `options.baseUrl` is the API origin for GitLab/Gitea (GitHub stays `https://api.github.com`).

URL parsing:

- Strip trailing slash and a trailing `.diff` / `.patch`.
- GitHub web: `/{owner}/{repo}/pull/{n}` (singular). API: `GET /repos/{owner}/{repo}/pulls/{n}`.
- GitLab web: `{namespace...}/-/merge_requests/{iid}` (namespace may contain slashes). API: `GET /projects/{encodeURIComponent(namespace/project)}/merge_requests/{iid}`.
- Gitea web/API: `/{owner}/{repo}/pulls/{n}`.

Status derivation (verified vendor fields, 2026-08-21):

- GitHub / Gitea: `merged === true` → `merged`; else `state === 'closed'` → `closed`; else `open`.
- GitLab: `state === 'merged'` → `merged`; `state === 'closed'` → `closed`; `opened` **and `locked`** → `open` (`locked` is transient en route to merged — do not complete or reject the task).

Non-OK HTTP or unparseable URL: throw (poller catches; see below). Do not introduce a new HTTP client.

Shared spec file: `packages/forge-adapters/src/get-pull-request.shared.test.ts`, parameterized over `github` / `gitlab` / `gitea`, same fetch-stub shape as `validate-token.shared.test.ts`. Assert request URL, auth headers, and the three terminal mappings (+ GitLab `locked` → `open`).

## Poller

Export **`pollPendingReviews(db)`** (name may match this) from a new server module so tests call it without sleeping. It is the only driver of 待验收→已完成/已退回.

Per 待验收 row:

1. Load the latest `submissions` row (highest `id`). Skip if none.
2. Decrypt credential the same way as `claimTask` (profile XOR inline). On `VaultUnconfiguredError` or decrypt failure: skip that row, do not throw out of the loop.
3. `createForgeAdapter(task.repo_forge, { baseUrl: task.repo_base_url })` then `getPullRequest({ token }, submission.prUrl)`.
4. `open` → leave status; `pr_state` may stay `'open'`.
5. `merged` → `transitionTaskStatus('待验收','已完成')`, set `submissions.pr_state` `'merged'`, insert `状态迁移` with **`actorUserId: null`** (same as `sweepExpiredLeases`), `details: { task_id: publicId, from: '待验收', to: '已完成', pr_url }`.
6. `closed` → same with `'已退回'` / `pr_state` `'closed'`.
7. Adapter/fetch throw → skip that row; continue other 待验收 tasks.
8. Never resurrect a lease. Never put plaintext token in `events.details` or any HTTP body. Session GET list/get still never contain token.

Do not scan 待认领 / 进行中 / 已完成 / 已取消 / 已退回.

## Frequency

`buildApp({ pollIntervalMs?: number })`. Omitted or `<= 0` → **no timer** (existing tests that call `buildApp()` must not grow a live interval). Positive → `setInterval(() => { void pollPendingReviews(db) }, pollIntervalMs)` and `clearInterval` in `onClose` (child hooks run before root db-close — register the timer cleanup so it runs before sqlite close).

Production `apps/server/src/index.ts`: read `POLL_INTERVAL_MS` as milliseconds; empty/unset → **60000**; pass through to `buildApp`. No new npm dependency. No `fastify-plugin`.

## Reopen / history

Do not change PATCH. After a real poller-driven 已退回, poster `PATCH` `{ status: '待认领' }` must succeed and prior events + the submissions row must still be present.

## Tests

- New files only (do not weaken existing suites). Append them to root `package.json` `"test"`.
- Adapter: `packages/forge-adapters/src/get-pull-request.shared.test.ts`.
- Server: `apps/server/src/poller.test.ts`. Copy seams from `mcp.test.ts` / `claim.test.ts`; do **not** import other test files. `{ concurrency: false }`. Stub `globalThis.fetch` (environment), do not stub `pollPendingReviews` or `buildApp`. Drive MCP `submit_pr` then `pollPendingReviews`.
- Pin: merged → 已完成; closed → 已退回; open stays 待验收; non-待验收 never fetched; skip-on-error does not block a sibling 待验收 task; poster reopen after closed keeps events/submissions; `pollIntervalMs` omitted/0 registers no interval; a positive `pollIntervalMs` registers `setInterval` with that delay; token absent from events and HTTP.
- Fail on current HEAD before any production change. Record the RED baseline.

## Out of scope

Webhook, import, REST `submit_pr`, claim-confirmation, DESIGN.md edits, shared package transition table, audit-log UI.
