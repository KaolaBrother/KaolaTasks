# Claim MCP lifecycle with default Workflow and optional Project Runner

Status: accepted  
Issue: https://github.com/KaolaBrother/KaolaTasks/issues/30

## Decision

Kaola Tasks owns the Claim lifecycle and a one-way compatibility layer for two independently
versioned external repositories:

- Kaola Workflow is the default engineering protocol after every successful claim.
- Kaola Project Runner is an optional CLI carrier used only when the user explicitly asks for it.
- Workflow and Runner do not import, call, or know about Kaola Tasks.

The server remains routing and coordination only. It never starts an Agent, Workflow, Runner, tmux,
git process, or local worktree. Compatibility is split between the existing MCP lifecycle contract,
the local `kaola-mcp` bridge, and Agent-facing instructions owned by Kaola Tasks.

## Why this is the minimum

The current system already has all durable authorities needed for the lifecycle:

```text
Task status  — product lifecycle authority
Lease        — active Claim attempt and expiry
Events       — audit and progress history
Submission   — PR/MR settlement
Workflow     — issue/worktree/Mission/finalize state
Runner       — exact CLI transport session
```

The design therefore adds no Claim aggregate table, execution-binding table, coordinator service,
`get_claim` tool, or `bind_execution` tool. It does not copy Workflow phases, Mission List content,
Runner transcripts, or runtime capability state into Kaola Tasks.

## Dependency direction

```text
KaolaTasks MCP + local compatibility instructions
                    |
             current MCP Agent
              /             \
    Kaola Workflow       Project Runner
       default          explicit carrier only
```

Knowledge flows outward only. Changes in an external interface are absorbed by Kaola Tasks'
compatibility instructions and observations; they do not create a dependency in either external
repository.

## Existing MCP surface stays intact

The public tool inventory remains exactly six:

```text
list_tasks
get_task_brief
claim_task
report_progress
release_task
submit_pr
```

No execution-mode or Runner field is added to the server contract. The server neither needs nor
uses that information. The MCP-connected Agent receives the user's instruction and selects the
carrier locally:

- no explicit Runner request: use Workflow directly;
- explicit Runner request: use that exact Runner/runtime and remain its controller/monitor;
- no silent carrier switch in either direction.

The static `claim_task` description and Kaola Tasks-owned client instructions state this default.
Workflow or Runner availability is observed locally and reported as evidence, not submitted to the
server as lifecycle state.

## Minimal Claim protocol additions

### Claim

`claim_task` adds one optional request field:

```json
{
  "task_id": "kt-2026-0142",
  "autonomous": false,
  "request_id": "7f5dfaa4-5c57-4f35-aab4-1fd37ce16db2"
}
```

The local bridge generates and durably records `request_id` before forwarding the first attempt.
Existing callers may omit it during compatibility rollout and retain their existing behavior. New
clients always send it.

The successful top-level envelope remains `{ task, token, lease, clone }`. Only `lease` gains an
additive identity:

```json
{
  "lease": {
    "claim_id": "clm_opaque",
    "expires_at": "2026-09-01T06:00:00.000Z",
    "ttl_seconds": 86400
  }
}
```

The existing lease row is the Claim attempt. `claim_id` is its public opaque encoding; no parallel
record is introduced. The lease stores the request id and has a unique device/request identity.

For the same task, device and request id:

- an active replay returns the same Claim identity and reconstructs the same success envelope;
- token re-reveal stays inside the existing REST/MCP claim endpoint and is audited as a replay;
- a terminal replay returns that Claim's terminal result and never creates a new lease;
- a different request id is a new attempt only when the Task is legally claimable.

### Mutations

`report_progress`, `release_task`, and `submit_pr` add `claim_id`. The server matches Task, active
lease, owner, exact device, and Claim identity. A stale Claim cannot renew, release, or submit a
newer attempt.

The REST claim/progress/release mirror uses the same fields and semantics. `submit_pr` remains MCP
only.

Compatibility rollout accepts an omitted `claim_id` only for a legacy active lease whose
`request_id` is null, deriving that lease for the same exact device. A new-style lease with a
non-null request id requires `claim_id`; omission returns `claim_id_required`. New bridge calls
always send it. Because Runner never receives the device key or calls Kaola MCP, it cannot mutate a
Claim directly.

### Idempotent terminal operations

- Repeating release for the same already released Claim returns the same released result.
- Repeating submit for the same Claim and PR URL returns the existing submission.
- Reusing that submission operation with a different PR URL returns conflict.
- An operation against an older Claim returns `stale_claim` without changing Task state.

