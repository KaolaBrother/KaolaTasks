import { createHmac, timingSafeEqual } from 'node:crypto'

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

export type ImportedIssue = {
  title: string
  description_md: string
  issue_url: string
  repo: { full_name: string }
}
export type PrStatus = { state: 'open' | 'merged' | 'closed' }

// Issue #13: the only two terminal PR/MR outcomes a webhook (or the poller) ever needs to act on.
// `parseWebhook` returns this or `null` — `null` means "ignore" (ping, non-terminal action/state,
// an event type we don't understand); anything signed-but-invalid is a thrown
// `WebhookSignatureError`, never a `null`.
export type ForgeEvent = {
  type: 'pull_request'
  state: 'merged' | 'closed'
  pr_url: string
  repo: { full_name: string }
}
export type IssueRef = unknown

// Distinct `name` so callers (the Fastify receiver) can tell "reject the HTTP request" (bad or
// missing signature/secret) apart from `parseWebhook`'s `null` return ("ignore, still 204").
export class WebhookSignatureError extends Error {
  constructor(message = 'invalid webhook signature') {
    super(message)
    this.name = 'WebhookSignatureError'
  }
}

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
  webhookSecret?: string
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
    importIssue: (cred, issueUrl) => importIssue(kind, options, cred, issueUrl),
    getPullRequest: (cred, prUrl) => getPullRequest(kind, options, cred, prUrl),
    registerWebhook: (cred, repo, callback) => registerWebhook(kind, options, cred, repo, callback),
    parseWebhook: (headers, body) => parseWebhook(kind, options, headers, body),
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

// Issue #13: verify + parse an inbound webhook delivery, and register one with the forge.
// `parseWebhook` never fetches — the host rule below only governs `registerWebhook`.

