# doc-updater record — issue #12

Role: doc-updater. Codemap tooling absent (`scripts/codemaps/` and `docs/CODEMAPS/` both missing in worktree) — reconciled README / CHANGELOG / CLAUDE.md / docs/api.md / docs/architecture.md only. Did not invent that structure.

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12`  
Branch: `workflow/issue-12`  
Doc writes: worktree only. Cache writes: this file + `doc-docking.md` under `kaola-workflow/issue-12/.cache/`.  
Did not claim finalization.

## Files edited (docs only)

Worktree:

- `README.md`
- `CHANGELOG.md`
- `CLAUDE.md` (Project Snapshot + Commands test list + Project Conventions token line)
- `docs/api.md`
- `docs/architecture.md`

Cache (main checkout, as requested):

- `kaola-workflow/issue-12/.cache/doc-updater.md` (this file)
- `kaola-workflow/issue-12/.cache/doc-docking.md`

Not edited (skip-with-reason):

- `docs/DESIGN.md` — forbidden; `git diff --name-only -- docs/DESIGN.md` produced no output
- `docs/README.md` — index still lists the same files; no new doc surface
- `docs/conventions.md` — no HTTP/command list to extend; token sentence still true
- `.env.example` — does not exist in the worktree
- production / test files — out of custody
- `scripts/codemaps/` / `docs/CODEMAPS/` — neither exists; not invented

## Ground truth citations

Measured in the worktree, not from issue-11 archives, not from `.cache/ground-truth.md` (that memo predates implementation).

### Adapter (`packages/forge-adapters/src/index.ts`)

- `ImportedIssue` (`index.ts:20-25`): `{ title: string; description_md: string; issue_url: string; repo: { full_name: string } }`
- `ForgeAdapter.importIssue` (`index.ts:33`): `(cred: Credential, issueUrl: string) => Promise<ImportedIssue>`
- Factory wiring (`index.ts:59`): `importIssue: (cred, issueUrl) => importIssue(kind, options, cred, issueUrl)`
- Still `notImplemented` (`index.ts:61-63`): `registerWebhook`, `parseWebhook`, `commentOnIssue`
- Package export `parseIssueUrl` (`index.ts:236-246`):
  `export function parseIssueUrl(kind: ForgeKind, issueUrl: string): { full_name: string } | undefined`
- Host rule (`index.ts:203-204` comment + `prApiOrigin` `:144-147` reused by `resolveImportedIssue` `:253`): GitHub always `https://api.github.com`; GitLab/Gitea constructor `options.baseUrl`, never pasted host
- Pathnames (`index.ts:220`, `:227-233`): GitHub/Gitea `^/([^/]+)/([^/]+)/issues/(\d+)$`; GitLab canonical `^/(.+)/-/issues/(\d+)$` before legacy `^/(.+)/issues/(\d+)$`
- REST (`index.ts:260-280`): GitHub `…/repos/{owner}/{repo}/issues/{n}`; GitLab `{origin}/api/v4/projects/{encodeURIComponent(namespace)}/issues/{iid}`; Gitea `{origin}/api/v1/repos/{owner}/{repo}/issues/{n}`
- Mapping (`index.ts:284-310`): GitLab `description` vs GitHub/Gitea `body`; missing/non-string → `''`; `issue_url` = pasted URL after `replace(/\/+$/u, '')`; missing title rejects after fetch; non-OK throws `` `importIssue: ${kind} responded ${res.status}` ``
- `git diff packages/forge-adapters/src/index.ts`: `ImportedIssue` was `unknown`; `importIssue` was `notImplemented`

### HTTP (`apps/server/src/tasks.ts`)

- Route (`tasks.ts:640-747`): `app.post('/api/v1/tasks/import', …)` comment: "Does not persist a task and does not call validateToken."
- Success (`tasks.ts:737-746`): `reply.code(200).send({ title, description_md, source: { type: 'imported', issue_url }, repo: { forge, base_url, full_name } })`
- Error table from source constants + `importForgeFailure` (`tasks.ts:23-27`, `:255-284`, `:648-723`):

  | status | body | when |
  |---|---|---|
  | 400 | `{ error: 'invalid_body' }` (no message) | `readImportBody` null |
  | 400 | `{ error: 'invalid_body', message: '仓库地址不是合法的 http 或 https 地址。' }` | `repo.base_url` not http(s)+host |
  | 400 | `{ error: 'invalid_body', message: '无法解析 Issue 地址。' }` | `parseIssueUrl` undefined |
  | 400 | `{ error: 'invalid_body', message: 'Issue 地址与仓库不匹配。' }` | optional `full_name` ≠ parsed |
  | 400 | `{ error: 'invalid_body', message: '所选凭证档案不存在。' }` | missing profile |
  | 400 | `{ error: 'invalid_body', message: '所选凭证档案与仓库不匹配。' }` | profile bind fail (parsed `full_name`) |
  | 401 | `sendUnauthorized` | no session |
  | 403 | `{ error: 'forbidden' }` | not `active`+`full` |
  | 404 | `{ error: 'issue_not_found', message: '无法读取该 Issue。' }` | forge 404 or 410 |
  | 422 | `{ error: 'token_check_failed', missing: ['读'], message: 'token 无效或无权读取该 Issue。' }` | forge 401 |
  | 502 | `{ error: 'forge_unreachable', message: '无法连接 forge 导入 Issue。' }` | other non-OK / network |
  | 500 | `{ error: 'vault_unconfigured' }` | profile decrypt vault miss |

