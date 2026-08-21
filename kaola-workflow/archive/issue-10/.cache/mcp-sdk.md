# Official MCP TypeScript SDK — HTTP in-process Fastify facts

Retrieval date: **2026-08-21**. Fetched pages treated as untrusted; this file records facts only. Citations are URL + retrieval date.

This note answers how the official TypeScript SDK exposes an MCP server over HTTP so it can share a Node process with an existing Fastify API, authenticate with a Bearer API key, register tools (including description text), return structured results (including sensitive fields), and be driven in-process without Claude Code.

**Product DESIGN.md is not an SDK source.** DESIGN.md names `@modelcontextprotocol/sdk` and “same process as API server” / “personal API Key”. The live SDK has **two stable lines** as of this retrieval; facts for both are pinned below.

---

## 0. Package fork (must read before any install)

As of 2026-08-21 the GitHub `main` branch of `modelcontextprotocol/typescript-sdk` is **v2**, published as split packages, implementing protocol revision **2026-07-28**. The v1 monolithic package `@modelcontextprotocol/sdk` lives on the long-lived `v1.x` branch and continues to receive bug fixes and security updates for at least 6 months after v2’s release.

Sources:

- https://github.com/modelcontextprotocol/typescript-sdk (README, retrieved 2026-08-21)
- https://www.npmjs.com/package/@modelcontextprotocol/sdk (retrieved 2026-08-21)
- https://www.npmjs.com/package/@modelcontextprotocol/server (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/migration/ (retrieved 2026-08-21)

| Line | npm packages | Protocol docs the SDK points at | Docs site |
| --- | --- | --- | --- |
| **v1.x (monolith)** | `@modelcontextprotocol/sdk` **1.30.0** (published 2026-07-27) | Streamable HTTP as in spec **2025-11-25** (sessions, GET SSE, `initialize`) | https://ts.sdk.modelcontextprotocol.io/ (v1) |
| **v2 (split, “stable release line”)** | `@modelcontextprotocol/server` **2.0.0**, `@modelcontextprotocol/client` **2.0.0**, optional `@modelcontextprotocol/node` **2.0.0**, `@modelcontextprotocol/fastify` **2.0.0** (all published ~2026-07-28) | Spec **2026-07-28** (no protocol sessions, no `initialize`, POST-only MCP endpoint) with optional 2025-era fallback | https://ts.sdk.modelcontextprotocol.io/v2/ |

**Disagreement with DESIGN.md:** DESIGN.md names `@modelcontextprotocol/sdk`. The v2 README states that v2 **replaces** that monolith and is the stable line. Both are currently published; they are not drop-in identical.

**No Context7 MCP was used.** Facts below come from official spec pages, the SDK docs site, npm, and GitHub raw sources.

---

## 1. Current recommended HTTP transport (2026)

### Spec (protocol)

The protocol currently defines two **standard** transports: **stdio** and **Streamable HTTP**. HTTP+SSE from protocol `2024-11-05` is **deprecated**.

- Spec 2025-11-25: Streamable HTTP **replaces** HTTP+SSE. The server **MUST** provide a single MCP endpoint that supports **POST and GET**. Example URL given: `https://example.com/mcp`. POST carries JSON-RPC; the server may answer with `application/json` **or** `text/event-stream` (SSE scoped to that request). GET may open a standalone SSE stream; servers **MAY** return HTTP 405 if they do not offer it. Optional **session** via `MCP-Session-Id`.
  - https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (retrieved 2026-08-21)

- Spec 2026-07-28: Streamable HTTP remains the HTTP transport, but this revision **removed** the GET stream endpoint and **removed protocol-level sessions** (`Mcp-Session-Id`). The MCP endpoint **MUST** support **POST**. Example URL still `https://example.com/mcp`. Response is still JSON **or** request-scoped SSE. Changelog items 1, 2, 4, 9.
  - https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http (retrieved 2026-08-21)
  - https://modelcontextprotocol.io/specification/2026-07-28/changelog (retrieved 2026-08-21)

**`/mcp` is an example path, not a required path.** Both specs say “for example”. SDK Fastify/Express recipes use `/mcp`.

**SSE vs Streamable HTTP:** Streamable HTTP **uses SSE as a response mode** (`Content-Type: text/event-stream`) for a POST’s reply stream. That is not the deprecated two-endpoint HTTP+SSE transport (`/sse` + `/message` from 2024-11-05). New HTTP implementations target Streamable HTTP; HTTP+SSE is backwards-compat only.

### SDK v1 (`@modelcontextprotocol/sdk`)

v1 docs: Streamable HTTP is “the modern, fully featured transport” and is **recommended for remote servers**. HTTP+SSE is “deprecated, for backwards compatibility only”. stdio is for locally spawned processes.

v1 Streamable HTTP supports:

- request/response over HTTP POST
- server-to-client notifications over SSE (when enabled)
- optional JSON-only mode (`enableJsonResponse: true`) with no SSE
- session management and resumability

v1 docs explicitly cite spec `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`.

Sources:

- https://ts.sdk.modelcontextprotocol.io/server (retrieved 2026-08-21)
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/server.md (retrieved 2026-08-21)
- https://www.npmjs.com/package/@modelcontextprotocol/sdk README (retrieved 2026-08-21)

### SDK v2 (`@modelcontextprotocol/server`)

