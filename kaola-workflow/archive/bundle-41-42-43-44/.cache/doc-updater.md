# Documentation update — bundle-41-42-43-44

Status: DOCKED

Custody: run owner, inline. Every claim below was transcribed from the real diff and verified against the
code; two were verified specifically because an earlier draft of one of them was wrong (see doc-docking).

## Files checked and changed

- `docs/smoke-test.md:151` — this IS issue #42's deliverable. Rewritten from "先把那条任务取消或走完到
  `已完成`/`已取消`" (which presented two paths as freely interchangeable) to a per-state statement of what
  is actually available. Verified against code, not assumed: `已取消` is reachable only from `待认领` /
  `已退回` (`tasks.ts` `POSTER_TRANSITIONS`); lease expiry moves `进行中` -> `待认领`
  (`leases.ts:149-154`); `LEASE_TTL_SECONDS = 86400` (`leases.ts:9`); and a `待验收` task's lease is
  ALREADY released inside `submitPr`'s transaction (`claim.ts:824` `markLeaseReleased`), so it has no
  expiry left to wait for.
- `CHANGELOG.md` — four new `## Unreleased` entries (#44, #43, #42, #41) in the existing per-issue Chinese
  prose style. The #43 entry deliberately records that the ORIGINAL diagnosis was wrong and what the real
  mechanism turned out to be, rather than describing the fix as if the first theory had held.

## No-impact, checked and deliberately not changed

- `docs/api.md`, `docs/architecture.md`, `docs/DESIGN.md`, `docs/workflow-default.md` — this bundle changes
  no public HTTP/MCP contract, no schema, no adapter behavior, and no Claim/Workflow semantics. #41 is a
  client-side rendering fix, #43 is test-only, #44 is an additive non-fatal diagnostic, #42 is itself a
  doc fix. Nothing in those four documents became false.
- `README.md`, `docs/conventions.md`, `docs/runner-carrier.md`, `docs/decisions/0030-*.md` — unaffected.
