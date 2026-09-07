# Code review — frozen candidate `fc405db` (issues #56 #57 #58)

Reviewer: code-reviewer. Read-only. Product / repository files were not edited. The only write is this file.

**Candidate:** `/workspace/.kw/worktrees/bundle-56-57-58` @ `fc405db0798e89e47cac454df3794b78e09f5141` (`cursor/smoke-uat-fixes-772b`)

**Baseline:** `3d04f28` (main at claim)

**Diff:** `git diff 3d04f28..fc405db`

**Changed files:** `scripts/forge-smoke.ts`, `scripts/forge-smoke.test.ts`, `package.json`, `docs/smoke-test.md`, `CHANGELOG.md`

**Scope:** hold protocol (`waitForUatFlag`), listen bind (`resolveSmokeListenHost`), timeout handling (`waitForForgeHead` / `isAbortTimeout`), test seam correctness, docs honesty. Path B without `--web` must stay loopback. Production adapter `DEFAULT_TIMEOUT_MS` must stay 10s. Do not resume #55.

**Acceptance already owned:** `scripts/forge-smoke.test.ts` (not weakened). Focused suite re-run on this freeze:

```
cd /workspace/.kw/worktrees/bundle-56-57-58
node --experimental-strip-types --test scripts/forge-smoke.test.ts
```

Result: exit 0, tests 14 / pass 14 / fail 0 (`duration_ms` ~3672).

**Verdict: PASS.** No candidate-caused defect admitted.

---

## Admitted findings

None.

verdict: pass
findings_blocking: 0

---

## Checked and clean — hold protocol (#56)

Primary anchor: `scripts/forge-smoke.ts` `waitForUatFlag` / `isEnoent`.

- Parent `3d04f28` empty `catch` swallowed `fail('unexpected UAT flag …')` because `fail()` throws `Error`. Candidate catch continues only when `err.code === 'ENOENT'`. `fail()` Errors have no `code`, so unexpected content escapes immediately.
- Missing `go`: `readFileSync` ENOENT → wait. Empty / whitespace-only after `.trim()`: `got === ''` skips both success and fail → wait (orchestrator given).
- Non-empty ≠ expected: `fail(\`unexpected UAT flag ${JSON.stringify(got)} (want ${expected})\`)` with `got` already passed through `redact(..., secrets)`. Order is trim → redact → compare → stringify. Tests pin immediate reject (`elapsed < 400` vs 2000ms hold) and secret absence (`wrong-***`, raw PAT not in message).
- Exact expected after trim: unlink + return. Callers remain Path C only (`round-done`, then `approved`) after `secrets.push(revealed)`.
- Other FS errors (`EISDIR`, `EACCES`) now fail closed instead of waiting until hold timeout. That is a tightening of the old empty catch, not a protocol regression.

## Checked and clean — listen bind (#57)

Primary anchor: `scripts/forge-smoke.ts` `resolveSmokeListenHost` and `run()` `app.listen`.

- Path C default changed from `'0.0.0.0'` to `'127.0.0.1'`. `web ? (env.UAT_WEB_HOST || '127.0.0.1') : '127.0.0.1'`. No remaining `'0.0.0.0'` default literal in `scripts/forge-smoke.ts`.
- Path B (`web=false`) is always `'127.0.0.1'` and ignores `UAT_WEB_HOST` (including `0.0.0.0` / LAN IPs). Port remains `0` (ephemeral). Tests pin this.
- Path C: unset or empty `UAT_WEB_HOST` → loopback; non-empty honored, including explicit `0.0.0.0`. Browser origin remains `http://localhost:${webPort}` (cookie host), separate from listen address.
- Production `HOST` and compose `127.0.0.1:31415:31415` are not in the diff.

## Checked and clean — forge-head timeout (#58)

Primary anchor: `scripts/forge-smoke.ts` `waitForForgeHead` / `isAbortTimeout`; adapter `packages/forge-adapters/src/index.ts` `DEFAULT_TIMEOUT_MS` / `forgeRequest`.

- Outer deadline still `options?.deadlineMs ?? 90_000`. Poll sleep still `options?.pollDelayMs ?? 3_000`. Production `run()` does not pass options; live path still `createForgeAdapter(kind, { baseUrl: spec.baseUrl })` with no `timeoutMs`, so each `getPullRequest` still inherits package `DEFAULT_TIMEOUT_MS = 10_000`.
- `git diff 3d04f28..fc405db -- packages/forge-adapters/src/index.ts` is empty. `DEFAULT_TIMEOUT_MS` is still `10_000`. No `KAOLA_FORGE_TIMEOUT_MS` reader was added.
- Continue-poll is `err.name === 'TimeoutError'` only. Measured on this Node 22: hung `fetch` + `AbortSignal.timeout` rejects as `DOMException` `{ name: 'TimeoutError', message: 'The operation was aborted due to timeout' }` — the same shape as the #55 GitLab live log. Tests inject that Error name and a `DOMException` TimeoutError, then a matching sha; both resolve.
- Adapter non-OK HTTP is `throw new Error(\`getPullRequest: ${kind} responded ${res.status}\`)` (`name === 'Error'`). Auth/5xx therefore still abort the waiter. Sha mismatch still continues (#54 test kept).
- No `KAOLA_FORGE_TIMEOUT_MS` env is required for the continue-poll path.

## Checked and clean — test seams and docs

- New named exports (`waitForUatFlag`, `resolveSmokeListenHost`, `waitForForgeHead` + `ForgeHeadLookup`) are mechanical. `run()` stays behind `isMain`. Injected `getHead` / `getPullRequest` default to the real adapter when omitted.
- Root `package.json` `"test"` list includes `scripts/forge-smoke.test.ts`. Acceptance was not weakened: missing/empty wait, immediate unexpected fail + redact, Path B loopback, Path C default loopback, TimeoutError then match.
- `docs/smoke-test.md` hold paragraph, HTTP row, and 坑 bullets match the new runtime. Historical #55 GitLab cell still records Issue #24 / #25 and names `KAOLA_FORGE_TIMEOUT_MS` as an unimplemented historical workaround, not a live knob. CHANGELOG Unreleased bullets match. DESIGN / product API / login / token-reveal untouched.

---

## Observations (not admitted)

- Focused suite does not inject a non-timeout `getPullRequest` rejection (`responded 401/500`). Live adapter shape still rethrows those. Residual coverage, not a production defect.
- `waitForForgeHead` fail text hardcodes `within 90s` even if a caller passes `deadlineMs`. Production `run()` never passes that option; the live message stays accurate.
- `isAbortTimeout` is name-only. A timeout wrapped as `TypeError: fetch failed` with `cause.name === 'TimeoutError'` would fail closed (rethrow). Measured Node 22 hung-fetch abort is top-level `TimeoutError`, matching the live log.
- Post-approve `createForgeAdapter` + single `getPullRequest` later in `run()` still has no continue-poll. That call is outside the #58 waiter loop (already true on `3d04f28`).
- Explicit `UAT_WEB_HOST=0.0.0.0` remains an operator override, documented as such.

## Out of scope / unchanged

- Product API, login, token-reveal channels.
- `packages/forge-adapters` `DEFAULT_TIMEOUT_MS`.
- Issue #55 Path C product behavior (not resumed).
- Live Path B `pnpm smoke:forge` (owned by the validation mission, not this review).
