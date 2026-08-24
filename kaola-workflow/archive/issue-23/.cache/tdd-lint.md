# TDD lint — test-file TypeScript / ESLint (issue #23)

Role: tdd-guide. Test paths only. Did not edit `device-proof.ts`, `claim.ts`, or `devices.ts`.

baseline: `6c9f01cf7e61630bec48fd4f0f3525a4fb5f5137`

## Assigned gates

| Command | Result |
|---|---|
| `pnpm --filter @kaola/server typecheck` | **exit 0** — `device-proof.test-helpers.ts` no longer reports implicit `any` / Buffer vs string |
| `pnpm exec eslint apps/server/src/device-proof.test-helpers.ts apps/server/src/claim.test.ts apps/mcp/src/main.test.ts` | **exit 0** |

Also eslint-clean after unused-helper removal: `claim-confirm.test.ts`, `mcp.test.ts`, `tasks.test.ts`, `vault.test.ts`, `import.test.ts`, `events.test.ts`, `credential-profile-issues.test.ts`.

## What changed (tests only)

- `apps/server/src/device-proof.test-helpers.ts` — TypeScript types on helpers (`DeviceIdentity`, `InjectSignedOptions`, `FastifyInstance`, `Buffer` bodies). Optional `nowSeconds` / `cookies` remain optional so `injectSigned` callers that omit them still typecheck.
- Removed unused imports/consts/helpers (assertions untouched):
  - `apps/mcp/src/main.test.ts` — `writeFileSync`
  - `apps/server/src/claim-confirm.test.ts` — `PENDING_CLAIM_MESSAGE`, `AGENT_KEY_RE`, `loginGithub`
  - `apps/server/src/claim.test.ts` — `PENDING_CLAIM_MESSAGE`, `AGENT_KEY_RE`, `loginGithub`, `approveUser`
  - `apps/server/src/credential-profile-issues.test.ts` — `loginGithub`, `approveUser`
  - `apps/server/src/events.test.ts` — `loginGithub`, `approveUser`
  - `apps/server/src/import.test.ts` — `loginGithub`, `approveUser`
  - `apps/server/src/mcp.test.ts` — `generateDeviceIdentity`, `PENDING_CLAIM_MESSAGE`, `AGENT_KEY_RE`, `loginGithub`
  - `apps/server/src/tasks.test.ts` — `loginGithub`, `approveUser`
  - `apps/server/src/vault.test.ts` — `loginGithub`

## Targeted tests

```
pnpm exec node --experimental-strip-types --test \
  apps/server/src/claim.test.ts \
  apps/server/src/mcp.test.ts \
  apps/server/src/devices.test.ts \
  apps/mcp/src/main.test.ts
```

**Did not stay green.** Load failure (not an assertion on the linted helpers):

```
RED: apps/server/src/claim.test.ts — ERR_MODULE_NOT_FOUND
Cannot find module '.../packages/shared/src/device-proof.js'
imported from packages/shared/src/index.ts
baseline: 6c9f01cf7e61630bec48fd4f0f3525a4fb5f5137
```

Same `ERR_MODULE_NOT_FOUND` on `mcp.test.ts`, `devices.test.ts`, and `apps/mcp/src/main.test.ts` `loadBridge` (`apps/mcp/src/main.ts must export the stdio bridge`).

Cause is **production** `packages/shared/src/index.ts` re-export `from './device-proof.js'`. This repo runs TS source with `--experimental-strip-types` and **`.ts` specifiers** (`from './db.ts'`). Direct `import './packages/shared/src/device-proof.ts'` loads; the `.js` specifier does not remap.

tdd-guide cannot edit `packages/shared/src/index.ts`. Implementer should switch that specifier to `./device-proof.ts` (repo convention) so the four-file command can pass.

This load error is independent of the helper typings / unused-import edits.
