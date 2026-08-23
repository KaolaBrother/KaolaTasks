# Implementer #20 — thicken claim `clone` to four keys

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`  
No commit. Tests not edited.

## task

REST `POST /api/v1/tasks/:publicId/claim` `201` and MCP `claim_task` success share `claimTask`. Thicken inline `clone` from two keys to four: `suggested_dir`, `token_usage`, `remote_url`, `extra_header`. Update `ClaimSuccessBody`. MCP has no separate builder.

## verification tier

`tests-green`

## files changed

- `apps/server/src/claim.ts` — `ClaimSuccessBody.clone` type; `remote_url` from stripped `base_url` + `full_name` + `.git`; `extra_header` github/gitlab `Bearer ${token}`, gitea `token ${token}` (literal `${token}`, no plaintext)

## verification commands

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21
node --experimental-strip-types --test apps/server/src/claim.test.ts apps/server/src/mcp.test.ts apps/server/src/claim-confirm.test.ts
```

## before

Same command: **exit 1**. Failures were `assertCloneRecipe` expecting four clone keys; production still returned `suggested_dir` + `token_usage` only.

## after

**exit 0**. `64` tests, **64 pass / 0 fail**. Duration ~671ms.
