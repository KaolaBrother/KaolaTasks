// Oracle for the 任务看板 in App.vue (issue #8).
//
// The board does not exist yet, so these tests define its observable surface. The data-testid
// contract, the fetch stub and every judgement call are written up in
// kaola-workflow/bundle-8-17/.cache/tests-board.md — read that before implementing.
//
// Wire format is the live GET /api/v1/tasks envelope `{ tasks: Brief[] }` (snake_case brief keys,
// credential `{ profile_id }` XOR `{ inline: true }`). Timeline synthesizes 发布 from
// created_at + poster; there is no events HTTP. Filters are client-side; the list URL stays
// exactly `/api/v1/tasks` so App.form.test.ts's defensive stub keeps working.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import naive, { NSelect } from 'naive-ui'
import { nextTick } from 'vue'
import App from './App.vue'

// --- fixtures ------------------------------------------------------------------------------

const FORGE_BASE_URL = 'https://gitea.forge.example.test'
const HTTPS_ISSUE_URL = 'https://github.com/org/app/issues/12'
const JS_ISSUE_URL = 'javascript:alert(1)'
const FILTER_ALL = ''

const STATUSES = ['待认领', '进行中', '待验收', '已完成', '已退回', '已取消'] as const

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
const ME_PENDING = { ...ME_CLAIM_ONLY, status: '待批准' }

const PROFILES = [
  {
    id: 3,
    forge: 'gitea',
    base_url: FORGE_BASE_URL,
    repo_full_name: 'team/orders',
    scopes_checked: [],
    created_by: 7,
  },
  {
    id: 5,
    forge: 'gitlab',
    base_url: 'https://gitlab.example.test',
    repo_full_name: 'team/billing',
    scopes_checked: [],
    created_by: 7,
  },
]

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
  pr_convention: { branch_prefix: string; title_prefix: string }
  credential: { profile_id: string } | { inline: true }
  priority: string
  tags: string[]
  poster: string
  status: string
  created_at: string
}

function makeBrief(
  overrides: { id: string } & Partial<Omit<Brief, 'id' | 'repo'>> & { repo?: Partial<Brief['repo']> },
): Brief {
  const { id, repo: repoOver, ...rest } = overrides
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
      ...repoOver,
    },
    acceptance_criteria: [],
    test_command: '',
    constraints: { allowed_paths: [], forbidden_paths: [] },
    pr_convention: { branch_prefix: `kaola/${id}-`, title_prefix: `[${id}] ` },
    credential: { profile_id: '3' },
    priority: 'P2',
    tags: [],
    poster: 'zhang.wei',
    status: '待认领',
    created_at: '2026-08-21T08:00:00Z',
    ...rest,
  }
}

const TASK_OPEN = makeBrief({
  id: 'kt-2026-0001',
  title: '为订单导出接口增加分页',
  status: '待认领',
  tags: ['backend', 'api'],
  credential: { profile_id: '3' },
  created_at: '2026-08-21T08:00:00Z',
  poster: 'zhang.wei',
})

const TASK_IN_PROGRESS = makeBrief({
  id: 'kt-2026-0002',
  title: '账单页改用 Naive 表格',
  status: '进行中',
  tags: ['frontend'],
  credential: { inline: true },
  source: { type: 'imported', issue_url: HTTPS_ISSUE_URL },
  repo: {
    forge: 'github',
    base_url: 'https://github.com',
    full_name: 'org/app',
    suggested_dir: 'app',
  },
  created_at: '2026-08-20T12:00:00Z',
  poster: 'li.na',
})

const TASK_CANCELLED = makeBrief({
  id: 'kt-2026-0003',
  title: '废弃的对账脚本',
  status: '已取消',
  tags: ['backend'],
  credential: { inline: true },
  repo: {
    forge: 'gitlab',
    base_url: 'https://gitlab.example.test',
    full_name: 'team/billing',
    suggested_dir: 'billing',
  },
  created_at: '2026-08-19T09:30:00Z',
  poster: 'zhang.wei',
})

const TASK_XSS = makeBrief({
  id: 'kt-2026-0004',
  title: '<img src=x onerror=alert(1)>',
  description_md: '<script>alert(1)</script>',
  status: '待认领',
  tags: ['security'],
  source: { type: 'imported', issue_url: JS_ISSUE_URL },
  repo: { forge: 'gitea', full_name: 'team/xss' },
  created_at: '2026-08-18T01:02:03Z',
  poster: 'mallory',
})

