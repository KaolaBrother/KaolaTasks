# Evidence-binding header (do not modify above this line)
project: issue-10
issue: 10
surface: MCP Streamable HTTP (/api/mcp) six tools + reveal-on-claim via claim_task + submit_pr
worktree: /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10
# End evidence-binding header

# Security review — issue #10 (in-process MCP `/api/mcp`)

Reviewer: security-reviewer. Read-only. Product files were not edited. The only write is this file.

**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-10` (uncommitted production delta on `workflow/issue-10` @ `64b123e5ac2fe77aa176bd5deea055be7d77f758` plus tdd-guide `mcp.test.ts`).

**Scope (candidate-caused only):** `apps/server/src/mcp.ts` (new); `claim.ts` (extracted `claimTask` / `reportProgress` / `releaseTask` + new `submitPr`); `tasks.ts` (`selectTasks` export); `app.ts` (`registerMcp`); `db.ts` / `schema.ts` (`submissions`); `apps/server/package.json` (`@modelcontextprotocol/sdk@1.30.0`, `zod`). `mcp.test.ts` was used only as a pin of intended JSON-RPC shapes, not as a defect surface. Pre-existing publish-time SSRF/exfil (#7 residuals) were not re-opened; this delta does not call `validateToken` or `fetch` on any MCP tool path. REST claim/progress/release keep the same extracted functions; they were not treated as a new reveal surface.

**Trust model honoured (not a defect):** successful `claim_task` must return forge plaintext in JSON key `token` to a Bearer Agent Key whose user is `active`. `list_tasks` / `get_task_brief` / `report_progress` / `release_task` / `submit_pr` must never contain the forge token. Pending (`待批准`) must not decrypt and must not write `token 揭示`. Missing/wrong Bearer on `POST /api/mcp` is HTTP 401 before JSON-RPC.

**Method:** full read of the candidate plus callers (`taskBrief` / `selectTasks`, encapsulated `addAgentBearerHook`, `claimTask` pending-before-decrypt, unique partial index `leases_one_active_per_task`, Fastify 5.12.1 default logger, MCP SDK Streamable HTTP). Then live probes against real `buildApp()` via `inject` only (no public listener): copied MCP JSON-RPC seams (`initialize` then `tools/list` / `tools/call`, replay `mcp-session-id`) without importing `mcp.test.ts`. Measured unauth oracles, list/brief after a live claim, pending seeded key, second claim and non-holder progress/release/submit_pr, successful claim nested objects + audit details, concurrent two `claim_task`, planted unique-index throw, tampered ciphertext, stolen `mcp-session-id` rebound, `events.details`, SQLite file bytes, `app.log` / stdout / stderr. No repository product file was modified by those probes.

**Verdict: PASS.** No candidate-caused finding. Reveal-on-claim is gated after Bearer authn + pending + status, and every reject/list/brief/heartbeat/release/submit_pr/log/audit path measured here stayed free of forge plaintext and ciphertext except the intended successful `claim_task` top-level `token`.

---

## Admitted findings

None.

---

## Checked and clean — HTTP 401 before JSON-RPC; no token on unauth paths

Primary anchors: `mcp.ts` encapsulated child `mcpBearerContext` + `addAgentBearerHook`; extra `request.agentAuth == null` guard in `handleMcpPost`.

- **401 (missing Authorization / wrong Bearer / `Token ` scheme / Basic / session-cookie-only):** `{error:'unauthorized'}` plus `WWW-Authenticate: Bearer`. Bodies were not JSON-RPC, contained neither forge plaintext nor a `token` key. Session cookies do not authorize `/api/mcp`.
- **GET / DELETE `/api/mcp` without Bearer:** also 401 (hook runs before the 405 handler). Authenticated GET is 405 JSON-RPC `-32000 Method not allowed.` with no plaintext.
- **tools/call without `mcp-session-id` after a valid Bearer:** 400 JSON-RPC `-32000 Bad Request: No valid session ID provided`, no plaintext.
- **Unknown `mcp-session-id` with a valid Bearer:** 404 JSON-RPC `-32001 Session not found`, no plaintext.

---

## Checked and clean — tools/list, list_tasks, get_task_brief never reveal

Primary anchors: `mcp.ts` `listTasksTool` / `getTaskBriefTool`; `tasks.ts` `taskBrief` (explicit 15-key projection, credential is `{profile_id}` or `{inline:true}`).

- **`tools/list` after a live claim:** HTTP 200, no forge plaintext, no secret key names `token` / `token_encrypted` / `inline_token_encrypted` / `access_token`.
- **`list_tasks` after a live inline claim:** `{ tasks: [...] }` briefs only. No forge plaintext, no secret key names. Status of the claimed card was `进行中`.
- **`get_task_brief` after that claim:** top-level 15-key brief, no forge plaintext, no secret key names.

---

## Checked and clean — pending must not decrypt or write `token 揭示`

`claimTask` (`claim.ts:77-79`) returns 403-equivalent `{error:'forbidden', message:'你的账号待正式成员批准后方可认领任务。'}` **before** `sweepExpiredLeases`, task lookup, and `decryptToken`. Isolated file-DB probe with a GitHub `待批准` user and a SQL-seeded Agent Key (pending cannot mint via HTTP):

- MCP `claim_task` HTTP 200, `result.isError === true`, REST error body in `structuredContent`, **no** `token` key, **no** forge plaintext in the HTTP body.
- Task status stayed `待认领`.
- `events` row count unchanged (`0→0` on a dedicated DB; `4→4` on the combined lifecycle DB that already had publish + inline-claim rows).
- `token 揭示` count for that probe was `0→0`. `leases` stayed empty.
- The Bearer hook still authenticates the seeded key (initialize succeeded). That is authn-then-authz, inherited from `addAgentBearerHook`, not a reveal.

`report_progress` / `release_task` / `submit_pr` do not re-check `待批准`. There is no HTTP path that demotes `active` to `待批准`, and pending cannot become a lease holder through `claim_task`, so that skip is not attacker-reachable as a decrypt.

---

## Checked and clean — second claim, non-holder progress/release/submit_pr

- **Second `claim_task` / holder re-claim while `进行中`:** `isError` `{error:'conflict', message:'任务已被认领。'}` **before decrypt**. No `token` key, no plaintext. Claiming someone else's in-progress task does not reveal.
- **Non-holder `report_progress` / `release_task` / `submit_pr`:** `isError` `{error:'forbidden'}` (no `message`), no `token` key, no plaintext. Holder identity is `leases.claimer_user_id === agentAuth.user.id` (not `agent_key_id`).
- **Holder `report_progress`:** exact keys `{lease, task}`, no plaintext, no `token` key.
- **Holder `submit_pr`:** exact keys `{pr_url, summary, task}` with `task.status === '待验收'`, no plaintext, no `token` key. Active lease marked `released`. `submissions` has no token columns.

---

## Checked and clean — successful `claim_task` envelope, audit, nested objects

Measured for both inline (`gitea-INLINE-…`) and profile (`gitea-PROFILE-…`) paths.

- HTTP 200 JSON-RPC `result` (MCP success is not REST 201). Tool payload keys exactly `clone`, `lease`, `task`, `token`. Top-level `token` matched the publish fixture (product intent).
- Nested `task`, `lease`, and `clone` did not contain forge plaintext or secret key names. Response headers (`content-type`, `mcp-session-id`, `content-length`, `date`, `connection`) did not carry the secret.
- The MCP `content[0].text` block is `JSON.stringify` of that same envelope, so it also contains the top-level token. That is the success body, not a second channel to an unauthorized caller.
- **Audit `details`:** every `events` row after the probed lifecycle serialized without forge plaintext and without ciphertext blobs from `tasks.inline_token_encrypted` / `credential_profiles.token_encrypted`. Claim reveal details were `{task_id, agent_key_id, credential}` plus `profile_id` only on the profile path. Heartbeat details `{task_id, note}`; `submit_pr` `状态迁移` `{task_id, from, to, pr_url, summary}`. SQLite file bytes after close contained no plaintext forge markers.

---

## Checked and clean — race (two `claim_task` on one task)

`claimTask` updates status and inserts the active lease with no `await` before returning. `leases_one_active_per_task` unique partial index rejects a second `state='active'` row for the same `task_id`. Concurrent `Promise.all` of two MCP `claim_task` calls (two sessions, two active users) on one `待认领` task: **one** success with top-level plaintext, **one** `isError` `{error:'conflict'}` with no `token` key and no plaintext, exactly one active lease, exactly one `token 揭示` for that `task_id`. The loser did not receive the secret.

---

## Checked and clean — thrown vault / unique-index paths (MCP isError, no token)

The MCP SDK turns a thrown tool error into `result.isError` with the `Error.message` as a text block (the outer `handleMcpPost` `-32603` catch is not the path that ran).

- **Planted unique index** (active lease row while `tasks.status` still `待认领`): HTTP 200, `isError`, text `UNIQUE constraint failed: leases.task_id`, **no** forge plaintext. Reveal audit is written **after** `insertActiveLease`, so a thrown insert does not record `token 揭示`.
- **Tampered ciphertext:** HTTP 200, `isError`, text `invalid ciphertext`, **no** forge plaintext.

Those English/SQLite strings are not token material. Not filed.

---

## Checked and clean — MCP session id is not an authorization credential

`mcp.ts` keeps an in-memory `sessions` map (stateful Streamable HTTP, `sessionIdGenerator: randomUUID`). Each subsequent request still requires Agent Bearer; `session.authHolder.auth` is overwritten with the current `request.agentAuth` before `handleRequest`.

- Rival Bearer + stolen holder `mcp-session-id` + `list_tasks`: 200, no forge plaintext (does not dump a prior `claim_task` result).
- Rival Bearer + stolen session + `claim_task` on a `待认领` task: succeeds **as the rival** (`leases.claimer_user_id` = rival user id). Session theft without the victim's Agent Key cannot impersonate the victim.

---

## Checked and clean — logger / stdout / SQLite

`buildApp` constructs `Fastify()` with no logger option. On the live app, `app.log.info` / `error` are Fastify `function noop () { }` (`name === 'noop'`). Wrapping the noop still sees in-memory `{req}` arguments; `util.inspect` of those objects can walk `POST /api/v1/tasks` `credential.token` (the publish fixture). JSON-safe serialization of the same logger args contained **no** forge plaintext. MCP `claim_task` success was **not** present in logger args. No `console.*` and no stdout/stderr chunk written during the probes contained forge plaintext (probe `record()` lines redact). SQLite file bytes after close: no inline/profile plaintext.

---

## Residual / pre-existing / product (not blocking, not admitted)

- **#7 leftovers, unchanged:** publish-time `validateToken` still follows caller `repo.base_url` on the **inline** HTTP create path; MCP tools do not call `validateToken` or `fetch`.
- **Decrypt before lease insert:** same as issue #9 REST. If insert throws, plaintext exists only in the handler local; the MCP isError body did not include it. Not reachable as a double-reveal over MCP given the unique index and the `进行中` gate.
- **Stateful MCP sessions vs orchestrator “stateless” ruling:** protocol/session bookkeeping only; Bearer still gates every POST. Not a token defect.
- **`POST /api/v1/tasks` request body still carries `credential.token` into the in-memory Fastify `req` object** that the noop logger is invoked with. Pre-existing publish path; destination is noop; not MCP-caused.
- **Session cookie `secure: false`:** pre-existing #5.

---

finding: none

verdict: pass
findings_blocking: 0

review_conclusion: Successful claim_task returns forge plaintext only at the tool envelope top-level token to an active Bearer agent, and every unauth reject, list, brief, progress, release, submit_pr, log, and audit path measured here stayed free of token material.
