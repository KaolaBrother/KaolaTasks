// Oracle for the 任务评审面板 in App.vue and for the anchor parser in review-anchor.ts (#53).
//
// Contract read from docs/DESIGN.md §17 and docs/api.md「Review loop REST」:
//   GET  /api/v1/tasks/:publicId/review              → { task_id, status, pr_url, head_sha,
//                                                        round, rounds, messages, current }
//   POST /api/v1/tasks/:publicId/review/messages     → { body_md, kind, anchor? }
//   POST /api/v1/tasks/:publicId/review/rounds       → 「提交本轮意见」（待验收）
//   POST /api/v1/tasks/:publicId/review/approve      → 「通过」（待验收 → 待合并）
//   POST /api/v1/tasks/:publicId/review/withdraw     → 「撤回通过」（待合并 → 待修改）
//   POST /api/v1/tasks/:publicId/review/terminate    → 「终止本次交付」（→ 已退回）
//
// The fetch stub, the mount helper and the DOM seam helpers are the ones from
// App.board.test.ts — same router keyed on `${METHOD} ${url}`, same「unrouted call answers 500
// { error: 'unstubbed' }」rule, so an unexpected outbound request can never pass silently.
// 待认领 / 进行中 must not call the review route at all: 面板只写「尚未提交 PR，暂无评审」.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import naive, { NSelect } from 'naive-ui'
import { nextTick } from 'vue'
import App from './App.vue'
import { parseAnchorLink } from './review-anchor'

// --- fixtures ------------------------------------------------------------------------------

const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const PR_URL = `${FORGE_BASE_URL}/team/orders/pulls/7`
const HEAD_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const ANCHOR_URL = `${FORGE_BASE_URL}/team/orders/src/commit/${HEAD_SHA}/src/export.ts#L42`

const ME_FULL = {
  id: 7,
  provider: 'gitlab',
  remote_id: '7',
  username: 'zhang.wei',
  display_name: '张伟',
  status: 'active',
  permission_level: 'full',
}
const ME_CLAIM_ONLY = { ...ME_FULL, provider: 'github', permission_level: 'claim_only' }

type Brief = {
  id: string
  title: string
  description_md: string
  source: { type: 'native' } | { type: 'imported'; issue_url: string }
  repo: {
    forge: 'github' | 'gitlab' | 'gitea'
    base_url: string
    full_name: string
    base_branch: string
    suggested_dir: string
  }
  acceptance_criteria: string[]
  test_command: string
  constraints: { allowed_paths: string[]; forbidden_paths: string[] }
  pr_convention: { branch_prefix: string; title_prefix: string; draft: boolean }
  credential: { profile_id: string } | { inline: true }
  priority: string
  tags: string[]
  poster: string
  status: string
  created_at: string
  parent_task_id: string | null
  review_round: number
}

function makeBrief(overrides: { id: string } & Partial<Omit<Brief, 'id'>>): Brief {
  const { id, ...rest } = overrides
  return {
    id,
    title: '为订单导出接口增加分页',
    description_md: '',
    source: { type: 'native' },
    repo: {
      forge: 'gitea',
      base_url: FORGE_BASE_URL,
      full_name: 'team/orders',
      base_branch: 'main',
      suggested_dir: 'orders',
    },
    acceptance_criteria: [],
    test_command: '',
    constraints: { allowed_paths: [], forbidden_paths: [] },
    pr_convention: { branch_prefix: `kaola/${id}-`, title_prefix: `[${id}] `, draft: true },
    credential: { profile_id: '3' },
    priority: 'P2',
    tags: [],
    poster: 'zhang.wei',
    status: '待认领',
    created_at: '2026-08-21T08:00:00Z',
    parent_task_id: null,
    review_round: 0,
    ...rest,
  }
}

const TASK_OPEN = makeBrief({ id: 'kt-2026-0200', title: '还没有 PR 的任务', status: '待认领' })
const TASK_REVIEWING = makeBrief({
  id: 'kt-2026-0201',
  title: '等评审者判定的导出接口',
  status: '待验收',
  review_round: 2,
})
const TASK_MERGING = makeBrief({
  id: 'kt-2026-0202',
  title: '等 forge 合并的导出接口',
  status: '待合并',
  review_round: 3,
})
const TASK_REVISING = makeBrief({
  id: 'kt-2026-0203',
  title: '球在 Agent 手里的导出接口',
  status: '待修改',
  review_round: 2,
  parent_task_id: 'kt-2026-0200',
})

