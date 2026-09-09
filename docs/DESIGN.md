# 考拉任务（Kaola Tasks）设计文档

> 版本：v0.8（2026-09-09）· 状态：草案；v0.8 增补：管理员批准绑定的私有 CA 自动配对（#63，§16.8 / [ADR 0031](decisions/0031-approval-bound-private-ca-pairing.md)）——认领者 `kaola-mcp pair --url <kaola-origin>`；客户端生成 ≥128-bit 一次性配对密语，只把 HMAC commitment 发到 bootstrap REST，密语本身只进管理员已受信工作台；批准证明绑定 instance/origin/device/root/nonces/owner/expiry；原子落地公开根后必须以一条全新严格 TLS 连接完成链/SAN/有效期与同设备 active `whoami` 才 ready。`kaola-mcp --url` 保持严格非交互，未配对返回 typed `pairing_required`。正常认领路径不接触 PEM、指纹、`NODE_EXTRA_CA_CERTS` 或 MCP 重启。编码与 test vectors 见 ADR，产品行为在设计冻结后实现。v0.7 增补：评审锚定核对（#54，§17.7）——`submissions` 记录 poller 每次拉取观察到的 forge 头（`forge_head_sha` / `forge_head_seen_at`）；`GET …/review` 暴露 `forge_head_sha` / `forge_head_seen_at` / `head_stale`，评审面板显示「forge 头已变化」；「通过」前用任务凭证实时读一次 `getPullRequest().head_sha`，与记录的 `head_sha` 不一致 → `409` `head_sha_stale`，记录为空则补齐后放行，forge 不可达时回退到最近观察值、仍未知则以 `head_verified: false` 放行并写入响应与 `评审通过` 事件；`submit_pr` / `submit_revision` 响应路径不出站，`submit_revision` 记录新头时清空观察值。v0.6 增补：评审循环（#53，§17）——代码事实在 forge、评审对话与协调在考拉；Agent 以 Draft PR 交付；新增中文规范状态 `待修改`（球在 Agent 手里、可认领）与 `待合并`（等 forge 合并），`已退回` 收窄为「PR 已关闭或交付被终止」；`submit_pr` 仅首次提交，修订经任意 Agent 认领 `待修改` 后以 `submit_revision` 交回同一 PR；新增 MCP 工具 `get_review_feedback` / `post_discussion_message` / `submit_revision` / `open_review_round`，`report_progress` 可带 `percent` / `phase`；六条评审 REST 与 `GET /api/v1/stream` SSE；`tasks.parent_task_id` 依赖子任务（堆叠基线、认领/通过门闩、父任务合并后自动 restack）；ForgeAdapter 新增 `markPullRequestReady` / `commentOnPullRequest`，`getPullRequest` 返回 `head_sha` / `draft` / `head_branch`。token 揭示通道不变。v0.5 增补：公网 HTTPS 为双模式合同 `DEBUG_PRIVATE_CA` / `STABLE_PUBLIC_CA`（DNS-01，不依赖入站 80）；`kaola-mcp` 保持严格 TLS 校验；仓库文档只用占位符，不写入真实主机名/端口/证书身份。同版另增补双模式 MCP 安装与证书信任（#48）——`STABLE_PUBLIC_CA` 公开 CA 默认路径严格系统信任、不装额外 CA、不设 `NODE_EXTRA_CA_CERTS`；`DEBUG_PRIVATE_CA` 测试路径每台纳管电脑都要信任同一份公开根证书：MCP 只通过进程级 `NODE_EXTRA_CA_CERTS`，系统/浏览器提权信任另一次显式授权。首次连接不得盲信服务器返回的 CA。服务端公网证书签发/续期由 #46 拥有（§12）；客户端安装与信任由 #48 拥有（§16 / §16.7）：package bin `kaola-mcp trust` 写入 `$KAOLA_HOME/trust/`（`root-ca.pem` + host-neutral `state.json`），`kaola-mcp --url` 只从已核验 state 注入额外 CA。v0.4：Claim MCP 完整生命周期以 Kaola Workflow 为默认工程协议、Kaola Project Runner 为用户显式选择的可选 carrier；兼容层单向归 Kaola Tasks，采用减法设计且不设置版本 hard gate。v0.3：管理员 ≠ 发布者——空库设置向导建 `local` 密码管理员；GitLab / Gitea OAuth 建发布者（可升级）；拿掉 GitHub 登录（适配器与发布表单的 GitHub 仓库仍在）。

---

## 1. 概述

**一句话定义：** 考拉任务是一个团队内部的中文任务协作平台。成员把编码任务发布到任务板上（手工创建，或从 GitHub / GitLab / Gitea 的 Issue 导入），并为任务附上 forge 访问令牌；其他成员的 Agent（Claude Code 等任意运行时）通过 MCP 认领任务、直接访问代码仓库完成实现，最终以 PR 的形式交付回目标 forge。平台全程跟踪任务闭环，直至 PR 合并。

**定位边界（最重要的一条）：** 考拉任务**只做路由与协调**，不做执行。Agent 运行在各自主人的运行时里，代码托管在团队既有的 forge 上。平台不跑 Agent、不托管代码、不做沙箱。

**使用场景：** 团队的代码分散在 GitHub、自托管 GitLab、自托管 Gitea 三种 forge 上。本平台为纯内部工具（inner circle），不对外开放、不做商业分发、无激励/赏金体系。

## 2. 决策记录

头脑风暴阶段已确认的决策：

| # | 决策项 | 结论 |
|---|--------|------|
| D1 | 激励模式 | 纯协调，无积分/赏金（内部工具） |
| D2 | Forge 支持 | GitHub / GitLab / Gitea 三者从第一天起走统一适配层 |
| D3 | 凭证模式 | 发布任务**强制**附带 token；Agent 认领后用该 token 直接访问 forge |
| D4 | 分发方式 | 仅内部部署，不对外分发 |
| D5 | 技术栈 | TypeScript 全栈：Vue 3 前端 + Node API + 官方 MCP TS SDK + Drizzle/SQLite |
| D6 | 登录方式 | 两条进工作台的路，不要混：设置向导创建的考拉用户名/密码（`provider: 'local'`，管理员）；已有管理员之后的 GitLab / Gitea OAuth（发布者，可被升级为管理员）。**没有 GitHub 登录**（GitHub 适配器与发布表单里的 GitHub 仓库仍在） |
| D7 | Token 附着方式 | 凭证档案（Credential Profile）复用为主，允许单任务临时 token 覆盖 |
| D8 | 登录与权限分级 | `permission_level`：`admin`（管理员） / `full`（发布者） / 遗留 `claim_only`（不再新建）。空库（无可登录管理员）只许设置向导；OAuth 不得抢权。已有管理员后，GitLab / Gitea 登录一律建 `active`+`full` 发布者（无 `uninvited`）。管理员可把发布者升级为 `admin`。`KAOLA_ADMINS` 忽略、不炸 boot。认领者不是 Web 账号。Agent 鉴权为本机设备证明，不是自助 Agent Key |
| D9 | 评审讨论的落点（#53） | **代码事实在 forge，评审对话与协调在考拉。** forge 上放 Draft PR、commits、CI、diff、最终合并；考拉放多轮意见、判定、阻塞项、「球在谁手里」。考拉不渲染 diff、不做行级评论，消息只携带跳转 forge 的代码锚点链接。这是对 §5「验收在 forge 上完成」的明确改向：验收**判定**在考拉，代码**合并**仍在 forge |
| D10 | PR 形态（#53） | Agent 一开始就开 **Draft PR**（GitHub draft / GitLab `Draft:` / Gitea `WIP:`）。评审期间 forge 上安静无评论；考拉里「通过」时由服务端用任务凭证把 Draft 翻 ready；真人在 forge 点合并 |
| D11 | 轮次（#53） | 评审者攒够意见后显式点一次「提交本轮意见」才翻状态；Agent 改完显式调一次 `submit_revision` 交回。任何一条消息本身不翻状态。一轮评审 = Workflow 里一个新的 recoverable outcome |
| D12 | 修订归属（#53） | `submit_pr` / `submit_revision` **仍释放租约**。`待修改` 是一个新的可认领态：任何 Agent 都可以 `claim_task` 认领它做修订，不绑定原 Agent |
| D13 | 依赖子任务（#53） | `tasks` 增加 `parent_task_id`。子任务的基线分支是父任务 PR 的 head 分支（堆叠）。**父任务进入 `待验收` 后子任务即可认领**；子任务的「通过」要等父任务 `已完成`。子任务 Agent 发现父任务问题时可对父任务开一轮意见，把父任务打回 `待修改` |
| D14 | 冲突与 rebase（#53） | 考拉不解冲突，认领的 Agent 解。父任务合并后，考拉自动给子任务追加一轮 `restack` 意见，由下一个认领它的 Agent rebase 到新基线并解冲突 |
| D15 | Agent 感知（#53） | 保持 pull 模型。Agent 自行轮询 `list_tasks(status=待修改)`；`report_progress` 心跳携带 `percent` / `phase`。考拉不向已下线的 Agent 推送 |
| D16 | 人的感知（#53） | 服务端提供 SSE 流，Web 看板与评审面板实时刷新，不用手工刷新 |
| D17 | 合并（#53） | 保留给 forge 上的真人。考拉不用任务 token approve 或 merge（token 身份是发布者/bot，会让 forge 审计失真） |
| D18 | 私有 CA 认领端配对（#63） | 通用认领端不走手工 `trust install`。私有 CA 第一次用 `kaola-mcp pair --url`：客户端高熵一次性密语不经未受信 bootstrap 传输；管理员在受信工作台录入密语并选择 owner；客户端核验批准证明后才原子安装公开根，并以全新严格 TLS + active `whoami` 就绪。`kaola-mcp --url` 不在 MCP host 内等待批准。配对 attempt 从该次申请起至少 24 小时（TTL 默认/下限 86400，到 `expires_at` 才过期）；批准后设备授权默认 **90** 天（`paired_at + device_max_age_days`）。#48 的 v1 手工 trust 仍是显式兼容/恢复路径，不伪装成 approval-bound state。公开 CA 不安装额外根。不新增 MCP 工具，不改变 Claim/Lease 或 token 揭示通道 |

## 3. 角色与核心概念

- **管理员（人）**：设置向导创建的考拉用户名/密码（`provider: 'local'`），或 GitLab / Gitea 发布者被升级后仍走原 OAuth（`permission_level: admin`）。管实例：电脑绑定/解除（含 `bind_to_self`）、认领者、把发布者升为管理员。**兼顾发布**：可绑仓库 PAT、发任务。不是认领者；不另开第二个密码管理员。
- **发布者（人）**：只留 GitLab / Gitea OAuth（`permission_level: full`）。登录后绑仓库 PAT，导入/发布任务卡；看看板与审计。不管实例、不升级别人、**不绑/解除任何电脑**（含不能 `bind_to_self`）。凭证档案仍是团队共享，不按 OAuth 来源硬限制 forge 种类。
- **认领者（命名身份）**：独立于 `users` 的认领身份，**没有 Web 登录**，不能进工作台。由管理员在绑定待授权电脑时命名。不是 OAuth 账号，也不是 `claim_only` 网页用户。
- **Agent**：任意 MCP 兼容运行时。经本机 stdio 桥以设备证明调用考拉 MCP，获取任务、汇报进度、提交 PR 链接。实际的 clone / 编码 / push / 开 PR 都由 Agent 用揭示的 forge token 直接对 forge 完成。
- **任务卡（Task Brief）**：结构化、机器可读的任务契约（见 §6），是平台相对"裸 Issue"的核心增值。
- **租约（Lease）**：认领即租约，带 TTL 与心跳，防止任务被挂死占用。绑定电脑本身不认领任务。

## 4. 系统架构

```mermaid
flowchart LR
  subgraph client["使用侧"]
    U["团队成员（浏览器）"]
    A["Agent（Claude Code 等）"]
  end
  subgraph kaola["考拉任务（内部部署）"]
    W["Web 前端（Vue 3）"]
    M["MCP Server"]
    S["API Server（Fastify）"]
    V["Token Vault（加密存储）"]
    F["ForgeAdapter 层"]
    D[("SQLite（Drizzle）")]
  end
  subgraph forges["团队 Forge"]
    GH["GitHub"]
    GL["GitLab（自托管）"]
    GT["Gitea（自托管）"]
  end
  U --> W --> S
  A -->|"MCP 工具调用"| M --> S
  S --> D
  S --> V
  S --> F
  F -->|"校验 token / 导入 Issue / 回写评论"| GH & GL & GT
  GH & GL & GT -->|"Webhook（轮询兜底）"| S
  A -.->|"clone / push / PR（使用认领时揭示的 token）"| GH & GL & GT
```

