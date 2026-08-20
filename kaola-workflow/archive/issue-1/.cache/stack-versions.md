# Stack versions (orchestrator notes, 2026-08-20)

knowledge-lookup was stopped after ~11 minutes without a landed report (read-only role; npm registry probes hung). Versions below are from npm/docs fetches the parent confirmed, not from that agent.

| Package | Version seen | Source |
| --- | --- | --- |
| vue | 3.5.41 | `npm view vue version` |
| naive-ui | 2.45.x (site 2.45.1; npm also listed 2.44.1/2.45.0) | npmjs.com/package/naive-ui, naiveui.com |
| fastify | 5.12.0; v5 requires Node 20+ | npmjs.com/package/fastify, fastify.dev migration guide |
| drizzle-orm SQLite drivers | libsql, `node:sqlite`, better-sqlite3 | https://orm.drizzle.team/docs/sqlite/get-started-sqlite |
| pnpm CI | `pnpm/setup` + `packageManager` field; Node 22 for this issue | https://pnpm.io/continuous-integration |
| Node | engines/CI: 22 (host is 24.14.0) | issue #1 |

Implementer is instructed to `pnpm add` current stables (no canary/rc) and pin `packageManager`.
