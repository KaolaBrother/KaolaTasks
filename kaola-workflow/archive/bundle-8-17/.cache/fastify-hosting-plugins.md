# Fastify 5 hosting plugins — knowledge lookup

- Retrieval date: **2026-08-21**
- Scope: official Fastify docs, official GitHub READMEs / plugin source / plugin tests, npm registry.
- Fetched pages treated as untrusted (no instructions followed from page content).
- Local facts (do not contradict): `fastify` `^5.4.0` / lockfile **5.12.1**; existing plugins `@fastify/cookie` `^11.1.2`, `@fastify/session` `^11.1.2`, `@fastify/oauth2` `^8.3.0`; `@fastify/static`, `@fastify/http-proxy`, `@fastify/reply-from`, `@fastify/websocket` **absent**; registration `app.register(plugin, opts)`; tests `await app.ready()`; exact `app.get('/')` currently wins.

Fastify docs “latest” at retrieval is **v5.12.1** (same as the lockfile).

---

## Q1. `@fastify/static` version for Fastify 5.12, and register options

### Compatible versions (do not invent)

Official compatibility table (README + npm):

| Plugin version | Fastify version |
| -------------- | --------------- |
| `>=8.x`        | `^5.x`          |
| `>=7.x <8.x`   | `^4.x`          |
| …              | …               |

Sources:

- https://github.com/fastify/fastify-static (README, retrieved 2026-08-21)
- https://www.npmjs.com/package/@fastify/static (retrieved 2026-08-21)

HEAD `package.json` version **10.1.3**, plugin constraint `fastify: '5.x'`:

```js
module.exports = fp(fastifyStatic, {
  fastify: '5.x',
  name: '@fastify/static'
})
```

Source: https://github.com/fastify/fastify-static/blob/main/index.js (SHA `0fab79fe68db73a8052b01e454c1ce2a32fc58a9`, retrieved 2026-08-21)

npm `latest` (registry, retrieved 2026-08-21):

- Version: **10.1.3**
- npm `time` for 10.1.3: **2026-08-06T12:44:53.082Z**
- URL: https://registry.npmjs.org/@fastify/static/latest

GitHub releases on `fastify/fastify-static` (retrieved 2026-08-21; not every 8.x patch is listed here — only what the API returned):

- 8.x: `v8.0.1` (2024-09-21) … `v8.3.0` (2025-10-17)
- 9.x: `v9.0.0` (2025-12-25) … `v9.3.0` (2026-07-08)
- 10.x: `v10.0.0` (2026-07-11) … `v10.1.3` (GitHub tag 2026-08-19; npm 2026-08-06)

**Answer:** any `@fastify/static` **>= 8.x** is the documented Fastify 5 line. Latest published at retrieval is **10.1.3**. Fastify 5.12.1 is `^5.x`, so 8.x / 9.x / 10.x are in-table. This lookup did **not** independently re-run the plugin test matrix against 5.12.1.

No `peerDependencies` field in HEAD `package.json`; compatibility is the README table plus `fastify-plugin` `fastify: '5.x'`.

### Official register options (directory, `index.html`, wildcard / SPA)

Register style matches the repo (`app.register(plugin, opts)`):

```js
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/public/', // optional: default '/'
  constraints: { host: 'example.com' } // optional: default {}
})
```

Documented options that matter for hosting (README, same URLs as above):

| Option | Default | Documented meaning |
| ------ | ------- | ------------------ |
| `root` | required if `serve` is not `false` | Absolute directory. File path = combine `req.url` with `root`. Array of dirs allowed (“first found, first served”). |
| `prefix` | `'/'` | Virtual mount path. |
| `serve` | `true` | `false` = decorate `reply.sendFile` only, do not serve the directory. |
| `wildcard` | `true` | `true`: add a **wildcard route** to serve files. `false`: glob `${root}/**/**` and register one route per file; **will not serve newly added files**. |
| `index` | `undefined` | Passed to `@fastify/send`. Send **supports `index.html` by default**. Set `false` to disable, or a string/array for other index names. |
| `redirect` | `false` | `true`: redirect directory URLs to trailing slash. `false`: directory without slash → `reply.callNotFound()`. Cannot be `true` if `wildcard` is `false` **and** `ignoreTrailingSlash` is `true`. |
| `allowedPath` | `(pathName, root, request) => true` | Return `false` → Fastify 404 handler. |
| `decorateReply` | not `false` | Adds `reply.sendFile` / `reply.download`. Second registration in the same context must pass `decorateReply: false`. |
| `prefixAvoidTrailingSlash` | `false` | If `false`, prefix gets a trailing `/`. |

