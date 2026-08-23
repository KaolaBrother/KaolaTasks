import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createForgeAdapter, parseIssueUrl } from './index.ts'
import type { Credential, ForgeAdapter, RepoRef } from './index.ts'

// Issue #19. Shared spec for `listIssues`, parameterized over github/gitlab/gitea, mirroring
// `import-issue.shared.test.ts`'s fetch-stub shape. Do not import that file — the helpers
// below are deliberately copied and trimmed to what this spec needs.

const KINDS = ['github', 'gitlab', 'gitea'] as const
type ForgeKind = (typeof KINDS)[number]

const FULL_NAME = 'acme/app'

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

const WEB_ORIGIN_OTHER = {
  github: 'https://github.web-origin.test',
  gitlab: 'https://gitlab.web-origin.test',
  gitea: 'https://gitea.web-origin.test',
} as const

type ListedIssue = {
  number: number
  title: string
  issue_url: string
}

type ListIssuesMethod = (cred: Credential, repo: RepoRef) => Promise<ListedIssue[]>

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

function callListIssues(adapter: ForgeAdapter, cred: Credential, repo: RepoRef): Promise<ListedIssue[]> {
  return (adapter as ForgeAdapter & { listIssues: ListIssuesMethod }).listIssues(cred, repo)
}

function repoRef(kind: ForgeKind, baseUrl = WEB_ORIGIN[kind], fullName = FULL_NAME): RepoRef {
  return { full_name: fullName, base_url: baseUrl }
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

function splitOwnerRepo(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf('/')
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) }
}

function listApiUrl(kind: ForgeKind, constructorBase: string, fullName = FULL_NAME): string {
  if (kind === 'github') {
    const { owner, repo } = splitOwnerRepo(fullName)
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=50&sort=created&direction=desc`
  }
  const origin = trimSlash(constructorBase)
  if (kind === 'gitlab') {
    return `${origin}/api/v4/projects/${encodeURIComponent(fullName)}/issues?state=opened&per_page=50&order_by=created_at&sort=desc`
  }
  const { owner, repo } = splitOwnerRepo(fullName)
  return `${origin}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&type=issues&limit=50`
}

function expectedIssueUrl(
  kind: ForgeKind,
  repoBaseUrl: string,
  number: number,
  fullName = FULL_NAME,
): string {
  const base = trimSlash(repoBaseUrl)
  if (kind === 'gitlab') return `${base}/${fullName}/-/issues/${number}`
  return `${base}/${fullName}/issues/${number}`
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

function issueJsonItems(
  kind: ForgeKind,
  items: readonly { number: number; title: string; pullRequest?: boolean }[],
): Record<string, unknown>[] {
  return items.map((item) => {
    if (kind === 'github') {
      const row: Record<string, unknown> = {
        number: item.number,
        title: item.title,
        html_url: `https://html-url.example/${FULL_NAME}/issues/${item.number}`,
      }
      if (item.pullRequest) {
        row.pull_request = {
          url: `https://api.github.com/repos/${FULL_NAME}/pulls/${item.number}`,
        }
      }
      return row
    }
    if (kind === 'gitlab') {
      return {
        id: 900000 + item.number,
        iid: item.number,
        title: item.title,
        web_url: `https://evil.example/${FULL_NAME}/-/work_items/${item.number}`,
      }
    }
    return {
      id: 800000 + item.number,
      number: item.number,
      title: item.title,
      html_url: `https://html-url.example/${FULL_NAME}/issues/${item.number}`,
    }
  })
}

function assertListedIssue(
  kind: ForgeKind,
  actual: unknown,
  expected: { number: number; title: string; issue_url: string; full_name: string },
): void {
  assert.equal(typeof actual, 'object', `ListedIssue must be an object, got ${JSON.stringify(actual)}`)
  assert.ok(actual !== null)
  const value = actual as { number?: unknown; title?: unknown; issue_url?: unknown }
  assert.equal(typeof value.number, 'number')
  assert.equal(value.number, expected.number)
  assert.equal(value.title, expected.title)
  assert.equal(value.issue_url, expected.issue_url)
  assert.deepEqual(parseIssueUrl(kind, String(value.issue_url)), { full_name: expected.full_name })
}