- `TokenRevealOutcome` gained `issue_not_found` (`tasks.ts:31`). Profile path writes `token 揭示`; inline does not.
- Import 200 keys never include `token` / `token_encrypted` / `inline_token_encrypted` / `access_token` (pinned by `SECRET_KEY_NAMES` in `import.test.ts:35` and `assertImportDraft` `:408-414`).

### UI (`apps/web/src/App.vue`)

- Form label `导入内容` (`App.vue:194` `data-testid="task-import-source-label"`)
- Button `导入` (`App.vue:284-290` `data-testid="task-import"`)
- Board label `导入内容` (`App.vue:99-102` `data-testid="board-detail-import-label"` iff `source.type === 'imported'`)
- `importTask` (`App.vue:848-884`): `POST /api/v1/tasks/import`, `Accept: application/json`, `credentials: 'include'`, body `{ issue_url, repo: { forge, base_url }, credential }` (no `full_name`); 200 fills title / `description_md` / `repo.full_name`; failure `message` or `` `导入失败（${res.status}）` ``
- Description remains `{{ selectedTask.description_md }}` (`App.vue:93`); no `v-html`

### Test counts (measured, not invented)

- `grep -c "it(" packages/forge-adapters/src/import-issue.shared.test.ts` → **19** (all are real `it(`; 10 inside `KINDS` loop)
- `grep -c "test(" apps/server/src/import.test.ts` → **25** because line 136 is `/…/.test(url)`; actual `test(` cases = **24** (`^\s*test\(`)
- `git diff apps/web/src/App.form.test.ts | grep -c '^+.*it('` → **6** new
- `git diff apps/web/src/App.board.test.ts | grep -c '^+.*it('` → **1** new

### Root `package.json` `"test"` (exact)

```
node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts packages/forge-adapters/src/get-pull-request.shared.test.ts packages/forge-adapters/src/import-issue.shared.test.ts apps/server/src/import.test.ts apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts apps/server/src/tasks.test.ts apps/server/src/hosting.test.ts apps/server/src/claim.test.ts apps/server/src/mcp.test.ts apps/server/src/poller.test.ts && pnpm --filter @kaola/web test
```

(`package.json:13`; `git diff package.json` is that one line.)

## Commands + exit codes

Cwd: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12`

1. `git diff --name-only -- docs/DESIGN.md` → exit 0, **empty stdout**
2. `git status --short` / `git diff --name-only` / `git diff --stat` → exit 0 (production + tests already dirty; docs later)
3. Test-count greps above → exit 0
4. **This session, after reading source, before writing docs:**  
   `CI=true pnpm lint && pnpm typecheck && pnpm test && pnpm build` → **exit 0**  
   Transcribed from that run (not issue-11 archives):
   - `pnpm lint` (`eslint .`) exit 0
   - `pnpm typecheck` (`pnpm -r --if-present typecheck`) exit 0; "Scope: 4 of 5 workspace projects"
   - node `--test`: `ℹ tests 396` / `ℹ suites 79` / `ℹ pass 396` / `ℹ fail 0`
   - vitest: `Test Files  2 passed (2)` / `Tests  51 passed (51)` / vitest `v4.1.11`
   - `pnpm build`: web vite **v7.3.6**, `✓ 2565 modules transformed.`, `dist/assets/index-MeXOcpNK.js  1,465.50 kB │ gzip: 406.21 kB` (chunk-size warning only)

## What each doc changed

- **CHANGELOG.md**: three new Unreleased bullets **above** the #11 bullets — forge-adapters `importIssue`/`ImportedIssue`/`parseIssueUrl`; server `POST /api/v1/tasks/import` 200/error table/no persist/no validateToken; web 导入/导入内容 + measured 396/51 and `index-MeXOcpNK.js`. #11 poller bullets left intact.
- **README.md**: status + 已落地 list + #12 bullet; 尚未实现 still webhook/write-back (import no longer listed as missing); mermaid/工作原理/首次使用; forge-adapters paragraph (`ImportedIssue` no longer `unknown`); `pnpm test` file list; 路线图 #12 landed. Token sentence: import 200 never contains token; claim 201 + MCP `claim_task` remain the only reveal channels. #11 poller bullet unchanged.
- **CLAUDE.md**: Project Snapshot — `importIssue` + `parseIssueUrl` + `ImportedIssue` struct + remaining three methods still `notImplemented`; `POST /api/v1/tasks/import` 200 draft; UI 导入内容; Commands test list matches `package.json`; Project Conventions notes import 200 never contains a forge token. Poller snapshot sentences unchanged.
- **docs/api.md**: header + new `POST /api/v1/tasks/import` section (200 shape, error table, no token); events row for import `token 揭示` including `issue_not_found`; vault env lists import profile decrypt; forge-adapters: `ImportedIssue` typed, `importIssue` implemented, `parseIssueUrl` exported, remaining three `notImplemented`; new `importIssue(cred, issueUrl)` subsection. #11 `getPullRequest` / poller sections unchanged.
- **docs/architecture.md**: tree line for `POST /import` 200 draft; forge-adapters now lists `importIssue` + `parseIssueUrl`; web 导入内容; server paragraph: import does not persist or call `validateToken`. Poller paragraph unchanged.

## DESIGN.md untouched confirmation

```
$ git diff --name-only -- docs/DESIGN.md
```

Empty stdout, exit 0. `git diff --name-only -- docs/` lists only `docs/api.md` and `docs/architecture.md`.
