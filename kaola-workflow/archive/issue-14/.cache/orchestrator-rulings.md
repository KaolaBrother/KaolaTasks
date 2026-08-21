# Orchestrator rulings — issue #14

Recorded 2026-08-21 after `ground-truth.md` (worktree HEAD `a722c8b`) and `forge-comment-apis.md`. These pin the suite. Evidence: DESIGN.md §5 §8 §10; issue #14 body (no comments); measured claim/submit/complete paths; official forge comment APIs.

## Scope

In: adapter `commentOnIssue`; typed `IssueRef`; server write-back on 认领 / 提交 PR / 完成 for **imported** tasks; non-blocking failure; retry without a new queue table; `回写` audit events; task credential; 考拉任务链接 + PR 链接 (PR only once a PR exists).
Out: audit-log UI (#15). Claim-confirmation (#16). REST `submit_pr` (still MCP-only). Write-back on `release_task` or `已退回`. New job/queue table. DESIGN.md contract rewrite. Web UI / vue-router. Token in list/get/import/events/logs.

## 1. `IssueRef`

Replace the `unknown` placeholder. Fill the existing exported name (same move as `ForgeEvent` on #13):

```ts
export type IssueRef = {
  issue_url: string
}
```

Call site passes `{ issue_url: task.sourceIssueUrl }`. The adapter re-parses owner/repo/number or namespace/iid from `issue_url` the same way `resolveImportedIssue` already does — no extra GET, no persisted number/iid. Do not change DESIGN.md.

## 2. `commentOnIssue(cred, issueRef, body)` — keep DESIGN signature

Stop throwing `not implemented`. Dispatch per `kind` like the sibling methods. Reuse `forgePost` / `authHeaders` / `prApiOrigin`. JSON body is `{ body }` for all three forges (field name confirmed). Success: `res.ok` (GitHub/Gitea docs say 201; GitLab page has no status table — do not require a single code). Non-ok: throw `Error(\`commentOnIssue: ${kind} responded ${status}\`)` after one fetch — same pattern as `importIssue` / `registerWebhook`. Unparseable `issue_url`: throw (not the placeholder message).

Host rule unchanged: GitHub always `https://api.github.com`; GitLab/Gitea constructor `baseUrl`, **never** the pasted URL host (SSRF). Paths (origin + suffix):

| kind | POST path |
|---|---|
| github | `{api.github.com}/repos/{owner}/{repo}/issues/{n}/comments` |
| gitlab | `{baseUrl}/api/v4/projects/{encodeURIComponent(namespace)}/issues/{iid}/notes` |
| gitea | `{baseUrl}/api/v1/repos/{owner}/{repo}/issues/{n}/comments` |

Auth headers: existing `authHeaders` (GitHub Bearer, GitLab PRIVATE-TOKEN, Gitea `token`). No idempotency key (none documented). No new fetch wrapper.

## 3. Which tasks and which transitions

Gate: `task.sourceType === 'imported'` AND `task.sourceIssueUrl` non-empty. Native tasks: no forge comment call, no `回写` event.

Three transitions only:

| Transition | Hook (do not duplicate at route/MCP layer) | Comment must contain |
|---|---|---|
| 认领 | inside `claimTask` (covers REST + MCP) | task `publicId` and `PUBLIC_URL` (trim trailing slash; default `http://localhost:31415`, same as `auth.ts`) |
| 提交 PR | inside `submitPr` (MCP-only entry; no new REST route) | publicId, PUBLIC_URL, and the submitted `pr_url` |
| 完成 | inside `applyPrTerminalTransition` **only when `terminal === 'merged'`** (covers poller + webhook) | publicId, PUBLIC_URL, and that `pr_url` |

Do **not** write back on `terminal === 'closed'` (已退回) or on `releaseTask`.

Web has no vue-router / `/tasks/:id` route. Do not invent a deep-link path. The 考拉任务链接 is `PUBLIC_URL` plus the `publicId` appearing in the comment body (markdown ok).

## 4. Non-blocking + retry — no new table

A forge throw / decrypt miss / unparseable URL must **not** fail claim / submit_pr / complete. Catch at the write-back helper; never inside the SQLite transaction; never hold a DB write lock across HTTP.

No job queue, no new columns. Durable success marker is a `回写` event with `details.ok === true` for that `task_id` (public id) + `transition` (`认领` | `提交PR` | `完成`). Retry condition: imported task whose transition has occurred and which has no successful `回写` for it.

- 认领 occurred: a `状态迁移` to `进行中` exists (release back to 待认领 does not erase the need to post the claim comment).
- 提交PR occurred: a `submissions` row exists.
- 完成 occurred: status is `已完成` (or a `状态迁移` to `已完成`).

Inline: attempt write-back after the status transition is committed, at each of the three hooks.

Retry seam: export `retryPendingWritebacks(db: AppDb): Promise<void>` from `apps/server/src/poller.ts` (implementation may live in a sibling and be re-exported). The existing `setInterval` in `app.ts` must also invoke it (same tick as `pollPendingReviews`, same in-flight guard is fine). Tests call the export directly — do not wait on a timer.

A successful POST records `回写` `{ task_id, transition, ok: true, issue_url }` and is not retried. Failures may record `ok: false` (no token, no ciphertext). `actorUserId`: claim/submit use the acting user; complete / poller retry use `null`. Never put a forge token, secret, or ciphertext in `events.details`, logs, or HTTP bodies (claim `201` `token` remains the existing reveal exception).

Credential: task-attached only (profile or inline). Reuse `decryptTaskToken`'s never-throw shape for the write-back/retry path. Do not use the caller's Agent API key as a forge token.

## 5. Tests to author (custody)

- `packages/forge-adapters/src/comment-on-issue.shared.test.ts` — parameterized github/gitlab/gitea; POST URL/auth/JSON `{ body }`; host/SSRF; unparseable URL; non-ok throws with `commentOnIssue:` and `message !== 'not implemented'`. Copy fetch helpers; do not import sibling shared specs. Header comment must pin current HEAD stub behavior like webhook.shared.test.ts.
- `apps/server/src/writeback.test.ts` — real `buildApp` + mocked `fetch` (copy seams from `poller.test.ts` / `claim.test.ts`; do not import those files). Pin: imported claim/submit/complete each POST a comment; native claim does not; forge 5xx leaves claim/submit/complete successful; 已退回 does not comment; comment bodies contain publicId + PUBLIC_URL and pr_url on submit/complete; task credential is the Authorization/PRIVATE-TOKEN value; failed comment then `retryPendingWritebacks` posts it; events/responses contain no token. Drive 认领 via REST claim (covers the shared `claimTask`); 提交 PR via MCP `submit_pr`; 完成 via `pollPendingReviews` **and** one webhook merged delivery (both already share `applyPrTerminalTransition`).
- Root `package.json` `test` script: append the two new node:test paths explicitly (no glob), adapters file with the other `*.shared.test.ts`, `writeback.test.ts` after `webhook.test.ts`. Same one-line harness exemption as #11–#13.
- No web UI tests. No DESIGN.md edits. No production files.

## 6. Check-the-premise notes (do not freeze into DESIGN.md)

- DESIGN §5 names 导入型任务 write-back; native tasks are skipped.
- DESIGN §10 already names the `回写` event type; introducing the string is additive (events.type is free text).
- `submit_pr` has no REST route; do not add one.
- GitLab create-note success status is not tabled on the vendor page; assert `res.ok`, not a hard-coded 201, in production. Tests may still return 201 from the stub.
