# Code review — #28 admin vs publisher identity

Candidate: `/workspace/.kw/worktrees/bundle-27-28` branch `cursor/bundle-27-28-7976` (HEAD `6d90488`) vs `main`.
Contract: GitHub issue #28 body (locked; latest comment does not rewrite it). Tests are the oracle.
Authority: correctness, regression, scope. No restyle. Do not implement.

## Verdict

**Pass. Zero blocking findings.**

The identity split is implemented on the HTTP and SPA paths the tests pin. Password storage, session issuance, GitHub-login removal, migration, and the 发布 vs 电脑 gates match issue #28. Production files reviewed: `password.ts`, `permissions.ts`, `auth.ts`, `schema.ts`, `db.ts`, `tasks.ts`, `credential-profiles.ts`, `devices.ts`, `claim-confirmations.ts`, `App.vue`, `scripts/forge-smoke.ts`.

## Blocking

None.

## Look-for checks

### Login username trim vs setup trim — not a defect

Setup stores a trimmed username (`auth.ts` POST `/api/v1/setup`: `body.username.trim()`). Login assignment does not trim at the local, but `findLocalUser` lowercases and trims both the needle and the stored row (`auth.ts`). Empirically: JSON `POST /api/v1/login` with `"  kaola-admin  "` returns 200 after setup. Unique index `users(lower(trim(username))) WHERE provider = 'local'` matches that lookup.

### GET `/login` HTML form urlencoded vs JSON parser — nit (fallback only)

Wizard HTML posts `application/x-www-form-urlencoded` to `/api/v1/setup`; login HTML does the same to `/api/v1/login` (`auth.ts` `wizardPageHtml` / `loginPageHtml`, default form enctype). Fastify has no formbody parser. Empirically those POSTs return **415** `FST_ERR_CTP_INVALID_MEDIA_TYPE`. SPA `App.vue` `submitSetup` / `submitLogin` send JSON and succeed (setup 201, login 200). Tests pin GET HTML copy and JSON bodies, not HTML form POST. Issue #28 requires the HTML page to *look* like the Vue card; the Vue card is the product login. Not blocking.

### Migration promoting earliest gitlab/gitea/local full — correct

`db.ts` `promoteEarliestLoginableAdmin`: no-op if an active admin already exists on `local|gitlab|gitea`; else `UPDATE` the earliest `active`+`full` in that provider set `ORDER BY id`. GitHub is excluded. `identity.test.ts` pins gitlab-early becomes admin, later gitea stays full, github full stays full; github-only file keeps `setup_complete: false`.

### `canPublish` vs `canManageInstance` call sites — complete

`permissions.ts`: `canPublish` = active && (admin || full); `canManageInstance` = active && admin.

Wired as required:

- `tasks.ts` `canPostTasks` → `canPublish` (POST create/import, PATCH poster transitions)
- `credential-profiles.ts` `canManageProfiles` → `canPublish`
- `devices.ts` `requireFullAdmin` → `canManageInstance` (pending, bind, revoke, claimants, mine)
- `claim-confirmations.ts` `requireActiveSessionUser` → `canManageInstance`
- `auth.ts` `PUT /api/v1/me/settings`, `GET /api/v1/users`, `POST /api/v1/users/:id/promote` → `canManageInstance`
- `events.ts` `canReadEvents` unchanged (`status !== 待批准`)

No leftover `active && full` production gate for instance admin. `identity.test.ts` publisher can POST tasks, 403 on devices/users/settings/claim-confirmations; admin can pending + settings.

### App.vue setup vs login, leftover GitHub buttons — correct

Unauthenticated `GET /api/v1/setup` then wizard (`setup_complete === false`) or local login + GitLab/Gitea (`true`). No `href="/login/github"` and no "使用 GitHub 登录". Publish `forgeOptions` still includes GitHub as a **repo** forge. `canPublish` vs `canManageInstance` split matches the 发布 nav/profiles vs devices/trusted-automation/claim-confirmations split. `permissionLabel`: admin → 管理员, full → 发布者. `providerLabel`: local → 本地. Leftover pending view remains. `App.shell.test.ts` / `App.devices.test.ts` / `App.settings.test.ts` pin this.

### forge-smoke still publishing as GitLab publisher after setup — correct, not a bug

`scripts/forge-smoke.ts`: `ensureSetup` then `loginGitlabStub` asserting `permission_level === 'full'`, then publish/import with those publisher cookies. Issue #28 allows publishers to publish. `pairDeviceToSelf` ignores the passed cookies and re-`ensureSetup`s so bind uses **admin** (`device-proof.test-helpers.ts`). Empty-DB OAuth grab is gone.

## Nits (non-blocking)

1. **HTML fallback forms 415.** Anchors: `apps/server/src/auth.ts` `wizardPageHtml` form `action="/api/v1/setup"`; `loginPageHtml` form `action="/api/v1/login"`. SPA JSON path is the tested product. If someone later wants no-JS `/login` to work, register urlencoded parsing or point the HTML forms at a JSON-capable handler.

2. **Workbench has no promote UI.** HTTP `GET /api/v1/users` + `POST /api/v1/users/:id/promote` exist and are tested (`identity.test.ts`). `App.vue` has no users list / promote control. Issue UI mentions 升级入口; tdd-guide required ME_FULL *not* to show promote, and did not pin an admin promote widget. Admins can promote via HTTP. Not a test-oracle miss.

3. **Smoke imports `ensureSetup` from `auth.test-helpers.ts`.** `scripts/forge-smoke.ts` production script depends on a test helper (and `DEFAULT_SETUP`). Works, and `pairDeviceToSelf` already does the same. Maintainability only; not blocking. Prefer a tiny shared setup helper outside `*.test-helpers.ts` later.

4. **`setupComplete` defaults `true` in `App.vue`.** Login view is shown while `loaded` is still false, so an empty-DB first paint can flash GitLab/Gitea buttons until the setup probe returns. After probe, wizard is correct. Tests mount after fetch settles.

5. **Password login `persistSession` does not use `skipUntrusted`.** OAuth callbacks skip save when `cookie.secure && protocol !== 'https'` (`auth-cookie.test.ts` public-peer case). Setup/login always `save()`. Different threat model (needs the password); tests do not pin the spoofed-proto case on these POSTs.

## Out of scope / observations

- `KAOLA_ADMINS` is unread in production `auth.ts`. Malformed env cannot throw. Tests still set it in leftover helpers; ignore path is pinned in `identity.test.ts` / `auth.test.ts`.
- `POST /api/v1/users/:id/approve` is an explicit 404 handler. Retired.
- GitHub OAuth plugin is not registered; `GET /login/github` and callback return `{ error: 'not_found' }`. `OAUTH_GITHUB_*` still required at boot.
- `publicUser` never includes `passwordHash`. Setup audit `管理员创建` details exactly `{ user_id }`. Promote audit `权限变更` details `{ target_user_id, from, to }`.
- scrypt via `node:crypto`; `verifyPassword` returns false on malformed hashes; empty password rejected at hash. Timing-safe compare on equal-length keys.
- Agent-key HTTP remains any-active-session (pre-existing #23 surface). Not an #28 gate. UI no longer mints keys.
- Task Brief, MCP tools, and the two token-reveal channels are untouched by this identity split.

verdict: pass
findings_blocking: 0
review_conclusion: Identity split matches issue 28 on the SPA and HTTP paths; HTML form 415 and missing promote widget are nits, not blocking defects.
