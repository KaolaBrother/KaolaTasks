# Doc docking — issue #14 (status write-back)

| Surface | Status | File(s) | Note |
|---|---|---|---|
| `IssueRef` type (`unknown` → `{ issue_url }`) | DOCKED | CLAUDE.md, README.md, docs/api.md, docs/architecture.md | |
| `commentOnIssue` implemented (GitHub/Gitea comments, GitLab notes) | DOCKED | CLAUDE.md, README.md, docs/api.md (+ new `### commentOnIssue` subsection), docs/architecture.md | |
| `comment-on-issue.shared.test.ts` (19 `it(`) | DOCKED | CHANGELOG.md, README.md (test cmd), CLAUDE.md (test cmd) | |
| `attemptWriteback` signature + gate (imported-only) | DOCKED | CLAUDE.md, README.md, docs/api.md (new "Status write-back" section), docs/architecture.md | |
| Three transitions `'认领'\|'提交PR'\|'完成'` + exact hook sites | DOCKED | CLAUDE.md, README.md, docs/api.md, docs/architecture.md | |
| `完成` only on `terminal === 'merged'`, never `已退回`/`releaseTask` | DOCKED | CLAUDE.md, README.md, docs/api.md, docs/architecture.md | |
| Non-blocking (every fault swallowed) | DOCKED | CLAUDE.md, README.md, docs/api.md, docs/architecture.md | |
| `events.type` `回写` exact `details` shape | DOCKED | CHANGELOG.md, docs/api.md (Status write-back section + Events table) | Verified failure writes **no** event (code, not the more permissive ruling text) |
| Comment body contents (publicId, PUBLIC_URL, pr_url) | DOCKED | CLAUDE.md, README.md, CHANGELOG.md, docs/api.md | No `/tasks/:id` deep link invented (no vue-router) |
| `decryptTaskToken` moved to `writeback.ts`, reused by poller | DOCKED | CLAUDE.md, README.md, CHANGELOG.md, docs/api.md, docs/architecture.md | |
| `retryPendingWritebacks` export + re-export + `app.ts` timer chain | DOCKED | CLAUDE.md, README.md, CHANGELOG.md, docs/api.md, docs/architecture.md | |
| `claimTask`/`submitPr` now `async`, awaited by REST + MCP | DOCKED | CLAUDE.md, docs/api.md, docs/architecture.md, CHANGELOG.md | |
| Webhook "never decrypts" nuance (merged now decrypts via write-back) | DOCKED | CLAUDE.md, docs/api.md (webhook section rewrite), docs/architecture.md | Matches the required #14 nuance; `closed` still never decrypts |
| Token-reveal channels unchanged (2 only) | DOCKED | CLAUDE.md, docs/api.md, docs/architecture.md | write-back adds no 3rd channel |
| M2 (#12–#14) fully implemented / status lines | DOCKED | README.md (status line, feature list, roadmap closing sentence, "工作原理" prose) | Removed "设计中、尚未实现" section (only ever named #14) |
| Root `pnpm test` script (+2 files) | DOCKED | CLAUDE.md, README.md | Matches `package.json` diff exactly |
| Sources list (`writeback.ts`) | DOCKED | docs/api.md | |
| `docs/DESIGN.md` | SKIPPED — forbidden by task instructions | — | Not touched |
| `docs/README.md` | SKIPPED — no new doc file, index unchanged | — | Not touched |
| `docs/conventions.md`, `docs/decisions/` | SKIPPED — not in this change's Documentation Update Checklist surface | — | Not touched |
| Web UI docs | SKIPPED — #14 has no web-visible surface (confirmed via `git status`) | — | Not touched |
| REST `submit_pr` / events HTTP / vue-router | SKIPPED — do not exist, not invented | — | Confirmed absent in source before writing |
| `docs/CODEMAPS/` | SKIPPED — does not exist in this repo, not invented | — | |

## Measured (re-run, not invented)

`CI=true pnpm test` in `.kw/worktrees/issue-14`: node `--test` → `tests 479, suites 99, pass 479, fail 0`; vitest → `Test Files 2 passed (2)`, `Tests 51 passed (51)`. Matches orchestrator's 2026-08-21 measurement exactly. Did not re-run lint/typecheck/build (doc-only pass, no source changed).

## Commit

Not committed (no `git add`/`git commit` run), per instructions.
