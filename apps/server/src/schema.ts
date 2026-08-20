import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider', { enum: ['github', 'gitlab', 'gitea'] }).notNull(),
    remoteId: text('remote_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status', { enum: ['active', '待批准'] }).notNull(),
    permissionLevel: text('permission_level', { enum: ['full', 'claim_only'] }).notNull(),
  },
  (t) => [unique('users_provider_remote_id').on(t.provider, t.remoteId)],
)

export type User = typeof users.$inferSelect
export type UserProvider = User['provider']
