import type { Socket } from 'node:net'
import type { ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { getSessionUser, sendUnauthorized } from './auth.ts'
import type { AppDb } from './db.ts'

export const STREAM_PING_INTERVAL_MS = 30_000

const PENDING_STATUS = '待批准'

export type StreamEventName = 'task_updated' | 'progress' | 'review_round' | 'discussion_message'

// Security review R3: a session may hold at most this many concurrent streams; opening one more
// ends that user's oldest. Each connection carries a heartbeat timer, so the bound is per user.
export const STREAMS_PER_USER_MAX = 8

type StreamConnection = {
  // The app that served this connection. `app.close()` must end only its own streams: several
  // apps live in one process during tests, and they all share the module-level registry below.
  owner: FastifyInstance
  userId: number
  raw: ServerResponse
  socket: Socket | null
  timer: NodeJS.Timeout
}

// Module-level so any writer (claim / release / poller / webhook / review / discussion) can
// broadcast without holding a handle to the Fastify instance. `publishStreamEvent` fans out to
// every app's connections; the per-app shutdown hook below only ends its own.
const connections = new Set<StreamConnection>()

let defaultPingIntervalMs = STREAM_PING_INTERVAL_MS

// Test seam. `buildApp()` wires `registerStream(app, db)` with no options, so the suite needs a
// way to shorten the 30s heartbeat without app.ts growing an option for it. Production never
// calls this; `registerStream`'s own `pingIntervalMs` option wins over it.
export function setStreamPingIntervalMs(intervalMs: number): void {
  defaultPingIntervalMs = intervalMs > 0 ? intervalMs : STREAM_PING_INTERVAL_MS
}

function forget(connection: StreamConnection): void {
  clearInterval(connection.timer)
  connections.delete(connection)
}

// Never throws: a dead socket removes its connection and the caller keeps going.
function writeFrame(connection: StreamConnection, frame: string): void {
  if (connection.raw.writableEnded || connection.raw.destroyed) {
    forget(connection)
    return
  }
  try {
    connection.raw.write(frame)
  } catch {
    forget(connection)
  }
}

function endConnection(connection: StreamConnection): void {
  forget(connection)
  const { raw, socket } = connection
  try {
    if (raw.writableEnded) {
      socket?.end()
      return
    }
    // FIN after the final chunk, not a destroy: the client still reads the terminator, and the
    // socket does not linger as an idle keep-alive one that would stall `server.close()`.
    raw.end(() => {
      socket?.end()
    })
  } catch {
    socket?.destroy()
  }
}

export function openStreamCount(): number {
  return connections.size
}

export function closeAllStreams(): void {
  for (const connection of [...connections]) endConnection(connection)
}

export function publishStreamEvent(name: StreamEventName, payload: Record<string, unknown>): void {
  if (connections.size === 0) return
  let frame: string
  try {
    // Payload is written as given — callers own its shape (and its no-token invariant).
    frame = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
  } catch {
    // A circular or otherwise unserializable payload is a caller bug; it must not take down the
    // write path it was published from.
    return
  }
  for (const connection of [...connections]) writeFrame(connection, frame)
}

export function registerStream(app: FastifyInstance, db: AppDb, options?: { pingIntervalMs?: number }) {
  const configuredPingIntervalMs = options?.pingIntervalMs

  app.get('/api/v1/stream', async (request, reply) => {
    // Same gate as GET /api/v1/events: no session or a 待批准 user is 401.
    const user = getSessionUser(db, request)
    if (user == null || user.status === PENDING_STATUS) return sendUnauthorized(request, reply)

    const pingIntervalMs =
      configuredPingIntervalMs != null && configuredPingIntervalMs > 0
        ? configuredPingIntervalMs
        : defaultPingIntervalMs

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    raw.write(': connected\n\n')

    const mine = [...connections].filter((c) => c.owner === app && c.userId === user.id)
    for (const stale of mine.slice(0, Math.max(0, mine.length - (STREAMS_PER_USER_MAX - 1)))) {
      endConnection(stale)
    }

    const connection: StreamConnection = {
      owner: app,
      userId: user.id,
      raw,
      socket: raw.socket,
      timer: setInterval(() => {
        writeFrame(connection, ': ping\n\n')
      }, pingIntervalMs),
    }
    connections.add(connection)

    request.raw.on('close', () => {
      forget(connection)
    })
  })

  // `preClose`, not `onClose`: Fastify's own server-closing hook is registered last and therefore
  // runs *first* on `app.close()`, and `server.close()` waits for this still-open SSE response —
  // an `onClose` hook (even in a child plugin) would never be reached. `preClose` runs before the
  // server close, and Fastify's runner walks child instances too, so root level is enough here.
  // Only this app's connections are ended: several apps share the module-level registry.
  app.addHook('preClose', () => {
    for (const connection of [...connections]) {
      if (connection.owner === app) endConnection(connection)
    }
  })
}
