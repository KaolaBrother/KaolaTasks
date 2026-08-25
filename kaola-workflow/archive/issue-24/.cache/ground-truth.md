# Ground truth: GitHub issue #24 (intranet deploy / cookie / compose)

Measured 2026-08-25 on `/workspace` branch `cursor/issue-24-intranet-deploy-9906`.
Issue: https://github.com/KaolaBrother/KaolaTasks/issues/24 (body is the spec; comments not used).
Facts only. Line numbers from current files.

---

## 1. Session cookie flags (`apps/server/src/auth.ts`)

`registerAuth` registers `@fastify/cookie` with **no options**, then `@fastify/session`:

```347:354:apps/server/src/auth.ts
  const oauthCookie = { path: '/' as const }

  app.register(cookie)
  app.register(session, {
    secret: sessionSecret,
    cookie: { path: '/', secure: false, httpOnly: true, sameSite: 'lax' },
    saveUninitialized: false,
  })
```

- Session `cookie` object: `path: '/'`, **`secure: false` (hardcoded literal)**, `httpOnly: true`, `sameSite: 'lax'`.
- No `domain`, no `cookieName` override (plugin default name is unused in this repo’s tests).
- `secure` is **not** derived from `PUBLIC_URL`, `https:`, or request protocol.

**`oauthCookie`:** `{ path: '/' as const }` only. Passed as `cookie: oauthCookie` to all three `@fastify/oauth2` registrations (GitHub ~365, GitLab ~385, Gitea ~401). No `secure`, `httpOnly`, or `sameSite` on that object.

---

## 2. `PUBLIC_URL` read / trim / default

**`registerAuth`** (`auth.ts:337`):

```ts
const publicUrl = trimTrailingSlash(process.env.PUBLIC_URL ?? 'http://localhost:31415')
```

`trimTrailingSlash` (`auth.ts:51-53`): `url.replace(/\/+$/, '')`.

Exact default string: **`http://localhost:31415`**.

Used for OAuth `callbackUri`: `` `${publicUrl}/login/{github|gitlab|gitea}/callback` ``.

**`writeback.ts` `publicUrl()`** (`writeback.ts:47-50`): same default `http://localhost:31415`, trim via `raw.replace(/\/+$/u, '')` (unicode flag; separate helper). Comment bodies only; not cookie flags.

`index.ts` does **not** read `PUBLIC_URL`. Empty/unset env uses the `??` default (empty string is **not** treated as unset: `'' ?? default` stays `''`, then trim leaves `''`).

---

## 3. `Fastify()` in `apps/server/src/app.ts`

```41:42:apps/server/src/app.ts
  const db = createDb(options?.sqlitePath ?? ':memory:')
  const app = Fastify()
```

- Call is **`Fastify()` with zero arguments**.
- **No `trustProxy`** (no options object at all). Repo-wide grep of `trustProxy` / `x-forwarded` / `X-Forwarded` in `apps/server`: **none**.
- Proxy-related plugin: `@fastify/http-proxy` is imported and registered **only** when `viteDevTarget` is set and `webDist` is omitted (`app.ts:116-128`) to proxy GET/HEAD (and websocket) to the Vite origin. That is outbound-to-Vite, not inbound reverse-proxy trust.
- `@fastify/static` when `webDist` is set. Cookie/session plugins live in `registerAuth`, not `app.ts`.

---

## 4. `SQLITE_PATH` in `apps/server/src/index.ts`

```21:27:apps/server/src/index.ts
const app = buildApp({
  sqlitePath: process.env.SQLITE_PATH ?? ':memory:',
  webDist: process.env.WEB_DIST,
  viteDevTarget: process.env.VITE_DEV_TARGET,
  pollIntervalMs,
  forgeInstances: readForgeInstances(),
})
```

Default: **`':memory:'`**. Passed as `sqlitePath` into `buildApp`. `buildApp` itself also defaults `options?.sqlitePath ?? ':memory:'` (`app.ts:41`). Compose unset → in-memory DB.

---

## 5. Current `docker-compose.yml` (full file, 16 lines)

```1:16:docker-compose.yml
services:
  server:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    ports:
      - "31415:31415"
    environment:
      PORT: "31415"
      HOST: "0.0.0.0"
    volumes:
      - kaola-data:/data

volumes:
  kaola-data:
```

| Key | Value |
|-----|--------|
| ports | `"31415:31415"` — all interfaces, **not** `127.0.0.1:31415:31415` |
| environment | only `PORT: "31415"`, `HOST: "0.0.0.0"` |
| volumes | named volume `kaola-data` → `/data` |
| env_file | **absent** |
| user | **absent** (container default = image user) |
| SQLITE_PATH / PUBLIC_URL / SESSION_SECRET / VAULT_MASTER_KEY / OAuth | **not set** |

`.gitignore` ignores `.env` and `.env.*`; no `.env` / `.env.example` in the tree.

`hosting.test.ts:167-173` **pins** compose to `['"]31415:31415['"]` and `PORT: "31415"` (not loopback bind).

---

## 6. README 「生产向部署」 (verbatim summary)

`README.md:159-167`:

- Heading `### 生产向部署`
- Code fence: `docker compose up -d --build`
- Prose: image builds the frontend; Fastify serves pages on **31415**. Compose **does not** write OAuth, `SESSION_SECRET`, `VAULT_MASTER_KEY`; **does not** set `SQLITE_PATH` (code default remains in-memory). Inject those yourself before going live and point SQLite at a file on the data volume.
- Optional `FORGE_INSTANCES` JSON; unset → poll all 待验收; invalid JSON fails boot.

