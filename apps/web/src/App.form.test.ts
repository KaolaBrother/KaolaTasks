// Oracle for the 发布任务 form in App.vue (issue #7).
//
// The form does not exist yet, so these tests define its observable surface. The data-testid
// contract, the fetch stub and every judgement call are written up in
// kaola-workflow/issue-7/.cache/tests-web.md — read that before implementing.
//
// The wire format asserted here is the one apps/server/src/tasks.ts actually implements:
// snake_case bodies, a request-side credential union of { profile_id } XOR { token } (which is
// deliberately NOT the brief-side { profile_id } | { inline: true }), and the Chinese strings
// copied character for character out of the server module.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import naive, { NSelect } from 'naive-ui'
import { nextTick } from 'vue'
import App from './App.vue'

// --- Chinese copy owned by the server (apps/server/src/tasks.ts) ----------------------------

const TOKEN_INVALID_MESSAGE = 'token 无效或无权访问该仓库，任务未发布。'
const FORGE_UNREACHABLE_MESSAGE = '无法连接 forge 校验 token，任务未发布。'
const PROFILE_MISSING_MESSAGE = '所选凭证档案不存在。'
const tokenInsufficientMessage = (missing: string[]) =>
  `token 权限不足：缺少 ${missing.join('、')} 权限，任务未发布。`

// Chinese copy this suite pins on the client, following the existing createProfile idiom.
const VAULT_UNCONFIGURED_MESSAGE = '凭证保险库未配置'
const GENERIC_FAILURE_MESSAGE = (status: number) => `发布失败（${status}）`

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

const CREATED_ID = 'kt-2026-0042'
const CREATED_BRIEF = {
  id: CREATED_ID,
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
  pr_convention: { branch_prefix: `kaola/${CREATED_ID}-`, title_prefix: `[${CREATED_ID}] ` },
  credential: { profile_id: '3' },
  priority: 'P2',
  tags: [],
  poster: 'zhang.wei',
  status: '待认领',
  created_at: '2026-08-21T08:00:00Z',
}

// --- fetch stub ----------------------------------------------------------------------------
//
// One router keyed on `${METHOD} ${url}`. Every call is recorded verbatim so the header and
// body contracts can be asserted. An unrouted call answers 500 { error: 'unstubbed' } and stays
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

// Drains the microtask queue and re-renders. Deliberately generous: the handler chain under test
// is fetch -> readJson -> optional follow-up load -> render, and the suite must not be sensitive
// to how many awaits deep that is.
async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await flushPromises()
    await nextTick()
  }
}

// --- mount helper --------------------------------------------------------------------------

async function mountApp(me: Record<string, unknown> = ME_FULL) {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/me', () => jsonResponse(200, me))
  routes.set('GET /api/v1/agent-keys', () => jsonResponse(200, { keys: [] }))
  routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles: PROFILES }))
  // Registered defensively: a task board is not required by these tests, but an implementer who
  // adds one to onMounted must not trip the unstubbed-call guard.
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks: [] }))
  routes.set('POST /api/v1/tasks', () => jsonResponse(201, CREATED_BRIEF))

  const wrapper = mount(App, { global: { plugins: [naive] } })
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/me')).toBe(true)
  })
  await settle()
  // A full member's onMounted also loads the credential profiles the task form's dropdown reuses;
  // waiting for that call keeps the harness deterministic instead of tick-counting.
  if (me.status === 'active' && me.permission_level === 'full') {
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/credential-profiles')).toBe(true)
    })
    await settle()
  }
  return { wrapper, calls, routes }
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

function optionalTextOf(wrapper: VueWrapper, testid: string): string {
  const found = node(wrapper, testid)
  return found.exists() ? found.text() : ''
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
}

async function submit(wrapper: VueWrapper) {
  const button = node(wrapper, 'task-submit')
  if (!button.exists()) throw new Error('missing [data-testid="task-submit"]')
  await button.trigger('click')
  await settle()
}

function createCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.method === 'POST' && call.url === '/api/v1/tasks')
}

function createBody(calls: FetchCall[]): Record<string, unknown> {
  const posts = createCalls(calls)
  if (posts.length !== 1) {
    const seen = calls.map((call) => `${call.method} ${call.url}`)
    throw new Error(`expected exactly 1 POST /api/v1/tasks, saw ${posts.length}: ${seen.join(', ')}`)
  }
  return posts[0].body as Record<string, unknown>
}

