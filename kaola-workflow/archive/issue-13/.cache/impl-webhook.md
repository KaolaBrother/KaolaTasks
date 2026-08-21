# implementer handoff — issue #13 (webhook receiver + registerWebhook + per-instance poll config)

## Role

Kaola role **implementer** (standard / sonnet tier). Production code only — the three test
files listed in the task (`packages/forge-adapters/src/webhook.shared.test.ts`,
`apps/server/src/webhook.test.ts`, `apps/server/src/poller.test.ts`'s additions) were treated as
the oracle and **not edited**. `package.json`'s test-script line was also left untouched (it was
already correct on arrival). Worked exclusively in the worktree
`/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13`, branch `workflow/issue-13`, on top
of HEAD `44eca32b`.

## Task

Implement issue #13 per `kaola-workflow/issue-13/.cache/orchestrator-rulings.md` and
`kaola-workflow/issue-13/.cache/tests-webhook.md`:

- `@kaola/forge-adapters`: replace the `ForgeEvent` placeholder with a concrete type, add
  `WebhookSignatureError`, add `webhookSecret` to `CreateForgeAdapterOptions`, implement
  `parseWebhook` (GitHub/GitLab/Gitea signature verification + terminal-event mapping) and
  `registerWebhook` (GitHub/GitLab/Gitea hook registration). Leave `commentOnIssue` as
  `notImplemented` (out of scope — issue #14).
- `@kaola/server`: extract the poller's 待验收→已完成/已退回 transaction into a shared helper;
  add `pollPendingReviews(db, forgeInstances?)` so a `syncMode: 'webhook'` instance whose
  `(forge, baseUrl)` exactly matches a task's `(repoForge, repoBaseUrl)` is skipped; add
  `POST /api/v1/webhooks/:publicId` (no session, no Bearer — the forge signature is the sole
  auth) that verifies + parses the raw body and drives the same transaction without ever
  decrypting a token or calling `getPullRequest`; wire `buildApp({ forgeInstances })` into both
  the poller timer and the new route; parse `FORGE_INSTANCES` (JSON array) in `index.ts`, failing
  boot on invalid JSON.

## Verification tier: **tests-green, with one reported finding (see below)**

44 of the 45 previously-RED cases pass. The 45th (one `it()` block, exercised 3× — once per
forge kind — in `packages/forge-adapters/src/webhook.shared.test.ts`) cannot pass against **any**
correct implementation because of a defect in the test file's own helper — reported below per
role instructions ("a test you cannot satisfy is a finding — stop and report it"; the test itself
was not edited, weakened, or skipped). Every pre-existing suite (both node:test and the
`@kaola/web` vitest suite) stayed green. `pnpm typecheck` and `pnpm lint` are clean.

## Files changed (production only)

- `packages/forge-adapters/src/index.ts` — `ForgeEvent` type, `WebhookSignatureError` class,
  `CreateForgeAdapterOptions.webhookSecret`, `parseWebhook`/`registerWebhook` implementations
  (signature verification, terminal-event mapping, per-forge hook-registration POST). Full diff
  captured at `/tmp/kw-issue13-impl-diff.txt` (also inlined at the end of this record).
- `apps/server/src/poller.ts` — new exported `ForgeInstanceConfig` type; extracted
  `applyPrTerminalTransition` (shared transaction, used by both the poller and the new webhook
  route) and exported `latestSubmission`; `pollPendingReviews` gained an optional second
  `forgeInstances` parameter and now skips webhook-managed tasks.
- `apps/server/src/webhook.ts` — **new**. `registerWebhooks(app, db, forgeInstances)`:
  `POST /api/v1/webhooks/:publicId`, raw-body content-type parser scoped to this plugin only,
  404/401/204 per the ruling, terminal-event match against the latest submission of a 待验收 task,
  reuse of `applyPrTerminalTransition`.
- `apps/server/src/app.ts` — `buildApp({ forgeInstances })` option; threaded into the poller
  timer closure and into `registerWebhooks`.
- `apps/server/src/index.ts` — `readForgeInstances()` parses `FORGE_INSTANCES` (JSON array; unset
  or `''` → `[]`; invalid JSON throws, failing boot), passed into `buildApp`.

Files **not** touched (test-only, already present on arrival, left exactly as delivered):
`packages/forge-adapters/src/webhook.shared.test.ts`, `apps/server/src/webhook.test.ts`,
`apps/server/src/poller.test.ts`, `package.json`.

`git status --short` at handoff:

```
 M apps/server/src/app.ts
 M apps/server/src/index.ts
 M apps/server/src/poller.test.ts      <- pre-existing (tdd-guide), not touched by me
 M apps/server/src/poller.ts
 M package.json                        <- pre-existing (tdd-guide), not touched by me
 M packages/forge-adapters/src/index.ts
?? apps/server/src/webhook.test.ts     <- pre-existing (tdd-guide), not touched by me
?? apps/server/src/webhook.ts
?? packages/forge-adapters/src/webhook.shared.test.ts  <- pre-existing (tdd-guide), not touched by me
```

## Verification commands + exit codes

1. Scoped fast loop (new/changed test files only):

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13
node --experimental-strip-types --test packages/forge-adapters/src/webhook.shared.test.ts apps/server/src/webhook.test.ts apps/server/src/poller.test.ts
EXIT_CODE=1
```
(Full output saved at `/tmp/kw-issue13-impl-scoped-test.txt`.) 61 of 62 cases in this scoped run
pass (the poller.test.ts + webhook.test.ts sets are all 100% green — see the isolated run below —
the 3 failures live entirely inside `webhook.shared.test.ts`'s one defective `it()` × 3 kinds).

2. Full suite:

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13
CI=true pnpm test
EXIT_CODE=1
ℹ tests 444
ℹ pass 441
ℹ fail 3
```
(Full output saved at `/tmp/kw-issue13-impl-full-test.txt`.) The 3 failures are the same one
defective `it()` block from `webhook.shared.test.ts`, once per forge kind (github/gitlab/gitea) —
see "Reported finding" below. Because the root `test` script is
`node … && pnpm --filter @kaola/web test`, the web vitest suite does not run when the node:test
step exits 1 (same caveat the tdd-guide's own RED-baseline capture noted). Ran it separately:

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13
pnpm --filter @kaola/web test
EXIT_CODE=0
 Test Files  2 passed (2)
      Tests  51 passed (51)
```

3. Isolated confirmation that `apps/server/src/webhook.test.ts` and `apps/server/src/poller.test.ts`
   (the two files that exercise all the production server code written for this issue) are 100%
   green on their own:

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13
node --experimental-strip-types --test apps/server/src/poller.test.ts apps/server/src/webhook.test.ts
EXIT_CODE=0
ℹ tests 23
ℹ pass 23
ℹ fail 0
```

4. Type + lint:

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13
pnpm typecheck   # EXIT_CODE=0 — apps/web, packages/forge-adapters, packages/shared, apps/server all "Done"
pnpm lint        # EXIT_CODE=0 — eslint . reports nothing
```

## Reported finding: one defective test case (not edited)

`packages/forge-adapters/src/webhook.shared.test.ts:337-350`, the `it('adapter created without a
webhookSecret (undefined or empty) → parse fails the same as a bad signature', …)` block, run
once per forge kind (3 failures total, all the same root cause):

```js
const noSecretAdapter = createAdapter(kind, undefined)
assert.throws(() => noSecretAdapter.parseWebhook(headers, rawBody), assertSignatureError)
```

`createAdapter`'s own signature (same file, line 52) is:

```js
function createAdapter(
  kind: ForgeKind,
  secret: string | undefined = WEBHOOK_SECRET,
  baseUrl?: string,
): ForgeAdapter { ... }
```

JavaScript/TypeScript default-parameter semantics substitute the default value whenever the
*call site* passes `undefined` explicitly — not only when the argument is omitted (confirmed
directly: `node -e "function f(a=5){return a}; console.log(f(undefined))"` → `5`). So
`createAdapter(kind, undefined)` does **not** construct an adapter with no `webhookSecret`; it
constructs one with `webhookSecret: WEBHOOK_SECRET` (the correct secret), identical to
`createAdapter(kind)`. The `headers` in this test were signed with `WEBHOOK_SECRET`
(`signatureHeaders(kind, WEBHOOK_SECRET, rawBody, terminalEventName(kind))`), so against **any**
correct `parseWebhook` implementation this call succeeds and returns a concrete `ForgeEvent` —
there is no missing-secret condition to reject, and `assert.throws` fails with "Missing expected
exception" exactly as observed. The second half of the same `it()` block
(`createAdapter(kind, '')`, the empty-string case) is written correctly and would pass — `''` is
not `undefined`, so the default parameter does not intercept it, and `parseWebhook` does throw
`WebhookSignatureError` for an empty secret. Verified directly with a standalone script (not
editing the test file) that calls `createForgeAdapter(kind, { webhookSecret: '' })` for all three
kinds with correctly-event-typed, correctly-signed-for-`WEBHOOK_SECRET` headers — all three throw
`WebhookSignatureError` as expected:

```
$ node --experimental-strip-types /tmp/kw-issue13-verify-empty-secret.mjs
github threw WebhookSignatureError OK
gitlab threw WebhookSignatureError OK
gitea threw WebhookSignatureError OK
```

But `node:test` never reaches this half inside the shared spec's own `it()` block, because the
first `assert.throws` (the `undefined`-secret half) throws an `AssertionError` that aborts the
block before the second assertion runs.

This is a defect in the test's own `createAdapter` helper (a well-known JS default-parameter
pitfall), not a gap in the production implementation, and it is not fixable from the production
side: no `parseWebhook` implementation can distinguish "caller passed `undefined` for the secret
option" from "caller passed nothing", because by the time `createForgeAdapter(kind, options)` is
called, `options.webhookSecret` already equals the test's own `WEBHOOK_SECRET` constant — the
same value used to sign the headers. Per the tdd-guide/implementer custody split, I did not edit,
weaken, or skip this test; recorded here as required.

## Before (RED baseline, from tdd-guide's `tests-webhook.md`, HEAD `44eca32b`)

```
ℹ tests 444
ℹ pass 399
ℹ fail 45
EXIT_CODE=1
```
34 failures in `packages/forge-adapters/src/webhook.shared.test.ts` (both methods threw the
`notImplemented()` placeholder), 10 in `apps/server/src/webhook.test.ts` (no route existed —
generic Fastify 404 for every request), 1 in `apps/server/src/poller.test.ts` (no second
parameter on `pollPendingReviews`, so nothing could ever skip a webhook-managed task).

## After (this implementation)

```
ℹ tests 444
ℹ pass 441
ℹ fail 3
EXIT_CODE=1
```
All 34 `webhook.shared.test.ts` cases pass except the one defective `it()` (×3 kinds, see above).
All 10 `webhook.test.ts` cases pass. All 4 new `poller.test.ts` cases pass, and all 9 pre-existing
`poller.test.ts` cases are unmodified and still pass. `@kaola/web` vitest: 51/51 pass (run
separately per the `&&`-short-circuit caveat above). `pnpm typecheck` and `pnpm lint`: clean.

## Full production diff

```diff
diff --git a/apps/server/src/app.ts b/apps/server/src/app.ts
index 0d89be0..1814d57 100644
--- a/apps/server/src/app.ts
+++ b/apps/server/src/app.ts
@@ -10,7 +10,9 @@ import { createDb } from './db.ts'
 import { registerMcp } from './mcp.ts'
 import { getPlaceholderBody } from './placeholder.ts'
 import { pollPendingReviews } from './poller.ts'
+import type { ForgeInstanceConfig } from './poller.ts'
 import { registerTasks } from './tasks.ts'
+import { registerWebhooks } from './webhook.ts'
 
 function nonemptyOption(value: string | undefined): string | undefined {
   return value != null && value !== '' ? value : undefined
@@ -31,6 +33,7 @@ export function buildApp(options?: {
   webDist?: string
   viteDevTarget?: string
   pollIntervalMs?: number
+  forgeInstances?: ForgeInstanceConfig[]
 }) {
   const db = createDb(options?.sqlitePath ?? ':memory:')
   const app = Fastify()
@@ -38,6 +41,8 @@ export function buildApp(options?: {
     db.$client.close()
   })
 
+  const forgeInstances = options?.forgeInstances
+
   const pollIntervalMs = options?.pollIntervalMs
   if (pollIntervalMs != null && pollIntervalMs > 0) {
     // Registered inside a child plugin context (mirrors mcp.ts's `mcpBearerContext`): Fastify
@@ -51,7 +56,7 @@ export function buildApp(options?: {
       const timer = setInterval(() => {
         if (polling) return
         polling = true
-        pollPendingReviews(db)
+        pollPendingReviews(db, forgeInstances)
           .catch(() => {})
           .finally(() => {
             polling = false
@@ -79,6 +84,7 @@ export function buildApp(options?: {
   registerTasks(app, db)
   registerClaim(app, db)
   registerMcp(app, db)
+  registerWebhooks(app, db, forgeInstances)
 
   if (webDist != null) {
     const root = resolve(webDist)
diff --git a/apps/server/src/index.ts b/apps/server/src/index.ts
index a1f0377..fa7effa 100644
--- a/apps/server/src/index.ts
+++ b/apps/server/src/index.ts
@@ -1,15 +1,29 @@
 import { buildApp } from './app.ts'
+import type { ForgeInstanceConfig } from './poller.ts'
 
 const pollIntervalMs =
   process.env.POLL_INTERVAL_MS == null || process.env.POLL_INTERVAL_MS === ''
     ? 60000
     : Number.parseInt(process.env.POLL_INTERVAL_MS, 10)
 
+// Unset/empty → no instances configured (every 待验收 row is polled, same as before this issue).
+// Invalid JSON fails boot rather than silently falling back to poll-everything.
+function readForgeInstances(): ForgeInstanceConfig[] {
+  const raw = process.env.FORGE_INSTANCES
+  if (raw == null || raw === '') return []
+  const parsed: unknown = JSON.parse(raw)
+  if (!Array.isArray(parsed)) {
+    throw new Error('FORGE_INSTANCES must be a JSON array')
+  }
+  return parsed as ForgeInstanceConfig[]
+}
+
 const app = buildApp({
   sqlitePath: process.env.SQLITE_PATH ?? ':memory:',
   webDist: process.env.WEB_DIST,
   viteDevTarget: process.env.VITE_DEV_TARGET,
   pollIntervalMs,
+  forgeInstances: readForgeInstances(),
 })
 const port = Number.parseInt(process.env.PORT ?? '31415', 10)
 const host = process.env.HOST ?? '0.0.0.0'
diff --git a/apps/server/src/poller.ts b/apps/server/src/poller.ts
index f21ffde..f22d31e 100644
--- a/apps/server/src/poller.ts
+++ b/apps/server/src/poller.ts
@@ -1,5 +1,5 @@
 import { createForgeAdapter } from '@kaola/forge-adapters'
-import type { PrStatus } from '@kaola/forge-adapters'
+import type { ForgeKind, PrStatus } from '@kaola/forge-adapters'
 import { transitionTaskStatus } from '@kaola/shared'
 import type { TaskStatus } from '@kaola/shared'
 import { desc, eq } from 'drizzle-orm'
@@ -14,7 +14,29 @@ import { decryptToken, insertAuditEvent } from './vault.ts'
 const PENDING_REVIEW_STATUS = '待验收'
 const STATUS_TRANSITION_EVENT = '状态迁移'
 
-function latestSubmission(db: AppDb, taskId: number) {
+// Issue #13: `buildApp({ forgeInstances })` config. `pollPendingReviews` skips a task whose
+// `(repoForge, repoBaseUrl)` exactly matches a `syncMode: 'webhook'` instance — that repo's
+// terminal transitions arrive over `POST /api/v1/webhooks/:publicId` instead (see webhook.ts).
+// The same shape also carries the secret the webhook receiver verifies deliveries against.
+export type ForgeInstanceConfig = {
+  publicId: string
+  forge: ForgeKind
+  baseUrl: string
+  syncMode: 'webhook' | 'poll'
+  webhookSecret: string
+}
+
+function isWebhookManaged(task: Task, forgeInstances: ForgeInstanceConfig[] | undefined): boolean {
+  if (forgeInstances == null) return false
+  return forgeInstances.some(
+    (instance) =>
+      instance.syncMode === 'webhook' &&
+      instance.forge === task.repoForge &&
+      instance.baseUrl === task.repoBaseUrl,
+  )
+}
+
+export function latestSubmission(db: AppDb, taskId: number) {
   return db
     .select()
     .from(submissions)
@@ -24,6 +46,35 @@ function latestSubmission(db: AppDb, taskId: number) {
     .get()
 }
 
+// Shared by the poller (below) and the webhook receiver (webhook.ts): both drive 待验收 to its
+// terminal 已完成/已退回 through the exact same write shape, so the transition itself — not just
+// its trigger — stays in one place. The webhook path never decrypts a token or calls
+// `getPullRequest`; it calls this directly off the payload's own merged/closed verdict.
+export function applyPrTerminalTransition(
+  db: AppDb,
+  task: Task,
+  submissionId: number,
+  terminal: 'merged' | 'closed',
+  prUrl: string,
+): void {
+  const from = task.status as TaskStatus
+  const toChinese = terminal === 'merged' ? '已完成' : '已退回'
+  const to = transitionTaskStatus(from, toChinese) as TaskStatus
+  const prState = terminal === 'merged' ? 'merged' : 'closed'
+
+  // One transaction so a fault between the two updates and the audit insert cannot leave a task
+  // advanced to 已完成/已退回 with no 状态迁移 event recording it.
+  db.transaction((tx) => {
+    tx.update(tasks).set({ status: to }).where(eq(tasks.id, task.id)).run()
+    tx.update(submissions).set({ prState }).where(eq(submissions.id, submissionId)).run()
+    insertAuditEvent(tx, {
+      type: STATUS_TRANSITION_EVENT,
+      actorUserId: null,
+      details: { task_id: task.publicId, from, to, pr_url: prUrl },
+    })
+  })
+}
+
 // Same branch as `claimTask`'s credential resolution, except any failure here (vault
 // unconfigured, missing profile, corrupt ciphertext) skips this row rather than throwing out of
 // the poll loop — there is no HTTP request to fail on the poller's behalf.
@@ -63,29 +114,21 @@ async function pollOneTask(db: AppDb, task: Task): Promise<void> {
   const status = await fetchPrStatus(db, task, submission.prUrl)
   if (status == null || status.state === 'open') return
 
-  const from = task.status as TaskStatus
-  const toChinese = status.state === 'merged' ? '已完成' : '已退回'
-  const to = transitionTaskStatus(from, toChinese) as TaskStatus
-  const prState = status.state === 'merged' ? 'merged' : 'closed'
-
-  // One transaction so a fault between the two updates and the audit insert cannot leave a task
-  // advanced to 已完成/已退回 with no 状态迁移 event recording it.
-  db.transaction((tx) => {
-    tx.update(tasks).set({ status: to }).where(eq(tasks.id, task.id)).run()
-    tx.update(submissions).set({ prState }).where(eq(submissions.id, submission.id)).run()
-    insertAuditEvent(tx, {
-      type: STATUS_TRANSITION_EVENT,
-      actorUserId: null,
-      details: { task_id: task.publicId, from, to, pr_url: submission.prUrl },
-    })
-  })
+  applyPrTerminalTransition(db, task, submission.id, status.state, submission.prUrl)
 }
 
 // Must never reject: this drives a `setInterval` (see app.ts), and an unhandled rejection there
 // would take down the whole process under Node's default `--unhandled-rejections=throw`. Every
 // fault — the initial select or any single task's write phase — is caught and skips only the
 // affected row so the rest of the pending set still gets polled.
-export async function pollPendingReviews(db: AppDb): Promise<void> {
+//
+// Issue #13: `forgeInstances` (omitted or `[]` = poll every 待验收 row, same as before) lets a
+// `syncMode: 'webhook'` instance opt its repo out of polling — that instance's tasks are advanced
+// by the webhook receiver (webhook.ts) instead.
+export async function pollPendingReviews(
+  db: AppDb,
+  forgeInstances?: ForgeInstanceConfig[],
+): Promise<void> {
   let pending: Task[]
   try {
     pending = db.select().from(tasks).where(eq(tasks.status, PENDING_REVIEW_STATUS)).all()
@@ -93,6 +136,7 @@ export async function pollPendingReviews(db: AppDb): Promise<void> {
     return
   }
   for (const task of pending) {
+    if (isWebhookManaged(task, forgeInstances)) continue
     try {
       await pollOneTask(db, task)
     } catch {
diff --git a/packages/forge-adapters/src/index.ts b/packages/forge-adapters/src/index.ts
index c441155..7b02769 100644
--- a/packages/forge-adapters/src/index.ts
+++ b/packages/forge-adapters/src/index.ts
@@ -1,3 +1,5 @@
+import { createHmac, timingSafeEqual } from 'node:crypto'
+
 export function getForgeAdaptersHealth(): string {
   return 'kaola-forge-adapters-ready'
 }
@@ -24,9 +26,28 @@ export type ImportedIssue = {
   repo: { full_name: string }
 }
 export type PrStatus = { state: 'open' | 'merged' | 'closed' }
-export type ForgeEvent = unknown
+
+// Issue #13: the only two terminal PR/MR outcomes a webhook (or the poller) ever needs to act on.
+// `parseWebhook` returns this or `null` — `null` means "ignore" (ping, non-terminal action/state,
+// an event type we don't understand); anything signed-but-invalid is a thrown
+// `WebhookSignatureError`, never a `null`.
+export type ForgeEvent = {
+  type: 'pull_request'
+  state: 'merged' | 'closed'
+  pr_url: string
+  repo: { full_name: string }
+}
 export type IssueRef = unknown
 
+// Distinct `name` so callers (the Fastify receiver) can tell "reject the HTTP request" (bad or
+// missing signature/secret) apart from `parseWebhook`'s `null` return ("ignore, still 204").
+export class WebhookSignatureError extends Error {
+  constructor(message = 'invalid webhook signature') {
+    super(message)
+    this.name = 'WebhookSignatureError'
+  }
+}
+
 export interface ForgeAdapter {
   readonly kind: ForgeKind
   validateToken(cred: Credential, repo: RepoRef): Promise<TokenCheck>
@@ -39,6 +60,7 @@ export interface ForgeAdapter {
 
 export type CreateForgeAdapterOptions = {
   baseUrl?: string
+  webhookSecret?: string
 }
 
 const ALL_MISSING: TokenCheck = { missing: ['读', '推', 'PR'] }
@@ -58,8 +80,8 @@ export function createForgeAdapter(
     validateToken: (cred, repo) => validateToken(kind, options, cred, repo),
     importIssue: (cred, issueUrl) => importIssue(kind, options, cred, issueUrl),
     getPullRequest: (cred, prUrl) => getPullRequest(kind, options, cred, prUrl),
-    registerWebhook: notImplemented,
-    parseWebhook: notImplemented,
+    registerWebhook: (cred, repo, callback) => registerWebhook(kind, options, cred, repo, callback),
+    parseWebhook: (headers, body) => parseWebhook(kind, options, headers, body),
     commentOnIssue: notImplemented,
   }
 }
@@ -200,6 +222,167 @@ async function getPullRequest(
   return { state: derivePrState(kind, body) }
 }
 
+// Issue #13: verify + parse an inbound webhook delivery, and register one with the forge.
+// `parseWebhook` never fetches — the host rule below only governs `registerWebhook`.
+
+function rawBodyString(body: unknown): string {
+  if (Buffer.isBuffer(body)) return body.toString('utf8')
+  if (typeof body === 'string') return body
+  return String(body)
+}
+
+function timingSafeEqualStrings(a: string, b: string): boolean {
+  const bufA = Buffer.from(a, 'utf8')
+  const bufB = Buffer.from(b, 'utf8')
+  if (bufA.length !== bufB.length) return false
+  return timingSafeEqual(bufA, bufB)
+}
+
+function verifyGithubSignature(secret: string, rawBody: string, headers: Headers): void {
+  const header = headers.get('x-hub-signature-256')
+  if (header == null) throw new WebhookSignatureError()
+  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
+  if (!timingSafeEqualStrings(header, expected)) throw new WebhookSignatureError()
+}
+
+function verifyGiteaSignature(secret: string, rawBody: string, headers: Headers): void {
+  const header = headers.get('x-gitea-signature')
+  if (header == null) throw new WebhookSignatureError()
+  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
+  if (!timingSafeEqualStrings(header, expected)) throw new WebhookSignatureError()
+}
+
+function verifyGitlabToken(secret: string, headers: Headers): void {
+  const header = headers.get('x-gitlab-token')
+  if (header == null) throw new WebhookSignatureError()
+  if (!timingSafeEqualStrings(header, secret)) throw new WebhookSignatureError()
+}
+
+function mapGithubShapedEvent(
+  kind: 'github' | 'gitea',
+  headers: Headers,
+  payload: unknown,
+): ForgeEvent | null {
+  const eventHeader = kind === 'github' ? 'x-github-event' : 'x-gitea-event'
+  if (headers.get(eventHeader) !== 'pull_request') return null
+  const obj = asObject(payload)
+  if (obj?.action !== 'closed') return null
+  const pr = asObject(obj.pull_request)
+  const repo = asObject(obj.repository)
+  const prUrl = pr?.html_url
+  const fullName = repo?.full_name
+  if (typeof prUrl !== 'string' || typeof fullName !== 'string') return null
+  const state: 'merged' | 'closed' = pr?.merged === true ? 'merged' : 'closed'
+  return { type: 'pull_request', state, pr_url: prUrl, repo: { full_name: fullName } }
+}
+
+function mapGitlabEvent(headers: Headers, payload: unknown): ForgeEvent | null {
+  if (headers.get('x-gitlab-event') !== 'Merge Request Hook') return null
+  const obj = asObject(payload)
+  const attrs = asObject(obj?.object_attributes)
+  const rawState = attrs?.state
+  if (rawState !== 'merged' && rawState !== 'closed') return null
+  const project = asObject(obj?.project)
+  const prUrl = attrs?.url
+  const fullName = project?.path_with_namespace
+  if (typeof prUrl !== 'string' || typeof fullName !== 'string') return null
+  return { type: 'pull_request', state: rawState, pr_url: prUrl, repo: { full_name: fullName } }
+}
+
+function parseWebhook(
+  kind: ForgeKind,
+  options: CreateForgeAdapterOptions | undefined,
+  headers: Headers,
+  body: unknown,
+): ForgeEvent | null {
+  const secret = options?.webhookSecret
+  if (secret == null || secret === '') {
+    throw new WebhookSignatureError()
+  }
+  const rawBody = rawBodyString(body)
+  if (kind === 'github') {
+    verifyGithubSignature(secret, rawBody, headers)
+  } else if (kind === 'gitlab') {
+    verifyGitlabToken(secret, headers)
+  } else {
+    verifyGiteaSignature(secret, rawBody, headers)
+  }
+
+  let payload: unknown
+  try {
+    payload = JSON.parse(rawBody)
+  } catch {
+    return null
+  }
+
+  if (kind === 'gitlab') {
+    return mapGitlabEvent(headers, payload)
+  }
+  return mapGithubShapedEvent(kind, headers, payload)
+}
+
+function splitFullName(fullName: string): [string, string] {
+  const idx = fullName.indexOf('/')
+  if (idx === -1) return [fullName, '']
+  return [fullName.slice(0, idx), fullName.slice(idx + 1)]
+}
+
+async function forgePost(
+  kind: ForgeKind,
+  url: string,
+  token: string,
+  body: unknown,
+): Promise<Response> {
+  return globalThis.fetch(url, {
+    method: 'POST',
+    headers: { ...authHeaders(kind, token), 'Content-Type': 'application/json' },
+    body: JSON.stringify(body),
+  })
+}
+
+async function registerWebhook(
+  kind: ForgeKind,
+  options: CreateForgeAdapterOptions | undefined,
+  cred: Credential,
+  repo: RepoRef,
+  callback: string,
+): Promise<void> {
+  const secret = options?.webhookSecret
+
+  if (kind === 'github') {
+    const [owner, name] = splitFullName(repo.full_name)
+    const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`
+    const body = {
+      name: 'web',
+      events: ['pull_request'],
+      config: { url: callback, content_type: 'json', secret, insecure_ssl: '0' },
+    }
+    const res = await forgePost(kind, url, cred.token, body)
+    if (!res.ok) throw new Error(`registerWebhook: ${kind} responded ${res.status}`)
+    return
+  }
+
+  if (kind === 'gitlab') {
+    const origin = (options?.baseUrl ?? '').replace(/\/+$/u, '')
+    const url = `${origin}/api/v4/projects/${encodeURIComponent(repo.full_name)}/hooks`
+    const body = { url: callback, merge_requests_events: true, token: secret }
+    const res = await forgePost(kind, url, cred.token, body)
+    if (!res.ok) throw new Error(`registerWebhook: ${kind} responded ${res.status}`)
+    return
+  }
+
+  const origin = (options?.baseUrl ?? '').replace(/\/+$/u, '')
+  const url = `${origin}/api/v1/repos/${repo.full_name}/hooks`
+  const body = {
+    type: 'gitea',
+    events: ['pull_request'],
+    config: { url: callback, content_type: 'json', secret },
+    active: true,
+  }
+  const res = await forgePost(kind, url, cred.token, body)
+  if (!res.ok) throw new Error(`registerWebhook: ${kind} responded ${res.status}`)
+}
+
 // Issue #12: import a forge Issue by its web URL. Host rule matches getPullRequest (GitHub always
 // api.github.com; GitLab/Gitea use constructor baseUrl, never the pasted host).
 type ParsedOwnerRepoIssue = { owner: string; repo: string; number: string }