v2 recommended HTTP **entry** for the 2026-07-28 era is `createMcpHandler(factory)`, not hand-wiring `*StreamableHTTPServerTransport` per request. The v2 HTTP guide: “`createMcpHandler` replaces the per-request `StreamableHTTPServerTransport` + `connect()` wiring”.

v2 protocol-versions matrix:

| Era | Server HTTP entry |
| --- | --- |
| 2025 (`legacy`, revisions through `2025-11-25`) | `*StreamableHTTPServerTransport` |
| 2026 (`modern`, `2026-07-28`) | `createMcpHandler` (default `legacy: 'stateless'` also serves 2025-era traffic) |

Default `createMcpHandler` answers a request with a single JSON body and upgrades to SSE only when a tool emits a notification before its result. `{ responseMode: 'json' }` never streams (mid-call notifications dropped). `{ responseMode: 'sse' }` always streams.

Sources:

- https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/createMcpHandler.html (retrieved 2026-08-21)

### Package export paths (verified)

**v1** — `package.json` `exports["./*"]` maps to `dist/esm/*`. Documented/used paths:

| Symbol | Import |
| --- | --- |
| `McpServer` | `@modelcontextprotocol/sdk/server/mcp.js` |
| `StreamableHTTPServerTransport` | `@modelcontextprotocol/sdk/server/streamableHttp.js` |
| `StdioServerTransport` | `@modelcontextprotocol/sdk/server/stdio.js` |
| `createMcpExpressApp` | `@modelcontextprotocol/sdk/server/express.js` |
| `hostHeaderValidation` | `@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js` |
| `requireBearerAuth` | `@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js` (source path `src/server/auth/middleware/bearerAuth.ts`; `./*` export glob) |
| `InMemoryTransport` | `@modelcontextprotocol/sdk/inMemory.js` |
| `Client` | `@modelcontextprotocol/sdk/client/index.js` (also `@modelcontextprotocol/sdk/client`) |
| types | `@modelcontextprotocol/sdk/types.js` |

v1 `package.json` `exports` confirmed at https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/package.json (retrieved 2026-08-21). v1 docs use the `.js` specifier form.

**v2** — no `@modelcontextprotocol/sdk/server/mcp.js`. Documented imports:

| Symbol | Import |
| --- | --- |
| `McpServer`, `createMcpHandler`, `requireBearerAuth` (web-standard gate) | `@modelcontextprotocol/server` |
| `StdioServerTransport` / `serveStdio` | `@modelcontextprotocol/server/stdio` |
| `Client`, `StreamableHTTPClientTransport`, `InMemoryTransport` | `@modelcontextprotocol/client` |
| `toNodeHandler`, `NodeStreamableHTTPServerTransport` | `@modelcontextprotocol/node` |
| `createMcpFastifyApp`, `hostHeaderValidation` | `@modelcontextprotocol/fastify` |
| Express `requireBearerAuth` middleware | `@modelcontextprotocol/express` |
| Frozen v1 SSE + AS helpers | `@modelcontextprotocol/server-legacy` |

v2 migration map: v1 `InMemoryTransport` from `sdk/inMemory.js` → `@modelcontextprotocol/server` or `@modelcontextprotocol/client` (same-package halves of a linked pair; the two packages bundle separate copies).

Sources:

- https://github.com/modelcontextprotocol/typescript-sdk README (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2 (retrieved 2026-08-21)
- https://www.npmjs.com/package/@modelcontextprotocol/server (retrieved 2026-08-21)
- https://www.npmjs.com/package/@modelcontextprotocol/node (retrieved 2026-08-21)
- https://www.npmjs.com/package/@modelcontextprotocol/fastify (retrieved 2026-08-21)

---

## 2. Create a server and register tools

### Create

Both lines: `new McpServer({ name, version })`.

