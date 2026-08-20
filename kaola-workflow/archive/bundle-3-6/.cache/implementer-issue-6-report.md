# Implementer report — issue #6 (ForgeAdapter + validateToken)

Role: implementer. Tests were not written or edited.

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6`  
Branch: `workflow/bundle-3-6` @ `e01b5b2`

## Task

Export `createForgeAdapter` and DESIGN §8 `ForgeAdapter` from `@kaola/forge-adapters`. Implement `kind` + `validateToken` (global `fetch`, GET-only permission proxy). Unimplemented methods throw `Error('not implemented')`. Keep `getForgeAdaptersHealth`.

## Verification tier

`tests-green`

## Files changed

| Path (worktree) | Change |
|-----------------|--------|
| `packages/forge-adapters/src/index.ts` | Types + factory + GitHub/GitLab/Gitea `validateToken`; stubs throw |

Not touched:

- `packages/forge-adapters/src/validate-token.shared.test.ts` (read-only)
- `packages/forge-adapters/src/index.test.ts` (read-only)
- `packages/forge-adapters/package.json` (no new dep; global `fetch`)
- `apps/**`, `packages/shared/**`, `docs/DESIGN.md`, root `package.json`

## Before

tdd-guide RED (worktree, missing export):

```
node --experimental-strip-types --test packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts
```

- health: pass 1 / fail 0
- shared spec: fail at import (`createForgeAdapter` not exported)
- combined: **pass 1 / fail 1**

This implementer session’s first combined run from a sandboxed shell did not see the gitignored `.kw` test file and only executed the health test (pass 1). Disk (full permissions) confirmed `validate-token.shared.test.ts` present (untracked) before the production edit.

## After

Command (from worktree):

```
node --experimental-strip-types --test packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts
```

```
ℹ tests 20
ℹ suites 4
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

**pass 20 / fail 0** (exit 0)

Also: `pnpm --filter @kaola/forge-adapters typecheck` → exit 0 (`tsc --noEmit -p tsconfig.json`).

## Behavior shipped

- `createForgeAdapter(kind, options?: { baseUrl?: string })`
- Types: `ForgeAdapter`, `Credential`, `RepoRef`, `TokenCheck`, `TokenCapability` (`Credential.token`; `RepoRef.full_name` + `base_url`; `missing: Array<'读'\|'推'\|'PR'>`)
- GitHub: always `https://api.github.com`; `Authorization: Bearer`; non-empty `User-Agent`; `Accept: application/vnd.github+json`; ignore `options.baseUrl` / `repo.base_url`
- GitLab: `PRIVATE-TOKEN`; `baseUrl.replace(/\/+$/, '') + '/api/v4' + path`; project id `encodeURIComponent(full_name)`
- Gitea: `Authorization: token …`; same join with `/api/v1`
- Prefer `options.baseUrl`, fall back to `RepoRef.base_url` for GitLab/Gitea
- GET `/user` then GET repo/project; 401 on user → missing `读,推,PR`; repo not 200 → missing all three (spec only requires `读`)
- GitHub 推/PR: `permissions.push === true`; classic `ghp_` also requires `X-OAuth-Scopes` from the **user** response to include `repo`, or `public_repo` when `private === false`
- GitLab 推: `max(project_access, group_access) >= 30` and `repository_access_level !== 'disabled'`; PR: `can_create_merge_request_in === true` and `merge_requests_access_level !== 'disabled'`
- Gitea 推: `permissions.push === true`; PR: push and `has_pull_requests !== false`
- No `/forks`, no POST

## Gaps

- `importIssue`, `getPullRequest`, `registerWebhook`, `parseWebhook`, `commentOnIssue` throw `Error('not implemented')`. Tests do not call them.
- `ImportedIssue`, `PrStatus`, `ForgeEvent`, `IssueRef` are exported as `unknown` placeholders (DESIGN §8 names them, does not define fields).
- Push / PR are REST permission **proxies**, not empirical `git push` or `POST` PR/MR. Fine-grained GitHub PATs cannot list Contents/PR grants; `permissions.push` is a role hint (same as technical-decisions.md).
- Repo 404/non-200 reports missing 推 and PR as well as 读 (allowed by spec).
- `registerWebhook` is required on the exported interface and throws (DESIGN marks it optional).
