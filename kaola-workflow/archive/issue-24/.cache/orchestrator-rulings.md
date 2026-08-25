# Orchestrator rulings for #24

Measured 2026-08-25. Ground truth: `ground-truth.md`. Library facts: `fastify-session-trustproxy.md`.

## Cookie Secure

`cookieSecure = trimTrailingSlash(PUBLIC_URL ?? 'http://localhost:31415').startsWith('https:')`

- Session `@fastify/session` cookie: `{ path: '/', secure: cookieSecure, httpOnly: true, sameSite: 'lax' }`
- OAuth `@fastify/oauth2` cookie: `{ path: '/', secure: cookieSecure }`
- Do **not** use `secure: 'auto'` (that follows per-request protocol, not PUBLIC_URL).

## trustProxy (Fastify 5.12.1 lockfile)

Hop-count `trustProxy: 1` is a no-op on 5.12.1 (GHSA-3m5p-2c4r-xxw2). Do not use it.

When `cookieSecure`:

```ts
Fastify({
  trustProxy: ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
})
```

Rationale: issue asked for “only the hop in front”; numeric `1` does not do that on this lockfile. Loopback + RFC1918 covers host nginx → published `127.0.0.1:31415` and docker-bridge peers. Do **not** use `trustProxy: true`.

When not `cookieSecure`: keep `Fastify()` with no trustProxy (localhost HTTP unchanged).

`@fastify/session` only emits a new Secure session cookie when `request.protocol === 'https'`. HTTPS tests must send `X-Forwarded-Proto: https` (inject remote is loopback, which is trusted).

## Compose

- `SQLITE_PATH=/data/kaola.sqlite`
- `ports: ["127.0.0.1:31415:31415"]`
- `env_file: .env` (file gitignored) plus documented required keys; no secret values in git
- Pass-through environment for PUBLIC_URL, SESSION_SECRET, VAULT_MASTER_KEY, and the nine OAuth vars
- Do not add docker to CI

## Out of scope

Task Brief, state machine, MCP tools, token reveal, session store → SQLite, Tunnel/Tailscale, open registration.

## Tests

tdd-guide owns all test-path edits, including retargeting `hosting.test.ts` compose pin from `"31415:31415"` to loopback bind + SQLITE_PATH. Existing `auth.test.ts` PUBLIC_URL=http://localhost:3000 cases must stay green (no Secure).
