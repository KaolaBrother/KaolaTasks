# Local stdio MCP bridge + Ed25519 HTTP signing — research notes

Retrieval date: 2026-08-24. Context7 MCP was not available in this session; facts are from official docs, published package types, and GitHub tag `1.30.0` of `modelcontextprotocol/typescript-sdk`.

Worktree versions (`/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`):

- `@modelcontextprotocol/sdk`: **1.30.0** (exact, `apps/server/package.json`)
- `fastify`: **^5.4.0** (`apps/server/package.json`)
- Node: **`>=22`** (root `package.json` `engines.node`); `@types/node` `^22.17.0`

Do not copy v2 SDK import paths (`@modelcontextprotocol/client`, `@modelcontextprotocol/server/stdio`). Those belong to a later split package, not 1.30.0.

---

## 1. `@modelcontextprotocol/sdk` 1.30.0 — stdio server + Streamable HTTP client

### 1.1 Proxying is not a first-class helper

Confirmed from SDK 1.30.0 `docs/server.md`, `docs/client.md`, `package.json` exports, and `src/examples/server/` listing: there is **no** `StdioToHttpProxy`, `proxyTools`, or similar class. Server examples are Streamable HTTP / SSE only; stdio is documented as a **transport**, not a bridge.

To implement a local stdio process that forwards to remote Streamable HTTP, **compose**:

| Role | Class | Import (1.30.0) |
| --- | --- | --- |
| Local stdio MCP server | `McpServer` | `@modelcontextprotocol/sdk/server/mcp.js` |
| Local stdio framing | `StdioServerTransport` | `@modelcontextprotocol/sdk/server/stdio.js` |
| Remote HTTP MCP client | `Client` | `@modelcontextprotocol/sdk/client/index.js` |
| Remote Streamable HTTP | `StreamableHTTPClientTransport` | `@modelcontextprotocol/sdk/client/streamableHttp.js` |

Typical glue (not an SDK helper): `await client.connect(httpTransport)`, then either:

- register the same tools on `McpServer` and `callTool` / `listTools` on `Client`, or
- forward JSON-RPC at the `Transport.onmessage` / `Protocol` layer (not documented as a helper; you own the mapping).

`server.connect(transport)` starts the transport (`StdioServerTransport.start()` throws if already started; docs note `connect()` calls `start()` automatically). Same for `Client.connect`.

Sources:

- https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/docs/server.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/docs/client.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/package.json (`"version": "1.30.0"`, `exports["./*"]` → `./dist/esm/*`)

### 1.2 `StdioServerTransport`

Source: tag `1.30.0` `src/server/stdio.ts` and npm `dist/esm/server/stdio.d.ts`.

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

new StdioServerTransport(
  _stdin?: Readable,   // default process.stdin
  _stdout?: Writable,  // default process.stdout
  options?: { maxBufferSize?: number }  // default 10 MB; oversize → error + close
);
```

- Node-only. Reads JSON-RPC from stdin, writes newline-delimited JSON to stdout.
- **No URL, headers, auth, or fetch options.**
- Official server wiring (`docs/server.md`):

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
const transport = new StdioServerTransport();
await server.connect(transport);
```

MCP spec (stdio): newline-delimited JSON-RPC; **must not** write non-MCP bytes to stdout (logs go to stderr). Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (retrieved 2026-08-24). SDK `docs/server.md` points at this revision for Streamable HTTP as well.

### 1.3 `StreamableHTTPClientTransport`

Source: tag `1.30.0` `src/client/streamableHttp.ts` / npm `dist/esm/client/streamableHttp.d.ts`.

```ts
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

new StreamableHTTPClientTransport(url: URL, opts?: StreamableHTTPClientTransportOptions);
```

`StreamableHTTPClientTransportOptions`:

| Field | Meaning |
| --- | --- |
| `authProvider?: OAuthClientProvider` | OAuth; omitted → `UnauthorizedError` if server requires auth |
| `requestInit?: RequestInit` | Merged into every fetch; extra headers via `requestInit.headers` |
| `fetch?: FetchLike` | Custom fetch for **all** network requests (signing hook) |
| `reconnectionOptions?: StreamableHTTPReconnectionOptions` | SSE reconnect backoff (defaults: initial 1000 ms, max 30000, grow 1.5, maxRetries 2) |
| `sessionId?: string` | Optional existing session |