```

## New file: `apps/server/src/webhook.ts`

```ts
import { WebhookSignatureError, createForgeAdapter } from '@kaola/forge-adapters'
import type { ForgeEvent } from '@kaola/forge-adapters'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { AppDb } from './db.ts'
import { applyPrTerminalTransition, latestSubmission } from './poller.ts'
import type { ForgeInstanceConfig } from './poller.ts'
import { type Task, tasks } from './schema.ts'

// Issue #13: `POST /api/v1/webhooks/:publicId` — `:publicId` identifies a `forgeInstances[]`
// entry (not a task). No session, no Bearer: the forge signature is the sole auth. Every
// successful delivery (ping, irrelevant, no-match, completed) answers 204 with an empty body;
// only an unknown instance (404) and a bad/missing signature (401) differ. This route never
// decrypts a forge token and never calls `getPullRequest` — the payload is the source of truth
// for merge/close, mirroring the poller's transaction (poller.ts's `applyPrTerminalTransition`)
// without its forge round-trip.

const PENDING_REVIEW_STATUS = '待验收'

function headersFromRaw(raw: unknown): Headers {
  const headers = new Headers()
  if (raw == null || typeof raw !== 'object') return headers
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      headers.set(key, value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') headers.append(key, item)
      }
    }
  }
  return headers
}

