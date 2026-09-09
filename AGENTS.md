# Project Instructions

## Project

- Kaola Tasks 是内部中文任务协作平台：Agent 通过 MCP 认领任务，在真实 forge 仓库交付 PR。
- 平台只做路由与协调，不运行 Agent、不托管代码。
- 技术栈：Node.js 22+、TypeScript、Vue 3、Fastify、Drizzle/SQLite、MCP SDK、pnpm workspace。
- 结构：`apps/web`、`apps/server`、`apps/mcp`、`packages/shared`、`packages/forge-adapters`。
- Web 身份入口是本地管理员设置以及 GitLab/Gitea OAuth；没有 GitHub 登录，但仍支持 GitHub 仓库任务。

## Commands

- Install: `pnpm install`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Build: `pnpm build`
- Dev: `pnpm dev`
- Forge smoke: `pnpm smoke:forge -- gitlab|gitea`

## Project Constraints

- `docs/DESIGN.md` 是产品和公开合同的 source of truth；先改设计，再改 schema、状态机、adapter 或 MCP surface。
- GitHub、GitLab、Gitea adapter 保持行为一致，并共享集成测试合同。
- Forge token 不得进入日志、Task Brief、列表、详情、事件或非 claim 响应；只允许现有 REST claim `201` 和 MCP `claim_task` 成功响应揭示。
- Task 状态使用 `docs/DESIGN.md` 中的中文规范值。
- 用户界面使用中文。
- 冒烟与 UAT 记录只写 `docs/smoke-test.md`，不写进 GitHub Issue。历史路径 A/B/C 的「配合」仍表示真人在场步骤，**不得伪称已执行**。
- **本机隔离 Linux 全 Agent 路径（路径 L，#63）例外**：仅限本机隔离 UAT，不改变生产管理员授权规则。全程由 Agent 完成，不设等待人工门，必要时用 Computer Use / 浏览器自动化。所需 token/key 已在主仓 gitignored `.env`，读取但不输出、不索取、不把整份 `.env`/PAT 预装认领端。细则见下一节与 `docs/smoke-test.md` 顶部更正。

## 本机隔离 Linux 全 Agent smoke/UAT（路径 L，#63）

权威：Issue [#63](https://github.com/KaolaBrother/KaolaTasks/issues/63) 评论 [5596896971](https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5596896971) 优先于 [5596887868](https://github.com/KaolaBrother/KaolaTasks/issues/63#issuecomment-5596887868) 里「配合/等人批准」的句子。可执行步骤在 `docs/smoke-test.md`。

1. **作用域。** 只覆盖本机隔离拓扑（独立 Linux 服务端容器 + 独立干净 Linux 认领端 + 本机 TLS 入口）。不授权外部部署、不碰旧库与无关 Docker 容器、不改生产授权模型。
2. **执行者。** 配置、管理端真实登录与工作台配对批准、发布、认领 Agent 生产 MCP、GitLab/Gitea 完整交付与评审合并均由 Agent 做。管理端可用 Computer Use 操作真实工作台；认领端必须是独立 Linux 上的真实 Agent 会话 + 生产 `kaola-mcp` package-bin。`kaola-mcp pair --url` 是辅助 CLI，不是 MCP tool。缺少 Linux 认领承载时记「缺项」，不得用路径 B / `inject` / `pairDeviceToSelf` 顶替。
3. **禁止冒充新配对。** 不得直接改 SQLite、测试注入身份、或旧 `pairDeviceToSelf` 当作路径 L 的配对 PASS。不得把路径 B 脚本再加一次孤立 `pair` 拼成新机制全闭环通过。
4. **凭证隔离。** 发布/管理端才读主仓 `.env` 的 `GITLAB_TOKEN` / `GITEA_TOKEN`。认领端初始无额外根、无 receipt、无设备授权、无 forge PAT；只允许成功 `claim_task` 揭示该任务凭证。不输出 secret，不写入仓库/聊天/remote URL。
5. **信任拓扑。** 服务器 Linux ≠ 认领端 Linux。认领端独立空 `KAOLA_HOME`、默认信任库；不得预挂根、手工 `trust install`、手工 PEM/指纹/`NODE_EXTRA_CA_CERTS`/重启作为自动配对成功条件。CA 签发私钥只留隔离签发端。浏览器（管理端）信任与 MCP 用户级 v2 信任分开。
6. **同一闭环。** 真实 HTTPS 私有 CA → 未配对 `pairing_required` → `pair` → 工作台真实输入密语批准 → 严格 TLS + active `whoami` → v2 → 生产 MCP `list_tasks` / `claim_task` → clone/PR/`submit_pr` / 修订 / 合并 / `已完成` 与源 Issue 回写。GitLab 与 Gitea 各跑一遍。
7. **诚实记录。** 真实运行、可控时钟的自动测试、未执行项分清。不为了 24h/90d 改真实时钟。外部 OAuth 人机挑战若阻断则记阻塞，不伪造。Windows / macOS 物理客户端 / 公开 CA 干净机器不因本路径 Linux 通过而自动 PASS。

## Documentation

- `README.md`：项目入口
- `docs/DESIGN.md`：产品与架构合同
- `docs/architecture.md`：系统结构
- `docs/api.md`：接口合同
- `docs/conventions.md`：工程约定
- `docs/smoke-test.md`：真实联调步骤与记录（路径 L 设计在文件顶部）
- `docs/workflow-default.md`：Claim 后默认直连 Kaola Workflow 的客户端指引
- `docs/runner-carrier.md`：显式选用 Kaola Project Runner 承载的兼容性指引
