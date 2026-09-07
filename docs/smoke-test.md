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

路径 A 是真人浏览器 + 真 OAuth。路径 B 是无人值守脚本（`inject` + 生产 MCP，不打开 Vue）。路径 C 把 B 的假考拉进程 **listen** 出来，用真实工作台代替真人点评审面板，仍不走 GitLab Authorize。

### A. 本机浏览器（人在场）

原点 **http://localhost:31415**（必须 `localhost`，不要 `127.0.0.1`，否则登录 cookie 对不上）。仓库根目录 `pnpm dev`（先 `export` / `source .env`）。`SQLITE_PATH` 指向文件库（不要默认内存库）。

登录：空库先走初始向导（`POST /api/v1/setup`），不要用空库 OAuth 抢 `full`。`registerAuth` 启动时三家 OAuth 客户端 env 都必须非空；GitHub 只占位（`GET /login/github` 为 404）。本机活测：向导建本地管理员后，再用 GitLab.com OAuth 登录成为发布者（`active` + `full`，不是管理员）。Gitea OAuth 在仍是 `unused` 时不能用来登录考拉。发布 GitLab / Gitea 任务用已登录管理员或发布者的对应凭证档案。电脑绑定仍是管理员。

### B. 注入会话脚本（Cloud Agent / 无人值守）

浏览器 Authorize 过不了（Cloudflare 人机、无交互）时，不要假装走了网页登录。用 `scripts/forge-smoke.ts`（`pnpm smoke:forge -- gitlab|gitea`）。脚本自己 `buildApp`，**不**碰正在跑的 `pnpm dev`。不打印 token，不把 token 写入 remote URL / `.env` / mcp.json。传入 `github` 会明确失败（发布面不含 GitHub）。参数解析会跳过 argv 里的 `--`，所以 `pnpm smoke:forge -- gitlab` 与直接传 `gitlab` 一样；`--web` 打开路径 C。

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

### C. 注入会话的浏览器 UAT（Cloud Agent 可代替真人点工作台）

路径 B 不打开 Vue，所以评审批面板、`409` 中文信封、「forge 头已变化」、看板 SSE 仍算「配合」。路径 C 补这一截：**考拉进程仍是假的**（`ensureSetup` + GitLab OAuth stub），**forge 仍是真的**，工作台是生产 Vue。用来代替真人点 #53/#54 评审面板，**不能**代替真实 OAuth、公网 TLS、或真人在 forge 页点 Merge。

```bash
pnpm smoke:uat -- gitlab --web
pnpm smoke:uat -- gitea --web
```

`pnpm smoke:forge -- gitlab --web` 等价。传入 `github` 仍明确失败。

| 东西 | 真假 | 谁提供 |
|------|------|--------|
| `GITLAB_TOKEN` / `GITEA_TOKEN` | **真** PAT | 与路径 B 相同；缺则失败 |
| 考拉 sqlite / session / vault / OAuth 占位 | 假 | 与路径 B 相同，`ensureSimulatedAuthEnv` |
| HTTP | 真 listen | **浏览器 URL** 默认 `http://localhost:31416`（`UAT_WEB_PORT`；必须 `localhost` 这个 host，不要 `127.0.0.1`，否则登录 cookie 对不上）。**listen 地址另算**：默认绑 `127.0.0.1`；`UAT_WEB_HOST` 非空才覆盖（仍可显式 `0.0.0.0`）。不要抢已在跑的 `pnpm dev` :31415。路径 B 始终 `127.0.0.1` + 临时端口，忽略 `UAT_WEB_HOST`。Compose `127.0.0.1:31415:31415` 与生产 `HOST` 未改 |
| Vue | **真** | 反向代理 `VITE_DEV_TARGET`（默认 `http://127.0.0.1:5173`）。工作树另起 Vite 时改端口 |
| 登录 | 假身份、真 cookie | 浏览器走本地管理员 `POST /api/v1/login`（用户名 `kaola-admin`，密码与 `apps/server/src/auth.test-helpers.ts` 的 `DEFAULT_SETUP` 相同）。**不要**点「使用 GitLab 登录 / 使用 Gitea 登录」。**不要**在页面里贴 PAT |
| 评审 UI | **真** | 人（或 Agent computer-use）点按钮 |
| 认领 / clone / PR / 修订 MCP / 合并 | **真** forge + 生产 stdio bridge | 脚本在旗标处继续；合并仍走 forge API，不是 forge 网页上的 Merge 按钮 |

