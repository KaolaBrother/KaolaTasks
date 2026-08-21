import { createForgeAdapter } from '@kaola/forge-adapters'
import type { ForgeKind, TokenCapability, TokenCheck } from '@kaola/forge-adapters'
import { taskStatusSchema, transitionTaskStatus } from '@kaola/shared'
import type { TaskStatus } from '@kaola/shared'
import { desc, eq, like, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getSessionUser, sendUnauthorized } from './auth.ts'
import type { AppDb } from './db.ts'
import { type NewTask, type Task, credentialProfiles, tasks, users } from './schema.ts'
import {
  decryptToken,
  encryptToken,
  insertAuditEvent,
  isVaultUnconfiguredError,
} from './vault.ts'

const TOKEN_INVALID_MESSAGE = 'token 无效或无权访问该仓库，任务未发布。'
const FORGE_UNREACHABLE_MESSAGE = '无法连接 forge 校验 token，任务未发布。'
const PROFILE_MISSING_MESSAGE = '所选凭证档案不存在。'
const PROFILE_REPO_MISMATCH_MESSAGE = '所选凭证档案与仓库不匹配。'
const REPO_BASE_URL_INVALID_MESSAGE = '仓库地址不是合法的 http 或 https 地址。'
const STATUS_TRANSITION_EVENT = '状态迁移'
const TOKEN_REVEAL_EVENT = 'token 揭示'

const FORGES = new Set(['github', 'gitlab', 'gitea'])
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3'])

// DESIGN.md §5: 发布者 may cancel a task or reopen a returned one. Every other edge in the shared
// state machine belongs to a claim (MCP) or to the PR webhook, so it is refused here.
const POSTER_TRANSITIONS: ReadonlyMap<string, ReadonlySet<TaskStatus>> = new Map([
  ['待认领', new Set<TaskStatus>(['已取消'])],
  ['已退回', new Set<TaskStatus>(['已取消', '待认领'])],
])

// public_id is allocated from the current year's sequence, so a collision needs another writer on
// the same database file. Retry a bounded number of times rather than spinning.
const PUBLIC_ID_ATTEMPTS = 5

type TaskPriority = Task['priority']

type SourceInput = { type: 'native' } | { type: 'imported'; issueUrl: string }

type RepoInput = {
  forge: ForgeKind
  baseUrl: string
  fullName: string
  baseBranch: string
  suggestedDir: string
}

type CredentialInput = { profileId: number } | { token: string }

type CreateTaskInput = {
  title: string
  descriptionMd: string
  source: SourceInput
  repo: RepoInput
  acceptanceCriteria: string[]
  testCommand: string
  allowedPaths: string[]
  forbiddenPaths: string[]
  priority: TaskPriority
  tags: string[]
  credential: CredentialInput
}

type TaskWithPoster = { task: Task; posterUsername: string | null }

function tokenCheckMessage(missing: TokenCapability[]): string {
  // Losing 读 means the token cannot see the repo at all — a different diagnosis from a token
  // that reads fine but lacks write capabilities.
  if (missing.includes('读')) return TOKEN_INVALID_MESSAGE
  return `token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。`
}

function illegalTransitionMessage(from: string, to: string): string {
  return `任务状态不允许从「${from}」变更为「${to}」。`
}

