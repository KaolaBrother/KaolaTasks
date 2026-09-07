# Live Path B forge smoke — candidate `fc405db`

Measured 2026-09-07. Investigator only: no tracked-file edits, no fix chosen, no commit.
`KAOLA_FORGE_TIMEOUT_MS` was **unset** for both legs (not passed; candidate continue-poll is the default).
Path C / `--web` / browser / OAuth / TLS were **not** executed.

## Setup

- Worktree: `/workspace/.kw/worktrees/bundle-56-57-58`
- Commit: `fc405db0798e89e47cac454df3794b78e09f5141` (`fc405db`)
- Branch: `cursor/smoke-uat-fixes-772b` (tracking `origin/cursor/smoke-uat-fixes-772b`)
- `git status --short` after both legs: empty (no tracked dirt)
- Node: `v22.14.0`; pnpm: `11.19.0`
- `node_modules`: already present; GitLab leg still ran pnpm’s install/resolution prefix (“Already up to date”, 675ms)
- Tokens: `GITLAB_TOKEN` and `GITEA_TOKEN` present in process environment (not printed, not written)
- Sequential order: GitLab, then Gitea

## Commands and results

| Measurement | Command | Result | Exit |
|-------------|---------|--------|------|
| GitLab Path B | `cd /workspace/.kw/worktrees/bundle-56-57-58 && pnpm smoke:forge -- gitlab` | stdout/stderr → `/opt/cursor/artifacts/smoke-gitlab-path-b.log` (1015 bytes, 19 lines) | **0** |
| GitLab wall clock | same | start `2026-09-07T12:48:34Z` → end `2026-09-07T12:49:01Z`; wrapper elapsed **27291 ms** (~27.3 s) | 0 |
| Gitea Path B | `cd /workspace/.kw/worktrees/bundle-56-57-58 && pnpm smoke:forge -- gitea` | stdout/stderr → `/opt/cursor/artifacts/smoke-gitea-path-b.log` (766 bytes, 13 lines) | **0** |
| Gitea wall clock | same | start `2026-09-07T12:49:19Z` → end `2026-09-07T12:49:58Z`; `date +%s` delta **39 s** | 0 |

Duration method: GitLab from the tool wrapper’s elapsed milliseconds (includes pnpm prefix). Gitea from integer-second `date +%s` around the command.

## Reproduction

- **Reproduces success (both forges Path B):** both commands exited 0 and printed `ok`.
- GitLab last line: `ok gitlab kt-2026-0001 https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/24 clone_auth=gitlab-basic-oauth2`
- Gitea last line: `ok gitea kt-2026-0001 https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/43 clone_auth=envelope`

## Forge URLs (from script stdout)

### GitLab

- Issue: https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/28
- MR: https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/24
- Task id in this isolated sqlite: `kt-2026-0001`
- `clone_auth`: `gitlab-basic-oauth2`
- Script steps logged: `review_round 1` → `待修改`; `submit_revision 1a354a1864e8` → `待验收`; `head_sha_stale` recorded=`1a354a1864e8` forge=`91b8d6becd65`; `submit_revision 91b8d6becd65` → `待验收 (round 2)`; `approved` `待合并` `draft=false` `head_verified=true`

### Gitea

- Issue: https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/42
- PR: https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/43
- Task id in this isolated sqlite: `kt-2026-0001`
- `clone_auth`: `envelope`
- Script steps logged: `review_round 1` → `待修改`; `submit_revision 40aedbf7fd00` → `待验收`; `head_sha_stale` recorded=`40aedbf7fd00` forge=`f9ff555675a5`; `submit_revision f9ff555675a5` → `待验收 (round 2)`; `approved` `待合并` `draft=false` `head_verified=true`

## `waitForForgeHead` vs 10s `TimeoutError`

Path B (non-`--web`) calls `waitForForgeHead` after the undeclared drift push and **before** the `head_sha_stale` log (`scripts/forge-smoke.ts`). Both logs contain `head_sha_stale` and then continue through round 2 approve/`ok`.

| Log | `TimeoutError` in stdout/stderr | `aborted due to timeout` in stdout/stderr | Run aborted by a single 10s abort |
|-----|----------------------------------|-------------------------------------------|-----------------------------------|
| GitLab | **not found** | **not found** | **no** (exit 0, full Path B sequence) |
| Gitea | **not found** | **not found** | **no** (exit 0, full Path B sequence) |

Observation: the harness swallows abort-timeouts inside `waitForForgeHead` without printing them, so stdout cannot prove whether a 10s `TimeoutError` occurred internally. Observation: neither run died at that wait; both reached `head_sha_stale` then `ok`.

## PAT / secret scan

Scanned both artifact logs (and this report after write) for typical prefixes: `glpat-`, `gitea_` + alnum, `ghp_`, `github_pat_`, `ghs_`, `glptt-`.

- `/opt/cursor/artifacts/smoke-gitlab-path-b.log`: **not found**
- `/opt/cursor/artifacts/smoke-gitea-path-b.log`: **not found**
- This report file: prefixes are named as search terms only; no token values quoted.

Tokens were not placed in git remotes by this investigator (worktree status clean).

## Failures

Neither leg failed. No non-secret error to paste.

## Not executed (do not claim)

- Path C (`--web`)
- Browser / computer-use
- OAuth publisher login as a human
- TLS / extra cert checks beyond whatever the script’s HTTPS clients did internally (not separately measured)

## Inferences (labeled)

- Both Path B live smokes **passed** on this candidate at this wall-clock window — confidence: high; refuted by: a later rerun with the same commands exiting non-zero.
- A single 10s adapter `TimeoutError` **did not abort** either run — confidence: high for “did not abort”; **unknown** whether any 10s abort occurred and was continue-polled (no harness log of swallowed timeouts).
- GitLab `waitForForgeHead` did not need the full 90s outer deadline on this sample (GitLab whole run ~27s) — confidence: medium; the wait is only one segment of the run; refuted by: instrumentation showing that wait consumed most of the 90s.

## Open

- No per-poll timing inside `waitForForgeHead` (script does not log poll iterations).
- No second sample / flake rate.
- GitLab wrapper duration includes pnpm’s “Already up to date” prefix; Gitea log starts at the `node` invocation (pnpm prefix not in that file).
