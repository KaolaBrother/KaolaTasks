# Implementer report — issue #23 stdio MCP bridge

## task

Implement `apps/mcp` (`@kaola/mcp`) stdio bridge: package/bin, `examples/mcp.json`, `resolveKaolaUrl`, `ensureDeviceIdentity`, `forwardMcpRequest` signing POST `{url}/api/mcp` with `@kaola/shared` `deviceProofCanonical`. HTTP 202 `authorization_required` → JSON-RPC error (no fake token). Never persist forge token under KAOLA_HOME. Logs to stderr only.

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`

## verification tier

`tests-green`

## files changed

| Path | Change |
|------|--------|
| `apps/mcp/package.json` | New: `@kaola/mcp`, private, ESM, `engines.node` `>=22`, bin `kaola-mcp`, deps SDK `1.30.0` + `@kaola/shared` `workspace:*` |
| `apps/mcp/bin/kaola-mcp.mjs` | New: shebang spawn `node --experimental-strip-types src/main.ts`, stdio inherit |
| `apps/mcp/src/main.ts` | New: exported seams + thin signed POST forwarder + NDJSON stdio loop |
| `apps/mcp/examples/mcp.json` | New: `command` + `--url` only, no secrets |
| `apps/mcp/tsconfig.json` | New: typecheck config |
| `pnpm-lock.yaml` | Workspace member `apps/mcp` linked by `pnpm install` |

Did **not** edit tests, `App.vue`, or server claim envelope.

## verification commands

```text
# before
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23
node --experimental-strip-types --test apps/mcp/src/main.test.ts
# exit 1

# after
node --experimental-strip-types --test apps/mcp/src/main.test.ts
# exit 0
```

## before

`apps/mcp` production absent. **7 tests, 0 pass, 7 fail.** Duration ~40 ms.

RED: missing `package.json` / `examples/mcp.json` / `src/main.ts` (`ERR_MODULE_NOT_FOUND`).

## after

**7 tests, 7 pass, 0 fail.** Duration ~121 ms. Exit code **0**.

```
▶ @kaola/mcp package
  ✔ package.json is @kaola/mcp ESM, Node >=22, bin kaola-mcp
  ✔ committed mcp.json example is command plus url and contains no secrets
▶ resolveKaolaUrl
  ✔ --url wins, then KAOLA_URL, then localhost:31415; trailing slash is stripped
▶ ensureDeviceIdentity
  ✔ creates ~/.kaola-shaped dir 0700 and device.json 0600 Ed25519 PKCS8+SPKI when missing
▶ forwardMcpRequest
  ✔ POSTs to {url}/api/mcp with canonical device proof headers
  ✔ HTTP 202 authorization_required becomes a JSON-RPC error, never a successful token result
  ✔ successful claim JSON-RPC may contain token but KAOLA_HOME never stores it
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

Pass count: **7**.

## notes

- URL order matches tests: `--url`, then non-empty `KAOLA_URL`, else `http://localhost:31415`; trailing slashes stripped. `config.json.url` is not used by the test seam.
- Device identity lives at `{KAOLA_HOME}/device.json` (`v`, PKCS8+SPKI base64, `createdAt`); dir `0700`, file `0600`.
- Signer uses raw `JSON.stringify(body)` bytes on the wire and `deviceProofCanonical` from `@kaola/shared` (not `*.test-helpers.ts`). Headers: `X-Kaola-Key|Ts|Nonce|Sig`; no `Authorization`.
- HTTP 202 `{ error, expires_at }` becomes `{ jsonrpc:'2.0', id, error: { code, message } }` with `authorization_required` and ISO `expires_at` in `message`; no `result` / `token`.
- Stdio CLI is a line-delimited JSON-RPC loop calling the same `forwardMcpRequest`; SDK 1.30.0 is a declared dependency (no stdio→HTTP proxy class).
- Private key and forge token are not written to KAOLA_HOME after claim and are not printed on console/stderr/stdout by the forwarder (202 path logs only `MCP authorization_required` to stderr).
