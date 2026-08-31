# Documentation update — bundle-40-45

Status: DOCKED

## Files checked and changed

- `docs/api.md` — the substantive docking, because #40 genuinely CHANGES a documented contract.
  `:488` previously read "A failed attempt writes no event at all (retried later, not marked `ok: false`)",
  which the implementation makes false. It now states the exact `{ task_id, transition, ok: false,
  ambiguous }` shape, what `ambiguous` means, that the row is written ONLY when the outcome changes (so it
  cannot grow per tick against a sweep that retries forever), and why it exists. `:393` carries a
  cross-reference. A new "Ack-loss dedupe (#40)" section at `:395` documents the whole mechanism: the
  measured absence of comment idempotency on all three forges, `listIssueComments`, the DEFINITE/AMBIGUOUS
  split, the zero-listing-calls common path, the whole-array scan given Gitea's undocumented ordering, and
  the skip-don't-post degradation.
- `CHANGELOG.md` — new `## Unreleased` entries for #40 and #45 in the existing per-issue Chinese style.

## No-impact, checked and deliberately not changed

- `docs/DESIGN.md`, `docs/architecture.md`, `docs/workflow-default.md` — #40 adds an adapter capability and
  internal retry logic but changes no Claim/Workflow/PR contract, no schema, no MCP surface; #45 is a
  client-side rendering fix. Nothing in those became false.
- `docs/smoke-test.md` — records real-run evidence and NO smoke run was performed this round.
- `README.md`, `docs/conventions.md`, `docs/runner-carrier.md` — unaffected.
