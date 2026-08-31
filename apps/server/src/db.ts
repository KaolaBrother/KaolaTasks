import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import {
  agentKeys,
  claimConfirmations,
  claimants,
  credentialProfiles,
  devices,
  events,
  leases,
  submissions,
  tasks,
  users,
} from './schema.ts'

const USERS_DDL = `
CREATE TABLE IF NOT EXISTS users (
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
)
`

const USERS_ADD_TRUSTED_AUTOMATION_DDL = `
ALTER TABLE users ADD COLUMN trusted_automation INTEGER NOT NULL DEFAULT 0
`

const USERS_ADD_DEVICE_MAX_AGE_DDL = `
ALTER TABLE users ADD COLUMN device_max_age_days INTEGER NOT NULL DEFAULT 30
`

const USERS_ADD_MAX_DEVICES_DDL = `
ALTER TABLE users ADD COLUMN max_devices INTEGER NOT NULL DEFAULT 5
`

const USERS_ADD_DEVICE_IDLE_DDL = `
ALTER TABLE users ADD COLUMN device_idle_days INTEGER NOT NULL DEFAULT 0
`

const USERS_ADD_PASSWORD_HASH_DDL = `
ALTER TABLE users ADD COLUMN password_hash TEXT
`

const USERS_LOCAL_USERNAME_INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS users_local_username
  ON users(lower(trim(username))) WHERE provider = 'local'
