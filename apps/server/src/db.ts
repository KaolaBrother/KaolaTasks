import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { agentKeys, credentialProfiles, events, leases, tasks, users } from './schema.ts'

const USERS_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  permission_level TEXT NOT NULL,
  UNIQUE (provider, remote_id)
)
`

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
  claimer_user_id INTEGER NOT NULL,
  agent_key_id INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  state TEXT NOT NULL
)
`

const LEASES_ONE_ACTIVE_INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_task
  ON leases(task_id) WHERE state = 'active'
`

export function createDb(path = ':memory:') {
  const sqlite = new Database(path)
  sqlite.exec(USERS_DDL)
  sqlite.exec(AGENT_KEYS_DDL)
  sqlite.exec(CREDENTIAL_PROFILES_DDL)
  sqlite.exec(TASKS_DDL)
  sqlite.exec(EVENTS_DDL)
  sqlite.exec(LEASES_DDL)
  sqlite.exec(LEASES_ONE_ACTIVE_INDEX_DDL)
  return drizzle(sqlite, {
    schema: { users, agentKeys, credentialProfiles, tasks, events, leases },
  })
}

export type AppDb = ReturnType<typeof createDb>
