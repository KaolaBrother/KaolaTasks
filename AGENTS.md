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
- `docs/smoke-test.md` 中标记“配合”的浏览器、OAuth、token 和人工操作不得伪称已执行；无人值守只使用已提供的 GitLab/Gitea smoke streamer。

## Documentation

- `README.md`：项目入口
- `docs/DESIGN.md`：产品与架构合同
- `docs/architecture.md`：系统结构
- `docs/api.md`：接口合同
- `docs/conventions.md`：工程约定
- `docs/smoke-test.md`：真实联调步骤与记录
- `docs/workflow-default.md`：Claim 后默认直连 Kaola Workflow 的客户端指引
