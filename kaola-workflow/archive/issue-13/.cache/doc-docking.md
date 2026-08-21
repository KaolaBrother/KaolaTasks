# doc-docking — issue #13

## Verdict: DOCKED

All doc surfaces enumerated in the mission (`README.md`, `CHANGELOG.md`, `CLAUDE.md` Project
Snapshot + Commands + token convention, `docs/api.md`, `docs/architecture.md`) now reflect the
implemented + R1-repaired webhook/poll-mode surface as it exists in the worktree at the time of
this pass, verified against source (`packages/forge-adapters/src/index.ts`, `apps/server/src/{app,
index,poller,webhook}.ts`, `package.json`) rather than against the ticket/handoff prose.

## Checklist

- [x] README.md status line, PR polling / webhook bullets, `FORGE_INSTANCES` env, milestone/roadmap
      closing paragraph — updated; #14 write-back explicitly still marked not done in every place
      that mentions M2.
- [x] CHANGELOG.md Unreleased — two #13 bullets prepended (forge-adapters, server), styled like the
      #11/#12 entries (real signatures, status codes, file names, measured gate numbers).
- [x] CLAUDE.md Project Snapshot, Commands test list (byte-for-byte matches the real
      `package.json` `test` script), `buildApp` options, token convention (webhook route is not a
      third reveal channel; poller still decrypts but never returns) — updated. File is 124 lines,
      under the 200-line guidance.
- [x] docs/api.md webhook HTTP section added; poller section rewritten to state it is one of two
      drivers, not the only one; adapter section confirms `registerWebhook`/`parseWebhook`
      implemented and documents the real per-forge mechanics.
- [x] docs/architecture.md component map, `buildApp` paragraph, poller-skip paragraph, new
      webhook-receiver paragraph, adapter packages paragraph — updated.
- [x] `docs/DESIGN.md` untouched (confirmed via `git diff --stat` before and after this pass — no
      change).
- [x] No UI claimed that doesn't exist — `apps/web` diff is empty; no doc mentions a webhook or
      forge-instance UI.
- [x] Token-reveal-channel invariant preserved in every doc that states it: REST claim `201` and
      MCP `claim_task` remain the only two; the new webhook route is explicitly called out as *not*
      a third channel in `README.md`, `CLAUDE.md`, and `docs/api.md`.
- [x] Verification gates run in-session on the real worktree, not fabricated: `pnpm lint` /
      `pnpm typecheck` / `pnpm test` / `pnpm build` all exit 0; node `--test` 445 pass / 0 fail;
      vitest 51 pass / 0 fail. These are the numbers written into the docs (superseding the
      "444 then 445" figure mentioned in the mission-list narrative, which predates this session's
      own measurement).

## Gaps / residual risk (none blocking)

- None found for the scope of this mission. The three cache-file numbers that could have drifted
  (test counts, `package.json` test-script order, current source signatures) were all re-verified
  directly against the worktree in this pass rather than trusted from the earlier subagents'
  handoffs, and matched.
- Not in scope for this doc pass, left correctly unaddressed: `docs/DESIGN.md` (contract doc, out
  of scope per instructions), `commentOnIssue`/#14 (a future issue, correctly still described as
  not implemented everywhere), any web UI for forge-instance configuration (does not exist; no doc
  invents one).

## Commit

Not performed — per instructions, no commit was made. `git status --short` in the worktree shows
only doc files added to the pre-existing (also uncommitted) production/test diff from earlier
missions; nothing was staged or committed by this pass.
