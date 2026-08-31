// Oracle for issue #45: App.vue must stop trusting ANY non-ok response body's `message`.
//
// Measured at fbdab34 (App.vue deleteProfile():1888/1893, createTask():1961/1969,
// importTask():2016 — six sites total, sharing one line of code each):
//   typeof body?.message === 'string' ? body.message : <Chinese fallback>
// There is no `setErrorHandler` anywhere in apps/server/src, so an unhandled throw in a route
// falls through to Fastify's own default envelope. Verified against this repo's Fastify by
// grepping every reply.code(...).send(...) in apps/server/src (`Bash: grep -rn "error: '"
// apps/server/src`): every typed app error uses a lowercase snake_case `error` code
// (`forbidden`, `not_found`, `invalid_body`, `conflict`, `credential_profile_in_use`,
// `vault_unconfigured`, `token_check_failed`, ...) — zero exceptions. Fastify's own generated
// envelopes never look like that: apps/server/src/app.ts:108-117 shows the ONE place this
// repo already asks Fastify to synthesize a body itself (`setNotFoundHandler`), and it comes
// out as `{ statusCode: 404, error: 'Not Found', message: 'Route ... not found' }` — a
// capitalized, space-containing `error` string plus a `statusCode` field no typed app error
// ever sends. Fastify's default *uncaught-exception* handler (no custom setErrorHandler
// exists) uses the same shape family, e.g.
//   500 { statusCode: 500, error: 'Internal Server Error', message: 'SQLITE_BUSY: ...' }
// (the shape independently reproduced against this repo's own Fastify per issue #45).
//
// CHOSEN DISCRIMINATOR (stated for the implementer to match): a response's `message` may only
// be surfaced verbatim when `body.error` is a snake_case machine code matching
// `/^[a-z][a-z0-9_]*$/`. That pattern accepts every real typed error this server sends and
// rejects both Fastify-synthesized shapes above (capital letter + space). This suite does not
// require a helper of any particular name — it pins the discriminator's OBSERVABLE effect
// through the rendered UI, so any equivalent predicate (e.g. also keying off the presence of
// `statusCode`) that satisfies every fixture below is acceptable.
//
// This suite does NOT touch the server, its status codes, or its error bodies — only the
// client's decision about which `message` to trust. It deliberately exercises more than one
// of the six sites (delete, publish, import) so the fix reads as one shared rule rather than a
// single-site patch, per the issue.
//
// Idiom: fetch stub + settle() copied from App.credential-profile-delete.test.ts (delete panel)
// and the mountApp/fillRequired/submit/fillImportPrereqs helpers copied from App.form.test.ts
// (publish + import panel), since this suite spans both panels.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import naive, { NSelect } from 'naive-ui'
import { nextTick } from 'vue'
import App from './App.vue'

// --- Chinese copy owned by the server (apps/server/src/credential-profiles.ts) --------------

const CREDENTIAL_PROFILE_IN_USE_MESSAGE = '该凭证档案仍被未完成任务引用，暂不能删除。'

// --- the two shapes under test ---------------------------------------------------------------

// Fastify's own default envelope for an unhandled exception (no setErrorHandler is registered
// anywhere in apps/server/src, so this is exactly what an uncaught `throw` produces). English,
// and must never reach the Chinese-only admin UI (AGENTS.md「用户界面使用中文」).
const FASTIFY_DEFAULT_500 = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'SQLITE_BUSY: database is locked',
}

// A hypothetical typed app error at the SAME 500 status code, so a fix that merely keys off
// "status is 500" instead of inspecting the body shape cannot pass this suite. `db_locked` is
// not a code any current route sends; it stands in for "some future typed 500" so the test does
// not depend on the app never adding one.
const TYPED_APP_500 = {
  error: 'db_locked',
  message: '数据库繁忙，请稍后重试。',
}

// --- fixtures ------------------------------------------------------------------------------

