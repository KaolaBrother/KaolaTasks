import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createDb } from './db.ts'

// Startup regression: rebuildLeasesIfAgentKeyStillRequired's INSERT ... SELECT (db.ts:123-145,
// edited by commit 8a49a63 / #36 to carry request_id through the rebuild) references
// `leases.request_id`, but createDb only adds that column via
// tryAddColumn(sqlite, LEASES_ADD_REQUEST_ID_DDL) *after* the rebuild runs (db.ts:361 then :363).
//
// Any existing database whose `leases` table predates #36 - i.e. still has `claimer_user_id` or
// `agent_key_id` declared NOT NULL, which is exactly the condition the rebuild's own guard
// (db.ts:117-122) exists to repair - trips this ordering bug: the rebuild's SELECT references a
// column that does not exist yet on that table, and createDb throws `no such column: request_id`,
// so the whole server fails to boot against any pre-#36 database file.
//
// This suite is RED against the current worktree for exactly that reason. Every existing suite
// starts createDb from a fresh database (fresh LEASES_DDL never declares claimer_user_id/
// agent_key_id NOT NULL, so the rebuild guard short-circuits and the buggy path is never taken) -
// nothing in the repo exercises createDb against a pre-existing legacy file. That missing coverage
// is the root cause; this file closes it.
//
// Amendment (final adversarial review, #37/#38/#39 bundle): the four cases above only seed a
// PRISTINE legacy `leases` table, but a real deployment that ever hit the ordering bug above is not
// pristine - `sqlite.exec()` is not transactional, so rebuildLeasesIfAgentKeyStillRequired's first
// statement (`CREATE TABLE leases__rebuild (...)`, db.ts:124) committed on its own before the
// following `INSERT ... SELECT` threw, leaving a durable orphan `leases__rebuild` table on disk.
// Once the ordering bug above is fixed, that same CREATE now collides with the leftover orphan and
// throws `table leases__rebuild already exists` on every single boot attempt, permanently. The two
// tests below (`seedLegacyLeasesWithOrphanRebuildTable`) pin that a real legacy database carrying
// exactly that orphan must still boot, recover its schema, keep its data, and leave no residue.

function sqliteFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-db-migration-'))
  const sqlitePath = join(dir, 'kaola.sqlite')
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return sqlitePath
}

function tableColumns(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all()
}

function columnNames(sqlite, table) {
  return tableColumns(sqlite, table).map((column) => column.name)
}

function columnIsNotNull(sqlite, table, name) {
  const column = tableColumns(sqlite, table).find((row) => row.name === name)
  assert.ok(column, `expected column ${name} to exist on ${table}`)
  return column.notnull === 1
}

// Builds a pre-#36 legacy `leases` table exactly as reproduced by the run owner: the shape
// createDb produced before request_id existed, with `claimer_user_id` still declared NOT NULL -
// the first half of the OR in rebuildLeasesIfAgentKeyStillRequired's guard (db.ts:120).
function seedLegacyLeasesClaimerUserIdRequired(sqlitePath) {
  const raw = new Database(sqlitePath)
  raw.exec(`
    CREATE TABLE leases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      claimer_user_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      agent_key_id INTEGER,
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL,
      state TEXT NOT NULL
    )
  `)
  raw
    .prepare(
      `INSERT INTO leases
         (id, task_id, claimer_user_id, device_id, agent_key_id, claimed_at, expires_at, last_heartbeat, state)
       VALUES (1, 42, 7, 3, NULL, 1000, 87400, 1000, 'active')`,
    )
    .run()
  raw.close()
}

// The other half of the same guard: a legacy table where `agent_key_id` (not `claimer_user_id`) is
// the NOT NULL column - db.ts:120 ORs the two conditions, so either alone must trip the identical
// rebuild path and the identical bug.
function seedLegacyLeasesAgentKeyIdRequired(sqlitePath) {
  const raw = new Database(sqlitePath)
  raw.exec(`
    CREATE TABLE leases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      claimer_user_id INTEGER,
      device_id INTEGER NOT NULL,
      agent_key_id INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL,
      state TEXT NOT NULL
    )
  `)
  raw
    .prepare(
      `INSERT INTO leases
         (id, task_id, claimer_user_id, device_id, agent_key_id, claimed_at, expires_at, last_heartbeat, state)
       VALUES (1, 42, NULL, 3, 9, 1000, 87400, 1000, 'active')`,
    )
    .run()
  raw.close()
}

