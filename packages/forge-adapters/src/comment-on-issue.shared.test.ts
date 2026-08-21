import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createForgeAdapter } from './index.ts'
import type { Credential, ForgeAdapter } from './index.ts'

// Issue #14. Shared spec for `commentOnIssue`, parameterized over github/gitlab/gitea, mirroring
// `import-issue.shared.test.ts`'s fetch-stub shape (issue-URL parsing, host/SSRF rule). Do not
// import that file — the helpers below are deliberately copied and trimmed to what this spec
// needs, per this project's one-shared-spec-per-file convention.
//
// HEAD `a722c8b`: `commentOnIssue` is unconditionally `notImplemented()` for every kind — it
// throws `new Error('not implemented')` synchronously without inspecting `cred`/`issueRef`/`body`
// or ever calling `fetch` — and `IssueRef` is `export type IssueRef = unknown`. Every "rejects"
// assertion below therefore predicates on `err.message !== 'not implemented'` (and, where
// relevant, on zero fetch calls): a bare `assert.rejects`/`assert.throws` with no predicate would
// pass against today's stub and must not be used here.

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

type RecordedRequest = {
  url: string
  method: string
  headers: Headers
  body: unknown
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
      const method = requestMethod(input, init)
      const headers = requestHeaders(input, init)
      const body = requestBodyJson(input, init)
      recorded.push({ url, method, headers, body })
      return respond(url)
    },
  )
  return recorded
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, '')
}

function githubIssueUrl(owner: string, repo: string, number: number): string {
  return `${WEB_ORIGIN.github}/${owner}/${repo}/issues/${number}`
}

function giteaIssueUrl(baseUrl: string, owner: string, repo: string, number: number): string {
  return `${trimSlash(baseUrl)}/${owner}/${repo}/issues/${number}`
}

function gitlabIssueUrl(baseUrl: string, namespace: string, iid: number): string {
  return `${trimSlash(baseUrl)}/${namespace}/-/issues/${iid}`
}

function githubCommentApiUrl(owner: string, repo: string, number: number): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`
}

function giteaCommentApiUrl(baseUrl: string, owner: string, repo: string, number: number): string {
  return `${trimSlash(baseUrl)}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`
}

function gitlabNoteApiUrl(baseUrl: string, namespace: string, iid: number): string {
  return `${trimSlash(baseUrl)}/api/v4/projects/${encodeURIComponent(namespace)}/issues/${iid}/notes`
}

function issueUrlFor(
  kind: ForgeKind,
  baseUrl: string,
  ids: { owner?: string; repo?: string; namespace?: string; number: number },
): string {
  if (kind === 'github') return githubIssueUrl(ids.owner ?? 'acme', ids.repo ?? 'app', ids.number)
  if (kind === 'gitlab') return gitlabIssueUrl(baseUrl, ids.namespace ?? 'acme/app', ids.number)
  return giteaIssueUrl(baseUrl, ids.owner ?? 'acme', ids.repo ?? 'app', ids.number)
}

function commentApiUrlFor(
  kind: ForgeKind,
  baseUrl: string,
  ids: { owner?: string; repo?: string; namespace?: string; number: number },
): string {
  if (kind === 'github') return githubCommentApiUrl(ids.owner ?? 'acme', ids.repo ?? 'app', ids.number)
  if (kind === 'gitlab') return gitlabNoteApiUrl(baseUrl, ids.namespace ?? 'acme/app', ids.number)
  return giteaCommentApiUrl(baseUrl, ids.owner ?? 'acme', ids.repo ?? 'app', ids.number)
}

function issueRefFor(
  kind: ForgeKind,
  baseUrl: string,
  ids: { owner?: string; repo?: string; namespace?: string; number: number },
): { issue_url: string } {
  return { issue_url: issueUrlFor(kind, baseUrl, ids) }
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

function unparseablePullUrl(kind: ForgeKind, baseUrl: string): string {
  if (kind === 'github') return `${WEB_ORIGIN.github}/acme/app/pull/9`
  if (kind === 'gitea') return `${trimSlash(baseUrl)}/acme/app/pulls/9`
  return `${trimSlash(baseUrl)}/acme/app/-/merge_requests/9`
}

function assertNotPlaceholder(err: unknown): boolean {
  assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`)
  assert.notEqual(
    (err as Error).message,
    'not implemented',
    'a real commentOnIssue failure must not be the notImplemented placeholder',
  )
  return true
}

