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

浏览器 Authorize 过不了（Cloudflare 人机、无交互）时，不要假装走了网页登录。用 `scripts/forge-smoke.ts`（`pnpm smoke:forge -- gitlab|gitea`）。脚本自己 `buildApp`，**不**碰正在跑的 `pnpm dev`。不打印 token，不把 token 写入 remote URL / `.env` / mcp.json。传入 `github` 会明确失败（发布面不含 GitHub）。`parseKind` 会跳过 argv 里的 `--`，所以 `pnpm smoke:forge -- gitlab` 与直接传 `gitlab` 一样。

#### B 模拟什么（进程假、forge 真）

路径 B **只模拟考拉进程**，不模拟 GitLab / Gitea。缺 PAT 就失败，脚本**不会**编一个。Cloud Agent 环境只需两家仓库 PAT；session / vault / OAuth 占位由 `ensureSimulatedAuthEnv()` 在进程内补齐，**不要问人要这些值**。生产 `pnpm dev` 仍须操作者自己 `export` 那一套，脚本不会改生产 boot。

| 东西 | 真假 | 谁提供 |
|------|------|--------|
| `GITLAB_TOKEN` / `GITEA_TOKEN` | **真** PAT，调真实 forge HTTP 和 git | 环境必须已有；缺则 `missing env GITLAB_TOKEN` / `GITEA_TOKEN` |
| `SESSION_SECRET` | 假 | 缺或空 → `randomBytes(32).toString('hex')`；已有则不覆盖 |
| `VAULT_MASTER_KEY` | 假（仍须 64 hex，vault 才能加解密档案） | 缺或空 → 同上 64 hex；已有则不覆盖 |
| 九个 `OAUTH_*` | 假占位（`registerAuth` boot 仍 `requireEnv`） | 缺或空 → id/secret `unused`，`OAUTH_GITLAB_BASE_URL=https://gitlab.com`，`OAUTH_GITEA_BASE_URL=https://gitea.com` |
| `PUBLIC_URL` | 假 | 缺或空 → `http://localhost:31415` |
| sqlite | 假 | 临时目录隔离文件库，跑完丢掉 |
| HTTP | 混合 | 发布侧 API 用 Fastify `inject`；真实 `kaola-mcp` stdio bridge 连接同一应用的临时 `127.0.0.1` listener |
| 登录 | 假 | `ensureSetup` 本地管理员，再 stub GitLab OAuth userinfo（用户记成 `gitlab` / `KaolaBrother` / `full` 发布者，不是空库抢权） |
| 电脑绑定 | 假 | `pairDeviceToSelf`（绑到 setup 管理员） |
| MCP | 真 | 生产 `apps/mcp/src/main.ts` stdio bridge；每次调用都以新进程语义重新初始化，并复用临时 `KAOLA_HOME` 的设备身份与 Claim receipt |
| 建 Issue、clone、开 PR、合并、回写评论 | **真** | 用 PAT 打 `KaolaBrother/kaola-tasks-smoke` |

```bash
pnpm smoke:forge -- gitlab
pnpm smoke:forge -- gitea
```

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

**Claim identity（#36/#31，已实测）：** 调用方仍只给 `claim_task` 传 `task_id`；生产 stdio bridge 会在转发前生成并持久化 `request_id`。成功信封的 `lease` 必须有 `clm_` 前缀的 `claim_id`。随后用全新的 bridge 进程调用 `report_progress` / `release_task` / `submit_pr` 时，bridge 从无密钥 receipt 恢复并自动附加同一个 `claim_id`，调用方不需要手工保存。#31 的设备锁定也已实测：同一账号绑定的另一台设备即使拿到正确 `claim_id`，也必须收到 `403`，不能心跳或改变该 Claim。

脚本还覆盖两种恢复：同一 `request_id` 的 active Claim 重放必须返回同一 `claim_id` 和同一仓库凭证，不新增 lease；Claim 被 `release_task` 终止后，新 bridge 进程先收到 typed `claim_request_conflict`，只轮换一次 `request_id`，再得到新的 `claim_id`。这一过程是局部恢复，不是 hard gate；失败只影响当前操作，不阻断服务器或其他任务。

