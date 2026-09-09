# GitLab / Gitea 冒烟手册

可重复的闭环，不是 backlog。**本轮结果只写这个文件**，不要写进 GitHub issue。

**发布面只有 GitLab 和 Gitea。** 产品代码里 GitHub 适配器仍在（见 `docs/DESIGN.md`），但这条手册不发 GitHub 任务、不要 `GITHUB_TOKEN`、不跑 `scripts/forge-smoke.ts github`。认领者不需要自己的 forge 账号或 PAT；认领身份是设备证明（`~/.kaola/device.json` Ed25519）加管理员远程配对。

## 2026-09-09 更正：本机隔离 Linux 全 Agent（路径 L，优先）

正式评论 [5596896971](https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5596896971) **优先于** [5596887868](https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5596887868) 以及下文历史「配合 / 停下来和人一起做 / 等人批准」的句子。本例外**只**覆盖本机隔离 Linux UAT，不修改生产管理员授权规则。本轮增量术语是 **Private CA / 私有 CA**，不是 Privacy AI。

- 全程由 Agent 完成：配置、管理端真实登录（含已有 `.env` OAuth 客户端时的 GitLab/Gitea 网页授权）与工作台配对批准、发布、认领 Agent 生产 MCP、GitLab/Gitea 完整交付与评审合并。必要时 Computer Use / 浏览器自动化。不设等待人工门。早期停下来等人批准/OAuth 的做法已被用户纠正，不要再抄。
- 所需 token/key 已在主仓 gitignored `.env`。Agent 读取但不输出、不再索取、不写入仓库/聊天/remote URL，不把整份 `.env` 或 PAT 预装认领端。
- 发布/管理端与认领端权限隔离。认领端只从成功 `claim_task` 获得该任务 forge 凭证。
- 不得 `inject`、直改 SQLite、或旧 `pairDeviceToSelf` / 无密语「绑到我自己」冒充新 **Private CA** 配对。不得把路径 B 再加一次孤立 `pair` 拼成新机制全闭环 PASS。
- 真实 Linux 认领端必须独立干净 `KAOLA_HOME` 和默认信任；服务器 Linux 容器不等于认领端。
- 真实 HTTPS **Private CA** → 自动 `pair` → 工作台批准 → 严格 `whoami` → v2 → 再接续下文「标准闭环」与 2026-09-08 本机 Linux 接续同一套生产交付，必须是**同一闭环**。不要为 #63 另造一套无关评审/OAuth/forge 流程。
- 浏览器自动化实际跑过工作台才记 UI 通过。真实 REST 可作协议诊断。外部 OAuth 人机挑战阻断则如实记阻塞，不伪造。
- 旧路径 A 的人工规则保留给历史记录；本路径按上述用户授权执行。
- 2026-09-07–08 VPS 与 2026-09-08 本机接续的历史 PASS **不是** 路径 L 本轮证据。旧容器已停/清理；执行前核实现场。若仍存在 `.kw/local-receipts/uat-20260907/` 只读参考，不把旧库/旧绑定当本轮 PASS。
- 本节是**可执行设计**。写入时 UAT **尚未启动**。执行顺序：产品候选复核通过 → finalize keep-open merge/push/archive → 再启动路径 L。结果仍只追加本文件。

项目根 `AGENTS.md` 同步了同一作用域。

每家走同一条形状：**Private CA 自动配对（本轮增补）** 之后，沿用标准闭环：导入 Issue → 凭证档案 → 发布 → `claim_task` → 按 `clone` 四键改仓开 PR → `submit_pr` → 多轮评审 / 未申报头拒绝 / 修订 → 合并 → 轮询 `已完成` → 源 Issue 回写；并覆盖 Claim 恢复、八状态/十工具、依赖 restack、SSE、终止/重开。不要缩成「只改 README」。

