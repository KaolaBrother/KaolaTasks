import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createForgeAdapter } from './index.ts'
import type { Credential, ForgeAdapter, ImportedIssue } from './index.ts'

// Issue #12. Shared spec for `importIssue`, parameterized over github/gitlab/gitea, mirroring
// `get-pull-request.shared.test.ts`'s fetch-stub shape. Do not import that file — the helpers
// below are deliberately copied and trimmed to what this spec needs.

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
      recorded.push({ url, method, headers })
      return respond(url)
    },
  )
  return recorded
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, '')
}

function githubIssueUrl(owner: string, repo: string, number: number, suffix = ''): string {
  return `${WEB_ORIGIN.github}/${owner}/${repo}/issues/${number}${suffix}`
}

function giteaIssueUrl(baseUrl: string, owner: string, repo: string, number: number, suffix = ''): string {
  return `${trimSlash(baseUrl)}/${owner}/${repo}/issues/${number}${suffix}`
}

function gitlabIssueUrl(baseUrl: string, namespace: string, iid: number, suffix = ''): string {
  return `${trimSlash(baseUrl)}/${namespace}/-/issues/${iid}${suffix}`
}

function gitlabLegacyIssueUrl(baseUrl: string, namespace: string, iid: number): string {
  return `${trimSlash(baseUrl)}/${namespace}/issues/${iid}`
}

