# Issue #63：私有 CA 认领端自动配对并进入 UAT 准备

# Issue #63：私有 CA 认领端自动配对并进入 UAT 准备

最新决定：https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5596896971 优先于 5596887868 中“配合/等人批准”的句子。本机隔离 Linux smoke/UAT 全程 Agent，不设人工等待门。历史 Missions 1–9 结果不改写；文档设计可另记独立 mission，审查轮次不另开 mission。归档快照保留在 `kaola-workflow/archive/bundle-63/`。

需求权威：https://github.com/KaolaBrother/KaolaTasks/issues/63 与正式更正 https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5595041812 。Mission List 只记执行状态。

两项最终期限：配对 attempt 默认/下限 86400 秒（从本次申请到 `expires_at` 才过期，幂等恢复不滑动）；批准后设备授权默认 90 天（`paired_at + device_max_age_days`）。存量 30 与既有 `expires_at` 不猜迁。

1.
   item: 冻结管理员批准绑定自动配对的威胁模型、规范 transcript/test vectors、REST/schema/error、本机 v2 trust 与轮换合同，先更新 DESIGN/ADR 且不提前改变产品行为。
   status: done
   dispatched: Cursor CLI main conversation via exact Runner session `cursor-cli-kaola-auto-pair-63`; worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in `docs/DESIGN.md`, `docs/decisions/0031-approval-bound-private-ca-pairing.md`, and design-owned acceptance test vectors on branch `workflow/bundle-63`.
   result: DESIGN v0.8 §16.8 + ADR 0031 + `docs/decisions/0031-pairing-test-vectors.json` on `workflow/bundle-63`. Initial freeze `65e8c7d`; TTL correction `13ecac39188036f41f6609a6e70e4d1dcd3545a7` (default/min 86400 from this create until `expires_at`; recover does not slide; pending may be extended never shortened; bound-device default remains 30 days). Product behavior not changed in these commits.

2.
   item: 以失败先行的验收测试交付服务端可恢复 pairing 状态、受限 bootstrap REST、管理员密语绑定事务及中文工作台，证明 pending 仍不能读取或认领任务。
   status: done
   dispatched: self / Cursor CLI main conversation `cursor-cli-kaola-auto-pair-63`; worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in shared pairing encoder tests, `apps/server` pairing REST/schema/bind transaction, and Chinese 电脑 pane on branch `workflow/bundle-63`.
   result: Server pairing REST + bind transaction + Chinese 电脑 pane + 90-day default on `workflow/bundle-63` commit `d572dcb3d5099f81330d1014eab0f91fc9ab1122`. Shared encoder/vectors; `device_pairings` / `app_settings.instance_id`; create/recover/commit/status/complete/next-root; leftover `ktk_` and session cookie cannot authorize pairing; pending still `202` on `list_tasks`/`claim_task`; wrong secret 8× then `409`; 86400 window live until `expires_at`; leftover pending extended not shortened; bind grants `paired_at + 90d`; workbench `配对密语` (`data-testid=device-bind-pairing-secret`) never echoes expected secret; wrong secret shows `配对密语不正确`. Evidence: `apps/server/src/pairing.test.ts` + `db-migration.test.ts` + `devices.test.ts` + `packages/shared/src/pairing.test.ts` 47/47 PASS; `App.devices.test.ts` 21/21 PASS. 90-day DESIGN/ADR/vector correction is in this checkpoint, not rewritten into Mission 1 commits. `kaola-mcp pair` not in this commit.

3.
   item: 交付 `kaola-mcp pair`、本机可恢复 receipt、批准证明核验、原子公开根落地与全新严格 TLS/active whoami handoff，正常路径不需要人工 PEM、指纹、env 或重启。
   status: done
   dispatched: self / Cursor CLI main conversation `cursor-cli-kaola-auto-pair-63`; worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in `apps/mcp/src/pair.ts` plus package-bin `kaola-mcp pair --url`, local `$KAOLA_HOME/pairings/` receipt, v2 `$KAOLA_HOME/trust/v2/<origin-digest>/`, and `pairing_required` launcher handoff on branch `workflow/bundle-63`.
   result: `kaola-mcp pair --url` on `workflow/bundle-63` commit `1d4eb9b3d47cd5b407650324fcb56d495ef2aade`. Receipt before first network; restart reuses secret/nonce; proof rebuilt from receipt; v2 rename only after strict active whoami; failed whoami discards staging; public CA does not install extra root; HTTPS unknown-issuer without v2/v1 prints `pairing_required` and exits 2 (package bin). Evidence: `apps/mcp/src/pair.test.ts` 12/12 PASS; `trust-cli.test.ts` / `trust.test.ts` / `main.test.ts` 45/45 PASS. README user path and overlap rotation not in this commit.

