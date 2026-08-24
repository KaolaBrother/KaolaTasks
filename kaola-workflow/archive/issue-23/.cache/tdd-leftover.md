# TDD leftover — issue #23 (tests only)

Role: tdd-guide. Tests only. Production untouched. `devices.test.ts` oracles untouched.

## Baseline

- Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`
- HEAD: `6c9f01cf7e61630bec48fd4f0f3525a4fb5f5137`
- Identity oracles were already green; leftover HTTP suites still assumed fresh GitHub OAuth creates `待批准` / `claim_only`, and `ktk_` Bearer whoami.

## Outcome

GREEN leftover 7-file set: **141 pass / 0 fail**.

GREEN identity 9-file set (cross-break check): **155 pass / 0 fail**.

No `production-gap:` items. Oracles were not weakened: leftover `待批准` / `claim_only` rows still 403 on publish/vault/import; leftover `ktk_` is not whoami identity.

## What changed (test paths only)

| Path | Change |
|---|---|
| `apps/server/src/import.test.ts` | Seed leftover GitHub `待批准` / `active`+`claim_only` then OAuth-login that row; do not expect a fresh GitHub OAuth to land in those states. |
| `apps/server/src/vault.test.ts` | Same leftover seed for vault 403 gates. Two full members via `KAOLA_ADMINS` (`gitlab:gl-dup-b`, `gitea:gt-share-peer`). |
| `apps/server/src/credential-profile-issues.test.ts` | Same leftover seed for issues-list 403 gates. |
| `apps/server/src/tasks.test.ts` | Same leftover seed for board-read / no-post. Second full poster via `KAOLA_ADMINS` `gitea:gt-bystander`. |
| `apps/server/src/agent-keys.test.ts` | Whoami failures: 401 `unauthorized` + `WWW-Authenticate` `/Kaola-Device/`. Success: `pairDeviceToSelf` + `injectSigned` (device owner fields, no `key_id`). Leftover `ktk_` never 200. Pending/claim_only via SQL seed. Session CRUD hashing/uniqueness kept for full GitLab. Alice/Bob second full via `KAOLA_ADMINS` `gitlab:bob`. |

## Commands

Leftover (after this edit):

```
pnpm exec node --experimental-strip-types --test \
  apps/server/src/agent-keys.test.ts \
  apps/server/src/import.test.ts \
  apps/server/src/placeholder.test.ts \
  apps/server/src/vault.test.ts \
  apps/server/src/credential-profile-issues.test.ts \
  apps/server/src/tasks.test.ts \
  apps/server/src/hosting.test.ts
```

Result: tests 141, pass 141, fail 0. duration_ms ~940.

Identity nine:

```
pnpm exec node --experimental-strip-types --test \
  apps/server/src/auth.test.ts \
  apps/server/src/devices.test.ts \
  apps/server/src/claim.test.ts \
  apps/server/src/mcp.test.ts \
  apps/server/src/claim-confirm.test.ts \
  apps/server/src/writeback.test.ts \
  apps/server/src/webhook.test.ts \
  apps/server/src/poller.test.ts \
  apps/server/src/events.test.ts
```

Result: tests 155, pass 155, fail 0. duration_ms ~1024.

This pass is against current worktree production at `6c9f01cf7e61630bec48fd4f0f3525a4fb5f5137` (identity already implemented). It is a leftover-oracle repair, not a new red suite.
