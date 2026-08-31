// Oracle for issue #41: DELETE /api/v1/credential-profiles/:id failure reporting in App.vue.
//
// Measured at 8d3504e (App.vue:1876-1898, deleteProfile()): the delete handler reads the
// response body into `body` and then discards it on failure, always rendering the bare
// `删除失败（${res.status}）`. #36 added a 409 credential_profile_in_use guard
// (apps/server/src/credential-profiles.ts) that returns a Chinese `message` explaining which
// kind of task still references the profile; today that message never reaches the admin.
//
// This suite does NOT touch the 409 guard, its status code, or the server. It pins only the
// client's error-reporting contract:
//   - a failing delete whose JSON body carries a string `message` must surface that exact
//     message to the user (assert on rendered text, not an internal ref name, so the
//     implementer keeps freedom in how it is wired — a computed message, a dedicated ref, a
//     shared `profileMessage`, whatever);
//   - a failing delete whose body has no usable `message` must still show something meaningful
//     (this suite accepts the existing `删除失败（${status}）` fallback — the pre-existing copy
//     for the message-less case is not part of the defect and is not being changed) and must
//     never render the literal string `undefined`;
//   - a successful delete keeps behaving exactly as before: the profile disappears from the
//     list and a success message is shown.
//
// Idiom copied from apps/web/src/App.form.test.ts (fetch stub, settle(), mountApp shape) since
// this exercises the same `canPublish`-gated 凭证档案 panel that file's mountApp already reaches.
// The delete button in that panel (App.vue ~line 627) has no data-testid — unlike
// device-revoke/claimant-revoke, it is not addressable by testid — so this suite selects it by
// its exact Chinese label ('删除'), which is unique to that button.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import naive from 'naive-ui'
import { nextTick } from 'vue'
import App from './App.vue'

// --- Chinese copy owned by the server (apps/server/src/credential-profiles.ts) --------------

const CREDENTIAL_PROFILE_IN_USE_MESSAGE = '该凭证档案仍被未完成任务引用，暂不能删除。'

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

const PROFILE = {
  id: 9,
  forge: 'gitlab',
  base_url: 'https://gitlab.example.test',
  repo_full_name: 'team/orders',
  scopes_checked: [],
  created_by: 1,
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

async function mountApp() {
  const { calls, routes } = installFetch()
  routes.set('GET /api/v1/setup', () => jsonResponse(200, { setup_complete: true }))
  routes.set('GET /api/v1/me', () => jsonResponse(200, ME_ADMIN))
  routes.set('GET /api/v1/agent-keys', () => jsonResponse(200, { keys: [] }))
  routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles: [PROFILE] }))
  routes.set('GET /api/v1/tasks', () => jsonResponse(200, { tasks: [] }))
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

// The delete button (App.vue ~line 627) carries no data-testid, so it is selected by its exact
// Chinese label. That label is unique to this button (device-revoke says '解除这台电脑',
// claimant-revoke says '解除认领者').
function deleteProfileButton(wrapper: VueWrapper) {
  const found = wrapper.findAll('button').find((btn) => btn.text().trim() === '删除')
  if (found == null) throw new Error("missing profile delete button (text '删除')")
  return found
}

async function clickDelete(wrapper: VueWrapper) {
  await deleteProfileButton(wrapper).trigger('click')
  await settle()
}

// =============================================================================================

describe('凭证档案删除失败 — 服务端说明必须透出（issue #41）', () => {
  it('409 credential_profile_in_use 且带 message：界面展示服务端的中文说明，而不是裸的状态码', async () => {
    const { wrapper, calls, routes } = await mountApp()
    routes.set('DELETE /api/v1/credential-profiles/9', () =>
      jsonResponse(409, {
        error: 'credential_profile_in_use',
        message: CREDENTIAL_PROFILE_IN_USE_MESSAGE,
      }),
    )

    await clickDelete(wrapper)

    const deletes = calls.filter(
      (call) => call.method === 'DELETE' && call.url === '/api/v1/credential-profiles/9',
    )
    expect(deletes).toHaveLength(1)
    expect(deletes[0].credentials).toBe('include')

    // The observable defect: today this renders only `删除失败（409）` and discards the
    // server's explanation. The fix must surface the explanation itself.
    expect(wrapper.text()).toContain(CREDENTIAL_PROFILE_IN_USE_MESSAGE)

    // The profile must still be listed — the delete did not succeed.
    expect(wrapper.text()).toContain('team/orders')
  })

  it('删除失败但响应体没有可用 message：仍展示有意义的中文提示，绝不渲染 "undefined"', async () => {
    const { wrapper, routes } = await mountApp()
    routes.set('DELETE /api/v1/credential-profiles/9', () =>
      jsonResponse(500, { error: 'internal' }),
    )

    await clickDelete(wrapper)

    // Chosen fallback: keep the pre-existing `删除失败（${status}）` copy for the message-less
    // case — that copy is not the defect in #41 and this suite is not changing it, only
    // guarding that it survives and that nothing renders the bare word "undefined".
    expect(wrapper.text()).toContain('删除失败（500）')
    expect(wrapper.text()).not.toContain('undefined')
  })

  it('删除成功：档案从列表消失，且展示成功提示（不回归）', async () => {
    const { wrapper, calls, routes } = await mountApp()
    routes.set('DELETE /api/v1/credential-profiles/9', () => jsonResponse(200, {}))
    routes.set('GET /api/v1/credential-profiles', () => jsonResponse(200, { profiles: [] }))

    await clickDelete(wrapper)

    const deletes = calls.filter(
      (call) => call.method === 'DELETE' && call.url === '/api/v1/credential-profiles/9',
    )
    expect(deletes).toHaveLength(1)
    expect(wrapper.text()).not.toContain('team/orders')
    expect(wrapper.text()).toContain('暂无凭证档案')
  })
})
