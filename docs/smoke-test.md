# 本机冒烟进度

这是**活测日志**，不是 backlog。进度只改这个文件，不要写进 GitHub issue。

续测前先读「怎么分工」，再看进度表。标了 **配合** 的步骤：自动化跑不了（OAuth 授权页、浏览器会话、只显示一次的令牌、页面点选）。到这些步必须**停下来和人一起做**，不要自己猜、不要让人把 Secret 贴到聊天里。

认领侧契约以 GitHub [#23](https://github.com/KaolaBrother/KaolaTasks/issues/23) **最新评论**为准（不要重开 #22）。本轮 #12 起已按电脑配对活测到闭环。

## 怎么分工

| 标记 | 谁做 | 规则 |
|------|------|------|
| **自动** | Agent 可单独做 | 测命令、起服务、查 SQLite、调不需要浏览器 cookie 的 API、用已写入 `.env` 且 gitignore 的令牌调 GitLab / Gitea API、用已配对的本机 MCP 再查一轮 |
| **配合** | 人和 Agent **当场一起做** | 浏览器登录、在页面里贴仓库令牌、点导入/发布、GitLab Authorize、**管理员在网页把待授权电脑绑到人并批准**。人操作页面；Agent 报下一步填什么、事后核 SQLite / 网络响应。令牌只进 `.env` 或页面输入框 |

`.env` 已 gitignore。需要 PAT 时，人把值写进本地 `.env`，聊天里只说「写好了」。

## 环境

- 原点：**http://localhost:31415**（必须 `localhost`，不要 `127.0.0.1`，否则登录 cookie 对不上）
- 启动：仓库根目录 `pnpm dev`（先 `export` / `source .env`）
- SQLite：`SQLITE_PATH` → `kaola-dev.sqlite`（不要用默认内存库）
- 登录身份：GitLab.com OAuth → 用户 `KaolaBrother`，`active` + `full`（本轮既是发布者，也是批准电脑的管理员）
- 本轮目标仓：GitLab 私有项目 [KaolaBrother/kaola-tasks-smoke](https://gitlab.com/KaolaBrother/kaola-tasks-smoke)（早先垫过的 GitHub 同名仓**不用**）
- **Gitea 闭环（G1–G8 完成）**：实例 `https://gitea.com`。**不要**点「使用 Gitea 登录」——OAuth 仍是 `unused`，发任务用已登录的 GitLab `KaolaBrother`。仓库 [KaolaBrother/kaola-tasks-smoke](https://gitea.com/KaolaBrother/kaola-tasks-smoke)，token 在 `.env` 的 `GITEA_TOKEN`。任务 `kt-2026-0002` 从 [Issue #1](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/1) 导入，现已 `已完成`。Issue URL 形如 `https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/1`（不是 GitLab 的 `/-/issues/`）
- 导入：#19 已落地。来源选「从 Issue 导入」、凭证选「共享档案」后，下拉选仓库档案再下拉选 Issue，点「导入」预览，再「发布」。不要粘贴 GitLab 页面上的 `/-/work_items/…`。inline token 回退才需要手填 URL，那条必须是：

  `https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/1`

## 认领怎么走（#23，已落地）

```
空库首次 OAuth → 该用户即 active+full 管理员（无需先配 KAOLA_ADMINS）
认领 Agent：本机 kaola-mcp --url … 调 MCP（list_tasks / claim_task 都算）
  → 合法未绑定签名：HTTP 202 { error: 'authorization_required', pending: true, expires_at }
管理员：工作台「电脑」→「待授权电脑」→「绑到我自己」（POST bind { bind_to_self: true }）
认领 Agent：同一把 ~/.kaola/device.json 再调 MCP → 再 claim_task → 201 才拿到该任务 forge token
```

两把凭证不要混：仓库 token 在发布者侧、只在 claim 成功时下发；考拉身份是「人 + 这台电脑」，证据在服务端。Cursor / Claude Code / Codex 的 MCP 配置无密钥（`apps/mcp/examples/mcp.json` 只有 `kaola-mcp --url`），换 Runtime 不复制 `ktk_`。

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
| 11 | 本机装考拉 MCP（无密钥） | 自动 | 完成 | 2026-08-24：`~/.cursor/mcp.json` 的 `kaola-tasks` 改为 stdio 桥 `apps/mcp/bin/kaola-mcp.mjs --url http://localhost:31415`（`cwd` `apps/mcp`，无 Bearer、无 forge token、无 `ktk_`）。PATH 上没有裸 `kaola-mcp`，故用仓库内绝对路径。模式 0600 |
| 12 | Agent 第一次 MCP：申请这台电脑 | 自动 | 完成 | 2026-08-24：`initialize` 与 `list_tasks` 均为等待态（桥 stderr `MCP authorization_required`；JSON-RPC `-32000` `authorization_required pending until 2026-08-25T06:44:16.000Z`）。无仓库 token。SQLite `devices` id=1 `pending`，窗口 86400s，`claimant_id`/`user_id` 空；本机 `~/.kaola/device.json` mode 600。第二次询问过期时间未刷新。`kt-2026-0001` 仍 `待认领`，`leases` 0。无新的 `token 揭示` |
| 13 | 管理员一天内把电脑绑到自己 | **配合** | 完成 | 2026-08-24 07:15Z：`devices` id=1 `active`，`user_id=1`（KaolaBrother），`expires` 30 天；`events` `电脑授权`。第一次点绑未落库（会话空、待授权列表空时按钮是空操作）。第二次绑上 |
| 14 | Agent 再查一轮；人指定任务 | **配合** | 完成 | 配对后 `list_tasks` / `get_task_brief` HTTP 200，**无** token。人指定 `kt-2026-0001`。`repo` gitlab / `https://gitlab.com` / `KaolaBrother/kaola-tasks-smoke`，`suggested_dir` `kaola-tasks-smoke` |
| 15 | 指示认领 `claim_task` | 自动（已配对） | 完成 | 只传 `task_id`，无 `autonomous`。第一次因旧库 `leases.agent_key_id NOT NULL` 失败（任务被写成 `进行中` 但无租约）；已给 `createDb` 加重建迁移，任务打回 `待认领` 后重试成功：`进行中`，顶层 token 为 `glpat-…`，`clone` 四键齐，`leases.device_id=1` `agent_key_id` 空。token 未进 mcp.json / remote URL。有 `token 揭示` 与认领 `回写` |
| 16 | 本机 clone GitLab，改 README | 自动（人确认任务后） | 完成 | 目录 `/tmp/kaola-smoke-work/kaola-tasks-smoke`。**GitLab.com git HTTP 不接受信封里的 `Authorization: Bearer ${token}`**（401，`WWW-Authenticate: Basic`）。API 用 Bearer 为 200。clone/push 改用 extraHeader `Authorization: Basic`（oauth2:token），**未**写入 remote URL；`.git/config` 无 token。`README.md` 末行 `Smoke test OK.` |
| 17 | 推分支、开 MR，再 `submit_pr` | **配合** | 完成 | 分支 `kaola/kt-2026-0001-smoke`；GitLab API 开 [MR !1](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/1)；MCP `submit_pr` 后任务 `待验收`，又一条 `回写` |
| 18 | 合并 MR，看任务变已完成 | **配合** | 完成 | 2026-08-24 07:59Z：人 Merge 后轮询把任务打成 `已完成`（`actor_user_id` 空）；`submissions.pr_state` `merged`。源 Issue #1 三条回写：认领 / 提交PR / 完成（完成评论含 `kt-2026-0001` 与 MR !1） |
| G1 | 注册 gitea.com 并写入 `GITEA_TOKEN` | **配合** | 完成 | 2026-08-24：账号 `KaolaBrother`。首把 token 缺 `read:user`/`write:user` 建仓 403；换一把勾 `read:user`+`write:user`+`write:repository`+`write:issue` 后 `GET /user` 200 |
| G2 | 建 Gitea 私有仓并开 Issue | 自动 | 完成 | 私有仓 [KaolaBrother/kaola-tasks-smoke](https://gitea.com/KaolaBrother/kaola-tasks-smoke)。#1 `smoke: append a line to README`（导入这条）；#2 `.gitignore`、#3 LICENSE 留在 Gitea |
| G3 | 工作台添加 Gitea 凭证档案 | **配合** | 完成 | SQLite `credential_profiles` id=2：`gitea` / `https://gitea.com` / `KaolaBrother/kaola-tasks-smoke`；`events` `变更` create。Gitea 选中后 base_url 不会自动从 gitlab.com 改掉，须手填 |
| G4 | 从 Gitea Issue 导入并发布 | **配合** | 完成 | 任务 `kt-2026-0002`：标题 `smoke: append a line to README`，`imported` / `gitea` / `KaolaBrother/kaola-tasks-smoke`，源 `https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/1`，档案 id=2。导入与发布各一条 `token 揭示` outcome ok（不含明文） |
| G5 | 另窗 MCP 列工具，人指定任务 | **配合** | 完成 | 2026-08-24 20:35 另窗：人只说「用kaolatasks列出可以认领的任务」。第一次 discovery 报连不上，`mcp_auth` 后再 `list_tasks` `status=待认领` 只返回 `kt-2026-0002`（无 token）。20:45 人指定「做 kt-2026-0002。认领后按 clone 指引改、推、开 PR，再 submit_pr。不要把 token 写进聊天或 git remote」 |
| G6 | 指示认领 `claim_task` | 自动（已配对） | 完成 | 只传 `task_id`，无 `autonomous`。`进行中`，`leases.device_id=1` `agent_key_id` 空。有 `token 揭示`（profile 2）与认领 `回写` |
| G7 | 本机 clone Gitea，改 README，开 PR | 自动（人确认任务后） | 完成 | 目录 `/Users/ylpromax5/Workspace/kaola-tasks-smoke`。信封 `Authorization: token ${token}` 对 **gitea.com git HTTP 可用**（与 GitLab.com 要 Basic 不同）。`origin` 无凭证；`.git/config` 无 token。分支 `kaola/kt-2026-0002-readme-line`；[PR #4](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/4) |
| G8 | `submit_pr` 并合并，看任务变已完成 | **配合** | 完成 | MCP `submit_pr` 后 `待验收`，提交PR `回写`。2026-08-24 12:56Z：合并后轮询打成 `已完成`（`actor_user_id` 空）；`submissions.pr_state` `merged`。源 Issue #1 三条回写：认领 / 提交PR / 完成（完成评论含 `kt-2026-0002` 与 PR #4） |

## 当前停在哪

**GitLab 闭环 #1–#18 完成。Gitea 闭环 G1–G8 完成。** 板上 `kt-2026-0001` / `kt-2026-0002` 均为 `已完成`。stdio 桥 session 回放的 Cursor 活发现 UAT 通过。

不要点「使用 Gitea 登录」。

**不要**生成 Agent Key，**不要**配 `KAOLA_AGENT_KEY`，**不要**重开或改 #22。

## 本轮之后（不写入本表状态，只作规划）

| 项 | 记在哪 | 和冒烟的关系 |
|----|--------|----------------|
| clone 信封四键含 `remote_url` + 按 forge 的 `extra_header` | GitHub [#20](https://github.com/KaolaBrother/KaolaTasks/issues/20) | 代码已落地；冒烟仍用 `clone.remote_url` + `clone.extra_header`。本表步骤未重跑 |
| 发布页导入后只读展示 Issue，去掉验收/路径/优先级等表单项 | GitHub [#21](https://github.com/KaolaBrother/KaolaTasks/issues/21) | 代码已落地；本轮冒烟发布步骤未重跑 |
| 电脑配对 + 管理员一天内绑定；claim 才下发仓库 token | GitHub [#23](https://github.com/KaolaBrother/KaolaTasks/issues/23) | **本轮冒烟已闭环到已完成。** 旧 sqlite `leases.agent_key_id NOT NULL` 会挡 claim（`createDb` 已重建）。GitLab.com **git** 不吃 Bearer extraHeader，要 Basic；API 仍是 Bearer。Gitea.com **git** 吃信封里的 `Authorization: token ${token}` |
| stdio 桥回放 `mcp-session-id`，否则 Cursor 列不出工具 | 已进 `main` `ac6bc23` | **另窗 UAT 通过**（G5）：`initialize` 后 `tools/list` 成功，短提示词可走完认领到 `submit_pr` |

## 坑（续测别踩）

- 三个 OAuth 客户端启动时都必须非空；不用的 GitHub/Gitea 可填 `unused`，**不要点那两个登录按钮**。本轮认领不走 GitHub 登录。
- `GITLAB_TOKEN`（Legacy PAT）和 `OAUTH_GITLAB_CLIENT_SECRET`（OAuth 应用密钥）不是同一个东西。认领揭示的是档案里那份 GitLab token，不是 OAuth 密钥。
- GitLab 新 UI 常把 Issue 显示成 `/-/work_items/N`；考拉只解析 `/-/issues/N`（以及遗留 `/issues/N`）。
- 网页没有「认领」按钮；认领只走 MCP（或已配对后的 Bearer REST）。口头让 Agent 去领时不要带 `autonomous`。
- **不要人手往 mcp.json 里贴 secret。** 认领者 MCP 无密钥：不配 `ktk_…`、不配仓库 PAT。仓库 token 只在 claim 成功后给这次 git 用。
- 第一次 MCP 对不上身份时必须是**等待管理员**，不是匿名成功，也不是用生成钥匙来换 200。批准之后必须 **Agent 再查一轮** 才算配对成功；批准瞬间不会 claim。
- 待批准窗口 **1 天**，同一公钥在 pending 内重复询问不续期。超时须重新走 #12。
- Cloud Agent / 云端 Runtime 访问不了 `localhost:31415`。接单用本机 Cursor / 本机 Claude Code / 本机 Codex。
- clone 不要把 token 写进 remote URL。目录 `clone.suggested_dir`。GitHub/Gitea 按信封 `extra_header`。**GitLab.com git HTTP 实测要 Basic（`oauth2:token`），信封里的 `Authorization: Bearer ${token}` 会被 401**；同一 token 调 GitLab **API** 用 Bearer 是成功的。**gitea.com git HTTP 实测按信封 `Authorization: token ${token}` 即可 clone/push。**
- gitea.com 的 Access Token **不能只勾仓库/Issue**：`POST /user/repos` 实测要求 `write:user`，`GET /user` 要求 `read:user`。冒烟至少勾 `read:user` + `write:user` + `write:repository` + `write:issue`。
- 会话在 Fastify 内存里，不在 SQLite。换进程后要重新登录才能在网页批准电脑（又是 **配合**）。
- GitLab 回调若出现 `Response Error: 400 Bad Request`：是 `/oauth/token` 被拒（常为未走 PKCE，或 secret 用 HTTP Basic 编码失败）。从首页重新点登录，不要刷新回调 URL。GitLab 应用回调必须是 `http://localhost:31415/login/gitlab/callback`。

## 测完可收

- GitLab：Personal access tokens 里 revoke `kaola-smoke`；项目 `kaola-tasks-smoke` 可删。
- Gitea：Access Token 与项目 `kaola-tasks-smoke` 同样可删。
- 工作台：删掉对应凭证档案；**解除这台电脑的授权**（不要再走「吊销 Agent Key」当收尾）。
- GitHub 上早先的 `KaolaBrother/kaola-tasks-smoke` 若还在、且确认不用，可删。