describe('listIssues shared spec', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('GETs the open-issues list with importIssue-style auth headers and returns ListedIssue[]', async (t) => {
        const constructorBase = WEB_ORIGIN[kind]
        const repo = repoRef(kind)
        const title = 'Fix the pager'
        const number = 12
        const requests = installFetch(t, () => jsonResponse(issueJsonItems(kind, [{ number, title }])))
        const adapter = createAdapter(kind)

        assert.equal(
          typeof (adapter as ForgeAdapter & { listIssues?: unknown }).listIssues,
          'function',
        )
        const result = await callListIssues(adapter, credential(kind), repo)

        assert.ok(Array.isArray(result), `listIssues must return an array, got ${JSON.stringify(result)}`)
        assert.equal(result.length, 1)
        assertListedIssue(kind, result[0], {
          number,
          title,
          issue_url: expectedIssueUrl(kind, repo.base_url, number),
          full_name: FULL_NAME,
        })

        assert.equal(
          requests.length,
          1,
          `expected exactly one fetch call, got ${JSON.stringify(requests.map((r) => r.url))}`,
        )
        const [req] = requests
        assert.equal(req.method, 'GET')
        assert.equal(req.url, listApiUrl(kind, constructorBase))
        assertAuthHeader(kind, req.headers, tokenFor(kind))
      })

      it('trailing slash on repo.base_url is stripped when constructing issue_url', async (t) => {
        const repo = repoRef(kind, `${WEB_ORIGIN[kind]}/`)
        installFetch(t, () => jsonResponse(issueJsonItems(kind, [{ number: 24, title: 'Fix the pager' }])))
        const adapter = createAdapter(kind)
        const result = await callListIssues(adapter, credential(kind), repo)
        assert.equal(result[0]?.issue_url, expectedIssueUrl(kind, WEB_ORIGIN[kind], 24))
        assert.equal(result[0]?.issue_url.includes(`${trimSlash(WEB_ORIGIN[kind])}//`), false)
        assert.deepEqual(parseIssueUrl(kind, String(result[0]?.issue_url)), { full_name: FULL_NAME })
      })

      for (const status of [401, 500] as const) {
        it(`non-OK HTTP ${status} rejects after fetch with listIssues: ${kind} responded ${status}`, async (t) => {
          const requests = installFetch(t, () => jsonResponse({ message: 'nope' }, status))
          const adapter = createAdapter(kind)
          await assert.rejects(
            async () => {
              await callListIssues(adapter, credential(kind), repoRef(kind))
            },
            (err: unknown) => {
              assert.ok(err instanceof Error)
              assert.match(err.message, new RegExp(`listIssues: ${kind} responded ${status}`))
              return true
            },
          )
          assert.equal(
            requests.length,
            1,
            'listIssues must actually call fetch and reject on the non-OK response, not reject for an unrelated reason',
          )
          assert.equal(requests[0]?.url, listApiUrl(kind, WEB_ORIGIN[kind]))
        })
      }

      it('a network rejection from fetch rejects the listIssues promise', async (t) => {
        const requests = installFetch(t, () => {
          throw new Error('network down')
        })
        const adapter = createAdapter(kind)
        await assert.rejects(
          async () => {
            await callListIssues(adapter, credential(kind), repoRef(kind))
          },
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.match(err.message, /network down/)
            return true
          },
        )
        assert.equal(requests.length, 1, 'listIssues must have called fetch before the network rejection')
      })

      it('keeps JSON array order and does not re-sort', async (t) => {
        const items = [
          { number: 4, title: 'Zed' },
          { number: 11, title: 'Alpha' },
          { number: 2, title: 'Mike' },
        ] as const
        installFetch(t, () => jsonResponse(issueJsonItems(kind, items)))
        const adapter = createAdapter(kind)
        const result = await callListIssues(adapter, credential(kind), repoRef(kind))
        assert.ok(Array.isArray(result))
        assert.deepEqual(
          result.map((row) => row.number),
          [4, 11, 2],
        )
        assert.deepEqual(
          result.map((row) => row.title),
          ['Zed', 'Alpha', 'Mike'],
        )
      })
    })
  }

  it('github: always calls api.github.com even with constructor baseUrl and a different repo.base_url', async (t) => {
    const repo = repoRef('github', WEB_ORIGIN_OTHER.github)
    const requests = installFetch(t, () =>
      jsonResponse(issueJsonItems('github', [{ number: 32, title: 'Fix the pager' }])),
    )
    const adapter = createAdapter('github', CUSTOM_BASE_URL.github)
    const result = await callListIssues(adapter, credential('github'), repo)

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, listApiUrl('github', CUSTOM_BASE_URL.github))
    assert.equal(requests[0]?.url.includes('github.example.com'), false)
    assert.equal(requests[0]?.url.includes('github.web-origin.test'), false)
    assert.equal(new URL(requests[0]?.url ?? '').host, 'api.github.com')
    assertListedIssue('github', result[0], {
      number: 32,
      title: 'Fix the pager',
      issue_url: expectedIssueUrl('github', WEB_ORIGIN_OTHER.github, 32),
      full_name: FULL_NAME,
    })
  })

  it('github: drops an item with a pull_request object; a following real issue remains; html_url is not copied', async (t) => {
    const repo = repoRef('github')
    const requests = installFetch(t, () =>
      jsonResponse([
        {
          number: 6,
          title: 'First real issue',
          html_url: 'https://html-url.example/acme/app/issues/6',
        },
        {
          number: 8,
          title: 'This is a PR',
          html_url: 'https://html-url.example/acme/app/pull/8',
          pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/8' },
        },
        {
          number: 9,
          title: 'Real issue after PR',
          html_url: 'https://html-url.example/acme/app/issues/9',
        },
      ]),
    )
    const adapter = createAdapter('github')
    const result = await callListIssues(adapter, credential('github'), repo)

    assert.equal(requests.length, 1)
    assert.ok(Array.isArray(result))
    assert.equal(result.length, 2)
    assertListedIssue('github', result[0], {
      number: 6,
      title: 'First real issue',
      issue_url: expectedIssueUrl('github', WEB_ORIGIN.github, 6),
      full_name: FULL_NAME,
    })
    assertListedIssue('github', result[1], {
      number: 9,
      title: 'Real issue after PR',
      issue_url: expectedIssueUrl('github', WEB_ORIGIN.github, 9),
      full_name: FULL_NAME,
    })
    assert.equal(
      result.some((row) => row.number === 8),
      false,
      'an item whose JSON includes a pull_request object must be absent from the result',
    )
    assert.equal(result[0]?.issue_url.includes('html-url.example'), false)
    assert.equal(result[1]?.issue_url.includes('html-url.example'), false)
  })

  it('gitlab: API origin is constructor baseUrl, never repo.base_url, never JSON web_url host', async (t) => {
    const constructorBase = CUSTOM_BASE_URL.gitlab
    const repo = repoRef('gitlab', WEB_ORIGIN_OTHER.gitlab)
    const webUrl = 'https://evil.example/acme/app/-/work_items/7'
    const requests = installFetch(t, () =>
      jsonResponse([
        {
          id: 999001,
          iid: 7,
          title: 'Fix the pager',
          web_url: webUrl,
        },
      ]),
    )
    const adapter = createAdapter('gitlab', constructorBase)
    const result = await callListIssues(adapter, credential('gitlab'), repo)

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, listApiUrl('gitlab', constructorBase))
    assert.equal(
      requests.some((req) => req.url.includes('web-origin.test')),
      false,
      'gitlab must never fetch repo.base_url (constructor baseUrl is the API origin)',
    )
    assert.equal(
      requests.some((req) => req.url.includes('evil.example')),
      false,
      'gitlab must never fetch JSON web_url host',
    )
    assertListedIssue('gitlab', result[0], {
      number: 7,
      title: 'Fix the pager',
      issue_url: expectedIssueUrl('gitlab', WEB_ORIGIN_OTHER.gitlab, 7),
      full_name: FULL_NAME,
    })
  })

  it('gitlab: maps iid not id; constructs canonical /-/issues/; parseIssueUrl round-trip; does not copy work_items web_url', async (t) => {
    const repo = repoRef('gitlab')
    const webUrl = 'https://evil.example/acme/app/-/work_items/7'
    installFetch(t, () =>
      jsonResponse([
        {
          id: 999001,
          iid: 7,
          title: 'Fix the pager',
          web_url: webUrl,
        },
      ]),
    )
    const adapter = createAdapter('gitlab')
    const result = await callListIssues(adapter, credential('gitlab'), repo)

    assert.equal(result[0]?.number, 7)
    assert.notEqual(result[0]?.number, 999001)
    const constructed = expectedIssueUrl('gitlab', WEB_ORIGIN.gitlab, 7)
    assert.equal(result[0]?.issue_url, constructed)
    assert.notEqual(result[0]?.issue_url, webUrl)
    assert.equal(String(result[0]?.issue_url).includes('/-/work_items/'), false)
    assert.equal(String(result[0]?.issue_url).includes('/-/issues/7'), true)
    assert.deepEqual(parseIssueUrl('gitlab', String(result[0]?.issue_url)), { full_name: FULL_NAME })
    assert.equal(
      parseIssueUrl('gitlab', webUrl),
      undefined,
      'copying GitLab web_url (work_items) must not satisfy parseIssueUrl',
    )
  })

  it('gitlab: a nested-group namespace is encodeURIComponent-ed as a single :id segment', async (t) => {
    const namespace = 'group/subgroup/app'
    const repo = repoRef('gitlab', WEB_ORIGIN.gitlab, namespace)
    const requests = installFetch(t, () =>
      jsonResponse([
        {
          id: 999043,
          iid: 43,
          title: 'Nested group issue',
          web_url: `https://evil.example/${namespace}/-/work_items/43`,
        },
      ]),
    )
    const adapter = createAdapter('gitlab')
    const result = await callListIssues(adapter, credential('gitlab'), repo)

    assert.equal(requests[0]?.url, listApiUrl('gitlab', WEB_ORIGIN.gitlab, namespace))
    assert.ok(
      requests[0]?.url.includes(encodeURIComponent(namespace)),
      `expected the namespace to be encodeURIComponent-ed as one segment: ${requests[0]?.url}`,
    )
    assert.equal(requests[0]?.url.includes('/group/subgroup/app/'), false)
    assertListedIssue('gitlab', result[0], {
      number: 43,
      title: 'Nested group issue',
      issue_url: expectedIssueUrl('gitlab', WEB_ORIGIN.gitlab, 43, namespace),
      full_name: namespace,
    })
  })

  it('gitea: API origin is constructor baseUrl, never repo.base_url', async (t) => {
    const constructorBase = CUSTOM_BASE_URL.gitea
    const repo = repoRef('gitea', WEB_ORIGIN_OTHER.gitea)
    const requests = installFetch(t, () =>
      jsonResponse(issueJsonItems('gitea', [{ number: 15, title: 'Fix the pager' }])),
    )
    const adapter = createAdapter('gitea', constructorBase)
    const result = await callListIssues(adapter, credential('gitea'), repo)

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, listApiUrl('gitea', constructorBase))
    assert.equal(
      requests.some((req) => req.url.includes('web-origin.test')),
      false,
      'gitea must never fetch repo.base_url (constructor baseUrl is the API origin)',
    )
    assert.equal(requests[0]?.url.includes('html-url.example'), false)
    assertListedIssue('gitea', result[0], {
      number: 15,
      title: 'Fix the pager',
      issue_url: expectedIssueUrl('gitea', WEB_ORIGIN_OTHER.gitea, 15),
      full_name: FULL_NAME,
    })
  })

  it('gitea: maps number not id; does not copy html_url; query uses type=issues and limit not per_page', async (t) => {
    const repo = repoRef('gitea')
    const htmlUrl = 'https://html-url.example/acme/app/issues/15'
    const requests = installFetch(t, () =>
      jsonResponse([
        {
          id: 888002,
          number: 15,
          title: 'Fix the pager',
          html_url: htmlUrl,
        },
      ]),
    )
    const adapter = createAdapter('gitea')
    const result = await callListIssues(adapter, credential('gitea'), repo)

    assert.equal(requests[0]?.url, listApiUrl('gitea', WEB_ORIGIN.gitea))
    assert.equal(requests[0]?.url.includes('per_page='), false)
    assert.equal(new URL(requests[0]?.url ?? '').searchParams.get('limit'), '50')
    assert.equal(new URL(requests[0]?.url ?? '').searchParams.get('type'), 'issues')
    assert.equal(result[0]?.number, 15)
    assert.notEqual(result[0]?.number, 888002)
    assert.equal(result[0]?.issue_url, expectedIssueUrl('gitea', WEB_ORIGIN.gitea, 15))
    assert.notEqual(result[0]?.issue_url, htmlUrl)
    assert.deepEqual(parseIssueUrl('gitea', String(result[0]?.issue_url)), { full_name: FULL_NAME })
  })
})