function readLeaseRow(sqlite) {
  return sqlite.prepare('SELECT * FROM leases WHERE id = 1').get()
}

function tableExists(sqlite, name) {
  return (
    sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  )
}

// Realistic legacy population, per the run owner's reproduction: sqlite.exec() is NOT
// transactional, so on the PRE-fix build rebuildLeasesIfAgentKeyStillRequired's (db.ts:117-149)
// first statement `CREATE TABLE leases__rebuild (...)` committed on its own, and only the
// following `INSERT ... SELECT ... request_id FROM leases` threw (request_id did not exist on the
// legacy source table at that point). Every legacy database that ever attempted to boot on that
// buggy build is left with a durable orphan `leases__rebuild` table on disk - that failed boot is
// exactly how the bug was found, so a legacy `leases` table PLUS a leftover, empty
// `leases__rebuild` table (the INSERT never got to insert anything before it threw) is the
// realistic population, not a pristine legacy table alone. The orphan table's shape is copied
// verbatim from the rebuild's own CREATE TABLE (db.ts:124-136) - the exact 11 columns.
function seedLegacyLeasesWithOrphanRebuildTable(sqlitePath) {
  seedLegacyLeasesClaimerUserIdRequired(sqlitePath)
  const raw = new Database(sqlitePath)
  raw.exec(`
    CREATE TABLE leases__rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      claimer_user_id INTEGER,
      claimer_claimant_id INTEGER,
      device_id INTEGER NOT NULL,
      agent_key_id INTEGER,
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL,
      state TEXT NOT NULL,
      request_id TEXT
    )
  `)
  raw.close()
}

