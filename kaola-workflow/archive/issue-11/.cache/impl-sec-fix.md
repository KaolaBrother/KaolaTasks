# Evidence-binding header (do not modify above this line)
project: issue-11
issue: 11
role: implementer
verification_tier: tests-green
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11
source: kaola-workflow/issue-11/.cache/sec-review.md
# End evidence-binding header

## Scope

Repaired the one blocking finding and three of the four non-blocking findings from `sec-review.md`
that were explicitly in scope for this pass. Left the fourth (pr_url ↔ task.repo_full_name binding)
untouched per the orchestrator's deferral — that is a user-visible contract change, not a defect
this pass owns. Did not touch `AbortSignal.timeout`/`forgeGet`'s signature (zero-test-churn
constraint; skipped as instructed). Did not edit any `*.test.ts` or `package.json`.

## Files changed (production code only)

1. `apps/server/src/app.ts`
2. `apps/server/src/poller.ts`
3. `apps/server/src/vault.ts`
4. `packages/forge-adapters/src/index.ts`

## 1. Blocking — unhandled rejection can kill the process (`apps/server/src/app.ts`)

**Before:**

```ts
const timer = setInterval(() => {
  void pollPendingReviews(db)
}, pollIntervalMs)
child.addHook('onClose', () => {
  clearInterval(timer)
})
```

**After** (`apps/server/src/app.ts:41-58`):

```ts
let polling = false
const timer = setInterval(() => {
  if (polling) return
  polling = true
  pollPendingReviews(db)
    .catch(() => {})
    .finally(() => {
      polling = false
    })
}, pollIntervalMs)
child.addHook('onClose', () => {
  clearInterval(timer)
  polling = false
})
```

`.catch(() => {})` is belt-and-suspenders on top of `pollPendingReviews` now never rejecting (see
§2 below). This also folds in requirement 4 (in-flight guard) — see that section for the guard's
own rationale.

## 2. Blocking (continued) — `pollPendingReviews` must never reject (`apps/server/src/poller.ts`)

**Before:**

```ts
export async function pollPendingReviews(db: AppDb): Promise<void> {
  const pending = db.select().from(tasks).where(eq(tasks.status, PENDING_REVIEW_STATUS)).all()
  for (const task of pending) {
    await pollOneTask(db, task)
  }
}
```

**After:**

```ts
export async function pollPendingReviews(db: AppDb): Promise<void> {
  let pending: Task[]
  try {
    pending = db.select().from(tasks).where(eq(tasks.status, PENDING_REVIEW_STATUS)).all()
  } catch {
    return
  }
  for (const task of pending) {
    try {
      await pollOneTask(db, task)
    } catch {
      // Skip this row; a DB or forge fault here must not abort polling the rest of the set.
    }
  }
}
```

The write phase inside `pollOneTask` (previously three bare statements outside every `try`) is now
wrapped by this outer `try` at the call site, so any DB fault there also just skips the row. The
initial `db.select()` is wrapped too, for the same "never reject" guarantee stated in the finding.

## 3. Non-blocking — non-transactional writes (`apps/server/src/poller.ts` + `apps/server/src/vault.ts`)

**Before** (`poller.ts`, three separate statements):

```ts
db.update(tasks).set({ status: to }).where(eq(tasks.id, task.id)).run()
db.update(submissions).set({ prState }).where(eq(submissions.id, submission.id)).run()
insertAuditEvent(db, {
  type: STATUS_TRANSITION_EVENT,
  actorUserId: null,
  details: { task_id: task.publicId, from, to, pr_url: submission.prUrl },
})
```

**After:**

```ts
db.transaction((tx) => {
  tx.update(tasks).set({ status: to }).where(eq(tasks.id, task.id)).run()
  tx.update(submissions).set({ prState }).where(eq(submissions.id, submission.id)).run()
  insertAuditEvent(tx, {
    type: STATUS_TRANSITION_EVENT,
    actorUserId: null,
    details: { task_id: task.publicId, from, to, pr_url: submission.prUrl },
  })
})
```

