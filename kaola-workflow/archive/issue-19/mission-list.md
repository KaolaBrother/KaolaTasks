# 发布导入：档案下拉选仓库和 Issue，预览后再发布

- item: 核对 DESIGN §7/§8、现有 import/档案 HTTP、发布表单和 parseIssueUrl，确认契约改动落在真实表面上（502 文案候选：「无法连接 forge 列出 Issue。」）
  status: done
  dispatched: code-explorer → kaola-workflow/issue-19/.cache/ground-truth.md
  result: kaola-workflow/issue-19/.cache/ground-truth.md（[Explorer](f5cc5259-9068-4f4c-8bc5-6480227947bd)）。502 选定「无法连接 forge 列出 Issue。」；新 GET 不写 token 揭示；importForgeFailure 的 404→issue_not_found 不要复用；仓库下拉 label 用 issue 的 `{forge} {repo_full_name}`。

- item: 先改 DESIGN.md §7 §8：写入 listIssues / ListedIssue、GET /api/v1/credential-profiles/:id/issues、发布页档案+Issue 下拉主路径；POST /import 与 POST /tasks 请求体不变
  status: done
  dispatched: self → .kw/worktrees/issue-19/docs/DESIGN.md §7 §8
  result: DESIGN §7 档案下拉=仓库、列 Issue 主路径、inline 回退、GET issues 非揭示通道；§8 listIssues / ListedIssue / HTTP 映射；502 文案「无法连接 forge 列出 Issue。」

- item: 查 GitHub/GitLab/Gitea 列仓库 open Issue 的官方 API（路径、query、排序、GitHub pull_request 键、GitLab iid vs web_url）
  status: done
  dispatched: knowledge-lookup → kaola-workflow/issue-19/.cache/forge-list-issues-apis.md
  result: kaola-workflow/issue-19/.cache/forge-list-issues-apis.md（[Lookup](ad4a5eca-65e0-4006-89b7-3c2b58a460b2)）。GitHub `state=open&per_page=50&sort=created&direction=desc`；GitLab `state=opened` + `iid`；Gitea `limit=50&type=issues`。

- item: 三个 forge 的 listIssues 先红：只列 open、最多 50、GitHub 丢掉 PR、GitLab issue_url 是 /-/issues/{iid} 且 parseIssueUrl 能解析、fetch host 与 importIssue 相同
  status: done
  dispatched: tdd-guide → .kw/worktrees/issue-19/packages/forge-adapters/src/list-issues.shared.test.ts + root package.json test list; red log kaola-workflow/issue-19/.cache/tests-list-issues-baseline.txt
  result: 25 it 全红 @ 41e1e01（方法不存在）。spec 在 worktree list-issues.shared.test.ts；基线 kaola-workflow/issue-19/.cache/tests-list-issues-baseline.txt（[tdd-guide](ebd9a99d-3a8a-462e-a7d9-0bcba594020a)）

- item: 实现三份 listIssues，直到适配层共享 spec 变绿
  status: done
  dispatched: implementer → .kw/worktrees/issue-19/packages/forge-adapters/src/index.ts（只改生产代码，禁止改测试）
  result: 25 pass / 既有适配器 139 pass。ListedIssue + listIssues 在 index.ts（[implementer](6316e54c-e8cd-4855-9213-08744c6c23f5)）。报告 kaola-workflow/issue-19/.cache/impl-list-issues.md

- item: GET /api/v1/credential-profiles/:id/issues 先红：active+full 门闩、200 形状、404/422/502/500、响应/日志/events 不含 token、不写 token 揭示
  status: done
  dispatched: tdd-guide → .kw/worktrees/issue-19/apps/server/src/credential-profile-issues.test.ts + root package.json; red log kaola-workflow/issue-19/.cache/tests-profile-issues-baseline.txt
  result: 13 test 全红（路由不存在）。文件 credential-profile-issues.test.ts（[tdd-guide](05aa5e2d-1b3a-4a6b-ac04-55ca9f7412e7)）

- item: 实现该 HTTP 路由（解密档案后调 listIssues），直到服务端测试变绿
  status: done
  dispatched: implementer → .kw/worktrees/issue-19/apps/server/src/credential-profiles.ts（禁止改测试）
  result: 13/13 绿；vault+import 40 仍绿。GET 在 credential-profiles.ts（[implementer](fd8dc7c4-b4f4-463e-be72-7483700b51e7)）

- item: 发布页先红：imported+档案选仓库再选 Issue、导入预览后发布、无档案不发列表请求、inline token 回退仍可贴 URL
  status: done
  dispatched: tdd-guide → .kw/worktrees/issue-19/apps/web/src/App.form.test.ts; red log kaola-workflow/issue-19/.cache/tests-publish-picker-baseline.txt
  result: 8 个新 it + helpers 改写；内联用例已改为先切 inline。基线仍 27 红 / 66 绿（[tdd-guide](20c0e924-6f14-48b3-86e1-d75e224666b4)）

- item: 实现发布页下拉，直到 web 测试变绿；浏览器核对主路径
  status: done
  dispatched: implementer → .kw/worktrees/issue-19/apps/web/src/App.vue（禁止改测试）
  result: web 93/93 绿（[implementer](8fac099e-5a10-4579-ae13-ae187b9c21a7)）。登录后的浏览器冒烟需配合 OAuth，本轮用 vitest 覆盖主路径。

- item: 把 api.md / CHANGELOG / CLAUDE.md 快照 / architecture 对上真实签名和选定的 502 文案
  status: done
  dispatched: doc-updater → worktree docs/api.md, CHANGELOG.md, CLAUDE.md, docs/architecture.md, README.md if HTTP surface is mentioned
  result: [doc-updater](4d34fdf5-4225-4cb2-9073-2fac73ce38a2) 已写入 api.md / architecture.md / CHANGELOG / CLAUDE.md / README；502 原文「无法连接 forge 列出 Issue。」；报告 kaola-workflow/issue-19/.cache/doc-updater.md。实测通过数已补进 CHANGELOG。

- item: 安全复核 + 全量 test/lint/typecheck/build，准备收口
  status: done
  dispatched: security-reviewer → kaola-workflow/issue-19/.cache/sec-review.md；self 跑 worktree pnpm test/lint/typecheck/build
  result: [security-reviewer](9d11356c-d732-4d64-951d-98ea64125d79) pass、0 blocking（sec-review.md）。pnpm test 540+93、lint/typecheck/build 均 exit 0。
