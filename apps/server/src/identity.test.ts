import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createDb } from './db.ts'
import {
  DEFAULT_SETUP,
  IDENTITY_SECRET_KEYS,
  JSON_HEADERS,
  LEGACY_USERS_DDL,
  PROVIDERS,
  applyOauthTestEnv,
  assertNoIdentitySecrets,
  assertPersistedUser,
  completeOauthCallback,
  cookieJar,
  countUsers,
  ensureSetup,
  getMe,
  getSetup,
  insertLegacyUser,
  loginGiteaPublisher,
  loginGitlabPublisher,
  loginViaCallback,
  nextAccessToken,
  openDb,
  postLogin,
  postSetup,
  seedUser,
  sqliteFile,
  stubUserinfoByAccessToken,
  withAdmins,
} from './auth.test-helpers.ts'

applyOauthTestEnv()

const { buildApp } = await import('./app.ts')

async function createApp(t, sqlitePath) {
  const app = buildApp(sqlitePath ? { sqlitePath } : undefined)
  t.after(async () => {
    await app.close()
  })
  await app.ready()
  return app
}

function oauthStub(t) {
  const profiles = new Map()
  stubUserinfoByAccessToken(t, profiles)
  return profiles
}

describe('users schema after createDb', () => {
  test('new sqlite has nullable password_hash, local provider, and admin permission_level', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-identity-schema-')
    const db = openDb(t, sqlitePath)
    const cols = db.$client.prepare('PRAGMA table_info(users)').all()
    const names = cols.map((c) => c.name)
    assert.ok(names.includes('password_hash'), `users columns: ${names.join(',')}`)
    const hashCol = cols.find((c) => c.name === 'password_hash')
    assert.equal(hashCol.notnull, 0, 'password_hash must be nullable')

    db.$client
      .prepare(
        `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation, password_hash)
         VALUES ('local', 'local', 'founder', 'founder', 'active', 'admin', 0, NULL)`,
      )
      .run()
    const row = db.$client.prepare("SELECT * FROM users WHERE provider = 'local'").get()
    assert.equal(row.permission_level, 'admin')
    assert.equal(row.password_hash, null)
  })

  test('two local rows with the same trimmed username fail; OAuth usernames may collide across providers', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-identity-unique-')
    const db = openDb(t, sqlitePath)
    const insertLocal = db.$client.prepare(
      `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
       VALUES ('local', ?, ?, ?, 'active', 'admin', 0)`,
    )
    insertLocal.run('local', 'Ada', 'Ada')
    assert.throws(() => insertLocal.run('local-2', ' ada ', 'Ada Dup'))

    db.$client
      .prepare(
        `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
         VALUES ('gitlab', '1', 'Ada', 'GL Ada', 'active', 'full', 0)`,
      )
      .run()
    db.$client
      .prepare(
        `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, trusted_automation)
         VALUES ('gitea', '1', 'Ada', 'GT Ada', 'active', 'full', 0)`,
      )
      .run()
    assert.equal(countUsers(db), 3)
  })
})

describe('legacy sqlite migration', () => {
  test('createDb promotes only the earliest gitlab/gitea/local full to admin; github full stays full', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-identity-migrate-')
    const sqlite = new Database(sqlitePath)
    sqlite.exec(LEGACY_USERS_DDL)
    insertLegacyUser(sqlite, {
      provider: 'gitlab',
      remoteId: '10',
      username: 'gl-early',
      displayName: 'GL Early',
      status: 'active',
      permissionLevel: 'full',
    })
    insertLegacyUser(sqlite, {
      provider: 'gitea',
      remoteId: '11',
      username: 'gt-later',
      displayName: 'GT Later',
      status: 'active',
      permissionLevel: 'full',
    })
    insertLegacyUser(sqlite, {
      provider: 'github',
      remoteId: '12',
      username: 'gh-full',
      displayName: 'GH Full',
      status: 'active',
      permissionLevel: 'full',
    })
    sqlite.close()

    const db = createDb(sqlitePath)
    t.after(() => db.$client.close())
    const rows = db.$client.prepare('SELECT provider, username, permission_level FROM users ORDER BY id').all()
    assert.equal(rows[0].provider, 'gitlab')
    assert.equal(rows[0].permission_level, 'admin')
    assert.equal(rows[1].provider, 'gitea')
    assert.equal(rows[1].permission_level, 'full')
    assert.equal(rows[2].provider, 'github')
    assert.equal(rows[2].permission_level, 'full')

    const app = await createApp(t, sqlitePath)
    const setup = await getSetup(app)
    assert.equal(setup.statusCode, 200)
    assert.deepEqual(setup.json(), { setup_complete: true })
  })

  test('old file with only github active+full still has zero loginable admins', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-identity-gh-only-')
    const sqlite = new Database(sqlitePath)
    sqlite.exec(LEGACY_USERS_DDL)
    insertLegacyUser(sqlite, {
      provider: 'github',
      remoteId: '99',
      username: 'octo',
      displayName: 'Octo',
      status: 'active',
      permissionLevel: 'full',
    })
    sqlite.close()

    const db = createDb(sqlitePath)
    t.after(() => db.$client.close())
    const admins = db.$client
      .prepare(
        `SELECT * FROM users WHERE status = 'active' AND permission_level = 'admin'
         AND provider IN ('local', 'gitlab', 'gitea')`,
      )
      .all()
    assert.equal(admins.length, 0)
    const github = db.$client.prepare("SELECT permission_level FROM users WHERE provider = 'github'").get()
    assert.equal(github.permission_level, 'full')

    const app = await createApp(t, sqlitePath)
    const setup = await getSetup(app)
    assert.equal(setup.statusCode, 200)
    assert.deepEqual(setup.json(), { setup_complete: false })
  })
})