const BOARD_TASKS = [TASK_OPEN, TASK_IN_PROGRESS, TASK_CANCELLED, TASK_XSS]

const CREATED_BRIEF = makeBrief({
  id: 'kt-2026-0042',
  title: '为订单导出接口增加分页',
  credential: { profile_id: '3' },
  created_at: '2026-08-21T08:00:00Z',
})

// --- fetch stub ----------------------------------------------------------------------------
//
// One router keyed on `${METHOD} ${url}`. Every call is recorded verbatim so the header and
// URL contracts can be asserted. An unrouted call answers 500 { error: 'unstubbed' } and stays
// in `calls`, so an unexpected outbound request (including GET /api/v1/tasks/:id) can never
// pass silently.

type FetchCall = {
  url: string
  method: string
  headers: Record<string, string>
  credentials: string | undefined
  body: unknown
}
type Handler = () => Response

const realFetch = globalThis.fetch

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
  vi.restoreAllMocks()
})

async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await flushPromises()
    await nextTick()
  }
}

// --- mount helper --------------------------------------------------------------------------

async function mountApp(me: Record<string, unknown> = ME_FULL, tasks: Brief[] = BOARD_TASKS) {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/setup', () => jsonResponse(200, { setup_complete: true }))
  routes.set('GET /api/v1/me', () => jsonResponse(200, me))
  routes.set('GET /api/v1/agent-keys', () => jsonResponse(200, { keys: [] }))
  routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles: PROFILES }))
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks }))
  routes.set('POST /api/v1/tasks', () => jsonResponse(201, CREATED_BRIEF))
  routes.set('GET /api/v1/me/devices', () => jsonResponse(200, { devices: [] }))
  routes.set('GET /api/v1/devices/pending', () => jsonResponse(200, { devices: [] }))
  routes.set('GET /api/v1/claimants', () => jsonResponse(200, { claimants: [] }))

  const wrapper = mount(App, { global: { plugins: [naive] } })
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/me')).toBe(true)
  })
  await settle()
  if (me.status === 'active' && (me.permission_level === 'full' || me.permission_level === 'admin')) {
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/credential-profiles')).toBe(true)
    })
    await settle()
  }
  return { wrapper, calls, routes }
}

async function mountBoard(me: Record<string, unknown> = ME_FULL, tasks: Brief[] = BOARD_TASKS) {
  const mounted = await mountApp(me, tasks)
  await vi.waitFor(() => {
    expect(node(mounted.wrapper, 'board').exists()).toBe(true)
  })
  return mounted
}

async function mountUnauthorized() {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/setup', () => jsonResponse(200, { setup_complete: true }))
  routes.set('GET /api/v1/me', () => jsonResponse(401, { error: 'unauthorized' }))
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks: BOARD_TASKS }))
  const wrapper = mount(App, { global: { plugins: [naive] } })
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/me')).toBe(true)
  })
  await settle()
  return { wrapper, calls }
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

function selectOf(wrapper: VueWrapper, testid: string) {
  const found = wrapper
    .findAllComponents(NSelect)
    .find((candidate) => candidate.attributes('data-testid') === testid)
  if (found == null) throw new Error(`no n-select with data-testid="${testid}"`)
  return found
}

async function setSelect(wrapper: VueWrapper, testid: string, value: string | number) {
  selectOf(wrapper, testid).vm.$emit('update:value', value)
  await nextTick()
  await settle()
}

function cardId(id: string) {
  return `board-card-${id}`
}

function columnId(status: string) {
  return `board-column-${status}`
}

function listGets(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.method === 'GET' && call.url === '/api/v1/tasks')
}

function taskItemGets(calls: FetchCall[]): FetchCall[] {
  return calls.filter(
    (call) => call.method === 'GET' && /^\/api\/v1\/tasks\/.+/.test(call.url),
  )
}

async function openDetail(wrapper: VueWrapper, id: string) {
  const found = node(wrapper, cardId(id))
  if (!found.exists()) throw new Error(`missing [data-testid="${cardId(id)}"]`)
  await found.trigger('click')
  await settle()
}

