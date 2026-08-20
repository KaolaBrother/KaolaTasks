export function getForgeAdaptersHealth(): string {
  return 'kaola-forge-adapters-ready'
}

export type ForgeKind = 'github' | 'gitlab' | 'gitea'

export type Credential = { token: string }

export type RepoRef = {
  full_name: string
  base_url: string
}

export type TokenCapability = '读' | '推' | 'PR'

export type TokenCheck = {
  missing: TokenCapability[]
}

/** Placeholder until later issues define DESIGN §8 payloads. */
export type ImportedIssue = unknown
export type PrStatus = unknown
export type ForgeEvent = unknown
export type IssueRef = unknown

export interface ForgeAdapter {
  readonly kind: ForgeKind
  validateToken(cred: Credential, repo: RepoRef): Promise<TokenCheck>
  importIssue(cred: Credential, issueUrl: string): Promise<ImportedIssue>
  getPullRequest(cred: Credential, prUrl: string): Promise<PrStatus>
  registerWebhook(cred: Credential, repo: RepoRef, callback: string): Promise<void>
  parseWebhook(headers: Headers, body: unknown): ForgeEvent | null
  commentOnIssue(cred: Credential, issueRef: IssueRef, body: string): Promise<void>
}

export type CreateForgeAdapterOptions = {
  baseUrl?: string
}

const ALL_MISSING: TokenCheck = { missing: ['读', '推', 'PR'] }
const GITHUB_API_ORIGIN = 'https://api.github.com'
const GITHUB_USER_AGENT = 'KaolaTasks'
const GITHUB_ACCEPT = 'application/vnd.github+json'

export function createForgeAdapter(
  kind: ForgeKind,
  options?: CreateForgeAdapterOptions,
): ForgeAdapter {
  if (kind !== 'github' && kind !== 'gitlab' && kind !== 'gitea') {
    throw new Error(`unknown forge kind: ${String(kind)}`)
  }
  return {
    kind,
    validateToken: (cred, repo) => validateToken(kind, options, cred, repo),
    importIssue: notImplemented,
    getPullRequest: notImplemented,
    registerWebhook: notImplemented,
    parseWebhook: notImplemented,
    commentOnIssue: notImplemented,
  }
}

function notImplemented(): never {
  throw new Error('not implemented')
}

async function validateToken(
  kind: ForgeKind,
  options: CreateForgeAdapterOptions | undefined,
  cred: Credential,
  repo: RepoRef,
): Promise<TokenCheck> {
  const token = cred.token
  const userUrl = apiUrl(kind, options, repo, userPath())
  const userRes = await forgeGet(kind, userUrl, token)
  if (userRes.status === 401) {
    return { missing: [...ALL_MISSING.missing] }
  }

  const repoUrl = apiUrl(kind, options, repo, repoPath(kind, repo.full_name))
  const repoRes = await forgeGet(kind, repoUrl, token)
  if (repoRes.status !== 200) {
    return { missing: [...ALL_MISSING.missing] }
  }

  const repoBody: unknown = await repoRes.json()
  if (kind === 'github') {
    return githubCapabilities(token, userRes, repoBody)
  }
  if (kind === 'gitlab') {
    return gitlabCapabilities(repoBody)
  }
  return giteaCapabilities(repoBody)
}

function userPath(): string {
  return '/user'
}

function repoPath(kind: ForgeKind, fullName: string): string {
  if (kind === 'gitlab') {
    return `/projects/${encodeURIComponent(fullName)}`
  }
  return `/repos/${fullName}`
}

function apiUrl(
  kind: ForgeKind,
  options: CreateForgeAdapterOptions | undefined,
  repo: RepoRef,
  path: string,
): string {
  if (kind === 'github') {
    return `${GITHUB_API_ORIGIN}${path}`
  }
  const prefix = kind === 'gitlab' ? '/api/v4' : '/api/v1'
  const origin = (options?.baseUrl ?? repo.base_url).replace(/\/+$/u, '')
  return `${origin}${prefix}${path}`
}

function authHeaders(kind: ForgeKind, token: string): Record<string, string> {
  if (kind === 'github') {
    return {
      Authorization: `Bearer ${token}`,
      'User-Agent': GITHUB_USER_AGENT,
      Accept: GITHUB_ACCEPT,
    }
  }
  if (kind === 'gitlab') {
    return { 'PRIVATE-TOKEN': token }
  }
  return { Authorization: `token ${token}` }
}

async function forgeGet(kind: ForgeKind, url: string, token: string): Promise<Response> {
  return globalThis.fetch(url, {
    method: 'GET',
    headers: authHeaders(kind, token),
  })
}

function githubCapabilities(
  token: string,
  userRes: Response,
  repoBody: unknown,
): TokenCheck {
  const body = asObject(repoBody)
  const permissions = asObject(body?.permissions)
  const roleCanPush = permissions?.push === true
  const isPrivate = body?.private !== false
  let canPush = roleCanPush
  if (token.startsWith('ghp_')) {
    canPush = roleCanPush && classicPatHasWriteScope(userRes.headers.get('x-oauth-scopes'), isPrivate)
  }
  return missingFromFlags({ canRead: true, canPush, canPr: canPush })
}

function classicPatHasWriteScope(header: string | null, isPrivate: boolean): boolean {
  const scopes = (header ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)
  if (scopes.includes('repo')) return true
  return !isPrivate && scopes.includes('public_repo')
}

function gitlabCapabilities(repoBody: unknown): TokenCheck {
  const body = asObject(repoBody)
  const permissions = asObject(body?.permissions)
  const projectLevel = nestedAccessLevel(permissions, 'project_access')
  const groupLevel = nestedAccessLevel(permissions, 'group_access')
  const accessLevel = Math.max(projectLevel, groupLevel)
  const canPush =
    accessLevel >= 30 && body?.repository_access_level !== 'disabled'
  const canPr =
    body?.can_create_merge_request_in === true &&
    body?.merge_requests_access_level !== 'disabled'
  return missingFromFlags({ canRead: true, canPush, canPr })
}

function nestedAccessLevel(
  permissions: Record<string, unknown> | undefined,
  key: 'project_access' | 'group_access',
): number {
  const access = asObject(permissions?.[key])
  return typeof access?.access_level === 'number' ? access.access_level : 0
}

function giteaCapabilities(repoBody: unknown): TokenCheck {
  const body = asObject(repoBody)
  const permissions = asObject(body?.permissions)
  const canPush = permissions?.push === true
  const canPr = canPush && body?.has_pull_requests !== false
  return missingFromFlags({ canRead: true, canPush, canPr })
}

function missingFromFlags(flags: {
  canRead: boolean
  canPush: boolean
  canPr: boolean
}): TokenCheck {
  const missing: TokenCapability[] = []
  if (!flags.canRead) missing.push('读')
  if (!flags.canPush) missing.push('推')
  if (!flags.canPr) missing.push('PR')
  return { missing }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}
