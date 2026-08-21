# Implementer record — issue #12 (import)

## Task

Implement `ImportedIssue` + `importIssue` on all three forge adapters, `POST /api/v1/tasks/import`
in `registerTasks` (pre-publish draft, no persist, no `validateToken`), and the 导入 UI in
`App.vue` (button, 导入内容 labels, fill-on-200, 导入失败 copy). Follow
`kaola-workflow/issue-12/.cache/orchestrator-rulings.md` and the RED tests in
`kaola-workflow/issue-12/.cache/tests-import.md`. No test files were edited.

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12`
Branch: `workflow/issue-12`
HEAD (unchanged; production is uncommitted): `0e8bc4ac980d71a874ce7de38297a5de37bd768a`

## Verification tier

`tests-green`.

## Files changed

Production (worktree only; main checkout `apps/` / `packages/` not edited):

- `packages/forge-adapters/src/index.ts`
  - `ImportedIssue` is now `{ title, description_md, issue_url, repo: { full_name } }` (was `unknown`).
  - `createForgeAdapter(...).importIssue` is wired (was `notImplemented`).
  - Parse: GitHub/Gitea `^/([^/]+)/([^/]+)/issues/(\d+)$`; GitLab canonical `^/(.+)/-/issues/(\d+)$`
    **before** legacy `^/(.+)/issues/(\d+)$`. Trailing `/` stripped; query/hash dropped by pathname.
    `/pull/`, `/pulls/`, `/-/merge_requests/`, `/-/work_items/` are unparseable (zero fetch).
  - Host rule matches `getPullRequest`: GitHub REST origin always `https://api.github.com`;
    GitLab/Gitea REST origin is constructor `options.baseUrl` (trim trailing `/`), never the pasted
    host. Reuses `forgeGet` / `authHeaders` / `prApiOrigin`.
  - Non-OK after fetch throws `importIssue: ${kind} responded ${status}` (tests match
    `/${kind} responded ${status}/`). Missing/non-string title rejects after the one fetch.
  - GitLab `description_md` from JSON `description`; GitHub/Gitea from `body`; null/missing → `''`.
    Returned `issue_url` is the pasted web URL after trailing-slash strip.
  - Exported `parseIssueUrl(kind, issueUrl)` so the HTTP layer can bind a profile on the parsed
    `full_name` **before** decrypt / fetch (same parsers as `importIssue`; not a new adapter method).

- `apps/server/src/tasks.ts` (`registerTasks`, same module as create — no webhook routes)
  - `POST /api/v1/tasks/import`: session `active`+`full` (else `403 { error: 'forbidden' }`);
    unauthenticated uses existing `sendUnauthorized` (`401 { error: 'unauthorized' }` for JSON).
  - Body: `issue_url` + `repo.{forge,base_url,full_name?}` + credential XOR `{ profile_id }|{ token }`.
    Generic parse → `400 { error: 'invalid_body' }` (no message). `base_url` not http(s)+host →
    same Chinese message as publish. Parse `issue_url` **before** decrypt. Unparseable →
    `400 { error: 'invalid_body', message: '无法解析 Issue 地址。' }` (zero fetch, no `token 揭示`).
    Optional `repo.full_name` must equal parsed name else `400` `Issue 地址与仓库不匹配。`.
  - Profile bind is exact `===` on `forge` / `base_url` / **parsed** `full_name`. Missing profile /
    mismatch reuse publish Chinese copy. Vault miss → `500 { error: 'vault_unconfigured' }`.
    Inline path does not encrypt (nothing is persisted).
  - Does **not** call `validateToken`. Does **not** insert a `tasks` row. Success **200** with
    `{ title, description_md, source: { type: 'imported', issue_url }, repo: { forge, base_url, full_name } }`.
    Never a token / ciphertext key.
  - Forge mapping: 404/410 → `404 issue_not_found` `无法读取该 Issue。`; 401 → `422 token_check_failed`
    `missing: ['读']` `token 无效或无权读取该 Issue。`; other non-OK / network → `502 forge_unreachable`
    `无法连接 forge 导入 Issue。`.
  - Profile path writes `events.type` `token 揭示` after decrypt (including failures):
    `details { profile_id, forge, base_url, full_name, outcome }` with
    `ok | issue_not_found | token_check_failed | forge_unreachable`. Integer PK. No
    `agent_key_id` / token / ciphertext. Inline path writes none.
  - `insertTokenRevealEvent` outcome union gained `issue_not_found` (create path unchanged).