const ME_ADMIN: Record<string, unknown> = {
  id: 1,
  provider: 'local',
  remote_id: 'local',
  username: 'kaola-admin',
  display_name: 'kaola-admin',
  status: 'active',
  permission_level: 'admin',
}

const FORGE_BASE_URL = 'https://gitea.forge.example.test'

const DELETE_PROFILE = {
  id: 9,
  forge: 'gitlab',
  base_url: 'https://gitlab.example.test',
  repo_full_name: 'team/orders',
  scopes_checked: [],
  created_by: 1,
}

const PUBLISH_PROFILE = {
  id: 3,
  forge: 'gitea',
  base_url: FORGE_BASE_URL,
  repo_full_name: 'team/billing',
  scopes_checked: [],
  created_by: 1,
}

const LISTED_ISSUE_87 = {
  number: 87,
  title: '为订单导出接口增加分页',
  issue_url: `${FORGE_BASE_URL}/team/billing/issues/87`,
}

const CREATED_ID = 'kt-2026-0099'
const CREATED_BRIEF = {
  id: CREATED_ID,
  title: '为订单导出接口增加分页',
  description_md: '',
  source: { type: 'native' },
  repo: { forge: 'gitea', base_url: FORGE_BASE_URL, full_name: 'team/billing' },
  acceptance_criteria: [],
  test_command: '',
  constraints: { allowed_paths: [], forbidden_paths: [] },
  pr_convention: { branch_prefix: `kaola/${CREATED_ID}-`, title_prefix: `[${CREATED_ID}] ` },
  credential: { profile_id: '3' },
  priority: 'P2',
  tags: [],
  poster: 'kaola-admin',
  status: '待认领',
  created_at: '2026-08-31T08:00:00Z',
}

// --- fetch stub ----------------------------------------------------------------------------
//
// One router keyed on `${METHOD} ${url}`. Every call is recorded verbatim. An unrouted call
// answers 500 { error: 'unstubbed' } and stays in `calls`, so an unexpected outbound request
// can never pass silently.

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
//
// One admin sees both the credential-profile panel and the publish/import form, so a single
// mountApp spans all three sites this suite exercises.

async function mountApp() {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/setup', () => jsonResponse(200, { setup_complete: true }))
  routes.set('GET /api/v1/me', () => jsonResponse(200, ME_ADMIN))
  routes.set('GET /api/v1/agent-keys', () => jsonResponse(200, { keys: [] }))
  routes.set('GET /api/v1/credential-profiles', () =>
    jsonResponse(200, { profiles: [DELETE_PROFILE, PUBLISH_PROFILE] }),
  )
  routes.set('GET /api/v1/credential-profiles/3/issues', () =>
    jsonResponse(200, { issues: [LISTED_ISSUE_87] }),
  )
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks: [] }))
  routes.set('POST /api/v1/tasks', () => jsonResponse(201, CREATED_BRIEF))
  routes.set('GET /api/v1/me/devices', () => jsonResponse(200, { devices: [] }))
  routes.set('GET /api/v1/devices/pending', () => jsonResponse(200, { devices: [] }))
  routes.set('GET /api/v1/claimants', () => jsonResponse(200, { claimants: [] }))
  routes.set('GET /api/v1/claim-confirmations', () => jsonResponse(200, { confirmations: [] }))

  const wrapper = mount(App, { global: { plugins: [naive] } })
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/me')).toBe(true)
  })
  await settle()
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === '/api/v1/credential-profiles')).toBe(true)
  })
  await settle()
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

