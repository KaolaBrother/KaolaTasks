# issue-55 — UAT：#53/#54 评审循环的注入会话浏览器闭环与手册补齐

Worktree: `/workspace/.kw/worktrees/issue-55` · branch `cursor/uat-review-smoke-989d` · base `753f772`.

Open issue list was empty; this run filed and claimed #55. Newest closed product issues are #53 / #54. Path B (`pnpm smoke:forge`) already covers the REST/MCP review loop and `head_sha_stale` drift on live GitLab/Gitea. This run harnesses that flow into Path C (listening Kaola + real Vue workbench + injected/local-admin session) and runs the UAT in place of the human. Real GitLab OAuth, public TLS, GitHub publish, and a human Merge click on the forge page stay unexecuted and must be recorded as such.

User override (this session): diagnose and execute UAT only; do not revise harness/product for review findings. Gaps become new issues.

## 1
item: Write Path C into the live-testing playbook (`docs/smoke-test.md`) and dock the one-line pointers in `docs/README.md` / `README.md` — injected-session browser UAT on localhost, local-admin login, no GitLab Authorize, no PAT in the page, #53/#54 panel + `head_sha_stale` as the UI slice; 配合 items that this Cloud Agent cannot run stay marked unexecuted.
status: done
dispatched: self → `docs/smoke-test.md`, `docs/README.md`, `README.md` in `/workspace/.kw/worktrees/issue-55`
result: `a388b47` — Path C section, `pnpm smoke:uat -- … --web` hold-flag protocol, honest 配合 remainder; README / docs/README one-liners.

## 2
item: Harness Path C — `scripts/forge-smoke.ts --web` (plus `pnpm smoke:uat`) listens on localhost with Vite proxy and isolated sqlite, pauses at `head_stale` 待验收 for the browser, then resumes revision claim / merge from flag files; login testids; failed 「通过」 refreshes the review panel so 「forge 头已变化」 appears after `409`; additive web test; no production login backdoor.
status: done
dispatched: self → `scripts/forge-smoke.ts`, `apps/web/src/App.vue`, `App.review.test.ts`, `App.shell.test.ts`, `package.json`, `CHANGELOG.md` in `/workspace/.kw/worktrees/issue-55`
result: `5fe4297` — `--web` hold protocol, login testids, 409 后 refresh GET …/review, vitest App.review+shell 44 passed. Hold default later `76d40e9` (30 min).

## 3
item: Execute live UAT and record it only in `docs/smoke-test.md` — Path B `pnpm smoke:forge -- gitlab` and `-- gitea`; Path C at least GitLab (Gitea same shape if time), real browser: local-admin login → board → review panel → 409 Chinese → blocking round → SSE column move → 通过 → 待合并 → script merge → 已完成. Tokens never in logs, screenshots, or the playbook. Layers 3–5 / real OAuth / GitHub remain 未执行.
status: done
dispatched: self → live `pnpm smoke:forge` GitLab/Gitea logs under `/opt/cursor/artifacts/`; Path C `pnpm smoke:uat -- gitlab|gitea --web` + computerUse; record in `docs/smoke-test.md`
result: Path B GitLab ok after 30s forge timeout retry (Issue #25 / MR !22; first Issue #24 / MR !20 timed out). Path B Gitea ok (Issue #38 / PR #39). Path C GitLab ok after hold-timeout retry (Issue #27 / MR !23; first Issue #26 / MR !21 hold timed out). Path C Gitea ok (Issue #40 / PR #41). Real OAuth / TLS 3–5 / GitHub / forge-page Merge / 拆为子任务 未执行. Logs and `state.json` had no token/password.

## 4
item: Independent review of the exact candidate bytes — code review (hold protocol, listen/bind, pause/resume correctness) and security review (token leakage in state files / logs / UI copy, no new reveal channel, no auth backdoor); repair findings and re-gate.
status: done
dispatched: code-reviewer + security-reviewer on `76d40e9`; user then forbade repair in this session — findings filed as new issues, no harness/product patch
result: Reviews found two harness defects (unexpected `go` swallowed by empty catch; `--web` default listen `0.0.0.0`). Live Path B also hit GitLab 10s `waitForForgeHead` timeout. No repair this session. Follow-ups: #56, #57, #58. Token/state.json/login-backdoor review otherwise PASS.
