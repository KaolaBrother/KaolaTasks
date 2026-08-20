# OAuth / session / SQLite libraries for bundle-3-6

**Retrieval date:** 2026-08-21  
**Context7:** not available in this runtime; facts below are from official vendor docs, GitHub source, and npm package metadata. Fetched pages were treated as untrusted data (no instructions inside them were followed).

This report answers library/API questions for Kaola Tasks M1 login. Product field names are taken only from `docs/DESIGN.md` §10–§11. Library API names are from official docs.

## Local grounding (this repo, not invented)

- Node `>=22`, TypeScript `^5.9.2`, ESM (`"type": "module"`).
- Server: Fastify `^5.4.0`, drizzle-orm `^0.44.4`, better-sqlite3 `^12.2.0`. Runs `node --experimental-strip-types src/index.ts` (no bundler).
- Tests: `node --experimental-strip-types --test` (root `pnpm test`).
- Web: Vue `^3.5.0`, Naive UI `^2.45.0`, Vite `^7`. **No `vue-router` in any `package.json`.** `apps/web/src/App.vue` is a single `n-config-provider` + `n-card` placeholder; `main.ts` does `app.use(naive)`.
- `apps/server/src/db.ts`: `createDb` returns `drizzle(sqlite)` with **no schema object**. `drizzle-kit` is **not** in any `package.json`.
- `apps/server/src/index.ts` already uses the driver handle: `db.$client.prepare('select 1').get()`.
- DESIGN.md §11: multi-source OAuth, no independent account system, first login auto-creates user, Web sessions. GitHub first login → 待批准 + `claim_only`; GitLab/Gitea (self-hosted) → `active` + `full`. `users` columns named in §10: `provider`, `remote_id`, `username`, display name, status (`active` / 待批准), permission (`full` / `claim_only`).

Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-3-6` has the same `createDb` (no schema).

---

## 1. Fastify 5 OAuth2 + cookie sessions

### Packages that are current and Fastify-5-compatible

| Package | Latest seen 2026-08-21 | Fastify 5 line | Notes |
| --- | --- | --- | --- |
| `@fastify/oauth2` | **8.3.0** (npm, updated 2026-08-14) | **8.x** | Depends on `@fastify/cookie ^11.0.2`, `fastify-plugin ^6.0.0`, `simple-oauth2 ^5.1.0`. Dev-dep `fastify ^5.6.2`. **No `peerDependencies` in its published `package.json`.** README still only says “v4.x → Fastify v3 / v3.x → Fastify v2”; that table is stale. 8.0.0 (2024-09-06) is the Fastify v5 major (`chore: update fastify to ^5.0.0`). |
| `@fastify/cookie` | **11.1.2** | **`>=10.x` → Fastify `^5.x`** (official compatibility table) | Required by oauth2 (since oauth2 v7.2.0) **and** by `@fastify/session`. Register **before** oauth2 if you register cookie yourself. |
| `@fastify/session` | **11.1.2** | **11.x** (11.0.0 = Fastify 5; 10.x was Fastify 4) | Server-side session store + signed cookie id. Requires `@fastify/cookie`. Default store is in-memory (“should not be used in a production environment”). |
| `@fastify/secure-session` | **8.3.0** | **8.x** (8.0.0 = Fastify 5) | Stateless encrypted cookie (libsodium). Depends on `@fastify/cookie ^11.0.1`. |

**Pin ranges known-compatible with Fastify `^5.4.0` and Node 22:**

```
@fastify/oauth2@^8.3.0
@fastify/cookie@^11.1.2
@fastify/session@^11.1.2          # if you want a server-side session
@fastify/secure-session@^8.3.0    # alternative: cookie-held session
```

Do not install `@fastify/oauth2@7` / `@fastify/cookie@9` / `@fastify/session@10` / `@fastify/secure-session@7` on Fastify 5.

### Which session plugin for Web login

Official docs do not pick one for “OAuth login.” Differences that matter here:

- **`@fastify/session`**: `request.session` is a mutable object; data lives in a store; cookie holds only the id. Default in-memory store leaks memory. Needs a real store for multi-process, but a **single docker-compose SQLite box** can use a SQLite/file store or even in-memory if you accept restart-logout. Secret must be ≥32 chars.
- **`@fastify/secure-session`**: entire session in an encrypted cookie; `request.session.get` / `.set` / `.delete`. Default expiry 1 day. Cookie size limits apply (do not put tokens in it). Official security note: leaking the cookie impersonates the user.

Both need `@fastify/cookie`. For HTTP (no TLS in local/dev), `@fastify/session` requires `cookie.secure: false` (default `true`). Reverse-proxy TLS needs Fastify `trustProxy`.

OAuth2 itself already sets `httpOnly` + `sameSite: Lax` cookies for **state / PKCE verifier** (`oauth2-redirect-state`, `oauth2-code-verifier`). That is independent of the login session cookie.

### Presets: GitHub, GitLab, generic (not Gitea)

From `@fastify/oauth2` README “Preset configurations” and `index.js` on `main` (v8.3.0):

- **`GITHUB_CONFIGURATION`** — GitHub.com:
  - `tokenHost: 'https://github.com'`
  - `tokenPath: '/login/oauth/access_token'`
  - `authorizePath: '/login/oauth/authorize'`
- **`GITLAB_CONFIGURATION`** — **gitlab.com only**:
  - `authorizeHost` / `tokenHost`: `'https://gitlab.com'`
  - `authorizePath: '/oauth/authorize'`
  - `tokenPath: '/oauth/token'`
  - `revokePath: '/oauth/revoke'`
- **No `GITEA_CONFIGURATION`.** Self-hosted GitLab and all Gitea must use the documented **custom `credentials.auth`** object (`authorizeHost`, `authorizePath`, `tokenHost`, `tokenPath`).
- Discovery (`discovery: { issuer }`) is documented for OpenID Connect issuers; Gitea publishes `/.well-known/openid-configuration`. Official oauth2 README: when `discovery` is used, do **not** set `credentials.auth`. `userinfo()` on the plugin **only works with discovery**; for static GitHub/GitLab/Gitea configs you HTTP-call `/user` yourself.

### Register + getAccessToken shapes (current README, not memory)

Register (required fields: `name`, `credentials`, `callbackUri`; `startRedirectPath` optional if you call `generateAuthorizationUri` yourself):

```js
import oauthPlugin from '@fastify/oauth2'

