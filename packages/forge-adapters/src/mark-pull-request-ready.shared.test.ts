import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createForgeAdapter } from './index.ts'
import type { Credential, CreateForgeAdapterOptions, ForgeAdapter } from './index.ts'

// Issue #53. Shared spec for `markPullRequestReady`, parameterized over github/gitlab/gitea,
// mirroring `get-pull-request.shared.test.ts`'s fetch-stub shape (URL parsing + host/SSRF rule)
// with a body/signal recorder added from `comment-on-issue.shared.test.ts` and
// `timeout.shared.test.ts`. Do not import those files — the helpers below are deliberately copied
// and trimmed, per this project's one-shared-spec-per-file convention.
//
// The operation is two-phase on every forge: read the PR/MR, then mutate it only if it is still a
// draft. The read is what makes it idempotent, so "already ready ⇒ zero mutating requests" is a
// first-class assertion here, not an afterthought — the server retries this call after an ack
// loss.

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

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql'
const NODE_ID = 'PR_kwDOABCD12345'
const READY_TITLE = 'Add the review loop'
const HEAD_SHA = '9f1c2d3e4b5a60718293a4b5c6d7e8f90a1b2c3d'
const HEAD_BRANCH = 'feature/kaola-53'

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
  respond: (url: string, method: string) => Response,
): RecordedRequest[] {
  const recorded: RecordedRequest[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = requestUrl(input)
      const method = requestMethod(input, init)
      recorded.push({
        url,
        method,
        headers: requestHeaders(input, init),
        body: requestBodyJson(input, init),
        signal: requestSignal(input, init),
      })
      return respond(url, method)
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

function githubApiUrl(owner: string, repo: string, number: number): string {
  return `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
}

function giteaApiUrl(baseUrl: string, owner: string, repo: string, number: number): string {
  return `${trimSlash(baseUrl)}/api/v1/repos/${owner}/${repo}/pulls/${number}`
}

function gitlabApiUrl(baseUrl: string, namespace: string, iid: number): string {
  return `${trimSlash(baseUrl)}/api/v4/projects/${encodeURIComponent(namespace)}/merge_requests/${iid}`
}

function prUrlFor(kind: ForgeKind, baseUrl: string, number: number): string {
  if (kind === 'github') return githubPrUrl('acme', 'app', number)
  if (kind === 'gitlab') return gitlabMrUrl(baseUrl, 'acme/app', number)
  return giteaPrUrl(baseUrl, 'acme', 'app', number)
}

function apiUrlFor(kind: ForgeKind, baseUrl: string, number: number): string {
  if (kind === 'github') return githubApiUrl('acme', 'app', number)
  if (kind === 'gitlab') return gitlabApiUrl(baseUrl, 'acme/app', number)
  return giteaApiUrl(baseUrl, 'acme', 'app', number)
}

// The URL the mutating second request must target, per forge: GitHub a separate GraphQL endpoint,
// GitLab/Gitea the very same resource URL the GET used, with a different verb.
function mutationUrlFor(kind: ForgeKind, baseUrl: string, number: number): string {
  if (kind === 'github') return GITHUB_GRAPHQL_URL
  return apiUrlFor(kind, baseUrl, number)
}

function mutationMethodFor(kind: ForgeKind): string {
  if (kind === 'github') return 'POST'
  if (kind === 'gitlab') return 'PUT'
  return 'PATCH'
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

// A PR/MR that is still a draft, expressed the way each forge expresses it: GitHub a `draft`
// boolean (plus the GraphQL `node_id` the mutation needs), GitLab `draft`, Gitea a `WIP:` title.
function draftBody(kind: ForgeKind, number: number, title = READY_TITLE): unknown {
  if (kind === 'github') {
    return {
      number,
      node_id: NODE_ID,
      state: 'open',
      draft: true,
      title,
      head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
    }
  }
  if (kind === 'gitlab') {
    return {
      iid: number,
      state: 'opened',
      draft: true,
      title: `Draft: ${title}`,
      sha: HEAD_SHA,
      source_branch: HEAD_BRANCH,
    }
  }
  return {
    number,
    state: 'open',
    title: `WIP: ${title}`,
    head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
  }
}

function readyBody(kind: ForgeKind, number: number): unknown {
  if (kind === 'github') {
    return { number, node_id: NODE_ID, state: 'open', draft: false, title: READY_TITLE }
  }
  if (kind === 'gitlab') {
    return { iid: number, state: 'opened', draft: false, work_in_progress: false, title: READY_TITLE }
  }
  return { number, state: 'open', draft: false, title: READY_TITLE }
}

// What a successful mutation looks like on each forge.
function mutationSuccessBody(kind: ForgeKind): unknown {
  if (kind === 'github') {
    return { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }
  }
  return { title: READY_TITLE }
}

// Serves the GET from the resource URL and the mutation from wherever that forge puts it, so a
// single stub can drive both phases.
function twoPhase(
  kind: ForgeKind,
  getBody: unknown,
  options?: { getStatus?: number; mutationStatus?: number; mutationBody?: unknown },
): (url: string, method: string) => Response {
  return (_url, method) => {
    if (method === 'GET') return jsonResponse(getBody, options?.getStatus ?? 200)
    return jsonResponse(
      options?.mutationBody ?? mutationSuccessBody(kind),
      options?.mutationStatus ?? 200,
    )
  }
}

function assertGraphqlMutationBody(body: unknown): void {
  assert.ok(body !== null && typeof body === 'object', 'the GraphQL request must send a JSON object')
  const payload = body as { query?: unknown; variables?: unknown }
  assert.equal(typeof payload.query, 'string')
  const query = payload.query as string
  assert.ok(
    query.includes('markPullRequestReadyForReview'),
    `expected the markPullRequestReadyForReview mutation, got: ${query}`,
  )
  assert.ok(query.includes('pullRequestId'), `expected a pullRequestId input, got: ${query}`)
  assert.ok(query.includes('$id: ID!'), `expected an ID! variable declaration, got: ${query}`)
  assert.deepEqual(payload.variables, { id: NODE_ID })
}

describe('markPullRequestReady shared spec', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('reads the pull/merge request, then mutates it: exact URLs, verbs and auth headers', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, twoPhase(kind, draftBody(kind, 11)))
        const adapter = createAdapter(kind)

        await adapter.markPullRequestReady(credential(kind), prUrlFor(kind, baseUrl, 11))

        assert.equal(
          requests.length,
          2,
          `expected a GET then one mutation, got ${JSON.stringify(requests.map((r) => [r.method, r.url]))}`,
        )
        assert.equal(requests[0]?.method, 'GET')
        assert.equal(requests[0]?.url, apiUrlFor(kind, baseUrl, 11))
        assert.equal(requests[1]?.method, mutationMethodFor(kind))
        assert.equal(requests[1]?.url, mutationUrlFor(kind, baseUrl, 11))
        for (const req of requests) {
          assertAuthHeader(kind, req.headers, tokenFor(kind))
        }
      })

      it('sends the mutation payload the forge needs (GraphQL node id / de-prefixed title)', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, twoPhase(kind, draftBody(kind, 12)))
        const adapter = createAdapter(kind)

        await adapter.markPullRequestReady(credential(kind), prUrlFor(kind, baseUrl, 12))

        const mutation = requests[1]
        assert.ok(mutation != null, 'the mutating request must have been sent')
        if (kind === 'github') {
          assertGraphqlMutationBody(mutation.body)
        } else {
          assert.deepEqual(
            mutation.body,
            { title: READY_TITLE },
            'the draft/WIP marker must be stripped from the title, leaving nothing else changed',
          )
        }
        assert.equal(mutation.headers.get('content-type'), 'application/json')
      })

      it('is idempotent: an already-ready pull/merge request sends no mutating request at all', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, twoPhase(kind, readyBody(kind, 13)))
        const adapter = createAdapter(kind)

        await adapter.markPullRequestReady(credential(kind), prUrlFor(kind, baseUrl, 13))

        assert.equal(
          requests.length,
          1,
          `an already-ready PR must be a read-only no-op, got ${JSON.stringify(requests.map((r) => [r.method, r.url]))}`,
        )
        assert.equal(requests[0]?.method, 'GET')
      })

      it('a non-OK read rejects with "markPullRequestReady: <kind> responded <status>" after exactly one fetch', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, twoPhase(kind, { message: 'Not Found' }, { getStatus: 404 }))
        const adapter = createAdapter(kind)

        await assert.rejects(
          async () => {
            await adapter.markPullRequestReady(credential(kind), prUrlFor(kind, baseUrl, 14))
          },
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.equal(err.message, `markPullRequestReady: ${kind} responded 404`)
            return true
          },
        )
        assert.equal(requests.length, 1, 'the failed read must not be followed by a mutation')
      })

      it('a non-OK mutation rejects with "markPullRequestReady: <kind> responded <status>" after both fetches', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(
          t,
          twoPhase(kind, draftBody(kind, 15), { mutationStatus: 422, mutationBody: { message: 'nope' } }),
        )
        const adapter = createAdapter(kind)

        await assert.rejects(
          async () => {
            await adapter.markPullRequestReady(credential(kind), prUrlFor(kind, baseUrl, 15))
          },
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.equal(err.message, `markPullRequestReady: ${kind} responded 422`)
            return true
          },
        )
        assert.equal(requests.length, 2, 'the rejection must come from the mutation, not from the read')
      })

      it('an unparseable prUrl rejects without calling fetch, while a valid URL from the same adapter succeeds', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, twoPhase(kind, draftBody(kind, 16)))
        const adapter = createAdapter(kind)

        await adapter.markPullRequestReady(credential(kind), prUrlFor(kind, baseUrl, 16))
        assert.equal(requests.length, 2, 'the valid-URL call must reach the forge')

        await assert.rejects(async () => {
          await adapter.markPullRequestReady(credential(kind), 'https://example.com/totally/not/a/pr/url')
        })
        assert.equal(requests.length, 2, 'an unparseable prUrl must reject before ever calling fetch')
      })

      it('#37: every request carries a bounded AbortSignal, on the read and on the mutation alike', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, twoPhase(kind, draftBody(kind, 17)))
        const adapter = createAdapterWithTimeout(kind, 5_000)

        await adapter.markPullRequestReady(credential(kind), prUrlFor(kind, baseUrl, 17))

        assert.equal(requests.length, 2)
        for (const req of requests) {
          assert.ok(
            req.signal instanceof AbortSignal,
            `${req.method} ${req.url} must be given an AbortSignal so a hung forge cannot block the caller`,
          )
          assert.equal(req.signal?.aborted, false, 'a fast response must not be falsely aborted')
        }
      })
    })
  }

  // --- GitHub: the mutation is GraphQL-only, and a 200 can still be a failure --------------------

  it('github: the GraphQL mutation always goes to api.github.com regardless of a custom baseUrl', async (t) => {
    const requests = installFetch(t, twoPhase('github', draftBody('github', 21)))
    const adapter = createAdapter('github', CUSTOM_BASE_URL.github)

    await adapter.markPullRequestReady(credential('github'), githubPrUrl('acme', 'app', 21))

    assert.equal(requests[0]?.url, githubApiUrl('acme', 'app', 21))
    assert.equal(requests[1]?.url, GITHUB_GRAPHQL_URL)
    for (const req of requests) {
      assert.equal(req.url.includes('github.example.com'), false)
    }
  })

  it('github: a 200 GraphQL response carrying a non-empty errors array rejects with "responded 200"', async (t) => {
    const requests = installFetch(
      t,
      twoPhase('github', draftBody('github', 22), {
        mutationBody: {
          data: { markPullRequestReadyForReview: null },
          errors: [{ message: 'Could not resolve to a node with the global id of ...' }],
        },
      }),
    )
    const adapter = createAdapter('github')

    await assert.rejects(
      async () => {
        await adapter.markPullRequestReady(credential('github'), githubPrUrl('acme', 'app', 22))
      },
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal(err.message, 'markPullRequestReady: github responded 200')
        return true
      },
    )
    assert.equal(requests.length, 2)
  })

  it('github: an empty errors array on a 200 is success, not a rejection', async (t) => {
    installFetch(
      t,
      twoPhase('github', draftBody('github', 23), {
        mutationBody: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }, errors: [] },
      }),
    )
    const adapter = createAdapter('github')
    await adapter.markPullRequestReady(credential('github'), githubPrUrl('acme', 'app', 23))
  })

  it('github: draft comes from the boolean flag — a "WIP:" title alone is not a draft and mutates nothing', async (t) => {
    const requests = installFetch(
      t,
      twoPhase('github', {
        number: 24,
        node_id: NODE_ID,
        state: 'open',
        draft: false,
        title: 'WIP: not a GitHub draft marker',
      }),
    )
    const adapter = createAdapter('github')

    await adapter.markPullRequestReady(credential('github'), githubPrUrl('acme', 'app', 24))
    assert.equal(requests.length, 1)
  })

  // --- GitLab: title-prefix stripping and the legacy work_in_progress flag ----------------------

  it('gitlab: the legacy work_in_progress flag alone still triggers the PUT', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    const requests = installFetch(
      t,
      twoPhase('gitlab', {
        iid: 31,
        state: 'opened',
        work_in_progress: true,
        title: `WIP: ${READY_TITLE}`,
      }),
    )
    const adapter = createAdapter('gitlab')

    await adapter.markPullRequestReady(credential('gitlab'), gitlabMrUrl(baseUrl, 'acme/app', 31))

    assert.equal(requests.length, 2)
    assert.equal(requests[1]?.method, 'PUT')
    assert.deepEqual(requests[1]?.body, { title: READY_TITLE })
  })

  it('gitlab: every documented draft marker is stripped, case-insensitively', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    for (const marker of ['Draft:', 'draft:', 'DRAFT:', 'WIP:', 'wip:', '[Draft]', '[draft]', '(Draft)', '(draft)']) {
      const requests = installFetch(
        t,
        twoPhase('gitlab', { iid: 32, state: 'opened', draft: true, title: `${marker} ${READY_TITLE}` }),
      )
      const adapter = createAdapter('gitlab')

      await adapter.markPullRequestReady(credential('gitlab'), gitlabMrUrl(baseUrl, 'acme/app', 32))

      assert.deepEqual(
        requests[1]?.body,
        { title: READY_TITLE },
        `marker ${marker} must be stripped from the MR title`,
      )
    }
  })

  it('gitlab: a draft MR whose title carries no marker keeps its title unchanged', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    const requests = installFetch(
      t,
      twoPhase('gitlab', { iid: 33, state: 'opened', draft: true, title: READY_TITLE }),
    )
    const adapter = createAdapter('gitlab')

    await adapter.markPullRequestReady(credential('gitlab'), gitlabMrUrl(baseUrl, 'acme/app', 33))
    assert.deepEqual(requests[1]?.body, { title: READY_TITLE })
  })

  it('gitlab: a nested-group namespace is encodeURIComponent-ed as one :id segment on both requests', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    const namespace = 'group/subgroup/app'
    const requests = installFetch(t, twoPhase('gitlab', draftBody('gitlab', 34)))
    const adapter = createAdapter('gitlab')

    await adapter.markPullRequestReady(credential('gitlab'), gitlabMrUrl(baseUrl, namespace, 34))

    for (const req of requests) {
      assert.equal(req.url, gitlabApiUrl(baseUrl, namespace, 34))
      assert.ok(req.url.includes(encodeURIComponent(namespace)))
    }
  })

  // --- Gitea: the WIP: title prefix is the whole draft protocol ---------------------------------

  it('gitea: a "WIP:" prefix is stripped case-insensitively and after leading whitespace', async (t) => {
    const baseUrl = WEB_ORIGIN.gitea
    for (const title of [`WIP: ${READY_TITLE}`, `wip: ${READY_TITLE}`, `WiP:   ${READY_TITLE}`]) {
      const requests = installFetch(t, twoPhase('gitea', { number: 41, state: 'open', title }))
      const adapter = createAdapter('gitea')

      await adapter.markPullRequestReady(credential('gitea'), giteaPrUrl(baseUrl, 'acme', 'app', 41))

      assert.equal(requests[1]?.method, 'PATCH')
      assert.deepEqual(requests[1]?.body, { title: READY_TITLE }, `title ${title} must lose its WIP: prefix`)
    }
  })

  it('gitea: a title that merely mentions WIP later is already ready and mutates nothing', async (t) => {
    const baseUrl = WEB_ORIGIN.gitea
    const requests = installFetch(
      t,
      twoPhase('gitea', { number: 42, state: 'open', title: 'Ship the WIP: banner component' }),
    )
    const adapter = createAdapter('gitea')

    await adapter.markPullRequestReady(credential('gitea'), giteaPrUrl(baseUrl, 'acme', 'app', 42))
    assert.equal(requests.length, 1)
  })

  // --- host rule shared by the two self-hosted forges -------------------------------------------

  it('gitlab/gitea: both requests use the constructor baseUrl as origin, never the prUrl host', async (t) => {
    for (const kind of ['gitlab', 'gitea'] as const) {
      const apiOrigin = CUSTOM_BASE_URL[kind]
      const webHost =
        kind === 'gitlab' ? 'https://gitlab.other-host.test' : 'https://gitea.other-host.test'
      const requests = installFetch(t, twoPhase(kind, draftBody(kind, 51)))
      const adapter = createAdapter(kind, apiOrigin)

      const prUrl =
        kind === 'gitlab' ? gitlabMrUrl(webHost, 'acme/app', 51) : giteaPrUrl(webHost, 'acme', 'app', 51)
      await adapter.markPullRequestReady(credential(kind), prUrl)

      assert.equal(requests.length, 2)
      for (const req of requests) {
        assert.equal(
          req.url,
          apiUrlFor(kind, apiOrigin, 51),
          `${kind} must use the constructor baseUrl as the API origin, not the prUrl host`,
        )
        assert.equal(req.url.includes('other-host.test'), false)
      }
    }
  })
})