组件职责：

1. **Web 前端（中文界面）** — 零管理员时为设置向导；有管理员后为直接登录 + GitLab / Gitea（无 GitHub 按钮）。工作台：任务看板、任务详情、发布向导、凭证档案、审计日志。电脑/认领者/升级入口仅管理员。认领者不能登录工作台。
2. **API Server** — 任务生命周期状态机、租约管理、认证鉴权、审计记录。REST 全量镜像 MCP 能力，供非 MCP 运行时或脚本使用。
3. **MCP Server** — Agent 的入口（见 §9）。服务端仍是 Streamable HTTP；本机 `kaola-mcp` 用设备私钥签名后转发。配置一次 stdio `command` + 考拉 URL，之后一句"去考拉接单"即可。身份不是自助 Agent Key Bearer。
4. **ForgeAdapter 层** — 统一接口、三份实现（见 §8）。GitLab / Gitea 均支持自定义 base URL（自托管）。
5. **Token Vault** — 凭证加密存储与"认领时揭示"机制（见 §7）。
6. **同步机制** — Webhook 优先，轮询兜底（自托管 forge 在内网/防火墙后时 webhook 可能打不进来，需可配置）。

## 5. 任务生命周期

```mermaid
stateDiagram-v2
    [*] --> 待认领: 发布/导入（token 校验通过）
    待认领 --> 进行中: claim_task（揭示 token，建立租约）
    进行中 --> 待认领: 租约过期 / release_task（任务尚无提交）
    进行中 --> 待修改: 租约过期 / release_task（任务已有提交，即修订中途放弃）
    进行中 --> 待验收: submit_pr（首次，Draft PR，记录 head_sha）/ submit_revision（修订交回）
    待验收 --> 待修改: 评审者「提交本轮意见」且含阻塞项 / 子任务 open_review_round / 父任务已完成触发 restack
    待修改 --> 进行中: 任意 Agent claim_task（修订 Claim）
    待验收 --> 待合并: 评审者「通过」（子任务需父任务已完成）；服务端把 Draft 翻 ready
    待合并 --> 待修改: 评审者「撤回通过」
    待合并 --> 已完成: forge 上合并（webhook/轮询检测 merged）
    待验收 --> 已退回: PR 被关闭 / 评审者「终止本次交付」
    待修改 --> 已退回: PR 被关闭 / 评审者「终止本次交付」
    待合并 --> 已退回: PR 被关闭 / 评审者「终止本次交付」
    待修改 --> 已取消: 发布者取消
    已退回 --> 待认领: 发布者重新开放
    待认领 --> 已取消: 发布者取消
    已退回 --> 已取消: 发布者取消
    已完成 --> [*]
    已取消 --> [*]
```

中文规范值恰好八个：`待认领`、`进行中`、`待验收`、`待修改`、`待合并`、`已完成`、`已退回`、`已取消`（#53 新增 `待修改`、`待合并`）。合法边（`transitionTaskStatus`，与上图逐条对应）：

| from | to |
|------|----|
| `待认领` | `进行中`、`已取消` |
| `进行中` | `待认领`（尚无提交）、`待修改`（已有提交）、`待验收` |
| `待验收` | `待修改`、`待合并`、`已退回` |
| `待修改` | `进行中`、`已退回`、`已取消` |
| `待合并` | `待修改`、`已完成`、`已退回` |
| `已退回` | `待认领`、`已取消` |

看板列语义：`待验收` 球在评审者手里；`待修改` 球在 Agent 手里（可认领）；`待合并` 等 forge 合并。**`已退回` 语义收窄**为「PR 已关闭或交付被终止」，不再表示「需要修改」——需要修改是 `待修改`。`待验收 → 已完成` 这条旧边不再存在：合并前必须先经考拉「通过」进入 `待合并`。

规则：

- **发布即校验**：任务发布/导入时，适配层用所附 token 实测权限（能否读仓库、能否推分支、能否创建 PR）。token 失效或权限不足的任务不会出现在看板上。
- **认领即租约**：默认 TTL 建议 24h（可按任务配置）。Agent 通过 `report_progress` 心跳续约；租约过期自动回到"待认领"，只撤销 Kaola Tasks 自身的生命周期权威与 Claim 锁定——揭示的 forge 凭证是可复用的仓库凭证，不因租约过期或释放而被吊销（措辞修正与 per-Claim 铸造/吊销的非目标见 §15「凭证语义」）。
- **验收判定在考拉，合并在 forge**（D9，#53 改向）：Agent 以 Draft PR 交付（`submit_pr` → `待验收`）；评审者在考拉的任务评审面板里写多轮意见并显式「提交本轮意见」（含阻塞项则 `待验收 → 待修改`）或「通过」（`待验收 → 待合并`，服务端用任务凭证把 Draft 翻 ready）；真人在 forge 合并，poller / webhook 检测 merged 后 `待合并 → 已完成`。`待修改` 可被任意 Agent 认领做修订，改完 `submit_revision` 交回同一 PR。考拉不渲染 diff、不做行级评论、不 approve、不 merge。导入型任务仍把认领 / 提交 PR / 完成以评论形式回写到源 Issue。细则见 §17。
- **一任务一 PR，forward-only**：`submit_revision` 校验 `pr_url` 与首次提交一致（canonical 相等）；不开第二个 PR。

## 6. 任务卡（Task Brief）Schema

发布表单与 Agent 拿到的 JSON 是同一份契约（Agent 侧不含 token，token 走认领揭示通道）：

```jsonc
{
  "id": "kt-2026-0142",
  "title": "为订单导出接口增加分页",
  "description_md": "……（Markdown 详述）",
  "source": {                        // native 或 imported
    "type": "imported",
    "issue_url": "https://gitea.internal.example/team/orders/issues/87"
  },
  "repo": {
    "forge": "gitea",                // github | gitlab | gitea
    "base_url": "https://gitea.internal.example",
    "full_name": "team/orders",
    "base_branch": "main",
    "suggested_dir": "orders"      // 建议的本地克隆目录名（Agent 可覆盖）
  },
  "acceptance_criteria": [           // 验收标准，逐条可核对
    "GET /api/orders/export 支持 page/page_size 参数",
    "新增单元测试覆盖分页边界"
  ],
  "test_command": "pnpm test",
  "constraints": {
    "allowed_paths": ["src/api/**", "tests/**"],
    "forbidden_paths": ["migrations/**"]
  },
  "pr_convention": {
    "branch_prefix": "kaola/kt-2026-0142-",
    "title_prefix": "[kt-2026-0142] ",
    "draft": true                     // #53：以 Draft PR（GitHub draft / GitLab Draft: / Gitea WIP:）交付
  },
  "parent_task_id": null,            // #53：依赖子任务时为父任务的 id（kt-…），否则 null
  "review_round": 0,                 // #53：当前评审轮次；> 0 表示认领到的是修订 Claim
  "credential": { "profile_id": "cp-gitea-orders" },  // 二选一，见下方说明
  "priority": "P1",
  "tags": ["backend", "api"],
  "poster": "zhang.wei",
  "status": "待认领",
  "created_at": "2026-08-20T12:00:00+08:00"
}
```

**`id` 形式**：`kt-<年份>-<四位序号>`（如 `kt-2026-0142`），全局唯一且可读；`pr_convention` 的分支前缀与标题前缀由它派生。平台内部另有自增主键，不对外暴露。

**#53 增补键**：`pr_convention.draft` 恒为 `true`（提示 Agent 以 Draft 形态开 PR）；`parent_task_id` 可空（子任务指向父任务的 `id`）；`review_round` 为当前轮次整数（0 = 尚未开轮）。子任务的 `repo.base_branch` 由服务端派生：父任务处于 `待验收` / `待修改` / `待合并` 时 = 父任务 PR 的 head 分支（堆叠）；父任务 `已完成` 后 = 父任务自己的 `base_branch`；父任务尚未提交时保留发布时的值。其余键不变；仍不含 token。

**`credential` 是引用，不是 token 本身**，两种形态二选一：

| 形态 | 含义 |
|------|------|
| `{ "profile_id": "cp-gitea-orders" }` | 引用团队共享的凭证档案（§7） |
| `{ "inline": true }` | 该任务附带单任务临时 token，密文随任务存储 |

两种形态下任务卡都**不含 token 明文**——`inline` 只声明"有一份专属凭证在等着"，不携带任何凭证内容；两者都只在 `claim_task` 成功时经揭示通道下发。

### 发布向导

Web「发布」页的收集规则（HTTP 仍是现有 `POST /api/v1/tasks` / `POST /api/v1/tasks/import`；§6 键集不变，JSON 示例里的 `acceptance_criteria` / `test_command` / `constraints` / `priority` / `tags` 仍属于 Task Brief）：

- **主路径（来源 = 从 Issue 导入）**：选档案 → 选 Issue → 「导入」仍 `POST /api/v1/tasks/import`（不落库、不做发布即校验）。导入成功后**不**展示可编辑的标题/描述输入，改为只读 Issue 卡片：标题为纯文本（不是 input）；`description_md` 以 Markdown 渲染**或**等宽/纯文本预览（当前前端无 Markdown 库，二者均可）；`source.issue_url` 可点击。卡片保留到再次导入或改选另一条 Issue；导入成功前不展示空卡片。「发布」仍 `POST /api/v1/tasks`，请求的 `title` / `description_md` / `source` / `repo` / `credential` 来自导入结果与所选档案（人不能改标题/正文）。
- **不再收集或展示**：验收标准、测试命令、允许路径、禁止路径、优先级、标签。发布请求**省略**这些键；服务端缺省仍为 `acceptance_criteria` `[]`、`test_command` `''`、`constraints` `{ allowed_paths: [], forbidden_paths: [] }`、`priority` `'P2'`、`tags` `[]`。
- **平台自有（来源 = 自有）**：标题与描述仍可编辑（没有可拷贝的 Issue）。上述附加字段同样不收集、不展示，POST 同样省略。
- **回退**：内联 token + 粘贴 Issue URL 仍可导入；成功后同样是只读卡片，不会回到可编辑标题/正文。

## 7. 凭证与安全模型

内部工具不等于不设防——token 会离开平台进入 Agent 侧，纪律要靠平台保证：

- **凭证档案（Credential Profile）**：按"forge + 仓库"维度存储可复用 token，团队连接一次、发布任务时下拉选择；也允许发布者为某个任务粘贴一次性 token（覆盖档案）。钥匙页存好档案之后，发布页的仓库选择**就是**该下拉（选项文案 `{forge} {repo_full_name}`）：选中一行即选定该行的 `forge` / `base_url` / `repo_full_name`，不再手填这三项（平台自有任务与从 Issue 导入都如此；标题/描述在平台自有时仍手填）。
- **从档案列 Issue**：来源 = 从 Issue 导入、凭证 = 共享档案时，选中档案后再加载该仓库的 **open** Issue 下拉（选项 `#{number} {title}`）。人选 Issue **不**自动导入；点「导入」仍走现有 `POST /api/v1/tasks/import`（不落库、不做发布即校验），成功后填入只读 Issue 副本（标题/正文不是可编辑 input，见 §6「发布向导」）；人核对后再点「发布」，仍走现有 `POST /api/v1/tasks`。无档案时仓库下拉为空，提示先去钥匙页添加，**不**请求 Issue 列表。`POST /import` 与 `POST /tasks` 的请求体契约不变（§6 Task Brief 也不变）；UI 只负责把档案行和下拉选中的 `issue_url` 填进现有字段。
- **单任务临时 token（回退）**：该路径没有档案可列 Issue，仍可贴 Issue URL + 手填仓库。不要删这条能力。
- **推荐 token 类型**：GitHub fine-grained PAT（限定单仓库）、GitLab Project Access Token、Gitea 仓库级 scoped token——三者都天然按仓库隔离。
- **加密存储**：AES-256-GCM，主密钥来自环境变量/密钥文件，不入库、不入代码。
- **认领时揭示（reveal-on-claim）**：token 只在 REST `POST /api/v1/tasks/:publicId/claim` `201` 与 MCP `claim_task` 成功时下发给认领 Agent；`list_tasks` / `get_task_brief` / 会话 GET 列表与详情 / `POST /api/v1/tasks/import` `200` 永不含 token。`GET /api/v1/credential-profiles/:id/issues` 是服务端解密后列 Issue（同轮询），**不是**第三条揭示通道：响应、日志、`events.details` 不得出现 token / ciphertext / `access_token`，也**不写** `token 揭示`（对比：现有 import 档案路径在解密后仍写 `token 揭示`，本路由不要照抄）。
- **两类凭证，互不混用**：
  - **考拉设备证明**：每台机器一把 Ed25519 密钥。私钥只在该机 `~/.kaola/`（目录 `0700`、私钥文件 `0600`），**永不**写入 mcp.json，也**不是** forge PAT。服务端只存公钥与指纹。MCP/REST 认领路径用带签名的设备请求，不再用可复制的 Bearer `ktk_`。
  - **Forge token**：仍只在 REST `POST /api/v1/tasks/:publicId/claim` `201` 顶层 `token` 与 MCP `claim_task` 成功顶层 `token` 揭示（见上条「认领时揭示」）。两条通道以外的会话 GET、import `200`、档案列 Issue、设备待授权 `202`、#16 `confirmation_required` `202` 均不含 forge token。
