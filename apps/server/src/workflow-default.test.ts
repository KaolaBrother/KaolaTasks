import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTaskBrief } from '@kaola/shared'
import { applyOauthTestEnv } from './auth.test-helpers.ts'
import { injectSigned, pairDeviceToSelf } from './device-proof.test-helpers.ts'

// Issue #33 — Make direct Kaola Workflow the default MCP Agent path.
//
// TEST CUSTODY ONLY. This suite owns acceptance meaning for:
//   (A/B) a NEW pure module apps/server/src/workflow-target.ts (does not exist yet at RED time),
//   (C)   the real MCP surface text (initialize `instructions`, tools/list schema+descriptions),
//   (D)   a NEW client-guidance doc this Issue must add (docs/workflow-default.md, path chosen
//         and bound here — see the final reply for rationale),
//   (E)   a token scan over this suite's own fixtures and that doc.
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
// WorkflowTarget shape owned here — the implementer must match these field names exactly:
//
//   type WorkflowAdvisory = {
//     reason: string             // measured refusal reason (never assumed)
//     workflow_version: string   // measured Kaola Workflow snapshot version
//     workflow_commit: string    // measured Kaola Workflow snapshot commit
//   }
//
//   type WorkflowTarget =
//     | { target_kind: 'issue'; available: true; issue_url: string;
//         project_name: null; advisory: null }
//     | { target_kind: 'issueless_project'; available: false; issue_url: null;
//         project_name: string; advisory: WorkflowAdvisory }
//
//   export function workflowTargetForTask(brief: TaskBrief): WorkflowTarget   // pure, no I/O
//
// Measured Kaola Workflow snapshot the advisory must cite (Issue #33 brief, read-only measurement
// against /Volumes/WorkspaceA/ylminiserver/workspace/kaola-workflow): version '10.2.1', commit
// '7e93763e'. VERDICT: NOT SUPPORTED — cmdStartup refuses with `no_target` absent
// --target-issue/--target-issues, so the advisory.reason must name that measured refusal rather
// than assume issue-less-project support or fabricate an issue-<N> project name.
//
// Ambiguities resolved here (not pinned upstream), documented rather than silently assumed:
//   (1) exact WorkflowTarget field names — fixed above; this suite is the sole owner of that shape.
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

const GITHUB_BASE_URL = 'https://github.com'
const GITLAB_BASE_URL = 'https://gitlab.example.test'
const GITEA_BASE_URL = 'https://gitea.example.test'

const WORKFLOW_MEASURED_VERSION = '10.2.1'
const WORKFLOW_MEASURED_COMMIT = '7e93763e'

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

function assertSerializable(value: unknown) {
  const roundTripped = JSON.parse(JSON.stringify(value))
  assert.deepEqual(
    roundTripped,
    value,
    'WorkflowTarget must be plain-JSON-serializable (a JSON round-trip must be lossless: no functions, no undefined, no class instances)',
  )
}

// --- Section B fixtures: imported and native briefs across all three forges, one of which
// (gitlab) uses a subgroup namespace in repo.full_name. ---------------------------------------

type SourceInput = { type: 'native' } | { type: 'imported'; issue_url: string }
type RepoInput = { forge: 'github' | 'gitlab' | 'gitea'; base_url: string; full_name: string }

function buildBrief({
  id,
  source,
  repo,
}: {
  id: string
  source: SourceInput
  repo: RepoInput
}) {
  const brief = {
    id,
    title: `fixture task ${id}`,
    description_md: '……（fixture）',
    source,
    repo: {
      forge: repo.forge,
      base_url: repo.base_url,
      full_name: repo.full_name,
      base_branch: 'main',
      suggested_dir: repo.full_name.split('/').at(-1) ?? repo.full_name,
    },
    acceptance_criteria: ['fixture acceptance criterion'],
    test_command: 'pnpm test',
    constraints: { allowed_paths: [], forbidden_paths: [] },
    pr_convention: { branch_prefix: `kaola/${id}-`, title_prefix: `[${id}] ` },
    // Never a real credential: the brief's own union only ever names a reference.
    credential: { inline: true as const },
    priority: 'P2' as const,
    tags: ['fixture'],
    poster: 'fixture-poster',
    status: '待认领' as const,
    created_at: new Date(Date.UTC(2026, 7, 31, 0, 0, 0)).toISOString(),
  }
  // Guards the fixture itself against a typo, not the module under test.
  parseTaskBrief(brief)
  return brief
}

