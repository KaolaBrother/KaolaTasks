# Acceptance walk — issue #60

Source delivery: 8b49640. Documentation docking: a9ed25d. Product bytes unchanged by docking (git diff 8b49640..a9ed25d only documentation).

- Fallback setup/login: four new auth tests prove form session/303, special-character encoding, one-time setup and wrong-password401; Safari initially415 and final real login returned administrator workbench.
- Contract boundaries: JSON setup201/login200 retained by existing identity suite; cross-Origin403 and unrelated taskAPI415 tested; independent security reviewer additionally checked413 and prototype-shaped input. Reviews both PASS with zero admitted findings.
- Actual evidence: Linux1053 PASS, Web165/166 initial then unchanged-file11/11 and full166/166; issue61 openP2 tracks unestablished root cause. Local lint/typecheck/build and auth/cookie25 rechecked during finalization. PR59 initial candidate CI twoSUCCESS, final publication CI will be observed by sink.
- Current mechanisms: docs/smoke-test.md captures eight states, ten tools, claim replay/fencing, multi-round resolution and revisions, drift reject and head_verified true/false distinction, parent/child claims and restack, SSE, termination/reopen/close, real GitLab/Gitea OAuth, new Linux and Mac device binding.
- Documentation: DESIGN/API/README/architecture/changelog/smoke docked; no new adapter/MCP/schema/environment variable surface. Final auth/test container SHA256 matched working source.
- Runtime cleanup: VPS unit/runtime/data/test packages removed; unrelated relay/RustDesk services active. Local service stopped. Local database11 terminal tasks and24 released leases;191 event rows scanned without real PAT/admin password.
- Scope: Windows, public-CA clean-client trust and individually induced VPS fault scenarios remain unexecuted, not part of this macOS/Linux GitLab/Gitea acceptance verdict. No invented human actions; owner explicitly authorized autonomous real UI/API operation in conversation.
- Lifecycle requirement: this document establishes readiness only; finalization summary and close/archive/sink receipts own archive/publication/cleanup truth.

Follow-up verification: gh issue view61 returned OPEN, labelP2, nonempty body_length1040. Duplicate probe query 'error-envelope task-message' had0 hits before filing. No claim on61.
