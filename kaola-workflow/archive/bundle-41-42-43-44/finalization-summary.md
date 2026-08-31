# Finalization summary — bundle-41-42-43-44 (#41, #42, #43, #44)

Branch `workflow/bundle-41-42-43-44`, forked from `5e5acb3`. Closure policy: all_or_nothing.
All four issues were FILED BY THIS SESSION during the previous bundle, from defects the original issues
never named.

## Delivered

- **#43 — a forge token can no longer be printed by a test diagnostic.** Test custody FALSIFIED the run
  owner's own diagnosis (written into #43's body): the nine `JSON.stringify(commentRequests)` messages do
  NOT leak, because `Headers` has no own enumerable properties and serializes to `{}`. The real leak was
  three exact auth-header comparisons — `assert.equal` attaches both values to `AssertionError.actual`,
  which node's reporter prints regardless of any custom message. Fixed with
  `assertCredentialHeaderEquals` = `assert.ok(actual === expected, msg)`, which PRESERVES exact equality
  rather than weakening to the "presence + prefix" check the brief had offered, plus redacted projections
  for all nine diagnostics as defence-in-depth. Test-only.
- **#41 — the credential-profile delete panel now shows the server's explanation.** One line in
  `App.vue`'s `deleteProfile`, reusing the idiom already at five other sites in the same file. The body
  was already being read and discarded, so no new request.
- **#44 — an orphaned database no longer boots empty in silence.** `db.ts` gained
  `reportStrandedRebuildOrphan`, emitting ONE `console.error` naming the orphan table and row count when
  it holds rows while the live table is empty. NO hard gate, NO auto-migration, NO deletion.
- **#42 — the documented remedy is now accurate.** `docs/smoke-test.md:151` states per-state actions
  instead of presenting cancel and run-to-completion as interchangeable.

## Files Changed

6 modified (`CHANGELOG.md`, `apps/server/src/db.ts`, `apps/server/src/writeback.test.ts`,
`apps/web/src/App.vue`, `docs/smoke-test.md`, `package.json`), 2 new test files.

## Test Coverage

New: `apps/server/src/db-orphan-warning.test.ts` (5), `apps/web/src/App.credential-profile-delete.test.ts`
(3), plus 2 cases in `writeback.test.ts`. Every suite was authored under independent test custody and
proven RED first. The new server suite was NOT registered in the root `test` script when authored; the run
owner caught that and registered it, then verified it genuinely executes inside `pnpm test` by grepping
that run's own output for the suite name.

## Validation

`verdict: pass`. Command: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
Result: typecheck 5/5; lint clean; 806 node + 120 web = **926 passing, 0 failing**; build 4 targets, 0
errors. Receipt `.cache/final-validation.md`, hash `ccd704a8f27698f970fc1e63a6caaa43d8c42d6381a1612ae1af26ea30200989`.
Test-count arithmetic reconciled: node 799 -> 806 (+5 orphan, +2 writeback); web 117 -> 120 (+3 UI).

**NOT executed and NOT claimed:** no UAT, no smoke test, none of `docs/smoke-test.md`'s 配合 steps, no
`pnpm smoke:forge`.

## Acceptance against each issue statement

- **#41** surfaced the server message with a safe fallback; verified text-bound (no `v-html`), so a
  server-controlled string cannot render as markup.
- **#42** doc corrected; every claim in it independently verified against both transition layers.
- **#43** the real leak mechanism fixed with exact equality preserved; issue body corrected to the
  measured mechanism before closing.
- **#44** reporting only, with the no-hard-gate rule proven by construction (see Review).

## Changed Paths

Reported by the finalize transaction (`--check`, `ok: true`, no reasons), 6 paths:

- `apps/server/src/db-orphan-warning.test.ts`
- `apps/server/src/db.ts`
- `apps/server/src/writeback.test.ts`
- `apps/web/src/App.credential-profile-delete.test.ts`
- `apps/web/src/App.vue`
- `package.json`

Implementation commit `0c782f8` staged 8 paths: these 6 plus `CHANGELOG.md` and `docs/smoke-test.md`.
Two are new test files, staged EXPLICITLY — the root `package.json` `test` script names files, so a
`git commit -a` would omit them and the commit would then fail `pnpm test` on a missing file.

## Mission List

10 missions recorded, 0 open.

## Documentation Docking

DOCKED — `.cache/doc-updater.md`, `.cache/doc-docking.md`. THREE corrections in this bundle were to the
run owner's OWN text: #42 overstated its own defect, #43 diagnosed the wrong mechanism, and the first
`smoke-test.md` rewrite offered a lease-expiry path that does not exist for `待验收`. Each was caught by
checking code rather than trusting phrasing.

## Review

Independent review returned ONE LOW finding and settled three architectural questions BY CONSTRUCTION:
`reportStrandedRebuildOrphan` cannot throw (locked, garbage, and selectively-corrupt files all fail
earlier, at `db.ts:407`); its `console.error` reaches only fd 2 in a process the MCP bridge never shares;
and six boots of a healthy empty-`leases` database produced zero warnings.

## Run gaps

- manual:english-error-copy-in-chinese-ui (apps/web/src/App.vue has six sites (1828, 1888, 1893, 1961, 1969, 2016) that trust body.message for any non-ok status, so Fastify's default 500 envelope would render raw English internal error text in the Chinese-only admin UI; five are pre-existing and the candidate adds the sixth): filed: #45
- manual:fixture-assert-prints-fake-token (the new credential-diagnostic test's own setup line asserts equality against a hardcoded fake token-shaped fixture, so a setup failure would print token-shaped text that is already visible in the source): noise: the value is a hardcoded fake fixture already visible verbatim in the test source, so a setup failure would print material that leaks nothing real; guarding it would add ceremony without protecting anything.

## Follow-Up Items

#45 (P3) — verified OPEN with a non-empty body and a priority label.

## Readiness

READY. All acceptance satisfied, four gates green on the final bytes, docs docked, follow-up filed. The
one review finding was decided under the controller's standing authorization: it is a pre-existing
repo-wide idiom (5 of 6 sites predate this bundle), display-copy only, so it was filed as #45 covering all
six sites rather than fixed inconsistently at one.

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/bundle-41-42-43-44/.cache/doc-docking.md
- kaola-workflow/archive/bundle-41-42-43-44/.cache/doc-updater.md
- kaola-workflow/archive/bundle-41-42-43-44/.cache/final-validation.md
- kaola-workflow/archive/bundle-41-42-43-44/.cache/origin/selection-record.json
- kaola-workflow/archive/bundle-41-42-43-44/.cache/run-gaps-manual.md
- kaola-workflow/archive/bundle-41-42-43-44/.cache/run-gaps.json
- kaola-workflow/archive/bundle-41-42-43-44/finalization-summary.md
- kaola-workflow/archive/bundle-41-42-43-44/mission-list.md
- kaola-workflow/archive/bundle-41-42-43-44/workflow-state.md