v1:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const server = new McpServer({ name: 'my-server', version: '1.0.0' });
```

v2:

```ts
import { McpServer } from '@modelcontextprotocol/server';
const server = new McpServer({ name: 'greeting-server', version: '1.0.0' });
```

Then `await server.connect(transport)` **or** (v2 HTTP) return the instance from a `createMcpHandler` factory (the handler connects per request).

Sources: v1 server docs; v2 GitHub README; https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html (retrieved 2026-08-21).

### `registerTool` vs `tool`

**Current API on both lines: `registerTool(name, config, handler)`.**

v1 `McpServer.tool(...)` still exists in `src/server/mcp.ts` on `v1.x` / tag `v1.29.0` and is **`@deprecated Use registerTool instead`**. v2 docs: “`registerTool` replaces `tool()` — run the codemod”. The v2 codemod rewrites `.tool()` → `registerTool`.

Config fields documented on both lines:

- `title?: string` — display name
- `description?: string` — advertised on `tools/list` (this is the field issue #10 would use for token-hygiene text on `claim_task`)
- `inputSchema` — argument schema
- `outputSchema` — optional; with `structuredContent` for machine-readable results
- `annotations?: ToolAnnotations` — hints only (`readOnlyHint`, `destructiveHint`, `idempotentHint`); “never change execution”
- `_meta?: Record<string, unknown>`

v1 `tools/list` handler copies `name`, `title`, `description`, derived JSON Schema, `annotations`, `_meta` onto each advertised tool (source: `v1.x` / `v1.29.0` `src/server/mcp.ts`).

**`description` is optional in the TypeScript config** (`description?: string`) but is the string `tools/list` returns as the tool’s description. A missing description means the list entry has no description text.

Sources:

- https://ts.sdk.modelcontextprotocol.io/server (v1 registerTool example, retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html (retrieved 2026-08-21)
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/server/mcp.ts (`tool` deprecated, `registerTool`, `tools/list` mapping, retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2 (codemod rewrites `.tool()` , retrieved 2026-08-21)

### `inputSchema` shape — v1 vs v2 (documented disagreement)

**v1 docs and v1 examples** pass a **Zod raw shape** (plain object of Zod fields), not `z.object(...)`:

```ts
inputSchema: { weightKg: z.number(), heightM: z.number() }
outputSchema: { bmi: z.number() }
```

v1 `simpleStatelessStreamableHttp.ts` uses the same shape form. v1 `mcp.ts` accepts `ZodRawShapeCompat | AnySchema` and normalizes.

**v2 docs** pass a **Zod object schema**:

```ts
inputSchema: z.object({ query: z.string().describe('…'), limit: z.number().int().max(50).optional() })
```

v2 tools page: “`inputSchema` is a Zod schema — the only schema you write.” From that one schema the SDK derives JSON Schema for `tools/list`, validates arguments before the handler, and infers handler argument types. `.describe()` on Zod fields survives into the advertised JSON Schema.

The v2 upgrade guide states the codemod **wraps raw Zod shapes with `z.object()`**.

**Do not copy a v1 shape into v2 `registerTool` without wrapping**, or a v2 `z.object()` into v1 without checking that line’s `normalizeObjectSchema` (v1 accepts both shape and schema, per `mcp.ts` comment “must be a Zod schema or raw shape”).

Sources:

- https://ts.sdk.modelcontextprotocol.io/server (v1, retrieved 2026-08-21)
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2 (retrieved 2026-08-21)

### Handler return: text + structured (including sensitive fields)

Documented return shape:

```ts
return {
  content: [{ type: 'text', text: JSON.stringify(output) }],
  structuredContent: output
};
```

`content` is what a model reads. `structuredContent` is the machine-readable payload, validated against `outputSchema` before it leaves the server (SDK skips that validation when `isError` is true).

**The SDK does not redact fields.** If a tool puts a forge token (or any secret) in `content` and/or `structuredContent`, it is returned to the MCP client. Token hygiene is application text in `description` plus application choice of what to put in the result — not an SDK filter.

Content block types documented: `text`, `image` (base64 + mimeType), `audio`, embedded `resource`, `resource_link`.

v2: “The wire encoding of structured results differs by protocol era” — see protocol-versions page; this file does not invent the encoding.

Sources:

- https://ts.sdk.modelcontextprotocol.io/server (v1 error handling + structured example, retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html (retrieved 2026-08-21)
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools (retrieved 2026-08-21)
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools (retrieved 2026-08-21)

### Zod peer

- v1: required peer `zod` `^3.25 || ^4.0`; README says the SDK imports `zod/v4` internally.
- v2: `@modelcontextprotocol/server` depends on `zod` `^4.2.0`. Docs import `* as z from 'zod/v4'`. Tool/prompt schemas use Standard Schema (Zod v4, Valibot, ArkType, or compatible).

---

## 3. Mounting on an existing Node HTTP / Fastify process

### Does the SDK provide a Node `(req, res)` handler?

**Yes.**

**v1:** `StreamableHTTPServerTransport.handleRequest(req, res, parsedBody?)` takes Node `IncomingMessage` (optional `auth?: AuthInfo`) and `ServerResponse`. If a framework already parsed JSON, pass that body as the third argument so the adapter does not re-read a consumed stream.

Source: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/server/streamableHttp.ts (retrieved 2026-08-21). JSDoc: “Using with pre-parsed request body: `app.post('/mcp', (req, res) => { transport.handleRequest(req, res, req.body); })`”.

**v2:** two Node faces:

1. **`toNodeHandler(handler)`** from `@modelcontextprotocol/node` adapts `createMcpHandler`’s web-standard `{ fetch }` to `(req, res, parsedBody?)`.
2. **`NodeStreamableHTTPServerTransport.handleRequest(req, res, parsedBody?)`** — Node wrapper around `WebStandardStreamableHTTPServerTransport`.

v2 HTTP guide: “Node frameworks wrap the handler once with `toNodeHandler` from `@modelcontextprotocol/node`”. Fastify recipe: pass `request.raw`, `reply.raw`, and `request.body`.

Sources:

- https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/serving/fastify.html (retrieved 2026-08-21)
- https://www.npmjs.com/package/@modelcontextprotocol/node (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/node/streamableHttp.html (retrieved 2026-08-21)

### Official Fastify adapter?

| SDK line | Official Fastify package? |
| --- | --- |
| **v1** | **No.** v1 ships Express helpers (`createMcpExpressApp` from `@modelcontextprotocol/sdk/server/express.js`). Fastify is not in v1 docs or v1 `package.json` exports. A Fastify app can still call `handleRequest(request.raw, reply.raw, request.body)` because that API is Node HTTP, not Express-specific. |
| **v2** | **Yes.** `@modelcontextprotocol/fastify` **2.0.0**. npm/README: “thin Fastify integration layer for `@modelcontextprotocol/server`. It does **not** implement MCP itself.” Peer: `fastify` `^5.2.0`, `@modelcontextprotocol/server` `^2.0.0`. |

v2 Fastify package exports (npm README):

- `createMcpFastifyApp(options?)` — `Fastify()` with DNS-rebinding Host/Origin validation applied (default bind `127.0.0.1`)
- `hostHeaderValidation(allowedHostnames)`
- `localhostHostValidation()`

**`createMcpFastifyApp` constructs a new Fastify instance.** It is not documented as a plugin that registers onto an already-built app. For an **existing** Fastify API process, the documented pieces that compose onto a pre-existing `app` are:

- `hostHeaderValidation([...])` via `app.addHook('onRequest', …)`
- a route such as `app.all('/mcp', …)` or `app.post('/mcp', …)` that calls `toNodeHandler(...)(request.raw, reply.raw, request.body)` or `transport.handleRequest(...)`

v2 Fastify serving page: “`app` is an ordinary Fastify instance with one route — `/mcp` answers every MCP request”. Same page shows mounting on `createMcpFastifyApp()` then `app.all('/mcp', …)`.

When binding to `0.0.0.0`, pass `allowedHosts` (and origins as needed); default localhost Host/Origin checks would otherwise 403 public Host headers.

Sources:

- https://ts.sdk.modelcontextprotocol.io/v2/serving/fastify.html (retrieved 2026-08-21)
- https://www.npmjs.com/package/@modelcontextprotocol/fastify (retrieved 2026-08-21)
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/middleware/fastify/README.md (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/fastify/ (retrieved 2026-08-21)

### Two official v2 Fastify mount patterns (docs disagree in emphasis)

**Pattern A — current v2 serving guide (recommended for 2026-07-28):** `createMcpHandler` + `toNodeHandler` + `app.all('/mcp', …)`. Factory runs **once per HTTP request**; a fresh `McpServer` serves every call.

**Pattern B — `@modelcontextprotocol/fastify` npm README:** `new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })` + `mcpServer.connect(transport)` + `transport.handleRequest(request.raw, reply.raw, request.body)` on `app.post('/mcp')`. Comments: stateless = transport per request; stateful = keep transport around. Tells you to add GET/DELETE 405 JSON-RPC if rejecting non-POST.

v2 protocol-versions table assigns Pattern B’s `*StreamableHTTPServerTransport` to the **2025 era** and Pattern A’s `createMcpHandler` to the **2026 era**. Both are published; they are not the same entry.

The npm README still documents `sessionIdGenerator` / stateful sessions. Spec **2026-07-28 removed protocol-level sessions**. Spec **2025-11-25** still has them. v1 and Pattern B align with 2025 sessions; `createMcpHandler` aligns with 2026-07-28 (and optional stateless 2025 fallback).

### Same Node process as an existing Fastify API

Nothing in the SDK requires a separate process. The transport/handler is an HTTP request listener. Mounting a route on the existing Fastify instance (or wrapping `request.raw`/`reply.raw`) is the in-process model the adapters exist for.

v1 stateless Express example (same idea, Express instead of Fastify): per POST, `getServer()`, `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, `server.connect(transport)`, `transport.handleRequest(req, res, req.body)`, close on `res.on('close')`. GET/DELETE `/mcp` return 405 JSON-RPC `{ code: -32000, message: 'Method not allowed.' }`.