Does **not** cover: intranet+public-IP topology, `PUBLIC_URL` as browser origin, OAuth Redirect URI vs intranet `OAUTH_*_BASE_URL`, reverse proxy 80/443 → `127.0.0.1:31415`, loopback bind, `kaola-mcp --url`, polling default, closed join.

`docs/DESIGN.md` §12 deploy sentence (`DESIGN.md:324`): internal docker-compose (server + static frontend + SQLite volume); master key via env. One line; no topology.

---

## 7. Tests asserting cookie `secure` / session flags

**NONE.**

`apps/server/src/auth.test.ts` `cookieJar` (`auth.test.ts:55-60`) copies only `cookie.name` → `cookie.value`. No assertion on `secure`, `httpOnly`, `sameSite`, or `Set-Cookie` substrings.

Same jar pattern in other HTTP suites (claim, mcp, vault, tasks, …). No test file asserts session/OAuth cookie flags. No test sets `PUBLIC_URL=https://…` to check `Secure`.

---

## 8. Package versions

`apps/server/package.json` ranges:

- `fastify`: `^5.4.0`
- `@fastify/session`: `^11.1.2`
- `@fastify/cookie`: `^11.1.2`

`pnpm-lock.yaml` resolved:

- `fastify@5.12.1`
- `@fastify/session@11.1.2`
- `@fastify/cookie@11.1.2`

Lockfile also has `@fastify/proxy-addr@5.1.0` / `@fastify/forwarded@3.0.2` as Fastify internals (not configured via `trustProxy` in this app).

---

## 9. `PUBLIC_URL` in `registerAuth` vs tests: `3000` vs `31415`

**Production default in `registerAuth`:** `http://localhost:31415` (`auth.ts:337`).

**Tests pin env to `http://localhost:3000`** before `import('./app.ts')` / `registerAuth`:

| File | Assignment |
|------|------------|
| `auth.test.ts:24` | `process.env.PUBLIC_URL = 'http://localhost:3000'` |
| `agent-keys.test.ts:30` | same |
| `vault.test.ts:26` | same |
| `tasks.test.ts:74` | same |
| `hosting.test.ts:39` | same (comment: fixtures `:3000` like other HTTP suites) |
| `claim.test.ts:67` | same |
| `import.test.ts:47` | same |
| `mcp.test.ts:78` | same |
| `poller.test.ts:37` | same |
| `webhook.test.ts:50` | same |
| `writeback.test.ts:33,60` | const + env `http://localhost:3000` |
| `events.test.ts:41` | same |
| `claim-confirm.test.ts:65` | same |
| `devices.test.ts:35` | same |
| `credential-profile-issues.test.ts:54` | same |

**Source pin of the 31415 default** (does not run `registerAuth` with that env): `hosting.test.ts:154-157` reads `auth.ts` and asserts `process.env.PUBLIC_URL ?? 'http://localhost:31415'`.

`placeholder.test.ts` / `apps/mcp`: do not set `PUBLIC_URL`.

So: **code default 31415; live `registerAuth` in tests is always 3000.**

---

## 10. `apps/server/Dockerfile`

```1:28:apps/server/Dockerfile
FROM node:22-bookworm-slim
# apt python3 make g++; corepack enable
WORKDIR /app
# copy manifests, pnpm install --frozen-lockfile, COPY . .
# pnpm --filter @kaola/web build
ENV PORT=31415
ENV HOST=0.0.0.0
ENV WEB_DIST=/app/apps/web/dist
EXPOSE 31415
CMD ["pnpm", "--filter", "@kaola/server", "start"]
```

- Working dir: **`/app`**
- **No `USER` instruction** → default image user (Node official image: typically `root`)
- **No `SQLITE_PATH`**, no mkdir `/data`
- `/data` is **not assumed in the Dockerfile**; only compose mounts `kaola-data:/data`. Process still uses `:memory:` unless env is set
- Image **does** set `WEB_DIST` so SPA is served when compose runs `start`

---

## Gaps vs #24 (what is currently false)

1. Session `secure` is hardcoded `false`; OAuth state cookie is path-only — **not** `Secure` when `PUBLIC_URL` starts with `https:`.
2. `Fastify()` has **no** `trustProxy`; HTTPS-terminating reverse proxy is not trusted.
3. Compose does **not** set `SQLITE_PATH=/data/kaola.sqlite`; volume `/data` is unused; default DB is `:memory:` (restart drops data).
4. Compose does **not** inject `PUBLIC_URL` / `SESSION_SECRET` / `VAULT_MASTER_KEY` / OAuth via env or `env_file`.
5. Port bind is `"31415:31415"` (all interfaces), **not** `127.0.0.1:31415:31415`.
6. README 「生产向部署」 is still `docker compose up` + “inject variables yourself”; missing the eight-point intranet/public-IP guide.
7. DESIGN §12 / api.md / architecture.md do not document cookie `Secure` or `trustProxy` (architecture still says `secure: false`).
8. No tests for https `Secure` cookies; HTTP suites pin `PUBLIC_URL` to `:3000`.
9. `hosting.test.ts` currently **requires** unscoped `"31415:31415"` in compose — that pin would fail if loopback bind is added without updating the test.
