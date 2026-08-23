# Evidence-binding header (do not modify above this line)
project: issue-19
issue: 19
surface: ForgeAdapter.listIssues + GET /api/v1/credential-profiles/:id/issues + publish UI issue picker
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-19
# End evidence-binding header

behavior: security-reviewer
candidate: worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-19 branch workflow/issue-19 uncommitted vs 41e1e01
claim: issue #19 listIssues plus profile issues GET plus publish picker is not a third forge-token reveal and does not add SSRF XSS or authz bypass
surface: SSRF on listIssues fetch origin, GitLab issue_url vs web_url, GitHub PR filter, GET /api/v1/credential-profiles/:id/issues authz decrypt and token hygiene, App.vue n-select titles
evidence: /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-19/.cache/sec-review.md

# Security review - issue #19 credential-profile issue picker

Read-only review of uncommitted production on workflow/issue-19 against 41e1e01. Production files: packages/forge-adapters/src/index.ts (listIssues, listIssuesApiUrl, listedIssueWebUrl, mapListedIssue, prApiOrigin, forgeGet), apps/server/src/credential-profiles.ts (new GET :id/issues, canManageProfiles, listForgeFailure), apps/web/src/App.vue (n-select listedIssueOptions, loadListedIssues, parseListedIssues). Context: vault decryptToken, auth getSessionUser/sendUnauthorized, DELETE :id 404 oracle, import token 揭示 path in tasks.ts, Naive render() in node_modules. Tests read as oracles only. HTTP suite apps/server/src/credential-profile-issues.test.ts was run after a clean code verdict: 13 pass, 0 fail. No production or test file was modified.

## Q1 - SSRF: listIssues fetch origin is prApiOrigin, not repo.base_url / web_url

listIssuesApiUrl builds the GET from prApiOrigin(kind, options) plus encoded path segments. GitHub origin is the constant https://api.github.com. GitLab and Gitea origin is constructor options.baseUrl with trailing slashes stripped. repo.base_url is not concatenated into the fetch URL. GitHub owner/name and Gitea owner/name are encodeURIComponent path segments. GitLab full_name is a single encodeURIComponent project path, so slashes cannot walk the constructor origin.

The HTTP handler does not take a caller-supplied host. It constructs createForgeAdapter(profile.forge, { baseUrl: profile.baseUrl }) and passes { full_name: profile.repoFullName, base_url: profile.baseUrl } from the stored row after id lookup. A claim_only or pending session never reaches decrypt or fetch.

GitLab and Gitea constructor baseUrl remains the stored profile host, the same inner-circle residual as importIssue/validateToken: only active+full can create that row. Not candidate-caused and not a new untrusted-host fetch.

forgeGet is the existing header-auth GET with default redirect follow. Same pre-existing adapter residual as importIssue. Issue-URL hosts and forge JSON html_url/web_url are not that origin.

## Q2 - GitLab issue_url is constructed; GitHub PRs are dropped

listedIssueWebUrl builds issue_url from repo.base_url + full_name + /-/issues/{number} (GitLab) or /issues/{number} (GitHub/Gitea). mapListedIssue never copies html_url, web_url, or html_url. GitLab number is iid, not id. GitHub items with a pull_request own-key are skipped.

Returned objects are only { number, title, issue_url }. Forge JSON extra fields do not pass through.

## Q3 - GET /api/v1/credential-profiles/:id/issues authz and token hygiene

Order: getSessionUser (401 via sendUnauthorized, same JSON oracle as GET /api/v1/me) then canManageProfiles (status === active and permissionLevel === full) then 403 { error: forbidden } with no message. Pending 待批准 and claim_only never decrypt. Agent Bearer is not accepted; this is session-only like the rest of credential-profile CRUD.

parsePositiveInt failure and missing row both 404 { error: not_found }, matching DELETE /api/v1/credential-profiles/:id. No extra existence oracle.

decryptToken(profile.tokenEncrypted) is a local variable passed only into listIssues as cred.token (Authorization / PRIVATE-TOKEN / token header on the outbound forge GET). Success body is { issues }. Error bodies are pinned: 422 { error: token_check_failed, missing: [读], message } on forge 401; 502 { error: forge_unreachable, message } otherwise including 404/410/500/network; 500 { error: vault_unconfigured } when the vault key is missing. Forge JSON is not forwarded. Adapter errors are listIssues: ${kind} responded ${status} or not-an-array; they do not include the credential.

No insertAuditEvent and no insertTokenRevealEvent on this route. GET /api/v1/events after a successful list does not contain type token 揭示. Ciphertext is not written to events.details. Fastify is constructed as Fastify() with the default no-op logger. The handler has no console.log.

Standing invariant holds: forge token plaintext still only leaves HTTP on REST claim 201 and MCP claim_task success. This GET is not a third reveal channel.

Pre-existing, not a regression: POST /api/v1/tasks/import profile path still writes token 揭示. This candidate does not touch that path.

## Q4 - Publish UI does not receive a forge token; titles are not v-html

loadListedIssues GETs /api/v1/credential-profiles/${id}/issues with credentials include and Accept application/json only. parseListedIssues allow-lists number, title, issue_url and drops anything else, so a token key on the JSON cannot enter listedIssues.

listedIssueOptions maps to { label: `#${number} ${title}`, value: issue_url } for n-select. App.vue has no v-html and no render-label. Naive UI render() turns string labels into createTextVNode. Issue titles from a hostile forge are text, not markup.

Profile mode still posts import with { profile_id } not a token. Inline token input is unchanged and not used for this GET.

## OWASP walk (attacker-reachable)

A01 Broken access control: new GET is session active+full, same as profile CRUD; claim_only and pending are 403 before lookup; 404 matches DELETE.
A02 Cryptographic failures: AES-256-GCM vault reuse; plaintext is a local for forgeGet only.
A03 Injection: Drizzle eq on integer id; path segments encoded; no shell.
A04 Insecure design: list 200 is not a claim/MCP token reveal; html_url/web_url ignored.
A05 Misconfiguration: no new CORS, logger, or parser flags.
A06 Vulnerable components: no dependency change in this delta (package.json only adds the new test path).
A07 Auth failures: cookie flags unchanged; GET plus SameSite=Lax does not create a new cookie-send on cross-site fetch.
A08 Integrity: mapped field picks, not raw JSON merge into markup.
A09 Logging: no token 揭示 row; no secret in details; default Fastify logger.
A10 SSRF: fetch host is prApiOrigin, never pasted URL, never web_url, never repo.base_url as origin.

Residual (pre-existing, not admitted): full-member-chosen GitLab/Gitea profile.baseUrl can still be an arbitrary http(s) host, same as import/validateToken; forgeGet still follows redirects by default.

verdict: pass
findings_blocking: 0
review_conclusion: The candidate adds listIssues and a session-gated profile issues GET that decrypts the vault token locally, fetches only from prApiOrigin, returns number title and issue_url, writes no token reveal event, and renders Naive n-select labels as text nodes, so no in-scope security defect is admitted.