async function showList(wrapper: VueWrapper) {
  const found = node(wrapper, 'board-view-list')
  if (!found.exists()) throw new Error('missing [data-testid="board-view-list"]')
  await found.trigger('click')
  await settle()
}

async function showKanban(wrapper: VueWrapper) {
  const found = node(wrapper, 'board-view-kanban')
  if (!found.exists()) throw new Error('missing [data-testid="board-view-kanban"]')
  await found.trigger('click')
  await settle()
}

function javascriptHrefs(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('a')
    .map((anchor) => anchor.attributes('href') ?? '')
    .filter((href) => href.trim().toLowerCase().startsWith('javascript:'))
}

function columnOrder(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('[data-testid^="board-column-"]')
    .map((col) => col.attributes('data-testid') ?? '')
}

function cardsIn(wrapper: VueWrapper, status: string) {
  return node(wrapper, columnId(status)).findAll('[data-testid^="board-card-"]')
}

function optionValues(wrapper: VueWrapper, testid: string): unknown[] {
  const options = selectOf(wrapper, testid).props('options') ?? []
  return options.map((option) => option.value)
}

// =============================================================================================

describe('任务看板 — 可见性（view === member）', () => {
  it('full 与 claim_only 看得到看板；待批准与未登录看不到', async () => {
    const full = await mountBoard(ME_FULL)
    expect(node(full.wrapper, 'board').exists()).toBe(true)
    expect(node(full.wrapper, 'task-form').exists()).toBe(true)
    full.wrapper.unmount()

    const claimOnly = await mountBoard(ME_CLAIM_ONLY)
    expect(claimOnly.wrapper.text()).toContain('工作台')
    expect(node(claimOnly.wrapper, 'board').exists()).toBe(true)
    expect(node(claimOnly.wrapper, 'task-form').exists()).toBe(false)
    claimOnly.wrapper.unmount()

    const pending = await mountApp(ME_PENDING)
    expect(pending.wrapper.text()).toContain('账号待批准')
    expect(node(pending.wrapper, 'board').exists()).toBe(false)
    pending.wrapper.unmount()

    const login = await mountUnauthorized()
    expect(login.wrapper.text()).toContain('登录')
    expect(node(login.wrapper, 'board').exists()).toBe(false)
    login.wrapper.unmount()
  })
})

describe('任务看板 — GET /api/v1/tasks', () => {
  it('成员工作台拉取列表：URL 无 query，credentials 与 Accept 承重', async () => {
    const { calls } = await mountApp()
    await vi.waitFor(() => {
      expect(listGets(calls).length).toBeGreaterThan(0)
    })

    const list = listGets(calls)
    expect(list).toHaveLength(1)
    expect(list[0].url).toBe('/api/v1/tasks')
    expect(list[0].method).toBe('GET')

    for (const call of calls) {
      expect({
        call: `${call.method} ${call.url}`,
        credentials: call.credentials,
        accept: call.headers.accept,
      }).toEqual({
        call: `${call.method} ${call.url}`,
        credentials: 'include',
        accept: 'application/json',
      })
    }
  })

  it('筛选与打开详情都不改 list URL，也不发 GET /api/v1/tasks/:id', async () => {
    const { wrapper, calls } = await mountBoard()
    expect(listGets(calls)).toHaveLength(1)

    await setSelect(wrapper, 'board-filter-status', '待认领')
    await openDetail(wrapper, TASK_OPEN.id)
    expect(node(wrapper, 'board-detail').exists()).toBe(true)

    expect(listGets(calls)).toHaveLength(1)
    expect(listGets(calls)[0].url).toBe('/api/v1/tasks')
    expect(taskItemGets(calls)).toHaveLength(0)
    expect(calls.some((call) => call.url.includes('?'))).toBe(false)
  })
})