Official client example (`src/examples/client/simpleStreamableHttp.ts`):

```ts
transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
  sessionId: sessionId,
});
```

`docs/client.md` stdio **client** (host spawning a process, not our bridge) uses `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js` with `{ command, args, env, cwd }`. That is the inverse of this task.

Observed HTTP behavior in 1.30.0 client transport (source, not a public “sign requests” API):

- POST: `content-type: application/json`, `accept: application/json, text/event-stream`, `body: JSON.stringify(message)`.
- GET (optional SSE): `Accept: text/event-stream`. HTTP **405** on GET is treated as “no standalone SSE”, not an error.
- Session: response `mcp-session-id` stored; subsequent `_commonHeaders()` set `mcp-session-id`.
- After initialize: `mcp-protocol-version` header.
- Auth: if `authProvider` has tokens, `Authorization: Bearer <access_token>`.
- Response: `application/json` parsed as JSON-RPC; `text/event-stream` parsed as SSE; other types → `StreamableHTTPError` “Unexpected content type”.

Signing without Bearer: wrap `fetch` or set `requestInit.headers` to signature headers only. There is **no** SDK option named `url` besides the constructor `URL`.

### 1.4 Server-side Streamable HTTP (remote Kaola process)

Worktree already uses:

```ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
```

Constructor options used in `apps/server/src/mcp.ts`: `sessionIdGenerator`, `enableJsonResponse: true`, `onsessioninitialized`.

`handleRequest(req, res, parsedBody?)` — third argument is **pre-parsed body** so the adapter does not re-read a consumed Node stream. Official comment on the class (1.30.0 `src/server/streamableHttp.ts`):

```ts
app.post('/mcp', (req, res) => {
  transport.handleRequest(req, res, req.body);
});
```

Kaola hijacks Fastify (`reply.hijack()`) then `handleRequest(request.raw, reply.raw, request.body)`.

`enableJsonResponse: true` is the JSON-response mode documented in `docs/server.md` (`jsonResponseStreamableHttp.ts`) — POST responses as `application/json` instead of SSE. Clients must still send `Accept` listing both types (spec).

---

## 2. Cursor / Claude Code / Codex — command stdio config

There is **no cross-product schema named only `mcp.json`**. Stdio is always “spawn this command”; a remote **URL** is a **different** transport. To pass “only a URL, no Authorization” into a **stdio** bridge, put the URL in `args` or `env`. Hosts do not inject `url` into stdio processes.

### 2.1 Cursor

Official: https://cursor.com/docs/mcp (retrieved 2026-08-24).

Files: project `.cursor/mcp.json`, global `~/.cursor/mcp.json`. Top-level `mcpServers`.