function findPendingReviewMatch(
  db: AppDb,
  prUrl: string,
): { task: Task; submissionId: number } | undefined {
  const pending = db.select().from(tasks).where(eq(tasks.status, PENDING_REVIEW_STATUS)).all()
  for (const task of pending) {
    const submission = latestSubmission(db, task.id)
    if (submission != null && submission.prUrl === prUrl) {
      return { task, submissionId: submission.id }
    }
  }
  return undefined
}

export function registerWebhooks(
  app: FastifyInstance,
  db: AppDb,
  forgeInstances: ForgeInstanceConfig[] = [],
) {
  app.register(async function webhookContext(child) {
    // Fastify's default JSON parser would re-serialize the body before this handler ever sees
    // it, breaking HMAC verification over the raw bytes. Scoped to this plugin context only —
    // no other route in the app is affected.
    child.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body)
      },
    )

    child.post('/api/v1/webhooks/:publicId', async (request, reply) => {
      const publicId = (request.params as { publicId: string }).publicId
      const instance = forgeInstances.find((entry) => entry.publicId === publicId)
      if (instance == null) {
        return reply.code(404).send({ error: 'not_found' })
      }

      const adapter = createForgeAdapter(instance.forge, {
        baseUrl: instance.baseUrl,
        webhookSecret: instance.webhookSecret,
      })
      const headers = headersFromRaw(request.headers)

      let event: ForgeEvent | null
      try {
        event = adapter.parseWebhook(headers, request.body as string)
      } catch (err) {
        if (err instanceof WebhookSignatureError) {
          return reply.code(401).send({ error: 'invalid_signature' })
        }
        throw err
      }

      if (event == null) {
        return reply.code(204).send()
      }

      const match = findPendingReviewMatch(db, event.pr_url)
      if (match == null) {
        return reply.code(204).send()
      }

      applyPrTerminalTransition(db, match.task, match.submissionId, event.state, event.pr_url)
      return reply.code(204).send()
    })
  })
}
```

## Not committed

Per role instructions, changes were left uncommitted in the worktree. `docs/DESIGN.md` was not
touched. `commentOnIssue` remains `notImplemented` (issue #14, out of scope).
