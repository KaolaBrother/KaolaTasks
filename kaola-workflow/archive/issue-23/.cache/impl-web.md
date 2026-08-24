# Implementer — issue #23 电脑 pane (`@kaola/web`)

## task

Replace the member workbench **钥匙** pane with **电脑**: nav label 电脑 (keep `workbench-nav-keys` / `workbench-pane-keys`), drop Agent Key mint + GitHub numeric-id approve, list/bind/revoke devices and claimants, keep #16 trusted automation + pending confirmations and credential-profile widgets. Login copy must not say GitLab/Gitea auto-full. `claim_only` has no bind/publish and must not GET devices/pending/claimants. Bind success must not render a trap `token`.

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`

## verification tier

`tests-green`

## files changed

- `apps/web/src/App.vue` only
- tests not edited (`App.devices.test.ts`, `App.shell.test.ts`, others)

## verification commands

**before** (baseline, production still 钥匙 / Agent Key):

```
pnpm --filter @kaola/web test
```

- exit code: **1**
- `Test Files  2 failed | 4 passed (6)`
- `Tests  14 failed | 95 passed (109)`
- duration ~4.57s
- failures match `tdd-web.md` (login copy, 钥匙 vs 电脑, no device GETs / bind testids)

**after**:

```
pnpm --filter @kaola/web test
```

- exit code: **0**
- `Test Files  6 passed (6)`
- `Tests  109 passed (109)`
- duration ~4.63s

Did not run `apps/server` or `apps/mcp` suites. Did not edit those trees.

## before

RED: 14 failing oracles in `App.devices.test.ts` (12) + `App.shell.test.ts` (2). 95 other web tests already green.

## after

GREEN: **109/109**. Nav 电脑; login without `GitLab / Gitea 为正式成员`; no 生成 Agent Key / no `/api/v1/agent-keys`; no 批准 GitHub 用户; full+active GET `/api/v1/me/devices`, `/api/v1/devices/pending`, `/api/v1/claimants`; bind `{ bind_to_self: true }` / `{ claimant_display_name }` / `{ claimant_id }`; revoke device/claimant with JSON mutation headers; bind response body is drained and never interpolated (trap token not shown); #16 toggle + confirmations remain; `claim_only` skips device APIs and bind UI; empty-profile hint still says 钥匙.

## notes / corner

Bind/submit/self operate on **the first pending device** (`pendingDevices[0]`). Tests only stub one pending row. Multiple pending would need a selected-device control.

Credential profiles stay on this pane (form tests still look for `profile-*`).