const REVIEW_TASKS = [TASK_OPEN, TASK_REVIEWING, TASK_MERGING, TASK_REVISING]

const BLOCKING_MESSAGE = {
  id: 11,
  round: 1,
  author_kind: 'reviewer',
  author: 'zhang.wei',
  kind: 'blocking',
  body_md: 'per_page 没有上限，必须夹到 100。',
  anchor: { path: 'src/export.ts', line: 42, head_sha: HEAD_SHA, url: ANCHOR_URL },
  reply_to: null,
  resolves: null,
  resolved: true,
  created_at: '2026-08-22T02:00:00Z',
}
const AGENT_MESSAGE = {
  id: 12,
  round: 1,
  author_kind: 'agent',
  author: 'kaola-agent',
  kind: 'resolution',
  body_md: '已夹到 100，并补了一条测试。',
  anchor: null,
  reply_to: 11,
  resolves: 11,
  resolved: false,
  created_at: '2026-08-22T03:00:00Z',
}
const SYSTEM_MESSAGE = {
  id: 13,
  round: 2,
  author_kind: 'system',
  author: null,
  kind: 'note',
  body_md: '父任务已完成，基线分支已更新。',
  anchor: null,
  reply_to: null,
  resolves: null,
  resolved: false,
  created_at: '2026-08-22T04:00:00Z',
}
const DRAFT_MESSAGE = {
  id: 14,
  round: null,
  author_kind: 'reviewer',
  author: 'zhang.wei',
  kind: 'suggestion',
  body_md: '顺手把导出列的顺序固定下来。',
  anchor: null,
  reply_to: null,
  resolves: null,
  resolved: false,
  created_at: '2026-08-22T05:00:00Z',
}

function reviewBody(overrides: Record<string, unknown> = {}) {
  return {
    task_id: TASK_REVIEWING.id,
    status: '待验收',
    pr_url: PR_URL,
    head_sha: HEAD_SHA,
    round: 2,
    rounds: [
      {
        round: 1,
        kind: 'review',
        verdict: 'changes_requested',
        opened_by: 'zhang.wei',
        opened_by_task_id: null,
        opened_at: '2026-08-22T02:10:00Z',
        revised_at: '2026-08-22T03:30:00Z',
        revision_head_sha: HEAD_SHA,
      },
      {
        round: 2,
        kind: 'review',
        verdict: null,
        opened_by: 'zhang.wei',
        opened_by_task_id: null,
        opened_at: '2026-08-22T04:10:00Z',
        revised_at: null,
        revision_head_sha: null,
      },
    ],
    messages: [BLOCKING_MESSAGE, AGENT_MESSAGE, SYSTEM_MESSAGE, DRAFT_MESSAGE],
    current: {
      task_id: TASK_REVIEWING.id,
      pr_url: PR_URL,
      round: 2,
      kind: 'review',
      head_sha: HEAD_SHA,
      base_branch: 'main',
      verdict: null,
      blocking: [],
      non_blocking: [DRAFT_MESSAGE],
      thread: [DRAFT_MESSAGE],
      source_trust: 'internal',
    },
    ...overrides,
  }
}

// --- fetch stub ----------------------------------------------------------------------------

type FetchCall = {
  url: string
  method: string
  headers: Record<string, string>
  credentials: string | undefined
  body: unknown
}
type Handler = () => Response

const realFetch = globalThis.fetch
const realConfirm = globalThis.confirm

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (init == null) return out
  if (init instanceof Headers) {
    init.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
    return out
  }
  const entries = Array.isArray(init) ? init : Object.entries(init)
  for (const [key, value] of entries) out[String(key).toLowerCase()] = String(value)
  return out
}

function installFetch() {
  const calls: FetchCall[] = []
  const routes = new Map<string, Handler>()
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    calls.push({
      url,
      method,
      headers: normalizeHeaders(init?.headers),
      credentials: init?.credentials,
      body,
    })
    const handler = routes.get(`${method} ${url}`)
    if (handler == null) return jsonResponse(500, { error: 'unstubbed', method, url })
    return handler()
  }
  globalThis.fetch = stub as unknown as typeof globalThis.fetch
  return { calls, routes }
}

afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.confirm = realConfirm
  vi.restoreAllMocks()
})

