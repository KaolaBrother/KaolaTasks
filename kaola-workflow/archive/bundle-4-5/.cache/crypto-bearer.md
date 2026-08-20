# Node 22 AES-256-GCM + Fastify 5 Bearer auth — knowledge-lookup

**Written:** 2026-08-21  
**Role:** knowledge-lookup (read-only). No production edits.  
**Context7 MCP:** unavailable in this runtime (no `resolve-library-id` / `query-docs` tools). All library facts below are from official Node.js v22 docs, Fastify v5 docs, npm READMEs, RFCs, NIST SP 800-38D, W3C Web Crypto, SQLite, and better-sqlite3 docs, fetched 2026-08-21.  
**This machine’s Node:** `v24.14.0` was used only for a one-shot `getCipherInfo` / API-existence probe. Project `engines.node` is `>=22`. Node 22-specific claims are taken from **Node.js v22.23.2** docs (`https://nodejs.org/docs/latest-v22.x/…`), not from that v24 binary, except where explicitly labelled.

This note does **not** choose a Kaola env-var name, hash algorithm, ciphertext layout, or whether to add a Fastify plugin.

---

## 0. Local repo (confirmed against files)

| Fact | Evidence |
|------|----------|
| Node engines `>=22` | root `package.json` `"engines": { "node": ">=22" }` |
| Server runs `node --experimental-strip-types` | `apps/server/package.json` scripts `start` / `dev`; root `pnpm test` |
| Fastify `^5.4.0` | `apps/server/package.json` `dependencies.fastify` |
| Already installed | `@fastify/cookie ^11.1.2`, `@fastify/oauth2 ^8.3.0`, `@fastify/session ^11.1.2`, `drizzle-orm ^0.44.4`, `better-sqlite3 ^12.2.0` |
| **Not** installed | No `@fastify/auth`, no `@fastify/bearer-auth` in any `package.json` or `pnpm-lock.yaml` |
| Token vault | `docs/DESIGN.md` §7: AES-256-GCM; master key from env / key file; not in DB or source |
| Agent keys | `docs/DESIGN.md` §10 `agent_keys.key_hash`; §11 “Bearer API Key…服务端只存哈希” |
| Session 401 JSON | `apps/server/src/auth.ts`: `reply.code(401).send({ error: 'unauthorized' })` for JSON `/api/v1/me` and unauthenticated approve |
| SQLite bootstrap | `apps/server/src/db.ts`: `CREATE TABLE IF NOT EXISTS users (…)`; no `drizzle-kit` in any `package.json` |
| Tests | root `pnpm test` = `node --experimental-strip-types --test …`; auth tests use Fastify `app.inject` (see `apps/server/src/auth.test.ts`) |

DESIGN.md §7 quote: “加密存储：AES-256-GCM，主密钥来自环境变量/密钥文件，不入库、不入代码。”  
DESIGN.md §11 quote: “Agent（MCP/REST）：Bearer API Key，用户在 Web 端自助生成/吊销，服务端只存哈希。”

---

## 1. Node 22 `node:crypto` AES-256-GCM

### 1.1 Which APIs exist: `createCipheriv` / `createDecipheriv` vs `createCipher` vs Web Crypto

**Use `createCipheriv` / `createDecipheriv`.** Signatures from Node.js v22.23.2 crypto docs:

```
crypto.createCipheriv(algorithm, key, iv[, options])
crypto.createDecipheriv(algorithm, key, iv[, options])
```

Quoted: “Creates and returns a `Cipher` object, with the given `algorithm`, `key` and initialization vector (`iv`).”  
Quoted: “The `key` is the raw key used by the `algorithm` and `iv` is an initialization vector. Both arguments must be `'utf8'` encoded strings, Buffers, `TypedArray`s, or `DataView`s. The `key` may optionally be a `KeyObject` of type `secret`.”

**`crypto.createCipher()` / `crypto.createDecipher()` are gone in Node 22.**  
Source: Node.js v22 deprecations, **DEP0106**, End-of-Life at v22.0.0:

> `crypto.createCipher()` and `crypto.createDecipher()` have been removed as they use a weak key derivation function (MD5 with no salt) and static initialization vectors. It is recommended to derive a key using crypto.pbkdf2() or crypto.scrypt() with random salts and to use crypto.createCipheriv() and crypto.createDecipheriv() to obtain the Cipher and Decipher objects respectively.

URL: https://nodejs.org/docs/latest-v22.x/api/deprecations.html#dep0106-cryptocreatecipher-and-cryptocreatedecipher  
Also: https://nodejs.org/en/blog/migrations/v20-to-v22 (migration note for DEP0106).

