# Evidence-binding header (do not modify above this line)
project: bundle-20-21
issue: 20,21
surface: git diff HEAD (docs + claim.ts + App.vue + tests)
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21
branch: workflow/bundle-20-21
# End evidence-binding header

behavior: code-reviewer
candidate: worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21 branch workflow/bundle-20-21 uncommitted vs HEAD
claim: issue #20 four-key clone on claimTask (REST+MCP); issue #21 publish UI read-only import card and omit extra POST keys
surface: git diff HEAD — README.md, docs/DESIGN.md, docs/api.md, apps/server/src/claim.ts, apps/web/src/App.vue, claim/mcp/claim-confirm tests, App.form.test.ts, App.shell.test.ts
evidence: /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-20-21/.cache/review-20-21.md

# Code review — issues #20 and #21

Read-only review of uncommitted worktree changes. Production and tests were not edited by this review. Tests named on the surface were run after a clean code verdict.

## Scope read

Uncommitted vs HEAD (this review): README.md, docs/DESIGN.md, docs/api.md, apps/server/src/claim.ts plus claim.test.ts / mcp.test.ts / claim-confirm.test.ts, apps/web/src/App.vue plus App.form.test.ts / App.shell.test.ts.

Issue #20: thicken claim success `clone` from two keys to exactly `suggested_dir`, `token_usage`, `remote_url`, `extra_header`. Token remains top-level only. `extra_header.value_pattern` is the literal characters `${token}`. `remote_url` is slash-stripped `base_url` + `/` + `full_name` + `.git` with no credentials.

Issue #21: publish pane drops `task-group-acceptance` and the six extra fields; omits those keys from `POST /api/v1/tasks`; native keeps editable title/description; imported shows a read-only Issue card only after import 200. HTTP contracts of POST `/tasks` and `/import` unchanged.

## #20 — clone four-key envelope

`claimTask` in `apps/server/src/claim.ts` is the single builder. MCP `claim_task` still calls it; there is no second clone object.

Success body type and literal now include:

- `suggested_dir` = `brief.repo.suggested_dir`
- `token_usage` = existing `CLONE_TOKEN_USAGE` (unchanged sentence; DESIGN.md / api.md quote it verbatim)
- `remote_url` = `` `${brief.repo.base_url.replace(/\/+$/u, '')}/${brief.repo.full_name}.git` ``
- `extra_header` gitea `{ name: 'Authorization', value_pattern: 'token ${token}' }`, else `{ name: 'Authorization', value_pattern: 'Bearer ${token}' }`

`value_pattern` uses single-quoted strings, so `${token}` is not interpolated. Forge plaintext stays on the outer `token` field only. Nested clone keys are `name` / `value_pattern`, not `token`.

`ClaimPendingBody` is unchanged `{ error, message, pending: true }` — no `clone`, no `token`. Tests pin `Object.hasOwn(body, 'clone') === false` on REST 202 and MCP pending structuredContent.

Session GET list/one and MCP `get_task_brief` still omit `clone`. Tests added `Object.hasOwn(..., 'clone') === false` on those paths.

GitHub fixture pins `https://github.com/octo/widget.git` (not `api.github.com`) and `Bearer ${token}`. GitLab subgroup pins `https://gitlab.forge.example.test/group/subgroup/app.git` (slashes kept, no `%2F`) and Bearer. Gitea default path pins `token ${token}`.

The trailing-slash case stored `base_url` with a trailing `/` (asserted) and claim returned `https://gitea.forge.example.test/team/orders.git`. In this run that test did not take the `statusCode !== 201` early return.

## #21 — publish pane

Acceptance group and refs `taskAcceptanceCriteria` / `taskTestCommand` / `taskAllowedPaths` / `taskForbiddenPaths` / `taskPriority` / `taskTags` / `priorityOptions` / `splitLines` are gone from the form. Board still reads server `priority` / `tags` on listed briefs — that is GET-list display, not publish collection.

`createTask` JSON is `{ title, description_md, source, repo, credential }` (empty `base_branch` / `suggested_dir` still omitted). Extra keys are not sent. Native still requires a trimmed title and writes the hand-typed description.