脚本先把任务推到路径 B 的 #53 一轮 + #54 未申报提交（forge 已报告新头），任务停在 `待验收`。然后写入 `UAT_HOLD_DIR/state.json`（默认系统临时目录下的 `kaola-uat-web`，**不含 token、不含密码**）并等待旗标文件 `UAT_HOLD_DIR/go`：

1. 浏览器：登录 → 看板打开该任务 → 「通过」→ 面板出现中文 `409` 提示（不是英文 `head_sha_stale`）且「forge 头已变化」→ 写一条阻塞意见 → 「提交本轮意见」→ 看板经 SSE 把卡片换到 `待修改`。写 `go`，内容恰好一行 `round-done`。
2. 脚本：bridge 再 `claim_task`（`review_round` 2）并以该漂移头 `submit_revision` → `待验收`。
3. 浏览器：再点「通过」→ `待合并`，forge 上 Draft/WIP 翻 ready。写 `go`，内容恰好一行 `approved`。
4. 脚本：forge merge + `pollPendingReviews` → `已完成`，核 `回写` 与 `events.details` 无令牌。

`UAT_HOLD_TIMEOUT_MS` 默认 30 分钟。人对着工作台点通常远短于这个值；Cloud Agent computer-use 建议显式设 40 分钟（`2400000`），因为登录、关「保存密码」弹层和点评审按钮会吃掉 hold 窗口。`go` 还不存在（`ENOENT`）或 trim 后为空 / 纯空白则**继续等**（空文件不是失败）。超时则失败。trim 后非空但不是期望内容则**立刻**失败（先 `redact` 再 `JSON.stringify` 进消息）。恰好匹配则 unlink 继续。不把 UI 步骤编成已通过。未实际打开浏览器的跑法不要写路径 C 通过。

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
| 10 | 以 **Draft**（GitLab `Draft:` / Gitea `WIP:`）开 PR 后 `submit_pr`（可带 `head_sha`），任务 `待验收` | **自动** | **自动** |
| 11 | 评审者在任务详情「评审」面板写一条阻塞意见并「提交本轮意见」，任务 `待修改` | **配合** 浏览器点按钮；看板经 SSE 自动变列 | **自动** `POST …/review/messages` + `POST …/review/rounds` |
| 12 | 任意 Agent `claim_task` 认领 `待修改`（`review_round` 1），`get_review_feedback` 读阻塞项，在同一分支再推一提交，`post_discussion_message(resolution)`，`submit_revision`（新 `head_sha`）回 `待验收` | **自动** | **自动** 经生产 stdio bridge |
| 12b | **#54** Agent 交回后在同一分支再推一提交但不 `submit_revision`；评审者「通过」→ `409` `head_sha_stale`（体含记录头与 forge 头），任务仍 `待验收`，`GET …/review` `head_stale: true`、面板显示「forge 头已变化」；评审者写阻塞意见 + 「提交本轮意见」→ `待修改`；Agent 再认领（`review_round` 2）并以新头 `submit_revision` | **配合** 面板看提示、点「通过」看拒绝 | **自动** 等 forge 报告新头后 `POST …/review/approve` 期望 `409`、核对视图、REST 开轮、bridge 再认领与交回 |
| 13 | 评审者「通过」，任务 `待合并`，响应 `head_verified: true` 且 `head_sha` = 交回头；考拉用任务凭证把 Draft 翻 ready（forge 上 PR 不再是 Draft/WIP） | **配合** 点「通过」；在 forge 页面核对 | **自动** `POST …/review/approve` + `settleWritebacks` + `getPullRequest().draft === false` |
| 14 | 合并 PR，看任务变已完成；源 Issue 三条回写 + `翻ready` 回写 | **配合** 点 Merge；Agent 核 SQLite | **自动** 调 forge merge + `pollPendingReviews` |

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
| #53 评审循环手册脚本 | 2026-09-07 | B `pnpm smoke:forge -- gitlab` / `gitea`（隔离 SQLite、`ensureSetup`、生产 stdio bridge；读取本地 gitignored PAT，日志脱敏，令牌未输出）：Draft PR → `submit_pr(head_sha)` → 评审 REST 一条阻塞意见 + 「提交本轮意见」→ `待修改` → bridge 再 `claim_task`（`review_round` 1）→ `get_review_feedback` → 同分支再推一提交 → `post_discussion_message(resolution)` → `submit_revision` → `待验收` → `approve` → `待合并` 且 forge 上 `draft=false`、head 与交回 sha 一致 → merge → `pollPendingReviews` → `已完成`，`回写` 含 认领/提交PR/完成/翻ready，`events.details` 无令牌 | [Issue #20](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/20) → [MR !16](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/16)，`clone_auth=gitlab-basic-oauth2`，`已完成`（首次尝试 [Issue #19](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/19) / [MR !15](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/15) 因脚本自身 `rev-parse` 读错字段停在 `待修改`，未合并） | [Issue #30](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/30) → [PR #31](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/31)，`clone_auth=envelope`，`已完成`（首次尝试 [Issue #28](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/28) / [PR #29](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/29) 同因停在 `待修改`，未合并） |
| #54 评审锚定核对手册脚本 | 2026-09-07 | B `pnpm smoke:forge -- gitlab` / `gitea`（同 #53 脚本加 12b 漂移段；令牌未输出）：`submit_revision` 后再推一提交不交回 → 等 forge 报告新头 → `approve` `409` `head_sha_stale`（`recorded_head_sha` / `forge_head_sha` 与实际一致）→ 视图 `待验收` + `head_stale: true` → 阻塞意见 + 开轮 `待修改` → bridge 再认领（`review_round` 2）→ `submit_revision(新头)` → `approve` `200` `head_verified: true` → forge `draft=false`、head 与交回一致 → merge → `pollPendingReviews` → `已完成`，`回写` 四种齐全，`events.details` 无令牌 | [Issue #23](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/23) → [MR !19](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/19)，`clone_auth=gitlab-basic-oauth2`，`已完成`（评审修复「通过」事务内重查 `待验收` 后的复跑；修复前同脚本 [Issue #22](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/22) / [MR !18](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/18) 亦 `已完成`；首次尝试 [Issue #21](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/21) / [MR !17](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/17) 在 push 后立刻「通过」，GitLab 尚未刷新 MR `sha`，考拉按 forge 报告的旧头 `200 head_verified: true` 放行，脚本按预期失败停在 `待合并`、未合并；随后脚本改为等 forge 报告新头再核对） | [Issue #36](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/36) → [PR #37](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/37)，`clone_auth=envelope`，`已完成`（评审修复后的复跑；修复前 [Issue #34](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/34) / [PR #35](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/35) 与脚本加等待前的一次 [Issue #32](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/32) / [PR #33](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/33) 亦 `已完成`，Gitea 即时报告新头） |
| #55 层 2 回归（#53/#54 脚本） | 2026-09-07 | B `pnpm smoke:forge -- gitlab` / `gitea`（工作树 `cursor/uat-review-smoke-989d`；令牌未输出） | 首次 [Issue #24](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/24) → [MR !20](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/20) 在 `waitForForgeHead` / `getPullRequest` 上 `TimeoutError`（#37 默认 10s），未合并；当时用未实现的 `KAOLA_FORGE_TIMEOUT_MS=30000` 环境变量复跑 [Issue #25](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/25) → [MR !22](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/22)，`clone_auth=gitlab-basic-oauth2`，`已完成`。该变量**至今不是**脚本旋钮；[#58](https://github.com/KaolaBrother/KaolaTasks/issues/58) 已让单次 abort-timeout 继续 poll 到 90s 外层截止，操作者不必再为这类失败设 env。 | [Issue #38](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/38) → [PR #39](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/39)，`clone_auth=envelope`，`已完成` |
| #55 路径 C 注入会话浏览器 UAT | 2026-09-07 | C `pnpm smoke:uat -- gitlab\|gitea --web`；Vite `127.0.0.1:5174`；`UAT_WEB_PORT=31416`；本地管理员登录，**未**点 OAuth、**未**在页面贴 PAT；Cloud Agent 点「通过」→ 中文 `409` / 「forge 头已变化」→ 阻塞意见 → 「提交本轮意见」→ `待修改` → 脚本 `submit_revision(漂移头)` → 再「通过」→ `待合并` → 脚本 forge API 合并 → `已完成`。日志与 `state.json` 无令牌、无密码 | 首次 [Issue #26](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/26) → [MR !21](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/21) 在当时 15 分钟 hold 窗口内未写到 `round-done`，脚本超时退出、未合并；加长 hold 后复跑 [Issue #27](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/27) → [MR !23](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/23)，`clone_auth=gitlab-basic-oauth2`，`已完成` | [Issue #40](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/40) → [PR #41](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/41)，`clone_auth=envelope`，`已完成` |
| #56–#58 harness 修复后路径 B | 2026-09-07 | B `pnpm smoke:forge -- gitlab` / `gitea`（`KAOLA_FORGE_TIMEOUT_MS` 未设；令牌未输出）。路径 C / 浏览器 / 真实 OAuth **未**执行 | [Issue #28](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/28) → [MR !24](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/24)，`clone_auth=gitlab-basic-oauth2`，`已完成` | [Issue #42](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/42) → [PR #43](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/43)，`clone_auth=envelope`，`已完成` |
| #56–#58 终态前路径 B 再跑 | 2026-09-07 | B `pnpm smoke:forge -- gitlab` / `gitea`（`KAOLA_FORGE_TIMEOUT_MS` 未设；令牌未输出）。脚本 `ok`，日志无 PAT 前缀 | [Issue #29](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/29) → [MR !25](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/25)，`clone_auth=gitlab-basic-oauth2`，`已完成` | [Issue #44](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/44) → [PR #45](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/45)，`clone_auth=envelope`，`已完成` |
| #56–#58 路径 C 注入会话浏览器 UAT | 2026-09-07 | C `pnpm smoke:uat -- gitlab\|gitea --web`；Vite `127.0.0.1:5174`；`UAT_WEB_PORT=31416`；listen `127.0.0.1`；`UAT_HOLD_TIMEOUT_MS=2400000`；本地管理员登录，**未**点 OAuth、**未**在页面贴 PAT；Cloud Agent 点「通过」→ 中文 `409` / 「forge 头已变化」→ 阻塞意见 → 「提交本轮意见」→ `待修改` → `go=round-done` → 脚本 `submit_revision(漂移头)` → 再「通过」→ `待合并` → `go=approved` → 脚本 forge API 合并 → `已完成`。`state.json` 仅有用户名。日志无 PAT 前缀。首次 GitLab [Issue #30](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/30) → [MR !26](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/26) UI 已到 `待合并` 且 forge 已合、Issue 已有「已完成并合并」评论，脚本因 Path C 2s poller 与 sqlite `回写 完成` 竞态报 `missing 回写 完成`；harness 改为 `settleWritebacks` + `retryPendingWritebacks` 后再跑 | 复跑 [Issue #31](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/31) → [MR !27](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/27)，`clone_auth=gitlab-basic-oauth2`，`已完成` | [Issue #46](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/46) → [PR #47](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/47)，`clone_auth=envelope`，`已完成` |