// DESIGN.md §11: 发布任务 belongs to the same GitLab/Gitea population as 管理凭证档案.
function canPostTasks(user: { status: string; permissionLevel: string }): boolean {
  return user.status === 'active' && user.permissionLevel === 'full'
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function readStringArray(value: unknown, fallback: string[]): string[] | undefined {
  if (value === undefined) return fallback
  if (!Array.isArray(value)) return undefined
  if (!value.every((item) => typeof item === 'string')) return undefined
  return value as string[]
}

function defaultSuggestedDir(fullName: string): string {
  const segments = fullName.split('/')
  return segments[segments.length - 1] ?? fullName
}

function readSource(value: unknown): SourceInput | undefined {
  if (value === undefined) return { type: 'native' }
  if (value == null || typeof value !== 'object') return undefined
  const raw = value as { type?: unknown; issue_url?: unknown }
  if (raw.type === 'native') return { type: 'native' }
  if (raw.type === 'imported') {
    if (typeof raw.issue_url !== 'string' || raw.issue_url === '') return undefined
    return { type: 'imported', issueUrl: raw.issue_url }
  }
  return undefined
}

function readRepo(value: unknown): RepoInput | undefined {
  if (value == null || typeof value !== 'object') return undefined
  const raw = value as {
    forge?: unknown
    base_url?: unknown
    full_name?: unknown
    base_branch?: unknown
    suggested_dir?: unknown
  }
  if (typeof raw.forge !== 'string' || !FORGES.has(raw.forge)) return undefined
  if (typeof raw.base_url !== 'string' || raw.base_url === '') return undefined
  if (typeof raw.full_name !== 'string' || raw.full_name === '') return undefined
  const baseBranch = raw.base_branch === undefined ? 'main' : raw.base_branch
  if (typeof baseBranch !== 'string' || baseBranch === '') return undefined
  const suggestedDir =
    raw.suggested_dir === undefined ? defaultSuggestedDir(raw.full_name) : raw.suggested_dir
  if (typeof suggestedDir !== 'string' || suggestedDir === '') return undefined
  return {
    forge: raw.forge as ForgeKind,
    baseUrl: raw.base_url,
    fullName: raw.full_name,
    baseBranch,
    suggestedDir,
  }
}

// Dedicated POST check (not folded into readRepo): generic parse failures stay `{ error:
// 'invalid_body' }` with no message; a non-http(s) or empty-host base_url is a pinned 400.
function isHttpOrHttpsUrlWithHost(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return parsed.hostname !== ''
}

function insertTokenRevealEvent(
  db: AppDb,
  input: {
    actorUserId: number
    profileId: number
    forge: ForgeKind
    baseUrl: string
    fullName: string
    outcome: 'ok' | 'token_check_failed' | 'forge_unreachable'
  },
): void {
  insertAuditEvent(db, {
    type: TOKEN_REVEAL_EVENT,
    actorUserId: input.actorUserId,
    details: {
      profile_id: input.profileId,
      forge: input.forge,
      base_url: input.baseUrl,
      full_name: input.fullName,
      outcome: input.outcome,
    },
  })
}

function readConstraints(
  value: unknown,
): { allowedPaths: string[]; forbiddenPaths: string[] } | undefined {
  if (value === undefined) return { allowedPaths: [], forbiddenPaths: [] }
  if (value == null || typeof value !== 'object') return undefined
  const raw = value as { allowed_paths?: unknown; forbidden_paths?: unknown }
  const allowedPaths = readStringArray(raw.allowed_paths, [])
  const forbiddenPaths = readStringArray(raw.forbidden_paths, [])
  if (allowedPaths == null || forbiddenPaths == null) return undefined
  return { allowedPaths, forbiddenPaths }
}

function readProfileId(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const id = Number.parseInt(value, 10)
    return Number.isInteger(id) && id > 0 ? id : undefined
  }
  return undefined
}

// The request carries real token material, so it is a { profile_id } XOR { token } union — a
// deliberately different shape from the brief's { profile_id } / { inline: true }, which must
// never carry a token.
function readCredential(value: unknown): CredentialInput | undefined {
  if (value == null || typeof value !== 'object') return undefined
  const raw = value as { profile_id?: unknown; token?: unknown }
  const hasProfileId = raw.profile_id !== undefined
  const hasToken = raw.token !== undefined
  if (hasProfileId === hasToken) return undefined
  if (hasProfileId) {
    const profileId = readProfileId(raw.profile_id)
    return profileId == null ? undefined : { profileId }
  }
  if (typeof raw.token !== 'string' || raw.token === '') return undefined
  return { token: raw.token }
}

