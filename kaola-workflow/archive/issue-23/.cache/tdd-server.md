# TDD report — issue #23 (server)

Role: tdd-guide. Tests only. No production implementation.

## Baseline

- Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`
- HEAD: `6c9f01cf7e61630bec48fd4f0f3525a4fb5f5137`

## Files added or changed

| Path | Change |
|------|--------|
| `apps/server/src/device-proof.test-helpers.ts` | **New** test-only helper: Ed25519 identity, canonical string, `injectSigned`, `pairDevice` / `pairDeviceToSelf` |
| `apps/server/src/devices.test.ts` | **New** admin bind/revoke/policy + unpaired 202 `authorization_required` |
| `apps/server/src/auth.test.ts` | Closed join: first OAuth `active`+`full`; later uninvited no insert; `KAOLA_ADMINS`; `revoked` no session |
| `apps/server/src/claim.test.ts` | Claim/progress/release identity is bound device proof; leftover `ktk_` is 401; leases/audit `device_id` |
| `apps/server/src/mcp.test.ts` | MCP + whoami use device headers; missing headers 401 `Kaola-Device`; leftover `ktk_` is not MCP identity |
| `apps/server/src/claim-confirm.test.ts` | #16 triple uses `device_id`; bind-to-self still #16; claimant-owned device skips #16 |
| `package.json` | `test` script appends `apps/server/src/devices.test.ts` |

## Red run

Command (worktree root, after `pnpm install`):

```text
pnpm exec node --experimental-strip-types --test \
  apps/server/src/auth.test.ts \
  apps/server/src/devices.test.ts \
  apps/server/src/claim.test.ts \
  apps/server/src/mcp.test.ts \
  apps/server/src/claim-confirm.test.ts
```

Result: **107 tests, 16 pass, 91 fail** (duration ~0.9s).

The 16 passes are **pre-existing** product behavior (GitLab/Gitea empty-db first login still `full`, leftover `待批准` seed+approve, empty `KAOLA_ADMINS` still `buildApp()`, login start redirects). **Do not treat them as new #23 oracles.**

## Failure signatures (old production, not syntax)

```
RED: GitHub first login persists active full user — AssertionError: '待批准' !== 'active'
RED: unauthenticated claim … WWW-Authenticate Kaola-Device — AssertionError: did not match /Kaola-Device/ (got Bearer)
RED: signed unpaired device proof on claim is 202 authorization_required — expected 202, got 401 { error: 'unauthorized' }
RED: pairDevice GET /api/v1/devices/pending expected 200, got 404 Route not found
RED: leftover ktk_ Bearer is 401 unauthorized — current HEAD still treats ktk_ as agent identity (403/400 JSON-RPC), not 401
baseline: 6c9f01cf7e61630bec48fd4f0f3525a4fb5f5137
```

Typical devices/claim/MCP bind path: `pairDevice: GET /api/v1/devices/pending expected 200, got 404`.

Typical closed-join: late GitLab/Gitea still `200` `permission_level: full` instead of `401` / `uninvited`.

## Notes for implementer

- Canonical payload and headers live in `device-proof.test-helpers.ts` (duplicate into production; do not import the test helper from `app.ts`).
- Admin paths follow architecture §4: `GET /api/v1/devices/pending`, `POST /api/v1/devices/:id/bind`.
- 202 body: `{ error: 'authorization_required', pending: true, expires_at }`. Distinct from #16 `confirmation_required`.
- Missing/bad proof: HTTP **401** `{ error: 'unauthorized' }`, `WWW-Authenticate: Kaola-Device` (not 202).
- Clone four keys and two-publicId different-token titles are unchanged oracles.
