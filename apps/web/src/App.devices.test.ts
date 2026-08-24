// Oracle for the 电脑 pane in App.vue (issue #23).
//
// Pins architecture §7 / DESIGN §3 §7 §11: nav 钥匙→电脑, drop Agent Key mint
// and the GitHub numeric-id 批准 widget, list/bind/revoke devices and claimants.
// JSON field names match apps/server/src/devices.test.ts.
//
// Judgment: keep data-testid="workbench-nav-keys" (and workbench-pane-keys) to
// limit shell churn; the visible label is 电脑. Empty-profile publish hint may
// still say 钥匙 (App.form.test.ts). Bind trap `token` on POST /bind is not a
// server field — it catches a UI that dumps the JSON body.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import naive, { NSelect } from 'naive-ui'
import { nextTick } from 'vue'
import App from './App.vue'

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
const ME_CLAIM_ONLY: Record<string, unknown> = {
  ...ME_FULL,
  provider: 'github',
  permission_level: 'claim_only',
}

const MINE_DEVICE = {
  id: 3,
  hostname: 'smoke-mac',
  fingerprint: 'aabbccddeeff0011deadbeefcafe0001aabbccddeeff0011deadbeefcafe0001',
  status: 'active',
  created_at: '2026-08-20T04:00:00.000Z',
  paired_at: '2026-08-20T04:01:00.000Z',
  expires_at: '2026-09-19T04:01:00.000Z',
  last_seen: '2026-08-21T04:00:00.000Z',
  owner: { kind: 'user', user_id: 7 },
}

const PENDING_DEVICE = {
  id: 11,
  hostname: 'ada-laptop',
  fingerprint: '1122334455667788aabbccddeeff00011122334455667788aabbccddeeff0001',
  created_at: '2026-08-21T03:00:00.000Z',
  expires_at: '2026-08-22T03:00:00.000Z',
}

const EXISTING_CLAIMANT = {
  id: 42,
  display_name: 'Ada Claimant',
  status: 'active',
  device_max_age_days: 30,
  max_devices: 5,
  device_idle_days: 0,
}

const BIND_TRAP_TOKEN = 'gitea-BIND-TRAP-TOKEN-zzq7'

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

type MountOpts = {
  mine?: typeof MINE_DEVICE[]
  pending?: typeof PENDING_DEVICE[]
  claimants?: typeof EXISTING_CLAIMANT[]
}

async function mountApp(me: Record<string, unknown> = ME_FULL, opts: MountOpts = {}) {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/me', () => jsonResponse(200, me))
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks: [] }))
  routes.set('GET /api/v1/events', () => jsonResponse(200, { events: [] }))
  routes.set('GET /api/v1/stats', () =>
    jsonResponse(200, { completed_count: 0, completed_by_username: {} }),
  )
  routes.set('GET /api/v1/claim-confirmations', () => jsonResponse(200, { confirmations: [] }))
  routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles: [] }))
  routes.set('GET /api/v1/me/devices', () =>
    jsonResponse(200, { devices: opts.mine ?? [MINE_DEVICE] }),
  )
  routes.set('GET /api/v1/devices/pending', () =>
    jsonResponse(200, { devices: opts.pending ?? [PENDING_DEVICE] }),
  )
  routes.set('GET /api/v1/claimants', () =>
    jsonResponse(200, { claimants: opts.claimants ?? [EXISTING_CLAIMANT] }),
  )

  const wrapper = mount(App, { global: { plugins: [naive] } })
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/me')).toBe(true)
  })
  await settle()
  if (me.status === 'active') {
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/tasks')).toBe(true)
    })
    await settle()
  }
  return { wrapper, calls, routes }
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

function expectMutationHeaders(call: FetchCall) {
  expect(call.credentials).toBe('include')
  expect(call.headers.accept).toBe('application/json')
  expect(call.headers['content-type']).toBe('application/json')
}

function deviceGets(calls: FetchCall[]) {
  return calls.filter((call) => call.method === 'GET' && call.url === '/api/v1/me/devices')
}

function pendingGets(calls: FetchCall[]) {
  return calls.filter((call) => call.method === 'GET' && call.url === '/api/v1/devices/pending')
}

function claimantGets(calls: FetchCall[]) {
  return calls.filter((call) => call.method === 'GET' && call.url === '/api/v1/claimants')
}

function agentKeyGets(calls: FetchCall[]) {
  return calls.filter((call) => call.url.startsWith('/api/v1/agent-keys'))
}

describe('登录文案', () => {
  it('不把 GitLab/Gitea 写成自动正式成员', async () => {
    const { wrapper } = await mountUnauthorized()
    expect(wrapper.text()).toContain('登录')
    expect(wrapper.text()).not.toMatch(/GitLab\s*\/\s*Gitea\s*为正式成员/)
    expect(wrapper.text()).not.toContain('GitLab / Gitea 为正式成员')
  })
})