- **MCP 平时无仓库钥匙（用户模型）**：Cursor MCP 配置平时**不含**仓库 / forge token，也不含「这条任务的钥匙」，**也不含**考拉设备私钥或 `ktk_…` / `KAOLA_AGENT_KEY`。认领者不生成仓库钥匙，也不需要在 GitLab/GitHub 上有该仓账号。Agent 对某条任务调用 `claim_task` **成功之后**（REST claim `201` 同此），才从**该任务**拿到 forge token（信封顶层 `token`）以及 `clone`。换一个 `task_id` / `publicId` 拿到的是那条任务自己的 token，禁止把上一把写进 MCP 或 git remote 接着用。仓库内提交的 MCP 示例是 stdio `command` + `--url`，不含任何 secret：

  ```json
  {
    "mcpServers": {
      "kaola-tasks": {
        "command": "kaola-mcp",
        "args": ["--url", "http://localhost:31415"]
      }
    }
  }
  ```

  **forge token 不得出现在任何 mcp.json**。人手不必按任务改 mcp.json。MCP 身份不再是 Agent Key Bearer。`--url` 为 `https://…` 时，`kaola-mcp` 保持严格 TLS 校验（Node/undici 运行时默认信任库，见 §16）。禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0`、`--insecure`、`curl -k`、在源码里跳过证书验证、或把浏览器证书例外当作成功路径。`STABLE_PUBLIC_CA` 入口不设置 `NODE_EXTRA_CA_CERTS`、不安装额外 CA，也不得把额外 CA 当作干净机器的默认方案。`DEBUG_PRIVATE_CA` 认领端默认走 §16.8 管理员批准绑定自动配对（`kaola-mcp pair --url`），正常路径不手工处理 PEM、指纹、`NODE_EXTRA_CA_CERTS` 或重启；`kaola-mcp --url` 在尚未配对时返回 typed `pairing_required` 并退出，不在 MCP host 内等待。操作者仍可用 #48 的 `kaola-mcp trust install` 作为显式 v1 兼容/恢复路径。配对 bootstrap 只允许 `pair` 使用范围受限的未建立 PKI 信任连接（只打 pairing REST，不设进程全局 `NODE_TLS_REJECT_UNAUTHORIZED=0`，不提供可复用 `--insecure`），根仍须在批准证明与全新严格重连通过之后才落地。环境值和本机路径不得进入仓库共享配置。不得分发根私钥。仓库里提交的 MCP 示例仍只有 `command` + `--url`，不含 `NODE_EXTRA_CA_CERTS`、PEM、指纹或任何私钥。
- **未配对设备**：签名合法但尚未绑定 → HTTP `202` `{ error: 'authorization_required', pending: true, expires_at }`（待授权窗口 1 天），**不**下发 forge token、不建立租约。与 Issue #16 的 `202` `{ error: 'confirmation_required' }` 字符串不同：前者在身份钩子、电脑尚未授权；后者是已授权设备上自主认领等人确认。待授权设备不能 `list_tasks` / `claim_task`。绑定不自动认领、不推送 forge token。§16.8 新 pairing attempt 从该次申请起另计至少 24 小时；若剩余 pending 更短，把 `pending_expires_at` 延长到 pairing `expires_at`，幂等恢复不滑动。批准后电脑授权默认 90 天，与该 pairing 窗口独立。存量 `device_max_age_days = 30` 无法区分旧默认与用户配置，保留不猜迁；已有 `devices.expires_at` 不重写。
- **解除立即生效**：解除认领者或解除电脑、将 `users.status` 置为 `revoked`，均在**下一次**请求生效。重新登录不得复活 `revoked`。
- **认领即授权（MVP）**：已绑定的设备即该认领身份（或绑到管理员自己时的 `full` 用户）的授权——人明确指示 Agent 认领时无需二次确认；"人确认认领"开关只针对绑到 Web 用户、且开启自主轮询的 Agent（M3，Issue #16）。待授权设备不能认领（见上）。
- **Agent 侧 token 卫生**：REST 认领 `201` 与 MCP `claim_task` 成功共用同一信封；揭示通道仍只有这两处的顶层 `token`。`clone` 恰四键：`suggested_dir`（同 `task.repo.suggested_dir`，相对目录名，不是绝对路径，也不是「在此打开 Cursor」）、`token_usage`（原文：`token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。`）、`remote_url`（HTTPS git remote，**不含**用户名/密码/token：去掉 `repo.base_url` 末尾斜杠 + `/` + `repo.full_name` + `.git`；GitLab 子组 `full_name` 保留斜杠，如 `https://host/group/subgroup/app.git`；不要用 GitLab API 的 `%2F` 项目路径，也不要用 `api.github.com`）、`extra_header`（`{ "name": string, "value_pattern": string }`；`value_pattern` 含字面量 `${token}`，**不得**嵌入已揭示的 forge token）。Agent 把顶层 `token` 代入 `value_pattern`，等价于 `git -c http.extraHeader="<name>: <value>" clone <remote_url> <suggested_dir>`。token 仍走环境变量或 `git -c http.extraHeader` 按次传递，**不要**拼进 remote URL（会落盘到 `.git/config` 并在任务结束后残留）。不新增 MCP 工具；服务端不执行 git；§6 `repo` 仍五字段；`list_tasks` / `get_task_brief` / 会话 GET 永不带 `clone` 附加键或 token；`202` `confirmation_required` 仍无 `clone`/token。三家 `extra_header`：

  | forge | `name` | `value_pattern` |
  |-------|--------|-----------------|
  | github | Authorization | Bearer ${token} |
  | gitlab | Authorization | Bearer ${token} |
  | gitea | Authorization | token ${token} |

- **全量审计**：每次揭示记录哪台电脑、何时、拿走了哪个档案的 token（认领者为 `claimant` 时无 `users` 行）；档案页提供一键吊销（删除档案 + 提示去 forge 侧撤销）。
- **在用凭证不可删**：被 `待认领`/`进行中`/`待验收`/`待修改`/`待合并`/`已退回` 任一非终态任务引用的凭证档案不能删除（`DELETE` 返回 `409` `credential_profile_in_use`）；只有任务已终态（已完成/已取消）或无引用时才能删——这样一个仍在进行的 Claim 永远能重新解密出它认领时拿到的同一份凭证（#36）。
- **无账号认领者（token 即访问权）**：认领者**不需要**在目标 forge 上有账号。Agent 用揭示的顶层 `token` 按 `clone` 四键克隆：目录 `clone.suggested_dir`，远端 `clone.remote_url`（无凭证的 HTTPS git URL），请求头按 `clone.extra_header`（见上表）把 token 代入 `value_pattern` 后走 `git -c http.extraHeader`，再向**同一仓库**推分支（不走 fork——fork 才需要账号）、再用同一 token 调 API 开 PR/MR。因此发布校验必须包含"能否推分支"。身份归属：PR 显示的是 token 所属身份（发布者或项目 bot），但 commit author 可自由设置为认领者姓名/邮箱（无需账号），PR 描述底部附"claimed by @认领者 via Kaola Tasks"，考拉侧审计日志保存真实认领记录。推荐用 GitLab Project Access Token（Developer 角色，`api` + `write_repository`）/ Gitea 仓库 token / GitHub fine-grained PAT 实现此模式。

  见上表。
- **提示注入提醒**：任务描述是进入 Agent 上下文的非受信文本。即使是内部平台，导入的 Issue 正文也可能包含外部人写的内容，UI 对导入内容打来源标记，默认保留"人确认认领"这一道闸。

## 8. ForgeAdapter 层

```ts
interface ForgeAdapter {
  readonly kind: 'github' | 'gitlab' | 'gitea'

  // 发布/导入时
  validateToken(cred: Credential, repo: RepoRef): Promise<TokenCheck>   // 可读？可开 PR？
  importIssue(cred: Credential, issueUrl: string): Promise<ImportedIssue>
  listIssues(cred: Credential, repo: RepoRef): Promise<ListedIssue[]>

  // 状态闭环
  getPullRequest(cred: Credential, prUrl: string): Promise<PrStatus>    // #53：{ state, head_sha, draft, head_branch }
  registerWebhook?(cred: Credential, repo: RepoRef, callback: string): Promise<void>
  parseWebhook(headers: Headers, body: unknown): ForgeEvent | null

  // 回写
  commentOnIssue(cred: Credential, issueRef: IssueRef, body: string): Promise<void>
  listIssueComments(cred: Credential, issueRef: IssueRef): Promise<string[]>

  // #53 评审循环：只在「通过」时使用
  markPullRequestReady(cred: Credential, prUrl: string): Promise<void>   // Draft → ready
  commentOnPullRequest(cred: Credential, prUrl: string, body: string): Promise<void>
}

type ListedIssue = { number: number; title: string; issue_url: string }
type PrStatus = { state: 'open' | 'merged' | 'closed'; head_sha: string; draft: boolean; head_branch: string }
```

`listIssues` 行为（三份实现相同，纳入同一套共享 spec）：

- 只列 **open** Issue；最多 50 条。厂商查询参数若支持排序，传其 created/updated 降序；否则保持响应顺序，不要在适配层发明无法用桩响应钉死的二次排序。
- GitHub 的 issues API 会夹带 PR：丢掉带 `pull_request` 键的项（过滤后仍不超过 50 条真 Issue）。
- `issue_url` **由适配层按 `repo.base_url` 拼出**，必须能被现有 `parseIssueUrl(kind, issue_url)` 解析：
  - GitHub / Gitea：`{base_url}/{full_name}/issues/{number}`
  - GitLab：`{base_url}/{namespace}/-/issues/{iid}`（用 `iid`）。**禁止**原样返回 GitLab JSON `web_url`（新 UI 常是 `/-/work_items/N`，`parseIssueUrl` 不认）。
- 拉列表的 HTTP 源遵循 `importIssue` / `getPullRequest`：GitHub → `api.github.com`；GitLab / Gitea → 构造函数 `baseUrl`。用 `repo.full_name` 拼 API 路径。禁止拿 Issue / `web_url` 的 host 当 fetch origin，也不走 `validateToken` 的 `options?.baseUrl ?? repo.base_url` 回退。
- 非 OK / 网络失败：像 `importIssue` 一样 throw（`listIssues: ${kind} responded ${status}`），由 HTTP 层映射。适配层本身不映射 HTTP 状态码。

对应 HTTP（会话；门闩与档案 CRUD 相同：`active` + `full`，否则 `403` `{ error: 'forbidden' }`；未登录与 `GET /api/v1/me` 同一套 401/302）：

`GET /api/v1/credential-profiles/:id/issues`

用该档案行的 forge / base_url / repo_full_name 解密后调 `listIssues`。`200` `{ issues: [{ number, title, issue_url }] }`。缺行或非正整数 id → `404` `{ error: 'not_found' }`。`VAULT_MASTER_KEY` 缺失或非法 → `500` `{ error: 'vault_unconfigured' }`。forge HTTP 401 → `422` `{ error: 'token_check_failed', missing: ['读'], message: 'token 无效或无权读取该 Issue。' }`（与 import 同源文案）。其它非 OK 或网络失败 → `502` `{ error: 'forge_unreachable', message: '无法连接 forge 列出 Issue。' }`（并列于 import 的「无法连接 forge 导入 Issue。」，不要共用那一句）。列表路由没有「单条 Issue 找不到」语义，不要把 import 的 404/410 → `issue_not_found` 套过来。

`markPullRequestReady` / `commentOnPullRequest` 行为（#53，三份实现相同，纳入同一套共享 spec）：