describe('createDb legacy-database migration (leases.request_id ordering)', { concurrency: false }, () => {
  test('createDb completes against a legacy leases table (claimer_user_id NOT NULL, no request_id)', (t) => {
    const sqlitePath = sqliteFile(t)
    seedLegacyLeasesClaimerUserIdRequired(sqlitePath)

    let db
    assert.doesNotThrow(() => {
      db = createDb(sqlitePath)
    }, 'createDb must migrate a pre-existing legacy leases table without throwing')
    t.after(() => db.$client.close())

    const sqlite = db.$client
    assert.ok(
      columnNames(sqlite, 'leases').includes('request_id'),
      'leases must gain a request_id column after migration',
    )
    assert.equal(
      columnIsNotNull(sqlite, 'leases', 'claimer_user_id'),
      false,
      "claimer_user_id must no longer be NOT NULL after the rebuild (the rebuild's actual purpose)",
    )

    const row = readLeaseRow(sqlite)
    assert.ok(row, 'the pre-existing lease row must survive the migration, not be dropped')
    assert.equal(row.task_id, 42)
    assert.equal(row.claimer_user_id, 7)
    assert.equal(row.device_id, 3)
    assert.equal(row.agent_key_id, null)
    assert.equal(row.claimed_at, 1000)
    assert.equal(row.expires_at, 87400)
    assert.equal(row.last_heartbeat, 1000)
    assert.equal(row.state, 'active')
    assert.equal(row.request_id, null, 'a pre-existing row has no request_id and must migrate to NULL')
  })

  test('createDb completes against a legacy leases table (agent_key_id NOT NULL variant)', (t) => {
    const sqlitePath = sqliteFile(t)
    seedLegacyLeasesAgentKeyIdRequired(sqlitePath)

    let db
    assert.doesNotThrow(() => {
      db = createDb(sqlitePath)
    }, 'createDb must migrate a legacy leases table whose agent_key_id (not claimer_user_id) is NOT NULL')
    t.after(() => db.$client.close())

    const sqlite = db.$client
    assert.ok(columnNames(sqlite, 'leases').includes('request_id'))
    assert.equal(columnIsNotNull(sqlite, 'leases', 'agent_key_id'), false)

    const row = readLeaseRow(sqlite)
    assert.ok(row, 'the pre-existing lease row must survive the migration')
    assert.equal(row.task_id, 42)
    assert.equal(row.claimer_user_id, null)
    assert.equal(row.device_id, 3)
    assert.equal(row.agent_key_id, 9)
    assert.equal(row.state, 'active')
  })

  test('createDb is idempotent: a second call against the same file still succeeds and preserves the row', (t) => {
    const sqlitePath = sqliteFile(t)
    seedLegacyLeasesClaimerUserIdRequired(sqlitePath)

    const first = createDb(sqlitePath)
    first.$client.close()

    let second
    assert.doesNotThrow(() => {
      second = createDb(sqlitePath)
    }, 'a second createDb call against an already-migrated file must not throw')
    t.after(() => second.$client.close())

    const sqlite = second.$client
    assert.ok(columnNames(sqlite, 'leases').includes('request_id'))
    const row = readLeaseRow(sqlite)
    assert.ok(row, 'the row must still be present after a second createDb pass')
    assert.equal(row.task_id, 42)
    assert.equal(row.claimer_user_id, 7)
    assert.equal(row.request_id, null)
  })

  test('createDb still works for a fresh database (no regression on the normal path)', (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const sqlite = db.$client
    assert.ok(
      columnNames(sqlite, 'leases').includes('request_id'),
      'fresh createDb must still produce a request_id column',
    )
    assert.equal(columnIsNotNull(sqlite, 'leases', 'claimer_user_id'), false)

    const info = sqlite
      .prepare(
        `INSERT INTO leases
           (task_id, claimer_user_id, device_id, claimed_at, expires_at, last_heartbeat, state, request_id)
         VALUES (1, 1, 1, 1000, 87400, 1000, 'active', 'req-1')`,
      )
      .run()
    assert.equal(info.changes, 1, 'fresh database must still accept ordinary lease inserts including request_id')
  })

  // Realistic legacy case: a database that already survived one crashed boot on the buggy build
  // (see seedLegacyLeasesWithOrphanRebuildTable above). On the current build, rebuild's first
  // statement `CREATE TABLE leases__rebuild (...)` collides with the leftover orphan and throws
  // `table leases__rebuild already exists` - createDb throws on every single boot attempt against
  // this file, permanently, until the file is manually repaired. This is RED on the current
  // worktree for exactly that reason.
  test('createDb recovers from a leftover leases__rebuild table orphaned by a prior crashed boot', (t) => {
    const sqlitePath = sqliteFile(t)
    seedLegacyLeasesWithOrphanRebuildTable(sqlitePath)

    let db
    assert.doesNotThrow(() => {
      db = createDb(sqlitePath)
    }, 'createDb must recover from an orphaned leases__rebuild table left by a prior crashed boot, not brick permanently on "table leases__rebuild already exists"')
    t.after(() => db.$client.close())

    const sqlite = db.$client
    assert.ok(
      columnNames(sqlite, 'leases').includes('request_id'),
      'leases must gain a request_id column after recovery',
    )
    assert.equal(
      columnIsNotNull(sqlite, 'leases', 'claimer_user_id'),
      false,
      'claimer_user_id must no longer be NOT NULL after recovery',
    )
    assert.equal(
      tableExists(sqlite, 'leases__rebuild'),
      false,
      'no stray leases__rebuild table may remain after a successful recovery',
    )

    const row = readLeaseRow(sqlite)
    assert.ok(row, 'the pre-existing lease row must survive recovery, not be dropped')
    assert.equal(row.task_id, 42)
    assert.equal(row.claimer_user_id, 7)
    assert.equal(row.device_id, 3)
    assert.equal(row.agent_key_id, null)
    assert.equal(row.claimed_at, 1000)
    assert.equal(row.expires_at, 87400)
    assert.equal(row.last_heartbeat, 1000)
    assert.equal(row.state, 'active')
    assert.equal(row.request_id, null, 'a pre-existing row has no request_id and must migrate to NULL')
  })

  test('createDb is idempotent after recovering from an orphaned leases__rebuild table: a second call still succeeds', (t) => {
    const sqlitePath = sqliteFile(t)
    seedLegacyLeasesWithOrphanRebuildTable(sqlitePath)

    const first = createDb(sqlitePath)
    first.$client.close()

    let second
    assert.doesNotThrow(() => {
      second = createDb(sqlitePath)
    }, 'a second createDb call against a file already recovered from an orphaned leases__rebuild table must not throw')
    t.after(() => second.$client.close())

    const sqlite = second.$client
    assert.ok(columnNames(sqlite, 'leases').includes('request_id'))
    assert.equal(tableExists(sqlite, 'leases__rebuild'), false)
    const row = readLeaseRow(sqlite)
    assert.ok(row, 'the row must still be present after a second createDb pass')
    assert.equal(row.task_id, 42)
    assert.equal(row.claimer_user_id, 7)
    assert.equal(row.request_id, null)
  })

  // Case 5 (atomicity of a fault mid-rebuild, e.g. the CREATE committing but the INSERT...SELECT
  // throwing) is NOT expressed here. Forcing that fault deterministically from a test would require
  // either interrupting better-sqlite3's synchronous exec() partway through its statement script (no
  // hook exists for that from outside db.ts) or altering db.ts itself to inject a fault point, which
  // is production code and out of this suite's custody. The two tests above already exercise the
  // durable, on-disk RESULT of exactly that fault - a real orphaned leases__rebuild table left over
  // from a genuine prior crash - which is the reproducible, observable half of the atomicity
  // property; the in-flight half (a rebuild interrupted mid-statement-script on a *fresh* orphan,
  // rather than one already committed to disk) cannot be produced honestly from test code alone.
})

