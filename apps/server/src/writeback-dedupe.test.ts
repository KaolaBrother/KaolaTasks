import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createDb } from './db.ts'
import { events, tasks } from './schema.ts'
import { encryptToken, insertAuditEvent } from './vault.ts'
import { attemptWriteback, retryPendingWritebacks } from './writeback.ts'

// Issue #40. Independent acceptance spec for the single-writer ack-loss race described in the
// issue: `postComment` fires the comment POST, the forge COMMITS it, but the client never reads
// the response back (an `AbortSignal.timeout(WRITEBACK_TIMEOUT_MS)` firing, or the network
// dropping after dispatch). `attemptWriteback` currently swallows every fault uniformly and
// records no `回写` event, so the uncapped `retryPendingWritebacks` sweep reposts on the very next
// 60s tick, duplicating a real comment on a real user's Issue.
//
// Controller's binding decision (issue #40 body, gh issue view 40): introduce a recognizable
// idempotency marker and check for it before retrying, WITHOUT changing #14's "retry forever until
// success" contract, and WITHOUT ever accepting a duplicate comment. `commentBodyFor` already
// embeds `task.publicId` plus a transition phrase in every write-back body — that is the marker;
// this spec does not invent a new hidden token, it only asserts the OUTCOME: dedupe via
// `listIssueComments` (see `packages/forge-adapters/src/list-issue-comments.shared.test.ts` for
// that adapter-level primitive) resolves the ambiguity instead of ever creating a second comment.
//
// This file drives `attemptWriteback` / `retryPendingWritebacks` directly against a minimal
// sqlite db + task row (same seam as `writeback-timeout.test.ts`; not the full app/HTTP/MCP
// harness `writeback.test.ts` uses), and mocks only `globalThis.fetch` — a scripted fake "forge"
// that can commit a comment server-side while still causing the client's `fetch()` call itself to
// reject, modeling exactly the ack-loss scenario the issue describes.
//
// HEAD `fbdab34`: `attemptWriteback`'s catch block is unconditional (`writeback.ts:104-111`) and
// nothing in `writeback.ts` ever calls a listing/lookup method — there is no `listIssueComments`
// on `ForgeAdapter` at all yet. Every scenario below where the forge fixture commits a comment
// but the client's fetch rejects is therefore expected to still duplicate the comment once
// `retryPendingWritebacks` runs, and the "listing must not be called on a definite failure" /
// "skip this tick when listing is unavailable" invariants have no code path to satisfy them.
//
// GITEA ORDERING GUESS: this suite drives the `gitea` adapter (whose real comment-listing endpoint
// has no documented ordering guarantee — see the shared spec's header comment). Every scenario
// below that seeds more than one comment in the fake forge's store deliberately puts the
// write-back marker in the MIDDLE of the array (decoy comments before and after), so a dedupe scan
// that only checks the first or last entry — an easy, wrong shortcut for an "unordered" listing —
// fails these tests rather than passing them by accident.
//
// FOLLOW-UP (independent review, same issue #40): two more describe blocks were added below after
// the implementation landed and passed the tests above:
//
//   R1 — `isDefiniteFailure` (writeback.ts) currently matches ANY status-bearing throw
//   (`/ responded \d+$/`) as DEFINITE. That is correct for a 403/404/422 from the forge API
//   itself, but WRONG for a 5xx from a reverse proxy in front of a self-hosted forge (AGENTS.md
//   names exactly this topology: self-hosted GitLab/Gitea), or a 408/429 — any of which can be
//   returned by the gateway or the origin AFTER the origin already committed the comment. Today
//   that is misclassified as "nothing was created" and blindly reposted with zero listing calls,
//   reproducing the exact duplicate this issue exists to prevent. The tests below pin the
//   corrected boundary: 4xx except 408/429 stays DEFINITE (zero listing calls, ever); 5xx plus
//   408/429 must be treated as AMBIGUOUS (resolved via `listIssueComments` before any repost),
//   exactly like a non-status network failure already is.
//
//   R3 — `recordFailedWriteback`'s de-duplication guard (collapses an unbroken run of identical
//   failures to one `回写` row) had no coverage at all. Added below: an unbroken run of identical
//   failures still collapses to one row (this already passes today — it is closing a coverage
//   gap, not chasing a defect); a classification change (ambiguous <-> definite) still records a
//   new row; and one test documents, without asserting it is prevented, that a forge which
//   alternates outcome on every tick writes one row per transition (bounded by transitions, not
//   by a cap below the tick count) — a known, accepted limitation of comparing only against the
//   immediately-preceding outcome.