- `markPullRequestReady`：GitHub 走 GraphQL `markPullRequestReadyForReview`（REST 不支持；先 REST 读 PR 取 `node_id`）；GitLab `PUT /projects/:id/merge_requests/:iid` 去掉标题 `Draft:` / `WIP:` 前缀；Gitea `PATCH /repos/:owner/:repo/pulls/:index` 去掉标题 `WIP:` 前缀。已经 ready 的 PR 幂等成功。非 OK 抛 `markPullRequestReady: ${kind} responded ${status}`。
- `commentOnPullRequest`：GitHub / Gitea 走 issue comments 端点（PR 编号即 issue 编号）；GitLab 走 MR `notes`。非 OK 抛 `commentOnPullRequest: ${kind} responded ${status}`。
- 两者的 host / 超时规则与 `getPullRequest` / `commentOnIssue` 相同（GitHub → `api.github.com`；GitLab / Gitea → 构造函数 `baseUrl`；#37 `timeoutMs`）。
- `getPullRequest` 扩展返回 `head_sha`（GitHub / Gitea `head.sha`，GitLab `sha`）、`draft`（GitHub `draft`；GitLab `draft` / `work_in_progress`；Gitea 标题 `WIP:` 前缀）、`head_branch`（GitHub / Gitea `head.ref`，GitLab `source_branch`）。
- `parseWebhook` 不在 #53 扩展非终态事件。

要点：

- 三份实现放在 `packages/forge-adapters`，共享一套集成测试规格（同一组行为断言跑三个后端；`listIssues`、`markPullRequestReady`、`commentOnPullRequest` 计入该套规格）。
- GitLab / Gitea 构造时接收 `baseUrl`；GitHub 固定 api.github.com（如未来有 GHE 也只是多一个 baseUrl）。
- Webhook 打不进来的实例（内网 Gitea 等）配置为轮询模式：对"待验收"任务定时查 PR 状态即可，量小、代价低。

## 9. MCP 工具面

服务端 MCP 仍是 Streamable HTTP `POST /api/mcp`。鉴权是本机设备证明（stdio 桥 `kaola-mcp` 签名转发），**不是** Web 自助生成的 Agent Key Bearer。待授权设备在钩子层即 `202` `authorization_required`，不能列出或认领任务。`claim_task` 成功顶层信封仍是任务卡 + 顶层 **揭示 token** + 租约 + `clone` 四键；租约新增 `claim_id`（#36，从该 lease 行不可变字段派生的公开编码，不新建表、不落库）。`report_progress` / `release_task` / MCP-only `submit_pr` 随附 `claim_id`，与设备一起做双重锁定（#31）。

| 工具 | 参数 | 行为 |
|------|------|------|
| `list_tasks` | `status?` `tags?` `forge?` | 列出任务（不含 token）；待授权设备不可用。`status` 可为 `待修改`（可认领的修订任务）；每张任务卡带 `parent_task_id`、`review_round`（#53） |
| `get_task_brief` | `task_id` | 返回 §6 的完整 JSON（不含 token） |
| `claim_task` | `task_id` `autonomous?` `request_id?` | 建立租约；返回任务卡 + **揭示 token** + 租约（含 `claim_id`、TTL）+ `clone` 四键（`suggested_dir`、`token_usage`、`remote_url`、`extra_header`）。已绑定设备即授权，无需二次确认（自主轮询场景见 M3；#16 仅绑到 Web 用户的路径）。同一 `(device, request_id)` 重放幂等返回同一 Claim，摘要（任务、`autonomous`）不一致时是 `claim_request_conflict`（#36）。**#53**：允许认领 `待修改` 任务（修订 Claim，信封不变；任务卡 `review_round` > 0 即表示修订）。对子任务：父任务未到 `待验收` / `待修改` / `待合并` / `已完成` 时 `409` `parent_not_ready` |
| `report_progress` | `task_id` `note` `claim_id?` `percent?` `phase?` | 心跳续约 + 进度记录（展示在任务详情时间线）；曾带 `request_id` 的新式 Claim 必须附 `claim_id`，遗留 Claim 可省（#31）。**#53**：可选 `percent`（0–100 整数，越界 `400` `invalid_body`）、`phase`（短文本）；省略时行为与以前完全一致 |
| `submit_pr` | `task_id` `pr_url` `summary` `claim_id?` `head_sha?` `head_branch?` | **一次交付的首次提交**（#53）：提交 Draft PR，任务转"待验收"，记录 `head_sha` / `head_branch`（省略时由 poller 首次拉取补齐；webhook 模式的实例不轮询，子任务要堆叠时 Agent 应传 `head_branch`）与 `is_draft`；`已退回` 后被发布者重新开放的任务可用新 PR 再次 `submit_pr`；`pr_url` 须能解析且属于该任务仓库，同一 Claim + 同一 URL 重复提交幂等（#31）。任务已有 `submissions` 行时 `409` `use_submit_revision` |
| `release_task` | `task_id` `reason` `claim_id?` | 主动放弃；任务尚无提交时回"待认领"，已有提交时回"待修改"（#53）；同一 Claim 重复释放幂等（#31） |
| `submit_revision` | `task_id` `claim_id` `pr_url` `head_sha` `summary` | **#53 新增**。修订交回：校验 `pr_url` 与首次提交一致（canonical 相等，否则 `422` `pr_url_invalid`）、`head_sha` 与上一轮不同（否则 `409` `head_sha_unchanged`）；写 `submission_revisions`、`review_rounds.revised_at`，`进行中 → 待验收`；释放租约。同一 Claim 同一 `head_sha` 重复调用幂等 `200`。返回 `{ task, pr_url, head_sha, round }`，不含 token。**#54**：记录新 `head_sha` 时同时清空 `submissions.forge_head_sha` / `forge_head_seen_at`（旧观察值不得把新交回误判为 stale）；响应路径不核对 forge，核对由 poller 下一次拉取与「通过」承担（§17.7） |
| `get_review_feedback` | `task_id` `round?` | **#53 新增**。只读，不需要 Claim，不含 token（不是第三条揭示通道）。返回 Review Brief（见下）；`round` 省略 = 当前轮；尚未开轮时 `round` 为 0、`verdict` 为 `null`、列表为空 |
| `post_discussion_message` | `task_id` `claim_id` `body_md` `kind` `reply_to?` `resolves?` `anchor?` | **#53 新增**。需要该任务的活动 Claim（无活动 Claim 或 `claim_id` 不匹配 → `409` `stale_claim`）。`kind` ∈ `blocking` / `suggestion` / `question` / `answer` / `note` / `resolution`；`resolves` 指向本任务的一条 `blocking` 消息 id，`kind=resolution` 时把它标为已解决。返回写入的消息，不含 token |
| `open_review_round` | `task_id` `claim_id` `items[]` | **#53 新增**。`task_id` 是**父任务**，`claim_id` 是调用者在**子任务**上的活动 Claim（该 Claim 的任务 `parent_task_id` 必须等于 `task_id`，否则 `403` `forbidden`）。`items[]` 每项 `{ kind, body_md, anchor? }`。父任务处于 `待验收` 时转 `待修改`，`review_rounds.kind = downstream_finding`，`opened_by_task_id` = 子任务；处于其他状态时只追加消息不翻状态 |

所有 #53 新增响应不含 token。**Review Brief**（`get_review_feedback` 返回值，REST `GET …/review` 的 `current` 同形）：

```jsonc
{
  "task_id": "kt-2026-0142",
  "pr_url": "…",
  "round": 2,
  "kind": "review",                       // review | downstream_finding | restack
  "head_sha": "abc123",
  "base_branch": "main",                  // restack 时为新基线
  "verdict": "changes_requested",         // changes_requested | approved | terminated | withdrawn | null
  "blocking": [
    { "id": 17, "author": "li.na", "kind": "blocking",
      "body_md": "分页边界少了 page=0 的处理",
      "anchor": { "path": "src/api/export.ts", "line": 42, "head_sha": "abc123", "url": "…" },
      "resolved": false }
  ],
  "non_blocking": [ … ],                  // 同形，kind 为 suggestion / question / note
  "thread": [ … ],                        // 本轮全部消息，按时间序（含 answer / resolution / system）
  "source_trust": "internal"              // internal（考拉内真人）| forge（汇入的外部评论，非受信）
}
```

REST 认领/进度/释放与 MCP 同一套设备证明。另加 Web 端专用的档案管理、审计查询、OAuth 回调等接口。

## 10. 数据模型（Drizzle / SQLite）

| 表 | 关键字段 |
|----|----------|
| `users` | 身份：`provider`（`local` / `gitlab` / `gitea` / leftover `github`）、`remote_id`（本地账号固定 `'local'`）、`username`（`local` 下唯一、非空、trim）、显示名、可空 `password_hash`（仅 `local`；Argon2id 或 `node:crypto` scrypt；明文永不进响应/日志/`events.details`）、状态（`active` / 遗留 `待批准` / `revoked`）、权限级（`admin` / `full` / 遗留 `claim_only`）；策略列 `device_max_age_days`（默认 90，范围 1–365，无永久；#63 评论更正。升级只改 SQL DEFAULT 与新建路径，不把已存储的 30 一律改成 90）、`max_devices`（默认 5）、`device_idle_days`（默认 0）。UNIQUE `(provider, remote_id)`。新 GitLab / Gitea OAuth 插入 `active`+`full`（已有可登录管理员之后）；不再插入 `待批准`/`claim_only`。重新登录不得把 `revoked` 改回 `active`。开库迁移：若无可登录管理员（`active`+`admin` 且 provider 为 `local`/`gitlab`/`gitea`；**GitHub 行不算**），取最早一条 `active`+`full` 且 provider 属 gitlab/gitea/local 改为 `admin`；若没有这样的行（只有 GitHub `full` 或空库）仍走向导 |
| `claimants` | 无 Web 登录的认领身份：display_name、status（`active` / `revoked`）、同上三列策略默认值 |
| `devices` | fingerprint、公钥、hostname（不可信）、status（`pending` / `active` / `expired` / `revoked`）。**活跃**设备的所有者恰好是 `claimant_id` 或 `user_id` 之一；**待授权**两者皆空。待授权窗口 `pending_expires_at`（首次见到起 1 天；#63 新 pairing 可延长到该 attempt 的 `expires_at`，不得缩短）。绑定后 `expires_at` 由所有者 `device_max_age_days`（默认 90 天）自 `paired_at` 计算。PATCH 策略与开库升级都不重写既有 `expires_at`。仍是唯一设备授权权威 |
| `device_pairings` | **#63**：配对 attempt 的幂等/过期/一次性消费状态，不是第二套授权。`pairing_id`、`device_id`、`protocol_version`、双方 nonce、normalized origin、`instance_id`、root SHA-256、commitment、status（`created` / `committed` / `approved` / `consumed` / `rejected` / `expired`）、approval payload/proof、`failed_attempts`、created/expires/approved/consumed。不存 pairing secret、私钥或 forge token。同一设备最多一个未过期 live attempt |
| `app_settings` | **#63**：随应用数据持久化的键值；至少 `instance_id`（UUID，首次启动生成，不随 `PUBLIC_URL` 轮换） |
| `agent_keys` | 遗留：user_id、key_hash、label、last_used_at。MCP / 认领 / whoami 不再用 Agent Key Bearer |
| `credential_profiles` | forge、base_url、repo_full_name、token_encrypted、scopes_checked、created_by |
| `tasks` | §6 各字段 + status、credential_profile_id / inline_token_encrypted（二选一）；**#53** `parent_task_id`（可空，自引用 `tasks.id`；只允许指向非终态任务，不允许自指 / 指向后代 / 环） |
| `leases` | task_id、claimer 为 `claimer_user_id` 或 `claimer_claimant_id`、**`device_id`**、claimed_at、expires_at、last_heartbeat、state、**`request_id`**（可空，`(device_id, request_id)` 部分唯一索引，#36 幂等 Claim 身份键）。`claim_id` 不落库，是该行不可变字段（`id`/`task_id`/`device_id`/`claimed_at`/`request_id`/claimer）派生的公开编码（见 §9、§15） |
| `claim_confirmations` | #16：task_id、user_id（仅绑到 Web 用户）、**`device_id`**、state、created_at |
| `submissions` | task_id、**`lease_id`**（唯一索引，一 Claim 一次提交，#31；仍指首次提交的 Claim）、**`pr_url`**（规范化后的绝对 URL，同一 URL 不得被另一任务的进行中提交占用）、summary、pr_state；**#53** `head_sha`（可空）、`head_branch`（可空）、`is_draft`（默认 false）、`review_round`（当前轮次，默认 0）；**#54** `forge_head_sha`（可空，poller / 「通过」最近一次在 forge 上观察到的 PR 头）、`forge_head_seen_at`（可空，unix 秒）。一任务一 PR |
| `submission_revisions` | **#53 新增**：`submission_id`、`lease_id`（唯一，一修订 Claim 一次交回）、`round`、`head_sha`、`summary`、`submitted_at` |
| `review_rounds` | **#53 新增**：`task_id`、`round`、`kind`（`review` / `downstream_finding` / `restack`）、`opened_by_user_id`（可空）、`opened_by_task_id`（可空，子任务开轮时记子任务）、`verdict`（`changes_requested` / `approved` / `terminated` / `withdrawn`）、`opened_at`、`revised_at`（可空）、`revision_head_sha`（可空）。`(task_id, round)` 唯一 |
| `discussion_messages` | **#53 新增**：`task_id`、`round`（可空 = 尚未归轮）、`author_kind`（`reviewer` / `agent` / `system` / `forge`）、`author_user_id` / `author_device_id`（可空）、`kind`（`blocking` / `suggestion` / `question` / `answer` / `note` / `resolution`）、`body_md`、`anchor`（可空 JSON `{ path, line, head_sha, url }`）、`reply_to_message_id`（可空）、`resolves_message_id`（可空）、`created_at` |
| `events` | 审计与时间线：类型（状态迁移 / token 揭示 / 心跳 / 回写 / 管理员创建 / 权限变更；**#53** 新增 `评审开轮`、`评审交回`、`评审通过`、`评审终止`、`评审撤回`、`restack`、`评审消息`，`details` 只放 `task_id`、`round`、`pr_url`、`head_sha`、`head_verified`（#54，`评审通过`）、`kind` 等短字段，不放长文本，不放 token）、主体、时间、详情 JSON。向导成功 `管理员创建`，`details` 恰好 `{ user_id }`；升级 `权限变更`，`details` `{ target_user_id, from, to }`。两者不得有密码、哈希、token |

