# Ground truth: status write-back to source issues (#14)

Worktree measured: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-14`, HEAD `a722c8b`
(branch `workflow/issue-14`, clean working tree; `a722c8b` = "chore: archive issue-13 [sink]", on
top of `66578d6` "feat: accept signed forge webhooks and skip polling per instance" = #13,
`44eca32` "chore: archive issue-12 [sink]" on top of `9c0adbe` "feat: import forge issues into a
labeled publish draft" = #12).

Issue #14 acceptance restated: (1) 三类迁移均产生回写评论 — claim / submit-PR / complete each
produce a write-back comment; (2) write-back failure is retryable and never blocks the main flow;
(3) write-back uses the credential attached to the task.

---

## Exploration: Status write-back (#14)

### Entry Points

There is no existing entry point for write-back — it does not exist yet. The three lifecycle
transitions #14 must hook are triggered from these call sites (all already implemented and
covered by tests):

1. **认领 (claim)** — `claimTask()` at `apps/server/src/claim.ts:67-186`. Called from two places:
   - REST: `POST /api/v1/tasks/:publicId/claim` → `apps/server/src/claim.ts:365-371` (inside
     `registerClaim`, `:361-389`).
   - MCP: tool `claim_task` → `apps/server/src/mcp.ts:114-121`.
   Both call the exact same `claimTask(db, auth, publicId)` function — no duplication to keep in
   sync.

2. **提交 PR (submit PR)** — `submitPr()` at `apps/server/src/claim.ts:287-359`. Called from
   **MCP only**: tool `submit_pr` → `apps/server/src/mcp.ts:147-159`. **There is no REST HTTP
   route for this.** `registerClaim` (`apps/server/src/claim.ts:361-389`) registers exactly three
   child routes — `/claim`, `/progress`, `/release` — and no `/submit-pr` or similar. Confirmed by
   grep: `submitPr`/`submit_pr` appear only in `claim.ts`, `mcp.ts`, `mcp.test.ts`,
   `webhook.test.ts` (unrelated match), `poller.test.ts` (unrelated match) — never in a route
   registration.

3. **完成 (complete, i.e. reaching 已完成)** — `applyPrTerminalTransition()` at
   `apps/server/src/poller.ts:60-83`. Called from two places, both already sharing this one
   function (no duplicated write logic):
   - `pollPendingReviews()` → `pollOneTask()` at `apps/server/src/poller.ts:117-125`, driven by a
     `setInterval(pollIntervalMs)` registered in `apps/server/src/app.ts:51-69` when
     `buildApp({ pollIntervalMs })` is set (`apps/server/src/index.ts:21-27` wires
     `POLL_INTERVAL_MS`, default `60000`).
   - The webhook receiver `POST /api/v1/webhooks/:publicId` →
     `apps/server/src/webhook.ts:71-105`, specifically line `103`, whenever the delivery's parsed
     `ForgeEvent.state` is `merged`.

   `applyPrTerminalTransition` handles **both** terminal outcomes — `merged` → 已完成 and
   `closed` (not merged) → 已退回. The issue names only 完成 (已完成) as an acceptance target, not
   已退回; see "Absences" below for the implication.

### Execution Flow

**认领 (claim), today, no write-back:**
`claimTask()` (`apps/server/src/claim.ts:67-186`) — status check (`待批准` forbidden; task must be
`待认领`) → decrypt task credential (profile or inline, see §5 below) → update `tasks.status` to
`进行中` → insert an active lease (`insertActiveLease`, `leases.ts:23-45`) → insert two audit
events (`token 揭示` then `状态迁移`, `claim.ts:161-170`) → return `{ task, token, lease, clone }`.
A write-back call would need to be inserted after the transition is durably committed (the two
`insertAuditEvent` calls are not wrapped in `db.transaction`, unlike `applyPrTerminalTransition`),
and must not turn a successful claim into a failed one if the forge call fails.

**提交 PR (submit_pr), today, no write-back:**
`submitPr()` (`apps/server/src/claim.ts:287-359`) — lease/ownership checks → task must be
`进行中` → update `tasks.status` to `待验收` → release the lease → insert a `submissions` row
(`prUrl`, `summary`, `prState: 'open'`) → insert one `状态迁移` audit event carrying `pr_url` and
`summary` (`claim.ts:344-348`) → return `{ task, pr_url, summary }`.

**完成 (complete), today, no write-back:**
`applyPrTerminalTransition()` (`apps/server/src/poller.ts:60-83`) runs inside `db.transaction`:
update `tasks.status` → update `submissions.prState` → insert one `状态迁移` audit event with
`actorUserId: null` (system-driven, no human/agent actor) carrying `from`, `to`, `pr_url`. This is
the **one place in the codebase that already wraps a status write + audit insert in a SQLite
transaction** — the pattern to imitate if write-back needs to be transactionally consistent with
anything (though see "Absences": a forge HTTP call cannot itself be inside a SQLite transaction
usefully, since it cannot be rolled back on later DB failure and blocking the transaction on a
network call is undesirable).

Both the poller and the webhook receiver reach this same function with a `Task` row and a
`prUrl` already in hand — exactly the two ingredients (`task.repoForge`/`task.repoBaseUrl` +
`task.sourceIssueUrl`) needed to build a forge adapter and call a would-be `commentOnIssue`.

### Architecture Insights

- **Layering**: `packages/forge-adapters` (pure functions, one `ForgeAdapter` per kind, no DB, no
  Fastify) ← `apps/server/src/{claim,poller,webhook,tasks}.ts` (DB + HTTP/MCP glue) ← `mcp.ts` /
  `claim.ts`'s `registerClaim` (route registration) / `webhook.ts` (route registration). Write-back
  belongs in the second layer (server), calling into the first (adapter) — same shape as
  `getPullRequest` is called from `poller.ts` and `importIssue` from `tasks.ts`.
- **Credential resolution is duplicated three times** at present, byte-for-byte the same
  try/profile-else-inline branch: `claim.ts:107-134` (claimTask), `poller.ts:88-104`
  (`decryptTaskToken`), and `tasks.ts:520-558`/`673-705` (task creation/import, which resolves
  credentials before encryption rather than after). There is **no shared helper function** that
  takes a `Task` row and returns a decrypted token — `decryptTaskToken` in `poller.ts` is the
  closest thing (private, not exported) and already has the right shape and failure behavior
  (swallow and return `undefined`, never throw) for a non-blocking caller. `claimTask`'s version
  throws (and is caught by its own caller to translate to `vault_unconfigured`/500) because it is
  in a synchronous HTTP-response path that must return an error to the caller. Any write-back
  helper should either reuse/export `decryptTaskToken`-style resolution or add a fourth copy —
  reuse is preferable and in scope for #14 to introduce (not a scope violation; it is a private
  same-module helper today, exporting it is a small, reversible change).
- **The forge kind/baseUrl construction is uniform**: every call site does
  `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl })` (poller.ts:110,
  claim.ts implicitly does not need an adapter for claim itself, tasks.ts:561/707). A write-back
  call would do the same: `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl })`.
- **Non-blocking is not a pattern that exists elsewhere as "catch a downstream failure and keep
  going" via an explicit queue** — it exists as "the periodic/webhook driver never lets one row's
  failure abort the batch" (poller.ts:145-152, `pollPendingReviews`'s inner try/catch) and "a
  decrypt/forge failure during background polling silently skips this row and is naturally
  retried next tick" (`decryptTaskToken`'s catch-and-undefined, `fetchPrStatus`'s catch-and-
  undefined at poller.ts:106-115). This is the one true prior-art shape for "retryable, doesn't
  block": *the effect is derived idempotently from durable state on every tick, so failing once
  just means trying again next tick* — not a persisted job/queue row. See "Absences".

### Key Files

| File | Relevance |
|---|---|
| `packages/forge-adapters/src/index.ts` | `ForgeAdapter.commentOnIssue` stub (`:58`, `:85`), `IssueRef = unknown` (`:40`), host/auth helpers to reuse |
| `packages/forge-adapters/src/get-pull-request.shared.test.ts` | Closest existing shared-spec template (URL-based cred, no RepoRef) |
| `packages/forge-adapters/src/import-issue.shared.test.ts` | Closest existing shared-spec template for an *issue* URL specifically |
| `packages/forge-adapters/src/webhook.shared.test.ts` | Shows the "HEAD `<hash>`: stub still throws / type still `unknown`" comment convention |
| `apps/server/src/claim.ts` | `claimTask` (`:67`), `submitPr` (`:287`), `registerClaim` (`:361`) — no `/submit-pr` route |
| `apps/server/src/mcp.ts` | `claim_task` (`:114`), `submit_pr` (`:147`) — the only submit-PR entry point |
| `apps/server/src/poller.ts` | `applyPrTerminalTransition` (`:60`), `decryptTaskToken` (`:88`, private) |
| `apps/server/src/webhook.ts` | second caller of `applyPrTerminalTransition` (`:103`) |
| `apps/server/src/vault.ts` | `decryptToken`/`encryptToken` (`:44`,`:53`), `insertAuditEvent` (`:73`), `AuditEventWriter` type (`:71`), `revealCredentialProfile` (`:87`, unused by claim/poller — they inline the same logic) |
| `apps/server/src/schema.ts` | `tasks` (`:46`), `events` (`:84`), `submissions` (`:104`) table shapes |
| `apps/server/src/tasks.ts` | `POST /api/v1/tasks` persists (`:499`), `POST /api/v1/tasks/import` previews only, never persists (`:641`) |
| `apps/server/src/app.ts` | `buildApp` wiring, poller interval registration (`:44-70`) |
| `apps/server/src/auth.ts` | `PUBLIC_URL` read (`:243`), module-private, not exported |
| `docs/DESIGN.md` §5, §8, §10 | 回写 is named in the design (state machine note + `events` table types) but not yet coded |
| `package.json` | root `test` script — exact current file list |

### Dependencies

- **`@kaola/forge-adapters`** (`packages/forge-adapters/src/index.ts`) — the only package that
  will need a real `commentOnIssue` implementation. No new external HTTP client: it uses
  `globalThis.fetch` exactly like every other adapter method (`forgeGet`, `forgePost`).
- **No comment-specific npm dependency exists or is needed** — GitHub/Gitea/GitLab REST "add a
  comment/note to an issue" are plain POST-with-JSON-body calls, same shape as `forgePost`
  (`index.ts:330-341`), which already exists and is reused by `registerWebhook`. (The exact
  per-forge endpoint path and body key are NOT verified against live forge docs here — that
  is knowledge-lookup/tdd-guide territory, not code-explorer territory. Do not assume payload
  shapes based on this report; only the *existing adapter plumbing* — `forgePost`, `authHeaders`,
  `apiUrl`/`prApiOrigin`, `splitFullName` — is verified from source.)
- **`@kaola/shared`** — `transitionTaskStatus` is unrelated to write-back (governs status graph
  only); no new shared-package dependency is implied by #14.
- **Internal reuse candidates**: `poller.ts`'s `decryptTaskToken` (credential resolution),
  `vault.ts`'s `insertAuditEvent` (audit), `createForgeAdapter` (adapter construction),
  `AuditEventWriter` type (`vault.ts:71`, already supports both a bare `AppDb` and a transaction
  handle — usable if write-back logging is done inside `applyPrTerminalTransition`'s transaction).

---

## 1. `commentOnIssue` / `IssueRef` / adapter wiring (verified against source)

`packages/forge-adapters/src/index.ts`:

```51:59:packages/forge-adapters/src/index.ts
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

