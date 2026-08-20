import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createForgeAdapter } from './index.ts'
import type {
  Credential,
  ForgeAdapter,
  RepoRef,
  TokenCapability,
  TokenCheck,
} from './index.ts'

const KINDS = ['github', 'gitlab', 'gitea'] as const
type ForgeKind = (typeof KINDS)[number]

const FULL_NAME = 'acme/app'
const GITLAB_ENCODED_PROJECT = 'acme%2Fapp'
const TOKEN_CAPABILITIES: readonly TokenCapability[] = ['读', '推', 'PR']

const WEB_ORIGIN = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.example.com',
  gitea: 'https://gitea.example.com',
} as const

const CUSTOM_BASE_URL = {
  github: 'https://github.example.com/ghe',
  gitlab: 'https://gitlab.example.com/gitlab',
  gitea: 'https://gitea.example.com/gitea',
} as const

type RecordedRequest = {
  url: string
  method: string
  headers: Headers
}

function tokenFor(kind: ForgeKind): string {
  return kind === 'github' ? 'github_pat_test-token' : 'test-token'
}

function credential(kind: ForgeKind, token = tokenFor(kind)): Credential {
  return { token }
}

function repoRef(kind: ForgeKind, baseUrl = WEB_ORIGIN[kind]): RepoRef {
  return { full_name: FULL_NAME, base_url: baseUrl }
}

function createAdapter(kind: ForgeKind, baseUrl?: string): ForgeAdapter {
  if (kind === 'github') {
    return baseUrl === undefined
      ? createForgeAdapter(kind)
      : createForgeAdapter(kind, { baseUrl })
  }
  return createForgeAdapter(kind, { baseUrl: baseUrl ?? WEB_ORIGIN[kind] })
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && 'url' in input) {
    const url = (input as { url: unknown }).url
    if (typeof url === 'string') return url
  }
  return String(input)
}

function requestMethod(input: unknown, init?: RequestInit): string {
  if (input !== null && typeof input === 'object' && 'method' in input) {
    const method = (input as { method?: unknown }).method
    if (typeof method === 'string' && method.length > 0) return method.toUpperCase()
  }
  return (init?.method ?? 'GET').toUpperCase()
}

function requestHeaders(input: unknown, init?: RequestInit): Headers {
  if (input !== null && typeof input === 'object' && 'headers' in input) {
    const headers = (input as { headers?: HeadersInit }).headers
    if (headers !== undefined) return new Headers(headers)
  }
  return new Headers(init?.headers)
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}

function pathnameOf(url: string): string {
  return new URL(url).pathname.replace(/\/+$/u, '') || '/'
}

function isUserRequest(kind: ForgeKind, url: string): boolean {
  const path = pathnameOf(url)
  if (kind === 'github') {
    return new URL(url).origin === 'https://api.github.com' && path === '/user'
  }
  if (kind === 'gitlab') {
    return /(?:^|\/)api\/v4\/user$/u.test(path)
  }
  return /(?:^|\/)api\/v1\/user$/u.test(path)
}

function isRepoRequest(kind: ForgeKind, url: string): boolean {
  const href = url.split('?')[0] ?? url
  const path = pathnameOf(url)
  if (kind === 'github') {
    return new URL(url).origin === 'https://api.github.com' && path === '/repos/acme/app'
  }
  if (kind === 'gitlab') {
    return (
      /\/api\/v4\/projects\/acme%2Fapp$/u.test(href) ||
      /(?:^|\/)api\/v4\/projects\/acme\/app$/u.test(path)
    )
  }
  return /(?:^|\/)api\/v1\/repos\/acme\/app$/u.test(path)
}

