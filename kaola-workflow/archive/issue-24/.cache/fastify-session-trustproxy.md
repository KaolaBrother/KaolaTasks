# Fastify `trustProxy` + `@fastify/session` cookie `secure` (issue #24)

Retrieval date: **2026-08-25**. Context7 MCP is **not** in this agent’s tool list; facts below are from official Fastify docs / GitHub source and `@fastify/session` / `@fastify/oauth2` / `@fastify/cookie` READMEs and tagged source.

Do not treat this as production code. No APIs below are guessed.

---

## Stack as installed (this repo)

From `apps/server/package.json` and `pnpm-lock.yaml`:

| Package | Range | Lockfile |
|---|---|---|
| `fastify` | `^5.4.0` | **5.12.1** |
| `@fastify/session` | `^11.1.2` | 11.1.2 |
| `@fastify/cookie` | `^11.1.2` | 11.1.2 |
| `@fastify/oauth2` | `^8.3.0` | (range 8.3.x) |
| Node | `>=22` | — |

**Lockfile Fastify is 5.12.1, not 5.4.0.** That matters: hop-count `trustProxy` was disabled in 5.12.1.

Current Kaola code (for implementers, not a library fact):

- `apps/server/src/app.ts`: `Fastify()` — no `trustProxy`.
- `apps/server/src/auth.ts`: session `cookie: { path: '/', secure: false, httpOnly: true, sameSite: 'lax' }`; OAuth `cookie: { path: '/' }` only.

Issue: https://github.com/KaolaBrother/KaolaTasks/issues/24 (comments do not amend the spec).

---

## 1. Fastify `trustProxy`: constructor values; `protocol` / `ip`

### Valid values (official Server docs)

**Default:** `false`.

Documented kinds:

| Value | Meaning (v5.4.0 docs) | Meaning (**v5.12.1 / latest docs**, this lockfile) |
|---|---|---|
| `false` | Do not trust proxies | Same |
| `true` | Trust **all** proxies | Same — `getTrustProxyFn` returns `() => true` |
| `string` | Trust given IP/CIDR (comma-separated OK), e.g. `'127.0.0.1'`, `'127.0.0.1,192.168.1.1/24'` | Same |
| `Array` | Trust IP/CIDR list, e.g. `['127.0.0.1']` | Same |
| `number` | “Trust the nth hop from the front-facing proxy as the client” (`1` = one hop) | **Hop-count-only trust is disabled** (cannot validate the immediate peer; lets direct clients spoof `X-Forwarded-*`). Use IP/CIDR, array, or a custom function that **validates the proxy address**. |
| `Function` | `(address, hop) => boolean` | Same; docs require inspecting **`address`**, not hop-only (`hop < 1` is called unsafe if Fastify is reachable directly) |

Sources:

- https://fastify.dev/docs/v5.4.x/Reference/Server/ (v5.4.x `trustProxy`)
- https://fastify.dev/docs/latest/Reference/Server/ and https://github.com/fastify/fastify/blob/v5.12.1/docs/Reference/Server.md (v5.12.1)
- Runtime 5.12.1: https://raw.githubusercontent.com/fastify/fastify/v5.12.1/lib/request.js (`getTrustProxyFn`)
- Advisory (numeric form disabled in 5.12.1): https://github.com/fastify/fastify/security/advisories/GHSA-3m5p-2c4r-xxw2 (CVE-2026-16732, published 2026-08-18)

**“Trust only the first hop / the reverse proxy in front” on 5.12.1 is not `trustProxy: 1`.** It is: trust the **connecting peer’s IP** (loopback / docker bridge / nginx bind address), via string/array/function.

### How `request.protocol` and `request.ip` are derived

Official Request docs (v5.12.1):

- `protocol`: from `socket.encrypted` **or** `X-Forwarded-Proto` when `trustProxy` is enabled.
- `ip`: from `socket.remoteAddress` **or** `X-Forwarded-For` when `trustProxy` is enabled.
- Multiple `x-forwarded-proto` / `x-forwarded-host` values: **last** entry wins.

Source: https://github.com/fastify/fastify/blob/v5.12.1/docs/Reference/Request.md

#### `trustProxy: false` (or omitted)

From 5.12.1 `lib/request.js` regular getters (no trust-proxy prototype):

- `protocol` = `socket.encrypted ? 'https' : 'http'`.
- `ip` = `socket.remoteAddress` (the reverse proxy, e.g. `127.0.0.1`).
- `X-Forwarded-Proto: https` is **ignored**. Behind nginx/caddy TLS termination, Node’s socket is not encrypted → **`request.protocol === 'http'`**.

#### `trustProxy: 1` (number) — **do not use on this lockfile**

