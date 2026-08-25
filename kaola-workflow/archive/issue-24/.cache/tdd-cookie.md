# TDD report — issue #24 cookie / compose

Custody: tdd-guide (tests only). Production files untouched.

## baseline

`b2d93c5aa2b67fdddf98273ec88ae358d425ba6c`

Production code on this SHA is unchanged. Tests were added in commit `de63fd7` on `cursor/issue-24-intranet-deploy-9906`.

## files written

- `apps/server/src/auth-cookie.test.ts` (new; `PUBLIC_URL=https://tasks.example.test` then dynamic `import('./app.ts')`)
- `apps/server/src/auth.test.ts` (HTTP Secure-absent pin only)
- `apps/server/src/hosting.test.ts` (retargeted compose pin)
- `package.json` (`"test"` script file list includes `apps/server/src/auth-cookie.test.ts`)

Not written: `auth.ts`, `app.ts`, `docker-compose.yml`, README, DESIGN, CLAUDE.md, CI docker.

## commands

```
cd /workspace
node --experimental-strip-types --test apps/server/src/auth-cookie.test.ts apps/server/src/hosting.test.ts apps/server/src/auth.test.ts
```

Exit 1. 35 tests, 30 pass, 5 fail.

HTTP control in `auth.test.ts` stayed green:

- `session Set-Cookie does not include Secure when PUBLIC_URL is http://localhost` — pass
- remainder of `auth.test.ts` — pass

## RED

**GET /login/github OAuth state Set-Cookie includes Secure when PUBLIC_URL is https**  
`AssertionError: oauth2-redirect-state cookie.secure must be true`  
actual `undefined`, expected `true`

**login callback session Set-Cookie includes Secure behind X-Forwarded-Proto https (loopback peer)**  
`AssertionError: sessionId cookie.secure must be true`  
actual `undefined`, expected `true`

**login callback session Set-Cookie includes Secure behind X-Forwarded-Proto https (docker-bridge peer)**  
`AssertionError: sessionId cookie.secure must be true`  
actual `undefined`, expected `true`

**untrusted public peer cannot mint a Secure session cookie via spoofed X-Forwarded-Proto**  
`AssertionError: trustProxy must not be true: a direct public peer spoofing X-Forwarded-Proto must not receive sessionId`  
actual inject `sessionId` cookie (`secure` omitted / not true), expected `undefined`

**docker-compose binds 127.0.0.1:31415:31415, sets PORT 31415, and injects SQLITE_PATH plus secrets**  
`AssertionError: The input did not match the regular expression /['"]127\.0\.0\.1:31415:31415['"]/`  
compose still has `"31415:31415"` (all interfaces); no `SQLITE_PATH=/data/kaola.sqlite`; no `env_file` / secret pass-through names.

## notes for implementer

HTTPS session cases send `X-Forwarded-Proto: https` with `remoteAddress` `127.0.0.1` and `172.18.0.1`. Fastify 5.12.1 `trustProxy: 1` is a no-op; session `secure: true` without a working peer-IP `trustProxy` will omit `sessionId` entirely (still red). Do not use `trustProxy: true` — the untrusted `203.0.113.10` case requires no `sessionId` Set-Cookie.