function okRepoBody(kind: ForgeKind): unknown {
  if (kind === 'github') {
    return {
      private: true,
      permissions: { admin: false, maintain: false, push: true, triage: false, pull: true },
    }
  }
  if (kind === 'gitlab') {
    return {
      visibility: 'private',
      can_create_merge_request_in: true,
      repository_access_level: 'enabled',
      merge_requests_access_level: 'enabled',
      permissions: {
        project_access: { access_level: 30, notification_level: 0 },
        group_access: null,
      },
    }
  }
  return {
    private: true,
    has_pull_requests: true,
    permissions: { admin: false, push: true, pull: true },
  }
}

function noPushRepoBody(kind: ForgeKind): unknown {
  if (kind === 'github') {
    return {
      private: true,
      permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    }
  }
  if (kind === 'gitlab') {
    return {
      visibility: 'private',
      can_create_merge_request_in: true,
      repository_access_level: 'enabled',
      merge_requests_access_level: 'enabled',
      permissions: {
        project_access: { access_level: 20, notification_level: 0 },
        group_access: null,
      },
    }
  }
  return {
    private: true,
    has_pull_requests: true,
    permissions: { admin: false, push: false, pull: true },
  }
}

function noPrRepoBody(kind: ForgeKind): unknown {
  if (kind === 'github') {
    return {
      private: true,
      permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    }
  }
  if (kind === 'gitlab') {
    return {
      visibility: 'private',
      can_create_merge_request_in: false,
      repository_access_level: 'enabled',
      merge_requests_access_level: 'enabled',
      permissions: {
        project_access: { access_level: 30, notification_level: 0 },
        group_access: null,
      },
    }
  }
  return {
    private: true,
    has_pull_requests: false,
    permissions: { admin: false, push: true, pull: true },
  }
}

type FetchScript = {
  kind: ForgeKind
  userStatus: number
  repoStatus: number
  repoBody?: unknown
  userHeaders?: Record<string, string>
}

function installFetch(
  t: { mock: { method: typeof import('node:test').mock.method } },
  script: FetchScript,
): RecordedRequest[] {
  const recorded: RecordedRequest[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = requestUrl(input)
      const method = requestMethod(input, init)
      const headers = requestHeaders(input, init)
      recorded.push({ url, method, headers })

      if (method !== 'GET') {
        return new Response(JSON.stringify({ message: 'mutation is out of spec' }), {
          status: 405,
        })
      }
      if (script.userStatus === 401) {
        return jsonResponse({ message: '401 Unauthorized' }, 401)
      }
      if (isUserRequest(script.kind, url)) {
        return jsonResponse(
          { login: 'bot', username: 'bot', id: 1 },
          script.userStatus,
          script.userHeaders,
        )
      }
      if (isRepoRequest(script.kind, url)) {
        return jsonResponse(script.repoBody ?? {}, script.repoStatus)
      }
      return jsonResponse({ message: 'not found' }, 404)
    },
  )
  return recorded
}

function assertTokenCheck(result: TokenCheck): TokenCheck {
  assert.equal(typeof result, 'object')
  assert.ok(result !== null)
  assert.ok(Array.isArray(result.missing), 'TokenCheck.missing must be an array')
  for (const item of result.missing) {
    assert.ok(
      TOKEN_CAPABILITIES.includes(item),
      `unknown missing item ${String(item)}; expected only 读/推/PR`,
    )
  }
  return result
}

function assertHas(result: TokenCheck, items: TokenCapability[]): void {
  for (const item of items) {
    assert.ok(
      result.missing.includes(item),
      `expected missing to include '${item}', got ${JSON.stringify(result.missing)}`,
    )
  }
}

function assertLacks(result: TokenCheck, items: TokenCapability[]): void {
  for (const item of items) {
    assert.equal(
      result.missing.includes(item),
      false,
      `expected missing not to include '${item}', got ${JSON.stringify(result.missing)}`,
    )
  }
}

