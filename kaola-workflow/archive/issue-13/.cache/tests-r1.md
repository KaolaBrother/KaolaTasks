# tests-r1: RED evidence for security finding R1

project: issue-13
issue: 13
finding: R1 — webhook signature authenticates an instance but authorizes every task on every instance
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13
HEAD SHA (uncommitted working tree; `git status --porcelain` unchanged aside from this test file): `44eca32b297d8aa15e3966c1bb29090ce6e336cb`

## What was added

One new case in `apps/server/src/webhook.test.ts` only (no production files touched):

> `confused deputy: a correctly-signed github delivery must not complete an unrelated gitea
> instance's task merely because pr_url matches`

Setup: boots `buildApp` with **two** `forgeInstances` — the existing gitea instance
(`GITEA_INSTANCE_ID`, `forge:'gitea'`, `baseUrl: FORGE_BASE_URL`, `GITEA_WEBHOOK_SECRET`) and the
existing github instance (`GITHUB_INSTANCE_ID`, `forge:'github'`, `baseUrl:'https://api.github.com'`,
`GITHUB_WEBHOOK_SECRET`). Creates a real 待验收 **gitea** task via `createPendingReviewTask`
(title `跨实例混淆用例`, prNumber `606`). POSTs a **correctly signed** (`githubSignature`,
`X-Hub-Signature-256`) github `pull_request` delivery (`X-GitHub-Event: pull_request`,
`action:'closed'`, `pull_request.merged:true`) to `/api/v1/webhooks/${GITHUB_INSTANCE_ID}` whose
`pull_request.html_url` is the **gitea task's own** `setup.prUrl` — the confused-deputy payload —
with an unrelated `repository.full_name` (`'unrelated/repo'`).

Assertions:
1. `res.statusCode === 204` (a validly-signed delivery must not be rejected as an authentication
   failure — this is an authz gap, not a signature problem)
2. `res.body === ''`
3. `taskRow(db, setup.publicId).status === '待验收'` (task must not have transitioned)
4. `statusTransitionEventsFor(db, setup.publicId)` filtered to `from === '待验收'` has length `0`
   (no 状态迁移 event written for that task)

Reused existing helpers only: `boot`, `createPendingReviewTask`, `taskRow`,
`statusTransitionEventsFor`, `parseDetails`, `githubSignature`, `giteaPrPayload` (body shape is
forge-agnostic — `mapGithubShapedEvent` in `packages/forge-adapters/src/index.ts` reads the same
`action`/`pull_request.merged`/`pull_request.html_url`/`repository.full_name` fields for both
`github` and `gitea` kinds), `webhookUrl`, `openDb`, `sqliteFile`, `mintAgentKey`, `loginGitea`.
No existing case was modified or weakened.

## RED run

Command:

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13
node --experimental-strip-types --test apps/server/src/webhook.test.ts
```

Result: `tests 11`, `pass 10`, `fail 1`. All 10 pre-existing cases still pass unmodified; the new
case is the sole failure.

Failure signature:

```
✖ confused deputy: a correctly-signed github delivery must not complete an unrelated gitea instance's task merely because pr_url matches (11.997208ms)
  AssertionError [ERR_ASSERTION]: a github instance's signed delivery must never complete a gitea task just because pr_url matches, got {"id":1,"public_id":"kt-2026-0001","status":"已完成"}

  '已完成' !== '待验收'

      at TestContext.<anonymous> (file:///Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13/apps/server/src/webhook.test.ts:843:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1125:7)
      at async Suite.processPendingSubtests (node:internal/test_runner/test:787:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: '已完成',
    expected: '待验收',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

This confirms the admitted defect exactly as described in R1: the correctly-signed github
delivery passed signature verification (no 401), then `findPendingReviewMatch` matched the gitea
task globally by `pr_url` alone and drove it `待验收 → 已完成`, with no check that the resolved
instance's `(forge, baseUrl)` equals the task's `(repoForge, repoBaseUrl)`.

## Fix acceptance criteria (for the implementer)

The new case's four assertions (204, empty body, status still `待验收`, zero 状态迁移 events from
`待验收` for that task) must pass, and all 10 pre-existing cases in
`apps/server/src/webhook.test.ts` must continue to pass unmodified.
