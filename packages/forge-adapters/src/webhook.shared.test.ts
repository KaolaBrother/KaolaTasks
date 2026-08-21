import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createForgeAdapter } from './index.ts'
import type { Credential, ForgeAdapter, RepoRef } from './index.ts'

// Issue #13. Shared spec for `parseWebhook` + `registerWebhook`, parameterized over
// github/gitlab/gitea, mirroring `get-pull-request.shared.test.ts`'s fetch-stub shape for the
// registerWebhook half. Do not import that file — the helpers below are deliberately copied and
// trimmed to what this spec needs.
//
// HEAD `44eca32b`: both methods `throw new Error('not implemented')` synchronously for every
// kind, and `ForgeEvent` is `unknown`. Every assertion below requires a *concrete* typed result
// (or `null`) on success paths, and `err.name === 'WebhookSignatureError'` plus
// `err.message !== 'not implemented'` on the signature-rejection paths — a bare
// `assert.rejects`/`assert.throws` with no predicate would pass against today's stub and must not
// be used here.

const KINDS = ['github', 'gitlab', 'gitea'] as const
type ForgeKind = (typeof KINDS)[number]

const WEBHOOK_SECRET = 'kaola-webhook-secret-9f3c7a'
const WRONG_SECRET = 'not-the-right-secret-0000000'
const CALLBACK_URL = 'https://kaola.example.test/api/v1/webhooks/task-abc123'

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

function credential(kind: ForgeKind): Credential {
  return { token: tokenFor(kind) }
}

function repoFor(kind: ForgeKind, fullName = 'acme/app'): RepoRef {
  return { full_name: fullName, base_url: WEB_ORIGIN[kind] }
}

type AdapterOptions = { baseUrl?: string; webhookSecret?: string }

// Sentinel for "no webhookSecret at all" (distinct from `undefined`, which a default
// parameter would silently replace with WEBHOOK_SECRET even when passed explicitly by a
// caller — see the "adapter created without a webhookSecret" case below).
const NO_SECRET = Symbol('no-secret')

function createAdapter(
  kind: ForgeKind,
  secret: string | typeof NO_SECRET = WEBHOOK_SECRET,
  baseUrl?: string,
): ForgeAdapter {
  const options: AdapterOptions = {}
  if (kind !== 'github') {
    options.baseUrl = baseUrl ?? WEB_ORIGIN[kind]
  } else if (baseUrl !== undefined) {
    options.baseUrl = baseUrl
  }
  if (secret !== NO_SECRET) {
    options.webhookSecret = secret
  }
  return createForgeAdapter(kind, options)
}

// --- registerWebhook fetch-stub helpers (copied + trimmed from get-pull-request.shared.test.ts) ---

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

function plainResponse(status: number, body: unknown = null): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status })
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

// --- signature helpers (this spec computes its own expected digests; production must match) ---

function githubSignatureHeader(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}