- `apps/web/src/App.vue`
  - When 来源 is `imported`: button `data-testid="task-import"` label `导入`;
    `data-testid="task-import-source-label"` text exactly `导入内容`.
  - Click → `POST /api/v1/tasks/import` with `Accept: application/json`, `credentials: 'include'`,
    snake_case `{ issue_url, repo: { forge, base_url }, credential }` from the current form
    (no `full_name` on the import request). 200 fills title / description / `task-repo` and keeps
    source imported. Failure shows server `message` or `导入失败（${status}）`. Existing
    `发布失败（${status}）` copy is untouched.
  - Board detail: `data-testid="board-detail-import-label"` text exactly `导入内容` iff
    `selectedTask.source.type === 'imported'`. Existing `board-detail-issue-url` remains the source
    **link**. Description stays text interpolation (`{{ selectedTask.description_md }}`, no `v-html`).

Not edited (tdd-guide custody; read + run only):

- `packages/forge-adapters/src/import-issue.shared.test.ts`
- `apps/server/src/import.test.ts`
- `apps/web/src/App.form.test.ts` / `App.board.test.ts`
- `package.json` `"test"` script
- `docs/DESIGN.md`
- `registerWebhook` / `parseWebhook` / `commentOnIssue` remain `notImplemented`

## Commands + exit codes

All commands from `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12`.

1. **Before (RED baseline, captured by tdd-guide on HEAD `0e8bc4a`, production still `notImplemented` /
   missing route):** `CI=true pnpm test` → **exit 1**.
   Log: `kaola-workflow/issue-12/.cache/tests-import-baseline.txt`.
   node:test: `ℹ tests 396` / `ℹ pass 333` / `ℹ fail 63` (39 adapter + 24 HTTP).
   Web ran separately after the `&&` short-circuit: `Tests  7 failed | 44 passed (51)`.

2. **Fast loop — new adapter + HTTP suites, after production:**
   `node --experimental-strip-types --test packages/forge-adapters/src/import-issue.shared.test.ts apps/server/src/import.test.ts`
   → **exit 0**. `ℹ tests 63` / `ℹ pass 63` / `ℹ fail 0`.

3. **Fast loop — web:**
   `pnpm --filter @kaola/web test` → **exit 0**. `Test Files  2 passed (2)` / `Tests  51 passed (51)`.

4. **Full suite (GREEN):**
   `CI=true pnpm test` → **exit 0**.
   node:test: `ℹ tests 396` / `ℹ pass 396` / `ℹ fail 0`.
   then `pnpm --filter @kaola/web test`: `Tests  51 passed (51)`.
   333 pre-existing node tests + 63 new node tests = 396; 44 pre-existing web + 7 new = 51.
   No test was weakened, skipped, or edited.

5. **Typecheck (packages touched):**
   `pnpm --filter @kaola/forge-adapters typecheck && pnpm --filter @kaola/server typecheck && pnpm --filter @kaola/web typecheck`
   → **exit 0**.

6. **Lint (files touched):**
   `pnpm exec eslint packages/forge-adapters/src/index.ts apps/server/src/tasks.ts apps/web/src/App.vue`
   → **exit 0** (no findings). IDE `ReadLints` on the same three files: no linter errors.

## Before / after

| Surface | Before (HEAD `0e8bc4a`, RED) | After (this implementation) |
|---|---|---|
| `importIssue` | `Error('not implemented')`; `ImportedIssue = unknown` | typed `ImportedIssue`; GET via `forgeGet`; host rule = `getPullRequest` |
| `POST /api/v1/tasks/import` | Fastify 404 `Route POST:/api/v1/tasks/import not found` | 200 draft / pinned error table; no `tasks` row; no `validateToken` |
| UI 导入 | no `task-import` / `*-import-label` nodes | `导入` button + `导入内容` on form and board |
| node:test | 333 pass / 63 fail / 396 total | 396 pass / 0 fail |
| web vitest | 44 pass / 7 fail / 51 total | 51 pass / 0 fail |

## Notes

- Error-message prefix is `importIssue: ${kind} responded ${status}` (not `getPullRequest:`). The
  shared spec only regex-matches `${kind} responded ${status}`.
- `parseIssueUrl` is a package-level helper so HTTP can parse-before-decrypt without a second copy
  of the GitLab canonical-before-legacy rule. Tests do not import it; they drive `importIssue` and
  the HTTP route.
- Orchestrator review is **not** claimed done.
