candidate: working tree README diff (32 lines)
surface: README.md

Reviewed the complete README candidate in context against docs/DESIGN.md sections 9, 15 and 17, docs/workflow-default.md, docs/runner-carrier.md, docs/smoke-test.md, and relevant MCP, task, review, poller, browser and smoke implementation paths.

No candidate-caused defects admitted. The added claims correctly scope mandatory Workflow to supplied external forge Issues, distinguish revision from reopened delivery, qualify restack state transitions, describe asynchronous ready retries, disclose head-check fallback and GitLab reporting lag, and separate smoke paths from actual OAuth and certificate-trust acceptance. The recent fallback login behavior is already described in the unchanged README. Historical wording drift in supporting documents is outside this review scope.

Validation was read-only source and contract inspection. No tests, live forge actions or UAT were run, as this candidate changes prose only.

verdict: pass
findings_blocking: 0
review_conclusion: The README candidate accurately summarizes the reviewed execution and acceptance boundaries without introducing a demonstrated defect.
