import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createForgeAdapter } from './index.ts'
import type { Credential, ForgeAdapter, CreateForgeAdapterOptions } from './index.ts'

// Issue #37. HEAD `8d3504e`: neither `forgePost` nor `forgeGet` in `index.ts` passes any
// `signal`/timeout to `globalThis.fetch` — a hung (not refusing) forge blocks every adapter
// operation (validateToken, importIssue, listIssues, commentOnIssue, getPullRequest,
// registerWebhook) without bound, for all three kinds, since they all route through those two
// helpers. This is the shared acceptance spec for a bounded, configurable abort timeout,
// parameterized over github/gitlab/gitea per AGENTS.md's "adapters share the integration
// contract" rule. Mirrors `get-pull-request.shared.test.ts` / `comment-on-issue.shared.test.ts`'s
// fetch-stub shape; deliberately copied and trimmed rather than imported, per this project's
// one-shared-spec-per-file convention.
//
// GUESS (flagged for the implementer): there is no existing config surface for this in
// `CreateForgeAdapterOptions`, and nothing in docs/DESIGN.md or the issue history names one. This
// file assumes the bounded deadline is configured via a `timeoutMs: number` field added to
// `CreateForgeAdapterOptions` (threaded the same way `baseUrl` already is: github ignores it for
// nothing host-related, gitlab/gitea take it alongside `baseUrl`). If the real option is named or
// shaped differently, only `createAdapterWithTimeout` below needs to change to match it — every
// other assertion in this file is against the OBSERVABLE fetch contract (an `AbortSignal` is
// passed, it fires on a hang, firing it rejects the operation, the deadline is configurable, and a
// fast response is never falsely aborted), not against a private implementation shape.

const KINDS = ['github', 'gitlab', 'gitea'] as const
type ForgeKind = (typeof KINDS)[number]

const WEB_ORIGIN = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.example.com',
  gitea: 'https://gitea.example.com',
} as const

// Fixed, already-valid URLs (same shapes proven by get-pull-request.shared.test.ts /
// comment-on-issue.shared.test.ts) — this file does not re-verify URL construction, only the
// timeout contract, so one representative pair per kind is enough.
const PR_URL: Record<ForgeKind, string> = {
  github: `${WEB_ORIGIN.github}/acme/app/pull/11`,
  gitlab: `${WEB_ORIGIN.gitlab}/acme/app/-/merge_requests/11`,
  gitea: `${WEB_ORIGIN.gitea}/acme/app/pulls/11`,
}

const ISSUE_URL: Record<ForgeKind, string> = {
  github: `${WEB_ORIGIN.github}/acme/app/issues/61`,
  gitlab: `${WEB_ORIGIN.gitlab}/acme/app/-/issues/61`,
  gitea: `${WEB_ORIGIN.gitea}/acme/app/issues/61`,
}

// Small, real, millisecond-scale deadlines — no fake timers. (Node's `t.mock.timers` does not
// intercept `AbortSignal.timeout()`'s internal timer, so a fake-timer test would silently pass or
// fail depending on which timer primitive production happens to pick; a short real deadline plus
// the `raceGuard` safety net below is the only strategy that is honest about the observable
// contract regardless of implementation choice.)
const SHORT_TIMEOUT_MS = 15
const LONG_TIMEOUT_MS = 90
// Upper bound so a still-missing timeout fails fast instead of hanging the test run.
const GUARD_MS = 400

function tokenFor(kind: ForgeKind): string {
  return kind === 'github' ? 'github_pat_test-token' : 'test-token'
}

function credential(kind: ForgeKind, token = tokenFor(kind)): Credential {
  return { token }
}

function createAdapterWithTimeout(
  kind: ForgeKind,
  timeoutMs: number,
  baseUrl = WEB_ORIGIN[kind],
): ForgeAdapter {
  const withTimeout = { timeoutMs } as CreateForgeAdapterOptions & { timeoutMs: number }
  if (kind === 'github') return createForgeAdapter(kind, withTimeout)
  return createForgeAdapter(kind, { ...withTimeout, baseUrl })
}

type RecordedRequest = { url: string; method: string; headers: Headers }

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

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError')
}

// A forge that never answers: the returned promise only ever settles by rejecting when (and if)
// the signal fetch was called with fires `abort` — exactly how real `fetch` behaves against an
// `AbortSignal`. If production never passes a signal at all, this promise never settles, which is
// the whole point: it stands in for a hung, not-refusing forge.
function installHangingFetch(t: {
  mock: { method: typeof import('node:test').mock.method }
}): { requests: RecordedRequest[]; getSignal: () => AbortSignal | undefined } {
  const requests: RecordedRequest[] = []
  let lastSignal: AbortSignal | undefined
  t.mock.method(
    globalThis,
    'fetch',
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = requestUrl(input)
      const method = requestMethod(input, init)
      const headers = requestHeaders(input, init)
      requests.push({ url, method, headers })
      const signal = requestSignal(input, init)
      lastSignal = signal
      return new Promise<Response>((_resolve, reject) => {
        if (signal == null) return
        if (signal.aborted) {
          reject(abortError())
          return
        }
        signal.addEventListener('abort', () => reject(abortError()), { once: true })
      })
    },
  )
  return { requests, getSignal: () => lastSignal }
}

function installImmediateFetch(
  t: { mock: { method: typeof import('node:test').mock.method } },
  body: unknown,
  status = 200,
): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push({
        url: requestUrl(input),
        method: requestMethod(input, init),
        headers: requestHeaders(input, init),
      })
      return jsonResponse(body, status)
    },
  )
  return requests
}