Source: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts (retrieved 2026-08-21).

### DNS rebinding (spec + SDK)

Spec (both 2025-11-25 and 2026-07-28): servers **MUST** validate `Origin` when present; invalid Origin → HTTP **403**. Local servers **SHOULD** bind `127.0.0.1` not `0.0.0.0`.

v2: `createMcpHandler` **does not** validate Host/Origin/token. Checks belong **in front**. Framework factories (`createMcpExpressApp`, `createMcpHonoApp`, `createMcpFastifyApp`) arm Host/Origin by default on localhost binds. `toNodeHandler` is also validation-free.

### Typical path

SDK recipes and spec examples use **`/mcp`**. Not mandated by the spec.

---

## 4. Authentication (Bearer API key vs SDK OAuth gate)

### Spec

Authorization is **OPTIONAL**. When HTTP authorization is supported, implementations **SHOULD** conform to the MCP authorization spec, which is **OAuth 2.1 resource-server** behavior: Bearer access tokens, Protected Resource Metadata (RFC 9728), HTTP **401** / **403** / **400**, `WWW-Authenticate: Bearer`.

STDIO **SHOULD NOT** follow that spec; credentials come from the environment.

Sources:

- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization (retrieved 2026-08-21)
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization (retrieved 2026-08-21)

HTTP 401 = authorization required or token invalid; 403 = invalid scopes / insufficient permissions (with `WWW-Authenticate` `error="insufficient_scope"` for step-up). These are **HTTP-layer** statuses, not JSON-RPC errors.

Streamable HTTP also: servers **SHOULD** implement proper authentication for all connections (transport security section).

### SDK does **not** parse `Authorization` inside `createMcpHandler` / `McpServer`

v2 HTTP guide, createMcpHandler API, and Fastify page all state: **`authInfo` is pass-through**. The handler never reads headers and never verifies a token. Verify in front, then:

- web-standard: `handler.fetch(request, { authInfo })`
- Fastify + `toNodeHandler`: set `auth` on `request.raw`; `toNodeHandler` forwards it as `ctx.http.authInfo`
- v1 `handleRequest`: reads `req.auth` (`IncomingMessage & { auth?: AuthInfo }`)