## 标准闭环（每家重复一遍）

| # | 步骤 | A 浏览器 | B 脚本 |
|---|------|----------|--------|
| 1 | 考拉有可登录管理员，再有发布者 | **配合** 初始向导，再 GitLab 登录（发布者） | **自动** `ensureSetup` 再 stub GitLab OAuth userinfo（`full`） |
| 2 | 仓库 PAT | **配合** 写入 `.env` | 环境已有 `GITLAB_TOKEN` / `GITEA_TOKEN` 则 **自动**；session / vault / OAuth 由脚本自填 |
| 3 | 冒烟仓有一条 open Issue | **自动**（有 token 后用 API 建） | **自动** |
| 4 | 工作台添加该 forge 的凭证档案 | **配合** | **自动** `POST /api/v1/credential-profiles` |
| 5 | 从 Issue 导入并发布 | **配合** 来源「从 Issue 导入」、凭证「共享档案」、下拉选 Issue，点导入再发布 | **自动** `POST /import` 再 `POST /tasks` |
| 6 | Agent 申请这台电脑 | **自动** 第一次 MCP → `authorization_required` | **自动** `pairDeviceToSelf` |
| 7 | 管理员一天内把电脑绑到自己 | **配合** | **自动** |
| 8 | 人指定任务 id；`claim_task` 只传 `task_id`，bridge 自动补 `request_id` 并保存 `claim_id` receipt | **配合** 指定 / **自动** 认领 | **自动** |
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

## 公网 HTTPS 入口（#46）

路径 A 的原点仍是 **http://localhost:31415**。公网 `PUBLIC_URL` 的真实主机名 / `<https-port>` 只写在本地 `.env`、操作者配置或用户本机 MCP 配置，不要写进本手册、仓库共享 MCP 示例或 git。两种模式的验收**分开**，都是 **配合**（或未授权的生产机则跳过 live）：

### `DEBUG_PRIVATE_CA` — 已登记设备冒烟

- Leaf 由受控开发根 CA 签发，SAN 含 `<public-host>`（不是 CN-only 自签名 leaf）。
- 客户端信任分两次（DESIGN §16 / §16.7），不要把 MCP 额外 CA 当成系统信任：本机先 `kaola-mcp trust install` 核验同一份公开根 CA（不含私钥）并写入用户级 state；`kaola-mcp --url` launcher 只从该 state 注入桥进程的 `NODE_EXTRA_CA_CERTS`（调用方环境里的该变量不是信任源）。stdio 桥 fail-closed 后把该 PEM 加到运行时默认根库（不替换、不 TOFU、不关 TLS）。浏览器 / OAuth 读系统（或浏览器）信任库，不读该环境变量。
- 需要工作台或 OAuth 的已登记 macOS / Windows / Linux：另做显式系统/浏览器提权，把同一份公开根装进 OS/浏览器；考拉进程不得静默执行装证命令。
- 通过只证明这些已登记机器上的工作台、OAuth、MCP initialize → `authorization_required`、管理员绑定、绑定后 `list_tasks`。**不**证明干净机器的默认公网信任。
- 禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0`；禁止把 `curl -k` 当验收。

### `STABLE_PUBLIC_CA` — 干净机器默认信任冒烟

- `PUBLIC_URL` 优先 `https://<production-subdomain>`。证书来自 ACME DNS-01（不是 HTTP-01 / 入站 80），反代在 `<https-port>` 发送 fullchain。
- 干净 macOS / Windows / Linux：不加 CA 环境变量、不点证书例外，系统 TLS / 浏览器 / `kaola-mcp` 必须链到内置根。
- GitLab OAuth start+callback 必须走这条默认信任链；浏览器证书例外不算 OAuth 通过。
- 续期后复跑 TLS + MCP focused proof（配置测试再 reload）。

本手册路径 B（`pnpm smoke:forge`）仍打本机临时 listener，不替代上述任一条。未实际执行的平台、浏览器、OAuth 或设备绑定不得写成已通过。没有已证明的服务器授权、选定的 `<production-subdomain>` 与 `<acme-dns-provider>` 时，不做 live 换证。

