# Evidence-binding header (do not modify above this line)
project: bundle-20-21
issue: 20
surface: REST claim 201 / MCP claim_task clone envelope (remote_url, extra_header) plus claim test secret assertions
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21
# End evidence-binding header

behavior: security-reviewer
candidate: worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21 branch workflow/bundle-20-21 uncommitted claim-clone change
claim: issue #20 thickens REST claim 201 / MCP claim_task success clone with remote_url and extra_header without a second forge-token reveal, without interpolating the secret into value_pattern, without credentials in remote_url, without clone/token on 202 or session GET, and without server-side git
surface: apps/server/src/claim.ts clone envelope; claim.test.ts mcp.test.ts claim-confirm.test.ts secret assertions
evidence: /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-20-21/.cache/sec-review-20.md

# Security review - issue #20 claim clone recipe

Read-only review of uncommitted production on workflow/bundle-20-21. Production delta for this surface is the ClaimSuccessBody.clone type plus the inline clone object in claimTask (apps/server/src/claim.ts). MCP claim_task was not edited; it still JSON-serializes claimTask's body via toToolResult. Tests were read as oracles for whether secret assertions were weakened. Issue #21 App.vue / form tests / DESIGN docs in the same dirty tree are outside this clone-envelope surface except to confirm they do not add a third HTTP reveal. HTTP suite claim.test.ts mcp.test.ts claim-confirm.test.ts was run after a clean code verdict: 64 pass, 0 fail. No production or test file was modified by this review.

## Q1 - Top-level token remains the only plaintext reveal

claimTask still decrypts into a local `plaintext` and places it only at body.token on httpStatus 201. clone is a sibling object. remote_url is built from brief.repo.base_url (trailing slashes stripped) plus '/' plus brief.repo.full_name plus '.git'. extra_header is a forge-keyed constant object. Neither field reads `plaintext`.

Single-quoted patterns `'token ${token}'` (gitea) and `'Bearer ${token}'` (github and gitlab) are JS string literals. They do not interpolate. The local binding is named `plaintext`, not `token`, so even a mistaken template literal `${token}` would not compile against this function's scope.

token 揭示 audit details remain { task_id, agent_key_id, credential, optional profile_id }. No token, no clone, no ciphertext.

MCP registerTool('claim_task') awaits claimTask and passes result.body through JSON.stringify unchanged. No second clone builder.

## Q2 - Nested clone keys are not secret names

clone keys are exactly suggested_dir, token_usage, remote_url, extra_header. extra_header keys are exactly name, value_pattern. None of token, token_encrypted, inline_token_encrypted, access_token. token_usage is the pre-existing hygiene sentence key, not a secret key.

## Q3 - 202 confirmation_required still has no token and no clone

autonomous === true && !trustedAutomation still returns pendingConfirmationBody() before decrypt, lease insert, or the 201 envelope. pendingConfirmationBody is { error: 'confirmation_required', message, pending: true }. claimTask does not attach token or clone on that path.

## Q4 - list / get / session GET still have no token and no clone

taskBrief (tasks.ts) is unchanged: 15-key brief, repo five fields, credential is a reference. list_tasks maps taskBrief; get_task_brief returns taskBrief; session GET list/one send taskBrief. clone exists only on ClaimSuccessBody.

## Q5 - Server does not execute git

apps/server/src has no child_process, spawn, execFile, or git clone. clone is a JSON recipe. Fastify send of claimTask's body is the only delivery.

## Q6 - Tests were strengthened, not weakened

assertClaimRevealToken still requires body.token === forge plaintext and still walks task, lease, and clone for plaintext substring and SECRET_KEY_NAMES (token, token_encrypted, inline_token_encrypted, access_token). New assertCloneRecipe pins four clone keys, extra_header {name, value_pattern}, literal `${token}` in value_pattern, and forbids forge plaintext and '@' in remote_url. assertPending202 now also requires clone absent. Session GET list/one and MCP get_task_brief now assert clone absent in addition to assertNoForgeSecretMaterial. Fixture tokens remain distinctive (gitea-INLINE-ONE-OFF-TOKEN-zzq7 and siblings), not the placeholder `${token}`.

## OWASP walk (attacker-reachable)

A01 Broken access control: claim still Bearer-gated; 202 still parks before decrypt; session GET still has no clone. Unchanged authz.
A02 Cryptographic failures: vault decrypt local to claimTask; plaintext still only on 201/MCP success token.
A03 Injection: no shell; extra_header name/value_pattern are constants; remote_url is JSON, not a server command.
A04 Insecure design: clone is a client recipe; revealed secret is not copied into remote_url or value_pattern.
A05 Misconfiguration: no new CORS, logger, or parser flags.
A06 Vulnerable components: no dependency change in this delta.
A07 Auth failures: Bearer hook unchanged.
A08 Integrity: clone object is constructed, not merged from attacker JSON.
A09 Logging: token 揭示 details unchanged; no secret in clone.
A10 SSRF: server does not fetch remote_url.

Residual, not admitted (pre-existing inner-circle publish field, not a new reveal of the decrypted claim token): isHttpOrHttpsUrlWithHost allows URL userinfo, and remote_url concatenates stored base_url without stripping userinfo. Session GET already returns that base_url. Posters are full members who already attached the forge token. The candidate does not interpolate plaintext into remote_url.

Issue #21 UI in the same dirty tree still uses password inputs for publish/profile tokens and has no Agent claim UI; not a third reveal channel.

verdict: pass
findings_blocking: 0
review_conclusion: The candidate thickens claim clone with a non-secret remote_url and a literal extra_header value_pattern, keeps forge plaintext only on the top-level token of REST 201 and MCP claim_task success, omits token and clone on 202 and session GET, does not run git, and the claim tests still walk nested objects for leaked plaintext, so no in-scope security defect is admitted.
