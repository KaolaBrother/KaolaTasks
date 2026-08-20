import Fastify from 'fastify'
import { getPlaceholderBody } from './placeholder.ts'

export function buildApp() {
  const app = Fastify()
  app.get('/', async (_request, reply) => {
    return reply.type('text/plain; charset=utf-8').send(getPlaceholderBody())
  })
  return app
}
