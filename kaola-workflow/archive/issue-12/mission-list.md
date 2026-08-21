# 三 forge Issue 导入为带来源标记的任务卡草稿，补全后走发布即校验（#12）

- item: Map the ground truth #12 must wrap — ForgeAdapter `importIssue` still `notImplemented` and `ImportedIssue` is `unknown`; POST `/api/v1/tasks` already accepts `source.type=imported` with client-supplied title/body/`issue_url` and then 发布即校验; the publish form has a "从 Issue 导入" selector but does not call `importIssue`; board detail shows imported `issue_url` as a link but does not mark imported body text. Known: `getPullRequest` URL-parse + constructor-`baseUrl` for GitLab/Gitea is the adapter pattern to reuse; no webhook (#13) or write-back (#14). Issue #12 has no comments (body stands).
  status: done
  dispatched: code-explorer over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-12/.cache/ground-truth.md
  result: kaola-workflow/issue-12/.cache/ground-truth.md. HEAD 0e8bc4a. importIssue throws; ImportedIssue is unknown; no import HTTP; POST stores client source then validateToken only; form does not fetch; no 来源标记. Reuse getPullRequest host rule. Stay off #13/#14.

- item: Look up the three forges' Issue GET APIs (how to parse an issue web URL into owner/repo/number or GitLab namespace/iid, which JSON fields are title and body, 404 vs auth errors) so `importIssue(cred, issueUrl)` can map to a draft. Mirror `getPullRequest`: GitHub host is api.github.com; GitLab/Gitea use constructor `baseUrl`, never the issue URL's own host. Context7 may be unavailable — use official docs.
  status: done
  dispatched: knowledge-lookup; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-12/.cache/forge-issue-apis.md
  result: kaola-workflow/issue-12/.cache/forge-issue-apis.md. GitHub/Gitea title+body; GitLab title+description; host rule mirrors getPullRequest; 404 conflates missing and no-access; 401 is bad token. Rulings in .cache/orchestrator-rulings.md.

- item: Author the failing suite for three-forge `importIssue` (recorded or stubbed responses), correct `source` + source-link mapping on the published brief, a draft-into-form import that still goes through existing 发布即校验, and UI 来源标记 on imported body text. Pin orchestrator rulings first. Do not implement production code.
  status: done
  dispatched: tdd-guide over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12; tests to land at packages/forge-adapters/src/import-issue.shared.test.ts and apps/server/src/import.test.ts plus web App.form/App.board additions and root package.json test-script append; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-12/.cache/tests-import.md; RED baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-12/.cache/tests-import-baseline.txt
  result: 39 adapter + 24 HTTP + 7 web cases RED on 0e8bc4a (node 333 pass / 63 fail; vitest 44 pass / 7 fail). Custody: import-issue.shared.test.ts, import.test.ts, App.form.test.ts, App.board.test.ts, package.json test script. Handoff kaola-workflow/issue-12/.cache/tests-import.md

- item: Implement `importIssue`, the import draft HTTP/UI, and the 来源标记 against that suite. Do not touch the test files. Do not add webhook receivers (#13) or status write-back (#14) unless the suite already requires it.
  status: done
  dispatched: implementer over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12 against import-issue.shared.test.ts, import.test.ts, App.form.test.ts, App.board.test.ts; green proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-12/.cache/impl-import.md
  result: Orchestrator-facing record kaola-workflow/issue-12/.cache/impl-import.md. Production: ImportedIssue + importIssue, POST /api/v1/tasks/import, 导入 UI. Custody held (test files untouched). CI=true pnpm test exit 0 (396 + 51).

- item: Security-review the import path — issue URL parsing must not SSRF (follow the getPullRequest host rule); the credential used to fetch the Issue must not be logged or returned; imported Issue body is untrusted text and must stay labeled.
  status: done
  dispatched: security-reviewer over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12 production diff; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-12/.cache/sec-review.md
  result: verdict pass, findings_blocking 0. Import is not a third token reveal; pasted hosts never become fetch origins; active+full gate matches publish; body is labeled and text-interpolated. Evidence kaola-workflow/issue-12/.cache/sec-review.md

- item: Dock README/CHANGELOG/CLAUDE.md Commands snapshot, docs/api.md, and docs/architecture.md to the implemented import surface. Transcribe verified signatures; do not change DESIGN.md contracts as a side effect of scaffolding.
  status: done
  dispatched: doc-updater over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12; proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-12/.cache/doc-updater.md
  result: README / CHANGELOG / CLAUDE.md / docs/api.md / docs/architecture.md docked. DESIGN.md untouched. Proof: kaola-workflow/issue-12/.cache/doc-updater.md. Docking: kaola-workflow/issue-12/.cache/doc-docking.md (DOCKED). it( 19 adapter source lines; import.test.ts 24 test(; web +6/+1.

- item: Validate the worktree in-session: CI=true pnpm lint && typecheck && test && build all exit 0.
  status: done
  dispatched: self, worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-12
  result: All four gates exit 0 after docs. node --test 396 pass / 0 fail (79 suites); vitest 51 pass. Record: kaola-workflow/issue-12/.cache/final-validation.md
