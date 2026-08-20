import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getSessionUser, sendUnauthorized } from './auth.ts'
import type { AppDb } from './db.ts'
import { type CredentialProfile, credentialProfiles } from './schema.ts'
import {
  encryptToken,
  insertAuditEvent,
  isVaultUnconfiguredError,
} from './vault.ts'

const FORGE_REVOKE_MESSAGE = '请同时到 forge 侧撤销该 token。'
const FORGES = new Set(['github', 'gitlab', 'gitea'])

function canManageProfiles(user: { status: string; permissionLevel: string }): boolean {
  return user.status === 'active' && user.permissionLevel === 'full'
}

function parseScopes(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function publicProfile(row: CredentialProfile) {
  return {
    id: row.id,
    forge: row.forge,
    base_url: row.baseUrl,
    repo_full_name: row.repoFullName,
    scopes_checked: parseScopes(row.scopesChecked),
    created_by: row.createdBy,
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  let current: unknown = err
  for (let i = 0; i < 4 && current != null; i += 1) {
    if (typeof current === 'object') {
      const code = 'code' in current ? String(current.code) : ''
      const message = 'message' in current ? String(current.message) : ''
      if (
        code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        code === 'SQLITE_CONSTRAINT' ||
        /UNIQUE/i.test(message)
      ) {
        return true
      }
      current = 'cause' in current ? current.cause : undefined
    } else {
      return /UNIQUE/i.test(String(current))
    }
  }
  return false
}

function parsePositiveInt(raw: string): number | undefined {
  const id = Number.parseInt(raw, 10)
  if (!Number.isInteger(id) || id <= 0) return undefined
  return id
}

function readCreateBody(body: unknown):
  | { forge: 'github' | 'gitlab' | 'gitea'; baseUrl: string; repoFullName: string; token: string }
  | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const raw = body as {
    forge?: unknown
    base_url?: unknown
    repo_full_name?: unknown
    token?: unknown
  }
  if (typeof raw.forge !== 'string' || !FORGES.has(raw.forge)) return undefined
  if (typeof raw.base_url !== 'string' || raw.base_url === '') return undefined
  if (typeof raw.repo_full_name !== 'string' || raw.repo_full_name === '') return undefined
  if (typeof raw.token !== 'string' || raw.token === '') return undefined
  return {
    forge: raw.forge as 'github' | 'gitlab' | 'gitea',
    baseUrl: raw.base_url,
    repoFullName: raw.repo_full_name,
    token: raw.token,
  }
}

export function registerCredentialProfiles(app: FastifyInstance, db: AppDb) {
  app.get('/api/v1/credential-profiles', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
    if (!canManageProfiles(user)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const rows = db.select().from(credentialProfiles).all()
    return reply.send({ profiles: rows.map(publicProfile) })
  })

  app.post('/api/v1/credential-profiles', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
    if (!canManageProfiles(user)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const parsed = readCreateBody(request.body)
    if (parsed == null) {
      return reply.code(400).send({ error: 'invalid_body' })
    }

    let tokenEncrypted: string
    try {
      tokenEncrypted = encryptToken(parsed.token)
    } catch (err) {
      if (isVaultUnconfiguredError(err)) {
        return reply.code(500).send({ error: 'vault_unconfigured' })
      }
      throw err
    }

    try {
      const inserted = db
        .insert(credentialProfiles)
        .values({
          forge: parsed.forge,
          baseUrl: parsed.baseUrl,
          repoFullName: parsed.repoFullName,
          tokenEncrypted,
          scopesChecked: '[]',
          createdBy: user.id,
        })
        .returning()
        .get()
      if (inserted == null) {
        throw new Error('failed to insert credential profile')
      }
      insertAuditEvent(db, {
        type: '变更',
        actorUserId: user.id,
        details: { action: 'create', profile_id: inserted.id },
      })
      return reply.code(201).send(publicProfile(inserted))
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({ error: 'conflict' })
      }
      throw err
    }
  })

  app.delete('/api/v1/credential-profiles/:id', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
    if (!canManageProfiles(user)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const id = parsePositiveInt((request.params as { id: string }).id)
    if (id == null) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const deleted = db
      .delete(credentialProfiles)
      .where(eq(credentialProfiles.id, id))
      .returning()
      .get()
    if (deleted == null) {
      return reply.code(404).send({ error: 'not_found' })
    }
    insertAuditEvent(db, {
      type: '变更',
      actorUserId: user.id,
      details: { action: 'delete', profile_id: deleted.id },
    })
    return reply.send({ ok: true, message: FORGE_REVOKE_MESSAGE })
  })
}
