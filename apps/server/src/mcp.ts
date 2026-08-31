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

// Issue #33: the subtraction-first default. An Agent connected to this MCP server needs no
// explicit instruction to run Kaola Workflow directly after a claim — that is the default carrier.
// Project Runner is used only when the user explicitly asks for it; there is no silent switch
// either way. Workflow/Runner availability is local, advisory evidence for the Agent's own
// judgment, never a version allowlist or a server-side hard gate on the Claim itself.
const KAOLA_MCP_INSTRUCTIONS = `Kaola Tasks 路由与协调任务的认领和生命周期，不运行 Agent、Workflow 或 Runner。

默认路径（no explicit Runner request needed）：认领任务后，当前 Agent 直接（directly）运行 Kaola
Workflow 处理该任务；这是减法优先的默认值（default），不需要任何额外声明。只有当用户明确（explicit）
请求使用 Kaola Project Runner 时，才切换到 Runner 承载；没有 explicit 请求就永远走 Workflow 直连，
也绝不在两者之间静默切换。

Workflow 目标映射：imported 任务（source.type === 'imported'，且 issue_url 非空）使用该任务已有的
issue_url 作为 Workflow 目标；native 任务没有已有 Issue，Kaola Tasks 从不代为在 forge 上新建一个
Issue 去凑合。已实测（Kaola Workflow 10.2.1，commit 7e93763e）：cmdStartup 在没有
--target-issue/--target-issues 时以 no_target 拒绝，即 issue-less 项目当前不受支持，因此 native 任
务只得到一个 advisory-unavailable 的 issueless_project 目标（project_name 取任务 id），而不是假设
它可行或伪造一个 issue-<N> 项目名。

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
        'After a PR or MR exists on the forge, submit its URL for a claimed in-progress task and move it to 待验收. claim_id is required for a Claim minted with request_id, optional for a legacy Claim; repeating submit_pr for the same Claim and pr_url is idempotent.',
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
