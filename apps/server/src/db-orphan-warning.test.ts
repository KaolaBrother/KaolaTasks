import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createDb } from './db.ts'

// Issue #44: a database orphaned by a PRE-#37/#38/#39-fix crash can carry a `<name>__rebuild`
// table as the ONLY copy of its rows while the real `<name>` table is absent (or is recreated
// fresh and empty by createDb's own `CREATE TABLE IF NOT EXISTS ... DDL). This is a DIFFERENT
// orphan shape than the one covered by db-migration.test.ts's
// `seedLegacyLeasesWithOrphanRebuildTable` (there, the LIVE table still holds the real data and
// the orphan is an empty leftover from an interrupted INSERT; here, the ORPHAN holds the real
// data and the live table is the empty one).
//
// Measured on the current worktree (adversarial verifier, cited verbatim in issue #44's body):
// against exactly this on-disk shape, `createDb` SUCCEEDS on boot #1 and boot #2, the orphan is
// NOT destroyed (`leases__rebuild` still holds its rows afterward), but the live `leases` table
// comes up empty and NOTHING is reported to the operator. `grep -c "console\.\|writeStderr\|warn"
// apps/server/src/db.ts` returns 0 today - there is no reporting surface in that file at all.
//
// ACCEPTANCE CONTRACT PINNED BY THIS SUITE (test author's design choice, not yet implemented):
// createDb must call the GLOBAL `console.error` exactly once, synchronously, during the same
// `createDb(...)` call that boots against a database in this state, once per orphaned table it
// finds in this shape. This is deliberately the least invasive surface available:
//   - It requires NO change to createDb's signature or return type (it stays a plain value, not
//     a reporter-argument API) - callers such as the real server boot path get the warning for
//     free with zero wiring, which matters because apps/server/src/db.ts has no logger today and
//     introducing one is a bigger surface than this issue's remedy calls for.
//   - It stops short of throwing: throwing would block boot over a table that is otherwise
//     perfectly usable (empty, not corrupt), which the issue explicitly says is "probably too
//     aggressive" - a stderr/warning line lets the server run while making the situation visible.
//   - console.error (rather than raw process.stderr.write) is deterministically observable from a
//     test by temporarily replacing the global and restoring it in `t.after`, with no subprocess
//     or real-stream capture required.
// Each console.error call's arguments, stringified and joined, must contain BOTH the orphan
// table's exact name and its row count (the two facts the issue calls out as the minimum useful
// detail: "至少给出孤儿表名，理想情况下还有行数和"正表为空"这一事实"). This suite does not
// prescribe exact wording beyond those facts, so it does not overfit to one message string.
//
// HARD CONSTRAINT this suite also pins, per the issue's explicit caution: the orphan may be an
// INCOMPLETE intermediate copy (a crash mid-INSERT), so createDb must NOT silently move the
// orphan's rows into the live table. Every positive case below asserts that after createDb
// returns, the live table is STILL empty and the orphan table STILL exists with its original row
// count unchanged - reporting only, never auto-recovery.

function sqliteFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-db-orphan-warning-'))
  const sqlitePath = join(dir, 'kaola.sqlite')
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return sqlitePath
}

function tableExists(sqlite, name) {
  return (
    sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  )
}

function rowCount(sqlite, table) {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
  return row.n
}

// Replaces the global console.error for the duration of one test, capturing every call. Restored
// unconditionally via t.after so a failing assertion never leaks the spy into later tests.
function captureConsoleError(t) {
  const calls = []
  const original = console.error
  console.error = (...args) => {
    calls.push(args)
  }
  t.after(() => {
    console.error = original
  })
  return calls
}

function joinedText(calls) {
  return calls.map((args) => args.map((value) => String(value)).join(' ')).join('\n')
}

