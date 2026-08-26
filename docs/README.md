# Documentation Index

- [User guide](../README.md) — how to log in, publish tasks, and connect an Agent
- [生产向部署](../README.md#生产向部署) — 内网 + 公网入口短清单
- [Design (source of truth)](DESIGN.md)
- [Architecture](architecture.md)
- [API](api.md)
- [Conventions](conventions.md)
- [Decisions](decisions/)
- [Changelog](../CHANGELOG.md)
- [Forge smoke playbook](smoke-test.md) — GitLab / Gitea publish loop (not GitHub); **配合** steps wait for the human; Agent 注入跑 `pnpm smoke:forge -- gitlab|gitea`（PAT 真、考拉进程假：脚本自己补 session/vault/OAuth 占位）