function rawBodyString(body: unknown): string {
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  if (typeof body === 'string') return body
  return String(body)
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function verifyGithubSignature(secret: string, rawBody: string, headers: Headers): void {
  const header = headers.get('x-hub-signature-256')
  if (header == null) throw new WebhookSignatureError()
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  if (!timingSafeEqualStrings(header, expected)) throw new WebhookSignatureError()
}

function verifyGiteaSignature(secret: string, rawBody: string, headers: Headers): void {
  const header = headers.get('x-gitea-signature')
  if (header == null) throw new WebhookSignatureError()
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  if (!timingSafeEqualStrings(header, expected)) throw new WebhookSignatureError()
}

function verifyGitlabToken(secret: string, headers: Headers): void {
  const header = headers.get('x-gitlab-token')
  if (header == null) throw new WebhookSignatureError()
  if (!timingSafeEqualStrings(header, secret)) throw new WebhookSignatureError()
}

function mapGithubShapedEvent(
  kind: 'github' | 'gitea',
  headers: Headers,
  payload: unknown,
): ForgeEvent | null {
  const eventHeader = kind === 'github' ? 'x-github-event' : 'x-gitea-event'
  if (headers.get(eventHeader) !== 'pull_request') return null
  const obj = asObject(payload)
  if (obj?.action !== 'closed') return null
  const pr = asObject(obj.pull_request)
  const repo = asObject(obj.repository)
  const prUrl = pr?.html_url
  const fullName = repo?.full_name
  if (typeof prUrl !== 'string' || typeof fullName !== 'string') return null
  const state: 'merged' | 'closed' = pr?.merged === true ? 'merged' : 'closed'
  return { type: 'pull_request', state, pr_url: prUrl, repo: { full_name: fullName } }
}

function mapGitlabEvent(headers: Headers, payload: unknown): ForgeEvent | null {
  if (headers.get('x-gitlab-event') !== 'Merge Request Hook') return null
  const obj = asObject(payload)
  const attrs = asObject(obj?.object_attributes)
  const rawState = attrs?.state
  if (rawState !== 'merged' && rawState !== 'closed') return null
  const project = asObject(obj?.project)
  const prUrl = attrs?.url
  const fullName = project?.path_with_namespace
  if (typeof prUrl !== 'string' || typeof fullName !== 'string') return null
  return { type: 'pull_request', state: rawState, pr_url: prUrl, repo: { full_name: fullName } }
}

function parseWebhook(
  kind: ForgeKind,
  options: CreateForgeAdapterOptions | undefined,
  headers: Headers,
  body: unknown,
): ForgeEvent | null {
  const secret = options?.webhookSecret
  if (secret == null || secret === '') {
    throw new WebhookSignatureError()
  }
  const rawBody = rawBodyString(body)
  if (kind === 'github') {
    verifyGithubSignature(secret, rawBody, headers)
  } else if (kind === 'gitlab') {
    verifyGitlabToken(secret, headers)
  } else {
    verifyGiteaSignature(secret, rawBody, headers)
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return null
  }

  if (kind === 'gitlab') {
    return mapGitlabEvent(headers, payload)
  }
  return mapGithubShapedEvent(kind, headers, payload)
}

function splitFullName(fullName: string): [string, string] {
  const idx = fullName.indexOf('/')
  if (idx === -1) return [fullName, '']
  return [fullName.slice(0, idx), fullName.slice(idx + 1)]
}

async function forgePost(
  kind: ForgeKind,
  url: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return globalThis.fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(kind, token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function registerWebhook(
  kind: ForgeKind,
  options: CreateForgeAdapterOptions | undefined,
  cred: Credential,
  repo: RepoRef,
  callback: string,
): Promise<void> {
  const secret = options?.webhookSecret

  if (kind === 'github') {
    const [owner, name] = splitFullName(repo.full_name)
    const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`
    const body = {
      name: 'web',
      events: ['pull_request'],
      config: { url: callback, content_type: 'json', secret, insecure_ssl: '0' },
    }
    const res = await forgePost(kind, url, cred.token, body)
    if (!res.ok) throw new Error(`registerWebhook: ${kind} responded ${res.status}`)
    return
  }

  if (kind === 'gitlab') {
    const origin = (options?.baseUrl ?? '').replace(/\/+$/u, '')
    const url = `${origin}/api/v4/projects/${encodeURIComponent(repo.full_name)}/hooks`
    const body = { url: callback, merge_requests_events: true, token: secret }
    const res = await forgePost(kind, url, cred.token, body)
    if (!res.ok) throw new Error(`registerWebhook: ${kind} responded ${res.status}`)
    return
  }

  const origin = (options?.baseUrl ?? '').replace(/\/+$/u, '')
  const [giteaOwner, giteaName] = splitFullName(repo.full_name)
  const url = `${origin}/api/v1/repos/${encodeURIComponent(giteaOwner)}/${encodeURIComponent(giteaName)}/hooks`
  const body = {
    type: 'gitea',
    events: ['pull_request'],
    config: { url: callback, content_type: 'json', secret },
    active: true,
  }
  const res = await forgePost(kind, url, cred.token, body)
  if (!res.ok) throw new Error(`registerWebhook: ${kind} responded ${res.status}`)
}

// Issue #12: import a forge Issue by its web URL. Host rule matches getPullRequest (GitHub always
// api.github.com; GitLab/Gitea use constructor baseUrl, never the pasted host).
type ParsedOwnerRepoIssue = { owner: string; repo: string; number: string }
type ParsedGitlabIssue = { namespace: string; iid: string }

function parsedIssueUrl(url: string): URL | undefined {
  try {
    return new URL(url.replace(/\/+$/u, ''))
  } catch {
    return undefined
  }
}

function parseOwnerRepoIssueUrl(issueUrl: string): ParsedOwnerRepoIssue | undefined {
  const url = parsedIssueUrl(issueUrl)
  if (url == null) return undefined
  const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/u.exec(url.pathname)
  if (match == null) return undefined
  return { owner: match[1] as string, repo: match[2] as string, number: match[3] as string }
}

function parseGitlabIssueUrl(issueUrl: string): ParsedGitlabIssue | undefined {
  const url = parsedIssueUrl(issueUrl)
  if (url == null) return undefined
  const canonical = /^\/(.+)\/-\/issues\/(\d+)$/u.exec(url.pathname)
  if (canonical != null) {
    return { namespace: canonical[1] as string, iid: canonical[2] as string }
  }
  const legacy = /^\/(.+)\/issues\/(\d+)$/u.exec(url.pathname)
  if (legacy == null) return undefined
  return { namespace: legacy[1] as string, iid: legacy[2] as string }
}

export function parseIssueUrl(
  kind: ForgeKind,
  issueUrl: string,
): { full_name: string } | undefined {
  if (kind === 'gitlab') {
    const parsed = parseGitlabIssueUrl(issueUrl)
    return parsed == null ? undefined : { full_name: parsed.namespace }
  }
  const parsed = parseOwnerRepoIssueUrl(issueUrl)
  return parsed == null ? undefined : { full_name: `${parsed.owner}/${parsed.repo}` }
}

function resolveImportedIssue(
  kind: ForgeKind,
  options: CreateForgeAdapterOptions | undefined,
  issueUrl: string,
): { apiUrl: string; fullName: string } {
  const origin = prApiOrigin(kind, options)
  if (kind === 'github') {
    const parsed = parseOwnerRepoIssueUrl(issueUrl)
    if (parsed == null) {
      throw new Error(`unparseable GitHub issue URL: ${issueUrl}`)
    }
    return {
      apiUrl: `${origin}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/issues/${parsed.number}`,
      fullName: `${parsed.owner}/${parsed.repo}`,
    }
  }
  if (kind === 'gitlab') {
    const parsed = parseGitlabIssueUrl(issueUrl)
    if (parsed == null) {
      throw new Error(`unparseable GitLab issue URL: ${issueUrl}`)
    }
    return {
      apiUrl: `${origin}/api/v4/projects/${encodeURIComponent(parsed.namespace)}/issues/${parsed.iid}`,
      fullName: parsed.namespace,
    }
  }
  const parsed = parseOwnerRepoIssueUrl(issueUrl)
  if (parsed == null) {
    throw new Error(`unparseable Gitea issue URL: ${issueUrl}`)
  }
  return {
    apiUrl: `${origin}/api/v1/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/issues/${parsed.number}`,
    fullName: `${parsed.owner}/${parsed.repo}`,
  }
}

function readIssueDescription(kind: ForgeKind, body: Record<string, unknown> | undefined): string {
  const raw = kind === 'gitlab' ? body?.description : body?.body
  return typeof raw === 'string' ? raw : ''
}

async function importIssue(
  kind: ForgeKind,
  options: CreateForgeAdapterOptions | undefined,
  cred: Credential,
  issueUrl: string,
): Promise<ImportedIssue> {
  const resolved = resolveImportedIssue(kind, options, issueUrl)
  const res = await forgeGet(kind, resolved.apiUrl, cred.token)
  if (!res.ok) {
    throw new Error(`importIssue: ${kind} responded ${res.status}`)
  }
  const payload: unknown = await res.json()
  const obj = asObject(payload)
  if (typeof obj?.title !== 'string') {
    throw new Error(`importIssue: ${kind} issue is missing a title`)
  }
  return {
    title: obj.title,
    description_md: readIssueDescription(kind, obj),
    issue_url: issueUrl.replace(/\/+$/u, ''),
    repo: { full_name: resolved.fullName },
  }
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