stdio example in docs (no `type`):

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "mcp-server"],
      "env": { "API_KEY": "value" }
    }
  }
}
```

STDIO field table in the same page:

| Field | Required (table) | Notes |
| --- | --- | --- |
| `type` | Yes (`"stdio"`) | **Inconsistency:** CLI examples omit `type`; table lists it required. Unknown which wins if omitted. |
| `command` | Yes | Executable / PATH |
| `args` | No | string[] |
| `env` | No | object; interpolation `${env:NAME}` |
| `envFile` | No | stdio only |

Remote (not stdio): `url` + optional `headers` (e.g. `Authorization`). Interpolation also on `url` and `headers`.

Passing only a URL with **stdio**: official pattern is env/args, e.g. `"env": { "KAOLA_MCP_URL": "http://127.0.0.1:31415/api/mcp" }` with **no** `headers`. Cursor will not send HTTP `Authorization` for a stdio server.

### 2.2 Claude Code

Official: https://code.claude.com/docs/en/mcp-quickstart and https://code.claude.com/docs/en/mcp (retrieved 2026-08-24).

Files: project `.mcp.json`; user/local `~/.claude.json`. Top-level `mcpServers`.

Project example:

```json
{
  "mcpServers": {
    "claude-code-docs": {
      "type": "http",
      "url": "https://code.claude.com/docs/mcp"
    },
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

- HTTP: `type` + `url`. Optional `headers` (e.g. `Authorization: Bearer …`). Docs example for docs MCP: **URL only, no headers**.
- stdio: `type: "stdio"`, `command`, `args`, optional `env` (values must be strings). `add-json` example includes `env`.
- **An entry with `url` but no `type` is a configuration error** (treated as stdio, then fails). Alias: `streamable-http` ≡ `http`.
- Interpolation in `.mcp.json`: `${VAR}` / `${VAR:-default}` (not Cursor’s `${env:NAME}`).
- CLI: `claude mcp add --transport stdio <name> --env KEY=value -- <command> [args…]`. `--` required.

Passing only a URL to a **stdio** bridge: `env` or `args`; do not set `headers` (those apply to HTTP/SSE entries).

### 2.3 Codex

Official (not a root `mcp.json` for the CLI): https://developers.openai.com/codex/mcp and sample https://developers.openai.com/codex/config-sample (retrieved 2026-08-24).

Storage: `~/.codex/config.toml` or project `.codex/config.toml`. Tables `[mcp_servers.<name>]` (snake_case). Plugin `.mcp.json` is a separate, historically inconsistent wrapper (`mcpServers` vs `mcp_servers`); **do not treat plugin JSON as the CLI contract**.

STDIO:

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env_vars = ["LOCAL_TOKEN"]

[mcp_servers.context7.env]
MY_ENV_VAR = "MY_ENV_VALUE"
```

Keys: `command` (required), `args`, `env`, `env_vars`, `cwd`. CLI: `codex mcp add <name> --env VAR=VALUE -- <stdio command>`.

Streamable HTTP (Codex talks HTTP itself — not the stdio bridge):

- `url` (required)
- optional `bearer_token_env_var` → `Authorization: Bearer`
- optional `http_headers` / `env_http_headers`
- Docs: **if no credential source resolves, Codex can connect without authentication**

Passing only a URL into a **stdio** bridge: put it in `args` or `[mcp_servers.x.env]`; omit HTTP auth keys (`bearer_token_env_var`, `http_headers`).

---

## 3. Node.js 22 Ed25519

Docs used: https://nodejs.org/docs/latest-v22.x/api/crypto.html (v22.23.2 text, retrieved 2026-08-24). Module **Stability: 2 – Stable**.

### 3.1 Key generation — stable `node:crypto`

`crypto.generateKeyPairSync('ed25519')` — `type` includes `'ed25519'` since **v12.0.0**. If encoding options are omitted (since v11.6.0), both sides are `KeyObject`s.

Recommended encodings in the same page: public `'spki'`, private `'pkcs8'`.

```js
import { generateKeyPairSync, sign, verify } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// or PEM:
const pem = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
```

`keyObject.export()` on **Node 22** public keys: `format` **`'pem' | 'der' | 'jwk'`**, `type` `'spki'` (or `'pkcs1'` RSA only). Private: `'pem' | 'der' | 'jwk'`, `type` `'pkcs8'` (etc.). **No `'raw-public'` / `'raw-private'`** in this v22 document.

Raw 32-byte export: **not a documented KeyObject format on Node 22**. `format: 'raw-public'` appears in later Node (e.g. commit/PR around Node 24/25 `crypto: add raw key formats`). On v22, people sometimes slice 32 bytes from SPKI DER (SPKI for Ed25519 is typically 12-byte ASN.1 prefix + 32-byte key) — **that slice is not an official Node 22 API**; treat as folklore unless you parse SPKI yourself.

JWK on v22: `export({ format: 'jwk' })` is documented (added v15.9.0); Ed25519 JWK uses `x` / `d` as base64url of the 32-byte values (Web Crypto / RFC 8037), but confirm round-trip in-process rather than assuming Node’s JWK field names from memory.

### 3.2 Sign / verify — stable, algorithm **null**

From v22 `crypto.sign` / `crypto.verify` (added v12.0.0):

> If `algorithm` is `null` or `undefined`, then the algorithm is dependent upon the key type (especially Ed25519 and Ed448).

```js
const data = Buffer.from('…'); // exact bytes of the signed payload
const signature = sign(null, data, privateKey); // Buffer, Ed25519 sig is 64 bytes
const ok = verify(null, data, publicKey, signature);
```

Passing a digest name (e.g. `'sha256'`) with Ed25519 is **not** what the docs prescribe; OpenSSL typically rejects it (`ERR_OSSL_EVP_CTRL_NOT_SUPPORTED`). That failure mode is widely reported; the **authoritative** rule is still “use `null`/`undefined`”.

`createSign('SHA256')` stream API is **not** the Ed25519 path shown in Node’s Ed25519 guidance.

### 3.3 Web Crypto on Node 22 — experimental vs stable **depends on patch**

`node:crypto` Ed25519 KeyObject APIs above are stable.

`globalThis.crypto.subtle` Ed25519:

- Web Crypto module: Stability 2, but **Ed25519/X25519 were Stability 1 – Experimental** on early v22 (e.g. v22.6.0 docs).
- History: **v22.13.0** — “Algorithms `Ed25519` and `X25519` are now stable.”  
  Source: https://nodejs.org/dist/latest-v22.x/docs/api/webcrypto.html (retrieved 2026-08-24).

Worktree pins `engines.node >= 22` without a floor of 22.13. If you need Web Crypto Ed25519 as stable, require **>= 22.13.0** or stick to `node:crypto` `sign(null, …)`.

`keyObject.toCryptoKey` exists on v22.10.0+ (v22 crypto.html). Unknown whether all 22.x used in CI are ≥ 22.10.

### 3.4 There is **no** Node 22 API “sign this HTTP request”

Node signs **byte strings**, not HTTP messages.

IETF **HTTP Message Signatures** (RFC 9421) is the standards-track way to sign selected headers + content with Ed25519 (`ed25519` / RFC 8032). Node 22 **does not** implement RFC 9421. A “timestamped payload” is an application convention, for example:

- bytes = `timestamp || rawBody` (must specify encoding, delimiter, timezone), or
- RFC 9421 over `content-digest` + `created`, or
- sign UTF-8 of a canonical JSON object.

**Unknown / not specified by Node:** which headers to include, replay window, encoding of the 64-byte signature (base64 vs base64url vs hex), header names. Those are product choices, not `crypto.sign` options.

Practical pairing with MCP client: custom `fetch` that signs **the same bytes** that go on the wire (`JSON.stringify(message)` in SDK 1.30.0 `send()`), plus any timestamp header you add, **before** `fetch`. Do not re-serialize after `JSON.parse`.

---

## 4. Fastify ^5.4 — raw body, headers, Streamable HTTP content types

Official: https://fastify.dev/docs/v5.4.x/Reference/ContentTypeParser/ (v5.4.0, retrieved 2026-08-24).

### 4.1 Reading raw body

Default parsers: `'application/json'` and `'text/plain'` (charset utf-8). Parsed value is `request.body`. **GET/HEAD never parse a body.**

For signatures over **exact request bytes**, do **not** use the default JSON parser then `JSON.stringify` (byte-inequivalent). Scoped override:

```js
fastify.register((scope) => {
  scope.addContentTypeParser(
    'application/json',
    { parseAs: 'string' }, // or 'buffer'
    (_req, body, done) => { done(null, body); },
  );
  scope.post('/path', async (request, reply) => {
    // request.body is string | Buffer
    const sig = request.headers['x-signature']; // lowercase keys
  });
});
```

`parseAs`: `'string' | 'buffer'` (default `'buffer'` if you only pass the option object’s default). Fastify collects the stream and enforces `bodyLimit`.

Encapsulation: parser applies only in that plugin scope (same pattern as worktree `apps/server/src/webhook.ts`).

Headers: Fastify/Node expose `request.headers` with **lowercase** names. Multi-value headers may be `string | string[]`. Worktree `headersFromRaw` copies string/array values into `Headers`.

After verifying, JSON.parse the raw string and pass the object as `parsedBody` to `StreamableHTTPServerTransport.handleRequest` (SDK contract). If you leave `request.body` as a string, confirm the SDK accepts a string vs object — **unknown without reading `WebStandardStreamableHTTPServerTransport` parse path**; Kaola currently passes already-parsed JSON from the default parser.

### 4.2 Streamable HTTP content-type gotchas

Spec (2025-11-25, matches Kaola MCP tests’ `protocolVersion`): https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (retrieved 2026-08-24).

| Direction | Content-Type / Accept |
| --- | --- |
| Client POST body | JSON-RPC object; SDK sets `content-type: application/json` |
| Client POST Accept | **MUST** list both `application/json` and `text/event-stream` |
| Server POST response (request) | **either** `application/json` (one JSON object) **or** `text/event-stream` (SSE) |
| Client GET | Accept `text/event-stream`; server SSE or **405** |
| Notification POST | 202 empty body if accepted |

Implications for Fastify:

1. **Request** MCP POSTs are `application/json`. Signature verification applies to that body. Clients do not POST `text/event-stream` as the request entity.
2. **Response** SSE (`text/event-stream`) is written on `reply.raw` after `reply.hijack()`. Fastify’s JSON serializer must **not** wrap that stream. Kaola already hijacks for MCP.
3. `enableJsonResponse: true` (Kaola) prefers JSON responses; clients still advertise SSE Accept. A custom `fetch` must still accept both (SDK 1.30.0 does).
4. `Content-Type: application/json; charset=utf-8`: Fastify’s default JSON parser matches JSON; a custom parser registered only as exact `'application/json'` may **miss** types with parameters depending on match rules. Fastify docs warn about essence MIME vs parameters; they recommend regex for families like `application/*`. **Unconfirmed** whether `application/json; charset=utf-8` hits a parser registered as `'application/json'` in 5.4 — treat as a test item.
5. Empty GET: no body to sign; sign headers/timestamp only if your scheme includes GET/DELETE (session terminate).
6. If the default JSON parser runs first, `handleRequest(..., request.body)` works for MCP but **HMAC/Ed25519 over raw bytes is already lost**.

Worktree webhook already uses `{ parseAs: 'string' }` + `done(null, body)` for this reason.

---

## 5. Unknown / not confirmed

- No SDK 1.30.0 first-class stdio↔HTTP proxy; forwarding semantics (tool-only vs full JSON-RPC including prompts/resources/notifications) are product-defined.
- Whether Cursor requires `"type": "stdio"` despite examples omitting it.
- Exact SPKI DER prefix length for Ed25519 on every OpenSSL build (don’t hardcode `subarray(12)` without a test).
- RFC 9421 vs custom timestamp+body: Node does not pick one.
- Fastify 5.4 match of `application/json; charset=utf-8` against an exact `'application/json'` custom parser.
- Whether `StreamableHTTPServerTransport.handleRequest` third argument may be a raw string; official Express sample uses parsed `req.body`.
- Codex plugin `.mcp.json` key (`mcpServers` vs `mcp_servers`): disputed in openai/codex#22105; CLI uses TOML `mcp_servers`.

---

## Source list

| Topic | URL | Date |
| --- | --- | --- |
| SDK 1.30.0 tag | https://github.com/modelcontextprotocol/typescript-sdk/tree/1.30.0 | 2026-08-24 |
| SDK server.md / client.md | same tag `docs/` | 2026-08-24 |
| Stdio + Streamable HTTP types | jsDelivr `@modelcontextprotocol/sdk@1.30.0` `dist/esm/server/stdio.d.ts`, `client/streamableHttp.d.ts` | 2026-08-24 |
| MCP transports 2025-11-25 | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports | 2026-08-24 |
| Cursor MCP | https://cursor.com/docs/mcp | 2026-08-24 |
| Claude Code MCP | https://code.claude.com/docs/en/mcp , https://code.claude.com/docs/en/mcp-quickstart | 2026-08-24 |
| Codex MCP / config sample | https://developers.openai.com/codex/mcp , https://developers.openai.com/codex/config-sample | 2026-08-24 |
| Node 22 crypto | https://nodejs.org/docs/latest-v22.x/api/crypto.html | 2026-08-24 |
| Node 22 webcrypto Ed25519 stable in 22.13.0 | https://nodejs.org/dist/latest-v22.x/docs/api/webcrypto.html | 2026-08-24 |
| Fastify 5.4 ContentTypeParser | https://fastify.dev/docs/v5.4.x/Reference/ContentTypeParser/ | 2026-08-24 |
| Worktree | `apps/server/package.json`, `apps/server/src/mcp.ts`, `apps/server/src/webhook.ts` | local |