fastify.register(oauthPlugin, {
  name: 'githubOAuth2',
  credentials: {
    client: { id: '<CLIENT_ID>', secret: '<CLIENT_SECRET>' },
    auth: oauthPlugin.GITHUB_CONFIGURATION
  },
  startRedirectPath: '/login/github',
  callbackUri: 'http://localhost:3000/login/github/callback'
  // callbackUri: (req) => `${req.protocol}://${req.hostname}/login/github/callback`
})
```

If you register `@fastify/cookie` yourself, it **must** be registered first:

```js
fastify.register(cookie, cookieOptions)
fastify.register(oauthPlugin, oauthOptions)
```

**Token exchange** — promise form used in the README callback route:

```js
fastify.get('/login/github/callback', async function (request, reply) {
  const { token } = await this.githubOAuth2.getAccessTokenFromAuthorizationCodeFlow(request)
  // token.access_token, token.refresh_token?, token.token_type, token.expires_in
  reply.send({ access_token: token.access_token })
})
```

Documented overloads (README + `types/index.d.ts`):

| Call | When |
| --- | --- |
| `getAccessTokenFromAuthorizationCodeFlow(request)` → `Promise<OAuth2Token>` | Default. |
| `getAccessTokenFromAuthorizationCodeFlow(request, callback)` | Callback style; omit callback → promise. |
| `getAccessTokenFromAuthorizationCodeFlow(request, reply)` → Promise | **Required when PKCE is used**, so the plugin can delete the `code_verifier` cookie. |
| `getAccessTokenFromAuthorizationCodeFlow(request, reply, callback)` | PKCE + callback. |

`OAuth2Token` has `.token` with `access_token`, optional `refresh_token`, `token_type` (generally `'Bearer'`), `expires_in`.

Manual start (only if `startRedirectPath` is omitted):

```js
fastify.githubOAuth2.generateAuthorizationUri(req, reply, (err, authorizationEndpoint) => {
  reply.redirect(authorizationEndpoint)
})
```

Promise form of `generateAuthorizationUri(request, reply)` is also typed.

Decorator namespace: for `name: 'githubOAuth2'` the instance is `fastify.githubOAuth2` **and** `fastify.oauth2GithubOAuth2`. TypeScript: merge `OAuth2Namespace` onto `FastifyInstance`.

`@fastify/oauth2` ships `"type": "commonjs"`. From this ESM server, default import (`import oauthPlugin from '@fastify/oauth2'`) is the documented CJS interop path; named `GITHUB_CONFIGURATION` lives on that default export.

**Sources:**  
https://github.com/fastify/fastify-oauth2 (README + `index.js` + `package.json`, retrieved 2026-08-21)  
https://www.npmjs.com/package/@fastify/oauth2 (v8.3.0, 2026-08-21)  
https://www.npmjs.com/package/@fastify/cookie (compat table `>=10.x` / Fastify `^5.x`, 2026-08-21)  
https://www.npmjs.com/package/@fastify/session (v11.1.2, 2026-08-21)  
https://www.npmjs.com/package/@fastify/secure-session (v8.3.0, 2026-08-21)  
https://fastify.dev/ecosystem/ (lists cookie, session, secure-session, 2026-08-21)

---

## 2. Multiple OAuth providers in one Fastify app

**Yes.** Official README “Reference” section: register the plugin **once per provider**, each with a unique `name`, `startRedirectPath`, and `callbackUri`. Each `simple-oauth2` instance lives in its own namespace.

Documented pattern (README, plus types PR discussion that restates “registered once for each one of the providers”):

```js
fastify.register(oauthPlugin, {
  name: 'github',
  credentials: { client: { id, secret }, auth: oauthPlugin.GITHUB_CONFIGURATION },
  startRedirectPath: '/login/github',
  callbackUri: 'http://localhost:3000/login/github/callback'
})