## Database changes

Reuse the current lease and submission rows:

- add nullable `request_id` to `leases` for rolling compatibility;
- add a unique index for non-null `(device_id, request_id)`;
- expose the lease's stable public `claim_id` without a new Claim table;
- add a unique index on `submissions.lease_id`;
- add `claim_id` to relevant event details rather than creating an event foreign-key schema.

An active Claim must retain access to the credential it originally revealed. A credential profile
referenced by an active Claim cannot be deleted or replaced until that Claim is terminal; inline
credential bytes remain on the Task as today. This lets an active replay re-decrypt the same
credential without copying another encrypted token into the lease.

Every lifecycle transition is one SQLite transaction:

- claim: approved-confirmation consumption when applicable, Task compare-and-swap, lease insert,
  token-reveal audit, and status-transition audit;
- heartbeat: conditional active-lease renewal and heartbeat audit;
- release: conditional lease terminal state, Task transition, and audit;
- expiry sweep: conditional lease expiry, Task transition, and audit;
- submit: conditional lease terminal state, Task transition, unique submission, and audit.

Forge comment writeback runs only after commit and uses the existing retry path. A remote comment is
not allowed to delay or decide the Claim response, and no new outbox table is required for this
scope.

## Local bridge receipt

The bridge persists the smallest recovery receipt under its existing `KAOLA_HOME` boundary:

```json
{
  "v": 1,
  "server": "origin-digest",
  "task_id": "kt-2026-0142",
  "request_id": "7f5dfaa4-5c57-4f35-aab4-1fd37ce16db2",
  "claim_id": "clm_opaque",
  "repo_identity": "github/owner/repo",
  "carrier": "direct",
  "runner": null,
  "runner_session": null
}
```

It contains no forge token, HTTP header, Task description, prompt, Workflow content, Runner frame,
or transcript. A pending receipt is written before the first Claim request; the response fills in
`claim_id`. After a bridge or server restart, replaying the same request id recovers the same active
Claim.

Carrier defaults to `direct`. When the user explicitly requests Runner, the Kaola Tasks-owned local
compatibility instruction changes only the local receipt to `carrier: "runner"`, records the named
runtime, and fills the exact session locator after start. The server never receives these fields.
Workflow state is rediscovered from the target repo; Runner identity is verified against the exact
recorded session rather than inferred from prose.

## Default direct Workflow path

When the user does not explicitly request Runner:

```text
get_task_brief
claim_task(request_id)
secure clone from the existing clone envelope
Workflow startup or resume
Mission List execution and report_progress heartbeats
Workflow finalization and PR/MR sink
submit_pr(task_id, claim_id, pr_url, summary)
```

This path performs zero Project Runner calls. The current Agent owns Claim control, Workflow
execution, validation, and settlement.

For an imported Task, `source.issue_url` is the Workflow issue target. For a native Task, the Agent
uses an issue-less Workflow project named from the Task id; Kaola Tasks does not silently create a
forge Issue. The sink is PR/MR because Task acceptance is based on `submit_pr` and remote review.

## Explicit Project Runner path

When the user explicitly names a Project Runner runtime:

```text
get_task_brief
local advisory observation of Workflow and the requested Runner
claim_task(request_id)
secure clone and Workflow startup
start the exact Runner session in the Workflow worktree
target CLI resumes and executes the Workflow Mission List
current Agent monitors Git and Workflow evidence and sends Claim heartbeats
current Agent performs credential-bearing push and PR/MR settlement
submit_pr(task_id, claim_id, pr_url, summary)
stop only the exact Runner session
```

The current Agent remains the controller and monitor. Project Runner remains transport-only. The
forge token is never sent through a prompt or Runner input and is never placed in its environment,
frame, capture, or transcript.

If the requested Runner is unavailable, the compatibility layer reports the observation. It does
not silently switch to direct execution, reject the Claim by version allowlist, or manufacture a
successful Runner receipt. The Agent decides, from actual work state and user intent, whether to
retry, ask for a different carrier, continue directly with explicit approval, or safely release.

## Advisory compatibility, not hard gates

Local observations may include Workflow availability, Runner binary/version, exact session,
worktree, Git state, and PR receipt. They are evidence for Agent judgment. They are not persisted as
server policy and do not block Claim merely because:

- a version is absent from an allowlist;
- an optional capability cannot be detected;
- a runtime uses a new but observable interface;
- Workflow or Runner returns prose instead of a preferred typed hint.

