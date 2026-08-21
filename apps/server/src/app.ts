import { resolve } from 'node:path'
import fastifyStatic from '@fastify/static'
import httpProxy from '@fastify/http-proxy'
import Fastify from 'fastify'
import { registerAgentKeys } from './agent-keys.ts'
import { registerAuth } from './auth.ts'
import { registerClaim } from './claim.ts'
import { registerClaimConfirmations } from './claim-confirmations.ts'
import { registerCredentialProfiles } from './credential-profiles.ts'
import { createDb } from './db.ts'
import { registerEvents } from './events.ts'
import { registerMcp } from './mcp.ts'
import { getPlaceholderBody } from './placeholder.ts'
import { pollPendingReviews, retryPendingWritebacks } from './poller.ts'
import type { ForgeInstanceConfig } from './poller.ts'
import { registerTasks } from './tasks.ts'
import { registerWebhooks } from './webhook.ts'

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
  pollIntervalMs?: number
  forgeInstances?: ForgeInstanceConfig[]
}) {
  const db = createDb(options?.sqlitePath ?? ':memory:')
  const app = Fastify()
  app.addHook('onClose', () => {
    db.$client.close()
  })

  const forgeInstances = options?.forgeInstances

  const pollIntervalMs = options?.pollIntervalMs
  if (pollIntervalMs != null && pollIntervalMs > 0) {
    // Registered inside a child plugin context (mirrors mcp.ts's `mcpBearerContext`): Fastify
    // runs child-plugin `onClose` hooks before parent/root-level ones, so `clearInterval` here is
    // guaranteed to fire before the root db-close hook above, regardless of source order.
    app.register(async function pollerContext(child) {
      // In-flight guard: a pass that outlives `pollIntervalMs` (a slow/hanging forge) must not
      // let the next tick re-poll the same rows and duplicate 状态迁移 events. `.catch()` is
      // belt-and-suspenders — `pollPendingReviews` itself is written to never reject.
      //
      // Issue #14: `retryPendingWritebacks` runs the same tick, sequentially after
      // `pollPendingReviews`, under the same in-flight guard — avoids overlapping SQLite writes
      // and, like `pollPendingReviews`, must never reject.
      let polling = false
      const timer = setInterval(() => {
        if (polling) return
        polling = true
        pollPendingReviews(db, forgeInstances)
          .catch(() => {})
          .then(() => retryPendingWritebacks(db).catch(() => {}))
          .finally(() => {
            polling = false
          })
      }, pollIntervalMs)
      child.addHook('onClose', () => {
        clearInterval(timer)
        polling = false
      })
    })
  }

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
  registerClaimConfirmations(app, db)
  registerEvents(app, db)
  registerMcp(app, db)
  registerWebhooks(app, db, forgeInstances)

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