`IssueRef` (`:40`): `export type IssueRef = unknown` — no shape at all. Two live precedents exist
for what it *could* be instead of `unknown`:
- URL-string, like `getPullRequest(cred, prUrl: string)` and `importIssue(cred, issueUrl: string)`
  — both take the pasted web URL and parse owner/repo/number (or namespace/iid) internally
  (`parseGithubPrUrl`/`parseGiteaPrUrl`/`parseGitlabMrUrl` at `:142-164`,
  `parseOwnerRepoIssueUrl`/`parseGitlabIssueUrl` at `:400-418`). This matches what the server
  actually has on hand: `task.sourceIssueUrl` is a URL string, not a structured ref.
- A structured `{ full_name, number }`-ish object, like `RepoRef` (`:11-14`) — would require the
  caller to parse the URL itself (duplicating logic already in `parseIssueUrl`, exported at
  `:420-430`, which returns `{ full_name }` only, not a number/iid).

`createForgeAdapter` (`:71-87`) wires every other method to a real `kind`-dispatching function,
but `commentOnIssue` is unconditionally `notImplemented` (`:85`), which is:

```89:91:packages/forge-adapters/src/index.ts
function notImplemented(): never {
  throw new Error('not implemented')
}
```

This is **not per-kind** — the same throwing stub is assigned regardless of `kind`. Whatever
replaces it needs the same `kind`-dispatch shape as `validateToken`/`importIssue`/`getPullRequest`
(`:80-84`), i.e. `commentOnIssue: (cred, issueRef, body) => commentOnIssue(kind, options, cred, issueRef, body)`.

