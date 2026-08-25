// Oracle for the Eucalyptus Ink workbench shell (issue #18).
//
// Pins the additive behavioral surface in
// kaola-workflow/issue-18/.cache/orchestrator-rulings.md §10. The four existing
// App.*.test.ts files stay untouched. Judgement calls (testid names, CSS variable
// names, PATCH headers) are written up in
// kaola-workflow/issue-18/.cache/tests-shell.md — read that before implementing.
//
// Tests mount App.vue (not main.ts). CSS tokens must therefore take effect on
// document.documentElement or document.body after a member mount — import
// theme.css from App.vue as well as main.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import naive, { NSelect } from 'naive-ui'
import { nextTick } from 'vue'
import App from './App.vue'

// --- fixtures ------------------------------------------------------------------------------

const FORGE_BASE_URL = 'https://gitea.forge.example.test'

const ME_FULL = {
  id: 7,
  provider: 'gitlab',
  remote_id: '7',
  username: 'zhang.wei',
  display_name: '张伟',
  status: 'active',
  permission_level: 'full',
}
const ME_ADMIN = {
  ...ME_FULL,
  id: 1,
  provider: 'local',
  remote_id: 'local',
  username: 'kaola-admin',
  display_name: 'kaola-admin',
  permission_level: 'admin',
}
const ME_CLAIM_ONLY = { ...ME_FULL, provider: 'github', permission_level: 'claim_only' }
const ME_PENDING = { ...ME_CLAIM_ONLY, status: '待批准' }

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

// Usernames match App.board.test.ts: ME_FULL.username === 'zhang.wei'.
const TASK_MINE_OPEN = makeBrief({
  id: 'kt-2026-0101',
  title: '发布者自己的待认领任务',
  status: '待认领',
  poster: 'zhang.wei',
})
const TASK_MINE_RETURNED = makeBrief({
  id: 'kt-2026-0102',
  title: '发布者自己的已退回任务',
  status: '已退回',
  poster: 'zhang.wei',
})
const TASK_OTHER_OPEN = makeBrief({
  id: 'kt-2026-0103',
  title: '别人发布的待认领任务',
  status: '待认领',
  poster: 'someone.else',
})
const TASK_MINE_PROGRESS = makeBrief({
  id: 'kt-2026-0104',
  title: '发布者自己的进行中任务',
  status: '进行中',
  poster: 'zhang.wei',
})

const POSTER_TASKS = [TASK_MINE_OPEN, TASK_MINE_RETURNED, TASK_OTHER_OPEN, TASK_MINE_PROGRESS]

// --- fetch stub ----------------------------------------------------------------------------
//
// One router keyed on `${METHOD} ${url}`. Unrouted calls answer 500 { error: 'unstubbed' }.
// Member view GETs are all stubbed so an unstubbed 500 cannot masquerade as a missing-testid.

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

function stubMemberGets(
  routes: Map<string, Handler>,
  me: Record<string, unknown>,
  tasks: Brief[],
) {
  routes.set('GET /api/v1/setup', () => jsonResponse(200, { setup_complete: true }))
  routes.set('GET /api/v1/me', () => jsonResponse(200, me))
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks }))
  routes.set('GET /api/v1/events', () => jsonResponse(200, { events: [] }))
  routes.set('GET /api/v1/stats', () =>
    jsonResponse(200, { completed_count: 0, completed_by_username: {} }),
  )
  routes.set('GET /api/v1/agent-keys', () => jsonResponse(200, { keys: [] }))
  routes.set('GET /api/v1/claim-confirmations', () => jsonResponse(200, { confirmations: [] }))
  routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles: [] }))
  routes.set('GET /api/v1/me/devices', () => jsonResponse(200, { devices: [] }))
  routes.set('GET /api/v1/devices/pending', () => jsonResponse(200, { devices: [] }))
  routes.set('GET /api/v1/claimants', () => jsonResponse(200, { claimants: [] }))
}

