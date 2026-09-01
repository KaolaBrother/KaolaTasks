## Investigation: Issue #48 validation gates (measurement only)

Claim under investigation: at worktree `workflow/issue-48` HEAD `5c08145877e5abe405869f3a26d79eedf711697d`, repository gates pass, product Git does not contain real deployment identifiers or root private keys, and Issue #48 live 配合 / system-trust checks are recorded honestly (executed vs not executed).

What would settle it:
- Sequential `pnpm lint` / `typecheck` / `test` / `build` plus focused `apps/mcp/src/trust.test.ts` with recorded exit codes and counts.
- Added-line scan vs `origin/main` plus working-tree grep of product paths for PEM, absolute paths, 64-hex fingerprints, vendor DNS, and new public hostnames.
- An execution ledger that marks live OS/browser/OAuth/public-entry 配合 as executed only if actually run.

This report does not choose a fix and does not claim the issue is ready to close.

### Setup
- Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-48`
- Branch: `workflow/issue-48`
- Commit / environment:
  - `git rev-parse HEAD` → `5c08145877e5abe405869f3a26d79eedf711697d` (matches expected)
  - `git log -1 --oneline` → `5c08145 Revert "chore: archive issue-48"`
  - `git status --short --branch` (before gates) → `## workflow/issue-48...origin/workflow/issue-48 [ahead 1]` and ` M kaola-workflow/issue-48/mission-list.md`
  - `git status --short --branch` (after gates) → same; product files unchanged by this investigation
  - `origin/main` → `e33db3dc9d177a8c1318722e17e90ce279199605`
  - Host: `uname -s/-m` → `Darwin` `arm64`; `sw_vers` → `macOS` `ProductVersion 26.6.2` `BuildVersion 25G83`
  - `node -v` → `v24.14.0`
- Merge-base product files vs `origin/main` (`git diff --name-only origin/main...HEAD`, excluding `kaola-workflow/`):
  - `CHANGELOG.md`, `README.md`, `apps/mcp/src/main.ts`, `apps/mcp/src/trust.test.ts`, `apps/mcp/src/trust.ts`, `docs/DESIGN.md`, `docs/README.md`, `docs/api.md`, `docs/architecture.md`, `docs/smoke-test.md`, `package.json`
  - `apps/mcp/examples/mcp.json` and `.env.example` have empty `git diff origin/main...HEAD` (exit 0, no hunks)
- Commands run (verbatim, sequential for gates):
  1. `git rev-parse HEAD && git status --short --branch && git log -1 --oneline && git rev-parse --abbrev-ref HEAD && node -v && pwd`
  2. `pnpm lint; echo "LINT_EXIT:$?"`
  3. `pnpm typecheck; echo "TYPECHECK_EXIT:$?"`
  4. `pnpm test; echo "TEST_EXIT:$?"`
  5. `pnpm build; echo "BUILD_EXIT:$?"`
  6. `node --experimental-strip-types --test apps/mcp/src/trust.test.ts; echo "TRUST_TEST_EXIT:$?"`
  7. Secret scans: `git diff origin/main...HEAD -- README.md CHANGELOG.md docs apps packages package.json .env.example apps/mcp/examples` and working-tree `rg` over the same product paths (excluding `kaola-workflow/`, `node_modules/`, `.git/`)
- Not run (forbidden / out of scope): push, merge, rebase, stash, reset; `security add-trusted-cert` / `certutil -addstore` / `update-ca-certificates` / `trust anchor`; any work on `issue-46` worktree.

### Observations