// id / pr_convention / poster / status / created_at are server-owned: a client that sends them is
// simply not read, matching every other hand-parsed body reader in this codebase.
function readCreateBody(body: unknown): CreateTaskInput | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const raw = body as {
    title?: unknown
    description_md?: unknown
    source?: unknown
    repo?: unknown
    acceptance_criteria?: unknown
    test_command?: unknown
    constraints?: unknown
    priority?: unknown
    tags?: unknown
    credential?: unknown
  }

  if (typeof raw.title !== 'string' || raw.title === '') return undefined

  const descriptionMd = raw.description_md === undefined ? '' : raw.description_md
  if (typeof descriptionMd !== 'string') return undefined

  const source = readSource(raw.source)
  if (source == null) return undefined

  const repo = readRepo(raw.repo)
  if (repo == null) return undefined

  const acceptanceCriteria = readStringArray(raw.acceptance_criteria, [])
  if (acceptanceCriteria == null) return undefined

  const testCommand = raw.test_command === undefined ? '' : raw.test_command
  if (typeof testCommand !== 'string') return undefined

  const constraints = readConstraints(raw.constraints)
  if (constraints == null) return undefined

  const priority = raw.priority === undefined ? 'P2' : raw.priority
  if (typeof priority !== 'string' || !PRIORITIES.has(priority)) return undefined

  const tags = readStringArray(raw.tags, [])
  if (tags == null) return undefined

  const credential = readCredential(raw.credential)
  if (credential == null) return undefined

  return {
    title: raw.title,
    descriptionMd,
    source,
    repo,
    acceptanceCriteria,
    testCommand,
    allowedPaths: constraints.allowedPaths,
    forbiddenPaths: constraints.forbiddenPaths,
    priority: priority as TaskPriority,
    tags,
    credential,
  }
}

function readStatusBody(body: unknown): TaskStatus | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const parsed = taskStatusSchema.safeParse((body as { status?: unknown }).status)
  return parsed.success ? parsed.data : undefined
}

function nextPosterStatus(from: string, to: TaskStatus): TaskStatus | undefined {
  if (!POSTER_TRANSITIONS.get(from)?.has(to)) return undefined
  // @kaola/shared owns the lifecycle graph; the poster subset above only narrows it.
  return transitionTaskStatus(from, to) as TaskStatus
}

// DESIGN.md §6 — the brief is the whole contract, and the only credential it ever names is a
// reference.
function taskBrief({ task, posterUsername }: TaskWithPoster) {
  return {
    id: task.publicId,
    title: task.title,
    description_md: task.descriptionMd,
    source:
      task.sourceType === 'imported'
        ? { type: 'imported', issue_url: task.sourceIssueUrl ?? '' }
        : { type: 'native' },
    repo: {
      forge: task.repoForge,
      base_url: task.repoBaseUrl,
      full_name: task.repoFullName,
      base_branch: task.repoBaseBranch,
      suggested_dir: task.repoSuggestedDir,
    },
    acceptance_criteria: parseStringArray(task.acceptanceCriteria),
    test_command: task.testCommand,
    constraints: {
      allowed_paths: parseStringArray(task.allowedPaths),
      forbidden_paths: parseStringArray(task.forbiddenPaths),
    },
    pr_convention: {
      branch_prefix: `kaola/${task.publicId}-`,
      title_prefix: `[${task.publicId}] `,
    },
    credential:
      task.credentialProfileId == null
        ? { inline: true }
        : { profile_id: String(task.credentialProfileId) },
    priority: task.priority,
    tags: parseStringArray(task.tags),
    poster: posterUsername ?? '',
    status: task.status,
    // Stored as unix seconds like every other timestamp in this schema; the brief projects it.
    created_at: new Date(task.createdAt * 1000).toISOString(),
  }
}

function selectTasks(db: AppDb): TaskWithPoster[] {
  return db
    .select({ task: tasks, posterUsername: users.username })
    .from(tasks)
    .leftJoin(users, eq(tasks.posterUserId, users.id))
    .orderBy(tasks.id)
    .all()
}

function selectTask(db: AppDb, publicId: string): TaskWithPoster | undefined {
  return db
    .select({ task: tasks, posterUsername: users.username })
    .from(tasks)
    .leftJoin(users, eq(tasks.posterUserId, users.id))
    .where(eq(tasks.publicId, publicId))
    .get()
}

