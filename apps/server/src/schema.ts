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

export const agentKeys = sqliteTable(
  'agent_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    keyHash: text('key_hash').notNull(),
    label: text('label').notNull().default(''),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [unique('agent_keys_key_hash').on(t.keyHash)],
)

export const credentialProfiles = sqliteTable(
  'credential_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    forge: text('forge', { enum: ['github', 'gitlab', 'gitea'] }).notNull(),
    baseUrl: text('base_url').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    tokenEncrypted: text('token_encrypted').notNull(),
    scopesChecked: text('scopes_checked').notNull().default('[]'),
    createdBy: integer('created_by').notNull(),
  },
  (t) => [unique('credential_profiles_forge_base_url_repo').on(t.forge, t.baseUrl, t.repoFullName)],
)

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  actorUserId: integer('actor_user_id'),
  createdAt: integer('created_at').notNull(),
  details: text('details').notNull(),
})

export type User = typeof users.$inferSelect
export type UserProvider = User['provider']
export type AgentKey = typeof agentKeys.$inferSelect
export type CredentialProfile = typeof credentialProfiles.$inferSelect
export type AuditEvent = typeof events.$inferSelect
