# tdd-guide brief — #28 identity (bundle-27-28)

Worktree: `/workspace/.kw/worktrees/bundle-27-28`
Baseline commit to fail against: `86354f1` (DESIGN v0.3 is already on the branch; production code is still empty-DB OAuth + `full` as one gate).
Contract: GitHub issue https://github.com/KaolaBrother/KaolaTasks/issues/28 **body in full**. Latest comment says implement the body; earlier 3 discussion comments are void.
#27 leftover hardening (rate-limit, helmet, AAD, …) is **out**.

## Custody
Write **tests only**. No production (`auth.ts`, `schema.ts`, `db.ts`, `App.vue`, `scripts/forge-smoke.ts`, DESIGN, api.md, …).
You MAY add new `*.test.ts` files and rewrite existing `*.test.ts`.
You MAY add those files to root `package.json` `"test"` script (required for new server files).
Web vitest already `include: src/**/*.test.ts`.

## Required RED surface

### Password module
New `apps/server/src/password.test.ts`:
- `hashPassword` / `verifyPassword` from `./password.ts` (will fail to import on baseline — that is valid RED).
- Correct password verifies; wrong password does not.
- Hash is not the plaintext; never equals the password string.
- Empty password is rejected (throw or false — pin a clear contract: hash rejects empty).
- Do not pin a vendor-specific encoding string beyond “not plaintext”. Argon2id **or** `node:crypto` scrypt are both allowed.

### Schema / migration
In `auth.test.ts` or `apps/server/src/identity.test.ts`:
- New sqlite from `createDb` has `users.password_hash` (nullable), `provider` can be `local`, `permission_level` can be `admin`.
- Partial unique: two `local` rows with same trimmed username must fail; OAuth usernames may collide across providers.
- Open an **old** sqlite file (raw `better-sqlite3` CREATE TABLE **without** password_hash/admin, insert earliest `gitlab` `active`+`full` plus a later `gitea` `full`, plus a `github` `full`): `createDb(path)` promotes **only the earliest gitlab/gitea/local full** to `admin`; github full stays `full` and is **not** a loginable admin.
- Old file with **only** `github` `active`+`full` (no gitlab/gitea/local): after `createDb`, still zero loginable admins (`GET /api/v1/setup` `setup_complete: false`).

Loginable admin = `active` + `permission_level === 'admin'` + `provider` in `local|gitlab|gitea`. GitHub does not count.

### Setup / login HTTP
- Unauthenticated `GET /api/v1/setup` → `200` `{ setup_complete: boolean }` (DESIGN §11; SPA probe). Empty DB → `false`.
- `POST /api/v1/setup` `{ username, password }` → `201` + session cookie; `GET /api/v1/me` is `provider: 'local'`, `permission_level: 'admin'`, `remote_id: 'local'`. Optional `display_name` defaults to username. Username trimmed, nonempty.
- `GET /api/v1/me` body has **no** `password`, `password_hash`, `hash`, or token-like keys. Even after setup.
- Second setup (same or other username) → `409` `{ error: 'setup_complete' }`. Concurrent two setups: at most one admin row.
- Missing/empty username → `400`. Empty password → `400`.
- Setup writes `events.type` `管理员创建` with `details` **exactly** `{ user_id }` (numeric public id). No password/hash in details or response.
- `POST /api/v1/login` correct → `200` + session; wrong password / unknown user / empty → **all** `401` (same shape; do not leak existence). No rate-limit tests.
- After setup, `GET /login` HTML has GitLab + Gitea links and **no** GitHub link; contains a local login affordance (form or equivalent). Before setup, HTML is wizard (username/password), **not** three OAuth as usable entries (no `/login/github`, and OAuth must not be presented as the way in).

### OAuth
- Empty DB: GitLab callback (stubbed token+userinfo) **does not** insert a user and **does not** set a session. Same for Gitea. Redirect toward login/setup, not a member session.
- `GET /login/github` and `GET /login/github/callback` → **404**. Do not register OAuth start.
- After setup, GitLab (and Gitea) OAuth inserts `active`+`full` **publisher**, session 200 `/me`. Not `admin`. No `/login?reason=uninvited`.
- `KAOLA_ADMINS` set (even `github:whoever` or malformed `not-a-spec`) **must still `buildApp()`** and must **not** grant GitHub login or extra admin. Ignore the env.

