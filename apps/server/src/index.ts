import { buildApp } from './app.ts'

const app = buildApp({ sqlitePath: process.env.SQLITE_PATH ?? ':memory:' })
const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const host = process.env.HOST ?? '0.0.0.0'

await app.listen({ port, host })
