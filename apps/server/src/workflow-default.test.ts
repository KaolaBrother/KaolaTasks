import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyOauthTestEnv } from './auth.test-helpers.ts'
import { injectSigned, pairDeviceToSelf } from './device-proof.test-helpers.ts'

// Issue #33 — Make direct Kaola Workflow the default MCP Agent path.
//
// TEST CUSTODY ONLY. This suite owns acceptance meaning for:
//   (A/B) [RETIRED BY #39 — these describe blocks are gone; the suite now asserts
//         apps/server/src/workflow-target.ts must NOT exist],
//   (C)   the real MCP surface text (initialize `instructions`, tools/list schema+descriptions),
//   (D)   a NEW client-guidance doc this Issue must add (docs/workflow-default.md, path chosen
//         and bound here — see the final reply for rationale),
//   (E)   [RETIRED BY #39 — the fixtures it scanned were deleted with A/B; the doc and the live
//         instructions are still token-scanned by the surviving cases].
// No production code is written by this file.
//
// RED baseline: commit 6df018a5e55749aa85de1642eedfb76f5df7504f ("feat(mcp): persist secret-free
// Claim recovery receipts in kaola-mcp (#32)"). At that commit, measured directly:
//   - apps/server/src/workflow-target.ts does not exist (no export at all);
//   - apps/server/src/mcp.ts constructs `new McpServer({ name: 'kaola-tasks', version: '0.0.0' })`
//     with no `instructions` option, so `initialize` never returns `result.instructions`;
//   - claim_task's registered description reads "Claim a task and receive a one-shot forge
//     token. ..." (contains "one-shot", omits the corrected repository-credential wording);
//   - docs/workflow-default.md does not exist.
// (Verified live against this commit with a throwaway probe script hitting POST /api/mcp
// initialize + tools/list before writing this suite — see the reply for the raw JSON.)
//
// >>> RETIRED BY ISSUE #39 — DO NOT IMPLEMENT ANY OF THE FOLLOWING. <<<
// #33 originally specified here a pure module `apps/server/src/workflow-target.ts` exporting
// `workflowTargetForTask(brief)`, returning either a `target_kind: 'issue'` target or a
// `target_kind: 'issueless_project'` / `available: false` target carrying an advisory that cited a
// measured Kaola Workflow snapshot (10.2.1 / 7e93763e) refusing an issue-less project with
// `no_target`. That measurement was accurate at the time and #33 implemented it faithfully — but it
// modeled a "claim succeeded, yet has no Workflow target" outcome. Issue #39 confirmed the product
// line requires every successful claim to uniformly enter Workflow, so that outcome must not be
// modeled anywhere: `workflow-target.ts` is DELETED (Issue #39 measured it as a zero-production-
// caller module — 16 grep hits total, 15 of them the tests removed here, the 16th its own
// definition — whose only real effect was the `mcp.ts` prose it fed), and this file's sole
// surviving A/B-adjacent test (in the describe block below) asserts the module does NOT exist,
// rather than continuing to pin the shape of a retired contract. This paragraph is kept purely as a
// record of what was retired and why; it is history, not a specification, and nothing in it may be
// built. The former Section E's fixture-based token scans are retired alongside it for the same
// reason (nothing left to scan) — the Issue #39 tests below instead scan the real, non-fixture
// instructions/description/doc text they read, so that invariant stays covered.
//
// Ambiguities resolved here (not pinned upstream), documented rather than silently assumed:
//   (1) [RETIRED BY #39 — this suite no longer owns any WorkflowTarget shape; the module is gone.]
//   (2) doc path — fixed to docs/workflow-default.md.
//   (3) "no version allowlist" / "never refused for a capability reason" is asserted (i) textually,
//       via keywords in the real `instructions` string, and (ii) structurally, by asserting no
//       tool's inputSchema gains any capability/version/carrier-shaped property — the six-tool
//       contract has no field through which a version could be submitted to be allowlisted against,
//       so a live "claim refused by capability" scenario cannot be driven through the public
//       surface at all. A full claim_task success flow (forge stub, task creation, device pairing)
//       is intentionally NOT duplicated here — apps/server/src/mcp.test.ts already independently
//       proves claim_task succeeds with no capability-shaped argument.
//   (4) the MCP SDK's own per-tool `execution: { taskSupport: 'forbidden' }` metadata (sibling of
//       `inputSchema`, already present today, unrelated to Issue #33) is deliberately NOT treated
//       as an "execution/carrier field" — the brief's ban is on the tool's *input* schema, i.e. the
//       parameters an Agent can submit, not this pre-existing SDK task-support declaration.
//
// -------------------------------------------------------------------------------------------------
// Issue #39 amendment — the confirmed product line changed after #33 shipped: external forge Issue
// + its token -> Claim MCP -> Workflow MUST be started for every successful claim (no non-Workflow
// path) -> submitting a PR after Workflow completes is default AND required. #33's contract above
// only ever said Workflow is the *default* (never required), and never required PR submission after
// Workflow completes. Sections C and D below gain new Issue #39 tests for both of those (rather than
// being replaced) since their existing #33 acceptance — the default-Workflow prose, the six-tool/no-
// new-field contract, claim_task's #30 wording — is still true and still owned here. Section D's one
// test that used to cite the retired `issueless_project` fallback (measured Workflow version/commit)
// is replaced below by a test pinning the new "no unavailable target" requirement instead. Two new
// describe blocks are added for surfaces this suite did not previously read: docs/architecture.md's
// #33 paragraph (which duplicated the same retired claim) and docs/DESIGN.md §15 (the frozen product
// boundary this whole Claim MCP contract stems from).
// -------------------------------------------------------------------------------------------------

