# 认领者用电脑配对证明考拉身份；仓库 token 仍只在 claim 成功时下发

- item: Measure current OAuth bootstrap (GitLab/Gitea auto-full vs GitHub 待批准), agent_keys Bearer, MCP/REST claim gates, keys pane copy, and leases/claim_confirmations agent_key_id coupling against #23 latest comments (claimants are not web accounts; first-full bootstrap; device pending 1 day; no ktk in mcp.json). Do not change #22 two-task token pin.
  status: done
  dispatched: code-explorer → kaola-workflow/issue-23/.cache/ground-truth.md (read worktree at .kw/worktrees/issue-23)
  result: kaola-workflow/issue-23/.cache/ground-truth.md — GitLab/Gitea still auto-full; self-serve ktk_ Bearer; unpaired MCP is 401; no devices/claimants tables; #22 two-task + clone four keys intact.

- item: Pin DESIGN §7 / §11 (and the data-model table) to the winning comments before code: two credentials; claimants ≠ claim_only OAuth users; empty KAOLA_ADMINS may boot; zero-full first web login is the bootstrap admin; device pending 1 day then bind-to-claimant; stdio bridge; signed device proof; hard expiry; no forge token in mcp.json.
  status: done
  dispatched: planner → kaola-workflow/issue-23/.cache/architecture.md; knowledge-lookup → kaola-workflow/issue-23/.cache/mcp-stdio-ed25519.md; orchestrator overlay kaola-workflow/issue-23/.cache/architecture-corrections.md; doc-updater → worktree docs/DESIGN.md
  result: DESIGN §3/§7/§9/§10/§11 pinned (claimants, devices, bootstrap, 202 authorization_required). Clone four-key sentences left as #22. Note: use code paths `/api/mcp`, tools `list_tasks`/`claim_task`; env `KAOLA_ADMINS`.

- item: Author failing tests for bootstrap, closed join, pending-device 202 authorization_required with no token, bind-to-claimant then retry, revoke person/device, list/brief hygiene, and two-task claim still returning different forge tokens.
  status: done
  dispatched: tdd-guide → worktree apps/server tests; notes at kaola-workflow/issue-23/.cache/tdd-server.md
  result: 107 tests / 91 fail on HEAD `6c9f01c`. New devices.test.ts; claim/mcp/claim-confirm/auth rewritten onto device proof. Remaining writeback/webhook/poller/events still mint ktk_ (retarget after server is green).

- item: Implement server identity: devices + claimant identities, optional KAOLA_ADMINS, first-full bootstrap, MCP/REST device proof, claim/lease/audit user_id+device_id, no anonymous claim, approve does not auto-claim or push a forge token.
  status: done
  dispatched: implementer → kaola-workflow/issue-23/.cache/impl-server.md; tdd-guide defect/leftover retarget → tdd-fix.md, tdd-leftover.md
  result: Server identity in production. `pnpm test` worktree: node 572 pass / 0 fail; vitest 95 pass (web still old keys pane).

- item: Ship a stdio MCP bridge that shares ~/.kaola device keys across runtimes; committed MCP example stays URL/command-only with no secrets.
  status: done
  dispatched: tdd-guide → tdd-mcp.md; implementer → impl-mcp.md
  result: `@kaola/mcp` bin `kaola-mcp`; 7/7 main.test.ts pass; examples/mcp.json is command + `--url` only.

- item: Web: 我的电脑 / 待授权电脑 / 绑到认领者身份；删掉「为接单去钥匙页生成仓库钥匙」；管理员可解除人或电脑（full 可把电脑绑到自己以便冒烟）。
  status: done
  dispatched: tdd-guide → tdd-web.md; implementer → impl-web.md
  result: App.vue 电脑 pane; vitest 109/109 pass. Nav testid `workbench-nav-keys` label 电脑.

- item: Dock README, smoke-test, api.md, CHANGELOG to the new claimant model; keep #22 reveal channels and two-task token pin.
  status: done
  dispatched: doc-updater → docs-dock.md; security-reviewer → sec-review.md (PASS)
  result: README/api/smoke-test/CHANGELOG/architecture/CLAUDE.md aligned to device proof. DESIGN clone four keys left as #22.