// --- form fill helpers ---------------------------------------------------------------------

async function fillRequired(
  wrapper: VueWrapper,
  overrides: { title?: string; repo?: string } = {},
) {
  await setField(wrapper, 'task-title', overrides.title ?? '为订单导出接口增加分页')
  await setSelect(wrapper, 'task-forge', 'gitea')
  await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
  await setField(wrapper, 'task-repo', overrides.repo ?? 'team/orders')
  await setSelect(wrapper, 'task-credential-profile', 3)
}

async function fillEverything(wrapper: VueWrapper) {
  await setField(wrapper, 'task-title', '为订单导出接口增加分页')
  await setField(wrapper, 'task-description', '……（Markdown 详述）')
  await setSelect(wrapper, 'task-source-type', 'imported')
  await setField(wrapper, 'task-issue-url', `${FORGE_BASE_URL}/team/orders/issues/87`)
  await setSelect(wrapper, 'task-forge', 'gitea')
  await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
  await setField(wrapper, 'task-repo', 'team/orders')
  await setField(wrapper, 'task-base-branch', 'develop')
  await setField(wrapper, 'task-suggested-dir', 'orders')
  await setField(
    wrapper,
    'task-acceptance-criteria',
    'GET /api/orders/export 支持 page/page_size 参数\n新增单元测试覆盖分页边界',
  )
  await setField(wrapper, 'task-test-command', 'pnpm test')
  await setField(wrapper, 'task-allowed-paths', 'src/api/**\ntests/**')
  await setField(wrapper, 'task-forbidden-paths', 'migrations/**')
  await setSelect(wrapper, 'task-priority', 'P1')
  await setField(wrapper, 'task-tags', 'backend\napi')
  await setSelect(wrapper, 'task-credential-profile', 3)
}

// =============================================================================================

describe('发布任务表单 — 可见性（DESIGN §11）', () => {
  it('只对 active + full 成员可见，claim_only 与待批准用户都看不到', async () => {
    const full = await mountApp(ME_FULL)
    expect(node(full.wrapper, 'task-form').exists()).toBe(true)
    expect(node(full.wrapper, 'task-submit').exists()).toBe(true)
    full.wrapper.unmount()

    const claimOnly = await mountApp(ME_CLAIM_ONLY)
    expect(claimOnly.wrapper.text()).toContain('工作台')
    expect(node(claimOnly.wrapper, 'task-form').exists()).toBe(false)
    expect(node(claimOnly.wrapper, 'task-submit').exists()).toBe(false)
    claimOnly.wrapper.unmount()

    const pending = await mountApp(ME_PENDING)
    expect(pending.wrapper.text()).toContain('账号待批准')
    expect(node(pending.wrapper, 'task-form').exists()).toBe(false)
    pending.wrapper.unmount()
  })
})