const MCP_PATH = '/api/mcp'
const MCP_PROTOCOL_VERSION = '2025-11-25'
const TOOL_NAMES = ['list_tasks', 'get_task_brief', 'claim_task', 'report_progress', 'release_task', 'submit_pr']
const FORBIDDEN_INPUT_FIELDS = [
  'carrier',
  'runner',
  'runner_name',
  'runtime',
  'execution',
  'execution_mode',
  'capability',
  'workflow_capability',
  'workflow_version',
  'runner_version',
  'allowlist',
]

// Deliberately narrow, prefix-anchored shapes for the well-known forge/agent-key token families
// this codebase actually issues (see SECRET_KEY_NAMES / CLONE_TOKEN_USAGE in mcp.test.ts) — broad
// enough to catch a pasted-in real-looking credential, narrow enough not to false-positive on an
// unrelated 8-char measured commit prefix like '7e93763e' or ordinary prose.
const TOKEN_SHAPE_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub PAT-shaped
  /glpat-[A-Za-z0-9_-]{20,}/, // GitLab PAT-shaped
  /ktk_[0-9a-f]{20,}/i, // Kaola agent-key-shaped
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/, // an embedded bearer credential
]

function assertNoTokenShapedText(text: string, label: string) {
  for (const pattern of TOKEN_SHAPE_PATTERNS) {
    assert.equal(
      pattern.test(text),
      false,
      `${label} contains token-shaped text matching ${pattern}: a fixture/doc must never carry credential-shaped material`,
    )
  }
}

// Issue #39 helper: true only if some single sentence (Chinese/English mixed prose, split on the
// full-width period 。 or an ASCII '. ' followed by a capital/Chinese char) matches every pattern in
// `patterns`. Sentence-scoped rather than whole-text-scoped so a requirement word and its subject
// (e.g. "Workflow" and "必须") must genuinely co-occur in one statement, not merely appear anywhere
// independently in a long document.
function assertSentenceContainsAll(text: string, patterns: RegExp[], label: string, message: string) {
  const sentences = text.split(/(?<=。)|(?<=\.)\s+(?=[A-Z一-鿿])/)
  const found = sentences.some((sentence) => patterns.every((pattern) => pattern.test(sentence)))
  assert.ok(found, `${label}: ${message}`)
}