const VAULT_MASTER_KEY_HEX = 'ef'.repeat(32)
process.env.VAULT_MASTER_KEY = VAULT_MASTER_KEY_HEX
const PUBLIC_URL = 'http://localhost:3000'
process.env.PUBLIC_URL = PUBLIC_URL

const GITEA_BASE_URL = 'https://gitea.dedupe.example.test'
const REPO_FULL_NAME = 'acme/checkout'
const ISSUE_NUMBER = 901
const INLINE_TOKEN = 'gitea-dedupe-INLINE-TOKEN-zz99'
const ISSUE_URL = `${GITEA_BASE_URL}/${REPO_FULL_NAME}/issues/${ISSUE_NUMBER}`
// Gitea's comment collection endpoint: commentOnIssue POSTs here, and a would-be
// listIssueComments GETs the same URL (see comment-on-issue.shared.test.ts's giteaCommentApiUrl).
const COMMENT_COLLECTION_URL = `${GITEA_BASE_URL}/api/v1/repos/${REPO_FULL_NAME}/issues/${ISSUE_NUMBER}/comments`

const WRITEBACK_EVENT = '回写'
const STATUS_TRANSITION_EVENT = '状态迁移'

// The exact body `commentBodyFor('认领', publicId, undefined)` produces (writeback.ts:59-68,
// mirrored here rather than imported — that function is module-private, and per this task's
// scope this file must not modify writeback.ts to export it). This IS the pre-existing "marker":
// task.publicId plus a transition-specific Chinese phrase, nothing new or hidden.
function expectedClaimBody(publicId: string): string {
  return `考拉任务（Kaola Tasks）已认领本 Issue 对应的任务。\n任务编号：${publicId}\n任务详情：${PUBLIC_URL}`
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function importedTaskRow(publicId: string) {
  return {
    publicId,
    title: '导入任务-写回去重',
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
  }
}

function insertImportedTask(db: ReturnType<typeof createDb>, publicId: string) {
  const inserted = db.insert(tasks).values(importedTaskRow(publicId)).run()
  const taskId = Number(inserted.lastInsertRowid)
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  assert.ok(task, 'setup: task row must exist')
  return task!
}

// Satisfies writeback.ts's private `claimOccurred` check so `retryPendingWritebacks` actually
// considers this task's 认领 transition eligible for a retry sweep.
function seedClaimTransition(db: ReturnType<typeof createDb>, publicId: string): void {
  insertAuditEvent(db, {
    type: STATUS_TRANSITION_EVENT,
    actorUserId: null,
    details: { task_id: publicId, from: '待认领', to: '进行中' },
  })
}

function successfulClaimWritebacks(db: ReturnType<typeof createDb>, publicId: string) {
  const rows = db.select().from(events).where(eq(events.type, WRITEBACK_EVENT)).all()
  return rows.filter((row) => {
    const details = JSON.parse(row.details) as Record<string, unknown>
    return details.task_id === publicId && details.transition === '认领' && details.ok === true
  })
}

function requestMethod(input: unknown, init?: RequestInit): string {
  if (input !== null && typeof input === 'object' && 'method' in input) {
    const method = (input as { method?: unknown }).method
    if (typeof method === 'string' && method.length > 0) return method.toUpperCase()
  }
  return (init?.method ?? 'GET').toUpperCase()
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

function requestBodyText(input: unknown, init?: RequestInit): string | undefined {
  let raw: unknown = init?.body
  if (raw === undefined && input !== null && typeof input === 'object' && 'body' in input) {
    raw = (input as { body?: unknown }).body
  }
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw) as { body?: unknown }
    return typeof parsed.body === 'string' ? parsed.body : undefined
  } catch {
    return undefined
  }
}

