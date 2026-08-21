import Fastify from 'fastify'
import { registerAgentKeys } from './agent-keys.ts'
import { registerAuth } from './auth.ts'
import { registerCredentialProfiles } from './credential-profiles.ts'
import { createDb } from './db.ts'
import { getPlaceholderBody } from './placeholder.ts'
import { registerTasks } from './tasks.ts'

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
  registerAgentKeys(app, db)
  registerCredentialProfiles(app, db)
  registerTasks(app, db)
  return app
}
