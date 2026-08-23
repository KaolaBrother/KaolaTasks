import cookie from '@fastify/cookie'
import oauthPlugin from '@fastify/oauth2'
import session from '@fastify/session'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppDb } from './db.ts'
import { type User, type UserProvider, users } from './schema.ts'

const PENDING_STATUS = '待批准'
const PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'

type OAuth2Decorator = {
  getAccessTokenFromAuthorizationCodeFlow: (
    request: FastifyRequest,
    reply?: FastifyReply,
  ) => Promise<{ token: { access_token: string } }>
}

type GithubAuthConfig = {
  tokenHost: string
  tokenPath?: string
  authorizeHost?: string
  authorizePath?: string
  revokePath?: string
}

const githubAuthConfig = (oauthPlugin as unknown as { GITHUB_CONFIGURATION: GithubAuthConfig })
  .GITHUB_CONFIGURATION

declare module 'fastify' {
  interface FastifyInstance {
    githubOAuth2: OAuth2Decorator
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

function readTrustedAutomation(body: unknown): boolean | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const value = (body as { trusted_automation?: unknown }).trusted_automation
  return typeof value === 'boolean' ? value : undefined
}

function userinfoUrl(provider: UserProvider, gitlabBaseUrl: string, giteaBaseUrl: string): string {
  if (provider === 'github') return 'https://api.github.com/user'
  if (provider === 'gitlab') return `${gitlabBaseUrl}/api/v4/user`
  return `${giteaBaseUrl}/api/v1/user`
}

function mapProfile(provider: UserProvider, profile: Record<string, unknown>) {
  if (provider === 'github') {
    const username = String(profile.login)
    return {
      remoteId: String(profile.id),
      username,
      displayName: nonemptyString(profile.name) ?? username,
      status: PENDING_STATUS as User['status'],
      permissionLevel: 'claim_only' as const,
    }
  }
  if (provider === 'gitlab') {
    return {
      remoteId: String(profile.id),
      username: String(profile.username),
      displayName: String(profile.name),
      status: 'active' as const,
      permissionLevel: 'full' as const,
    }
  }
  const username = String(profile.login)
  return {
    remoteId: String(profile.id),
    username,
    displayName: nonemptyString(profile.full_name) ?? username,
    status: 'active' as const,
    permissionLevel: 'full' as const,
  }
}

function upsertUser(
  db: AppDb,
  provider: UserProvider,
  profile: ReturnType<typeof mapProfile>,
): User {
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
    return {
      ...existing,
      username: profile.username,
      displayName: profile.displayName,
    }
  }

  const inserted = db
    .insert(users)
    .values({
      provider,
      remoteId: profile.remoteId,
      username: profile.username,
      displayName: profile.displayName,
      status: profile.status,
      permissionLevel: profile.permissionLevel,
    })
    .returning()
    .get()

  if (inserted == null) {
    throw new Error('failed to insert user')
  }
  return inserted
}

export function getSessionUser(db: AppDb, request: FastifyRequest): User | undefined {
  const userId = request.session.userId
  if (userId == null) return undefined
  return db.select().from(users).where(eq(users.id, userId)).get()
}

function oauthOf(app: FastifyInstance, provider: UserProvider): OAuth2Decorator {
  const decoratorName = `${provider}OAuth2` as const
  const oauth = app[decoratorName]
  if (oauth == null || typeof oauth.getAccessTokenFromAuthorizationCodeFlow !== 'function') {
    throw new Error(`${decoratorName} is not registered`)
  }
  return oauth
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
    <p>使用团队 forge 账号登录：</p>
    <ul>
      <li><a href="/login/github">使用 GitHub 登录</a></li>
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

async function completeOAuthLogin(
  app: FastifyInstance,
  db: AppDb,
  provider: UserProvider,
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
  const user = upsertUser(db, provider, mapped)
  request.session.userId = user.id
  await request.session.save()
  return reply.redirect('/')
}

export function registerAuth(app: FastifyInstance, db: AppDb) {
  const sessionSecret = requireEnv('SESSION_SECRET')
  const publicUrl = trimTrailingSlash(process.env.PUBLIC_URL ?? 'http://localhost:31415')
  const githubClientId = requireEnv('OAUTH_GITHUB_CLIENT_ID')
  const githubClientSecret = requireEnv('OAUTH_GITHUB_CLIENT_SECRET')
  const gitlabClientId = requireEnv('OAUTH_GITLAB_CLIENT_ID')
  const gitlabClientSecret = requireEnv('OAUTH_GITLAB_CLIENT_SECRET')
  const gitlabBaseUrl = trimTrailingSlash(requireEnv('OAUTH_GITLAB_BASE_URL'))
  const giteaClientId = requireEnv('OAUTH_GITEA_CLIENT_ID')
  const giteaClientSecret = requireEnv('OAUTH_GITEA_CLIENT_SECRET')
  const giteaBaseUrl = trimTrailingSlash(requireEnv('OAUTH_GITEA_BASE_URL'))

  const oauthCookie = { path: '/' as const }

  app.register(cookie)
  app.register(session, {
    secret: sessionSecret,
    cookie: { path: '/', secure: false, httpOnly: true, sameSite: 'lax' },
    saveUninitialized: false,
  })

  app.register(oauthPlugin, {
    name: 'githubOAuth2',
    scope: ['read:user'],
    credentials: {
      client: { id: githubClientId, secret: githubClientSecret },
      auth: githubAuthConfig,
    },
    startRedirectPath: '/login/github',
    callbackUri: `${publicUrl}/login/github/callback`,
    cookie: oauthCookie,
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

  app.get('/login', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(loginPageHtml())
  })

  app.get('/login/github/callback', async (request, reply) => {
    return completeOAuthLogin(app, db, 'github', gitlabBaseUrl, giteaBaseUrl, request, reply)
  })
  app.get('/login/gitlab/callback', async (request, reply) => {
    return completeOAuthLogin(app, db, 'gitlab', gitlabBaseUrl, giteaBaseUrl, request, reply)
  })
  app.get('/login/gitea/callback', async (request, reply) => {
    return completeOAuthLogin(app, db, 'gitea', gitlabBaseUrl, giteaBaseUrl, request, reply)
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

  // Issue #16: 待批准 sessions get the same 401 as no session — they never see the toggle.
  app.put('/api/v1/me/settings', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null || user.status === PENDING_STATUS) {
      return sendUnauthorized(request, reply)
    }

    const trustedAutomation = readTrustedAutomation(request.body)
    if (trustedAutomation === undefined) {
      return reply.code(400).send({ error: 'invalid_body' })
    }

    db.update(users).set({ trustedAutomation }).where(eq(users.id, user.id)).run()
    return reply.send({ trusted_automation: trustedAutomation })
  })

  app.post('/api/v1/users/:id/approve', async (request, reply) => {
    const actor = getSessionUser(db, request)
    if (actor == null) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    if (actor.status !== 'active' || actor.permissionLevel !== 'full') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const rawId = (request.params as { id: string }).id
    const targetId = Number.parseInt(rawId, 10)
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return reply.code(400).send({ error: 'invalid_id' })
    }
    const target = db.select().from(users).where(eq(users.id, targetId)).get()
    if (target == null) {
      return reply.code(404).send({ error: 'not_found' })
    }
    db.update(users).set({ status: 'active' }).where(eq(users.id, targetId)).run()
    const updated = db.select().from(users).where(eq(users.id, targetId)).get()
    return reply.send(updated ? publicUser(updated) : { ok: true })
  })
}