Factory can destructure `authInfo` to register a different tool set per caller (v2). Tool handlers read `ctx.http.authInfo` (v2) or v1 extra/`req.auth`. `ctx.http` is undefined over stdio.

Sources:

- https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/serving/fastify.html (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/createMcpHandler.html (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization (retrieved 2026-08-21)
- v1 `streamableHttp.ts` `handleRequest` signature (retrieved 2026-08-21)

### Built-in Bearer helper: OAuth resource-server gate, not a personal-API-key store

**v1** `requireBearerAuth({ verifier, requiredScopes, resourceMetadataUrl })` is an **Express** `RequestHandler`. It:

1. Requires `Authorization: Bearer <token>`
2. Calls `verifier.verifyAccessToken(token)` → `AuthInfo`
3. Enforces `requiredScopes` (else `InsufficientScopeError` → **403**)
4. **Rejects tokens with missing/NaN `expiresAt` as invalid** (`InvalidTokenError` → **401** “Token has no expiration time”) and rejects expired tokens
5. Sets `req.auth = authInfo` and `next()`, or writes OAuth JSON + `WWW-Authenticate`

Source: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/server/auth/middleware/bearerAuth.ts (retrieved 2026-08-21).

**v2** same gate, two adapters:

- `@modelcontextprotocol/express` `requireBearerAuth` — Express middleware on `/mcp`
- `@modelcontextprotocol/server` `requireBearerAuth` — `(request) => Promise<AuthInfo | Response>` for fetch hosts

v2 docs: “Your MCP server is an OAuth resource server: it verifies access tokens that an authorization server issued, and it **never issues them**.” Missing/malformed/expired → **401** `invalid_token`. Missing `requiredScopes` → **403** `insufficient_scope`. **`expiresAt` unset also → 401 invalid_token.**

`AuthInfo` (v1 types): `{ token, clientId, scopes, expiresAt?, resource?, extra? }`.

v2 Authorization Server helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`, …) are **frozen** in `@modelcontextprotocol/server-legacy/auth`. New servers are told to use a dedicated IdP; the serving page covers the resource-server half only.

### Personal API keys (DESIGN.md) vs this gate

The SDK **does not** document a first-class “personal API key” authenticator. A Fastify `preHandler` / hook that checks `Authorization: Bearer <api-key>` and either:

- replies **401** (HTTP, before JSON-RPC), or
- sets `request.raw.auth` / passes `{ authInfo }` into `fetch`

…is the wrapping model the SDK describes (“Verify the bearer token in front of the handler”). That wrapper is application code. Using SDK `requireBearerAuth` for long-lived API keys **collides with the documented `expiresAt` requirement** unless the verifier always supplies a numeric `expiresAt`.

Per-tool permission after a valid token: v2 docs check `ctx.http?.authInfo?.scopes` **inside the tool handler** and return `{ isError: true, content: [...] }` — **not** HTTP 403 — so the model sees the refusal. HTTP 403 `insufficient_scope` instead triggers client transport scope step-up (SEP-2350).

### Sessions / initialize vs per-request auth

**2025-era (v1 Streamable HTTP, v2 legacy fallback):** protocol session may exist (`MCP-Session-Id`). Initialization is the first interaction (`initialize` then `notifications/initialized`). Auth is still **per HTTP request** (Bearer on each POST/GET). v1 stateful transport tracks session IDs in memory; missing session on non-init → 400; unknown session → 404 (`streamableHttp.ts` comments).

**2026-era (`createMcpHandler` modern path):** **no protocol sessions, no `initialize`.** Every request carries version/capabilities in `_meta` (and `MCP-Protocol-Version` on HTTP). Auth is per request. `tools/list` **MUST NOT** vary per-connection but **MAY** vary by the authorization presented on that request (spec 2026-07-28 tools page).

v2 protocol-versions: HTTP **401/403 during `server/discover` probe** are typed auth failures (`SdkHttpError` `ClientHttpAuthentication` / `ClientHttpForbidden`), **not** era fallback. “Auth settles first, era second.”

Sources:

- https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle (retrieved 2026-08-21)
- https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle (retrieved 2026-08-21)
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html (retrieved 2026-08-21)

---

## 5. Driving tools in tests without Claude Code

Official testing does **not** involve Claude Code, MCP Inspector, or a live model. The v2 page title is “Test a server”: drive a real `Client` in-process — “no port, no socket, no mock transport.”

Source: https://ts.sdk.modelcontextprotocol.io/v2/testing.html (retrieved 2026-08-21).

### Method 1 — `handler.fetch` as custom `fetch` (v2; covers 2026-07-28)

```ts
const handler = createMcpHandler(createServer);
const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
  fetch: (url, init) => handler.fetch(new Request(url, init))
});
const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(transport);
const result = await client.callTool({ name: '…', arguments: { … } });
```

The URL is never dialed. This is “the same `createMcpHandler` you deploy.” Pass `{ authInfo }` into `handler.fetch` when testing the authenticated factory path (HTTP guide).

Tear down: `await client.close(); await handler.close();`

### Method 2 — `InMemoryTransport.createLinkedPair()` (both lines; v2: **2025-era only**)

v1: `import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'`

v2: `import { InMemoryTransport } from '@modelcontextprotocol/client'` (or `/server` — **same package for both halves**)

```ts
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await memServer.connect(serverTransport);
await memClient.connect(clientTransport);
```

