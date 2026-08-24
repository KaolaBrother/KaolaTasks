# Implementer report — issue #23 server identity

## task

Implement Kaola Tasks issue #23 **server identity** in worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`: Ed25519 device proof on MCP / REST claim / progress / release / whoami; pending 202 `authorization_required`; admin bind/revoke/policy; closed-join OAuth; leases/confirmations keyed by `device_id`. Tests are the oracle. Do not author tests. Do not build `apps/mcp` or rewrite `apps/web`.

## verification tier

`tests-green` — **not reached**. Latest oracle run is **93 pass / 14 fail / 107 tests**. Remaining failures are classified below; production typecheck (excluding pre-existing test-helper `any` noise) is clean.

## files changed

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`

| Path | Change |
|------|--------|
| `packages/shared/src/device-proof.ts` | **New** — canonical string, skew constant, fingerprint |
| `packages/shared/src/index.ts` | Re-export device-proof helpers |
| `apps/server/src/schema.ts` | `claimants`, `devices`; user policy columns; `revoked`; leases/confirmations `device_id` |
| `apps/server/src/db.ts` | New DDL + ALTER duplicate-column swallow |
| `apps/server/src/device-proof.ts` | **New** — verify headers, replay cache, pending insert/reuse, hook outcomes |
| `apps/server/src/devices.ts` | **New** — pending/bind/revoke/claimant settings + whoami |
| `apps/server/src/auth.ts` | Closed join, first-full bootstrap, `KAOLA_ADMINS`, no GitLab/Gitea auto-full, `revoked` |
| `apps/server/src/claim.ts` | `AgentPrincipal` = device + owner; #16 user-only; leases by owner; reveal `device_id` |
| `apps/server/src/leases.ts` | Nullable claimer user/claimant; required `device_id` |
| `apps/server/src/claim-confirmations.ts` | Lookup triple `(task, user, device_id)` |
| `apps/server/src/mcp.ts` | Device proof hook instead of `ktk_` Bearer |
| `apps/server/src/agent-keys.ts` | Session CRUD kept; whoami moved off Bearer |
| `apps/server/src/app.ts` | `registerDevices` after `registerClaim` |
| `apps/server/src/device-proof.test-helpers.ts` | Removed a **duplicate export** (`export const pairDeviceToSelf = pairDeviceToSelf`) that made the helper a SyntaxError so the oracle files could not load. No assertions changed. |

Canonical production string (duplicated from the helper, **not** imported from `*.test-helpers.ts`):

```
kaola-device-v1
${ts}
${nonce}
${METHOD}
${pathname}
${body_sha256_hex}
```

No trailing newline after the hash. Skew 300s. In-memory nonce replay.

## verification commands

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23
pnpm exec node --experimental-strip-types --test \
  apps/server/src/auth.test.ts \
  apps/server/src/devices.test.ts \
  apps/server/src/claim.test.ts \
  apps/server/src/mcp.test.ts \
  apps/server/src/claim-confirm.test.ts
```

Exit code: **1** (14 failures).

```
ℹ tests 107
ℹ suites 32
ℹ pass 93
ℹ fail 14
ℹ duration_ms ~1080
```

`pnpm --filter @kaola/server typecheck`: fails only on `device-proof.test-helpers.ts` implicit `any` (test file, pre-existing). No remaining errors in production `src/*.ts`.

## before

Oracle suite at HEAD before this dispatch (tdd-server.md): **107 tests, 16 pass, 91 fail**. Typical reds: GitHub first login `'待批准' !== 'active'`; WWW-Authenticate still `Bearer`; unpaired signed claim 401 not 202; `GET /api/v1/devices/pending` 404; leftover `ktk_` still treated as MCP identity.

## after

**93 pass / 14 fail.** Auth closed-join, unpaired MCP 202, missing/bad proof 401 `Kaola-Device`, leftover `ktk_` 401, bind_to_self, pending whoami 202, MCP pending `list_tasks` 202 are in the green set.

### Remaining 14 (do not treat as production-green)

**A. `claim-confirm.test.ts` — `clone.identity_usage` vs pinned keys `token_usage` (test defect)**

`assertCloneRecipe` pins `Object.keys(clone)` to `['extra_header', 'remote_url', 'suggested_dir', 'token_usage']` then reads `clone.identity_usage`. Those cannot both be true. Production emits `token_usage` (matches `claim.test.ts`). Failures that die in `assertCloneRecipe` line ~582:

- no body / autonomous:false still 201
- MCP claim_task without autonomous
- instructed claim ignores leftover rejected row
- GET `/api/v1/me` defaults trusted_automation (fails later in `assertClaim201`, not on `/me`)
- approve then agent retry
- MCP approve then retry claim_task

**B. `devices.test.ts` — `POST /api/v1/tasks` 422 `token_check_failed` (test stub gap)**

`stubUserinfoByAccessToken` 500s any non-userinfo fetch. Publish still validates the forge token. `claim.test.ts` stubs forge; these devices cases do not. Failures:

- signed unknown device on REST claim
- full session lists pending; bind `{ claimant_display_name }`
- after bind, same keypair claim 201
- revoke claimant → 403
- revoke device → 403

**C. `mcp.test.ts` — reads `body.identity` after envelope with top-level `token`**

- `claim_task` on a second `task_id` — `assert.notEqual(secondBody.identity, firstBody.identity)` when both are `undefined`
- second `claim_task` conflict count — likely same envelope parse / first claim not actually holding a token

**D. claimant-owned device skips #16** — likely the same 422 on task create or bind path as (B).

## notes for orchestrator / tdd-guide

1. Please fix `claim-confirm.test.ts` `clone.identity_usage` → `clone.token_usage` (keys already say `token_usage`).
2. Please stub forge token validation in `devices.test.ts` the same way as `claim.test.ts`, or allow non-userinfo `fetch` to pass through.
3. Please read MCP claim envelope `token`, not `identity`.
4. `writeback.test.ts` / `webhook.test.ts` / `poller.test.ts` / `events.test.ts` still mint `ktk_` and were left red on purpose.

Replay cache is in-process `Map` (single Fastify + SQLite). Changing max age does not rewrite existing `devices.expires_at`. Claimant claims write `actor_user_id: null`. `#16` runs only for bind-to-self user + autonomous + `!trusted_automation`.