Official SPA **caching** example (README “Managing cache-control headers”; names Vite as an example **build**, not a proxy):

```js
fastify.register(require('@fastify/static'), {
  root: path.join(import.meta.dirname, 'dist'),
  maxAge: '30d',
  immutable: true,
})

fastify.get('/', function (req, reply) {
  reply.sendFile('index.html', {maxAge: 0, immutable: false})
})

fastify.get('/favicon.ico', function (req, reply) {
  reply.sendFile('favicon.ico', {maxAge: '1d', immutable: false})
})
```

`@fastify/send` `index` (https://www.npmjs.com/package/@fastify/send, latest **4.1.1**, retrieved 2026-08-21): “By default send supports `"index.html"` files, to disable this set `false` or supply a new index…”

---

## Q2. SPA fallback: `wildcard: true` vs `setNotFoundHandler` on Fastify 5

### What the official docs actually say

1. **`wildcard: true` is not documented as “SPA fallback”.** It is documented as: add a wildcard **file-serving** route. Missing files are not rewritten to `index.html` by the wildcard itself.

2. **Missing file → Fastify 404.** README “Handling 404s”:

   > If a request matches the URL `prefix` but no file is found, Fastify's 404 handler is called. Set a custom 404 handler with `fastify.setNotFoundHandler()`.

   Source: same README as Q1. `setNotFoundHandler` docs: https://fastify.dev/docs/latest/Reference/Server/#setnotfoundhandler (v5.12.1, retrieved 2026-08-21).

3. **Plugin source (10.1.3 / main):** on ENOENT / send 404, the plugin calls `reply.callNotFound()` (not a silent `index.html` rewrite). Fastify Reply: `.callNotFound()` “Invokes the custom not found handler.” https://fastify.dev/docs/latest/Reference/Reply/#callnotfound (retrieved 2026-08-21).

4. **Encapsulated + nested 404:** README says that **inside an encapsulated context**, `wildcard` **may need to be `false`** “to support index resolution and nested not-found-handler”, and shows `setNotFoundHandler` sending **`404.html`**, while `index.html` is served for `docs`, `docs/`, `docs/index.html` via send’s index behavior — **not** as a catch-all SPA:

```js
app.register((childContext, _, done) => {
    childContext.register(require('@fastify/static'), {
        root: path.join(__dirname, 'docs'),
        wildcard: false
    });
    childContext.setNotFoundHandler((_, reply) => {
        return reply.code(404).type('text/html').sendFile('404.html');
    });
    done();
}, { prefix: 'docs' });
```

5. **Fastify 5 removed `setDefaultRoute` / `getDefaultRoute`.** Do not use the v4 `setDefaultRoute` SPA pattern.

   Source: https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/ (v5.12.1) — “Removes getDefaultRoute and setDefaultRoute methods”.

### Documented approach that *is* SPA-shaped

- Serve files with `@fastify/static` (`wildcard` default `true`, or `false` + glob).
- For URLs that match the prefix but have **no file**, use **`setNotFoundHandler`** (and/or `reply.sendFile('index.html')` inside it). The official README does **not** show filtering `/api/*` or `/login*`; that filter is application logic on top of `setNotFoundHandler`.
- For **`GET /` specifically**, the official Vite-build example registers an **exact** `fastify.get('/', … sendFile('index.html'))` **after** `register(@fastify/static)`. That is the documented way to control `/`, not `wildcard: true` alone.

### Interaction with an already-registered exact `GET /`

See Q5. Summary:

- Default `wildcard: true` registers `prefix + '*'` (with default prefix `'/'` → path `'/*'`), **not** `'/'`.
- The official example of adding `fastify.get('/')` **after** static would be a duplicate if static already owned `GET /`. It is documented, so default static **does not claim** exact `GET /`.
- An existing exact `GET /` therefore **keeps winning**. `setNotFoundHandler` does **not** run for that URL, because the route exists. SPA fallback via 404 cannot replace `GET /`.

`setNotFoundHandler` is encapsulated by prefix. A root-level 404 handler sees URLs Fastify does not recognize; it does **not** override registered `/api/...` or `/login...` routes. Unregistered `/api/no-such-route` **would** hit the 404 handler unless the handler itself 404s those prefixes.

---

## Q3. `@fastify/http-proxy` vs `@fastify/reply-from` (Vite / WebSocket / HMR)

### Roles (official)

- **`@fastify/reply-from`**: decorate `reply.from(source, [opts])` to forward **the current HTTP request** to another server. No WebSocket section in the README. Plugin constraint `fastify: '5.x'`.
  - npm latest: **12.6.4** (2026-07-18T11:30:16.234Z)
  - https://www.npmjs.com/package/@fastify/reply-from
  - https://github.com/fastify/fastify-reply-from
  - HEAD `index.js` SHA `bbdd3d9d3159500325abd292555ce91bbc79c6cc`

- **`@fastify/http-proxy`**: “forwards all requests received with a given prefix (or none) to an upstream.” **Built on** `@fastify/reply-from`. Adds prefix stripping, default catch-all routes, and **partial WebSocket forwarding**.
  - README: “Requirements: **Fastify 5.x**. See `@fastify/http-proxy v9.x` for Fastify 4.x.”
  - npm latest: **11.6.0** (2026-07-18T10:54:51.550Z)
  - Depends on `@fastify/reply-from` `^12.6.2` (npm latest page)
  - Plugin: `fp(..., { fastify: '5.x', name: '@fastify/http-proxy', encapsulate: true })`
  - https://www.npmjs.com/package/@fastify/http-proxy
  - https://github.com/fastify/fastify-http-proxy
  - HEAD `index.js` SHA `7b2c501dede4cdce0fc3f9407b26d77551e28e73`
  - GitHub also lists 10.x (first 10.0.0 on npm 2024-09-06) and 11.x (11.0.0 on npm 2024-11-28) on the Fastify 5 line. Latest is **11.6.0**.

**Fastify 5–compatible choice for reverse-proxy including WebSocket:** `@fastify/http-proxy` (11.x current; 10.x also Fastify 5 per README, which only calls out v9.x for Fastify 4). `@fastify/reply-from` is HTTP-only per-route `reply.from()`; it does **not** document a websocket option.

Official docs **do not mention Vite or HMR**. The following is only what Fastify documents for WebSocket proxying.

### WebSocket option names (`@fastify/http-proxy` README)

| Option | Documented meaning |
| ------ | ------------------ |
| `websocket` | Boolean. **Partial** support for forwarding websockets. Gaps listed: request-id logging; `ignoreTrailingSlash`; only the **first** subprotocol is forwarded. README TODO still says “Finish implementing websocket”. |
| `wsUpstream` | Only if `websocket` is `true`. Target WebSocket URL; accepts `https://` and `wss://`. If omitted, proxy uses `upstream`. |
| `wsServerOptions` | Passed to `new ws.Server()`. |
| `wsClientOptions` | Passed to outgoing `WebSocket` constructor. Extra: `rewriteRequestHeaders(headers, request)` → headers object. Default implementation forwards `cookie`. |
| `wsReconnect` | **Experimental**, default disabled. Object with `pingInterval`, `maxReconnectionRetries`, `reconnectInterval`, `reconnectDecay`, `connectionTimeout`, `reconnectOnClose`, `logs`. |
| `wsHooks` | Synchronous: `onIncomingMessage`, `onOutgoingMessage`, `onConnect`, `onDisconnect`, `onReconnect`, `onPong`. |

HTTP-side options that interact with hosting:

| Option | Default | Note |
| ------ | ------- | ---- |
| `upstream` | required (plugin throws `upstream must be specified` if missing — plugin test) | Target server URL. README: **paths in `upstream` are ignored**; use `rewritePrefix` for target base path. |
| `prefix` | (none) | Mount prefix; stripped when forwarding. |
| `rewritePrefix` | `''` | Rewrite stripped prefix. |
| `httpMethods` | `['DELETE','GET','HEAD','PATCH','POST','PUT','OPTIONS']` | Restricting to `GET`/`HEAD` is documented via this array (plugin test `settings of method types`). |
| `routes` | `['/', '/*']` | **Default includes exact `/`.** Plugin test `settings of routes` uses `routes: ['/a']` to limit. |

Plugin source registers:

```js
const defaultRoutes = ['/', '/*']
const defaultHttpMethods = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT', 'OPTIONS']
// ...
for (const url of opts.routes || defaultRoutes) {
  fastify.route({ url, method, preHandler, config, constraints, handler })
}
```

`@fastify/websocket` is a **devDependency** of http-proxy, not a runtime dependency. Runtime WS uses the `ws` package and `server.on('upgrade', ...)`. Official README does not require `@fastify/websocket`.

---

## Q4. Does `app.inject()` exercise static / http-proxy?

### What official Fastify testing docs say

https://fastify.dev/docs/latest/Guides/Testing/ (v5.12.1, retrieved 2026-08-21):

- `inject` is **fake HTTP injection** via [`light-my-request`](https://github.com/fastify/light-my-request).
- “`.inject` ensures all registered plugins have booted up” (so it overlaps with `await app.ready()`).
- Alternative: `fastify.listen()` then real HTTP (`fetch` / undici).

light-my-request README (https://github.com/fastify/light-my-request, retrieved 2026-08-21):

> Injects a fake HTTP request/response into a node HTTP server … **Does not use a socket connection** so can be run against an inactive server (server not in listen mode).

That README lists HTTP methods, headers, payload, cookies, `simulate`, `signal`. **It does not document WebSocket or HTTP `upgrade`.**

### `@fastify/static` + `inject`

**Yes, officially exercised.** Plugin test explicitly named `'inject support'`:

```js
test('inject support', async (t) => {
  const pluginOptions = {
    root: path.join(__dirname, '/static'),
    prefix: '/static'
  }
  const fastify = Fastify()
  fastify.register(fastifyStatic, pluginOptions)
  const response = await fastify.inject({
    method: 'GET',
    url: '/static/index.html'
  })
  t.assert.deepStrictEqual(response.statusCode, 200)
  t.assert.deepStrictEqual(response.body.toString(), indexContent)
})
```

Source: https://github.com/fastify/fastify-static/blob/main/test/static.test.js (retrieved 2026-08-21). Many other tests also `fastify.inject({ method: 'GET', url: ... })` and assert file bodies.

Caveat not in those docs: inject is in-process fake HTTP; it still runs the static handler and `@fastify/send` filesystem read. It is **not** a listen-mode integration test.

### `@fastify/http-proxy` + `inject`

**Official README and Testing.md do not mention `inject` together with this plugin.**

What the plugin’s **own tests** actually do (retrieved 2026-08-21):

- HTTP: `test/test.js` — `await server.listen({ port: 0 })` then **`fetch(http://localhost:…)`**. No `.inject(` in that file’s HTTP cases as read.
- WebSocket: `test/websocket.js` — `await server.listen(...)` then real `new WebSocket('ws://127.0.0.1:...')`. Upgrade path is `fastify.server.on('upgrade', ...)`.

**HTTP proxying:** docs are **silent** on whether `inject` is a supported way to test it. Mechanically, the HTTP handler calls `reply.from()` / undici against a real `upstream`; an injected incoming request could still trigger a real outbound HTTP call if an origin is listening. That is **not** documented and **not** how the official test suite is written.

**WebSocket / HMR:** docs are **silent**, and light-my-request documents **no socket / no upgrade**. Official WS tests always `listen()` + real `WebSocket`. Treat `inject` as **not shown to exercise** http-proxy WebSocket.

---

## Q5. Gotcha: `app.get('/')` registered before `@fastify/static` — does static override it?

**No. Fastify does not override an existing method+URL. Static’s default wildcard does not even register `GET /`.**

### Fastify rule

`FST_ERR_DUPLICATED_ROUTE`: “The HTTP method already has a registered controller for that URL.” How to solve: “Use a different URL or register the controller for another HTTP method.” **No override API in that error’s documented solution.**

Source: https://fastify.dev/docs/latest/Reference/Errors/#fst_err_duplicated_route (v5.12.1). Message in core: `Method '%s' already declared for route '%s'` (`lib/errors.js`).

A later `app.register(@fastify/static)` **cannot replace** an earlier `app.get('/')`. If both try to own the same method+url, boot/`ready()` fails with that error.

(`FST_ERR_ROUTE_METHOD_ALREADY_SUPPORTED` is a different error: adding a method already supported on a route; docs mention `{ overrideExisting: true }` for **that** case — not for replacing another plugin’s `GET /`.)

### What static actually registers (HEAD / 10.1.3 source)

If `wildcard === undefined || wildcard === true`:

```js
fastify.route({
  ...routeOpts,
  method: ['HEAD', 'GET'],
  path: prefix + '*',  // default prefix '/' → '/*'
  handler (req, reply) { /* send file or reply.callNotFound() */ }
})
```

It does **not** call `fastify.get('/')` in the default wildcard branch (only an extra `fastify.get(opts.prefix, …)` when `redirect === true` **and** `prefix !== opts.prefix` after trailing-slash normalization).

The official SPA example **adds** `fastify.get('/')` **after** `register(@fastify/static)` — evidence that default static and exact `GET /` are meant to coexist.

**Implication for the measured local fact** (“exact `app.get('/')` currently wins so static must REPLACE that route when hosting is on”):

- Registering `@fastify/static` **in addition to** the placeholder `GET /` will **not** replace the placeholder. `/` keeps the placeholder body; static serves **other** GET paths via `/*` (e.g. `/index.html`, hashed assets) and 404s missing paths into `setNotFoundHandler`.
- To make `/` serve `index.html`, the placeholder route must **not** be registered when hosting is on, **or** it must itself `reply.sendFile('index.html')` (as in the official SPA example). Static will not steal it.

### `wildcard: false` is the opposite footgun

If `wildcard: false`, the plugin globs files and, for each index filename, also registers the **directory URL**. With default prefix `'/'` and a root `index.html`, that includes **`GET /`**. Then an existing `app.get('/')` **does** collide → `FST_ERR_DUPLICATED_ROUTE`.

### Same collision with `@fastify/http-proxy`

Default `routes: ['/', '/*']` **does** register exact `'/'`. Registering http-proxy at the root **after** `app.get('/')` is expected to throw `Method 'GET' already declared for route '/'` (same Fastify rule; also the failure mode in fastify/help#688 when combining static `/*` with proxy `/*`). Official maintainer reply there: Fastify uses deterministic routing; use `wildcard: false` on static — not “later plugin wins”.

https://github.com/fastify/help/issues/688 (community help thread, 2026-08-21; not a README contract).

More specific registered routes (`/api/v1/...`, `/login`, `/login/github`, …) still win over `/*` wildcards. Default proxy `httpMethods` includes POST/PUT/… — a root-level proxy without `httpMethods: ['GET','HEAD']` (or a tight `prefix`) would also claim non-GET methods that no more-specific route owns.

---

## Mapping to the stated hosting need (facts only)

Need: production static + SPA fallback to `index.html` for unmatched GET except `/api/*` and `/login*`; exact `GET /` currently wins; dev reverse-proxy of other GET/WS to Vite 7 HMR.

| Need | What official sources support | What they do **not** claim |
| ---- | ----------------------------- | -------------------------- |
| Serve a directory | `@fastify/static` `>=8.x`, `root` + default `prefix: '/'` | — |
| `index.html` at `/` | Explicit `GET /` + `reply.sendFile('index.html')` **or** omit placeholder and rely on send index / `wildcard: false` glob of `/` | Default `wildcard: true` replacing an existing `GET /` |
| SPA for unknown GET | `setNotFoundHandler` + `sendFile('index.html')` after static 404/`callNotFound`; Fastify 5 has **no** `setDefaultRoute` | Automatic skip of `/api/*` and `/login*` |
| Dev reverse proxy + WS | `@fastify/http-proxy` 11.x, `upstream`, `websocket: true`, optional `wsUpstream` / `wsClientOptions` | Vite 7 / HMR-specific behavior |
| Test static files | `app.inject` — plugin’s own `'inject support'` test | — |
| Test HTTP proxy | Official tests: `listen` + `fetch` | `inject` (docs silent) |
| Test WS/HMR proxy | Official tests: `listen` + `ws` | `inject` (no socket) |

---

## Source list (retrieved 2026-08-21)

1. https://github.com/fastify/fastify-static — README, `package.json` 10.1.3, `index.js`, `test/static.test.js`
2. https://www.npmjs.com/package/@fastify/static and https://registry.npmjs.org/@fastify/static/latest — 10.1.3
3. https://www.npmjs.com/package/@fastify/send — 4.1.1, `index` default `index.html`
4. https://fastify.dev/docs/latest/Reference/Server/#setnotfoundhandler — Fastify v5.12.1
5. https://fastify.dev/docs/latest/Reference/Reply/#callnotfound — v5.12.1
6. https://fastify.dev/docs/latest/Reference/Errors/#fst_err_duplicated_route — v5.12.1
7. https://fastify.dev/docs/latest/Guides/Testing/ — v5.12.1, `inject` / light-my-request
8. https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/ — `setDefaultRoute` removed
9. https://github.com/fastify/light-my-request — README (no WebSocket)
10. https://github.com/fastify/fastify-http-proxy — README, `package.json` 11.6.0, `index.js`, `test/test.js`, `test/websocket.js`
11. https://www.npmjs.com/package/@fastify/http-proxy — 11.6.0
12. https://github.com/fastify/fastify-reply-from — README, `package.json` 12.6.4, `index.js` (`fastify: '5.x'`, no websocket)
13. https://www.npmjs.com/package/@fastify/reply-from — 12.6.4
14. GitHub releases APIs: `fastify/fastify-static`, `fastify/fastify-http-proxy`, `fastify/fastify-reply-from`