function giteaSignatureHeader(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

function eventHeaderName(kind: ForgeKind): string {
  if (kind === 'github') return 'x-github-event'
  if (kind === 'gitlab') return 'x-gitlab-event'
  return 'x-gitea-event'
}

function terminalEventName(kind: ForgeKind): string {
  if (kind === 'gitlab') return 'Merge Request Hook'
  return 'pull_request'
}

function irrelevantEventName(kind: ForgeKind): string {
  if (kind === 'gitlab') return 'Push Hook'
  return 'push'
}

function signatureHeaders(
  kind: ForgeKind,
  secret: string,
  rawBody: string,
  eventName: string,
): Headers {
  const headers = new Headers()
  headers.set(eventHeaderName(kind), eventName)
  headers.set('content-type', 'application/json')
  if (kind === 'github') {
    headers.set('x-hub-signature-256', githubSignatureHeader(secret, rawBody))
  } else if (kind === 'gitea') {
    headers.set('x-gitea-signature', giteaSignatureHeader(secret, rawBody))
  } else {
    headers.set('x-gitlab-token', secret)
  }
  return headers
}

// --- webhook payload builders per rulings ---

function prUrlFor(kind: ForgeKind, fullName: string, number: number): string {
  if (kind === 'gitlab') return `${WEB_ORIGIN.gitlab}/${fullName}/-/merge_requests/${number}`
  const path = kind === 'github' ? 'pull' : 'pulls'
  return `${WEB_ORIGIN[kind]}/${fullName}/${path}/${number}`
}

function githubShapedPayload(opts: {
  action: string
  merged?: boolean
  fullName?: string
  number?: number
  kind: 'github' | 'gitea'
}): Record<string, unknown> {
  const fullName = opts.fullName ?? 'acme/app'
  const number = opts.number ?? 42
  return {
    action: opts.action,
    pull_request: {
      merged: opts.merged ?? false,
      html_url: prUrlFor(opts.kind, fullName, number),
    },
    repository: { full_name: fullName },
  }
}

function gitlabPayload(opts: {
  state: 'opened' | 'closed' | 'merged' | 'locked'
  fullName?: string
  iid?: number
}): Record<string, unknown> {
  const fullName = opts.fullName ?? 'acme/app'
  const iid = opts.iid ?? 42
  return {
    object_attributes: {
      state: opts.state,
      url: prUrlFor('gitlab', fullName, iid),
    },
    project: { path_with_namespace: fullName },
  }
}

function expectedEvent(
  kind: ForgeKind,
  state: 'merged' | 'closed',
  fullName: string,
  number: number,
): { type: 'pull_request'; state: 'merged' | 'closed'; pr_url: string; repo: { full_name: string } } {
  return {
    type: 'pull_request',
    state,
    pr_url: prUrlFor(kind, fullName, number),
    repo: { full_name: fullName },
  }
}

function assertConcreteEvent(result: unknown, expected: ReturnType<typeof expectedEvent>): void {
  assert.equal(typeof result, 'object', `ForgeEvent must be a concrete object, got ${JSON.stringify(result)}`)
  assert.ok(result !== null)
  assert.deepEqual(result, expected)
}

function assertSignatureError(err: unknown): boolean {
  assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`)
  assert.equal((err as Error).name, 'WebhookSignatureError', `expected name WebhookSignatureError, got ${(err as Error).name}`)
  assert.notEqual(
    (err as Error).message,
    'not implemented',
    'a bad-signature rejection must not be the notImplemented placeholder',
  )
  return true
}

describe('parseWebhook shared spec', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('valid signature + merged terminal event → concrete ForgeEvent with state "merged"', () => {
        const payload =
          kind === 'gitlab'
            ? gitlabPayload({ state: 'merged', iid: 11 })
            : githubShapedPayload({ action: 'closed', merged: true, number: 11, kind: kind as 'github' | 'gitea' })
        const rawBody = JSON.stringify(payload)
        const headers = signatureHeaders(kind, WEBHOOK_SECRET, rawBody, terminalEventName(kind))
        const adapter = createAdapter(kind)

        const result = adapter.parseWebhook(headers, rawBody)
        assertConcreteEvent(result, expectedEvent(kind, 'merged', 'acme/app', 11))
      })

      it('valid signature + closed-unmerged terminal event → concrete ForgeEvent with state "closed"', () => {
        const payload =
          kind === 'gitlab'
            ? gitlabPayload({ state: 'closed', iid: 12 })
            : githubShapedPayload({ action: 'closed', merged: false, number: 12, kind: kind as 'github' | 'gitea' })
        const rawBody = JSON.stringify(payload)
        const headers = signatureHeaders(kind, WEBHOOK_SECRET, rawBody, terminalEventName(kind))
        const adapter = createAdapter(kind)

        const result = adapter.parseWebhook(headers, rawBody)
        assertConcreteEvent(result, expectedEvent(kind, 'closed', 'acme/app', 12))
      })

      it('valid signature + non-terminal action/state (still open) → null, not throw', () => {
        const payload =
          kind === 'gitlab'
            ? gitlabPayload({ state: 'opened', iid: 13 })
            : githubShapedPayload({ action: 'opened', merged: false, number: 13, kind: kind as 'github' | 'gitea' })
        const rawBody = JSON.stringify(payload)
        const headers = signatureHeaders(kind, WEBHOOK_SECRET, rawBody, terminalEventName(kind))
        const adapter = createAdapter(kind)

        const result = adapter.parseWebhook(headers, rawBody)
        assert.equal(result, null, `expected null for a non-terminal event, got ${JSON.stringify(result)}`)
      })

      it('valid signature + irrelevant event type (push) → null, not throw', () => {
        const rawBody = JSON.stringify({ ref: 'refs/heads/main', commits: [] })
        const headers = signatureHeaders(kind, WEBHOOK_SECRET, rawBody, irrelevantEventName(kind))
        const adapter = createAdapter(kind)

        const result = adapter.parseWebhook(headers, rawBody)
        assert.equal(result, null, `expected null for an irrelevant event, got ${JSON.stringify(result)}`)
      })

      it('wrong-secret signature → throws WebhookSignatureError (not the notImplemented placeholder)', () => {
        const payload =
          kind === 'gitlab'
            ? gitlabPayload({ state: 'merged', iid: 14 })
            : githubShapedPayload({ action: 'closed', merged: true, number: 14, kind: kind as 'github' | 'gitea' })
        const rawBody = JSON.stringify(payload)
        const badHeaders = signatureHeaders(kind, WRONG_SECRET, rawBody, terminalEventName(kind))
        const adapter = createAdapter(kind, WEBHOOK_SECRET)

        assert.throws(() => adapter.parseWebhook(badHeaders, rawBody), assertSignatureError)
      })

      it('missing signature header entirely → throws WebhookSignatureError', () => {
        const payload =
          kind === 'gitlab'
            ? gitlabPayload({ state: 'merged', iid: 15 })
            : githubShapedPayload({ action: 'closed', merged: true, number: 15, kind: kind as 'github' | 'gitea' })
        const rawBody = JSON.stringify(payload)
        const headers = new Headers()
        headers.set(eventHeaderName(kind), terminalEventName(kind))
        headers.set('content-type', 'application/json')
        const adapter = createAdapter(kind, WEBHOOK_SECRET)

        assert.throws(() => adapter.parseWebhook(headers, rawBody), assertSignatureError)
      })

      it('adapter created without a webhookSecret (undefined or empty) → parse fails the same as a bad signature', () => {
        const payload =
          kind === 'gitlab'
            ? gitlabPayload({ state: 'merged', iid: 16 })
            : githubShapedPayload({ action: 'closed', merged: true, number: 16, kind: kind as 'github' | 'gitea' })
        const rawBody = JSON.stringify(payload)
        const headers = signatureHeaders(kind, WEBHOOK_SECRET, rawBody, terminalEventName(kind))

        const noSecretAdapter = createAdapter(kind, NO_SECRET)
        assert.throws(() => noSecretAdapter.parseWebhook(headers, rawBody), assertSignatureError)

        const emptySecretAdapter = createAdapter(kind, '')
        assert.throws(() => emptySecretAdapter.parseWebhook(headers, rawBody), assertSignatureError)
      })
    })
  }

  it('body may be passed as a Buffer (raw bytes), not only a string, for every kind', () => {
    for (const kind of KINDS) {
      const payload =
        kind === 'gitlab'
          ? gitlabPayload({ state: 'merged', iid: 17 })
          : githubShapedPayload({ action: 'closed', merged: true, number: 17, kind: kind as 'github' | 'gitea' })
      const rawBody = JSON.stringify(payload)
      const headers = signatureHeaders(kind, WEBHOOK_SECRET, rawBody, terminalEventName(kind))
      const adapter = createAdapter(kind)

      const result = adapter.parseWebhook(headers, Buffer.from(rawBody, 'utf8'))
      assertConcreteEvent(result, expectedEvent(kind, 'merged', 'acme/app', 17))
    }
  })

  it('github: ping event with a valid signature → null, must not throw (hook setup must not fail)', () => {
    const pingBody = JSON.stringify({ zen: 'Non-blocking is better than blocking.', hook_id: 999 })
    const headers = signatureHeaders('github', WEBHOOK_SECRET, pingBody, 'ping')
    const adapter = createAdapter('github')

    const result = adapter.parseWebhook(headers, pingBody)
    assert.equal(result, null, `expected null for a ping event, got ${JSON.stringify(result)}`)
  })

  it('gitea: a tampered body (bytes differ from what was signed) → throws WebhookSignatureError', () => {
    const signedBody = JSON.stringify(
      githubShapedPayload({ action: 'closed', merged: true, number: 18, kind: 'gitea' }),
    )
    const tamperedBody = JSON.stringify(
      githubShapedPayload({ action: 'closed', merged: true, number: 18999, kind: 'gitea' }),
    )
    const headers = signatureHeaders('gitea', WEBHOOK_SECRET, signedBody, 'pull_request')
    const adapter = createAdapter('gitea')

    assert.throws(() => adapter.parseWebhook(headers, tamperedBody), assertSignatureError)
  })

  it('gitlab: irrelevant event type with a correct token is still null, not an error (token alone is not "terminal")', () => {
    const rawBody = JSON.stringify({ object_kind: 'push' })
    const headers = signatureHeaders('gitlab', WEBHOOK_SECRET, rawBody, irrelevantEventName('gitlab'))
    const adapter = createAdapter('gitlab')

    const result = adapter.parseWebhook(headers, rawBody)
    assert.equal(result, null)
  })
})

describe('registerWebhook shared spec', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('non-OK HTTP response rejects with a message containing "<kind> responded <status>", after exactly one fetch', async (t) => {
        const requests = installFetch(t, () => plainResponse(422, { message: 'unprocessable' }))
        const adapter = createAdapter(kind)

        await assert.rejects(
          async () => {
            await adapter.registerWebhook(credential(kind), repoFor(kind), CALLBACK_URL)
          },
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.match(err.message, new RegExp(`${kind} responded 422`))
            assert.notEqual(err.message, 'not implemented')
            return true
          },
        )
        assert.equal(requests.length, 1, 'registerWebhook must actually call fetch exactly once before rejecting')
      })
    })
  }

  it('github: POST https://api.github.com/repos/{owner}/{repo}/hooks with pull_request events + secret, GitHub auth', async (t) => {
    const requests = installFetch(t, () => plainResponse(201, { id: 1 }))
    const adapter = createAdapter('github')

    await adapter.registerWebhook(credential('github'), repoFor('github'), CALLBACK_URL)

    assert.equal(requests.length, 1)
    const [req] = requests
    assert.equal(req.method, 'POST')
    assert.equal(req.url, 'https://api.github.com/repos/acme/app/hooks')
    assert.equal(req.headers.get('authorization'), `Bearer ${tokenFor('github')}`)
    const userAgent = req.headers.get('user-agent')
    assert.ok(userAgent != null && userAgent.length > 0)

    const body = req.body as Record<string, unknown> | undefined
    assert.equal(body?.name, 'web')
    assert.ok(Array.isArray(body?.events))
    assert.ok((body?.events as unknown[]).includes('pull_request'))
    const config = body?.config as Record<string, unknown> | undefined
    assert.equal(config?.url, CALLBACK_URL)
    assert.equal(config?.content_type, 'json')
    assert.equal(config?.secret, WEBHOOK_SECRET)
  })

  it('github: registerWebhook always targets api.github.com regardless of a custom baseUrl option', async (t) => {
    const requests = installFetch(t, () => plainResponse(201, { id: 1 }))
    const adapter = createAdapter('github', WEBHOOK_SECRET, CUSTOM_BASE_URL.github)

    await adapter.registerWebhook(credential('github'), repoFor('github'), CALLBACK_URL)

    assert.equal(requests[0]?.url, 'https://api.github.com/repos/acme/app/hooks')
    assert.equal(requests[0]?.url.includes('github.example.com'), false)
  })

  it('gitlab: POST {baseUrl}/api/v4/projects/{id}/hooks with merge_requests_events + token, PRIVATE-TOKEN auth', async (t) => {
    const requests = installFetch(t, () => plainResponse(201, { id: 2 }))
    const adapter = createAdapter('gitlab')
    const fullName = 'acme/app'

    await adapter.registerWebhook(
      credential('gitlab'),
      { full_name: fullName, base_url: WEB_ORIGIN.gitlab },
      CALLBACK_URL,
    )

    assert.equal(requests.length, 1)
    const [req] = requests
    assert.equal(req.method, 'POST')
    assert.equal(req.url, `${WEB_ORIGIN.gitlab}/api/v4/projects/${encodeURIComponent(fullName)}/hooks`)
    assert.equal(req.headers.get('private-token'), tokenFor('gitlab'))

    const body = req.body as Record<string, unknown> | undefined
    assert.equal(body?.url, CALLBACK_URL)
    assert.equal(body?.merge_requests_events, true)
    assert.equal(body?.token, WEBHOOK_SECRET)
    assert.equal(body?.signing_token, undefined, 'this issue implements the legacy token field, not signing_token')
  })

  it('gitlab: registerWebhook uses the constructor baseUrl, not repo.base_url, and encodes nested-group namespaces', async (t) => {
    const requests = installFetch(t, () => plainResponse(201, { id: 3 }))
    const apiOrigin = CUSTOM_BASE_URL.gitlab
    const adapter = createAdapter('gitlab', WEBHOOK_SECRET, apiOrigin)
    const namespace = 'group/subgroup/app'

    await adapter.registerWebhook(
      credential('gitlab'),
      { full_name: namespace, base_url: 'https://gitlab.other-host.test' },
      CALLBACK_URL,
    )

    const url = requests[requests.length - 1]?.url ?? ''
    assert.equal(url, `${apiOrigin}/api/v4/projects/${encodeURIComponent(namespace)}/hooks`)
    assert.equal(url.includes('other-host.test'), false, 'must never fetch the repo.base_url host')
  })

  it('gitea: POST {baseUrl}/api/v1/repos/{owner}/{repo}/hooks with type gitea + pull_request events + config, token auth', async (t) => {
    const requests = installFetch(t, () => plainResponse(201, { id: 4 }))
    const adapter = createAdapter('gitea')
    const fullName = 'acme/app'

    await adapter.registerWebhook(
      credential('gitea'),
      { full_name: fullName, base_url: WEB_ORIGIN.gitea },
      CALLBACK_URL,
    )

    assert.equal(requests.length, 1)
    const [req] = requests
    assert.equal(req.method, 'POST')
    assert.equal(req.url, `${WEB_ORIGIN.gitea}/api/v1/repos/${fullName}/hooks`)
    assert.equal(req.headers.get('authorization'), `token ${tokenFor('gitea')}`)

    const body = req.body as Record<string, unknown> | undefined
    assert.equal(body?.type, 'gitea')
    assert.ok(Array.isArray(body?.events))
    assert.ok((body?.events as unknown[]).includes('pull_request'))
    const config = body?.config as Record<string, unknown> | undefined
    assert.equal(config?.url, CALLBACK_URL)
    assert.equal(config?.content_type, 'json')
    assert.equal(config?.secret, WEBHOOK_SECRET)
  })

  it('gitea: registerWebhook uses the constructor baseUrl, not repo.base_url', async (t) => {
    const requests = installFetch(t, () => plainResponse(201, { id: 5 }))
    const apiOrigin = CUSTOM_BASE_URL.gitea
    const adapter = createAdapter('gitea', WEBHOOK_SECRET, apiOrigin)

    await adapter.registerWebhook(
      credential('gitea'),
      { full_name: 'acme/app', base_url: 'https://gitea.other-host.test' },
      CALLBACK_URL,
    )

    const url = requests[requests.length - 1]?.url ?? ''
    assert.equal(url, `${apiOrigin}/api/v1/repos/acme/app/hooks`)
    assert.equal(url.includes('other-host.test'), false, 'must never fetch the repo.base_url host')
  })
})
