import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createForgeAdapter } from './index.ts'
import type { Credential, CreateForgeAdapterOptions, ForgeAdapter } from './index.ts'

// Issue #53. Shared spec for `commentOnPullRequest`, parameterized over github/gitlab/gitea.
// Mirrors `get-pull-request.shared.test.ts`'s fetch-stub shape for URL parsing and the host/SSRF
// rule, plus `comment-on-issue.shared.test.ts`'s body recorder. Deliberately copied rather than
// imported, per this project's one-shared-spec-per-file convention.
//
// This is the PR/MR comment channel, distinct from `commentOnIssue` (which targets the imported
// Issue). GitHub and Gitea both treat a PR as an issue for commenting, so the PR number doubles
// as the issue number and the endpoint is `/issues/{n}/comments`, not `/pulls/{n}/comments` —
// that distinction is asserted explicitly below, because getting it wrong yields a 404 only at
// runtime against a real forge.

const KINDS = ['github', 'gitlab', 'gitea'] as const
type ForgeKind = (typeof KINDS)[number]

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

// The real payload is Chinese review prose, so the fixture is too: it proves the body survives
// JSON encoding verbatim rather than being mangled or escaped into something else.
const COMMENT_BODY = '考拉评审已通过，PR 已翻为 ready。'

function tokenFor(kind: ForgeKind): string {
  return kind === 'github' ? 'github_pat_test-token' : 'test-token'
}

function credential(kind: ForgeKind, token = tokenFor(kind)): Credential {
  return { token }
}

function createAdapter(kind: ForgeKind, baseUrl?: string): ForgeAdapter {
  if (kind === 'github') {
    return baseUrl === undefined ? createForgeAdapter(kind) : createForgeAdapter(kind, { baseUrl })
  }
  return createForgeAdapter(kind, { baseUrl: baseUrl ?? WEB_ORIGIN[kind] })
}

function createAdapterWithTimeout(kind: ForgeKind, timeoutMs: number): ForgeAdapter {
  const withTimeout: CreateForgeAdapterOptions = { timeoutMs }
  if (kind === 'github') return createForgeAdapter(kind, withTimeout)
  return createForgeAdapter(kind, { ...withTimeout, baseUrl: WEB_ORIGIN[kind] })
}