async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await flushPromises()
    await nextTick()
  }
}

// --- mount helper --------------------------------------------------------------------------

async function mountBoard(me: Record<string, unknown> = ME_FULL, tasks: Brief[] = REVIEW_TASKS) {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/setup', () => jsonResponse(200, { setup_complete: true }))
  routes.set('GET /api/v1/me', () => jsonResponse(200, me))
  routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles: [] }))
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks }))
  routes.set('GET /api/v1/events', () => jsonResponse(200, { events: [] }))
  routes.set('GET /api/v1/stats', () =>
    jsonResponse(200, { completed_count: 0, completed_by_username: {} }),
  )
  routes.set('GET /api/v1/me/devices', () => jsonResponse(200, { devices: [] }))
  routes.set('GET /api/v1/devices/pending', () => jsonResponse(200, { devices: [] }))
  routes.set('GET /api/v1/claimants', () => jsonResponse(200, { claimants: [] }))

  const wrapper = mount(App, { global: { plugins: [naive] } })
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/me')).toBe(true)
  })
  await settle()
  await vi.waitFor(() => {
    expect(wrapper.find('[data-testid="board"]').exists()).toBe(true)
  })
  return { wrapper, calls, routes }
}

function stubReview(routes: Map<string, Handler>, id: string, body: unknown, status = 200) {
  routes.set(`GET /api/v1/tasks/${id}/review`, () => jsonResponse(status, body))
}

// --- DOM seam helpers ----------------------------------------------------------------------

function node(wrapper: VueWrapper, testid: string) {
  return wrapper.find(`[data-testid="${testid}"]`)
}

function textOf(wrapper: VueWrapper, testid: string): string {
  const found = node(wrapper, testid)
  if (!found.exists()) throw new Error(`missing [data-testid="${testid}"]`)
  return found.text()
}

function fieldElement(wrapper: VueWrapper, testid: string) {
  const found = wrapper.findAll(
    `[data-testid="${testid}"] input, [data-testid="${testid}"] textarea`,
  )
  if (found.length === 0) throw new Error(`no input/textarea under [data-testid="${testid}"]`)
  return found[0]
}

async function setField(wrapper: VueWrapper, testid: string, value: string) {
  await fieldElement(wrapper, testid).setValue(value)
  await settle()
}

function selectOf(wrapper: VueWrapper, testid: string) {
  const found = wrapper
    .findAllComponents(NSelect)
    .find((candidate) => candidate.attributes('data-testid') === testid)
  if (found == null) throw new Error(`no n-select with data-testid="${testid}"`)
  return found
}

async function openDetail(wrapper: VueWrapper, id: string) {
  const found = node(wrapper, `board-card-${id}`)
  if (!found.exists()) throw new Error(`missing [data-testid="board-card-${id}"]`)
  await found.trigger('click')
  await settle()
}

async function click(wrapper: VueWrapper, testid: string) {
  const found = node(wrapper, testid)
  if (!found.exists()) throw new Error(`missing [data-testid="${testid}"]`)
  await found.trigger('click')
  await settle()
}

function reviewGets(calls: FetchCall[], id: string): FetchCall[] {
  return calls.filter(
    (call) => call.method === 'GET' && call.url === `/api/v1/tasks/${id}/review`,
  )
}

function reviewPosts(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.method === 'POST' && call.url.includes('/review'))
}

function groupOrder(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('[data-testid^="review-group-"]')
    .map((group) => group.attributes('data-testid') ?? '')
}

// =============================================================================================

describe('评审面板 — 何时加载（#53）', () => {
  it('待认领 / 进行中 只写「尚未提交 PR，暂无评审」，一次 GET …/review 都不发', async () => {
    const { wrapper, calls } = await mountBoard()
    await openDetail(wrapper, TASK_OPEN.id)

    expect(node(wrapper, 'review-panel').exists()).toBe(true)
    expect(textOf(wrapper, 'review-empty')).toContain('尚未提交 PR，暂无评审')
    expect(node(wrapper, 'review-header').exists()).toBe(false)
    expect(node(wrapper, 'review-composer').exists()).toBe(false)
    expect(reviewGets(calls, TASK_OPEN.id)).toHaveLength(0)
    expect(calls.filter((call) => call.url.includes('/review'))).toHaveLength(0)
  })

  it('待验收打开详情就拉一次 GET …/review，带 credentials 与 Accept', async () => {
    const { wrapper, calls, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())

    await openDetail(wrapper, TASK_REVIEWING.id)

    const gets = reviewGets(calls, TASK_REVIEWING.id)
    expect(gets).toHaveLength(1)
    expect(gets[0].url).toBe(`/api/v1/tasks/${TASK_REVIEWING.id}/review`)
    expect(gets[0].credentials).toBe('include')
    expect(gets[0].headers.accept).toBe('application/json')
    expect(node(wrapper, 'review-empty').exists()).toBe(false)
  })
})