// Races the real operation against an external, generous real-time deadline so a still-missing
// production timeout fails this test quickly instead of hanging the run. `assertRealAbort` below
// distinguishes "the adapter itself rejected via its own abort" from "our guard gave up on it".
async function raceGuard<T>(promise: Promise<T>, guardMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `guard: ${label} did not settle within ${guardMs}ms — a hung forge response must be aborted by a bounded, configurable timeout`,
        ),
      )
    }, guardMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(timer)
  }
}

function assertRealAbort(err: unknown, label: string): boolean {
  assert.ok(err instanceof Error, `${label}: expected an Error, got ${String(err)}`)
  assert.ok(
    !(err as Error).message.startsWith('guard:'),
    `${label}: the adapter never rejected on its own before the external test guard fired — ` +
      `a hung forge response must be aborted by the adapter's own bounded timeout: ${(err as Error).message}`,
  )
  return true
}

async function callGetShapedOp(adapter: ForgeAdapter, kind: ForgeKind): Promise<unknown> {
  return adapter.getPullRequest(credential(kind), PR_URL[kind])
}

async function callPostShapedOp(adapter: ForgeAdapter, kind: ForgeKind): Promise<unknown> {
  return adapter.commentOnIssue(credential(kind), { issue_url: ISSUE_URL[kind] }, 'x')
}

describe('forge fetch timeout shared spec (issue #37)', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('a hung GET-shaped fetch (getPullRequest, via forgeGet) is aborted rather than left pending forever', async (t) => {
        const { requests, getSignal } = installHangingFetch(t)
        const adapter = createAdapterWithTimeout(kind, SHORT_TIMEOUT_MS)

        await assert.rejects(
          () => raceGuard(callGetShapedOp(adapter, kind), GUARD_MS, `${kind} getPullRequest`),
          (err: unknown) => assertRealAbort(err, `${kind} getPullRequest`),
        )
        assert.equal(requests.length, 1, 'getPullRequest must call fetch exactly once')
        const signal = getSignal()
        assert.ok(
          signal instanceof AbortSignal,
          'forgeGet must pass an AbortSignal to fetch so a hang can be cancelled',
        )
        assert.equal(
          signal?.aborted,
          true,
          'the AbortSignal passed to fetch must actually fire once the configured timeout elapses',
        )
      })

      it('a hung POST-shaped fetch (commentOnIssue, via forgePost) is aborted rather than left pending forever', async (t) => {
        const { requests, getSignal } = installHangingFetch(t)
        const adapter = createAdapterWithTimeout(kind, SHORT_TIMEOUT_MS)

        await assert.rejects(
          () => raceGuard(callPostShapedOp(adapter, kind), GUARD_MS, `${kind} commentOnIssue`),
          (err: unknown) => assertRealAbort(err, `${kind} commentOnIssue`),
        )
        assert.equal(requests.length, 1, 'commentOnIssue must call fetch exactly once')
        const signal = getSignal()
        assert.ok(
          signal instanceof AbortSignal,
          'forgePost must pass an AbortSignal to fetch so a hang can be cancelled',
        )
        assert.equal(
          signal?.aborted,
          true,
          'the AbortSignal passed to fetch must actually fire once the configured timeout elapses',
        )
      })

      it('the abort deadline is configurable: a longer configured timeout waits measurably longer than a shorter one', async (t) => {
        installHangingFetch(t)
        const shortAdapter = createAdapterWithTimeout(kind, SHORT_TIMEOUT_MS)
        const shortStart = Date.now()
        await assert.rejects(
          () =>
            raceGuard(callGetShapedOp(shortAdapter, kind), GUARD_MS, `${kind} short-timeout getPullRequest`),
          (err: unknown) => assertRealAbort(err, `${kind} short timeout`),
        )
        const shortElapsed = Date.now() - shortStart

        t.mock.restoreAll()
        installHangingFetch(t)
        const longAdapter = createAdapterWithTimeout(kind, LONG_TIMEOUT_MS)
        const longStart = Date.now()
        await assert.rejects(
          () =>
            raceGuard(callGetShapedOp(longAdapter, kind), GUARD_MS, `${kind} long-timeout getPullRequest`),
          (err: unknown) => assertRealAbort(err, `${kind} long timeout`),
        )
        const longElapsed = Date.now() - longStart

        assert.ok(
          longElapsed - shortElapsed > (LONG_TIMEOUT_MS - SHORT_TIMEOUT_MS) / 2,
          `a ${LONG_TIMEOUT_MS}ms configured timeout must wait measurably longer than a ${SHORT_TIMEOUT_MS}ms ` +
            `one before aborting; got short=${shortElapsed}ms long=${longElapsed}ms — the abort deadline must ` +
            'be honored per configuration, not a single fixed constant',
        )
      })

      it('a normal fast GET response is not aborted, even against a very short configured timeout (no false positive)', async (t) => {
        installImmediateFetch(t, { number: 11, state: 'open', merged: false })
        const adapter = createAdapterWithTimeout(kind, SHORT_TIMEOUT_MS)
        const result = await callGetShapedOp(adapter, kind)
        assert.equal((result as { state: unknown }).state, 'open')
      })

      it('a normal fast POST response is not aborted, even against a very short configured timeout (no false positive)', async (t) => {
        installImmediateFetch(t, { id: 1 }, 201)
        const adapter = createAdapterWithTimeout(kind, SHORT_TIMEOUT_MS)
        await assert.doesNotReject(() => callPostShapedOp(adapter, kind))
      })
    })
  }
})
