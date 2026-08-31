import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import * as z from 'zod'
import { addDeviceProofHook, sendDeviceUnauthorized } from './device-proof.ts'
import {
  CLONE_TOKEN_USAGE,
  type AgentPrincipal,
  type AgentServiceResult,
  claimTask,
  releaseTask,
  reportProgress,
  submitPr,
} from './claim.ts'
import type { AppDb } from './db.ts'
import { sweepExpiredLeases } from './leases.ts'
import { selectTask, selectTasks, taskBrief } from './tasks.ts'

type AuthHolder = { auth: AgentPrincipal }

type McpSession = {
  authHolder: AuthHolder
  transport: StreamableHTTPServerTransport
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null }
}

function methodNotAllowed(reply: FastifyReply) {
  return reply.code(405).send(jsonRpcError(-32000, 'Method not allowed.'))
}

function readSessionId(request: FastifyRequest): string | undefined {
  const raw = request.headers['mcp-session-id']
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

function toToolResult<T>(result: AgentServiceResult<T>): CallToolResult {
  const text = JSON.stringify(result.body)
  const structuredContent = result.body as Record<string, unknown>
  if (result.ok) {
    return { structuredContent, content: [{ type: 'text', text }] }
  }
  return { isError: true, structuredContent, content: [{ type: 'text', text }] }
}

function toolPayload(body: unknown): CallToolResult {
  return {
    structuredContent: body as Record<string, unknown>,
    content: [{ type: 'text', text: JSON.stringify(body) }],
  }
}

function listTasksTool(
  db: AppDb,
  filters: { status?: string; tags?: string; forge?: string },
): CallToolResult {
  sweepExpiredLeases(db)
  let briefs = selectTasks(db).map(taskBrief)
  const status = filters.status
  if (status !== undefined) {
    briefs = briefs.filter((brief) => brief.status === status)
  }
  const tag = filters.tags
  if (tag !== undefined) {
    briefs = briefs.filter((brief) => brief.tags.includes(tag))
  }
  const forge = filters.forge
  if (forge !== undefined) {
    briefs = briefs.filter((brief) => brief.repo.forge === forge)
  }
  return toolPayload({ tasks: briefs })
}

function getTaskBriefTool(db: AppDb, taskId: string): CallToolResult {
  sweepExpiredLeases(db)
  const row = selectTask(db, taskId)
  if (row == null) {
    return toToolResult({ ok: false, httpStatus: 404, body: { error: 'not_found' } })
  }
  return toolPayload(taskBrief(row))
}

// Issue #33 (default) → Issue #39 (required, scoped): the confirmed product line is that every
// successful claim_task on a task that carries an external forge Issue enters Kaola Workflow — there
// is no non-Workflow path for such a task — and once Workflow completes, submitting a PR/MR via
// submit_pr is default and required, not optional. An Agent connected to this MCP server needs no
// explicit instruction to run Kaola Workflow directly after a claim — that is still the default
// carrier — but it is no longer merely a default: Kaola Workflow must be started. Project Runner is
// used only when the user explicitly asks for it; there is no silent switch either way.
// Workflow/Runner availability is local, advisory evidence for the Agent's own judgment, never a
// version allowlist or a server-side hard gate on the Claim itself. This requirement presumes the
// claimed task actually has a forge Issue to target — Kaola Workflow itself refuses to start without
// one (measured no_target / claim_issue_numbers_invalid) — so an Agent that claims a task with no
// forge Issue is outside this contract's scope and cannot start Workflow for it.
const KAOLA_MCP_INSTRUCTIONS = `Kaola Tasks 路由与协调任务的认领和生命周期，不运行 Agent、Workflow 或 Runner。

默认路径（no explicit Runner request needed）：本约定覆盖来自外部 forge Issue、随任务携带该 Issue
凭证（source.issue_url）的任务——该 Issue 就是 Workflow 目标。对这类任务，认领任务成功后，当前
Agent 必须（required）直接（directly）启动并运行 Kaola Workflow 处理该任务——这是强制要求，不再
只是默认值（default）；只有当用户明确（explicit）请求使用 Kaola Project Runner 时，才切换到
Runner 承载；没有 explicit 请求就永远走 Workflow 直连，也绝不在两者之间静默切换。Kaola Workflow
完成后，Agent 必须（required）调用 submit_pr 提交 PR，这是默认且必须的收尾动作，不是可选建议。
若认领到的任务没有随附的 forge Issue（例如 native 任务），则不在本约定范围内：Kaola Workflow 本
身启动要求至少一个 Issue 编号（已实测 no_target / claim_issue_numbers_invalid 拒绝），因此无法为
其启动 Workflow。

兼容性只是证据，不是硬性关卡：Workflow 或 Runner 版本缺失、无法识别、或提供了新接口，都只是本地
advisory 观察，供 Agent 自行判断如何继续；没有一份"已知可用版本清单"逐条核对放行，也绝不会因为兼
容性原因拒绝一次 Claim。`

function createKaolaMcpServer(db: AppDb, authHolder: AuthHolder): McpServer {
  const server = new McpServer(
    { name: 'kaola-tasks', version: '0.0.0' },
    { instructions: KAOLA_MCP_INSTRUCTIONS },
  )

  server.registerTool(
    'list_tasks',
    {
      description:
        'List Kaola task briefs. Optional filters: status (exact, e.g. 待认领 for claimable work), tags (membership of one tag), forge (exact repo.forge). Never includes a forge token.',
      inputSchema: {
        status: z.string().optional(),
        tags: z.string().optional(),
        forge: z.string().optional(),
      },
    },
    async (args) => listTasksTool(db, args),
  )

  server.registerTool(
    'get_task_brief',
    {
      description: 'Get a single task brief by public task_id. Never includes a forge token.',
      inputSchema: { task_id: z.string() },
    },
    async (args) => getTaskBriefTool(db, args.task_id),
  )

  server.registerTool(
    'claim_task',
    {
      description: `Claim a task and receive its reusable stored repository credential (not minted per claim). ${CLONE_TOKEN_USAGE} Release and lease expiry revoke only Kaola Tasks' own lifecycle authority and Claim fencing — never the forge token itself. When the human instructed this claim, omit autonomous. Set autonomous: true when the Agent discovered and initiated this claim itself (not on human instruction) — an untrusted user may then need to confirm it in the web UI before a token is issued. Optional request_id makes retries of the same claim attempt idempotent: replaying the same (device, request_id) returns the same claim_id and credential instead of erroring.`,
      inputSchema: { task_id: z.string(), autonomous: z.boolean().optional(), request_id: z.string().optional() },
    },
    async (args) => toToolResult(await claimTask(db, authHolder.auth, args.task_id, args.autonomous, args.request_id)),
  )

  server.registerTool(
    'report_progress',
    {
      description:
        'Heartbeat on a claimed task. Optional note; omit to record an empty note. claim_id is required for a Claim minted with request_id, optional for a legacy Claim.',
      inputSchema: {
        task_id: z.string(),
        note: z.string().optional(),
        claim_id: z.string().optional(),
      },
    },
    async (args) => toToolResult(reportProgress(db, authHolder.auth, args.task_id, args.note, args.claim_id)),
  )

  server.registerTool(
    'release_task',
    {
      description:
        'Release a claimed task back to 待认领. Optional reason is recorded only when provided. claim_id is required for a Claim minted with request_id, optional for a legacy Claim; repeating release for an already-released Claim is idempotent.',
      inputSchema: {
        task_id: z.string(),
        reason: z.string().optional(),
        claim_id: z.string().optional(),
      },
    },
    async (args) => toToolResult(releaseTask(db, authHolder.auth, args.task_id, args.reason, args.claim_id)),
  )

  server.registerTool(
    'submit_pr',
    {
      description:
        'The required completion of the Workflow path: after Kaola Workflow finishes and a PR or MR exists on the forge, submit its URL for a claimed in-progress task and move it to 待验收. claim_id is required for a Claim minted with request_id, optional for a legacy Claim; repeating submit_pr for the same Claim and pr_url is idempotent.',
      inputSchema: {
        task_id: z.string(),
        pr_url: z.string(),
        summary: z.string(),
        claim_id: z.string().optional(),
      },
    },
    async (args) =>
      toToolResult(await submitPr(db, authHolder.auth, args.task_id, args.pr_url, args.summary, args.claim_id)),
  )

  return server
}

async function handleMcpPost(
  db: AppDb,
  sessions: Map<string, McpSession>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.deviceAuth
  if (auth == null) {
    sendDeviceUnauthorized(reply)
    return
  }

  const sessionId = readSessionId(request)
  if (sessionId != null) {
    const session = sessions.get(sessionId)
    if (session == null) {
      reply.code(404).send(jsonRpcError(-32001, 'Session not found'))
      return
    }
    session.authHolder.auth = auth
    reply.hijack()
    try {
      await session.transport.handleRequest(request.raw, reply.raw, request.body)
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' })
        reply.raw.end(JSON.stringify(jsonRpcError(-32603, 'Internal server error')))
      }
    }
    return
  }

  if (!isInitializeRequest(request.body)) {
    reply.code(400).send(jsonRpcError(-32000, 'Bad Request: No valid session ID provided'))
    return
  }

  const authHolder: AuthHolder = { auth }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid) => {
      sessions.set(sid, { authHolder, transport })
    },
  })
  transport.onclose = () => {
    const sid = transport.sessionId
    if (sid != null) sessions.delete(sid)
  }
  const server = createKaolaMcpServer(db, authHolder)
  await server.connect(transport)

  reply.hijack()
  try {
    await transport.handleRequest(request.raw, reply.raw, request.body)
  } catch {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { 'content-type': 'application/json' })
      reply.raw.end(JSON.stringify(jsonRpcError(-32603, 'Internal server error')))
    }
  }
}

export function registerMcp(app: FastifyInstance, db: AppDb) {
  app.register(async function mcpDeviceContext(child) {
    addDeviceProofHook(child, db)

    const sessions = new Map<string, McpSession>()
    child.addHook('onClose', async () => {
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.all(open.map((session) => session.transport.close()))
    })

    child.post('/api/mcp', async (request, reply) => {
      await handleMcpPost(db, sessions, request, reply)
    })
    child.get('/api/mcp', async (_request, reply) => methodNotAllowed(reply))
    child.delete('/api/mcp', async (_request, reply) => methodNotAllowed(reply))
  })
}