`

function promoteEarliestLoginableAdmin(sqlite: InstanceType<typeof Database>): void {
  const existing = sqlite
    .prepare(
      `SELECT id FROM users
       WHERE status = 'active' AND permission_level = 'admin'
         AND provider IN ('local', 'gitlab', 'gitea')
       LIMIT 1`,
    )
    .get()
  if (existing != null) return
  sqlite
    .prepare(
      `UPDATE users SET permission_level = 'admin'
       WHERE id = (
         SELECT id FROM users
         WHERE status = 'active' AND permission_level = 'full'
           AND provider IN ('local', 'gitlab', 'gitea')
         ORDER BY id
         LIMIT 1
       )`,
    )
    .run()
}

function isDuplicateColumnError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    'message' in err &&
    /duplicate column name/i.test(String((err as { message: unknown }).message))
  )
}

function tryAddColumn(sqlite: InstanceType<typeof Database>, ddl: string): void {
  try {
    sqlite.exec(ddl)
  } catch (err) {
    if (!isDuplicateColumnError(err)) throw err
  }
}

function tableExists(sqlite: InstanceType<typeof Database>, name: string): boolean {
  return (
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  )
}

function rowCount(sqlite: InstanceType<typeof Database>, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

// Issue #44: a database orphaned by a pre-#37/#38/#39-fix crash can leave a `<table>__rebuild`
// table on disk as the ONLY surviving copy of its rows, while the live `<table>` comes up empty
// (either freshly created by this file's own `CREATE TABLE IF NOT EXISTS` DDL, or because the
// guarded rebuild above short-circuited since the live table no longer needs rebuilding). createDb
// must not treat that as fatal (the live table is empty, not corrupt) and must not guess whether
// the orphan's rows are safe to replay (a crash mid-INSERT can leave it incomplete) - so this only
// reports the fact via console.error, once per stranded orphan, and never mutates either table.
function reportStrandedRebuildOrphan(
  sqlite: InstanceType<typeof Database>,
  liveTable: string,
  orphanTable: string,
): void {
  if (!tableExists(sqlite, orphanTable)) return
  const orphanRows = rowCount(sqlite, orphanTable)
  if (orphanRows === 0) return
  if (rowCount(sqlite, liveTable) !== 0) return
  console.error(
    `[kaola-server] found orphaned rebuild table "${orphanTable}" holding ${orphanRows} row(s) ` +
      `while live table "${liveTable}" is empty; data was left in place untouched - ` +
      `manual review required before recovering or discarding it.`,
  )
}

type SqliteTableColumn = { name: string; notnull: number }

function tableColumns(
  sqlite: InstanceType<typeof Database>,
  table: string,
): SqliteTableColumn[] {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all() as SqliteTableColumn[]
}

function columnIsNotNull(
  columns: SqliteTableColumn[],
  name: string,
): boolean {
  const column = columns.find((row) => row.name === name)
  return column != null && column.notnull === 1
}

// Guarded and transactional: sqlite.exec() is not transactional on its own, so a fault partway
// through this statement script (a crash, power loss, or killed container between the CREATE and
// the RENAME) would otherwise leave a durable orphan `leases__rebuild` table on disk that collides
// with the CREATE on every subsequent boot attempt, permanently bricking the server. The leading
// DROP TABLE IF EXISTS clears any such orphan from a prior crashed boot before rebuilding (the
// orphan is scratch state only — the real data still lives in `leases` until this rebuild's own
// DROP TABLE leases below), and wrapping the whole script in a transaction means a fault now leaves
// no residue at all.
function rebuildLeasesIfAgentKeyStillRequired(sqlite: InstanceType<typeof Database>): void {
  const columns = tableColumns(sqlite, 'leases')
  if (columns.length === 0) return
  if (!columnIsNotNull(columns, 'agent_key_id') && !columnIsNotNull(columns, 'claimer_user_id')) {
    return
  }
  sqlite.transaction(() => {
    sqlite.exec(`
      DROP TABLE IF EXISTS leases__rebuild;
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
      INSERT INTO leases__rebuild (
        id, task_id, claimer_user_id, claimer_claimant_id, device_id, agent_key_id,
        claimed_at, expires_at, last_heartbeat, state, request_id
      )
      SELECT
        id, task_id, claimer_user_id, claimer_claimant_id, device_id, agent_key_id,
        claimed_at, expires_at, last_heartbeat, state, request_id
      FROM leases;
      DROP TABLE leases;
      ALTER TABLE leases__rebuild RENAME TO leases;
      CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_task
        ON leases(task_id) WHERE state = 'active';
    `)
  })()
}

// Guarded and transactional for the same reason as rebuildLeasesIfAgentKeyStillRequired above:
// sqlite.exec() is not transactional, so a fault partway through this statement script (a crash,
// power loss, or killed container between the CREATE and the RENAME) would otherwise leave a
// durable orphan `claim_confirmations__rebuild` table on disk that collides with the CREATE on
// every subsequent boot attempt, permanently bricking the server. This sibling has no known
// trigger today, but has the identical unguarded shape, so it carries the identical risk. The
// leading DROP TABLE IF EXISTS clears any such orphan before rebuilding (the orphan is scratch
// state only — the real data still lives in `claim_confirmations` until this rebuild's own DROP
// TABLE below), and wrapping the whole script in a transaction means a fault now leaves no residue
// at all.
function rebuildClaimConfirmationsIfAgentKeyStillRequired(
  sqlite: InstanceType<typeof Database>,
): void {
  const columns = tableColumns(sqlite, 'claim_confirmations')
  if (columns.length === 0) return
  if (!columnIsNotNull(columns, 'agent_key_id')) return
  sqlite.transaction(() => {
    sqlite.exec(`
      DROP TABLE IF EXISTS claim_confirmations__rebuild;
      CREATE TABLE claim_confirmations__rebuild (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        device_id INTEGER NOT NULL,
        agent_key_id INTEGER,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO claim_confirmations__rebuild (
        id, task_id, user_id, device_id, agent_key_id, state, created_at
      )
      SELECT id, task_id, user_id, device_id, agent_key_id, state, created_at
      FROM claim_confirmations;
      DROP TABLE claim_confirmations;
      ALTER TABLE claim_confirmations__rebuild RENAME TO claim_confirmations;
    `)
  })()
}

const AGENT_KEYS_DDL = `
CREATE TABLE IF NOT EXISTS agent_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  last_used_at INTEGER
)
`

const CREDENTIAL_PROFILES_DDL = `
CREATE TABLE IF NOT EXISTS credential_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  forge TEXT NOT NULL,
  base_url TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  scopes_checked TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER NOT NULL,
  UNIQUE (forge, base_url, repo_full_name)
)
`

const TASKS_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
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
)
`

const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  actor_user_id INTEGER,
  created_at INTEGER NOT NULL,
  details TEXT NOT NULL
)
`

const LEASES_DDL = `
CREATE TABLE IF NOT EXISTS leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  claimer_user_id INTEGER,
  claimer_claimant_id INTEGER,
  device_id INTEGER NOT NULL,
  agent_key_id INTEGER,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  state TEXT NOT NULL
)
`

const LEASES_ADD_DEVICE_ID_DDL = `
ALTER TABLE leases ADD COLUMN device_id INTEGER NOT NULL DEFAULT 0
`

const LEASES_ADD_CLAIMER_CLAIMANT_ID_DDL = `
ALTER TABLE leases ADD COLUMN claimer_claimant_id INTEGER
`

const LEASES_ONE_ACTIVE_INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_task
  ON leases(task_id) WHERE state = 'active'
`