fastify.register(oauthPlugin, {
  name: 'gitlab',
  credentials: {
    client: { id, secret },
    auth: {
      authorizeHost: gitlabOrigin, // NOT gitlab.com for self-hosted
      authorizePath: '/oauth/authorize',
      tokenHost: gitlabOrigin,
      tokenPath: '/oauth/token'
    }
  },
  startRedirectPath: '/login/gitlab',
  callbackUri: 'http://localhost:3000/login/gitlab/callback'
})

fastify.register(oauthPlugin, {
  name: 'gitea',
  credentials: {
    client: { id, secret },
    auth: {
      authorizeHost: giteaOrigin,
      authorizePath: '/login/oauth/authorize',
      tokenHost: giteaOrigin,
      tokenPath: '/login/oauth/access_token'
    }
  },
  startRedirectPath: '/login/gitea',
  callbackUri: 'http://localhost:3000/login/gitea/callback'
})

// then three callback routes:
fastify.get('/login/github/callback', async (request, reply) => {
  const { token } = await fastify.github.getAccessTokenFromAuthorizationCodeFlow(request)
  // ...
})
```

**Cookie-path caveat (not in the happy-path README; from maintainer reply on issue #218):** default cookie `Path` is the directory of `startRedirectPath`. If `callbackUri` does not share that path prefix, the state cookie is invisible and you get invalid state. Either:

- keep start + callback under the same prefix (`/login/github` + `/login/github/callback`), or
- set `cookie: { path: '/' }` in oauth2 options.

**Unspecified in official docs:** whether three registrations share one `@fastify/cookie` instance (they must; register cookie once at the root). Distinct `redirectStateCookieName` / `verifierCookieName` per provider are optional; defaults are global names, so overlapping concurrent flows on one browser can collide if two providers use the same cookie names. Official docs do not say you must rename them for multi-provider; they only document the option.

**Sources:**  
https://github.com/fastify/fastify-oauth2 README “Reference” (2026-08-21)  
https://github.com/fastify/fastify-oauth2/issues/218 (cookie path, 2026-08-21)

---

## 3. Self-hosted authorize / token URL suffixes

Prefix with the instance origin, **no extra API prefix** on OAuth (that is `/oauth` or `/login/oauth`, not `/api/v4` / `/api/v1`).

### GitLab Self-Managed

Official: “Offering: GitLab.com, GitLab Self-Managed, GitLab Dedicated.” Examples use `https://gitlab.example.com`.

