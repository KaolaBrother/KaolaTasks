# implementer — admin 升级入口 (电脑 pane)

## task

Add the admin-only **升级入口** on the 电脑 pane in `apps/web/src/App.vue` to match RED tests in `apps/web/src/App.devices.test.ts`. Production only; no test edits; no git commit/push.

## verification tier

tests-green

## files changed

- `apps/web/src/App.vue` (production only)

## before

```
cd /workspace/.kw/worktrees/bundle-27-28
pnpm --filter @kaola/web test -- src/App.devices.test.ts
```

Exit code: 1

```
Tests  3 failed | 114 passed (117)
```

Failed (expected RED):

- 电脑页 — admin 升级入口 > 打开电脑后 GET /api/v1/users，gitlab/gitea full 行可升级
- 电脑页 — admin 升级入口 > 点击升级 POST /api/v1/users/:id/promote 后重新 GET users，该行显示 admin
- 电脑页 — admin 升级入口 > local 与 github 行没有升级按钮；已是 admin 的 gitlab 行也没有

## after

```
cd /workspace/.kw/worktrees/bundle-27-28
pnpm --filter @kaola/web test -- src/App.devices.test.ts
```

Exit code: 0

```
Test Files  6 passed (6)
Tests  117 passed (117)
```

Vitest's include `src/**/*.test.ts` ran the full `@kaola/web` suite (devices + shell/settings/audit/board/form). All green.

## what landed

On `canManageInstance` (active + admin):

- `loadUsers()` calls `GET /api/v1/users` with `credentials: 'include'` and `Accept: application/json`, from the same member `onMounted` path and `applyMeFromResponse` as `loadClaimants` / `loadPendingDevices`.
- Widget `data-testid="users-promote"` after 认领者, before 凭证档案; copy includes `升级`.
- One `user-row` per listed user (username, display_name, provider, permission_level).
- `user-promote` only when provider is gitlab or gitea, status `active`, permission_level `full` (not local, not github, not already admin). Label `升级为管理员`.
- Click uses existing `postJson` → `POST /api/v1/users/:id/promote` body `{}`, then reloads users so the row shows `admin`.

Publishers (`full`) and leftover `claim_only` never render `users-promote` and never GET `/api/v1/users`.