// Issue #36: request_id is the client-supplied idempotency key for a claim attempt. Nullable —
// added BEFORE rebuildLeasesIfAgentKeyStillRequired, because that rebuild's own INSERT ... SELECT
// reads request_id off the existing table (see below). A legacy database still carrying
// `agent_key_id NOT NULL` / `claimer_user_id NOT NULL` has no such column yet, so running the
// rebuild first made createDb throw `no such column: request_id` and the server could not boot at
// all. The ALTER is additive and tryAddColumn is idempotent, so running it first is safe for
// already-migrated databases too.
const LEASES_ADD_REQUEST_ID_DDL = `
ALTER TABLE leases ADD COLUMN request_id TEXT
`

const LEASES_DEVICE_REQUEST_IDENTITY_INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS leases_device_request_identity
  ON leases(device_id, request_id) WHERE request_id IS NOT NULL
`

const SUBMISSIONS_DDL = `
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  lease_id INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  summary TEXT NOT NULL,
  pr_state TEXT NOT NULL
)
`

// Issue #31: one submission per Claim (lease) — enforces submit_pr's idempotent-repeat contract
// at the storage layer, not just in application code.
const SUBMISSIONS_LEASE_ID_INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS submissions_lease_id
  ON submissions(lease_id)
`

const CLAIM_CONFIRMATIONS_DDL = `
CREATE TABLE IF NOT EXISTS claim_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  agent_key_id INTEGER,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
`

const CLAIM_CONFIRMATIONS_ADD_DEVICE_ID_DDL = `
ALTER TABLE claim_confirmations ADD COLUMN device_id INTEGER NOT NULL DEFAULT 0
`

const CLAIMANTS_DDL = `
CREATE TABLE IF NOT EXISTS claimants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  device_max_age_days INTEGER NOT NULL DEFAULT 30,
  max_devices INTEGER NOT NULL DEFAULT 5,
  device_idle_days INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
`

const DEVICES_DDL = `
CREATE TABLE IF NOT EXISTS devices (
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
)
`

export function createDb(path = ':memory:') {
  const sqlite = new Database(path)
  sqlite.exec(USERS_DDL)
  tryAddColumn(sqlite, USERS_ADD_TRUSTED_AUTOMATION_DDL)
  tryAddColumn(sqlite, USERS_ADD_DEVICE_MAX_AGE_DDL)
  tryAddColumn(sqlite, USERS_ADD_MAX_DEVICES_DDL)
  tryAddColumn(sqlite, USERS_ADD_DEVICE_IDLE_DDL)
  tryAddColumn(sqlite, USERS_ADD_PASSWORD_HASH_DDL)
  sqlite.exec(USERS_LOCAL_USERNAME_INDEX_DDL)
  promoteEarliestLoginableAdmin(sqlite)
  sqlite.exec(AGENT_KEYS_DDL)
  sqlite.exec(CREDENTIAL_PROFILES_DDL)
  sqlite.exec(TASKS_DDL)
  sqlite.exec(EVENTS_DDL)
  sqlite.exec(LEASES_DDL)
  tryAddColumn(sqlite, LEASES_ADD_DEVICE_ID_DDL)
  tryAddColumn(sqlite, LEASES_ADD_CLAIMER_CLAIMANT_ID_DDL)
  tryAddColumn(sqlite, LEASES_ADD_REQUEST_ID_DDL)
  rebuildLeasesIfAgentKeyStillRequired(sqlite)
  reportStrandedRebuildOrphan(sqlite, 'leases', 'leases__rebuild')
  sqlite.exec(LEASES_ONE_ACTIVE_INDEX_DDL)
  sqlite.exec(LEASES_DEVICE_REQUEST_IDENTITY_INDEX_DDL)
  sqlite.exec(SUBMISSIONS_DDL)
  sqlite.exec(SUBMISSIONS_LEASE_ID_INDEX_DDL)
  sqlite.exec(CLAIM_CONFIRMATIONS_DDL)
  tryAddColumn(sqlite, CLAIM_CONFIRMATIONS_ADD_DEVICE_ID_DDL)
  rebuildClaimConfirmationsIfAgentKeyStillRequired(sqlite)
  reportStrandedRebuildOrphan(sqlite, 'claim_confirmations', 'claim_confirmations__rebuild')
  sqlite.exec(CLAIMANTS_DDL)
  sqlite.exec(DEVICES_DDL)
  return drizzle(sqlite, {
    schema: {
      users,
      agentKeys,
      credentialProfiles,
      tasks,
      events,
      leases,
      submissions,
      claimConfirmations,
      claimants,
      devices,
    },
  })
}

export type AppDb = ReturnType<typeof createDb>
