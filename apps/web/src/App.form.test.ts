// Oracle for the 发布任务 form in App.vue (issue #7, import #12, publish picker #19, publish wizard #21).
//
// The wire format asserted here is the one apps/server/src/tasks.ts actually implements:
// snake_case bodies, a request-side credential union of { profile_id } XOR { token } (which is
// deliberately NOT the brief-side { profile_id } | { inline: true }), and the Chinese strings
// copied character for character out of the server module.
//
// Issue #19 (DESIGN §7): in profile mode the credential dropdown IS the repo picker
// (`{forge} {repo_full_name}`); imported+profile lists Issues via
// GET /api/v1/credential-profiles/:id/issues and does not paste a URL. Inline token
// paste-URL + hand-filled repo stay as the fallback. POST /tasks and POST /import
// bodies are unchanged.

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

const LISTED_ISSUE_87 = {
  number: 87,
  title: '为订单导出接口增加分页',
  issue_url: `${FORGE_BASE_URL}/team/orders/issues/87`,
}
const LISTED_ISSUE_5 = {
  number: 12,
  title: '账单对账失败重试',
  issue_url: 'https://gitlab.example.test/team/billing/-/issues/12',
}

const KAOLA_EXTRA_TESTIDS = [
  'task-group-acceptance',
  'task-acceptance-criteria',
  'task-test-command',
  'task-allowed-paths',
  'task-forbidden-paths',
  'task-priority',
  'task-tags',
] as const

const KAOLA_EXTRA_BODY_KEYS = [
  'acceptance_criteria',
  'test_command',
  'constraints',
  'priority',
  'tags',
] as const

const IMPORT_TITLE = '从 Issue 导入的标题'
const IMPORT_DESCRIPTION = '从 Issue 导入的正文'
const IMPORT_ISSUE_URL = LISTED_ISSUE_87.issue_url
const IMPORT_DRAFT = {
  title: IMPORT_TITLE,
  description_md: IMPORT_DESCRIPTION,
  source: { type: 'imported', issue_url: IMPORT_ISSUE_URL },
  repo: { forge: 'gitea', base_url: FORGE_BASE_URL, full_name: 'team/orders' },
}

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

type ProfileFixture = (typeof PROFILES)[number]

async function mountApp(
  me: Record<string, unknown> = ME_FULL,
  opts: { profiles?: readonly ProfileFixture[] } = {},
) {
  const profiles = opts.profiles ?? PROFILES
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/me', () => jsonResponse(200, me))
  routes.set('GET /api/v1/agent-keys', () => jsonResponse(200, { keys: [] }))
  routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles }))
  // Listed Issues for the two fixture profiles. Unstubbed keys already 500; tests that
  // select a profile in imported mode need these routes so a correct UI does not trip
  // the guard. A UI that never fetches simply never hits them.
  routes.set('GET /api/v1/credential-profiles/3/issues', () =>
    jsonResponse(200, { issues: [LISTED_ISSUE_87] }),
  )
  routes.set('GET /api/v1/credential-profiles/5/issues', () =>
    jsonResponse(200, { issues: [LISTED_ISSUE_5] }),
  )
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

function issueListCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter(
    (call) => call.method === 'GET' && /^\/api\/v1\/credential-profiles\/\d+\/issues$/.test(call.url),
  )
}

async function selectListedIssue(wrapper: VueWrapper, number: number) {
  const options = selectOf(wrapper, 'task-issue-select').props('options') as
    | { label?: unknown; value?: string | number }[]
    | undefined
  const option = options?.find((candidate) => String(candidate.label).startsWith(`#${number} `))
  if (option == null || option.value == null) {
    throw new Error(`missing issue option #${number}`)
  }
  await setSelect(wrapper, 'task-issue-select', option.value)
  await settle()
}

