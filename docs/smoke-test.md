# GitLab / Gitea 冒烟手册

可重复的闭环，不是 backlog。**本轮结果只写这个文件**，不要写进 GitHub issue。

**发布面只有 GitLab 和 Gitea。** 产品代码里 GitHub 适配器仍在（见 `docs/DESIGN.md`），但这条手册不发 GitHub 任务、不要 `GITHUB_TOKEN`、不跑 `scripts/forge-smoke.ts github`。认领者不需要自己的 forge 账号或 PAT；认领身份是设备证明（`~/.kaola/device.json` Ed25519）加管理员远程配对。

每家走同一条形状：导入 Issue → 凭证档案 → 发布 → 电脑配对 → `claim_task` → 按 `clone` 四键改仓开 PR → `submit_pr` → 合并 → 轮询 `已完成` → 源 Issue 三条回写（认领 / 提交PR / 完成）。

标了 **配合** 的步骤：自动化跑不了（OAuth 授权页、浏览器会话、只显示一次的令牌、页面点选）。到这些步必须**停下来和人一起做**，不要自己猜、不要让人把 Secret 贴到聊天里。

认领侧契约以 GitHub [#23](https://github.com/KaolaBrother/KaolaTasks/issues/23) **最新评论**为准（不要重开 #22）。

## 怎么分工

| 标记 | 谁做 | 规则 |
|------|------|------|
| **自动** | Agent 可单独做 | 测命令、起服务、查 SQLite、调不需要浏览器 cookie 的 API、用已写入 `.env` 且 gitignore 的令牌调 forge API、已配对后走 MCP |
| **配合** | 人和 Agent **当场一起做** | 浏览器登录、在页面里贴仓库令牌、点导入/发布、Authorize、**管理员在网页把待授权电脑绑到人并批准**。人操作页面；Agent 报下一步填什么、事后核 SQLite / 网络响应。令牌只进 `.env` 或页面输入框 |

`.env` 已 gitignore。需要 PAT 时，人把值写进本地 `.env`，聊天里只说「写好了」。

## 两种跑法

### A. 本机浏览器（人在场）

原点 **http://localhost:31415**（必须 `localhost`，不要 `127.0.0.1`，否则登录 cookie 对不上）。仓库根目录 `pnpm dev`（先 `export` / `source .env`）。`SQLITE_PATH` 指向文件库（不要默认内存库）。

登录：空库先走初始向导（`POST /api/v1/setup`），不要用空库 OAuth 抢 `full`。`registerAuth` 启动时三家 OAuth 客户端 env 都必须非空；GitHub 只占位（`GET /login/github` 为 404）。本机活测：向导建本地管理员后，再用 GitLab.com OAuth 登录成为发布者（`active` + `full`，不是管理员）。Gitea OAuth 在仍是 `unused` 时不能用来登录考拉。发布 GitLab / Gitea 任务用已登录管理员或发布者的对应凭证档案。电脑绑定仍是管理员。

### B. 注入会话脚本（Cloud Agent / 无人值守）

浏览器 Authorize 过不了（Cloudflare 人机、无交互）时，不要假装走了网页登录。用隔离 SQLite + Fastify `inject`：先 `ensureSetup`（本地管理员），再 stub GitLab OAuth userinfo（考拉用户记成 `gitlab` / `KaolaBrother` / `full` 发布者，不是空库抢权），forge 调用走真实 API：

```bash
pnpm smoke:forge -- gitlab
pnpm smoke:forge -- gitea
```

需要 `SESSION_SECRET`、`VAULT_MASTER_KEY`，以及对应的 `GITLAB_TOKEN` / `GITEA_TOKEN`。脚本自己 `buildApp`，**不**碰正在跑的 `pnpm dev`。不打印 token，不把 token 写入 remote URL。传入 `github` 会明确失败（发布面不含 GitHub）。

## 目标仓与令牌

两家各用同名私有仓 `KaolaBrother/kaola-tasks-smoke`（可删）。任务描述统一：`smoke: append a line to README`。

| Forge | 仓 | 令牌 env | 推荐令牌 | Issue URL（考拉能解析） |
|-------|----|----------|----------|-------------------------|
| GitLab | [KaolaBrother/kaola-tasks-smoke](https://gitlab.com/KaolaBrother/kaola-tasks-smoke) | `GITLAB_TOKEN` | **Legacy** PAT（不要 Fine-grained），`api` + `write_repository` | `https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/N`（不要 `/-/work_items/`） |
| Gitea | [KaolaBrother/kaola-tasks-smoke](https://gitea.com/KaolaBrother/kaola-tasks-smoke) | `GITEA_TOKEN` | 至少 `read:user` + `write:user` + `write:repository` + `write:issue` | `https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/N` |

`GITLAB_TOKEN` 和 `OAUTH_GITLAB_CLIENT_SECRET` 不是同一个东西。认领揭示的是档案里那份仓库 token，不是认领者自己的 PAT。

## 认领怎么走（#23）

```
POST /api/v1/setup → local active+admin（空库 OAuth 不得插用户）
已有管理员后 GitLab / Gitea OAuth → active+full 发布者（KAOLA_ADMINS 忽略）
认领 Agent：kaola-mcp --url … 调 MCP（list_tasks / claim_task 都算）
  → 合法未绑定签名：HTTP 202 { error: 'authorization_required', pending: true, expires_at }
管理员：工作台「电脑」→「待授权电脑」→「绑到我自己」（POST bind { bind_to_self: true }）
认领 Agent：同一把 ~/.kaola/device.json 再调 MCP → 再 claim_task → 201 才拿到该任务 forge token
```

两把凭证不要混：仓库 token 在发布者侧、只在 claim 成功时下发；考拉身份是「人 + 这台电脑」。MCP 配置无密钥（`apps/mcp/examples/mcp.json` 只有 `kaola-mcp --url`）。**不要**生成 Agent Key，**不要**配 `KAOLA_AGENT_KEY`，**不要**往 mcp.json 贴 Bearer / PAT。

口头让 Agent 去领时不要带 `autonomous`。网页没有「认领」按钮。

## 标准闭环（每家重复一遍）

| # | 步骤 | A 浏览器 | B 脚本 |
|---|------|----------|--------|
| 1 | 考拉有可登录管理员，再有发布者 | **配合** 初始向导，再 GitLab 登录（发布者） | **自动** `ensureSetup` 再 stub GitLab OAuth userinfo（`full`） |
| 2 | 令牌在 `.env` | **配合** | 环境里已有则 **自动** |
| 3 | 冒烟仓有一条 open Issue | **自动**（有 token 后用 API 建） | **自动** |
| 4 | 工作台添加该 forge 的凭证档案 | **配合** | **自动** `POST /api/v1/credential-profiles` |
| 5 | 从 Issue 导入并发布 | **配合** 来源「从 Issue 导入」、凭证「共享档案」、下拉选 Issue，点导入再发布 | **自动** `POST /import` 再 `POST /tasks` |
| 6 | Agent 申请这台电脑 | **自动** 第一次 MCP → `authorization_required` | **自动** `pairDeviceToSelf` |
| 7 | 管理员一天内把电脑绑到自己 | **配合** | **自动** |
| 8 | 人指定任务 id；`claim_task` 只传 `task_id` | **配合** 指定 / **自动** 认领 | **自动** |
| 9 | 按 `clone` 四键 clone、改 README、推分支、开 PR | **自动**（人确认任务后） | **自动** |
| 10 | `submit_pr` | **自动** | **自动** |
| 11 | 合并 PR，看任务变已完成；源 Issue 三条回写 | **配合** 点 Merge；Agent 核 SQLite | **自动** 调 forge merge + `pollPendingReviews` |

导入用档案下拉，不要粘贴 GitLab 的 `/-/work_items/…`。inline token 回退才手填 URL。

## clone 信封（实测）

`clone` 恰四键：`suggested_dir` / `token_usage` / `remote_url`（无凭证的 HTTPS git URL）/ `extra_header`（`value_pattern` 含字面量 `${token}`）。**不要**把 token 写进 remote URL（会落盘 `.git/config`）。

| Forge | 信封 `extra_header` | git HTTP 实测 |
|-------|---------------------|---------------|
| GitLab | `Authorization: Bearer ${token}` | **git 要 Basic `oauth2:token`**；信封 Bearer 会被 401。同一 token 调 **API** 用 `PRIVATE-TOKEN` 成功 |
| Gitea | `Authorization: token ${token}` | **按信封即可** clone/push |

目录用 `clone.suggested_dir`。Cloud Agent / 云端 Runtime 访问不了操作者笔记本上的 `localhost:31415`；接单用本机 Cursor，或走脚本 B。

## 禁止

- 不要点仍为 `unused` 的登录按钮。
- 不要人手往 mcp.json 里贴 secret。
- 第一次 MCP 对不上身份时必须是**等待管理员**，不是匿名成功，也不是用生成钥匙来换 200。批准瞬间不会 claim。
- 待批准窗口 **1 天**，同一公钥在 pending 内重复询问不续期。
- 会话在 Fastify 内存里，不在 SQLite。换进程后要重新登录才能在网页批准电脑（又是 **配合**）。
- 旧 sqlite `leases.agent_key_id NOT NULL` 会挡 claim（`createDb` 已重建）。
- 不要为发布冒烟申请或粘贴 `GITHUB_TOKEN`。

## 本轮记录

| 轮 | 何时 | 跑法 | GitLab | Gitea |
|----|------|------|--------|-------|
| 本机 | 2026-08-22–24 | A 浏览器 | [Issue #1](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/1) → [MR !1](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/1)，任务 `kt-2026-0001` `已完成` | [Issue #1](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/1) → [PR #4](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/4)，任务 `kt-2026-0002` `已完成` |
| Cloud Agent | 2026-08-25 上午 | B 注入会话（手写） | [Issue #4](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/4) → [MR !3](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/3) | [Issue #5](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/5) → [PR #6](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/6) |
| 手册脚本 | 2026-08-25 | B `scripts/forge-smoke.ts` | [Issue #6](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/6) → [MR !4](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/4)，`clone_auth=gitlab-basic-oauth2`，`已完成` | [Issue #7](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/7) → [PR #8](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/8)，`clone_auth=envelope`，`已完成` |
| 手册脚本（GitLab stub / 无 GitHub 发布） | 2026-08-25 | B `pnpm smoke:forge -- gitlab` / `gitea` | [Issue #8](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/8) → [MR !6](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/6)，`clone_auth=gitlab-basic-oauth2`，`已完成` | [Issue #10](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/10) → [PR #11](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/11)，`clone_auth=envelope`，`已完成` |
| 手册脚本（#28 后 ensureSetup） | 2026-08-26 | B `pnpm smoke:forge -- gitlab` / `gitea` | [Issue #9](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/9) → [MR !7](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/7)，任务 `kt-2026-0001`，`clone_auth=gitlab-basic-oauth2`，`已完成` | [Issue #12](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/12) → [PR #13](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/13)，任务 `kt-2026-0001`，`clone_auth=envelope`，`已完成` |

GitHub 发布冒烟已停（此前仓 [Issue #1](https://github.com/KaolaBrother/kaola-tasks-smoke/issues/1) 开过、未走认领，已标 `not_planned` 关闭）。stdio 桥回放 `mcp-session-id` 已进 `main`；另窗 UAT 曾用短提示词走完认领到 `submit_pr`。

## 坑（续测别踩）

- GitLab Issues API 的 `web_url` 是 `/-/work_items/N`，考拉 `parseIssueUrl` 不认。导入必须用拼出来的 `/-/issues/N`（脚本已这么做）。
- GitLab 回调 `400`：常为未走 PKCE，或 secret 用 HTTP Basic 编码失败。从首页重新点登录。回调必须是 `http://localhost:31415/login/gitlab/callback`。
- Gitea 选中档案后 base_url 不会自动从 gitlab.com 改掉，须手填 `https://gitea.com`。
- gitea.com 建仓：`POST /user/repos` 要 `write:user`，`GET /user` 要 `read:user`。
- GitLab.com **git** 不吃信封 Bearer；Gitea.com **git** 吃信封 `token`。
- GitLab `PUT …/merge_requests/:iid/merge` 在 `detailed_merge_status` 还是 checking 时返回 **405**；脚本等到 `mergeable` 再合。
- 隔离 sqlite 每次从 `kt-2026-0001` 起号，冒烟分支必须带时间戳，否则会撞上次的 `kaola/kt-2026-0001-smoke`。

## 测完可收

- 两家：撤销冒烟 PAT；项目 `kaola-tasks-smoke` 可删。
- 工作台：删掉对应凭证档案；**解除这台电脑的授权**（不要再走「吊销 Agent Key」当收尾）。