describe('任务看板 — 六个状态列', () => {
  it('看板默认六列按枚举顺序，空列保留，卡片落在对应 status', async () => {
    const { wrapper } = await mountBoard()
    expect(node(wrapper, 'board-kanban').exists()).toBe(true)
    expect(node(wrapper, 'board-list').exists()).toBe(false)

    expect(columnOrder(wrapper)).toEqual(STATUSES.map((status) => columnId(status)))
    for (const status of STATUSES) {
      expect(textOf(wrapper, columnId(status))).toContain(status)
    }

    expect(cardsIn(wrapper, '待认领').map((card) => card.attributes('data-testid'))).toEqual([
      cardId(TASK_OPEN.id),
      cardId(TASK_XSS.id),
    ])
    expect(cardsIn(wrapper, '进行中').map((card) => card.attributes('data-testid'))).toEqual([
      cardId(TASK_IN_PROGRESS.id),
    ])
    expect(cardsIn(wrapper, '已取消').map((card) => card.attributes('data-testid'))).toEqual([
      cardId(TASK_CANCELLED.id),
    ])
    expect(cardsIn(wrapper, '待验收')).toHaveLength(0)
    expect(cardsIn(wrapper, '已完成')).toHaveLength(0)
    expect(cardsIn(wrapper, '已退回')).toHaveLength(0)

    expect(textOf(wrapper, cardId(TASK_OPEN.id))).toContain(TASK_OPEN.title)
    expect(textOf(wrapper, cardId(TASK_CANCELLED.id))).toContain(TASK_CANCELLED.title)
  })

  it('空列表仍渲染六个空列，并给出暂无任务。', async () => {
    const { wrapper } = await mountBoard(ME_FULL, [])
    expect(columnOrder(wrapper)).toEqual(STATUSES.map((status) => columnId(status)))
    for (const status of STATUSES) {
      expect(cardsIn(wrapper, status)).toHaveLength(0)
    }
    expect(textOf(wrapper, 'board')).toContain('暂无任务。')
  })
})

describe('任务看板 — 列表 / 看板切换', () => {
  it('点「列表」只见列表，点「看板」只见看板；列表仍展示各标题', async () => {
    const { wrapper } = await mountBoard()
    expect(textOf(wrapper, 'board-view-list')).toContain('列表')
    expect(textOf(wrapper, 'board-view-kanban')).toContain('看板')

    await showList(wrapper)
    expect(node(wrapper, 'board-list').exists()).toBe(true)
    expect(node(wrapper, 'board-kanban').exists()).toBe(false)
    expect(node(wrapper, columnId('待认领')).exists()).toBe(false)
    expect(textOf(wrapper, cardId(TASK_OPEN.id))).toContain(TASK_OPEN.title)
    expect(textOf(wrapper, cardId(TASK_IN_PROGRESS.id))).toContain(TASK_IN_PROGRESS.title)
    expect(textOf(wrapper, cardId(TASK_CANCELLED.id))).toContain(TASK_CANCELLED.title)

    await showKanban(wrapper)
    expect(node(wrapper, 'board-kanban').exists()).toBe(true)
    expect(node(wrapper, 'board-list').exists()).toBe(false)
    expect(node(wrapper, columnId('待认领')).exists()).toBe(true)
  })
})