Correctness and security invariants still fail closed: device authorization, legal Task transition,
token decryption, exact Claim/device fencing, transaction integrity, and PR repository identity.
These are not compatibility gates.

## Heartbeat and recovery

- The Task server remains the only live lease authority.
- The controlling Agent calls `report_progress`; Runner and Workflow do not learn Kaola MCP.
- Heartbeat cadence is advisory and derived from the returned TTL; mission transitions and pre-sink
  checks are useful opportunities, but no extra scheduler service is introduced.
- If the controller stops permanently, normal lease expiry returns the Task to `待认领`.
- A bridge/server response-loss window recovers through the local request receipt and idempotent
  Claim replay.
- Workflow interruption recovers from `workflow-state.md` and `mission-list.md`.
- Runner interruption recovers through its exact repo/session identity.

Compensation follows the work, not process exit codes:

- before durable work: clean the external attempt, then release the Claim;
- after work exists: preserve repo, Workflow state and Claim; never auto-discard;
- after PR/MR creation: forward-only recovery—reuse the same remote PR and retry `submit_pr`;
- never create a second PR merely because a local receipt write or MCP response was uncertain.

## Credential semantics

The current claim response reveals the Task's reusable stored forge PAT. It is not minted for one
Claim, and lease expiry cannot revoke it on the forge.

This design therefore changes misleading wording from "one-shot 24-hour token" to "repository
credential revealed on claim". Release and expiry revoke Kaola Tasks lifecycle authority and Claim
fencing only. True per-Claim credential mint/revoke is a separate future capability and is not a
hard gate for this integration.

## Acceptance contract

- [ ] Keep exactly six MCP tools; add no Claim aggregate table, binding table, or coordinator service.
- [ ] A normal claim defaults to direct Workflow and performs zero Runner calls.
- [ ] An explicit Runner request operates only the named exact runtime/session; the current Agent stays
  controller/monitor.
- [ ] Workflow and Runner repositories receive no Kaola Tasks dependency or modification.
- [ ] Replaying one request id 100 times produces one active lease and one Task transition.
- [ ] A stale Claim or different device cannot heartbeat, release, or submit a newer Claim.
- [ ] Failure injection at each claim/release/expiry/submit write boundary leaves all-before or
  all-after state only.
- [ ] Claim response loss and bridge/server restart recover the same active Claim.
- [ ] Direct and Runner paths settle into the same Task, lease and submission facts.
- [ ] A created PR/MR is reused; retries produce no second PR and no second submission.
- [ ] Secret scans find no forge token in bridge receipts, Workflow state, Mission List, Runner
  frame/capture, git remote/config, logs, or events.
- [ ] Workflow/Runner capability observations remain advisory rather than version hard gates.
- [ ] Shared lifecycle tests cover GitHub, GitLab and Gitea behavior; live-provider acceptance records
  only environments actually executed.

## Ordered delivery issues

The issue number is an identifier, not execution order. Deliver in this dependency order; each
Issue has its own focused proof and can be accepted without relying on prose from a later Issue:

1. [#36 — Claim identity and atomic acquisition](https://github.com/KaolaBrother/KaolaTasks/issues/36)
2. [#31 — Fenced transactional mutations](https://github.com/KaolaBrother/KaolaTasks/issues/31), after #36
3. [#32 — Secret-free local recovery receipt](https://github.com/KaolaBrother/KaolaTasks/issues/32), after #36 and #31
4. [#33 — Default direct Workflow path](https://github.com/KaolaBrother/KaolaTasks/issues/33), after #36, #31 and #32
5. [#34 — Explicit Project Runner carrier](https://github.com/KaolaBrother/KaolaTasks/issues/34), after #32 and #33
6. [#35 — End-to-end parity and recovery proof](https://github.com/KaolaBrother/KaolaTasks/issues/35), after #36 and #31–#34

This design Issue is complete when the decision and independently verifiable delivery backlog are
frozen. Product completion is owned by #36, #31, #32, #33, #34 and finally #35; closing #30 does
not imply that those implementation Issues have passed.

## Non-goals

- Server-side Agent, Workflow, Runner, tmux, git, or worktree execution.
- Changes to Kaola Workflow or Kaola Project Runner.
- Multi-Task or bundle Claim semantics.
- A third copy of Workflow phases, Mission state, Runner output, or completion truth.
- Per-Claim forge credential minting or revocation.