SQLite 足够内部团队规模；Drizzle 之上留好升级 Postgres 的余地（不用 SQLite 特有特性）。

## 11. 认证

- **可登录管理员**：`status === 'active'` 且 `permission_level === 'admin'` 且 `provider` 为 `local` | `gitlab` | `gitea`。GitHub 行不算（登录按钮已拿掉）。
- **人（Web）**：两条路。考拉登录密码 ≠ forge 仓库 PAT。PAT 只用来绑档案、发任务；仍只在 REST claim `201` 顶层 `token` 与 MCP `claim_task` 成功 `token` 揭示。

  - **空库 / 零可登录管理员**：只许设置向导。`POST /api/v1/setup` `{ username, password }`（`display_name` 可省，默认等于 username）→ `201` + 会话；第一个人成为 `local` 管理员。向导只跑一次。并发第二次 → `409` `{ error: 'setup_complete' }`。缺字段/空用户名 → `400`。GitLab / Gitea / GitHub OAuth **不得**插 `users`、不得发会话。回调只重定向向导/登录页。
  - **已有管理员之后**：`POST /api/v1/login` `{ username, password }` → `200` + 会话；失败一律 `401`（不透露用户是否存在）。所有 GitLab / Gitea 登录都建发布者（`active`+`full`），不再 `/login?reason=uninvited`，不再插 `待批准` / `claim_only`。
  - **备用 HTML 表单**：`GET /login` 的向导及登录表单以 `application/x-www-form-urlencoded` 提交到相同 setup/login 端点；仅这两个端点接受该格式。成功建立会话后以 `303` 跳转 `/`；JSON 调用仍返回原 `201`/`200` 公共用户响应。表单携带的 `Origin` 若与 `PUBLIC_URL` 的 origin 不一致（含 `null`）返回 `403 forbidden`，不创建用户或会话；字段及失败状态沿用 JSON 合同。
  - **`GET /login/github` 与 callback 404**（不注册 OAuth start）。不删 GitHub 适配器。
  - **升级**：任何管理员 `POST /api/v1/users/:id/promote` 把 GitLab/Gitea 的 `active`+`full` 升为 `admin`（同一 OAuth 身份，不另开密码号）。已是 `admin` → 幂等 `200`。GitHub / local / 缺失 → `404` 或 `400`。不再用向导开第二个密码管理员。本条不做降级、删用户、改密、自助找回。
  - **`GET /api/v1/users`**：仅管理员 → `{ users: [{ id, provider, username, display_name, status, permission_level }] }`，无哈希。
  - **`GET /api/v1/me`**：现有字段 + `permission_level` 为 `admin` | `full` | leftover `claim_only`；`provider` 可为 `local`。从不带密码/哈希/代币。不另加 `is_admin`。
  - **`GET /api/v1/setup`**（公开）：`{ setup_complete: boolean }`，供 SPA 在向导与登录卡之间切换（无会话）。
  - 退役 `POST /api/v1/users/:id/approve`。`KAOLA_ADMINS` 若仍设置：**忽略**，不炸 boot。
  - 重新登录不得复活 `revoked`。
  - **发布 / 导入 / 档案 / 自己任务 PATCH**：`admin` **或** `full`。
  - **待授权电脑、绑定/解除、认领者、升级、受信自动化 + 待确认认领**：**仅** `admin`。发布者不能绑任何电脑。绑定不自动认领、不推送 forge token。认领者没有会话，不能进工作台。自动配对产生的 pending 设备（存在 `device_pairings` 行）绑定必须附带 exact `pairing_id` + pairing secret；工作台不显示期望密语。无 pairing 行的遗留 pending 仍走原 bind body（§16.8）。
  - **看板 / 审计 events+stats**：任何 `active` Web 用户；`待批准` 仍 401 events。
  - UI：零管理员只展示向导（不把三家 OAuth 当可用入口）。有管理员后：直接登录表单 + GitLab / Gitea；**没有 GitHub 按钮**。服务端 `GET /login` HTML 与 Vue 登录卡同步。头栏：`admin` → 管理员；`full` → 发布者。

  | 能力 | `admin` | `full`（发布者） | 认领者（无 Web 登录） |
  |------|---------|-----------------|------------------------|
  | 查看任务板 / 发布 / 凭证档案 | ✓ | ✓ | ✗ |
  | 绑定电脑 / 认领者 / 升级 | ✓ | ✗ | ✗ |
  | 经 Agent 认领任务 | 冒烟：电脑绑到自己 | ✗（无设备） | ✓（电脑绑到该认领者） |

- **Agent（MCP/REST）**：每请求 Ed25519 设备签名，不是复制粘贴的 Bearer `ktk_`。未配对的合法签名 → `202` `authorization_required`（见 §7）。解除人或电脑在下一次请求生效。私有 CA 上尚未完成 §16.8 配对的客户端进不了 MCP：`kaola-mcp --url` 返回 `pairing_required`，须先 `kaola-mcp pair`。绑定事务仍不自动认领、不揭示 forge token。`GET /api/v1/agent/whoami` 在 active 时另含 `instance_id`（#63）。
- **Webhook**：各 forge 的签名校验（GitHub HMAC、Gitea/GitLab secret token）。

## 12. 技术选型与仓库结构

- 前端：Vue 3 + Vite + Naive UI（或 Element Plus，中文生态一线组件库）
- 后端：Node 22 + Fastify + Drizzle ORM + SQLite
- MCP：官方 `@modelcontextprotocol/sdk`（TS），与 API Server 同进程或独立进程均可，首选同进程挂载
- Monorepo：pnpm workspaces

```
KaolaTasks/
├─ apps/
│  ├─ web/          # Vue 3 前端
│  ├─ server/       # Fastify API + MCP Server + webhook 接收
│  └─ mcp/          # kaola-mcp：本机 stdio 桥，签名后转发 POST /api/mcp
├─ packages/
│  ├─ shared/       # 类型、任务卡 schema（zod）、状态机定义
│  └─ forge-adapters/
├─ docs/
│  └─ DESIGN.md     # 本文档
└─ docker-compose.yml
```

