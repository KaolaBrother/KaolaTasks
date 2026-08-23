# doc-updater report — issue #19

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-19`  
Branch: `workflow/issue-19`  
No commit.

## Exact 502 string copied from source

From `apps/server/src/credential-profiles.ts`:

```
const LIST_FORGE_UNREACHABLE_MESSAGE = '无法连接 forge 列出 Issue。'
```

Transcribed unchanged into `docs/api.md`, `CHANGELOG.md`, and `CLAUDE.md`.

Matching 422 message (same file, identical to import in `apps/server/src/tasks.ts`):

```
const LIST_TOKEN_INVALID_MESSAGE = 'token 无效或无权读取该 Issue。'
```

Publish empty hint copied from `apps/web/src/App.vue`:

```
暂无凭证档案，请先到钥匙页添加。
```

## Files touched

### `docs/api.md`

Reconciled against `apps/server/src/credential-profiles.ts` `GET /api/v1/credential-profiles/:id/issues` and `packages/forge-adapters/src/index.ts` `listIssues` / `ListedIssue`.

- Opening paragraph: GET is implemented; decrypt-then-`listIssues` like the poller; **not** a third reveal channel; does **not** write `token 揭示` (contrast import profile path); still never returns a token.
- New subsection after DELETE profiles, before GET tasks: gate `active`+`full`; `200` `{ issues: [{ number, title, issue_url }] }`; `404` `not_found`; `500` `vault_unconfigured`; `422` `token_check_failed` `missing: ['读']` + import-identical message; `502` `forge_unreachable` + the 502 string above; forge 404/410 are 502 not `issue_not_found`; never token/ciphertext; no `token 揭示` event.
- Forge-adapters: `listIssues` as adapter method; `ListedIssue` type; fetch URLs/query strings from source; `issue_url` constructed from `repo.base_url`; GitLab `iid` not `web_url`; GitHub drops `pull_request`; host rule = `importIssue` / `prApiOrigin`.
- Root test file list is not quoted as a single `package.json` script in this file; added `packages/forge-adapters/src/list-issues.shared.test.ts` next to the other shared specs.

### `docs/architecture.md`

- Added `/api/v1/credential-profiles/:id/issues` next to profiles in the ASCII map (session `active`+`full`; decrypt + `listIssues`; not a reveal channel).
- Added `listIssues` to both adapter method lists (diagram + Packages).
- Added `list-issues.shared.test.ts` to the shared-spec list.
- Noted `ListedIssue[]` `{ number, title, issue_url }`, `issue_url` from `repo.base_url`, GitLab `iid`, GitHub drops `pull_request`.

### `CHANGELOG.md`

Unreleased `#19` bullet: adapters `listIssues` + `ListedIssue`; server GET; web picker; 502/422 copy from source; test files `packages/forge-adapters/src/list-issues.shared.test.ts` and `apps/server/src/credential-profile-issues.test.ts`. No pass counts.

### `CLAUDE.md`

- Project Snapshot: `listIssues` / `ListedIssue`; `GET /api/v1/credential-profiles/:id/issues`; 502 copy; not a third reveal channel; no `token 揭示`; publish picker (dropdowns, empty hint, hidden Forge/仓库地址/仓库; inline still pastes URL).
- Commands test list aligned with root `package.json`: `list-issues.shared.test.ts` after `import-issue.shared.test.ts`; `credential-profile-issues.test.ts` after `vault.test.ts`.
- Project conventions token paragraph: GET issues never returns a token; decrypts like the poller; does not write `token 揭示`.

### `README.md`

Publish step 3 previously told users to fill 仓库 and paste an Issue URL unconditionally. Updated: profile path uses dropdowns (repo comes from the archive; imported source selects Issue); inline token still hand-fills repo and pastes Issue URL.

### Report file

This file: `kaola-workflow/issue-19/.cache/doc-updater.md` (main repo, not the worktree).

## Surfaces skipped (with reason)

- `docs/DESIGN.md` — already updated for #19 (§7 §8); instructed not to revert or restyle.
- Test files — instructed not to edit.
- Production code (`App.vue`, adapter `index.ts`, `credential-profiles.ts`) — instructed not to edit.
- `docs/conventions.md` — does not list HTTP routes.
- `docs/CODEMAPS/` / `scripts/codemaps/` — neither exists in this repo; did not invent the structure.

## Commands run

- `ls` of worktree root, `docs/`, and the two new test files (exist).
- `grep`/`sed`/`python3` reads of DESIGN §7–§8, source constants, App.vue picker labels, `package.json` `"test"`, and the doc surfaces above.
- `python3` check that `CLAUDE.md` Commands test string equals root `package.json` `"test"`.
- `git diff --stat` (no commit).
- Did **not** run the full test suite; CHANGELOG omits measured totals.

## Source facts transcribed (not invented)

- Route: `GET /api/v1/credential-profiles/:id/issues`
- Gate: session `active` + `full` (`403` `{ error: 'forbidden' }`)
- `200` `{ issues }` where items are `{ number, title, issue_url }`
- `404` `{ error: 'not_found' }`; `500` `{ error: 'vault_unconfigured' }`
- `422` `{ error: 'token_check_failed', missing: ['读'], message: 'token 无效或无权读取该 Issue。' }` on forge 401
- `502` `{ error: 'forge_unreachable', message: '无法连接 forge 列出 Issue。' }` otherwise, including forge 404/410
- No `token 揭示` event on this GET
- Adapter: `listIssues`; type `ListedIssue`; GitHub query `state=open&per_page=50&sort=created&direction=desc`; GitLab `state=opened&per_page=50&order_by=created_at&sort=desc`; Gitea `state=open&type=issues&limit=50`; GitHub drops `pull_request`; GitLab number from `iid`; `issue_url` built from `repo.base_url`; host = `prApiOrigin` (GitHub `https://api.github.com`; GitLab/Gitea constructor `baseUrl`)
- Picker: profile option `{forge} {repo_full_name}`; Issue option `#{number} {title}`; labels Issue vs Issue URL; hidden Forge / 仓库地址 / 仓库 on profile path; empty hint `暂无凭证档案，请先到钥匙页添加。`