| Step | Method + path |
| --- | --- |
| Authorize | `GET {origin}/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&state=…&scope=…` |
| Token | `POST {origin}/oauth/token` (`application/x-www-form-urlencoded`: `client_id`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`) |
| Revoke | `POST {origin}/oauth/revoke` |
| Optional OIDC userinfo | `{origin}/oauth/userinfo` (CORS list; not the REST current-user API) |

PKCE query extras: `code_challenge`, `code_challenge_method=S256`. Docs recommend PKCE even for server apps.

`@fastify/oauth2` `GITLAB_CONFIGURATION` is **gitlab.com**. For self-hosted copy the **paths** and set `authorizeHost` / `tokenHost` to the instance origin.

**Source:** https://docs.gitlab.com/api/oauth2/ (retrieved 2026-08-21)

### Gitea (self-hosted)

Official endpoint table (relative to `[YOUR-GITEA-URL]`):

| Endpoint | Path suffix |
| --- | --- |
| Authorization | `/login/oauth/authorize` |
| Access token | `/login/oauth/access_token` |
| OIDC discovery | `/.well-known/openid-configuration` |
| OIDC UserInfo | `/login/oauth/userinfo` |
| Introspect | `/login/oauth/introspect` |
| JWKS | `/login/oauth/keys` |

Authorize example: `https://[YOUR-GITEA-URL]/login/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&state=…`  
Token: `POST https://[YOUR-GITEA-URL]/login/oauth/access_token` with JSON **or** form body: `client_id`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`. `redirect_uri` must match the authorize request.

**Not** `/oauth/authorize` (that is GitLab). Gitea token path is `/login/oauth/access_token`, not `/oauth/token`.

**Source:** https://docs.gitea.com/development/oauth2-provider (retrieved 2026-08-21)

### GitHub.com (for completeness; DESIGN uses GitHub.com, not GHE)

| Step | URL |
| --- | --- |
| Authorize | `GET https://github.com/login/oauth/authorize` |
| Token | `POST https://github.com/login/oauth/access_token` |

Matches `GITHUB_CONFIGURATION`. PKCE: GitHub documents `code_challenge` / `code_challenge_method=S256` (`plain` is not supported). DESIGN.md does not mention GHE; if GHE were added later, hosts would change — **unspecified here**.

**Source:** https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps (retrieved 2026-08-21)

---

## 4. Stable remote id + username + display name after OAuth

`@fastify/oauth2` does **not** fetch userinfo unless `discovery` is on. After `getAccessTokenFromAuthorizationCodeFlow`, call each forge’s current-user API with the access token.

### GitHub — `GET https://api.github.com/user`

Auth: `Authorization: Bearer <token>` (docs also historically show `token`). OAuth apps need `user` scope for private profile fields.

| Role | JSON field | Notes |
| --- | --- | --- |
| Stable remote id | **`id`** | required integer (int64) |
| Username / login | **`login`** | required string. **There is no `username` field.** |
| Display name | **`name`** | required in schema as **string or null** |

Map to DESIGN `remote_id` / `username` / display name as `String(id)` / `login` / (`name` or fall back to `login`). Fallback is product logic, not a GitHub field.

**Source:** https://docs.github.com/en/rest/users/users (Get the authenticated user, retrieved 2026-08-21)

### GitLab — `GET {origin}/api/v4/user`

REST root: host + path starting with `/api/v4`. OAuth docs show both `?access_token=` and `Authorization: Bearer`.

Example “Retrieve the current user” response:

```json
{
  "id": 1,
  "username": "john_smith",
  "email": "john@example.com",
  "name": "John Smith",
  "state": "active"
}
```

| Role | JSON field |
| --- | --- |
| Stable remote id | **`id`** (integer) |
| Username | **`username`** |
| Display name | **`name`** |

**Sources:**  
https://docs.gitlab.com/api/users/ (“Retrieve the current user”, 2026-08-21)  
https://docs.gitlab.com/api/rest/ (path must start with `/api/v4`, 2026-08-21)  
https://docs.gitlab.com/api/oauth2/ (Bearer / query token to `/api/v4/user`, 2026-08-21)

### Gitea — `GET {origin}/api/v1/user`

Official OpenAPI “Get the authenticated user” (`GET /user` under `/api/v1`). Auth: `Authorization: token …` or, for OAuth access tokens, `Authorization: Bearer …` (API usage page).

Documented User object fields:

| Role | JSON field | Official description |
| --- | --- | --- |
| Stable remote id | **`id`** | “The user’s id” (int64) |
| Username | **`login`** | “Login of the user, same as `username`” |
| Display name | **`full_name`** | “The user’s full name” |

OpenAPI / swagger model lists **`login`**, not a separate `username` property. **Gitea source** `modules/structs/user.go` (v1.27.1) adds a **backward-compat** marshaler that **also emits `username`**, equal to `login`:

```go
CompatUserName string `json:"username"`
```

So live JSON typically has **both** `login` and `username`. Prefer **`login`** (the documented swagger field); `username` is a compat alias in source, not listed on docs.gitea.com’s 1.26 User schema table.

Do not use `login_name` as the app username — that is “identifier … provided by the external authenticator”.

**Sources:**  
https://docs.gitea.com/api/1.26/operations/user-get-current/ (2026-08-21)  
https://docs.gitea.com/development/api-usage (token vs Bearer for OAuth, 2026-08-21)  
https://raw.githubusercontent.com/go-gitea/gitea/v1.27.1/modules/structs/user.go (`MarshalJSON` username alias, 2026-08-21)

### Mapping (library fields only → DESIGN columns)

Do not invent product columns. After fetch:

| DESIGN (`users`) | GitHub | GitLab | Gitea |
| --- | --- | --- | --- |
| `provider` | (app enum, not from JSON) | same | same |
| `remote_id` | `id` | `id` | `id` |
| `username` | `login` | `username` | `login` (compat: `username`) |
| display name | `name` (nullable) | `name` | `full_name` |

---

## 5. Drizzle ORM 0.44 + better-sqlite3 (schema, unique, migrations)

### How this repo is wired today

```ts
// apps/server/src/db.ts
const sqlite = new Database(path)
return drizzle(sqlite) // no { schema }, no { client } wrapper
```

Current Drizzle SQLite get-started still documents **three** init forms; the “existing driver” form is now:

```ts
import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'

const sqlite = new Database('sqlite.db')
const db = drizzle({ client: sqlite })
```

`drizzle(sqlite)` (positional client) is what this repo uses; it still works in 0.44. Official live “get started” pages currently advertise `drizzle-orm@rc` + `drizzle-kit@rc` (v1 beta). **This repo is on `drizzle-orm ^0.44.4`.** Stay on the 0.44 line unless the project explicitly upgrades.

Relational query API needs `drizzle(sqlite, { schema })` / `drizzle({ client, schema })`. That does **not** create tables.

### `sqliteTable`, integer PK, text “enums”, unique(provider, remote_id)

From Drizzle SQLite schema + column-types + indexes docs (and SQLite table API):

```ts
import {
  sqliteTable,
  integer,
  text,
  unique,
} from 'drizzle-orm/sqlite-core'

export const users = sqliteTable(
  'users',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    provider: text({ enum: ['github', 'gitlab', 'gitea'] }).notNull(),
    remoteId: text('remote_id').notNull(),
    username: text().notNull(),
    // display name: DESIGN §10 says 显示名; pick a TS key, alias the SQL column in English
    displayName: text('display_name'),
    status: text({ enum: ['active', 'pending_approval'] }).notNull(),
    permission: text({ enum: ['full', 'claim_only'] }).notNull(),
  },
  (t) => [unique('users_provider_remote_id').on(t.provider, t.remoteId)],
)
```

Facts from docs:

- `integer().primaryKey({ autoIncrement: true })` → `integer PRIMARY KEY AUTOINCREMENT`.
- `text({ enum: ["value1", "value2"] })` **only infers TypeScript union**. Quote: “it won’t check runtime values.” SQLite has no real ENUM; Drizzle does not emit CHECK unless you add `check()`.
- Composite unique: `unique().on(t.a, t.b)` or `unique('name').on(...)`. Single-column: `.unique()` on the column, or `uniqueIndex('idx').on(col)`.
- Column TS key vs SQL name: `text('remote_id')` if you want snake_case in SQLite.

**Do not treat the example SQL column names above as DESIGN contracts** beyond `provider` / `remote_id` / `username`. Status labels in DESIGN are Chinese (`待批准`); storing an English token vs the Chinese string is a product choice — official Drizzle docs do not speak to that.

**Sources:**  
https://orm.drizzle.team/docs/column-types/sqlite (integer PK, text enum, 2026-08-21)  
https://orm.drizzle.team/docs/sqlite/sql-schema-declaration (sqliteTable + uniqueIndex, 2026-08-21)  
https://orm.drizzle.team/docs/indexes-constraints (`unique().on(...)`, 2026-08-21)  
https://orm.drizzle.team/docs/get-started-sqlite (better-sqlite3 init, 2026-08-21)

### Is drizzle-kit required? Is `CREATE TABLE IF NOT EXISTS` at startup documented?

**drizzle-kit is the official way to generate/push/pull schema.** Overview: `generate`, `migrate`, `push`, `pull`, `export`. Install: `npm i -D drizzle-kit`. Needs `drizzle.config.ts` with at least `dialect: 'sqlite'` and `schema` path.

It is **not** a runtime dependency of `drizzle-orm`. This repo can query with drizzle-orm alone; **tables will not exist** until something runs DDL.

Documented migration options (https://orm.drizzle.team/docs/migrations, 2026-08-21):

| Option | drizzle-kit needed? | What happens |
| --- | --- | --- |
| 2 `push` | Yes (CLI) | Push TS schema to DB, no SQL files |
| 3 `generate` + `migrate` CLI | Yes | SQL files + kit applies them |
| 4 `generate` + **runtime `migrate()`** | Yes to **generate**; apply via `drizzle-orm/.../migrator` | Kit still authors SQL |
| 5 `generate` then **you** run SQL | Yes to generate; apply “directly to the database” or Atlas/Liquibase/etc. | Closest official “I’ll exec SQL myself” |
| 6 `export` | Yes | Print DDL, apply elsewhere |

Runtime migrator (SQLite, official migrator API):

```ts
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
migrate(db, { migrationsFolder: './drizzle' }) // SQLite migrate is synchronous
```

**`CREATE TABLE IF NOT EXISTS` at process start is not a Drizzle Kit strategy.** Kit maintainers have said they will not emit `IF NOT EXISTS` (migrations should fail if objects already exist).  

It **is** a valid **SQLite driver** bootstrap:

- better-sqlite3 `Database#exec(sql)` — can run multiple statements; docs say prefer `prepare` except when executing SQL from an external file.
- better-sqlite3 `Database#prepare(sql)` → `Statement`; this repo already uses `db.$client.prepare`.
- Drizzle `sql` template + `db.run` / driver `exec` can run the same strings.

So: **drizzle-kit is required if you want generate/push/diff.** **It is not required** if you hand-write `CREATE TABLE IF NOT EXISTS …` (or kit-exported DDL) and `sqlite.exec` / `db.$client.exec` at startup. That second path is documented at the **driver** layer and as Drizzle “option 5 / run SQL yourself,” not as a first-class “skip kit, IF NOT EXISTS forever” recipe. Kit `push` is the documented no-file alternative.

**drizzle-kit version vs `drizzle-orm@0.44.4`:** stable kit on npm is **0.31.10** (release 2026-03-17). Pair `drizzle-kit@^0.31.4` with `drizzle-orm@^0.44.4`. GitHub issue #4855: **kit 0.31.4 falsely rejected orm 0.44.4** (“requires newer drizzle-orm”); workaround was orm 0.44.3 or a later kit. Prefer **0.31.10** with 0.44.4 and install kit **only in `@kaola/server`**, not also at the monorepo root (duplicate copies confuse kit’s version check). Current get-started pages pushing `@rc` are the v1 beta track — **not** what this repo’s `^0.44.4` should follow unless you upgrade both.

**Node ESM + strip-types:** drizzle-kit 0.31.10 switched its loader to **tsx** (release notes: ESM/CJS). Runtime `import './schema.ts'` under `node --experimental-strip-types` is a Node feature, not a Drizzle feature; Drizzle does not document strip-types. `migrate()` reads generated `.sql` files, so it does not need strip-types for the SQL itself.

**Sources:**  
https://orm.drizzle.team/docs/kit-overview (2026-08-21)  
https://orm.drizzle.team/docs/migrations (options 1–6, 2026-08-21)  
https://orm.drizzle.team/docs/get-started-sqlite (better-sqlite3, 2026-08-21)  
https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md (`prepare` / `exec`, 2026-08-21)  
https://github.com/drizzle-team/drizzle-orm/issues/4855 (kit/orm 0.44.4 mismatch, 2026-08-21)  
https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.31.10 (2026-08-21)

---

## 6. Testing Fastify OAuth without real providers (`node:test`)

### Official Fastify: `inject` + `node:test`

Fastify v5 Testing guide uses **`node:test`** and **`app.inject()`** (light-my-request). `inject` does not open a socket; it still **runs the real plugin stack**, including outbound HTTP from `@fastify/oauth2` to `tokenHost` if you hit the callback route with a fake `code`.

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('requests the "/" route', async (t) => {
  const app = build()
  t.after(() => app.close())
  const response = await app.inject({ method: 'GET', url: '/' })
  assert.equal(response.statusCode, 200)
})
```

`inject` accepts `method`, `url`, `query`, `payload`, `headers`, **`cookies`**. Call `app.close()` in `t.after`. Matches this repo’s `node --test` runner.

**Source:** https://fastify.dev/docs/latest/Guides/Testing/ (latest tagged Fastify 5.12.1 on the page, retrieved 2026-08-21)

### What official docs do **not** provide

There is **no** Fastify or `@fastify/oauth2` tutorial titled “mock GitHub.” Approaches that **are** documented in pieces:

1. **HTTP mock the token + userinfo hosts**  
   `@fastify/oauth2` **itself** uses **`nock` ^14.0.10** in `devDependencies` and `npm test` is `c8 node --test`. Intercept `POST https://github.com/login/oauth/access_token` and `GET https://api.github.com/user` (and GitLab/Gitea equivalents). Then `inject` the callback with `?code=…&state=…` **and** the oauth2 state/PKCE cookies from a prior `inject` of `startRedirectPath` (or set `cookies` yourself). PKCE makes cookie capture mandatory if enabled.

2. **Do not register oauth2 in the test app; stub the decorator**  
   Fastify plugin testing guide: build a Fastify instance, `register` only what you need, `inject`. You can `fastify.decorate('githubOAuth2', { getAccessTokenFromAuthorizationCodeFlow: async () => ({ token: { access_token: 't' } }) })` **if your production code reads that decorator**. Official oauth2 does not document this stub; it is the generic decorate/inject pattern.

3. **Split “exchange code” from “upsert user”**  
   Test the upsert with a fake profile object; test OAuth only as far as redirect 302 from `startRedirectPath`. Redirect-to-GitHub does not need a live GitHub if you assert `Location` header. **Unspecified** as an oauth2 recipe; it is ordinary `inject`.

4. **Node 22 `mock.module` / undici `MockAgent`** — Node/undici features. **Not** documented by Fastify oauth2. `nock` is what the plugin’s own tests use.

**Recommendation that stays inside documented tools:** `node:test` + `app.inject` + **`nock` ^14** (same as `@fastify/oauth2`). For unit tests of “first GitHub login → 待批准”, stub the token helper and never call GitHub.

Pin if used: `nock@^14.0.10` (oauth2’s own range).

**Sources:**  
https://fastify.dev/docs/latest/Guides/Testing/ (2026-08-21)  
https://raw.githubusercontent.com/fastify/fastify-oauth2/main/package.json (`nock`, `test:unit`: `node --test`, 2026-08-21)

---

## 7. Naive UI + Vue 3: login buttons and 待批准 / 批准 without vue-router

**vue-router is not required.** This repo has none. Vue official docs:

- App = `createApp(root).mount('#app')`. Nested views are just child components.
- **Routing** page: “For most SPAs, it's recommended to use Vue Router.” Immediately after: **“Simple Routing from Scratch”** — `ref` + `v-if` / `<component :is>` (hashchange example). Conditional rendering (`v-if` / `v-else`) is a core essential.

A single `App.vue` can swap 登录 / 看板 / 待批准 with `v-if` on session state from `/api/me`. Naive UI issue #2321: maintainers **will not** wrap `n-button` in `router-link`; use `n-button` + `@click` or `tag="a"` + `href`.

Naive UI `n-button` (zhCN demo + props table in source): `type` = `default | tertiary | primary | info | success | warning | error`. Chinese labels are just slot text (`GitHub 登录`, `批准`). `n-card` is already used in this repo’s placeholder.

Live naiveui.com button URLs returned **404** from this environment; cite the GitHub demos instead.

**Sources:**  
https://vuejs.org/guide/essentials/application.html (2026-08-21)  
https://vuejs.org/guide/essentials/conditional.html (2026-08-21)  
https://vuejs.org/guide/scaling-up/routing.html (simple routing / Vue Router optional, 2026-08-21)  
https://github.com/tusen-ai/naive-ui/blob/main/src/button/demos/zhCN/basic.demo.vue (2026-08-21)  
https://github.com/tusen-ai/naive-ui/blob/main/src/button/demos/zhCN/index.demo-entry.md (`type` prop, 2026-08-21)  
https://github.com/tusen-ai/naive-ui/issues/2321 (no built-in router-link, 2026-08-21)

---

## Implementation notes that official docs leave unspecified

- Exact DESIGN Chinese status string vs English DB enum.
- Whether to put the forge access token in the Web session (oauth2 README only logs `access_token`; DESIGN is Web session for the **platform user**, not forge token reuse).
- Gitea granular OAuth scopes vs “no scope → full access” pre-1.23 behavior.
- GitHub OAuth `user` vs `read:user` vs empty scope for public `login`/`id`.
- How to rotate `@fastify/session` in-memory store across docker restarts.

---

## Suggested add list (versions only)

For `@kaola/server` (Fastify 5.4 + Node 22):

```
@fastify/oauth2@^8.3.0
@fastify/cookie@^11.1.2
@fastify/session@^11.1.2
# or @fastify/secure-session@^8.3.0 instead of session
```

Optional: `drizzle-kit@^0.31.10` (dev) if using generate/push; `nock@^14.0.10` (dev) if mocking token HTTP.

Do not add `vue-router` unless you want URL-based pages; Vue + Naive UI already cover login / 待批准 in `App.vue`.
