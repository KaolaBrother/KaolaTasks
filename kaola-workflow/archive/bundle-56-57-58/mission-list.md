# bundle-56-57-58 — 修 forge-smoke 三条独立缺陷：错误 UAT 旗标被吞、--web 默认绑 0.0.0.0、waitForForgeHead 单次 10s 整段失败

Claimed from `main` @ `3d04f28` (Path C already merged; `0100dc9` is ancestor; remote `cursor/uat-review-smoke-989d` gone). Worktree `/workspace/.kw/worktrees/bundle-56-57-58` · branch `cursor/smoke-uat-fixes-772b`. Do not resume #55. Do not change product API, login, or token-reveal. Empty `go` file: keep waiting (same as missing), pinned in the playbook.

## 1
item: Measure current `scripts/forge-smoke.ts` `waitForUatFlag` / `--web` `listenHost` / `waitForForgeHead` and the `docs/smoke-test.md` rows they contradict, from the worktree not the issue text.
status: done
dispatched: code-explorer → `/workspace/kaola-workflow/bundle-56-57-58/.cache/ground-truth.md` against worktree `/workspace/.kw/worktrees/bundle-56-57-58` @ `3d04f28`
result: `/workspace/kaola-workflow/bundle-56-57-58/.cache/ground-truth.md` — #56 empty catch swallows `fail()`; #57 `--web` default `0.0.0.0`; #58 first adapter TimeoutError aborts 90s wait; only `ensureSimulatedAuthEnv` exported; `KAOLA_FORGE_TIMEOUT_MS` is docs-only.

## 2
item: Author failing acceptance that nails Path C hold protocol (missing flag waits; unexpected non-empty content fails immediately with redacted actual bytes; empty file waits), `--web` default listen `127.0.0.1` with `UAT_WEB_HOST` override, and `waitForForgeHead` treating a single adapter timeout as continue-poll without loosening production `getPullRequest` 10s; Path B without `--web` stays on loopback.
status: done
dispatched: tdd-guide → worktree `/workspace/.kw/worktrees/bundle-56-57-58` `scripts/forge-smoke.test.ts` + root `package.json` test list; report `/workspace/kaola-workflow/bundle-56-57-58/.cache/tests.md`
result: RED `scripts/forge-smoke.test.ts` 14 tests / 8 pass / 6 fail (exit 1). Mechanical seams only. Report `.cache/tests.md`. Baseline `3d04f28`.

## 3
item: Repair the three harness defects in `scripts/forge-smoke.ts` so those tests pass; no product API / login / token-reveal change; production adapter default timeout unchanged.
status: done
dispatched: implementer → worktree `/workspace/.kw/worktrees/bundle-56-57-58` `scripts/forge-smoke.ts`; report `/workspace/kaola-workflow/bundle-56-57-58/.cache/impl.md`
result: `#56` ENOENT-only catch; `#57` default `127.0.0.1`; `#58` TimeoutError continue-poll. Focused suite 14/14 exit 0 (orchestrator re-run). `.cache/impl.md`.

## 4
item: Dock `docs/smoke-test.md` (and CHANGELOG/README pointers if they currently name the old pits) for empty-flag wait, default loopback listen, and GitLab `waitForForgeHead` no longer needing a 30s adapter timeout just to survive one slow poll.
status: done
dispatched: doc-updater → worktree `/workspace/.kw/worktrees/bundle-56-57-58` `docs/smoke-test.md` `CHANGELOG.md`; report `/workspace/kaola-workflow/bundle-56-57-58/.cache/doc-docking.md`
result: DOCKED `docs/smoke-test.md` hold/listen/pit + CHANGELOG Unreleased #56–#58. DESIGN/README/architecture unchanged. `.cache/doc-docking.md`.

## 5
item: Independent code review and security review of the frozen candidate bytes (hold protocol, bind, timeout handling, no new reveal/backdoor).
status: done
dispatched: code-reviewer + security-reviewer → frozen `fc405db` on worktree `/workspace/.kw/worktrees/bundle-56-57-58`; reports `/workspace/kaola-workflow/bundle-56-57-58/.cache/code-review.md` and `.cache/sec-review.md`
result: both PASS, 0 blocking findings. Reports `.cache/code-review.md` and `.cache/sec-review.md`. Frozen `fc405db`.

## 6
item: Validate the frozen candidate with `pnpm lint && pnpm typecheck && pnpm test`, plus live Path B `pnpm smoke:forge -- gitlab|gitea` only if the gitignored PATs are present; record unexecuted live legs honestly.
status: done
dispatched: self → lint/typecheck/test on worktree `/workspace/.kw/worktrees/bundle-56-57-58` @ `fc405db`; investigator → live Path B gitlab+gitea; report `/workspace/kaola-workflow/bundle-56-57-58/.cache/final-validation.md`
result: lint+typecheck+test exit 0 (1049+166). Path B GitLab Issue #28/MR !24 and Gitea Issue #42/PR #43 exit 0. Path C/OAuth/TLS unexecuted. `.cache/final-validation.md` + `.cache/live-smoke.md`. Live row recorded `a13e5f8`.