// kt-YYYY-NNNN, counting from 1 within the current year. The suffix is ordered numerically rather
// than lexically so the sequence keeps climbing once it outgrows four digits.
function nextPublicId(db: AppDb, year: string): string {
  const prefix = `kt-${year}-`
  const latest = db
    .select({ publicId: tasks.publicId })
    .from(tasks)
    .where(like(tasks.publicId, `${prefix}%`))
    .orderBy(desc(sql`CAST(substr(${tasks.publicId}, ${prefix.length + 1}) AS INTEGER)`))
    .limit(1)
    .get()
  const previous = latest == null ? 0 : Number.parseInt(latest.publicId.slice(prefix.length), 10)
  const sequence = (Number.isInteger(previous) ? previous : 0) + 1
  return `${prefix}${String(sequence).padStart(4, '0')}`
}

function isPublicIdCollision(err: unknown): boolean {
  if (err == null || typeof err !== 'object' || !('message' in err)) return false
  return /UNIQUE constraint failed: tasks\.public_id/i.test(String(err.message))
}

function insertTask(db: AppDb, values: Omit<NewTask, 'publicId'>): Task {
  const year = String(new Date().getUTCFullYear())
  for (let attempt = 1; attempt <= PUBLIC_ID_ATTEMPTS; attempt += 1) {
    try {
      const inserted = db
        .insert(tasks)
        .values({ ...values, publicId: nextPublicId(db, year) })
        .returning()
        .get()
      if (inserted == null) {
        throw new Error('failed to insert task')
      }
      return inserted
    } catch (err) {
      if (attempt < PUBLIC_ID_ATTEMPTS && isPublicIdCollision(err)) continue
      throw err
    }
  }
  throw new Error('failed to allocate a task public id')
}