认领侧契约以 GitHub [#23](https://github.com/KaolaBrother/KaolaTasks/issues/23) **最新评论**为准（不要重开 #22）。#63 认领端默认 `kaola-mcp pair --url`，不是 #48 `trust install`。

## 怎么分工

| 标记 | 谁做 | 规则 |
|------|------|------|
| **自动** | Agent 可单独做 | 测命令、起服务、查 SQLite、调不需要浏览器 cookie 的 API、用已写入 `.env` 且 gitignore 的令牌调 forge API、已配对后走 MCP |
| **配合** | 历史路径 A：人和 Agent **当场一起做** | 仅路径 A / 未授权的物理机。浏览器登录、页面贴仓库令牌、Authorize、管理员网页绑定。人操作页面；Agent 报下一步、事后核 SQLite / 网络。令牌只进 `.env` 或页面输入框 |
| **路径 L（全 Agent）** | Agent，含 Computer Use | 本机隔离 Linux UAT。管理端真实工作台登录与密语批准由 Agent 自动化；认领端独立 Linux 真实 Agent 会话。不等人。凭证规则见顶部更正 |

`.env` 已 gitignore。路径 L **不再**为 PAT 向人索取；主仓 `.env` 已有则读取。聊天里不出现令牌值。

## 四种跑法

路径 A 是真人浏览器 + 真 OAuth。路径 B 是无人值守脚本（`inject` + 生产 MCP，不打开 Vue）。路径 C 把 B 的假考拉进程 **listen** 出来，用真实工作台代替真人点评审面板，仍不走 GitLab Authorize。**路径 L** 是本机隔离 Linux 上的生产服务 + 真实 **Private CA** + 独立认领端 + 真实工作台密语批准，用来验收 #63 新配对机制，并**沿用**下文标准闭环与 2026-09-08 本机接续的交付面；**不能**用 B 或 C 代替，也不能把旧 VPS/本机历史 PASS 算进本轮。

### L. 本机隔离 Linux 全 Agent 私有 CA 闭环（#63）

#### 拓扑（固定后再执行）

| 角色 | 是什么 | 不是什么 |
|------|--------|----------|
| 隔离根 | 仅 `/private/tmp/kaolatasks-63-uat.<id>/`（已准备目录可复用，执行前按冻结 SHA 刷新 `source/` 并重建镜像） | 旧生产库、无关容器、已卸载 VPS |
| 服务端 | Linux 容器跑生产 Fastify + `apps/web/dist`；独立 SQLite 卷；`KAOLA_PAIRING_MODE=private_ca` | 认领端 |
| TLS 入口 | 服务端 Linux 容器内 Node proxy：`:34463` HTTPS → `127.0.0.1:31463`；仅发布 `127.0.0.1:34463:34463` 到宿主。`PUBLIC_URL=https://localhost:34463`，leaf SAN `DNS:localhost` + `IP:127.0.0.1` | 公网部署 |
| 管理端入口 | 同一容器 proxy `:31415` HTTP，仅发布 `127.0.0.1:31415:31415` 到宿主（cookie host 必须是 `localhost`） | 把 PAT 贴进认领端 |
| 签发端 | 隔离目录内 root/leaf；私钥不进认领端、不进 git | 认领端预挂 PEM |
| 认领端 | **第二个** Linux 容器：`--network container:kaolatasks-issue63-uat` 共享服务端网络命名空间，但文件系统与空 `KAOLA_HOME` 独立；默认 CA 库、无 `NODE_EXTRA_CA_CERTS`、无 PAT、无 receipt，不挂服务端配置、证书或数据库 | 只把服务器容器叫「Linux 认领」 |
| 管理端 Agent | 主控 Codex + Computer Use / 浏览器自动化操作真实工作台；Runner 只用于明确 Issue 的代码修改，不承包 UAT | 路径 B 的 stub 登录冒充 UI 通过 |
| 认领端 Agent | 主控 Codex 经 stdio MCP 驱动独立 Linux 容器内生产 `apps/mcp/bin/kaola-mcp.mjs`，与上次实际 `docker run --network container:…` 方法相同；不另起 coding Agent CLI | `scripts/forge-smoke.ts`、`pairDeviceToSelf` 或仅 REST 冒充生产 MCP |

镜像 tag 设计为 `kaolatasks-issue63-uat:final`，构建上下文 = 冻结候选 SHA 的 source，不是审查 FAIL 的旧 SHA。`start-linux.mjs` 的 `server.env` 为 `wx`，重建前勿残留。回收：停路径 L 容器与 proxy、删该隔离 `data/` 与认领端 `KAOLA_HOME`；不动其它 Docker。2026-09-07 VPS 与 2026-09-08 `kaola-tasks-local-uat` 已停/清理，**不要**默认复用；执行前 `docker ps -a` 核实现场。旧证据与受保护库只保留，不挂进本轮隔离根当 PASS。

#### 网络与 origin

本机使用 Colima 的 Linux Docker。认领容器显式采用 `--network container:kaolatasks-issue63-uat`，其 `localhost:34463` 到达服务端容器里的 HTTPS proxy；宿主浏览器通过仅 loopback 发布的端口到达同一 proxy。两边保持 `https://localhost:34463` 和同一 SAN，无需改 origin、另加 host-gateway 或关闭 TLS。共享网络不共享文件系统：认领端不挂签发目录、服务端 `.env`、SQLite、根证书或密钥。

L5 前分别核验宿主和认领容器的 TCP 可达性。认领端默认信任的严格 HTTPS 应报 unknown issuer，而不是连接失败；这只证明传输前置条件，不是受信成功。管理侧另用显式公开测试 CA、hostname 校验及失败退出核验完整 TLS。不得用 `NODE_TLS_REJECT_UNAUTHORIZED=0`、`--insecure`、`curl -k` 把端口连通记为 TLS 通过。

#### 沿用 vs 增补（不重造无关流程）

| | 做什么 | 不要做什么 |
|--|--------|------------|
| **沿用** | 下文「标准闭环」#1–14（含 12b 未申报头）、Claim 恢复/fencing、八状态、十个 MCP 工具、依赖子任务/restack、SSE、终止确认/重开/关 PR、真实 GitLab/Gitea OAuth（已有 `.env` 客户端时 Agent Computer Use）、源 Issue 回写。形状与 2026-09-08「本地 Linux 接续」相同。 | 为 #63 另写一套评审/OAuth/merge 剧本；把路径 B 的 `pairDeviceToSelf` 或缩水 README-only 当成完整 smoke |
| **本轮增补** | 干净 Linux 认领端 **Private CA** 自动配对：`pairing_required` → `kaola-mcp pair --url` → 工作台 `配对密语` → 严格 TLS + active `whoami` → v2，再进入沿用交付。恢复/负例见下表。 | 手工 `trust install`、预挂根、旧「绑到我自己」无密语路径、Privacy AI 误称 |
| **历史节** | 2026-09-07–08 VPS 与 2026-09-08 本机接续原文不动 | 把那些行的 PASS 改写成路径 L 本轮通过 |

若本地仍有 `.kw/local-receipts/uat-20260907/` helper，只读对照步骤与脱敏结构；其中 DB、绑定、token 不是本轮现场。

#### 凭证与信任

- 管理/发布侧从主仓 `.env` 读 `GITLAB_TOKEN` / `GITEA_TOKEN`（及既有 OAuth 客户端配置若要用真 OAuth）。
- 认领端 MCP 配置只有 `command` + `--url ${PUBLIC_URL}`，无密钥。`pair` 密语只经受保护本地通道（认领 tty → 管理端自动化输入），不进聊天、bootstrap 响应、日志、Issue。
- 管理端本机若要打开 HTTPS 工作台，系统/浏览器信任与 MCP v2 分开；不得把同一预挂根当作认领端自动配对成功条件。
- 禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0`、`--insecure`、`curl -k`、证书例外当 PASS。

#### 闭环步骤（GitLab 与 Gitea 各一遍）

每步：前置 / 操作 / 期望 / 证据 / 失败恢复。全部为路径 L 的 Agent 执行，不是配合门。

| # | 前置 | 操作 | 期望 | 证据 | 失败恢复 |
|---|------|------|------|------|----------|
| L1 | 冻结 SHA 已 merge 或经授权在隔离目录刷新 source | 重建 `:final`，启动 server + TLS proxy + 空 SQLite | 服务健康；`private_ca` 启动成功（配置根+leaf 与 `PUBLIC_URL` 一致） | 容器日志无 token；`openssl s_client -verify_hostname localhost` 对入口成功 | 错根/错 SAN 应启动失败；修配置后重建，不改旧库 |
| L2 | 空库 | Computer Use：初始向导建本地管理员；**不要**空库 OAuth | `active`+`admin` | 工作台已登录；SQLite 有本地管理员，无密码入日志 | 向导失败则停，不 inject 用户 |
| L2b | 已有管理员；`.env` 已有 OAuth 客户端 | Computer Use：真实 GitLab / Gitea Authorize（与 2026-09-08 本机接续相同）。空库之后才允许 OAuth 建发布者 | 工作台显示发布者；无权限提升成第二个密码管理员 | 实际走过回调才记 OAuth UI；人机挑战阻断则记阻塞 | 勿用 stub userinfo 充真实 OAuth |
| L3 | 管理员或发布者会话 | 工作台或**该会话**下 REST 建 GitLab/Gitea 凭证档案（PAT 只从 `.env` 进页面或带 cookie 的请求） | 档案列表无 token 字段 | UI 实际走过才记 UI；仅 REST 则记「协议诊断」 | 缺 PAT 记阻塞，不编 token |
| L4 | 档案 | 工作台导入并发布 smoke Issue（`KaolaBrother/kaola-tasks-smoke`） | 任务 `待认领` | publicId、源 Issue URL | 导入失败不改库顶替 |
| L5 | 干净认领端；L1 可达性已过 | 生产 `kaola-mcp --url ${PUBLIC_URL}`（认领端无 extra CA） | **仅传输层**：HTTPS unknown-issuer → 打印 `pairing_required`，退出码 `2`。此时还没有设备证明、也打不到 MCP，**不能**当作 pending `202` | 认领端无 v2；stderr 为 unknown-issuer / `pairing_required` | 若已有 v2 则拓扑不干净，换新 `KAOLA_HOME`。勿 `--insecure` 硬闯 MCP |
| L6 | L5 | 同一认领端 `kaola-mcp pair --url ${PUBLIC_URL}` | 终端展示密语；receipt `0600`；服务端出现 **pending 设备** | 密语不在服务响应/聊天；SQLite pending 行 | `--cancel` 只删本机 receipt 后重来 |
| L6b | L6 已有 pending；**尚未** L7 批准 | **生产授权诊断**（单独标记，不是 L5）：在**宿主机**用一次性诊断 `KAOLA_HOME`（复制认领端 `device.json` 身份，**不**写入认领端 `trust/`）。该进程用隔离目录 `root.pem` 作 **仅此进程** 的 `-CAfile`/`NODE_EXTRA_CA_CERTS`，严格 TLS 打 `https://localhost:34463`，以该 pending 设备的 device proof 调生产 `list_tasks` / `claim_task` | HTTP `202` `{ error: 'authorization_required', pending: true }`；无 forge token | 诊断 home 用后删除；认领端 `KAOLA_HOME/trust` 仍不存在；无 `--insecure` | 禁止：往干净认领端装根、`pairDeviceToSelf`、inject、直改 status。诊断失败不得用 L5 顶替 |
| L7 | L6 密语；L6b 已记 | 管理端 Computer Use：电脑页 `配对密语` 绑到管理员（`data-testid=device-bind-pairing-secret`） | 设备 `active`；pair 完成严格 TLS + active `whoami`；v2 落地 | 认领端 `$KAOLA_HOME/trust/v2/<origin-digest>/`；whoami 有 `instance_id` 无 forge token | 错密语显示「配对密语不正确」；不得 SQL 改 status |
| L8 | L7 | 同一设备生产 MCP `tools/list`、`list_tasks`、`claim_task` | 认领成功才揭示该任务凭证 | claim `201`；日志无 PAT 前缀 | pending 仍 `202` 则配对未完成 |
| L9 | L8；沿用标准闭环，不另造剧本 | 认领端 Agent：真实 clone 四键、Draft PR、`submit_pr`、多轮评审、`submit_revision`、12b 未申报头 `409`、通过、forge API 合并、`pollPendingReviews`；另做 Claim 恢复/fencing、十工具、依赖 restack、SSE、终止确认/重开（形状同 2026-09-08 本机接续，详见下表） | 任务终态与回写符合标准闭环；不是 README-only | forge URL、SQLite 状态、回写条数、`events.details` 无令牌 | 按手册既有评审循环恢复，不跳过 PR、不拿历史节 PASS 顶替 |
| L10 | 第一家完成 | 对另一家 forge 重复 L3–L9（仍同一隔离服务，认领端可新 `KAOLA_HOME` 或证明同设备多任务） | 两家都走完沿用闭环 | 各一家 Issue/PR | 一家失败不把另一家外推 |

`pair` 不是 MCP tool。L8–L9 由主控 Agent 经真实 stdio MCP 调 Linux 中的生产工具；协议驱动器只是通道，不冒称独立 AI 会话。不能只跑 Node 测试或 forge-smoke。

沿用面（L9）对照 2026-09-08 本机接续与「标准闭环」，**本轮必须再跑**；历史节判定保持原样：

| 沿用项 | 本轮怎么跑 | 旧证据 |
|--------|------------|--------|
| 标准闭环 #8–14 + 12b | 配对完成后的生产 MCP / 工作台 | 2026-09-07 VPS / 路径 B 行 **不是** 本轮 |
| Claim 恢复与异设备 fencing | 同设备 replay、release、跨进程 receipt；另一设备 `403` | 历史 PASS 不顶替 |
| 八状态 / 十工具 | `tools/list` 见 10 个工具；状态按 DESIGN 中文规范走完 | 旧 launcher 10 工具不是新配对证明 |
| 依赖 / restack | 创建本轮父子任务，按 §17 跑父完成、子 restack、rebase 与交付；未完成不得宣称完整 UAT 通过 | 旧 `kt-2026-0005` 不复用 |
| SSE | 工作台不手动刷新可见换列；独立 SSE 无 token | 旧 SSE 行不是本轮 |
| 终止 UI / 重开 / 关 PR | Computer Use 点确认框；REST 只作协议诊断 | 2026-09-08 终止 UI 已完成 ≠ 本轮已做 |
| 真实 OAuth | L2b | 2026-09-08 Safari OAuth 行不是本轮 |

#### 恢复 / 负例矩阵

| 项 | 真实路径 L | 自动测试（可控时钟/进程） | 不得 |
|----|------------|---------------------------|------|
| 批准前客户端中断、同 receipt 再 `pair` | 杀 pair 进程后重跑，密语不变，管理端仍可批准 | pairing/pair 套件 | 把单元当已做物理等待 |
| 批准后、v2 落地前重启 | 同 receipt 恢复 approved attempt 并 whoami | `approved pairing recovers on create after bind` | 新 nonce 当同一 attempt |
| 错密语 | 工作台错误文案；8 次后 attempt 拒绝 | pairing 错密语用例 | SQL 清计数充 PASS |
| 86400 不滑动 / 到期 | **不**把墙钟调一天；记「未做物理 24h」 | pairing 冻结时间用例 | 改系统时间充 24h |
| 90 天默认 / 存量 30 | 新绑定 `expires_at`；不改旧行 | db-migration | 猜迁存量 |
| 换 root/origin / nonce replay | 换入口或重放证明应失败 | pairing replay | 关 TLS 验证 |
| pending 无 list/claim | L6b 的真实 pending 设备生产授权诊断返回 `202`；L5 仅为 TLS 证据 | pairing pending `202` | 用 TLS 失败代替授权证据；先 pairDeviceToSelf 再测 pending |
| overlap / 错过 overlap 再 pair | 有条件时做；否则记未执行 | pair overlap / repair 套件 | launcher 提示 pair 但未跑 pair 当 PASS |
| 证书配置错误 | 错根启动失败 | unrelated CA / 错名 s_client | 默认库里的别的根冒充配置根 |
| caller extra CA 污染 | 认领端不设 extra CA | R4 真实 TLS 子进程 | 给认领端预挂根再测公开迁移 |
| trust 替换中断 / rename 失败 | 可选破坏 staging；否则记未执行物理中断 | R5 previous + forced rename | 先 rm 再 rename 的旧实现 |
| 公开 CA 迁移 | 本路径是私有 CA；公开迁移边界保持自动测试 | public-CA migration 用例 | 本路径 Linux 通过 ⇒ 公开 CA 干净机器 PASS |

#### 结果模板（执行后追加，不预填 PASS）

```
日期 / 候选 SHA / 镜像 tag / Node / OpenSSL
隔离目录 / 服务端容器 / 认领端 KAOLA_HOME（路径可记，不含 secret）
Private CA 配对：pair 出口、v2 digest 是否存在、whoami 无 token
沿用交付：GitLab Issue/MR、Gitea Issue/PR、八状态/十工具、12b、restack/SSE/终止（做了哪些）
未执行 / 外部阻塞（OAuth 人机、缺 Linux Agent 承载、forge 故障）
历史 2026-09-07–08 行未改写成 PASS
```

未启动前本段保持「设计已写、执行未做」。

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

> 路径 L **沿用**本节与下一节的交付面，但这些历史 PASS **不是** 2026-09-09 路径 L 本轮证据。术语是 Private CA，不是 Privacy AI。

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

> 路径 L 的执行风格（Agent 完成 OAuth / 网页绑定 / 独立 Linux Claim）以本节为参考；**绑定机制改为 Private CA `pair` + 密语**，不得把本节的 `trust install` / 无密语绑定或下列 PASS 记作路径 L 本轮通过。

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

完整 Web 回归首次有一项 `App.error-envelope.test.ts` 的 403 发布提示断言报 `missing [data-testid="task-message"]`（165/166）；该文件及 Web 产品代码未改。原样单文件复查 **11/11** 通过。随后原样完整 Web 复查 **166/166、9/9 文件通过**。保留首轮失败，不把重跑写成从未失败；该单次异步提示断言波动的根因未在本轮认定，后续调查记录为 [#61](https://github.com/KaolaBrother/KaolaTasks/issues/61)。

### VPS 已按后续指令卸载清理

此前“保留部署和备份”的现场已被用户后续明确清理指令取代。清理前已在本机保存接续所需的受保护配置与停服数据库。VPS 上已删除 Kaola Tasks systemd unit、部署及旧部署、SQLite 数据、该服务备份、私有 CA/反代站点、测试日志与临时构建文件、专用 kaola 用户、安装的 Node 22 目录和对应命令链接；卸载本次安装且无其他使用者的 nginx、Docker/Compose/containerd 及其测试依赖，删除空容器数据和本次安装时产生的 corepack/pnpm 缓存。

清理前核实 Docker 容器、镜像、卷均为空，未发现安装在 VPS 的 GitLab/Gitea 服务；两家 smoke 仓库在外部 forge，不属于 VPS 软件卸载。清理后 `kaola-tasks` 为 `LoadState=not-found`、`ActiveState=inactive`，node/docker/nginx 命令及专用用户均不存在。既有 `kaola-relay`、`rustdesk-hbbs`、`rustdesk-hbbr` 三项服务仍 active。保留共享 SSH 配置、其他服务和系统级 apt/journal 审计记录，不删除整机共享日志。

详细日志与敏感配置只留在不跟踪的本地 operator receipt。Windows 客户端、公开 CA 干净机器默认信任，以及未逐项制造的真实 VPS 故障场景均不包含在本轮通过范围；已有自动合同覆盖与真实设备／服务验收分开计。


### 本地接续最终收尾

验收后的数据库为 **11 个任务均终态：5 已完成、6 已取消；24 条 lease 全部 released**。GitLab/Gitea 用户均保持 `active/full`，本地用户为 `active/admin`；没有 OAuth 权限提升。核对 **191 条事件**不含两家 PAT 或管理员密码。修复版容器中的 auth 源码和新增测试 SHA-256 与工作区一致。

本轮选定的 GitLab/Gitea 业务闭环、八状态／十工具扩展、macOS/Linux 客户端、真实 OAuth、设备绑定和终止 UI 已完成；此前缺项由上述本地真实环境接续补齐。Windows、公开 CA 与未制造的故障场景仍按上面的边界记录。验收后已停止本地 `kaola-tasks-local-uat` 容器（`exited`、`Running=false`），保留本地受保护的数据库、配置和证据供复现。VPS 已完成上述卸载清理。

## 2026-09-09 #63 私有 CA 自动配对：UAT 前置清单（未做活网）

本轮 `workflow/bundle-63` 曾把 #63 做到**可进入真实 UAT 的候选**。其后用户授权本机隔离 Linux 测试（不授权外部部署）。**可执行设计见文件顶部路径 L**；写入路径 L 当时 **尚未启动** UAT。此前 #48/#60 的 macOS/Linux `trust install`、OAuth、旧绑定路径**不能**替代 `kaola-mcp pair --url`。路径 B **不能**替代路径 L。

### 本机自动门（已执行）

候选 HEAD 在写入本段时核对；后续提交只追加本清单的文档句，不改产品字节则门禁证据仍有效。

| 门 | 命令 | 结果 |
|---|---|---|
| lint | `pnpm lint` | 退出 0（`eslint .` 无 findings） |
| typecheck | `pnpm typecheck` | 5/6 workspace 项目 Done（含 mcp） |
| Node 测试 | `pnpm test` 前半 | **1091/1091** pass，0 fail |
| Web 测试 | `pnpm --filter @kaola/web test` | **169/169**，9 files |
| build | `pnpm build` | web/server/shared/forge-adapters 退出 0 |
| whitespace | `git diff --check` | 干净 |
| secret scan | `git diff origin/main...HEAD` 新增行 | 无私钥 PEM、无真实 `ktk_` / `glpat-` / `ghp_`；`BEGIN CERTIFICATE` 仅测试断言与占位 PEM 头；`KAOLA_PAIRING_TTL_SECONDS=900` 只作为失败关闭用例 |

### Issue 验收对照（自动 vs 未执行）

| 验收项 | 本轮证据 | 判定 |
|---|---|---|
| DESIGN / ADR / vectors 冻结后再改行为 | `65e8c7d` 冻结；TTL 纠正 `13ecac3`；90 天在后续检查点 `d572dcb`，不改写 Mission 1 result | 自动合同 PASS |
| 期限一致：86400 / 90 天，无 15 分钟有效窗口 | `parsePairingTtlSeconds('900')` 抛错；boot `KAOLA_PAIRING_TTL_SECONDS=900` fail-closed；bind `paired_at + 90d`；升级重建 DEFAULT 90、存量 30 与既有 `expires_at` 原样 | 自动 PASS |
| 申请接近 24h 仍可批准/恢复；到期拒绝；recover 不滑动 | `apps/server/src/pairing.test.ts` | 自动 PASS |
| 较早 pending 不缩短一天窗口 | 同上 leftover pending 只延长 | 自动 PASS |
| 全新库与升级后新建所有者 DEFAULT 90 | `apps/server/src/db-migration.test.ts` `issue #63 device_max_age_days default 90` | 自动 PASS |
| 自定义策略与既有 `expires_at` 不变 | 同上 | 自动 PASS |
| pending 不能 list/claim；bootstrap 不碰 Task/credential | pairing REST `rejectAuthorization`；pending `202`；leftover `ktk_` 401 | 自动 PASS |
| `kaola-mcp pair --url` 严格 TLS、公开 CA 不装额外根、`pairing_required` 退出 2 | `apps/mcp/src/pair.test.ts` | 自动 PASS |
| 重启/重放/错密语/中间人/legacy v1、overlap、错过 overlap、公开 CA 迁移 | pair + trust + pairing replay 套件 | 自动 PASS |
| 三 forge adapter / Claim / token containment 回归 | 全量 Node 1091 含既有 adapter/claim/vault 套件 | 自动回归 PASS；**不是**活网三 forge UAT |
| 通用客户端 `pair → 管理员批准 → strict whoami → MCP list_tasks`，认领者不碰 PEM | 进程内 harness | **未**在真实 package-bin / 真实私有 CA / 真人工作台执行 |
| macOS / Windows / Linux package-bin Claim 客户端 | — | **未执行**；不得写 PASS |
| 浏览器「电脑」页粘贴配对密语并授权 | — | 路径 L 设计要求 Agent Computer Use 真实执行；**本节写入时未执行** |
| 真实 OAuth、活网私有 CA、部署、系统/浏览器装根 | — | 外部部署仍未授权；路径 L 覆盖本机隔离私有 CA，**执行前不得预填 PASS** |

### 真实 UAT 建议顺序（配合，本轮不做）

> 已被文件顶部 **路径 L** 取代为「全 Agent、本机隔离、执行前不写 PASS」。下列编号保留作历史。Windows 客户端、公开 CA 干净机器、以及未制造的故障场景仍按上文既有边界，不由路径 L 的 Linux 通过改写为通过。

1. 独立 `DEBUG_PRIVATE_CA` 入口（SAN 含 `<public-host>`），`KAOLA_PAIRING_MODE=private_ca`，公开根路径无私钥块。
2. 干净认领端：`kaola-mcp pair --url ${PUBLIC_URL}`，确认密语只出现在本机终端，不进 bootstrap 响应。
3. 管理员已受信工作台「电脑」页输入 `配对密语`，绑到 owner；客户端应自动落地 v2 根并 strict whoami。
4. 随后 `kaola-mcp --url` 发现工具并 `list_tasks`（pending 阶段不得成功）。
5. 分别重启客户端/服务端后恢复同一未过期 attempt；取消用 `--cancel` 只删本机 receipt。
6. 负例：错密语、换根/origin、过期、公开 CA 机器不得多装根。
7. 按平台各记一笔 macOS / Windows / Linux package-bin；未跑的平台保持「未执行」。

## 2026-09-09 #63 范围纠正：不自动迁公开 CA

正式评论 [5595770991](https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5595770991) 取代正文中要求交付「公开 CA 迁移 / 自动删本机私有根」的段落。本检查点之后，上一节把「公开 CA 迁移」写成自动 PASS 的句子**不再是现行产品合同**；历史 Mission 4/6 result 不改写。

保留：私有 CA `pair` 恢复、overlap 轮换、无 extra CA 的公开 CA 直连（`pair` 成功且不装额外根）。去掉：`--url` 在默认库 + `whoami` 后 `rm` 该 origin 的 v2 目录。

受影响验证在纠正提交上重跑，不沿用上一节全量 PASS 数字。活网 UAT / 部署仍未执行。

## 2026-09-09 #63 范围恢复：保留公开 CA 迁移

正式评论 [5595967717](https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5595967717) 取代 5595770991 的移除要求。产品行为恢复为 `8be16f6` / `09a01f5` 已验证的 launcher 迁移：默认库严格 TLS + 匹配 active `whoami` 后只删该 origin 的 v2 extra root。历史 `5a4f1e1` 与上一节不改写。其后 UAT 设计见顶部路径 L；**设计写入时仍未执行**。

## 2026-09-09 路径 L 实际执行：Private CA Linux 闭环

**判定：私有 CA 自动配对和已执行的交付链路通过；整套 UAT 不是全项通过。** OAuth 存在真实配置阻塞，配对轮询有监听器警告，回写有额外重复。以下是本轮新证据，不沿用历史 PASS，也不把自动测试写成真实环境验收。结果只记本手册，未发到 GitHub Issue。

### 候选与隔离现场

- 先完成 `bundle-63` 独立审查、finalize keep-open、merge/push/archive，再开始本轮；测试源为主分支 `0eeb2c00c67994d1f573c002fd0d4613be009587`。#63 仍开放。归档验证命令为 `pnpm lint && pnpm typecheck && PATH=/opt/homebrew/opt/openssl@3/bin:$PATH pnpm test && pnpm build && git diff --check`；Node 1109、Web 170 通过。macOS 默认 LibreSSL 不满足本次测试要求，改用已安装的 OpenSSL 3 后通过；不是忽略失败。
- Colima 中两个独立文件系统的 Linux 容器：`kaolatasks-issue63-uat` 和 `kaolatasks-issue63-claimant`，镜像 `kaolatasks-issue63-uat:final`，Node `22.23.2` / Debian Bookworm OpenSSL `3.0.20`。认领端共享服务端网络命名空间以保持 `localhost` SAN，但只挂自己的 `/client`，不挂服务端数据库、`.env`、PAT 或签发根。
- 真实私有 CA HTTPS 入口为 `https://localhost:34463`；TLS proxy 在服务容器中转发生产服务。本机管理侧使用仅发布在 loopback 的 `http://localhost:31415`。**管理页面不是浏览器 HTTPS 信任验收**。根 CA 私钥只留隔离签发目录；TLS 终端持有自己的 leaf key，认领端没有根或 leaf 私钥。未安装系统/浏览器根，未绕过证书警告。
- 主控 Codex 自己完成管理端 UI、生产 stdio MCP、Linux git、真实 forge API 交付与验收，未把 UAT 委派 Runner；未在 Linux 另起 coding Agent CLI，也未宣称执行了一套额外 Workflow/Runner carrier。没有 `inject`、直接改 SQLite 或旧 `pairDeviceToSelf`。SQLite 仅在结尾只读核验。
- 受保护、gitignored 现场为 `.kw/local-receipts/uat-20260909/`。其中管理员密码、环境、设备私钥、配对终端输出不提交；`*-safe.json`、状态/协议检查记录仅作本机定位。该目录不能整体上传。

### 本轮通过项

| 验收面 | 实际操作与结果 |
| --- | --- |
| 干净认领端 | 默认严格 HTTPS 返回 unknown issuer，生产 launcher 输出 `pairing_required`、退出 2；初始无 trust、receipt、授权和 PAT。这是传输负例，不冒称 pending 授权证据。 |
| pending 授权 | 配对申请建立后、批准前，以该真实设备签名做单独 HTTPS 授权诊断；`list_tasks`、`claim_task` 均为 `202 authorization_required`，无 token。诊断只在管理侧信任公开测试 CA，未给认领端装根。 |
| 真实网页批准 | UI 建本地管理员；错误密语显示「配对密语不正确」；正确密语「绑到我自己」后，pair 自动完成严格 TLS / active whoami / v2，随后新生产 MCP 进程可列工具和任务。无手工 PEM、env 或重启作为首次就绪条件。 |
| 配对恢复 | 首台设备 pending 期间中断 pair 后恢复，同 receipt SHA-256；第三台设备在服务端与认领容器重启后恢复同 pairing id、receipt SHA-256、instance 和 `expires_at`，再由网页批准成功。前者隔离验证客户端重启；后者联合验证服务/客户端重启，不宣称只重启了服务端。 |
| 期限与消费 | 只读 DB：三次 attempt 的 `expires_at-created_at` 均为 `86400`；三台批准设备 `expires_at-paired_at` 均为 `7776000`（90 天）；三次 pairing 均 `consumed`，本机一次性 receipt 均删除。没有改真实时钟或声称等待过 24h/90d。 |
| 发布与 Claim | 两家真实凭证档案均在 UI 添加，Issue 下拉导入并发布；同一已配对 Linux 设备成功 Claim 后才把本任务凭证送入 Linux git。clone 四键存在；GitLab 使用已知 Basic oauth2 兼容头，Gitea 使用信封头。token 不入 remote URL / `.git/config`。 |
| Claim 恢复与 fencing | 两家各执行 release → 新进程恢复终态 receipt → 新 Claim；active replay 返回相同 Claim ID/凭证。另一个通过真实 pair 批准、同 owner 的设备持正确 Claim ID仍为 403；原设备错误 Claim ID 为 409，正确 Claim 为 200。后两项为严格 HTTPS 签名 REST 诊断。 |
| 标准交付 | 真实 Linux clone/提交/push → Draft MR/PR → `submit_pr` → 阻塞意见/开轮 → Claim/read feedback/修订 → 同 PR `submit_revision`。GitLab 第一、第二轮意见由网页提交；Gitea开轮用真实管理员 REST，最终通过仍点网页。未把 REST 记成对应按钮测试。 |
| 未申报头 | 两家推新头但不交回，待 forge 已报告新 SHA 后尝试通过；GitLab 网页出现中文拒绝和「forge 头已变化」，Gitea真实 REST为 `409 head_sha_stale`；任务仍待验收。再次开轮、Claim、以新头交回后通过。 |
| 多轮/十工具 | 十个生产 MCP 工具均实际调用成功（不只是 `tools/list`）。`post_discussion_message` 首次漏传必填 `claim_id` 被 SDK 拒绝，这是驱动参数错误；后续携带当前 Claim ID 的 resolution 成功，不把首次失败写成成功。 |
| 父子依赖与 restack | GitLab子任务 Claim 的 base 指向父分支；从子 Claim `open_review_round` 使父任务待修改。父未完成时子通过被 `409 parent_not_completed` 拒绝。父合并后子自动待修改、Review Brief `kind=restack` / `base_branch=main`；真实 rebase、同 MR回交、通过、合并。另建未就绪父子任务，子 Claim 为 `parent_not_ready`。 |
| restack 推送安全 | 用户明确交由主控按正确性判断后，核对远端仍是本轮子提交；只对 `kaola/kt-2026-0003-restack` 使用带确切旧 SHA 的 `--force-with-lease`。不改主分支、不覆盖别人的提交。 |
| SSE / 八状态 | 浏览器不刷新可见 Claim、评审、合并后的换列；独立真实 session SSE 接收 `task_updated`、`progress`，不带 note、body_md、PAT。事件记录覆盖八个规范状态。 |
| 终止/重开/关 PR | 对本轮 Gitea PR58 在网页点「终止本次交付」，后续真实状态及事件证实 `已退回`；再实际点「重新开放」→待认领、「取消」→已取消，forge API关闭 PR且未合并。终止点击曾超时，原生确认框未被可靠捕获，**不把确认框的单独交互细节记为已验证**；没有用 REST terminate 顶替。 |
| 终态和敏感信息 | 七个测试任务均完成/取消，活动 lease 为 0。`verify-containment.mjs` 检查 35 个暴露面：列表/详情/review/凭证档案、133条事件、服务stdout/stderr、四个 `.git/config`/末次diff、源Issue评论/SSE、三份v2；未发现仓库 PAT 或私钥 PEM。v2无literal origin，已消费receipt不存在。检查不覆盖本来就持有秘密的隔离环境/设备文件和受保护CLI密语日志。 |

### 本轮真实 forge 资源

| 本地任务 | 真实资源 | 最后状态 |
| --- | --- | --- |
| `kt-2026-0001` | [GitLab Issue34](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/34) → [MR31](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/31) | 合并，已完成，第4轮；最终提交 `05dec66bda25` |
| `kt-2026-0002` | [Gitea Issue56](https://gitea.com/KaolaBrother/kaola-tasks-smoke/issues/56) → [PR57](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/57) | 合并，已完成，第3轮；最终提交 `edd0dbdaaf22` |
| `kt-2026-0003` | [GitLab 子 MR32](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/32) | restack后合并，已完成，第2轮；提交 `e3e660e457a2` |
| `kt-2026-0004` | [Gitea PR58](https://gitea.com/KaolaBrother/kaola-tasks-smoke/pulls/58) | UI终止/重开/取消；PR关闭未合并 |
| `kt-2026-0005`–`0007` | fencing、SSE、未就绪依赖的本轮临时任务 | 均已取消，无活动Claim |

### 阻塞、发现与未执行边界

1. **GitLab OAuth：BLOCKED_CONFIG。** Safari真实点击「使用GitLab登录」，provider返回 `The redirect URI included is not valid.`。本轮 `PUBLIC_URL` 回调为 `https://localhost:34463/login/gitlab/callback`，不是此前HTTP回调。未修改外部OAuth应用，未伪造回调/用户，没有把既有本地管理员会话算OAuth成功。
2. **Gitea OAuth：BLOCKED_CONFIG。** 实际导航至Gitea登录，但主仓 `.env` 与本轮服务环境的 `OAUTH_GITEA_CLIENT_ID` / `OAUTH_GITEA_CLIENT_SECRET` 都为 `unused`。两家forge PAT真实可用，不代表两家OAuth客户端均已配置。没有索取或输出秘密，也没有创建新OAuth凭证。全量OAuth继续前需要有效注册及正确回调；本轮未静默安装系统/浏览器根。
3. **配对轮询监听器：OPEN_FINDING。** 同一冻结候选在多个真实pair等待进程输出 `MaxListenersExceededWarning`：TLSSocket累积11个`secureConnect` listener；最终配对仍成功。源码 `apps/mcp/src/pair.ts` 的每请求 `socket.on('secureConnect', …)` 与复用socket相符，但未测24小时内存曲线，不宣称已发生OOM。未通过提高listener上限掩盖，未在UAT中自行改产品。
4. **回写额外重复：OPEN_FINDING。** 两家任务各只有两次真实 `待认领→进行中`（release/reclaim），源Issue却各有3条「认领」评论，以及1条提交、1条完成，共5条；各有2条成功「翻ready」事件。故不能填「恰好三条回写」或去重通过。当前源码中即时后台回写与poller重试缺少共同in-flight互斥，属于原因假设；未做受控A/B隔离。成功合并及状态到达不因此变成失败，但回写唯一性另列未通过。
5. **浏览器工具边界。** 初次终止点击发生浏览器命令超时；随后状态/审计已确认终止。Computer Use不能控制Codex宿主，Chrome连接不可用；Safari本地HTTP登录后不保留本次Secure cookie，故没有用它宣称管理端HTTPS通过。原生确认框独立证据仍缺失。后续内置浏览器恢复并完成重开/取消、重启后的密语批准。
6. **自动测试而非本轮活网故障注入。** 批准后、trust落地前中断；root/instance/origin/nonce替换和重放；真实到期边界；legacy v1；overlap/missed-overlap；公开CA迁移；强制rename失败等维持归档候选的自动测试证据，本轮未全部在运行环境重新制造。不把Windows/macOS物理认领客户端、公开CA干净机器或已卸载VPS标为PASS。

本轮没有修产品代码，也没有把这些UAT发现发给Runner。后续代码修复须先有明确Issue范围；OAuth配置属于外部接入前置，不通过降低TLS或伪造身份解决。#63保留开放，不以本节局部通过关闭整体验收。

### 2026-09-09 接续调查：#63 前后归因（未修产品）

用户最新要求：主控直接处理，不再交给 Runner；**先调查**监听器与重复回写是否由 #63 引入。本节只记录调查，不宣称修复或完整 UAT 已通过。此前“需要再次授权使用现有凭证”的判断撤回：本机 `.env` 与既有账号配置的使用已获授权，OAuth 接入继续由主控完成。

对照为 #63 之前 `8784833` 与当前 `91e0a5a`。只读导出旧源码，以相同本机 Node、已安装依赖和同一隔离诊断脚本运行；SQLite 为各场景独立内存库，forge 出站替换为可控响应，不调用真实 forge 写接口。此为受控源码路径实验，不冒称完整旧版部署 UAT。

| 场景（两版本各重复三次） | #63 之前 | 当前 |
|---|---|---|
| 一次认领写回完成后再轮询 | 每次 1 个 POST / 1 条成功事件 | 每次 1 / 1 |
| 两次顺序认领写回（模拟重新认领） | 每次 2 / 2 | 每次 2 / 2 |
| 首次 POST 等待响应时并发轮询重试 | 每次 2 / 2 | 每次 2 / 2 |
| 两次认领写回与轮询同时等待响应 | 每次 3 / 3 | 每次 3 / 3 |

**重复回写归因：并非 #63 新增的回写回归。** 两版本 `writeback.ts`、`claim.ts`、`poller.ts` 和 forge adapters 字节相同；`app.ts` 的差异仅为 pairing 导入、配置校验和路由注册，没有改轮询调度。实验直接证明原有即时后台写回与轮询重试缺少共同并发互斥。真实本轮两任务均快速 release/reclaim，轮询间隔 2000ms，三条成功认领回写在数秒内集中出现，与实验一致；真实现场未记录每个出站请求的调用栈，因此不声称已逐一定位当时三次 POST 的来源。首次发现不等于首次引入；历史通过行保持原判定。

**监听器归因：#63 新引入，已真实复现。** `git blame` 将每请求追加 `socket.on('secureConnect', ...)` 定位到 `1d4eb9b`；#63 前没有该配对 transport。使用当前生产 `createDefaultPairingTransport` 向隔离本机真实 HTTPS 服务顺序发 25 个 bootstrap 请求：复用 1 条 TLS 连接，其 `secureConnect` listener 达 25，实际触发 `MaxListenersExceededWarning`。握手事件不会为每个复用请求重新触发，旧回调持续留存。没有修改 listener 上限，没有以警告推断 OOM，也没有执行 24 小时真实等待。

诊断脚本与旧源码快照保留在 gitignored `.kw/local-receipts/diagnostic63/`。本阶段没有修改产品源码、启动 Runner、重开已完成 forge 任务或触碰旧数据库。完整 OAuth 接续和修复后验收仍未完成。

收尾：确认活动lease为0后，仅停止本轮 `kaolatasks-issue63-claimant` / `kaolatasks-issue63-uat`，保留隔离数据库、镜像和受保护证据以便续验；未删除旧证据或无关容器。现有20分钟心跳只读检查剩余配置/用户方向变化，不重复创建任务、PR、环境或启动Runner。

### 2026-09-09 修复后全链路复验（完成，不是上一轮证据）

用户明确要求主控按 Workflow 自己修复、然后从头完整 UAT；不使用 Runner。生产候选 `a76674f`：配对请求使用单次 HTTPS agent 与一次性握手监听；即时回写和 poller 共享数据库实例内的 in-flight promise，同任务/动作/PR 的并发请求合并，翻 ready 另按评审轮隔离。不改变顺序重新认领语义，不宣称跨进程 exactly-once。#63 的产品增量仍只有 Private CA 自动配对；监听器修复属于这条新增链路，回写并发互斥是全链路 UAT 暴露且经用户另行授权修复的既有缺陷，不把其他既有流程问题归因于 Private CA。设计先行；两个独立复核均无阻塞问题。修复前定向测试真实失败，修复后 focused 88、macOS Node 1113 + Web 170、lint/typecheck/build 通过；Linux 测试同步问题单列于下，不用 macOS PASS 替代。

**全新隔离现场。** 镜像 `kaolatasks-issue63-uat:repair-a76674f`，新容器 `kaolatasks-issue63-repair-uat` 与 `kaolatasks-issue63-repair-claimant`，独立数据目录 `.kw/local-receipts/uat-repair-20260909/`。Linux Node 22.23.2 / OpenSSL 3.0.20；主机签发 OpenSSL 3.6.3。旧容器、旧库和旧证据未复用。本轮认领端从空 KAOLA_HOME 与默认信任开始，无预装根、receipt、设备授权或 PAT；CA 私钥未进入认领端。

| 本轮实际路径 | 当前证据与判定 |
|---|---|
| GitLab / Gitea OAuth | 两种真实浏览器 OAuth 登录及回调均成功，账号在本轮新库出现 full 权限。GitLab 使用已有应用，Gitea 本轮隔离应用 1136；secret 仅在受保护本地配置。先以已登记的 HTTP localhost:31415 回调完成 OAuth，随后同库切换 Private CA 服务模式。此为真实 OAuth PASS，**不冒称 HTTPS 浏览器 OAuth PASS**。 |
| Private CA 初始配对 | 未配对 Linux launcher 返回 pairing_required；真实 HTTPS pending 请求不可认领；网页错误密语被拒，正确密语批准后 CLI 严格 TLS + active whoami 完成并落 v2。主设备申请 08:53:56Z、批准 08:58:42Z，等待约 4 分 46 秒无 listener warning；未手工 PEM、环境根或重启来促成成功。 |
| 发布、认领与恢复 | 工作台真实导入 GitLab Issue 35 / Gitea Issue 59，发布本轮任务 1/2；生产 package-bin stdio MCP 认领、release/reclaim、request receipt 重放与进度恢复成功。PAT 仅从成功 claim 返回，经 Linux git stdin/临时 extraHeader 使用，不进入 remote URL。 |
| 多轮评审与新头拒绝 | 两端网页阻塞评审、MCP 读取反馈/声明解决/submit_revision 成功。真实推送但未申报的新头，两端网页均拒绝通过并显示 head_stale 文案；新一轮申报后才获通过。 |
| 两端真实合并 | GitLab MR33（最终头 `999dfc5c9bd2a6901eb0a5811eb77e582c0076ad`）、Gitea PR60（`b1e20245dc7b83f2e6a19158c35c7a40b4de12c2`）均合并，平台任务 1/2 已完成，分别第 4/3 轮。 |
| 依赖与 restack | 子任务 3 以父分支为基底，经 MCP 向父任务发起下游 blocking；父未完成时网页拒绝通过子任务。父合并后自动转 restack，核对远端原 SHA 后以精确 force-with-lease 重排；同一 MR34 改投 main、新头 `0fc34023e03dd390f4eb5189272ddba4d3500b49` 重新申报并经网页通过，真实合并后任务已完成第 2 轮。 |
| 回写去重 | 两个真实源 Issue 各只有认领、提交 PR、完成各一条；每个最终通过只有一条翻 ready 成功事件。快速 release/reclaim 落在同一个未完成写回窗口，合并为一个在途写回；未把此结果解释为禁止顺序重新认领。 |
| 第二设备 fencing | 独立空 home 第二设备经真实密语网页批准并严格 TLS 就绪；同账号另一设备持相同 claim ID 返回 403，主设备正确 claim 200、错误 claim 409。任务 5 已 release/cancel。 |
| SSE / 未就绪依赖 | 真实登录 session SSE 收到 task_updated、progress=67，不含 note/body_md/PAT；子任务对未就绪父任务 claim 返回 parent_not_ready。任务 6/7 均已取消。 |
| 重启恢复 | 第三空 home 在 pending 时同时重启本轮 server/claimant，重启前后 receipt SHA-256、服务端 pending 记录完全相同；恢复 CLI 继续同一申请，主设备重启后严格 TLS 生产 MCP 仍可用。随后真实工作台用原密语批准，CLI 自动完成 strict whoami、落地 v2 并删除一次性 receipt；第三设备于 10:40:40Z active，授权至 2026-12-08T10:40:40Z。 |
| 终止 / 重开 | 一次性 Gitea PR61 先通过生产 MCP 交付为待验收。最初内置浏览器通道未暴露原生 confirm，属于控制方法不对，不是产品或 Private CA 故障；改用真实 Playwright Chromium 后，第一次 dismiss 保持待验收，第二次 accept 转已退回，网页重新开放转待认领，再由网页取消转已取消。PR61 随后通过 Gitea API 正常关闭并核实未合并；未用 REST 状态迁移冒充网页 PASS。 |

**Linux 测试时钟归因更正。** 全量 Node 1113 已通过；Web 重复运行曾出现不同文件/用例的偶发失败（169/170 或 168/170），原候选也可复现。增加响应等待、等档案选项、自动卸载 wrapper 后仍失败，故未将这些推测写成根因，试探性改动已全部撤回。进一步捕获到 `task-title` input 的 `_vts=1788946496774`，Vue listener `attached=1788946496909`，事件比挂载时间早 135ms，模型 title 仍为空；Vue 的 `e._vts <= invoker.attached` 直接丢弃该事件。证据在 `data/repair-form-event-2.log`。这是本轮 Linux VM 的非单调墙钟在测试事件分发中造成的失败，不是输入表单生产代码回归。

仅新增 Web test setup（`720e239`）：每个测试用 `performance.now()` 推进以当前 epoch 为基点的 `Date.now()` mock，保留真实 timers，不调整系统时钟，不改原有 170 个测试的断言或交互。该最小改动后 Linux Web 连续三轮 170/170 PASS（`repair-linux-web-monotonic-{1,2,3}.log`）；最终 Linux 与 macOS 全量均 Node 1113 + Web 170 PASS，lint/typecheck/build PASS，独立 test-clock 复核无阻塞问题。最初 Linux test 误继承 Private CA 启动环境造成 7 个 auth-cookie fixture 失败，清理环境变量后消失；一次 macOS 重跑在工作树解析到 `/usr/bin/openssl` LibreSSL，已纠正为实际核对后的 OpenSSL 3.6.3 重跑。两者均保留为执行错误，不冒称产品缺陷或修复。所有未通过尝试日志保留，不只保留重跑成功值。

**最终安全核验。** `verify-containment.mjs` 已扫描 35 个暴露面：任务列表/详情/评审/事件、凭证档案、服务器日志、4 个 Linux git config 与最后提交、两端源 Issue 评论、SSE、三台设备的 v2 文件，均无 PAT 或 CA 私钥；v2 不含明文 origin，三份已消费配对 receipt 均不存在。只读 SQL 证实 14 条 lease 均 released、无 active；三次 pairing 均 consumed、TTL 均 86400 秒，三台 active 设备授权期均 7776000 秒，主设备错误密语计数为 1。最终 7 个任务、128 条事件覆盖待认领、进行中、待验收、待修改、待合并、已完成、已退回、已取消八个规范状态；任务 1/2/3 已完成，任务 4/5/6/7 已取消。

管理端使用本机回环 HTTP 入口，MCP 使用 Private CA HTTPS 严格校验；未绕过浏览器证书警告、未安装 macOS 系统根。本轮本机隔离 Linux 全 Agent 路径完成 PASS；实际 24 小时/90 天等待、Windows/macOS 物理认领客户端、公开 CA 干净机器、HTTPS 浏览器 OAuth 回调和已卸载 VPS 不在本轮 PASS 内，也不由本轮结果推断。#63 在本轮 Workflow lifecycle 完成前保持开放。

**本次收尾现场。** 确认活动 lease 为 0 并完成最终扫描后，关闭专用 Playwright 会话，仅停止 `kaolatasks-issue63-repair-claimant`、`kaolatasks-issue63-repair-uat`，inspect 均为 exited；旧容器与所有库、镜像、日志、clone、已消费 receipt 的审计材料均保留，没有删除材料。5 份配对进程日志均无 MaxListenersExceededWarning；一次性 PR61 已关闭且未合并。修复候选、自动测试和本轮 UAT 均已有完整证据，后续只进入 Workflow lifecycle 收尾。
