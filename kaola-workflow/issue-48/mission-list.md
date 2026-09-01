# Goal

Deliver the two-mode Kaola MCP installation and certificate-trust onboarding contract, implementation, README guidance, and honest cross-platform evidence for Issue #48 without mixing the co-active Issue #46 branch or committing real deployment identifiers.

- item: Reconcile the merged Issue #46 TLS contract into this branch, then freeze the public-CA and private-CA installation, trust-bootstrap, privilege, removal, and rotation contract in DESIGN and README.
  status: done
  dispatched: Grok CLI via exact Runner session `grok-kaola-issue-48` → `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-48`; wait for Issue #46 dependency truth, then edit only the Issue #48 worktree and leave reviewable Git and validation evidence there.
  result: docs/DESIGN.md §16 and README.md「安装与证书信任」 freeze the two operator schemes only. Unimplemented CLI/state/storage contracts removed (no `kaola-mcp trust …`, no `KAOLA_HOME/trust/`, no state file). #46 still open; no copy of its worktree or server issuance. Public-CA = strict default trust, no extra CA, no `NODE_EXTRA_CA_CERTS`. Private-CA = every enrolled computer trusts the public root PEM; MCP-only `NODE_EXTRA_CA_CERTS` after `openssl x509 -fingerprint -sha256`; browser/system trust is a separate explicit elevation. First connection must not TOFU a server-returned CA. Restart, uninstall, rotation, leave-team, and migrate-to-public-CA are documented. Root private key is never distributed. Placeholders only (`<kaola-origin>`, `<dev-root-ca.pem>`, `<sha256-fingerprint>`). Installer/code/tests remain missions 2–3. Working-tree `git diff --check` exit 0; `pnpm lint` exit 0. Added-line scan of product docs `README.md` + `docs/DESIGN.md` vs a9de0fb: no SHA-256 hex, no `/Users/`, no PEM blocks, no DNS vendors; only pre-existing `127.0.0.1:31415` and public GitHub issue links. Workflow metadata (`kaola-workflow/issue-48/workflow-state.md` and this file's `dispatched` locator) retains standard Kaola Workflow absolute local custody paths and is excluded from the deployment-identifier scan.

- item: Implement the bounded MCP installation and trust-onboarding surfaces with fail-closed fingerprint or signature verification, explicit system-trust elevation, uninstall behavior, and focused automated acceptance.
  status: in-flight
  dispatched: Grok CLI via exact Runner session `grok-kaola-issue-48-impl` → Issue #48 worktree; production code, focused tests, operator documentation adjustments, and a reviewable commit must land only on `workflow/issue-48`, without touching the co-active Issue #46 worktree.

- item: Validate the frozen candidate with repository gates, secret and environment-identifier scans, independent security review, and only the macOS, Windows, Linux, browser, and MCP checks actually executed.
  status: todo
