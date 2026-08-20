import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

export function createDb(path = ':memory:') {
  const sqlite = new Database(path)
  return drizzle(sqlite)
}

export const db = createDb(process.env.SQLITE_PATH ?? ':memory:')