**v5.4.0 source** (`lib/request.js`): hop function is `(a, i) => i < tp`. `trustProxy: 1` trusts hop index `0` (immediate peer). Importantly, v5.4.0’s `protocol` getter trusted **any** `x-forwarded-proto` whenever trust-proxy mode was on (`if (this.headers['x-forwarded-proto'])`), without checking the peer. So `X-Forwarded-Proto: https` → `request.protocol === 'https'`. That peer-unaware header read is GHSA-444r-cwp2-x5xf (CVE-2026-3635).

**v5.12.1 source:** `typeof tp === 'number'` compiles to `function () { return false }` (fail closed). The trust-proxy `protocol` getter only uses `x-forwarded-proto` when `proxyFn(socket.remoteAddress, 0)` is true. For a number, that is **always false**, so protocol falls back to `socket.encrypted` → **`http` behind TLS termination**, same as `trustProxy: false`. Session `secure: true` cookies still will not be sent.

#### `trustProxy: true`

- `proxyFn` always true.
- `X-Forwarded-Proto: https` → `request.protocol === 'https'` (last header value).
- `request.ip` is taken from the forwarded chain (`proxyAddr.all`); clients can spoof `X-Forwarded-*` if they can reach the origin.

#### `trustProxy: '127.0.0.1'` (or CIDR / custom function that returns true for the proxy)

- Only if `socket.remoteAddress` matches the trusted address (and hop `0` guard) does Fastify read `X-Forwarded-Proto` / `X-Forwarded-For`.
- Then `X-Forwarded-Proto: https` → `protocol === 'https'`.
- If the peer is **not** that IP (typical Docker DNAT: peer is `172.x` / `::ffff:172.x`, not `127.0.0.1`), headers are ignored → `protocol` stays `http`.

---

## 2. `@fastify/session` cookie option `secure`

Official README (tag **v11.1.2**): https://raw.githubusercontent.com/fastify/session/v11.1.2/README.md

- For unencrypted HTTP, set `secure` to `false`. Default `secure` is **`true`**.
- `secure` may be `'auto'`: Secure is false on HTTP and true on HTTPS; in HTTP mode `sameSite` is forced to Lax (README) / `'lax'` (source).
- **Reverse-proxy TLS:** “If you are terminating HTTPs at the reverse proxy, you need to add the `trustProxy` setting to your fastify instance if you want to use secure cookies.”

### What “HTTPS” means for this plugin

Not Node TLS (`https` server options) by itself. Session v11.1.2 `lib/cookie.js` (`secure: 'auto'`):

```js
if (this.secure === 'auto') {
  if (request.protocol === 'https') {
    this.secure = true
  } else {
    this.sameSite = 'lax'
    this.secure = false
  }
}
```

`onSend` in `index.js` (v11.1.2):

```js
const isInsecureConnection = session.cookie.secure === true && request.protocol !== 'https'
if (!saveSession || isInsecureConnection) {
  // … may clearCookie; setCookie only if session.isSaved(); then return
  // does NOT session.save() for a new session
}
```

So `secure: true` requires **`request.protocol === 'https'`**, which is Fastify’s protocol getter: `socket.encrypted` **or** (with a working `trustProxy`) `X-Forwarded-Proto`. It is **not** “browser saw HTTPS” unless Fastify’s protocol agrees.

Related maintainer discussion: https://github.com/fastify/session/issues/272 — plugin used to check the raw socket; the documented fix is Fastify `trustProxy` so `request.protocol` reflects the proxy.

### If `secure: true` but Node still thinks HTTP

- **Not a thrown error.**
- Plugin skips saving a **new** session and **does not emit** `Set-Cookie` for that new id (`isInsecureConnection` short-circuit). Existing saved sessions can still `setCookie` in that branch if `session.isSaved()`.
- Effect for login: session cookie **silently missing** → looks like “login succeeded but not logged in”.
- The **browser** never sees a `Secure` cookie to drop; Fastify never sent it.

Contrast **`@fastify/cookie` `setCookie`** (v11.0.2 `plugin.js`; lockfile cookie is 11.1.2 — same pattern in 11.0.2): `secure: true` still serializes `Set-Cookie` with the Secure attribute. No protocol gate. The **browser** then stores it only on a secure context (HTTPS, or `http://localhost`). Official cookie README: be careful with `secure: true`; clients will not send the cookie later without HTTPS. Source: https://github.com/fastify/fastify-cookie/

OAuth **state/verifier** cookies go through `setCookie`, not the session `onSend` gate. They can still appear on the wire with `Secure` even when Fastify’s protocol is `http`. `@fastify/oauth2` v8.3.0 README (host-prefixed cookies): **the address bar matters, not Node TLS**; “terminating TLS at a reverse proxy and running Fastify over plain HTTP works exactly the same. You do not need `https` options on the Fastify instance, and you do not need `trustProxy`” **for those OAuth cookies**. Session cookies **do** need `trustProxy` if `secure: true`.

