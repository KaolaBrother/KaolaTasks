import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createForgeAdapter } from '@kaola/forge-adapters'
import { createDb } from './db.ts'
import { events, tasks } from './schema.ts'
import { encryptToken } from './vault.ts'
import { attemptWriteback } from './writeback.ts'

// Independent regression spec for the defect an audit found in the just-landed issue #37 work:
// #37 added `timeoutMs?: number` to `CreateForgeAdapterOptions` plus `DEFAULT_TIMEOUT_MS =
// 10_000` in packages/forge-adapters/src/index.ts, and both forgeGet/forgePost now pass
// `signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)`. That is correct for
// read paths, but `apps/server/src/writeback.ts`'s `postComment` builds its adapter via
// `createForgeAdapter(task.repoForge, { baseUrl: task.repoBaseUrl })` — no `timeoutMs` — so it
// silently inherits the same 10s deadline as every read call. A self-hosted GitLab/Gitea that
// takes longer than that to answer a comment POST, but DOES create the comment, now gets its
// response aborted; `attemptWriteback` swallows the abort and records no successful `回写` event,
// so `retryPendingWritebacks` re-posts on every poller tick and duplicates a real user's comment.
//
// This file does not import writeback.test.ts's app/HTTP/MCP harness (per this codebase's
// one-seam-per-file convention, see that file's and timeout.shared.test.ts's header comments) —
// `attemptWriteback` is exercised directly against a minimal sqlite db + task row, which is
// enough to reach `postComment`'s `createForgeAdapter(...)` call.
//
// HOW THE DEADLINE ITSELF IS OBSERVED: `AbortSignal.timeout(ms)` does not expose its `ms` on the
// returned signal, and actually waiting for a multi-second real abort to fire is both slow and
// (for the write-back deadline, which must be *longer* than the 10s default) impractical in a
// test. Instead this file mocks the global `AbortSignal.timeout` static — exactly the same
// pattern this codebase already uses for `t.mock.method(globalThis, 'fetch', ...)` — to record
// every `ms` argument synchronously while still delegating to the real implementation, so normal
// operation (and a fast stubbed fetch) proceeds unaffected. This needs no experimental flags,
// unlike `node:test`'s `mock.module` (confirmed unavailable under this repo's plain
// `--experimental-strip-types --test` invocation).
//
// ACCEPTANCE CONTRACT ASSERTED (RELATION, not an exact number — see below):
//   1. write-back's adapter construction must pass an EXPLICIT timeoutMs, not rely on the
//      default (`postComment`'s call must produce a different AbortSignal.timeout(ms) than an
//      otherwise-identical adapter built with no timeoutMs option).
//   2. that write-back deadline must be STRICTLY GREATER than whatever the adapter's own default
//      currently is — measured empirically in this same test run (not hardcoded), so this stays
//      correct even if DEFAULT_TIMEOUT_MS's value changes later.
//   3. a "global bump" bad fix (raising DEFAULT_TIMEOUT_MS itself instead of passing a distinct
//      timeoutMs at the writeback.ts call site) must NOT satisfy this test: since the baseline
//      measurement below also goes through the (unchanged) no-options construction path, a global
//      bump would move both numbers together and the strict inequality would still fail.
//   4. a comment POST that completes (doesn't hang) must still record exactly one successful 回写
//      event and cause exactly one comment POST — no regression, no duplicate — once resolved.
//
// GUESS the implementer may need to weigh: the exact write-back deadline value is left to them;
// only the relation (write-back deadline > adapter default) is pinned here, per this task's
// explicit preference for asserting the relation over a specific number.

const VAULT_MASTER_KEY_HEX = 'ef'.repeat(32)
process.env.VAULT_MASTER_KEY = VAULT_MASTER_KEY_HEX

const GITEA_BASE_URL = 'https://gitea.writeback-timeout.example.test'
const REPO_FULL_NAME = 'acme/checkout'
const ISSUE_NUMBER = 701
const INLINE_TOKEN = 'gitea-writeback-timeout-INLINE-TOKEN'
const ISSUE_URL = `${GITEA_BASE_URL}/${REPO_FULL_NAME}/issues/${ISSUE_NUMBER}`
const COMMENT_URL = `${GITEA_BASE_URL}/api/v1/repos/${REPO_FULL_NAME}/issues/${ISSUE_NUMBER}/comments`

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Mocks `AbortSignal.timeout` to record every configured deadline (ms) while still delegating to
// the real implementation, and stubs `globalThis.fetch` to resolve every comment POST immediately
// (this file is about *which deadline gets configured*, not about actually waiting one out).
function instrumentDeadlinesAndFetch(t: { mock: { method: typeof import('node:test').mock.method } }): {
  timeoutCalls: number[]
  fetchCalls: { url: string; method: string; headers: Headers }[]
} {
  const timeoutCalls: number[] = []
  const originalAbortTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    timeoutCalls.push(ms)
    return originalAbortTimeout(ms)
  })

  const fetchCalls: { url: string; method: string; headers: Headers }[] = []
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: string }).url ?? input)
    const method = (init?.method ?? (input as { method?: string })?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? (input as { headers?: HeadersInit })?.headers)
    fetchCalls.push({ url, method, headers })
    return jsonResponse(201, { id: fetchCalls.length })
  })

  return { timeoutCalls, fetchCalls }
}

