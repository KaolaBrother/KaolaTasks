// Oracle for the 审计日志 / 团队统计 sections in App.vue (issue #15).
//
// Neither section exists yet — see kaola-workflow/bundle-15-16/.cache/ground-truth.md ("No
// events UI/audit page exists yet ... No aggregation query, no /stats route, no stats widget
// exists"). This suite defines their observable surface. Judgement calls not settled by
// kaola-workflow/bundle-15-16/.cache/orchestrator-rulings.md §15 are written up in
// kaola-workflow/bundle-15-16/.cache/tests-events.md — read that before implementing.
//
// Wire format: GET /api/v1/events -> { events: EventRow[] } (newest-first, actor_username via
// left-join, details already parsed). GET /api/v1/stats -> exactly
// { completed_count, completed_by_username }. Both fetch URLs stay query-string free; every
// filter (类型/人/任务/时间) is client-side, same idiom as the board's client-side filters.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import naive, { NSelect } from 'naive-ui'
import { nextTick } from 'vue'
import App from './App.vue'

// --- shared event vocabulary (orchestrator-rulings.md §15 "Shared / out") ------------------

const LIVE_EVENT_TYPES = ['token 揭示', '状态迁移', '心跳', '变更', '回写', '认领待确认', '认领已确认']
const SYSTEM_ACTOR_LABEL = '系统'

// --- fixtures ------------------------------------------------------------------------------

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

type EventRow = {
  id: number
  type: string
  actor_user_id: number | null
  actor_username: string | null
  created_at: string
  details: Record<string, unknown>
}

// Seven rows spanning every live `type` literal, a mix of real-actor and system (null-actor)
// rows, and overlapping actors/tasks so combinable filters have something to narrow.
const EVENTS: EventRow[] = [
  {
    id: 7,
    type: '回写',
    actor_user_id: null,
    actor_username: null,
    created_at: '2026-08-21T11:00:00Z',
    details: { task_id: 'kt-2026-0001', transition: '认领', ok: true, issue_url: 'https://forge.example.test/issues/1' },
  },
  {
    id: 6,
    type: '认领已确认',
    actor_user_id: 7,
    actor_username: 'zhang.wei',
    created_at: '2026-08-21T10:45:00Z',
    details: { task_id: 'kt-2026-0004', agent_key_id: 21 },
  },
  {
    id: 5,
    type: '认领待确认',
    actor_user_id: 11,
    actor_username: 'li.na',
    created_at: '2026-08-21T10:30:00Z',
    details: { task_id: 'kt-2026-0004', agent_key_id: 21 },
  },
  {
    id: 4,
    type: '变更',
    actor_user_id: 7,
    actor_username: 'zhang.wei',
    created_at: '2026-08-21T10:00:00Z',
    details: { action: 'create', profile_id: 3 },
  },
  {
    id: 3,
    type: '状态迁移',
    actor_user_id: null,
    actor_username: null,
    created_at: '2026-08-21T09:00:00Z',
    details: { task_id: 'kt-2026-0002', from: '进行中', to: '待认领' },
  },
  {
    id: 2,
    type: '心跳',
    actor_user_id: 7,
    actor_username: 'zhang.wei',
    created_at: '2026-08-21T08:30:00Z',
    details: { task_id: 'kt-2026-0001', note: '写测试' },
  },
  {
    id: 1,
    type: 'token 揭示',
    actor_user_id: 11,
    actor_username: 'li.na',
    created_at: '2026-08-21T08:00:00Z',
    details: { task_id: 'kt-2026-0003', agent_key_id: 9, credential: 'inline' },
  },
]

const STATS = {
  completed_count: 4,
  completed_by_username: {
    'zhang.wei': 2,
    [SYSTEM_ACTOR_LABEL]: 1,
    'li.na': 1,
  },
}

const EMPTY_STATS = { completed_count: 0, completed_by_username: {} }

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

// --- mount helpers ---------------------------------------------------------------------------

type StatsBody = { completed_count: number; completed_by_username: Record<string, number> }

async function mountMember(
  me: Record<string, unknown> = ME_FULL,
  { events = EVENTS, stats = STATS }: { events?: EventRow[]; stats?: StatsBody } = {},
) {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/me', () => jsonResponse(200, me))
  routes.set('GET /api/v1/agent-keys', () => jsonResponse(200, { keys: [] }))
  routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles: [] }))
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks: [] }))
  routes.set('GET /api/v1/events', () => jsonResponse(200, { events }))
  routes.set('GET /api/v1/stats', () => jsonResponse(200, stats))
  routes.set('GET /api/v1/me/devices', () => jsonResponse(200, { devices: [] }))
  routes.set('GET /api/v1/devices/pending', () => jsonResponse(200, { devices: [] }))
  routes.set('GET /api/v1/claimants', () => jsonResponse(200, { claimants: [] }))

  const wrapper = mount(App, { global: { plugins: [naive] } })
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/me')).toBe(true)
  })
  await settle()
  await vi.waitFor(
    () => {
      expect(calls.some((call) => call.url === '/api/v1/events')).toBe(true)
      expect(calls.some((call) => call.url === '/api/v1/stats')).toBe(true)
    },
    { timeout: 2000 },
  )
  await settle()
  return { wrapper, calls, routes }
}