**Web Crypto alternative (same Node 22 process):** `crypto.subtle` is “A convenient alias for `crypto.webcrypto.subtle`” (added v17.4.0). AES-GCM is listed under `subtle.encrypt` / `subtle.decrypt` with algorithm name `'AES-GCM'` (not `'aes-256-gcm'`). Web Crypto **appends the tag to the ciphertext**; Node `createCipheriv` **does not**. See §1.7.

For a vault that must store IV + ciphertext + tag as separate pieces (or a layout you control), `createCipheriv`/`createDecipheriv` match the OpenSSL GCM split-tag model. Web Crypto is valid AES-GCM but a different wire format.

### 1.2 Algorithm string

OpenSSL / `node:crypto` cipher name: **`'aes-256-gcm'`**.

Node v22 `crypto.getCiphers()` docs example: `console.log(getCiphers()); // ['aes-128-cbc', 'aes-128-ccm', ...]`.  
Quoted: “The `algorithm` is dependent on OpenSSL, examples are `'aes192'`, etc. On recent OpenSSL releases, `openssl list -cipher-algorithms` will display the available cipher algorithms.”

Web Crypto algorithm name is **`'AES-GCM'`** plus a key whose `length` is 256 bits (`AesKeyGenParams.length` “must be either `128`, `192`, or `256`”).

Do not mix the two name strings on the same API.

### 1.3 Key length

AES-256 key is **256 bits = 32 bytes**. Node v22 `crypto.getCipherInfo(nameOrNid[, options])` returns `keyLength`: “The expected or default key length in bytes.”

A probe on **this machine’s Node v24.14.0** (`crypto.getCipherInfo('aes-256-gcm')`) returned:

```json
{"mode":"gcm","name":"id-aes256-gcm","nid":901,"blockSize":1,"ivLength":12,"keyLength":32}
```

That measurement is OpenSSL via Node, not a Kaola decision. **BLOCK:** this `getCipherInfo` JSON was not captured on a Node 22 binary. Node 22 docs document the same `getCipherInfo` fields (`keyLength`, `ivLength`).

Master key: DESIGN says env / key file. `createCipheriv` expects the **raw 32-byte key**, not a passphrase. If the env value is a password, Node’s own DEP0106 text says derive with `pbkdf2` or `scrypt` **and a random salt** — that is a product decision (open). If the env value is already 32 raw bytes (or hex/base64 of 32 bytes), no KDF is required by the cipher API.

### 1.4 IV / nonce length

**NIST SP 800-38D** (official GCM recommendation), §5.2.1.1:

> For IVs, it is recommended that implementations restrict support to the length of **96 bits**, to promote interoperability, efficiency, and simplicity of design.

96 bits = **12 bytes**. PDF: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf

**Node.js v22 Web Crypto `AesGcmParams.iv`:**

> The initialization vector must be unique for every encryption operation using a given key.  
> Ideally, this is a deterministic 12-byte value that is computed in such a way that it is guaranteed to be unique across all invocations that use the same key. Alternatively, the initialization vector may consist of **at least 12 cryptographically random bytes**. For more information on constructing initialization vectors for AES-GCM, refer to Section 8 of NIST SP 800-38D.

URL: https://nodejs.org/docs/latest-v22.x/api/webcrypto.html#class-aesgcmparams

**Node `createCipheriv` (v22)** does not hard-code 12 in the `createCipheriv` paragraph. It says:

> Initialization vectors should be unpredictable and unique; ideally, they will be cryptographically random. They do not have to be secret: IVs are typically just added to ciphertext messages unencrypted.

`getCipherInfo` documents `ivLength` as “The expected or default initialization vector length in bytes.” The v24 probe reported **`ivLength: 12`** for `'aes-256-gcm'`.

**Is a 12-byte random IV per encrypt the current recommendation?**  
Yes, as one of the two constructions NIST and Node Web Crypto document:

1. Deterministic 12-byte IV unique per (key, message) — NIST §8.2.1.  
2. Random IV: NIST §8.2.2 says for the RBG construction “the length of the random field shall be **at least 96 bits**”; Node Web Crypto: “at least 12 cryptographically random bytes.”

A fresh `randomBytes(12)` per encrypt under a given key is the random construction. **IV reuse under the same key is catastrophic for GCM** (NIST uniqueness requirement; Node’s own createCipher removal cites static IVs / nonce reuse).

### 1.5 Auth tag: `getAuthTag` / `setAuthTag`, typical length 16

**Encrypt — after `cipher.final()`:**

```
cipher.getAuthTag()
```