// Issue #39 A3 fix: assertSentenceContainsAll's split only breaks after an ASCII '.' when the
// following word starts with an uppercase Latin letter or a CJK character (see its own comment,
// above). submit_pr's English description has no 。 at all, and its only '. ' boundary is followed
// by lowercase "claim_id" — so that regex never splits it, the whole description collapses into one
// "sentence", and the unrelated, separate clause "claim_id is required for a Claim minted with
// request_id" is enough on its own to supply the requirement word. The assertion built on
// assertSentenceContainsAll therefore never actually verifies that Workflow and the requirement word
// occur in the SAME clause — a description that mentions Workflow anywhere, with "required" showing
// up in an unrelated clause elsewhere, would pass it too. This narrower helper is scoped to the A3
// test only (assertSentenceContainsAll and every other call site, including the A2 Chinese-prose
// tests above, are untouched): it splits on ANY '.' or '。' sentence boundary regardless of the case
// of the following letter, so an unrelated later (or earlier) clause can no longer supply the
// requirement word or the Workflow mention for a clause that lacks it.
function assertClauseContainsAll(text: string, patterns: RegExp[], label: string, message: string) {
  const clauses = text.split(/(?<=[.。])\s*/)
  const found = clauses.some((clause) => patterns.every((pattern) => pattern.test(clause)))
  assert.ok(found, `${label}: ${message}`)
}

async function loadWorkflowTarget() {
  // Dynamic import (rather than a static top-level one) so a missing module fails this one test
  // with its own clear "Cannot find module" signal, instead of aborting the entire file and masking
  // Section C/D's independent, differently-caused RED failures behind one module-resolution error.
  return import('./workflow-target.ts')
}

describe('Issue #39 A4 — the Claim MCP contract no longer models "claim succeeded but no Workflow target"', () => {
  test('apps/server/src/workflow-target.ts must no longer exist: its issueless_project/available:false model is a retired contract, not dead code left in place', async () => {
    await assert.rejects(
      () => loadWorkflowTarget(),
      (err: unknown) => {
        const message = String((err as { message?: unknown })?.message ?? err)
        assert.match(
          message,
          /Cannot find module|ERR_MODULE_NOT_FOUND/i,
          `expected a module-not-found rejection once workflow-target.ts is deleted, got: ${message}`,
        )
        return true
      },
      'workflow-target.ts must be deleted (Issue #39): the confirmed product line requires every ' +
        'successful claim to enter Workflow, so a mapping whose native-task branch reports the ' +
        'Workflow target unavailable now asserts a false contract, and the module already has zero ' +
        'production callers',
    )
  })
})

// --- Section C: the real MCP surface text -------------------------------------------------------

applyOauthTestEnv()
const { buildApp } = await import('./app.ts')

async function bootApp(t: import('node:test').TestContext) {
  const app = buildApp()
  t.after(async () => {
    await app.close()
  })
  await app.ready()
  return app
}

function mcpHeaders(sessionId?: string) {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  }
  if (sessionId != null) headers['mcp-session-id'] = sessionId
  return headers
}

async function postMcpSigned(
  app: Awaited<ReturnType<typeof bootApp>>,
  identity: Parameters<typeof injectSigned>[1],
  { sessionId, payload }: { sessionId?: string; payload: unknown },
) {
  return injectSigned(app, identity, {
    method: 'POST',
    url: MCP_PATH,
    payload,
    extraHeaders: mcpHeaders(sessionId),
  })
}

function parseSseMessages(body: string) {
  const messages: Array<{ id?: unknown; result?: unknown; error?: unknown }> = []
  const chunks = String(body).split(/\r?\n\r?\n/)
  for (const chunk of chunks) {
    if (!chunk.trim()) continue
    let eventName = 'message'
    const dataParts: string[] = []
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataParts.push(line.slice('data:'.length).replace(/^\s/, ''))
    }
    if (eventName === 'message' && dataParts.length > 0) {
      messages.push(JSON.parse(dataParts.join('\n')))
    }
  }
  return messages
}

function parseJsonRpcHttp(res: { headers: Record<string, unknown>; body: unknown; statusCode: number }) {
  const contentType = String(res.headers['content-type'] ?? '')
  const body = String(res.body ?? '')
  if (contentType.includes('text/event-stream') || /^\s*event:/m.test(body) || /^\s*data:/m.test(body)) {
    const messages = parseSseMessages(body)
    assert.ok(messages.length > 0, `expected SSE event: message JSON-RPC payloads, status ${res.statusCode}: ${body}`)
    return messages
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    assert.fail(`MCP response was not JSON or SSE (status ${res.statusCode}): ${body}`)
  }
  return Array.isArray(parsed) ? parsed : [parsed]
}

function jsonRpcById(messages: Array<{ id?: unknown }>, id: number) {
  const hit = messages.find((message) => message && message.id === id)
  assert.ok(hit, `no JSON-RPC message with id ${id}: ${JSON.stringify(messages)}`)
  return hit as { id?: unknown; result?: Record<string, unknown>; error?: unknown }
}