export function registerTasks(app: FastifyInstance, db: AppDb) {
  // DESIGN.md §11 grants 查看任务板 to every logged-in user, 待批准 GitHub accounts included.
  app.get('/api/v1/tasks', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)

    return reply.send({ tasks: selectTasks(db).map(taskBrief) })
  })

  app.get('/api/v1/tasks/:publicId', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)

    const row = selectTask(db, (request.params as { publicId: string }).publicId)
    if (row == null) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return reply.send(taskBrief(row))
  })

  app.post('/api/v1/tasks', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
    if (!canPostTasks(user)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const input = readCreateBody(request.body)
    if (input == null) {
      return reply.code(400).send({ error: 'invalid_body' })
    }
    if (!isHttpOrHttpsUrlWithHost(input.repo.baseUrl)) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: REPO_BASE_URL_INVALID_MESSAGE,
      })
    }

    let credentialProfileId: number | null = null
    let inlineTokenEncrypted: string | null = null
    let plaintext: string
    if ('profileId' in input.credential) {
      const profile = db
        .select()
        .from(credentialProfiles)
        .where(eq(credentialProfiles.id, input.credential.profileId))
        .get()
      if (profile == null) {
        return reply.code(400).send({ error: 'invalid_body', message: PROFILE_MISSING_MESSAGE })
      }
      if (
        input.repo.forge !== profile.forge ||
        input.repo.baseUrl !== profile.baseUrl ||
        input.repo.fullName !== profile.repoFullName
      ) {
        return reply.code(400).send({
          error: 'invalid_body',
          message: PROFILE_REPO_MISMATCH_MESSAGE,
        })
      }
      credentialProfileId = profile.id
      try {
        plaintext = decryptToken(profile.tokenEncrypted)
      } catch (err) {
        if (isVaultUnconfiguredError(err)) {
          return reply.code(500).send({ error: 'vault_unconfigured' })
        }
        throw err
      }
    } else {
      plaintext = input.credential.token
      try {
        inlineTokenEncrypted = encryptToken(plaintext)
      } catch (err) {
        if (isVaultUnconfiguredError(err)) {
          return reply.code(500).send({ error: 'vault_unconfigured' })
        }
        throw err
      }
    }

    // DESIGN.md §5 发布即校验 — a task whose token fails the check is never persisted.
    const adapter = createForgeAdapter(input.repo.forge, { baseUrl: input.repo.baseUrl })
    let check: TokenCheck
    try {
      check = await adapter.validateToken(
        { token: plaintext },
        { full_name: input.repo.fullName, base_url: input.repo.baseUrl },
      )
    } catch {
      // validateToken has no try/catch of its own: an unreachable forge rejects rather than
      // reporting missing capabilities, and that is a different verdict.
      if (credentialProfileId != null) {
        insertTokenRevealEvent(db, {
          actorUserId: user.id,
          profileId: credentialProfileId,
          forge: input.repo.forge,
          baseUrl: input.repo.baseUrl,
          fullName: input.repo.fullName,
          outcome: 'forge_unreachable',
        })
      }
      return reply
        .code(502)
        .send({ error: 'forge_unreachable', message: FORGE_UNREACHABLE_MESSAGE })
    }
    if (check.missing.length > 0) {
      if (credentialProfileId != null) {
        insertTokenRevealEvent(db, {
          actorUserId: user.id,
          profileId: credentialProfileId,
          forge: input.repo.forge,
          baseUrl: input.repo.baseUrl,
          fullName: input.repo.fullName,
          outcome: 'token_check_failed',
        })
      }
      return reply.code(422).send({
        error: 'token_check_failed',
        missing: check.missing,
        message: tokenCheckMessage(check.missing),
      })
    }

    if (credentialProfileId != null) {
      insertTokenRevealEvent(db, {
        actorUserId: user.id,
        profileId: credentialProfileId,
        forge: input.repo.forge,
        baseUrl: input.repo.baseUrl,
        fullName: input.repo.fullName,
        outcome: 'ok',
      })
    }

    const inserted = insertTask(db, {
      title: input.title,
      descriptionMd: input.descriptionMd,
      sourceType: input.source.type,
      sourceIssueUrl: input.source.type === 'imported' ? input.source.issueUrl : null,
      repoForge: input.repo.forge,
      repoBaseUrl: input.repo.baseUrl,
      repoFullName: input.repo.fullName,
      repoBaseBranch: input.repo.baseBranch,
      repoSuggestedDir: input.repo.suggestedDir,
      acceptanceCriteria: JSON.stringify(input.acceptanceCriteria),
      testCommand: input.testCommand,
      allowedPaths: JSON.stringify(input.allowedPaths),
      forbiddenPaths: JSON.stringify(input.forbiddenPaths),
      priority: input.priority,
      tags: JSON.stringify(input.tags),
      credentialProfileId,
      inlineTokenEncrypted,
      posterUserId: user.id,
      status: '待认领',
      createdAt: Math.floor(Date.now() / 1000),
    })

    return reply.code(201).send(taskBrief({ task: inserted, posterUsername: user.username }))
  })

  // DESIGN.md §5: 发布者取消 / 发布者重新开放. Claiming and 验收 are not poster edits.
  app.patch('/api/v1/tasks/:publicId', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
    if (!canPostTasks(user)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const publicId = (request.params as { publicId: string }).publicId
    const row = selectTask(db, publicId)
    if (row == null) {
      return reply.code(404).send({ error: 'not_found' })
    }
    if (row.task.posterUserId !== user.id) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const requested = readStatusBody(request.body)
    if (requested == null) {
      return reply.code(400).send({ error: 'invalid_body' })
    }

    const from = row.task.status
    const to = nextPosterStatus(from, requested)
    if (to == null) {
      return reply
        .code(409)
        .send({ error: 'illegal_transition', message: illegalTransitionMessage(from, requested) })
    }

    const updated = db
      .update(tasks)
      .set({ status: to })
      .where(eq(tasks.id, row.task.id))
      .returning()
      .get()
    if (updated == null) {
      throw new Error('failed to update task status')
    }
    insertAuditEvent(db, {
      type: STATUS_TRANSITION_EVENT,
      actorUserId: user.id,
      details: { task_id: publicId, from, to },
    })

    return reply.send(taskBrief({ task: updated, posterUsername: row.posterUsername }))
  })
}
