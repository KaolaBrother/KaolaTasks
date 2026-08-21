# tdd-guide handoff — issue #12 (RED baseline)

## Baseline commit

`0e8bc4ac980d71a874ce7de38297a5de37bd768a` (`chore: archive issue-11 [sink]`), branch
`workflow/issue-12`, worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12`.
Tree was clean before I started; only the files listed below were added/changed.

## What I wrote

1. `packages/forge-adapters/src/import-issue.shared.test.ts` — new. Shared spec for
   `ForgeAdapter.importIssue`, parameterized over github/gitlab/gitea (copies the
   fetch-stub/URL-recording helper shapes from `get-pull-request.shared.test.ts`, does **not**
   import that file). 39 test cases: per-kind auth-header + REST URL + `ImportedIssue` field
   mapping, trailing-slash strip on both fetch URL and returned `issue_url`, query/hash dropped
   by pathname, null/missing body → `''`, pasted URL not `html_url`/`web_url`, missing/non-string
   title rejects **after one fetch**, non-OK HTTP rejects **after one fetch** with
   `${kind} responded ${status}` in the message, unparseable URLs (including `/pull/`,
   `/pulls/`, `/-/merge_requests/`) reject with **zero** fetch and a message that is **not**
   `not implemented`, GitHub always-`api.github.com`, GitHub/Gitea `pull_request` key still
   accepted, GitLab `description` not `body` (and the inverse for GitHub/Gitea), GitLab nested
   group `encodeURIComponent`, canonical `/-/issues/` not parsed as a `/-` namespace, GitLab
   legacy `/issues/` accepted, GitLab `/-/work_items/` unparseable, and constructor `baseUrl`
   (never the pasted host) for gitlab/gitea.
2. `apps/server/src/import.test.ts` — new. Drives the **real** `buildApp` + session cookie
   (seams copied from `tasks.test.ts`; that file is not imported). Stubs `globalThis.fetch`
   for OAuth userinfo and the Issue GET only — a `/user` validateToken probe during import is
   a failure. 24 test cases: 401/403 gates, 200 draft shape with **no** `tasks` row and no
   secret keys, trailing-slash strip, SSRF (pasted host ≠ constructor `baseUrl`), the pinned
   HTTP error table (generic 400, unparseable 400 + zero fetch, full_name mismatch, base_url
   Chinese message, 404/410 → `issue_not_found`, 401 → `token_check_failed` + `missing: ['读']`,
   other non-OK / network → `forge_unreachable`), profile bind on **parsed** `full_name`,
   parse-before-decrypt (unparseable profile path writes no `token 揭示`), and profile
   `token 揭示` outcomes `ok` | `issue_not_found` | `token_check_failed` | `forge_unreachable`
   (inline path writes none; no `agent_key_id` / token / ciphertext).
3. `apps/web/src/App.form.test.ts` — **added** 6 cases (existing 27 untouched): `task-import`
   button label `导入` only when 来源 is `imported`; `task-import-source-label` text exactly
   `导入内容` only when imported; POST `/api/v1/tasks/import` with `Accept: application/json`,
   `credentials: 'include'`, snake_case body from forge/base_url/credential/issue_url (profile
   and inline); 200 fills title/description/`full_name` and keeps source imported; failures
   show server `message` or `导入失败（${status}）` and never `发布失败`.
4. `apps/web/src/App.board.test.ts` — **added** 1 case (existing 17 untouched):
   `board-detail-import-label` text exactly `导入内容` iff `source.type === 'imported'`; native
   has no such node; the existing `board-detail-issue-url` link remains the source link.
5. `package.json` — appended the two new node:test paths immediately after
   `get-pull-request.shared.test.ts` (same one-line harness exemption as issue #11). No other
   field touched (see `git diff package.json` — 1 line changed).

No production files were touched in the final state (`packages/forge-adapters/src/index.ts`,
`apps/server/src/tasks.ts`, `apps/web/src/App.vue`, `docs/DESIGN.md` are all untouched — see
"Self-check" below).

## Self-check performed (and reverted) before declaring RED

Per "Correct first," I did not want to hand off assertions I hadn't verified are satisfiable and
that fail for the *right* reason. I temporarily wrote scratch implementations —
`packages/forge-adapters/src/index.ts` (`ImportedIssue` type + `importIssue` per the rulings),
`apps/server/src/tasks.ts` (`POST /api/v1/tasks/import` with the pinned error table, parse-before-
decrypt, profile `token 揭示` including `issue_not_found`), and `apps/web/src/App.vue` (导入
button, 导入内容 labels, import POST) — ran the new adapter spec (39/39), `import.test.ts`
(24/24), and `pnpm --filter @kaola/web test` (51/51) against them, then **reverted every scratch
production change** (`git checkout -- packages/forge-adapters/src/index.ts apps/server/src/tasks.ts
apps/web/src/App.vue`) before capturing the RED baseline below. `git status --short` at handoff
shows only `package.json` + the two modified web test files (modified) and the two new test files
(untracked) — no production diff.

Problems the scratch run caught and how I fixed the **tests** (not production):

- Unparseable / pull-path cases that only asserted `assert.rejects` + `recorded.length === 0`
  would pass on today's `notImplemented()` (sync throw, zero fetch). Strengthened to also
  require `err.message !== 'not implemented'`. Non-OK cases require the message to match
  `${kind} responded ${status}` **and** `recorded.length === 1`. Missing-title requires
  `recorded.length === 1`. Happy paths assert `ImportedIssue` fields. Confirmed 0/39 adapter
  cases pass on HEAD after this strengthening (39/39 against the scratch impl).
- The null-and-missing body case originally installed `fetch` twice in one `it`; split into two
  tests so each mock is independent.

## RED baseline

Captured at `kaola-workflow/issue-12/.cache/tests-import-baseline.txt` (full `CI=true pnpm test`
stdout/stderr against the reverted-to-HEAD worktree, commit SHA on line 1).

Because the root `"test"` script is `node … && pnpm --filter @kaola/web test`, vitest did **not**
run in that capture (node:test already failed). Web RED was confirmed separately with
`pnpm --filter @kaola/web test` after the revert.

```
ℹ tests 396
ℹ pass 333
ℹ fail 63
EXIT_CODE=1
```

- **333 pass** — every pre-existing node:test, unmodified, still green (no existing suite was
  weakened).
- **63 fail**, all newly added and all failing for the pinned reasons:
  - **39** in `packages/forge-adapters/src/import-issue.shared.test.ts`. Happy-path / mapping
    cases: `Error: not implemented` thrown from
    `packages/forge-adapters/src/index.ts:64` (`notImplemented()` — `importIssue` is still
    wired to the placeholder, and `ImportedIssue` is still `unknown`). Non-OK cases: assertion
    that the message matches `/${kind} responded 404/` gets input `'not implemented'`.
    Unparseable / pull-path / work-item cases: `AssertionError` `unparseable must fail as a
    parse error, not the notImplemented placeholder` (or `notStrictEqual` on `'not implemented'`).
    Missing-title: `recorded.length` `0 !== 1`.
  - **24** in `apps/server/src/import.test.ts`, every one with signature
    `AssertionError: POST import: 404 {"message":"Route POST:/api/v1/tasks/import not found",
    "error":"Not Found","statusCode":404}` (or the same Fastify 404 body compared against the
    pinned 400/401/403/422/502 JSON). The route does not exist yet.

Web (not in the `pnpm test` capture because of `&&`):

```
Tests  7 failed | 44 passed (51)
```

- **44 pass** — every pre-existing form/board case, unmodified.
- **7 fail**, all newly added:
  - form: `task-import` / `task-import-source-label` `.exists()` is `false` after selecting
    `imported`; click helpers throw `missing [data-testid="task-import"]`.
  - board: `board-detail-import-label` `.exists()` is `false` on an imported task.

No test that exercises new behavior currently passes on this HEAD.

## Notes for whoever implements

- Adapter host rule is `getPullRequest`, not `validateToken`: GitHub REST origin is always
  `https://api.github.com`; GitLab/Gitea origin is constructor `options.baseUrl` (trim trailing
  `/`), never the pasted issue URL host. Encode GitHub/Gitea owner and repo with
  `encodeURIComponent`; encode the whole GitLab namespace (slashes → `%2F`).
- GitLab: try canonical `^/(.+)/-/issues/(\d+)$` **before** legacy `^/(.+)/issues/(\d+)$`, or a
  nested `/-/issues/` URL will be parsed as a namespace ending in `/-`.
- HTTP 200 is **not** 201 — nothing is created. Do not call `validateToken` on this route.
  `repo.full_name` on the request is optional; when present it must equal the **parsed**
  full_name. Profile bind is exact `===` on `forge` / `base_url` / **parsed** `full_name`.
- Profile `token 揭示` `details` is `{ profile_id, forge, base_url, full_name, outcome }` with
  `outcome` `ok` | `issue_not_found` | `token_check_failed` | `forge_unreachable`. `profile_id`
  is the integer PK. Inline path writes no such event.
- UI 来源标记 text is exactly `导入内容` (form `task-import-source-label`, board
  `board-detail-import-label`). Description stays text interpolation. Existing
  `board-detail-issue-url` is the source **link**, not the injection label. Import failure copy
  is `导入失败（${status}）`; do not change `发布失败（${status}）`.
- Out of scope: `registerWebhook` / `parseWebhook` / `commentOnIssue`, REST `submit_pr`, a
  seventh task status, DESIGN.md contract edits.
