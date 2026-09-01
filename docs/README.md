# Documentation Index

- [User guide](../README.md) — how to log in, publish tasks, and connect an Agent
- [生产向部署](../README.md#生产向部署) — 内网 + 公网入口短清单；#46 双模式 `DEBUG_PRIVATE_CA` / `STABLE_PUBLIC_CA`（文档只用占位符）
- [安装与证书信任](../README.md#安装与证书信任) — #48 双模式 MCP 安装：`kaola-mcp trust` + launcher 只从已核验 state 注入额外 CA（DESIGN §16 / §16.7；系统/浏览器提权另一次）
- [Design (source of truth)](DESIGN.md)
- [Architecture](architecture.md)
- [API](api.md)
- [Conventions](conventions.md)
- [Decisions](decisions/)
- [默认直连 Kaola Workflow](workflow-default.md) — Claim 之后的默认执行承载与目标映射
- [Kaola Project Runner 承载兼容性](runner-carrier.md) — 显式选用 Runner 承载的指引与秘密边界
- [Changelog](../CHANGELOG.md)
- [Forge smoke playbook](smoke-test.md) — GitLab / Gitea publish loop (not GitHub); **配合** steps wait for the human; Agent 注入跑 `pnpm smoke:forge -- gitlab|gitea`（PAT 真、考拉进程假：脚本自己补 session/vault/OAuth 占位）
