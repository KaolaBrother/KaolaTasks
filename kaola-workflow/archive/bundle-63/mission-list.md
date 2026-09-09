# #63 接续：先归因，再完成已授权 UAT 与收尾

1.
   item: 按用户最新要求，对比 #63 前后复现监听器累积和重复回写；区分引入回归、既有路径与测试操作差异，先报告证据，不改产品。
   status: done
   dispatched: self; baseline 8784833 and current 91e0a5a; isolated diagnostic scripts under .kw/local-receipts/diagnostic63; results land in docs/smoke-test.md only, not Issue comments. No Runner. User latest requests investigation before fixing.
   result: docs/smoke-test.md section “2026-09-09 接续调查” records measured attribution. Both versions 3/3 serial=1, reclaim=2, concurrent=2, reclaim+concurrent=3 POSTs; affected writeback sources identical. Pair production transport actual HTTPS 25 requests/1 TLS socket/25 listeners and warning; introduced 1d4eb9b. No product mutation. Full UAT remains incomplete.

2.
   item: 根据归因及用户后续决定处理确认缺陷，补齐本机真实 OAuth 和受影响 UAT，形成完整范围报告。
   status: done
   dispatched: self; user explicitly authorizes direct Workflow repair then UAT. Production changes and acceptance tests land in .kw/worktrees/bundle-63 on workflow/bundle-63; controller owns test meaning and implementation, no Runner. Freeze DESIGN first, prove focused failures, fix minimally, review candidate, full gates, then actual isolated UAT; results only docs/smoke-test.md.
   result: Production a76674f and test-only clock stabilization 720e239 passed independent review and full Linux/macOS gates. Fresh isolated Linux path L completed real GitLab/Gitea OAuth, three automatic Private CA pairings including pending restart recovery, all 10 MCP tools, fencing/SSE/dependency/restack, real reviews and three merges, terminal dismiss/accept/reopen/cancel through Playwright Chromium, PR61 closed unmerged, eight states, 0 active leases, and 35-surface secret scan PASS. Final report commit 02edb3227a9d5c7ba644cd59c9dac9a83470d4ce is pushed; protected receipts remain under .kw/local-receipts/uat-repair-20260909. Unexecuted physical/time/public-CA/browser-HTTPS scopes remain explicitly excluded.

3.
   item: 对冻结修复候选执行独立正确性与安全复核，回报候选引入的问题，不改产品。
   status: done
   dispatched: native code-reviewer and security-reviewer; exact worktree .kw/worktrees/bundle-63; candidate is its frozen HEAD after “fix: bound pairing connections and coalesce in-flight forge writes”; compare 91e0a5a. Each reviewer returns receipt to controller; durable output lands in kaola-workflow/bundle-63/repair-review.md and repair-security-review.md. Read-only reviews only, not Runner or UAT delegation.
   result: a76674f both reviewers PASS, 0 admitted findings. Receipts repair-review.md and repair-security-review.md. Security reviewer separately ran 46 tests. Main full regression Node 1113/1113 + Web 170/170 PASS; focused88, lint/typecheck/build PASS. Actual repaired UAT remains mission2 frontier.

4.
   item: 定位 Linux 表单测试独立异步不稳定原因，在不弱化断言的前提下修正测试同步并重跑回归。
   status: done
   dispatched: native investigator linux_form_diagnosis read-only reproduction and causal report; controller owns test-only edits and final causal verdict. Root captured Vue event 135ms older than listener after VM clock correction; exploratory edits reverted. Native repair_code_review reviews frozen test-only commit 720e239 against a76674f, read-only; receipt lands in repair-clock-review.md. Evidence under .kw/local-receipts/uat-repair-20260909/data/repair-linux-web-*.log and repair-form-event-2.log; final result lands in docs/smoke-test.md. No production or UAT environment mutations delegated.
   result: 720e239 uses monotonic elapsed Date.now only in Web tests; original assertions and production unchanged. Linux Web170/170 three consecutive full runs; final Linux1113+170 and Mac1113+170 PASS; lint/typecheck/build PASS; repair-clock-review.md PASS0. Root measured wall-clock rollback and corrected earlier async-wait hypothesis in docs/smoke-test.md. UAT mission2 remains open at native browser confirmation and pending third-device approval.