describe('评审面板 — 头部与线程（#53）', () => {
  it('头部给出 PR 链接、head_sha 前 12 位、第 N 轮与球在谁手里', async () => {
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    await openDetail(wrapper, TASK_REVIEWING.id)

    const link = node(wrapper, 'review-pr-url').find('a')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe(PR_URL)
    expect(link.attributes('target')).toBe('_blank')

    expect(textOf(wrapper, 'review-head-sha')).toBe('abcdef123456')
    expect(node(wrapper, 'review-head-sha').find('code').exists()).toBe(true)
    expect(textOf(wrapper, 'review-round')).toContain('第 2 轮')
    expect(textOf(wrapper, 'review-ball')).toContain('评审者')
  })

  it('球在谁手里跟着状态走：待合并等 forge 合并，待修改是 Agent', async () => {
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_MERGING.id, reviewBody({ task_id: TASK_MERGING.id, status: '待合并' }))
    stubReview(
      routes,
      TASK_REVISING.id,
      reviewBody({ task_id: TASK_REVISING.id, status: '待修改' }),
    )

    await openDetail(wrapper, TASK_MERGING.id)
    expect(textOf(wrapper, 'review-ball')).toContain('等 forge 合并')

    await openDetail(wrapper, TASK_REVISING.id)
    expect(textOf(wrapper, 'review-ball')).toContain('Agent')
  })

  it('消息按轮次分组，未归轮的「本轮草稿（未提交）」排在最后', async () => {
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    await openDetail(wrapper, TASK_REVIEWING.id)

    expect(groupOrder(wrapper)).toEqual([
      'review-group-2',
      'review-group-1',
      'review-group-draft',
    ])
    expect(textOf(wrapper, 'review-group-1')).toContain('第 1 轮')
    expect(textOf(wrapper, 'review-group-1')).toContain('需修改')
    expect(textOf(wrapper, 'review-group-draft')).toContain('本轮草稿（未提交）')

    expect(node(wrapper, 'review-group-1').find('[data-testid="review-message-11"]').exists()).toBe(
      true,
    )
    expect(node(wrapper, 'review-group-2').find('[data-testid="review-message-13"]').exists()).toBe(
      true,
    )
    expect(
      node(wrapper, 'review-group-draft').find('[data-testid="review-message-14"]').exists(),
    ).toBe(true)
  })

  it('每条消息带作者与 kind 徽章、纯文本正文、已解决标记与 path:line 锚点链接', async () => {
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    await openDetail(wrapper, TASK_REVIEWING.id)

    const blocking = textOf(wrapper, 'review-message-11')
    expect(blocking).toContain('评审者')
    expect(blocking).toContain('阻塞')
    expect(blocking).toContain('已解决')
    expect(blocking).toContain(BLOCKING_MESSAGE.body_md)

    const anchor = node(wrapper, 'review-anchor-11').find('a')
    expect(anchor.exists()).toBe(true)
    expect(anchor.text()).toBe('src/export.ts:42')
    expect(anchor.attributes('href')).toBe(ANCHOR_URL)

    const agent = textOf(wrapper, 'review-message-12')
    expect(agent).toContain('Agent')
    expect(node(wrapper, 'review-anchor-12').exists()).toBe(false)

    expect(textOf(wrapper, 'review-message-13')).toContain('系统')
    expect(textOf(wrapper, 'review-message-13')).toContain('备注')
  })

  it('body_md 里的标签按文本渲染，不长出节点', async () => {
    const XSS_MESSAGE = {
      ...DRAFT_MESSAGE,
      id: 21,
      body_md: '<img src=x onerror=alert(1)>',
      anchor: { path: '', url: 'javascript:alert(1)' },
    }
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody({ messages: [XSS_MESSAGE] }))
    await openDetail(wrapper, TASK_REVIEWING.id)

    expect(textOf(wrapper, 'review-message-21')).toContain('<img src=x onerror=alert(1)>')
    expect(node(wrapper, 'review-message-21').find('img').exists()).toBe(false)
    expect(node(wrapper, 'review-anchor-21').find('a').exists()).toBe(false)
    expect(textOf(wrapper, 'review-anchor-21')).toContain('javascript:alert(1)')
  })
})

