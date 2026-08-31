# Documentation update — bundle-37-38-39

Status: DOCKED

Custody: two `doc-updater` dispatches plus run-owner corrections. Every claim below was transcribed
from the real diff and re-verified by the run owner against the code; nothing was invented.

## Files checked and changed

- `docs/DESIGN.md` §15 (:356) — the frozen product-boundary bullet. Was "`claim_task` 成功后**默认**由当前
  MCP Agent 直接运行 Kaola Workflow". Now scopes to tasks carrying an external forge Issue, states the
  Agent 必须 start Workflow (强制要求，不再只是默认值), states the post-Workflow PR is 必须, and names the
  honest negative for a task with no Issue.
- `docs/api.md` — :11 dropped the deleted `workflow-target.ts` from the Sources enumeration; :286, :341,
  :395, :399-405 corrected so the write-back table shows 认领 and 提交PR as NOT awaited and 完成 as
  awaited; :523/:531/:533 document `timeoutMs` and the 10s `DEFAULT_TIMEOUT_MS`, corrected to the true
  5+1 split; :391/:395 document `WRITEBACK_TIMEOUT_MS = 30_000` with its rationale and its honest limit.
- `docs/architecture.md` — :118 and :124 corrected (both write-backs now off the response path); :124 also
  documents the 30s write-back deadline; :142 rewritten for #39 and scoped; :160 documents the adapter
  timeout and the 5+1 split, and lists the new shared spec.
- `docs/workflow-default.md` — the retired `issueless_project` / `available: false` /
  `advisory-unavailable` model removed entirely; the 目标映射 section rewritten; and the HEADLINE section
  (:1, :8-13) rewritten by the run owner after an adversarial verifier refuted it for simultaneously
  over-claiming scope and under-claiming the requirement.
- `CHANGELOG.md` — new `## Unreleased` entries for #37, #38, #39, plus the previously-undocumented
  `#36` migration ordering fix and `#34` mcp stderr fix. No historical entry was rewritten.

## No-impact, checked and deliberately not changed

- `README.md`, `docs/conventions.md` — grepped for every affected symbol; zero hits, no stale claim.
- `docs/smoke-test.md` — records real-run evidence and NO new smoke run was performed this round, so it
  must not be touched.
- `docs/decisions/0030-*.md` — historical decision record.
- Historical `#33`/`#39` CHANGELOG entries retain the retired term strings as RETROSPECTIVE description of
  what was retired; term scans cover live doc/instruction text only and remain green.