describe('发布任务表单 — 请求线格式', () => {
  it('完整填写后提交，请求体精确匹配服务端的 snake_case 契约', async () => {
    const { wrapper, calls } = await mountApp()
    await fillEverything(wrapper)
    await submit(wrapper)

    expect(createBody(calls)).toEqual({
      title: '为订单导出接口增加分页',
      description_md: '……（Markdown 详述）',
      source: { type: 'imported', issue_url: `${FORGE_BASE_URL}/team/orders/issues/87` },
      repo: {
        forge: 'gitea',
        base_url: FORGE_BASE_URL,
        full_name: 'team/orders',
        base_branch: 'develop',
        suggested_dir: 'orders',
      },
      acceptance_criteria: [
        'GET /api/orders/export 支持 page/page_size 参数',
        '新增单元测试覆盖分页边界',
      ],
      test_command: 'pnpm test',
      constraints: { allowed_paths: ['src/api/**', 'tests/**'], forbidden_paths: ['migrations/**'] },
      priority: 'P1',
      tags: ['backend', 'api'],
      credential: { profile_id: 3 },
    })
  })

  it('平台自有字段 id / pr_convention / poster / status / created_at 不出现在请求体里', async () => {
    const { wrapper, calls } = await mountApp()
    await fillEverything(wrapper)
    await submit(wrapper)

    const body = createBody(calls)
    for (const key of ['id', 'pr_convention', 'poster', 'status', 'created_at']) {
      expect(Object.keys(body)).not.toContain(key)
    }
  })

  it('未填写的 base_branch 与 suggested_dir 被省略，而不是发送空字符串', async () => {
    // 服务端 readRepo 对空字符串直接 400 invalid_body，只有 undefined 才会套用默认值。
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper)
    await submit(wrapper)

    const body = createBody(calls)
    expect(body.repo).toEqual({
      forge: 'gitea',
      base_url: FORGE_BASE_URL,
      full_name: 'team/orders',
    })
    expect(body.source).toEqual({ type: 'native' })
    expect(body.priority).toBe('P2')
    expect(body.description_md).toBe('')
    expect(body.test_command).toBe('')
    expect(body.acceptance_criteria).toEqual([])
    expect(body.tags).toEqual([])
    expect(body.constraints).toEqual({ allowed_paths: [], forbidden_paths: [] })
  })

  it('四个 string[] 字段按行拆分：逐行去空白并丢弃空行', async () => {
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper)
    await setField(wrapper, 'task-acceptance-criteria', '  第一条  \n\n第二条\n')
    await setField(wrapper, 'task-tags', 'backend\n\n  api  \n')
    await setField(wrapper, 'task-allowed-paths', '\nsrc/api/**\n\n  tests/**\n')
    await setField(wrapper, 'task-forbidden-paths', 'migrations/**\n   \n')
    await submit(wrapper)

    const body = createBody(calls)
    expect(body.acceptance_criteria).toEqual(['第一条', '第二条'])
    expect(body.tags).toEqual(['backend', 'api'])
    expect(body.constraints).toEqual({
      allowed_paths: ['src/api/**', 'tests/**'],
      forbidden_paths: ['migrations/**'],
    })
  })

  it('创建请求是 POST /api/v1/tasks，带 Content-Type: application/json', async () => {
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper)
    await submit(wrapper)

    const post = createCalls(calls)[0]
    expect(post.method).toBe('POST')
    expect(post.url).toBe('/api/v1/tasks')
    expect(post.headers['content-type']).toBe('application/json')
  })

  it('每一个 fetch 都带 credentials: include 与 Accept: application/json', async () => {
    // Accept 是承重的：没有它，服务端的 sendUnauthorized 会 302 到 /login 而不是回 401 JSON。
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper)
    await submit(wrapper)

    expect(createCalls(calls)).toHaveLength(1)
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
})

describe('发布任务表单 — 两条凭证路径（{profile_id} XOR {token}）', () => {
  it('默认走共享档案：渲染档案下拉，不渲染内联 token 输入框', async () => {
    const { wrapper } = await mountApp()
    expect(node(wrapper, 'task-credential-profile').exists()).toBe(true)
    expect(node(wrapper, 'task-credential-token').exists()).toBe(false)
  })

  it('切到单任务临时 token：渲染 token 输入框，不渲染档案下拉', async () => {
    const { wrapper } = await mountApp()
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    expect(node(wrapper, 'task-credential-token').exists()).toBe(true)
    expect(node(wrapper, 'task-credential-profile').exists()).toBe(false)
    expect(fieldElement(wrapper, 'task-credential-token').attributes('type')).toBe('password')
  })

  it('档案路径发送 credential: { profile_id }，且不带任何 token 键', async () => {
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper)
    await setSelect(wrapper, 'task-credential-profile', 5)
    await submit(wrapper)

    expect(createBody(calls).credential).toEqual({ profile_id: 5 })
  })

  it('内联路径发送 credential: { token }，且不带 profile_id', async () => {
    const { wrapper, calls } = await mountApp()
    await setField(wrapper, 'task-title', '为订单导出接口增加分页')
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setField(wrapper, 'task-repo', 'team/orders')
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setField(wrapper, 'task-credential-token', 'ghp_oneoff_secret')
    await submit(wrapper)

    expect(createBody(calls).credential).toEqual({ token: 'ghp_oneoff_secret' })
  })

  it('档案下拉复用已加载的 profiles，不再发一次 GET /api/v1/credential-profiles', async () => {
    const { wrapper, calls } = await mountApp()
    const options = selectOf(wrapper, 'task-credential-profile').props('options')
    expect(options).toHaveLength(2)
    expect(options?.map((option) => option.value)).toEqual([3, 5])
    expect(String(options?.[0].label)).toContain('team/orders')
    expect(String(options?.[1].label)).toContain('team/billing')

    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setSelect(wrapper, 'task-credential-mode', 'profile')
    expect(
      calls.filter(
        (call) => call.method === 'GET' && call.url === '/api/v1/credential-profiles',
      ),
    ).toHaveLength(1)
  })

  it('发布成功后清空内联 token 输入框', async () => {
    const { wrapper } = await mountApp()
    await setField(wrapper, 'task-title', '为订单导出接口增加分页')
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setField(wrapper, 'task-repo', 'team/orders')
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setField(wrapper, 'task-credential-token', 'ghp_oneoff_secret')
    expect(fieldValue(wrapper, 'task-credential-token')).toBe('ghp_oneoff_secret')

    await submit(wrapper)
    expect(fieldValue(wrapper, 'task-credential-token')).toBe('')
  })
})

