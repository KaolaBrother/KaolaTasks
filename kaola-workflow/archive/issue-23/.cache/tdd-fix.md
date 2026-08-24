# TDD fix — issue #23 test defects (oracle 14)

Role: tdd-guide. Tests only. Production routes untouched.

baseline: `6c9f01cf7e61630bec48fd4f0f3525a4fb5f5137`

## Outcome

GREEN: `pnpm exec node --experimental-strip-types --test` on the nine listed files → **155 pass / 0 fail**.

The previous 14 oracle failures were test defects. They now match production + DESIGN + #22 clone/reveal pins.

No `production-gap:` items. Oracles were not weakened (clone still four keys `extra_header` / `remote_url` / `suggested_dir` / `token_usage`; claim envelope still top-level `token`).

## Failure signatures that were test defects

1. `assertCloneRecipe` — `clone.identity_usage` vs production `token_usage`
2. MCP two-task pin — `secondBody.identity` / `firstBody.identity` vs production `token`
3. `devices.test.ts` fetch stub — non-userinfo fetches 500 → `POST /api/v1/tasks` 422 `token_check_failed`
4. Duplicate helper export `export { pairDeviceToSelf as pairDeviceToSelf }` (illegal when the function is already that name)
5. writeback / webhook / poller / events still minted `ktk_` and claimed with Bearer — production rejects `ktk_`

## Paths edited

- `apps/server/src/claim-confirm.test.ts` — `clone.token_usage`; leftover Bearer release → `injectSigned`
- `apps/server/src/mcp.test.ts` — envelope `.token`; reveal filter `device_id`; leases SELECT `device_id`
- `apps/server/src/devices.test.ts` — dual fetch stub (`oauth` + `forge`, `allowForgeToken(INLINE_TOKEN)`); revoke POSTs send `payload: {}`
- `apps/server/src/device-proof.test-helpers.ts` — removed illegal identity re-export (function already `pairDeviceToSelf`; claim/mcp/claim-confirm already import that name). `export { pairDeviceToSelf as pairDeviceToSelf }` is a SyntaxError (`Duplicate export of 'pairDeviceToSelf'`).
- `apps/server/src/writeback.test.ts` — `pairDeviceToSelf` + `injectSigned` for claim/MCP
- `apps/server/src/webhook.test.ts` — same
- `apps/server/src/poller.test.ts` — same
- `apps/server/src/events.test.ts` — same; reveal pin `device_id`; leftover GitHub 待批准 / claim_only via seed+OAuth (closed-join); stats bob seeded in SQL so a second Gitea OAuth is not required after a full user exists

`apps/server/src/agent-keys.test.ts` session CRUD left alone.

## Command run

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

Result: tests 155, pass 155, fail 0. Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`.