## 验收分层与通过条件

按层留证据，低层通过不能替代高层。一次对外“完整通过”至少同时满足第 1–4 层；第 5 层只属于 `STABLE_PUBLIC_CA`。

| 层 | 验收面 | 最小通过证据 | 不能替代 |
|----|--------|--------------|----------|
| 1 | 仓库静态与回归 | `pnpm lint` / `typecheck` / `test` / `build` 全部退出 0 | 真实 forge、TLS、OAuth、绑定 |
| 2 | 真实 Forge 闭环 | 路径 B 对 GitLab 与 Gitea 都完成真实 Issue → clone/push → PR/MR → merge → 状态与评论回写 | 浏览器会话、真实管理员批准、远端 TLS |
| 3 | 部署与 TLS | 备份；反代配置测试通过后 reload；严格 TLS 校验通过；MCP initialize 到达 `authorization_required`；保留回滚与续期证据 | OAuth 与绑定后身份 |
| 4 | 浏览器与设备身份 | 浏览器登录/OAuth；未绑定设备得到 pending；管理员绑到指定用户；同一设备随后 `list_tasks` 成功 | 干净设备默认信任 |
| 5 | 公网默认信任 | 干净 macOS / Windows / Linux 不装私有 CA、不设额外 CA、不点例外，完成 TLS + OAuth + MCP focused proof | — |