**部署**（仍是 D4 内部部署，不对外分发）：一种拓扑——内网服务器跑考拉和本地 GitLab / Gitea；公网入口是主机名（或 IP）上的 TLS 反代，云开发机不是生产原点。浏览器与 `kaola-mcp` 打到 `PUBLIC_URL`，宿主机反代 `<https-port>` → `127.0.0.1:31415`（compose 端口绑环回，不把 31415 直接放公网）。不要假设入站 80 可用：动态主机名加上禁止入站 80 时，HTTP-01 / standalone webroot **不可行**。`PUBLIC_URL` 是团队浏览器真正打开的地址（`https://<public-host>:<https-port>` 或稳定名 `https://<production-subdomain>`，不带尾斜杠），OAuth 回调、MCP `--url`、回写评论里的链接都跟它；`OAUTH_*_BASE_URL` 用服务器访问 forge 的内网地址。真实主机名、公网 HTTPS 端口、IP、DNS 提供商、证书指纹只写在 gitignore 的 `.env`、操作者配置或用户本机 MCP 配置中；不得进入 git、可提交补丁或仓库共享 MCP 示例。docker-compose 单机：镜像内 SPA + Fastify，`env_file: .env` 注入密钥与 `PUBLIC_URL`，SQLite 文件 `/data/kaola.sqlite`（卷 `kaola-data` → `/data`）。同机时默认轮询完结「待验收」；webhook 可后补。登录：空库只许设置向导建最初管理员；之后 GitLab / Gitea 登录成为发布者（可被升级），不是对外开放注册。操作步骤见根目录 [README.md](../README.md)「生产向部署」与「安装与证书信任」。服务端公网证书签发、反代 fullchain、DNS-01 与续期由本节（[#46](https://github.com/KaolaBrother/KaolaTasks/issues/46)）拥有；客户端 MCP 安装与证书信任（公开 CA 默认路径 vs 私有 CA 测试路径）见 §16（#48）。仓库文档只用占位符（`<kaola-origin>`、`<public-host>`、`<https-port>`、`<production-subdomain>`、`<acme-dns-provider>`、`<dev-root-ca.pem>`、`<sha256-fingerprint>`）；真实域名、服务器名、端口、证书指纹、DNS 提供商和本机路径不得进入 Git。

**公网 HTTPS 证书（#46），两种模式（二选一，由操作者在本地配置声明；仓库只描述合同）：**

1. **`DEBUG_PRIVATE_CA`（已登记测试机，不是干净机器的公网信任）**
   使用受控的**开发根 CA**（不是当前这种仅 CN、无 SAN 的自签名 leaf）。由该根签发的 leaf，其 SAN 必须包含 `<public-host>`。`PUBLIC_URL` 仍是 `https://<public-host>:<https-port>`。认领端默认走 §16.8：`KAOLA_PAIRING_MODE=private_ca` 加上非秘密的 `KAOLA_PUBLIC_ROOT_CA_PATH`（恰好一块公开根 CA，无私钥块；启动时须能作为当前 origin 严格链的根）。`NODE_EXTRA_CA_CERTS` 只给本机 `kaola-mcp` 桥进程，且只从本机已核验的 v2（或遗留 v1）state 注入。根私钥永不进入 git、mcp.json、Task Brief、或分发给认领电脑。禁止把 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或 `curl -k` 当作验收。本模式只证明**已登记测试机**上的浏览器 / OAuth / MCP / 设备绑定功能，**不**证明干净机器的默认公网信任。客户端如何安装与（或不）信任见 §16 / §16.8。需要浏览器、OAuth 或管理员工作台的电脑仍须另做 §16.3 系统信任。

2. **`STABLE_PUBLIC_CA`（干净机器默认信任）**
   优先使用专用名 `<production-subdomain>`（不要沿用动态 `<public-host>` 当稳定生产名）。用公开 ACME CA 经 **DNS-01** 签发（DNS API 自动化，占位 `<acme-dns-provider>`），不依赖入站 80。反代在 `<https-port>` 上发送 **fullchain**（leaf + intermediates）。自动续期，续期后先做反代配置测试再 reload，不中断 Fastify。若 DNS 提供商没有 API，手工 DNS-01 只可作临时；可选把 `_acme-challenge.<production-subdomain>` CNAME 委派到由自动化管理的 zone。干净 macOS / Windows / Linux 的系统 TLS 必须能链到内置根。客户端不装额外 CA、不设 `NODE_EXTRA_CA_CERTS`（见 §16）。

**验收拆开：** `DEBUG_PRIVATE_CA` → 已登记设备冒烟（配合）；`STABLE_PUBLIC_CA` → 干净 macOS / Windows / Linux 默认信任冒烟（配合）。未实际执行的平台检查不得写成已通过。

**活网变更前置：** 已证明的服务器授权，加上已选定的 `<production-subdomain>` 与 `<acme-dns-provider>` 细节。缺任一项则不做 live 换证 / reload。仓库不提交针对某一套主机的反代脚本或证书。CN-only 自签名 leaf 不是任何一种模式的交付物。`kaola-mcp` 保持严格 TLS（见 §7、§16）。本条不改变 MCP 工具面、Claim/Lease、设备签名、GitLab/Gitea OAuth 身份、token 揭示通道或 Task 状态机。

## 13. 里程碑

- **M0 — 脚手架**：monorepo 初始化、CI（lint + test）、shared 包内的任务卡 zod schema 与状态机、docker-compose 骨架。
- **M1 — 核心闭环（可用版）**：设置向导 + GitLab / Gitea OAuth 登录、凭证档案 + 发布即校验、任务 CRUD 与看板、租约式认领、**MCP Server 六个工具全量可用**、`submit_pr` 手动闭环（PR 状态先靠轮询）。此时"发布 → Agent 认领 → PR 交付"的主循环已经跑通。
- **M2 — 导入与自动闭环**：三 forge 的 Issue 导入、webhook 接入（含签名校验）+ 轮询兜底配置化、PR 合并自动完结、状态回写源 Issue 评论。
- **M3 — 打磨**：审计日志界面、任务时间线、团队完成统计、认领确认策略配置、（可选）竞技模式——同一任务允许 N 个 Agent 并行尝试、发布者择优合并。

## 14. 风险与开放问题

1. **token 外泄面**：token 到达 Agent 侧后平台无法控制其存储环境。缓解：仓库级细粒度 token + 审计 + 易吊销；团队约定 Agent 侧不落盘。
2. **内网 webhook 可达性**：部署位置需与三个 forge 网络互通；不通的实例走轮询（已设计）。
3. **提示注入**：导入 Issue 的正文可能含诱导 Agent 的内容。缓解：来源标记 + 人确认认领；后续可加简单的注入模式扫描。
4. **待定**：租约 TTL 默认值（暂定 24h）；是否需要"补丁文件"作为 PR 之外的备用交付通道（当前范围内暂不做）。

## 15. Claim 执行兼容层（规划）

完整决策见 [0030 — Claim MCP lifecycle with default Workflow and optional Project Runner](decisions/0030-claim-mcp-workflow-runner-compatibility.md) 与 [Issue #30](https://github.com/KaolaBrother/KaolaTasks/issues/30)。本节冻结产品边界：

- Kaola Tasks 单向适配两个独立 Repo；Workflow 和 Runner 不知道 Kaola Tasks 存在。
- 本节适用范围是来自外部 forge Issue、随任务携带该 Issue 凭证的任务；该 Issue（`source.issue_url`）就是 Workflow 目标。对这类任务，`claim_task` 成功后，当前 MCP Agent 必须直接启动并运行 Kaola Workflow 处理该任务——这是强制要求，不再只是默认值；只有用户显式指定时才使用 Project Runner，当前 Agent 仍是 Claim controller/monitor。Kaola Workflow 完成后提交 PR/MR 是默认且必须的收尾动作，Agent 必须调用 submit_pr，不允许省略这一步。若认领到的任务没有随附的 forge Issue（例如 native 任务），则不在本节范围内：Kaola Workflow 本身启动要求至少一个 Issue 编号（已实测 `no_target` / `claim_issue_numbers_invalid` 拒绝），因此无法为其启动 Workflow。
- 服务端保持现有六个 MCP 工具且不运行外部进程；只给现有 lease 补 request id、公开 Claim identity、精确 device fence、事务和幂等。
- `kaola-mcp` bridge 只保存无密 Claim recovery receipt：服务端身份为 request/claim，carrier 与精确 Runner session 仅留在本地回执；不保存 token、prompt、Workflow 内容或 Runner transcript。
- Workflow/Runner capability 与版本探测只提供 advisory evidence，不形成 allowlist hard gate；身份、合法状态迁移、Claim fence、token 解密和 PR repo 绑定仍 fail closed。
- 当前 forge PAT 是 claim 时揭示的可复用仓库凭证，并非 lease-scoped token；真正 per-Claim mint/revoke 是独立后续能力。
- 实现顺序与逐项验收由 [#36](https://github.com/KaolaBrother/KaolaTasks/issues/36) → [#31](https://github.com/KaolaBrother/KaolaTasks/issues/31) → [#32](https://github.com/KaolaBrother/KaolaTasks/issues/32) → [#33](https://github.com/KaolaBrother/KaolaTasks/issues/33) → [#34](https://github.com/KaolaBrother/KaolaTasks/issues/34) → [#35](https://github.com/KaolaBrother/KaolaTasks/issues/35) 承接；Issue 编号不代表执行顺序。

## 16. 双模式 MCP 安装与证书信任（#48，认领端配对 #63）

本节冻结**客户端**安装、信任启动、权限边界、卸载与轮换，以及 #63 的管理员批准绑定自动配对。它不改变 MCP 工具清单、设备签名 canonical、Claim/Lease、OAuth 身份、token 揭示通道或 Task 状态机。证书引导发生在 MCP 协议连接之前。

操作者在未跟踪的本地配置里声明入口属于哪一种模式。模式名与 [#46](https://github.com/KaolaBrother/KaolaTasks/issues/46) 的两阶段 TLS 划分对齐（`STABLE_PUBLIC_CA` / `DEBUG_PRIVATE_CA`），但职责分开：#46 拥有签发、反代、续期和公网跨平台实测（见 §12）；#48 拥有每台电脑怎么安装 `kaola-mcp` 以及 v1 手工信任；#63 拥有认领端自动配对（§16.8）。本节不重复服务器签发/DNS-01/fullchain/续期合同。

可执行入口是 `@kaola/mcp` 的 package bin `kaola-mcp`。`kaola-mcp trust …` 与 `kaola-mcp pair …` 都在 MCP 协议之外（不是新的 MCP 工具）。`kaola-mcp --url <kaola-origin>` 由同一 bin 启动 stdio 桥，只从本机已核验的信任 state 注入额外 CA，且保持严格、非交互。提交进 Git 的示例仍是 `command` + `--url`，不含 `env`、PEM、指纹、清单、配对密语或任何私钥。磁盘布局见 §16.7（v1）与 §16.8（v2 / receipt）。

### 16.1 方案 1：`STABLE_PUBLIC_CA`（公开 CA 默认安装）

适用：服务器证书链能被操作系统默认根证书库验证。

这是面向干净电脑和长期稳定入口的默认方案。

- 安装 `kaola-mcp` 后只配置 `PUBLIC_URL` / `kaola-mcp --url <kaola-origin>`。
- 不安装额外 CA，不设置 `NODE_EXTRA_CA_CERTS`，不关闭严格 TLS。
- 浏览器 OAuth、MCP `authorization_required`、管理员绑定、绑定后 `list_tasks` 全部使用系统默认信任链。
- 若本机 MCP 配置或进程环境仍带 `NODE_EXTRA_CA_CERTS`，或系统信任库仍留着测试私有根，视为未完成从测试模式的迁移。

为什么不需要安装证书：叶子由公开 CA 签发，操作系统已内置对应根。再装私有根只会扩大信任面。

### 16.2 方案 2：`DEBUG_PRIVATE_CA`（私有 CA 测试安装）

适用：已纳管测试电脑；入口由受控开发根 CA 签发（不是把裸自签叶子当根分发）。**每台电脑**都要完成信任引导，因为默认根证书库不包含该开发根。只在一台机器上装过，其它电脑照样 TLS 失败。

分发物是同一份**公开根证书 PEM**（占位 `<dev-root-ca.pem>`），外加带外 SHA-256（占位 `<sha256-fingerprint>`）——这是操作者 v1 路径的材料。根私钥不得离开签发端，不得进入服务器 Web 根、客户端、Git、Task Brief、mcp.json、MCP 环境变量或日志。`NODE_EXTRA_CA_CERTS` 指向的是这份公开根**证书**，不是公钥文件，更不是私钥。

**认领端默认路径是 §16.8**（`kaola-mcp pair --url`），不要求认领者持有 PEM 或指纹。下面 1–5 步只描述 #48 的操作者 / 恢复路径（v1），不得把 v1 state 写成 approval-bound。

默认 MCP 路径是**进程级**信任，与系统/浏览器信任分开：

1. 从安装包或带外材料取得 PEM，以及固定 SHA-256 指纹或发布者签名清单。禁止用第一次连 `<kaola-origin>` 时服务器返回的 CA 当信任锚。
2. 运行 `kaola-mcp trust install`（§16.7）核验并原子写入用户级 `$KAOLA_HOME/trust/` 下的公开根 PEM 与 host-neutral 验证 state。核验通过之前，不得启动带额外 CA 的 HTTPS 连接。
3. 之后用 `kaola-mcp --url <kaola-origin>` 启动桥。launcher **只**从已核验 state 给桥子进程注入 `NODE_EXTRA_CA_CERTS`（指向已安装的公开根 PEM）。调用方环境里的 `NODE_EXTRA_CA_CERTS` 不是信任源，不得作为成功路径。真实路径不得提交进 Git。Node 把该根**加到**运行时默认根证书库，而不是替换默认库。不得关闭严格 TLS。
4. 不把该根写入系统信任库，除非操作者另走 §16.3 的显式提权。`NODE_EXTRA_CA_CERTS` 不是浏览器信任。
5. 安装、轮换或卸载之后必须**重启 MCP 客户端**，再以严格 TLS 发起设备 pending / 绑定。正在跑的 stdio 桥不会热加载新根。

只跑 Agent、不打开工作台/OAuth 的电脑：做完进程级信任即可。需要浏览器、OAuth 或管理员绑定的电脑：进程级信任不够，必须另做 §16.3。

### 16.3 系统 / 浏览器信任（显式提权，不得静默）

浏览器读操作系统（或浏览器自己的）信任库，不读 `NODE_EXTRA_CA_CERTS`。

- 用户级 MCP 信任与系统级浏览器信任是两次授权，分开描述、分开执行。
- 涉及 macOS 管理员认证、Windows UAC 或 Linux root 时，任何考拉进程都**不得**静默执行装证命令。
- 文档使用占位符 `<dev-root-ca.pem>`。三种操作系统的证书命令不得假定相同：
  - macOS：系统钥匙串 / `security add-trusted-cert`（需管理员认证）。
  - Windows：本机受信任根 / `certutil -addstore Root`（需 UAC）。
  - Linux：发行版各异（Debian/Ubuntu `update-ca-certificates` 与 Fedora/RHEL `trust anchor` 不要混用），需 root。
- 未完成系统信任时，浏览器 / OAuth 必须失败。点证书例外、忽略警告或 `curl -k` 不算通过。

### 16.4 信任启动（fail closed）

禁止 TOFU：客户端不得在第一次未信任连接上「下载到什么 CA 就自动信任什么」。#63 允许 `kaola-mcp pair` 在 unknown-issuer 类错误之后用范围受限的 bootstrap **搬运**公开根 PEM 作为未信任数据，但**安装**只发生在管理员批准证明核验以及全新严格 TLS + active `whoami` 通过之后（§16.8）。操作者 v1 路径仍然：先核验、再设置 `NODE_EXTRA_CA_CERTS`、再连接；不得把第一次连 origin 下载到的 CA 直接写成 v1 ready。

本版冻结的带外材料是：**本地 PEM + 带外 SHA-256**，或 **本地 PEM + 发布者签名清单**。操作者从安装包或其它可信渠道拿到材料，用 `kaola-mcp trust install` 核验后再启用。手工对照：

```bash
openssl x509 -in <dev-root-ca.pem> -noout -fingerprint -sha256
```

输出必须与带外 `<sha256-fingerprint>` 一致（去掉冒号、大小写不敏感）。PEM 必须恰好一块 `CERTIFICATE`，且是 CA；文件中出现任何私钥块（`PRIVATE KEY`）则拒绝。错误指纹、错误签名、无法解析、非 CA、含私钥、state 缺失/损坏/权限不合、或磁盘上的 PEM 被替换导致与 state 中的指纹不再匹配：`trust install` / `trust status` / `kaola-mcp --url` launcher 一律 fail closed，不得给桥注入额外 CA，不得连接，不得降级为「先连上再说」。只对内部 `exportMcpTrustEnv(expectedFingerprint)` 证明替换失败、而不证明真实 bin 启动链，不算验收通过。

下列路径不是成功：

- `NODE_TLS_REJECT_UNAUTHORIZED` 为 `0` / `false`
- `--insecure`、`curl -k`、浏览器证书例外
- `STABLE_PUBLIC_CA` 下安装私有根、或调用方设置 `NODE_EXTRA_CA_CERTS` 仍被 launcher 接受
- `DEBUG_PRIVATE_CA` 下未核验、指纹不匹配、签名不匹配、非 CA、含私钥、或 PEM 被替换后仍启动桥
- 未核验就从 origin 下载 CA 并写入信任目录或 `NODE_EXTRA_CA_CERTS`

### 16.5 卸载、轮换、退出团队、迁移到公开 CA

- **核验**：`kaola-mcp trust status`，或用上面的 `openssl` 命令对照带外 `<sha256-fingerprint>`。不一致就停止连接。
- **卸载 MCP 额外 CA**：`kaola-mcp trust uninstall`，然后重启 MCP。不要删 `device.json` 或 Claim receipts。卸载后公开 CA 路径不得再注入额外 CA；调用方若仍设置 `NODE_EXTRA_CA_CERTS`，launcher 必须拒绝。
- **卸载系统/浏览器信任**：按各 OS 提权命令手工删除该根。卸载 MCP 信任不等于系统信任已撤。
- **根 CA 轮换（v1 操作者路径）**：先带外分发新根的指纹或签名清单；各电脑再跑 `kaola-mcp trust install`（原子替换 PEM + state），重启 MCP；若曾做系统信任则同步替换；再作废旧根。新旧根的私钥都不分发。
- **根 CA 轮换（v2 已配对客户端）**：走 §16.8 overlap：旧严格 TLS + active device-auth 预取下一公开根；先 old+new overlap，再切 leaf；客户端证明新链后才删旧根。错过 overlap 必须重新管理员批准配对，不做不安全恢复。
- **电脑退出团队**：管理员解除该设备；本机删除该 origin 的 v2 trust（或 `kaola-mcp trust uninstall`）；若曾做系统信任则再撤系统根。
- **从 `DEBUG_PRIVATE_CA` 迁到 `STABLE_PUBLIC_CA`**：先证明同 origin / instance / device 的默认系统根严格连接与 active `whoami`，再移除该 origin 的 MCP extra root。不静默卸载系统/浏览器根。只保留 `--url <kaola-origin>`。

### 16.6 验收边界

`kaola-mcp trust`、`kaola-mcp pair` 与 launcher 必须从 package bin 可调用。内部库函数不是安装器。系统/浏览器装证命令从不由考拉进程执行。不新增 MCP 工具。

#48 必须继续证明：公开 CA 默认无额外 CA，调用方设置 `NODE_EXTRA_CA_CERTS` 时 fail closed；v1 私有 CA 在指纹或签名清单匹配时严格 TLS 成功；错误指纹、错误签名、替换证书、缺失/权限/state 不一致时 fail closed；卸载不留下 MCP 额外 CA 且不删 `device.json` / Claim receipts。#63 的 pairing 验收见 §16.8 与 [ADR 0031](decisions/0031-approval-bound-private-ca-pairing.md)；未实际执行的物理平台、浏览器、服务或用户操作不得写 PASS。真实环境标识与根私钥扫描必须为零。

### 16.7 客户端 CLI 与信任 state（package bin，非 MCP 工具）

`kaola-mcp` 由 `@kaola/mcp` 的 `bin` 提供。成功退出码 `0`，fail-closed 非 `0`。

信任子命令：

- `kaola-mcp trust install --pem <dev-root-ca.pem> --fingerprint <sha256-fingerprint>`
- `kaola-mcp trust install --pem <dev-root-ca.pem> --manifest <trust-manifest.json>`
- `kaola-mcp trust status`
- `kaola-mcp trust uninstall`
- `kaola-mcp trust system-plan`（可选 `--platform darwin|win32|linux-debian|linux-fedora`）。省略时：`darwin` / `win32` 按 `process.platform`；Linux 必须显式传发行版，不得把 Debian 与 Fedora 命令混用。只打印操作者命令，从不执行。仅当本机信任 **ready**（PEM + state 核验通过）时才打印提权命令，目标必须是已核验的 `$KAOLA_HOME/trust/root-ca.pem`。未安装、PEM/state 不一致或磁盘 PEM 被替换：退出非 0，且不得输出 `security add-trusted-cert` / `certutil` / `update-ca-certificates` / `trust anchor`。win32 用 Windows 命令行引号（不是 POSIX 单引号），路径含空格或 `"` 时仍是一条可解析参数。

`--fingerprint` 与 `--manifest` 必须恰好提供一个。清单 JSON：

```json
{
  "v": 1,
  "fingerprintSha256": "<sha256-fingerprint>",
  "signature": "<ed25519-signature-base64>",
  "publicKeySpki": "<ed25519-spki-base64>"
}
```

`signature` 是对证书 DER 的 Ed25519 签名。清单里的指纹必须与 PEM 的 SHA-256 一致，且验签必须通过。`publicKeySpki` 与 `signature` **同在这份操作者提供的文件里**：它不是产品内置的发布者公钥钉，也不能把任意自带密钥的 JSON 当成独立信任锚。只有当整份清单来自与带外指纹相同的可信渠道（安装包或已认证分发，而不是第一次连 origin 下载到的东西）时，验签才代表该渠道的发布者身份。否则用 `--fingerprint` 对照带外 SHA-256。

安装成功后写入 `$KAOLA_HOME/trust/`（`KAOLA_HOME` 或默认 `~/.kaola`）：

- 目录模式 `0700`
- `root-ca.pem`：单块公开根 CA，`0600`
- `state.json`：host-neutral，`0600`，至少 `{ "v": 1, "alg": "sha256", "fingerprintSha256": "<lowercase hex without colons>" }`。不含主机名、本机绝对路径、PEM 正文或私钥。经清单安装时另含 `"kind": "publisher-signature-manifest"` 与 `"publicKeySpki"`
- PEM 与 state 必须原子写入（先写临时文件再 rename）。只存在其一、JSON 无法解析、指纹与 PEM 不一致、权限不合或不可读：视为未就绪，fail closed。POSIX 模式位在 `win32` 上不强制（平台无 0700/0600）；就绪性仍要求 PEM 与 state 可读且指纹一致。

桥启动 `kaola-mcp --url <kaola-origin>`（同一 bin）：

1. 若该 origin 存在核验通过的 **v2** trust（§16.8）：只注入该 origin 的已核验 PEM；device fingerprint 必须匹配本机 `device.json`。
2. 否则若 v1 PEM 与 state 齐全且核验通过：保持 #48 行为，只把已核验 PEM 路径注入桥**子进程**的 `NODE_EXTRA_CA_CERTS`。这是显式兼容，不是 approval-bound。
3. 否则公开 CA 默认，不注入额外 CA。若调用方环境已设 `NODE_EXTRA_CA_CERTS`，fail closed，不启动桥。
4. HTTPS 且失败属于 unknown-issuer 类、又没有可用 v2/v1：不启动桥，typed `pairing_required`（退出码 `2`），提示 `kaola-mcp pair --url <origin>`。hostname mismatch、过期、尚未生效、畸形证书：直接失败，不进入 pairing。
5. 其它任何不一致：fail closed，不启动桥。调用方该变量不是信任源。`--url` 从不在 MCP host 内等待管理员批准。

`trust status` 用同一套规则报告是否 ready。`trust uninstall` 删除 v1 目录下的 PEM 与 state，不删 `device.json`、Claim receipts 或未完成的 pairing receipt；v2 按 origin digest 单独删除。

### 16.8 管理员批准绑定自动配对（#63）

完整威胁模型、length-delimited transcript、HKDF、test vectors 与失败断言见 [ADR 0031](decisions/0031-approval-bound-private-ca-pairing.md) 与 [0031-pairing-test-vectors.json](decisions/0031-pairing-test-vectors.json)。实现必须复现这些向量，不得另编编码。本节冻结产品合同。

**用户路径**

```text
安装 kaola-mcp
  -> kaola-mcp pair --url <kaola-origin>
  -> 本机生成 device key + 一次性配对密语并等待
  -> 管理员在「电脑」页选择 owner、输入配对密语、授权
  -> 客户端验证批准证明
  -> 自动安装公开根
  -> 全新严格 TLS + active whoami
  -> ready，可 list_tasks / claim_task
```

公司签名安装包或 MDM 可以用既有受信通道代替人工复制密语，但不得改变服务端批准事务和严格重连门槛。认领者不手工处理 PEM、证书指纹、`NODE_EXTRA_CA_CERTS` 或重启。`pair` 在本进程内完成安装与严格重连；`--url` 仍是新的 MCP 进程，保持非交互。

**Bootstrap 边界**

只允许 `kaola-mcp pair` 在「先严格 TLS、仅 unknown-issuer 类错误」之后使用一次性、范围受限的未建立 PKI 信任连接：

- 只访问 pairing REST（create / commit / status）；不打 `/api/mcp`、Task、Claim、review、credential、event/audit
- 不发送 cookie、forge token、Claim token、Task 内容或 repo 信息
- 不设置进程全局 `NODE_TLS_REJECT_UNAUTHORIZED=0`，不提供可复用 `--insecure`
- bootstrap 上仍校验 hostname/SAN、有效期、证书可解析性
- 严格重连之前销毁该 agent

公开 CA 默认信任成功时不得安装额外根。

**协议**

客户端生成现有 Ed25519 设备身份、32-byte client nonce、≥16-byte pairing secret。服务端生成 `kpr_` + 32 hex 的 pairing id、32-byte server nonce、持久 `instance_id`，并给出规范化 origin（与 `originDigest` 所用字符串相同）、公开根 PEM、根 SHA-256（证书 DER）和 expiry。

**配对窗口（用户纠正，取代 900s 草案）：** 新 attempt 的有效窗口从**该次申请**起算，至少 24 小时。`KAOLA_PAIRING_TTL_SECONDS` 默认与下限均为 `86400`，上限 `604800`。`pairing.expires_at = created_at + ttl`。`now < expires_at` 时可批准、可幂等恢复 create/commit/status；`now >= expires_at` 才 `pairing_expired`。不得另设更短的 secret / proof / receipt / 客户端等待超时，以免一天内的正常批准或重启恢复失效。若该设备已有未过期 pending：`devices.pending_expires_at = max(既有 pending_expires_at, pairing.expires_at)`，只延长、不缩短；pairing 自身仍从本次申请起至少 24 小时，不改写成剩余 pending。同一 attempt 的幂等恢复**不**滑动 `pairing.expires_at` 或因此再延 pending。批准后设备授权按 owner `device_max_age_days`（默认 **90** 天）从 `paired_at` 计算，与 pairing TTL 独立。全新库与升级后的 SQL DEFAULT / 应用创建路径均为 90；不得无差别把存量策略或既有 `devices.expires_at` 从 30 改成 90（无法区分旧默认与明确配置）。

客户端只发送 `HMAC-SHA256(pairing_secret, SHA256(transcript))`。管理员提交 secret 后，服务端 constant-time 验证 commitment，在同一事务中激活 exact device，并以 HKDF-SHA256（salt = SHA-256(transcript)，info `kaola-pairing-approval-v1`，L=32）派生 pairing key，对 approval transcript 做 HMAC proof。密语不入库、不进日志/事件/工作台回显。

**REST（MCP 外，设备证明，忽略 cookie）**

| 路由 | 行为 |
|------|------|
| `POST /api/v1/device-pairings` | `{ client_nonce }`；创建或幂等恢复该设备未过期 attempt；返回公开 descriptor（含 `root_pem` / `root_sha256` / `instance_id` / `origin` / `server_nonce` / `expires_at`）。已 active → `409 conflict` |
| `POST /api/v1/device-pairings/:id/commit` | `{ commitment }`；首次写入；相同 commitment 幂等；不同 commitment → `409 pairing_commitment_mismatch` |
| `POST /api/v1/device-pairings/:id/status` | `{}`；`created`/`committed` 无 proof；`approved` 返回同一 proof 直至 consumed 或过期；`consumed` 不再重放 proof |
| `POST /api/v1/device-pairings/:id/complete` | 仅严格 TLS；标记 consumed；幂等。不是信任门闩 |
| `POST /api/v1/devices/:id/bind` | 有 pairing 行的设备额外要求 `pairing_id` + `pairing_secret`；仍 exactly-one owner；错密语 `403 pairing_secret_invalid`（8 次后拒绝该 attempt）；无 pairing 行的遗留 pending 保持原 bind body |
| `POST /api/v1/device-trust/next-root` | 严格 TLS + **active** 设备；overlap 期间返回下一公开根 |

`KAOLA_PAIRING_MODE` 非 `private_ca` 时 pairing REST 为 `404 pairing_mode_disabled`。Bootstrap 设备仍是 pending，不能 list/claim。bind 成功不自动 claim，不揭示 forge token。`GET /api/v1/devices/pending` 可带 `pairing_id` / `pairing_expires_at` / `requires_pairing_secret`，不含密语/commitment/proof/PEM。

**本机状态**

- 完成前：`$KAOLA_HOME/pairings/<origin-digest>/receipt.json`（`0600`），可含恢复所需材料（含密语与 PEM）；成功/取消/过期后删除。不含 device 私钥、forge token、Task。
- 就绪后：`$KAOLA_HOME/trust/v2/<origin-digest>/`（`root-ca.pem` + `{ v: 2, originDigest, instanceId, deviceFingerprint, fingerprintSha256, trustEpoch, pairedAt }`）。不含字面 origin、pairing secret、私钥、forge token 或 Task。
- v1 `$KAOLA_HOME/trust/state.json` `v: 1` 不得改写成 v2。

**工作台**

电脑页待授权行：配对密语输入（中文，不显示期望值）+ 现有 owner 选择。发布者仍不能绑定。

**不变量**

- 批准前、proof 未验证、或最终 strict TLS / active whoami 未通过，不得出现 ready trust
- 根/leaf 私钥不进入应用、客户端、DB、日志、Task、MCP 配置或 Git
- 不新增 MCP 工具；不改变 Claim/Lease、设备 Ed25519 proof、token 揭示通道或 Task 状态机

## 17. 评审循环（#53）

本节冻结考拉内多轮评审、修订 Claim、依赖子任务与实时进度流。它不改变 token 揭示通道（仍只有 REST claim `201` 与 MCP `claim_task` 成功）、设备证明、Claim/Lease 身份、OAuth 身份，也不让服务端运行 Agent / Workflow / git、解冲突、rebase、approve 或 merge。六个既有工具的输入 schema 只做可选字段追加。

### 17.1 分工

```text
forge（代码事实层）                 考拉（协调对话层）
─────────────────────              ─────────────────────────────
Draft PR / 分支 / commits          任务级讨论线程（人 ↔ Agent，多轮）
CI 结果                            轮次、判定、阻塞项清单、处理状态
diff 与行级锚点                      「球在谁手里」的任务状态
最终 ready + 合并                   依赖子任务、restack、进度流
```

评审期间考拉对 forge PR 的写操作只有两处：「通过」时把 Draft 翻 ready；可选地写一条摘要评论（「经考拉 N 轮评审通过，讨论见 kt-xxxx」，由 `KAOLA_REVIEW_SUMMARY_COMMENT=1` 开启，默认关闭）。

### 17.2 评审者与 REST（会话）

评审者 = 任何 `active` 且 `admin` / `full` 的 Web 用户（MVP 不加 `reviewers` 字段）。五条写路由非 `admin` / `full` → `403` `{ error: 'forbidden' }`；`GET …/review` 与看板同一读者群（任何非 `待批准` 会话）；无会话走现有 401/302。消息正文 ≤ 20000 字、锚点字段 ≤ 2000 字、`open_review_round` 单次 ≤ 50 项、`phase` ≤ 200 字，超限 `400`。

| 路由 | 行为 |
|------|------|
| `GET /api/v1/tasks/:publicId/review` | 返回 `{ task_id, status, pr_url, head_sha, forge_head_sha, forge_head_seen_at, head_stale, round, rounds: [...], messages: [...], current: <Review Brief> }`（`forge_head_*` / `head_stale` 见 §17.7） |
| `POST /api/v1/tasks/:publicId/review/messages` | 写一条未归轮消息 `{ body_md, kind, anchor?, reply_to?, resolves? }`；`kind` 同 §9；可带 `anchor`（粘贴 forge diff 链接时前端解析出 `path:line`）。任务不在 `待验收` / `待修改` / `待合并` → `409` `illegal_transition`。不翻状态 |
| `POST /api/v1/tasks/:publicId/review/rounds` | 「提交本轮意见」：把当前未归轮的消息归入新一轮（`kind = review`）；含 `blocking` 消息时 `待验收 → 待修改`（`verdict = changes_requested`），否则只归轮不翻状态（`verdict` 为空）。没有未归轮消息 → `409` `no_pending_messages`。任务不在 `待验收` → `409` `illegal_transition` |
| `POST /api/v1/tasks/:publicId/review/approve` | 「通过」：`待验收 → 待合并`；子任务父未 `已完成` → `409` `parent_not_completed`；**#54** 迁移前实时核对 forge 头，不一致 → `409` `head_sha_stale`（§17.7）；成功 `200` `{ task, round, head_sha, head_verified }`；成功后异步把 Draft 翻 ready（`scheduleWriteback` 同模式，不阻塞响应），可选摘要评论 |
| `POST /api/v1/tasks/:publicId/review/withdraw` | 「撤回通过」：`待合并 → 待修改`（`verdict = withdrawn` 的新一轮） |
| `POST /api/v1/tasks/:publicId/review/terminate` | 「终止本次交付」：`待验收 / 待修改 / 待合并 → 已退回`（`verdict = terminated`） |
| `GET /api/v1/stream` | SSE（§17.5） |

翻 ready 失败不回滚 `待合并`：写失败 outcome（`回写` 事件 `transition: '翻ready'`），`retryPendingWritebacks` 同款重试；成功写 `events` `评审通过`（`details` `{ task_id, round, pr_url, head_sha, head_verified }`，#54）。翻 ready / 摘要评论走服务端解密后出站，从不返回 token。

### 17.3 Agent 侧（MCP）

见 §9 表。要点：认领 `待修改` 任务后先调 `get_review_feedback`，把 Review Brief 作为本轮 mission 输入；在同一 PR 上推新提交；期间可 `post_discussion_message`（`answer` / `resolution` / `question`）；改完调 `submit_revision`（新 `head_sha`）交回 `待验收`，租约释放。修订 Claim 中途 `release_task` 或租约过期 → 任务回 `待修改`，不是 `待认领`。评审文本进入 Agent 上下文时带 `source_trust`；`author_kind = forge` 的消息按导入 Issue 同级对待（非受信）。

### 17.4 依赖子任务与 restack

- 发布：`POST /api/v1/tasks` 可带 `parent_task_id`（父任务 `kt-…`）；父不存在 → `400` `invalid_body`；父为终态（`已完成` / `已取消`）、指向自身、或形成环 → `409` `parent_invalid`。
- 认领门闩：父任务状态 ∉ {`待验收`, `待修改`, `待合并`, `已完成`} 时子任务不可认领（`409` `parent_not_ready`）。
- 通过门闩：父任务 ≠ `已完成` 时子任务不可「通过」（`409` `parent_not_completed`）。
- 派生 `base_branch`：见 §6。
- restack：父任务转 `已完成` 时，服务端对每个子任务：追加一条 `system` 消息与一轮 `kind = restack`（`details` 含新基线分支与父 PR URL）；子任务处于 `待验收` → `待修改`；处于 `待认领` / `进行中` / `待修改` / `待合并` 只追加不翻状态。写 `events` `restack`。
- 反向意见：子任务 Agent 通过 `open_review_round` 把父任务打回 `待修改`（§9）。
- 父 `已退回` / `已取消`：子任务追加 `system` 消息提示，不自动取消，由发布者决定取消或改父。

### 17.5 SSE

`GET /api/v1/stream`：会话；`待批准` 或无会话 → `401`。`Content-Type: text/event-stream`。事件 `task_updated`（`{ task_id, status }`）、`progress`（`{ task_id, percent, phase }`；不含 `note`）、`review_round`（`{ task_id, round, kind, verdict }`）、`discussion_message`（`{ task_id, message_id, kind, author_kind }`）；体只含 `task_id` 与短摘要，永不含 token、`body_md` 长文本或密文。每 30s 一条注释行 `: ping` 心跳。服务关闭时所有连接被关闭，无悬挂计时器。写入点：状态迁移（claim / release / 过期 / submit / revision / 评审动作 / poller / webhook / 发布者 PATCH）、`report_progress`、评审动作、讨论消息、poller 观察到 forge 头变化（#54，`task_updated`，状态不变）。

### 17.6 不变式

- token 只在 REST claim `201` 与 MCP `claim_task` 成功揭示；Review Brief、讨论消息、SSE、评审 REST、所有新增响应、日志、`events.details` 不得出现 token / ciphertext。
- 翻 ready / 摘要评论走服务端解密后出站（同 poller / writeback），从不返回。
- 评审文本进入 Agent 上下文时带 `source_trust`。
- 一任务一 PR，forward-only。
- 三家 adapter 行为一致，新增方法全部进共享集成测试合同。
- 状态值使用本文中文规范值；UI 中文。
- 服务端不运行 Agent、Workflow、git；不解冲突、不 rebase、不 merge、不 approve。
- 不做合并队列；不向下线的 Agent 推送；不引入服务端长轮询等待工具。
- **#54** 评审判定锚定到记录的 `head_sha`：「通过」只对 forge 上当前头等于记录头的 PR 生效；forge 不可达时的放行必须以 `head_verified: false` 留痕。

### 17.7 评审锚定核对（#54）

#53 把 Agent 自报的 `head_sha` 直接写入 `submissions` / `submission_revisions`，poller 只在记录为空时补齐；Agent 交回后再推的提交考拉看不见，「通过」翻 ready 的却是 forge 当前头。本节把「评审锚定到具体 commit」落成合同。

- **观察**：poller 每次拉取（不只是首次）把 `getPullRequest().head_sha`（非空时）写入 `submissions.forge_head_sha`，`forge_head_seen_at` = 观察时刻；既有的 NULL-only 补齐 `head_sha` / `head_branch` / `is_draft` 不变。观察值相对上一次发生变化时发 SSE `task_updated`（状态不变），评审面板据此刷新。webhook 模式实例不轮询，因此只有「通过」时的实时核对。
- **暴露**：`GET …/review` 顶层增加 `forge_head_sha`（可空）、`forge_head_seen_at`（可空）、`head_stale`（仅当 `head_sha` 与 `forge_head_sha` 都已知且不相等时为 `true`）。面板在 `head_stale` 时显示「forge 头已变化：记录 `<12>`，forge 当前 `<12>`」并提示先「提交本轮意见」让 Agent 重新交回。Review Brief 形状不变。
- **核对**：「通过」在迁移事务之前用任务凭证读一次 `getPullRequest`（超时同翻 ready，`MARK_READY_TIMEOUT_MS`），并把读到的头写入 `forge_head_sha` / `forge_head_seen_at`：
  - 记录 `head_sha` 为空 → 用 forge 头补齐记录后放行，`head_verified: true`；
  - 相等 → 放行，`head_verified: true`；
  - 不等 → `409` `{ error: 'head_sha_stale', message, recorded_head_sha, forge_head_sha }`，不翻状态、不开轮、不写 `评审通过`；
  - forge 不可达 / 无头（异常、非 2xx、`head_sha === ''`）→ 与已存的 `forge_head_sha` 比较：存在且不等 → 同上 `409`；否则放行，`head_verified: false`。
  成功响应 `{ task, round, head_sha, head_verified }`；`评审通过` `details` 带 `head_sha`（放行时的记录头）与 `head_verified`。
- **交回**：`submit_pr` 新建行的 `forge_head_*` 为空；`submit_revision` 记录新 `head_sha` 时清空 `forge_head_*`。二者响应路径都不出站（trade-off：核对放在 poller 与「通过」，避免把 forge 往返放进 Agent 响应路径）。
- **补救**：`409 head_sha_stale` 后评审者写一条 `blocking` 消息并「提交本轮意见」→ `待修改`，Agent 认领后以新头 `submit_revision` 交回；不提供「采纳 forge 当前头」的一键动作，判定必须经 Agent 声明。
- **不变式**：新增字段与 `409` 体只含 sha / 时间戳 / 中文提示，不含 token、ciphertext、`body_md`；三家 adapter 的 `getPullRequest().head_sha` 语义不变（§11）。
- **forge 一致性**：核对对象是 forge 的 PR 对象报告的头，不是分支引用本身。GitLab 在 push 之后由后台任务刷新 MR `sha`（gitlab.com 实测有数秒滞后），Gitea 即时；滞后窗口内的「通过」按 forge 报告的旧头放行且 `head_verified: true`，poller 下一次拉取会把新头记入 `forge_head_sha` 并让面板显示 `head_stale`。考拉不为此轮询等待；这是 forge 的属性，记录于 `docs/smoke-test.md`。
