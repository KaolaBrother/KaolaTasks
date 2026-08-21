import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getSessionUser, sendUnauthorized } from './auth.ts'
import type { AppDb } from './db.ts'
import { events, users } from './schema.ts'

const PENDING_STATUS = '待批准'
const STATUS_TRANSITION_EVENT = '状态迁移'
const COMPLETED_STATUS = '已完成'
const SYSTEM_ACTOR_LABEL = '系统'

function parseDetails(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

// events/stats gate 待批准 out — stricter than GET /api/v1/tasks, which lets them read the board.
function canReadEvents(user: { status: string }): boolean {
  return user.status !== PENDING_STATUS
}

export function registerEvents(app: FastifyInstance, db: AppDb) {
  app.get('/api/v1/events', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null || !canReadEvents(user)) return sendUnauthorized(request, reply)

    const rows = db
      .select({
        id: events.id,
        type: events.type,
        actorUserId: events.actorUserId,
        actorUsername: users.username,
        createdAt: events.createdAt,
        details: events.details,
      })
      .from(events)
      .leftJoin(users, eq(events.actorUserId, users.id))
      .orderBy(desc(events.id))
      .all()

    return reply.send({
      events: rows.map((row) => ({
        id: row.id,
        type: row.type,
        actor_user_id: row.actorUserId,
        actor_username: row.actorUsername,
        created_at: new Date(row.createdAt * 1000).toISOString(),
        details: parseDetails(row.details),
      })),
    })
  })

  app.get('/api/v1/stats', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null || !canReadEvents(user)) return sendUnauthorized(request, reply)

    const rows = db
      .select({
        actorUserId: events.actorUserId,
        actorUsername: users.username,
        details: events.details,
      })
      .from(events)
      .leftJoin(users, eq(events.actorUserId, users.id))
      .where(eq(events.type, STATUS_TRANSITION_EVENT))
      .all()

    let completedCount = 0
    const completedByUsername: Record<string, number> = {}
    for (const row of rows) {
      const details = parseDetails(row.details)
      if (details.to !== COMPLETED_STATUS) continue
      completedCount += 1
      const key = row.actorUserId == null ? SYSTEM_ACTOR_LABEL : row.actorUsername ?? SYSTEM_ACTOR_LABEL
      completedByUsername[key] = (completedByUsername[key] ?? 0) + 1
    }

    return reply.send({ completed_count: completedCount, completed_by_username: completedByUsername })
  })
}