describe('GET /api/v1/setup', () => {
  test('unauthenticated probe is 200 { setup_complete: boolean }; empty DB is false', async (t) => {
    const app = await createApp(t)
    const res = await getSetup(app)
    assert.equal(res.statusCode, 200, `GET /api/v1/setup: ${res.statusCode} ${res.body}`)
    assert.deepEqual(res.json(), { setup_complete: false })
    assertNoIdentitySecrets(res)
  })
})

describe('POST /api/v1/setup', () => {
  test('creates local admin session; me has no hash fields; display_name defaults to trimmed username', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-identity-setup-')
    const app = await createApp(t, sqlitePath)
    const res = await postSetup(app, { username: '  founder  ', password: DEFAULT_SETUP.password })
    assert.equal(res.statusCode, 201, `POST /api/v1/setup: ${res.statusCode} ${res.body}`)
    assert.ok(res.cookies.some((c) => c.name === 'sessionId'), 'setup must set a session cookie')
    const cookies = cookieJar(res)
    const me = await getMe(app, cookies)
    assert.equal(me.statusCode, 200)
    assertPersistedUser(me.json(), {
      provider: 'local',
      remote_id: 'local',
      username: 'founder',
      display_name: 'founder',
      status: 'active',
      permission_level: 'admin',
    })
    assertNoIdentitySecrets(me, DEFAULT_SETUP.password)
    assertNoIdentitySecrets(res, DEFAULT_SETUP.password)

    const db = openDb(t, sqlitePath)
    const events = db.$client.prepare("SELECT type, details FROM events WHERE type = '管理员创建'").all()
    assert.equal(events.length, 1)
    const details = typeof events[0].details === 'string' ? JSON.parse(events[0].details) : events[0].details
    assert.deepEqual(details, { user_id: me.json().id })
    assert.equal(JSON.stringify(details).includes(DEFAULT_SETUP.password), false)
    const hashRow = db.$client.prepare('SELECT password_hash FROM users WHERE id = ?').get(me.json().id)
    assert.ok(hashRow.password_hash)
    assert.notEqual(hashRow.password_hash, DEFAULT_SETUP.password)
  })

  test('second setup is 409 setup_complete; concurrent setups leave at most one admin', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-identity-setup-race-')
    const app = await createApp(t, sqlitePath)
    const first = await postSetup(app, { username: 'one', password: DEFAULT_SETUP.password })
    assert.equal(first.statusCode, 201)
    const second = await postSetup(app, { username: 'two', password: DEFAULT_SETUP.password })
    assert.equal(second.statusCode, 409)
    assert.deepEqual(second.json(), { error: 'setup_complete' })
    assertNoIdentitySecrets(second, DEFAULT_SETUP.password)

    const app2 = await createApp(t, sqliteFile(t, 'kaola-identity-setup-race2-'))
    const [a, b] = await Promise.all([
      postSetup(app2, { username: 'alpha', password: DEFAULT_SETUP.password }),
      postSetup(app2, { username: 'beta', password: DEFAULT_SETUP.password }),
    ])
    const created = [a, b].filter((r) => r.statusCode === 201)
    const conflicts = [a, b].filter((r) => r.statusCode === 409)
    assert.equal(created.length, 1, `expected one 201, got ${a.statusCode} and ${b.statusCode}`)
    assert.equal(conflicts.length, 1)
  })

  test('missing/empty username or empty password is 400', async (t) => {
    const app = await createApp(t)
    const missing = await postSetup(app, { password: DEFAULT_SETUP.password })
    assert.equal(missing.statusCode, 400)
    const emptyUser = await postSetup(app, { username: '   ', password: DEFAULT_SETUP.password })
    assert.equal(emptyUser.statusCode, 400)
    const emptyPass = await postSetup(app, { username: 'founder', password: '' })
    assert.equal(emptyPass.statusCode, 400)
  })
})

