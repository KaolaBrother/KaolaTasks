import cookie from '@fastify/cookie'
import oauthPlugin from '@fastify/oauth2'
import session from '@fastify/session'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import type { AppDb } from './db.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { canManageInstance, isLoginableAdmin } from './permissions.ts'
import { type User, users } from './schema.ts'
import { insertAuditEvent } from './vault.ts'

const PENDING_STATUS = '待批准'
const PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'
type OauthProvider = 'gitlab' | 'gitea'

type OAuth2Decorator = {
  getAccessTokenFromAuthorizationCodeFlow: (
    request: FastifyRequest,
    reply?: FastifyReply,
  ) => Promise<{ token: { access_token: string } }>
}

declare module 'fastify' {
  interface FastifyInstance {
    gitlabOAuth2: OAuth2Decorator
    giteaOAuth2: OAuth2Decorator
  }

  interface Session {
    userId?: number
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value == null || value === '') {
    throw new Error(`missing required environment variable ${name}`)
  }
  return value
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function publicUrlFromEnv(): string {
  return trimTrailingSlash(process.env.PUBLIC_URL ?? 'http://localhost:31415')
}

/** True when PUBLIC_URL (trailing slash trimmed) is https — drives cookie Secure and trustProxy. */
export function cookieSecureFromPublicUrl(): boolean {
  return publicUrlFromEnv().startsWith('https:')
}

/** Loopback + RFC1918 peers for TLS-terminating proxies. Never hop-count `1` (Fastify 5.12.1 no-op) or `true`. */
export const COOKIE_SECURE_TRUST_PROXY = [
  '127.0.0.1',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
] as const

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export function wantsJson(request: FastifyRequest): boolean {
  const accept = request.headers.accept
  return typeof accept === 'string' && accept.includes('application/json')
}

export function sendUnauthorized(request: FastifyRequest, reply: FastifyReply) {
  if (wantsJson(request)) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
  return reply.redirect('/login')
}

function publicUser(user: User) {
  const body: {
    id: number
    provider: User['provider']
    remote_id: string
    username: string
    display_name: string
    status: User['status']
    permission_level: User['permissionLevel']
    trusted_automation: boolean
    message?: string
  } = {
    id: user.id,
    provider: user.provider,
    remote_id: user.remoteId,
    username: user.username,
    display_name: user.displayName,
    status: user.status,
    permission_level: user.permissionLevel,
    trusted_automation: user.trustedAutomation,
  }
  if (user.status === PENDING_STATUS) {
    body.message = PENDING_CLAIM_MESSAGE
  }
  return body
}

function listedUser(user: User) {
  return {
    id: user.id,
    provider: user.provider,
    username: user.username,
    display_name: user.displayName,
    status: user.status,
    permission_level: user.permissionLevel,
  }
}

function readTrustedAutomation(body: unknown): boolean | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const value = (body as { trusted_automation?: unknown }).trusted_automation
  return typeof value === 'boolean' ? value : undefined
}

function userinfoUrl(provider: OauthProvider, gitlabBaseUrl: string, giteaBaseUrl: string): string {
  if (provider === 'gitlab') return `${gitlabBaseUrl}/api/v4/user`
  return `${giteaBaseUrl}/api/v1/user`
}

function mapProfile(provider: OauthProvider, profile: Record<string, unknown>) {
  if (provider === 'gitlab') {
    return {
      remoteId: String(profile.id),
      username: String(profile.username),
      displayName: String(profile.name),
    }
  }
  const username = String(profile.login)
  return {
    remoteId: String(profile.id),
    username,
    displayName: nonemptyString(profile.full_name) ?? username,
  }
}

export function countLoginableAdmins(db: AppDb): number {
  return db
    .select()
    .from(users)
    .all()
    .filter((row) => isLoginableAdmin(row)).length
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
        /UNIQUE constraint failed/i.test(message)
      ) {
        return true
      }
      current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined
      continue
    }
    break
  }
  return false
}

