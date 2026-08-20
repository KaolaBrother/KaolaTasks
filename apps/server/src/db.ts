import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { users } from './schema.ts'

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

export function createDb(path = ':memory:') {
  const sqlite = new Database(path)
  sqlite.exec(USERS_DDL)
  return drizzle(sqlite, { schema: { users } })
}

export type AppDb = ReturnType<typeof createDb>
