# Finalization — Summary: bundle-27-28

## Delivered
#28 identity: empty-DB setup wizard (`local` admin), GitLab/Gitea publishers after an admin exists, GitHub login 404, split publish vs instance gates, admin 升级入口 on the 电脑 pane. Setup/login share OAuth `skipUntrusted` so an untrusted public peer cannot mint `sessionId`.

#27 this round: schema/hash foundation (`password_hash`, `local`, `admin`, `users_local_username`, scrypt). Remaining memo candidates (rate-limit, helmet, device nonce, GCM AAD, Dockerfile USER) were not implemented.

Forge token reveal channels unchanged: REST claim 201 `token` and MCP `claim_task` success `token`.

## Files Changed
Worktree `/workspace/.kw/worktrees/bundle-27-28` on `cursor/bundle-27-28-7976`, fast-forwarded to `main` at `9338fed`.

## Test Coverage
`apps/server/src/identity.test.ts`, `password.test.ts`, `auth-cookie.test.ts` untrusted setup/login, `apps/web/src/App.devices.test.ts` promote widget.

## Validation
verdict: pass
command: `pnpm test && pnpm lint && pnpm typecheck`
validated_candidate_hash: `9338fed`
tree: `/workspace/.kw/worktrees/bundle-27-28`

## Changed Paths
See `git log aef8792..9338fed --stat`.

## Mission List
All items done. R1 skipUntrusted fixed; promote UI landed; issues #27 and #28 closed.

## Documentation Docking
DOCKED: DESIGN v0.3, api.md, architecture.md, README, smoke-test, CHANGELOG, CLAUDE.md.

## Run gaps
- leftover-hardening (rate-limit / helmet / device nonce / GCM AAD / Dockerfile USER): noise: left on closed #27 memo for humans to split later
- html-form-415 (GET /login urlencoded POST): noise: Vue JSON login is the product path; HTML form is fail-closed

## Follow-Up Items
None filed.

## Status: READY FOR FINAL GIT GATE
merged to main without a pull request, per user instruction.