4.
   item: 补齐重启/重放/错误密语/中间人替换/legacy v1 迁移、根 overlap 轮换与公开 CA 迁移的失败关闭实现、文档和端到端 harness。
   status: done
   dispatched: self / Cursor CLI main conversation `cursor-cli-kaola-auto-pair-63`; worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in launcher overlap/next-root + public-CA migration, README user path, and fail-closed harness tests on branch `workflow/bundle-63`.
   result: Recovery, overlap rotation, public-CA migration, and README user path on `workflow/bundle-63` commit `8be16f6ae553ca3b6587cfaafa1934408666d646`. Launcher writes old+new extra CA then drops the previous root only after the new chain proves; missed overlap is `pairing_required`; next-root failure leaves existing v2; public-CA default-store + matching active `whoami` deletes only that origin digest v2 extra root (not `device.json` / v1). v1 `state.json` stays `v: 1` beside v2. Receipt restart, root substitution, and device-proof nonce replay fail closed. README claimant path is `kaola-mcp pair --url`; `trust install` is #48 explicit compatibility/recovery. Evidence: `apps/mcp/src/pair.test.ts` 18/18 PASS; `trust-cli.test.ts` / `trust.test.ts` / `main.test.ts` 45/45 PASS; `apps/server/src/pairing.test.ts` replay 401 included. Live macOS/Windows/Linux package-bin UAT not executed.

5.
   item: 对完整候选做独立安全与正确性审查并修复确认的问题，重点核对 bootstrap 隔离、secret/token containment、管理员事务、TLS 降级边界和跨 origin/device replay。
   status: done
   dispatched: self / Cursor CLI main conversation `cursor-cli-kaola-auto-pair-63` (inline; named Kaola review roles absent from this host Task catalog — `capability_gap`); worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in confirmed security/correctness fixes plus review evidence on branch `workflow/bundle-63`.
   result: Independent review on `workflow/bundle-63`. Confirmed fix: live pairing create/recover lookup+insert now one SQLite transaction (`1338cf957bc80264cb92c0154cbdd51e89342fe8`); changelog `a6f9185576f39ea7b9e451e0a434665bc85893ea`. Review also locked hyphenated CLI secret bind, foreign-device status 404 without proof, consumed status does not replay proof, and `device_pairings_one_live` unique. Bootstrap still cannot list/claim; leftover `ktk_` and session cookie cannot authorize pairing; bind audit has pairing_id not secret; whoami has `instance_id` and no token; TLS `NODE_TLS_REJECT_UNAUTHORIZED=0` / `--insecure` fail closed; device-proof nonce replay 401. Evidence: `apps/server/src/pairing.test.ts` 14/14 PASS. No live-network UAT.

