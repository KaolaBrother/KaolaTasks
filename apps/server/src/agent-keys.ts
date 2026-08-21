import { createHash, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { addAgentBearerHook, sendBearerUnauthorized } from './agent-bearer.ts'
import { getSessionUser, sendUnauthorized } from './auth.ts'
import type { AppDb } from './db.ts'
import { type AgentKey, agentKeys } from './schema.ts'

const PENDING_GENERATE_MESSAGE = '你的账号待正式成员批准后方可生成 Agent Key。'

function hashAgentKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

function generatePlaintextKey(): string {
  return `ktk_${randomBytes(32).toString('hex')}`
}

function publicKey(row: AgentKey) {
  return {
    id: row.id,
    label: row.label,
    last_used_at: row.lastUsedAt ?? null,
  }
}

function labelFromBody(body: unknown): string {
  if (body == null || typeof body !== 'object') return ''
  const label = (body as { label?: unknown }).label
  return typeof label === 'string' ? label : ''
}

function parsePositiveInt(raw: string): number | undefined {
  const id = Number.parseInt(raw, 10)
  if (!Number.isInteger(id) || id <= 0) return undefined
  return id
}

export function registerAgentKeys(app: FastifyInstance, db: AppDb) {
  app.post('/api/v1/agent-keys', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
    if (user.status !== 'active') {
      return reply.code(403).send({ error: 'forbidden', message: PENDING_GENERATE_MESSAGE })
    }

    const label = labelFromBody(request.body)
    const plaintext = generatePlaintextKey()
    const keyHash = hashAgentKey(plaintext)
    const inserted = db
      .insert(agentKeys)
      .values({
        userId: user.id,
        keyHash,
        label,
        lastUsedAt: null,
      })
      .returning()
      .get()
    if (inserted == null) {
      throw new Error('failed to insert agent key')
    }

    return reply.code(201).send({
      id: inserted.id,
      label: inserted.label,
      token: plaintext,
      last_used_at: null,
    })
  })

  app.get('/api/v1/agent-keys', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
    if (user.status !== 'active') {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const rows = db.select().from(agentKeys).where(eq(agentKeys.userId, user.id)).all()
    return reply.send({ keys: rows.map(publicKey) })
  })

  app.delete('/api/v1/agent-keys/:id', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
    if (user.status !== 'active') {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const id = parsePositiveInt((request.params as { id: string }).id)
    if (id == null) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const deleted = db
      .delete(agentKeys)
      .where(and(eq(agentKeys.id, id), eq(agentKeys.userId, user.id)))
      .returning()
      .get()
    if (deleted == null) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return reply.send({ ok: true })
  })

  app.register(async function agentBearerContext(child) {
    addAgentBearerHook(child, db)

    child.get('/api/v1/agent/whoami', async (request, reply) => {
      const auth = request.agentAuth
      if (auth == null) {
        return sendBearerUnauthorized(reply)
      }
      return reply.send({
        id: auth.user.id,
        key_id: auth.key.id,
        label: auth.key.label,
        status: auth.user.status,
        permission_level: auth.user.permissionLevel,
      })
    })
  })
}
