# Security review — issue #12 import
behavior_contract_version: 3
role: security-reviewer
candidate: worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12
claim: importIssue + POST /api/v1/tasks/import + 来源标记
surface: SSRF, token hygiene, untrusted imported body, authz

## Method

Read-only review of uncommitted production on `workflow/issue-12` against HEAD `0e8bc4ac980d71a874ce7de38297a5de37bd768a`. Files: `packages/forge-adapters/src/index.ts` (`importIssue`, `parseIssueUrl`, `ImportedIssue`), `apps/server/src/tasks.ts` (`POST /api/v1/tasks/import`), `apps/web/src/App.vue` (import button, 导入内容 labels, fill-from-draft). Callers and neighbours: `forgeGet` / `authHeaders` / `prApiOrigin`, `decryptToken` / `insertTokenRevealEvent` / `insertAuditEvent`, existing `POST /api/v1/tasks`, `getSessionUser` / `canPostTasks`, board `{{ }}` rendering and `boardIssueUrlIsHttp`. Tests treated as oracles, not a defect surface. No product files edited.

## Trust-model checks

### SSRF (pasted issue host must not be the REST origin)

`resolveImportedIssue` builds the GET URL from `prApiOrigin(kind, options)` plus pathname-derived segments. GitHub origin is the constant `https://api.github.com`. GitLab and Gitea origin is constructor `options.baseUrl` with trailing slashes stripped. The pasted URL is parsed with `new URL` after trailing-slash strip; only `pathname` is used (query and hash dropped). Owner, repo, and GitLab namespace are `encodeURIComponent`-ed into a single path segment, so slashes and `..` cannot walk the constructor origin into a different host. Unparseable paths throw before `fetch`. HTTP `readImportBody` then `parseIssueUrl` runs before decrypt. `repo.base_url` must be http or https with a non-empty hostname, matching publish. Profile bind requires exact `forge` / `base_url` / parsed `full_name` before decrypt, so a profile token cannot be retargeted at a caller-chosen host.

### Token hygiene (import is not a third reveal channel)

Success `200` body is only `title`, `description_md`, `source`, and `repo`. No `token`, ciphertext, or credential object. Error bodies are pinned Chinese messages plus `error` / optional `missing`; forge JSON is not forwarded. Profile decrypt writes `token 揭示` via `insertTokenRevealEvent` with `profile_id`, `forge`, `base_url`, `full_name`, `outcome` only. Inline path does not persist and does not write that event. Adapter errors are `importIssue: ${kind} responded ${status}` or missing-title; they do not include the credential. Fastify is constructed with the default no-op logger. Session list/get still use `taskBrief`, which never reads vault plaintext.

### Authz

`POST /api/v1/tasks/import` uses `getSessionUser` then `canPostTasks` (`status === 'active'` and `permissionLevel === 'full'`), the same gate as publish. Unauthenticated is `sendUnauthorized`. Session cookie is `httpOnly` and `sameSite: 'lax'`. Agent Bearer is not accepted on this route. Import does not insert a `tasks` row.

### Untrusted imported body (XSS / prompt-injection labeling)

`ImportedIssue` copies forge `title` and body/description as strings. The UI never uses `v-html`. Board title and `description_md` are Vue text interpolation. Fill-from-draft assigns those strings into `n-input` `v-model` fields. Form and board both render the exact label 导入内容 when `source.type === 'imported'`. `javascript:` issue URLs stay text because `boardIssueUrlIsHttp` requires an `http:` or `https:` prefix; the import path does not change that helper.

## OWASP Top 10 against attacker-reachable paths

A01 Broken access control: new route is session-gated the same as publish; claim_only and pending cannot import; profile tokens only decrypt after forge/base_url/repo bind.
A02 Cryptographic failures: AES-256-GCM vault reuse; plaintext is a local variable for `forgeGet` only.
A03 Injection: Drizzle parameterized lookups; path segments encoded; no shell.
A04 Insecure design: draft 200 is not a claim/MCP token reveal; html_url/web_url from forge JSON are ignored so a hostile payload cannot replace the stored/pasted URL.
A05 Misconfiguration: no new CORS, logger, or parser flags.
A06 Vulnerable components: no dependency change in this delta.
A07 Auth failures: cookie flags unchanged; JSON POST plus SameSite=Lax blocks cross-site cookie send.
A08 Integrity: typed field picks from JSON, not raw object merge into markup or queries.
A09 Logging: profile decrypt is audited without secret material; inline import writes no reveal row.
A10 SSRF: fetch host is constructor origin or api.github.com, never the pasted issue host.

Pre-existing adapter residual (not candidate-caused, not admitted): `forgeGet` still uses default redirect follow, and GitLab `PRIVATE-TOKEN` is a non-Authorization header. That sink already existed for `validateToken` / `getPullRequest`. Issue-URL host is not that origin. Full-member inline `base_url` pointing at an arbitrary http(s) host remains the publish-era inner-circle residual.

verdict: pass
findings_blocking: 0
review_conclusion: Import is not a token reveal channel, pasted issue hosts never become fetch origins, session active-full gates match publish, and imported markdown is labeled and text-interpolated so the candidate introduces no in-scope security defect.