async function mountApp(me: Record<string, unknown> = ME_FULL, tasks: Brief[] = []) {
  const { calls, routes } = installFetch()
  stubMemberGets(routes, me, tasks)

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
  if (me.status === 'active' && (me.permission_level === 'full' || me.permission_level === 'admin')) {
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/credential-profiles')).toBe(true)
    })
    await settle()
  }
  return { wrapper, calls, routes }
}

async function mountUnauthorized(setupComplete = true) {
  const { calls, routes } = installFetch()
  stubMemberGets(routes, ME_FULL, [])
  routes.set('GET /api/v1/setup', () => jsonResponse(200, { setup_complete: setupComplete }))
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

function fieldValue(wrapper: VueWrapper, testid: string): string {
  return (fieldElement(wrapper, testid).element as HTMLInputElement | HTMLTextAreaElement).value
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

async function openDetail(wrapper: VueWrapper, id: string) {
  const found = node(wrapper, `board-card-${id}`)
  if (!found.exists()) throw new Error(`missing [data-testid="board-card-${id}"]`)
  await found.trigger('click')
  await settle()
}

function patchCalls(calls: FetchCall[], id: string): FetchCall[] {
  return calls.filter((call) => call.method === 'PATCH' && call.url === `/api/v1/tasks/${id}`)
}

function tokenVar(name: string): string {
  const fromRoot = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (fromRoot !== '') return fromRoot
  return getComputedStyle(document.body).getPropertyValue(name).trim()
}

async function chooseForgeWithEmptyBaseUrl(
  wrapper: VueWrapper,
  forge: 'github' | 'gitlab' | 'gitea',
) {
  const other: 'github' | 'gitlab' | 'gitea' = forge === 'gitea' ? 'github' : 'gitea'
  await setSelect(wrapper, 'profile-forge', other)
  await setField(wrapper, 'profile-base-url', '')
  await settle()
  await setSelect(wrapper, 'profile-forge', forge)
  await settle()
}

function stubPatch(routes: Map<string, Handler>, brief: Brief, status: string) {
  routes.set(`PATCH /api/v1/tasks/${brief.id}`, () => jsonResponse(200, { ...brief, status }))
}

function expectMutationHeaders(call: FetchCall) {
  expect(call.credentials).toBe('include')
  expect(call.headers.accept).toBe('application/json')
  expect(call.headers['content-type']).toBe('application/json')
}

function expectNoClaimOrLogout(wrapper: VueWrapper) {
  expect(node(wrapper, 'board-detail-claim').exists()).toBe(false)
  expect(node(wrapper, 'logout').exists()).toBe(false)
}

function expectNeitherPosterButton(wrapper: VueWrapper) {
  expect(node(wrapper, 'board-detail-cancel').exists()).toBe(false)
  expect(node(wrapper, 'board-detail-reopen').exists()).toBe(false)
}

// =============================================================================================

describe('登录卡 — 设置向导 vs 发布者登录', () => {
  it('setup_complete: false 展示用户名密码向导，没有三家 OAuth 可用入口', async () => {
    const { wrapper, calls } = await mountUnauthorized(false)
    expect(calls.some((call) => call.url === '/api/v1/setup')).toBe(true)
    expect(wrapper.text()).toMatch(/用户名/)
    expect(wrapper.text()).toMatch(/密码/)
    expect(wrapper.find('a[href="/login/github"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/login/gitlab"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/login/gitea"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('setup_complete: true 展示本地登录 + GitLab/Gitea，没有 GitHub 登录按钮', async () => {
    const { wrapper } = await mountUnauthorized(true)
    expect(wrapper.find('a[href="/login/gitlab"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/login/gitea"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/login/github"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('使用 GitHub 登录')
    expect(wrapper.text()).toMatch(/密码/)
    wrapper.unmount()
  })
})

describe('头栏身份文案', () => {
  it('admin 显示管理员；full 显示发布者', async () => {
    const admin = await mountApp(ME_ADMIN)
    expect(admin.wrapper.text()).toContain('管理员')
    expect(admin.wrapper.text()).not.toContain('正式成员')
    admin.wrapper.unmount()

    const full = await mountApp(ME_FULL)
    expect(full.wrapper.text()).toContain('发布者')
    expect(full.wrapper.text()).not.toContain('正式成员')
    full.wrapper.unmount()
  })

  it('admin 与 full 都有发布导航', async () => {
    const admin = await mountApp(ME_ADMIN)
    expect(node(admin.wrapper, 'workbench-nav-publish').exists()).toBe(true)
    admin.wrapper.unmount()
    const full = await mountApp(ME_FULL)
    expect(node(full.wrapper, 'workbench-nav-publish').exists()).toBe(true)
    full.wrapper.unmount()
  })
})

describe('Workbench nav', () => {
  it('full+active：workbench-nav 与四项都在，文案含看板/发布/电脑/审计；pending 与 login 没有 workbench-nav', async () => {
    const full = await mountApp(ME_FULL)
    expect(node(full.wrapper, 'workbench-nav').exists()).toBe(true)
    expect(node(full.wrapper, 'workbench-nav-board').exists()).toBe(true)
    expect(node(full.wrapper, 'workbench-nav-publish').exists()).toBe(true)
    expect(node(full.wrapper, 'workbench-nav-keys').exists()).toBe(true)
    expect(node(full.wrapper, 'workbench-nav-audit').exists()).toBe(true)
    expect(textOf(full.wrapper, 'workbench-nav-board')).toContain('看板')
    expect(textOf(full.wrapper, 'workbench-nav-publish')).toContain('发布')
    expect(textOf(full.wrapper, 'workbench-nav-keys')).toContain('电脑')
    expect(textOf(full.wrapper, 'workbench-nav-keys')).not.toContain('钥匙')
    expect(textOf(full.wrapper, 'workbench-nav-audit')).toContain('审计')
    full.wrapper.unmount()

    const pending = await mountApp(ME_PENDING)
    expect(node(pending.wrapper, 'workbench-nav').exists()).toBe(false)
    pending.wrapper.unmount()

    const login = await mountUnauthorized()
    expect(node(login.wrapper, 'workbench-nav').exists()).toBe(false)
    login.wrapper.unmount()
  })

  it('claim_only+active：看板/电脑/审计导航存在，没有 workbench-nav-publish', async () => {
    const { wrapper } = await mountApp(ME_CLAIM_ONLY)
    expect(node(wrapper, 'workbench-nav').exists()).toBe(true)
    expect(node(wrapper, 'workbench-nav-board').exists()).toBe(true)
    expect(node(wrapper, 'workbench-nav-keys').exists()).toBe(true)
    expect(node(wrapper, 'workbench-nav-audit').exists()).toBe(true)
    expect(textOf(wrapper, 'workbench-nav-board')).toContain('看板')
    expect(textOf(wrapper, 'workbench-nav-keys')).toContain('电脑')
    expect(textOf(wrapper, 'workbench-nav-keys')).not.toContain('钥匙')
    expect(textOf(wrapper, 'workbench-nav-audit')).toContain('审计')
    expect(node(wrapper, 'workbench-nav-publish').exists()).toBe(false)
  })

  it('默认面板是看板：workbench-pane-board 与 board 在；full 的 task-form 不点发布也 exists；四块 pane 都在 DOM', async () => {
    const { wrapper } = await mountApp(ME_FULL)
    expect(node(wrapper, 'workbench-pane-board').exists()).toBe(true)
    expect(node(wrapper, 'board').exists()).toBe(true)
    expect(node(wrapper, 'task-form').exists()).toBe(true)
    expect(node(wrapper, 'workbench-pane-publish').exists()).toBe(true)
    expect(node(wrapper, 'workbench-pane-keys').exists()).toBe(true)
    expect(node(wrapper, 'workbench-pane-audit').exists()).toBe(true)
  })
})

describe('Form groups', () => {
  it('full 用户四个 task-group-* 都在，且没有验收分组与附加字段', async () => {
    const { wrapper } = await mountApp(ME_FULL)
    expect(node(wrapper, 'task-group-task').exists()).toBe(true)
    expect(node(wrapper, 'task-group-repo').exists()).toBe(true)
    expect(node(wrapper, 'task-group-advanced').exists()).toBe(true)
    expect(node(wrapper, 'task-group-credential').exists()).toBe(true)
    expect(node(wrapper, 'task-group-acceptance').exists()).toBe(false)
    for (const testid of [
      'task-acceptance-criteria',
      'task-test-command',
      'task-allowed-paths',
      'task-forbidden-paths',
      'task-priority',
      'task-tags',
    ]) {
      expect({ testid, exists: node(wrapper, testid).exists() }).toEqual({ testid, exists: false })
    }
  })

  it('task-group-advanced 默认关闭，且分支/目录输入仍在文档', async () => {
    const { wrapper } = await mountApp(ME_FULL)
    const advanced = node(wrapper, 'task-group-advanced')
    expect(advanced.exists()).toBe(true)
    expect((advanced.element as HTMLDetailsElement).open).toBeFalsy()
    expect(fieldElement(wrapper, 'task-base-branch').exists()).toBe(true)
    expect(fieldElement(wrapper, 'task-suggested-dir').exists()).toBe(true)
  })
})

describe('Credential profile prefills', () => {
  it('凭证档案行有 profile-forge / base-url / repo / token / submit，且 token 是 password', async () => {
    const { wrapper } = await mountApp(ME_FULL)
    expect(node(wrapper, 'profile-forge').exists()).toBe(true)
    expect(node(wrapper, 'profile-base-url').exists()).toBe(true)
    expect(node(wrapper, 'profile-repo').exists()).toBe(true)
    expect(node(wrapper, 'profile-token').exists()).toBe(true)
    expect(node(wrapper, 'profile-submit').exists()).toBe(true)
    expect(fieldElement(wrapper, 'profile-token').attributes('type')).toBe('password')
  })

  it('空 base_url：github → https://github.com，gitlab → https://gitlab.com，gitea 保持为空', async () => {
    const { wrapper } = await mountApp(ME_FULL)

    await chooseForgeWithEmptyBaseUrl(wrapper, 'github')
    expect(fieldValue(wrapper, 'profile-base-url')).toBe('https://github.com')

    await chooseForgeWithEmptyBaseUrl(wrapper, 'gitlab')
    expect(fieldValue(wrapper, 'profile-base-url')).toBe('https://gitlab.com')

    await chooseForgeWithEmptyBaseUrl(wrapper, 'gitea')
    expect(fieldValue(wrapper, 'profile-base-url')).toBe('')
    expect(fieldValue(wrapper, 'profile-base-url')).not.toBe('https://github.com')
    expect(fieldValue(wrapper, 'profile-base-url')).not.toBe('https://gitlab.com')
  })

  it('用户已输入非空 base_url 时切换 forge 不覆盖', async () => {
    const { wrapper } = await mountApp(ME_FULL)
    const typed = 'https://git.corp.example.test'
    await setField(wrapper, 'profile-base-url', typed)
    await setSelect(wrapper, 'profile-forge', 'github')
    expect(fieldValue(wrapper, 'profile-base-url')).toBe(typed)
    await setSelect(wrapper, 'profile-forge', 'gitlab')
    expect(fieldValue(wrapper, 'profile-base-url')).toBe(typed)
    await setSelect(wrapper, 'profile-forge', 'gitea')
    expect(fieldValue(wrapper, 'profile-base-url')).toBe(typed)
  })
})

describe('Poster PATCH', () => {
  it('发布者+full+待认领：取消存在、重新开放不在；点击发恰好一次 PATCH 已取消；2xx 后详情状态更新；非发布者/claim_only/进行中都没有按钮；无 claim/logout testid', async () => {
    const mine = await mountApp(ME_FULL, POSTER_TASKS)
    stubPatch(mine.routes, TASK_MINE_OPEN, '已取消')
    await openDetail(mine.wrapper, TASK_MINE_OPEN.id)

    expect(node(mine.wrapper, 'board-detail-cancel').exists()).toBe(true)
    expect(node(mine.wrapper, 'board-detail-reopen').exists()).toBe(false)
    expect(textOf(mine.wrapper, 'board-detail-cancel')).toContain('取消')
    expectNoClaimOrLogout(mine.wrapper)

    expect(patchCalls(mine.calls, TASK_MINE_OPEN.id)).toHaveLength(0)
    await node(mine.wrapper, 'board-detail-cancel').trigger('click')
    await settle()

    const patches = patchCalls(mine.calls, TASK_MINE_OPEN.id)
    expect(patches).toHaveLength(1)
    expect(patches[0].url).toBe(`/api/v1/tasks/${TASK_MINE_OPEN.id}`)
    expect(patches[0].method).toBe('PATCH')
    expectMutationHeaders(patches[0])
    expect(patches[0].body).toEqual({ status: '已取消' })
    expect(textOf(mine.wrapper, 'board-detail-status')).toContain('已取消')
    expect(
      mine.calls.filter(
        (call) => call.method === 'GET' && call.url === `/api/v1/tasks/${TASK_MINE_OPEN.id}`,
      ),
    ).toHaveLength(0)
    mine.wrapper.unmount()

    const other = await mountApp(ME_FULL, POSTER_TASKS)
    await openDetail(other.wrapper, TASK_OTHER_OPEN.id)
    expectNeitherPosterButton(other.wrapper)
    expectNoClaimOrLogout(other.wrapper)
    other.wrapper.unmount()

    const claimOnly = await mountApp(ME_CLAIM_ONLY, POSTER_TASKS)
    await openDetail(claimOnly.wrapper, TASK_MINE_OPEN.id)
    expectNeitherPosterButton(claimOnly.wrapper)
    expectNoClaimOrLogout(claimOnly.wrapper)
    claimOnly.wrapper.unmount()

    const progress = await mountApp(ME_FULL, POSTER_TASKS)
    await openDetail(progress.wrapper, TASK_MINE_PROGRESS.id)
    expectNeitherPosterButton(progress.wrapper)
    expectNoClaimOrLogout(progress.wrapper)
    progress.wrapper.unmount()
  })

  it('发布者+full+已退回：取消与重新开放都在；重新开放恰好一次 PATCH 待认领，2xx 后详情状态更新', async () => {
    const { wrapper, calls, routes } = await mountApp(ME_FULL, POSTER_TASKS)
    stubPatch(routes, TASK_MINE_RETURNED, '待认领')
    await openDetail(wrapper, TASK_MINE_RETURNED.id)

    expect(node(wrapper, 'board-detail-cancel').exists()).toBe(true)
    expect(node(wrapper, 'board-detail-reopen').exists()).toBe(true)
    expect(textOf(wrapper, 'board-detail-cancel')).toContain('取消')
    expect(textOf(wrapper, 'board-detail-reopen')).toContain('重新开放')
    expectNoClaimOrLogout(wrapper)

    await node(wrapper, 'board-detail-reopen').trigger('click')
    await settle()

    const patches = patchCalls(calls, TASK_MINE_RETURNED.id)
    expect(patches).toHaveLength(1)
    expect(patches[0].url).toBe(`/api/v1/tasks/${TASK_MINE_RETURNED.id}`)
    expect(patches[0].method).toBe('PATCH')
    expectMutationHeaders(patches[0])
    expect(patches[0].body).toEqual({ status: '待认领' })
    expect(textOf(wrapper, 'board-detail-status')).toContain('待认领')
  })
})

describe('Theme tokens loaded', () => {
  it('成员挂载后 :root 或 body 上 --motion-fast 为 120ms，且 --paper / --leaf 有值', async () => {
    await mountApp(ME_FULL)
    expect(tokenVar('--motion-fast')).toBe('120ms')
    expect(tokenVar('--paper')).not.toBe('')
    expect(tokenVar('--leaf')).not.toBe('')
  })
})