| Measurement | Command | Result | Exit |
|-------------|---------|--------|------|
| HEAD | `git rev-parse HEAD` | `5c08145877e5abe405869f3a26d79eedf711697d` | 0 |
| Branch tracking | `git status --short --branch` | `workflow/issue-48...origin/workflow/issue-48 [ahead 1]`; dirty file `kaola-workflow/issue-48/mission-list.md` only | 0 |
| Node | `node -v` | `v24.14.0` | 0 |
| Platform | `uname -s && uname -m`; `sw_vers` | Darwin arm64; macOS 26.6.2 (25G83) | 0 |
| lint | `pnpm lint` | `$ eslint .` then `LINT_EXIT:0`; no eslint findings printed | 0 |
| typecheck | `pnpm typecheck` | `pnpm -r --if-present typecheck`; Scope 5 of 6 workspace projects; `apps/web`, `packages/shared`, `packages/forge-adapters`, `apps/mcp`, `apps/server` all `Done`; `TYPECHECK_EXIT:0` | 0 |
| test (node harness) | `pnpm test` (first stage) | `ℹ tests 860` / `ℹ suites 230` / `ℹ pass 860` / `ℹ fail 0` / `ℹ cancelled 0` / `ℹ skipped 0` / `ℹ todo 0` / `ℹ duration_ms 10400.756792` | 0 (combined with vitest) |
| test (web vitest) | `pnpm --filter @kaola/web test` (second stage of `pnpm test`) | `Test Files  8 passed (8)` / `Tests  131 passed (131)` / `Duration  5.70s` | 0 |
| test combined | `pnpm test` | `TEST_EXIT:0` | 0 |
| build | `pnpm build` | `pnpm -r --if-present build`; Scope 5 of 6 workspace projects; `packages/forge-adapters` and `packages/shared` `tsc --noEmit` Done; `apps/web` vite build: 2568 modules, `dist/index.html` 0.75 kB (gzip 0.43 kB), `dist/assets/index-BNddLdPW.css` 9.32 kB (gzip 2.71 kB), `dist/assets/index-dfT5cHaS.js` 1,491.22 kB (gzip 412.75 kB); warning: chunks larger than 500 kB; `apps/server` `tsc --noEmit` Done; `BUILD_EXIT:0`. `@kaola/mcp` has no `build` script (`start`, `typecheck` only) so it was not in the 5-of-6 build scope. | 0 |
| focused MCP trust suite | `node --experimental-strip-types --test apps/mcp/src/trust.test.ts` | `ℹ tests 17` / `ℹ suites 8` / `ℹ pass 17` / `ℹ fail 0` / `ℹ cancelled 0` / `ℹ skipped 0` / `ℹ todo 0` / `ℹ duration_ms 311.722333`; openssl mint noise then all 17 titles passed (fail-closed verify, install, replacement, uninstall, system-trust plan data-only, no TOFU, HTTPS extra-CA against ephemeral `127.0.0.1` leaf, committed mcp.json clean); `TRUST_TEST_EXIT:0` | 0 |
| committed mcp.json | `cat apps/mcp/examples/mcp.json` | `command` + `args: ["--url", "http://localhost:31415"]` only; no `env`, PEM, fingerprint | 0 |
| mcp.json vs origin/main | `git diff origin/main...HEAD -- apps/mcp/examples/mcp.json` | empty | 0 |
| .env.example vs origin/main | `git diff origin/main...HEAD -- .env.example` | empty | 0 |
| package.json vs origin/main | `git diff origin/main...HEAD -- package.json` | one-line change: root `test` script inserts `apps/mcp/src/trust.test.ts` | 0 |
| added-line PEM private-key blocks | `git diff -U0 origin/main...HEAD` product paths; `rg` `BEGIN .*PRIVATE KEY` on `+` lines | 2 hits, both regex *source*, not PEM: `apps/mcp/src/trust.test.ts:44` `const PRIVATE_KEY_MARKER = /BEGIN [A-Z0-9 ]*PRIVATE KEY/`; `apps/mcp/src/trust.ts:29` `const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/` | 0 |
| added-line PEM CERTIFICATE blocks | same added-line scan; `BEGIN CERTIFICATE` | 4 hits, all string/regex/assert in `apps/mcp/src/trust.test.ts` (lines 45, 549, 729) and `apps/mcp/src/trust.ts:27`; no `-----BEGIN CERTIFICATE-----` + base64 + `-----END CERTIFICATE-----` blob | 0 |
| added-line absolute local paths | `+` lines `/Users/` `/home/[A-Za-z]` `C:\` | **ZERO** | 0 |
| added-line 64-hex SHA-256 | `+` lines `[a-fA-F0-9]{64}` | **ZERO** | 0 |
| added-line vendor DNS product config | `+` lines `cloudflare\|aliyun\|route53\|dnspod\|nameserver` | **ZERO** | 0 |
| working-tree literal PEM private key | `rg "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"` product paths | **ZERO** (marker regexes did not match this search as a PEM block) | 0 |
| working-tree literal CERTIFICATE PEM (multiline) | `rg -nU "-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----"` | **ZERO** | 0 |
| working-tree `BEGIN CERTIFICATE` strings | `rg -n "BEGIN CERTIFICATE"` product paths | `apps/mcp/src/trust.test.ts:45,549,729`; `apps/mcp/src/trust.ts:27` | 0 |
| working-tree absolute paths | `rg "/Users/|/home/[a-zA-Z]|C:\\Users"` product paths | 1 hit: `apps/mcp/src/runner-carrier.test.ts:574` `HOME: '/home/x'` (file **not** in `origin/main...HEAD` name list) | 0 |
| working-tree 64-hex | `rg "[a-fA-F0-9]{64}"` product paths | 3 hits, none in this branch’s added files: `apps/web/src/App.devices.test.ts:46` and `:58` (fixture fingerprints); `apps/server/src/devices.test.ts:24` `EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'` (SHA-256 of empty bytes). Docs/README/CHANGELOG/`.env.example`/`apps/mcp/examples`: **ZERO** | 0 |
| working-tree vendor DNS | `rg -ni cloudflare\|aliyun\|route53\|dnspod\|nameserver` product paths | 1 hit: `docs/smoke-test.md:32` Cloudflare 人机 on GitLab Authorize (file changed this branch only at DEBUG_PRIVATE_CA bullets ~L120; this line is not an added-line hit) | 0 |
| placeholders in product docs | `rg "<kaola-origin>\|<dev-root-ca.pem>\|<sha256-fingerprint>"` | present in `README.md` (e.g. 173, 182, 192, 197, 200, 213, 215, 241) and `docs/DESIGN.md` (e.g. 335, 383, 402, 406, 420, 435, 438, 450, 455) | 0 |
| `systemTrustElevationPlan` source | `rg spawn\|execFile\|child_process` in `apps/mcp/src/trust.ts` | no `spawn`/`exec`/`child_process` imports; OS commands appear only as returned string arrays (`trust.ts:379` `security add-trusted-cert…`, `:386` `certutil -addstore Root…`, `:395` `sudo update-ca-certificates`, `:403` `sudo trust anchor…`) | 0 |
| post-gate git status | `git status --short --branch` | still `[ahead 1]`; only ` M kaola-workflow/issue-48/mission-list.md`; `git diff --stat HEAD` that file 3 lines | 0 |