describe('电脑页 — 去掉 Agent Key 与 GitHub 批准', () => {
  it('full+active：没有「生成 Agent Key」文案，也不请求 /api/v1/agent-keys', async () => {
    const { wrapper, calls } = await mountApp(ME_FULL)
    expect(wrapper.text()).not.toContain('生成 Agent Key')
    expect(wrapper.text()).not.toContain('暂无 Agent Key。')
    expect(agentKeyGets(calls)).toHaveLength(0)
  })

  it('没有 GitHub 数字 id 批准控件', async () => {
    const { wrapper } = await mountApp(ME_FULL)
    expect(node(wrapper, 'github-user-approve').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('批准 GitHub 用户')
    expect(wrapper.text()).not.toContain('GitHub 用户数字 id')
  })
})

describe('电脑页 — full+active 列表与绑定', () => {
  it('GET /api/v1/me/devices 填入 我的电脑（hostname / fingerprint / expires_at）', async () => {
    const { wrapper, calls } = await mountApp(ME_FULL)
    const gets = deviceGets(calls)
    expect(gets.length).toBeGreaterThanOrEqual(1)
    expect(gets[0].credentials).toBe('include')
    expect(gets[0].headers.accept).toBe('application/json')
    expect(gets[0].url).toBe('/api/v1/me/devices')

    expect(node(wrapper, 'devices-mine').exists()).toBe(true)
    const mine = textOf(wrapper, 'devices-mine')
    expect(mine).toContain('我的电脑')
    expect(mine).toContain(MINE_DEVICE.hostname)
    expect(mine).toContain(MINE_DEVICE.fingerprint.slice(0, 8))
    expect(mine).toContain(MINE_DEVICE.expires_at)
  })

  it('GET /api/v1/devices/pending 填入 待授权电脑，并带绑定控件', async () => {
    const { wrapper, calls } = await mountApp(ME_FULL)
    const gets = pendingGets(calls)
    expect(gets.length).toBeGreaterThanOrEqual(1)
    expect(gets[0].url).toBe('/api/v1/devices/pending')
    expect(gets[0].credentials).toBe('include')

    expect(claimantGets(calls).length).toBeGreaterThanOrEqual(1)
    expect(claimantGets(calls)[0].url).toBe('/api/v1/claimants')

    expect(node(wrapper, 'devices-pending').exists()).toBe(true)
    const pending = textOf(wrapper, 'devices-pending')
    expect(pending).toContain('待授权电脑')
    expect(pending).toContain(PENDING_DEVICE.hostname)
    expect(pending).toContain(PENDING_DEVICE.fingerprint.slice(0, 8))
    expect(pending).toContain(PENDING_DEVICE.expires_at)

    expect(node(wrapper, 'device-bind-claimant-name').exists()).toBe(true)
    expect(node(wrapper, 'device-bind-claimant-select').exists()).toBe(true)
    expect(node(wrapper, 'device-bind-self').exists()).toBe(true)
    expect(textOf(wrapper, 'device-bind-self')).toContain('绑到我自己')
  })

  it('空 我的电脑 列表显示 暂无已绑定的电脑。', async () => {
    const { wrapper } = await mountApp(ME_FULL, { mine: [] })
    expect(textOf(wrapper, 'devices-mine')).toContain('暂无已绑定的电脑。')
  })

  it('空认领者下拉提示输入显示名新建', async () => {
    const { wrapper } = await mountApp(ME_FULL, { claimants: [] })
    expect(wrapper.text()).toContain('暂无认领者，请输入显示名新建。')
  })

  it('绑到我自己 POST { bind_to_self: true }，成功响应即使带 trap token 也不展示 forge token', async () => {
    const { wrapper, calls, routes } = await mountApp(ME_FULL)
    routes.set(`POST /api/v1/devices/${PENDING_DEVICE.id}/bind`, () =>
      jsonResponse(200, {
        ok: true,
        device_id: PENDING_DEVICE.id,
        owner: { kind: 'user', user_id: 7 },
        token: BIND_TRAP_TOKEN,
      }),
    )
    routes.set('GET /api/v1/devices/pending', () => jsonResponse(200, { devices: [] }))
    routes.set('GET /api/v1/me/devices', () => jsonResponse(200, { devices: [MINE_DEVICE] }))

    await node(wrapper, 'device-bind-self').trigger('click')
    await settle()

    const posts = calls.filter(
      (call) =>
        call.method === 'POST' && call.url === `/api/v1/devices/${PENDING_DEVICE.id}/bind`,
    )
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ bind_to_self: true })
    expectMutationHeaders(posts[0])
    expect(wrapper.text()).not.toContain(BIND_TRAP_TOKEN)
    expect(wrapper.text()).not.toContain('生成 Agent Key')
  })

  it('认领者显示名提交 POST { claimant_display_name }，不展示 forge token', async () => {
    const { wrapper, calls, routes } = await mountApp(ME_FULL, { claimants: [] })
    routes.set(`POST /api/v1/devices/${PENDING_DEVICE.id}/bind`, () =>
      jsonResponse(200, {
        ok: true,
        device_id: PENDING_DEVICE.id,
        owner: { kind: 'claimant', claimant_id: 99, display_name: 'Ada Claimant' },
        token: BIND_TRAP_TOKEN,
      }),
    )

    await setField(wrapper, 'device-bind-claimant-name', 'Ada Claimant')
    expect(node(wrapper, 'device-bind-submit').exists()).toBe(true)
    await node(wrapper, 'device-bind-submit').trigger('click')
    await settle()

    const posts = calls.filter(
      (call) =>
        call.method === 'POST' && call.url === `/api/v1/devices/${PENDING_DEVICE.id}/bind`,
    )
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ claimant_display_name: 'Ada Claimant' })
    expectMutationHeaders(posts[0])
    expect(wrapper.text()).not.toContain(BIND_TRAP_TOKEN)
  })

  it('已有认领者下拉提交 POST { claimant_id }', async () => {
    const { wrapper, calls, routes } = await mountApp(ME_FULL)
    routes.set(`POST /api/v1/devices/${PENDING_DEVICE.id}/bind`, () =>
      jsonResponse(200, {
        ok: true,
        device_id: PENDING_DEVICE.id,
        owner: { kind: 'claimant', claimant_id: EXISTING_CLAIMANT.id },
      }),
    )

    await setSelect(wrapper, 'device-bind-claimant-select', EXISTING_CLAIMANT.id)
    await node(wrapper, 'device-bind-submit').trigger('click')
    await settle()

    const posts = calls.filter(
      (call) =>
        call.method === 'POST' && call.url === `/api/v1/devices/${PENDING_DEVICE.id}/bind`,
    )
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ claimant_id: EXISTING_CLAIMANT.id })
    expectMutationHeaders(posts[0])
  })

  it('解除这台电脑 POST /api/v1/devices/:id/revoke', async () => {
    const { wrapper, calls, routes } = await mountApp(ME_FULL)
    routes.set(`POST /api/v1/devices/${MINE_DEVICE.id}/revoke`, () => jsonResponse(200, { ok: true }))
    routes.set('GET /api/v1/me/devices', () => jsonResponse(200, { devices: [] }))

    expect(node(wrapper, 'device-revoke').exists()).toBe(true)
    expect(textOf(wrapper, 'device-revoke')).toContain('解除这台电脑')
    await node(wrapper, 'device-revoke').trigger('click')
    await settle()

    const posts = calls.filter(
      (call) =>
        call.method === 'POST' && call.url === `/api/v1/devices/${MINE_DEVICE.id}/revoke`,
    )
    expect(posts).toHaveLength(1)
    expectMutationHeaders(posts[0])
  })

  it('解除认领者 POST /api/v1/claimants/:id/revoke', async () => {
    const { wrapper, calls, routes } = await mountApp(ME_FULL)
    routes.set(`POST /api/v1/claimants/${EXISTING_CLAIMANT.id}/revoke`, () =>
      jsonResponse(200, { ok: true }),
    )
    routes.set('GET /api/v1/claimants', () => jsonResponse(200, { claimants: [] }))

    expect(node(wrapper, 'claimants-list').exists()).toBe(true)
    expect(textOf(wrapper, 'claimants-list')).toContain(EXISTING_CLAIMANT.display_name)
    expect(node(wrapper, 'claimant-revoke').exists()).toBe(true)
    expect(textOf(wrapper, 'claimant-revoke')).toContain('解除认领者')
    await node(wrapper, 'claimant-revoke').trigger('click')
    await settle()

    const posts = calls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url === `/api/v1/claimants/${EXISTING_CLAIMANT.id}/revoke`,
    )
    expect(posts).toHaveLength(1)
    expectMutationHeaders(posts[0])
  })
})

