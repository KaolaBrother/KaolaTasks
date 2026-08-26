# implementer — R1 skipUntrusted on setup/login

Worktree: `/workspace/.kw/worktrees/bundle-27-28`
File: `apps/server/src/auth.ts` only.
Tests: not edited (`*.test.ts` untouched). `persistSession` body unchanged.

## Diff

1. `POST /api/v1/setup` and `POST /api/v1/login` now call
   `await persistSession(request, <id>, { skipUntrusted: true })`.
   Both still return 201 / 200 with `publicUser(...)` when save is skipped
   (cookie withheld; user created / credentials valid). Same as OAuth
   (redirect even when cookie is skipped).

2. `shouldSkipSessionSave` still requires `cookie.secure === true` and
   `request.protocol !== 'https'`, and now also requires the TCP peer
   (`request.socket.remoteAddress`, `::ffff:` stripped) to be **outside**
   `COOKIE_SECURE_TRUST_PROXY` (loopback + RFC1918 via `node:net` `BlockList`).

   Why: skip-save with only the protocol check treats Fastify inject’s
   default loopback peer (`127.0.0.1`, no `X-Forwarded-Proto`) as skip,
   so `POST /setup` would omit `sessionId` and break the existing HTTPS
   Secure-cookie test plus `ensureSetup`. Untrusted public peers
   (`203.0.113.10`) still cannot flip `protocol` to `https`, still skip
   `save()`, so `@fastify/session` onSend does not emit `sessionId`.
   Trusted loopback / RFC1918 cookie issuance is unchanged.

## Commands

cwd: `/workspace/.kw/worktrees/bundle-27-28`

### Before (baseline, two persistSession calls without skipUntrusted)

`node --experimental-strip-types --test apps/server/src/auth-cookie.test.ts`  
exit 1 — tests 7, pass 5, fail 2  
(setup/login untrusted-peer Set-Cookie assertions)

### After (auth-cookie)

`node --experimental-strip-types --test apps/server/src/auth-cookie.test.ts`  
exit 0 — tests 7, pass 7, fail 0  
including: untrusted setup, untrusted login, loopback HTTPS setup Secure cookie, GitLab untrusted-peer.

### After (identity + auth + auth-cookie)

`node --experimental-strip-types --test apps/server/src/identity.test.ts apps/server/src/auth.test.ts apps/server/src/auth-cookie.test.ts`  
exit 0 — tests 42, suites 17, pass 42, fail 0