describe('write-back ack-loss dedupe (issue #40)', () => {
  test('happy path is unchanged: a successful post records exactly one 回写 and posts exactly once, with zero listing calls', async (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const task = insertImportedTask(db, 'wb-dedupe-happy-0001')

    let postCalls = 0
    let listCalls = 0
    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = requestUrl(input)
      const method = requestMethod(input, init)
      if (url !== COMMENT_COLLECTION_URL) throw new Error(`unexpected fetch to ${url}`)
      if (method === 'POST') {
        postCalls += 1
        return jsonResponse(201, { id: postCalls })
      }
      listCalls += 1
      return jsonResponse(200, [])
    })

    await attemptWriteback(db, task, '认领', null)

    assert.equal(postCalls, 1, 'expected exactly one comment POST for a successful write-back')
    assert.equal(listCalls, 0, 'a successful write-back must never call listIssueComments')
    assert.equal(
      successfulClaimWritebacks(db, task.publicId).length,
      1,
      'expected exactly one successful 回写 event for 认领',
    )
  })

  test('a DEFINITE failure (non-2xx response) never triggers a listing call, and the sweep reposts next tick exactly as today', async (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const task = insertImportedTask(db, 'wb-dedupe-definite-0002')

    let postCalls = 0
    let listCalls = 0
    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = requestUrl(input)
      const method = requestMethod(input, init)
      if (url !== COMMENT_COLLECTION_URL) throw new Error(`unexpected fetch to ${url}`)
      if (method === 'POST') {
        postCalls += 1
        // A real, status-bearing rejection: nothing was created forge-side.
        return jsonResponse(403, { message: 'Forbidden' })
      }
      listCalls += 1
      return jsonResponse(200, [])
    })

    await attemptWriteback(db, task, '认领', null)
    assert.equal(postCalls, 1)
    assert.equal(listCalls, 0, 'a definite (status-bearing) failure must not call listIssueComments')
    assert.equal(successfulClaimWritebacks(db, task.publicId).length, 0)

    seedClaimTransition(db, task.publicId)
    await retryPendingWritebacks(db)

    assert.equal(postCalls, 2, 'the sweep must repost on the next tick, exactly as before this issue')
    assert.equal(
      listCalls,
      0,
      'repeated definite failures must never call listIssueComments — this keeps the common-path rate-limit cost at zero',
    )
    assert.equal(successfulClaimWritebacks(db, task.publicId).length, 0)
  })

  test('an AMBIGUOUS failure (fetch rejects, no status) whose comment already landed forge-side is discovered via listIssueComments and recorded as successful WITHOUT a duplicate POST', async (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const task = insertImportedTask(db, 'wb-dedupe-ambiguous-0003')
    const marker = expectedClaimBody(task.publicId)

    // Decoys before and after the marker in the fake forge's own comment order — this store is
    // never sorted for the adapter's benefit, mirroring gitea's undocumented ordering.
    const store: string[] = ['无关评论：与本任务无关的手动留言']

    let postCalls = 0
    let listCalls = 0
    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = requestUrl(input)
      const method = requestMethod(input, init)
      if (url !== COMMENT_COLLECTION_URL) throw new Error(`unexpected fetch to ${url}`)
      if (method === 'POST') {
        postCalls += 1
        if (postCalls === 1) {
          // The defect scenario: the forge COMMITS the comment server-side, but the client's
          // fetch() call itself rejects (abort/timeout/network drop) — no status is ever read.
          const body = requestBodyText(input, init)
          assert.ok(typeof body === 'string' && body.length > 0, 'setup: POST must carry a JSON { body } field')
          store.push(body as string)
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        // Only reached if an implementation reposts instead of deduping — recorded as a real
        // second comment so the assertions below can catch it.
        store.push(requestBodyText(input, init) ?? '')
        return jsonResponse(201, { id: postCalls })
      }
      listCalls += 1
      return jsonResponse(200, store.map((body, i) => ({ id: i + 1, body })))
    })

    // The original claim-time attempt: forge commits, client observes only a rejection.
    await attemptWriteback(db, task, '认领', null)
    assert.equal(postCalls, 1, 'setup: exactly one POST attempt so far')

    // A second, unrelated decoy arrives on the real Issue between the ambiguous attempt and the
    // next retry tick — the marker must remain findable in the MIDDLE of the listing, not just at
    // whichever position a naive implementation might assume.
    store.push('另一条无关评论：稍后由其他人添加')
    assert.ok(store.includes(marker), 'setup: the fake forge did receive the marker body from the aborted POST')

    seedClaimTransition(db, task.publicId)
    await retryPendingWritebacks(db)

    assert.equal(
      postCalls,
      1,
      `write-back must never duplicate the comment once it was already committed forge-side, got ${postCalls} POSTs`,
    )
    assert.ok(
      listCalls >= 1,
      'resolving an ambiguous failure must consult listIssueComments at least once before ever reposting',
    )
    assert.equal(
      successfulClaimWritebacks(db, task.publicId).length,
      1,
      'once the existing comment is found, exactly one successful 回写 event must be recorded',
    )
    const writebackEvents = db.select().from(events).where(eq(events.type, WRITEBACK_EVENT)).all()
    assert.equal(
      JSON.stringify(writebackEvents).includes(INLINE_TOKEN),
      false,
      '回写 event must never contain the plaintext forge token',
    )
  })

  test('DEGRADATION: if listIssueComments itself fails or is unavailable while resolving an ambiguous failure, the tick is skipped — no blind repost, no lost write-back, it converges once listing recovers', async (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const task = insertImportedTask(db, 'wb-dedupe-degraded-0004')
    const marker = expectedClaimBody(task.publicId)

    const store: string[] = []
    let postCalls = 0
    let listCalls = 0
    let listingAvailable = false

    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = requestUrl(input)
      const method = requestMethod(input, init)
      if (url !== COMMENT_COLLECTION_URL) throw new Error(`unexpected fetch to ${url}`)
      if (method === 'POST') {
        postCalls += 1
        if (postCalls === 1) {
          const body = requestBodyText(input, init)
          store.push(body ?? '')
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        store.push(requestBodyText(input, init) ?? '')
        return jsonResponse(201, { id: postCalls })
      }
      listCalls += 1
      if (!listingAvailable) {
        return jsonResponse(503, { message: 'Service Unavailable' })
      }
      return jsonResponse(200, store.map((body, i) => ({ id: i + 1, body })))
    })

    // Original claim-time attempt: ambiguous (forge commits, client sees only a rejection).
    await attemptWriteback(db, task, '认领', null)
    assert.equal(postCalls, 1, 'setup: exactly one POST attempt so far')
    assert.ok(store.includes(marker), 'setup: the fake forge did receive the marker body')

    seedClaimTransition(db, task.publicId)

    // Tick N: listing is unavailable. Must not post blindly, must not fabricate success.
    await retryPendingWritebacks(db)
    assert.equal(
      postCalls,
      1,
      'when listIssueComments is unavailable, the tick must be skipped rather than reposting blindly (that would recreate the duplicate)',
    )
    assert.equal(
      successfulClaimWritebacks(db, task.publicId).length,
      0,
      'a degraded (failed) listing must not be treated as "not found" — the write-back stays pending, not lost, not falsely marked done',
    )

    // Tick N+1: listing recovers.
    listingAvailable = true
    await retryPendingWritebacks(db)

    assert.equal(
      postCalls,
      1,
      'once listing recovers and finds the existing comment, there must still be no repost',
    )
    assert.ok(listCalls >= 1, 'setup: at least one listing attempt must have occurred across the two ticks')
    assert.equal(
      successfulClaimWritebacks(db, task.publicId).length,
      1,
      'the write-back must converge to exactly one successful 回写 once listing recovers — "retry until success" is preserved',
    )
  })
})

