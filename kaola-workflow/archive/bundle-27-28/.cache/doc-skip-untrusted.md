# doc-updater: skipUntrusted / persistSession

Ground truth: `apps/server/src/auth.ts` (`persistSession` + `shouldSkipSessionSave` + `isTrustedSessionPeer`; call sites `completeOAuthLogin`, `POST /api/v1/setup`, `POST /api/v1/login`). No production/test edits. No git commit/push.

## Changed

### `docs/api.md` (worktree)

- Cookie/`trustProxy` paragraph: replaced OAuth-only skip (`After OAuth login, if cookie.secure && protocol !== https, skip session.save() and still redirect`) with three `persistSession(..., { skipUntrusted: true })` sites, `shouldSkipSessionSave` conjunct `!isTrustedSessionPeer`, `node:net` `BlockList` + `::ffff:` strip, no `session.save()` / no `sessionId` on skip, OAuth redirect / setup `201` / login `200` still, trusted loopback/RFC1918 still get Secure `sessionId`, untrusted public peer spoofing `X-Forwarded-Proto` does not.
- `POST /api/v1/setup`: replaced `Sets session, writes events… 201` with `Calls persistSession(..., { skipUntrusted: true }) then writes events… 201`. Added: untrusted HTTP peer with `PUBLIC_URL` https does not get `Set-Cookie`; `201` body still returns.
- `POST /api/v1/login`: replaced `Success: session + 200 public user JSON.` with `persistSession(..., { skipUntrusted: true }) then 200`. Added: untrusted HTTP peer with `PUBLIC_URL` https does not get `Set-Cookie`; `200` body still returns.

### `docs/architecture.md` (worktree)

- Auth stack paragraph: replaced `Login callback skips session.save() when cookie.secure === true and request.protocol !== 'https'.` with three `persistSession` sites plus `isTrustedSessionPeer` / `COOKIE_SECURE_TRUST_PROXY` / `BlockList` / `::ffff:` conjunct.

### `CHANGELOG.md` (worktree)

- Unreleased `#28` only: after `POST /api/v1/login` 本地会话 inserted `; setup/login 与 OAuth 同走 persistSession 的 skipUntrusted`. Did not rewrite `#24`.

## Skipped (with reason)

- `docs/DESIGN.md` — instructed not to change contracts.
- `CLAUDE.md` Commands — no sentence claiming skip-save is OAuth-only.
- `#24` changelog bullet — left intact; clause went on `#28`.
- `README.md`, `docs/README.md`, `.env.example` — no stale skip-save / always-Set-Cookie claim found.
- `docs/CODEMAPS/` / `scripts/codemaps/` — neither exists; not invented.