describe('任务看板 — 客户端筛选', () => {
  it('状态筛「待认领」藏起已取消；恢复「全部」后回来', async () => {
    const { wrapper } = await mountBoard()
    expect(optionValues(wrapper, 'board-filter-status')).toEqual([FILTER_ALL, ...STATUSES])
    expect(selectOf(wrapper, 'board-filter-status').props('options')?.[0]?.label).toBe('全部')

    await setSelect(wrapper, 'board-filter-status', '待认领')
    expect(node(wrapper, cardId(TASK_OPEN.id)).exists()).toBe(true)
    expect(node(wrapper, cardId(TASK_XSS.id)).exists()).toBe(true)
    expect(node(wrapper, cardId(TASK_CANCELLED.id)).exists()).toBe(false)
    expect(node(wrapper, cardId(TASK_IN_PROGRESS.id)).exists()).toBe(false)

    await setSelect(wrapper, 'board-filter-status', FILTER_ALL)
    expect(node(wrapper, cardId(TASK_CANCELLED.id)).exists()).toBe(true)
    expect(node(wrapper, cardId(TASK_IN_PROGRESS.id)).exists()).toBe(true)
  })

  it('标签筛是 tags 数组成员资格，不是整列相等', async () => {
    const { wrapper } = await mountBoard()
    const values = optionValues(wrapper, 'board-filter-tag')
    expect(values[0]).toBe(FILTER_ALL)
    expect(values).toContain('backend')
    expect(values).toContain('frontend')
    expect(values).toContain('security')

    await setSelect(wrapper, 'board-filter-tag', 'backend')
    expect(node(wrapper, cardId(TASK_OPEN.id)).exists()).toBe(true)
    expect(node(wrapper, cardId(TASK_CANCELLED.id)).exists()).toBe(true)
    expect(node(wrapper, cardId(TASK_IN_PROGRESS.id)).exists()).toBe(false)
    expect(node(wrapper, cardId(TASK_XSS.id)).exists()).toBe(false)
  })

  it('forge 筛只留下 repo.forge 匹配的卡片', async () => {
    const { wrapper } = await mountBoard()
    expect(optionValues(wrapper, 'board-filter-forge')).toEqual([
      FILTER_ALL,
      'github',
      'gitlab',
      'gitea',
    ])

    await setSelect(wrapper, 'board-filter-forge', 'github')
    expect(node(wrapper, cardId(TASK_IN_PROGRESS.id)).exists()).toBe(true)
    expect(node(wrapper, cardId(TASK_OPEN.id)).exists()).toBe(false)
    expect(node(wrapper, cardId(TASK_CANCELLED.id)).exists()).toBe(false)
    expect(node(wrapper, cardId(TASK_XSS.id)).exists()).toBe(false)
  })

  it('状态与标签是 AND；列表视图共用同一套过滤', async () => {
    const { wrapper } = await mountBoard()
    await setSelect(wrapper, 'board-filter-status', '待认领')
    await setSelect(wrapper, 'board-filter-tag', 'backend')
    expect(node(wrapper, cardId(TASK_OPEN.id)).exists()).toBe(true)
    expect(node(wrapper, cardId(TASK_XSS.id)).exists()).toBe(false)
    expect(node(wrapper, cardId(TASK_CANCELLED.id)).exists()).toBe(false)

    await showList(wrapper)
    expect(node(wrapper, 'board-list').exists()).toBe(true)
    expect(node(wrapper, cardId(TASK_OPEN.id)).exists()).toBe(true)
    expect(node(wrapper, cardId(TASK_XSS.id)).exists()).toBe(false)
    expect(node(wrapper, cardId(TASK_CANCELLED.id)).exists()).toBe(false)
  })
})

describe('任务看板 — 详情与发布时间线', () => {
  it('点击卡片打开详情，关闭后详情消失', async () => {
    const { wrapper } = await mountBoard()
    await openDetail(wrapper, TASK_OPEN.id)

    expect(textOf(wrapper, 'board-detail-title')).toContain(TASK_OPEN.title)
    expect(textOf(wrapper, 'board-detail-status')).toContain('待认领')
    expect(textOf(wrapper, 'board-detail-poster')).toContain('zhang.wei')
    expect(textOf(wrapper, 'board-detail-tags')).toContain('backend')
    expect(textOf(wrapper, 'board-detail-tags')).toContain('api')
    expect(textOf(wrapper, 'board-detail-forge')).toContain('gitea')
    expect(textOf(wrapper, 'board-detail-close')).toContain('关闭')

    await node(wrapper, 'board-detail-close').trigger('click')
    await settle()
    expect(node(wrapper, 'board-detail').exists()).toBe(false)
  })

  it('时间线恰好一条「发布」，文案带 poster 与 created_at；不发明心跳或 token 揭示', async () => {
    const { wrapper } = await mountBoard()
    await openDetail(wrapper, TASK_OPEN.id)

    const items = wrapper.findAll('[data-testid="board-timeline-item"]')
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('发布')
    expect(items[0].text()).toContain('zhang.wei')
    expect(items[0].text()).toContain('2026-08-21T08:00:00Z')

    const timeline = textOf(wrapper, 'board-timeline')
    expect(timeline).not.toContain('心跳')
    expect(timeline).not.toContain('token 揭示')
    expect(timeline).not.toContain('完结')
    expect(node(wrapper, 'board-timeline-认领').exists()).toBe(false)
    expect(node(wrapper, 'board-timeline-心跳').exists()).toBe(false)
    expect(node(wrapper, 'board-timeline-提交').exists()).toBe(false)
    expect(node(wrapper, 'board-timeline-完结').exists()).toBe(false)
  })

  it('native 不渲染 issue 链接；imported 的 http(s) issue_url 是 a[href]', async () => {
    const { wrapper } = await mountBoard()
    await openDetail(wrapper, TASK_OPEN.id)
    expect(node(wrapper, 'board-detail').exists()).toBe(true)
    expect(node(wrapper, 'board-detail-issue-url').exists()).toBe(false)

    await openDetail(wrapper, TASK_IN_PROGRESS.id)
    const link = node(wrapper, 'board-detail-issue-url').find('a')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe(HTTPS_ISSUE_URL)
  })
})