---

## 3. Pattern: `PUBLIC_URL` https vs localhost HTTP

Issue #24:

- `PUBLIC_URL` starts with `https:` → session + OAuth state cookies **Secure**; Fastify `trustProxy` for the **one proxy in front**.
- `http://localhost` / plain HTTP public IP → `secure: false`; local HTTP must keep working.

### Recommended mapping

| `PUBLIC_URL` | Session `cookie.secure` | OAuth `cookie.secure` | Fastify `trustProxy` |
|---|---|---|---|
| starts with `https:` | `true` | `true` (keep existing `path: '/'`) | Enable, **peer-IP form** (not `1`) |
| `http://localhost…` or other `http:` | `false` (as today) | omit or `false` | Leave **off** |

`trustProxy` on localhost HTTP: **not required** for cookies when `secure` is false. Leaving it on is “ok” for sending cookies but **changes `request.ip` / `request.protocol` / `request.host`** for every request and, with `true`, lets anyone who can hit the port spoof forwarded headers. Prefer **off** unless HTTPS-behind-proxy.

### Pitfalls

1. **`trustProxy: true` vs one hop.** `true` trusts every `X-Forwarded-*` (last proto/host). Safe only if the Fastify port is not reachable except from the proxy (issue wants `127.0.0.1:31415:31415`). Still prefer CIDR/IP of the real peer so a mis-bind does not open spoofing. Advisory impact includes **secure-cookie / HTTPS-enforcement bypass**.

2. **`trustProxy: 1` is not one-hop on 5.12.1.** It is a no-op trust predicate. Secure session cookies stay suppressed.

3. **Docker vs `127.0.0.1`.** Host nginx → `127.0.0.1:31415` published into a container often shows **bridge IP**, not `127.0.0.1`, as `socket.remoteAddress`. Hard-coding `'127.0.0.1'` can leave `protocol` at `http`. Measure the peer (or trust loopback **and** RFC1918 / the compose network), or use a function that checks `address`.

4. **Proxy must set `X-Forwarded-Proto`.** Caddy/nginx should **overwrite** proto from `$scheme`, not pass through a client-supplied header if you trust forwarded proto.

5. **Session cookie vs OAuth state cookie.** Session: `@fastify/session` **blocks** Set-Cookie when `secure && protocol !== 'https'`. OAuth: `@fastify/oauth2` uses `@fastify/cookie`; Secure is a flag for the **browser**. Both still need `path: '/'` so start path `/login/github` and callback `/login/github/callback` share the cookie (already Kaola’s OAuth cookie). Do not assume one `cookie` object is shared between session and oauth2 — they are separate plugin options.

6. **`secure: 'auto'`** is per-request protocol, not `PUBLIC_URL`. A client sending `X-Forwarded-Proto: https` to an HTTP-only public IP deploy (with a too-wide `trustProxy`) would get Secure session cookies the browser may refuse. Prefer **boolean from `PUBLIC_URL`**, not `'auto'`, for #24.

7. **`hostPrefixedCookies` (`@fastify/oauth2`).** README: `__Host-` names **require HTTPS in the browser**; unusable on plain HTTP public IP; optional for #24 (issue only asked Secure, not `__Host-`). Enabling on HTTP public IP would make login fail with Invalid state (cookies dropped).

---

## 4. `@fastify/session` v11 + Fastify 5: cookie option names; `secure: 'auto'`?

Plugin declares `fastify: '5.x'` (`index.js` v11.1.2).

README cookie object:

- `path` (default `/`)
- `maxAge` (ms)
- `httpOnly` (default `true`)
- `secure` (`boolean` or **`'auto'`**, default `true`)
- `expires`
- `sameSite` (boolean or string)
- `domain`
- `partitioned` (experimental)

Types (`types/index.d.ts` v11.1.2): `CookieOptions extends Omit<CookieSerializeOptions, 'signed' | 'maxAge'>`. `@fastify/cookie` `CookieSerializeOptions.secure` is `boolean | 'auto'`. Express-session-shaped `cookie.secure` on the session object is also `boolean | 'auto'`.