// Issue #53: an existing database whose `submissions` / `tasks` tables predate the review loop
// must open with the new columns present and every existing row intact — `review_round` 0,
// `is_draft` false, `head_sha` / `head_branch` / `parent_task_id` NULL — and the three new tables
// created. Seeds the exact pre-#53 shapes createDb produced (SUBMISSIONS_DDL / TASKS_DDL before
// this issue) plus one row each.
function seedPre53SubmissionsAndTasks(sqlitePath) {
  const sqlite = new Database(sqlitePath)
  sqlite.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description_md TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL,
      source_issue_url TEXT,
      repo_forge TEXT NOT NULL,
      repo_base_url TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      repo_base_branch TEXT NOT NULL,
      repo_suggested_dir TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      test_command TEXT NOT NULL DEFAULT '',
      allowed_paths TEXT NOT NULL DEFAULT '[]',
      forbidden_paths TEXT NOT NULL DEFAULT '[]',
      priority TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      credential_profile_id INTEGER,
      inline_token_encrypted TEXT,
      poster_user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CONSTRAINT tasks_credential_xor
        CHECK ((credential_profile_id IS NULL) != (inline_token_encrypted IS NULL))
    );
    CREATE TABLE submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      lease_id INTEGER NOT NULL,
      pr_url TEXT NOT NULL,
      summary TEXT NOT NULL,
      pr_state TEXT NOT NULL
    );
    CREATE UNIQUE INDEX submissions_lease_id ON submissions(lease_id);
  `)
  sqlite
    .prepare(
      `INSERT INTO tasks (public_id, title, source_type, repo_forge, repo_base_url, repo_full_name,
         repo_base_branch, repo_suggested_dir, priority, credential_profile_id, poster_user_id, status, created_at)
       VALUES ('kt-2026-0001', 'legacy', 'native', 'gitea', 'https://gitea.example', 'team/app',
         'main', 'app', 'P2', 1, 1, '待验收', 1000)`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO submissions (task_id, lease_id, pr_url, summary, pr_state)
       VALUES (1, 5, 'https://gitea.example/team/app/pulls/9', 'legacy summary', 'open')`,
    )
    .run()
  sqlite.close()
}