Focused trust suite titles that passed (all 17):

1. `empty PEM, private-key block, not-one CERTIFICATE, unparseable, non-CA, and fingerprint mismatch do not verify`
2. `matching openssl SHA-256 fingerprint of a real CA cert verifies, colon/case-insensitive`
3. `failed verify does not install, does not export NODE_EXTRA_CA_CERTS, and is not ready`
4. `matching verify+install writes public root PEM under kaolaHome 0600/0700 and exports absolute extra-CA path`
5. `wrong fingerprint, empty PEM, unparseable, non-CA, and multi-cert sources do not install`
6. `replacing the on-disk PEM with a different cert drops ready/export`
7. `removes extra CA PEM and export without deleting device.json or Claim receipts`
8. `plan API describes operator-run commands per OS and is data, not a spawned side effect`
9. `trust module source does not spawn security/certutil/update-ca-certificates/trust anchor`
10. `trust module and stdio bridge contain no origin-download-to-trust helper`
11. `HTTPS private-CA without prior local PEM+fingerprint does not write a CA into kaolaHome`
12. `private-CA success: matching verify+install then initialize/list_tasks over HTTPS with verification still on`
13. `missing extra CA: same HTTPS server, fresh kaolaHome, request fails with a certificate/TLS error`
14. `wrong fingerprint: verify/install rejected; HTTPS must not succeed via a disabled verifier`
15. `public-CA / clean home: default bridge does not write extra CA and does not disable TLS verification`
16. `production performMcpRequest/fetch must not pass rejectUnauthorized: false`
17. `apps/mcp/examples/mcp.json has no NODE_EXTRA_CA_CERTS, PEM, or fingerprints`