describe('发布任务表单 — 提交前校验', () => {
  it('标题为空时不发请求；补上标题后才发', async () => {
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper, { title: '' })
    await submit(wrapper)
    expect(createCalls(calls)).toHaveLength(0)

    await setField(wrapper, 'task-title', '为订单导出接口增加分页')
    await submit(wrapper)
    expect(createCalls(calls)).toHaveLength(1)
  })

  it('仓库 full_name 为空时不发请求', async () => {
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper, { repo: '' })
    await submit(wrapper)
    expect(createCalls(calls)).toHaveLength(0)
  })

  it('选择 imported 却没填 issue_url 时不发请求', async () => {
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper)
    await setSelect(wrapper, 'task-source-type', 'imported')
    await submit(wrapper)
    expect(createCalls(calls)).toHaveLength(0)
  })

  it('档案模式下没选档案时不发请求', async () => {
    const { wrapper, calls } = await mountApp()
    await setField(wrapper, 'task-title', '为订单导出接口增加分页')
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setField(wrapper, 'task-repo', 'team/orders')
    await submit(wrapper)
    expect(createCalls(calls)).toHaveLength(0)
  })

  it('内联模式下 token 为空时不发请求', async () => {
    const { wrapper, calls } = await mountApp()
    await setField(wrapper, 'task-title', '为订单导出接口增加分页')
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setField(wrapper, 'task-repo', 'team/orders')
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await submit(wrapper)
    expect(createCalls(calls)).toHaveLength(0)
  })
})

describe('发布任务表单 — 发布即校验的两种失败（DESIGN §5）', () => {
  async function submitAgainst(status: number, body: unknown) {
    const mounted = await mountApp()
    mounted.routes.set('POST /api/v1/tasks', () => jsonResponse(status, body))
    await fillRequired(mounted.wrapper)
    await submit(mounted.wrapper)
    return mounted
  }

  it('422 缺少 推 与 PR：凭证字段旁点名两项能力', async () => {
    const missing = ['推', 'PR']
    const { wrapper } = await submitAgainst(422, {
      error: 'token_check_failed',
      missing,
      message: tokenInsufficientMessage(missing),
    })
    expect(textOf(wrapper, 'task-credential-feedback')).toContain(
      'token 权限不足：缺少 推、PR 权限，任务未发布。',
    )
  })

  it('422 只缺少 PR：文案只点名 PR，说明它不是写死的字符串', async () => {
    const missing = ['PR']
    const { wrapper } = await submitAgainst(422, {
      error: 'token_check_failed',
      missing,
      message: tokenInsufficientMessage(missing),
    })
    const feedback = textOf(wrapper, 'task-credential-feedback')
    expect(feedback).toContain('token 权限不足：缺少 PR 权限，任务未发布。')
    expect(feedback).not.toContain('推')
  })

  it('422 连 读 都缺失：显示 token 无效文案，而不是权限不足文案', async () => {
    const { wrapper } = await submitAgainst(422, {
      error: 'token_check_failed',
      missing: ['读', '推', 'PR'],
      message: TOKEN_INVALID_MESSAGE,
    })
    const feedback = textOf(wrapper, 'task-credential-feedback')
    expect(feedback).toContain(TOKEN_INVALID_MESSAGE)
    expect(feedback).not.toContain('权限不足')
  })

  it('502 forge 不可达是另一种结局：提交级消息，且不落在凭证字段旁', async () => {
    const { wrapper } = await submitAgainst(502, {
      error: 'forge_unreachable',
      message: FORGE_UNREACHABLE_MESSAGE,
    })
    expect(textOf(wrapper, 'task-message')).toContain(FORGE_UNREACHABLE_MESSAGE)
    expect(optionalTextOf(wrapper, 'task-credential-feedback')).not.toContain(
      FORGE_UNREACHABLE_MESSAGE,
    )
    expect(textOf(wrapper, 'task-message')).not.toContain('权限不足')
  })

  it('400 所选凭证档案不存在：原样显示服务端的中文消息', async () => {
    const { wrapper } = await submitAgainst(400, {
      error: 'invalid_body',
      message: PROFILE_MISSING_MESSAGE,
    })
    expect(wrapper.text()).toContain(PROFILE_MISSING_MESSAGE)
  })

  it('400 invalid_body 且没有 message：回落到通用中文提示', async () => {
    const { wrapper } = await submitAgainst(400, { error: 'invalid_body' })
    expect(textOf(wrapper, 'task-message')).toContain(GENERIC_FAILURE_MESSAGE(400))
  })

  it('500 vault_unconfigured：沿用凭证档案那套文案', async () => {
    const { wrapper } = await submitAgainst(500, { error: 'vault_unconfigured' })
    expect(textOf(wrapper, 'task-message')).toContain(VAULT_UNCONFIGURED_MESSAGE)
  })

  it('网络失败：给出提示，并且不把已填的 token 当成功清掉', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('POST /api/v1/tasks', () => {
      throw new TypeError('fetch failed')
    })
    await setField(wrapper, 'task-title', '为订单导出接口增加分页')
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setField(wrapper, 'task-repo', 'team/orders')
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setField(wrapper, 'task-credential-token', 'ghp_oneoff_secret')
    await submit(wrapper)

    expect(textOf(wrapper, 'task-message').length).toBeGreaterThan(0)
    expect(fieldValue(wrapper, 'task-credential-token')).toBe('ghp_oneoff_secret')
  })
})