**Host selection precedent** (verified, three call sites all agree):
- `prApiOrigin(kind, options)` (`:166-169`): GitHub is unconditionally `GITHUB_API_ORIGIN =
  'https://api.github.com'` (`:67`); GitLab/Gitea use `options?.baseUrl` (the constructor option),
  **never** anything parsed from the pasted URL's own host. This is asserted by dedicated tests in
  both shared specs (see §2) with an explicit anti-SSRF framing ("must never fetch the pasted …
  host (SSRF)", `import-issue.shared.test.ts:543-546`).
- `resolveImportedIssue` (`:432-466`) and `prApiUrl` (`:171-195`) both call `prApiOrigin` for the
  origin, then build a REST path from parsed owner/repo/number or namespace/iid.
- A `commentOnIssue` implementation should follow the exact same rule: never trust a host baked
  into the issue URL/ref; always use `prApiOrigin(kind, options)`.

**Auth headers** (`authHeaders`, `:522-534`, reused unchanged by every adapter method):
- GitHub: `Authorization: Bearer <token>`, `User-Agent: KaolaTasks`, `Accept:
  application/vnd.github+json` (constants at `:67-69`).
- GitLab: `PRIVATE-TOKEN: <token>`.
- Gitea: `Authorization: token <token>`.

**Fetch helpers**: `forgeGet` (`:536-541`, GET + `authHeaders`) and `forgePost` (`:330-341`, POST +
`authHeaders` + `Content-Type: application/json` + `JSON.stringify(body)`), both wrapping
`globalThis.fetch` — this is exactly what mocked-`fetch` tests intercept (see §2). `registerWebhook`
already uses `forgePost` for a POST-with-JSON-body call per kind (`:343-385`), which is the closest
existing precedent for what a `commentOnIssue` POST would look like structurally (three
`if (kind === …)` branches each building their own URL + body, then one shared
`forgePost`/status-check tail).

**Error handling convention** (uniform across `importIssue`, `getPullRequest`,
`registerWebhook`): a non-`.ok`/non-200 response throws `Error(`<methodName>: ${kind} responded
${res.status}`)` — never returns a sentinel. `tasks.ts`'s `forgeResponseStatus` (`:248-253`)
parses that exact message shape back out with a regex (`/responded (\d+)\s*$/u`) to recover the
HTTP status for its own error-mapping — so if write-back logic ever needs to distinguish e.g. a
404 (issue deleted) from a 401 (token revoked) from a 5xx, that same regex-on-message pattern is
the only mechanism that exists; there is no typed error class carrying a status code anywhere in
`forge-adapters`.

## 2. Existing shared adapter test pattern (for a later tdd-guide to match)

Three files exist, one per adapter method added since M1, all in
`packages/forge-adapters/src/*.shared.test.ts`, one level up from `index.ts`, imported as
`./index.ts`:

- `validate-token.shared.test.ts` (earliest; other files explicitly say "mirroring
  validate-token.shared.test.ts's fetch-stub shape" and then **duplicate its helpers rather than
  import them** — every shared-spec file is self-contained by convention).
- `get-pull-request.shared.test.ts` (issue #11) — verified in full above.
- `import-issue.shared.test.ts` (issue #12) — verified in full above.
- `webhook.shared.test.ts` (issue #13).

Common shape across all of them (confirmed by reading get-pull-request and import-issue in full,
and skimming webhook's header):

1. A top-of-file comment naming the issue, saying which prior file's fetch-stub shape it mirrors,
   and explicitly instructing **not to import that file** — helpers are copy-pasted and trimmed
   per file, not shared via a common test-utils module. (`get-pull-request.shared.test.ts:6-8`,
   `import-issue.shared.test.ts:6-8`, `webhook.shared.test.ts:7-10`.)
2. `webhook.shared.test.ts` additionally pins the exact HEAD short hash and current stub behavior
   in its header comment (`webhook.shared.test.ts:12-17`: `"HEAD `44eca32b`: both methods throw
   new Error('not implemented') synchronously for every kind, and ForgeEvent is unknown."`) and
   explicitly warns that a bare `assert.rejects`/`assert.throws` with no predicate would pass
   against today's stub and must not be used — a real behavioral assertion (predicate function
   checking `err.message !== 'not implemented'` or similar) is required. **This is the exact
   trap a `comment-on-issue.shared.test.ts` must also avoid**, since `commentOnIssue` is
   currently `notImplemented` (throws `'not implemented'` for every kind) — any "rejects" test
   must assert the rejection is NOT the placeholder message.
3. `KINDS = ['github', 'gitlab', 'gitea'] as const`; `WEB_ORIGIN` / `CUSTOM_BASE_URL` per-kind
   constant maps; `tokenFor(kind)` (github uses a `github_pat_…`-prefixed fake, others
   `'test-token'`); `credential(kind)` → `{ token }`.
4. `createAdapter(kind, baseUrl?)`: for `github`, `baseUrl` is only passed through as
   `{ baseUrl }` when explicitly given (github ignores it for real requests but the option is
   still accepted); for gitlab/gitea, always passes `{ baseUrl: baseUrl ?? WEB_ORIGIN[kind] }`.
5. `installFetch(t, respond)`: uses `t.mock.method(globalThis, 'fetch', …)` (Node's built-in
   `node:test` mocking, not a third-party fetch-mock library), recording `{ url, method, headers }`
   for every call via helper functions `requestUrl`/`requestMethod`/`requestHeaders` that handle
   both a `Request` object and a `(url, init)` call signature. Returns the array of recorded
   requests so a test can assert `requests.length` and inspect each entry.
6. `jsonResponse(body, status=200)`: constructs a real `Response` via `new Response(JSON.stringify(body), {...})`.
7. Per-kind URL builders (`githubIssueUrl`/`giteaIssueUrl`/`gitlabIssueUrl` +
   `githubApiUrl`/`giteaApiUrl`/`gitlabApiUrl`) and an `assertAuthHeader(kind, headers, token)`
   helper checking the exact three header shapes from §1 above.
8. `describe('<method> shared spec', () => { for (const kind of KINDS) { describe(kind, () => {
   it(...) } } })` — per-kind `describe` blocks nested inside one outer `describe`, then
   kind-specific edge-case `it`s outside the loop (e.g. "github: always calls api.github.com
   regardless of a custom baseUrl option").
9. Both files assert the **anti-SSRF** property explicitly for gitlab/gitea: constructor
   `baseUrl` is the API origin, and the pasted-URL host (even a totally different "other-host")
   must never be fetched (`import-issue.shared.test.ts:517-548`,
   `get-pull-request.shared.test.ts:323-342`). A `comment-on-issue.shared.test.ts` should include
   the same assertion for whatever `IssueRef`/URL shape it settles on.

A file named `packages/forge-adapters/src/comment-on-issue.shared.test.ts` following this exact
template is the expected shape for #14's adapter-level tests, appended to the root `test` script
the same way #11/#12/#13 did (see §9).

## 3. How imported tasks store the source Issue URL

`apps/server/src/schema.ts:46-82`, `tasks` table:
- `sourceType: text(..., { enum: ['native', 'imported'] }).notNull()` (`:53`)
- `sourceIssueUrl: text('source_issue_url')` — **nullable**, no enum/format constraint (`:54`)
- `repoForge: enum(['github','gitlab','gitea']).notNull()` (`:55`)
- `repoBaseUrl: text().notNull()` (`:56`)
- `repoFullName: text().notNull()` (`:57`)

**`POST /api/v1/tasks/import`** (`tasks.ts:641-747`) is a **pure preview** — comment at `:640`:
*"Issue #12: pre-publish draft. Does not persist a task and does not call validateToken."* It
calls `adapter.importIssue` and returns a JSON body shaped like a draft brief
(`title`/`description_md`/`source`/`repo`), but **writes nothing to the `tasks` table**.

**`POST /api/v1/tasks`** (`tasks.ts:499-638`) is the only route that persists a task, for both
native and imported sources. `readSource` (`:115-125`) accepts `{ type: 'native' }` (default when
omitted) or `{ type: 'imported', issue_url: <string> }` from the request body. `insertTask`
(`:614-635`) sets:
```618:sourceIssueUrl: input.source.type === 'imported' ? input.source.issueUrl : null,
```
— i.e. the client (the web posting form, having already called `/tasks/import` to fetch a
preview) re-submits the same `issue_url` on the real `POST /api/v1/tasks` call; there is no
server-side link between an `/import` preview call and the later persist call — they are two
independent requests, and the server trusts whatever `source.issue_url` the create call sends.

**Distinguishing an imported task from a handmade one, at read time**: yes, unambiguous —
`task.sourceType === 'imported'` (and then `task.sourceIssueUrl` is guaranteed non-null by how
`insertTask` writes it; a native task's `sourceIssueUrl` is always `null`). `taskBrief()`
(`tasks.ts:378-415`) projects this as `source: { type: 'imported', issue_url: … }` vs
`{ type: 'native' }` (`:383-386`).

**`repo.base_url`/`repo.full_name`/`repo.forge`** are available directly on the `Task` row
(`repoForge`, `repoBaseUrl`, `repoFullName`) for every task, imported or native — a write-back
implementation reading a `Task` row already has everything `createForgeAdapter(task.repoForge, {
baseUrl: task.repoBaseUrl })` needs, plus `task.sourceIssueUrl` as the comment target.

## 4. Claim / submit-PR / complete call sites (contract-preserving hook points)

Verified precisely (see "Entry Points" and "Execution Flow" above for full detail); summary
table:

| Transition | Function | Called from | HTTP/MCP contract |
|---|---|---|---|
| 认领 | `claimTask` (`claim.ts:67`) | `POST /api/v1/tasks/:publicId/claim` (`claim.ts:365`) AND MCP `claim_task` (`mcp.ts:114`) | Both share one function; a write-back call inside it affects both surfaces identically, no duplication risk |
| 提交 PR | `submitPr` (`claim.ts:287`) | **MCP `submit_pr` only** (`mcp.ts:147`) | **No REST route exists.** `registerClaim` only registers `/claim`, `/progress`, `/release` (`claim.ts:361-389`). A write-back hooked into `submitPr` itself (not into a route handler) automatically covers the one real entry point and needs no REST-vs-MCP duplication handling. |
| 完成 (已完成) | `applyPrTerminalTransition` (`poller.ts:60`, `terminal === 'merged'` branch) | poller tick (`poller.ts:124`) AND webhook receiver (`webhook.ts:103`) | Both share one function; hooking inside it covers both without duplication. **Also fires for `已退回`** (terminal === 'closed') — issue #14 names only 完成, not 已退回, as an acceptance target; see Absences. |

`release_task`/`退回` are explicitly out of scope per the issue statement ("Note: issue says 认领
/ 提交 PR / 完成 — not release, not 已退回") — `releaseTask` (`claim.ts:234-285`) and the
`已退回` branch of `applyPrTerminalTransition` should not gain write-back calls under a literal
reading of #14's three-transition list, though `applyPrTerminalTransition` cannot easily have
write-back added to only its `merged` branch without either duplicating the function or adding an
`if` inside it — this is a design decision to flag, not resolve here.

## 5. Credential reveal for a task — reuse path (verified end-to-end)

Three near-identical implementations of "resolve a task's plaintext forge token", none exported
as a single shared helper:

1. **`claim.ts:100-140`** (inside `claimTask`) — throws on failure (profile missing, vault
   unconfigured, xor-violation), caught by its own caller to map to a 500
   `{ error: 'vault_unconfigured' }` HTTP response. Blocking/synchronous-HTTP shape.
2. **`poller.ts:88-104`**, `decryptTaskToken(db, task)` — **the best-fitting precedent for
   write-back**, because it already has "never throw, return `undefined` on any failure" semantics
   (comment at `:85-87`: *"any failure here (vault unconfigured, missing profile, corrupt
   ciphertext) skips this row rather than throwing out of the poll loop — there is no HTTP request
   to fail on the poller's behalf"*). It is **not exported** (module-private function in
   `poller.ts`) — exporting it (or an equivalent) is the natural reuse move for #14, since claim,
   submit-PR, and complete-via-poller/webhook all need exactly this "give me a token or nothing,
   never throw" behavior for a *non-blocking* side effect.
3. **`tasks.ts:520-558` / `:673-705`** (task creation/import) — resolves credential to validate a
   *fresh* plaintext token before encrypting/persisting; not a "read back an existing task's
   token" case, least relevant precedent.

**Vault mechanics** (`vault.ts`): `VAULT_MASTER_KEY` (64 hex chars) read lazily inside
`readMasterKey()` (`:32-42`), throwing `VaultUnconfiguredError` if absent/malformed — never
required at `buildApp()` boot. `decryptToken`/`encryptToken` (`:44-65`) are AES-256-GCM,
IV(12)+ciphertext+tag(16) base64-packed. `isVaultUnconfiguredError` (`:22-30`) is the type guard
every caller uses to special-case that one failure mode.

**Proof tokens never leak** (verified by reading, not assumed):
- `insertAuditEvent`'s callers for claim/submit/complete only ever pass small structured facts:
  `{ task_id, agent_key_id, credential: 'inline'|'profile', profile_id? }` (token-reveal event,
  `claim.ts:118-133`), `{ task_id, from, to }` (`claim.ts:169`, `poller.ts:80`), `{ task_id, from,
  to, pr_url, summary }` (`claim.ts:347`) — never the plaintext `token`/`plaintext` variable
  itself. Grepping `insertAuditEvent(` across `apps/server/src` confirms every call site's
  `details` object is a hand-built literal with named fields, never a passthrough of a credential
  variable.
- HTTP responses: `claimTask`'s body legitimately **does** include `token: plaintext`
  (`claim.ts:178`) — this is the one documented exception (DESIGN.md §7 "认领时揭示"), and
  `claim.test.ts`/`mcp.test.ts` both have an `assertNoForgeSecretMaterial(res, ...plaintexts)`
  helper (`claim.test.ts:541-556`, `mcp.test.ts:467-482`) used on every *other* endpoint
  (list/get/progress/release) to assert the plaintext string never appears in the response body
  and that no key named in a `SECRET_KEY_NAMES` set appears anywhere in the parsed JSON. This
  helper is the direct precedent a `comment-on-issue`-related test should reuse/extend to prove a
  write-back call site never echoes the token back in its own response or audit event.
- Logs: no `console.log`/`app.log` call anywhere in `claim.ts`, `poller.ts`, `webhook.ts`, or
  `vault.ts` references a decrypted token variable (grep confirms — the only identifiers named
  `plaintext`/`token` are used for adapter calls, response bodies, or the one documented claim
  response field).

## 6. `events` / `insertAuditEvent` — current state

`schema.ts:84-90`:
```84:90:apps/server/src/schema.ts
export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  actorUserId: integer('actor_user_id'),
  createdAt: integer('created_at').notNull(),
  details: text('details').notNull(),
})
```
`type` is a free-form `text`, **not** a SQLite/Drizzle enum — no compile-time check on event type
strings. Current event type string constants (all string literals, not a shared enum export):
`'状态迁移'` (claim.ts, tasks.ts, poller.ts, leases.ts), `'token 揭示'` (claim.ts, tasks.ts,
vault.ts's `revealCredentialProfile`), `'心跳'` (claim.ts). **No `'回写'` event type exists in
code anywhere** — confirmed by grepping `回写` across the whole worktree: it appears only in
`docs/DESIGN.md` (§5's prose and §10's table cell "类型（状态迁移 / token 揭示 / 心跳 / 回写）")
and in prior archived `kaola-workflow/archive/*/.cache/*.md` reports (design-measurement notes
from earlier issues, not code). **The design already anticipates a `回写` event type; #14 is
where it would first be introduced into code.**

`insertAuditEvent(db, { type, actorUserId, details })` (`vault.ts:73-85`) — `actorUserId: number |
null` (confirmed by its type signature and by `poller.ts`'s system-driven calls passing `null`,
`poller.ts:79`, `leases.ts:76`). `db` param is typed as `AuditEventWriter = { insert:
AppDb['insert'] }` (`vault.ts:71`) — a structural subset so a `db.transaction((tx) => …)` handle
can be passed directly, exactly as `applyPrTerminalTransition` does
(`poller.ts:74-82`, passing `tx`). This means a write-back audit event *can* be inserted inside
the same transaction as `applyPrTerminalTransition`'s status write, if write-back is done
synchronously there — but see §7/Absences for why a synchronous forge HTTP call inside that
transaction is not free of trade-offs.

## 7. Retry / non-blocking patterns already in the server

**Explicitly verified: there is no retry queue, job table, or backoff mechanism anywhere in this
codebase.** Grepping `retry|Retry|backoff|queue|Queue` across `apps/server/src` turns up exactly
one hit, and it is unrelated to network retries: `tasks.ts:43-45`, a bounded loop
(`PUBLIC_ID_ATTEMPTS = 5`) retrying `public_id` allocation on a synchronous SQLite UNIQUE-
constraint collision (`isPublicIdCollision`, `:451-454`) — a same-process, same-transaction retry
of a DB insert, nothing to do with an external HTTP call or a durable "pending" state.

The only pattern that resembles "keep trying, don't block" is **implicit and periodic**, not a
queue:
- `pollPendingReviews` (`poller.ts:135-153`) re-derives everything from current DB state
  (`SELECT … WHERE status = '待验收'`) on every tick; if one task's forge call fails
  (`fetchPrStatus` catches and returns `undefined`, `:106-115`), that task is simply left as-is
  and re-evaluated fresh on the next tick — there is no persisted "this failed, retry me" marker;
  the retry *is* the next poll of the same durable state.
- `pollPendingReviews`'s outer try/catch (`:145-152`) additionally ensures one row's *unexpected*
  throw (not just the caught-and-`undefined`'d forge/decrypt failure) doesn't abort the batch for
  the rest.
- The `setInterval` registration in `app.ts:51-69` has its own re-entrancy guard (`polling`
  boolean) so a slow tick can't overlap the next one.

**Do not invent a job queue, retry table, or exponential-backoff scheduler for #14** — none
exists, and introducing one is a much bigger surface than "add a write-back call" implies. The
two realistic reuse-shaped options visible in the current codebase are: (a) best-effort inline
(catch the forge call's rejection at the call site, log/record failure via an audit event, never
propagate to the caller — exactly `decryptTaskToken`'s catch-and-swallow shape) or (b) a periodic
sweep in the same spirit as `pollPendingReviews`, driven off some new "not yet write-back'd"
condition derived from existing/new durable columns. Neither currently exists; both are
implementation decisions for #14 itself, not something already built to hook into.

## 8. Public URL / task permalink

**No existing helper builds a 考拉任务链接.** `PUBLIC_URL` is read exactly once in the whole
codebase, inside `registerAuth`'s closure:
```243:apps/server/src/auth.ts
  const publicUrl = trimTrailingSlash(process.env.PUBLIC_URL ?? 'http://localhost:31415')
```
`publicUrl` is a **local `const`, not exported**, used later in the same function only to build
OAuth `redirect_uri`s. No module exports a `taskUrl(publicId)`-style function, and nothing else in
the server reads `process.env.PUBLIC_URL`. `task.publicId` (schema.ts:50, format `kt-YYYY-NNNN`,
allocated by `nextPublicId`, `tasks.ts:437-449`) is the only stable identifier that would go into
such a link; there is no known-correct path segment for a task detail page to append to it,
because the web app (per always-applied CLAUDE.md context) has no vue-router / task-detail route
at all in the member workbench as of the last documented state — this would need to be checked
against the current `apps/web` routing if a real clickable link (not just a bare `id`) is wanted,
which is outside what this report was scoped to verify (`apps/web` was not read for this report).

**Reuse recommendation**: build a small `publicUrl(env) + '/tasks/' + task.publicId`-shaped helper
near `PUBLIC_URL`'s existing read site or export `publicUrl` from `auth.ts`, rather than adding a
third independent `process.env.PUBLIC_URL` read. Confirm with a web-side check (out of this
report's scope) whether `/tasks/:id` is a real route before hard-coding that path into a
comment body.

## 9. Root `test` script — exact current command

`package.json:13` (single line, reproduced verbatim, `&&`-chained onto the web test run):

```
node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts packages/forge-adapters/src/get-pull-request.shared.test.ts packages/forge-adapters/src/import-issue.shared.test.ts packages/forge-adapters/src/webhook.shared.test.ts apps/server/src/import.test.ts apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts apps/server/src/tasks.test.ts apps/server/src/hosting.test.ts apps/server/src/claim.test.ts apps/server/src/mcp.test.ts apps/server/src/poller.test.ts apps/server/src/webhook.test.ts && pnpm --filter @kaola/web test
```

This is **already newer than the always-applied CLAUDE.md snapshot** quoted in this session's
system context (which lists a shorter, #9-era file set) — that snapshot is stale relative to this
worktree; the file list above, read directly from `package.json` in the worktree, is ground truth.
A new `comment-on-issue.shared.test.ts` (adapter-level) and any new/renamed server-level test file
for write-back would each need one more path token appended to this space-separated list, in the
same position other `*.shared.test.ts` files occupy (grouped with the other forge-adapters tests,
before the `apps/server` block) or the same position other `apps/server/src/*.test.ts` files
occupy, following existing ordering (roughly: package tests, then server tests in the rough order
features were added — `import`, `placeholder`, `auth`, `agent-keys`, `vault`, `tasks`, `hosting`,
`claim`, `mcp`, `poller`, `webhook`).

## 10. What would make a naive "just call commentOnIssue in claimTask" wrong

1. **Handmade (native) tasks have no `sourceIssueUrl`** (`schema.ts:54`, nullable; `null` for
   `sourceType === 'native'`, confirmed at `tasks.ts:618`). A write-back call must be gated on
   `task.sourceType === 'imported'` (and, defensively, `task.sourceIssueUrl != null`) — otherwise
   every claim/submit/complete on a native task would either call `commentOnIssue` with a
   nonsensical target or need a null-check added ad hoc at each of the three call sites.
2. **Credential resolution can fail** (vault unconfigured, profile row deleted since the task was
   created, corrupt ciphertext) — `decryptTaskToken`'s three-way failure handling (`poller.ts:88-
   104`) already accounts for this by returning `undefined`; a write-back call inserted into
   `claimTask` naively (which currently *throws* on these same failures, `claim.ts:135-140`,
   because it's on the "reveal token to the claiming agent" hot path) must not let a write-back-
   specific credential failure fail the claim itself — the credential is already known-good at
   that point in `claimTask` (it just got decrypted successfully to return to the agent), so this
   specific risk is actually low for the *claim* path, but real for `applyPrTerminalTransition` if
   write-back needs its *own* credential lookup there (that function currently receives no
   credential at all — it only gets `task`, `submissionId`, `terminal`, `prUrl`).
3. **The forge adapter call can throw for many reasons** — 404 (issue deleted since import), 401
   (token revoked/rotated since claim), 5xx, network failure, or an unparseable `issueUrl`/`IssueRef`
   (see `resolveImportedIssue`'s per-kind throw conditions, `index.ts:432-466`, as the direct
   precedent for what "unparseable" looks like for issue URLs specifically). None of `claimTask`,
   `submitPr`, or `applyPrTerminalTransition` currently have a try/catch shaped to swallow *this
   specific new call* without also swallowing or being confused with their existing error paths —
   inserting an unguarded `await adapter.commentOnIssue(...)` into any of the three would turn a
   successful status transition into a 500/thrown-out-of-poller-tick failure the moment the forge
   is unreachable, which directly violates acceptance criterion (2) ("回写失败可重试且不阻断主流程").
4. **MCP vs REST duplication is a non-issue for 认领 and 完成** (both already funnel through one
   shared function each — `claimTask`, `applyPrTerminalTransition`) but **is real for 提交 PR**,
   because `submitPr` itself is the only real entry point (no REST route calls it) — so hooking
   write-back inside `submitPr` itself (rather than inside a route handler) is correct and
   sufficient; hooking it inside `mcp.ts`'s `submit_pr` tool registration instead would be the
   wrong layer (couples write-back to MCP specifically, for no reason, since there's no REST
   caller to also cover).
5. **`applyPrTerminalTransition` covers both 已完成 and 已退回** in one function
   (`terminal: 'merged' | 'closed'`, `poller.ts:60-83`) — the issue's acceptance criterion (1)
   names only 完成/已完成 as one of the "three transitions," so adding write-back unconditionally
   inside this shared function would also silently satisfy (or over-satisfy) a 已退回 comment that
   the issue didn't ask for. This is a scope question for the implementer/planner, not something
   this report resolves — flagged as a decision point, not a defect.
6. **No transaction currently spans a forge HTTP call** anywhere in this codebase — the one
   existing `db.transaction(...)` usage (`applyPrTerminalTransition`) wraps only synchronous
   SQLite statements. A network call inside a `better-sqlite3` synchronous transaction would hold
   a write lock on the whole DB file for the duration of that network call, which is a real
   concern for a self-hosted internal tool's concurrency but not something previously exercised in
   this code — worth flagging to whoever designs the write-back's transaction boundary rather than
   assuming today's transaction pattern generalizes safely to "and also make an HTTP call here."

## Recommendations for New Development

Kept strictly inside #14's stated scope (claim / submit-PR / complete write-back comments; retry-
without-blocking; use the task's own credential) — not proposing #15 (audit-log UI) or #16
(claim-confirmation policy) work:

- **Reuse, don't reinvent, credential resolution.** Export (or extract to a shared location)
  `poller.ts`'s `decryptTaskToken(db, task) → string | undefined` shape — it already has the
  right "never throw" contract for a non-blocking side effect and is usable from `claimTask`,
  `submitPr`, and `applyPrTerminalTransition` alike, none of which currently share this logic.
- **Reuse `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl })`** exactly as
  `poller.ts:110` and `tasks.ts:561/707` already do — no new adapter-construction logic needed.
- **Reuse the `forgePost`/`authHeaders`/`prApiOrigin` plumbing inside `forge-adapters/src/index.ts`**
  when implementing `commentOnIssue` for real — do not add a second fetch wrapper or new auth-
  header logic; follow `registerWebhook`'s three-`if`-branches-then-shared-POST-helper shape.
- **Give `IssueRef` a concrete shape before implementing `commentOnIssue`** — the URL-string
  precedent (`getPullRequest`/`importIssue`) fits what the server actually has
  (`task.sourceIssueUrl`) better than inventing a structured ref that would require parsing
  the URL at the call site instead of inside the adapter. This is a real API-surface decision
  (changes an exported type) — flag it explicitly rather than silently picking one, per this
  project's "escalate irreversible changes" rule (public package type change).
- **Add `comment-on-issue.shared.test.ts`** to `packages/forge-adapters/src/`, following the
  exact template documented in §2, appended to the root `test` script per §9 — this is
  `tdd-guide`'s job, not `implementer`'s, per this repo's custody split.
- **Add a `回写` audit event type** when a write-back comment is actually posted (success or
  terminal failure) — the design already names this type (`docs/DESIGN.md` §10); reuse
  `insertAuditEvent`'s existing `AuditEventWriter`-typed `db` parameter (works with both a bare
  `AppDb` and a `tx` handle) rather than inventing new audit plumbing.
- **Implement "retryable, non-blocking" as catch-and-record, not a new queue.** No retry/queue
  infrastructure exists (§7) and building one is out of proportion to #14. A defensible in-scope
  approach: wrap the `commentOnIssue` call in try/catch at each of the three hook points, record
  success/failure via a `回写` audit event either way, and never let the catch propagate past the
  status-transition's own success — with retry handled either by (a) a periodic sweep modeled on
  `pollPendingReviews`'s existing shape (re-derive "needs write-back" from durable state each
  tick) or (b) an explicitly simpler "best effort now, no automatic retry beyond that" if the
  planner judges that sufficient for acceptance criterion (2)'s "可重试" wording (a human-
  triggered manual retry action would also satisfy "可重试" without any background scheduler).
  This is a design decision for the planner, not something this report should resolve.
- **Decide, explicitly, whether `applyPrTerminalTransition`'s `已退回` branch also gets write-back**
  (see Absences #10.5) before implementing — the issue names only 完成.
- **Do not add a REST `/submit-pr` route as a side effect of #14.** `submit_pr` is MCP-only today
  by design (or at least, by current state); hooking write-back into `submitPr()` itself (not into
  `mcp.ts`) naturally covers the one real entry point without expanding the HTTP contract, which
  this issue's constraints require avoiding ("must hook WITHOUT changing their HTTP contracts").
- **Verify the real per-forge "create issue comment" endpoint and payload shape via
  knowledge-lookup before implementing** — this report deliberately did not fabricate GitHub
  `/issues/{n}/comments`, GitLab `/issues/{iid}/notes`, or Gitea `/issues/{index}/comments`
  request/response shapes; only the adapter's existing internal plumbing (`forgePost`, headers,
  host rules) was verified from source.

## Absences (do not invent)

- **No REST route calls `submitPr`.** Confirmed by reading `registerClaim` in full
  (`claim.ts:361-389`) — only `/claim`, `/progress`, `/release` exist. `submit_pr` is MCP-tool-only.
- **No retry queue, job table, or backoff scheduler exists anywhere in `apps/server`.** The only
  "retry" in the codebase is a bounded same-transaction public-id collision retry
  (`tasks.ts:43-45`), unrelated to network calls. Do not invent a queue for #14.
- **No `回写` event type exists in code** — only named in `docs/DESIGN.md` §5/§10 as a forward-
  looking design note. `events.type` is untyped free text, so adding the string is a small,
  additive change, not a schema migration.
- **No exported helper resolves a task's decrypted credential.** Three separate inline
  implementations exist (`claim.ts`, `poller.ts`'s private `decryptTaskToken`, `tasks.ts`); none
  is shared.
- **No helper builds a 考拉任务链接 / task permalink.** `PUBLIC_URL` is read once, privately,
  inside `auth.ts`'s `registerAuth` closure, for OAuth callbacks only. Whether `apps/web` even has
  a task-detail route to link to was **not verified** in this report (out of scope as given —
  focus was server/adapter ground truth); check before hard-coding a link path.
- **`IssueRef` has no shape** (`= unknown`) and `commentOnIssue` is unconditionally
  `notImplemented()` for every `kind` — there is nothing partially built to extend; this is a
  from-scratch implementation inside the existing `ForgeAdapter` interface slot.
- **No existing test file for `commentOnIssue`** — `index.test.ts` was grepped for
  `commentOnIssue`/`IssueRef` and has zero matches; no partial/skipped test exists to resume.
- **No transaction in this codebase currently spans a network call.** The one `db.transaction`
  user (`applyPrTerminalTransition`) is synchronous-only. Don't assume that pattern generalizes
  for free to "transaction + forge HTTP call."
- **`apps/web` was not read for this report** — any claim about whether a task detail page /
  router exists to build a permalink against is deferred, not asserted, here.
- **Real per-forge comment/note API request+response shapes were not verified against forge
  documentation** — only the adapter's existing internal plumbing was verified from source. Do
  not treat this report as confirming GitHub/GitLab/Gitea's actual comment-creation wire format.