HTTPS tests 11–15 used ephemeral PKI minted at runtime against `https://127.0.0.1:${addr.port}` (test output included openssl `subject=CN=127.0.0.1`). They are not live public-origin or `DEBUG_PRIVATE_CA` deployment checks.

Added hostnames / ports in product-doc `+` lines vs `origin/main` (heuristic `https?://` / `localhost:` / `127.0.0.1:31415`): `http://localhost:31415`, `127.0.0.1:31415`, `https://…` ellipsis, GitHub issue links `https://github.com/KaolaBrother/KaolaTasks/issues/46`, placeholders `<kaola-origin>` / `<public-host>` / `<https-port>` / `<production-subdomain>`. Test-only added host: `https://kaola.example.test` in `apps/mcp/src/trust.test.ts`. No newly introduced real public production hostname or production port was observed in the added-line scan.

### Reproduction
- Repository gates **reproduce as passing** at this HEAD: lint 0, typecheck 0, test 0 (860+131 pass, 0 fail), build 0, focused trust suite 0 (17 pass, 0 fail).
- Secret-scan claim **reproduces as: no committed PEM private-key blocks, no committed literal CERTIFICATE PEM, no added 64-hex fingerprints, no added `/Users`/`C:\`/`/home/<user>` paths, no added Cloudflare/Aliyun/etc. as a live DNS product choice**. Hits that exist are regex/string constants in `trust.ts` / `trust.test.ts`, pre-existing test fixtures, pre-existing `docs/smoke-test.md:32` Cloudflare bot-challenge wording, and allowed `localhost:31415` / `127.0.0.1:31415` / public GitHub issue URLs / placeholders.
- Live 配合 items **do not reproduce as executed** in this session: they were not run.

### Narrowing
- Axis 1 — automated gates at `5c08145`: eliminated “lint/typecheck/test/build/trust.test currently fail on this worktree”.
- Axis 2 — added-line vs working-tree secret scan: eliminated “this branch added literal root private keys, committed PEM certs, 64-hex fingerprints, absolute operator home paths, or vendor DNS live config into product Git”. Did **not** eliminate pre-existing fixture hashes in device tests (those files are not in the issue-48 diff).
- Axis 3 — live vs unit: unit tests 12–15 exercise HTTPS extra-CA against local ephemeral `127.0.0.1`. That axis **does not** eliminate missing public-CA clean-machine live HTTPS, missing real `DEBUG_PRIVATE_CA` origin live MCP, or missing OS/browser/OAuth system-trust live.
- Axis 4 — system-trust commands: source + unit test 8–9 show `systemTrustElevationPlan` returns command strings and `trust.ts` does not import `child_process`. That axis **does not** mean the operator commands were executed; they were not.

### Inferences
- Automated Issue #48 MCP trust behaviors covered by `apps/mcp/src/trust.test.ts` (fail-closed verify/install/replacement/uninstall, no TOFU helper, extra-CA added rather than replacing store, mcp.json clean, plan export-only) **passed in this run**. Confidence: high for this commit and this Node `v24.14.0` Darwin host; refuted by a non-zero `TRUST_TEST_EXIT` or fail>0 on the same command.
- Product Git at this HEAD **does not appear to contain real deployment identifiers or root private keys** in the scanned product paths; observed identifiers are placeholders, allowed loopback `31415`, public GitHub issue links, and test `.example.test` / `127.0.0.1`. Confidence: high for the regexes actually run; refuted by a committed PEM block, a 64-hex fingerprint in docs, or a real hostname/port in added product docs that those patterns missed (e.g. a hostname without `http://`).
- Live DESIGN §16.6 / `docs/smoke-test.md` 配合 public-entry, private-CA enrolled-machine, and OS/browser trust checks **remain unmeasured**. Unit-test HTTPS on `127.0.0.1` is not a substitute. Confidence: high (commands were not issued); refuted only by evidence of those live commands in this session (none).
- `pnpm build` passing does **not** mean `@kaola/mcp` produced a compile artifact: that package has no `build` script; it was typechecked separately. Confidence: high; refuted by a `build` script appearing in `apps/mcp/package.json`.
- This report does **not** infer issue-close readiness. Remaining unexecuted 配合 items are specified in DESIGN/smoke-test as live checks.