const FIXTURES = [
  {
    label: 'github imported',
    brief: buildBrief({
      id: 'kt-2026-0101',
      source: { type: 'imported', issue_url: 'https://github.com/octo/widget/issues/42' },
      repo: { forge: 'github', base_url: GITHUB_BASE_URL, full_name: 'octo/widget' },
    }),
  },
  {
    label: 'github native',
    brief: buildBrief({
      id: 'kt-2026-0102',
      source: { type: 'native' },
      repo: { forge: 'github', base_url: GITHUB_BASE_URL, full_name: 'octo/widget' },
    }),
  },
  {
    label: 'gitlab subgroup-namespace imported',
    brief: buildBrief({
      id: 'kt-2026-0201',
      source: {
        type: 'imported',
        issue_url: `${GITLAB_BASE_URL}/team/backend/payments/-/issues/7`,
      },
      repo: { forge: 'gitlab', base_url: GITLAB_BASE_URL, full_name: 'team/backend/payments' },
    }),
  },
  {
    label: 'gitlab subgroup-namespace native',
    brief: buildBrief({
      id: 'kt-2026-0202',
      source: { type: 'native' },
      repo: { forge: 'gitlab', base_url: GITLAB_BASE_URL, full_name: 'team/backend/payments' },
    }),
  },
  {
    label: 'gitea imported',
    brief: buildBrief({
      id: 'kt-2026-0301',
      source: { type: 'imported', issue_url: `${GITEA_BASE_URL}/team/orders/issues/3` },
      repo: { forge: 'gitea', base_url: GITEA_BASE_URL, full_name: 'team/orders' },
    }),
  },
  {
    label: 'gitea native',
    brief: buildBrief({
      id: 'kt-2026-0302',
      source: { type: 'native' },
      repo: { forge: 'gitea', base_url: GITEA_BASE_URL, full_name: 'team/orders' },
    }),
  },
]

async function loadWorkflowTarget() {
  // Dynamic, per-test import (rather than a static top-level import) so a missing production
  // module fails each Section A/B test individually with its own clear "Cannot find module"
  // signal, instead of aborting the entire file (which would mask Section C/D/E's independent,
  // differently-caused RED failures behind one module-resolution error).
  return import('./workflow-target.ts')
}

