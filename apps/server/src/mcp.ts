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

function createKaolaMcpServer(db: AppDb, authHolder: AuthHolder): McpServer {
  const server = new McpServer({ name: 'kaola-tasks', version: '0.0.0' })

  server.registerTool(
    'list_tasks',
    {
      description:
        'List task briefs. Optional filters: status (exact), tags (membership of one tag), forge (exact repo.forge).',
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
      description: `Claim a task and receive a one-shot forge token. ${CLONE_TOKEN_USAGE} Set autonomous: true when the Agent discovered and initiated this claim itself (not on human instruction) — an untrusted user may then need to confirm it in the web UI before a token is issued.`,
      inputSchema: { task_id: z.string(), autonomous: z.boolean().optional() },
    },
    async (args) => toToolResult(await claimTask(db, authHolder.auth, args.task_id, args.autonomous)),
  )

  server.registerTool(
    'report_progress',
    {
      description: 'Heartbeat on a claimed task. Optional note; omit to record an empty note.',
      inputSchema: {
        task_id: z.string(),
        note: z.string().optional(),
      },
    },
    async (args) => toToolResult(reportProgress(db, authHolder.auth, args.task_id, args.note)),
  )

  server.registerTool(
    'release_task',
    {
      description: 'Release a claimed task back to 待认领. Optional reason is recorded only when provided.',
      inputSchema: {
        task_id: z.string(),
        reason: z.string().optional(),
      },
    },
    async (args) => toToolResult(releaseTask(db, authHolder.auth, args.task_id, args.reason)),
  )

  server.registerTool(
    'submit_pr',
    {
      description: 'Submit a PR for a claimed in-progress task and move it to 待验收.',
      inputSchema: {
        task_id: z.string(),
        pr_url: z.string(),
        summary: z.string(),
      },
    },
    async (args) =>
      toToolResult(await submitPr(db, authHolder.auth, args.task_id, args.pr_url, args.summary)),
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