describe('发布任务表单 — 发布成功', () => {
  it('201 之后提交级消息带上服务端生成的任务 id', async () => {
    const { wrapper } = await mountApp()
    await fillRequired(wrapper)
    await submit(wrapper)
    expect(textOf(wrapper, 'task-message')).toContain(CREATED_ID)
  })
})

// Issue #12 — pre-publish Issue import + 「导入内容」来源标记. Do not weaken the cases above.

const IMPORT_TITLE = '从 Issue 导入的标题'
const IMPORT_DESCRIPTION = '从 Issue 导入的正文'
const IMPORT_ISSUE_URL = `${FORGE_BASE_URL}/team/orders/issues/87`
const IMPORT_DRAFT = {
  title: IMPORT_TITLE,
  description_md: IMPORT_DESCRIPTION,
  source: { type: 'imported', issue_url: IMPORT_ISSUE_URL },
  repo: { forge: 'gitea', base_url: FORGE_BASE_URL, full_name: 'team/orders' },
}

function importCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.method === 'POST' && call.url === '/api/v1/tasks/import')
}

async function clickImport(wrapper: VueWrapper) {
  const button = node(wrapper, 'task-import')
  if (!button.exists()) throw new Error('missing [data-testid="task-import"]')
  await button.trigger('click')
  await settle()
}

async function fillImportPrereqs(wrapper: VueWrapper) {
  await setSelect(wrapper, 'task-source-type', 'imported')
  await setField(wrapper, 'task-issue-url', IMPORT_ISSUE_URL)
  await setSelect(wrapper, 'task-forge', 'gitea')
  await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
  await setSelect(wrapper, 'task-credential-profile', 3)
}

