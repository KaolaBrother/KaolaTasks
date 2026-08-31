# Design the minimal complete Claim MCP lifecycle that defaults to Kaola Workflow and optionally carries execution through Kaola Project Runner

- item: Re-measure the latest KaolaTasks, Workflow, and Runner contracts and correct every stale premise in Issue #30 without implementing product behavior.
  status: done
  dispatched: self — verify current source and installed external contracts; land the corrected findings in Issue #30 and this mission result
  result: Latest origin keeps six MCP tools; leases already have an internal id and submissions already bind leaseId. Corrected design direction: expose/reuse that identity and add request id/device fencing, but keep runner choice and execution warnings entirely in the local compatibility receipt rather than adding runner/execution fields to the server MCP contract. Workflow 10.2.1 treats typed observations as facts and Project Runner remains transport-only; the reusable-PAT versus lease distinction remains current.

- item: Produce the repository design artifact and make Issue #30 the complete implementation-ready backlog contract using subtraction-first, advisory compatibility semantics.
  status: done
  dispatched: self — write the frozen proposal under docs/decisions, dock its governing summary in docs/DESIGN.md, and replace Issue #30 body with the same corrected contract
  result: Complete proposal landed at docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md; docs/DESIGN.md v0.4 §15 freezes the product boundary; GitHub Issue #30 body now carries the identical implementation-ready contract and acceptance checklist.

- item: Validate the frozen design for lifecycle completeness, secret boundaries, external-repo independence, and absence of unnecessary tools, tables, services, or hard gates.
  status: done
  dispatched: self — audit the frozen docs and live Issue against measured code, run documentation and repository validation, and land the readiness verdict in this mission result
  result: PASS — diff check clean; the proposal names exactly the six existing tools, contains no actual forge-token pattern, adds no parallel service/table/tool, keeps compatibility observations advisory, and closes response-loss, exact-device fencing, transaction, credential-replay, direct/Runner recovery, and forward-only PR boundaries. Issue #30 matches the committed proposal byte-for-byte except GitHub's trailing newline. Both external repos remain clean.

- item: Decompose the frozen parent design into an ordered set of independently verifiable implementation Issues with explicit scope, dependencies, acceptance evidence, and non-goals.
  status: done
  dispatched: self — create the child Issues on GitHub, then add their ordered traceability map to the parent design document and Issue #30
  result: PASS — published six independently verifiable Issues in dependency order #36 → #31 → #32 → #33 → #34 → #35. Every Issue has Goal, Scope, 7–9 concrete acceptance checks, dependencies, and Non-goals; parent #30 and the accepted ADR carry the exact ordered map and state that closing the design does not imply product implementation. Remote parent body matches the ADR exactly; both external repositories remain clean.