### Promote / users / approve
- `GET /api/v1/users` publisher `403`; unauth `401`; admin `200` `{ users: [{ id, provider, username, display_name, status, permission_level }] }` — no hash fields.
- `POST /api/v1/users/:id/promote`: admin promotes gitlab/gitea `active`+`full` → `200 { ok: true }`; target `/me` is `admin` and can hit device routes. Already admin → `200` idempotent. Local admin id / github leftover / missing → `404` or `400`. Publisher cannot promote (`403`).
- Promote writes `events.type` `权限变更`, `details` `{ target_user_id, from, to }` (`from`/`to` are permission_level strings). No password/hash/token.
- `POST /api/v1/users/:id/approve` is **retired** → `404` (or not found as a route). Delete/replace tests that currently expect approve to succeed.

### Gates (HTTP)
After setup admin + GitLab publisher:
- Publisher **can** `POST /api/v1/tasks` (and import/profiles) — `admin` **or** `full`.
- Publisher **cannot** `GET /api/v1/devices/pending`, bind, claimants, promote, `GET /api/v1/users` → `403`.
- Admin **can** those device routes (today’s `requireFullAdmin` surface) **and** publish/profiles.
- `PUT /api/v1/me/settings` trusted_automation and `GET/POST /api/v1/claim-confirmations*` : **admin only** (publishers `403`). Matches “受信自动化 + 待确认认领仅管理员”.
- Leftover `claim_only`: sqlite insert + **GitLab/Gitea** OAuth reuse of that row (or session cookie after seed+callback). **Never** `GET /login/github` to mint a session. Defense: cannot publish, cannot manage devices.

### Rewrite existing GitHub-bootstrap fixtures
Every server test that currently uses `PROVIDERS.github` / `GET /login/github` to create the first `full` user **must** switch to:
1. `POST /api/v1/setup` for the instance admin, then
2. GitLab or Gitea stub OAuth for a publisher when the case needs `full`.

Files known to use GitHub start/callback (non-exhaustive — grep `/login/github` and `PROVIDERS.github`):
`auth.test.ts`, `auth-cookie.test.ts`, `hosting.test.ts`, `agent-keys.test.ts`, `vault.test.ts`, `credential-profile-issues.test.ts`, `tasks.test.ts`, `import.test.ts`, `claim.test.ts`, `mcp.test.ts`, `poller.test.ts`, `webhook.test.ts`, `writeback.test.ts`, `events.test.ts`, `claim-confirm.test.ts`, `devices.test.ts`.

`auth-cookie.test.ts`: Secure cookie assertions must not depend on GitHub OAuth start. Use setup `POST` and/or GitLab start **after** setup.
`hosting.test.ts`: `/login/github` is 404, not 302.
`devices.test.ts`: bootstrap admin `permission_level` is `admin` (setup), not `full`. Publisher `full` is 403 on device routes.
Replace “KAOLA_ADMINS match inserts github full” with “KAOLA_ADMINS is ignored”.
Replace “uninvited GitLab after full exists” with “GitLab after setup **does** insert publisher”.

Keep unrelated behavioral assertions (claim envelope, writeback, poller, MCP tools, token reveal channels) intact — only change **how the user is created** and **who is admin vs publisher**.

### Web (vitest)
`apps/web/src/App.vue` tests (`App.shell.test.ts`, `App.form.test.ts`, `App.board.test.ts`, `App.devices.test.ts`, `App.settings.test.ts`, `App.audit.test.ts`):
- Mock `GET /api/v1/setup` `{ setup_complete: false|true }` as needed (unauthenticated fetch on login view).
- `setup_complete: false`: wizard (username + password). **No** GitHub/GitLab/Gitea as usable login buttons.
- `setup_complete: true`: local login form + GitLab + Gitea. **No** GitHub button / no `href="/login/github"`.
- `ME_ADMIN` (`permission_level: 'admin'`): header 管理员; 发布 nav; 待授权电脑 / 绑到我自己 / 认领者; 凭证档案; 受信自动化.
- `ME_FULL` (`permission_level: 'full'`): header 发布者; 发布 nav; 凭证档案; **not** pending devices / bind-self / claimants / promote; **not** trusted-automation / claim-confirmations.
- Publish form still offers GitHub as a **repo forge** option (D2). That is not a login button.
- `claim_only` leftover: still no 发布 (unchanged idea).

## Prove RED
Run against `86354f1` production (your new tests + rewritten tests). Capture the failure signature (test name + assertion/error) and SHA in:
`/workspace/kaola-workflow/bundle-27-28/.cache/tdd-red.log`

You do **not** need the entire `pnpm test` green — it must be **red** for the new contract. Existing tests you rewrote to the new contract will fail on baseline; that is the point.
Do not rewrite tests so they still pass on the old OAuth-bootstrap behavior.

## Stop and report
If a claim cannot be tested as stated, record it and stop. Do not invent HTTP paths except `GET /api/v1/setup` which DESIGN §11 already added as the SPA probe.

Do not change Task Brief / MCP tool tests except fixtures.
Do not add login rate-limit tests.