function completeUserLogin(
  db: AppDb,
  provider: OauthProvider,
  profile: ReturnType<typeof mapProfile>,
): { user?: User; redirect: string } {
  const existing = db
    .select()
    .from(users)
    .where(and(eq(users.provider, provider), eq(users.remoteId, profile.remoteId)))
    .get()

  if (existing) {
    db.update(users)
      .set({
        username: profile.username,
        displayName: profile.displayName,
      })
      .where(eq(users.id, existing.id))
      .run()
    const updated = {
      ...existing,
      username: profile.username,
      displayName: profile.displayName,
    }
    if (updated.status === 'revoked') {
      return { redirect: '/login?reason=revoked' }
    }
    return { user: updated, redirect: '/' }
  }

  if (countLoginableAdmins(db) === 0) {
    return { redirect: '/login' }
  }

  const inserted = db
    .insert(users)
    .values({
      provider,
      remoteId: profile.remoteId,
      username: profile.username,
      displayName: profile.displayName,
      status: 'active',
      permissionLevel: 'full',
    })
    .returning()
    .get()

  if (inserted == null) {
    throw new Error('failed to insert user')
  }
  return { user: inserted, redirect: '/' }
}

export function getSessionUser(db: AppDb, request: FastifyRequest): User | undefined {
  const userId = request.session.userId
  if (userId == null) return undefined
  return db.select().from(users).where(eq(users.id, userId)).get()
}

function oauthOf(app: FastifyInstance, provider: OauthProvider): OAuth2Decorator {
  const decoratorName = `${provider}OAuth2` as const
  const oauth = app[decoratorName]
  if (oauth == null || typeof oauth.getAccessTokenFromAuthorizationCodeFlow !== 'function') {
    throw new Error(`${decoratorName} is not registered`)
  }
  return oauth
}

function wizardPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>初始向导 · 考拉任务</title>
  </head>
  <body>
    <h1>考拉任务登录</h1>
    <p>创建本地管理员账号以完成初始向导。</p>
    <form method="post" action="/api/v1/setup">
      <label>用户名 <input name="username" autocomplete="username" /></label>
      <label>密码 <input name="password" type="password" autocomplete="new-password" /></label>
      <button type="submit">创建管理员</button>
    </form>
  </body>
</html>`
}

function loginPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>登录 · 考拉任务</title>
  </head>
  <body>
    <h1>考拉任务登录</h1>
    <form method="post" action="/api/v1/login">
      <label>用户名 <input name="username" autocomplete="username" /></label>
      <label>密码 <input name="password" type="password" autocomplete="current-password" /></label>
      <button type="submit">登录</button>
    </form>
    <p>或使用团队 forge 账号登录：</p>
    <ul>
      <li><a href="/login/gitlab">使用 GitLab 登录</a></li>
      <li><a href="/login/gitea">使用 Gitea 登录</a></li>
    </ul>
  </body>
</html>`
}

function oauthTokenErrorMessage(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined
  const data = (err as { data?: unknown }).data
  const payload =
    data != null && typeof data === 'object' && 'payload' in data
      ? (data as { payload?: unknown }).payload
      : data
  if (payload != null && typeof payload === 'object') {
    const description = (payload as { error_description?: unknown }).error_description
    if (typeof description === 'string' && description.length > 0 && description.length < 400) {
      return description
    }
    const error = (payload as { error?: unknown }).error
    if (typeof error === 'string' && error.length > 0 && error.length < 80) {
      return error
    }
  }
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

function shouldSkipSessionSave(request: FastifyRequest): boolean {
  return request.session.cookie.secure === true && request.protocol !== 'https'
}

async function persistSession(
  request: FastifyRequest,
  userId: number,
  opts?: { skipUntrusted?: boolean },
): Promise<boolean> {
  request.session.userId = userId
  if (opts?.skipUntrusted === true && shouldSkipSessionSave(request)) return false
  await request.session.save()
  return true
}

async function completeOAuthLogin(
  app: FastifyInstance,
  db: AppDb,
  provider: OauthProvider,
  gitlabBaseUrl: string,
  giteaBaseUrl: string,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  let accessToken: string
  try {
    const { token } = await oauthOf(app, provider).getAccessTokenFromAuthorizationCodeFlow(
      request,
      reply,
    )
    accessToken = token.access_token
  } catch (err) {
    const detail = oauthTokenErrorMessage(err)
    return reply.code(502).send({
      error: 'oauth_token_failed',
      message: detail ?? '无法向登录提供方换取令牌。',
    })
  }
  const response = await fetch(userinfoUrl(provider, gitlabBaseUrl, giteaBaseUrl), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'kaola-tasks',
    },
  })
  if (!response.ok) {
    return reply.code(502).send({ error: 'userinfo_failed' })
  }
  const raw: unknown = await response.json()
  if (raw == null || typeof raw !== 'object') {
    return reply.code(502).send({ error: 'userinfo_invalid' })
  }
  const mapped = mapProfile(provider, raw as Record<string, unknown>)
  const outcome = completeUserLogin(db, provider, mapped)
  if (outcome.user == null) {
    return reply.redirect(outcome.redirect)
  }
  const saved = await persistSession(request, outcome.user.id, { skipUntrusted: true })
  if (!saved) {
    return reply.redirect(outcome.redirect)
  }
  return reply.redirect(outcome.redirect)
}