// Seeds the "only-copy" orphan shape for `leases`: no `leases` table on disk at all (createDb's
// own LEASES_DDL will create it fresh and empty), and a `leases__rebuild` table - the exact
// 11-column shape rebuildLeasesIfAgentKeyStillRequired's own CREATE TABLE produces (db.ts:134-146)
// - holding the only surviving copies of `rowCount` rows. This is the durable, on-disk result of a
// crash between that rebuild's `DROP TABLE leases` and its `ALTER TABLE ... RENAME TO leases`
// (pre-#37/#38/#39-fix, when the whole script was not wrapped in a transaction).
function seedLeasesOnlyCopyOrphan(sqlitePath, rowsToInsert) {
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
  const insert = raw.prepare(
    `INSERT INTO leases__rebuild
       (task_id, claimer_user_id, device_id, agent_key_id, claimed_at, expires_at, last_heartbeat, state, request_id)
     VALUES (@task_id, @claimer_user_id, @device_id, @agent_key_id, @claimed_at, @expires_at, @last_heartbeat, @state, @request_id)`,
  )
  for (let i = 0; i < rowsToInsert; i += 1) {
    insert.run({
      task_id: 100 + i,
      claimer_user_id: 7,
      device_id: 3,
      agent_key_id: null,
      claimed_at: 1000,
      expires_at: 87400,
      last_heartbeat: 1000,
      state: 'active',
      request_id: `req-${i}`,
    })
  }
  raw.close()
}