function assertAuth(kind: ForgeKind, requests: RecordedRequest[], token: string): void {
  assert.ok(requests.length > 0, 'validateToken must call fetch')
  for (const req of requests) {
    if (kind === 'github') {
      assert.equal(req.headers.get('authorization'), `Bearer ${token}`)
      const userAgent = req.headers.get('user-agent')
      assert.ok(userAgent && userAgent.length > 0, 'GitHub REST requires a User-Agent header')
    } else if (kind === 'gitlab') {
      assert.equal(req.headers.get('private-token'), token)
    } else {
      assert.equal(req.headers.get('authorization'), `token ${token}`)
    }
  }
}

function assertSameRepoNoFork(kind: ForgeKind, requests: RecordedRequest[]): void {
  assert.ok(requests.length > 0, 'validateToken must call fetch')
  for (const req of requests) {
    assert.equal(
      req.method,
      'GET',
      `validateToken must not mutate the forge (${req.method} ${req.url})`,
    )
    assert.equal(
      req.url.includes('/forks'),
      false,
      `same-repo claimant path must not call fork APIs: ${req.url}`,
    )

    const path = pathnameOf(req.url)
    if (kind === 'gitlab' && path.includes('/projects/')) {
      assert.ok(
        req.url.includes(GITLAB_ENCODED_PROJECT),
        `GitLab project id must be encodeURIComponent('${FULL_NAME}') → ${GITLAB_ENCODED_PROJECT}: ${req.url}`,
      )
    }

    if (kind === 'github' && path.includes('/repos/')) {
      const rest = path.slice(path.indexOf('/repos/') + '/repos/'.length)
      assert.match(
        rest,
        /^acme\/app(?:\/|$)/u,
        `GitHub repo path must use only full_name ${FULL_NAME}: ${req.url}`,
      )
    }

    if (kind === 'gitea' && /\/api\/v1\/repos\//u.test(path)) {
      const rest = path.slice(path.indexOf('/repos/') + '/repos/'.length)
      assert.match(
        rest,
        /^acme\/app(?:\/|$)/u,
        `Gitea repo path must use only full_name ${FULL_NAME}: ${req.url}`,
      )
    }
  }
}