// --- form fill helpers ---------------------------------------------------------------------
//
// Profile mode (the default) hides hand-filled forge / base_url / repo. Native required
// fields are title + a selected profile. Imported adds an Issue pick from GET .../issues.

async function fillRequired(wrapper: VueWrapper, overrides: { title?: string } = {}) {
  await setField(wrapper, 'task-title', overrides.title ?? '为订单导出接口增加分页')
  await setSelect(wrapper, 'task-credential-profile', 3)
  await settle()
}

function expectNoKaolaExtraFields(wrapper: VueWrapper) {
  for (const testid of KAOLA_EXTRA_TESTIDS) {
    expect({ testid, exists: node(wrapper, testid).exists() }).toEqual({ testid, exists: false })
  }
}

function expectOmittedExtraBodyKeys(body: Record<string, unknown>) {
  for (const key of KAOLA_EXTRA_BODY_KEYS) {
    expect(Object.keys(body)).not.toContain(key)
  }
  expect(body).toEqual(
    expect.objectContaining({
      title: expect.any(String),
      description_md: expect.any(String),
      source: expect.any(Object),
      repo: expect.any(Object),
      credential: expect.any(Object),
    }),
  )
}

function importCardAnchor(wrapper: VueWrapper) {
  const found = node(wrapper, 'task-import-card-url')
  if (!found.exists()) throw new Error('missing [data-testid="task-import-card-url"]')
  if (found.element.tagName === 'A') return found
  const inner = found.find('a')
  if (!inner.exists()) throw new Error('task-import-card-url has no <a href>')
  return inner
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
  it('导入成功后发布：请求体含 title / description_md / source / repo / credential，省略验收等附加键', async () => {
    const { wrapper, calls, routes } = await mountApp()
    routes.set('POST /api/v1/tasks/import', () => jsonResponse(200, IMPORT_DRAFT))
    await fillImportPrereqs(wrapper)
    await clickImport(wrapper)
    await setField(wrapper, 'task-base-branch', 'develop')
    await setField(wrapper, 'task-suggested-dir', 'orders')
    await submit(wrapper)

    const body = createBody(calls)
    expectOmittedExtraBodyKeys(body)
    expect(body).toEqual({
      title: IMPORT_TITLE,
      description_md: IMPORT_DESCRIPTION,
      source: { type: 'imported', issue_url: IMPORT_ISSUE_URL },
      repo: {
        forge: 'gitea',
        base_url: FORGE_BASE_URL,
        full_name: 'team/orders',
        base_branch: 'develop',
        suggested_dir: 'orders',
      },
      credential: { profile_id: 3 },
    })
  })

  it('平台自有字段 id / pr_convention / poster / status / created_at 不出现在请求体里', async () => {
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper)
    await submit(wrapper)

    const body = createBody(calls)
    for (const key of ['id', 'pr_convention', 'poster', 'status', 'created_at']) {
      expect(Object.keys(body)).not.toContain(key)
    }
  })

  it('未填写的 base_branch 与 suggested_dir 被省略，且不发送验收等附加键', async () => {
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
    expect(body.title).toBe('为订单导出接口增加分页')
    expect(body.description_md).toBe('')
    expect(body.credential).toEqual({ profile_id: 3 })
    expectOmittedExtraBodyKeys(body)
    expect(Object.keys(body).sort()).toEqual(
      ['credential', 'description_md', 'repo', 'source', 'title'].sort(),
    )
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
    // imported+profile covers GET .../issues; import then publish covers POST /import and POST /tasks.
    const { wrapper, calls, routes } = await mountApp()
    routes.set('POST /api/v1/tasks/import', () => jsonResponse(200, IMPORT_DRAFT))
    await fillImportPrereqs(wrapper)
    await clickImport(wrapper)
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
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setField(wrapper, 'task-repo', 'team/orders')
    await setField(wrapper, 'task-credential-token', 'ghp_oneoff_secret')
    await submit(wrapper)

    expect(createBody(calls).credential).toEqual({ token: 'ghp_oneoff_secret' })
  })

  it('档案下拉复用已加载的 profiles，不再发一次 GET /api/v1/credential-profiles', async () => {
    const { wrapper, calls } = await mountApp()
    const options = selectOf(wrapper, 'task-credential-profile').props('options')
    expect(options).toHaveLength(2)
    expect(options?.map((option) => option.value)).toEqual([3, 5])
    expect(String(options?.[0].label)).toBe('gitea team/orders')
    expect(String(options?.[1].label)).toBe('gitlab team/billing')

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
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setField(wrapper, 'task-repo', 'team/orders')
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

  it('选择 imported 却没选 Issue 时不发请求', async () => {
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper)
    await setSelect(wrapper, 'task-source-type', 'imported')
    await settle()
    await submit(wrapper)
    expect(createCalls(calls)).toHaveLength(0)
  })

  it('档案模式下没选档案时不发请求', async () => {
    const { wrapper, calls } = await mountApp()
    await setField(wrapper, 'task-title', '为订单导出接口增加分页')
    await submit(wrapper)
    expect(createCalls(calls)).toHaveLength(0)
  })

  it('内联模式下 token 为空时不发请求', async () => {
    const { wrapper, calls } = await mountApp()
    await setField(wrapper, 'task-title', '为订单导出接口增加分页')
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setField(wrapper, 'task-repo', 'team/orders')
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
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setField(wrapper, 'task-repo', 'team/orders')
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
// Issue #21 — successful import shows a read-only card; title/description are not n-inputs.

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
  await setSelect(wrapper, 'task-credential-profile', 3)
  await settle()
  await selectListedIssue(wrapper, 87)
}

describe('发布任务表单 — 发布向导不再收集附加字段（issue #21）', () => {
  it('native 来源仍有标题/描述输入，没有导入卡片，也没有验收分组与附加字段', async () => {
    const { wrapper } = await mountApp()
    expect(node(wrapper, 'task-title').exists()).toBe(true)
    expect(node(wrapper, 'task-description').exists()).toBe(true)
    expect(node(wrapper, 'task-import-card').exists()).toBe(false)
    expectNoKaolaExtraFields(wrapper)
  })

  it('imported 来源在导入成功前后都没有验收分组与附加字段', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('POST /api/v1/tasks/import', () => jsonResponse(200, IMPORT_DRAFT))
    await setSelect(wrapper, 'task-source-type', 'imported')
    expectNoKaolaExtraFields(wrapper)
    await fillImportPrereqs(wrapper)
    await clickImport(wrapper)
    expectNoKaolaExtraFields(wrapper)
  })

  it('native 发布把手填标题写入请求体，仍省略附加键', async () => {
    const { wrapper, calls } = await mountApp()
    await fillRequired(wrapper)
    await setField(wrapper, 'task-description', '手填 Markdown 描述')
    await submit(wrapper)
    const body = createBody(calls)
    expect(body.title).toBe('为订单导出接口增加分页')
    expect(body.description_md).toBe('手填 Markdown 描述')
    expect(body.source).toEqual({ type: 'native' })
    expectOmittedExtraBodyKeys(body)
  })
})

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

  it('导入成功前不渲染 task-import-card；native 来源也没有该卡片', async () => {
    const { wrapper } = await mountApp()
    expect(node(wrapper, 'task-import-card').exists()).toBe(false)
    expect(node(wrapper, 'task-import-source-label').exists()).toBe(false)

    await setSelect(wrapper, 'task-source-type', 'imported')
    expect(node(wrapper, 'task-import-card').exists()).toBe(false)
    expect(node(wrapper, 'task-import-source-label').exists()).toBe(false)

    await setSelect(wrapper, 'task-source-type', 'native')
    expect(node(wrapper, 'task-import-card').exists()).toBe(false)
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
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setSelect(wrapper, 'task-source-type', 'imported')
    await setField(wrapper, 'task-issue-url', IMPORT_ISSUE_URL)
    await setSelect(wrapper, 'task-forge', 'gitea')
    await setField(wrapper, 'task-base-url', FORGE_BASE_URL)
    await setField(wrapper, 'task-credential-token', 'ghp_oneoff_secret')
    await clickImport(wrapper)
    expect(importCalls(calls)[0].body).toEqual({
      issue_url: IMPORT_ISSUE_URL,
      repo: { forge: 'gitea', base_url: FORGE_BASE_URL },
      credential: { token: 'ghp_oneoff_secret' },
    })
  })

  it('200 后渲染只读 Issue 卡片，不再有 task-title / task-description 输入', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('POST /api/v1/tasks/import', () => jsonResponse(200, IMPORT_DRAFT))
    await fillImportPrereqs(wrapper)
    expect(node(wrapper, 'task-import-card').exists()).toBe(false)
    await clickImport(wrapper)

    expect(node(wrapper, 'task-import-card').exists()).toBe(true)
    expect(textOf(wrapper, 'task-import-card-title')).toContain(IMPORT_TITLE)
    expect(node(wrapper, 'task-import-card-title').find('input').exists()).toBe(false)
    expect(node(wrapper, 'task-import-card-title').find('textarea').exists()).toBe(false)
    expect(textOf(wrapper, 'task-import-card-body')).toContain(IMPORT_DESCRIPTION)
    expect(importCardAnchor(wrapper).attributes('href')).toBe(IMPORT_ISSUE_URL)
    expect(node(wrapper, 'task-title').exists()).toBe(false)
    expect(node(wrapper, 'task-description').exists()).toBe(false)
    expect(selectOf(wrapper, 'task-source-type').props('value')).toBe('imported')
    expect(node(wrapper, 'task-issue-url').exists()).toBe(false)
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

describe('发布任务表单 — 档案下拉选仓库与 Issue（issue #19）', () => {
  it('档案选项文案恰好是 `{forge} {repo_full_name}`，值仍是档案 id', async () => {
    const { wrapper } = await mountApp()
    const options = selectOf(wrapper, 'task-credential-profile').props('options')
    expect(options?.map((option) => option.value)).toEqual([3, 5])
    expect(options?.map((option) => String(option.label))).toEqual([
      'gitea team/orders',
      'gitlab team/billing',
    ])
  })

  it('档案模式隐藏手填仓库字段；切到内联后才显示', async () => {
    const { wrapper } = await mountApp()
    expect(node(wrapper, 'task-forge').exists()).toBe(false)
    expect(node(wrapper, 'task-base-url').exists()).toBe(false)
    expect(node(wrapper, 'task-repo').exists()).toBe(false)

    await setSelect(wrapper, 'task-source-type', 'imported')
    expect(node(wrapper, 'task-forge').exists()).toBe(false)
    expect(node(wrapper, 'task-base-url').exists()).toBe(false)
    expect(node(wrapper, 'task-repo').exists()).toBe(false)

    await setSelect(wrapper, 'task-credential-mode', 'inline')
    expect(node(wrapper, 'task-forge').exists()).toBe(true)
    expect(node(wrapper, 'task-base-url').exists()).toBe(true)
    expect(node(wrapper, 'task-repo').exists()).toBe(true)
  })

  it('imported 下选档案 3 发一次 GET .../3/issues；改选 5 再发 .../5/issues', async () => {
    const { wrapper, calls } = await mountApp()
    expect(issueListCalls(calls)).toHaveLength(0)

    await setSelect(wrapper, 'task-source-type', 'imported')
    await settle()
    expect(issueListCalls(calls)).toHaveLength(0)

    await setSelect(wrapper, 'task-credential-profile', 3)
    await settle()
    expect(issueListCalls(calls).map((call) => call.url)).toEqual([
      '/api/v1/credential-profiles/3/issues',
    ])

    await setSelect(wrapper, 'task-credential-profile', 5)
    await settle()
    expect(issueListCalls(calls).map((call) => call.url)).toEqual([
      '/api/v1/credential-profiles/3/issues',
      '/api/v1/credential-profiles/5/issues',
    ])
  })

  it('Issue 选项是 `#{number} {title}`；选中不发 POST /import', async () => {
    const { wrapper, calls, routes } = await mountApp()
    routes.set('POST /api/v1/tasks/import', () => jsonResponse(200, IMPORT_DRAFT))
    await setSelect(wrapper, 'task-source-type', 'imported')
    await setSelect(wrapper, 'task-credential-profile', 3)
    await settle()

    const options = selectOf(wrapper, 'task-issue-select').props('options') as
      | { label?: unknown }[]
      | undefined
    expect(options?.map((option) => String(option.label))).toEqual([
      `#${LISTED_ISSUE_87.number} ${LISTED_ISSUE_87.title}`,
    ])

    await selectListedIssue(wrapper, 87)
    expect(importCalls(calls)).toHaveLength(0)
  })

  it('档案+imported 没有粘贴 URL；导入 POST 用列表里的 issue_url 与 profile 凭证', async () => {
    const { wrapper, calls, routes } = await mountApp()
    routes.set('POST /api/v1/tasks/import', () => jsonResponse(200, IMPORT_DRAFT))
    await fillImportPrereqs(wrapper)
    expect(node(wrapper, 'task-issue-url').exists()).toBe(false)

    await clickImport(wrapper)
    expect(importCalls(calls)).toHaveLength(1)
    expect(importCalls(calls)[0].body).toEqual({
      issue_url: LISTED_ISSUE_87.issue_url,
      repo: { forge: 'gitea', base_url: FORGE_BASE_URL },
      credential: { profile_id: 3 },
    })
  })

  it('无档案：选项为空、提示去钥匙，来源 imported 也不发 issues GET', async () => {
    const { wrapper, calls } = await mountApp(ME_FULL, { profiles: [] })
    expect(selectOf(wrapper, 'task-credential-profile').props('options')).toEqual([])
    expect(node(wrapper, 'task-profile-empty-hint').exists()).toBe(true)
    expect(textOf(wrapper, 'task-profile-empty-hint')).toContain('钥匙')

    await setSelect(wrapper, 'task-source-type', 'imported')
    await settle()
    expect(issueListCalls(calls)).toHaveLength(0)
  })

  it('内联+imported：显示粘贴 URL，不发 issues GET', async () => {
    const { wrapper, calls } = await mountApp()
    await setSelect(wrapper, 'task-credential-mode', 'inline')
    await setSelect(wrapper, 'task-source-type', 'imported')
    await settle()

    expect(node(wrapper, 'task-issue-url').exists()).toBe(true)
    expect(node(wrapper, 'task-issue-select').exists()).toBe(false)
    expect(issueListCalls(calls)).toHaveLength(0)
  })

  it('native+档案：无 Issue 下拉；发布 repo 来自档案，无需手填仓库', async () => {
    const { wrapper, calls } = await mountApp()
    expect(node(wrapper, 'task-issue-select').exists()).toBe(false)

    await fillRequired(wrapper)
    expect(node(wrapper, 'task-issue-select').exists()).toBe(false)
    expect(node(wrapper, 'task-import').exists()).toBe(false)
    expect(node(wrapper, 'task-forge').exists()).toBe(false)
    expect(node(wrapper, 'task-repo').exists()).toBe(false)

    await submit(wrapper)
    expect(createBody(calls).repo).toEqual({
      forge: 'gitea',
      base_url: FORGE_BASE_URL,
      full_name: 'team/orders',
    })
    expect(createBody(calls).source).toEqual({ type: 'native' })
    expect(createBody(calls).credential).toEqual({ profile_id: 3 })
  })
})

