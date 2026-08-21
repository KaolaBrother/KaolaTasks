import { transitionTaskStatus } from '@kaola/shared'
import type { TaskStatus } from '@kaola/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { addAgentBearerHook, sendBearerUnauthorized } from './agent-bearer.ts'
import type { AppDb } from './db.ts'
import {
  LEASE_TTL_SECONDS,
  insertActiveLease,
  markLeaseReleased,
  renewActiveLease,
  selectActiveLease,
  sweepExpiredLeases,
  unixNow,
} from './leases.ts'
import { credentialProfiles, tasks } from './schema.ts'
import { selectTask, taskBrief } from './tasks.ts'
import { decryptToken, insertAuditEvent, isVaultUnconfiguredError } from './vault.ts'

const PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'
const TASK_ALREADY_CLAIMED_MESSAGE = '任务已被认领。'
const TASK_NOT_CLAIMED_MESSAGE = '任务未被认领。'
const STATUS_TRANSITION_EVENT = '状态迁移'
const TOKEN_REVEAL_EVENT = 'token 揭示'
const HEARTBEAT_EVENT = '心跳'
const CLONE_TOKEN_USAGE =
  'token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。'

function illegalTransitionMessage(from: string, to: string): string {
  return `任务状态不允许从「${from}」变更为「${to}」。`
}

function leaseEnvelope(expiresAt: number) {
  return {
    expires_at: new Date(expiresAt * 1000).toISOString(),
    ttl_seconds: LEASE_TTL_SECONDS,
  }
}

function readOptionalString(body: unknown, key: string): string | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function requireAgentAuth(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.agentAuth
  if (auth == null) {
    sendBearerUnauthorized(reply)
    return undefined
  }
  return auth
}