第 3–5 层的真实域名、服务器名、端口、证书指纹、SSH 别名和 DNS provider 只进入本地不跟踪的 operator receipt；Git 只记录模式、结果和占位符。任何未执行项明确写“未执行”或“阻塞”，不得由路径 B 推断为通过。

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
| 手册脚本（B 自填进程 env） | 2026-08-26 | B `ensureSimulatedAuthEnv`（未再开真实 Issue） | 空 PAT → `missing env GITLAB_TOKEN`（不是缺 `SESSION_SECRET`）；无 session/vault/OAuth 时 `buildApp`+`ensureSetup` 成功 | 同左 |
| Claim MCP 完整闭环（#31–#40 后） | 2026-09-01 | B 生产 stdio bridge + 临时本机 listener；先 release/recover，再完整 Workflow/PR 闭环 | [Issue #15](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/15) → [MR !11](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/11)，`request_id`/`claim_id`/跨进程恢复/同设备 fencing/`report_progress`/`release_task`/`submit_pr` 均通过，`clone_auth=gitlab-basic-oauth2`，`已完成` | [Issue #20](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/20) → [PR #21](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/21)，同一组 Claim 验证通过，`clone_auth=envelope`，`已完成` |
| Codex 亲验 Forge 闭环 | 2026-09-01 | B `pnpm smoke:forge -- gitlab` / `gitea`；读取本地 gitignored PAT，未输出令牌 | [Issue #16](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/16) → [MR !12](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/12)，任务 `kt-2026-0001`，`clone_auth=gitlab-basic-oauth2`，`已完成` | [Issue #22](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/22) → [PR #23](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/23)，任务 `kt-2026-0001`，`clone_auth=envelope`，`已完成` |
| Codex 亲验本机浏览器闭环 | 2026-09-01 | A 隔离 SQLite + Safari；初始向导、GitLab OAuth 发布者、真实凭证档案、Issue 下拉导入、发布、未绑定 pending、管理员绑定、同设备生产 MCP、Git/PR、合并与回写；令牌未输出 | [Issue #17](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/17) → [MR !13](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/13)，任务 `kt-2026-0001`，`clone_auth=gitlab-basic-oauth2`，`已完成`，源 Issue 恰有三条状态回写 | [Issue #24](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/24) → [PR #25](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/25)，任务 `kt-2026-0002`，`clone_auth=envelope`，`已完成`，源 Issue 恰有三条状态回写；Issue 下拉为异步加载，服务端先返回数据后页面恢复 |
| Codex 亲验外部 `DEBUG_PRIVATE_CA` 全闭环 | 2026-09-01 | A 真实外部 Ubuntu 部署 + 已纳管 macOS；严格 TLS 负例、带外根核验、系统/浏览器信任、GitLab/Gitea OAuth、管理员绑定、共享凭证档案、生产 MCP、Git/PR、合并、部署进程轮询与回写；真实环境标识和令牌未输出或入库 | [Issue #18](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/18) → [MR !14](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/14)，任务 `kt-2026-0001`，`clone_auth=gitlab-basic-oauth2`，`已完成`，源 Issue 恰有三条状态回写 | [Issue #26](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/26) → [PR #27](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/27)，任务 `kt-2026-0002`，`clone_auth=envelope`，`已完成`，源 Issue 恰有三条状态回写 |

外部 `DEBUG_PRIVATE_CA` 本轮还保留两条观察：Gitea 共享档案的 Issue 下拉在请求完成前短暂显示「无数据」，重开后列出真实 Issue；第一次导入收到一次瞬时 `forge_unreachable`，同一部署字节的生产 adapter 随后成功，UI 单次重试也成功。GitLab MR 长时间报告 `checking`，但 merge endpoint 返回 `200` / `merged`，部署进程随后把任务推进为 `已完成`。这些观察不改变两家最终闭环结果，也没有触发 TLS 降级或令牌输出。

GitHub 发布冒烟已停（此前仓 [Issue #1](https://github.com/KaolaBrother/kaola-tasks-smoke/issues/1) 开过、未走认领，已标 `not_planned` 关闭）。stdio 桥回放 `mcp-session-id` 已进 `main`；另窗 UAT 曾用短提示词走完认领到 `submit_pr`。

## 坑（续测别踩）

- 路径 B 不要再向人要 `SESSION_SECRET` / `VAULT_MASTER_KEY` / `OAUTH_*`；缺了由 `ensureSimulatedAuthEnv` 进程内生成。生产 `pnpm dev` 仍须操作者自己 `export`。
- GitLab Issues API 的 `web_url` 是 `/-/work_items/N`，考拉 `parseIssueUrl` 不认。导入必须用拼出来的 `/-/issues/N`（脚本已这么做）。
- GitLab 回调 `400`：常为未走 PKCE，或 secret 用 HTTP Basic 编码失败。从首页重新点登录。回调必须是 `http://localhost:31415/login/gitlab/callback`。
- Gitea 选中档案后 base_url 不会自动从 gitlab.com 改掉，须手填 `https://gitea.com`。
- gitea.com 建仓：`POST /user/repos` 要 `write:user`，`GET /user` 要 `read:user`。
- GitLab.com **git** 不吃信封 Bearer；Gitea.com **git** 吃信封 `token`。
- GitLab `PUT …/merge_requests/:iid/merge` 在 `detailed_merge_status` 还是 checking 时返回 **405**；脚本等到 `mergeable` 再合。
- 隔离 sqlite 每次从 `kt-2026-0001` 起号，冒烟分支必须带时间戳，否则会撞上次的 `kaola/kt-2026-0001-smoke`。

## 测完可收

- 两家：撤销冒烟 PAT；项目 `kaola-tasks-smoke` 可删。
- 工作台：删掉对应凭证档案；**解除这台电脑的授权**（不要再走「吊销 Agent Key」当收尾）。若某一轮中途停下、任务还停在 `待认领`/`进行中`/`待验收`/`已退回` 任一非终态，删档案会先被 `409 credential_profile_in_use` 挡住（#36）——需先把那条任务推进到终态再删档案，可行动作按当前状态而定：`待认领`/`已退回` 可由发布者直接取消；`进行中`/`待验收` **不能**直接取消（`已取消` 只允许从 `待认领`/`已退回` 迁移，见 `tasks.ts` 的 `POSTER_TRANSITIONS`）。`进行中` 可以等 lease 过期（`LEASE_TTL_SECONDS = 86400`，即 24 小时）自动掉回 `待认领` 后再取消，或由认领方 `release_task`；`待验收` 的 lease 在 `submit_pr` 时就已释放，没有可等的过期，只能等 PR 合并（`已完成`）或关闭（`已退回`，之后可取消）。
