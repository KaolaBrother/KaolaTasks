import { createHash, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppDb } from './db.ts'
import { type AgentKey, type User, agentKeys, users } from './schema.ts'

declare module 'fastify' {
  interface FastifyRequest {
    agentAuth?: { user: User; key: AgentKey }
  }
}

function hashAgentKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

function digestEqual(hexA: string, hexB: string): boolean {
  try {
    const a = Buffer.from(hexA, 'hex')
    const b = Buffer.from(hexB, 'hex')
    if (a.length === 0 || a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function parseBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(\S+)/i.exec(header)
  return match?.[1]
}

export function sendBearerUnauthorized(reply: FastifyReply) {
  return reply.header('WWW-Authenticate', 'Bearer').code(401).send({ error: 'unauthorized' })
}

export function addAgentBearerHook(app: FastifyInstance, db: AppDb): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = parseBearerToken(request.headers.authorization)
    if (token == null) {
      return sendBearerUnauthorized(reply)
    }

    const presentedHash = hashAgentKey(token)
    const key = db.select().from(agentKeys).where(eq(agentKeys.keyHash, presentedHash)).get()
    if (key == null || !digestEqual(key.keyHash, presentedHash)) {
      return sendBearerUnauthorized(reply)
    }

    const user = db.select().from(users).where(eq(users.id, key.userId)).get()
    if (user == null) {
      return sendBearerUnauthorized(reply)
    }

    const now = Math.floor(Date.now() / 1000)
    db.update(agentKeys).set({ lastUsedAt: now }).where(eq(agentKeys.id, key.id)).run()
    request.agentAuth = { user, key }
  })
}