### Open
- Public-CA clean-machine live HTTPS to a real public origin: **not executed** (no `PUBLIC_URL` / `<production-subdomain>` live target provided; DESIGN forbids inventing one; 配合).
- Private-CA MCP-only live against a real `DEBUG_PRIVATE_CA` origin: **not executed** (ephemeral `127.0.0.1` unit server only).
- macOS / Windows / Linux browser or OAuth system-trust live: **not executed**. This host is macOS only; Windows and Linux were not present.
- Actual execution of `security add-trusted-cert` / `certutil` / `update-ca-certificates` / `trust anchor`: **not executed** (forbidden privilege-elevation; unit tests assert the plan is data-only).
- Forge smoke `pnpm smoke:forge -- gitlab|gitea`: not in this brief; not run.
- Pattern-gap: hostname scan used `https?://` and a few port heuristics; a bare FQDN with no scheme could be missed. No such candidate was noticed in the 11 product files of the issue-48 diff, but that is unmeasured beyond the listed regexes.
- `kaola-workflow/issue-48/mission-list.md` is dirty vs HEAD; not a product-file scan target.

## Honest platform / MCP execution ledger

Host of this run: macOS 26.6.2 arm64, Node v24.14.0. Columns: check, executed, command or evidence, result.

| check | executed | command or evidence | result |
|-------|----------|---------------------|--------|
| Automated MCP trust: fail-closed verify | yes | `node --experimental-strip-types --test apps/mcp/src/trust.test.ts` titles 1–2 | pass (part of 17/17, exit 0) |
| Automated MCP trust: install | yes | same suite titles 3–5 | pass |
| Automated MCP trust: replacement | yes | title 6 | pass |
| Automated MCP trust: uninstall | yes | title 7 | pass |
| Automated MCP trust: no TOFU | yes | titles 10–11 | pass |
| Automated MCP trust: HTTPS extra-CA (ephemeral local PKI) | yes | titles 12–16 against `https://127.0.0.1:${port}` | pass; **not** live public/DEBUG origin |
| Automated MCP trust: committed mcp.json clean | yes | title 17 + `cat apps/mcp/examples/mcp.json` | pass; json is command+url only |
| Automated MCP trust: system-trust plan never executed | yes (unit + source); **commands not run** | titles 8–9; `rg` on `trust.ts` shows string `commands:` only | unit pass; operator elevation **not executed** |
| `pnpm lint` | yes | `pnpm lint` | exit 0 |
| `pnpm typecheck` | yes | `pnpm typecheck` | exit 0 |
| `pnpm test` | yes | `pnpm test` | exit 0; 860 node + 131 vitest pass, 0 fail |
| `pnpm build` | yes | `pnpm build` | exit 0; vite chunk-size warning; mcp package has no build script |
| Public-CA clean-machine live HTTPS to a real public origin | **no** | not run | not executed (配合 / DESIGN §16.6) |
| Private-CA MCP-only live against a real `DEBUG_PRIVATE_CA` origin | **no** | not run (unit 127.0.0.1 only) | not executed (配合) |
| macOS browser or OAuth system-trust live | **no** | not run | not executed (配合) |
| Windows browser or OAuth system-trust live | **no** | not run; host is not Windows | not executed |
| Linux browser or OAuth system-trust live | **no** | not run; host is not Linux | not executed |
| `security add-trusted-cert` | **no** | forbidden; not issued | not executed |
| `certutil -addstore` | **no** | forbidden; not issued | not executed |
| `update-ca-certificates` | **no** | forbidden; not issued | not executed |
| `trust anchor` | **no** | forbidden; not issued | not executed |
| Confirm `systemTrustElevationPlan` export-only without executing returned commands | yes | unit titles 8–9; `apps/mcp/src/trust.ts:369+` returns `{commands, note}`; no `child_process` | export-only in source/tests; commands not executed |
| `node -v` | yes | `node -v` | `v24.14.0` |

No 配合 live check is recorded as passed.
