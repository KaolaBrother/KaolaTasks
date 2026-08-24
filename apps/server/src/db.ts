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
  sqlite.exec(AGENT_KEYS_DDL)
  sqlite.exec(CREDENTIAL_PROFILES_DDL)
  sqlite.exec(TASKS_DDL)
  sqlite.exec(EVENTS_DDL)
  sqlite.exec(LEASES_DDL)
  tryAddColumn(sqlite, LEASES_ADD_DEVICE_ID_DDL)
  tryAddColumn(sqlite, LEASES_ADD_CLAIMER_CLAIMANT_ID_DDL)
  sqlite.exec(LEASES_ONE_ACTIVE_INDEX_DDL)
  sqlite.exec(SUBMISSIONS_DDL)
  sqlite.exec(CLAIM_CONFIRMATIONS_DDL)
  tryAddColumn(sqlite, CLAIM_CONFIRMATIONS_ADD_DEVICE_ID_DDL)
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
