import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createForgeAdapter } from './index.ts'
import type { Credential, ForgeAdapter } from './index.ts'

// Issue #40. Shared spec for the new `listIssueComments(cred, issueRef)`, parameterized over
// github/gitlab/gitea, mirroring `comment-on-issue.shared.test.ts`'s fixture pattern. Per this
// project's one-shared-spec-per-file convention the helpers below are deliberately copied and
// trimmed from that file rather than imported.
//
// Baseline at the time this file was written (worktree HEAD, before #40's implementation):
// `createForgeAdapter(...)` returns an object literal with no `listIssueComments` property at
// all, so `adapter.listIssueComments` is `undefined` and calling it throws a plain
// `TypeError: adapter.listIssueComments is not a function` — every test below fails for that
// reason today (see the captured RED run in this session's report).
//
// MEASURED FACTS THIS SPEC PINS (see issue #40's controller decision + measurement comment):
//   - the list endpoint is the SAME collection as `commentOnIssue`'s POST endpoint (`.../comments`
//     for github/gitea, `.../notes` for gitlab).
//   - the constructor `baseUrl` / host / SSRF rule is identical to every other read (github always
//     api.github.com; gitlab/gitea use the constructor baseUrl, never the pasted issue host).
//   - the return shape is intentionally minimal: `Promise<string[]>`, one element per
//     comment/note body, exactly what the write-back dedupe needs to scan for its marker
//     client-side (see apps/server/src/writeback-dedupe.test.ts). Nothing about ORDER is
//     asserted anywhere in this file — Gitea's endpoint documents no ordering guarantee, so every
//     assertion below compares the returned bodies as a set, never by index/order, for all three
//     kinds uniformly (a shared adapter contract must not behave differently per forge here).
//
// R2 FOLLOW-UP (independent review, same issue #40): the original version of this file pinned "no
// query string at all", which is correct for Gitea (measured: its comment-listing endpoint accepts
// no page/limit params) but was WRONG to generalize to GitHub/GitLab. GitHub's comments endpoint
// defaults to 30/page (max 100); GitLab's notes endpoint defaults to 20/page (max 100), both in
// ascending creation order — so on a busy imported Issue (30+ real comments, exactly the case a
// write-back marker needs to survive), an unpaginated default-size GET never returns the page the
// marker landed on, and dedupe silently never fires. This file now pins `per_page=100` for
// github/gitlab specifically, and keeps the "no query string" pin scoped to gitea alone. UNKNOWN,
// flagged rather than guessed at: whether gitea's own endpoint, given it accepts no page/limit
// params, returns literally every comment unbounded or applies some undocumented server-side cap —
// this file does not assert either way for gitea, only that no page/limit params can be sent.

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
  respond: (url: string, method: string) => Response,
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
      return respond(url, method)
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