describe('POST /api/v1/login', () => {
  test('correct password is 200; wrong, unknown, and empty are all 401 with the same shape', async (t) => {
    const app = await createApp(t)
    await ensureSetup(app)
    const ok = await postLogin(app, { username: DEFAULT_SETUP.username, password: DEFAULT_SETUP.password })
    assert.equal(ok.statusCode, 200, `login: ${ok.statusCode} ${ok.body}`)
    assert.ok(ok.cookies.some((c) => c.name === 'sessionId'))
    const me = await getMe(app, cookieJar(ok))
    assert.equal(me.json().permission_level, 'admin')
    assertNoIdentitySecrets(me, DEFAULT_SETUP.password)

    const wrong = await postLogin(app, { username: DEFAULT_SETUP.username, password: 'nope' })
    const unknown = await postLogin(app, { username: 'nobody', password: DEFAULT_SETUP.password })
    const empty = await postLogin(app, { username: DEFAULT_SETUP.username, password: '' })
    assert.equal(wrong.statusCode, 401)
    assert.equal(unknown.statusCode, 401)
    assert.equal(empty.statusCode, 401)
    assert.deepEqual(wrong.json(), unknown.json())
    assert.deepEqual(unknown.json(), empty.json())
    assert.equal(wrong.json()?.error, 'unauthorized')
    assertNoIdentitySecrets(wrong)
    assertNoIdentitySecrets(unknown)
  })
})

describe('GET /login HTML', () => {
  test('before setup the page is a username/password wizard, not OAuth as the way in', async (t) => {
    const app = await createApp(t)
    const res = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(res.statusCode, 200)
    assert.doesNotMatch(res.body, /\/login\/github/)
    assert.doesNotMatch(res.body, /href="\/login\/gitlab"/)
    assert.doesNotMatch(res.body, /href="\/login\/gitea"/)
    assert.match(res.body, /username|用户名/i)
    assert.match(res.body, /password|密码/i)
  })

  test('after setup: GitLab + Gitea links, local login affordance, no GitHub', async (t) => {
    const app = await createApp(t)
    await ensureSetup(app)
    const res = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(res.statusCode, 200)
    assert.match(res.body, /\/login\/gitlab/)
    assert.match(res.body, /\/login\/gitea/)
    assert.doesNotMatch(res.body, /\/login\/github/)
    assert.match(res.body, /password|密码/i)
  })
})

describe('OAuth after identity split', () => {
  test('empty DB GitLab callback does not insert a user or set a session', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-identity-empty-gl-')
    const app = await createApp(t, sqlitePath)
    const profiles = oauthStub(t)
    const accessToken = nextAccessToken('gitlab-empty')
    profiles.set(accessToken, { id: 99, username: 'gl-user', name: 'Git Lab' })
    const callback = await completeOauthCallback(app, { ...PROVIDERS.gitlab, accessToken })
    assert.ok(callback.statusCode >= 200 && callback.statusCode < 400)
    const me = await getMe(app, cookieJar(callback))
    assert.equal(me.statusCode, 401)
    const loc = String(callback.headers.location ?? callback.body)
    assert.match(loc, /login|setup|向导/)
    const db = openDb(t, sqlitePath)
    assert.equal(countUsers(db), 0)
  })

  test('empty DB Gitea callback does not insert a user or set a session', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-identity-empty-gt-')
    const app = await createApp(t, sqlitePath)
    const profiles = oauthStub(t)
    const accessToken = nextAccessToken('gitea-empty')
    profiles.set(accessToken, { id: 5, login: 'gt-user', full_name: 'Gi Tea' })
    const callback = await completeOauthCallback(app, { ...PROVIDERS.gitea, accessToken })
    const me = await getMe(app, cookieJar(callback))
    assert.equal(me.statusCode, 401)
    const db = openDb(t, sqlitePath)
    assert.equal(countUsers(db), 0)
  })

  test('GET /login/github and callback are 404', async (t) => {
    const app = await createApp(t)
    const start = await app.inject({ method: 'GET', url: '/login/github' })
    assert.equal(start.statusCode, 404)
    const callback = await app.inject({ method: 'GET', url: '/login/github/callback?code=x' })
    assert.equal(callback.statusCode, 404)
  })

  test('after setup, GitLab and Gitea OAuth insert active+full publishers and set a session', async (t) => {
    const app = await createApp(t)
    const profiles = oauthStub(t)
    const gl = await loginGitlabPublisher(app, profiles, 'pub')
    assert.equal(gl.body.status, 'active')
    assert.equal(gl.body.permission_level, 'full')
    assert.equal(gl.body.provider, 'gitlab')
    assert.notEqual(gl.body.permission_level, 'admin')
    assert.doesNotMatch(String(gl.callback.headers.location ?? ''), /uninvited/)

    const gt = await loginGiteaPublisher(app, profiles, 'pub-gt')
    assert.equal(gt.body.permission_level, 'full')
    assert.equal(gt.body.provider, 'gitea')
  })
})