async function initializeMcpSession(app: Awaited<ReturnType<typeof bootApp>>, identity: Parameters<typeof injectSigned>[1]) {
  const res = await postMcpSigned(app, identity, {
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'kaola-workflow-default-test', version: '0.0.0' },
      },
    },
  })
  assert.equal(res.statusCode, 200, `MCP initialize HTTP: ${res.statusCode} ${res.body}`)
  const rpc = jsonRpcById(parseJsonRpcHttp(res), 1)
  assert.equal(rpc.error, undefined, `MCP initialize JSON-RPC error: ${JSON.stringify(rpc.error)}`)
  const headerSessionId = res.headers['mcp-session-id']
  const sessionId = headerSessionId != null && headerSessionId !== '' ? String(headerSessionId) : undefined
  if (sessionId != null) {
    await postMcpSigned(app, identity, {
      sessionId,
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    })
  }
  return { rpc, sessionId }
}

async function listMcpTools(app: Awaited<ReturnType<typeof bootApp>>, identity: Parameters<typeof injectSigned>[1], sessionId?: string) {
  const res = await postMcpSigned(app, identity, {
    sessionId,
    payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  })
  assert.equal(res.statusCode, 200, `tools/list HTTP: ${res.statusCode} ${res.body}`)
  const rpc = jsonRpcById(parseJsonRpcHttp(res), 2)
  assert.equal(rpc.error, undefined, `tools/list JSON-RPC error: ${JSON.stringify(rpc.error)}`)
  const tools = rpc.result?.tools
  assert.ok(Array.isArray(tools), `tools/list result.tools must be an array: ${JSON.stringify(rpc.result)}`)
  return tools as Array<{ name: string; description: string; inputSchema?: { properties?: Record<string, unknown> } }>
}

