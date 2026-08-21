import { WebhookSignatureError, createForgeAdapter } from '@kaola/forge-adapters'
import type { ForgeEvent } from '@kaola/forge-adapters'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { AppDb } from './db.ts'
import { applyPrTerminalTransition, latestSubmission, taskMatchesForgeInstance } from './poller.ts'
import type { ForgeInstanceConfig } from './poller.ts'
import { type Task, tasks } from './schema.ts'

// Issue #13: `POST /api/v1/webhooks/:publicId` — `:publicId` identifies a `forgeInstances[]`
// entry (not a task). No session, no Bearer: the forge signature is the sole auth. Every
// successful delivery (ping, irrelevant, no-match, completed) answers 204 with an empty body;
// only an unknown instance (404) and a bad/missing signature (401) differ. This route never
// decrypts a forge token and never calls `getPullRequest` — the payload is the source of truth
// for merge/close, mirroring the poller's transaction (poller.ts's `applyPrTerminalTransition`)
// without its forge round-trip.

const PENDING_REVIEW_STATUS = '待验收'

function headersFromRaw(raw: unknown): Headers {
  const headers = new Headers()
  if (raw == null || typeof raw !== 'object') return headers
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      headers.set(key, value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') headers.append(key, item)
      }
    }
  }
  return headers
}

// Bound to the signature-verified `instance` the delivery arrived on (same (forge, base_url)
// equality `isWebhookManaged` in poller.ts uses): a pr_url that matches a task owned by a
// different forge instance is treated as no-match, never as this task's delivery.
function findPendingReviewMatch(
  db: AppDb,
  instance: ForgeInstanceConfig,
  prUrl: string,
): { task: Task; submissionId: number } | undefined {
  const pending = db.select().from(tasks).where(eq(tasks.status, PENDING_REVIEW_STATUS)).all()
  for (const task of pending) {
    if (!taskMatchesForgeInstance(task, instance)) continue
    const submission = latestSubmission(db, task.id)
    if (submission != null && submission.prUrl === prUrl) {
      return { task, submissionId: submission.id }
    }
  }
  return undefined
}

export function registerWebhooks(
  app: FastifyInstance,
  db: AppDb,
  forgeInstances: ForgeInstanceConfig[] = [],
) {
  app.register(async function webhookContext(child) {
    // Fastify's default JSON parser would re-serialize the body before this handler ever sees
    // it, breaking HMAC verification over the raw bytes. Scoped to this plugin context only —
    // no other route in the app is affected.
    child.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body)
      },
    )

    child.post('/api/v1/webhooks/:publicId', async (request, reply) => {
      const publicId = (request.params as { publicId: string }).publicId
      const instance = forgeInstances.find((entry) => entry.publicId === publicId)
      if (instance == null) {
        return reply.code(404).send({ error: 'not_found' })
      }

      const adapter = createForgeAdapter(instance.forge, {
        baseUrl: instance.baseUrl,
        webhookSecret: instance.webhookSecret,
      })
      const headers = headersFromRaw(request.headers)

      let event: ForgeEvent | null
      try {
        event = adapter.parseWebhook(headers, request.body as string)
      } catch (err) {
        if (err instanceof WebhookSignatureError) {
          return reply.code(401).send({ error: 'invalid_signature' })
        }
        throw err
      }

      if (event == null) {
        return reply.code(204).send()
      }

      const match = findPendingReviewMatch(db, instance, event.pr_url)
      if (match == null) {
        return reply.code(204).send()
      }

      applyPrTerminalTransition(db, match.task, match.submissionId, event.state, event.pr_url)
      return reply.code(204).send()
    })
  })
}