describe('KAOLA_ADMINS is ignored', () => {
  test('malformed KAOLA_ADMINS still buildApp and does not grant GitHub login or extra admin', async (t) => {
    withAdmins(t, 'not-a-spec')
    const sqlitePath = sqliteFile(t, 'kaola-identity-admins-env-')
    const app = await createApp(t, sqlitePath)
    const login = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(login.statusCode, 200)
    const github = await app.inject({ method: 'GET', url: '/login/github' })
    assert.equal(github.statusCode, 404)

    withAdmins(t, 'github:whoever')
    const app2 = await createApp(t, sqliteFile(t, 'kaola-identity-admins-gh-'))
    const gh = await app.inject({ method: 'GET', url: '/login/github' })
    assert.equal(gh.statusCode, 404)
    void app2
    const setup = await getSetup(app)
    assert.equal(setup.json().setup_complete, false)
  })
})

describe('users list, promote, retired approve', () => {
  test('GET /api/v1/users: unauth 401, publisher 403, admin 200 without hash fields', async (t) => {
    const app = await createApp(t)
    const profiles = oauthStub(t)
    const unauth = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { accept: 'application/json' },
    })
    assert.equal(unauth.statusCode, 401)

    const admin = await ensureSetup(app)
    const publisher = await loginGitlabPublisher(app, profiles, 'list-pub')
    const asPub = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      cookies: publisher.cookies,
      headers: { accept: 'application/json' },
    })
    assert.equal(asPub.statusCode, 403)

    const asAdmin = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      cookies: admin.cookies,
      headers: { accept: 'application/json' },
    })
    assert.equal(asAdmin.statusCode, 200, `GET users: ${asAdmin.statusCode} ${asAdmin.body}`)
    const body = asAdmin.json()
    assert.ok(Array.isArray(body.users))
    for (const user of body.users) {
      assert.deepEqual(
        Object.keys(user).sort(),
        ['display_name', 'id', 'permission_level', 'provider', 'status', 'username'].sort(),
      )
      for (const key of IDENTITY_SECRET_KEYS) {
        assert.equal(Object.hasOwn(user, key), false)
      }
    }
  })

  test('admin promotes gitlab/gitea full; already admin is 200; local/github/missing are 404 or 400; publisher 403', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-identity-promote-')
    const app = await createApp(t, sqlitePath)
    const profiles = oauthStub(t)
    const admin = await ensureSetup(app)
    const publisher = await loginGitlabPublisher(app, profiles, 'to-promote')
    assert.equal(publisher.body.permission_level, 'full')

    const asPub = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${publisher.body.id}/promote`,
      cookies: publisher.cookies,
      headers: JSON_HEADERS,
    })
    assert.equal(asPub.statusCode, 403)

    const promoted = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${publisher.body.id}/promote`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
    })
    assert.equal(promoted.statusCode, 200)
    assert.deepEqual(promoted.json(), { ok: true })
    assertNoIdentitySecrets(promoted)

    const me = await getMe(app, publisher.cookies)
    assert.equal(me.json().permission_level, 'admin')

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${publisher.body.id}/promote`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
    })
    assert.equal(again.statusCode, 200)

    const local = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${admin.body.id}/promote`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
    })
    assert.ok(local.statusCode === 404 || local.statusCode === 400)

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/users/999999/promote',
      cookies: admin.cookies,
      headers: JSON_HEADERS,
    })
    assert.ok(missing.statusCode === 404 || missing.statusCode === 400)

    const db = openDb(t, sqlitePath)
    const seeded = seedUser(db, {
      provider: 'github',
      remoteId: 4242,
      username: 'leftover-gh',
      displayName: 'Leftover GH',
      status: 'active',
      permissionLevel: 'full',
    })
    const ghPromote = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${seeded.id}/promote`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
    })
    assert.ok(ghPromote.statusCode === 404 || ghPromote.statusCode === 400)

    const events = db.$client.prepare("SELECT type, details FROM events WHERE type = '权限变更'").all()
    assert.ok(events.length >= 1)
    const details = typeof events[0].details === 'string' ? JSON.parse(events[0].details) : events[0].details
    assert.deepEqual(details, { target_user_id: publisher.body.id, from: 'full', to: 'admin' })
  })

  test('POST /api/v1/users/:id/approve is retired 404', async (t) => {
    const app = await createApp(t)
    const admin = await ensureSetup(app)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${admin.body.id}/approve`,
      cookies: admin.cookies,
      headers: JSON_HEADERS,
    })
    assert.equal(res.statusCode, 404)
  })
})

