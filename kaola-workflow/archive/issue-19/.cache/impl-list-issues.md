# impl: listIssues (issue #19)

- **worktree**: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-19`
- **branch**: `workflow/issue-19`
- **HEAD SHA**: `41e1e01ff4ec58e4651bb6825ee1bcfa7c158c3d` (uncommitted; not pushed)
- **file changed**: `packages/forge-adapters/src/index.ts` (+70)

## What changed

Added `ListedIssue` and `listIssues` on `ForgeAdapter` / `createForgeAdapter`.

- Fetch origin is `prApiOrigin` (GitHub always `https://api.github.com`; GitLab/Gitea constructor `options.baseUrl`). Does not use `validateToken`'s `options?.baseUrl ?? repo.base_url` fallback.
- One GET via existing `forgeGet` + `authHeaders`. Path segments `encodeURIComponent`.
  - github: `/repos/{owner}/{repo}/issues?state=open&per_page=50&sort=created&direction=desc`
  - gitlab: `/api/v4/projects/{urlencoded full_name}/issues?state=opened&per_page=50&order_by=created_at&sort=desc`
  - gitea: `/api/v1/repos/{owner}/{repo}/issues?state=open&type=issues&limit=50`
- Mapping keeps JSON array order. GitHub drops items with `'pull_request' in obj`. GitLab uses `iid`. `issue_url` is constructed from stripped `repo.base_url` (never `html_url` / `web_url`).
- Non-OK: `throw new Error(\`listIssues: ${kind} responded ${res.status}\`)`. Network failures propagate.

## Verification

**tier**: `tests-green`

**before** (`list-issues.shared.test.ts`): tests 25 / pass 0 / fail 25 (`listIssues` was missing)

**after** (`list-issues.shared.test.ts`):

```
node --experimental-strip-types --test packages/forge-adapters/src/list-issues.shared.test.ts
→ tests 25 / pass 25 / fail 0  (exit 0)
```

**existing adapter specs** (unchanged, still green):

```
node --experimental-strip-types --test packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts packages/forge-adapters/src/get-pull-request.shared.test.ts packages/forge-adapters/src/import-issue.shared.test.ts packages/forge-adapters/src/webhook.shared.test.ts packages/forge-adapters/src/comment-on-issue.shared.test.ts
→ tests 139 / pass 139 / fail 0  (exit 0)
```
