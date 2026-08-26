# tdd-guide — fixture defects after #28 production (961e081)

Production is GREEN on identity oracle (password/identity/auth/auth-cookie/hosting/devices HTTP). Full `pnpm test` is RED because **tests still describe the old identity**. Do not change production. Do not weaken behavioral assertions except identity fixtures.

Worktree: `/workspace/.kw/worktrees/bundle-27-28`

## Product facts (do not fight these)

- `ensureSetup` → local `admin` (id 1 typically).
- GitLab/Gitea OAuth after setup → `full` publisher. Publishers can POST tasks; cannot bind devices, cannot PUT `/me/settings`, cannot GET claim-confirmations.
- `pairDeviceToSelf` in `device-proof.test-helpers.ts` **always** `ensureSetup` then `bind_to_self` (ignores passed cookies). Device owner is the **setup admin**, not the publisher whose cookies were passed.
- Leftover `claim_only`: sqlite insert + GitLab/Gitea OAuth reuse. Never `/login/github`.

## Required test repairs

### 1. `apps/web/src/App.devices.test.ts`
`电脑页 — 发布者没有实例管理` (ME_FULL, no bind UI) is correct.

These three still mount `ME_FULL` and expect bind UI — they must use `ME_ADMIN`:
- `空 我的电脑 列表显示 暂无已绑定的电脑。`
- `空认领者下拉提示输入显示名新建`
- `认领者显示名提交 POST { claimant_display_name }`

Default `mountApp` is already `ME_ADMIN`. Only those three are wrong.

### 2. `loginGitea === ensureSetup` alias
Several files stub `loginGitea` as `return ensureSetup(app)`:
`claim.test.ts`, `mcp.test.ts`, `events.test.ts`, `claim-confirm.test.ts`, `poller.test.ts`, `webhook.test.ts`, `writeback.test.ts`.

That makes the poster an **admin**, which is OK for “publish + bind_to_self + claim” loops.

Fix assertions that still say `permission_level === 'full'` on `loginGitea` (e.g. claim.test `active full can claim`) → `admin`. Rename the test to “active admin can claim via bind_to_self” if you rename.

`tasks.test.ts` / `vault.test.ts` / `import.test.ts` / `credential-profile-issues.test.ts` already do real Gitea OAuth (publisher). Leave those as publishers unless a case needs bind.

### 3. Two identities that must not collapse
`mcp.test.ts` / `claim.test.ts` “non-holder progress/release”:
- poster `loginGitea` = admin
- other `loginGitlab` = publisher
- `mintAgentKey` + `pairDeviceToSelf` binds **both** devices to the same admin → bystander is not a non-holder.

Use `pairDevice(app, adminCookies, { claimant_display_name: 'bystander' })` (or equivalent) for the second identity so the lease holder and the bystander are different owners. Keep the forbidden assertion.

Same pattern anywhere two `loginGitea`/`pairDeviceToSelf` were meant to be two people.

### 4. `agent-keys.test.ts`
After `pairDeviceToSelf(app, gitlab.cookies)`, whoami `user_id` is the **setup admin**, not `gitlab.body.id`. Assert admin id (`ensureSetup` / `getSetupAdmin`). Publishers can still mint leftover `ktk_` keys; device whoami owner is admin.

### 5. Dead GitHub OAuth fixtures
Remove unused `PROVIDERS.github` / `githubOAuth2` objects that would throw if used (plugin not registered): `events.test.ts`, `claim.test.ts`, `mcp.test.ts`, `devices.test.ts`, `agent-keys.test.ts`, `claim-confirm.test.ts`, etc. Leftover GitHub **rows** may still be sqlite-inserted; they must not log in via `/login/github`.

### 6. claim-confirm settings
`loginGitea` as ensureSetup makes PUT settings 200 (admin). That matches #28. Do not switch that poster to a publisher unless you also stop asserting 200 on PUT settings.

Publisher 403 on settings is already in `identity.test.ts`.

### 7. Typecheck / lint of test files
`pnpm typecheck` currently fails on `auth.test-helpers.ts` implicit `any`. Add types or JSDoc so `apps/server` typecheck passes.
`pnpm lint` unused symbols in `*.test.ts` — remove unused `PROVIDERS.github` etc.

## Prove GREEN

Run:
```
cd /workspace/.kw/worktrees/bundle-27-28
pnpm test
pnpm typecheck
pnpm lint
```

All must pass. Record output in `/workspace/kaola-workflow/bundle-27-28/.cache/tdd-green.log`.

Do not edit production `.ts`/`.vue` except you must not touch them. `device-proof.test-helpers.ts` and `auth.test-helpers.ts` are test custody — you may adjust helpers (e.g. `pairDeviceToClaimant`) but do not change production bind semantics.

If you change `pairDeviceToSelf` to honor cookies, publishers still cannot bind (403) — then smoke/tests that pass publisher cookies would break. Keep “always setup admin” OR document that callers must pass admin cookies and use `pairDevice` for claimants.

## Stop
Do not invent GitHub login. Do not assert publishers can bind. Do not weaken claim envelope / token-reveal tests.