function failedClaimWritebacks(db: ReturnType<typeof createDb>, publicId: string) {
  return db
    .select()
    .from(events)
    .where(eq(events.type, WRITEBACK_EVENT))
    .all()
    .filter((row) => {
      const details = JSON.parse(row.details) as Record<string, unknown>
      return details.task_id === publicId && details.transition === '认领' && details.ok === false
    })
}

const AMBIGUOUS_GATEWAY_STATUS_CODES = [502, 503, 504, 408, 429] as const
const STILL_DEFINITE_STATUS_CODES = [403, 404, 422] as const

describe('write-back failure classification: gateway/5xx and 408/429 must be AMBIGUOUS, not DEFINITE (issue #40 R1)', () => {
  for (const status of AMBIGUOUS_GATEWAY_STATUS_CODES) {
    test(`a ${status} response is AMBIGUOUS: the forge may have committed the comment behind a proxy/gateway, so a listing resolves it before any repost`, async (t) => {
      const db = createDb(':memory:')
      t.after(() => db.$client.close())
      const task = insertImportedTask(db, `wb-dedupe-gateway-${status}`)
      const marker = expectedClaimBody(task.publicId)
      const store: string[] = ['无关评论：与本任务无关的手动留言']

      let postCalls = 0
      let listCalls = 0
      t.mock.method(
        globalThis,
        'fetch',
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = requestUrl(input)
          const method = requestMethod(input, init)
          if (url !== COMMENT_COLLECTION_URL) throw new Error(`unexpected fetch to ${url}`)
          if (method === 'POST') {
            postCalls += 1
            if (postCalls === 1) {
              // A gateway/proxy in front of a self-hosted forge (or the origin itself for
              // 408/429) can answer with its OWN status AFTER the origin already committed the
              // comment. That must be resolved the same way a bare network failure already is —
              // never treated as "nothing was created".
              const body = requestBodyText(input, init)
              store.push(body ?? '')
              return jsonResponse(status, { message: `gateway ${status}` })
            }
            store.push(requestBodyText(input, init) ?? '')
            return jsonResponse(201, { id: postCalls })
          }
          listCalls += 1
          return jsonResponse(200, store.map((body, i) => ({ id: i + 1, body })))
        },
      )

      await attemptWriteback(db, task, '认领', null)
      assert.equal(postCalls, 1, 'setup: exactly one POST attempt so far')
      assert.ok(
        store.includes(marker),
        'setup: the fake forge did receive the marker body from the gateway-fronted POST',
      )

      // A decoy arrives before the next tick, kept in the middle of the eventual array so a
      // position-dependent scan can't pass by accident (same discipline as the ambiguous-fetch-
      // reject test above).
      store.push('另一条无关评论：稍后由其他人添加')

      seedClaimTransition(db, task.publicId)
      await retryPendingWritebacks(db)

      assert.equal(
        postCalls,
        1,
        `a ${status} response must be resolved via listIssueComments, not blindly reposted, got ${postCalls} POSTs`,
      )
      assert.ok(
        listCalls >= 1,
        `a ${status} response must be treated as AMBIGUOUS and trigger a listing before any repost decision`,
      )
      assert.equal(
        successfulClaimWritebacks(db, task.publicId).length,
        1,
        'once the existing comment is found, exactly one successful 回写 event must be recorded',
      )
    })
  }

  for (const status of STILL_DEFINITE_STATUS_CODES) {
    test(`a ${status} response remains DEFINITE: zero listing calls, the sweep reposts next tick exactly as today`, async (t) => {
      const db = createDb(':memory:')
      t.after(() => db.$client.close())
      const task = insertImportedTask(db, `wb-dedupe-definite-${status}`)

      let postCalls = 0
      let listCalls = 0
      t.mock.method(
        globalThis,
        'fetch',
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = requestUrl(input)
          const method = requestMethod(input, init)
          if (url !== COMMENT_COLLECTION_URL) throw new Error(`unexpected fetch to ${url}`)
          if (method === 'POST') {
            postCalls += 1
            // A real rejection from the forge API itself: nothing was created.
            return jsonResponse(status, { message: `forge ${status}` })
          }
          listCalls += 1
          return jsonResponse(200, [])
        },
      )

      await attemptWriteback(db, task, '认领', null)
      assert.equal(postCalls, 1)
      assert.equal(listCalls, 0, `a ${status} rejection from the forge API itself must not call listIssueComments`)
      assert.equal(successfulClaimWritebacks(db, task.publicId).length, 0)

      seedClaimTransition(db, task.publicId)
      await retryPendingWritebacks(db)

      assert.equal(postCalls, 2, 'the sweep must repost on the next tick, exactly as before this issue')
      assert.equal(listCalls, 0, `repeated ${status} failures must never call listIssueComments`)
      assert.equal(successfulClaimWritebacks(db, task.publicId).length, 0)
    })
  }
})

