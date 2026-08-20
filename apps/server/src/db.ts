import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { agentKeys, credentialProfiles, events, users } from './schema.ts'

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

const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  actor_user_id INTEGER,
  created_at INTEGER NOT NULL,
  details TEXT NOT NULL
)
`

export function createDb(path = ':memory:') {
  const sqlite = new Database(path)
  sqlite.exec(USERS_DDL)
  sqlite.exec(AGENT_KEYS_DDL)
  sqlite.exec(CREDENTIAL_PROFILES_DDL)
  sqlite.exec(EVENTS_DDL)
  return drizzle(sqlite, { schema: { users, agentKeys, credentialProfiles, events } })
}

export type AppDb = ReturnType<typeof createDb>
