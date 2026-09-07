# RED: `scripts/forge-smoke.test.ts` against worktree baseline

Worktree: `/workspace/.kw/worktrees/bundle-56-57-58`  
Tracked source baseline: `3d04f280f15f9575e81386e2c647fd5424f13197` (`3d04f28`)  
Suite: `scripts/forge-smoke.test.ts` (also appended to root `package.json` `"test"` `node --test` list)  
Mechanical production only: export `waitForUatFlag` / `waitForForgeHead`; extract `resolveSmokeListenHost` with **today’s** values (`web` → `env.UAT_WEB_HOST || '0.0.0.0'`; Path B → `'127.0.0.1'`); optional `getPullRequest`/`getHead` + `deadlineMs`/`pollDelayMs` on `waitForForgeHead` defaulting to `createForgeAdapter({ baseUrl })` + 90s / 3s. Empty `catch`, `--web` default bind, and TimeoutError swallow **unchanged**.

Did not run full `pnpm test` (full Node + web Vitest list). Focused RED is the new file.

## Command

```bash
cd /workspace/.kw/worktrees/bundle-56-57-58
node --experimental-strip-types --test scripts/forge-smoke.test.ts
```

## Result

- **exit code: 1**
- **tests 14 / pass 8 / fail 6 / duration_ms ~7758**
- Node 22.14.0 `--experimental-strip-types` warning on import (not a suite assertion)

## Assertions that failed (expected RED)

### #56 Path C hold — `waitForUatFlag`

| Test | Result | Failure signature |
|------|--------|-------------------|
| missing `go` waits; timeout mentions waiting, not unexpected flag | PASS | — |
| empty `go` waits the same as missing | PASS | — |
| whitespace-only `go` waits the same as missing | PASS | — |
| non-empty unexpected `go` rejects immediately with redacted actual and expected | **FAIL** | `AssertionError`: `/unexpected UAT flag/` vs actual `'timed out waiting for /tmp/kaola-uat-flag-DXb06b/go to contain round-done'` (`duration_ms` ~2004 vs hold `UAT_HOLD_TIMEOUT_MS=2000`) |
| unexpected `go` never includes the passed secret in the rejection | **FAIL** | same swallow: `/unexpected UAT flag/` vs `'timed out waiting for /tmp/kaola-uat-flag-pqARZh/go to contain round-done'` |
| exact expected after trim resolves and unlinks `go` | PASS | — |

Empty `catch` still swallows `fail('unexpected UAT flag …')`; wrong content waits until hold timeout.

### #57 listen — `resolveSmokeListenHost`

| Test | Result | Failure signature |
|------|--------|-------------------|
| Path B always `127.0.0.1` even if `UAT_WEB_HOST=0.0.0.0` | PASS | — |
| Path C default `127.0.0.1` when `UAT_WEB_HOST` unset | **FAIL** | `strictEqual`: actual `'0.0.0.0'`, expected `'127.0.0.1'` |
| Path C default `127.0.0.1` when `UAT_WEB_HOST` empty | **FAIL** | `strictEqual`: actual `'0.0.0.0'`, expected `'127.0.0.1'` |
| Path C honors `UAT_WEB_HOST=0.0.0.0` | PASS | — |
| Path C honors another explicit host | PASS | — |

### #58 `waitForForgeHead`

| Test | Result | Failure signature |
|------|--------|-------------------|
| injected first `getPullRequest` `TimeoutError` then matching sha resolves | **FAIL** | uncaught `TimeoutError`: `'The operation was aborted due to timeout'` (first poll aborts the waiter) |
| injected first `getHead` abort-timeout (`DOMException` `TimeoutError`) then match resolves | **FAIL** | same: `'The operation was aborted due to timeout'` |
| injected sha mismatch then match still resolves (#54) | PASS | — |

`packages/forge-adapters` `DEFAULT_TIMEOUT_MS` not touched; `KAOLA_FORGE_TIMEOUT_MS` not assumed.

```
RED: waitForUatFlag non-empty unexpected — AssertionError: /unexpected UAT flag/ vs timed out waiting
RED: waitForUatFlag secret in go — same timeout-instead-of-unexpected-flag
RED: Path C default listen — strictEqual 0.0.0.0 !== 127.0.0.1 (unset and empty)
RED: waitForForgeHead TimeoutError then match — TimeoutError: The operation was aborted due to timeout
RED: waitForForgeHead getHead abort-timeout then match — same TimeoutError
baseline: 3d04f280f15f9575e81386e2c647fd5424f13197
```
