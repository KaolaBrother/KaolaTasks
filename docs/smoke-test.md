# 本机冒烟进度

这是**活测日志**，不是 backlog。进度只改这个文件，不要写进 GitHub issue。

续测前先读「怎么分工」，再看进度表。标了 **配合** 的步骤：自动化跑不了（OAuth 授权页、浏览器会话、只显示一次的令牌、页面点选）。到这些步必须**停下来和人一起做**，不要自己猜、不要让人把 Secret 贴到聊天里。

认领侧契约以 GitHub [#23](https://github.com/KaolaBrother/KaolaTasks/issues/23) **最新评论**为准（不要重开 #22）。代码落地前，#12 起会停在等待态，不要用生成 `ktk_…` 或往 mcp.json 贴 Bearer 来绕过。

## 怎么分工

| 标记 | 谁做 | 规则 |
|------|------|------|
| **自动** | Agent 可单独做 | 测命令、起服务、查 SQLite、调不需要浏览器 cookie 的 API、用已写入 `.env` 且 gitignore 的令牌调 GitLab API、用已配对的本机 MCP 再查一轮 |
| **配合** | 人和 Agent **当场一起做** | 浏览器登录、在页面里贴仓库令牌、点导入/发布、GitLab Authorize、**管理员在网页把待授权电脑绑到人并批准**。人操作页面；Agent 报下一步填什么、事后核 SQLite / 网络响应。令牌只进 `.env` 或页面输入框 |

`.env` 已 gitignore。需要 PAT 时，人把值写进本地 `.env`，聊天里只说「写好了」。

## 环境

- 原点：**http://localhost:31415**（必须 `localhost`，不要 `127.0.0.1`，否则登录 cookie 对不上）
- 启动：仓库根目录 `pnpm dev`（先 `export` / `source .env`）
- SQLite：`SQLITE_PATH` → `kaola-dev.sqlite`（不要用默认内存库）
- 登录身份：GitLab.com OAuth → 用户 `KaolaBrother`，`active` + `full`（本轮既是发布者，也是批准电脑的管理员）
- 本轮目标仓：GitLab 私有项目 [KaolaBrother/kaola-tasks-smoke](https://gitlab.com/KaolaBrother/kaola-tasks-smoke)（早先垫过的 GitHub 同名仓**不用**）
- 导入：#19 已落地。来源选「从 Issue 导入」、凭证选「共享档案」后，下拉选仓库档案再下拉选 Issue，点「导入」预览，再「发布」。不要粘贴 GitLab 页面上的 `/-/work_items/…`。inline token 回退才需要手填 URL，那条必须是：

  `https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/1`

## 认领怎么走（#23）

```
发布者：OAuth + 该仓 forge token → 发布任务
认领 Agent：MCP 启动（list / claim 都算）→ 对不上电脑/身份则挂起（无 token，最多等管理员 1 天）
管理员：网页把这台电脑绑到某个用户并批准
认领 Agent：再查一轮 → 配对成功 → 再 claim → 才拿到该任务的仓库 token
```

两把凭证不要混：仓库 token 在发布者侧、只在 claim 成功时下发；考拉身份是「人 + 这台电脑」，证据在服务端。Cursor / Claude Code / Codex 的 MCP 配置无密钥，换 Runtime 不复制钥匙。

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
| 10 | 认领者生成 Agent Key | — | **取消** | 不要生成 `ktk_…`，不要 `KAOLA_AGENT_KEY`，不要往 mcp.json 贴 Bearer。考拉身份按 [#23](https://github.com/KaolaBrother/KaolaTasks/issues/23) 走电脑配对。仓库 token 已由发布者附在任务上（#6–#8） |
| 11 | 本机装考拉 MCP（无密钥） | 自动 | 部分完成 | 2026-08-24：`~/.cursor/mcp.json` 的 `kaola-tasks` 只有 URL，无 Bearer、无 forge token（这是对的）。落地后同一条无密钥配置也给 Claude Code / Codex 用（stdio 桥或 URL，以 #23 实现为准）。**现状：** #23 未落地，无配对的 `POST /api/mcp` 仍 401，还不是设计里的等待态 |
| 12 | Agent 第一次 MCP：申请这台电脑 | 自动 | 未做 | **接单从这里开始**，不要先打开网页贴码。调 `list_tasks`（或开始 `claim_task`）。对不上身份/电脑 → **等待态**（`authorization_required` / `pending: true`，约 1 天后 `expires_at`）。**无**仓库 token、**无**租约，看板仍 `待认领`。本机应出现 `~/.kaola/` 设备密钥（私钥不上聊天、不上服务端）。SQLite `devices` 一条 `pending`。未过期时再调 MCP 只复用这条，不续期 |
| 13 | 管理员一天内批准这台电脑 | **配合** | 未做 | 人用 `KaolaBrother` 登录工作台，看到待授权电脑（hostname、指纹、申请时间、到期），把它绑到用户 `KaolaBrother` 并批准。限 **1 天**。超时作废，须 Agent 重新走 #12。批准**不会**自动 claim，也**不会**下发仓库 token |
| 14 | Agent 再查一轮；人指定任务 | **配合** | 未做 | 同一把本机密钥再调 MCP。配对成功后才能真正 `list_tasks`。人指定 `kt-2026-0001`（`smoke: append a line to README`）。`get_task_brief` **不含** token。`repo`：`gitlab` / `https://gitlab.com` / `KaolaBrother/kaola-tasks-smoke`，`suggested_dir` `kaola-tasks-smoke`。在**新目录新 session**测认领 |
| 15 | 指示认领 `claim_task` | 自动（已配对） | 未做 | 只传 `task_id`，**不要** `autonomous`。成功：看板 `进行中`；顶层 `token` 是**这一条任务**的 GitLab PAT（发布者附上的）。不写进 mcp.json、不写进 remote URL。网页没有认领按钮 |
| 16 | 本机 clone GitLab，改 README | 自动（人确认任务后） | 未做 | 只用 #15 揭示的 token，按 `clone.extra_header` + `clone.remote_url` 进 `clone.suggested_dir`。这是该 Issue 的临时仓库权，用完不落盘。`README.md` 末尾加一行 `Smoke test OK.` |
| 17 | 推分支、开 MR，再 `submit_pr` | **配合** | 未做 | 同一 token 推分支、用 GitLab API 开 MR（认领者不必在该仓有自己的 GitLab 账号）。MCP `submit_pr` 交 `pr_url`；任务应变 `待验收` |
| 18 | 合并 MR，看任务变已完成 | **配合** | 未做 | 人在 GitLab 点 Merge。默认约 60s 轮询；导入型应给源 Issue `#1` 回写评论 |

## 当前停在哪

**#1–#9 完成（发布者已附仓库 token）；#10 取消；#11 MCP 无密钥 URL 已写入 Cursor。** 板上仍是 `kt-2026-0001` / `待认领`。

**下一步是 #23 落地之后的 #12。** 认领 Agent 直接 MCP 启动；对不上电脑则挂起，等管理员在网页批准（本轮管理员就是已登录的 `KaolaBrother`），再查一轮才配对成功，然后才 `claim_task`。

**不要**生成 Agent Key，**不要**配 `KAOLA_AGENT_KEY`，**不要**重开或改 #22。

## 本轮之后（不写入本表状态，只作规划）

| 项 | 记在哪 | 和冒烟的关系 |
|----|--------|----------------|
| clone 信封四键含 `remote_url` + 按 forge 的 `extra_header` | GitHub [#20](https://github.com/KaolaBrother/KaolaTasks/issues/20) | 代码已落地；冒烟仍用 `clone.remote_url` + `clone.extra_header`。本表步骤未重跑 |
| 发布页导入后只读展示 Issue，去掉验收/路径/优先级等表单项 | GitHub [#21](https://github.com/KaolaBrother/KaolaTasks/issues/21) | 代码已落地；本轮冒烟发布步骤未重跑 |
| 电脑配对 + 管理员一天内批准；claim 才下发仓库 token | GitHub [#23](https://github.com/KaolaBrother/KaolaTasks/issues/23) | **以最新评论为准。** 挡住本表 #12 起。落地后按 #12→#18 测，不要用 `ktk_…` 绕过 |

## 坑（续测别踩）

- 三个 OAuth 客户端启动时都必须非空；不用的 GitHub/Gitea 可填 `unused`，**不要点那两个登录按钮**。本轮认领不走 GitHub 登录。
- `GITLAB_TOKEN`（Legacy PAT）和 `OAUTH_GITLAB_CLIENT_SECRET`（OAuth 应用密钥）不是同一个东西。认领揭示的是档案里那份 GitLab token，不是 OAuth 密钥。
- GitLab 新 UI 常把 Issue 显示成 `/-/work_items/N`；考拉只解析 `/-/issues/N`（以及遗留 `/issues/N`）。
- 网页没有「认领」按钮；认领只走 MCP（或已配对后的 Bearer REST）。口头让 Agent 去领时不要带 `autonomous`。
- **不要人手往 mcp.json 里贴 secret。** 认领者 MCP 无密钥：不配 `ktk_…`、不配仓库 PAT。仓库 token 只在 claim 成功后给这次 git 用。
- 第一次 MCP 对不上身份时必须是**等待管理员**，不是匿名成功，也不是用生成钥匙来换 200。批准之后必须 **Agent 再查一轮** 才算配对成功；批准瞬间不会 claim。
- 待批准窗口 **1 天**，同一公钥在 pending 内重复询问不续期。超时须重新走 #12。
- Cloud Agent / 云端 Runtime 访问不了 `localhost:31415`。接单用本机 Cursor / 本机 Claude Code / 本机 Codex。
- clone 不要把 token 写进 remote URL。用 `clone.remote_url` + `clone.extra_header`（gitea `token ${token}`，GitLab `Bearer ${token}`），目录 `clone.suggested_dir`。
- 会话在 Fastify 内存里，不在 SQLite。换进程后要重新登录才能在网页批准电脑（又是 **配合**）。
- GitLab 回调若出现 `Response Error: 400 Bad Request`：是 `/oauth/token` 被拒（常为未走 PKCE，或 secret 用 HTTP Basic 编码失败）。从首页重新点登录，不要刷新回调 URL。GitLab 应用回调必须是 `http://localhost:31415/login/gitlab/callback`。

## 测完可收

- GitLab：Personal access tokens 里 revoke `kaola-smoke`；项目 `kaola-tasks-smoke` 可删。
- 工作台：删掉对应凭证档案；**解除这台电脑的授权**（不要再走「吊销 Agent Key」当收尾）。
- GitHub 上早先的 `KaolaBrother/kaola-tasks-smoke` 若还在、且确认不用，可删。
