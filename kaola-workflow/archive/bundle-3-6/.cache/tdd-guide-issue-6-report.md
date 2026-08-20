# tdd-guide report — issue #6 (ForgeAdapter + validateToken)

Role: test author. Production code was not written. `packages/forge-adapters/src/index.ts` is unchanged (`getForgeAdaptersHealth` only).

## Baseline

```
e01b5b2c325ba515514114bb9abe8edac9a26809
e01b5b2 chore: archive issue-2 [sink]
```

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6`  
Main checkout was not used for test files.

## Files written (worktree)

| Path | Role |
|------|------|
| `packages/forge-adapters/src/validate-token.shared.test.ts` | Shared spec: one loop over `github` / `gitlab` / `gitea`, mocks `globalThis.fetch` via `t.mock.method` |

Unchanged:

- `packages/forge-adapters/src/index.ts`
- `packages/forge-adapters/src/index.test.ts` (health pin)
- `apps/**`, `packages/shared/**`, `docs/DESIGN.md`, root `package.json`

Public surface imports in the shared spec (from `./index.ts`):

- value: `createForgeAdapter`
- types: `ForgeAdapter`, `Credential`, `RepoRef`, `TokenCheck`, `TokenCapability`

`getForgeAdaptersHealth` stays pinned in `index.test.ts`.

## Spec coverage (per kind)

1. All ok — GET user 200 + push-capable repo/project 200 → `missing` is `[]`
2. Cannot read — repo/project GET 404 → `missing` includes `'读'`
3. Dead token — user GET 401 → `missing` includes `'读'`, `'推'`, `'PR'`
4. Read but cannot push — Reporter / `permissions.push: false` / GitLab `access_level: 20` → includes `'推'`, not `'读'`
5. Cannot open PR/MR while readable — GitLab `can_create_merge_request_in: false`; Gitea `has_pull_requests: false`; GitHub without push → includes `'PR'` (GitLab/Gitea also assert `'推'` is still present)
6. Custom `baseUrl` — GitLab `https://gitlab.example.com/gitlab` → URLs under `…/gitlab/api/v4/`; Gitea `…/gitea/api/v1/`; GitHub ignores options/`base_url` and calls `https://api.github.com`
7. Same-repo / no fork — recorded fetch URLs never contain `/forks`; GitLab project id is `acme%2Fapp`; methods are GET only

Extra GitHub-only oracle (technical-decisions classic PAT path): `ghp_` token with `X-OAuth-Scopes: gist` and `permissions.push: true` on a private repo → missing `'推'` and `'PR'`, not `'读'`.

Does not call `importIssue` / webhooks / `getPullRequest`. Does not POST.

## RED (required)

Command (from worktree):

```
node --experimental-strip-types --test packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts
```

```
RED: packages/forge-adapters/src/validate-token.shared.test.ts
     SyntaxError: The requested module './index.ts' does not provide an export named 'createForgeAdapter'
baseline: e01b5b2c325ba515514114bb9abe8edac9a26809
```

Combined counts: **pass 1 / fail 1** (tests 2). Health test passed; shared spec failed at import (exports missing). Individual cases did not execute — expected on this baseline. If this file had passed against current `index.ts`, the tests would be wrong.

Health-only (same worktree):

```
node --experimental-strip-types --test packages/forge-adapters/src/index.test.ts
```

**pass 1 / fail 0**. Pin: `getForgeAdaptersHealth() === 'kaola-forge-adapters-ready'`.

Raw combined output: `kaola-workflow/bundle-3-6/.cache/tdd-guide-issue-6-red-run.txt`

## Implementer contract (already decided; tests assert it)

- `createForgeAdapter(kind, options?: { baseUrl?: string })`
- `Credential = { token: string }`
- `RepoRef = { full_name: string, base_url: string }`
- `TokenCheck = { missing: Array<'读' | '推' | 'PR'> }`
- global `fetch` only; no octokit / nock / extra deps
- GitLab join: strip trailing slashes, then `baseUrl + '/api/v4' + path` (keep `/gitlab` subpath)
- Gitea: same with `/api/v1`
- GitHub: `https://api.github.com`, `Authorization: Bearer`, non-empty `User-Agent`
- GitLab: `PRIVATE-TOKEN`
- Gitea: `Authorization: token …`

Stopped. No production implementation.
