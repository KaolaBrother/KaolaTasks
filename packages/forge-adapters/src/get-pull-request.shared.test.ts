import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createForgeAdapter } from './index.ts'
import type { Credential, ForgeAdapter, PrStatus } from './index.ts'

// Issue #11. Shared spec for `getPullRequest`, parameterized over github/gitlab/gitea, mirroring
// `validate-token.shared.test.ts`'s fetch-stub shape. Do not import that file — the helpers below
// are deliberately copied and trimmed to what this spec needs.

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

function githubPrUrl(owner: string, repo: string, number: number, suffix = ''): string {
  return `${WEB_ORIGIN.github}/${owner}/${repo}/pull/${number}${suffix}`
}

function giteaPrUrl(baseUrl: string, owner: string, repo: string, number: number, suffix = ''): string {
  return `${trimSlash(baseUrl)}/${owner}/${repo}/pulls/${number}${suffix}`
}

function gitlabMrUrl(baseUrl: string, namespace: string, iid: number, suffix = ''): string {
  return `${trimSlash(baseUrl)}/${namespace}/-/merge_requests/${iid}${suffix}`
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

// Issue #53 widened `PrStatus` from `{ state }` to `{ state, head_sha, draft, head_branch }`.
// `state` is still asserted by every pre-existing case below; the optional `fields` argument is
// how the new cases pin the three added members without duplicating the state assertions.
function assertPrStatus(
  result: PrStatus,
  expected: 'open' | 'merged' | 'closed',
  fields?: Partial<Omit<PrStatus, 'state'>>,
): void {
  assert.equal(typeof result, 'object')
  assert.ok(result !== null)
  assert.equal((result as { state: unknown }).state, expected)
  if (fields === undefined) return
  if (fields.head_sha !== undefined) assert.equal(result.head_sha, fields.head_sha)
  if (fields.head_branch !== undefined) assert.equal(result.head_branch, fields.head_branch)
  if (fields.draft !== undefined) assert.equal(result.draft, fields.draft)
}

function prUrlFor(kind: ForgeKind, baseUrl: string, ids: { owner?: string; repo?: string; namespace?: string; number: number }): string {
  if (kind === 'github') return githubPrUrl(ids.owner ?? 'acme', ids.repo ?? 'app', ids.number)
  if (kind === 'gitlab') return gitlabMrUrl(baseUrl, ids.namespace ?? 'acme/app', ids.number)
  return giteaPrUrl(baseUrl, ids.owner ?? 'acme', ids.repo ?? 'app', ids.number)
}

function apiUrlFor(kind: ForgeKind, baseUrl: string, ids: { owner?: string; repo?: string; namespace?: string; number: number }): string {
  if (kind === 'github') return githubApiUrl(ids.owner ?? 'acme', ids.repo ?? 'app', ids.number)
  if (kind === 'gitlab') return gitlabApiUrl(baseUrl, ids.namespace ?? 'acme/app', ids.number)
  return giteaApiUrl(baseUrl, ids.owner ?? 'acme', ids.repo ?? 'app', ids.number)
}

// #53 fixtures. Real forge payloads always carry the head commit and branch on an open PR/MR, so
// the shared bodies below carry them too — the pre-#53 cases ignore them, the new cases assert
// them.
const HEAD_SHA = '9f1c2d3e4b5a60718293a4b5c6d7e8f90a1b2c3d'
const HEAD_BRANCH = 'feature/kaola-53'
const READY_TITLE = 'Add the review loop'

function openBody(kind: ForgeKind, number: number): unknown {
  if (kind === 'gitlab') {
    return {
      iid: number,
      state: 'opened',
      title: READY_TITLE,
      sha: HEAD_SHA,
      source_branch: HEAD_BRANCH,
      draft: false,
      work_in_progress: false,
    }
  }
  return {
    number,
    state: 'open',
    merged: false,
    title: READY_TITLE,
    draft: false,
    head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
  }
}

function mergedBody(kind: ForgeKind, number: number): unknown {
  if (kind === 'gitlab') {
    return { iid: number, state: 'merged', title: READY_TITLE, sha: HEAD_SHA, source_branch: HEAD_BRANCH }
  }
  return {
    number,
    state: 'closed',
    merged: true,
    title: READY_TITLE,
    head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
  }
}

function closedBody(kind: ForgeKind, number: number): unknown {
  if (kind === 'gitlab') {
    return { iid: number, state: 'closed', title: READY_TITLE, sha: HEAD_SHA, source_branch: HEAD_BRANCH }
  }
  return {
    number,
    state: 'closed',
    merged: false,
    title: READY_TITLE,
    head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
  }
}

// A draft/WIP PR/MR expressed the way each forge actually expresses it: GitHub a real `draft`
// boolean, GitLab `draft`, Gitea a `WIP:` title prefix (its long-standing encoding).
function draftBody(kind: ForgeKind, number: number): unknown {
  if (kind === 'gitlab') {
    return {
      iid: number,
      state: 'opened',
      title: `Draft: ${READY_TITLE}`,
      sha: HEAD_SHA,
      source_branch: HEAD_BRANCH,
      draft: true,
    }
  }
  if (kind === 'github') {
    return {
      number,
      state: 'open',
      merged: false,
      title: READY_TITLE,
      draft: true,
      head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
    }
  }
  return {
    number,
    state: 'open',
    merged: false,
    title: `WIP: ${READY_TITLE}`,
    head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
  }
}

// A payload with no head commit / branch information at all — e.g. a closed PR whose source
// branch has been deleted. The contract says these degrade to `''`, never to a rejection.
function headlessBody(kind: ForgeKind, number: number): unknown {
  if (kind === 'gitlab') return { iid: number, state: 'closed' }
  return { number, state: 'closed', merged: false }
}

describe('getPullRequest shared spec', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('GETs the pull/merge-request endpoint with validateToken-style auth headers', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse(openBody(kind, 11)))
        const adapter = createAdapter(kind)

        const result = await adapter.getPullRequest(
          credential(kind),
          prUrlFor(kind, baseUrl, { number: 11 }),
        )
        assertPrStatus(result, 'open')

        assert.equal(requests.length, 1, `expected exactly one fetch call, got ${JSON.stringify(requests.map((r) => r.url))}`)
        const [req] = requests
        assert.equal(req.method, 'GET')
        assert.equal(req.url, apiUrlFor(kind, baseUrl, { number: 11 }))
        assertAuthHeader(kind, req.headers, tokenFor(kind))
      })

      it('merged → { state: "merged" }', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        installFetch(t, () => jsonResponse(mergedBody(kind, 21)))
        const adapter = createAdapter(kind)
        const result = await adapter.getPullRequest(credential(kind), prUrlFor(kind, baseUrl, { number: 21 }))
        assertPrStatus(result, 'merged')
      })

      it('closed and not merged → { state: "closed" }', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        installFetch(t, () => jsonResponse(closedBody(kind, 22)))
        const adapter = createAdapter(kind)
        const result = await adapter.getPullRequest(credential(kind), prUrlFor(kind, baseUrl, { number: 22 }))
        assertPrStatus(result, 'closed')
      })

      it('open → { state: "open" }', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        installFetch(t, () => jsonResponse(openBody(kind, 23)))
        const adapter = createAdapter(kind)
        const result = await adapter.getPullRequest(credential(kind), prUrlFor(kind, baseUrl, { number: 23 }))
        assertPrStatus(result, 'open')
      })

      it('trailing slash on the pasted URL is stripped before parsing', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse(openBody(kind, 24)))
        const adapter = createAdapter(kind)
        const url = `${prUrlFor(kind, baseUrl, { number: 24 })}/`
        const result = await adapter.getPullRequest(credential(kind), url)
        assertPrStatus(result, 'open')
        assert.equal(requests[0]?.url, apiUrlFor(kind, baseUrl, { number: 24 }))
      })

      it('non-OK HTTP response rejects (after actually calling fetch, not merely throwing)', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse({ message: 'Not Found' }, 404))
        const adapter = createAdapter(kind)
        await assert.rejects(async () => {
          await adapter.getPullRequest(credential(kind), prUrlFor(kind, baseUrl, { number: 25 }))
        })
        assert.equal(
          requests.length,
          1,
          'getPullRequest must actually call fetch and reject on the non-OK response, not reject for an unrelated reason',
        )
        assert.equal(requests[0]?.url, apiUrlFor(kind, baseUrl, { number: 25 }))
      })

      it('an unparseable prUrl rejects without calling fetch, while a valid URL from the same adapter succeeds', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse(openBody(kind, 26)))
        const adapter = createAdapter(kind)

        const ok = await adapter.getPullRequest(credential(kind), prUrlFor(kind, baseUrl, { number: 26 }))
        assertPrStatus(ok, 'open')
        assert.equal(requests.length, 1, 'the valid-URL call must reach the forge')

        await assert.rejects(async () => {
          await adapter.getPullRequest(credential(kind), 'https://example.com/totally/not/a/pr/url')
        })
        assert.equal(
          requests.length,
          1,
          'an unparseable prUrl must reject before ever calling fetch',
        )
      })

      // --- #53: the three added PrStatus members -------------------------------------------
      it('#53: a ready pull/merge request reports head_sha, head_branch and draft: false', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        installFetch(t, () => jsonResponse(openBody(kind, 51)))
        const adapter = createAdapter(kind)
        const result = await adapter.getPullRequest(credential(kind), prUrlFor(kind, baseUrl, { number: 51 }))
        assertPrStatus(result, 'open', {
          head_sha: HEAD_SHA,
          head_branch: HEAD_BRANCH,
          draft: false,
        })
      })

      it('#53: a draft/WIP pull/merge request reports draft: true, still with head_sha and head_branch', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        installFetch(t, () => jsonResponse(draftBody(kind, 52)))
        const adapter = createAdapter(kind)
        const result = await adapter.getPullRequest(credential(kind), prUrlFor(kind, baseUrl, { number: 52 }))
        assertPrStatus(result, 'open', {
          head_sha: HEAD_SHA,
          head_branch: HEAD_BRANCH,
          draft: true,
        })
      })

      it('#53: a payload with no head commit/branch degrades to empty strings, not a rejection', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        installFetch(t, () => jsonResponse(headlessBody(kind, 53)))
        const adapter = createAdapter(kind)
        const result = await adapter.getPullRequest(credential(kind), prUrlFor(kind, baseUrl, { number: 53 }))
        assertPrStatus(result, 'closed', { head_sha: '', head_branch: '', draft: false })
      })

      it('#53: a merged pull/merge request still carries head_sha and head_branch', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        installFetch(t, () => jsonResponse(mergedBody(kind, 54)))
        const adapter = createAdapter(kind)
        const result = await adapter.getPullRequest(credential(kind), prUrlFor(kind, baseUrl, { number: 54 }))
        assertPrStatus(result, 'merged', { head_sha: HEAD_SHA, head_branch: HEAD_BRANCH })
      })
    })
  }

  it('github: .diff and .patch suffixes on the pasted URL are stripped before parsing', async (t) => {
    const requests = installFetch(t, () => jsonResponse(openBody('github', 31)))
    const adapter = createAdapter('github')

    const diffResult = await adapter.getPullRequest(
      credential('github'),
      `${githubPrUrl('acme', 'app', 31)}.diff`,
    )
    assertPrStatus(diffResult, 'open')

    const patchResult = await adapter.getPullRequest(
      credential('github'),
      `${githubPrUrl('acme', 'app', 31)}.patch`,
    )
    assertPrStatus(patchResult, 'open')

    for (const req of requests) {
      assert.equal(req.url, githubApiUrl('acme', 'app', 31))
    }
  })

  it('github: always calls api.github.com regardless of a custom baseUrl option', async (t) => {
    const requests = installFetch(t, () => jsonResponse(openBody('github', 32)))
    const adapter = createAdapter('github', CUSTOM_BASE_URL.github)

    const result = await adapter.getPullRequest(credential('github'), githubPrUrl('acme', 'app', 32))
    assertPrStatus(result, 'open')
    assert.equal(requests[0]?.url, githubApiUrl('acme', 'app', 32))
    assert.equal(requests[0]?.url.includes('github.example.com'), false)
  })

  it('gitlab: opened → open (verified 4-valued vendor enum mapped down to 3)', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    installFetch(t, () => jsonResponse({ iid: 41, state: 'opened' }))
    const adapter = createAdapter('gitlab')
    const result = await adapter.getPullRequest(credential('gitlab'), gitlabMrUrl(baseUrl, 'acme/app', 41))
    assertPrStatus(result, 'open')
  })

  it('gitlab: locked (transient, en route to merged) → open, not merged and not closed', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    installFetch(t, () => jsonResponse({ iid: 42, state: 'locked' }))
    const adapter = createAdapter('gitlab')
    const result = await adapter.getPullRequest(credential('gitlab'), gitlabMrUrl(baseUrl, 'acme/app', 42))
    assertPrStatus(result, 'open')
  })

  it('gitlab: a namespace path with subgroup slashes is encodeURIComponent-ed as a single :id segment', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    const namespace = 'group/subgroup/app'
    const requests = installFetch(t, () => jsonResponse({ iid: 43, state: 'opened' }))
    const adapter = createAdapter('gitlab')
    const result = await adapter.getPullRequest(credential('gitlab'), gitlabMrUrl(baseUrl, namespace, 43))
    assertPrStatus(result, 'open')
    assert.equal(requests[0]?.url, gitlabApiUrl(baseUrl, namespace, 43))
    assert.ok(
      requests[0]?.url.includes(encodeURIComponent(namespace)),
      `expected the namespace to be encodeURIComponent-ed as one segment: ${requests[0]?.url}`,
    )
  })

  it('gitlab/gitea: the API origin comes from the constructor baseUrl option, not from the prUrl host', async (t) => {
    for (const kind of ['gitlab', 'gitea'] as const) {
      const apiOrigin = CUSTOM_BASE_URL[kind]
      const webHost = kind === 'gitlab' ? 'https://gitlab.other-host.test' : 'https://gitea.other-host.test'
      const requests = installFetch(t, () => jsonResponse(openBody(kind, 44)))
      const adapter = createAdapter(kind, apiOrigin)

      const prUrl =
        kind === 'gitlab' ? gitlabMrUrl(webHost, 'acme/app', 44) : giteaPrUrl(webHost, 'acme', 'app', 44)
      const result = await adapter.getPullRequest(credential(kind), prUrl)
      assertPrStatus(result, 'open')

      const expected = apiUrlFor(kind, apiOrigin, { number: 44 })
      assert.equal(
        requests[requests.length - 1]?.url,
        expected,
        `${kind} must use the constructor baseUrl as the API origin, not the prUrl host`,
      )
    }
  })

  // --- #53: per-forge draft encodings, which genuinely differ between the three -----------------

  it('#53 github: draft comes from the boolean flag only — a "WIP:" title is not a draft marker on GitHub', async (t) => {
    installFetch(t, () =>
      jsonResponse({
        number: 61,
        state: 'open',
        merged: false,
        title: 'WIP: not a GitHub draft marker',
        head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
      }),
    )
    const adapter = createAdapter('github')
    const result = await adapter.getPullRequest(credential('github'), githubPrUrl('acme', 'app', 61))
    assertPrStatus(result, 'open', { draft: false, head_sha: HEAD_SHA, head_branch: HEAD_BRANCH })
  })

  it('#53 github: an absent draft field reads as draft: false', async (t) => {
    installFetch(t, () =>
      jsonResponse({ number: 62, state: 'open', merged: false, head: { sha: HEAD_SHA, ref: HEAD_BRANCH } }),
    )
    const adapter = createAdapter('github')
    const result = await adapter.getPullRequest(credential('github'), githubPrUrl('acme', 'app', 62))
    assertPrStatus(result, 'open', { draft: false })
  })

  it('#53 gitlab: the legacy work_in_progress flag alone marks the MR as draft', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    installFetch(t, () =>
      jsonResponse({
        iid: 63,
        state: 'opened',
        title: 'WIP: legacy marker',
        sha: HEAD_SHA,
        source_branch: HEAD_BRANCH,
        work_in_progress: true,
      }),
    )
    const adapter = createAdapter('gitlab')
    const result = await adapter.getPullRequest(credential('gitlab'), gitlabMrUrl(baseUrl, 'acme/app', 63))
    assertPrStatus(result, 'open', { draft: true })
  })

  it('#53 gitlab: neither flag set reads as draft: false even when the title still says Draft:', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    installFetch(t, () =>
      jsonResponse({
        iid: 64,
        state: 'opened',
        title: 'Draft: stale title, flags already cleared',
        sha: HEAD_SHA,
        source_branch: HEAD_BRANCH,
        draft: false,
        work_in_progress: false,
      }),
    )
    const adapter = createAdapter('gitlab')
    const result = await adapter.getPullRequest(credential('gitlab'), gitlabMrUrl(baseUrl, 'acme/app', 64))
    assertPrStatus(result, 'open', { draft: false })
  })

  it('#53 gitlab: head_sha comes from `sha` and head_branch from `source_branch`, each "" when absent', async (t) => {
    const baseUrl = WEB_ORIGIN.gitlab
    installFetch(t, () => jsonResponse({ iid: 65, state: 'opened', source_branch: HEAD_BRANCH }))
    const adapter = createAdapter('gitlab')
    const result = await adapter.getPullRequest(credential('gitlab'), gitlabMrUrl(baseUrl, 'acme/app', 65))
    assertPrStatus(result, 'open', { head_sha: '', head_branch: HEAD_BRANCH })
  })

  it('#53 gitea: a "WIP:" title prefix marks the PR as draft, case-insensitively and after trimming', async (t) => {
    const baseUrl = WEB_ORIGIN.gitea
    for (const title of ['WIP: lowercase test', 'wip: lowercase test', '  WiP:   spaced', 'WIP:no-space']) {
      installFetch(t, () =>
        jsonResponse({
          number: 66,
          state: 'open',
          merged: false,
          title,
          head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
        }),
      )
      const adapter = createAdapter('gitea')
      const result = await adapter.getPullRequest(
        credential('gitea'),
        giteaPrUrl(baseUrl, 'acme', 'app', 66),
      )
      assertPrStatus(result, 'open', { draft: true })
    }
  })

  it('#53 gitea: a title that merely mentions WIP later is not a draft', async (t) => {
    const baseUrl = WEB_ORIGIN.gitea
    installFetch(t, () =>
      jsonResponse({
        number: 67,
        state: 'open',
        merged: false,
        title: 'Ship the WIP: banner component',
        head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
      }),
    )
    const adapter = createAdapter('gitea')
    const result = await adapter.getPullRequest(credential('gitea'), giteaPrUrl(baseUrl, 'acme', 'app', 67))
    assertPrStatus(result, 'open', { draft: false })
  })

  it('#53 gitea: an explicit draft boolean also marks the PR as draft', async (t) => {
    const baseUrl = WEB_ORIGIN.gitea
    installFetch(t, () =>
      jsonResponse({
        number: 68,
        state: 'open',
        merged: false,
        title: READY_TITLE,
        draft: true,
        head: { sha: HEAD_SHA, ref: HEAD_BRANCH },
      }),
    )
    const adapter = createAdapter('gitea')
    const result = await adapter.getPullRequest(credential('gitea'), giteaPrUrl(baseUrl, 'acme', 'app', 68))
    assertPrStatus(result, 'open', { draft: true })
  })

  it('#53 github/gitea: head_sha and head_branch come from head.sha / head.ref, "" when head is absent', async (t) => {
    for (const kind of ['github', 'gitea'] as const) {
      const baseUrl = WEB_ORIGIN[kind]
      installFetch(t, () => jsonResponse({ number: 69, state: 'open', merged: false, head: { ref: HEAD_BRANCH } }))
      const adapter = createAdapter(kind)
      const result = await adapter.getPullRequest(
        credential(kind),
        prUrlFor(kind, baseUrl, { number: 69 }),
      )
      assertPrStatus(result, 'open', { head_sha: '', head_branch: HEAD_BRANCH })
    }
  })
})
