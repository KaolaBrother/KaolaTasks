# implementer brief — #28 identity (dispatch AFTER tests are RED)

Worktree: `/workspace/.kw/worktrees/bundle-27-28`
Branch: `cursor/bundle-27-28-7976`
Contract: GitHub issue #28 body in full + DESIGN v0.3 (`docs/DESIGN.md`).
Do **not** write tests. Read and run them. Do **not** change Task Brief, MCP tools, or the two token-reveal channels.

## Password
New `apps/server/src/password.ts` using `node:crypto` scrypt (no new dependency).
Suggested encode: `scrypt$N$r$p$salt_hex$key_hex`. Random salt. Reject empty password.
`verifyPassword` timing-safe; unknown/malformed hash → false (do not throw on login path).
Never log plaintext or hash.

## Schema / db
`schema.ts`:
- `provider`: `'github' | 'gitlab' | 'gitea' | 'local'`
- `permissionLevel`: `'admin' | 'full' | 'claim_only'`
- `passwordHash`: text nullable (`password_hash`)

`db.ts` USERS_DDL: add `password_hash TEXT`.
`tryAddColumn` for existing files.
Partial unique: `CREATE UNIQUE INDEX IF NOT EXISTS users_local_username ON users(username) WHERE provider = 'local'`
On `createDb`, after columns: `promoteEarliestLoginableAdmin(sqlite)`:
- Loginable admin exists (`active` + `admin` + provider in local/gitlab/gitea) → no-op
- Else earliest `active`+`full` with provider in local/gitlab/gitea (ORDER BY id) → set `admin`
- Only github full or empty → still wizard

## Auth (`auth.ts`)
Helpers (extract if useful, e.g. `permissions.ts`):
- `isLoginableAdmin(user)`: active + admin + provider local|gitlab|gitea
- `countLoginableAdmins(db)`
- `canPublish(user)`: active && (admin || full)  // tasks + profiles
- `canManageInstance(user)`: active && admin     // devices, promote, users list, trusted automation, claim-confirmations HTTP
- `publicUser`: never include password/hash/token. `permission_level` as stored. `provider` may be `local`.

**Ignore `KAOLA_ADMINS`**: do not parse (malformed must not throw). Env set → still boot.

**Do not register GitHub OAuth plugin** (`startRedirectPath: '/login/github'`). Explicit `GET /login/github` and `GET /login/github/callback` → 404 JSON or empty 404. Keep requiring `OAUTH_GITHUB_CLIENT_ID/SECRET` so compose `unused` still boots, or make them optional — either way, no GitHub login routes.

`completeUserLogin`:
- Existing row: update username/displayName only; revoked → `/login?reason=revoked`; else session. Do not change permission_level.
- No existing row + **no loginable admin**: no insert, redirect `/login` (wizard). GitHub should not reach this.
- No existing row + loginable admin exists + provider gitlab|gitea: insert `active`+`full`.
- Do not insert `待批准` / `claim_only`. No `uninvited`.

`GET /api/v1/setup` (no session): `{ setup_complete: boolean }` (`countLoginableAdmins > 0`).

`POST /api/v1/setup` `{ username, password, display_name? }`:
- If setup_complete → 409 `{ error: 'setup_complete' }`
- Trim username; empty username or empty/missing password → 400
- Hash password; insert `provider: 'local'`, `remote_id: 'local'`, `status: 'active'`, `permission_level: 'admin'`
- Unique conflict (second local / race) → 409 `{ error: 'setup_complete' }`
- Issue session (same cookie rules as OAuth, including skip save when secure && protocol !== https)
- 201 + publicUser
- `insertAuditEvent` type `管理员创建`, details **exactly** `{ user_id }` (numeric id), actorUserId = that user (or null — pin to whatever tests assert; prefer the new admin id)

`POST /api/v1/login` `{ username, password }`:
- Look up local user by trimmed username
- Any failure (missing, bad hash, revoked, pending) → 401 `{ error: 'unauthorized' }` same shape
- Success 200 + session + publicUser

`GET /login` HTML:
- !setup_complete: wizard copy + username/password (no GitHub/GitLab/Gitea as usable entries)
- setup_complete: local login form + GitLab + Gitea links; **no GitHub**

Remove `POST /api/v1/users/:id/approve`.

Add:
- `GET /api/v1/users` — `canManageInstance` else 401/403. Body `{ users: [{ id, provider, username, display_name, status, permission_level }] }` no hashes.
- `POST /api/v1/users/:id/promote` — admin only. Target gitlab/gitea `active`+`full` → `admin`. Already admin → 200 `{ ok: true }`. local/github/missing → 404 or 400. Event `权限变更` details `{ target_user_id, from, to }`.

Same session save / Secure / X-Forwarded-Proto rules as OAuth for setup and login POSTs.

## Gates
- `tasks.ts` `canPostTasks`: active && (admin || full)
- `credential-profiles.ts` `canManageProfiles`: same
- `devices.ts` `requireFullAdmin`: rename or keep name but check **admin** (not full)
- `claim-confirmations.ts` + `PUT /api/v1/me/settings`: require **admin** (403 for publisher)
- `events.ts` `canReadEvents`: unchanged (status !== 待批准)

## Web `App.vue`
- Unauthenticated: `GET /api/v1/setup`. `setup_complete === false` → wizard view (username/password, POST setup, then reload me). No OAuth buttons.
- `setup_complete === true` → local login form (POST `/api/v1/login`) + GitLab + Gitea buttons. **No GitHub button**.
- Split `canApprove`:
  - `canPublish` = active && (admin || full) → 发布 nav/pane, 凭证档案, loadProfiles
  - `canManageInstance` = active && admin → devices mine/pending/claimants/bind_to_self, promote UI, trusted-automation, claim-confirmations, load those resources
- `permissionLabel`: admin → 管理员; full → 发布者; else 仅认领
- `providerLabel`: local → 本地 (or 考拉)
- Publish form **keeps** GitHub as repo forge
- Promote: admin-only list from GET /users + POST promote (testid the tests introduce)
- Leftover pending view can stay for leftover 待批准 rows

## Smoke `scripts/forge-smoke.ts`
**Must** `POST /api/v1/setup` first (local admin). Then stub GitLab OAuth as publisher (`full`).
`pairDeviceToSelf` / device bind uses **admin** cookies (publishers cannot bind).
Publish may use publisher or admin cookies.
Do not empty-DB OAuth-grab full.
Update the assertion that GitLab user is `full` (publisher), not admin.

## Docs
Leave DESIGN (already done). `api.md` / README / smoke-test / CHANGELOG / CLAUDE.md / architecture.md are the later doc-updater mission unless tests import doc strings.

## Verify
Run the tests tdd-guide wrote plus `pnpm test` / lint / typecheck. Iterate production only.
If a test is wrong, stop and report — do not edit it.
