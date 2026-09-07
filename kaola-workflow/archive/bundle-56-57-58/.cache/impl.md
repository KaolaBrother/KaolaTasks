# Implementation: forge-smoke harness repairs (#56 / #57 / #58)

Worktree: `/workspace/.kw/worktrees/bundle-56-57-58`  
File: `scripts/forge-smoke.ts` only  
Did not edit `scripts/forge-smoke.test.ts`, `docs/`, or `packages/forge-adapters`. Did not commit.

## Three repairs

### #56 `waitForUatFlag`

Empty `catch` swallowed `fail('unexpected UAT flag …')` because `fail()` throws. Catch now continues only on `ENOENT` (`isEnoent`); every other throw is rethrown, including `fail()` Errors and `unlinkSync` failures.

- Missing file: keep waiting.
- Empty / whitespace-only after trim: still no throw, keep waiting.
- Non-empty ≠ expected: `fail()` escapes immediately with `/unexpected UAT flag/`, `JSON.stringify` of redacted actual, `want ${expected}`.

### #57 `resolveSmokeListenHost`

Path C default changed from `'0.0.0.0'` to `'127.0.0.1'`. Comment updated.

- `web=false`: always `'127.0.0.1'` (ignores `UAT_WEB_HOST`).
- `web=true`: unset or empty `UAT_WEB_HOST` → `'127.0.0.1'`; non-empty env honored (including explicit `'0.0.0.0'`).
- `run()` still calls this helper; no raw `'0.0.0.0'` default remains in `scripts/forge-smoke.ts`.

### #58 `waitForForgeHead`

A single adapter abort-timeout (`err.name === 'TimeoutError'`, including undici/DOMException “The operation was aborted due to timeout”) continues the poll loop until `deadlineMs` (default 90s). Sha mismatch still continues. Auth/HTTP errors that are not timeouts still reject. Optional `getPullRequest` / `getHead` / `deadlineMs` / `pollDelayMs` seams unchanged.

## Out of scope (confirmed untouched)

- `packages/forge-adapters` `DEFAULT_TIMEOUT_MS` not changed.
- No `KAOLA_FORGE_TIMEOUT_MS` env reader added.
- Product API, login, and token-reveal not changed.

## Focused suite

```bash
cd /workspace/.kw/worktrees/bundle-56-57-58
node --experimental-strip-types --test scripts/forge-smoke.test.ts
```

- **before:** exit 1 — tests 14 / pass 8 / fail 6
- **after:** **exit 0** — tests 14 / pass 14 / fail 0 (`duration_ms` ~3660)