6.
   item: 跑 focused、lint、typecheck、全量 Node/Web、build、diff/secret scan，核对 Issue 验收并形成真实 UAT 前置清单；未执行的物理平台、浏览器、服务或用户操作明确保留。
   status: done
   dispatched: self / Cursor CLI main conversation `cursor-cli-kaola-auto-pair-63`; worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in lint/typecheck/full test/build/diff/secret-scan receipts and an honest UAT prerequisite list on branch `workflow/bundle-63`. No deploy, no fabricated live UAT.
   result: Full gates on `workflow/bundle-63` at product HEAD `a6f9185576f39ea7b9e451e0a434665bc85893ea` then docs checkpoint `09a01f5c4701917a67914c931a341378379a3742`. `pnpm lint` 0; `pnpm typecheck` 0; Node **1091/1091**; Web **169/169** (9 files); `pnpm build` 0; `git diff --check` clean. Added-line secret scan vs `origin/main`: no private-key PEM, no live `ktk_` / `glpat-` / `ghp_`. UAT checklist in `docs/smoke-test.md` (2026-09-09 #63). Live private CA, browser pairing-secret bind, macOS/Windows/Linux package-bin, OAuth, and deploy were **not** executed and are not PASS. Issue live-UAT boxes remain open.

7.
   item: 按 Issue 最新范围纠正移除公开 CA 自动迁移的新增行为与专属承诺，保留私有 CA 自动配对恢复和既有公开 CA 直连兼容，验证调整后的候选。
   status: done
   dispatched: Cursor CLI main conversation `cursor-cli-kaola-auto-pair-63`; worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in scope-correction commit and affected validation receipts on `workflow/bundle-63` after rereading Issue comment 5595770991.
   result: Scope correction on `workflow/bundle-63` commit `5a4f1e1f33c532cda1d2e0e060fd8577bdc8b25d` after rereading Issue body and https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5595770991. Removed `migratePublicCaIfPossible` (launcher no longer `rm`s ready v2 extra root when default-store TLS succeeds). Kept `kaola-mcp pair` recovery, private-CA overlap rotation, and public-CA direct connect that does not install extra CA. DESIGN §16.5 / D18, ADR 0031 rotation section, README, architecture, CHANGELOG, and smoke-test 2026-09-09 correction section updated in this checkpoint; Missions 1–6 results not rewritten. Evidence: `apps/mcp/src/pair.test.ts` 18/18 PASS (lock: default-store success does not auto-delete ready v2); `trust.test.ts` / `trust-cli.test.ts` / `main.test.ts` 45/45 PASS. No deploy, no live UAT. Implementer self-review of this candidate only; independent review remains the controller's later pass.

8.
   item: 按 Issue 最新评论保留已实现的公开 CA 迁移：若移除提交已存在，以普通新提交最小恢复此前行为、专属测试与文档承诺，验证后冻结候选。
   status: done
   dispatched: Cursor CLI main conversation `cursor-cli-kaola-auto-pair-63`; worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in a restore commit (not history rewrite) plus affected pair/trust validation and updated receipts on `workflow/bundle-63` after rereading Issue comment 5595967717.
   result: Restored public-CA extra-root auto-migration on `workflow/bundle-63` commit `4993b1079c1b7ab5137e7e2225b65fa27a3fa6bf` after rereading https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5595967717. History `5a4f1e1` not rewritten. Restored `migratePublicCaIfPossible` from `09a01f5`; CHANGELOG prepends the restore line (5595770991 withdrawal kept as history); smoke-test adds 2026-09-09 restore section. Product frozen at this SHA for controller independent review. Evidence: `apps/mcp/src/pair.test.ts` 18/18 (lock: public-CA migration deletes only this origin digest v2 extra root); `trust.test.ts` / `trust-cli.test.ts` / `main.test.ts` 45/45. No deploy; live UAT not executed. Implementer self-review of this restore only.

9.
   item: 按独立审查评论 5596014744 修复 R1–R5：批准后 receipt 重启恢复、错过 overlap 可再 pair、启动核验配置根与 origin/leaf、默认 TLS 隔离 NODE_EXTRA_CA_CERTS（真实子进程）、trust 替换保留旧或新完整状态。先失败证明再修复；不扩大 UAT；修复后冻结候选交复核，不 sink。
   status: done
   dispatched: Cursor CLI main conversation `cursor-cli-kaola-auto-pair-63`; worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in DESIGN/ADR contract correction plus fail-first tests and R1–R5 fixes on `workflow/bundle-63` after rereading Issue comment 5596014744 and `.cache/controller-review.md`. Archive snapshot kept; no history rewrite; no sink.
   result: Independent-review R1–R5 on `workflow/bundle-63` commit `f1e0a8c4cf4f16a493b24da6592ec67ad34a05a1` after https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5596014744. DESIGN/ADR/api updated in this checkpoint. R1: active+matching nonce recovers approved attempt (status still returns proof). R2: consumed then new create + repair bind keeps owner/`expires_at`; pair continues on extra-CA unknown-issuer. R3: boot fails on unrelated CA or HTTP origin without leaf chain. R4: real TLS child with process-start NODE_EXTRA_CA_CERTS does not delete v2. R5: `.previous` restore after interrupted replace. Evidence: `pairing.test.ts` 17/17; `pair.test.ts` 21/21 (incl. real TLS child); trust/cli/main 45/45; `devices.test.ts` 18/18; Web vitest 170/170. No sink; no live UAT. Implementer self-review of this repair only; candidate for controller re-review.

10.
   item: 把本机隔离 Linux 全 Agent smoke/UAT 规则写入项目根 AGENTS.md，并更新 docs/smoke-test.md 可执行设计（路径 L）；不启动 UAT；结果只写手册不写 Issue。
   status: done
   dispatched: Cursor CLI main conversation `cursor-cli-kaola-auto-pair-63`; worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in `AGENTS.md` and `docs/smoke-test.md` on `workflow/bundle-63` after rereading Issue comments 5596887868 / 5596896971 and `.cache/local-linux-uat-direction.md`. Top-of-file correction wins over older 配合/等人 sentences. No UAT start.
   result: Path L executable design on `workflow/bundle-63` commit `760d068954ea6f3b2cda6e42098aba7bbb68a036`. AGENTS.md records isolated Linux full-agent UAT (no human gate, Computer Use allowed, `.env` not copied to claim client). `docs/smoke-test.md` top correction + Path L topology/steps/recovery matrix/result template. Historical A/B/C 配合 text kept below. UAT not started. Missions 1–9 unchanged.

11.
   item: 把 Codex 0907 Linux VPS→本机 Linux 完整 smoke 参考并入路径 L 设计：沿用旧闭环，只增补 Private CA 自动配对；术语 Private CA 不是 Privacy AI；旧证据不当本轮 PASS。不启动 UAT。
   status: done
   dispatched: Cursor CLI main conversation `cursor-cli-kaola-auto-pair-63`; worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-63`; output lands in `AGENTS.md` and `docs/smoke-test.md` after `.cache/previous-uat-reference.md`. Product pairing bytes stay `d52352b`; no review-round mission.
   result: Path L baseline-vs-delta on `workflow/bundle-63` commit `5808536cbfd506c0558bed71f1b272aa4d34c82c`. AGENTS.md + smoke-test.md reuse 2026-09-07–08 complete smoke; this run only adds Private CA auto-pairing (`kaola-mcp pair`, not Privacy AI / trust install). Historical VPS/local PASS not this run. UAT not started. Missions 1–10 unchanged. Product freeze for R3/R7 remains `d52352b`.