async function mountPending(me: Record<string, unknown> = ME_PENDING) {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/me', () => jsonResponse(200, me))
  const wrapper = mount(App, { global: { plugins: [naive] } })
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/me')).toBe(true)
  })
  await settle()
  return { wrapper, calls }
}

async function mountUnauthorized() {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/me', () => jsonResponse(401, { error: 'unauthorized' }))
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

function optionValues(wrapper: VueWrapper, testid: string): unknown[] {
  const options = selectOf(wrapper, testid).props('options') ?? []
  return options.map((option: unknown) =>
    typeof option === 'object' && option != null && 'value' in option ? option.value : undefined,
  )
}

function fieldElement(wrapper: VueWrapper, testid: string) {
  const found = wrapper.findAll(`[data-testid="${testid}"] input, [data-testid="${testid}"] textarea`)
  if (found.length === 0) throw new Error(`no input/textarea under [data-testid="${testid}"]`)
  return found[0]
}

async function setField(wrapper: VueWrapper, testid: string, value: string) {
  await fieldElement(wrapper, testid).setValue(value)
  await settle()
}

function auditRowCount(wrapper: VueWrapper): number {
  return wrapper.findAll('[data-testid="audit-row"]').length
}

// =============================================================================================

describe('审计日志/团队统计 — 可见性（view === member，包含 claim_only）', () => {
  it('full 与 claim_only 都能看到两块；待批准与未登录都看不到，也不请求 events/stats', async () => {
    const full = await mountMember(ME_FULL)
    expect(node(full.wrapper, 'audit-section').exists()).toBe(true)
    expect(node(full.wrapper, 'stats-section').exists()).toBe(true)
    full.wrapper.unmount()

    const claimOnly = await mountMember(ME_CLAIM_ONLY)
    expect(node(claimOnly.wrapper, 'audit-section').exists()).toBe(true)
    expect(node(claimOnly.wrapper, 'stats-section').exists()).toBe(true)
    claimOnly.wrapper.unmount()

    const pending = await mountPending()
    expect(node(pending.wrapper, 'audit-section').exists()).toBe(false)
    expect(node(pending.wrapper, 'stats-section').exists()).toBe(false)
    expect(pending.calls.some((call) => call.url === '/api/v1/events')).toBe(false)
    expect(pending.calls.some((call) => call.url === '/api/v1/stats')).toBe(false)
    pending.wrapper.unmount()

    const login = await mountUnauthorized()
    expect(node(login.wrapper, 'audit-section').exists()).toBe(false)
    expect(node(login.wrapper, 'stats-section').exists()).toBe(false)
    expect(login.calls.some((call) => call.url === '/api/v1/events')).toBe(false)
    expect(login.calls.some((call) => call.url === '/api/v1/stats')).toBe(false)
  })
})

describe('审计日志/团队统计 — GET /api/v1/events 与 GET /api/v1/stats', () => {
  it('URL 恰好是 /api/v1/events 与 /api/v1/stats，无 query；credentials/Accept 与既有请求一致', async () => {
    const { calls } = await mountMember()
    const eventsCalls = calls.filter((call) => call.method === 'GET' && call.url === '/api/v1/events')
    const statsCalls = calls.filter((call) => call.method === 'GET' && call.url === '/api/v1/stats')
    expect(eventsCalls).toHaveLength(1)
    expect(statsCalls).toHaveLength(1)
    for (const call of [...eventsCalls, ...statsCalls]) {
      expect(call.credentials).toBe('include')
      expect(call.headers.accept).toBe('application/json')
    }
    expect(calls.some((call) => call.url.includes('?'))).toBe(false)
  })

  it('筛选不会重新发起 GET（过滤是纯客户端行为）', async () => {
    const { wrapper, calls } = await mountMember()
    expect(calls.filter((call) => call.url === '/api/v1/events')).toHaveLength(1)
    expect(calls.filter((call) => call.url === '/api/v1/stats')).toHaveLength(1)

    await setSelect(wrapper, 'audit-filter-type', '心跳')
    await setField(wrapper, 'audit-filter-task', 'kt-2026-0001')

    expect(calls.filter((call) => call.url === '/api/v1/events')).toHaveLength(1)
    expect(calls.filter((call) => call.url === '/api/v1/stats')).toHaveLength(1)
  })
})

describe('审计日志 — 类型/人/任务/时间 组合过滤（AND）', () => {
  it('无筛选时展示全部 7 条', async () => {
    const { wrapper } = await mountMember()
    expect(auditRowCount(wrapper)).toBe(EVENTS.length)
  })

  it('类型下拉包含全部现存 type 字面量（含 变更 与两种认领确认类型）', async () => {
    const { wrapper } = await mountMember()
    const values = optionValues(wrapper, 'audit-filter-type')
    expect(values[0]).toBe('')
    for (const type of LIVE_EVENT_TYPES) {
      expect(values).toContain(type)
    }
  })

  it('人下拉包含 系统 与真实用户名', async () => {
    const { wrapper } = await mountMember()
    const values = optionValues(wrapper, 'audit-filter-actor')
    expect(values).toContain(SYSTEM_ACTOR_LABEL)
    expect(values).toContain('zhang.wei')
    expect(values).toContain('li.na')
  })

  it('类型筛「心跳」只留 1 条', async () => {
    const { wrapper } = await mountMember()
    await setSelect(wrapper, 'audit-filter-type', '心跳')
    expect(auditRowCount(wrapper)).toBe(1)

    await setSelect(wrapper, 'audit-filter-type', '')
    expect(auditRowCount(wrapper)).toBe(EVENTS.length)
  })

  it('人筛「li.na」留 2 条；筛「系统」（空 actor）留 2 条', async () => {
    const { wrapper } = await mountMember()
    await setSelect(wrapper, 'audit-filter-actor', 'li.na')
    expect(auditRowCount(wrapper)).toBe(2)

    await setSelect(wrapper, 'audit-filter-actor', SYSTEM_ACTOR_LABEL)
    expect(auditRowCount(wrapper)).toBe(2)
  })

  it('任务筛「kt-2026-0004」留 2 条', async () => {
    const { wrapper } = await mountMember()
    await setField(wrapper, 'audit-filter-task', 'kt-2026-0004')
    expect(auditRowCount(wrapper)).toBe(2)
  })

  it('时间区间 [10:00, 10:45] 留 3 条', async () => {
    const { wrapper } = await mountMember()
    await setField(wrapper, 'audit-filter-from', '2026-08-21T10:00:00Z')
    await setField(wrapper, 'audit-filter-to', '2026-08-21T10:45:00Z')
    expect(auditRowCount(wrapper)).toBe(3)
  })

  it('组合(AND)：人=zhang.wei 且 类型=心跳，从 3 条收窄到 1 条', async () => {
    const { wrapper } = await mountMember()
    await setSelect(wrapper, 'audit-filter-actor', 'zhang.wei')
    expect(auditRowCount(wrapper)).toBe(3)

    await setSelect(wrapper, 'audit-filter-type', '心跳')
    expect(auditRowCount(wrapper)).toBe(1)
  })

  it('空事件列表仍渲染 audit-section，行数为 0', async () => {
    const { wrapper } = await mountMember(ME_FULL, { events: [] })
    expect(node(wrapper, 'audit-section').exists()).toBe(true)
    expect(auditRowCount(wrapper)).toBe(0)
  })
})

describe('团队统计 — completed_count 与逐人分布', () => {
  it('展示 completed_count 与按用户名（含「系统」）的分布', async () => {
    const { wrapper } = await mountMember()
    expect(textOf(wrapper, 'stats-completed-count')).toContain('4')
    const section = textOf(wrapper, 'stats-section')
    expect(section).toContain('zhang.wei')
    expect(section).toContain('li.na')
    expect(section).toContain(SYSTEM_ACTOR_LABEL)
  })

  it('空统计（无 已完成 事件）展示 0，不渲染任何用户行', async () => {
    const { wrapper } = await mountMember(ME_FULL, { stats: EMPTY_STATS })
    expect(textOf(wrapper, 'stats-completed-count')).toContain('0')
  })
})

describe('审计日志/团队统计 — 中文文案；不使用 vue-router', () => {
  it('标题文案是中文；不出现英文 Audit/Stats/Timeline', async () => {
    const { wrapper } = await mountMember()
    expect(textOf(wrapper, 'audit-section')).toContain('审计日志')
    expect(textOf(wrapper, 'stats-section')).toContain('团队统计')
    const chrome = `${textOf(wrapper, 'audit-section')}\n${textOf(wrapper, 'stats-section')}`
    expect(chrome).not.toContain('Audit')
    expect(chrome).not.toContain('Stats')
    expect(chrome).not.toContain('Timeline')
  })

  it('挂载时没有注入 vue-router', async () => {
    const { wrapper } = await mountMember()
    expect((wrapper.vm as unknown as { $router?: unknown }).$router).toBeUndefined()
  })
})
