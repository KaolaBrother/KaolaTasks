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
export type PrStatus = { state: 'open' | 'merged' | 'closed' }
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
    getPullRequest: (cred, prUrl) => getPullRequest(kind, options, cred, prUrl),
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

// Issue #11: PR/MR status lookup used by the server poller. `Credential` carries only a bare
// `prUrl` string (no RepoRef), so owner/repo/number (or namespace/iid) are parsed out of the URL
// itself. GitHub's API origin is always api.github.com; GitLab/Gitea use the constructor
// `options.baseUrl`, never the prUrl's own host.
type ParsedGithubPr = { owner: string; repo: string; number: string }
type ParsedGiteaPr = { owner: string; repo: string; number: string }
type ParsedGitlabMr = { namespace: string; iid: string }

function stripPrUrlSuffix(url: string): string {
  return url.replace(/\/+$/u, '').replace(/\.(?:diff|patch)$/u, '')
}

function parsedUrl(url: string): URL | undefined {
  try {
    return new URL(stripPrUrlSuffix(url))
  } catch {
    return undefined
  }
}

function parseGithubPrUrl(prUrl: string): ParsedGithubPr | undefined {
  const url = parsedUrl(prUrl)
  if (url == null) return undefined
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/u.exec(url.pathname)
  if (match == null) return undefined
  return { owner: match[1] as string, repo: match[2] as string, number: match[3] as string }
}

function parseGiteaPrUrl(prUrl: string): ParsedGiteaPr | undefined {
  const url = parsedUrl(prUrl)
  if (url == null) return undefined
  const match = /^\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/u.exec(url.pathname)
  if (match == null) return undefined
  return { owner: match[1] as string, repo: match[2] as string, number: match[3] as string }
}

function parseGitlabMrUrl(prUrl: string): ParsedGitlabMr | undefined {
  const url = parsedUrl(prUrl)
  if (url == null) return undefined
  const match = /^\/(.+)\/-\/merge_requests\/(\d+)$/u.exec(url.pathname)
  if (match == null) return undefined
  return { namespace: match[1] as string, iid: match[2] as string }
}

function prApiOrigin(kind: ForgeKind, options: CreateForgeAdapterOptions | undefined): string {
  if (kind === 'github') return GITHUB_API_ORIGIN
  return (options?.baseUrl ?? '').replace(/\/+$/u, '')
}

function prApiUrl(
  kind: ForgeKind,
  options: CreateForgeAdapterOptions | undefined,
  prUrl: string,
): string {
  if (kind === 'github') {
    const parsed = parseGithubPrUrl(prUrl)
    if (parsed == null) {
      throw new Error(`unparseable GitHub pull request URL: ${prUrl}`)
    }
    return `${prApiOrigin(kind, options)}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`
  }
  if (kind === 'gitlab') {
    const parsed = parseGitlabMrUrl(prUrl)
    if (parsed == null) {
      throw new Error(`unparseable GitLab merge request URL: ${prUrl}`)
    }
    return `${prApiOrigin(kind, options)}/api/v4/projects/${encodeURIComponent(parsed.namespace)}/merge_requests/${parsed.iid}`
  }
  const parsed = parseGiteaPrUrl(prUrl)
  if (parsed == null) {
    throw new Error(`unparseable Gitea pull request URL: ${prUrl}`)
  }
  return `${prApiOrigin(kind, options)}/api/v1/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`
}

function derivePrState(kind: ForgeKind, body: unknown): PrStatus['state'] {
  const obj = asObject(body)
  if (kind === 'gitlab') {
    if (obj?.state === 'merged') return 'merged'
    if (obj?.state === 'closed') return 'closed'
    // 'opened' and the transient 'locked' (en route to merged) both read as open.
    return 'open'
  }
  if (obj?.merged === true) return 'merged'
  if (obj?.state === 'closed') return 'closed'
  return 'open'
}

async function getPullRequest(
  kind: ForgeKind,
  options: CreateForgeAdapterOptions | undefined,
  cred: Credential,
  prUrl: string,
): Promise<PrStatus> {
  const url = prApiUrl(kind, options, prUrl)
  const res = await forgeGet(kind, url, cred.token)
  if (!res.ok) {
    throw new Error(`getPullRequest: ${kind} responded ${res.status}`)
  }
  const body: unknown = await res.json()
  return { state: derivePrState(kind, body) }
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
