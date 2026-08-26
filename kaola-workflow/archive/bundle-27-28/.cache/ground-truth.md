# Ground truth — #28 identity vs current code (HEAD aef8792)

## users schema (`apps/server/src/schema.ts`, `db.ts`)

- `provider`: `github | gitlab | gitea` only — no `local`.
- `permission_level`: `full | claim_only` — no `admin`.
- No `password_hash` column.
- Unique `(provider, remote_id)`.
- `CREATE TABLE` in `db.ts` matches; no ALTER for password/admin.
- No unique index on local username.

## Bootstrap (`apps/server/src/auth.ts`)

- `countActiveFull`: `status === 'active' AND permission_level === 'full'`.
- Empty DB: **first OAuth of any of github/gitlab/gitea** → `active`+`full`.
- Else: `KAOLA_ADMINS` (`provider:username` csv, case-insensitive) → `full`; else `/login?reason=uninvited` (no insert).
- `GET /login`, `/login/github|gitlab|gitea`, callbacks all registered.
- `loginPageHtml`: 考拉任务 + 请选择登录方式 + three OAuth `<a>`.
- `POST /api/v1/users/:id/approve`: session `active`+`full`; sets `active`+`full`.
- `publicUser`: `id, provider, username, display_name, avatar_url, status, permission_level, trusted_automation` — no password field (column does not exist).
- `registerAuth` requires all nine OAuth env vars including GitHub.

## Permission predicates (today all `active && full`)

- `canPostTasks` (`tasks.ts`): publish/import/PATCH own cancel/reopen.
- `canManageProfiles` (`credential-profiles.ts`): profile CRUD + list issues.
- `requireFullAdmin` (`devices.ts`): pending list, bind, revoke, claimants — **same as publisher**.
- `canReadEvents` (`events.ts`): `status !== '待批准'` (pending 401; active claim_only can read events).
- `GET /api/v1/me` PUT settings: `requireActiveSessionUser` (not 待批准).
- Agent keys: any session user (`registerAgentKeys`).

## Web (`apps/web/src/App.vue`)

- Login card: three OAuth buttons always (`github`/`gitlab`/`gitea`).
- No setup wizard; no local username/password form.
- `canApprove`: `active && full` — used for 发布 pane, profiles, devices, bind_to_self, claimants.
- `canManageKeys`: any `active` — trusted automation + claim confirmations for publishers too.
- `permissionLabel`: `full` → 正式成员; else 仅认领.
- Tests (`App.shell.test.ts` etc.) mock `permission_level: 'full'` for publisher+admin combo.

## Tests

- Almost every server test bootstraps via GitHub `loginViaCallback` + `PROVIDERS.github` or `seedUser` then GitHub callback (`auth.test.ts`, `claim.test.ts`, `devices.test.ts`, `mcp.test.ts`, …).
- `createAppWithAuth` in claim/mcp/events/writeback/poller uses GitHub first-login as bootstrap admin.

## Smoke (`scripts/forge-smoke.ts`)

- Isolated sqlite + stub GitLab OAuth; first GitLab callback becomes `full`.
- No `POST /api/v1/setup`.

## DESIGN.md (stale vs locked #28)

- D6: first OAuth = 管理员 (`full`); others 待批准.
- D8: GitHub/GitLab/Gitea login; `KAOLA_ADMINS`.
- §3 角色: 发布者/认领者/管理员 via `full` + first OAuth.
- §10 users: no password_hash, no admin, no local.
- §11: `/login/{github,gitlab,gitea}`, `POST .../approve`.

## #28 deltas (implement)

See GitHub issue #28 body (locked 2026-08-25). Do not implement leftover #27 memo (rate-limit, helmet, AAD, …).
