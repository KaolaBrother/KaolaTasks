# Architecture

Document system boundaries, major components, data flow, and deployment shape.

Currently defined in [DESIGN.md](DESIGN.md) §4 (架构), §10 (数据模型), §12 (部署). This file takes over as implementation diverges or adds detail beyond the design doc.

M0 tree: `apps/web`, `apps/server`, `packages/shared`, `packages/forge-adapters`. HTTP, MCP, and forge adapters remain unimplemented (`GET /` body `考拉任务服务占位`; `@kaola/forge-adapters` still exports only `getForgeAdaptersHealth()`). There is no product HTTP/MCP public API yet.

`@kaola/shared` now implements the Task Brief schema and lifecycle transitions specified in [DESIGN.md](DESIGN.md) §5–§6 (`taskBriefSchema` / `parseTaskBrief`, `transitionTaskStatus`). Legal edges in `packages/shared/src/index.ts`: 待认领 → 进行中, 已取消; 进行中 → 待认领, 待验收; 待验收 → 已完成, 已退回; 已退回 → 待认领, 已取消.