function sendGithubGone(_request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({ error: 'not_found' })
}

function findLocalUser(db: AppDb, username: string): User | undefined {
  const needle = username.trim().toLowerCase()
  if (needle === '') return undefined
  return db
    .select()
    .from(users)
    .all()
    .find((row) => row.provider === 'local' && row.username.trim().toLowerCase() === needle)
}

export function registerAuth(app: FastifyInstance, db: AppDb) {
  // Compose still supplies unused GitHub OAuth client env; required so boot does not change.
  requireEnv('OAUTH_GITHUB_CLIENT_ID')
  requireEnv('OAUTH_GITHUB_CLIENT_SECRET')
  const sessionSecret = requireEnv('SESSION_SECRET')
  const publicUrl = publicUrlFromEnv()
  const cookieSecure = cookieSecureFromPublicUrl()
  const gitlabClientId = requireEnv('OAUTH_GITLAB_CLIENT_ID')
  const gitlabClientSecret = requireEnv('OAUTH_GITLAB_CLIENT_SECRET')
  const gitlabBaseUrl = trimTrailingSlash(requireEnv('OAUTH_GITLAB_BASE_URL'))
  const giteaClientId = requireEnv('OAUTH_GITEA_CLIENT_ID')
  const giteaClientSecret = requireEnv('OAUTH_GITEA_CLIENT_SECRET')
  const giteaBaseUrl = trimTrailingSlash(requireEnv('OAUTH_GITEA_BASE_URL'))

  const oauthCookie = { path: '/' as const, secure: cookieSecure }

  app.addHook('preParsing', (request, _reply, payload, done) => {
    if (request.method !== 'POST') {
      done(null, payload)
      return
    }
    const url = request.url.split('?')[0] ?? ''
    if (!url.startsWith('/api/v1/users/')) {
      done(null, payload)
      return
    }
    const chunks: Buffer[] = []
    payload.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    payload.on('end', () => {
      const raw = Buffer.concat(chunks)
      const next = raw.length === 0 ? Buffer.from('{}') : raw
      done(null, Readable.from([next]))
    })
    payload.on('error', (err: Error) => done(err, undefined))
  })

  app.register(cookie)
  app.register(session, {
    secret: sessionSecret,
    cookie: { path: '/', secure: cookieSecure, httpOnly: true, sameSite: 'lax' },
    saveUninitialized: false,
  })

  app.register(oauthPlugin, {
    name: 'gitlabOAuth2',
    scope: ['read_user'],
    pkce: 'S256',
    credentials: {
      client: { id: gitlabClientId, secret: gitlabClientSecret },
      auth: {
        authorizeHost: gitlabBaseUrl,
        authorizePath: '/oauth/authorize',
        tokenHost: gitlabBaseUrl,
        tokenPath: '/oauth/token',
      },
      options: {
        authorizationMethod: 'body',
      },
    },
    startRedirectPath: '/login/gitlab',
    callbackUri: `${publicUrl}/login/gitlab/callback`,
    cookie: oauthCookie,
  })
  app.register(oauthPlugin, {
    name: 'giteaOAuth2',
    scope: ['read:user'],
    credentials: {
      client: { id: giteaClientId, secret: giteaClientSecret },
      auth: {
        authorizeHost: giteaBaseUrl,
        authorizePath: '/login/oauth/authorize',
        tokenHost: giteaBaseUrl,
        tokenPath: '/login/oauth/access_token',
      },
    },
    startRedirectPath: '/login/gitea',
    callbackUri: `${publicUrl}/login/gitea/callback`,
    cookie: oauthCookie,
  })

  app.get('/login/github', sendGithubGone)
  app.get('/login/github/callback', sendGithubGone)
  app.post('/api/v1/users/:id/approve', async (_request, reply) => {
    return reply.code(404).send({ error: 'not_found' })
  })

  app.get('/login', async (_request, reply) => {
    const html = countLoginableAdmins(db) > 0 ? loginPageHtml() : wizardPageHtml()
    return reply.type('text/html; charset=utf-8').send(html)
  })

  app.get('/login/gitlab/callback', async (request, reply) => {
    return completeOAuthLogin(app, db, 'gitlab', gitlabBaseUrl, giteaBaseUrl, request, reply)
  })
  app.get('/login/gitea/callback', async (request, reply) => {
    return completeOAuthLogin(app, db, 'gitea', gitlabBaseUrl, giteaBaseUrl, request, reply)
  })

  app.get('/api/v1/setup', async (_request, reply) => {
    return reply.send({ setup_complete: countLoginableAdmins(db) > 0 })
  })

  app.post('/api/v1/setup', async (request, reply) => {
    if (countLoginableAdmins(db) > 0) {
      return reply.code(409).send({ error: 'setup_complete' })
    }
    const body = request.body as { username?: unknown; password?: unknown; display_name?: unknown }
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (username === '' || password === '') {
      return reply.code(400).send({ error: 'invalid_body' })
    }
    const displayName =
      typeof body?.display_name === 'string' && body.display_name.trim() !== ''
        ? body.display_name.trim()
        : username
    const passwordHash = await hashPassword(password)
    let inserted: User
    try {
      const row = db
        .insert(users)
        .values({
          provider: 'local',
          remoteId: 'local',
          username,
          displayName,
          status: 'active',
          permissionLevel: 'admin',
          passwordHash,
        })
        .returning()
        .get()
      if (row == null) throw new Error('failed to insert local admin')
      inserted = row
    } catch (err) {
      if (isUniqueConstraintError(err) || countLoginableAdmins(db) > 0) {
        return reply.code(409).send({ error: 'setup_complete' })
      }
      throw err
    }
    insertAuditEvent(db, {
      type: '管理员创建',
      actorUserId: inserted.id,
      details: { user_id: inserted.id },
    })
    await persistSession(request, inserted.id)
    return reply.code(201).send(publicUser(inserted))
  })

  app.post('/api/v1/login', async (request, reply) => {
    const unauthorized = () => reply.code(401).send({ error: 'unauthorized' })
    const body = request.body as { username?: unknown; password?: unknown }
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const user = findLocalUser(db, username)
    if (user == null || user.passwordHash == null || user.status !== 'active') {
      return unauthorized()
    }
    const ok = await verifyPassword(password, user.passwordHash)
    if (!ok) return unauthorized()
    await persistSession(request, user.id)
    return reply.send(publicUser(user))
  })

  app.get('/api/v1/me', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) {
      if (wantsJson(request)) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
      return reply.redirect('/login')
    }
    return reply.send(publicUser(user))
  })

  app.put('/api/v1/me/settings', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null || user.status === PENDING_STATUS || user.status === 'revoked') {
      return sendUnauthorized(request, reply)
    }
    if (!canManageInstance(user)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const trustedAutomation = readTrustedAutomation(request.body)
    if (trustedAutomation === undefined) {
      return reply.code(400).send({ error: 'invalid_body' })
    }

    db.update(users).set({ trustedAutomation }).where(eq(users.id, user.id)).run()
    return reply.send({ trusted_automation: trustedAutomation })
  })

  app.get('/api/v1/users', async (request, reply) => {
    const actor = getSessionUser(db, request)
    if (actor == null) {
      return sendUnauthorized(request, reply)
    }
    if (!canManageInstance(actor)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const rows = db.select().from(users).all()
    return reply.send({ users: rows.map(listedUser) })
  })

  app.post('/api/v1/users/:id/promote', async (request, reply) => {
    const actor = getSessionUser(db, request)
    if (actor == null) {
      return sendUnauthorized(request, reply)
    }
    if (!canManageInstance(actor)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const rawId = (request.params as { id: string }).id
    const targetId = Number.parseInt(rawId, 10)
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return reply.code(400).send({ error: 'invalid_id' })
    }
    const target = db.select().from(users).where(eq(users.id, targetId)).get()
    if (
      target == null ||
      (target.provider !== 'gitlab' && target.provider !== 'gitea') ||
      (target.permissionLevel !== 'full' && target.permissionLevel !== 'admin') ||
      target.status !== 'active'
    ) {
      return reply.code(404).send({ error: 'not_found' })
    }
    if (target.permissionLevel === 'admin') {
      return reply.send({ ok: true })
    }
    db.update(users).set({ permissionLevel: 'admin' }).where(eq(users.id, targetId)).run()
    insertAuditEvent(db, {
      type: '权限变更',
      actorUserId: actor.id,
      details: { target_user_id: target.id, from: 'full', to: 'admin' },
    })
    return reply.send({ ok: true })
  })
}