function listApiUrlFor(
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

// This adapter has no notImplemented() stub for listIssueComments at all (unlike
// commentOnIssue's HEAD `a722c8b` placeholder) — before #40's implementation lands,
// `adapter.listIssueComments` is simply not a function, so every "rejects" assertion below
// merely needs to catch an Error and must not accidentally pass against a vacuous no-op.
function assertGenuineFailure(err: unknown): boolean {
  assert.ok(err instanceof Error || err instanceof TypeError, `expected an Error, got ${String(err)}`)
  return true
}

function commentBodies(bodies: string[]): { id: number; body: string; user: { login: string } }[] {
  return bodies.map((body, index) => ({ id: index + 1, body, user: { login: 'someone' } }))
}

function sortedCopy(values: string[]): string[] {
  return [...values].sort()
}

describe('listIssueComments shared spec', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('GETs the same collection commentOnIssue POSTs to, requesting the largest page the forge supports, with the same per-kind auth headers', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse(commentBodies(['认领：kt-2026-0040'])))
        const adapter = createAdapter(kind) as ForgeAdapter & {
          listIssueComments(cred: Credential, issueRef: { issue_url: string }): Promise<string[]>
        }
        const issueRef = issueRefFor(kind, baseUrl, { number: 81 })

        const result = await adapter.listIssueComments(credential(kind), issueRef)
        assert.ok(Array.isArray(result), 'listIssueComments resolves an array')

        assert.equal(
          requests.length,
          1,
          `expected exactly one fetch call, got ${JSON.stringify(requests.map((r) => r.url))}`,
        )
        const [req] = requests
        assert.equal(req.method, 'GET')
        const url = new URL(req.url)
        assert.equal(
          `${url.origin}${url.pathname}`,
          listApiUrlFor(kind, baseUrl, { number: 81 }),
          'must target the identical collection path commentOnIssue POSTs to',
        )
        if (kind === 'gitea') {
          // Measured: Gitea's issue-comments listing endpoint documents no page/limit params at
          // all, so none can be requested — its real behavior beyond that is not asserted here.
          assert.equal(req.url.includes('?'), false, "gitea's comment endpoint accepts no page/limit query params")
        } else {
          // GitHub defaults to 30 comments/page (max 100); GitLab notes default to 20/page (max
          // 100) — on a busy imported Issue, a write-back marker committed after the first page
          // would otherwise never be found by a single unpaginated GET. See the coverage test
          // below for the concrete "marker beyond the default page" scenario.
          assert.equal(
            url.searchParams.get('per_page'),
            '100',
            `${kind} must explicitly request the maximum page size (100), not rely on the small default`,
          )
        }
        assertAuthHeader(kind, req.headers, tokenFor(kind))
      })



      it('maps a JSON array of comment/note objects into an array of their body strings, order-agnostic', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const expected = ['认领：kt-2026-0041', '第二条无关评论', '第三条：提交PR：kt-2026-0041']
        installFetch(t, () => jsonResponse(commentBodies(expected)))
        const adapter = createAdapter(kind) as ForgeAdapter & {
          listIssueComments(cred: Credential, issueRef: { issue_url: string }): Promise<string[]>
        }
        const issueRef = issueRefFor(kind, baseUrl, { number: 82 })

        const result = await adapter.listIssueComments(credential(kind), issueRef)
        assert.deepEqual(
          sortedCopy(result),
          sortedCopy(expected),
          `expected the same set of bodies regardless of order, got ${JSON.stringify(result)}`,
        )
      })

      it('the marker can appear anywhere in the list, not only first or last (no ordering assumption)', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const marker = '考拉任务（Kaola Tasks）已认领本 Issue 对应的任务。\n任务编号：kt-2026-0042'
        const bodies = ['不相关评论 A', marker, '不相关评论 B', '不相关评论 C']
        installFetch(t, () => jsonResponse(commentBodies(bodies)))
        const adapter = createAdapter(kind) as ForgeAdapter & {
          listIssueComments(cred: Credential, issueRef: { issue_url: string }): Promise<string[]>
        }
        const issueRef = issueRefFor(kind, baseUrl, { number: 83 })

        const result = await adapter.listIssueComments(credential(kind), issueRef)
        assert.ok(
          result.includes(marker),
          `expected the marker to survive the mapping regardless of position, got ${JSON.stringify(result)}`,
        )
      })

      it('non-OK HTTP response rejects with "listIssueComments: <kind> responded <status>", after exactly one fetch', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse({ message: 'Forbidden' }, 403))
        const adapter = createAdapter(kind) as ForgeAdapter & {
          listIssueComments(cred: Credential, issueRef: { issue_url: string }): Promise<string[]>
        }
        const issueRef = issueRefFor(kind, baseUrl, { number: 84 })

        await assert.rejects(
          async () => {
            await adapter.listIssueComments(credential(kind), issueRef)
          },
          (err: unknown) => {
            assertGenuineFailure(err)
            assert.match((err as Error).message, new RegExp(`listIssueComments: ${kind} responded 403`))
            return true
          },
        )
        assert.equal(requests.length, 1)
      })

      it('an unparseable issue_url rejects without calling fetch', async (t) => {
        const requests = installFetch(t, () => jsonResponse(commentBodies(['x'])))
        const adapter = createAdapter(kind) as ForgeAdapter & {
          listIssueComments(cred: Credential, issueRef: { issue_url: string }): Promise<string[]>
        }

        await assert.rejects(async () => {
          await adapter.listIssueComments(credential(kind), { issue_url: 'https://example.com/totally/not/an/issue' })
        }, assertGenuineFailure)
        assert.equal(requests.length, 0, 'an unparseable issue_url must reject before ever calling fetch')
      })

      it('a pull/MR web path in issue_url is unparseable and must not fetch', async (t) => {
        const baseUrl = WEB_ORIGIN[kind]
        const requests = installFetch(t, () => jsonResponse(commentBodies(['x'])))
        const adapter = createAdapter(kind) as ForgeAdapter & {
          listIssueComments(cred: Credential, issueRef: { issue_url: string }): Promise<string[]>
        }
        const pasted = unparseablePullUrl(kind, baseUrl)

        await assert.rejects(async () => {
          await adapter.listIssueComments(credential(kind), { issue_url: pasted })
        }, assertGenuineFailure)
        assert.equal(requests.length, 0, `${pasted} must be rejected with zero fetch`)
      })
    })
  }

  it('github: always GETs api.github.com regardless of a custom baseUrl option or the pasted issue host', async (t) => {
    const requests = installFetch(t, () => jsonResponse(commentBodies(['x'])))
    const adapter = createAdapter('github', CUSTOM_BASE_URL.github) as ForgeAdapter & {
      listIssueComments(cred: Credential, issueRef: { issue_url: string }): Promise<string[]>
    }
    const pastedHost = 'https://github.other-host.test'
    const issueRef = { issue_url: `${pastedHost}/acme/app/issues/91` }

    await adapter.listIssueComments(credential('github'), issueRef)

    assert.equal(requests.length, 1)
    const url = new URL(requests[0]!.url)
    assert.equal(`${url.origin}${url.pathname}`, githubCommentApiUrl('acme', 'app', 91))
    assert.equal(requests[0]?.url.includes('github.example.com'), false)
    assert.equal(requests[0]?.url.includes('github.other-host.test'), false)
  })

  it('gitlab/gitea: the API origin comes from the constructor baseUrl option, never from the issue_url host (SSRF)', async (t) => {
    for (const kind of ['gitlab', 'gitea'] as const) {
      const apiOrigin = CUSTOM_BASE_URL[kind]
      const webHost = kind === 'gitlab' ? 'https://gitlab.other-host.test' : 'https://gitea.other-host.test'
      const requests = installFetch(t, () => jsonResponse(commentBodies(['x'])))
      const adapter = createAdapter(kind, apiOrigin) as ForgeAdapter & {
        listIssueComments(cred: Credential, issueRef: { issue_url: string }): Promise<string[]>
      }

      const pasted =
        kind === 'gitlab' ? gitlabIssueUrl(webHost, 'acme/app', 92) : giteaIssueUrl(webHost, 'acme', 'app', 92)
      await adapter.listIssueComments(credential(kind), { issue_url: pasted })

      const expected = listApiUrlFor(kind, apiOrigin, { number: 92 })
      const lastUrl = new URL(requests[requests.length - 1]!.url)
      assert.equal(
        `${lastUrl.origin}${lastUrl.pathname}`,
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
    const requests = installFetch(t, () => jsonResponse(commentBodies(['x'])))
    const adapter = createAdapter('gitlab') as ForgeAdapter & {
      listIssueComments(cred: Credential, issueRef: { issue_url: string }): Promise<string[]>
    }

    await adapter.listIssueComments(credential('gitlab'), { issue_url: gitlabIssueUrl(baseUrl, namespace, 93) })

    const url = new URL(requests[0]!.url)
    assert.equal(`${url.origin}${url.pathname}`, gitlabNoteApiUrl(baseUrl, namespace, 93))
    assert.ok(
      requests[0]?.url.includes(encodeURIComponent(namespace)),
      `expected the namespace to be encodeURIComponent-ed as one segment: ${requests[0]?.url}`,
    )
    assert.equal(requests[0]?.url.includes('/group/subgroup/app/'), false)
  })

  it('github/gitlab: requesting per_page=100 explicitly means a marker beyond a small default first page is still found (a busy imported Issue)', async (t) => {
    for (const bigKind of ['github', 'gitlab'] as const) {
      const baseUrl = WEB_ORIGIN[bigKind]
      const marker =
        '考拉任务（Kaola Tasks）已认领本 Issue 对应的任务。\n任务编号：kt-2026-0043\n任务详情：http://localhost:3000/tasks/kt-2026-0043'
      // GitHub defaults to 30/page, GitLab notes default to 20/page — 30 decoys plus the marker
      // puts the marker beyond either forge's own default (unrequested) page size.
      const decoysBefore = Array.from({ length: 30 }, (_, i) => `无关评论 #${i + 1}`)
      const bodies = [...decoysBefore, marker, '无关评论：最后一条']
      const requests = installFetch(t, () => jsonResponse(commentBodies(bodies)))
      const adapter = createAdapter(bigKind) as ForgeAdapter & {
        listIssueComments(cred: Credential, issueRef: { issue_url: string }): Promise<string[]>
      }
      const issueRef = issueRefFor(bigKind, baseUrl, { number: 85 })

      const result = await adapter.listIssueComments(credential(bigKind), issueRef)

      const url = new URL(requests[0]!.url)
      assert.equal(
        url.searchParams.get('per_page'),
        '100',
        `${bigKind} must explicitly request a 100-item page so a marker past the small default page size is not missed`,
      )
      assert.ok(
        result.includes(marker),
        `expected the marker (position ${decoysBefore.length + 1} of ${bodies.length}) to be present, got length ${result.length}`,
      )
    }
  })
})