v2 testing page: “`createLinkedPair` connects **2025-era instances only**; `handler.fetch` is the in-process entry for **2026-07-28** coverage.”

`send(message, { authInfo })` exists specifically “for testing authentication scenarios” (v1 `inMemory.ts`; v2 InMemoryTransport API docs).

Sources:

- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/inMemory.ts (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/classes/_modelcontextprotocol_client.index.InMemoryTransport.html (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/testing.html (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2 (linked-pair same-package rule, retrieved 2026-08-21)

### Method 3 — HTTP inject / listen

**Not documented** by the SDK as the preferred test harness. Fastify `app.inject()` is a Fastify feature, not an MCP SDK API. It would exercise the **route wrapper** (preHandler, `toNodeHandler`, parsed body) if you mount MCP on Fastify; official SDK tests of protocol behavior use Client + `handler.fetch` or InMemoryTransport.

v1 examples use a real listen port for demos, not as the documented unit-test approach.

### Node test runner compatibility

v2 testing page: “This page uses `node:assert/strict`; swap in your runner’s `expect` — **nothing else changes**.” No Vitest/Jest/node:test lock-in in the harness. The SDK’s **own** package tests use **Vitest** (`"test": "vitest run"` in v1 `package.json` and v2 `packages/server/package.json`). `node:test` can call the same `Client` + `createMcpHandler` / `InMemoryTransport` APIs.

`callTool` happy path: assert `structuredContent`. Handler/business failure: **resolves** as `{ isError: true }`, does not throw. Schema-rejected arguments: same `isError: true` result; handler never runs (v2 tools page).

---

## 6. Protocol version and npm versions (Node 22)

### npm latest as of retrieval 2026-08-21

| Package | Latest stable | Published | `engines.node` |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | **1.30.0** | 2026-07-27 | `>=18` (`v1.x` package.json) |
| `@modelcontextprotocol/server` | **2.0.0** | 2026-07-27/28 | `>=20` (packages/server/package.json) |
| `@modelcontextprotocol/client` | **2.0.0** | 2026-07-27/28 | (same release line; v2 migration: “Node.js 20+”) |
| `@modelcontextprotocol/node` | **2.0.0** | 2026-07-27/28 | peer `@modelcontextprotocol/server` `^2.0.0` |
| `@modelcontextprotocol/fastify` | **2.0.0** | 2026-07-27/28 | peer `fastify` `^5.2.0` |

Sources: respective npm pages and GitHub raw package.json (retrieved 2026-08-21); https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2 “Prerequisites. Node.js 20+”.

**Node 22** satisfies v1 `>=18` and v2 `>=20`. v1 FAQ: `globalThis.crypto` is available by default on Node ≥19 (OAuth/jose). Node 22 needs no Web Crypto polyfill.

Source: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/faq.md (retrieved 2026-08-21).

### Which protocol revision “matches current docs”

- Installing **`@modelcontextprotocol/sdk@1.30.0`** matches **v1 docs** (https://ts.sdk.modelcontextprotocol.io/) and Streamable HTTP **2025-11-25** (sessions, `initialize`, GET optional).
- Installing **`@modelcontextprotocol/server@2.0.0` + `@modelcontextprotocol/client@2.0.0` + `@modelcontextprotocol/node@2.0.0`**, and `@modelcontextprotocol/fastify@2.0.0` if using the Fastify helpers, matches **v2 docs** (`/v2/`) and spec **2026-07-28**, with default dual-era HTTP (`legacy: 'stateless'`).

v2 `createMcpHandler` default `legacy: 'stateless'` serves 2025-era clients from the same factory (GET/DELETE → 405). `legacy: 'reject'` is modern-only.

Client `versionNegotiation`: default / `mode: 'legacy'` = 2025 `initialize`; `mode: 'auto'` probes `server/discover` then falls back; `mode: { pin: '2026-07-28' }` never falls back.

There is **no** `@modelcontextprotocol/sdk@2.x` on npm as of this retrieval; v2 is split packages.

---

## 7. Error model: HTTP 401 vs JSON-RPC vs tool `isError`

Three layers, documented separately.

### A. HTTP transport / auth (before or instead of JSON-RPC)

| Situation | Status | Body |
| --- | --- | --- |
| Missing/invalid/expired Bearer (`requireBearerAuth`) | **401** | OAuth error JSON `invalid_token` + `WWW-Authenticate: Bearer` |
| Token missing `requiredScopes` (`requireBearerAuth`) | **403** | `insufficient_scope` + `WWW-Authenticate` |
| Invalid Origin / Host (DNS rebind guards) | **403** | spec allows JSON-RPC error with no `id` |
| Spec: malformed authorization request | **400** | — |
| v1 stateless GET/DELETE `/mcp` example | **405** | JSON-RPC `{ code: -32000, message: 'Method not allowed.' }` |
| v2 `createMcpHandler` legacy GET/DELETE | **405** / “Method not allowed.” | createMcpHandler API |
| POST Content-Type not `application/json` | **415** | createMcpHandler building-block docs |
| Invalid `MCP-Protocol-Version` (2025 spec) | **400** | — |
| v1 stateful: no session on non-init | **400** | — |
| v1 stateful: unknown session | **404** | — |
| Uncaught error in v1 Express example | **500** | JSON-RPC `{ code: -32603, message: 'Internal server error' }` |

A Fastify preHandler that rejects a bad API key with **401** never reaches `McpServer`; there is no JSON-RPC envelope unless the wrapper writes one.

### B. JSON-RPC protocol errors (JSON-RPC `error` object, HTTP typically still 200 for Streamable HTTP JSON)

Spec tools pages (2025-11-25 and 2026-07-28):

- **Protocol errors:** unknown tool, malformed `tools/call` request, server errors → JSON-RPC error, example code **-32602** `Unknown tool: …`
- **Tool execution errors:** API failures, input validation, business logic → JSON-RPC **result** with `isError: true`

v2 Errors page: a tool error is a **successful JSON-RPC result** with `isError: true` that the model reads. A protocol error is a JSON-RPC error response **the model never sees**.

v2: thrown exceptions **inside a `registerTool` handler** (including a thrown `ProtocolError`) become **`isError: true`**, not a JSON-RPC error. Only `UrlElicitationRequiredError` escapes a tool handler as JSON-RPC error.

v2: resource/prompt/completion callbacks have no `isError` channel; throw `ProtocolError`. Non-`ProtocolError` there → **-32603** Internal Error.

v2 `ProtocolErrorCode` table (SDK): `-32700` Parse, `-32600` InvalidRequest, `-32601` MethodNotFound, `-32602` InvalidParams (also resources/read miss), `-32603` InternalError, `-32021` MissingRequiredClientCapability, `-32022` UnsupportedProtocolVersion, `-32042` UrlElicitationRequired. `-32002` ResourceNotFound is receive-tolerated only; SDK emits `-32602` for a read miss. Spec 2026-07-28 changelog: resource-not-found code changed **-32002 → -32602**.

v2 protocol-versions: on modern HTTP, `400` with a JSON-RPC error body is delivered as in-band `ProtocolError`; on 2025 era that shape is `SdkHttpError`.

### C. What this means for “auth failure vs business error”

| Intent | Documented channel |
| --- | --- |
| Caller has no/invalid API key or OAuth token | **HTTP 401** from the wrapper / `requireBearerAuth` — not `tools/call` |
| Token valid but missing an OAuth scope at the **endpoint** gate | **HTTP 403** `insufficient_scope` |
| Token valid but this **tool** is not allowed | v2 recipe: **`isError: true`** in the tool result (model-visible). HTTP 403 would trigger OAuth step-up |
| Unknown tool name | JSON-RPC **-32602** (spec example) |
| Bad tool arguments (schema) | v2 `registerTool`: **`isError: true`** result, handler not run (tools page). Spec also lists input validation under tool execution errors (`isError`) |
| Business failure (e.g. task not claimable) | **`isError: true`** + text in `content` |
| Sensitive success payload (e.g. revealed forge token) | JSON-RPC **result** with `content` / `structuredContent` — still HTTP 200 at the MCP layer |

v1 server docs “Error handling” section: set `isError: true` in the tool result; `content` describes what went wrong.

Sources:

- https://modelcontextprotocol.io/specification/2025-11-25/server/tools (retrieved 2026-08-21)
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/servers/errors.html (retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/server (v1 Error handling, retrieved 2026-08-21)
- https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization (retrieved 2026-08-21)

---

## 8. Does listing tools require initialize + auth?

### Initialize / handshake

**2025-11-25 lifecycle:** “The initialization phase **MUST** be the first interaction.” Client **SHOULD NOT** send requests other than pings before `initialize` completes; server **SHOULD NOT** send requests other than pings/logging before `initialized`. `Client.connect()` on v1 / v2 default (`mode: 'legacy'`) runs that handshake.

**2026-07-28 lifecycle:** “There is **no negotiation handshake**.” Every request carries protocol version. Servers **MUST** implement `server/discover`. Clients **MAY** call it first; they may also invoke any RPC and handle `UnsupportedProtocolVersionError` (-32022).

**Empirical from v2 Fastify docs:** they POST `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` **without** a prior `initialize` to `createMcpHandler` and show an SSE `message` event containing the `tools/list` result. That is **2026-era** serving.

v2 `createMcpHandler` with default `legacy: 'stateless'` also answers 2025-era traffic **per request** (including `initialize` as a one-shot legacy request, not a durable session).

### Auth

If a Bearer gate wraps `/mcp`, **every** HTTP request to that path — `initialize`, `server/discover`, `tools/list`, `tools/call` — needs a valid Bearer. Failure is **401/403 at HTTP**, so listing never happens.

If the route is unauthenticated, `tools/list` does not require a token (authorization is optional in the spec).

If authenticated, 2026 tools spec: the listed set **MAY** vary by the authorization on **that** request (e.g. only tools the caller’s scopes permit). It **MUST NOT** vary per-connection or as a side effect of other requests.

v2 factory receiving `authInfo` can register a different tool set per caller **before** handlers run.

### v2 Client default vs `mode: 'auto'`

Default `Client` connect is **legacy `initialize`**, no `server/discover` probe. Against a modern-only endpoint (`legacy: 'reject'`), a default client fails (compatibility matrix: Legacy client × Modern server). Tests that intend 2026-07-28 use `versionNegotiation: { mode: 'auto' }` as on the testing page.

---

## 9. Spec vs SDK disagreements (explicit)

1. **DESIGN.md vs live SDK packaging:** DESIGN.md names `@modelcontextprotocol/sdk`. GitHub `main` + v2 npm READMEs say v2 split packages are the stable line and replace that monolith. v1.30.0 is still published and documented.

2. **2025-11-25 vs 2026-07-28 Streamable HTTP:** 2025 requires GET+POST and optional sessions; 2026 POST-only, no protocol sessions, no GET stream, no SSE resumability. v1 SDK implements the 2025 shape. v2 `createMcpHandler` implements 2026 and optionally a **stateless** 2025 fallback (GET/DELETE 405, `sessionIdGenerator: undefined`).

3. **v2 serving/fastify.html vs `@modelcontextprotocol/fastify` npm README:** guide uses `createMcpHandler` + `toNodeHandler` + `app.all('/mcp')`; npm README uses `NodeStreamableHTTPServerTransport` + `app.post('/mcp')` + `handleRequest`. Protocol-versions.html assigns those to different eras.

4. **`inputSchema` form:** v1 docs/examples use Zod **shapes**; v2 docs use `z.object(...)`. Codemod wraps shapes when upgrading.

5. **`tool()` vs `registerTool`:** older README snapshots and blogs show `server.tool(...)`. Current v1 source deprecates `tool`; current v1/v2 docs use `registerTool`.

6. **Authorization spec vs personal API keys:** MCP HTTP authorization spec is OAuth 2.1 + RFC 6750 Bearer + PRM. SDK `requireBearerAuth` matches that and **requires `expiresAt`**. A static personal API key is not specified as a protocol auth mechanism; it is an HTTP wrapper in front of the MCP handler.

7. **v2 Fastify curl `tools/list` without initialize** vs **2025 lifecycle MUST initialize first:** the curl is against `createMcpHandler` (2026 era). A v1 stateful server or a v2 client in default legacy mode still expects `initialize`.

8. **Resource not found code:** spec 2026-07-28 changed `-32002` → `-32602`. SDK documents it emits `-32602` and only receive-tolerates `-32002`.

---

## 10. Minimal fact map for “same-process Fastify + Bearer API key + tools + in-process tests”

These are facts, not an implementation patch:

- HTTP transport to use for a new remote MCP server in 2026: **Streamable HTTP** (not deprecated HTTP+SSE). SSE may still appear as the POST response `Content-Type`.
- In-process with existing Fastify: Node adapter **`handleRequest(req, res, parsedBody)`** (v1 `StreamableHTTPServerTransport` or v2 `NodeStreamableHTTPServerTransport`) **or** v2 **`toNodeHandler(createMcpHandler(...))`** with `request.raw` / `reply.raw` / `request.body`. Official Fastify package exists **only on v2**. Route example **`/mcp`**.
- Tools: **`registerTool(name, { description, inputSchema, outputSchema?, title?, annotations? }, handler)`**. `description` is what `tools/list` advertises (token-hygiene text goes here). Structured secrets go in `structuredContent` / `content` if the handler returns them; the SDK will not strip them.
- Auth: SDK Bearer helper is an **OAuth resource-server gate** in **front** of MCP. `createMcpHandler` does not read `Authorization`. A personal API key is a Fastify preHandler that 401s or sets `request.raw.auth` / `fetch(..., { authInfo })`. `requireBearerAuth` additionally requires `expiresAt`.
- Tests: official in-process path is **`Client` + `StreamableHTTPClientTransport` with custom `fetch: handler.fetch`** (v2, 2026 coverage) or **`InMemoryTransport.createLinkedPair()`** (v1; v2 2025-era only). Compatible with `node:test` via `node:assert/strict`. Claude Code is not part of the SDK test story.
- Install for Node 22: **v1.30.0** of `@modelcontextprotocol/sdk` **or** **2.0.0** of `@modelcontextprotocol/server` + `@modelcontextprotocol/client` (+ `@modelcontextprotocol/node` / `@modelcontextprotocol/fastify`). They speak different protocol eras unless v2 dual-era fallback is left on.

---

## Source index (all retrieved 2026-08-21)

### Spec

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/specification/2026-07-28/changelog

### SDK docs

- https://ts.sdk.modelcontextprotocol.io/server (v1)
- https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html
- https://ts.sdk.modelcontextprotocol.io/v2/serving/fastify.html
- https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization
- https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html
- https://ts.sdk.modelcontextprotocol.io/v2/servers/errors.html
- https://ts.sdk.modelcontextprotocol.io/v2/testing.html
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html
- https://ts.sdk.modelcontextprotocol.io/v2/clients/connect.html
- https://ts.sdk.modelcontextprotocol.io/v2/migration/
- https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/createMcpHandler.html
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/fastify/
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/node/
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/node/streamableHttp.html
- https://ts.sdk.modelcontextprotocol.io/v2/classes/_modelcontextprotocol_client.index.InMemoryTransport.html

### GitHub / npm

- https://github.com/modelcontextprotocol/typescript-sdk
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/package.json
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/server.md
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/faq.md
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/server/streamableHttp.ts
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/server/auth/middleware/bearerAuth.ts
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/server/auth/types.ts
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/inMemory.ts
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/server/mcp.ts
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/package.json
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/middleware/fastify/README.md
- https://www.npmjs.com/package/@modelcontextprotocol/sdk
- https://www.npmjs.com/package/@modelcontextprotocol/server
- https://www.npmjs.com/package/@modelcontextprotocol/client
- https://www.npmjs.com/package/@modelcontextprotocol/node
- https://www.npmjs.com/package/@modelcontextprotocol/fastify