Imported path: `showImportedIssueCard` = `taskSourceType === 'imported' && taskImportReady`. Card uses `{{ taskTitle }}` / `{{ taskDescription }}` (text, not input) and an `<a :href>` only when `urlLooksHttp` (http/https prefix). `task-import-source-label` lives on the card, so it is absent before import 200.

`createTask` still publishes imported tasks: after import 200, `taskTitle` / `taskDescription` are filled from the draft, `taskIssueUrl` is the selected/pasted URL, `taskSourceType` is `imported`, and POST `source` is `{ type: 'imported', issue_url: issueUrl }` from `taskIssueUrl.trim()`. App.form.test.ts `导入成功后发布` pins that exact body including `IMPORT_TITLE` / `IMPORT_DESCRIPTION` / `IMPORT_ISSUE_URL`.

HTTP handlers in `tasks.ts` are not in this diff. POST `/tasks` and `/import` request/response shapes are unchanged; the client simply omits optional extra keys so server defaults apply.

## importTask vs watch(taskIssueUrl) / resetListedIssues

`resetListedIssues` still does `taskIssueUrl.value = ''`. The source/mode/profile watch always calls it first. `watch(taskIssueUrl)` always calls `clearImportedIssueCard()`.

`importTask` ends with `taskSourceType.value = 'imported'` then sets `taskImportIssueUrl` and `taskImportReady = true`. It does **not** assign `taskIssueUrl`.

On the only UI path the import button is rendered, source is already `'imported'`. Assigning the same string does not retrigger the `[taskSourceType, …]` watch (Vue ref uses `Object.is`). `resetListedIssues` does not run, so the selected Issue URL is not wiped. The card stays up. Subsequent `createTask` still has a non-empty `taskIssueUrl` and can POST imported.

`watch(taskIssueUrl)` does not fire during import because `taskIssueUrl` is not written. Changing the Issue select after a successful import does clear the card (intended: DESIGN 「再次导入或改选另一条 Issue」). Switching source off imported also clears the card.

If `importTask` were ever invoked while source is `native`, a queued pre-flush watch would clear `taskIssueUrl` and then the card. That is unreachable from the template (`v-if="taskSourceType === 'imported'"` on the import button). Not admitted.

## Secrets

Forge plaintext is still only REST claim 201 top-level `token` and MCP `claim_task` success `token`. Clone `remote_url` / `value_pattern` tests assert the fixture plaintext is absent. Import 200 and publish POST still send `{ profile_id }` or `{ token }` as before; the new card interpolates title/body as text.

## Test / production alignment

Helpers `assertCloneRecipe` in the three claim suites match production key set and the three-forge `extra_header` table. Web helpers `expectNoKaolaExtraFields` / `expectOmittedExtraBodyKeys` match the removed testids and omitted JSON keys. Card testids `task-import-card` / `task-import-card-title` / `task-import-card-body` / `task-import-card-url` / `task-import-source-label` match App.vue.

## Validation run (after clean code verdict)

Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`:

```
node --experimental-strip-types --test apps/server/src/claim.test.ts apps/server/src/mcp.test.ts apps/server/src/claim-confirm.test.ts
```

exit 0; tests 64; pass 64; fail 0.

```
pnpm --filter @kaola/web test
```

exit 0; Test Files 5 passed; Tests 95 passed.

## Blocking findings

None.

## Nits (not admitted; below the >80% defect bar)

- `claim remote_url strips trailing slashes` returns early if `POST /tasks` is not 201. In this run it was 201 and the strip assertion ran. If publish later rejects a trailing-slash `base_url`, that case becomes a silent skip rather than a failure.
- Card href uses `taskImportIssueUrl` (import 200 `source.issue_url` or fallback) while `createTask` posts `taskIssueUrl`. Tests keep them equal. A canonicalized import URL would display one value and publish the other.
- `remote_url` is a concatenation of stored `repo.base_url`. Publish `isHttpOrHttpsUrlWithHost` allows URL userinfo. A poster-stored `https://user:pass@host/` would appear in `clone.remote_url`. That follows the specified construction; stripping userinfo was not in the issue formula.

verdict: pass
findings_blocking: 0
review_conclusion: Uncommitted #20/#21 changes match the claim clone four-key contract and the publish read-only import card; importTask does not wipe the issue URL on the reachable imported path, createTask still publishes imported tasks, and named claim plus web tests passed with zero failures.
