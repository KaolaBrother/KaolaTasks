import { buildApp } from './app.ts'
import { db } from './db.ts'

db.$client.prepare('select 1').get()

const app = buildApp()
const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const host = process.env.HOST ?? '0.0.0.0'

await app.listen({ port, host })
