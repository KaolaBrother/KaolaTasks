# 本机冒烟进度

这是**活测日志**，不是 backlog。进度只改这个文件，不要写进 GitHub issue。

续测前先读「怎么分工」，再看进度表。标了 **配合** 的步骤：自动化跑不了（OAuth 授权页、浏览器会话、只显示一次的令牌、页面点选）。到这些步必须**停下来和人一起做**，不要自己猜、不要让人把 Secret 贴到聊天里。

## 怎么分工

| 标记 | 谁做 | 规则 |
|------|------|------|
| **自动** | Agent 可单独做 | 测命令、起服务、查 SQLite、调不需要浏览器 cookie 的 API、用已写入 `.env` 且 gitignore 的令牌调 GitLab API |
| **配合** | 人和 Agent **当场一起做** | 浏览器登录、在页面里贴令牌、生成 Agent Key、点导入/发布、GitLab Authorize。人操作页面；Agent 报下一步填什么、事后核 SQLite / 网络响应。令牌只进 `.env` 或页面输入框 |

`.env` 已 gitignore。需要 PAT 时，人把值写进本地 `.env`，聊天里只说「写好了」。

## 环境

- 原点：**http://localhost:31415**（必须 `localhost`，不要 `127.0.0.1`，否则登录 cookie 对不上）
- 启动：仓库根目录 `pnpm dev`（先 `export` / `source .env`）
- SQLite：`SQLITE_PATH` → `kaola-dev.sqlite`（不要用默认内存库）
- 登录身份：GitLab.com OAuth → 用户 `KaolaBrother`，`active` + `full`
- 本轮目标仓：GitLab 私有项目 [KaolaBrother/kaola-tasks-smoke](https://gitlab.com/KaolaBrother/kaola-tasks-smoke)（早先垫过的 GitHub 同名仓**不用**）
- 导入：#19 已落地。来源选「从 Issue 导入」、凭证选「共享档案」后，下拉选仓库档案再下拉选 Issue，点「导入」预览，再「发布」。不要粘贴 GitLab 页面上的 `/-/work_items/…`。inline token 回退才需要手填 URL，那条必须是：

  `https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/1`

## 进度

| # | 步骤 | 分工 | 状态 | 记录 |
|---|------|------|------|------|
| 1 | `pnpm test` | 自动 | 完成 | 2026-08-22：node 502 pass / vitest 75 pass |
| 2 | `pnpm dev` 起来，未登录 API 为 401 | 自动 | 完成 | `GET /login` 200；`GET /api/v1/me` 与 `/api/v1/tasks` 未登录 401 |
| 3 | GitLab.com 建 OAuth 应用，填 `.env` 的 `OAUTH_GITLAB_*` | **配合** | 完成 | 回调必须是 `http://localhost:31415/login/gitlab/callback`；Scopes 勾 `read_user`。`OAUTH_GITLAB_CLIENT_SECRET` **不是**个人令牌 |
| 4 | 浏览器打开原点，点「使用 GitLab 登录」，Authorize | **配合** | 完成 | 人过 GitLab 授权页。曾报 `The requested scope is invalid`：请求里是 `scope=undefined`。已在 `auth.ts` 补上 GitLab `read_user`、GitHub/Gitea `read:user` |
| 5 | 核本机用户行 | 自动 | 完成 | `users`：`KaolaBrother` / GitLab / `active` / `full` |
| 6 | Legacy PAT 写入 `.env` 的 `GITLAB_TOKEN` | **配合** | 完成 | 人选 **Legacy token**（不要 Fine-grained），勾 `api` + `write_repository`，`glpat-…` 只写 `.env`。Fine-grained 绑已有项目，建仓前用不上 |
| 7 | 建私有仓并开 3 个 Issue | 自动 | 完成 | 有 `GITLAB_TOKEN` 之后用 API 建的。#1 导入考拉；#2 `.gitignore`、#3 LICENSE 留在 GitLab |
| 8 | 工作台添加 GitLab 凭证档案 | **配合** | 完成 | SQLite `credential_profiles` id=1：`gitlab` / `https://gitlab.com` / `KaolaBrother/kaola-tasks-smoke`；`events` 有 `变更` create。换进程后仍要重新登录才能在页面里看到 |
| 9 | 从 Issue 导入并发布 | **配合** | 完成 | 任务 `kt-2026-0001`：标题 `smoke: append a line to README`，`imported` / `gitlab` / `KaolaBrother/kaola-tasks-smoke`，状态 `待认领` |
| 10 | 生成 Agent Key | **配合** | 未做 | 用**已经登录的** GitLab 用户 `KaolaBrother`（`active` + `full`）在「钥匙」页生成。认领**不必**再登 GitHub，也**不必**再为完成任务走一遍网页登录。明文 `ktk_…` 只出现一次。写入 `.env` 的 `KAOLA_AGENT_KEY=`，聊天只说「写好了」 |
| 11 | 本机 Cursor CLI 配考拉 MCP | **配合** | 未做 | 全局 `~/.cursor/mcp.json`（或项目 `.cursor/mcp.json`，**不要提交 Key**）：`url` `http://localhost:31415/api/mcp`，`headers.Authorization` `Bearer ktk_…`。用**本机** CLI / 本机 Agent；Cloud Agent Runtime 打不到 localhost |
| 12 | `list_tasks`，人确认做哪条 | **配合** | 未做 | Agent 列出待认领。人指定 `kt-2026-0001`（`smoke: append a line to README`）。`get_task_brief` **不含** token。`repo`：`gitlab` / `https://gitlab.com` / `KaolaBrother/kaola-tasks-smoke`，`suggested_dir` `kaola-tasks-smoke` |
| 13 | 指示认领 `claim_task` | 自动（MCP 已配） | 未做 | 只传 `task_id`，**不要** `autonomous`。成功：看板 `进行中`；返回顶层 `token`（发布者的 GitLab PAT）和 `clone.suggested_dir`。网页始终没有认领按钮 |
| 14 | 本机 clone GitLab，改 README | **配合** | 未做 | remote：`https://gitlab.com/KaolaBrother/kaola-tasks-smoke.git`。token 用环境变量或 `git -c http.extraHeader`，**不要**写进 remote URL。目录用 `kaola-tasks-smoke`。在 `README.md` 末尾加一行 `Smoke test OK.` |
| 15 | 推分支、开 MR，再 `submit_pr` | **配合** | 未做 | 同一 token 推分支、用 GitLab API 开 MR（认领者不必在该仓有自己的 GitLab 账号）。MCP `submit_pr` 交 `pr_url`；任务应变 `待验收` |
| 16 | 合并 MR，看任务变已完成 | **配合** | 未做 | 人在 GitLab 点 Merge。默认约 60s 轮询；导入型应给源 Issue `#1` 回写评论 |

## 当前停在哪

**#1–#9 完成。** 板上有 `kt-2026-0001` / `待认领` / 导入自 GitLab Issue #1。发布这条已经测过。

**下一步是 #10**，不是 GitHub 登录。接单闭环约定如下（现设计就能走；#20 / #21 是后续产品改动，**不挡**本轮冒烟）：

```
网页看板（只看）
  → 本机 Cursor CLI + MCP（Agent Key）
  → list_tasks → 人确认 kt-2026-0001
  → claim_task（指示，无 autonomous）
  → 用揭示的 GitLab token clone/改/推/开 MR
  → submit_pr → 人 Merge → 已完成
```

完成任务**不用**再登录 GitLab/GitHub 去拿仓库权；token 是发布时附上的。仍需要一把考拉 Agent Key（#10），用来标识谁领走了 token。

## 本轮之后（不写入本表状态，只作规划）

| 项 | 记在哪 | 和冒烟的关系 |
|----|--------|----------------|
| clone 信封加 `remote_url` + 按 forge 的 `extra_header` | GitHub [#20](https://github.com/KaolaBrother/KaolaTasks/issues/20) | 本轮 Agent 自己用 `forge`/`base_url`/`full_name` 拼 clone；配方加厚是下一轮 |
| 发布页导入后只读展示 Issue，去掉验收/路径/优先级等表单项 | GitHub [#21](https://github.com/KaolaBrother/KaolaTasks/issues/21) | 本轮已用旧表单发布成功；UI 改版另做 |

## 坑（续测别踩）

- 三个 OAuth 客户端启动时都必须非空；不用的 GitHub/Gitea 可填 `unused`，**不要点那两个登录按钮**。本轮认领不走 GitHub 登录。
- `GITLAB_TOKEN`（Legacy PAT）和 `OAUTH_GITLAB_CLIENT_SECRET`（OAuth 应用密钥）不是同一个东西。认领揭示的是档案里那份 GitLab token，不是 OAuth 密钥。
- GitLab 新 UI 常把 Issue 显示成 `/-/work_items/N`；考拉只解析 `/-/issues/N`（以及遗留 `/issues/N`）。
- 网页没有「认领」按钮；认领只走 Agent Key（MCP 或 Bearer REST）。口头让 Agent 去领时不要带 `autonomous`。
- Cloud Agent / 云端 Runtime 访问不了 `localhost:31415`。接单用本机 Cursor CLI / 本机 Agent。
- clone 不要把 token 写进 remote URL。现契约只有 `clone.suggested_dir` + 卫生句；GitLab 地址由 brief 的 `repo.*` 拼。
- 会话在 Fastify 内存里，不在 SQLite。换进程后要重新登录才能生成 Agent Key（又是 **配合**）。
- GitLab 回调若出现 `Response Error: 400 Bad Request`：是 `/oauth/token` 被拒（常为未走 PKCE，或 secret 用 HTTP Basic 编码失败）。从首页重新点登录，不要刷新回调 URL。GitLab 应用回调必须是 `http://localhost:31415/login/gitlab/callback`。

## 测完可收

- GitLab：Personal access tokens 里 revoke `kaola-smoke`；项目 `kaola-tasks-smoke` 可删。
- 工作台：删掉对应凭证档案；吊销 Agent Key。
- GitHub 上早先的 `KaolaBrother/kaola-tasks-smoke` 若还在、且确认不用，可删。