describe('Issue #33 MCP contract text — initialize instructions and tool surface', () => {
  test('initialize result.instructions states the subtraction-first default: no explicit Runner request means the current Agent runs Kaola Workflow directly', async (t) => {
    const app = await bootApp(t)
    const { identity } = await pairDeviceToSelf(app, undefined, { hostname: 'contract-instructions' })
    const { rpc } = await initializeMcpSession(app, identity)
    const instructions = rpc.result?.instructions
    assert.equal(
      typeof instructions,
      'string',
      `initialize result must carry a non-empty string "instructions" field: ${JSON.stringify(rpc.result)}`,
    )
    assert.ok((instructions as string).length > 0, 'instructions must not be an empty string')
    // Keyword-only: the implementer keeps prose freedom. These four concepts are load-bearing:
    // Workflow, an explicit ask is required for Runner, and the default runs directly.
    assert.match(instructions as string, /Workflow/i, `instructions must mention Workflow: ${instructions}`)
    assert.match(instructions as string, /Runner/i, `instructions must mention Runner: ${instructions}`)
    assert.match(
      instructions as string,
      /explicit/i,
      `instructions must state Runner is used only on explicit request: ${instructions}`,
    )
    assert.match(
      instructions as string,
      /directly|default/i,
      `instructions must state the direct-Workflow default: ${instructions}`,
    )
  })

  test('initialize instructions state a missing/unrecognized Workflow capability is advisory evidence for Agent judgment, not a hard gate', async (t) => {
    const app = await bootApp(t)
    const { identity } = await pairDeviceToSelf(app, undefined, { hostname: 'contract-advisory' })
    const { rpc } = await initializeMcpSession(app, identity)
    const instructions = String(rpc.result?.instructions ?? '')
    assert.match(
      instructions,
      /advisory/i,
      `instructions must state Workflow/Runner capability observations are advisory: ${instructions}`,
    )
    assert.doesNotMatch(
      instructions,
      /allowlist/i,
      `instructions must not describe a version allowlist that gates a Claim: ${instructions}`,
    )
  })

  test('tools/list still returns exactly six tools; none gains a carrier/runner/execution/capability-shaped input field', async (t) => {
    const app = await bootApp(t)
    const { identity } = await pairDeviceToSelf(app, undefined, { hostname: 'contract-tools-list' })
    const { sessionId } = await initializeMcpSession(app, identity)
    const tools = await listMcpTools(app, identity, sessionId)

    assert.equal(tools.length, 6, `expected exactly six tools, got ${tools.length}: ${tools.map((tool) => tool.name).join(', ')}`)
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort(),
      `tools/list must name exactly the existing six tools, no seventh: ${JSON.stringify(tools.map((tool) => tool.name))}`,
    )
    for (const tool of tools) {
      const fieldNames = Object.keys(tool.inputSchema?.properties ?? {})
      for (const forbidden of FORBIDDEN_INPUT_FIELDS) {
        assert.equal(
          fieldNames.includes(forbidden),
          false,
          `${tool.name} inputSchema must not gain a "${forbidden}" field (no execution-mode/carrier/capability surface was added): ${JSON.stringify(fieldNames)}`,
        )
      }
    }
  })

  test('claim_task description drops "one-shot"/一次性 wording and instead names a repository credential whose lease-expiry revocation never touches the forge token itself', async (t) => {
    const app = await bootApp(t)
    const { identity } = await pairDeviceToSelf(app, undefined, { hostname: 'contract-claim-description' })
    const { sessionId } = await initializeMcpSession(app, identity)
    const tools = await listMcpTools(app, identity, sessionId)
    const claim = tools.find((tool) => tool.name === 'claim_task')
    assert.ok(claim, 'claim_task tool must be registered')
    const description = (claim as { description: string }).description

    assert.equal(
      /one-shot/i.test(description),
      false,
      `claim_task description must drop the misleading "one-shot" wording (Issue #30 correction): ${description}`,
    )
    assert.equal(
      description.includes('一次性'),
      false,
      `claim_task description must drop the misleading 一次性 wording (Issue #30 correction): ${description}`,
    )
    // Keyword-only: the implementer keeps prose freedom. The load-bearing concepts are: a
    // *repository* credential (not a one-shot/lease-scoped mint) is revealed, and revocation
    // scope is Kaola Tasks' own lease/lifecycle authority, not the forge token itself.
    assert.match(
      description,
      /repository credential|repo credential/i,
      `claim_task description must name a repository credential: ${description}`,
    )
    assert.match(description, /lease/i, `claim_task description must mention lease expiry: ${description}`)
    assert.match(description, /revoke/i, `claim_task description must describe what revocation scope means: ${description}`)
  })

  // --- Issue #39 A2: the real initialize instructions must state Workflow is REQUIRED after a
  // successful claim_task (not merely the #33 default), and that submitting a PR once Workflow
  // completes is required. Baseline (measured live against this commit before these two tests were
  // added): the instructions text contains no 必须/required/must at all, and no mention of PR or
  // submit_pr whatsoever — so both tests below fail on missing content, not on wrong wording. ---

  test('Issue #39 A2: initialize result.instructions states Workflow is REQUIRED after a successful claim, not merely the default', async (t) => {
    const app = await bootApp(t)
    const { identity } = await pairDeviceToSelf(app, undefined, { hostname: 'contract-workflow-required' })
    const { rpc } = await initializeMcpSession(app, identity)
    const instructions = String(rpc.result?.instructions ?? '')
    assertNoTokenShapedText(instructions, 'initialize instructions')
    // Keyword-only, sentence-scoped so the implementer keeps prose freedom: some sentence must pair
    // a requirement word (必须/required/must) with Workflow, not merely mention each independently.
    assertSentenceContainsAll(
      instructions,
      [/Workflow/i, /(必须|\brequired\b|\bmust\b)/i],
      'initialize instructions',
      `must state, in one sentence, that Kaola Workflow is REQUIRED (必须/required/must) after a successful claim_task — not only that it is the default: ${instructions}`,
    )
  })

  test('Issue #39 A2: initialize result.instructions states submitting a PR after Workflow completes is default AND required', async (t) => {
    const app = await bootApp(t)
    const { identity } = await pairDeviceToSelf(app, undefined, { hostname: 'contract-pr-required' })
    const { rpc } = await initializeMcpSession(app, identity)
    const instructions = String(rpc.result?.instructions ?? '')
    assertNoTokenShapedText(instructions, 'initialize instructions')
    assertSentenceContainsAll(
      instructions,
      [/PR|submit_pr/i, /(必须|\brequired\b|\bmust\b)/i],
      'initialize instructions',
      `must state, in one sentence, that submitting a PR after Workflow completes is required (必须/required/must), not merely a suggested next step: ${instructions}`,
    )
  })

  // --- Issue #39 A3: submit_pr's own registered tool description must state it is the required
  // completion of the Workflow path. This must NOT change submit_pr's input schema (still asserted,
  // unchanged, by the six-tools/no-new-field test above) and must NOT change the six-tool count.
  // Baseline: submit_pr's description never mentions Workflow at all today, so this fails on missing
  // content — not a false-positive collision with its unrelated existing "claim_id is required for
  // a Claim minted with request_id" wording, which never mentions Workflow either. ---

  test('Issue #39 A3: submit_pr tool description states it is the required completion of the Workflow path', async (t) => {
    const app = await bootApp(t)
    const { identity } = await pairDeviceToSelf(app, undefined, { hostname: 'contract-submit-pr-required' })
    const { sessionId } = await initializeMcpSession(app, identity)
    const tools = await listMcpTools(app, identity, sessionId)
    assert.equal(tools.length, 6, `expected exactly six tools, got ${tools.length}: ${tools.map((tool) => tool.name).join(', ')}`)

    const submitPr = tools.find((tool) => tool.name === 'submit_pr')
    assert.ok(submitPr, 'submit_pr tool must still be registered')
    const description = (submitPr as { description: string }).description
    assertNoTokenShapedText(description, 'submit_pr description')
    // assertClauseContainsAll, not assertSentenceContainsAll: this description has no 。 and its
    // only '. ' boundary is followed by lowercase "claim_id", so assertSentenceContainsAll's
    // capital/CJK-gated split never fires and the whole description collapses into one "sentence" —
    // letting the unrelated "claim_id is required for a Claim minted with request_id" clause supply
    // the requirement word for an entirely separate Workflow mention. assertClauseContainsAll splits
    // on every '.'/'。' boundary regardless of case, so Workflow and the requirement word must
    // genuinely co-occur in the same clause.
    assertClauseContainsAll(
      description,
      [/Workflow/i, /(必须|\brequired\b|\bmust\b)/i],
      'submit_pr description',
      `must state, in one clause, that submitting the PR is the required completion of the Workflow path — today it never mentions Workflow at all: ${description}`,
    )
  })
})