describe('Issue #33 workflow-target.ts — pure Workflow-target mapping (no I/O)', () => {
  test('apps/server/src/workflow-target.ts must exist and export workflowTargetForTask as a function', async () => {
    const mod = await loadWorkflowTarget()
    assert.equal(
      typeof (mod as { workflowTargetForTask?: unknown }).workflowTargetForTask,
      'function',
      'workflow-target.ts must export a workflowTargetForTask(brief) function',
    )
  })

  for (const fixture of FIXTURES.filter((f) => f.brief.source.type === 'imported')) {
    test(`${fixture.label}: an imported Task's existing issue_url becomes an available Workflow target, never contains a token, and is JSON-serializable`, async () => {
      const { workflowTargetForTask } = await loadWorkflowTarget()
      const target = workflowTargetForTask(fixture.brief)
      assert.equal(target.target_kind, 'issue', `expected target_kind 'issue', got ${JSON.stringify(target)}`)
      assert.equal(target.available, true, `an imported Task's target must be marked available: ${JSON.stringify(target)}`)
      assert.equal(
        target.issue_url,
        (fixture.brief.source as { issue_url: string }).issue_url,
        'the Workflow target must name the Task brief\'s own existing issue_url, not a derived or fabricated one',
      )
      assert.equal(target.project_name, null)
      assert.equal(target.advisory, null, 'an available issue target must carry no advisory-unavailable observation')
      assertSerializable(target)
      assertNoTokenShapedText(JSON.stringify(target), `${fixture.label} WorkflowTarget`)
    })
  }

  for (const fixture of FIXTURES.filter((f) => f.brief.source.type === 'native')) {
    test(`${fixture.label}: a native Task gets an issue-less project named from the Task id, marked advisory-unavailable with the measured reason and Workflow snapshot identity`, async () => {
      const { workflowTargetForTask } = await loadWorkflowTarget()
      const target = workflowTargetForTask(fixture.brief)
      assert.equal(
        target.target_kind,
        'issueless_project',
        `expected target_kind 'issueless_project', got ${JSON.stringify(target)}`,
      )
      assert.equal(target.available, false, `a native Task's target must be marked unavailable, not thrown: ${JSON.stringify(target)}`)
      assert.equal(target.issue_url, null)
      assert.equal(
        target.project_name,
        fixture.brief.id,
        'the intended (unavailable) Workflow project name must be the Task\'s own public id',
      )
      assert.ok(target.advisory, 'an unavailable target must carry an advisory observation, not silently omit one')
      assert.match(
        target.advisory.reason,
        /no_target/i,
        `advisory.reason must name the measured cmdStartup 'no_target' refusal rather than assume issue-less-project support: ${target.advisory.reason}`,
      )
      assert.equal(
        target.advisory.workflow_version,
        WORKFLOW_MEASURED_VERSION,
        'advisory must cite the exact measured Kaola Workflow version, not a placeholder',
      )
      assert.equal(
        target.advisory.workflow_commit,
        WORKFLOW_MEASURED_COMMIT,
        'advisory must cite the exact measured Kaola Workflow commit, not a placeholder',
      )
      assertSerializable(target)
      assertNoTokenShapedText(JSON.stringify(target), `${fixture.label} WorkflowTarget`)
    })
  }

  test('workflowTargetForTask performs zero forge calls and therefore creates no forge Issue, for every imported/native fixture across github, gitlab (subgroup namespace) and gitea', async (t) => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (...args: unknown[]) => {
      calls += 1
      throw new Error(
        `workflowTargetForTask must never call fetch (no forge calls, no forge Issue creation); got a call: ${JSON.stringify(args[0])}`,
      )
    }) as typeof fetch
    t.after(() => {
      globalThis.fetch = originalFetch
    })

    const { workflowTargetForTask } = await loadWorkflowTarget()
    for (const fixture of FIXTURES) {
      workflowTargetForTask(fixture.brief)
    }
    assert.equal(
      calls,
      0,
      `workflowTargetForTask must make zero forge calls across all fixtures; observed ${calls} fetch call(s)`,
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

  test('docs/workflow-default.md must document the measured issue-less-project fallback, citing the measured reason and snapshot identity rather than assuming support', () => {
    const text = readFileSync(WORKFLOW_DEFAULT_DOC_PATH, 'utf8')
    assert.match(text, /issue-less|issueless/i, 'must name the issue-less-project fallback')
    assert.match(text, new RegExp(WORKFLOW_MEASURED_VERSION.replace(/\./g, '\\.')), 'must cite the measured Kaola Workflow version')
    assert.match(text, new RegExp(WORKFLOW_MEASURED_COMMIT, 'i'), 'must cite the measured Kaola Workflow commit')
    assert.match(
      text,
      /no_target|not supported/i,
      'must record the measured refusal reason, not an assumed capability',
    )
  })

  test('docs/workflow-default.md contains no token-shaped text', () => {
    const text = readFileSync(WORKFLOW_DEFAULT_DOC_PATH, 'utf8')
    assertNoTokenShapedText(text, 'docs/workflow-default.md')
  })
})

// --- Section E: token scan over this suite's own fixtures ----------------------------------------

describe('Issue #33 token scan — fixtures this suite adds carry no token-shaped material', () => {
  test('every workflow-target fixture brief (imported/native across github, gitlab-subgroup, gitea) is token-free', () => {
    for (const fixture of FIXTURES) {
      assertNoTokenShapedText(JSON.stringify(fixture.brief), `fixture brief "${fixture.label}"`)
    }
  })

  test('every computed WorkflowTarget for those fixtures is token-free', async () => {
    const { workflowTargetForTask } = await loadWorkflowTarget()
    for (const fixture of FIXTURES) {
      const target = workflowTargetForTask(fixture.brief)
      assertNoTokenShapedText(JSON.stringify(target), `WorkflowTarget for "${fixture.label}"`)
    }
  })
})