function importedTaskRow(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  return {
    publicId: 'wb-timeout-0001',
    title: '导入任务-写回超时',
    descriptionMd: '',
    sourceType: 'imported' as const,
    sourceIssueUrl: ISSUE_URL,
    repoForge: 'gitea' as const,
    repoBaseUrl: GITEA_BASE_URL,
    repoFullName: REPO_FULL_NAME,
    repoBaseBranch: 'main',
    repoSuggestedDir: 'checkout',
    priority: 'P1' as const,
    posterUserId: 1,
    inlineTokenEncrypted: encryptToken(INLINE_TOKEN),
    status: '进行中' as const,
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  }
}

describe('write-back deadline (regression for the #37 timeout defect landing on the write-back path)', () => {
  test('postComment (via attemptWriteback) configures an explicit deadline strictly greater than the adapter default, and still records exactly one successful 回写 with exactly one comment POST', async (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const { timeoutCalls, fetchCalls } = instrumentDeadlinesAndFetch(t)

    const inserted = db.insert(tasks).values(importedTaskRow()).run()
    const taskId = Number(inserted.lastInsertRowid)
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    assert.ok(task, 'setup: task row must exist')

    // --- Baseline: the exact construction read paths use (no explicit timeoutMs) ---
    // Reproduces, byte for byte, how `createForgeAdapter` is called with no `timeoutMs`
    // (identical to how every read-path caller in this codebase constructs an adapter today), so
    // this measures the adapter's live default rather than a hardcoded/copied constant.
    const baselineAdapter = createForgeAdapter('gitea', { baseUrl: GITEA_BASE_URL })
    await baselineAdapter.commentOnIssue({ token: INLINE_TOKEN }, { issue_url: ISSUE_URL }, 'baseline probe')
    assert.equal(timeoutCalls.length, 1, 'setup: the baseline probe must perform exactly one forgePost/AbortSignal.timeout call')
    const [defaultMs] = timeoutCalls
    assert.equal(typeof defaultMs, 'number')
    timeoutCalls.length = 0
    fetchCalls.length = 0

    // --- The actual write-back path under test ---
    await attemptWriteback(db, task!, '认领', null)

    assert.equal(
      timeoutCalls.length,
      1,
      `write-back's postComment must perform exactly one AbortSignal.timeout-bounded fetch, got ${timeoutCalls.length}`,
    )
    const [writebackMs] = timeoutCalls
    assert.equal(typeof writebackMs, 'number', 'write-back must configure a numeric deadline')
    assert.notEqual(
      writebackMs,
      defaultMs,
      `write-back must configure an EXPLICIT deadline distinct from the adapter default (both were ${String(writebackMs)}ms) — ` +
        'it must not silently inherit createForgeAdapter\'s default via an options object with no timeoutMs',
    )
    assert.ok(
      writebackMs > defaultMs,
      `write-back's deadline (${writebackMs}ms) must be STRICTLY GREATER than the adapter default currently in effect ` +
        `for read paths (${defaultMs}ms) — a slow-but-working forge must be given more patience for a durable, ` +
        'user-visible write than for a read. (A "global bump" of DEFAULT_TIMEOUT_MS itself, rather than a distinct ' +
        'value at the writeback.ts call site, would move both numbers together and must fail this assertion too.)',
    )

    // Pin #4: a comment POST that actually completes (this test's fetch stub resolves immediately,
    // it never hangs) must still behave exactly as before — one comment POST, one successful 回写.
    assert.equal(
      fetchCalls.filter((c) => c.url === COMMENT_URL && c.method === 'POST').length,
      1,
      `expected exactly one write-back comment POST, got ${JSON.stringify(fetchCalls)}`,
    )
    const writebackEvents = db.select().from(events).where(eq(events.type, '回写')).all()
    const successful = writebackEvents.filter((row) => {
      const details = JSON.parse(row.details) as Record<string, unknown>
      return details.task_id === task!.publicId && details.transition === '认领' && details.ok === true
    })
    assert.equal(
      successful.length,
      1,
      `expected exactly one successful 回写 event for 认领, got ${JSON.stringify(writebackEvents)}`,
    )
    assert.equal(
      JSON.stringify(writebackEvents).includes(INLINE_TOKEN),
      false,
      '回写 event must never contain the plaintext forge token',
    )
  })
})