// --- Section D: client guidance doc --------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const WORKFLOW_DEFAULT_DOC_PATH = join(repoRoot, 'docs', 'workflow-default.md')

describe('Issue #33 docs/workflow-default.md — client guidance the implementer must add', () => {
  test('docs/workflow-default.md must exist and state the Workflow-direct default (Runner only on explicit request)', () => {
    const text = readFileSync(WORKFLOW_DEFAULT_DOC_PATH, 'utf8')
    assert.match(text, /Workflow/i)
    assert.match(text, /default/i)
    assert.match(text, /explicit/i, 'must state Runner is used only on explicit user request')
  })

  test('docs/workflow-default.md must document compensation before durable work exists, preservation after work exists, and forward-only behavior after PR creation', () => {
    const text = readFileSync(WORKFLOW_DEFAULT_DOC_PATH, 'utf8')
    assert.match(text, /compensat/i, 'must mention compensation before durable work exists')
    assert.match(text, /preserv/i, 'must mention preservation once durable work exists')
    assert.match(text, /forward-only/i, 'must state forward-only recovery after PR/MR creation')
  })

  // Issue #39 A4 replaces this suite's former "measured issue-less-project fallback" assertion
  // (which pinned exactly the `available: false`/no-target model Issue #39 retires — see the header
  // comment and the Issue #39 A4 describe block above). The doc must instead state the corrected
  // product line: no successful claim ever lacks a Workflow target. Baseline: the doc's own current
  // "Workflow 目标映射" section still states the opposite for a native task (`available: false`,
  // `issueless_project`, "not supported"), so this fails on wrong content, not missing content.
  test('Issue #39 A4: docs/workflow-default.md no longer models a claim succeeding with an unavailable/no Workflow target', () => {
    const text = readFileSync(WORKFLOW_DEFAULT_DOC_PATH, 'utf8')
    assert.doesNotMatch(
      text,
      /issueless_project/,
      'must not name the retired issueless_project target_kind',
    )
    assert.doesNotMatch(
      text,
      /available:\s*false/,
      'must not document any Workflow target as available: false — every successful claim now gets one',
    )
    assert.doesNotMatch(
      text,
      /advisory-unavailable/i,
      'must not describe a Workflow target as advisory-unavailable',
    )
    assertSentenceContainsAll(
      text,
      [/(每|所有).*?(成功|通过).*?(claim|认领)|claim_task.*?(成功)/i, /Workflow/i, /(必须|\brequired\b|\bmust\b)/i],
      'docs/workflow-default.md',
      'must state that Workflow is required for every successful claim, with no issue-less exception',
    )
  })

  test('docs/workflow-default.md contains no token-shaped text', () => {
    const text = readFileSync(WORKFLOW_DEFAULT_DOC_PATH, 'utf8')
    assertNoTokenShapedText(text, 'docs/workflow-default.md')
  })
})

