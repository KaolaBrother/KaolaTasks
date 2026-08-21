# Ground Truth for Issue #13 — Webhook receivers + configurable polling fallback

**Repo**: `/Users/ylpromax5/Workspace/KaolaTasks`
**Worktree measured**: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-13`
**Worktree branch**: `workflow/issue-13`
**Worktree HEAD**: `44eca32b297d8aa15e3966c1bb29090ce6e336cb` (2026-08-21 19:40:00 +0800)
**Worktree status at measurement time**: clean (`git status --short` empty)

Issue #13 (P2, M2): "Webhook receivers (signature checks) + configurable polling fallback." Acceptance: (1) bad signature/secret requests rejected; (2) webhook PR-merge events correctly complete a task; (3) mode is configurable per forge instance and actually takes effect. Design refs: `docs/DESIGN.md` §8, §11, §14. Issue has no comments — body stands as written. **Out of scope per task instructions: issue #14 (status write-back / `commentOnIssue`)** — not measured here beyond confirming it also throws `not implemented`.

This document states what exists **now** in the worktree. It does not propose a design. Every "does not exist" below was confirmed by reading the named file, not inferred.

---

## Entry Points

There is exactly one process entry point for the server, and today it has **no webhook entry point at all**:

- `apps/server/src/index.ts:1-17` — reads env, calls `buildApp({ sqlitePath, webDist, viteDevTarget, pollIntervalMs })` (`index.ts:8-13`), then `app.listen(...)`. `pollIntervalMs` is computed from `process.env.POLL_INTERVAL_MS` (unset/`''` → `60000`, else `Number.parseInt(...)`) at `index.ts:3-6`. This is a single global value — there is no per-forge-instance or per-task override anywhere in this file or in `buildApp`.
- `apps/server/src/app.ts:29-115` (`buildApp`) is the sole Fastify composition root. It registers, in order: the poller timer (conditionally, `app.ts:41-65`), then `registerAuth`, `registerAgentKeys`, `registerCredentialProfiles`, `registerTasks`, `registerClaim`, `registerMcp` (`app.ts:76-81`), then hosting (`webDist`/`viteDevTarget`/placeholder) (`app.ts:67-112`).
- **No `app.post('/webhook...')` or any route matching `/webhook` exists anywhere in the repo.** Confirmed by grepping the whole worktree for `webhook|Webhook|signature|hmac|HMAC|secret_token|X-Hub-Signature|X-Gitea-Signature|X-Gitlab-Token` — the only source-code hit (outside docs and archived workflow caches) is the `ForgeAdapter` interface declaration itself (`packages/forge-adapters/src/index.ts`) and one comment in `apps/server/src/tasks.ts` (§5 flattening note, unrelated to webhooks).
- The only thing today that drives a "待验收" task toward completion/rejection is `pollPendingReviews` (`apps/server/src/poller.ts:88-102`), invoked either directly by tests or by the `setInterval` timer `buildApp` registers when `pollIntervalMs > 0` (`app.ts:46-64`).

## Execution Flow

### Current flow: 进行中 → 待验收 → (poller only) → 已完成/已退回

1. Agent calls MCP `submit_pr` (`apps/server/src/mcp.ts:147-159`) → `submitPr(db, auth, task_id, pr_url, summary)` in `apps/server/src/claim.ts:287-359`.
   - Requires an active lease held by the caller (`claim.ts:305-311`), requires `from === '进行中'` or 409s (`claim.ts:313-320`).
   - Transitions `进行中 → 待验收` via `transitionTaskStatus` (`claim.ts:322`, backed by `packages/shared/src/index.ts:68-73,75-81` — the only legal edge out of `待验收` is to `已完成` or `已退回`, both **not reachable from `submitPr`**).
   - Releases the lease (`claim.ts:323`), inserts a `submissions` row with `prState: 'open'` (`claim.ts:334-342`), writes a `状态迁移` audit event with `actorUserId: auth.user.id` (`claim.ts:344-348`).
   - There is **no REST `POST /api/v1/tasks/:publicId/submit_pr`** — only the MCP tool. `registerClaim` (`claim.ts:361-389`) exposes only `claim`, `progress`, `release` over REST.
2. From `待验收`, the **only** driver forward is `pollPendingReviews(db)` (`apps/server/src/poller.ts:88-102`):
   - Selects `tasks` where `status === '待验收'` (`poller.ts:91`, constant `PENDING_REVIEW_STATUS = '待验收'` at `poller.ts:14`). No forge/instance filter — every pending-review task across every forge/base_url is scanned every tick; there is **no way to skip a forge instance** in this function.
   - Per task: `latestSubmission` picks the newest `submissions` row by `taskId` (`poller.ts:17-25`).
   - `decryptTaskToken` (`poller.ts:30-46`) resolves the credential exactly like `claimTask`'s resolution (profile vs inline), catching any vault/profile fault and returning `undefined` (skip, not throw).
   - `fetchPrStatus` (`poller.ts:48-57`) builds `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl })` and calls `adapter.getPullRequest({ token }, prUrl)`; any exception is swallowed → `undefined` (skip).
   - `pollOneTask` (`poller.ts:59-82`): if `status.state === 'open'` or fetch failed, returns (task stays `待验收`, no event). Otherwise maps `merged → 已完成`, anything else (`closed`) `→ 已退回` (`poller.ts:67-69`), and in **one `db.transaction`** (`poller.ts:73-81`): updates `tasks.status`, updates `submissions.prState` to `'merged'`/`'closed'`, and calls `insertAuditEvent(tx, { type: '状态迁移', actorUserId: null, details: { task_id, from, to, pr_url } })`.
   - The outer `pollPendingReviews` never throws (`poller.ts:84-101`): the initial `select` is wrapped in try/catch (return early), and each task's `pollOneTask` call is individually try/caught so one bad row never blocks the rest.
3. `buildApp({ pollIntervalMs })` timer contract (`app.ts:41-65`): if `pollIntervalMs` is `null`/`undefined`/`<= 0`, **no timer is registered at all** — confirmed both by reading the code and by `poller.test.ts:778-791` ("omitted pollIntervalMs registers no interval") and `poller.test.ts:793-807` ("pollIntervalMs: 0 registers no interval"). If positive, exactly one global `setInterval(..., pollIntervalMs)` is registered inside a child plugin context so its `onClose` (`clearInterval`) runs before the root db-close hook regardless of source order (comment at `app.ts:43-45`); an in-flight boolean guard (`polling`) prevents re-entrant polling if a pass outlives the interval (`app.ts:50-58`). This is **one process-wide interval**, not per-forge-instance — there is no data-driven way today to run, e.g., gitea on a 30s poll and gitlab on a 5min poll, or to disable polling for one instance while keeping it for another.

### What is missing for issue #13 (traced by absence, not assumption)

- No Fastify route receives a webhook POST from any forge.
- No signature/secret verification code exists anywhere (`registerWebhook`/`parseWebhook` are stubs that `throw new Error('not implemented')` — `packages/forge-adapters/src/index.ts:61-69`).
- No raw-body capture: Fastify's default JSON body parser is used throughout (no `addContentTypeParser` override observed in `app.ts`, `auth.ts`, `claim.ts`, `mcp.ts`, `credential-profiles.ts`, `tasks.ts`). HMAC signature verification (GitHub) needs the exact raw request bytes, which the current setup does not preserve anywhere.
- No per-task or per-forge-instance column/flag exists for "webhook mode" vs "poll mode" (see Data Model section below) — `pollIntervalMs` is the only related knob, and it is a single global server-start value, not per-instance.

## Architecture Insights

- **Layering**: `packages/forge-adapters` (pure fetch-based forge API client, no DB/Fastify knowledge) → `apps/server/src/*.ts` (Fastify route modules + `poller.ts`, each importing the adapter factory and the Drizzle schema) → `apps/server/src/app.ts` (composition root wiring registration order and the poller timer) → `apps/server/src/index.ts` (process env → `buildApp` → listen). This is a strict layering; nothing in `forge-adapters` imports from `apps/server`.
- **Bearer auth is a Fastify child-plugin `onRequest` hook, reused across routes**: `addAgentBearerHook` (`apps/server/src/agent-bearer.ts:38-60`) hashes the presented token (SHA-256, `agent-bearer.ts:13-15`), looks up `agentKeys` by `keyHash`, `timingSafeEqual`-compares the hash (`agent-bearer.ts:17-26`), loads the `users` row, bumps `lastUsedAt`, and sets `request.agentAuth`. Used identically by `registerClaim` (`claim.ts:362-363`) and `registerMcp` (`mcp.ts:228-229`), each inside its own `app.register(async function ...Context(child) { addAgentBearerHook(child, db); ... })` closure — this is the established pattern for "route group needs its own non-session auth."
- **Session auth is cookie/OAuth, checked per-route via `getSessionUser`**, not a global hook — `auth.ts:175-179`, called inline at the top of every session-authed handler in `tasks.ts`, `credential-profiles.ts`, `auth.ts` itself (e.g. `tasks.ts:480-481`).
- **No route in the codebase today is deliberately unauthenticated and signature-checked** — every existing route is either session-cookie-gated (`getSessionUser`/`sendUnauthorized`), Bearer-gated (`addAgentBearerHook`), or is a genuinely open GET (`/`, `/login`, `/login/:provider/callback`, static asset serving). A webhook receiver would be the **first** route in this codebase whose authentication is "verify a signature over the body," not session or Bearer — there is no existing pattern to imitate for that specific shape, only the general "wrap registration in `app.register(async function xContext(child) {...})` and add an `onRequest`/handler-level check" shape used by `agent-bearer.ts`.
- **Error/response shape conventions** (for whatever a webhook route would need to match): session-gated JSON error is `{ error: 'unauthorized' }` at 401 with `WWW-Authenticate: Bearer` header for Bearer routes (`agent-bearer.ts:34-36`) or a `/login` redirect for session routes lacking `Accept: application/json` (`auth.ts:62-67`). Body-validation failures are `{ error: 'invalid_body' }` 400, sometimes with a Chinese `message` (`tasks.ts:507-509,511-515`). Conflict/illegal-transition is `{ error: 'illegal_transition', message }` 409 (`claim.ts:96-98`, `tasks.ts:774-777`). Not-found is `{ error: 'not_found' }` 404. These are hand-parsed body readers everywhere (no schema-validation middleware, no Fastify JSON schema on routes) — `readCreateBody`, `readImportBody`, `readCredential` etc. in `tasks.ts` all follow "return `undefined` on any shape mismatch, caller 400s."
- **System-driven (non-human) events use `actorUserId: null`** — established twice already: `pollPendingReviews`'s `状态迁移` event (`poller.ts:76-80`) and lease-expiry's `状态迁移` event in `sweepExpiredLeases` (referenced by `apps/server/src/leases.ts`, confirmed via `docs/api.md:295`). A webhook-driven transition would be a third instance of this same convention.
- **`insertAuditEvent`'s first parameter is a structural type** `{ insert: AppDb['insert'] }` (`vault.ts:71-85`) specifically so it can be called with either the plain `AppDb` or a `db.transaction` handle — already used this way by `poller.ts:76` inside its `db.transaction` callback. Any webhook handler wanting the same one-transaction status+event write (mirroring `pollOneTask`) can reuse this without modification.
- **Shared adapter test spec pattern** (`*.shared.test.ts`): one file, parameterized over `['github', 'gitlab', 'gitea'] as const`, with a local `installFetch(t, respond)` helper that mocks `globalThis.fetch` via `node:test`'s `t.mock.method` and records requests (`get-pull-request.shared.test.ts:79-96`). Each such file is **explicitly a fresh copy** of the fetch-stub helpers, not an import from a sibling spec — see the comment at `get-pull-request.shared.test.ts:6-8`: "Do not import that file — the helpers below are deliberately copied and trimmed to what this spec needs." Any new adapter behavior (e.g. `parseWebhook`) needing a shared spec should follow this exact isolation convention, not factor out a shared test-helpers module.

## Key Files

| File | Role | Relevant lines |
|---|---|---|
| `packages/forge-adapters/src/index.ts` | `ForgeAdapter` interface + `createForgeAdapter` factory; `registerWebhook`/`parseWebhook`/`commentOnIssue` are stubs | interface: 30-38; stub wiring: 56-65; `notImplemented`: 67-69 |
| `packages/forge-adapters/src/get-pull-request.shared.test.ts` | Shared cross-forge spec pattern to imitate for a new adapter capability | 1-343 (whole file is the pattern) |
| `packages/forge-adapters/src/index.test.ts` | Trivial package health test, registered first in the root test command | 1-12 |
| `apps/server/src/poller.ts` | Only current driver of 待验收→已完成/已退回; polling scope, credential decrypt, transaction/event pattern | 14-15 (consts), 30-46 (decrypt), 59-82 (per-task), 88-102 (entry) |
| `apps/server/src/poller.test.ts` | End-to-end HTTP+MCP-driven poller spec; also the `buildApp({ pollIntervalMs })` timer-contract tests | 530-644 (transitions), 646-684 (scope), 686-723 (resilience), 777-831 (timer contract) |
| `apps/server/src/app.ts` | `buildApp` composition root; poller timer registration; hosting; route-module wiring order | 29-65 (poller timer), 76-81 (route registration order) |
| `apps/server/src/index.ts` | Process entry; env → `buildApp` options; `POLL_INTERVAL_MS` parsing | 1-17 |
| `apps/server/src/claim.ts` | `claimTask`/`reportProgress`/`releaseTask`/`submitPr` service functions + `registerClaim` HTTP; token-reveal event; lease coupling | 67-186 (`claimTask`, only HTTP `token` reveal), 287-359 (`submitPr`, only entry to 待验收), 361-389 (`registerClaim`, no `submit_pr` REST route) |
| `apps/server/src/mcp.ts` | MCP tool surface incl. `submit_pr`, `claim_task` (second token-reveal channel); Bearer child-plugin pattern to imitate | 114-121 (`claim_task`), 147-159 (`submit_pr`), 227-244 (`registerMcp`, bearer-context wiring pattern) |
| `apps/server/src/agent-bearer.ts` | Bearer auth hook; hashing/timing-safe-compare pattern; 401 response shape | 13-15 (hash), 17-26 (compare), 34-36 (401 shape), 38-60 (hook) |
| `apps/server/src/auth.ts` | Session auth; `sendUnauthorized` content-negotiated response; OAuth login/callback pattern | 57-67 (`wantsJson`/`sendUnauthorized`), 241-349 (`registerAuth`) |
| `apps/server/src/vault.ts` | AES-256-GCM encrypt/decrypt; `VAULT_MASTER_KEY` read-on-use; `insertAuditEvent` structural type; `revealCredentialProfile` | 32-42 (`readMasterKey`), 44-65 (encrypt/decrypt), 67-85 (`insertAuditEvent`), 87-106 (`revealCredentialProfile`) |
| `apps/server/src/schema.ts` | Drizzle schema: `tasks`, `submissions`, `credential_profiles`, `events`, `leases`, `users`, `agent_keys` | 30-42 (`credentialProfiles`), 46-82 (`tasks`), 84-90 (`events`), 104-111 (`submissions`) |
| `apps/server/src/db.ts` | Raw DDL mirroring `schema.ts` (SQLite, no migrations) | 28-39 (`credential_profiles` DDL), 41-68 (`tasks` DDL) |
| `apps/server/src/tasks.ts` | Task CRUD, `taskBrief` projection, poster-only transitions; how repo/forge/base_url/credential are stored on create | 46-58 (`RepoInput`), 456-475 (`insertTask`), 499-638 (`POST /api/v1/tasks`) |
| `packages/shared/src/index.ts` | `taskBriefSchema`, `taskStatusSchema`, `transitionTaskStatus` state machine (only 待验收→已完成/已退回 legal) | 7-14 (status enum), 68-73 (legal transitions map), 75-81 (`transitionTaskStatus`) |
| `docs/DESIGN.md` | §8 ForgeAdapter contract (incl. webhook-vs-poll intent), §11 auth incl. webhook signature checking, §14 risks incl. intranet webhook reachability | §8: 168-192, §11: 223-236, §14: 266-271 |
| `docs/api.md` | Current-implementation doc; explicitly states "no webhook route", `registerWebhook`/`parseWebhook`/`commentOnIssue` throw | poller section: 224-241; adapter section: 340-344 |
| `docs/architecture.md` | Current-implementation doc; explicitly states "no webhook" in the ASCII component map | line 44 |
| `package.json` | Root `test` script — the ordered list of test files `pnpm test` runs | 13 |

## Dependencies

**External libs already in use that a webhook receiver would touch:**
- `fastify` (route registration, `app.register` child-plugin pattern, `request.raw`/`reply.raw` used in `mcp.ts` for the one place that needs raw HTTP objects — but that is for MCP's SSE transport, not for signature verification over a raw body).
- `node:crypto` — `createHash`, `timingSafeEqual` already used in `agent-bearer.ts:1,13-26`; `createCipheriv`/`createDecipheriv`/`randomBytes` in `vault.ts:1`. GitHub webhook HMAC verification (`crypto.createHmac('sha256', secret)`) would be a natural extension of this same module's style but does not exist yet.
- `drizzle-orm` (`eq`, `desc` from `drizzle-orm`; `sqliteTable`/`check`/`unique` from `drizzle-orm/sqlite-core`) — used identically across `schema.ts`, `claim.ts`, `poller.ts`, `tasks.ts`.
- `@kaola/forge-adapters` — `createForgeAdapter`, `parseIssueUrl` are the only current package exports (confirmed by `docs/architecture.md:73`: "package export `createForgeAdapter` and `parseIssueUrl`"); `validateToken`/`getPullRequest`/`importIssue` are adapter *methods*, not package exports.
- `@kaola/shared` — `transitionTaskStatus`, `taskStatusSchema`, `taskBriefSchema`.
- `better-sqlite3` (`db.$client` for raw SQL in tests, e.g. `poller.test.ts:474-475,483-487`).

**Internal modules a webhook implementation would need to reuse rather than duplicate:**
- `decryptTaskToken`-equivalent logic already exists twice (`poller.ts:30-46` and inline in `claim.ts:107-140`) — both branch on `credentialProfileId != null` vs `inlineTokenEncrypted`. A third copy for webhook-driven lookups (task → forge/base_url/repo → matching credential) should reuse this branch, not re-derive it.
- `insertAuditEvent` (`vault.ts:73-85`) and the `状态迁移` event shape (`{ task_id, from, to, pr_url }`, no `summary`) established by `poller.ts:79`.
- `transitionTaskStatus` (`packages/shared/src/index.ts:75-81`) — any webhook-driven completion must go through this, and today it only permits `待验收 → 已完成 | 已退回`, matching exactly what the poller already does. No new edges exist in the state machine for a webhook path — none are needed if webhook-driven completion reuses the same target states.
- The `db.transaction` pattern from `pollOneTask` (`poller.ts:73-81`) for "status update + submissions update + audit event, atomically."

## 1. `ForgeAdapter` interface — what throws, what `ForgeEvent` is, host rules, shared test pattern

- Interface at `packages/forge-adapters/src/index.ts:30-38`. Full method list: `validateToken`, `importIssue`, `getPullRequest` (all implemented, GET-only, real fetch calls), plus `registerWebhook(cred, repo, callback): Promise<void>`, `parseWebhook(headers, body): ForgeEvent | null`, `commentOnIssue(cred, issueRef, body): Promise<void>`.
- `createForgeAdapter` (`index.ts:49-65`) wires `registerWebhook: notImplemented`, `parseWebhook: notImplemented`, `commentOnIssue: notImplemented` (`index.ts:61-63`), where `notImplemented` (`index.ts:67-69`) is `function notImplemented(): never { throw new Error('not implemented') }`. **All three throw synchronously the instant they are called**, regardless of `kind`.
- `ForgeEvent` (`index.ts:27`) is `export type ForgeEvent = unknown` — a placeholder with zero shape today. `IssueRef` (`index.ts:28`) is likewise `unknown`.
- Host rules for the two implemented methods that a webhook feature would model itself on: `getPullRequest`/`importIssue` always use `api.github.com` for GitHub (`prApiOrigin`, `index.ts:144-147`: `if (kind === 'github') return GITHUB_API_ORIGIN`), and `options?.baseUrl` (never the URL host pasted by the user) for GitLab/Gitea. `parseIssueUrl` (`index.ts:236-246`, the one other package-level export besides `createForgeAdapter`) is a **pure URL-parsing helper independent of any adapter instance** — it takes `kind` and a URL string and returns `{ full_name }` or `undefined`, used by `tasks.ts`'s import-draft route to validate a pasted issue URL against a chosen repo before ever calling the adapter.
- Shared test pattern: `*.shared.test.ts` files (`validate-token.shared.test.ts`, `get-pull-request.shared.test.ts`, `import-issue.shared.test.ts`), each parameterized over the three `ForgeKind`s in a `for (const kind of KINDS)` loop with `describe(kind, ...)` blocks, each installing its own local `fetch` mock via `t.mock.method(globalThis, 'fetch', ...)` (see `get-pull-request.shared.test.ts:79-96`), explicitly **not** importing helpers from a sibling shared-test file (comment at lines 6-8). These three files are registered individually and explicitly in the root `package.json` `test` script (`package.json:13`) — there is no glob; a new shared spec file (e.g. `register-webhook.shared.test.ts` or `parse-webhook.shared.test.ts`) must be added to that script by name to run under `pnpm test`.

## 2. Poller — scope, decrypt, mapping, events, per-instance skip; timer contract

Answered in full in **Execution Flow** above. Summary of the specific sub-questions:
- **Rows scanned**: `db.select().from(tasks).where(eq(tasks.status, PENDING_REVIEW_STATUS)).all()` (`poller.ts:91`) — all tasks in `待验收`, across every forge/base_url, in one query. No forge/instance predicate exists.
- **Credential decryption**: `decryptTaskToken` (`poller.ts:30-46`), same profile-vs-inline branch as `claimTask`.
- **Mapping**: `merged → 已完成` (`prState: 'merged'`), any non-open/non-merged (i.e. `closed`) → `已退回` (`prState: 'closed'`) (`poller.ts:66-69`). `open` → no-op.
- **Events written**: `状态迁移`, `actorUserId: null`, `details: { task_id, from, to, pr_url }` (`poller.ts:76-80`), inside the same `db.transaction` as the two row updates (`poller.ts:73-81`).
- **Can it skip a forge instance?** No. There is no column, env var, or config structure consulted by `pollPendingReviews` that would exclude a task/instance from being polled. This is the central gap issue #13 must fill — see "Gaps" below.
- **Timer contract**: `buildApp({ pollIntervalMs })` in `app.ts:41-65`: omitted/`<= 0` → no timer (verified by `poller.test.ts:778-807`); positive → exactly one `setInterval` in a dedicated child plugin whose `onClose` clears it before the root db-close hook, with an in-flight `polling` boolean guard against re-entrancy (`app.ts:46-64`, verified by `poller.test.ts:809-830`). `POLL_INTERVAL_MS` env var parsed in `index.ts:3-6` (unset/`''` → `60000`).

## 3. HTTP/app surface — `buildApp`, registered modules, auth hooks, existing webhook route, conventions

- `buildApp(options?: { sqlitePath?, webDist?, viteDevTarget?, pollIntervalMs? })` (`app.ts:29-115`) — no `webhookSecret`/`forgeInstances`/similar option exists in its signature today.
- Registered route modules, in order (`app.ts:76-81`): `registerAuth`, `registerAgentKeys`, `registerCredentialProfiles`, `registerTasks`, `registerClaim`, `registerMcp`. No `registerWebhook` module exists; there is no file named anything like `webhook.ts` in `apps/server/src`.
- Auth hooks: session (`getSessionUser`, per-route call, `auth.ts:175-179`) vs Bearer (`addAgentBearerHook`, per-child-plugin `onRequest` hook, `agent-bearer.ts:38-60`). No signature-based auth hook exists anywhere.
- **Existing webhook route today: none.** Confirmed by full-repo grep (see Entry Points section) and by `docs/api.md:240`/`docs/architecture.md:44` explicitly documenting its absence.
- Unauthenticated routes today are exactly: `GET /` (placeholder or SPA/proxy), `GET /login`, `GET /login/:provider/callback` (auth.ts, these *complete* an OAuth flow using a `code` param + Fastify-oauth2's own CSRF-cookie state, not a payload signature), plus static asset serving under `webDist`. None of these use a body-signature scheme, so there is no existing "verify a signature over the request body" code path to reuse structurally, only the general pattern of wrapping a route group in its own `app.register(async function ctx(child) {...})` closure with a shared guard, as used for Bearer routes.
- Content-type/error conventions: see Architecture Insights above (JSON body via Fastify's default parser everywhere; hand-rolled `read*Body` validators; `{ error: '<snake_case_code>', message?: '<Chinese message>' }` response bodies; status codes 400/401/403/404/409/422/500/502 used consistently for invalid body / unauthenticated / forbidden / not found / illegal transition / token check failed / vault unconfigured / forge unreachable respectively).

## 4. Data model — forge kind/base_url/repo/credential storage; webhook-vs-poll config

- `tasks` table (`schema.ts:46-82`) stores, per task: `repoForge` (enum `github|gitlab|gitea`), `repoBaseUrl` (text), `repoFullName` (text), `repoBaseBranch`, `repoSuggestedDir`, plus `credentialProfileId` (nullable FK) XOR `inlineTokenEncrypted` (nullable, enforced by the `tasks_credential_xor` CHECK constraint, `schema.ts:76-80` / `db.ts:65-66`). There is **no forge "instance" table** — `(repoForge, repoBaseUrl)` pairs are the closest thing to an "instance," implicitly repeated across tasks and across `credentialProfiles` (which has its own `(forge, baseUrl, repoFullName)` unique constraint, `schema.ts:41`, but is also not an "instance" registry — it is scoped to one repo, not one forge host).
- `credential_profiles` (`schema.ts:30-42`): `forge`, `baseUrl`, `repoFullName`, `tokenEncrypted`, `scopesChecked`, `createdBy`. No webhook-secret column.
- `submissions` (`schema.ts:104-111`): `taskId`, `leaseId`, `prUrl`, `summary`, `prState` (free-text, no enum in Drizzle per `docs/api.md:278`).
- `events` (`schema.ts:84-90`): `type` (free text), `actorUserId` (nullable int), `createdAt`, `details` (JSON text).
- **Confirmed absence**: no column, table, or JSON field anywhere in `schema.ts`/`db.ts` stores a "webhook mode" vs "poll mode" flag, a webhook secret, or a per-forge-instance config of any kind. Grepped for `webhook_mode|forge_instance|per.?instance|instance_config` across the whole worktree — zero hits in any source file. **This is the primary schema gap issue #13 must fill** to satisfy acceptance criterion (3) "mode is configurable per forge instance."

## 5. Path to 待验收; 已完成/已退回 currently poller-only

- 待验收 is reached **only** via MCP `submit_pr` → `submitPr` in `apps/server/src/claim.ts:287-359` (extracted function, called from `mcp.ts:157-158`). There is no REST equivalent (confirmed: `registerClaim` only registers `claim`/`progress`/`release`, `claim.ts:361-389`; `docs/api.md:7` states explicitly "no REST `submit_pr`").
- 已完成/已退回 are reached **only** via `pollPendingReviews`'s transaction at `poller.ts:73-81`, calling `transitionTaskStatus(from, toChinese)` at `poller.ts:68` where `from` is read off the task row and `toChinese` is `'已完成'` or `'已退回'` per `poller.ts:67`. No other code path in the entire `apps/server` source calls `transitionTaskStatus` with a target of `已完成` or `已退回` — confirmed by inspecting every caller of `transitionTaskStatus` (`claim.ts:143,256,322`, `tasks.ts:373`, `poller.ts:68`) — the `tasks.ts` and `claim.ts` call sites only ever target `进行中`, `待认领`, or `待验收`.
- This is exactly what issue #13's acceptance criterion (2) — "webhook PR-merge events correctly complete a task" — must add a **second** path into: a webhook-driven equivalent of `pollOneTask`'s terminal-transition logic (same target states, same transaction shape, same event convention), triggered by a parsed `ForgeEvent` instead of a `getPullRequest` poll result.

## 6. Token hygiene

- Token is revealed over HTTP/MCP in exactly two places, both already audited:
  - REST `POST /api/v1/tasks/:publicId/claim` → `claimTask`, top-level `token` in the `201` body (`claim.ts:173-185`), preceded by a `token 揭示` audit event (`claim.ts:161-165`).
  - MCP `claim_task` tool (`mcp.ts:114-121`) → same `claimTask` function, same reveal.
- `list_tasks`/`get_task_brief` (MCP) and session `GET /api/v1/tasks`/`GET /api/v1/tasks/:publicId` (REST) never include a token — `taskBrief` (`tasks.ts:378-415`) only ever projects `credential: { profile_id } | { inline: true }` (`tasks.ts:404-407`), matching `taskBriefSchema`'s union (`packages/shared/src/index.ts:50-53`).
- The poller (`poller.ts:48-57`) decrypts a token to call `adapter.getPullRequest` but **never returns it anywhere** — it stays inside `fetchPrStatus`'s local scope. `poller.test.ts:570` explicitly asserts the plaintext inline token never appears in `events.details` after a poll.
- Vault: `encryptToken`/`decryptToken` (AES-256-GCM, `vault.ts:44-65`) both call `readMasterKey()` (`vault.ts:32-42`) which reads `process.env.VAULT_MASTER_KEY` **on every call** (not cached, not read at `buildApp()` boot) and throws `VaultUnconfiguredError` if absent/malformed (must be exactly 64 hex chars). `isVaultUnconfiguredError` (`vault.ts:22-30`) is the check every caller (`tasks.ts`, `claim.ts`, `credential-profiles.ts`, `poller.ts` implicitly via its try/catch) uses to distinguish "vault not configured" from other errors.
- **Any webhook handler that needs to call `getPullRequest`/`commentOnIssue`/etc. with a task's credential must reuse this same decrypt path and must never place a plaintext token into an audit event, an error response, or a log** — the existing convention (poller, `claimTask`) is the bar to match.

## 7. Test command surface

- Root `package.json:13` `test` script runs, in this exact order: `packages/shared/src/index.test.ts`, `packages/forge-adapters/src/index.test.ts`, `packages/forge-adapters/src/validate-token.shared.test.ts`, `packages/forge-adapters/src/get-pull-request.shared.test.ts`, `packages/forge-adapters/src/import-issue.shared.test.ts`, `apps/server/src/import.test.ts`, `apps/server/src/placeholder.test.ts`, `apps/server/src/auth.test.ts`, `apps/server/src/agent-keys.test.ts`, `apps/server/src/vault.test.ts`, `apps/server/src/tasks.test.ts`, `apps/server/src/hosting.test.ts`, `apps/server/src/claim.test.ts`, `apps/server/src/mcp.test.ts`, `apps/server/src/poller.test.ts`, followed by `pnpm --filter @kaola/web test`.
- **Note**: this list is longer/newer than the one recorded in the root `CLAUDE.md` "Commands" section (which still lists an older, shorter set without `get-pull-request.shared.test.ts`, `import-issue.shared.test.ts`, `import.test.ts`, `mcp.test.ts`, `poller.test.ts`) — `CLAUDE.md` in this worktree is stale relative to `package.json`. This is a doc-staleness observation, not a code gap; flagging it because any doc-docking work for issue #13 will need to update `CLAUDE.md`'s Commands section too, consistent with the "Documentation Update Checklist" already in that file.
- **How a new shared adapter spec gets registered**: there is no glob or auto-discovery — a new file (e.g. `packages/forge-adapters/src/parse-webhook.shared.test.ts` or `register-webhook.shared.test.ts`) must be added **by explicit path** to the `test` script string in `package.json:13`, in the same position other `forge-adapters` shared specs occupy (immediately after `validate-token.shared.test.ts` and its siblings, before the `apps/server` specs begin). Likewise, any new `apps/server/src/*.test.ts` file (e.g. a `webhook.test.ts`) must be appended to that same script string, in the same position other `apps/server` specs occupy (currently ending with `poller.test.ts`).

---

## Gaps — what `docs/DESIGN.md` describes that the code does not yet have

These are gaps, stated as such, not implemented behavior:

1. **§8** ("三份实现放在 `packages/forge-adapters`，共享一套集成测试规格") — `registerWebhook` and `parseWebhook` are declared on the interface but both throw `not implemented` for all three forges (`index.ts:61-62`, `67-69`). No shared `*.shared.test.ts` spec exists yet for either method (only `validate-token`, `get-pull-request`, `import-issue` have one).
2. **§8** ("Webhook 打不进来的实例（内网 Gitea 等）配置为轮询模式") — no config surface (schema column, env var, or otherwise) lets an operator mark a specific forge instance as "poll mode" vs "webhook mode." The only poll-related knob is the single global `pollIntervalMs`/`POLL_INTERVAL_MS`, which is process-wide, not per-instance, and does not gate/enable a webhook path at all (there is no webhook path to gate).
3. **§11** ("Webhook：各 forge 的签名校验（GitHub HMAC、Gitea/GitLab secret token）") — no signature/HMAC verification code exists anywhere in the repo. No raw-body capture exists in the Fastify setup, which HMAC verification would need (GitHub signs the exact raw bytes; Fastify's default JSON parser does not preserve them today).
4. **§14 item 2** ("内网 webhook 可达性...不通的实例走轮询（已设计）") — acknowledges the poll fallback is "already designed," but as shown above it is not implemented as a *fallback selectable per instance* — today polling is simply the only mechanism that exists, unconditionally, for every task in `待验收` regardless of forge/instance.
5. **Milestone M2** (`docs/DESIGN.md` §13, line 263) explicitly lists "webhook 接入（含签名校验）+ 轮询兜底配置化、PR 合并自动完结" as *not yet done* scaffolding for this exact issue — consistent with everything measured above.
6. **§9 / `docs/api.md`**: there is no REST `submit_pr` (confirmed still true) and, per this measurement, still no webhook route — both explicitly called out as absent in `docs/api.md:240` ("There is no REST `POST /api/v1/tasks/:publicId/submit_pr`... and no webhook route").

No other DESIGN.md claim relevant to §8/§11/§14 was found to already be implemented under a different name — the gaps above are the full set relevant to issue #13's three acceptance criteria.