**Yes, `secure: 'auto'` is documented and implemented** in v11.1.2 (`lib/cookie.js`). Historical TS issues (#222, #299) were about typings vs README; current types inherit `'auto'` from cookie.

Kaola already uses `path`, `secure`, `httpOnly`, `sameSite: 'lax'` — those names are correct.

---

## 5. Is `Fastify({ trustProxy: 1 })` enough for Secure cookies behind nginx/caddy?

**On Fastify 5.12.1 (this repo’s lockfile): no.** Numeric hop-count is disabled; `X-Forwarded-Proto` is not applied; `request.protocol` stays `http`; `@fastify/session` with `cookie.secure: true` **will not Set-Cookie** a new session. Changing only cookie flags without a **working** `trustProxy` is not enough.

**On Fastify 5.4.0 (range in package.json, not what pnpm locked):** `trustProxy: 1` plus `cookie.secure: true` would typically make `protocol` `https` when the header is present (v5.4 protocol getter trusted the header whenever trust-proxy mode was on). That is **not** the runtime you have after `pnpm install`.

Assuming `cookie.secure === true`, a **sufficient** Fastify constructor change is a **non-numeric** trust that actually accepts the reverse-proxy peer, e.g.:

```js
Fastify({ trustProxy: '127.0.0.1' })
// or ['127.0.0.1', '::1']
// or (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
```

plus nginx/caddy setting `X-Forwarded-Proto` to `https`. No further session cookie *code* is required **if** `protocol` becomes `https`. Verify the peer IP in the real compose/host layout.

`trustProxy: true` also makes protocol honor the header, but is the “trust all proxies” pitfall.

---

## Recommended implementation sketch (#24)

Decide once from `PUBLIC_URL` (trim trailing slash as today):

```ts
const publicUrl = trimTrailingSlash(process.env.PUBLIC_URL ?? 'http://localhost:31415')
const cookieSecure = publicUrl.startsWith('https:')
```

1. **`buildApp` / `Fastify()`**  
   If `cookieSecure`: pass `trustProxy` that validates the **immediate peer** (string/array/function). Do **not** pass `1`. If not `cookieSecure`: omit `trustProxy` (keep current `Fastify()`).

2. **Session** (`@fastify/session`):  
   `cookie: { path: '/', secure: cookieSecure, httpOnly: true, sameSite: 'lax' }`  
   Do not switch to `'auto'` unless tests prove you want per-request protocol instead of PUBLIC_URL.

3. **OAuth** (`@fastify/oauth2` `cookie`):  
   `{ path: '/', secure: cookieSecure }` (defaults remain `httpOnly` + `sameSite: Lax` per oauth2 README). Same `secure` as session so HTTPS public URL marks state/PKCE cookies Secure. Do not enable `hostPrefixedCookies` unless you accept “HTTPS only” (breaks `http://公网IP`).

4. **Proxy config (ops, not Node API):** overwrite `X-Forwarded-Proto` from the client-facing scheme; do not leave 31415 on `0.0.0.0`.

5. **Tests:** `PUBLIC_URL=https://…` → session `Set-Cookie` includes `Secure` **and** inject/simulate `X-Forwarded-Proto: https` with a trusted peer (or Fastify inject’s forwarded headers **and** a trustProxy value that accepts inject’s remote address). Local `http://localhost` → no Secure, existing cases unchanged.

---

## Source list (2026-08-25)

- Fastify Server `trustProxy` v5.4.x: https://fastify.dev/docs/v5.4.x/Reference/Server/
- Fastify Server `trustProxy` latest / v5.12.1: https://fastify.dev/docs/latest/Reference/Server/ , https://github.com/fastify/fastify/blob/v5.12.1/docs/Reference/Server.md
- Fastify Request (`protocol` / `ip`): https://github.com/fastify/fastify/blob/v5.12.1/docs/Reference/Request.md
- Fastify 5.12.1 `lib/request.js`: https://raw.githubusercontent.com/fastify/fastify/v5.12.1/lib/request.js
- Fastify 5.4.0 `lib/request.js`: https://raw.githubusercontent.com/fastify/fastify/v5.4.0/lib/request.js
- GHSA-3m5p-2c4r-xxw2 (disable numeric hop-count): https://github.com/fastify/fastify/security/advisories/GHSA-3m5p-2c4r-xxw2
- GHSA-444r-cwp2-x5xf (protocol/host spoofing): https://github.com/fastify/fastify/security/advisories/GHSA-444r-cwp2-x5xf
- `@fastify/session` v11.1.2 README: https://raw.githubusercontent.com/fastify/session/v11.1.2/README.md
- `@fastify/session` v11.1.2 `index.js` / `lib/cookie.js` / `types/index.d.ts` (same tag)
- `@fastify/session` #272 (secure + reverse proxy): https://github.com/fastify/session/issues/272
- `@fastify/cookie` types `secure?: boolean | 'auto'`: https://raw.githubusercontent.com/fastify/fastify-cookie/v11.0.2/types/plugin.d.ts
- `@fastify/oauth2` v8.3.0 README (cookie + host prefix + TLS at proxy): https://raw.githubusercontent.com/fastify/fastify-oauth2/v8.3.0/README.md
- Issue #24: https://github.com/KaolaBrother/KaolaTasks/issues/24