// Issue #33's former Section E ("token scan over this suite's own fixtures") is removed along with
// the FIXTURES it scanned — see the Issue #39 amendment in this file's header comment for why that
// is a deliberate contract retirement, not a coverage gap: the new Issue #39 tests above already
// call assertNoTokenShapedText on the real (non-fixture) instructions/description/doc text they
// read, so the "no token in a Claim MCP contract surface" invariant stays covered.

// --- Section F: docs/architecture.md must not duplicate the retired "no Workflow target" model ---

const ARCHITECTURE_DOC_PATH = join(repoRoot, 'docs', 'architecture.md')

describe('Issue #39 A4 — docs/architecture.md no longer duplicates the retired "claim succeeded but no Workflow target" model', () => {
  test('docs/architecture.md no longer describes a native-task Workflow target as an unavailable/issueless_project fallback', () => {
    const text = readFileSync(ARCHITECTURE_DOC_PATH, 'utf8')
    assert.doesNotMatch(text, /issueless_project/, 'must not name the retired issueless_project target_kind')
    assert.doesNotMatch(
      text,
      /available:\s*false/,
      'must not document any Workflow target as available: false — every successful claim now gets one',
    )
    assert.doesNotMatch(
      text,
      /advisory-unavailable/i,
      'must not describe a Workflow target as advisory-unavailable',
    )
  })
})

// --- Section G: docs/DESIGN.md §15 — Workflow is required, PR submission is required (Issue #39 A1) --

const DESIGN_DOC_PATH = join(repoRoot, 'docs', 'DESIGN.md')

// §15 ("Claim 执行兼容层（规划）") is the last numbered section in DESIGN.md at RED time, so slicing
// from its heading to end-of-file captures the whole section without depending on a §16 that may or
// may not exist by the time this is read again.
function readDesignSection15(): string {
  const text = readFileSync(DESIGN_DOC_PATH, 'utf8')
  const heading = /^## 15\.\s/m
  const match = heading.exec(text)
  assert.ok(match, 'docs/DESIGN.md must still contain a "## 15." section (Claim 执行兼容层)')
  return text.slice(match!.index)
}

describe('Issue #39 A1 — docs/DESIGN.md §15 states Workflow is required (not merely default) and PR submission after completion is required', () => {
  // Baseline (measured live against this commit): §15 only ever says claim_task 成功后"默认"由当前
  // MCP Agent 直接运行 Kaola Workflow (docs/DESIGN.md:356) — 必须/required/must appears nowhere in
  // the section, and the section never mentions PR/MR at all. Both tests below therefore fail on
  // missing content, not on wrong wording.
  test('§15 states claim_task success REQUIRES the current Agent to start Kaola Workflow, not merely defaults to it', () => {
    const section = readDesignSection15()
    assertNoTokenShapedText(section, 'docs/DESIGN.md §15')
    assertSentenceContainsAll(
      section,
      [/claim_task/, /(必须|\brequired\b|\bmust\b)/i, /Kaola Workflow/],
      'docs/DESIGN.md §15',
      `must state, in one sentence, that a successful claim_task REQUIRES the current Agent to run Kaola Workflow — today it only says 默认 (default): ${section}`,
    )
  })

  test('§15 states submitting a PR after Workflow completes is default AND required, not optional', () => {
    const section = readDesignSection15()
    assertSentenceContainsAll(
      section,
      [/Workflow/, /(完成|complet)/i, /PR|MR/, /(必须|\brequired\b|\bmust\b)/i],
      'docs/DESIGN.md §15',
      `must state, in one sentence, that submitting a PR/MR once Workflow completes is required — today §15 never mentions PR/MR at all: ${section}`,
    )
  })
})