export function registerClaim(app: FastifyInstance, db: AppDb) {
  app.register(async function claimBearerContext(child) {
    addAgentBearerHook(child, db)

    child.post('/api/v1/tasks/:publicId/claim', async (request, reply) => {
      const auth = requireAgentAuth(request, reply)
      if (auth == null) return

      if (auth.user.status === '待批准') {
        return reply.code(403).send({ error: 'forbidden', message: PENDING_CLAIM_MESSAGE })
      }

      sweepExpiredLeases(db)

      const publicId = (request.params as { publicId: string }).publicId
      const row = selectTask(db, publicId)
      if (row == null) {
        return reply.code(404).send({ error: 'not_found' })
      }

      const from = row.task.status
      if (from === '进行中') {
        return reply.code(409).send({ error: 'conflict', message: TASK_ALREADY_CLAIMED_MESSAGE })
      }
      if (from !== '待认领') {
        return reply.code(409).send({
          error: 'illegal_transition',
          message: illegalTransitionMessage(from, '进行中'),
        })
      }

      let plaintext: string
      let revealDetails: {
        task_id: string
        agent_key_id: number
        credential: 'inline' | 'profile'
        profile_id?: number
      }
      try {
        if (row.task.credentialProfileId != null) {
          const profile = db
            .select()
            .from(credentialProfiles)
            .where(eq(credentialProfiles.id, row.task.credentialProfileId))
            .get()
          if (profile == null) {
            throw new Error('credential profile not found')
          }
          plaintext = decryptToken(profile.tokenEncrypted)
          revealDetails = {
            task_id: publicId,
            agent_key_id: auth.key.id,
            credential: 'profile',
            profile_id: profile.id,
          }
        } else {
          if (row.task.inlineTokenEncrypted == null) {
            throw new Error('task credential xor violated')
          }
          plaintext = decryptToken(row.task.inlineTokenEncrypted)
          revealDetails = {
            task_id: publicId,
            agent_key_id: auth.key.id,
            credential: 'inline',
          }
        }
      } catch (err) {
        if (isVaultUnconfiguredError(err)) {
          return reply.code(500).send({ error: 'vault_unconfigured' })
        }
        throw err
      }

      const now = unixNow()
      const to = transitionTaskStatus(from, '进行中') as TaskStatus
      const updated = db
        .update(tasks)
        .set({ status: to })
        .where(eq(tasks.id, row.task.id))
        .returning()
        .get()
      if (updated == null) {
        throw new Error('failed to update task status')
      }

      const lease = insertActiveLease(db, {
        taskId: row.task.id,
        claimerUserId: auth.user.id,
        agentKeyId: auth.key.id,
        now,
      })

      insertAuditEvent(db, {
        type: TOKEN_REVEAL_EVENT,
        actorUserId: auth.user.id,
        details: revealDetails,
      })
      insertAuditEvent(db, {
        type: STATUS_TRANSITION_EVENT,
        actorUserId: auth.user.id,
        details: { task_id: publicId, from, to },
      })

      const brief = taskBrief({ task: updated, posterUsername: row.posterUsername })
      return reply.code(201).send({
        task: brief,
        token: plaintext,
        lease: leaseEnvelope(lease.expiresAt),
        clone: {
          suggested_dir: brief.repo.suggested_dir,
          token_usage: CLONE_TOKEN_USAGE,
        },
      })
    })

    child.post('/api/v1/tasks/:publicId/progress', async (request, reply) => {
      const auth = requireAgentAuth(request, reply)
      if (auth == null) return

      sweepExpiredLeases(db)

      const publicId = (request.params as { publicId: string }).publicId
      const row = selectTask(db, publicId)
      if (row == null) {
        return reply.code(404).send({ error: 'not_found' })
      }

      const lease = selectActiveLease(db, row.task.id)
      if (lease == null) {
        return reply.code(409).send({ error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE })
      }
      if (lease.claimerUserId !== auth.user.id) {
        return reply.code(403).send({ error: 'forbidden' })
      }

      const now = unixNow()
      const expiresAt = renewActiveLease(db, lease.id, now)
      const note = readOptionalString(request.body, 'note') ?? ''
      insertAuditEvent(db, {
        type: HEARTBEAT_EVENT,
        actorUserId: auth.user.id,
        details: { task_id: publicId, note },
      })

      const fresh = selectTask(db, publicId)
      if (fresh == null) {
        throw new Error('task missing after heartbeat')
      }
      return reply.send({
        task: taskBrief(fresh),
        lease: leaseEnvelope(expiresAt),
      })
    })

    child.post('/api/v1/tasks/:publicId/release', async (request, reply) => {
      const auth = requireAgentAuth(request, reply)
      if (auth == null) return

      sweepExpiredLeases(db)

      const publicId = (request.params as { publicId: string }).publicId
      const row = selectTask(db, publicId)
      if (row == null) {
        return reply.code(404).send({ error: 'not_found' })
      }

      const lease = selectActiveLease(db, row.task.id)
      if (lease == null) {
        return reply.code(409).send({ error: 'conflict', message: TASK_NOT_CLAIMED_MESSAGE })
      }
      if (lease.claimerUserId !== auth.user.id) {
        return reply.code(403).send({ error: 'forbidden' })
      }

      const from = row.task.status
      const to = transitionTaskStatus(from, '待认领') as TaskStatus
      markLeaseReleased(db, lease.id)
      const updated = db
        .update(tasks)
        .set({ status: to })
        .where(eq(tasks.id, row.task.id))
        .returning()
        .get()
      if (updated == null) {
        throw new Error('failed to update task status')
      }

      const reason = readOptionalString(request.body, 'reason')
      const details =
        reason === undefined
          ? { task_id: publicId, from, to }
          : { task_id: publicId, from, to, reason }
      insertAuditEvent(db, {
        type: STATUS_TRANSITION_EVENT,
        actorUserId: auth.user.id,
        details,
      })

      return reply.send({
        task: taskBrief({ task: updated, posterUsername: row.posterUsername }),
      })
    })
  })
}
