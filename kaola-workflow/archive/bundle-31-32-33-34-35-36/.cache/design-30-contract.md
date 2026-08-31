# Design §15 / ADR-0030 Contract Extract

Source documents read in full, at worktree commit `df98907` (branch `workflow/bundle-31-32-33-34-35-36`,
path `/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/.kw/worktrees/bundle-31-32-33-34-35-36`):

- `docs/DESIGN.md` (360 lines) — read in full; §15 is lines 350–360.
- `docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md` (329 lines) — read in full.

This extract quotes normative sentences verbatim (Chinese text verbatim where the source is
Chinese). Where the two source documents are silent on a question the checklist below asks,
this file says "not addressed" rather than inferring an answer.

---

## 1. Frozen contract obligations

Every normative statement found in DESIGN §15 and ADR-0030, numbered, each with its source
anchor and exact quote.

### From `docs/DESIGN.md` §15 (lines 350–360)

1. **DESIGN.md:352** — "本节冻结产品边界" (this section freezes the product boundary — framing
   sentence for everything below in §15).
2. **DESIGN.md:354** — "Kaola Tasks 单向适配两个独立 Repo；Workflow 和 Runner 不知道 Kaola Tasks 存在。"
3. **DESIGN.md:355** — "`claim_task` 成功后默认由当前 MCP Agent 直接运行 Kaola Workflow；只有用户显式指定时才使用 Project Runner，当前 Agent 仍是 Claim controller/monitor。"
4. **DESIGN.md:356** — "服务端保持现有六个 MCP 工具且不运行外部进程；只给现有 lease 补 request id、公开 Claim identity、精确 device fence、事务和幂等。"
5. **DESIGN.md:357** — "`kaola-mcp` bridge 只保存无密 Claim recovery receipt：服务端身份为 request/claim，carrier 与精确 Runner session 仅留在本地回执；不保存 token、prompt、Workflow 内容或 Runner transcript。"
6. **DESIGN.md:358** — "Workflow/Runner capability 与版本探测只提供 advisory evidence，不形成 allowlist hard gate；身份、合法状态迁移、Claim fence、token 解密和 PR repo 绑定仍 fail closed。"
7. **DESIGN.md:359** — "当前 forge PAT 是 claim 时揭示的可复用仓库凭证，并非 lease-scoped token；真正 per-Claim mint/revoke 是独立后续能力。"
8. **DESIGN.md:360** — "实现顺序与逐项验收由 [#36] → [#31] → [#32] → [#33] → [#34] → [#35] 承接；Issue 编号不代表执行顺序。"

### From `docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md`

**§Decision (lines 6–17)**

9. **ADR-0030 §Decision:8-9** — "Kaola Tasks owns the Claim lifecycle and a one-way compatibility layer for two independently versioned external repositories:"
10. **ADR-0030 §Decision:11** — "Kaola Workflow is the default engineering protocol after every successful claim."
11. **ADR-0030 §Decision:12** — "Kaola Project Runner is an optional CLI carrier used only when the user explicitly asks for it."
12. **ADR-0030 §Decision:13** — "Workflow and Runner do not import, call, or know about Kaola Tasks."
13. **ADR-0030 §Decision:15-16** — "The server remains routing and coordination only. It never starts an Agent, Workflow, Runner, tmux, git process, or local worktree."
14. **ADR-0030 §Decision:16-17** — "Compatibility is split between the existing MCP lifecycle contract, the local `kaola-mcp` bridge, and Agent-facing instructions owned by Kaola Tasks."

**§Why this is the minimum (lines 19–34)**

15. **ADR-0030 §Why this is the minimum:32-34** — "The design therefore adds no Claim aggregate table, execution-binding table, coordinator service, `get_claim` tool, or `bind_execution` tool. It does not copy Workflow phases, Mission List content, Runner transcripts, or runtime capability state into Kaola Tasks."

**§Dependency direction (lines 36–49)**

16. **ADR-0030 §Dependency direction:47-49** — "Knowledge flows outward only. Changes in an external interface are absorbed by Kaola Tasks' compatibility instructions and observations; they do not create a dependency in either external repository."

**§Existing MCP surface stays intact (lines 51–74)**