function githubApiUrl(owner: string, repo: string, number: number): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`
}

function giteaApiUrl(baseUrl: string, owner: string, repo: string, number: number): string {
  return `${trimSlash(baseUrl)}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`
}

function gitlabApiUrl(baseUrl: string, namespace: string, iid: number): string {
  return `${trimSlash(baseUrl)}/api/v4/projects/${encodeURIComponent(namespace)}/issues/${iid}`
}

function issueUrlFor(
  kind: ForgeKind,
  baseUrl: string,
  ids: { owner?: string; repo?: string; namespace?: string; number: number },
  suffix = '',
): string {
  if (kind === 'github') return githubIssueUrl(ids.owner ?? 'acme', ids.repo ?? 'app', ids.number, suffix)
  if (kind === 'gitlab') return gitlabIssueUrl(baseUrl, ids.namespace ?? 'acme/app', ids.number, suffix)
  return giteaIssueUrl(baseUrl, ids.owner ?? 'acme', ids.repo ?? 'app', ids.number, suffix)
}

function apiUrlFor(
  kind: ForgeKind,
  baseUrl: string,
  ids: { owner?: string; repo?: string; namespace?: string; number: number },
): string {
  if (kind === 'github') return githubApiUrl(ids.owner ?? 'acme', ids.repo ?? 'app', ids.number)
  if (kind === 'gitlab') return gitlabApiUrl(baseUrl, ids.namespace ?? 'acme/app', ids.number)
  return giteaApiUrl(baseUrl, ids.owner ?? 'acme', ids.repo ?? 'app', ids.number)
}

function fullNameFor(
  kind: ForgeKind,
  ids: { owner?: string; repo?: string; namespace?: string } = {},
): string {
  if (kind === 'gitlab') return ids.namespace ?? 'acme/app'
  return `${ids.owner ?? 'acme'}/${ids.repo ?? 'app'}`
}

function issueJson(
  kind: ForgeKind,
  fields: { title?: unknown; body?: unknown; description?: unknown } = {},
): Record<string, unknown> {
  const title = Object.prototype.hasOwnProperty.call(fields, 'title') ? fields.title : 'Fix the pager'
  if (kind === 'gitlab') {
    const description = Object.prototype.hasOwnProperty.call(fields, 'description')
      ? fields.description
      : 'GitLab description markdown'
    return { title, description }
  }
  const body = Object.prototype.hasOwnProperty.call(fields, 'body')
    ? fields.body
    : 'GitHub/Gitea body markdown'
  return { title, body }
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

function assertImportedIssue(
  result: ImportedIssue,
  expected: { title: string; description_md: string; issue_url: string; full_name: string },
): void {
  assert.equal(typeof result, 'object', `ImportedIssue must be an object, got ${JSON.stringify(result)}`)
  assert.ok(result !== null)
  const value = result as {
    title?: unknown
    description_md?: unknown
    issue_url?: unknown
    repo?: { full_name?: unknown }
  }
  assert.equal(value.title, expected.title)
  assert.equal(value.description_md, expected.description_md)
  assert.equal(value.issue_url, expected.issue_url)
  assert.equal(typeof value.repo, 'object')
  assert.ok(value.repo != null)
  assert.equal(value.repo.full_name, expected.full_name)
  assert.deepEqual(Object.keys(value.repo), ['full_name'])
}

function descriptionFor(kind: ForgeKind): string {
  return kind === 'gitlab' ? 'GitLab description markdown' : 'GitHub/Gitea body markdown'
}

function unparseablePullUrl(kind: ForgeKind, baseUrl: string): string {
  if (kind === 'github') return `${WEB_ORIGIN.github}/acme/app/pull/9`
  if (kind === 'gitea') return `${trimSlash(baseUrl)}/acme/app/pulls/9`
  return `${trimSlash(baseUrl)}/acme/app/-/merge_requests/9`
}

describe('importIssue shared spec', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('GETs the issue endpoint with validateToken-style auth headers and returns ImportedIssue', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse(issueJson(kind)))
        const adapter = createAdapter(kind)
        const pasted = issueUrlFor(kind, baseUrl, { number: 11 })

        const result = await adapter.importIssue(credential(kind), pasted)
        assertImportedIssue(result, {
          title: 'Fix the pager',
          description_md: descriptionFor(kind),
          issue_url: pasted,
          full_name: fullNameFor(kind),
        })

        assert.equal(
          requests.length,
          1,
          `expected exactly one fetch call, got ${JSON.stringify(requests.map((r) => r.url))}`,
        )
        const [req] = requests
        assert.equal(req.method, 'GET')
        assert.equal(req.url, apiUrlFor(kind, baseUrl, { number: 11 }))
        assertAuthHeader(kind, req.headers, tokenFor(kind))
      })

      it('trailing slash on the pasted URL is stripped before parsing and from returned issue_url', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse(issueJson(kind)))
        const adapter = createAdapter(kind)
        const pasted = `${issueUrlFor(kind, baseUrl, { number: 24 })}/`

        const result = await adapter.importIssue(credential(kind), pasted)
        assertImportedIssue(result, {
          title: 'Fix the pager',
          description_md: descriptionFor(kind),
          issue_url: issueUrlFor(kind, baseUrl, { number: 24 }),
          full_name: fullNameFor(kind),
        })
        assert.equal(requests[0]?.url, apiUrlFor(kind, baseUrl, { number: 24 }))
      })

      it('query and hash on the pasted URL are dropped by pathname when building the REST URL', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse(issueJson(kind)))
        const adapter = createAdapter(kind)
        const pasted = `${issueUrlFor(kind, baseUrl, { number: 27 })}?foo=1#comment-9`

        const result = await adapter.importIssue(credential(kind), pasted)
        assert.equal((result as { title?: unknown }).title, 'Fix the pager')
        assert.equal(requests[0]?.url, apiUrlFor(kind, baseUrl, { number: 27 }))
      })

      it('null issue body/description maps to an empty description_md', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const adapter = createAdapter(kind)
        const nullBody =
          kind === 'gitlab' ? issueJson(kind, { description: null }) : issueJson(kind, { body: null })
        installFetch(t, () => jsonResponse(nullBody))
        const fromNull = await adapter.importIssue(credential(kind), issueUrlFor(kind, baseUrl, { number: 28 }))
        assert.equal((fromNull as { description_md?: unknown }).description_md, '')
      })

      it('missing issue body/description maps to an empty description_md', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const adapter = createAdapter(kind)
        installFetch(t, () => jsonResponse({ title: 'Fix the pager' }))
        const fromMissing = await adapter.importIssue(
          credential(kind),
          issueUrlFor(kind, baseUrl, { number: 29 }),
        )
        assert.equal((fromMissing as { description_md?: unknown }).description_md, '')
      })

      it('returned issue_url is the pasted web URL, not html_url / web_url from JSON', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const pasted = issueUrlFor(kind, baseUrl, { number: 30 })
        installFetch(t, () =>
          jsonResponse({
            ...issueJson(kind),
            html_url: 'https://html-url.example/lie',
            web_url: 'https://web-url.example/lie',
          }),
        )
        const adapter = createAdapter(kind)
        const result = await adapter.importIssue(credential(kind), pasted)
        assert.equal((result as { issue_url?: unknown }).issue_url, pasted)
      })

      it('missing or non-string title rejects after fetch', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse(issueJson(kind, { title: 12 })))
        const adapter = createAdapter(kind)
        await assert.rejects(async () => {
          await adapter.importIssue(credential(kind), issueUrlFor(kind, baseUrl, { number: 31 }))
        })
        assert.equal(
          requests.length,
          1,
          'a 200 JSON payload with a bad title must still have fetched once',
        )
      })

      it('non-OK HTTP response rejects after actually calling fetch, with status in the message', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse({ message: 'Not Found' }, 404))
        const adapter = createAdapter(kind)
        await assert.rejects(
          async () => {
            await adapter.importIssue(credential(kind), issueUrlFor(kind, baseUrl, { number: 25 }))
          },
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.match(err.message, new RegExp(`${kind} responded 404`))
            return true
          },
        )
        assert.equal(
          requests.length,
          1,
          'importIssue must actually call fetch and reject on the non-OK response, not reject for an unrelated reason',
        )
        assert.equal(requests[0]?.url, apiUrlFor(kind, baseUrl, { number: 25 }))
      })

      it('an unparseable issueUrl rejects without calling fetch (not merely notImplemented)', async (t) => {
        const requests = installFetch(t, () => jsonResponse(issueJson(kind)))
        const adapter = createAdapter(kind)

        await assert.rejects(
          async () => {
            await adapter.importIssue(credential(kind), 'https://example.com/totally/not/an/issue')
          },
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.notEqual(
              err.message,
              'not implemented',
              'unparseable must fail as a parse error, not the notImplemented placeholder',
            )
            return true
          },
        )
        assert.equal(requests.length, 0, 'an unparseable issueUrl must reject before ever calling fetch')
      })

      it('a pull/MR/work-item web path is unparseable and must not fetch', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse(issueJson(kind)))
        const adapter = createAdapter(kind)
        const pasted = unparseablePullUrl(kind, baseUrl)

        await assert.rejects(
          async () => {
            await adapter.importIssue(credential(kind), pasted)
          },
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.notEqual(err.message, 'not implemented')
            return true
          },
        )
        assert.equal(requests.length, 0, `${pasted} must be rejected with zero fetch`)
      })
    })
  }

  it('github: always calls api.github.com regardless of a custom baseUrl option or pasted host', async (t) => {
    const requests = installFetch(t, () => jsonResponse(issueJson('github')))
    const adapter = createAdapter('github', CUSTOM_BASE_URL.github)
    const pasted = 'https://github.other-host.test/acme/app/issues/32'

    const result = await adapter.importIssue(credential('github'), pasted)
    assertImportedIssue(result, {
      title: 'Fix the pager',
      description_md: descriptionFor('github'),
      issue_url: pasted,
      full_name: 'acme/app',
    })
    assert.equal(requests[0]?.url, githubApiUrl('acme', 'app', 32))
    assert.equal(requests[0]?.url.includes('github.example.com'), false)
    assert.equal(requests[0]?.url.includes('github.other-host.test'), false)
  })

  it('github/gitea: a GET /issues/{n} payload that includes pull_request is still accepted', async (t) => {
    for (const kind of ['github', 'gitea'] as const) {
      const baseUrl = WEB_ORIGIN[kind]
      const requests = installFetch(t, () =>
        jsonResponse({ ...issueJson(kind), pull_request: { url: 'https://example.test/pr' } }),
      )
      const adapter = createAdapter(kind)
      const pasted = issueUrlFor(kind, baseUrl, { number: 33 })
      const result = await adapter.importIssue(credential(kind), pasted)
      assert.equal((result as { title?: unknown }).title, 'Fix the pager')
      assert.equal((result as { description_md?: unknown }).description_md, descriptionFor(kind))
      assert.equal(requests[requests.length - 1]?.url, apiUrlFor(kind, baseUrl, { number: 33 }))
    }
  })

  it('gitlab: description_md comes from JSON description, not body', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    installFetch(t, () =>
      jsonResponse({
        title: 'Fix the pager',
        body: 'WRONG body field',
        description: 'RIGHT description field',
      }),
    )
    const adapter = createAdapter('gitlab')
    const result = await adapter.importIssue(credential('gitlab'), gitlabIssueUrl(baseUrl, 'acme/app', 41))
    assert.equal((result as { description_md?: unknown }).description_md, 'RIGHT description field')
  })

  it('github/gitea: description_md comes from JSON body, not description', async (t) => {
    for (const kind of ['github', 'gitea'] as const) {
      const baseUrl = WEB_ORIGIN[kind]
      installFetch(t, () =>
        jsonResponse({
          title: 'Fix the pager',
          body: 'RIGHT body field',
          description: 'WRONG description field',
        }),
      )
      const adapter = createAdapter(kind)
      const result = await adapter.importIssue(credential(kind), issueUrlFor(kind, baseUrl, { number: 42 }))
      assert.equal((result as { description_md?: unknown }).description_md, 'RIGHT body field')
    }
  })

  it('gitlab: a nested-group namespace is encodeURIComponent-ed as a single :id segment', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    const namespace = 'group/subgroup/app'
    const requests = installFetch(t, () => jsonResponse(issueJson('gitlab')))
    const adapter = createAdapter('gitlab')
    const result = await adapter.importIssue(
      credential('gitlab'),
      gitlabIssueUrl(baseUrl, namespace, 43),
    )
    assert.equal((result as { repo?: { full_name?: unknown } }).repo?.full_name, namespace)
    assert.equal(requests[0]?.url, gitlabApiUrl(baseUrl, namespace, 43))
    assert.ok(
      requests[0]?.url.includes(encodeURIComponent(namespace)),
      `expected the namespace to be encodeURIComponent-ed as one segment: ${requests[0]?.url}`,
    )
    assert.equal(requests[0]?.url.includes('/group/subgroup/app/'), false)
  })

  it('gitlab: canonical /-/issues/ is not parsed as a legacy namespace ending in /-', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    const namespace = 'group/sub/project'
    const requests = installFetch(t, () => jsonResponse(issueJson('gitlab')))
    const adapter = createAdapter('gitlab')
    await adapter.importIssue(credential('gitlab'), gitlabIssueUrl(baseUrl, namespace, 44))
    assert.equal(requests[0]?.url, gitlabApiUrl(baseUrl, namespace, 44))
    assert.equal(
      requests[0]?.url.includes(encodeURIComponent('group/sub/project/-')),
      false,
      `canonical /-/issues/ must not feed a trailing /- into the project id: ${requests[0]?.url}`,
    )
  })

  it('gitlab: the legacy /issues/ web_url (no /-/) is also accepted', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    const namespace = 'my-group/my-project'
    const requests = installFetch(t, () => jsonResponse(issueJson('gitlab')))
    const adapter = createAdapter('gitlab')
    const pasted = gitlabLegacyIssueUrl(baseUrl, namespace, 45)
    const result = await adapter.importIssue(credential('gitlab'), pasted)
    assertImportedIssue(result, {
      title: 'Fix the pager',
      description_md: descriptionFor('gitlab'),
      issue_url: pasted,
      full_name: namespace,
    })
    assert.equal(requests[0]?.url, gitlabApiUrl(baseUrl, namespace, 45))
  })

  it('gitlab: /-/work_items/ is unparseable (zero fetch)', async (t) => {
    const requests = installFetch(t, () => jsonResponse(issueJson('gitlab')))
    const adapter = createAdapter('gitlab')
    await assert.rejects(
      async () => {
        await adapter.importIssue(
          credential('gitlab'),
          `${WEB_ORIGIN.gitlab}/acme/app/-/work_items/46`,
        )
      },
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.notEqual(err.message, 'not implemented')
        return true
      },
    )
    assert.equal(requests.length, 0)
  })

  it('gitlab/gitea: the API origin comes from the constructor baseUrl option, not from the issueUrl host', async (t) => {
    for (const kind of ['gitlab', 'gitea'] as const) {
      const apiOrigin = CUSTOM_BASE_URL[kind]
      const webHost = kind === 'gitlab' ? 'https://gitlab.other-host.test' : 'https://gitea.other-host.test'
      const requests = installFetch(t, () => jsonResponse(issueJson(kind)))
      const adapter = createAdapter(kind, apiOrigin)

      const pasted =
        kind === 'gitlab'
          ? gitlabIssueUrl(webHost, 'acme/app', 47)
          : giteaIssueUrl(webHost, 'acme', 'app', 47)
      const result = await adapter.importIssue(credential(kind), pasted)
      assertImportedIssue(result, {
        title: 'Fix the pager',
        description_md: descriptionFor(kind),
        issue_url: pasted,
        full_name: fullNameFor(kind),
      })

      const expected = apiUrlFor(kind, apiOrigin, { number: 47 })
      assert.equal(
        requests[requests.length - 1]?.url,
        expected,
        `${kind} must use the constructor baseUrl as the API origin, not the issueUrl host`,
      )
      assert.equal(
        requests.some((req) => req.url.includes('other-host.test')),
        false,
        `${kind} must never fetch the pasted issue host (SSRF)`,
      )
    }
  })
})