describe('write-back failure bookkeeping does not flood the audit timeline (issue #40 R3)', () => {
  test('an unbroken run of identical (DEFINITE) failures collapses to exactly one failed 回写 row, not one per tick', async (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const task = insertImportedTask(db, 'wb-dedupe-guard-definite-0010')

    t.mock.method(
      globalThis,
      'fetch',
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = requestUrl(input)
        const method = requestMethod(input, init)
        if (url !== COMMENT_COLLECTION_URL) throw new Error(`unexpected fetch to ${url}`)
        if (method === 'POST') return jsonResponse(403, { message: 'Forbidden' })
        return jsonResponse(200, [])
      },
    )

    await attemptWriteback(db, task, '认领', null)
    seedClaimTransition(db, task.publicId)
    await retryPendingWritebacks(db)
    await retryPendingWritebacks(db)
    await retryPendingWritebacks(db)

    assert.equal(
      failedClaimWritebacks(db, task.publicId).length,
      1,
      'an unbroken run of identical failures must write exactly one failed 回写 row, not one per tick',
    )
  })

  test('a change in failure classification (AMBIGUOUS -> DEFINITE) records a NEW failed 回写 row, not a collapsed one', async (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const task = insertImportedTask(db, 'wb-dedupe-guard-transition-0011')

    let postCalls = 0
    t.mock.method(
      globalThis,
      'fetch',
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = requestUrl(input)
        const method = requestMethod(input, init)
        if (url !== COMMENT_COLLECTION_URL) throw new Error(`unexpected fetch to ${url}`)
        if (method === 'POST') {
          postCalls += 1
          // Attempt 1: a bare network failure, no status at all, nothing committed (AMBIGUOUS).
          if (postCalls === 1) throw new TypeError('fetch failed')
          // Attempt 2 onward: a real rejection from the forge API itself (DEFINITE).
          return jsonResponse(403, { message: 'Forbidden' })
        }
        // Nothing was ever actually committed in this scenario, so a listing always comes back
        // empty and the retry correctly falls through to a real repost attempt.
        return jsonResponse(200, [])
      },
    )

    await attemptWriteback(db, task, '认领', null) // records ambiguous:true
    seedClaimTransition(db, task.publicId)
    await retryPendingWritebacks(db) // lists (not found) -> reposts -> 403 -> records ambiguous:false

    const failedRows = failedClaimWritebacks(db, task.publicId)
    assert.equal(
      failedRows.length,
      2,
      `a classification change (ambiguous -> definite) must record a new row rather than being collapsed, got ${failedRows.length}`,
    )
    const ambiguousFlags = failedRows
      .map((row) => (JSON.parse(row.details) as Record<string, unknown>).ambiguous)
      .sort()
    assert.deepEqual(
      ambiguousFlags,
      [false, true],
      `expected one ambiguous:true row and one ambiguous:false row, got ${JSON.stringify(ambiguousFlags)}`,
    )
  })

  // KNOWN, ACCEPTED LIMITATION (per review) — not asserted as prevented, only pinned as bounded by
  // transitions rather than unbounded: a forge that FLAPS (alternates outcome on every single
  // tick) still writes one row per tick here, because the guard only ever compares against the
  // immediately-preceding outcome. This documents that mechanism honestly.
  test('KNOWN LIMITATION: a forge that alternates outcome on every tick writes one row per transition (not capped below the tick count)', async (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const task = insertImportedTask(db, 'wb-dedupe-guard-flap-0012')

    let postCalls = 0
    t.mock.method(
      globalThis,
      'fetch',
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = requestUrl(input)
        const method = requestMethod(input, init)
        if (url !== COMMENT_COLLECTION_URL) throw new Error(`unexpected fetch to ${url}`)
        if (method === 'POST') {
          postCalls += 1
          // Alternates ambiguous / definite on every single POST attempt.
          if (postCalls % 2 === 1) throw new TypeError('fetch failed')
          return jsonResponse(403, { message: 'Forbidden' })
        }
        return jsonResponse(200, [])
      },
    )

    await attemptWriteback(db, task, '认领', null) // attempt 1: ambiguous
    seedClaimTransition(db, task.publicId)
    await retryPendingWritebacks(db) // attempt 2: definite (transition)
    await retryPendingWritebacks(db) // attempt 3: ambiguous (transition)
    await retryPendingWritebacks(db) // attempt 4: definite (transition)

    assert.equal(
      failedClaimWritebacks(db, task.publicId).length,
      4,
      'every tick alternates classification here, so every tick is a transition — expected one row per tick (4)',
    )
  })
})