describe('createDb #53 review-loop migration (pre-existing submissions / tasks)', { concurrency: false }, () => {
  test('createDb adds the #53 columns to an existing submissions/tasks table with defaults and keeps the rows', (t) => {
    const sqlitePath = sqliteFile(t)
    seedPre53SubmissionsAndTasks(sqlitePath)

    let db
    assert.doesNotThrow(() => {
      db = createDb(sqlitePath)
    }, 'createDb must open a pre-#53 database without throwing')
    t.after(() => db.$client.close())
    const sqlite = db.$client

    for (const column of ['head_sha', 'head_branch', 'is_draft', 'review_round']) {
      assert.ok(columnNames(sqlite, 'submissions').includes(column), `submissions must gain ${column}`)
    }
    assert.ok(columnNames(sqlite, 'tasks').includes('parent_task_id'), 'tasks must gain parent_task_id')
    for (const table of ['submission_revisions', 'review_rounds', 'discussion_messages']) {
      assert.equal(tableExists(sqlite, table), true, `${table} must be created`)
    }

    const submission = sqlite.prepare('SELECT * FROM submissions').get()
    assert.ok(submission, 'the pre-existing submission row must survive')
    assert.equal(submission.task_id, 1)
    assert.equal(submission.lease_id, 5)
    assert.equal(submission.pr_url, 'https://gitea.example/team/app/pulls/9')
    assert.equal(submission.summary, 'legacy summary')
    assert.equal(submission.pr_state, 'open')
    assert.equal(submission.head_sha, null, 'head_sha defaults to NULL for a legacy row')
    assert.equal(submission.head_branch, null)
    assert.equal(submission.is_draft, 0, 'is_draft defaults to false (0) for a legacy row')
    assert.equal(submission.review_round, 0, 'review_round defaults to 0 for a legacy row')

    const task = sqlite.prepare('SELECT * FROM tasks').get()
    assert.ok(task, 'the pre-existing task row must survive')
    assert.equal(task.public_id, 'kt-2026-0001')
    assert.equal(task.status, '待验收')
    assert.equal(task.parent_task_id, null, 'parent_task_id defaults to NULL for a legacy row')
  })

  test('createDb is idempotent after the #53 migration: a second open keeps the same rows and defaults', (t) => {
    const sqlitePath = sqliteFile(t)
    seedPre53SubmissionsAndTasks(sqlitePath)

    const first = createDb(sqlitePath)
    first.$client.close()

    let second
    assert.doesNotThrow(() => {
      second = createDb(sqlitePath)
    })
    t.after(() => second.$client.close())
    const sqlite = second.$client
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 1)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1)
    assert.equal(sqlite.prepare('SELECT review_round FROM submissions').get().review_round, 0)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM review_rounds').get().n, 0)
  })
})

// Issue #54 (§17.7 / "#54 columns" in docs/api.md): submissions gains two nullable columns,
// forge_head_sha (TEXT) and forge_head_seen_at (INTEGER) — the PR head most recently observed on
// the forge by the poller tick or the approve live check, and when. A database that already
// carries #53's shape (head_sha / head_branch / is_draft / review_round present) but predates #54
// must gain the two new columns via an idempotent ALTER TABLE and keep every existing row's other
// columns — especially the #53 head_sha — untouched.
function seedPre54Submissions(sqlitePath) {
  const sqlite = new Database(sqlitePath)
  sqlite.exec(`
    CREATE TABLE submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      lease_id INTEGER NOT NULL,
      pr_url TEXT NOT NULL,
      summary TEXT NOT NULL,
      pr_state TEXT NOT NULL,
      head_sha TEXT,
      head_branch TEXT,
      is_draft INTEGER NOT NULL DEFAULT 0,
      review_round INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX submissions_lease_id ON submissions(lease_id);
  `)
  sqlite
    .prepare(
      `INSERT INTO submissions
         (task_id, lease_id, pr_url, summary, pr_state, head_sha, head_branch, is_draft, review_round)
       VALUES (1, 5, 'https://gitea.example/team/app/pulls/9', '#54 前遗留提交', 'open',
         'sha-legacy-1', 'kaola/legacy', 1, 1)`,
    )
    .run()
  sqlite.close()
}