describe('commentOnIssue shared spec', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('POSTs { body } to the comment endpoint with the same per-kind auth headers as the sibling methods', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse({ id: 1 }, 201))
        const adapter = createAdapter(kind)
        const issueRef = issueRefFor(kind, baseUrl, { number: 61 })

        const result = await adapter.commentOnIssue(credential(kind), issueRef, '认领：kt-2026-0001')
        assert.equal(result, undefined, 'commentOnIssue resolves Promise<void>')

        assert.equal(
          requests.length,
          1,
          `expected exactly one fetch call, got ${JSON.stringify(requests.map((r) => r.url))}`,
        )
        const [req] = requests
        assert.equal(req.method, 'POST')
        assert.equal(req.url, commentApiUrlFor(kind, baseUrl, { number: 61 }))
        assertAuthHeader(kind, req.headers, tokenFor(kind))
        assert.deepEqual(req.body, { body: '认领：kt-2026-0001' })
      })

      it('treats any res.ok (2xx) response as success, not only a hard-coded 201', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        installFetch(t, () => jsonResponse({ id: 2 }, 200))
        const adapter = createAdapter(kind)
        const issueRef = issueRefFor(kind, baseUrl, { number: 62 })

        await assert.doesNotReject(async () => {
          await adapter.commentOnIssue(credential(kind), issueRef, 'a 200 response must still resolve')
        })
      })

      it('non-OK HTTP response rejects with "commentOnIssue: <kind> responded <status>", after exactly one fetch', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse({ message: 'Forbidden' }, 403))
        const adapter = createAdapter(kind)
        const issueRef = issueRefFor(kind, baseUrl, { number: 63 })

        await assert.rejects(
          async () => {
            await adapter.commentOnIssue(credential(kind), issueRef, 'should fail')
          },
          (err: unknown) => {
            assertNotPlaceholder(err)
            assert.match((err as Error).message, new RegExp(`commentOnIssue: ${kind} responded 403`))
            return true
          },
        )
        assert.equal(
          requests.length,
          1,
          'commentOnIssue must actually call fetch and reject on the non-OK response, not reject for an unrelated reason',
        )
        assert.equal(requests[0]?.url, commentApiUrlFor(kind, baseUrl, { number: 63 }))
      })

      it('an unparseable issue_url rejects without calling fetch (not merely notImplemented)', async (t) => {
        const requests = installFetch(t, () => jsonResponse({ id: 3 }, 201))
        const adapter = createAdapter(kind)

        await assert.rejects(
          async () => {
            await adapter.commentOnIssue(
              credential(kind),
              { issue_url: 'https://example.com/totally/not/an/issue' },
              'x',
            )
          },
          assertNotPlaceholder,
        )
        assert.equal(requests.length, 0, 'an unparseable issue_url must reject before ever calling fetch')
      })

      it('a pull/MR web path in issue_url is unparseable and must not fetch', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse({ id: 4 }, 201))
        const adapter = createAdapter(kind)
        const pasted = unparseablePullUrl(kind, baseUrl)

        await assert.rejects(
          async () => {
            await adapter.commentOnIssue(credential(kind), { issue_url: pasted }, 'x')
          },
          assertNotPlaceholder,
        )
        assert.equal(requests.length, 0, `${pasted} must be rejected with zero fetch`)
      })
    })
  }

  it('github: always POSTs to api.github.com regardless of a custom baseUrl option or the pasted issue host', async (t) => {
    const requests = installFetch(t, () => jsonResponse({ id: 5 }, 201))
    const adapter = createAdapter('github', CUSTOM_BASE_URL.github)
    const pastedHost = 'https://github.other-host.test'
    const issueRef = { issue_url: `${pastedHost}/acme/app/issues/71` }

    await adapter.commentOnIssue(credential('github'), issueRef, 'x')

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, githubCommentApiUrl('acme', 'app', 71))
    assert.equal(requests[0]?.url.includes('github.example.com'), false)
    assert.equal(requests[0]?.url.includes('github.other-host.test'), false)
  })

  it('gitlab/gitea: the API origin comes from the constructor baseUrl option, never from the issue_url host (SSRF)', async (t) => {
    for (const kind of ['gitlab', 'gitea'] as const) {
      const apiOrigin = CUSTOM_BASE_URL[kind]
      const webHost = kind === 'gitlab' ? 'https://gitlab.other-host.test' : 'https://gitea.other-host.test'
      const requests = installFetch(t, () => jsonResponse({ id: 6 }, 201))
      const adapter = createAdapter(kind, apiOrigin)

      const pasted =
        kind === 'gitlab' ? gitlabIssueUrl(webHost, 'acme/app', 72) : giteaIssueUrl(webHost, 'acme', 'app', 72)
      await adapter.commentOnIssue(credential(kind), { issue_url: pasted }, 'x')

      const expected = commentApiUrlFor(kind, apiOrigin, { number: 72 })
      assert.equal(
        requests[requests.length - 1]?.url,
        expected,
        `${kind} must use the constructor baseUrl as the API origin, not the issue_url host`,
      )
      assert.equal(
        requests.some((req) => req.url.includes('other-host.test')),
        false,
        `${kind} must never fetch the pasted issue host (SSRF)`,
      )
    }
  })

  it('gitlab: a nested-group namespace is encodeURIComponent-ed as a single :id segment in the notes URL', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    const namespace = 'group/subgroup/app'
    const requests = installFetch(t, () => jsonResponse({ id: 7 }, 201))
    const adapter = createAdapter('gitlab')

    await adapter.commentOnIssue(credential('gitlab'), { issue_url: gitlabIssueUrl(baseUrl, namespace, 73) }, 'x')

    assert.equal(requests[0]?.url, gitlabNoteApiUrl(baseUrl, namespace, 73))
    assert.ok(
      requests[0]?.url.includes(encodeURIComponent(namespace)),
      `expected the namespace to be encodeURIComponent-ed as one segment: ${requests[0]?.url}`,
    )
    assert.equal(requests[0]?.url.includes('/group/subgroup/app/'), false)
  })

  it('the same body string is sent verbatim as the JSON { body } field for every kind', async (t) => {
    for (const kind of KINDS) {
      const baseUrl = WEB_ORIGIN[kind]
      const requests = installFetch(t, () => jsonResponse({ id: 8 }, 201))
      const adapter = createAdapter(kind)
      const commentText = '提交 PR：https://example.test/pr/1\n\n完成后将自动更新任务状态。'

      await adapter.commentOnIssue(credential(kind), issueRefFor(kind, baseUrl, { number: 74 }), commentText)

      assert.deepEqual(requests[requests.length - 1]?.body, { body: commentText })
    }
  })
})
