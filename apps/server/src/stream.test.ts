import { describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import {
  PROVIDERS,
  applyOauthTestEnv,
  ensureSetup,
  loginViaCallback,
  nextAccessToken,
  openDb,
  seedUser,
  sqliteFile,
  stubUserinfoByAccessToken,
} from './auth.test-helpers.ts'
import type { CookieJar } from './auth.test-helpers.ts'

// Issue #53 §17.5 — GET /api/v1/stream (SSE) and the module-level publish seam.
applyOauthTestEnv({ VAULT_MASTER_KEY: 'ef'.repeat(32) })

const { buildApp } = await import('./app.ts')
const {
  STREAM_PING_INTERVAL_MS,
  closeAllStreams,
  openStreamCount,
  publishStreamEvent,
  setStreamPingIntervalMs,
} = await import('./stream.ts')

const STREAM_PATH = '/api/v1/stream'
const JSON_ACCEPT = { accept: 'application/json' }

type StreamHandle = {
  response: Response
  reader: ReadableStreamDefaultReader<Uint8Array>
  abort: () => void
}

function cookieHeader(cookies: CookieJar): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), Math.max(ms, 0))
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function listeningApp(t: TestContext, sqlitePath?: string) {
  const app: FastifyInstance = buildApp(sqlitePath != null ? { sqlitePath } : undefined)
  t.after(async () => {
    await app.close()
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address != null ? address.port : 0
  assert.ok(port > 0, 'test server must be listening on an ephemeral port')
  return { app, origin: `http://127.0.0.1:${port}` }
}

async function openStream(t: TestContext, origin: string, cookies: CookieJar): Promise<StreamHandle> {
  const controller = new AbortController()
  let aborted = false
  const abort = () => {
    if (aborted) return
    aborted = true
    controller.abort()
  }
  t.after(abort)
  const response = await withDeadline(
    fetch(`${origin}${STREAM_PATH}`, {
      headers: { cookie: cookieHeader(cookies), accept: 'text/event-stream' },
      signal: controller.signal,
    }),
    2_000,
    `GET ${STREAM_PATH}`,
  )
  assert.ok(response.body, 'SSE response must carry a body stream')
  return { response, reader: response.body.getReader(), abort }
}

// Reads until `predicate(text)` holds (returns `done: false`) or the server ends the stream
// (`done: true`). Throws on timeout so a missing frame fails loudly instead of hanging the suite.
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 2_000,
  label = 'stream text',
): Promise<{ text: string; done: boolean }> {
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (!predicate(text)) {
    const chunk = await withDeadline(reader.read(), deadline - Date.now(), label)
    if (chunk.done) return { text, done: true }
    text += decoder.decode(chunk.value, { stream: true })
  }
  return { text, done: false }
}

async function adminSession(app: FastifyInstance) {
  const session = await ensureSetup(app)
  assert.equal(session.body.status, 'active')
  return session.cookies
}

describe('issue #53 §17.5 GET /api/v1/stream (SSE)', { concurrency: false }, () => {
  test('publishStreamEvent with zero open connections is a no-op that does not throw', () => {
    assert.equal(openStreamCount(), 0)
    assert.doesNotThrow(() => {
      publishStreamEvent('task_updated', { task_id: 'kt-2026-0001', status: '进行中' })
    })
    assert.doesNotThrow(() => {
      closeAllStreams()
    })
    assert.equal(openStreamCount(), 0)
  })

  test('no session is 401 unauthorized', async (t) => {
    const app = buildApp()
    t.after(async () => {
      await app.close()
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: STREAM_PATH, headers: JSON_ACCEPT })
    assert.equal(res.statusCode, 401, res.body)
    assert.deepEqual(res.json(), { error: 'unauthorized' })
  })

  test('待批准 user is 401 unauthorized, same gate as GET /api/v1/events', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-stream-')
    const db = openDb(t, sqlitePath)
    seedUser(db, {
      provider: 'gitlab',
      remoteId: '5301',
      username: 'gl-stream-pending',
      displayName: 'Pending Stream',
      status: '待批准',
      permissionLevel: 'claim_only',
    })
    const app = buildApp({ sqlitePath })
    t.after(async () => {
      await app.close()
    })
    await app.ready()
    await ensureSetup(app)

    const profiles = new Map<string, unknown>()
    stubUserinfoByAccessToken(t, profiles)
    const accessToken = nextAccessToken('stream-pending')
    profiles.set(accessToken, { id: 5301, username: 'gl-stream-pending', name: 'Pending Stream' })
    const pending = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })
    assert.equal(pending.body.status, '待批准')

    const res = await app.inject({
      method: 'GET',
      url: STREAM_PATH,
      cookies: pending.cookies,
      headers: JSON_ACCEPT,
    })
    assert.equal(res.statusCode, 401, res.body)
    assert.deepEqual(res.json(), { error: 'unauthorized' })
  })

  test('an active session gets 200 text/event-stream and the : connected comment', async (t) => {
    const { app, origin } = await listeningApp(t)
    const cookies = await adminSession(app)

    const { response, reader, abort } = await openStream(t, origin, cookies)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-cache')
    assert.equal(response.headers.get('connection'), 'keep-alive')
    assert.equal(response.headers.get('x-accel-buffering'), 'no')

    const first = await readUntil(reader, (text) => text.includes(': connected'), 2_000, ': connected comment')
    assert.equal(first.done, false)
    assert.ok(first.text.startsWith(': connected\n\n'), JSON.stringify(first.text))
    assert.equal(openStreamCount(), 1)

    abort()
  })

  test('publishStreamEvent reaches an open connection as an event: progress block', async (t) => {
    const { app, origin } = await listeningApp(t)
    const cookies = await adminSession(app)
    const { reader, abort } = await openStream(t, origin, cookies)
    await readUntil(reader, (text) => text.includes(': connected'), 2_000, ': connected comment')

    const payload = { task_id: 'kt-2026-0001', percent: 40, phase: '跑测试' }
    publishStreamEvent('progress', payload)

    const received = await readUntil(
      reader,
      (text) => /event: progress\ndata: .+\n\n/.test(text),
      2_000,
      'progress event',
    )
    assert.equal(received.done, false)
    const match = /event: progress\ndata: (.+)\n\n/.exec(received.text)
    assert.ok(match, JSON.stringify(received.text))
    const data = JSON.parse(match[1]) as Record<string, unknown>
    assert.deepEqual(data, payload)
    assert.equal(Object.hasOwn(data, 'note'), false)
    assert.equal(Object.hasOwn(data, 'token'), false)
    assert.equal(received.text.includes('note'), false, received.text)
    assert.equal(received.text.includes('token'), false, received.text)

    abort()
  })

  test('a : ping comment arrives on the configured heartbeat interval', async (t) => {
    setStreamPingIntervalMs(20)
    t.after(() => {
      setStreamPingIntervalMs(STREAM_PING_INTERVAL_MS)
    })
    const { app, origin } = await listeningApp(t)
    const cookies = await adminSession(app)
    const { reader, abort } = await openStream(t, origin, cookies)

    const pinged = await readUntil(reader, (text) => text.includes(': ping\n\n'), 500, ': ping comment')
    assert.equal(pinged.done, false)

    abort()
  })

  test('app.close() ends every open stream and clears its ping timer', async (t) => {
    const { app, origin } = await listeningApp(t)
    const cookies = await adminSession(app)
    const { reader } = await openStream(t, origin, cookies)
    await readUntil(reader, (text) => text.includes(': connected'), 2_000, ': connected comment')
    assert.equal(openStreamCount(), 1)

    const closing = app.close()
    const tail = await readUntil(reader, () => false, 2_000, 'stream end after app.close()')
    assert.equal(tail.done, true, `stream should end on app.close(), trailing text: ${JSON.stringify(tail.text)}`)
    await withDeadline(closing, 2_000, 'app.close()')
    assert.equal(openStreamCount(), 0)
  })

  test('STREAM_PING_INTERVAL_MS is the 30s heartbeat from §17.5', () => {
    assert.equal(STREAM_PING_INTERVAL_MS, 30_000)
  })
})
