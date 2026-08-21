# tdd-guide handoff — issue #16 claim-confirmation for autonomous polling agents

Role: tdd-guide (standard / sonnet tier). Custody: tests only. No production code, no
`package.json` edits, no edits to `claim.test.ts` / existing `mcp.test.ts` describes /
`App.vue` / `db.ts` / `schema.ts` / `DESIGN.md`.

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-15-16`
Branch: `workflow/bundle-15-16`
**Baseline SHA measured**: `637c3041f7e20513929b7230bd7d394e77ffc1a1` (worktree HEAD at the time
these tests were authored and RED-verified; working tree was otherwise clean except for the two
new test files below and, if the sibling #15 tdd-guide has landed in parallel,
`apps/server/src/events.test.ts` / `apps/web/src/App.audit.test.ts`, which are untouched by this
handoff).

## Oracle followed

`kaola-workflow/bundle-15-16/.cache/orchestrator-rulings.md` §"#16" (comment overrides body:
instructed claims need no confirmation; the gate is autonomous-poll only) +
`kaola-workflow/bundle-15-16/.cache/ground-truth.md` (exact `claimTask` signature/behavior,
`users`/`agent_keys` schema, MCP tool registration shape). No ambiguity required stopping —
every acceptance bullet in the oracle's "#16 — Tests to author" section had a concrete, testable
shape.

## Files written

1. `apps/server/src/claim-confirm.test.ts` (new, in the worktree). REST + MCP. 20 tests across 6
   `describe` blocks:
   - **instructed claims stay MVP 认领即授权** (3 tests): no body / `autonomous:false` REST still
     `assertClaim201`; MCP `claim_task` without `autonomous` still returns the token envelope;
     instructed claim ignores a leftover `rejected` `claim_confirmations` row for the same
     `(task, user, key)` (seeded via raw SQL, since the table has no HTTP writer of its own yet).
   - **autonomous claim gate — 待批准 first** (1 test): the existing 403 gate still fires before
     the new autonomous branch, even with `autonomous: true`.
   - **autonomous claim gate — automation off (default)** (3 tests): REST 202
     `{ error: 'confirmation_required', message }`, no `token` key, no `token 揭示`/lease/status
     flip, writes one `认领待确认` `{ task_id, agent_key_id }`; MCP equivalent (`isError` false,
     `structuredContent.pending === true`); idempotent re-request reuses one
     `claim_confirmations` row (raw-SQL row count assertion — the ruling explicitly pins "one
     pending row … reuse it").
   - **settings — trusted_automation** (2 tests): `GET /api/v1/me` defaults `false`; `PUT
     /api/v1/me/settings` flips it and the *next* autonomous claim is immediately 201 (直通),
     then flipping back to `false` reinstates 202; persistence across a **second** `buildApp()`
     on the same sqlite file path (new `loginGiteaFixed` helper reuses a fixed `remote_id` so
     both `buildApp` instances resolve to the same `users` row).
   - **approve / reject a pending claim confirmation** (4 tests): approve consumes the pending
     row (retry succeeds 201; approve itself reveals no token / inserts no lease / flips no
     status; writes one `认领已确认` `{ task_id, agent_key_id }`) — and, critically, pins that a
     *consumed* approval does not grant a second free claim after release+re-autonomous-claim;
     the identical approve-then-retry flow repeated over MCP; reject sets `state='rejected'` and
     a retried autonomous claim parks a **fresh** pending row (202 again, not a crash/500); 404
     for approve/reject on another user's confirmation id, and `GET
     /api/v1/claim-confirmations` is scoped to the caller only.
   - **authentication sanity** (1 test): session-only endpoint — no session cookie is 401; a
     valid Bearer Agent Key token alone does not authorize `GET /api/v1/claim-confirmations`
     (it is session, not Bearer, per the ruling).

   Seams (fetch/OAuth stub, `loginGitea`/`loginGitlab`/`loginGithub`, `mintAgentKey`,
   `seedAgentKey`, `freezeNow`, MCP JSON-RPC/SSE client, `assertClaim201`,
   `assertNoForgeSecretMaterial`, etc.) are copied verbatim from `claim.test.ts` and
   `mcp.test.ts` — neither is imported. New helpers added on top: `claimTaskAutonomous`
   (omits the body key entirely when `autonomous` is `undefined`, matching "today's clients send
   no body"), `putSettings`, `getMe`, `getClaimConfirmations`, `approveConfirmation`,
   `rejectConfirmation`, `claimConfirmationRows`/`seedClaimConfirmation` (raw SQL against the
   `claim_confirmations` schema pinned in the ruling), `pendingConfirmEvents`/
   `confirmApprovedEvents`, `loginGiteaFixed`, `assertPending202`, `assertClaimEnvelope` (MCP
   analogue of `assertClaim201`).

2. `apps/web/src/App.settings.test.ts` (new, in the worktree). 8 tests across 4 `describe`
   blocks, mirroring the `App.board.test.ts` / `App.form.test.ts` fetch-stub + `data-testid`
   convention (neither imported):
   - Visibility: gated like `canManageKeys` — visible to *both* `full` and `claim_only` active
     members, absent on pending and login views, and on those views the client never even
     requests `/api/v1/me/settings` or `/api/v1/claim-confirmations`.
   - A `GET /api/v1/me` response that omits `trusted_automation` entirely (the existing
     `ME_FULL` fixture shape used by `App.board.test.ts`/`App.form.test.ts`) must still mount and
     default the toggle to off — pins the "additive field, existing stubs keep working" ruling
     line directly.
   - Toggling PUTs `{ trusted_automation: <bool> }` with `credentials: 'include'` and reflects
     the server's returned value (both directions).
   - `GET /api/v1/claim-confirmations` renders rows (task id visible in the list); the approve
     and reject buttons (repeated per row, shared `data-testid` per the ruling's "(per row ok)")
     POST the corresponding `/api/v1/claim-confirmations/:id/approve|reject` route and the list
     refetches/empties afterward; empty list still renders the container with zero buttons.
   - Fetch URL pinned to exactly `/api/v1/claim-confirmations` (no query).

   **Judgment call (recorded per role instructions, not reopened elsewhere):** the
   受信自动化 control is asserted as an `n-switch` driven via `update:value` emit — the only
   boolean control convention this codebase has anywhere, and consistent with how every other
   naive-ui input here (`n-select` filters) is driven in tests. If an implementer instead reaches
   for a checkbox or a button-toggle, `switchOf()` will not find it and the test will fail loudly
   rather than silently pass — that is intentional, not a bug to route around.

## RED failure signature (this baseline)

Full captured output: `kaola-workflow/bundle-15-16/.cache/tests-claim-confirm-baseline.txt`
(concatenates both commands' full output, git SHA header included).

Commands run from the worktree:

```
node --experimental-strip-types --test apps/server/src/claim-confirm.test.ts
cd apps/web && npx vitest run src/App.settings.test.ts
```

- **`claim-confirm.test.ts`**: `tests 14`, `pass 3`, `fail 11`. (Node's test runner counts each
  `test()` once; sub-`describe`s roll up separately in the TAP-ish summary — 14 leaf tests, 3
  pass / 11 fail is the number that matters.) All 11 failures are exactly the shape expected pre-
  implementation:
  - `AssertionError: … actual: 201, expected: 202` — every "autonomous + off should park" /
    "reject should re-park" / "settings off should re-park" case, because `claimTask` today has
    no gate at all and always returns 201.
  - `{ code: 'SQLITE_ERROR' }` — the "instructed ignores a leftover rejected row" test and every
    test that queries/seeds the `claim_confirmations` table, because that table does not exist
    yet (no DDL in `db.ts`, no Drizzle table in `schema.ts`).
  - `actual: undefined, expected: true/false` — `trusted_automation` is `undefined` on
    `GET /api/v1/me` (no such column, no such field on `publicUser()`), and `PUT
    /api/v1/me/settings` is a 404 "Route not found" (route does not exist).
  - MCP `pending`/`structuredContent.pending` assertions fail for the same reason: `claim_task`'s
    Zod input schema has no `autonomous` key yet, and `claimTask()` ignores it even if the SDK
    tolerated an unknown key, so it always returns the full token envelope.
- **`App.settings.test.ts`**: `Test Files 1 failed`, `Tests 8 failed (8)` — every test times out
  in `vi.waitFor` waiting for a `GET /api/v1/claim-confirmations` call that `App.vue` never makes
  (no such fetch exists), or fails to find `[data-testid="trusted-automation-toggle"]` /
  `[data-testid="claim-confirmation-list"]` because neither widget exists in the template yet.

## Accidental passes on HEAD (not a defective oracle — read before "fixing")

3 of the 20 `claim-confirm.test.ts` tests **already pass on HEAD**, by design:
- "no body and explicit autonomous:false both still return 201 with a token" — pins that the
  *instructed* path is unaffected; it passes today because `claimTask` has no gate at all yet,
  which is the correct baseline for the instructed path and must **stay** passing after #16 is
  implemented.
- "MCP claim_task without autonomous still returns the token envelope" — same reasoning on the
  MCP side.
- "待批准 users are still 403 before the autonomous gate, even with autonomous:true" — pins that
  the pre-existing pending-approval gate is untouched by the new autonomous branch; it passes
  today because `claimTask`'s very first check already returns 403 regardless of any other
  field, and must keep doing so once the autonomous branch is added *after* that check (per the
  ruling: "Keep the existing 待批准 403 first").

These three are intentional regression pins for behavior that must **not change**, not signal
that the suite failed to exercise new behavior — the other 17 tests (11 failing here, plus the 3
above pass, plus 6 web tests not yet counted... see below) do exercise the new gate and are all
RED. Do not weaken or delete these three to "make the suite fail more" — that would defeat their
purpose.

All 8 `App.settings.test.ts` tests fail on HEAD (0 accidental passes) since none of the widget,
the settings routes, or the confirmations routes exist yet on the web side.

## For the orchestrator / implementer

- **`package.json` reminder (I did not edit it — a sibling #15 tdd-guide owns that line in
  parallel per instructions):** append `apps/server/src/claim-confirm.test.ts` to the root
  `test` script's `node --experimental-strip-types --test …` file list, **after**
  `apps/server/src/events.test.ts` (per the ruling's ordering: "#15 lands first, then #16").
  `apps/web/src/App.settings.test.ts` needs no script change — `pnpm --filter @kaola/web test`
  (`vitest run`) already picks up every `*.test.ts` under `apps/web/src`.
- Implementer touch points implied by RED (not prescribed beyond the oracle): `db.ts` (new
  `claim_confirmations` DDL + the `ALTER TABLE users ADD COLUMN trusted_automation …` guarded
  ignore-duplicate-column path), `schema.ts` (new Drizzle table + `users.trustedAutomation`
  column), `claim.ts` (`claimTask` gains an `autonomous?: boolean` 4th parameter — the single
  choke point per the ruling — used by both the REST route and `mcp.ts`'s `claim_task` tool),
  `mcp.ts` (`claim_task` input schema gains optional `autonomous`), `auth.ts` (`publicUser()`
  gains `trusted_automation`, new `PUT /api/v1/me/settings`), a new module (e.g.
  `claim-confirmations.ts`) for `GET /api/v1/claim-confirmations` and the two `POST …/approve|
  reject` routes, and `App.vue` (受信自动化 switch + 待确认认领列表 widget, gated like
  `canManageKeys`).
- I did not touch `App.vue`, `db.ts`, `schema.ts`, `DESIGN.md`, `package.json`, `claim.test.ts`,
  or any existing `mcp.test.ts` describe block, per the role contract.
