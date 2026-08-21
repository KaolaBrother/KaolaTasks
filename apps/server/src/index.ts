import { buildApp } from './app.ts'
import type { ForgeInstanceConfig } from './poller.ts'

const pollIntervalMs =
  process.env.POLL_INTERVAL_MS == null || process.env.POLL_INTERVAL_MS === ''
    ? 60000
    : Number.parseInt(process.env.POLL_INTERVAL_MS, 10)

// Unset/empty → no instances configured (every 待验收 row is polled, same as before this issue).
// Invalid JSON fails boot rather than silently falling back to poll-everything.
function readForgeInstances(): ForgeInstanceConfig[] {
  const raw = process.env.FORGE_INSTANCES
  if (raw == null || raw === '') return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error('FORGE_INSTANCES must be a JSON array')
  }
  return parsed as ForgeInstanceConfig[]
}

const app = buildApp({
  sqlitePath: process.env.SQLITE_PATH ?? ':memory:',
  webDist: process.env.WEB_DIST,
  viteDevTarget: process.env.VITE_DEV_TARGET,
  pollIntervalMs,
  forgeInstances: readForgeInstances(),
})
const port = Number.parseInt(process.env.PORT ?? '31415', 10)
const host = process.env.HOST ?? '0.0.0.0'

await app.listen({ port, host })
