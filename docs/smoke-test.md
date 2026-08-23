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
- 导入用这一条（不要用 GitLab 页面上的 `/-/work_items/…`，`parseIssueUrl` 不认）：

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
| 8 | 工作台添加 GitLab 凭证档案 | **配合** | 未做 | 人在页面填：Forge `gitlab`，base_url `https://gitlab.com`，仓库 `KaolaBrother/kaola-tasks-smoke`，token 用本机 `GITLAB_TOKEN`（不要发聊天） |
| 9 | 从 Issue 导入并发布 | **配合** | 未做 | 来源选「从 Issue 导入」；Issue URL 用上一节那条 `/-/issues/1`；先「导入」再「发布」。成功后把任务 public id（如 `kt-2026-0001`）告诉 Agent |
| 10 | 生成 Agent Key | **配合** | 未做 | 明文 `ktk_…` 只出现一次。写入 `.env` 的 `KAOLA_AGENT_KEY=`，聊天只说「写好了」 |
| 11 | Bearer / MCP 认领 | 自动（Key 就位后） | 未做 | `POST /api/v1/tasks/:id/claim` 或 MCP `claim_task`。指示路径不要带 `autonomous` |
| 12 | Agent 改仓、开 MR，再 `submit_pr` | **配合** | 未做 | clone/推/开 MR 用任务揭示的 forge token，在人的环境里做；`submit_pr` 可由配了 MCP 的客户端或人确认后由 Agent 调 |
| 13 | 合并 MR，看任务变已完成 | **配合** | 未做 | 人在 GitLab 点 Merge。默认约 60s 轮询；导入型任务应给源 Issue 回写评论 |

当前卡在 **#8–#9**：人和 Agent 一起对着工作台做凭证 + 导入发布。

## 坑（续测别踩）

- 三个 OAuth 客户端启动时都必须非空；不用的 GitHub/Gitea 可填 `unused`，但不要点那两个登录按钮。
- `GITLAB_TOKEN`（Legacy PAT）和 `OAUTH_GITLAB_CLIENT_SECRET`（OAuth 应用密钥）不是同一个东西。
- GitLab 新 UI 常把 Issue 显示成 `/-/work_items/N`；考拉只解析 `/-/issues/N`（以及遗留 `/issues/N`）。
- 网页没有「认领」按钮；认领只走 Agent Key（MCP 或 Bearer REST）。
- 会话在 Fastify 内存里，不在 SQLite。换进程后要重新登录（又是 **配合**）。

## 测完可收

- GitLab：Personal access tokens 里 revoke `kaola-smoke`；项目 `kaola-tasks-smoke` 可删。
- 工作台：删掉对应凭证档案；吊销 Agent Key。
- GitHub 上早先的 `KaolaBrother/kaola-tasks-smoke` 若还在、且确认不用，可删。