type RecordedRequest = {
  url: string
  method: string
  headers: Headers
  body: unknown
  signal: AbortSignal | undefined
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

function requestBodyJson(input: unknown, init?: RequestInit): unknown {
  let raw: unknown = init?.body
  if (raw === undefined && input !== null && typeof input === 'object' && 'body' in input) {
    raw = (input as { body?: unknown }).body
  }
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function requestSignal(input: unknown, init?: RequestInit): AbortSignal | undefined {
  if (input !== null && typeof input === 'object' && 'signal' in input) {
    const signal = (input as { signal?: unknown }).signal
    if (signal instanceof AbortSignal) return signal
  }
  if (init?.signal instanceof AbortSignal) return init.signal
  return undefined
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch(
  t: { mock: { method: typeof import('node:test').mock.method } },
  respond: (url: string) => Response,
): RecordedRequest[] {
  const recorded: RecordedRequest[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = requestUrl(input)
      recorded.push({
        url,
        method: requestMethod(input, init),
        headers: requestHeaders(input, init),
        body: requestBodyJson(input, init),
        signal: requestSignal(input, init),
      })
      return respond(url)
    },
  )
  return recorded
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, '')
}

function githubPrUrl(owner: string, repo: string, number: number): string {
  return `${WEB_ORIGIN.github}/${owner}/${repo}/pull/${number}`
}

function giteaPrUrl(baseUrl: string, owner: string, repo: string, number: number): string {
  return `${trimSlash(baseUrl)}/${owner}/${repo}/pulls/${number}`
}

function gitlabMrUrl(baseUrl: string, namespace: string, iid: number): string {
  return `${trimSlash(baseUrl)}/${namespace}/-/merge_requests/${iid}`
}

function githubCommentUrl(owner: string, repo: string, number: number): string {
  return `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`
}

function giteaCommentUrl(baseUrl: string, owner: string, repo: string, number: number): string {
  return `${trimSlash(baseUrl)}/api/v1/repos/${owner}/${repo}/issues/${number}/comments`
}

function gitlabNotesUrl(baseUrl: string, namespace: string, iid: number): string {
  return `${trimSlash(baseUrl)}/api/v4/projects/${encodeURIComponent(namespace)}/merge_requests/${iid}/notes`
}

function prUrlFor(kind: ForgeKind, baseUrl: string, number: number): string {
  if (kind === 'github') return githubPrUrl('acme', 'app', number)
  if (kind === 'gitlab') return gitlabMrUrl(baseUrl, 'acme/app', number)
  return giteaPrUrl(baseUrl, 'acme', 'app', number)
}

function commentUrlFor(kind: ForgeKind, baseUrl: string, number: number): string {
  if (kind === 'github') return githubCommentUrl('acme', 'app', number)
  if (kind === 'gitlab') return gitlabNotesUrl(baseUrl, 'acme/app', number)
  return giteaCommentUrl(baseUrl, 'acme', 'app', number)
}

function assertAuthHeader(kind: ForgeKind, headers: Headers, token: string): void {
  if (kind === 'github') {
    assert.equal(headers.get('authorization'), `Bearer ${token}`)
    const userAgent = headers.get('user-agent')
    assert.ok(userAgent != null && userAgent.length > 0, 'GitHub REST requires a User-Agent header')
  } else if (kind === 'gitlab') {
    assert.equal(headers.get('private-token'), token)
  } else {
    assert.equal(headers.get('authorization'), `token ${token}`)
  }
}

function createdResponse(): Response {
  return jsonResponse({ id: 1, body: COMMENT_BODY }, 201)
}

describe('commentOnPullRequest shared spec', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('POSTs { body } as JSON to the PR/MR comment endpoint with the per-kind auth header', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => createdResponse())
        const adapter = createAdapter(kind)

        await adapter.commentOnPullRequest(credential(kind), prUrlFor(kind, baseUrl, 11), COMMENT_BODY)

        assert.equal(
          requests.length,
          1,
          `expected exactly one fetch call, got ${JSON.stringify(requests.map((r) => r.url))}`,
        )
        const [req] = requests
        assert.equal(req?.method, 'POST')
        assert.equal(req?.url, commentUrlFor(kind, baseUrl, 11))
        assert.deepEqual(req?.body, { body: COMMENT_BODY })
        assert.equal(req?.headers.get('content-type'), 'application/json')
        assertAuthHeader(kind, req?.headers as Headers, tokenFor(kind))
      })

      it('any 2xx counts as success, not only 201', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        installFetch(t, () => jsonResponse({ id: 2 }, 200))
        const adapter = createAdapter(kind)
        await adapter.commentOnPullRequest(credential(kind), prUrlFor(kind, baseUrl, 12), COMMENT_BODY)
      })

      it('a non-OK response rejects with "commentOnPullRequest: <kind> responded <status>" after exactly one fetch', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse({ message: 'Forbidden' }, 403))
        const adapter = createAdapter(kind)

        await assert.rejects(
          async () => {
            await adapter.commentOnPullRequest(credential(kind), prUrlFor(kind, baseUrl, 13), COMMENT_BODY)
          },
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.equal(err.message, `commentOnPullRequest: ${kind} responded 403`)
            return true
          },
        )
        assert.equal(
          requests.length,
          1,
          'commentOnPullRequest must actually call fetch and reject on the non-OK response',
        )
      })

      it('an unparseable prUrl rejects without calling fetch, while a valid URL from the same adapter succeeds', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => createdResponse())
        const adapter = createAdapter(kind)

        await adapter.commentOnPullRequest(credential(kind), prUrlFor(kind, baseUrl, 14), COMMENT_BODY)
        assert.equal(requests.length, 1, 'the valid-URL call must reach the forge')

        await assert.rejects(async () => {
          await adapter.commentOnPullRequest(
            credential(kind),
            'https://example.com/totally/not/a/pr/url',
            COMMENT_BODY,
          )
        })
        assert.equal(requests.length, 1, 'an unparseable prUrl must reject before ever calling fetch')
      })

      it('a trailing slash on the pasted PR/MR URL is stripped before the endpoint is built', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => createdResponse())
        const adapter = createAdapter(kind)

        await adapter.commentOnPullRequest(
          credential(kind),
          `${prUrlFor(kind, baseUrl, 15)}/`,
          COMMENT_BODY,
        )
        assert.equal(requests[0]?.url, commentUrlFor(kind, baseUrl, 15))
      })

      it('#37: the request carries a bounded AbortSignal', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => createdResponse())
        const adapter = createAdapterWithTimeout(kind, 5_000)

        await adapter.commentOnPullRequest(credential(kind), prUrlFor(kind, baseUrl, 16), COMMENT_BODY)

        assert.ok(
          requests[0]?.signal instanceof AbortSignal,
          'a hung forge must not be able to block the caller forever',
        )
        assert.equal(requests[0]?.signal?.aborted, false, 'a fast response must not be falsely aborted')
      })

      it('an empty body string is still sent verbatim, not dropped', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => createdResponse())
        const adapter = createAdapter(kind)

        await adapter.commentOnPullRequest(credential(kind), prUrlFor(kind, baseUrl, 17), '')
        assert.deepEqual(requests[0]?.body, { body: '' })
      })
    })
  }

  it('github/gitea: the endpoint is the issues comment collection, not a pulls sub-path', async (t) => {
    for (const kind of ['github', 'gitea'] as const) {
      const baseUrl = WEB_ORIGIN[kind]
      const requests = installFetch(t, () => createdResponse())
      const adapter = createAdapter(kind)

      await adapter.commentOnPullRequest(credential(kind), prUrlFor(kind, baseUrl, 21), COMMENT_BODY)

      const url = requests[requests.length - 1]?.url ?? ''
      assert.equal(url, commentUrlFor(kind, baseUrl, 21))
      assert.ok(url.includes('/issues/21/comments'), `expected the issues comment collection, got ${url}`)
      assert.equal(url.includes('/pulls/'), false, `a PR comment must not go to a pulls path: ${url}`)
    }
  })

  it('github: always posts to api.github.com regardless of a custom baseUrl option', async (t) => {
    const requests = installFetch(t, () => createdResponse())
    const adapter = createAdapter('github', CUSTOM_BASE_URL.github)

    await adapter.commentOnPullRequest(credential('github'), githubPrUrl('acme', 'app', 22), COMMENT_BODY)

    assert.equal(requests[0]?.url, githubCommentUrl('acme', 'app', 22))
    assert.equal(requests[0]?.url.includes('github.example.com'), false)
  })

  it('gitlab: posts to the MR notes collection, with a nested-group namespace encoded as one :id segment', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    const namespace = 'group/subgroup/app'
    const requests = installFetch(t, () => createdResponse())
    const adapter = createAdapter('gitlab')

    await adapter.commentOnPullRequest(
      credential('gitlab'),
      gitlabMrUrl(baseUrl, namespace, 23),
      COMMENT_BODY,
    )

    assert.equal(requests[0]?.url, gitlabNotesUrl(baseUrl, namespace, 23))
    assert.ok(requests[0]?.url.endsWith('/notes'), `expected the notes collection, got ${requests[0]?.url}`)
    assert.ok(requests[0]?.url.includes(encodeURIComponent(namespace)))
  })

  it('gitlab/gitea: the API origin comes from the constructor baseUrl option, not from the prUrl host', async (t) => {
    for (const kind of ['gitlab', 'gitea'] as const) {
      const apiOrigin = CUSTOM_BASE_URL[kind]
      const webHost =
        kind === 'gitlab' ? 'https://gitlab.other-host.test' : 'https://gitea.other-host.test'
      const requests = installFetch(t, () => createdResponse())
      const adapter = createAdapter(kind, apiOrigin)

      const prUrl =
        kind === 'gitlab' ? gitlabMrUrl(webHost, 'acme/app', 24) : giteaPrUrl(webHost, 'acme', 'app', 24)
      await adapter.commentOnPullRequest(credential(kind), prUrl, COMMENT_BODY)

      const url = requests[requests.length - 1]?.url ?? ''
      assert.equal(
        url,
        commentUrlFor(kind, apiOrigin, 24),
        `${kind} must use the constructor baseUrl as the API origin, not the prUrl host`,
      )
      assert.equal(url.includes('other-host.test'), false)
    }
  })
})