describe('任务看板 — 凭证不泄露', () => {
  it('详情只显示共享档案或单任务临时 token，不出现密文键名', async () => {
    const { wrapper } = await mountBoard(ME_CLAIM_ONLY)
    await openDetail(wrapper, TASK_OPEN.id)
    expect(textOf(wrapper, 'board-detail-credential')).toContain('共享档案')
    expect(textOf(wrapper, 'board-detail-credential')).not.toContain('单任务临时 token')

    await openDetail(wrapper, TASK_IN_PROGRESS.id)
    expect(textOf(wrapper, 'board-detail-credential')).toContain('单任务临时 token')

    const scoped = `${textOf(wrapper, 'board')}\n${textOf(wrapper, 'board-detail')}`
    expect(scoped).not.toContain('token_encrypted')
    expect(scoped).not.toContain('inline_token_encrypted')
    expect(scoped).not.toContain('access_token')
    expect(scoped).not.toContain('ghp_')
  })
})

describe('任务看板 — XSS', () => {
  it('description_md 与危险标题按文本渲染，不长出 script / img 节点', async () => {
    const { wrapper } = await mountBoard()
    expect(textOf(wrapper, cardId(TASK_XSS.id))).toContain('<img src=x onerror=alert(1)>')
    expect(node(wrapper, cardId(TASK_XSS.id)).find('img').exists()).toBe(false)

    await openDetail(wrapper, TASK_XSS.id)
    expect(textOf(wrapper, 'board-detail-title')).toContain('<img src=x onerror=alert(1)>')
    expect(node(wrapper, 'board-detail-title').find('img').exists()).toBe(false)
    expect(textOf(wrapper, 'board-detail-description')).toContain('<script>alert(1)</script>')
    expect(node(wrapper, 'board-detail-description').find('script').exists()).toBe(false)
  })

  it('javascript: issue_url 显示为文本，不变成 href', async () => {
    const { wrapper } = await mountBoard()
    await openDetail(wrapper, TASK_XSS.id)
    expect(textOf(wrapper, 'board-detail-issue-url')).toContain(JS_ISSUE_URL)
    expect(node(wrapper, 'board-detail-issue-url').find('a').exists()).toBe(false)
    expect(javascriptHrefs(wrapper)).toEqual([])
  })
})

describe('任务看板 — 导入内容来源标记（issue #12）', () => {
  it('imported 详情显示 board-detail-import-label，文案恰好是「导入内容」；native 不渲染', async () => {
    const { wrapper } = await mountBoard()

    await openDetail(wrapper, TASK_OPEN.id)
    expect(node(wrapper, 'board-detail').exists()).toBe(true)
    expect(node(wrapper, 'board-detail-import-label').exists()).toBe(false)

    await openDetail(wrapper, TASK_IN_PROGRESS.id)
    expect(node(wrapper, 'board-detail-import-label').exists()).toBe(true)
    expect(textOf(wrapper, 'board-detail-import-label').trim()).toBe('导入内容')
    expect(node(wrapper, 'board-detail-issue-url').exists()).toBe(true)
  })
})

describe('任务看板 — 中文文案', () => {
    it('界面文案是中文：任务看板 / 列表 / 看板 / 全部 / 关闭，不含 Kanban 或 Timeline', async () => {
    const { wrapper } = await mountBoard(ME_CLAIM_ONLY)
    const chrome = textOf(wrapper, 'board')
    expect(chrome).toContain('任务看板')
    expect(chrome).toContain('列表')
    expect(chrome).toContain('看板')
    expect(chrome).toContain('全部')
    expect(chrome).toContain('状态')
    expect(chrome).toContain('标签')
    expect(chrome).not.toContain('Kanban')
    expect(chrome).not.toContain('Timeline')
    expect(chrome).not.toContain('Backlog')

    await openDetail(wrapper, TASK_OPEN.id)
    expect(textOf(wrapper, 'board-detail-close')).toContain('关闭')
    expect(textOf(wrapper, 'board-detail')).not.toContain('Timeline')
  })
})