describe('电脑页 — #16 受信自动化仍在本页', () => {
  it('full+active 仍有 trusted-automation-toggle 与 claim-confirmation-list', async () => {
    const { wrapper } = await mountApp(ME_FULL)
    expect(node(wrapper, 'trusted-automation-toggle').exists()).toBe(true)
    expect(node(wrapper, 'claim-confirmation-list').exists()).toBe(true)
  })
})

describe('电脑页 — leftover claim_only 防御视图', () => {
  it('没有发布、没有待授权/绑定/认领者管理，也不拉 pending/me/devices/claimants', async () => {
    const { wrapper, calls } = await mountApp(ME_CLAIM_ONLY)
    expect(node(wrapper, 'workbench-nav-publish').exists()).toBe(false)
    expect(node(wrapper, 'devices-pending').exists()).toBe(false)
    expect(node(wrapper, 'device-bind-self').exists()).toBe(false)
    expect(node(wrapper, 'device-bind-claimant-name').exists()).toBe(false)
    expect(node(wrapper, 'device-bind-submit').exists()).toBe(false)
    expect(node(wrapper, 'claimants-list').exists()).toBe(false)
    expect(pendingGets(calls)).toHaveLength(0)
    expect(deviceGets(calls)).toHaveLength(0)
    expect(claimantGets(calls)).toHaveLength(0)
    expect(node(wrapper, 'trusted-automation-toggle').exists()).toBe(true)
  })
})