describe('admin vs publisher HTTP gates', () => {
  test('publisher can post tasks; cannot list devices, users, promote, settings, or claim-confirmations', async (t) => {
    const app = await createApp(t)
    const profiles = oauthStub(t)
    process.env.VAULT_MASTER_KEY = 'cd'.repeat(32)
    t.after(() => {
      delete process.env.VAULT_MASTER_KEY
    })
    const admin = await ensureSetup(app)
    const publisher = await loginGitlabPublisher(app, profiles, 'gates-pub')

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      cookies: publisher.cookies,
      headers: JSON_HEADERS,
      payload: {
        title: '发布者发任务',
        description_md: '',
        source: { type: 'native' },
        repo: {
          forge: 'gitea',
          base_url: 'https://gitea.forge.example.test',
          full_name: 'team/orders',
          base_branch: 'main',
          suggested_dir: 'orders',
        },
        credential: { token: 'gitea-INLINE-ONE-OFF-TOKEN-zzq7' },
      },
    })
    assert.notEqual(post.statusCode, 403, `publisher publish must not be 403: ${post.statusCode} ${post.body}`)
    assert.notEqual(post.statusCode, 401)

    for (const url of [
      '/api/v1/devices/pending',
      '/api/v1/users',
      '/api/v1/claim-confirmations',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url,
        cookies: publisher.cookies,
        headers: { accept: 'application/json' },
      })
      assert.equal(res.statusCode, 403, `publisher GET ${url}: ${res.statusCode} ${res.body}`)
    }

    const settings = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/settings',
      cookies: publisher.cookies,
      headers: JSON_HEADERS,
      payload: { trusted_automation: true },
    })
    assert.equal(settings.statusCode, 403)

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/pending',
      cookies: admin.cookies,
      headers: { accept: 'application/json' },
    })
    assert.equal(pending.statusCode, 200, `admin pending: ${pending.statusCode} ${pending.body}`)

    const adminSettings = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/settings',
      cookies: admin.cookies,
      headers: JSON_HEADERS,
      payload: { trusted_automation: true },
    })
    assert.equal(adminSettings.statusCode, 200)
    assert.deepEqual(adminSettings.json(), { trusted_automation: true })
  })

  test('leftover claim_only via GitLab reuse cannot publish or manage devices', async (t) => {
    const sqlitePath = sqliteFile(t, 'kaola-identity-leftover-')
    const app = await createApp(t, sqlitePath)
    const profiles = oauthStub(t)
    await ensureSetup(app)
    const db = openDb(t, sqlitePath)
    seedUser(db, {
      provider: 'gitlab',
      remoteId: 9001,
      username: 'leftover-claim',
      displayName: 'Leftover Claim',
      status: 'active',
      permissionLevel: 'claim_only',
    })
    const accessToken = nextAccessToken('leftover-gl')
    profiles.set(accessToken, { id: 9001, username: 'leftover-claim', name: 'Leftover Claim' })
    const leftover = await loginViaCallback(app, { ...PROVIDERS.gitlab, accessToken })
    assert.equal(leftover.body.permission_level, 'claim_only')

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      cookies: leftover.cookies,
      headers: JSON_HEADERS,
      payload: { title: 'nope', description_md: '', source: { type: 'native' } },
    })
    assert.ok(post.statusCode === 401 || post.statusCode === 403)

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/pending',
      cookies: leftover.cookies,
      headers: { accept: 'application/json' },
    })
    assert.equal(pending.statusCode, 403)
  })
})
