# Implementer report — issue #24 cookie Secure + compose

Production only. Tests not edited.

## What changed

### Cookie Secure from PUBLIC_URL
`apps/server/src/auth.ts` exports `cookieSecureFromPublicUrl()`:

`trimTrailingSlash(process.env.PUBLIC_URL ?? 'http://localhost:31415').startsWith('https:')`

One `PUBLIC_URL` default (hosting source pin). Session cookie: `{ path: '/', secure: cookieSecure, httpOnly: true, sameSite: 'lax' }`. OAuth cookie: `{ path: '/', secure: cookieSecure }`. Not `'auto'`.

### trustProxy
`apps/server/src/app.ts` + exported `COOKIE_SECURE_TRUST_PROXY`:

When `cookieSecure`: `Fastify({ trustProxy: ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] })`.

When not: `Fastify()` (no trustProxy). Never `1` or `true`.

### Pre-save vs untrusted peer
`@fastify/session` onSend still `Set-Cookie`s a **pre-saved** session when `secure && protocol !== 'https'`. `completeOAuthLogin` already `await request.session.save()`. That minted `sessionId` for inject `remoteAddress` `203.0.113.10`. Skip `save()` when `cookie.secure === true && request.protocol !== 'https'` so spoofed `X-Forwarded-Proto` from an untrusted peer gets no session cookie. Trusted loopback / `172.18.0.1` still get Secure `sessionId`.

OAuth start `/login/github` still serializes `Secure` via `@fastify/cookie` without `X-Forwarded-Proto`.

### Compose
`docker-compose.yml`: `"127.0.0.1:31415:31415"`, `SQLITE_PATH: /data/kaola.sqlite`, `env_file: .env`, pass-through `${…}` for PUBLIC_URL, SESSION_SECRET, VAULT_MASTER_KEY, nine OAUTH_* vars. PORT 31415, HOST 0.0.0.0, `kaola-data:/data` kept. No secret literals.

## Commands

```
cd /workspace
node --experimental-strip-types --test apps/server/src/auth-cookie.test.ts apps/server/src/hosting.test.ts apps/server/src/auth.test.ts
```

**Before:** 35 tests, 30 pass, 5 fail (cookie Secure ×4, compose pin). HTTP Secure-absent in `auth.test.ts` already green.

**After:** 35 tests, **pass 35, fail 0**, exit 0.

HTTP pin still green: `session Set-Cookie does not include Secure when PUBLIC_URL is http://localhost`.