describe('评审面板 — 四个动作按钮（#53）', () => {
  it('待验收：提交本轮意见 / 通过 / 终止本次交付各打一条对应的 POST', async () => {
    const { wrapper, calls, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/rounds`, () =>
      jsonResponse(201, { task: { ...TASK_REVIEWING, status: '待修改' }, round: { round: 3 } }),
    )
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/approve`, () =>
      jsonResponse(200, { task: { ...TASK_REVIEWING, status: '待合并' }, round: { round: 3 } }),
    )
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/terminate`, () =>
      jsonResponse(200, { task: { ...TASK_REVIEWING, status: '已退回' }, round: { round: 3 } }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)

    expect(textOf(wrapper, 'review-submit-round')).toContain('提交本轮意见')
    expect(textOf(wrapper, 'review-approve')).toContain('通过')
    expect(textOf(wrapper, 'review-terminate')).toContain('终止本次交付')
    expect(node(wrapper, 'review-withdraw').exists()).toBe(false)

    await click(wrapper, 'review-submit-round')
    expect(reviewPosts(calls).map((call) => call.url)).toEqual([
      `/api/v1/tasks/${TASK_REVIEWING.id}/review/rounds`,
    ])
    const round = reviewPosts(calls)[0]
    expect(round.credentials).toBe('include')
    expect(round.headers['content-type']).toBe('application/json')
    // 归轮响应里的 task 直接刷进详情：含阻塞项时服务端把任务转成待修改。
    expect(textOf(wrapper, 'board-detail-status')).toContain('待修改')
    expect(node(wrapper, 'review-approve').exists()).toBe(false)
  })

  it('通过 走 …/review/approve，且成功后把详情状态刷成待合并', async () => {
    const { wrapper, calls, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/approve`, () =>
      jsonResponse(200, { task: { ...TASK_REVIEWING, status: '待合并' }, round: { round: 3 } }),
    )
    stubReview(routes, TASK_REVIEWING.id, reviewBody({ status: '待合并' }))
    await openDetail(wrapper, TASK_REVIEWING.id)

    await click(wrapper, 'review-approve')

    expect(reviewPosts(calls).map((call) => call.url)).toEqual([
      `/api/v1/tasks/${TASK_REVIEWING.id}/review/approve`,
    ])
    expect(textOf(wrapper, 'board-detail-status')).toContain('待合并')
    // 动作之后面板重新加载：一次开详情 + 一次动作后刷新。
    expect(reviewGets(calls, TASK_REVIEWING.id)).toHaveLength(2)
  })

  it('待合并只给「撤回通过」与「终止本次交付」，撤回走 …/review/withdraw', async () => {
    const { wrapper, calls, routes } = await mountBoard()
    stubReview(routes, TASK_MERGING.id, reviewBody({ task_id: TASK_MERGING.id, status: '待合并' }))
    routes.set(`POST /api/v1/tasks/${TASK_MERGING.id}/review/withdraw`, () =>
      jsonResponse(200, { task: { ...TASK_MERGING, status: '待修改' }, round: { round: 4 } }),
    )
    await openDetail(wrapper, TASK_MERGING.id)

    expect(node(wrapper, 'review-submit-round').exists()).toBe(false)
    expect(node(wrapper, 'review-approve').exists()).toBe(false)
    expect(textOf(wrapper, 'review-withdraw')).toContain('撤回通过')
    expect(textOf(wrapper, 'review-terminate')).toContain('终止本次交付')

    await click(wrapper, 'review-withdraw')

    expect(reviewPosts(calls).map((call) => call.url)).toEqual([
      `/api/v1/tasks/${TASK_MERGING.id}/review/withdraw`,
    ])
    expect(textOf(wrapper, 'board-detail-status')).toContain('待修改')
  })

  it('终止本次交付先问一句中文确认；点取消就不发请求', async () => {
    const asked: string[] = []
    globalThis.confirm = ((message?: string) => {
      asked.push(String(message ?? ''))
      return false
    }) as typeof globalThis.confirm

    const { wrapper, calls, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/terminate`, () =>
      jsonResponse(200, { task: { ...TASK_REVIEWING, status: '已退回' }, round: { round: 3 } }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)

    await click(wrapper, 'review-terminate')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('已退回')
    expect(asked[0]).not.toMatch(/[A-Za-z]{4,}/)
    expect(reviewPosts(calls)).toHaveLength(0)

    globalThis.confirm = (() => true) as typeof globalThis.confirm
    await click(wrapper, 'review-terminate')
    expect(reviewPosts(calls).map((call) => call.url)).toEqual([
      `/api/v1/tasks/${TASK_REVIEWING.id}/review/terminate`,
    ])
    expect(textOf(wrapper, 'board-detail-status')).toContain('已退回')
  })

  it('claim_only 看得到线程，但没有动作按钮，也没有输入框', async () => {
    const { wrapper, routes } = await mountBoard(ME_CLAIM_ONLY)
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    await openDetail(wrapper, TASK_REVIEWING.id)

    expect(node(wrapper, 'review-thread').exists()).toBe(true)
    expect(node(wrapper, 'review-message-11').exists()).toBe(true)
    expect(node(wrapper, 'review-actions').exists()).toBe(false)
    expect(node(wrapper, 'review-composer').exists()).toBe(false)
  })
})

describe('评审面板 — 写一条意见（#53）', () => {
  it('kind 下拉给出 blocking / suggestion / question / note 四项中文标签', async () => {
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    await openDetail(wrapper, TASK_REVIEWING.id)

    const options = selectOf(wrapper, 'review-composer-kind').props('options') ?? []
    expect(options.map((option) => option.value)).toEqual([
      'blocking',
      'suggestion',
      'question',
      'note',
    ])
    expect(options.map((option) => option.label)).toEqual(['阻塞', '建议', '提问', '备注'])
  })

  it('发送 POST …/review/messages，体是 { body_md, kind, anchor }，锚点由粘贴的链接解析而来', async () => {
    const { wrapper, calls, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/messages`, () =>
      jsonResponse(201, { ...DRAFT_MESSAGE, id: 15 }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)

    await setField(wrapper, 'review-composer-body', 'per_page 还是没有上限。')
    await setField(wrapper, 'review-composer-anchor', ANCHOR_URL)
    await click(wrapper, 'review-composer-send')

    const posts = reviewPosts(calls)
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe(`/api/v1/tasks/${TASK_REVIEWING.id}/review/messages`)
    expect(posts[0].credentials).toBe('include')
    expect(posts[0].headers['content-type']).toBe('application/json')
    expect(posts[0].body).toEqual({
      body_md: 'per_page 还是没有上限。',
      kind: 'blocking',
      anchor: { url: ANCHOR_URL, path: 'src/export.ts', head_sha: HEAD_SHA, line: 42 },
    })
    // 发完清空输入，并重新加载线程。
    expect(reviewGets(calls, TASK_REVIEWING.id)).toHaveLength(2)
    expect(
      (fieldElement(wrapper, 'review-composer-body').element as HTMLTextAreaElement).value,
    ).toBe('')
  })

  it('不填锚点时请求体里没有 anchor 这个键；正文为空时根本不发请求', async () => {
    const { wrapper, calls, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/messages`, () =>
      jsonResponse(201, { ...DRAFT_MESSAGE, id: 16 }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)

    await click(wrapper, 'review-composer-send')
    expect(reviewPosts(calls)).toHaveLength(0)

    await setField(wrapper, 'review-composer-body', '只是一条备注。')
    await click(wrapper, 'review-composer-send')

    const posts = reviewPosts(calls)
    expect(posts).toHaveLength(1)
    expect(Object.keys(posts[0].body as Record<string, unknown>)).toEqual(['body_md', 'kind'])
  })
})

describe('评审面板 — 中文错误信封（#53）', () => {
  it('409 no_pending_messages 无 message：写「没有待提交的评审意见。」', async () => {
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/rounds`, () =>
      jsonResponse(409, { error: 'no_pending_messages' }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)

    await click(wrapper, 'review-submit-round')

    expect(textOf(wrapper, 'review-action-message')).toContain('没有待提交的评审意见。')
    expect(textOf(wrapper, 'review-action-message')).not.toContain('undefined')
  })

  it('409 parent_not_completed 无 message：写「父任务尚未完成，不能通过子任务。」', async () => {
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/approve`, () =>
      jsonResponse(409, { error: 'parent_not_completed' }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)

    await click(wrapper, 'review-approve')

    expect(textOf(wrapper, 'review-action-message')).toContain('父任务尚未完成，不能通过子任务。')
  })

  it('Fastify 默认 500 信封：英文原文不上屏，回落到中文「操作失败（500）」', async () => {
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/approve`, () =>
      jsonResponse(500, {
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Cannot read properties of undefined',
      }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)

    await click(wrapper, 'review-approve')

    expect(textOf(wrapper, 'review-action-message')).toContain('操作失败（500）')
    expect(wrapper.text()).not.toContain('Internal Server Error')
    expect(wrapper.text()).not.toContain('Cannot read properties of undefined')
  })

  it('服务端带类型化 message 时照原样展示', async () => {
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/rounds`, () =>
      jsonResponse(409, { error: 'illegal_transition', message: '任务已经不在待验收。' }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)

    await click(wrapper, 'review-submit-round')

    expect(textOf(wrapper, 'review-action-message')).toContain('任务已经不在待验收。')
  })
})

describe('parseAnchorLink — 三家 forge 的单文件链接（#53）', () => {
  it('GitHub blob 链接解析出 path / line / head_sha', () => {
    expect(
      parseAnchorLink('https://github.com/org/app/blob/0123456789abcdef/src/orders/export.ts#L42'),
    ).toEqual({
      url: 'https://github.com/org/app/blob/0123456789abcdef/src/orders/export.ts#L42',
      path: 'src/orders/export.ts',
      head_sha: '0123456789abcdef',
      line: 42,
    })
  })

  it('GitLab 的 /-/blob/ 链接不会把 `-` 当成仓库名', () => {
    expect(
      parseAnchorLink('https://gitlab.example.test/team/sub/billing/-/blob/deadbeef/app/pay.rb#L7'),
    ).toEqual({
      url: 'https://gitlab.example.test/team/sub/billing/-/blob/deadbeef/app/pay.rb#L7',
      path: 'app/pay.rb',
      head_sha: 'deadbeef',
      line: 7,
    })
  })

  // 这一条才让「GitLab 先于 GitHub 判定」承重：分组名就叫 blob 时，光扫裸 `blob` 段会把
  // 项目名当成 sha。
  it('分组名恰好叫 blob 的 GitLab 链接仍取 /-/blob/ 后面的 sha', () => {
    const url = 'https://gitlab.example.test/blob/billing/-/blob/deadbeef/app/pay.rb#L7'
    expect(parseAnchorLink(url)).toEqual({
      url,
      path: 'app/pay.rb',
      head_sha: 'deadbeef',
      line: 7,
    })
  })

  it('Gitea 的 /src/commit/ 链接同样解析', () => {
    expect(parseAnchorLink(ANCHOR_URL)).toEqual({
      url: ANCHOR_URL,
      path: 'src/export.ts',
      head_sha: HEAD_SHA,
      line: 42,
    })
  })

  it('没有行号时只给 path 与 head_sha', () => {
    expect(
      parseAnchorLink('https://github.com/org/app/blob/0123456789abcdef/README.md'),
    ).toEqual({
      url: 'https://github.com/org/app/blob/0123456789abcdef/README.md',
      path: 'README.md',
      head_sha: '0123456789abcdef',
    })
  })

  it('GitHub 的 PR diff 锚点带不出 path：只留 url', () => {
    const prAnchor = 'https://github.com/org/app/pull/12/files#diff-9a8b7c6d5eR42'
    expect(parseAnchorLink(prAnchor)).toEqual({ url: prAnchor })
  })

  it('非 http(s) 与不成形的链接也只留 url，绝不编造 path', () => {
    expect(parseAnchorLink('javascript:alert(1)')).toEqual({ url: 'javascript:alert(1)' })
    expect(parseAnchorLink('随手写的一句话')).toEqual({ url: '随手写的一句话' })
    expect(parseAnchorLink('  ')).toEqual({ url: '' })
  })
})

// =============================================================================================
// Issue #54 (DESIGN.md §17.7) — 评审锚定核对：forge_head_sha / forge_head_seen_at / head_stale on
// the review view, and the Chinese envelope for a 409 head_sha_stale review action.
//
// Custody note: this describe block is the acceptance oracle for the web half of #54; an
// implementer may not weaken or reinterpret it to pass. Deliberately NOT covered here: a 409
// head_sha_stale WITH a server-supplied `message` already round-trips correctly on HEAD through
// the pre-existing generic `typedErrorMessage` path (see '服务端带类型化 message 时照原样展示'
// above, which already proves this generically for any `[a-z][a-z0-9_]*` error code) — a
// duplicate assertion of that same generic path for this one code specifically would pass on
// baseline for a reason unrelated to #54, so it would not be RED evidence for this issue and is
// omitted per this suite's "don't force a non-failing test" rule.
// =============================================================================================

describe('评审面板 — forge 头已变化（#54）', () => {
  it('head_stale: true 时渲染 review-head-stale，文案含「forge 头已变化」与两个 12 位 sha 前缀；head_stale: false 时不渲染', async () => {
    const FORGE_SHA = 'fedcba9876543210fedcba9876543210fedcba98'
    const { wrapper, routes } = await mountBoard()
    stubReview(
      routes,
      TASK_REVIEWING.id,
      reviewBody({
        forge_head_sha: FORGE_SHA,
        forge_head_seen_at: 1780000000,
        head_stale: true,
      }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)

    const staleText = textOf(wrapper, 'review-head-stale')
    expect(staleText).toContain('forge 头已变化')
    expect(staleText).toContain(HEAD_SHA.slice(0, 12))
    expect(staleText).toContain(FORGE_SHA.slice(0, 12))

    // A second task whose view reports head_stale: false must render no such element at all.
    stubReview(
      routes,
      TASK_MERGING.id,
      reviewBody({
        task_id: TASK_MERGING.id,
        status: '待合并',
        forge_head_sha: HEAD_SHA,
        forge_head_seen_at: 1780000001,
        head_stale: false,
      }),
    )
    await openDetail(wrapper, TASK_MERGING.id)
    expect(node(wrapper, 'review-head-stale').exists()).toBe(false)
  })

  it('409 head_sha_stale 且服务端未带 message：客户端兜底给出与通用「操作失败（409）」不同的非空中文提示，且不出现英文错误码', async () => {
    const { wrapper, routes } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/approve`, () =>
      jsonResponse(409, {
        error: 'head_sha_stale',
        recorded_head_sha: HEAD_SHA,
        forge_head_sha: 'fedcba9876543210fedcba9876543210fedcba98',
      }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)

    await click(wrapper, 'review-approve')

    const text = textOf(wrapper, 'review-action-message')
    expect(text.trim().length).toBeGreaterThan(0)
    expect(text).not.toBe('操作失败（409）')
    expect(text).not.toContain('head_sha_stale')
    expect(/[一-鿿]/.test(text)).toBe(true)
  })

  it('409 head_sha_stale 之后会再 GET …/review，从而画出「forge 头已变化」，且 409 中文提示仍在', async () => {
    const FORGE_SHA = 'fedcba9876543210fedcba9876543210fedcba98'
    const { wrapper, routes, calls } = await mountBoard()
    stubReview(routes, TASK_REVIEWING.id, reviewBody())
    routes.set(`POST /api/v1/tasks/${TASK_REVIEWING.id}/review/approve`, () =>
      jsonResponse(409, {
        error: 'head_sha_stale',
        recorded_head_sha: HEAD_SHA,
        forge_head_sha: FORGE_SHA,
      }),
    )
    await openDetail(wrapper, TASK_REVIEWING.id)
    const getsBefore = reviewGets(calls, TASK_REVIEWING.id).length
    stubReview(
      routes,
      TASK_REVIEWING.id,
      reviewBody({
        forge_head_sha: FORGE_SHA,
        forge_head_seen_at: 1780000000,
        head_stale: true,
      }),
    )

    await click(wrapper, 'review-approve')

    expect(reviewGets(calls, TASK_REVIEWING.id).length).toBeGreaterThan(getsBefore)
    expect(textOf(wrapper, 'review-head-stale')).toContain('forge 头已变化')
    expect(textOf(wrapper, 'review-action-message')).toMatch(/[一-鿿]/)
    expect(textOf(wrapper, 'review-action-message')).not.toContain('head_sha_stale')
  })
})
