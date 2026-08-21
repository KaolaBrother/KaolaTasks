// Oracle for the 受信自动化 (trusted_automation) settings widget + 待确认认领列表 in App.vue
// (issue #16). Neither exists yet, so these tests define their observable surface.
//
// Contract pinned by kaola-workflow/bundle-15-16/.cache/orchestrator-rulings.md §16 +
// kaola-workflow/bundle-15-16/.cache/tests-claim-confirm.md (read that before implementing):
//   - GET /api/v1/me gains an additive `trusted_automation: boolean` field (default false);
//     existing stubs that omit it (see App.board.test.ts / App.form.test.ts) must keep working,
//     which this file also pins directly.
//   - PUT /api/v1/me/settings { trusted_automation } -> 200 { trusted_automation }.
//   - GET /api/v1/claim-confirmations -> { confirmations: [{ id, task_id, state, created_at }] }.
//   - POST /api/v1/claim-confirmations/:id/approve|reject -> 200.
//   - The whole widget is gated like canManageKeys (any active user, full or claim_only);
//     hidden on the pending/login views, alongside the existing Agent Key widget.
//   - data-testid contract: trusted-automation-toggle, claim-confirmation-list,
//     claim-confirmation-approve (repeats per row), claim-confirmation-reject (repeats per row).
//
// Judgment call (recorded here, not elsewhere): the toggle is implemented as `n-switch`
// (the only naive-ui boolean control used anywhere in this codebase), driven the same way every
// other naive-ui control here is driven — `v-model:value` / `update:value` emit — exactly like
// `board-filter-status`'s n-select. Fetch pattern is copied from the existing
// `credentials: 'include'` + `Accept: application/json` + defensive `readJson()` convention.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import naive, { NSwitch } from 'naive-ui'
import { nextTick } from 'vue'
import App from './App.vue'

// --- fixtures ------------------------------------------------------------------------------

const ME_FULL: Record<string, unknown> = {
  id: 7,
  provider: 'gitlab',
  remote_id: '7',
  username: 'zhang.wei',
  display_name: '张伟',
  status: 'active',
  permission_level: 'full',
  trusted_automation: false,
}
const ME_CLAIM_ONLY: Record<string, unknown> = { ...ME_FULL, provider: 'github', permission_level: 'claim_only' }
const ME_PENDING: Record<string, unknown> = { ...ME_CLAIM_ONLY, status: '待批准' }

// A legacy /api/v1/me response predating this issue: no trusted_automation key at all.
const ME_FULL_LEGACY: Record<string, unknown> = { ...ME_FULL }
delete ME_FULL_LEGACY.trusted_automation

type Confirmation = { id: number; task_id: string; state: string; created_at: string }

const PENDING_CONFIRMATION: Confirmation = {
  id: 501,
  task_id: 'kt-2026-0001',
  state: 'pending',
  created_at: '2026-08-21T08:00:00Z',
}

// --- fetch stub ----------------------------------------------------------------------------
//
// One router keyed on `${METHOD} ${url}`. Every call is recorded verbatim so the header and
// URL contracts can be asserted. An unrouted call answers 500 { error: 'unstubbed' } and stays
// in `calls`, so an unexpected outbound request can never pass silently.

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

async function mountApp(
  me: Record<string, unknown> = ME_FULL,
  options: { confirmations?: Confirmation[] } = {},
) {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/me', () => jsonResponse(200, me))
  routes.set('GET /api/v1/agent-keys', () => jsonResponse(200, { keys: [] }))
  routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles: [] }))
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks: [] }))
  routes.set('GET /api/v1/claim-confirmations', () =>
    jsonResponse(200, { confirmations: options.confirmations ?? [] }),
  )
  routes.set('PUT /api/v1/me/settings', () => jsonResponse(200, { trusted_automation: true }))

  const wrapper = mount(App, { global: { plugins: [naive] } })
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/me')).toBe(true)
  })
  await settle()
  if (me.status === 'active') {
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/claim-confirmations')).toBe(true)
    })
    await settle()
  }
  return { wrapper, calls, routes }
}

