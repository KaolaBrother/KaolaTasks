import Fastify from 'fastify'
import { registerAuth } from './auth.ts'
import { createDb } from './db.ts'
import { getPlaceholderBody } from './placeholder.ts'

export function buildApp(options?: { sqlitePath?: string }) {
  const db = createDb(options?.sqlitePath ?? ':memory:')
  const app = Fastify()
  app.addHook('onClose', () => {
    db.$client.close()
  })
  app.get('/', async (_request, reply) => {
    return reply.type('text/plain; charset=utf-8').send(getPlaceholderBody())
  })
  registerAuth(app, db)
  return app
}