外部 `DEBUG_PRIVATE_CA` 本轮还保留两条观察：Gitea 共享档案的 Issue 下拉在请求完成前短暂显示「无数据」，重开后列出真实 Issue；第一次导入收到一次瞬时 `forge_unreachable`，同一部署字节的生产 adapter 随后成功，UI 单次重试也成功。GitLab MR 长时间报告 `checking`，但 merge endpoint 返回 `200` / `merged`，部署进程随后把任务推进为 `已完成`。这些观察不改变两家最终闭环结果，也没有触发 TLS 降级或令牌输出。

#53 评审循环后的「配合」项（未经真人执行不得写成已通过）：发布向导「拆为子任务」、GitHub 仓库的 Draft → ready（GraphQL）翻转、以及真人在 forge 页面点 Merge。路径 B 只证明 REST / MCP / adapter 层的同一闭环。路径 C 证明工作台评审面板的「通过」/「提交本轮意见」、`409` 中文信封、「forge 头已变化」与看板 SSE 换列；仍不证明真实 OAuth、公网 TLS、或 forge 网页 Merge。

#54 补充：路径 B 已真实证明「通过」被 forge 上未申报的新头拒绝（`409 head_sha_stale`）并在重新交回后放行。路径 C 在真实浏览器里证明同一拒绝的中文信封与「forge 头已变化」提示。已知 forge 属性：GitLab 在 push 后由后台任务刷新 MR `sha`，gitlab.com 实测滞后数秒，滞后窗口内的「通过」按 forge 报告的旧头放行（`head_verified: true`）；Gitea 即时。

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
- 路径 B `waitForForgeHead` 外层仍 90s；每次 `getPullRequest` 仍走 #37 `DEFAULT_TIMEOUT_MS` 10s（生产 adapter 默认未改）。gitlab.com 偶发一次慢读现在继续 poll，直到 90s 截止才失败。#55 首次 GitLab 尝试因单次 10s abort 整段失败；当时文档误把未实现的 `KAOLA_FORGE_TIMEOUT_MS` 当成 workaround——该变量仍不存在，操作者不必为这类失败设置它。见 [#58](https://github.com/KaolaBrother/KaolaTasks/issues/58)。
- 路径 C `--web` listen 默认 `127.0.0.1`；`UAT_WEB_HOST` 非空才覆盖（显式 `0.0.0.0` 仍可能）。路径 B 始终 `127.0.0.1`，忽略 `UAT_WEB_HOST`，用临时端口。浏览器 URL 仍是 `http://localhost:${UAT_WEB_PORT}`（cookie host），与 listen 地址分开。Docker Compose `127.0.0.1:31415:31415` 与生产 `HOST` 无关、未改。见 [#57](https://github.com/KaolaBrother/KaolaTasks/issues/57)。
- 路径 C `waitForUatFlag`：`go` 不存在（`ENOENT`）或 trim 后空 / 纯空白则继续等；非空且不等于期望立刻失败（脱敏后再 `JSON.stringify`）；恰好匹配则 unlink 继续。见 [#56](https://github.com/KaolaBrother/KaolaTasks/issues/56)。
- 路径 C `--web` 的 2s 进程内 poller 可能在脚本打开第二路 sqlite 之前就把任务标成 `已完成` 并开始「完成」回写。合并后必须 `settleWritebacks` 再 `retryPendingWritebacks`，否则会出现 forge Issue 已有「已完成并合并」评论、脚本却报 `missing 回写 完成`。
- 浏览器必须 `http://localhost:31416`，不要 `127.0.0.1`（host-only cookie）。Chrome「保存密码」弹层会挡住按钮，先关。看板「第 1 轮 · 需修改」是历史轮次标签，不是任务状态；任务仍在 `待验收` 时「通过」按钮在。

## 测完可收

- 两家：撤销冒烟 PAT；项目 `kaola-tasks-smoke` 可删。
- 工作台：删掉对应凭证档案；**解除这台电脑的授权**（不要再走「吊销 Agent Key」当收尾）。若某一轮中途停下、任务还停在 `待认领`/`进行中`/`待验收`/`已退回` 任一非终态，删档案会先被 `409 credential_profile_in_use` 挡住（#36）——需先把那条任务推进到终态再删档案，可行动作按当前状态而定：`待认领`/`已退回` 可由发布者直接取消；`进行中`/`待验收` **不能**直接取消（`已取消` 只允许从 `待认领`/`已退回` 迁移，见 `tasks.ts` 的 `POSTER_TRANSITIONS`）。`进行中` 可以等 lease 过期（`LEASE_TTL_SECONDS = 86400`，即 24 小时）自动掉回 `待认领` 后再取消，或由认领方 `release_task`；`待验收` 的 lease 在 `submit_pr` 时就已释放，没有可等的过期，只能等 PR 合并（`已完成`）或关闭（`已退回`，之后可取消）。


## 2026-09-07–08 VPS 综合 UAT（功能闭环通过，仍有未通过／未执行项）

本轮将本机 `main` 从 `13ce1fb` 快进到抓取的 `origin/main` `6ba97d6`，按 DESIGN v0.7 扩展旧闭环，覆盖八状态、十个 MCP 工具、多轮评审、头版本锚定、依赖子任务及 SSE。复用原 `DEBUG_PRIVATE_CA` Ubuntu VPS、管理员、两份共享凭证档案和已配对客户端。部署 API、生产 `kaola-mcp` launcher 与浏览器均连接真实 VPS；Git/forge 操作复用现有 smoke helper。不把注入会话脚本结果计作 VPS 结果。

**结论：两家 Forge 的部署闭环、子任务 restack 和已执行的安全／状态负例通过；本轮不能标记“全项通过”。** Linux Web 自动测试出现内存耗尽；真实 OAuth 重授权、新设备人工绑定及终止按钮确认框未完整执行。它们与已通过项目分别记录。

### 验收证据

| 范围 | 实际证据 | 判定 |
|---|---|---|
| 本机基础回归 | frozen install、lint、typecheck、build 退出 0；Node **1049/1049**，Web **166/166** | PASS |
| GitLab 标准路径 B | [Issue #32](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/32) → [MR !28](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/28)；两轮修订、头漂移拒绝、ready、真实合并与回写 | PASS；不是 VPS 进程 |
| Gitea 标准路径 B | [Issue #48](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/48) → [PR #49](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/49)；同一闭环 | PASS；不是 VPS 进程 |
| VPS 升级与字节 | 独立目录 frozen install/build；切换前备份旧部署、环境和数据库；新版健康检查成功、评审表创建；**607 个文件 SHA-256 一致**（排除本轮正在写的本手册） | PASS |
| 旧数据保留 | 备份与升级库按旧列逐行对比：users 3、credential_profiles 2、tasks 2、leases 2、submissions 2 全部一致；旧任务仍可见 | PASS |
| 既有身份与严格 TLS | 原管理员在真实浏览器登录；原设备经生产 launcher 发现全部 **10 个工具**并 `list_tasks`；显式核验既有根 CA 的严格 HTTPS；匿名列表 401 | PASS；不是新设备批准或真实 OAuth 重授权 |
| 两家 VPS 原闭环 | 档案复用、真实 Issue 导入／发布、Brief、Claim、clone/push、Draft PR、`submit_pr`、审批、ready、合并、部署 poller 更新 `已完成` | PASS；资源见下表 |
| Claim 恢复 | active replay 同一 claim_id/token；release 回 `待认领`；终止 receipt 轮换后新 Claim；跨 launcher 进程恢复；percent/phase 心跳 | PASS |
| 两家多轮评审 | 阻塞消息本身不翻状态；归轮到 `待修改`；反馈、resolution、同 PR 新 SHA 交回；修订 release 回 `待修改`；换 PR 收到 `pr_url_invalid` | PASS |
| 头漂移与中文界面 | 两家均做未申报 push；浏览器「通过」被中文提示拒绝，显示记录头与当前头；补阻塞意见、归轮、正式交回后可通过 | PASS |
| 审批锚定与回退 | GitLab 初次通过、子任务通过的审计 `head_verified=true`；两家主任务最后一次通过为 `false`，锚定 SHA 与交回一致，走 §17.7 允许的读取失败回退分支 | PASS；不得把后两次称为实时 Forge 头已核验 |
| 撤回通过 | GitLab `待合并 → 待修改`；同 SHA 交回被 `head_sha_unchanged` 拒绝；新提交重新交回并通过 | PASS |
| 子任务完整闭环 | 浏览器发布父子关系；父未就绪拒绝认领；Claim 堆叠到父分支；子任务 `open_review_round` 令父回 `待修改`；父未完成禁止子通过；父合并后自动 restack；rebase 到 main、同 PR 交回、通过、合并 | PASS |
| 终止、重开、PR 关闭 | 非阻塞意见归轮仍 `待验收`；真实 REST terminate → `已退回`；发布者重开 → `待认领`；新 PR 可重新 `submit_pr`；真实关闭 PR 后部署 poller → `已退回`；随后取消 | PASS；浏览器终止确认单列为未完成 |
| 签名／状态负例 | 原始 REST 旧 claim_id 收到 `stale_claim`；percent 101 拒绝；nonce 重放及过期时间戳 401；父子取消；终态父不能再创建子任务；非法状态审批 409；匿名评审 401 | PASS |
| SSE | 浏览器不手动刷新即可观察进度、评审轮数、父子任务及状态换列；独立真实 SSE 流收到 progress/task_updated，未包含 progress note 或令牌 | PASS |
| 完成与脱敏 | 两家源 Issue 实际收到认领／提交 PR／完成三类评论；`翻ready` 与审批 SHA 有审计；核对 **161 条事件**及已读取响应无两家 PAT／管理员密码 | PASS；重领会产生新的认领评论，不把类别数写成总评论数 |
| 新客户端信任／待授权 | 全新客户端以已核验根指纹执行生产 `trust install --pem … --fingerprint …`；生产 launcher 返回 `authorization_required`，没有自动绑定或匿名成功 | PASS 到 pending；管理员人工批准尚未执行 |
| Linux Node 自动回归 | 原测试日志的 **1049 tests、256 suites、1049 pass、0 fail**；随后确实进入 Web 测试 | PASS |
| Linux Web 自动回归 | 首次 **158/166** 后 worker 异常退出；内核记录 OOM 杀掉测试会话中的 Node。单 worker、600 MiB cgroup／384 MiB V8 堆限制重试仍堆耗尽，出现失败后主动结束本轮测试服务 | 未通过；本机 166/166 不能替代 Linux 结果 |
| 其余合同回归 | 三 adapter 共享合同、webhook、并发审批、异设备 fencing、租约过期、故障与重试、trust／Runner 兼容 | 自动回归 PASS；未逐一制造真实 VPS 故障场景 |
| 人工／平台边界 | 真实 GitLab/Gitea OAuth 回调重验、新设备管理员人工绑定、Linux Claim 客户端、Windows 客户端 | 本轮未执行；既有用户和设备保留不替代这些步骤 |
| 终止按钮确认框 | 浏览器点击后交互超时，未取得可处理的对话框；改以真实 REST 验证状态行为 | UI 未完成；不写成 UI PASS |
| 公开 CA | 当前采用既有私有 CA 模式 | 不适用；未验证干净机器默认信任 |

### 最终业务现场

| 任务 | 真实 Forge 资源 | 收尾状态 |
|---|---|---|
| `kt-2026-0003` GitLab 父任务 | [Issue #33](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/33) / [MR !29](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/29) | PR 已合并，VPS `已完成`，第 6 轮 |
| `kt-2026-0004` Gitea | [Issue #50](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/50) / [PR #51](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/51) | PR 已合并，VPS `已完成`，第 3 轮 |
| `kt-2026-0005` GitLab 子任务 | [MR !30](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/30) | restack 后合并，VPS `已完成`，第 2 轮 |
| `kt-2026-0006`、`kt-2026-0007` | 原生负例父子任务，无 PR | 均 `已取消` |
| `kt-2026-0008` | [Gitea PR #52](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/52)、[PR #53](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/53) | 两个测试 PR 均已关闭，终止／重开／关闭回写验收后 `已取消` |

两条旧任务仍为 `已完成`。停服前全库 **8 个任务均在终态：5 已完成、3 已取消；20 条 lease 全部 released，无活跃 Claim**。保留测试记录、备份及旧部署，不用旧库覆盖本轮数据。

### 连接中断的调查与更正

中段发生 SSH banner exchange 与严格 TLS 握手超时。经用户已登录的 Safari 阿里云 Workbench 成功进入 Linux；随后原 SSH 与 HTTPS 恢复。Linux uptime 连续，任务服务 `NRestarts=0`，没有重启 VPS 或任务服务来恢复连接。内核在 00:03 记录全局 OOM，杀掉本轮测试会话中的 Node；首次 Web 测试于 00:06 以失败结束。恢复时负载均值为 0.10／15.12／58.18、约 937 MB 内存可用。资源压力是有证据支持的主要解释，但不能仅凭这些记录证明每一次握手超时的唯一原因。

用户确认 VPN 始终开启，且早期 SSH、严格 TLS 和 VPS UAT 已在该条件下成功。此前把排查重点放在 VPN 缺乏证据；本轮未改动或关闭 VPN。此小内存共享 VPS 的全量 Web 自动测试没有通过，后续不应再把未限额全量测试与验收服务同时运行。受限重试只约束本轮测试进程，任务服务在验收期间保持运行。

测试驱动的 `trust install` 参数、浅 clone 后 force-with-lease 的期望引用，以及审批回退断言曾不符合现有合同，均在本地不跟踪的驱动中纠正后接续；不把这些驱动错误算作产品故障。GitLab 子任务推送重试先核对远端仍是本轮旧 SHA，再以显式 lease 推送。详细日志和真实环境标识只留在本地 operator receipt。

### 按用户要求停服

验收及业务现场核对完成后，执行 `systemctl stop kaola-tasks`。实测 `ActiveState=inactive`、`SubState=dead`、`MainPID=0`，应用监听已关闭；SSH 仍可登录，反代严格 TLS 仍通过、上游停止后返回 502（此次为预期停服结果）。本轮受限 Web 测试服务也已停止。保留数据库和部署供后续接续。


## 2026-09-08 本地 Linux 接续与 UAT 修复

按用户要求，将 `6ba97d6` 的生产构建部署到本机 Colima Linux 容器，使用只绑定 `127.0.0.1:31415` 的本地服务；受保护地迁移停服后的数据库和既有配置。构建上下文来自 Git archive，不含环境文件或 operator receipt。回归镜像补齐测试所需的 MCP workspace manifest、OpenSSL 和 Git；产品 Dockerfile 未改动。本轮随后发现并修复备用 HTML 表单的 415，最终镜像包含下述 auth 修复和四项回归测试。

用户明确授权使用 `.env` 和既有账号会话自主完成剩余操作；本轮由 Agent 操作真实浏览器和 API，不称为本人手动点选。该授权只解释本轮执行方式，不修改本手册其他轮次的配合约定。

| 范围 | 实际结果 |
|---|---|
| 原源码 Linux 回归 | Node **1049/1049**、Web **166/166** 全过，补足原 VPS Web OOM 后缺失的 Linux 证据 |
| 最终修复版 Linux 回归 | Node **1053/1053**、0 fail、0 cancelled；Web 完整复查 **166/166**。2 CPU／4 GiB，Node 并发 2、Web 单 worker |
| 本地生产服务 | Vue 管理员登录、旧任务保留、10 个 MCP 工具、匿名 401 均通过 |
| Linux 新设备 | 未绑定先返回 `authorization_required`；以管理员真实 API 绑定；独立 Linux 生产 launcher 认领、跨进程 receipt replay、进度、释放、取消全部通过。修复版复验任务 `kt-2026-0011`，此前用例 `kt-2026-0010`，均已取消 |
| 网页设备绑定 | Safari 管理员实际点「绑到我自己」，原 pending 新 Mac 设备进入已授权列表；生产 launcher 随后发现 10 个工具并成功 `list_tasks` |
| GitLab 真实 OAuth | `.env` 原本已有本地应用；首次误选 VPS 配置导致回调被拒。改用已有本地 client 后，Safari 既有 GitLab 会话完成真实回调，工作台显示 `KaolaBrother · GitLab · 发布者`；最终修复版再次通过 |
| Gitea 真实 OAuth | 使用 `.env` PAT 经真实管理 API 创建本轮独立本地 OAuth 应用；Safari 通过已有 GitHub 登录会话进入 Gitea，实际点击「应用授权」，真实回调后显示 `KaolaBrother · Gitea · 发布者`；最终修复版再次通过。未模拟 token exchange 或 userinfo |
| 终止 UI | `kt-2026-0009` / [Gitea PR #54](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/54)；Safari 原生确认框点「取消」保持待验收，再点「好」转为已退回。此前内置浏览器确认框工具受限，没有继续替代成 REST 后声称 UI 通过 |
| 重开与关闭回写 | 同一任务重开、生产 MCP 再认领、[Gitea PR #55](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/55) 重新 submit、真实关闭、部署 poller 转已退回、最终取消；两个测试 PR 均关闭 |
| 备用 HTML 表单缺陷 | Safari `/login` 原表单 POST 返回 **415 FST_ERR_CTP_INVALID_MEDIA_TYPE**，空库向导同样缺少解析。先补测试复现，再修复仅 setup/login 的 urlencoded parser，成功以 303 回工作台，保留 JSON 201/200；拒绝跨 origin 表单。修复后 Safari 实际表单登录并跳转成功 |
| 修复回归 | 新增四项测试：表单向导与一次性门闩、正确／错误密码、跨 origin 不建用户或会话、其他 API 不接受表单格式；定向 auth/cookie **25/25**。lint、typecheck、build 全通过 |

完整 Web 回归首次有一项 `App.error-envelope.test.ts` 的 403 发布提示断言报 `missing [data-testid="task-message"]`（165/166）；该文件及 Web 产品代码未改。原样单文件复查 **11/11** 通过。随后原样完整 Web 复查 **166/166、9/9 文件通过**。保留首轮失败，不把重跑写成从未失败；该单次异步提示断言波动的根因未在本轮认定。

### VPS 已按后续指令卸载清理

此前“保留部署和备份”的现场已被用户后续明确清理指令取代。清理前已在本机保存接续所需的受保护配置与停服数据库。VPS 上已删除 Kaola Tasks systemd unit、部署及旧部署、SQLite 数据、该服务备份、私有 CA/反代站点、测试日志与临时构建文件、专用 kaola 用户、安装的 Node 22 目录和对应命令链接；卸载本次安装且无其他使用者的 nginx、Docker/Compose/containerd 及其测试依赖，删除空容器数据和本次安装时产生的 corepack/pnpm 缓存。

清理前核实 Docker 容器、镜像、卷均为空，未发现安装在 VPS 的 GitLab/Gitea 服务；两家 smoke 仓库在外部 forge，不属于 VPS 软件卸载。清理后 `kaola-tasks` 为 `LoadState=not-found`、`ActiveState=inactive`，node/docker/nginx 命令及专用用户均不存在。既有 `kaola-relay`、`rustdesk-hbbs`、`rustdesk-hbbr` 三项服务仍 active。保留共享 SSH 配置、其他服务和系统级 apt/journal 审计记录，不删除整机共享日志。

详细日志与敏感配置只留在不跟踪的本地 operator receipt。Windows 客户端、公开 CA 干净机器默认信任，以及未逐项制造的真实 VPS 故障场景均不包含在本轮通过范围；已有自动合同覆盖与真实设备／服务验收分开计。


### 本地接续最终收尾

验收后的数据库为 **11 个任务均终态：5 已完成、6 已取消；24 条 lease 全部 released**。GitLab/Gitea 用户均保持 `active/full`，本地用户为 `active/admin`；没有 OAuth 权限提升。核对 **191 条事件**不含两家 PAT 或管理员密码。修复版容器中的 auth 源码和新增测试 SHA-256 与工作区一致。

本轮选定的 GitLab/Gitea 业务闭环、八状态／十工具扩展、macOS/Linux 客户端、真实 OAuth、设备绑定和终止 UI 已完成；此前缺项由上述本地真实环境接续补齐。Windows、公开 CA 与未制造的故障场景仍按上面的边界记录。验收后已停止本地 `kaola-tasks-local-uat` 容器（`exited`、`Running=false`），保留本地受保护的数据库、配置和证据供复现。VPS 已完成上述卸载清理。
