# TDD report — issue #23 (stdio MCP bridge)

Role: tdd-guide. Tests only. No production implementation (`apps/mcp/src/main.ts` was not created).

## Baseline

- Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`
- HEAD: `6c9f01cf7e61630bec48fd4f0f3525a4fb5f5137`
- `apps/mcp` production: absent (no `package.json`, no `bin`, no `src/main.ts`)

## Files added or changed

| Path | Change |
|------|--------|
| `apps/mcp/src/main.test.ts` | **New** oracles: `@kaola/mcp` package/bin, committed `examples/mcp.json`, `KAOLA_HOME` device.json, URL order, signed POST `/api/mcp`, HTTP 202 → JSON-RPC error, claim `token` not persisted |
| `package.json` | Root `test` script appends `apps/mcp/src/main.test.ts` |

No `apps/web` edits. Issue #22 not reopened.

## Seams the implementer must export from `apps/mcp/src/main.ts`

These names are the oracle; do not leave them as an empty file.

- `resolveKaolaUrl(argv, env) → string` — first `--url` (next argv token), else non-empty `KAOLA_URL`, else `http://localhost:31415`; strip trailing `/`
- `ensureDeviceIdentity(kaolaHome)` — mkdir `0700`, write `device.json` `0600` if missing: `{ v: 1, privateKeyPkcs8, publicKeySpki, createdAt }` (base64 PKCS8 + SPKI DER); reuse if present; never write a forge `token`
- `forwardMcpRequest({ kaolaHome, url, body, stdout?, stderr? })` — POST `{url}/api/mcp` (origin trailing slash stripped) with `X-Kaola-Key|Ts|Nonce|Sig` over `deviceProofCanonical` from `@kaola/shared`; HTTP `202` `{ error: 'authorization_required', pending: true, expires_at }` → JSON-RPC **error** (`jsonrpc: '2.0'`, same `id`, `message` contains `authorization_required` and the ISO `expires_at`, no `result.token`); HTTP 200 JSON-RPC success is passed through (may include `result.token`) without writing that token under `KAOLA_HOME`; do not log PKCS8 or forge token on console/stderr/stdout

Also required (not `main.ts`):

- `apps/mcp/package.json`: `name` `@kaola/mcp`, `private`, `"type": "module"`, `engines.node` `>=22`, `bin.kaola-mcp` path that exists, deps `@modelcontextprotocol/sdk` `1.30.0` and `@kaola/shared` `workspace:*`
- `apps/mcp/examples/mcp.json` exactly:

```json
{
  "mcpServers": {
    "kaola-tasks": {
      "command": "kaola-mcp",
      "args": ["--url", "http://localhost:31415"]
    }
  }
}
```

No `headers`, no `ktk_`, no `KAOLA_AGENT_KEY`, no forge PAT.

SDK glue (research, not a class to import): compose `StdioServerTransport` + `StreamableHTTPClientTransport` custom `fetch`; no proxy helper in `1.30.0`. Tests call `forwardMcpRequest` so the signer can be proven without spawning Cursor.

## Red run

Command (worktree root):

```text
node --experimental-strip-types --test apps/mcp/src/main.test.ts
```

Result: **7 tests, 0 pass, 7 fail**. Duration ~62 ms. Tests **loaded** (no syntax error). Shared `deviceProofCanonical` import resolved.

```
RED: package.json is @kaola/mcp ESM, Node >=22, bin kaola-mcp — AssertionError: apps/mcp/package.json must exist for @kaola/mcp
RED: committed mcp.json example is command plus url and contains no secrets — AssertionError: apps/mcp/examples/mcp.json must be committed
RED: --url wins, then KAOLA_URL, then localhost:31415; trailing slash is stripped — AssertionError: apps/mcp/src/main.ts must export the stdio bridge (got ERR_MODULE_NOT_FOUND)
RED: creates ~/.kaola-shaped dir 0700 and device.json 0600 Ed25519 PKCS8+SPKI when missing — AssertionError: apps/mcp/src/main.ts must export the stdio bridge (got ERR_MODULE_NOT_FOUND)
RED: POSTs to {url}/api/mcp with canonical device proof headers — AssertionError: apps/mcp/src/main.ts must export the stdio bridge (got ERR_MODULE_NOT_FOUND)
RED: HTTP 202 authorization_required becomes a JSON-RPC error, never a successful token result — AssertionError: apps/mcp/src/main.ts must export the stdio bridge (got ERR_MODULE_NOT_FOUND)
RED: successful claim JSON-RPC may contain token but KAOLA_HOME never stores it — AssertionError: apps/mcp/src/main.ts must export the stdio bridge (got ERR_MODULE_NOT_FOUND)
baseline: 6c9f01cf7e61630bec48fd4f0f3525a4fb5f5137
```

## Notes for implementer

- Sign the **raw POST body bytes** (same bytes on the wire). Verify in tests uses `@kaola/shared` `deviceProofCanonical` + `crypto.verify(null, …)` against `device.json` SPKI. Header names are case-insensitive on Node; values: `X-Kaola-Key` = standard-base64 SPKI, `X-Kaola-Ts` decimal unix seconds no leading zeros, `X-Kaola-Nonce` 32 hex, `X-Kaola-Sig` standard-base64 64-byte Ed25519. No `Authorization`.
- Pathname in the canonical string is `/api/mcp` (no host, no query).
- Mode asserts are `stat.mode & 0o777` (`0700` / `0600`); this repo smokes on darwin/linux.
- `forwardMcpRequest` is a testable seam; the CLI (`kaola-mcp` → `node --experimental-strip-types` on `main.ts`) should call the same code. Do not persist claim `token` into `device.json` / `config.json` / any file under `KAOLA_HOME`.
- Do not import `apps/server` or boot Fastify; the suite uses `node:http`.