Verified against the vendored drizzle client before writing this (not guessed): `AppDb` is
`drizzle-orm@0.44.7`'s `BetterSQLite3Database<TSchema> & { $client: Database }`
(`node_modules/.pnpm/drizzle-orm@0.44.7.../better-sqlite3/driver.d.ts`); its `.transaction<T>(cb):
T` is synchronous (better-sqlite3 is a sync driver) and hands the callback a
`BetterSQLiteTransaction<TFullSchema, TSchema>` (`better-sqlite3/session.d.ts:28`), which extends
the same `BaseSQLiteDatabase<'sync', RunResult, TFullSchema, TSchema>` base class as `AppDb`
itself (`sqlite-core/session.d.ts:90`, `sqlite-core/db.d.ts:16`) with identical generic
parameters — so `tx.insert`/`tx.update` are the exact same type as `db.insert`/`db.update`.

The one type wrinkle: `insertAuditEvent(db: AppDb, ...)` couldn't accept `tx` as-is, because `tx`
has no `$client` property and is therefore not structurally assignable to the full `AppDb` type.
Fixed by narrowing `insertAuditEvent`'s parameter type to the structural subset it actually uses
(`vault.ts`):

```ts
type AuditEventWriter = { insert: AppDb['insert'] }

export function insertAuditEvent(
  db: AuditEventWriter,
  input: { type: string; actorUserId: number | null; details: unknown },
): void {
```

`AppDb` still satisfies `AuditEventWriter` trivially, so every other existing caller
(`revealCredentialProfile`, `claim.ts`, `leases.ts`) is unaffected. Confirmed by `pnpm typecheck`
passing clean across all workspaces after the change.

## 4. Non-blocking — no in-flight guard on the timer (`apps/server/src/app.ts`)

Folded into §1's diff: a module-scoped `let polling = false` inside the `pollerContext` plugin
registration is set before dispatching `pollPendingReviews(db)` and cleared in `.finally()`. The
timer callback no-ops (`if (polling) return`) while a pass is still in flight, so an overlapping
tick can no longer re-select and re-transition the same `待验收` rows. `child.addHook('onClose',
...)` also resets `polling = false` alongside the existing `clearInterval(timer)`, as required.

## 5. Non-blocking — unencoded owner/repo path segments (`packages/forge-adapters/src/index.ts`)

**Before** (`prApiUrl`, github and gitea branches):

```ts
return `${prApiOrigin(kind, options)}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`
...
return `${prApiOrigin(kind, options)}/api/v1/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`
```

**After:**

```ts
return `${prApiOrigin(kind, options)}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`
...
return `${prApiOrigin(kind, options)}/api/v1/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`
```

GitLab's namespace segment (`prApiUrl`'s gitlab branch) was already `encodeURIComponent`-ed and is
unchanged. `get-pull-request.shared.test.ts` only ever exercises `owner ?? 'acme'` / `repo ?? 'app'`,
which encode to themselves, so no test assertion changed shape.

## Not implemented (per task's "Do NOT implement" / "Out of scope")

- No `pr_url` ↔ `task.repo_full_name` / host binding — deferred to the user per the orchestrator's
  note; issue #11 and `docs/DESIGN.md` don't specify it.
- No `AbortSignal.timeout` / `forgeGet` signature change — skipped to keep zero test churn.
- No changes to REST `submit_pr`, webhooks, `docs/DESIGN.md`, `packages/shared`, or any test file.

## Verification (run from the worktree)

- `pnpm typecheck` → exit 0, all 4 workspaces (`apps/web`, `packages/shared`,
  `packages/forge-adapters`, `apps/server`) report `Done`. This is also the check that proved the
  `insertAuditEvent(tx, ...)` type-widening actually type-checks, not just runs.
- `pnpm lint` → exit 0 (`eslint .`, no output).
- `CI=true pnpm test` → Node test runner: `tests 333`, `pass 333`, `fail 0`; then
  `vitest run` (`@kaola/web`): `Test Files 2 passed (2)`, `Tests 44 passed (44)`. Matches the
  required 333 + 44 tally exactly, including the pre-existing (uncommitted, not authored by this
  role) `poller.test.ts` and `get-pull-request.shared.test.ts` specs that exercise every touched
  path: the transaction-wrapped write (merged/closed/open transitions, event shape, actor_user_id
  null), the resilience test asserting `pollPendingReviews` never rejects and a sibling task still
  completes past a broken one, and the `getPullRequest` shared spec across github/gitlab/gitea.

No test was edited to reach this result.
