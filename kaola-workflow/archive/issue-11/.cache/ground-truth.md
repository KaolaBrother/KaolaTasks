# Ground truth for #11 — 待验收轮询终态 + 已退回重开

Measured against the claimed worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-11`
(branch `workflow/issue-11`, clean, `HEAD` = `1a6272c chore: archive issue-10 [sink]`), **not** main and
**not** any archive note. Baseline was run in-session:

```
$ CI=true pnpm test
… ℹ tests 297 / pass 297 / fail 0 (shared+forge-adapters+server)
$ vitest run (apps/web)
… Test Files 2 passed (2), Tests 44 passed (44)
```

Everything below is quoted with `file:line`; nothing is inferred beyond what the cited lines say.

---

## 1. `@kaola/shared` `transitionTaskStatus` — legal edges already exist

`packages/shared/src/index.ts:68-81`:

```ts
const LEGAL_TRANSITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['待认领', new Set(['进行中', '已取消'])],
  ['进行中', new Set(['待认领', '待验收'])],
  ['待验收', new Set(['已完成', '已退回'])],
  ['已退回', new Set(['待认领', '已取消'])],
])

export function transitionTaskStatus(from: string, to: string): string {
  const allowed = LEGAL_TRANSITIONS.get(from)
  if (!allowed?.has(to)) {
    throw new Error(`Illegal task status transition: ${from} → ${to}`)
  }
  return to
}
```

**待验收→已完成, 待验收→已退回, 已退回→待认领 are all already legal in the shared state machine.**
`packages/shared/src/index.test.ts` (visible in the passing test run above, `describe('transitionTaskStatus')`)
exhaustively covers all 6×6 pairs including these three as `allows`. #11 needs **no change** to
`@kaola/shared` for the state-machine edges themselves — it only needs *callers* that invoke
`transitionTaskStatus('待验收', '已完成' | '已退回')` from the poller, mirroring the existing callers
in `claim.ts` / `tasks.ts` / `leases.ts`.

## 2. MCP `submitPr` (`submit_pr`) — what #10 actually landed

`apps/server/src/claim.ts:287-359` (`submitPr`), registered as MCP tool only —
`apps/server/src/mcp.ts:147-159` (`registerTool('submit_pr', …)`). **No REST `submit_pr` route**:
`apps/server/src/claim.ts:361-389` (`registerClaim`) registers only `claim` / `progress` / `release`.

Behavior of `submitPr(db, auth, publicId, prUrl, summary)`:
- `sweepExpiredLeases(db)` first (claim.ts:298).
- 404 if task not found (300-303); 409 `conflict` `任务未被认领。` if no *active* lease (305-308);
  403 `forbidden` (no message) if the active lease's `claimerUserId !== auth.user.id` (309-311).
- **Requires `from === '进行中'` exactly** (314-320) — 409 `illegal_transition` with Chinese message
  otherwise (`任务状态不允许从「X」变更为「待验收」。`). Any other `from` (已取消, 待认领, 待验收, 已完成,
  已退回) is refused here, not by `transitionTaskStatus`.
- On success: `to = transitionTaskStatus('进行中', '待验收')` (322); **releases the lease**
  (`markLeaseReleased(db, lease.id)`, 323) — so a submitted task has **no active lease** while
  待验收; updates `tasks.status` (324-329); inserts one `submissions` row
  `{ taskId, leaseId, prUrl, summary, prState: 'open' }` (334-342); writes one `状态迁移` event with
  `actorUserId: auth.user.id` and `details: { task_id, from: '进行中', to: '待验收', pr_url, summary }`
  (344-348).
- Returns `{ task: brief, pr_url, summary }` — **no token**, no `lease` field.

Test coverage confirming every clause above: `apps/server/src/mcp.test.ts:1271-1385`
(`describe('submit_pr')`), including the exact `submissions` row shape query at
`apps/server/src/mcp.test.ts:584` (`SELECT task_id, lease_id, pr_url, summary, pr_state FROM
submissions WHERE task_id = ?`).

## 3. Session `PATCH /api/v1/tasks/:publicId` poster transitions

`apps/server/src/tasks.ts:31-34`:

```ts
const POSTER_TRANSITIONS: ReadonlyMap<string, ReadonlySet<TaskStatus>> = new Map([
  ['待认领', new Set<TaskStatus>(['已取消'])],
  ['已退回', new Set<TaskStatus>(['已取消', '待认领'])],
])
```

**已退回→待认领 already exists** as a poster edit (`nextPosterStatus`, tasks.ts:290-294, gates through
`POSTER_TRANSITIONS` then re-derives via `transitionTaskStatus` — belt-and-suspenders, not a second
source of truth). Handler: `apps/server/src/tasks.ts:561-606` — auth via session cookie
(`getSessionUser` + `canPostTasks`), 403 if not the task's poster (573-575), 400 `invalid_body` if
`status` isn't a valid `taskStatusSchema` member (577-580), 409 `illegal_transition` with the
Chinese message if the edge isn't in `POSTER_TRANSITIONS` (582-588), else updates `tasks.status`
and writes one `状态迁移` event with `actorUserId: user.id`, `details: { task_id, from, to }`
(590-604). Returns the updated `taskBrief`.

**History/events retention**: this PATCH never deletes or mutates `events` or `submissions` rows —
it only inserts a new `事件` and updates `tasks.status`. So "历史保留" (issue body) is **already
satisfied for this specific edge** by the existing implementation: the prior task's lease,
submission, and every audit event survive a reopen untouched.

Test coverage: `apps/server/src/tasks.test.ts:1240-1255` (`已退回 → 待认领 reopens the task`),
`:1256-1271` (`已退回 → 已取消`), `:1272-1290` (illegal 待认领→已完成 409), `:1290-1304` (待认领→进行中
is claim territory, refused here), `:1304-1320` (已取消 terminal), `:1379-1401` (reopen writes one
`状态迁移` event, asserts `details.from === '已退回'` / `details.to === '待认领'`).

**Gap vs #11's scope**: this PATCH is *poster-initiated* reopen from an *already*-已退回 task (set up
in tests via a raw `forceStatus` helper, not via any real transition into 已退回). **Nothing in the
current code ever puts a task into 已退回** — there is no caller anywhere in `apps/server/src`
that invokes `transitionTaskStatus(_, '已退回')` or sets `status: '已退回'` outside test helpers
(confirmed by grep — the only non-test locations returning `'已退回'`-typed values are the schema enum
declaration and the `POSTER_TRANSITIONS`/`LEGAL_TRANSITIONS` maps that route *through* it). **This is
the actual, sole missing wiring #11 must add**: something that drives 待验收→已完成/已退回, after
which the already-correct poster-reopen and shared-transition code just works unmodified.

## 4. `ForgeAdapter` interface vs. implementation

`packages/forge-adapters/src/index.ts:26-34` (interface, matches DESIGN §8 with one drift, see §10
below):

```ts
export interface ForgeAdapter {
  readonly kind: ForgeKind
  validateToken(cred: Credential, repo: RepoRef): Promise<TokenCheck>
  importIssue(cred: Credential, issueUrl: string): Promise<ImportedIssue>
  getPullRequest(cred: Credential, prUrl: string): Promise<PrStatus>
  registerWebhook(cred: Credential, repo: RepoRef, callback: string): Promise<void>
  parseWebhook(headers: Headers, body: unknown): ForgeEvent | null
  commentOnIssue(cred: Credential, issueRef: IssueRef, body: string): Promise<void>
}
```

`createForgeAdapter` (index.ts:45-61) wires every method except `validateToken` to
`notImplemented` (index.ts:63-65, `throw new Error('not implemented')`), **including
`getPullRequest`** — confirmed: `getPullRequest: notImplemented` at index.ts:56. There is **no
`getPullRequest` test anywhere** (`rg getPullRequest packages/forge-adapters/src/index.test.ts` →
no matches). `PrStatus` is currently `export type PrStatus = unknown` (index.ts:22, "Placeholder
until later issues define DESIGN §8 payloads").

**`validateToken`'s HTTP pattern is the one reusable precedent** (index.ts:67-140): per-kind
`apiUrl()` (github fixed `https://api.github.com`; gitlab/gitea use `options?.baseUrl ?? repo.base_url`
with `/api/v4` / `/api/v1` prefix, trailing slash stripped), per-kind `authHeaders()` (github
`Authorization: Bearer` + `User-Agent: KaolaTasks` + `Accept: application/vnd.github+json`; gitlab
`PRIVATE-TOKEN`; gitea `Authorization: token`), a shared `forgeGet()` using `globalThis.fetch`, and
per-kind response-shape branches (`githubCapabilities` / `gitlabCapabilities` / `giteaCapabilities`).
**#11's `getPullRequest` must follow the same per-kind dispatch shape** — there is no generic REST
client to reuse beyond `apiUrl`/`authHeaders`/`forgeGet`, and those are currently module-private
(not exported), so implementing `getPullRequest` either extends this file in place or factors those
three helpers out for reuse; nothing in the codebase does that extraction yet.