async function mountUnauthorized() {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/me', () => jsonResponse(401, { error: 'unauthorized' }))
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks: [] }))
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

function switchOf(wrapper: VueWrapper, testid: string) {
  const found = wrapper
    .findAllComponents(NSwitch)
    .find((candidate) => candidate.attributes('data-testid') === testid)
  if (found == null) throw new Error(`no n-switch with data-testid="${testid}"`)
  return found
}

async function setSwitch(wrapper: VueWrapper, testid: string, value: boolean) {
  switchOf(wrapper, testid).vm.$emit('update:value', value)
  await nextTick()
  await settle()
}

function approveButtons(wrapper: VueWrapper) {
  return wrapper.findAll('[data-testid="claim-confirmation-approve"]')
}

function rejectButtons(wrapper: VueWrapper) {
  return wrapper.findAll('[data-testid="claim-confirmation-reject"]')
}

// =============================================================================================

describe('受信自动化设置 — 可见性（gated like canManageKeys）', () => {
  it('active 的 full 与 claim_only 都能看到开关与待确认列表；待批准与未登录都看不到，也不会请求这两个新接口', async () => {
    const full = await mountApp(ME_FULL)
    expect(node(full.wrapper, 'trusted-automation-toggle').exists()).toBe(true)
    expect(node(full.wrapper, 'claim-confirmation-list').exists()).toBe(true)
    full.wrapper.unmount()

    const claimOnly = await mountApp(ME_CLAIM_ONLY)
    expect(node(claimOnly.wrapper, 'trusted-automation-toggle').exists()).toBe(true)
    expect(node(claimOnly.wrapper, 'claim-confirmation-list').exists()).toBe(true)
    claimOnly.wrapper.unmount()

    const pending = await mountApp(ME_PENDING)
    expect(pending.wrapper.text()).toContain('账号待批准')
    expect(node(pending.wrapper, 'trusted-automation-toggle').exists()).toBe(false)
    expect(node(pending.wrapper, 'claim-confirmation-list').exists()).toBe(false)
    expect(pending.calls.some((call) => call.url === '/api/v1/me/settings')).toBe(false)
    expect(pending.calls.some((call) => call.url === '/api/v1/claim-confirmations')).toBe(false)
    pending.wrapper.unmount()

    const login = await mountUnauthorized()
    expect(login.wrapper.text()).toContain('登录')
    expect(node(login.wrapper, 'trusted-automation-toggle').exists()).toBe(false)
    expect(node(login.wrapper, 'claim-confirmation-list').exists()).toBe(false)
    expect(login.calls.some((call) => call.url === '/api/v1/me/settings')).toBe(false)
    expect(login.calls.some((call) => call.url === '/api/v1/claim-confirmations')).toBe(false)
    login.wrapper.unmount()
  })

  it('GET /api/v1/me 缺省 trusted_automation 字段时（既有 stub 场景）仍渲染，开关默认关闭', async () => {
    const { wrapper } = await mountApp(ME_FULL_LEGACY)
    expect(node(wrapper, 'trusted-automation-toggle').exists()).toBe(true)
    expect(switchOf(wrapper, 'trusted-automation-toggle').props('value')).toBe(false)
  })
})

describe('受信自动化设置 — PUT /api/v1/me/settings', () => {
  it('打开开关会 PUT { trusted_automation: true }（credentials include），并按服务端返回值刷新显示', async () => {
    const { wrapper, calls, routes } = await mountApp(ME_FULL)
    routes.set('PUT /api/v1/me/settings', () => jsonResponse(200, { trusted_automation: true }))
    expect(switchOf(wrapper, 'trusted-automation-toggle').props('value')).toBe(false)

    await setSwitch(wrapper, 'trusted-automation-toggle', true)

    const puts = calls.filter((call) => call.method === 'PUT' && call.url === '/api/v1/me/settings')
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toEqual({ trusted_automation: true })
    expect(puts[0].credentials).toBe('include')
    expect(puts[0].headers.accept).toBe('application/json')
    expect(switchOf(wrapper, 'trusted-automation-toggle').props('value')).toBe(true)
  })

  it('关闭开关同理：PUT { trusted_automation: false }', async () => {
    const { wrapper, calls, routes } = await mountApp({ ...ME_FULL, trusted_automation: true })
    routes.set('PUT /api/v1/me/settings', () => jsonResponse(200, { trusted_automation: false }))
    expect(switchOf(wrapper, 'trusted-automation-toggle').props('value')).toBe(true)

    await setSwitch(wrapper, 'trusted-automation-toggle', false)

    const puts = calls.filter((call) => call.method === 'PUT' && call.url === '/api/v1/me/settings')
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toEqual({ trusted_automation: false })
    expect(switchOf(wrapper, 'trusted-automation-toggle').props('value')).toBe(false)
  })
})