describe('发布任务表单 — Issue 导入（issue #12）', () => {
  it('来源为 imported 时显示导入按钮，文案是「导入」；native 时不渲染', async () => {
    const { wrapper } = await mountApp()
    expect(node(wrapper, 'task-import').exists()).toBe(false)

    await setSelect(wrapper, 'task-source-type', 'imported')
    expect(node(wrapper, 'task-import').exists()).toBe(true)
    expect(textOf(wrapper, 'task-import').trim()).toBe('导入')

    await setSelect(wrapper, 'task-source-type', 'native')
    expect(node(wrapper, 'task-import').exists()).toBe(false)
  })

  it('来源标记 task-import-source-label 仅在 imported 可见，文案恰好是「导入内容」', async () => {
    const { wrapper } = await mountApp()
    expect(node(wrapper, 'task-import-source-label').exists()).toBe(false)

    await setSelect(wrapper, 'task-source-type', 'imported')
    expect(node(wrapper, 'task-import-source-label').exists()).toBe(true)
    expect(textOf(wrapper, 'task-import-source-label').trim()).toBe('导入内容')

    await setSelect(wrapper, 'task-source-type', 'native')
    expect(node(wrapper, 'task-import-source-label').exists()).toBe(false)
  })

  it('点击导入：POST /api/v1/tasks/import，Accept + credentials，snake_case 体来自当前表单', async () => {
    const { wrapper, calls, routes } = await mountApp()
    routes.set('POST /api/v1/tasks/import', () => jsonResponse(200, IMPORT_DRAFT))
    await fillImportPrereqs(wrapper)
    await clickImport(wrapper)

    expect(importCalls(calls)).toHaveLength(1)
    const post = importCalls(calls)[0]
    expect(post.method).toBe('POST')
    expect(post.url).toBe('/api/v1/tasks/import')
    expect(post.headers.accept).toBe('application/json')
    expect(post.headers['content-type']).toBe('application/json')
    expect(post.credentials).toBe('include')
    expect(post.body).toEqual({
      issue_url: IMPORT_ISSUE_URL,
      repo: { forge: 'gitea', base_url: FORGE_BASE_URL },
      credential: { profile_id: 3 },
    })
  })

  it('内联 token 路径的导入请求发送 credential: { token }', async () => {
    const { wrapper, calls, routes } = await mountApp()
    routes.set('POST /api/v1/tasks/import', () => jsonResponse(200, IMPORT_DRAFT))
    await setSelect(wrapper, 'task-source-type', 'imported')
    await setField(wrapper, 'task-issue-url', IMPORT_ISSUE_URL)
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setField(wrapper, 'task-credential-token', 'ghp_oneoff_secret')
    await clickImport(wrapper)
    expect(importCalls(calls)[0].body).toEqual({
      issue_url: IMPORT_ISSUE_URL,
      repo: { forge: 'gitea', base_url: FORGE_BASE_URL },
      credential: { token: 'ghp_oneoff_secret' },
    })
  })

  it('200 后填入标题、描述、仓库 full_name，并保持来源为 imported', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('POST /api/v1/tasks/import', () => jsonResponse(200, IMPORT_DRAFT))
    await fillImportPrereqs(wrapper)
    await setField(wrapper, 'task-title', '旧标题')
    await setField(wrapper, 'task-description', '旧描述')
    await clickImport(wrapper)

    expect(fieldValue(wrapper, 'task-title')).toBe(IMPORT_TITLE)
    expect(fieldValue(wrapper, 'task-description')).toBe(IMPORT_DESCRIPTION)
    expect(fieldValue(wrapper, 'task-repo')).toBe('team/orders')
    expect(selectOf(wrapper, 'task-source-type').props('value')).toBe('imported')
    expect(node(wrapper, 'task-issue-url').exists()).toBe(true)
    expect(node(wrapper, 'task-import-source-label').exists()).toBe(true)
    expect(textOf(wrapper, 'task-import-source-label').trim()).toBe('导入内容')
  })

  it('失败时展示服务端 message；没有 message 时用「导入失败（status）」且不改写发布失败文案', async () => {
    const withMessage = await mountApp()
    withMessage.routes.set('POST /api/v1/tasks/import', () =>
      jsonResponse(400, { error: 'invalid_body', message: '无法解析 Issue 地址。' }),
    )
    await fillImportPrereqs(withMessage.wrapper)
    await clickImport(withMessage.wrapper)
    expect(textOf(withMessage.wrapper, 'task-message')).toContain('无法解析 Issue 地址。')
    expect(textOf(withMessage.wrapper, 'task-message')).not.toContain('发布失败')
    withMessage.wrapper.unmount()

    const generic = await mountApp()
    generic.routes.set('POST /api/v1/tasks/import', () => jsonResponse(404, { error: 'issue_not_found' }))
    await fillImportPrereqs(generic.wrapper)
    await clickImport(generic.wrapper)
    expect(textOf(generic.wrapper, 'task-message')).toContain('导入失败（404）')
    expect(textOf(generic.wrapper, 'task-message')).not.toContain('发布失败')
    generic.wrapper.unmount()
  })
})