describe('createDb #54 head-anchoring migration (pre-existing submissions)', { concurrency: false }, () => {
  test('createDb adds forge_head_sha / forge_head_seen_at to a #53-shaped submissions table, defaulting to NULL and preserving the row', (t) => {
    const sqlitePath = sqliteFile(t)
    seedPre54Submissions(sqlitePath)

    let db
    assert.doesNotThrow(() => {
      db = createDb(sqlitePath)
    }, 'createDb must open a pre-#54 database without throwing')
    t.after(() => db.$client.close())
    const sqlite = db.$client

    for (const column of ['forge_head_sha', 'forge_head_seen_at']) {
      assert.ok(columnNames(sqlite, 'submissions').includes(column), `submissions must gain ${column}`)
    }

    const submission = sqlite.prepare('SELECT * FROM submissions').get()
    assert.ok(submission, 'the pre-existing submission row must survive')
    assert.equal(submission.task_id, 1)
    assert.equal(submission.lease_id, 5)
    assert.equal(submission.pr_url, 'https://gitea.example/team/app/pulls/9')
    assert.equal(submission.pr_state, 'open')
    assert.equal(submission.head_sha, 'sha-legacy-1', 'the pre-existing #53 head_sha must be untouched by the #54 migration')
    assert.equal(submission.head_branch, 'kaola/legacy')
    assert.equal(submission.is_draft, 1)
    assert.equal(submission.review_round, 1)
    assert.equal(submission.forge_head_sha, null, 'forge_head_sha defaults to NULL for a legacy row')
    assert.equal(submission.forge_head_seen_at, null, 'forge_head_seen_at defaults to NULL for a legacy row')
  })

  test('createDb is idempotent after the #54 migration: a second open keeps the same row and the same NULL defaults', (t) => {
    const sqlitePath = sqliteFile(t)
    seedPre54Submissions(sqlitePath)

    const first = createDb(sqlitePath)
    first.$client.close()

    let second
    assert.doesNotThrow(() => {
      second = createDb(sqlitePath)
    }, 'a second createDb call against an already-#54-migrated file must not throw')
    t.after(() => second.$client.close())

    const sqlite = second.$client
    assert.ok(columnNames(sqlite, 'submissions').includes('forge_head_sha'))
    assert.ok(columnNames(sqlite, 'submissions').includes('forge_head_seen_at'))
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 1, 'no duplicate row from the second pass')
    const submission = sqlite.prepare('SELECT * FROM submissions').get()
    assert.equal(submission.forge_head_sha, null)
    assert.equal(submission.forge_head_seen_at, null)
    assert.equal(submission.head_sha, 'sha-legacy-1', 'the row must still carry its #53 head_sha after a second createDb pass')
  })

  test('createDb still works for a fresh database and the new columns accept writes', (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const sqlite = db.$client
    assert.ok(columnNames(sqlite, 'submissions').includes('forge_head_sha'))
    assert.ok(columnNames(sqlite, 'submissions').includes('forge_head_seen_at'))

    const info = sqlite
      .prepare(
        `INSERT INTO submissions (task_id, lease_id, pr_url, summary, pr_state, forge_head_sha, forge_head_seen_at)
         VALUES (1, 1, 'https://gitea.example/team/app/pulls/1', 'fresh', 'open', 'sha-fresh-1', 1700000000)`,
      )
      .run()
    assert.equal(info.changes, 1, 'a fresh database must accept ordinary submissions inserts including the #54 columns')
    const row = sqlite.prepare('SELECT * FROM submissions WHERE id = ?').get(info.lastInsertRowid)
    assert.equal(row.forge_head_sha, 'sha-fresh-1')
    assert.equal(row.forge_head_seen_at, 1700000000)
  })
})

