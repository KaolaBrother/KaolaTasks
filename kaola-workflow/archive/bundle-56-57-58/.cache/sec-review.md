# Security review — frozen candidate `fc405db` (issues #56 #57 #58)

Reviewer: security-reviewer. Read-only. Product files were not edited. The only write is this file.

**Candidate:** `/workspace/.kw/worktrees/bundle-56-57-58` @ `fc405db0798e89e47cac454df3794b78e09f5141` (`cursor/smoke-uat-fixes-772b`)

**Baseline:** `3d04f28`

**Diff:** `git diff 3d04f28..fc405db`

**Changed files:** `scripts/forge-smoke.ts`, `scripts/forge-smoke.test.ts`, `package.json`, `docs/smoke-test.md`, `CHANGELOG.md`

**Product files:** none (`apps/`, `packages/` untouched). Login, claim `201`, and MCP `claim_task` were not modified.

**Surface reviewed:** Path C `--web` listen bind; `waitForUatFlag` fail-message redact; `waitForForgeHead` TimeoutError continue-poll vs auth/HTTP errors; logs/handbook/tests for real tokens; no new token-reveal channel.

**Method:** full read of the candidate diff plus callers (`run()`, `writeUatState`, claim/`secrets` assembly, adapter `getPullRequest` / `forgeRequest`). Walked OWASP classes against attacker-reachable paths. Test fixture strings treated as non-secrets.

**Verdict: PASS.** No candidate-caused security defect admitted.

---

## Admitted findings

None.

verdict: pass
findings_blocking: 0

---

## Checked and clean — Path C listen bind (#57)

Primary anchor: `scripts/forge-smoke.ts` `resolveSmokeListenHost` and `run()` `app.listen`.

- Parent `3d04f28` Path C default was `process.env.UAT_WEB_HOST || '0.0.0.0'`. Candidate default is `'127.0.0.1'`. No remaining `0.0.0.0` literal in `scripts/forge-smoke.ts`.
- Path B (`web=false`) is always `'127.0.0.1'` and ignores `UAT_WEB_HOST` (including `0.0.0.0` / LAN IPs).
- Path C override is explicit: unset or empty `UAT_WEB_HOST` stays loopback; any non-empty value is honored, including operator-chosen `0.0.0.0`. That is the documented knob, not a silent widening.
- Browser origin remains `http://localhost:${UAT_WEB_PORT}` (cookie host). Listen address is separate. Production `HOST` and compose `127.0.0.1:31415:31415` are unchanged.
- Isolated sqlite still uses `ensureSetup(app, DEFAULT_SETUP)` and still stores the live PAT in the vault. Reveal is still only REST claim `201` and MCP `claim_task` success. This change does not add a login route, does not weaken `skipUntrusted`, and does not print `DEFAULT_SETUP.password` into `state.json` (username only, pre-existing).
- Net effect vs `0.0.0.0`: LAN peers can no longer hit Path C `POST /api/v1/login` with the published test-helper password unless the operator sets `UAT_WEB_HOST`. That narrows exposure; it is not a backdoor.

## Checked and clean — `waitForUatFlag` redact (#56)

Primary anchor: `scripts/forge-smoke.ts` `waitForUatFlag`.

- Order is `readFileSync` → `.trim()` → `redact(..., secrets)` → compare → `fail(\`unexpected UAT flag ${JSON.stringify(got)} (want ${expected})\`)`. Secrets in the helper argument cannot appear in the rejection text; the new test pins that with a fake `glpat-…` fixture.
- `fail()` throws `Error` with no `code`. Catch rethrows unless `err.code === 'ENOENT'`, so unexpected-flag failures escape immediately instead of being swallowed until hold timeout.
- Callers (both Path C holds) run after `secrets.push(revealed)` and pass `[env PAT, STUB_OAUTH_ACCESS, revealed]`. Success logs print only the expected token (`round-done` / `approved`), not file bytes.
- Timeout message is path + expected only. Empty/whitespace `go` still waits (orchestrator given).
- This is not a new reveal channel: the fail string now actually reaches `run().catch` stderr, but only after redact.

## Checked and clean — `waitForForgeHead` continue-poll (#58)

Primary anchor: `scripts/forge-smoke.ts` `waitForForgeHead` / `isAbortTimeout`; live adapter `packages/forge-adapters/src/index.ts` `getPullRequest` + `forgeRequest`.

- Continue-poll is only `err.name === 'TimeoutError'` (undici/DOMException abort-timeout from `AbortSignal.timeout(DEFAULT_TIMEOUT_MS)`).
- Non-OK HTTP is `throw new Error(\`getPullRequest: ${kind} responded ${res.status}\`)` with default `name === 'Error'`. 401/403/5xx therefore rethrow and fail the smoke. Network errors that are not named `TimeoutError` also rethrow.
- Production `DEFAULT_TIMEOUT_MS` (10s) is unchanged. No `KAOLA_FORGE_TIMEOUT_MS` reader was added. Outer deadline remains 90s.
- Live `run()` does not pass injected lookups; token still goes only to `adapter.getPullRequest({ token }, prUrl)`. Fail text uses 12-char git SHA slices, not the PAT.
- Catch of TimeoutError does not log the error object (no token dump).

## Checked and clean — logs / handbook / tests / dependencies

- Candidate docs and CHANGELOG describe bind, redact, and poll behavior. No real PAT material.
- `scripts/forge-smoke.test.ts` uses the obvious fixture `glpat-super-secret-pat-value` (false-positive control: test credential). Dummy forge URLs are `*.example.invalid`.
- `package.json` only appends `scripts/forge-smoke.test.ts` to the existing Node `--test` list. No dependency add/bump.

## Observations (not admitted)

- Pre-existing Path C trust model: isolated sqlite still holds a live forge PAT behind local-admin `DEFAULT_SETUP`. Handbook still points operators at that test-helper password. Candidate did not invent this; loopback default reduces who can reach it.
- Pre-existing: HTTP `PUBLIC_URL` means `skipUntrusted` does not block session cookies for non-loopback peers. Only material if someone sets `UAT_WEB_HOST` off-loopback.
- Residual test gap: focused suite pins TimeoutError continue-poll and sha mismatch, but does not inject a `responded 401/403/500` Error. Live adapter shape still makes those reject. Not a product defect.
- `isAbortTimeout` is name-only. That matches Node abort-timeout and does not match adapter HTTP `Error`s. A wrapped timeout would fail closed (rethrow), which is acceptable.
- Explicit `UAT_WEB_HOST=0.0.0.0` remains an operator footgun, documented as such.

## Out of scope / unchanged

- Product login, OAuth, vault, claim `201`, MCP `claim_task`.
- Compose publish bind and production `HOST`.
- Adapter package timeout default.

review_conclusion: Frozen harness candidate fc405db narrows Path C listen to loopback, redacts UAT flag failures before stringify, and continues forge-head polls only on TimeoutError while HTTP auth errors still reject, with no new login backdoor or token-reveal channel.