describe('待确认认领列表 — GET /api/v1/claim-confirmations 与批准/拒绝', () => {
  it('渲染待确认行（含任务 id）；批准按钮 POST 对应 approve 路由并刷新列表', async () => {
    const { wrapper, calls, routes } = await mountApp(ME_FULL, { confirmations: [PENDING_CONFIRMATION] })
    expect(textOf(wrapper, 'claim-confirmation-list')).toContain(PENDING_CONFIRMATION.task_id)
    expect(approveButtons(wrapper)).toHaveLength(1)
    expect(rejectButtons(wrapper)).toHaveLength(1)

    routes.set(`POST /api/v1/claim-confirmations/${PENDING_CONFIRMATION.id}/approve`, () =>
      jsonResponse(200, { ok: true }),
    )
    routes.set('GET /api/v1/claim-confirmations', () => jsonResponse(200, { confirmations: [] }))

    await approveButtons(wrapper)[0].trigger('click')
    await settle()

    const posts = calls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url === `/api/v1/claim-confirmations/${PENDING_CONFIRMATION.id}/approve`,
    )
    expect(posts).toHaveLength(1)
    expect(posts[0].credentials).toBe('include')
    expect(approveButtons(wrapper)).toHaveLength(0)
    expect(textOf(wrapper, 'claim-confirmation-list')).not.toContain(PENDING_CONFIRMATION.task_id)
  })

  it('拒绝按钮 POST 对应 reject 路由并刷新列表', async () => {
    const { wrapper, calls, routes } = await mountApp(ME_FULL, { confirmations: [PENDING_CONFIRMATION] })
    routes.set(`POST /api/v1/claim-confirmations/${PENDING_CONFIRMATION.id}/reject`, () =>
      jsonResponse(200, { ok: true }),
    )
    routes.set('GET /api/v1/claim-confirmations', () => jsonResponse(200, { confirmations: [] }))

    await rejectButtons(wrapper)[0].trigger('click')
    await settle()

    const posts = calls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url === `/api/v1/claim-confirmations/${PENDING_CONFIRMATION.id}/reject`,
    )
    expect(posts).toHaveLength(1)
    expect(rejectButtons(wrapper)).toHaveLength(0)
  })

  it('空列表时仍渲染 claim-confirmation-list 容器，且没有任何操作按钮', async () => {
    const { wrapper } = await mountApp(ME_FULL, { confirmations: [] })
    expect(node(wrapper, 'claim-confirmation-list').exists()).toBe(true)
    expect(approveButtons(wrapper)).toHaveLength(0)
    expect(rejectButtons(wrapper)).toHaveLength(0)
  })
})

describe('拉取路径与请求头约定', () => {
  it('claim-confirmations 的 URL 恰好是 /api/v1/claim-confirmations（无 query），credentials 与 Accept 头符合既有约定', async () => {
    const { calls } = await mountApp(ME_FULL, { confirmations: [PENDING_CONFIRMATION] })
    const getConfirmations = calls.find(
      (call) => call.method === 'GET' && call.url === '/api/v1/claim-confirmations',
    )
    expect(getConfirmations).toBeTruthy()
    expect(getConfirmations?.credentials).toBe('include')
    expect(getConfirmations?.headers.accept).toBe('application/json')
  })
})