function columnDefault(sqlite, table, name) {
  const column = tableColumns(sqlite, table).find((row) => row.name === name)
  assert.ok(column, `expected column ${name} on ${table}`)
  return column.dflt_value == null ? null : String(column.dflt_value).replace(/^['"]|['"]$/g, '')
}

function seedLegacyDeviceMaxAgeDefaultThirty(sqlitePath) {
  const raw = new Database(sqlitePath)
  raw.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      permission_level TEXT NOT NULL,
      password_hash TEXT,
      trusted_automation INTEGER NOT NULL DEFAULT 0,
      device_max_age_days INTEGER NOT NULL DEFAULT 30,
      max_devices INTEGER NOT NULL DEFAULT 5,
      device_idle_days INTEGER NOT NULL DEFAULT 0,
      UNIQUE (provider, remote_id)
    );
    CREATE TABLE claimants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      device_max_age_days INTEGER NOT NULL DEFAULT 30,
      max_devices INTEGER NOT NULL DEFAULT 5,
      device_idle_days INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      hostname TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      claimant_id INTEGER,
      user_id INTEGER,
      created_at INTEGER NOT NULL,
      pending_expires_at INTEGER,
      paired_at INTEGER,
      expires_at INTEGER,
      last_seen INTEGER
    );
  `)
  raw
    .prepare(
      `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, device_max_age_days)
       VALUES ('local', 'local', 'old-admin', 'old-admin', 'active', 'admin', 30)`,
    )
    .run()
  raw
    .prepare(
      `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level, device_max_age_days)
       VALUES ('gitlab', '7', 'custom-age', 'custom-age', 'active', 'full', 14)`,
    )
    .run()
  raw
    .prepare(
      `INSERT INTO claimants (display_name, status, device_max_age_days, created_at)
       VALUES ('legacy-claimant', 'active', 30, 1700000000)`,
    )
    .run()
  raw
    .prepare(
      `INSERT INTO devices (fingerprint, public_key, hostname, status, user_id, created_at, paired_at, expires_at)
       VALUES (?, 'pk', 'legacy-host', 'active', 1, 1700000000, 1700000000, ?)`,
    )
    .run('a'.repeat(64), 1700000000 + 30 * 86400)
  raw.close()
}

describe('issue #63 device_max_age_days default 90', () => {
  test('fresh database SQL default is 90; omit-column insert and bind owners get 90', (t) => {
    const db = createDb(':memory:')
    t.after(() => db.$client.close())
    const sqlite = db.$client
    assert.equal(columnDefault(sqlite, 'users', 'device_max_age_days'), '90')
    assert.equal(columnDefault(sqlite, 'claimants', 'device_max_age_days'), '90')
    sqlite
      .prepare(
        `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level)
         VALUES ('local', 'fresh', 'fresh-admin', 'fresh-admin', 'active', 'admin')`,
      )
      .run()
    sqlite
      .prepare(`INSERT INTO claimants (display_name, status, created_at) VALUES ('fresh-claimant', 'active', 1)`)
      .run()
    assert.equal(sqlite.prepare(`SELECT device_max_age_days FROM users WHERE username = 'fresh-admin'`).get().device_max_age_days, 90)
    assert.equal(
      sqlite.prepare(`SELECT device_max_age_days FROM claimants WHERE display_name = 'fresh-claimant'`).get().device_max_age_days,
      90,
    )
  })

  test('upgraded DEFAULT 30 database keeps stored 30/custom and existing expires_at; new omit-column owners get 90', (t) => {
    const sqlitePath = sqliteFile(t)
    seedLegacyDeviceMaxAgeDefaultThirty(sqlitePath)
    const db = createDb(sqlitePath)
    t.after(() => db.$client.close())
    const sqlite = db.$client
    assert.equal(columnDefault(sqlite, 'users', 'device_max_age_days'), '90')
    assert.equal(columnDefault(sqlite, 'claimants', 'device_max_age_days'), '90')
    assert.equal(sqlite.prepare(`SELECT device_max_age_days FROM users WHERE username = 'old-admin'`).get().device_max_age_days, 30)
    assert.equal(sqlite.prepare(`SELECT device_max_age_days FROM users WHERE username = 'custom-age'`).get().device_max_age_days, 14)
    assert.equal(
      sqlite.prepare(`SELECT device_max_age_days FROM claimants WHERE display_name = 'legacy-claimant'`).get().device_max_age_days,
      30,
    )
    assert.equal(sqlite.prepare(`SELECT expires_at FROM devices WHERE id = 1`).get().expires_at, 1700000000 + 30 * 86400)

    sqlite
      .prepare(
        `INSERT INTO users (provider, remote_id, username, display_name, status, permission_level)
         VALUES ('gitea', '99', 'post-upgrade', 'post-upgrade', 'active', 'full')`,
      )
      .run()
    sqlite
      .prepare(`INSERT INTO claimants (display_name, status, created_at) VALUES ('post-upgrade-claimant', 'active', 2)`)
      .run()
    assert.equal(
      sqlite.prepare(`SELECT device_max_age_days FROM users WHERE username = 'post-upgrade'`).get().device_max_age_days,
      90,
      'upgraded SQL DEFAULT must not leave new owners on leftover DEFAULT 30',
    )
    assert.equal(
      sqlite.prepare(`SELECT device_max_age_days FROM claimants WHERE display_name = 'post-upgrade-claimant'`).get()
        .device_max_age_days,
      90,
    )
  })
})
