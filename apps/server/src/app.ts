import { resolve } from 'node:path'
import fastifyStatic from '@fastify/static'
import httpProxy from '@fastify/http-proxy'
import Fastify from 'fastify'
import { registerAgentKeys } from './agent-keys.ts'
import { registerAuth } from './auth.ts'
import { registerClaim } from './claim.ts'
import { registerCredentialProfiles } from './credential-profiles.ts'
import { createDb } from './db.ts'
import { registerMcp } from './mcp.ts'
import { getPlaceholderBody } from './placeholder.ts'
import { registerTasks } from './tasks.ts'

function nonemptyOption(value: string | undefined): string | undefined {
  return value != null && value !== '' ? value : undefined
}

function requestPath(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

function isApiOrLoginPath(url: string): boolean {
  const path = requestPath(url)
  return path === '/api' || path.startsWith('/api/') || path.startsWith('/login')
}

export function buildApp(options?: {
  sqlitePath?: string
  webDist?: string
  viteDevTarget?: string
}) {
  const db = createDb(options?.sqlitePath ?? ':memory:')
  const app = Fastify()
  app.addHook('onClose', () => {
    db.$client.close()
  })

  const webDist = nonemptyOption(options?.webDist)
  const viteDevTarget = nonemptyOption(options?.viteDevTarget)

  if (webDist == null && viteDevTarget == null) {
    app.get('/', async (_request, reply) => {
      return reply.type('text/plain; charset=utf-8').send(getPlaceholderBody())
    })
  }

  registerAuth(app, db)
  registerAgentKeys(app, db)
  registerCredentialProfiles(app, db)
  registerTasks(app, db)
  registerClaim(app, db)
  registerMcp(app, db)

  if (webDist != null) {
    const root = resolve(webDist)
    app.register(fastifyStatic, { root })
    app.get('/', async (_request, reply) => {
      return reply.sendFile('index.html')
    })
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !isApiOrLoginPath(request.url)) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: 'Not Found',
        statusCode: 404,
      })
    })
  } else if (viteDevTarget != null) {
    app.register(httpProxy, {
      upstream: viteDevTarget,
      websocket: true,
      httpMethods: ['GET', 'HEAD'],
      preHandler: (request, reply, done) => {
        if (isApiOrLoginPath(request.url)) {
          reply.callNotFound()
          return
        }
        done()
      },
    })
  }

  return app
}