async function setField(wrapper: VueWrapper, testid: string, value: string) {
  const found = wrapper.findAll(`[data-testid="${testid}"] input, [data-testid="${testid}"] textarea`)
  if (found.length === 0) throw new Error(`no input/textarea under [data-testid="${testid}"]`)
  await found[0].setValue(value)
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

// The credential-profile delete button (App.vue ~line 627) carries no data-testid, so it is
// selected by its exact Chinese label — copied verbatim from
// App.credential-profile-delete.test.ts. With two profiles listed, DELETE_PROFILE (id 9) is
// first in the fixture array, so its button is first in document order.
function deleteProfileButton(wrapper: VueWrapper) {
  const found = wrapper.findAll('button').find((btn) => btn.text().trim() === '删除')
  if (found == null) throw new Error("missing profile delete button (text '删除')")
  return found
}

async function clickDelete(wrapper: VueWrapper) {
  await deleteProfileButton(wrapper).trigger('click')
  await settle()
}

async function fillRequired(wrapper: VueWrapper) {
  await setField(wrapper, 'task-title', '为订单导出接口增加分页')
  await setSelect(wrapper, 'task-credential-profile', 3)
  await settle()
}

async function submit(wrapper: VueWrapper) {
  const button = node(wrapper, 'task-submit')
  if (!button.exists()) throw new Error('missing [data-testid="task-submit"]')
  await button.trigger('click')
  await settle()
}

async function fillImportPrereqs(wrapper: VueWrapper) {
  await setSelect(wrapper, 'task-source-type', 'imported')
  await setSelect(wrapper, 'task-credential-profile', 3)
  await settle()
  const options = selectOf(wrapper, 'task-issue-select').props('options') as
    | { label?: unknown; value?: string | number }[]
    | undefined
  const option = options?.find((candidate) => String(candidate.label).startsWith('#87 '))
  if (option == null || option.value == null) throw new Error('missing issue option #87')
  await setSelect(wrapper, 'task-issue-select', option.value)
  await settle()
}

async function clickImport(wrapper: VueWrapper) {
  const button = node(wrapper, 'task-import')
  if (!button.exists()) throw new Error('missing [data-testid="task-import"]')
  await button.trigger('click')
  await settle()
}

// =============================================================================================

describe('凭证档案删除 — 只信任本应用的类型化错误 message（issue #45）', () => {
  it('409 credential_profile_in_use（类型化错误）：仍展示服务端的中文说明（不回归）', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('DELETE /api/v1/credential-profiles/9', () =>
      jsonResponse(409, {
        error: 'credential_profile_in_use',
        message: CREDENTIAL_PROFILE_IN_USE_MESSAGE,
      }),
    )

    await clickDelete(wrapper)

    expect(wrapper.text()).toContain(CREDENTIAL_PROFILE_IN_USE_MESSAGE)
  })

  it('500 且 body 是 Fastify 未处理异常的默认信封：绝不能把英文原文渲染进界面', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('DELETE /api/v1/credential-profiles/9', () => jsonResponse(500, FASTIFY_DEFAULT_500))

    await clickDelete(wrapper)

    expect(wrapper.text()).not.toContain(FASTIFY_DEFAULT_500.message)
    expect(wrapper.text()).not.toContain('Internal Server Error')
    // Pre-existing message-less fallback copy for this site — not the defect, must survive.
    expect(wrapper.text()).toContain('删除失败（500）')
  })

  it('同样是 500，但 body 是本应用自己的类型化错误：仍展示该 message（证明判别不是"看到 500 就回退"）', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('DELETE /api/v1/credential-profiles/9', () => jsonResponse(500, TYPED_APP_500))

    await clickDelete(wrapper)

    expect(wrapper.text()).toContain(TYPED_APP_500.message)
  })

  it('404 not_found 没有 message：回落到「删除失败（404）」，绝不渲染 "undefined"', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('DELETE /api/v1/credential-profiles/9', () => jsonResponse(404, { error: 'not_found' }))

    await clickDelete(wrapper)

    expect(wrapper.text()).toContain('删除失败（404）')
    expect(wrapper.text()).not.toContain('undefined')
  })

  it('删除成功（200）：档案从列表消失，且展示成功提示（不受判别逻辑影响的回归）', async () => {
    const { wrapper, calls, routes } = await mountApp()
    routes.set('DELETE /api/v1/credential-profiles/9', () => jsonResponse(200, { ok: true, message: '请同时到 forge 侧撤销该 token。' }))
    routes.set('GET /api/v1/credential-profiles', () =>
      jsonResponse(200, { profiles: [PUBLISH_PROFILE] }),
    )

    await clickDelete(wrapper)

    const deletes = calls.filter(
      (call) => call.method === 'DELETE' && call.url === '/api/v1/credential-profiles/9',
    )
    expect(deletes).toHaveLength(1)
    expect(wrapper.text()).not.toContain('team/orders')
  })

  it('删除成功（200）且服务端返回自定义 message（无 error 字段）：展示该文案，而不是写死的回退 —— 判别不能被原样搬到成功分支', async () => {
    const CUSTOM_SUCCESS_MESSAGE = '已删除，另有 3 个待认领任务引用旧档案，请检查。'
    const { wrapper, routes } = await mountApp()
    routes.set('DELETE /api/v1/credential-profiles/9', () =>
      jsonResponse(200, { ok: true, message: CUSTOM_SUCCESS_MESSAGE }),
    )
    routes.set('GET /api/v1/credential-profiles', () =>
      jsonResponse(200, { profiles: [PUBLISH_PROFILE] }),
    )

    await clickDelete(wrapper)

    expect(wrapper.text()).toContain(CUSTOM_SUCCESS_MESSAGE)
  })
})