Quoted (Node v22): “When using an authenticated encryption mode (`GCM`, `CCM`, `OCB`, and `chacha20-poly1305` are currently supported), the `cipher.getAuthTag()` method returns a Buffer containing the authentication tag that has been computed from the given data.”  
“The `cipher.getAuthTag()` method should only be called after encryption has been completed using the `cipher.final()` method.”  
“If the `authTagLength` option was set during the `cipher` instance’s creation, this function will return exactly `authTagLength` bytes.”

**`createCipheriv` GCM default tag length:**

> In GCM mode, the `authTagLength` option is not required but can be used to set the length of the authentication tag that will be returned by `getAuthTag()` and **defaults to 16 bytes**.

16 bytes = 128 bits. NIST SP 800-38D §5.2.1.2: tag length `t` may be 128, 120, 112, 104, or 96 (and 64 or 32 only with extra constraints). 128 is the usual full-size tag.

**Decrypt — supply tag before `final()`:**

```
decipher.setAuthTag(buffer[, encoding])
```

Quoted: “the `decipher.setAuthTag()` method is used to pass in the received authentication tag.”  
“The `decipher.setAuthTag()` method must be called before `decipher.update()` for `CCM` mode or **before `decipher.final()` for `GCM`** and `OCB` modes and `chacha20-poly1305`. `decipher.setAuthTag()` can only be called once.”

Node v22.0.0 history on `setAuthTag`: “Using GCM tag lengths other than 128 bits without specifying the `authTagLength` option when creating `decipher` is **deprecated**.” Prefer explicit `{ authTagLength: 16 }` on both cipher and decipher if you always use 16-byte tags.

**Web Crypto:** `aesGcmParams.tagLength` default **`128`** (bits). Encrypt output is **C concatenated with T**, not a separate `getAuthTag`.

### 1.6 Wrong / missing auth tag — does it throw?

**Yes.** Node v22 `decipher.setAuthTag` docs:

> If no tag is provided, or if the cipher text has been tampered with, **`decipher.final()` will throw**, indicating that the cipher text should be discarded due to failed authentication. If the tag length is invalid according to NIST SP 800-38D or does not match the value of the `authTagLength` option, **`decipher.setAuthTag()` will throw** an error.

Do not return partial plaintext after a failed `final()`.

### 1.7 Encoding ciphertext + IV + tag for SQLite TEXT vs BLOB

**Node `createCipheriv` does not glue the tag onto the ciphertext.** CCM docs (same crypto page) state the general Node AEAD split:

> Many crypto libraries include the authentication tag in the ciphertext, which means that they produce ciphertexts of the length `plaintextLength + authTagLength`. **Node.js does not include the authentication tag, so the ciphertext length is always `plaintextLength`.**

GCM uses the same split via `getAuthTag` / `setAuthTag`.