describe('validateToken shared spec', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('all ok: GET user + push-capable repo → missing [] (same-repo, no /forks)', async (t) => {
        const requests = installFetch(t, {
          kind,
          userStatus: 200,
          repoStatus: 200,
          repoBody: okRepoBody(kind),
        })
        const adapter = createAdapter(kind)
        assert.equal(adapter.kind, kind)

        const result = assertTokenCheck(
          await adapter.validateToken(credential(kind), repoRef(kind)),
        )
        assert.deepEqual(result.missing, [])
        assert.ok(
          requests.some((req) => isUserRequest(kind, req.url)),
          'must GET the current user',
        )
        assert.ok(
          requests.some((req) => isRepoRequest(kind, req.url)),
          'must GET the target repo/project',
        )
        assertAuth(kind, requests, tokenFor(kind))
        assertSameRepoNoFork(kind, requests)
      })

      it('cannot read: repo/project GET 404 → missing includes 读', async (t) => {
        installFetch(t, {
          kind,
          userStatus: 200,
          repoStatus: 404,
          repoBody: { message: 'Not Found' },
        })
        const adapter = createAdapter(kind)
        const result = assertTokenCheck(
          await adapter.validateToken(credential(kind), repoRef(kind)),
        )
        assertHas(result, ['读'])
      })

      it('dead token: user GET 401 → missing includes 读, 推, and PR', async (t) => {
        const requests = installFetch(t, {
          kind,
          userStatus: 401,
          repoStatus: 401,
        })
        const adapter = createAdapter(kind)
        const result = assertTokenCheck(
          await adapter.validateToken(credential(kind), repoRef(kind)),
        )
        assert.ok(requests.length > 0, 'dead-token check must probe the forge')
        assertHas(result, ['读', '推', 'PR'])
      })

      it('read but cannot push (Reporter / push:false / access_level 20) → missing 推, not 读', async (t) => {
        const requests = installFetch(t, {
          kind,
          userStatus: 200,
          repoStatus: 200,
          repoBody: noPushRepoBody(kind),
        })
        const adapter = createAdapter(kind)
        const result = assertTokenCheck(
          await adapter.validateToken(credential(kind), repoRef(kind)),
        )
        assertHas(result, ['推'])
        assertLacks(result, ['读'])
        assertSameRepoNoFork(kind, requests)
      })

      it('cannot open PR/MR while readable → missing includes PR', async (t) => {
        const requests = installFetch(t, {
          kind,
          userStatus: 200,
          repoStatus: 200,
          repoBody: noPrRepoBody(kind),
        })
        const adapter = createAdapter(kind)
        const result = assertTokenCheck(
          await adapter.validateToken(credential(kind), repoRef(kind)),
        )
        assertHas(result, ['PR'])
        assertLacks(result, ['读'])
        if (kind === 'gitlab' || kind === 'gitea') {
          assertLacks(result, ['推'])
        }
        assertSameRepoNoFork(kind, requests)
      })

      it('custom baseUrl: GitLab/Gitea keep subpath; GitHub always api.github.com', async (t) => {
        const requests = installFetch(t, {
          kind,
          userStatus: 200,
          repoStatus: 200,
          repoBody: okRepoBody(kind),
        })
        const custom = CUSTOM_BASE_URL[kind]
        const adapter = createAdapter(kind, custom)
        const result = assertTokenCheck(
          await adapter.validateToken(credential(kind), repoRef(kind, custom)),
        )
        assert.deepEqual(result.missing, [])
        assert.ok(requests.length > 0, 'custom baseUrl must still probe via fetch')

        if (kind === 'github') {
          for (const req of requests) {
            assert.ok(
              req.url.startsWith('https://api.github.com/'),
              `GitHub must ignore base_url/options and call api.github.com: ${req.url}`,
            )
            assert.equal(
              req.url.includes('github.example.com'),
              false,
              `GitHub must not use RepoRef.base_url or options.baseUrl: ${req.url}`,
            )
          }
        } else if (kind === 'gitlab') {
          const prefix = 'https://gitlab.example.com/gitlab/api/v4/'
          const dropped = 'https://gitlab.example.com/api/v4/'
          for (const req of requests) {
            assert.ok(
              req.url.startsWith(prefix),
              `GitLab baseUrl with /gitlab must join as origin+/api/v4, not drop the subpath: ${req.url}`,
            )
            assert.equal(
              req.url.startsWith(dropped),
              false,
              `GitLab must not request ${dropped}: ${req.url}`,
            )
          }
        } else {
          const prefix = 'https://gitea.example.com/gitea/api/v1/'
          const dropped = 'https://gitea.example.com/api/v1/'
          for (const req of requests) {
            assert.ok(
              req.url.startsWith(prefix),
              `Gitea baseUrl with /gitea must join as origin+/api/v1, not drop the subpath: ${req.url}`,
            )
            assert.equal(
              req.url.startsWith(dropped),
              false,
              `Gitea must not request ${dropped}: ${req.url}`,
            )
          }
        }

        assertSameRepoNoFork(kind, requests)
      })
    })
  }

  it('github classic PAT without repo scope cannot push or open PR', async (t) => {
    const token = 'ghp_classic-token'
    const requests = installFetch(t, {
      kind: 'github',
      userStatus: 200,
      repoStatus: 200,
      repoBody: okRepoBody('github'),
      userHeaders: { 'x-oauth-scopes': 'gist' },
    })
    const adapter = createAdapter('github')
    const result = assertTokenCheck(
      await adapter.validateToken(credential('github', token), repoRef('github')),
    )
    assertHas(result, ['推', 'PR'])
    assertLacks(result, ['读'])
    assertSameRepoNoFork('github', requests)
  })
})