17. **ADR-0030 §Existing MCP surface stays intact:53** — "The public tool inventory remains exactly six:" (list: `list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `release_task`, `submit_pr`).
18. **ADR-0030 §Existing MCP surface stays intact:64-65** — "No execution-mode or Runner field is added to the server contract. The server neither needs nor uses that information."
19. **ADR-0030 §Existing MCP surface stays intact:65-70** — "The MCP-connected Agent receives the user's instruction and selects the carrier locally: no explicit Runner request: use Workflow directly; explicit Runner request: use that exact Runner/runtime and remain its controller/monitor; no silent carrier switch in either direction."
20. **ADR-0030 §Existing MCP surface stays intact:72** — "The static `claim_task` description and Kaola Tasks-owned client instructions state this default."
21. **ADR-0030 §Existing MCP surface stays intact:73-74** — "Workflow or Runner availability is observed locally and reported as evidence, not submitted to the server as lifecycle state."

**§Minimal Claim protocol additions → Claim (lines 76–115)**

22. **ADR-0030 §Claim:80** — "`claim_task` adds one optional request field:" followed by example containing `request_id`.
23. **ADR-0030 §Claim:90-92** — "The local bridge generates and durably records `request_id` before forwarding the first attempt. Existing callers may omit it during compatibility rollout and retain their existing behavior. New clients always send it."
24. **ADR-0030 §Claim:94** — "The successful top-level envelope remains `{ task, token, lease, clone }`. Only `lease` gains an additive identity:" followed by example with `claim_id`, `expires_at`, `ttl_seconds`.
25. **ADR-0030 §Claim:107-108** — "The existing lease row is the Claim attempt. `claim_id` is its public opaque encoding; no parallel record is introduced."
26. **ADR-0030 §Claim:108-109** — "The lease stores the request id and has a unique device/request identity."
27. **ADR-0030 §Claim:110-115** — "For the same task, device and request id: an active replay returns the same Claim identity and reconstructs the same success envelope; token re-reveal stays inside the existing REST/MCP claim endpoint and is audited as a replay; a terminal replay returns that Claim's terminal result and never creates a new lease; a different request id is a new attempt only when the Task is legally claimable."

**§Mutations (lines 117–130)**

28. **ADR-0030 §Mutations:119-121** — "`report_progress`, `release_task`, and `submit_pr` add `claim_id`. The server matches Task, active lease, owner, exact device, and Claim identity. A stale Claim cannot renew, release, or submit a newer attempt."
29. **ADR-0030 §Mutations:123-124** — "The REST claim/progress/release mirror uses the same fields and semantics. `submit_pr` remains MCP only."
30. **ADR-0030 §Mutations:126-129** — "Compatibility rollout accepts an omitted `claim_id` only for a legacy active lease whose `request_id` is null, deriving that lease for the same exact device. A new-style lease with a non-null request id requires `claim_id`; omission returns `claim_id_required`. New bridge calls always send it."
31. **ADR-0030 §Mutations:129-130** — "Because Runner never receives the device key or calls Kaola MCP, it cannot mutate a Claim directly."

**§Idempotent terminal operations (lines 132–137)**

32. **ADR-0030 §Idempotent terminal operations:134** — "Repeating release for the same already released Claim returns the same released result."
33. **ADR-0030 §Idempotent terminal operations:135** — "Repeating submit for the same Claim and PR URL returns the existing submission."
34. **ADR-0030 §Idempotent terminal operations:136** — "Reusing that submission operation with a different PR URL returns conflict."
35. **ADR-0030 §Idempotent terminal operations:137** — "An operation against an older Claim returns `stale_claim` without changing Task state."

**§Database changes (lines 139–165)**

36. **ADR-0030 §Database changes:143-147** — "add nullable `request_id` to `leases` for rolling compatibility; add a unique index for non-null `(device_id, request_id)`; expose the lease's stable public `claim_id` without a new Claim table; add a unique index on `submissions.lease_id`; add `claim_id` to relevant event details rather than creating an event foreign-key schema."
37. **ADR-0030 §Database changes:149-152** — "An active Claim must retain access to the credential it originally revealed. A credential profile referenced by an active Claim cannot be deleted or replaced until that Claim is terminal; inline credential bytes remain on the Task as today. This lets an active replay re-decrypt the same credential without copying another encrypted token into the lease."
38. **ADR-0030 §Database changes:154-161** — "Every lifecycle transition is one SQLite transaction: claim: approved-confirmation consumption when applicable, Task compare-and-swap, lease insert, token-reveal audit, and status-transition audit; heartbeat: conditional active-lease renewal and heartbeat audit; release: conditional lease terminal state, Task transition, and audit; expiry sweep: conditional lease expiry, Task transition, and audit; submit: conditional lease terminal state, Task transition, unique submission, and audit."
39. **ADR-0030 §Database changes:163-165** — "Forge comment writeback runs only after commit and uses the existing retry path. A remote comment is not allowed to delay or decide the Claim response, and no new outbox table is required for this scope."

**§Local bridge receipt (lines 167–194)**

40. **ADR-0030 §Local bridge receipt:169** — "The bridge persists the smallest recovery receipt under its existing `KAOLA_HOME` boundary:" followed by receipt JSON shape (`v`, `server`, `task_id`, `request_id`, `claim_id`, `repo_identity`, `carrier`, `runner`, `runner_session`).
41. **ADR-0030 §Local bridge receipt:185-186** — "It contains no forge token, HTTP header, Task description, prompt, Workflow content, Runner frame, or transcript."
42. **ADR-0030 §Local bridge receipt:186-187** — "A pending receipt is written before the first Claim request; the response fills in `claim_id`."
43. **ADR-0030 §Local bridge receipt:187-188** — "After a bridge or server restart, replaying the same request id recovers the same active Claim."
44. **ADR-0030 §Local bridge receipt:190** — "Carrier defaults to `direct`."
45. **ADR-0030 §Local bridge receipt:190-192** — "When the user explicitly requests Runner, the Kaola Tasks-owned local compatibility instruction changes only the local receipt to `carrier: \"runner\"`, records the named runtime, and fills the exact session locator after start."
46. **ADR-0030 §Local bridge receipt:192** — "The server never receives these fields."
47. **ADR-0030 §Local bridge receipt:192-194** — "Workflow state is rediscovered from the target repo; Runner identity is verified against the exact recorded session rather than inferred from prose."

**§Default direct Workflow path (lines 196–215)**

48. **ADR-0030 §Default direct Workflow path:198-207** — "When the user does not explicitly request Runner:" sequence: `get_task_brief`; `claim_task(request_id)`; secure clone from the existing clone envelope; Workflow startup or resume; Mission List execution and `report_progress` heartbeats; Workflow finalization and PR/MR sink; `submit_pr(task_id, claim_id, pr_url, summary)`.
49. **ADR-0030 §Default direct Workflow path:210-211** — "This path performs zero Project Runner calls. The current Agent owns Claim control, Workflow execution, validation, and settlement."
50. **ADR-0030 §Default direct Workflow path:213** — "For an imported Task, `source.issue_url` is the Workflow issue target."
51. **ADR-0030 §Default direct Workflow path:213-214** — "For a native Task, the Agent uses an issue-less Workflow project named from the Task id; Kaola Tasks does not silently create a forge Issue."
52. **ADR-0030 §Default direct Workflow path:215** — "The sink is PR/MR because Task acceptance is based on `submit_pr` and remote review."

**§Explicit Project Runner path (lines 217–241)**

53. **ADR-0030 §Explicit Project Runner path:219-231** — "When the user explicitly names a Project Runner runtime:" sequence: `get_task_brief`; local advisory observation of Workflow and the requested Runner; `claim_task(request_id)`; secure clone and Workflow startup; start the exact Runner session in the Workflow worktree; target CLI resumes and executes the Workflow Mission List; current Agent monitors Git and Workflow evidence and sends Claim heartbeats; current Agent performs credential-bearing push and PR/MR settlement; `submit_pr(task_id, claim_id, pr_url, summary)`; stop only the exact Runner session.
54. **ADR-0030 §Explicit Project Runner path:234** — "The current Agent remains the controller and monitor. Project Runner remains transport-only."
55. **ADR-0030 §Explicit Project Runner path:235-236** — "The forge token is never sent through a prompt or Runner input and is never placed in its environment, frame, capture, or transcript."
56. **ADR-0030 §Explicit Project Runner path:238-239** — "If the requested Runner is unavailable, the compatibility layer reports the observation."
57. **ADR-0030 §Explicit Project Runner path:239-241** — "It does not silently switch to direct execution, reject the Claim by version allowlist, or manufacture a successful Runner receipt."
58. **ADR-0030 §Explicit Project Runner path:240-241** — "The Agent decides, from actual work state and user intent, whether to retry, ask for a different carrier, continue directly with explicit approval, or safely release."

**§Advisory compatibility, not hard gates (lines 243–256)**

59. **ADR-0030 §Advisory compatibility, not hard gates:245-247** — "Local observations may include Workflow availability, Runner binary/version, exact session, worktree, Git state, and PR receipt. They are evidence for Agent judgment."
60. **ADR-0030 §Advisory compatibility, not hard gates:247-252** — "They are not persisted as server policy and do not block Claim merely because: a version is absent from an allowlist; an optional capability cannot be detected; a runtime uses a new but observable interface; Workflow or Runner returns prose instead of a preferred typed hint."
61. **ADR-0030 §Advisory compatibility, not hard gates:254-255** — "Correctness and security invariants still fail closed: device authorization, legal Task transition, token decryption, exact Claim/device fencing, transaction integrity, and PR repository identity."
62. **ADR-0030 §Advisory compatibility, not hard gates:256** — "These are not compatibility gates."

**§Heartbeat and recovery (lines 258–276)**

63. **ADR-0030 §Heartbeat and recovery:260** — "The Task server remains the only live lease authority."
64. **ADR-0030 §Heartbeat and recovery:261** — "The controlling Agent calls `report_progress`; Runner and Workflow do not learn Kaola MCP."
65. **ADR-0030 §Heartbeat and recovery:262-263** — "Heartbeat cadence is advisory and derived from the returned TTL; mission transitions and pre-sink checks are useful opportunities, but no extra scheduler service is introduced."
66. **ADR-0030 §Heartbeat and recovery:264** — "If the controller stops permanently, normal lease expiry returns the Task to `待认领`."
67. **ADR-0030 §Heartbeat and recovery:265-266** — "A bridge/server response-loss window recovers through the local request receipt and idempotent Claim replay."
68. **ADR-0030 §Heartbeat and recovery:267** — "Workflow interruption recovers from `workflow-state.md` and `mission-list.md`."
69. **ADR-0030 §Heartbeat and recovery:268** — "Runner interruption recovers through its exact repo/session identity."
70. **ADR-0030 §Heartbeat and recovery:270-276** (compensation) — "Compensation follows the work, not process exit codes: before durable work: clean the external attempt, then release the Claim; after work exists: preserve repo, Workflow state and Claim; never auto-discard; after PR/MR creation: forward-only recovery—reuse the same remote PR and retry `submit_pr`; never create a second PR merely because a local receipt write or MCP response was uncertain."

**§Credential semantics (lines 277–285)**

71. **ADR-0030 §Credential semantics:279-280** — "The current claim response reveals the Task's reusable stored forge PAT. It is not minted for one Claim, and lease expiry cannot revoke it on the forge."
72. **ADR-0030 §Credential semantics:282-283** — "This design therefore changes misleading wording from \"one-shot 24-hour token\" to \"repository credential revealed on claim\"."
73. **ADR-0030 §Credential semantics:283-284** — "Release and expiry revoke Kaola Tasks lifecycle authority and Claim fencing only."
74. **ADR-0030 §Credential semantics:284-285** — "True per-Claim credential mint/revoke is a separate future capability and is not a hard gate for this integration."

**§Ordered delivery issues (lines 307–321)**

75. **ADR-0030 §Ordered delivery issues:309-310** — "The issue number is an identifier, not execution order. Deliver in this dependency order; each Issue has its own focused proof and can be accepted without relying on prose from a later Issue:" followed by the ordered list #36 → #31 → #32 → #33 → #34 → #35 with "after" dependency annotations (line 313: #31 "after #36"; line 314: #32 "after #36 and #31"; line 315: #33 "after #36, #31 and #32"; line 316: #34 "after #32 and #33"; line 317: #35 "after #36 and #31–#34").
76. **ADR-0030 §Ordered delivery issues:319-321** — "This design Issue is complete when the decision and independently verifiable delivery backlog are frozen. Product completion is owned by #36, #31, #32, #33, #34 and finally #35; closing #30 does not imply that those implementation Issues have passed."

**§Non-goals (lines 323–329)**

77. **ADR-0030 §Non-goals:325** — "Server-side Agent, Workflow, Runner, tmux, git, or worktree execution."
78. **ADR-0030 §Non-goals:326** — "Changes to Kaola Workflow or Kaola Project Runner."
79. **ADR-0030 §Non-goals:327** — "Multi-Task or bundle Claim semantics."
80. **ADR-0030 §Non-goals:328** — "A third copy of Workflow phases, Mission state, Runner output, or completion truth."
81. **ADR-0030 §Non-goals:329** — "Per-Claim forge credential minting or revocation."

---

## 2. Parent #30 acceptance checklist

DESIGN §15 itself carries no acceptance checklist; it points to ADR-0030 and Issue #30. The one
acceptance checklist that exists is ADR-0030's `## Acceptance contract` (lines 287–306),
reproduced verbatim, item for item, with its anchor:

- **ADR-0030 §Acceptance contract:289** — "Keep exactly six MCP tools; add no Claim aggregate table, binding table, or coordinator service."
- **ADR-0030 §Acceptance contract:290** — "A normal claim defaults to direct Workflow and performs zero Runner calls."
- **ADR-0030 §Acceptance contract:291-292** — "An explicit Runner request operates only the named exact runtime/session; the current Agent stays controller/monitor."
- **ADR-0030 §Acceptance contract:293** — "Workflow and Runner repositories receive no Kaola Tasks dependency or modification."
- **ADR-0030 §Acceptance contract:294** — "Replaying one request id 100 times produces one active lease and one Task transition."
- **ADR-0030 §Acceptance contract:295** — "A stale Claim or different device cannot heartbeat, release, or submit a newer Claim."
- **ADR-0030 §Acceptance contract:296-297** — "Failure injection at each claim/release/expiry/submit write boundary leaves all-before or all-after state only."
- **ADR-0030 §Acceptance contract:298** — "Claim response loss and bridge/server restart recover the same active Claim."
- **ADR-0030 §Acceptance contract:299** — "Direct and Runner paths settle into the same Task, lease and submission facts."
- **ADR-0030 §Acceptance contract:300** — "A created PR/MR is reused; retries produce no second PR and no second submission."
- **ADR-0030 §Acceptance contract:301-302** — "Secret scans find no forge token in bridge receipts, Workflow state, Mission List, Runner frame/capture, git remote/config, logs, or events."
- **ADR-0030 §Acceptance contract:303** — "Workflow/Runner capability observations remain advisory rather than version hard gates."
- **ADR-0030 §Acceptance contract:304-305** — "Shared lifecycle tests cover GitHub, GitLab and Gitea behavior; live-provider acceptance records only environments actually executed."

All 13 checklist items above are the complete and only text of the ADR's `## Acceptance contract`
section (the checklist markers `- [ ]` were stripped for reproduction here; the source uses
GitHub-style unchecked checkboxes on every one of these 13 lines).

No further acceptance list exists in either source document (DESIGN.md has no independent §15
checklist; it names #36/#31/#32/#33/#34/#35 as the execution/acceptance chain but does not restate
criteria beyond referring to ADR-0030 and Issue #30).

---

## 3. Public-contract surfaces named

### REST endpoints

- `POST /api/v1/tasks/:publicId/claim` → `201` with top-level `token` (named directly in
  DESIGN.md:173, DESIGN.md:176, DESIGN.md:194, DESIGN.md:288; and referenced generically by
  ADR-0030 §Mutations:123 as "REST claim/progress/release mirror" and §Credential
  semantics:279 as "the current claim response").
- ADR-0030 states a "REST claim/progress/release mirror uses the same fields and semantics" for
  `claim_id` (ADR-0030 §Mutations:123-124) but does **not** name the exact REST route paths for
  the progress/release mirror endpoints in §15 or the ADR text itself — **not addressed** at the
  exact-path level by these two documents (DESIGN.md's broader body, outside §15, names other
  REST routes such as `POST /api/v1/tasks`, `POST /api/v1/tasks/import`,
  `GET /api/v1/credential-profiles/:id/issues`, but those are not part of the frozen §15/ADR-0030
  Claim-compatibility surface under review here).
- ADR-0030 §Mutations:124 states explicitly: "`submit_pr` remains MCP only" — i.e. no REST mirror
  for `submit_pr` is declared.

### MCP tool names and fields

The six MCP tools, confirmed identically in DESIGN §9 (lines 257–264) and ADR-0030
§Existing MCP surface stays intact:53-61 ("The public tool inventory remains exactly six:
`list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `release_task`, `submit_pr`"):

| Tool | Parameters (DESIGN §9, table row) | ADR-0030 additive fields |
|---|---|---|
| `list_tasks` | `status?`, `tags?`, `forge?` | none |
| `get_task_brief` | `task_id` | none |
| `claim_task` | `task_id`, `autonomous?` | **additive**: `request_id` (optional request field, ADR-0030 §Claim:80-92) |
| `report_progress` | `task_id`, `note` | **additive**: `claim_id` (ADR-0030 §Mutations:119) |
| `submit_pr` | `task_id`, `pr_url`, `summary` | **additive**: `claim_id` (ADR-0030 §Mutations:119; sequence example ADR-0030 §Default direct Workflow path:207 shows `submit_pr(task_id, claim_id, pr_url, summary)`) |
| `release_task` | `task_id`, `reason` | **additive**: `claim_id` (ADR-0030 §Mutations:119) |

`claim_task` success envelope (DESIGN.md §9 line 255, §7 line 194, confirmed unchanged in shape by
ADR-0030 §Claim:94): top-level `{ task, token, lease, clone }`. ADR-0030 declares only `lease`
gains new fields, **additively**:

- `lease.claim_id` (string, "opaque" public encoding of the existing lease row — ADR-0030
  §Claim:94-107)
- `lease.expires_at` (ISO datetime, ADR-0030 §Claim:94-104 example)
- `lease.ttl_seconds` (ADR-0030 §Claim:94-104 example)

ADR-0030 §Claim:94 states explicitly: "The successful top-level envelope remains
`{ task, token, lease, clone }`. Only `lease` gains an additive identity" — i.e. `task`, `token`,
and `clone` shapes are declared unchanged/frozen by this ADR; only `lease` is declared additive.

**Implementation-state note (observation, not part of the frozen design text):** a grep of
`apps/server/src/schema.ts` and `apps/server/src/mcp.ts` in this worktree shows the `leases` table
has no `request_id` column and the MCP tool `inputSchema` for `claim_task` has no `request_id`
field (`apps/server/src/schema.ts:99-110`, `apps/server/src/mcp.ts:114-121`) — i.e. as of this
commit the ADR-0030 additive fields described above are not yet implemented. This is an
observation about current code state, not a restatement of the design contract; it is included
because §3 asks which fields the design declares additive, and confirming their absence in the
current schema/tool registration is directly relevant to that question.

### DB tables/columns named as frozen or additive

DESIGN §10 (lines 268–283) names the existing tables `users`, `claimants`, `devices`,
`agent_keys`, `credential_profiles`, `tasks`, `leases`, `claim_confirmations`, `submissions`,
`events`, with the `leases` row listed as: "`leases` | task_id、claimer 为 `claimer_user_id` 或
`claimer_claimant_id`、**`device_id`**、claimed_at、expires_at、last_heartbeat、state" (DESIGN.md:278).

ADR-0030 §Database changes (lines 139–152) declares these additive changes, reusing existing rows
rather than adding a new table:

- add nullable `request_id` to `leases` (ADR-0030 §Database changes:143)
- add a unique index for non-null `(device_id, request_id)` (ADR-0030 §Database changes:144)
- expose the lease's stable public `claim_id` "without a new Claim table" (ADR-0030 §Database
  changes:145) — i.e. `claim_id` is declared to be an encoding/exposure of the existing lease row,
  not necessarily a new stored column
- add a unique index on `submissions.lease_id` (ADR-0030 §Database changes:146)
- add `claim_id` to relevant `events.details` rather than a new event foreign-key schema (ADR-0030
  §Database changes:147)

ADR-0030 explicitly rules out a new "Claim aggregate table, execution-binding table, coordinator
service" (ADR-0030 §Why this is the minimum:32-33, restated in §Acceptance contract:289).

### Status values (task lifecycle, Chinese canonical values)

From DESIGN §5 (lines 79–100), the state machine names these Chinese status values:
`待认领`, `进行中`, `待验收`, `已完成`, `已退回`, `已取消`. §15/ADR-0030 do not redefine this
machine; ADR-0030 references only `待认领` directly, at §Heartbeat and recovery:264 — "normal
lease expiry returns the Task to `待认领`" — consistent with DESIGN §5's existing transition
"进行中 --> 待认领: 租约过期 / release_task" (DESIGN.md:85). No new status value is introduced by
§15 or ADR-0030.

---

## 4. Token/credential semantics

Exact quotes on how the forge credential is revealed, through which channels, and what lease
expiry does and does not revoke.

**Reveal channel (DESIGN §7, line 173):**

> "**认领时揭示（reveal-on-claim）**：token 只在 REST `POST /api/v1/tasks/:publicId/claim` `201` 与 MCP `claim_task` 成功时下发给认领 Agent；`list_tasks` / `get_task_brief` / 会话 GET 列表与详情 / `POST /api/v1/tasks/import` `200` 永不含 token。"

**Two credential classes kept separate, forge-token reveal channel restated (DESIGN §7, line 175-176):**

> "**Forge token**：仍只在 REST `POST /api/v1/tasks/:publicId/claim` `201` 顶层 `token` 与 MCP `claim_task` 成功顶层 `token` 揭示（见上条「认领时揭示」）。两条通道以外的会话 GET、import `200`、档案列 Issue、设备待授权 `202`、#16 `confirmation_required` `202` 均不含 forge token。"

**Lease-expiry wording in DESIGN §5, line 99 (the wording ADR-0030 later flags as needing
correction — see below):**

> "**认领即租约**：默认 TTL 建议 24h（可按任务配置）。Agent 通过 `report_progress` 心跳续约；租约过期自动回到"待认领"，并撤销该次 token 揭示的有效性记录。"

This sentence says lease expiry "撤销该次 token 揭示的有效性记录" — literally, revokes the
*validity record of that token reveal* (a Kaola-side audit/tracking artifact), not explicitly the
forge token itself. DESIGN.md does not, in this sentence or elsewhere in §5, claim the forge-side
token is revoked. This is flagged as a drift candidate in §5 below because it uses 撤销 in close
proximity to "token 揭示" and could be misread; ADR-0030 addresses the ambiguity directly (next
quote).

**ADR-0030 §Credential semantics (lines 279–285) — the authoritative correction:**

> "The current claim response reveals the Task's reusable stored forge PAT. It is not minted for one Claim, and lease expiry cannot revoke it on the forge."

> "This design therefore changes misleading wording from \"one-shot 24-hour token\" to \"repository credential revealed on claim\"."

> "Release and expiry revoke Kaola Tasks lifecycle authority and Claim fencing only. True per-Claim credential mint/revoke is a separate future capability and is not a hard gate for this integration."

**Net normative statement (both documents read together):** the forge PAT/token revealed on claim
is a reusable, stored repository credential; it is not minted per-Claim; lease release/expiry only
revokes Kaola Tasks' own lifecycle authority and Claim fencing (i.e., the lease/claim stops being
valid inside Kaola Tasks, and the task returns to `待认领`) — it does **not** revoke, invalidate, or
rotate the credential on the forge side. Per-Claim mint/revoke of the credential is named as a
separate, not-yet-built, future capability and explicitly not a gate for the #36/#31/#32/#33/#34/#35
delivery series (ADR-0030 §Credential semantics:284-285, restated in DESIGN.md:359 and
ADR-0030 §Non-goals:329).

**Not addressed:** neither DESIGN §15 nor ADR-0030 specifies exactly how or whether Kaola Tasks
communicates this "still-valid-on-forge" fact to the Agent or the publisher at expiry time (e.g.,
no UI/audit-message wording is prescribed beyond the audit event types already in DESIGN §10
line 281, `事件`/`events.type` "token 揭示" etc.). That is left unaddressed by these two documents.

---

## 5. Documentation drift candidates

Full-repo search (this worktree, commit df98907) across `README.md`, `docs/*.md`, `apps/**/*.ts`,
`CHANGELOG.md`, `AGENTS.md` for: `一次性`, `one-shot`, `撤销`, `24 小时`/`24h`, `revoke` (and
`Revoke`), plus `short-lived`/`短期` (no hits for the latter two terms).

Commands run:

```
grep -rn -e '一次性' -e 'one-shot' -e 'one shot' -e 'oneshot' -- README.md CHANGELOG.md AGENTS.md docs apps
grep -rn -e '撤销' -e 'revoke' -e 'Revoke' -- README.md CHANGELOG.md AGENTS.md docs apps
grep -rn -e '24 小时' -e '24小时' -e '24h' -e '24-hour' -- README.md CHANGELOG.md AGENTS.md docs apps
grep -rn -e 'short-lived' -e '短期' -e 'short lived' -- README.md CHANGELOG.md AGENTS.md docs apps
```

### Direct drift: wording matching the exact phrase ADR-0030 flags as misleading

ADR-0030 §Credential semantics:282-283 explicitly names the wording to retire: `"one-shot
24-hour token"` → `"repository credential revealed on claim"`. These hits reproduce that same
shape of claim ("token is one-shot" and/or paired with a 24-hour figure) outside the ADR itself:

- **`README.md:30`** — "4. 管理员在工作台 **电脑** 页把 **待授权电脑** 绑到自己或 **认领者**。已绑定后 `claim_task` 才拿到一次性仓库令牌（默认 24 小时）。"
  — calls the claim-revealed forge token "一次性仓库令牌（默认 24 小时）" (a one-shot repository
  token, default 24 hours). This directly mirrors the flagged "one-shot 24-hour token" phrasing.
- **`apps/server/src/mcp.ts:117`** — `description: \`Claim a task and receive a one-shot forge token. ${CLONE_TOKEN_USAGE} ...\`` — the live `claim_task` MCP tool description string shipped to Agents literally says "receive a one-shot forge token." This is the exact English phrase ADR-0030 says should change, and it is in the runtime-facing tool description (ADR-0030 §Existing MCP surface stays intact:72 calls this "the static `claim_task` description" that "state[s] this default" — i.e. this is a document ADR-0030 itself expects to carry compatibility-relevant wording).

### Same-search hits that are a different concept (single-task inline credential, not lease-expiry revocation)

DESIGN §7 (line 168) and §6 (line 151) use "一次性 token" / "inline" to mean a *publisher-supplied,
task-specific credential that overrides a shared credential profile* — a different concept from
"the claim-revealed token is only usable once." These are literal hits for the search term but are
not the same claim ADR-0030 is correcting; included for completeness and flagged as such:

- **`docs/DESIGN.md:168`** — "…也允许发布者为某个任务粘贴一次性 token（覆盖档案）。" (a publisher may
  paste a one-off token for a single task, overriding the shared profile — this is about credential
  *scope/reuse*, not about how many times the *revealed* token may be used after claim.)
- **`README.md:58`** — "「发布」栏：自有任务填标题和说明；从 Issue 导入则点「导入」。共享档案会带出仓库，导入时从下拉选 Issue；一次性 token 仍手填仓库。分支和目录在「高级」里。" — same inline/one-off-credential concept as above, in the publish-form walkthrough.

### `24 小时` / `24h` hits

- **`README.md:30`** — already quoted above (paired with "一次性仓库令牌").
- **`docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md:282`** — "This design therefore changes misleading wording from \"one-shot 24-hour token\" to \"repository credential revealed on claim\"." — this is the ADR's own quoting of the wording it is retiring; it is the correction itself, not drift.
- **`docs/DESIGN.md:99`** — "**认领即租约**：默认 TTL 建议 24h（可按任务配置）。…" — this states the lease TTL default is 24h; read alone this is about lease TTL, not directly a claim that the forge token itself is 24-hour-lived. Flagged for completeness because it co-occurs with the 撤销 wording quoted in §4 above.
- **`docs/DESIGN.md:348`** — "**待定**：租约 TTL 默认值（暂定 24h）；…" — lease TTL default still marked "TBD/tentative," about lease TTL only, not forge-token lifetime.

### `撤销` / `revoke` / `Revoke` hits

The bulk of these hits are about **device**, **claimant**, **user**, or **Agent Key** revocation
(an unrelated, legitimate identity/session-revocation feature), or about the credential-profile
deletion flow that *manually* prompts an operator to go revoke the token on the forge side
(consistent with ADR-0030 — Kaola Tasks does not itself revoke the forge-side token). Listed in
full per the search requirement, then classified:

**Relevant to forge-token/lease-expiry revocation semantics (the concept ADR-0030 addresses):**

- **`docs/DESIGN.md:99`** — already quoted in full in §4 above: "…租约过期自动回到"待认领"，并撤销该次 token 揭示的有效性记录。" — the one hit in this repo that pairs 撤销 directly with "token 揭示" in the context of lease expiry; addressed and disambiguated in §4.
- **`docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md:280`** — "…and lease expiry cannot revoke it on the forge." — the ADR's own authoritative statement (not drift).
- **`docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md:283-284`** — "Release and expiry revoke Kaola Tasks lifecycle authority and Claim fencing only." — the ADR's own authoritative statement (not drift).

**Not relevant — device/claimant/user/session revocation (a different feature, not the forge token):**

- `docs/architecture.md:27` — "`/api/v1/agent-keys` leftover session mint/list/revoke (not MCP identity)"
- `docs/architecture.md:32` — "`POST /api/v1/devices/:id/revoke`"
- `docs/architecture.md:33` — "`/api/v1/claimants` GET list; POST :id/revoke; PATCH :id/settings"
- `docs/api.md:58` — "…`revoked` redirects `/login?reason=revoked`…"
- `docs/api.md:70` — "Session cookie. No session or `status` `待批准` / `revoked` → `sendUnauthorized`…"
- `docs/api.md:122` — "…`revoked` → `403` `{ error: 'forbidden' }`…"
- `docs/api.md:134` — "### `POST /api/v1/devices/:id/revoke`, claimants (#23)"
- `docs/api.md:136` — "`POST /api/v1/devices/:id/revoke` → `200` `{ ok: true }`, `events.type` `电脑解除`. … `POST /api/v1/claimants/:id/revoke` revokes the **认领者** and its devices…"
- `docs/api.md:164` — "`200` `{ ok: true, message: '请同时到 forge 侧撤销该 token。' }`…" (credential-profile delete: manual, out-of-band prompt — consistent with ADR-0030, not drift)
- `docs/api.md:401` — "…`status` `active` | `待批准` | `revoked`…"
- `docs/api.md:403` — "…`revoked` existing users redirect `/login?reason=revoked`."
- `docs/smoke-test.md:148` — "两家：撤销冒烟 PAT；项目 `kaola-tasks-smoke` 可删。" (manual smoke-test cleanup instruction, unrelated to product semantics)
- `docs/DESIGN.md:192` — "**解除立即生效**：解除认领者或解除电脑、将 `users.status` 置为 `revoked`，均在**下一次**请求生效。重新登录不得复活 `revoked`。"
- `docs/DESIGN.md:202` — "…档案页提供一键吊销（删除档案 + 提示去 forge 侧撤销）。" (manual, out-of-band prompt — not drift)
- `docs/DESIGN.md:272` — `users` table row, `revoked` enum value
- `docs/DESIGN.md:273` — `claimants` table row, `revoked` enum value
- `docs/DESIGN.md:274` — `devices` table row, `revoked` enum value
- `docs/DESIGN.md:298` — "重新登录不得复活 `revoked`。"
- `CHANGELOG.md:14` — device pairing/revoke changelog entry
- `CHANGELOG.md:46` — Agent Key generate/list/revoke changelog entry
- `CHANGELOG.md:47` — credential-profile delete message "请同时到 forge 侧撤销该 token。" (manual, not drift)
- `CHANGELOG.md:48` — web widget delete-profile copy referencing the same manual message
- `apps/web/src/App.devices.test.ts:4,487,489,492-494,499,505,507,514-516,522` — device/claimant revoke UI test assertions
- `apps/server/src/schema.ts:12,138,152` — `status` enum definitions including `revoked`
- `apps/server/src/devices.ts:269,276,301,308-309` — device/claimant revoke route handlers
- `apps/server/src/auth.test.ts:227,228,234-236,243-244,247,254,256` — "revoked re-login" test suite (user status)
- `apps/web/src/App.vue:463,467,543,547,582,843` — device/claimant revoke UI bindings; credential-profile delete manual-revoke copy constant
- `apps/server/src/credential-profiles.ts:15` — same manual-revoke copy constant
- `apps/server/src/agent-keys.test.ts:437,489-499,608,609,632-634,650-652` — Agent Key revoke test suite
- `apps/server/src/device-proof.ts:223,245` — device/claimant `revoked` status checks in the device-proof hook
- `apps/server/src/vault.test.ts:12,443` — same manual-revoke copy constant, test assertion
- `apps/server/src/auth.ts:217-218,585` — user `revoked` status redirect/gate logic
- `apps/server/src/devices.test.ts:667,670,676,681,683,688-689,692,697,700,708-710,715-716,719` — device/claimant revoke test suite

### `short-lived` / `短期` / `one-shot`(alt spellings) / `oneshot`

No hits found anywhere in the searched paths.

---

## Summary of what this extract found

- Two direct-drift hits reproduce the exact "one-shot [24-hour] token" framing ADR-0030 names as
  misleading and instructs be retired: the end-user-facing `README.md:30`, and — more
  significantly, because it is live, runtime-facing product text an Agent reads on every claim —
  the `claim_task` MCP tool description string in `apps/server/src/mcp.ts:117`.
- One ambiguous-but-not-directly-contradictory hit, `docs/DESIGN.md:99`, pairs 撤销 with "token
  揭示" in the lease-expiry sentence; it is defensible as written (it revokes the *reveal record*,
  not the token) but sits exactly in the spot ADR-0030's correction targets, and is worth a
  reviewer's attention when #33/#35 touch that sentence.
- Two `一次性 token` hits (`docs/DESIGN.md:168`, `README.md:58`) are a different, legitimate
  concept (single-task inline credential override) and are not the drift ADR-0030 is correcting.
- All other `撤销`/`revoke` hits are device/claimant/user/Agent-Key identity revocation or manual
  forge-side-revoke prompts, unrelated to the forge-token-reveal-and-expiry semantics ADR-0030
  addresses.