describe('发布任务 — 同一判别规则必须应用到 POST /api/v1/tasks（issue #45）', () => {
  it('500 且 body 是 Fastify 未处理异常的默认信封：绝不能把英文原文渲染进界面', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('POST /api/v1/tasks', () => jsonResponse(500, FASTIFY_DEFAULT_500))
    await fillRequired(wrapper)

    await submit(wrapper)

    expect(wrapper.text()).not.toContain(FASTIFY_DEFAULT_500.message)
    expect(wrapper.text()).not.toContain('Internal Server Error')
    expect(textOf(wrapper, 'task-message')).toContain('发布失败（500）')
  })

  it('同样是 500，但 body 是本应用自己的类型化错误：仍展示该 message', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('POST /api/v1/tasks', () => jsonResponse(500, TYPED_APP_500))
    await fillRequired(wrapper)

    await submit(wrapper)

    expect(textOf(wrapper, 'task-message')).toContain(TYPED_APP_500.message)
  })

  it('403 forbidden 没有 message：回落到「发布失败（403）」，绝不渲染 "undefined"', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('POST /api/v1/tasks', () => jsonResponse(403, { error: 'forbidden' }))
    await fillRequired(wrapper)

    await submit(wrapper)

    expect(textOf(wrapper, 'task-message')).toContain('发布失败（403）')
    expect(textOf(wrapper, 'task-message')).not.toContain('undefined')
  })

  it('201 成功：提交级消息仍带上服务端生成的任务 id（不回归）', async () => {
    const { wrapper } = await mountApp()
    await fillRequired(wrapper)

    await submit(wrapper)

    expect(textOf(wrapper, 'task-message')).toContain(CREATED_ID)
  })
})

describe('Issue 导入 — 同一判别规则同样应用到 POST /api/v1/tasks/import（issue #45）', () => {
  it('500 且 body 是 Fastify 未处理异常的默认信封：绝不能把英文原文渲染进界面', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('POST /api/v1/tasks/import', () => jsonResponse(500, FASTIFY_DEFAULT_500))
    await fillImportPrereqs(wrapper)

    await clickImport(wrapper)

    expect(wrapper.text()).not.toContain(FASTIFY_DEFAULT_500.message)
    expect(wrapper.text()).not.toContain('Internal Server Error')
    expect(textOf(wrapper, 'task-message')).toContain('导入失败（500）')
  })
})