**W3C Web Crypto AES-GCM** (fetched 2026-08-21, https://www.w3.org/TR/WebCryptoAPI/#aes-gcm):

> Let ciphertext be equal to **C | T**, where '|' denotes concatenation.  
> (decrypt) Let tag be the last tagLength bits of ciphertext. Let actualCiphertext be the result of removing the last tagLength bits from ciphertext.

So: **do not store a Web Crypto `subtle.encrypt` ArrayBuffer in the same layout as Node `update()+final()` output without stripping/appending the tag.**

**SQLite storage classes** (https://www.sqlite.org/datatype3.html, 2026-08-21):

- TEXT: “The value is a text string, stored using the database encoding (UTF-8, UTF-16BE or UTF-16LE).”  
- BLOB: “The value is a blob of data, stored exactly as it was input.”  
- TEXT affinity: stores NULL, TEXT, or BLOB; numbers are converted to text.  
- BLOB affinity: no coercion.

**better-sqlite3** (https://github.com/WiseLibs/better-sqlite3/blob/HEAD/docs/api.md, 2026-08-21):

| SQLite | JavaScript |
|--------|------------|
| TEXT | `string` |
| BLOB | `Buffer` |

**Common concatenation layouts (documented, not chosen):**

| Layout | Bytes | Typical TEXT encoding | Notes |
|--------|-------|------------------------|-------|
| A. `iv \|\| ciphertext \|\| tag` | 12 + n + 16 | base64 or hex of the whole buffer | Very common interop (nonce prefix, tag suffix). Matches “Go appends tag; prepend nonce” blogs; **not** a Node official layout. |
| B. `iv \|\| tag \|\| ciphertext` | 12 + 16 + n | base64 / hex | Fixed-size prefix (12+16) then remainder = ciphertext. |
| C. `ciphertext \|\| tag` with IV stored in a **separate column** | n + 16 | or BLOB + BLOB | IV uniqueness still required; two columns. |
| D. JSON `{ iv, ciphertext, tag }` each base64/hex | TEXT | Human-readable; no binary concat. |
| E. Web Crypto blob | `iv` separate + `subtle.encrypt` output = `C\|T` | Must not call Node `setAuthTag` on the whole blob without splitting last 16 bytes. |
| F. Version byte prefix | `0x01 \|\| iv \|\| ct \|\| tag` | Allows future layout changes. |

**TEXT vs BLOB:** TEXT needs a 7-bit-safe encoding (hex, base64, base64url). BLOB can store the raw `Buffer.concat`. DESIGN §10 names the column `token_encrypted` / `inline_token_encrypted` without SQL type.

**Do not pick a product env var name** for the master key. DESIGN only says 环境变量/密钥文件.

### 1.8 `randomBytes` and `timingSafeEqual`

**`crypto.randomBytes(size[, callback])`** (v22): “Generates cryptographically strong pseudorandom data.” Sync form returns a `Buffer`. Size “must not be larger than `2**31 - 1`.” Use for IV (`12`) and for generating API key material.

**`crypto.timingSafeEqual(a, b)`** (v22):

> This function compares the underlying bytes that represent the given `ArrayBuffer`, `TypedArray`, or `DataView` instances using a constant-time algorithm.  
> This function does not leak timing information that would allow an attacker to guess one of the values. This is suitable for comparing HMAC digests or secret values like authentication cookies or capability urls.  
> `a` and `b` must both be `Buffer`s, `TypedArray`s, or `DataView`s, and they **must have the same byte length**. An error is thrown if `a` and `b` have different byte lengths.  
> Use of `crypto.timingSafeEqual` does not guarantee that the surrounding code is timing-safe.

For hashed API keys: hash the presented token, then `timingSafeEqual` against the stored hash **only if both buffers are the same length**. Different algorithms / truncated hashes must be padded or rejected before compare. Surrounding DB lookup still leaks “unknown key id” vs “bad secret” unless you also dummy-compare.

### 1.9 Hash APIs that exist on Node 22 (no recommendation)

Documented on https://nodejs.org/docs/latest-v22.x/api/crypto.html (v22.23.2):

| API | Present on Node 22? | Signature / notes from docs |
|-----|---------------------|-----------------------------|
| `crypto.createHash(algorithm[, options])` | Yes | Examples **`'sha256'`**, **`'sha512'`**. “The `algorithm` is dependent on the available algorithms supported by the version of OpenSSL… `openssl list -digest-algorithms`.” `createHash('sha256').update(…).digest()`. |
| `crypto.hash(algorithm, data[, outputEncoding])` | Yes (added v21.7.0, v20.12.0) | One-shot. **Stability: 1.2 — Release candidate.** Default output `'hex'`. Examples include `'sha1'`; algorithm list same as createHash (`'sha256'`, `'sha512'`, etc.). |
| `crypto.getHashes()` | Yes | Returns names of digest algorithms. |
| `crypto.pbkdf2(password, salt, iterations, keylen, digest, callback)` | Yes | PBKDF2. Docs example: `pbkdf2('secret', 'salt', 100000, 64, 'sha512', …)`. Salt “at least 16 bytes” recommended (NIST SP 800-132). Sync: `pbkdf2Sync`. |
| `crypto.scrypt(password, salt, keylen[, options], callback)` | Yes | Password-based KDF. Default `N`/`cost` 16384, `r` 8, `p` 1. Sync: `scryptSync`. |
| `crypto.hkdf` / `hkdfSync` | Yes | HKDF (also on the v22 crypto page). Not requested as a Kaola decision. |
| **`crypto.argon2` / `argon2Sync`** | **No in Node 22 docs** | Node **v24.7.0** changelog: “crypto: add argon2() and argon2Sync() methods”. https://nodejs.org/en/blog/release/v24.7.0 |
| **Web Crypto Argon2** (`'Argon2id'` etc.) | **No in Node 22 `webcrypto.html`** (grep of latest-v22.x page: no `Argon2`) | Node **v24.8.0**: “crypto: add Argon2 Web Cryptography algorithms”. https://nodejs.org/en/blog/release/v24.8.0 |

**Do not decide** which hash Kaola should use for `agent_keys.key_hash`. Fast hash (sha256/sha512) vs password KDF (scrypt/pbkdf2) vs waiting for Argon2 (not in Node 22) is an orchestrator value call. `timingSafeEqual` applies to the **digest bytes**, not to a string `===`.

### 1.10 Minimal GCM round-trip (signatures only; not a product recipe)

From the documented APIs, a `createCipheriv` round-trip is:

```js
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// key: 32-byte Buffer (raw AES-256 key)
const iv = randomBytes(12)
const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
const tag = cipher.getAuthTag() // 16 bytes

const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
decipher.setAuthTag(tag)
const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
```

Persist `iv`, `ciphertext`, and `tag` (layout open). Wrong `tag` → `final()` throws.

---

## 2. Fastify 5 Bearer auth next to `@fastify/session` cookies

### 2.1 Official plugins vs custom header parse

**`@fastify/bearer-auth`** — Bearer hook. npm **10.1.3** (published 2026-08-08). README (https://www.npmjs.com/package/@fastify/bearer-auth, 2026-08-21):

- Compatibility: **plugin `^10.x` → Fastify `^5.x`**.
- Registers an `onRequest` hook by default (`addHook: true` / `'onRequest'`).
- Inspects `authorization` header in the format `bearer key`.
- Default `keys`: `Set` of **plaintext** strings, compared with a “constant time algorithm”.
- Custom `auth(key, req)` may return `true`/`false` or a Promise; **if `auth` is a function, `keys` is ignored**. Hashed DB keys fit `auth`, not the default `Set`.
- Default 401 body: `errorResponse: (err) => ({ error: err.message })`.
- `specCompliance`: `'rfc6750'` (default) “forces the token type to be an **exact match**”; `'rfc6749'` “allows the token type to be **case-insensitive**”.
- Encapsulation: “This allows registering the plugin within scoped paths, so some paths can be protected by the plugin while others are not.”

**`@fastify/auth`** — **not** a Bearer parser. npm **5.1.0** (2026-08-08). README (https://www.npmjs.com/package/@fastify/auth):

- Compatibility: **plugin `>=5.x` → Fastify `^5.x`**.
- Quote: “This module does not provide an authentication strategy but offers a fast utility to handle authentication and multiple strategies in routes.”
- You decorate your own `verify*` functions and pass them to `fastify.auth([...])` as `preHandler`.
- Bearer-auth README shows combining the two: register `@fastify/auth`, register bearer-auth with `{ addHook: false }`, then `preHandler: fastify.auth([fastify.verifyBearerAuth, …])`.

**Custom parse of `request.headers.authorization`:** Fastify Request exposes `headers` (v5.4.x Request docs). Node v22 HTTP: **header names are lower-cased**; use `request.headers.authorization`. Duplicate `authorization` headers are discarded (Node `message.headers` rules).

A custom hook is **sufficient and documented**. Fastify v5.4.x Hooks, “Respond to a request from a hook”:

> If needed, you can respond to a request before you reach the route handler, **for example when implementing an authentication hook**. Replying from a hook implies that the hook chain is stopped… If you are using `onRequest` or `preHandler` use `reply.send`.

Route-level hooks are also documented (`onRequest` / `preHandler` on the route options object). `@fastify/auth` security note: prefer `onRequest`/`preParsing` when the secret is in headers so a huge body is not parsed before 401.

### 2.2 Fastify 5 compatibility (version lines)

| Package | Fastify 5 line | Latest seen 2026-08-21 |
|---------|----------------|-------------------------|
| `@fastify/bearer-auth` | `^10.x` | **10.1.3** |
| `@fastify/auth` | `>=5.x` | **5.1.0** |
| `@fastify/cookie` (already in repo) | `>=10.x` → Fastify `^5.x` | `^11.1.2` installed |
| `@fastify/session` (already) | 11.x = Fastify 5 | `^11.1.2` installed |

Do **not** install bearer-auth `^8` / auth `^4` (those are Fastify 4).

### 2.3 RFC 6750 spelling of `Authorization: Bearer <token>`

https://www.rfc-editor.org/rfc/rfc6750.html §2.1 (fetched 2026-08-21):

Example:

```
Authorization: Bearer mF_9.B5f-4.1JqM
```

ABNF:

```
credentials = "Bearer" 1*SP b64token
```

- **`1*SP`** = **one or more** space characters (RFC 5234), not “exactly one” in the grammar. The example uses a single SP.  
- ABNF string literals are **case-insensitive** unless written as `%s"Bearer"` (RFC 5234). RFC 6750 does not use `%s`.  
- **RFC 9110** §11.1: HTTP “uses a **case-insensitive token** to identify the authentication scheme.” https://www.rfc-editor.org/rfc/rfc9110.html#name-authentication-scheme

Clients should send `Authorization: Bearer <token>` (capital B, one space) as in the RFC example. Servers that implement HTTP auth generally accept `bearer` / `BEARER`. **`@fastify/bearer-auth` default `specCompliance: 'rfc6750'` is documented as exact match** — that is stricter than RFC 5234/9110. Open decision if you use the plugin.

### 2.4 Mixing cookie session (humans) and Bearer (agents) on different routes

**Official Fastify encapsulation example uses `@fastify/bearer-auth` on a child context only** (Fastify v5.4.x Encapsulation, https://fastify.dev/docs/v5.4.x/Reference/Encapsulation/):

```
fastify.register(async function authenticatedContext (childServer) {
  childServer.register(require('@fastify/bearer-auth'), { keys: ['abc123'] })
  childServer.route({ path: '/one', … })
})
fastify.register(async function publicContext (childServer) {
  childServer.route({ path: '/two', … })  // no bearer
})
```

Docs: “Only the `authenticatedContext` has access to the `@fastify/bearer-auth` plugin.”

Kaola already registers `@fastify/session` on the **root** app (`registerAuth`). Session cookies then exist for all routes; that does not authenticate agents. Pattern that matches the docs:

- Keep session plugin at root (humans).  
- Register **agent REST/MCP routes in a child plugin** with either (a) `@fastify/bearer-auth` scoped there, or (b) a scoped `onRequest`/`preHandler` that parses Bearer and looks up `key_hash`.  
- Do **not** register `@fastify/bearer-auth` at root with default `addHook: true` — it would 401 browser session requests that have no `Authorization` header.

`@fastify/auth` is only needed if one route must accept **multiple** strategies (Bearer **or** session). DESIGN splits humans vs agents by protocol (cookie vs Bearer), so combinator plugin is optional.

### 2.5 Typical 401 body

**HTTP:** RFC 9110 §15.5.2: 401 means missing/invalid credentials; **server MUST send `WWW-Authenticate`** with a challenge. RFC 6750 §3: resource server **MUST** include `WWW-Authenticate` using scheme `Bearer`, e.g.

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="example"
```

or with `error="invalid_token"`.

**Fastify default error handler** (latest Errors docs, also applicable as the generic serializer; v5.4.x Errors page is thinner): JSON

```json
{ "statusCode": 500, "error": "Internal Server Error", "message": "kaboom" }
```

Quoted: “The default error handler serializes the error into a JSON body with the `statusCode`, `error`, and `message` properties, plus `code` when the error carries one.”  
“The `error` property is the **generic HTTP status text**, but `message` is `error.message` verbatim. This applies to every status code.”

So `reply.code(401).send(new Error('…'))` / thrown errors with `statusCode: 401` tend toward:

```json
{ "statusCode": 401, "error": "Unauthorized", "message": "<error.message>" }
```

not Kaola’s session shape.

**`@fastify/bearer-auth` default:** `{ error: err.message }` (npm README). Not `{ error: 'unauthorized' }`.

**Kaola today:** `{ error: 'unauthorized' }` with HTTP 401, **no** `WWW-Authenticate` (session JSON). Matching agent 401s to that object is a product consistency choice; RFC 6750 additionally wants `WWW-Authenticate: Bearer …`.

**Fastify `inject`:** official Testing guide uses `app.inject({ method, url, headers, … })` without binding a port — matches existing `auth.test.ts`. Do not hit live network.

---

## 3. What NOT to add

**`drizzle-kit` is not required at runtime** for this vault/auth work. Prior bundle used `CREATE TABLE IF NOT EXISTS` on the better-sqlite3 handle (`apps/server/src/db.ts`). drizzle-kit is a generate/push/migrate **dev** tool; it is not a runtime dependency of `drizzle-orm ^0.44.4`. Do not add it unless the orchestrator explicitly chooses migrations.

Do not add `@fastify/bearer-auth` / `@fastify/auth` unless the orchestrator records “plugin” over “custom hook”. Hashed API keys already need a custom `auth()` callback if the plugin is used, so the plugin’s `keys: Set` does not map to DESIGN §11.

Do not add a live-network test harness; Fastify `inject` + `node:test` is the documented in-process path.

---

## 4. Verified facts table

| API / fact | Source URL | Version / date |
|------------|------------|----------------|
| `crypto.createCipheriv(algorithm, key, iv[, options])`; GCM `authTagLength` default 16 | https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreatecipherivalgorithm-key-iv-options | Node.js v22.23.2 docs, 2026-08-21 |
| `crypto.createDecipheriv(algorithm, key, iv[, options])` | https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreatedecipherivalgorithm-key-iv-options | same |
| `cipher.getAuthTag()` after `final()` | https://nodejs.org/docs/latest-v22.x/api/crypto.html#ciphergetauthtag | same |
| `decipher.setAuthTag`; **`final()` throws** on missing/wrong tag | https://nodejs.org/docs/latest-v22.x/api/crypto.html#deciphersetauthtagbuffer-encoding | same; history v22.0.0 non-128-bit GCM tags deprecated without `authTagLength` |
| `createCipher` / `createDecipher` **removed** | https://nodejs.org/docs/latest-v22.x/api/deprecations.html#dep0106-cryptocreatecipher-and-cryptocreatedecipher | DEP0106 EOL **v22.0.0** |
| `crypto.randomBytes(size[, callback])` | https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptorandombytessize-callback | v22.23.2 |
| `crypto.timingSafeEqual(a, b)` same-length constant-time | https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptotimingsafeequala-b | v22.23.2 |
| `createHash('sha256'\|'sha512')` | https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreatehashalgorithm-options | v22.23.2 |
| `crypto.hash(algorithm, data[, outputEncoding])` Stability 1.2 RC | https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptohashalgorithm-data-outputencoding | added v21.7.0 / v20.12.0 |
| `crypto.pbkdf2` / `pbkdf2Sync` | https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptopbkdf2password-salt-iterations-keylen-digest-callback | v22.23.2 |
| `crypto.scrypt` / `scryptSync` | https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback | v22.23.2 |
| `crypto.subtle` alias of `webcrypto.subtle` | https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptosubtle | added v17.4.0 |
| AES-GCM IV: unique; 12-byte deterministic **or** ≥12 random bytes | https://nodejs.org/docs/latest-v22.x/api/webcrypto.html#aesgcmparamsiv | Node v22 Web Crypto |
| AES-GCM `tagLength` default 128 bits | https://nodejs.org/docs/latest-v22.x/api/webcrypto.html#aesgcmparamstaglength | Node v22 Web Crypto |
| GCM IV 96 bits recommended | https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf | NIST SP 800-38D |
| Web Crypto ciphertext = C \| T | https://www.w3.org/TR/WebCryptoAPI/#aes-gcm | W3C Web Crypto, 2026-08-21 |
| Argon2 **not** in Node 22 `node:crypto` | Node 22 crypto.html has no `argon2` heading; added https://nodejs.org/en/blog/release/v24.7.0 | Node **24.7.0** |
| Web Crypto Argon2 **not** in Node 22 | latest-v22.x `webcrypto.html` has no Argon2; added https://nodejs.org/en/blog/release/v24.8.0 | Node **24.8.0** |
| HTTP header names lower-cased; `authorization` | https://nodejs.org/docs/latest-v22.x/api/http.html#messageheaders | Node v22.23.2 |
| RFC 6750 `Authorization: Bearer` + `1*SP` | https://www.rfc-editor.org/rfc/rfc6750.html#section-2.1 | RFC 6750 |
| RFC 6750 401 MUST `WWW-Authenticate` Bearer | https://www.rfc-editor.org/rfc/rfc6750.html#section-3 | RFC 6750 |
| RFC 9110 auth-scheme case-insensitive; 401 MUST WWW-Authenticate | https://www.rfc-editor.org/rfc/rfc9110.html | RFC 9110 |
| Fastify encapsulation + scoped `@fastify/bearer-auth` | https://fastify.dev/docs/v5.4.x/Reference/Encapsulation/ | Fastify **v5.4.x** |
| Auth hook may `reply.send` from `onRequest`/`preHandler` | https://fastify.dev/docs/v5.4.x/Reference/Hooks/ | Fastify **v5.4.x** |
| Fastify default error JSON `statusCode`/`error`/`message` | https://fastify.dev/docs/latest/Reference/Errors/ | Fastify latest (fetched 2026-08-21); v5.4.x Errors page lacks this subsection |
| `@fastify/bearer-auth` Fastify 5 = `^10.x`; default `{error: err.message}` | https://www.npmjs.com/package/@fastify/bearer-auth | **10.1.3**, 2026-08-21 |
| `@fastify/auth` Fastify 5 = `>=5.x`; not a Bearer strategy | https://www.npmjs.com/package/@fastify/auth | **5.1.0**, 2026-08-21 |
| Fastify `inject` in-process tests | https://fastify.dev/docs/v5.7.x/Guides/Testing/ | Fastify testing guide |
| SQLite TEXT vs BLOB | https://www.sqlite.org/datatype3.html | 2026-08-21 |
| better-sqlite3 TEXT→string, BLOB→Buffer | https://github.com/WiseLibs/better-sqlite3/blob/HEAD/docs/api.md | HEAD, 2026-08-21 |
| `getCipherInfo('aes-256-gcm')` → keyLength 32, ivLength 12 | local `node -e` | **Node v24.14.0 only** — see BLOCK |

---

## 5. Compatible plugin versions IF a plugin is needed

Only if the orchestrator chooses a plugin:

```
@fastify/bearer-auth@^10.1.3   # Fastify ^5; 10.1.3 current on npm 2026-08-21
```

Optional combinator (only if one route must run several strategies):

```
@fastify/auth@^5.1.0           # Fastify ^5; 5.1.0 current on npm 2026-08-21
```

Then register bearer-auth with `{ addHook: false }` as in the bearer-auth README.

**A plugin is not required.** Hashed keys need a custom verifier either way. Scoped Fastify hook + `request.headers.authorization` is first-class in Fastify Hooks docs.

Already-present Fastify 5 auth stack stays: cookie `^11.1.2`, session `^11.1.2`, oauth2 `^8.3.0`.

---

## 6. Open decisions the orchestrator must record

1. **API-key hash algorithm** — Node 22 offers `sha256`/`sha512` (`createHash` / RC `crypto.hash`), `pbkdf2`, `scrypt`. Argon2 is **not** in Node 22. This lookup does not pick one.  
2. **Master-key env var / key-file path name** — DESIGN says env or file only; **this note does not name a variable**.  
3. **Ciphertext encoding** — TEXT (hex/base64 of a concat or JSON) vs BLOB (`Buffer`); concat order A–F in §1.7; Node split-tag vs Web Crypto `C|T`.  
4. **Plugin vs custom hook** — `@fastify/bearer-auth@^10` (scoped child plugin, likely with custom `auth()` for hashes) vs `onRequest`/`preHandler` that parse `Authorization` and `timingSafeEqual` hashes. Mixing with session: encapsulate agent routes; do not put default bearer hook on the root app.  
5. **401 JSON shape** — keep Kaola `{ error: 'unauthorized' }` vs Fastify default `{ statusCode, error: 'Unauthorized', message }` vs bearer-auth `{ error: err.message }`; whether to send RFC 6750 `WWW-Authenticate: Bearer …`.  
6. **`specCompliance` / case of `Bearer`** — if using the plugin: rfc6750 exact vs rfc6749 / RFC 9110 case-insensitive.  
7. **Whether the 32-byte AES key is raw in the file/env or derived** (pbkdf2/scrypt + salt). Cipher API wants raw key bytes.

---

## 7. BLOCK (could not verify)

- **BLOCK:** Context7 MCP was not available; no curated Context7 library IDs were resolved.  
- **BLOCK:** `crypto.getCipherInfo('aes-256-gcm')` was executed on **Node v24.14.0** (`keyLength: 32`, `ivLength: 12`). Not re-run on a Node 22 binary. Node 22 docs define those fields; NIST/Web Crypto independently specify 12-byte IVs.  
- **BLOCK:** Exact OpenSSL error `code` / `message` string for a failed GCM `final()` on Node 22 was not captured (docs only say it “will throw”).  
- **BLOCK:** Fastify **v5.4.x** Errors page fetched from fastify.dev did **not** include the “What The Default Error Handler Sends” subsection; that JSON shape is quoted from **latest** Errors docs. Treat 401 Fastify-default body as “HTTP status text `Unauthorized` + `statusCode` + `message`” per that latest page, not as a line in the v5.4.x Errors TOC.  
- **BLOCK:** GitHub `raw.githubusercontent.com/fastify/fastify-bearer-auth/main/README.md` returned 404; plugin facts are from **npm README** for `@fastify/bearer-auth@10.1.3`.  
- **BLOCK:** Whether `@fastify/bearer-auth`’s “constant time algorithm” is `crypto.timingSafeEqual` internally was not read from source.  
- **BLOCK:** FIPS 197 PDF was not fetched; 32-byte key length follows from AES-256 = 256-bit keys and from `getCipherInfo.keyLength` (v24 probe).  
- **BLOCK:** Exact `better-sqlite3@12.2.0` npm tarball was not unpacked; BLOB↔`Buffer` mapping is from current upstream `docs/api.md`.  
- **BLOCK:** No live Fastify 5.4.0 + bearer-auth 10.1.3 install was performed in this read-only lookup.

---

## 8. One-line approach (facts only, not a product pick)

GCM: `createCipheriv('aes-256-gcm', 32-byte-key, randomBytes(12), { authTagLength: 16 })` → `update`/`final` → `getAuthTag()`; decrypt with matching `createDecipheriv` + `setAuthTag`; persist iv+ct+tag in a recorded layout; failed tag → thrown `final()`. Bearer plugin is **optional**; Fastify documents a custom auth hook; hashed keys do not fit bearer-auth’s default `keys` Set without `auth()`.
