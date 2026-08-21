import { buildApp } from './app.ts'

const pollIntervalMs =
  process.env.POLL_INTERVAL_MS == null || process.env.POLL_INTERVAL_MS === ''
    ? 60000
    : Number.parseInt(process.env.POLL_INTERVAL_MS, 10)

const app = buildApp({
  sqlitePath: process.env.SQLITE_PATH ?? ':memory:',
  webDist: process.env.WEB_DIST,
  viteDevTarget: process.env.VITE_DEV_TARGET,
  pollIntervalMs,
})
const port = Number.parseInt(process.env.PORT ?? '31415', 10)
const host = process.env.HOST ?? '0.0.0.0'

await app.listen({ port, host })