// Same "only-copy" shape for the sibling table: no `claim_confirmations` table on disk, and a
// `claim_confirmations__rebuild` table - the exact 7-column shape
// rebuildClaimConfirmationsIfAgentKeyStillRequired's own CREATE TABLE produces (db.ts:182-190) -
// holding the only surviving copies of `rowsToInsert` rows.
function seedClaimConfirmationsOnlyCopyOrphan(sqlitePath, rowsToInsert) {
  const raw = new Database(sqlitePath)
  raw.exec(`
    CREATE TABLE claim_confirmations__rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      agent_key_id INTEGER,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  const insert = raw.prepare(
    `INSERT INTO claim_confirmations__rebuild (task_id, user_id, device_id, agent_key_id, state, created_at)
     VALUES (@task_id, @user_id, @device_id, @agent_key_id, @state, @created_at)`,
  )
  for (let i = 0; i < rowsToInsert; i += 1) {
    insert.run({
      task_id: 200 + i,
      user_id: 5,
      device_id: 3,
      agent_key_id: null,
      state: 'confirmed',
      created_at: 1000 + i,
    })
  }
  raw.close()
}

// Negative fixture, self-contained (not imported from db-migration.test.ts, which is under
// separate custody): a pre-#36 legacy `leases` table - claimer_user_id declared NOT NULL, WITH its
// real data - plus an EMPTY `leases__rebuild` orphan left over from an interrupted INSERT. This is
// the "successful legacy migration" shape: the live table already holds the real data, so the
// guarded rebuild fires, recovers the schema, and consumes the orphan. No data is stranded in the
// orphan here, so this must NOT be reported.
function seedSuccessfulLegacyMigration(sqlitePath) {
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
    );
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
    );
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

describe('createDb reports (but does not auto-recover) an only-copy __rebuild orphan', { concurrency: false }, () => {
  test('reports the leases__rebuild-only-copy orphan via console.error, without touching either table', (t) => {
    const sqlitePath = sqliteFile(t)
    seedLeasesOnlyCopyOrphan(sqlitePath, 2)
    const calls = captureConsoleError(t)

    let db
    assert.doesNotThrow(() => {
      db = createDb(sqlitePath)
    }, 'createDb must still boot successfully against this state (the live table is empty, not corrupt)')
    t.after(() => db.$client.close())
    const sqlite = db.$client

    assert.equal(
      calls.length,
      1,
      `expected exactly one console.error call reporting the stranded leases__rebuild orphan, got ${calls.length}`,
    )
    const text = joinedText(calls)
    assert.match(
      text,
      /leases__rebuild/,
      'the report must name the orphan table (leases__rebuild) so an operator knows where the data is',
    )
    assert.match(
      text,
      /\b2\b/,
      'the report must include the orphan row count (2) so an operator knows how much data is stranded',
    )

    // Hard constraint: reporting only, never silent auto-recovery.
    assert.equal(
      rowCount(sqlite, 'leases'),
      0,
      'createDb must not have moved the orphan rows into the live (empty) leases table on its own',
    )
    assert.equal(
      tableExists(sqlite, 'leases__rebuild'),
      true,
      'the orphan table must still exist untouched - it may be an incomplete copy, so createDb must not drop it either',
    )
    assert.equal(
      rowCount(sqlite, 'leases__rebuild'),
      2,
      'the orphan row count must be unchanged - createDb must not mutate it',
    )
  })

  test('reports the claim_confirmations__rebuild-only-copy orphan via console.error, without touching either table', (t) => {
    const sqlitePath = sqliteFile(t)
    seedClaimConfirmationsOnlyCopyOrphan(sqlitePath, 3)
    const calls = captureConsoleError(t)

    let db
    assert.doesNotThrow(() => {
      db = createDb(sqlitePath)
    }, 'createDb must still boot successfully against this state')
    t.after(() => db.$client.close())
    const sqlite = db.$client

    assert.equal(
      calls.length,
      1,
      `expected exactly one console.error call reporting the stranded claim_confirmations__rebuild orphan, got ${calls.length}`,
    )
    const text = joinedText(calls)
    assert.match(
      text,
      /claim_confirmations__rebuild/,
      'the report must name the orphan table (claim_confirmations__rebuild)',
    )
    assert.match(
      text,
      /\b3\b/,
      'the report must include the orphan row count (3)',
    )

    assert.equal(
      rowCount(sqlite, 'claim_confirmations'),
      0,
      'createDb must not have moved the orphan rows into the live (empty) claim_confirmations table on its own',
    )
    assert.equal(
      tableExists(sqlite, 'claim_confirmations__rebuild'),
      true,
      'the orphan table must still exist untouched',
    )
    assert.equal(
      rowCount(sqlite, 'claim_confirmations__rebuild'),
      3,
      'the orphan row count must be unchanged',
    )
  })

  test('reports nothing for a fresh database (no orphan of either kind exists)', (t) => {
    const calls = captureConsoleError(t)
    const db = createDb(':memory:')
    t.after(() => db.$client.close())

    assert.equal(
      calls.length,
      0,
      `a fresh database must not warn about anything; got ${calls.length} console.error call(s): ${joinedText(calls)}`,
    )
  })

  test('reports nothing for an already-migrated database across two successive boots', (t) => {
    const sqlitePath = sqliteFile(t)
    seedSuccessfulLegacyMigration(sqlitePath)
    const calls = captureConsoleError(t)

    // First boot performs (and completes) the legacy rebuild.
    const first = createDb(sqlitePath)
    first.$client.close()
    assert.equal(
      calls.length,
      0,
      `the first boot completes a normal migration and must not warn; got: ${joinedText(calls)}`,
    )

    // Second boot runs against an already-migrated file - the ordinary "nothing to do" path.
    const second = createDb(sqlitePath)
    t.after(() => second.$client.close())
    assert.equal(
      calls.length,
      0,
      `a second boot against an already-migrated file must not warn; got: ${joinedText(calls)}`,
    )
  })

  test('reports nothing for a successful legacy migration that resolves its own (empty) orphan', (t) => {
    const sqlitePath = sqliteFile(t)
    seedSuccessfulLegacyMigration(sqlitePath)
    const calls = captureConsoleError(t)

    const db = createDb(sqlitePath)
    t.after(() => db.$client.close())
    const sqlite = db.$client

    // Sanity: this fixture really does exercise the guarded rebuild and really does carry the row
    // through, so a passing negative here is not a vacuous no-op.
    assert.equal(tableExists(sqlite, 'leases__rebuild'), false, 'the successful rebuild must still consume its own orphan')
    assert.equal(rowCount(sqlite, 'leases'), 1, 'the real row must have survived the migration')

    assert.equal(
      calls.length,
      0,
      `a successful legacy migration - where the live table (not an orphan) always held the real data - must not warn; got: ${joinedText(calls)}`,
    )
  })
})