**Shared integration-test spec** (CLAUDE.md convention: "The three forge adapters stay
behavior-identical: one shared integration-test spec runs against all three implementations") is
realized today as `packages/forge-adapters/src/validate-token.shared.test.ts` — a single file
parameterized over `KINDS = ['github', 'gitlab', 'gitea']` (validate-token.shared.test.ts:12) that
runs the same assertions against all three adapters via `createAdapter(kind, baseUrl)`
(validate-token.shared.test.ts:49-56) and a `RecordedRequest`-capturing fetch stub. **This is the
precedent shape a `get-pull-request.shared.test.ts` should follow** if #11 implements
`getPullRequest` for real (the issue text explicitly names "轮询 adapter `getPullRequest`", so this
is in scope, not deferred).

## 5. Schema: `tasks`, `submissions`, `events`, credential decrypt path

`apps/server/src/schema.ts`:
- `tasks` (46-82): `status` enum `['待认领','进行中','待验收','已完成','已退回','已取消']` (69-71);
  `credentialProfileId` / `inlineTokenEncrypted` XOR-checked at the SQL level
  (`tasks_credential_xor`, 77-80); no `id` exposed externally, only `publicId`.
- `submissions` (104-111): `taskId` (int FK to `tasks.id`, not `publicId`), `leaseId` (int FK to
  `leases.id`), `prUrl`, `summary`, `prState: text('pr_state').notNull()` — **no `enum` constraint
  on `pr_state`** (confirmed also by `docs/api.md:242`: "no enum on `pr_state`"), so a poller can
  write `'merged'` / `'closed'` freely with no migration.
- `events` (84-90): `type`, `actorUserId: integer('actor_user_id')` (**nullable** — matches
  CLAUDE.md's "`insertAuditEvent` accepts `actorUserId: number | null`"), `createdAt`, `details`
  (JSON text). Never pruned by any code path found.

**A poller finds 待验收 rows** by querying `tasks` where `status = '待验收'` — there is no existing
helper for that; `selectTasks`/`selectTask` (`apps/server/src/tasks.ts:337-353`) select all tasks /
one by `publicId`, with no status filter (filtering happens client-side in `list_tasks`,
`apps/server/src/mcp.ts:58-77`). A poller also needs, per 待验收 task, its latest `submissions` row
for `pr_url` (and to update `pr_state`) — no `selectSubmission`-style helper exists yet either;
`submissions` is only ever inserted (claim.ts:334), never selected in production code (only in test
helpers).

**Credential decrypt path is fully precedented** — `claimTask` (claim.ts:100-140) is the template:
branch on `row.task.credentialProfileId != null` → `db.select().from(credentialProfiles)…` then
`decryptToken(profile.tokenEncrypted)`; else `decryptToken(row.task.inlineTokenEncrypted)`; catch
`isVaultUnconfiguredError(err)` and return a typed error rather than throwing raw. A poller running
outside a request context has no `AgentServiceResult` to return, so it cannot reuse that exact
return shape, but it can and should reuse `decryptToken` / `isVaultUnconfiguredError` from
`apps/server/src/vault.ts:22-30,53-65` directly, and skip a 待验收 row (log/skip, don't crash the
poll loop) when the vault is unconfigured. `revealCredentialProfile` (vault.ts:81-100) is a
different-shaped convenience (decrypt + audit in one call, used by the MCP claim path elsewhere per
CLAUDE.md) — usable if the poller wants profile-only decrypt-with-audit, but it doesn't cover the
inline-token branch, so it can't be the *only* path.

**Token hygiene**: confirmed again at the surface level — `taskBrief()` (tasks.ts:298-335) never
reads `credentialProfileId`'s or `inlineTokenEncrypted`'s plaintext, only emits the reference shape
(`{ inline: true }` or `{ profile_id: String(...) }}`, tasks.ts:324-327). Session
`GET /api/v1/tasks` / `GET /api/v1/tasks/:publicId` (tasks.ts:399-417) both call `taskBrief` and
never touch decrypt. A poller must be equally careful never to put a decrypted token into an
`events.details` blob or any HTTP response — no existing poller-adjacent code does this yet since
none exists, so this is a rule for the *new* code, not a fact about old code.

## 6. `buildApp` plugin registration order / existing timers

`apps/server/src/app.ts:28-87` (`buildApp`). Order: `createDb` → (conditional placeholder `GET /`)
→ `registerAuth` → `registerAgentKeys` → `registerCredentialProfiles` → `registerTasks` →
`registerClaim` → `registerMcp` → (conditional static/proxy). One `onClose` hook at the top
(app.ts:35-37, closes the sqlite client), registered on the **root** instance before any plugin is
registered. Per Fastify 5's documented `onClose` execution order ("child-plugin hooks execute
before parent-plugin hooks" — fastify.dev/docs/latest/Reference/Hooks/#onclose, verified against
the installed `fastify` `^5.4.0` per `apps/server/package.json:23`), `mcp.ts:232`'s own `onClose`
(registered inside its encapsulated child context, closing MCP sessions) will run **before**
app.ts's root-level db-close hook regardless of source order — a poller's `onClose` should follow
the same pattern (register inside a child `app.register(async (child) => {...})` context, mirroring
`mcp.ts:227-243`'s encapsulation) if it needs to run before the db closes; this is the verified
Fastify behavior, not an assumption. **No `setInterval` / `setTimeout`
anywhere in `apps/server/src`** (confirmed by grep across the whole directory — zero hits beyond
the `onClose` lines above). The only existing "polling"-flavored pattern in this codebase is
**on-access sweeping**, not a background timer: `sweepExpiredLeases(db)` (leases.ts:60-80) is called
synchronously at the top of essentially every mutating/listing handler (`claim.ts:81,197,240,298`,
`mcp.ts:62,80`, `tasks.ts:403,411`) rather than on any schedule. **A real interval-based poller for
待验收→PR-status has no precedent in this codebase** — #11 is the first place a `setInterval` (or
equivalent) plus a Fastify `onClose` cleanup for it would be introduced. `sweepExpiredLeases`
*does* show the pattern for the state-machine + audit-event side of it (leases.ts:71-78: guards
`task.status !== '进行中'` before transitioning, transitions via `transitionTaskStatus`, writes a
`状态迁移` event with `actorUserId: null` for system-driven changes) — this is the direct precedent
for how a poller should write its own 已完成/已退回 transitions and audit events.

## 7. Env var patterns

From `apps/server/src/auth.ts` (`registerAuth`) and `apps/server/src/vault.ts`, and confirmed by
README.md:57-66: required-at-boot vars are read directly off `process.env.X`, checked non-empty,
and throw synchronously if missing (pattern used by `registerAuth` for `SESSION_SECRET` +
6 OAuth vars). Optional/lazy vars (`VAULT_MASTER_KEY`, `PUBLIC_URL`) are read lazily at the point of
use, not at `buildApp()` boot — `vault.ts:32-42` (`readMasterKey`, throws `VaultUnconfiguredError`
only when `encryptToken`/`decryptToken` is actually called). `apps/server/src/index.ts:1-11` is
where `buildApp()` gets its options from `process.env` (`SQLITE_PATH`, `WEB_DIST`,
`VITE_DEV_TARGET`, `PORT`, `HOST`) — this is the file that would also read a poll-frequency env var
and pass it into `buildApp({ …, pollIntervalMs? })` if the frequency needs to be boot-configurable;
`buildApp`'s options object (app.ts:28-32) is the natural place to add such a field, following the
existing `sqlitePath?` / `webDist?` / `viteDevTarget?` shape (all optional, all defaulted inside
`buildApp` or the caller). No `.env.example` exists in the repo (README.md:66, "仓库没有
`.env.example`") so there's no file to update for a new poll-frequency var beyond README/docs/index.ts.

## 8. Tests that would break or should extend

- `apps/server/src/mcp.test.ts` — `submit_pr` tests (1271-1385) assert `submissions.pr_state ===
  'open'` and no lease survives; **would break** if a poller wrote to the same task's lease/status
  without respecting "no active lease while 待验收" — any new code must not resurrect a lease for
  待验收 tasks.
- `apps/server/src/claim.test.ts` — no `submit_pr` coverage at all today (confirmed: zero matches
  for `submitPr|submit_pr`); would need new tests only if #11 adds a REST endpoint (issue body
  doesn't ask for one — "轮询" is server-internal, not agent-facing).
- `apps/server/src/tasks.test.ts` — 已退回→待认领 tests (1240-1401) currently reach 已退回 only via a
  `forceStatus` test helper (direct SQL write), since nothing else produces that state. Once a
  poller can really drive a task into 已退回, an end-to-end test (submit_pr → poll → 已退回 → poster
  reopens via PATCH) becomes possible and should be added; the existing PATCH-level tests should
  keep passing unmodified since `POSTER_TRANSITIONS`/the handler aren't touched by #11's scope.
- `packages/shared/src/index.test.ts` — exhaustively covers `transitionTaskStatus`; **should not
  need to change** since all edges #11 needs already exist and are already tested.
- `packages/forge-adapters/src/index.test.ts` and `validate-token.shared.test.ts` — **will need a
  new `getPullRequest` spec** (module-level `notImplemented` today, no test); the shared-spec
  pattern in `validate-token.shared.test.ts` is the template to copy for a
  `get-pull-request.shared.test.ts` (or an extension of `index.test.ts`) covering github/gitlab/gitea
  open/merged/closed parsing.
- No poller-specific test file exists yet (`apps/server/src` has no `poller.test.ts` / similar).

## 9. REST `submit_pr`? Poll-once export?

- **No REST `submit_pr`** — verified directly (§2 above) and by `docs/api.md:181`
  ("There is no REST `POST /api/v1/tasks/:publicId/submit_pr`. `submit_pr` is MCP-only.").
- **No poll-once export exists anywhere** — grepped `apps/server/src` for `poll`, `Poll`,
  `getPullRequest`, `setInterval`: zero hits outside the interface/placeholder declarations already
  quoted in §4 and §6. There is nothing to wire up; #11 is greenfield for the poller itself.

## 10. DESIGN.md §5 / §8 vs. code — mismatches that would misroute #11 if taken literally

`docs/DESIGN.md:78-99` (§5) and `:168-192` (§8), read directly from the worktree:

- **§5 mermaid** (`docs/DESIGN.md:78-93`) shows `待验收 --> 已完成: PR 合并（webhook/轮询检测）` and
  `待验收 --> 已退回: PR 被关闭 / 验收不通过`. The "/ 验收不通过" clause implies a *second*, non-PR-status
  reason for 已退回 (e.g. a manual "reject" action) that is **out of scope for #11** per the issue
  body ("轮询 adapter `getPullRequest`" only) — literal-reading §5 could misroute an implementer into
  also building a manual-reject endpoint. **Correction**: #11 is polling-driven 已退回 only; a
  manual/rejection path, if wanted, is a separate concern not asked for by the issue body or its
  (absent) comments.
- **§8 interface snippet** (`docs/DESIGN.md:170-186`) marks `registerWebhook?(...)` as **optional**
  (`?`), but the actual `ForgeAdapter` interface (`packages/forge-adapters/src/index.ts:31`) declares
  it **required** (no `?`), and `createForgeAdapter` (index.ts:57) wires it to `notImplemented` for
  all three kinds regardless. This mismatch doesn't affect #11 directly (#11 doesn't touch
  `registerWebhook` — that's #13), but it means **the design doc's interface snippet is already
  stale against the implemented interface** and should not be treated as the literal signature
  source; the real signature is `packages/forge-adapters/src/index.ts:26-34`.
- **§8's "轮询模式"" bullet** (`docs/DESIGN.md:192`) frames polling as a *fallback* for
  "webhook 打不进来的实例" (instances webhooks can't reach), implying polling might be conditional on
  webhook-reachability config. The issue body for #11 doesn't ask for that conditionality — it asks
  for a `轮询只针对待验收任务，频率可配置` poller full stop, with webhook wiring deferred to #13 (a
  separate, later issue). **Taking §8 literally today would misroute #11 into gating the poller on
  some not-yet-built webhook-config flag; #11's own issue text overrides that** (per CLAUDE.md:
  "GitHub issues are the backlog … comments override the body" — here the body itself is the
  narrower, correct scope since #11 has no comments). The two features (poll-always vs.
  poll-only-when-webhook-absent) can be reconciled later in #13 without #11 needing to guess at it
  now.
- **§7** (`docs/DESIGN.md:154-166`) is consistent with the vault/audit code as measured in §5 above
  (no mismatch found there worth flagging).

---

## Summary index

1. Shared state machine already legal for 待验收→已完成/已退回 and 已退回→待认领 — no shared-package change needed. (`packages/shared/src/index.ts:68-81`)
2. `submitPr` MCP tool (§2) fully landed, MCP-only, releases the lease, writes `submissions.pr_state = 'open'`. (`apps/server/src/claim.ts:287-359`, `apps/server/src/mcp.ts:147-159`)
3. Poster PATCH 已退回→待认领 already exists and preserves all history (events/submissions untouched). (`apps/server/src/tasks.ts:31-34,290-294,561-606`)
4. `ForgeAdapter.getPullRequest` is `notImplemented` for all 3 kinds; no test exists; `validateToken`'s per-kind fetch pattern (`apiUrl`/`authHeaders`/`forgeGet`, currently module-private) is the template to extend. (`packages/forge-adapters/src/index.ts:26-65,67-140`)
5. Schema is poller-ready with zero migrations needed (`pr_state` is unconstrained text); no `selectSubmission`/status-filtered task query exists yet; decrypt path is precedented via `claimTask`'s branch (`decryptToken` + `isVaultUnconfiguredError`). (`apps/server/src/schema.ts:46-111`, `apps/server/src/claim.ts:100-140`, `apps/server/src/vault.ts`)
6. `buildApp` has zero existing timers; only precedent for scheduled-ish work is on-access `sweepExpiredLeases`, which is also the template for how the poller should write its own transitions + `状态迁移` events with `actorUserId: null`. (`apps/server/src/app.ts:28-87`, `apps/server/src/leases.ts:60-80`)
7. Env vars are either required-at-boot-and-checked (`registerAuth` style) or lazy-read-at-use (`VAULT_MASTER_KEY` style); a poll-frequency var fits best as an optional `buildApp()` option read from `process.env` in `index.ts`, no `.env.example` to update. (`apps/server/src/auth.ts`, `apps/server/src/vault.ts:32-42`, `apps/server/src/index.ts:1-11`)
8. Tests: `mcp.test.ts` submit_pr suite must not break (no lease resurrection); `getPullRequest` needs a new shared spec following `validate-token.shared.test.ts`'s pattern; no poller test file exists yet.
9. No REST `submit_pr`, no poll-once export anywhere — #11's poller is greenfield.
10. Two DESIGN.md clauses (§5's "验收不通过" branch, §8's webhook-conditional framing of polling) would misroute #11 if read literally; the issue's own (comment-free) body is the narrower, correct scope. One doc/code drift found independent of #11's scope: §8's `registerWebhook?` is optional in the doc but required in the actual interface.

Full detail is in this file:
`/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-11/.cache/ground-truth.md`
