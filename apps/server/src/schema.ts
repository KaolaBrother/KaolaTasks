import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

export const DEFAULT_DEVICE_MAX_AGE_DAYS = 90

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider', { enum: ['github', 'gitlab', 'gitea', 'local'] }).notNull(),
    remoteId: text('remote_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status', { enum: ['active', '待批准', 'revoked'] }).notNull(),
    permissionLevel: text('permission_level', { enum: ['admin', 'full', 'claim_only'] }).notNull(),
    passwordHash: text('password_hash'),
    // Issue #16: default off — autonomous claims from this user need a per-claim confirmation
    // until the user opts in via PUT /api/v1/me/settings.
    trustedAutomation: integer('trusted_automation', { mode: 'boolean' }).notNull().default(false),
    deviceMaxAgeDays: integer('device_max_age_days').notNull().default(DEFAULT_DEVICE_MAX_AGE_DAYS),
    maxDevices: integer('max_devices').notNull().default(5),
    deviceIdleDays: integer('device_idle_days').notNull().default(0),
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

// DESIGN.md §6 is the wire contract; the columns below are its storage form. Scalars that the
// brief nests (source, repo, constraints) are flattened, and its string arrays are JSON text.
export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull(),
    title: text('title').notNull(),
    descriptionMd: text('description_md').notNull().default(''),
    sourceType: text('source_type', { enum: ['native', 'imported'] }).notNull(),
    sourceIssueUrl: text('source_issue_url'),
    repoForge: text('repo_forge', { enum: ['github', 'gitlab', 'gitea'] }).notNull(),
    repoBaseUrl: text('repo_base_url').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    repoBaseBranch: text('repo_base_branch').notNull(),
    repoSuggestedDir: text('repo_suggested_dir').notNull(),
    acceptanceCriteria: text('acceptance_criteria').notNull().default('[]'),
    testCommand: text('test_command').notNull().default(''),
    allowedPaths: text('allowed_paths').notNull().default('[]'),
    forbiddenPaths: text('forbidden_paths').notNull().default('[]'),
    priority: text('priority', { enum: ['P0', 'P1', 'P2', 'P3'] }).notNull(),
    tags: text('tags').notNull().default('[]'),
    credentialProfileId: integer('credential_profile_id'),
    inlineTokenEncrypted: text('inline_token_encrypted'),
    posterUserId: integer('poster_user_id').notNull(),
    status: text('status', {
      enum: ['待认领', '进行中', '待验收', '待修改', '待合并', '已完成', '已退回', '已取消'],
    }).notNull(),
    createdAt: integer('created_at').notNull(),
    // Issue #53 (D13): nullable self-reference to the parent task's integer PK.
    parentTaskId: integer('parent_task_id'),
  },
  (t) => [
    unique('tasks_public_id').on(t.publicId),
    // DESIGN.md §10: credential_profile_id / inline_token_encrypted 二选一.
    check(
      'tasks_credential_xor',
      sql`(${t.credentialProfileId} IS NULL) != (${t.inlineTokenEncrypted} IS NULL)`,
    ),
  ],
)

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  actorUserId: integer('actor_user_id'),
  createdAt: integer('created_at').notNull(),
  details: text('details').notNull(),
})

export const leases = sqliteTable('leases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id').notNull(),
  claimerUserId: integer('claimer_user_id'),
  claimerClaimantId: integer('claimer_claimant_id'),
  deviceId: integer('device_id').notNull(),
  agentKeyId: integer('agent_key_id'),
  claimedAt: integer('claimed_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  lastHeartbeat: integer('last_heartbeat').notNull(),
  state: text('state', { enum: ['active', 'released', 'expired'] }).notNull(),
  // Issue #36: the client-supplied idempotency key for a claim attempt (device_id, request_id)
  // pair. Nullable — legacy leases and clients that omit request_id have none.
  requestId: text('request_id'),
})

// DESIGN.md §10: submissions persist a submitted PR against the lease that held the task.
// Issue #31: one submission per Claim (lease) — the actual constraint is the
// `submissions_lease_id` unique index created by db.ts; this mirrors it for drizzle's typing.
export const submissions = sqliteTable(
  'submissions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id').notNull(),
    leaseId: integer('lease_id').notNull(),
    prUrl: text('pr_url').notNull(),
    summary: text('summary').notNull(),
    prState: text('pr_state').notNull(),
    // Issue #53: the delivered head, its branch, Draft flag, and the current review round.
    headSha: text('head_sha'),
    headBranch: text('head_branch'),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
    reviewRound: integer('review_round').notNull().default(0),
    // Issue #54 (§17.7): the PR head most recently observed on the forge, by either a poller
    // tick or the approve live check — distinct from `headSha` (the Agent-reported head), which
    // it is checked against and never overwrites. Reset to NULL by submit_revision.
    forgeHeadSha: text('forge_head_sha'),
    forgeHeadSeenAt: integer('forge_head_seen_at'),
  },
  (t) => [unique('submissions_lease_id').on(t.leaseId)],
)

// Issue #53: one row per revision Claim that handed a new head back (lease_id unique — one
// revision Claim, one 交回). The first submission itself stays on `submissions`.
export const submissionRevisions = sqliteTable(
  'submission_revisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    submissionId: integer('submission_id').notNull(),
    leaseId: integer('lease_id').notNull(),
    round: integer('round').notNull(),
    headSha: text('head_sha').notNull(),
    summary: text('summary').notNull(),
    submittedAt: integer('submitted_at').notNull(),
  },
  (t) => [unique('submission_revisions_lease_id').on(t.leaseId)],
)

// Issue #53 (D11): one row per review round; (task_id, round) unique.
export const reviewRounds = sqliteTable(
  'review_rounds',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id').notNull(),
    round: integer('round').notNull(),
    kind: text('kind', { enum: ['review', 'downstream_finding', 'restack'] }).notNull(),
    openedByUserId: integer('opened_by_user_id'),
    openedByTaskId: integer('opened_by_task_id'),
    verdict: text('verdict', { enum: ['changes_requested', 'approved', 'terminated', 'withdrawn'] }),
    openedAt: integer('opened_at').notNull(),
    revisedAt: integer('revised_at'),
    revisionHeadSha: text('revision_head_sha'),
  },
  (t) => [unique('review_rounds_task_round').on(t.taskId, t.round)],
)

// Issue #53 (D9): the task-level discussion thread. `round` is null until 提交本轮意见 folds the
// message into a round. `anchor` is JSON text `{ path, line, head_sha, url }` or null.
export const discussionMessages = sqliteTable('discussion_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id').notNull(),
  round: integer('round'),
  authorKind: text('author_kind', { enum: ['reviewer', 'agent', 'system', 'forge'] }).notNull(),
  authorUserId: integer('author_user_id'),
  authorDeviceId: integer('author_device_id'),
  kind: text('kind', {
    enum: ['blocking', 'suggestion', 'question', 'answer', 'note', 'resolution'],
  }).notNull(),
  bodyMd: text('body_md').notNull(),
  anchor: text('anchor'),
  replyToMessageId: integer('reply_to_message_id'),
  resolvesMessageId: integer('resolves_message_id'),
  createdAt: integer('created_at').notNull(),
})

// Issue #16: parks an autonomous claim (task.id PK, not public_id) awaiting the claiming user's
// approval or rejection. One row is reused per (task_id, user_id, agent_key_id) while pending.
export const claimConfirmations = sqliteTable('claim_confirmations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id').notNull(),
  userId: integer('user_id').notNull(),
  deviceId: integer('device_id').notNull(),
  agentKeyId: integer('agent_key_id'),
  state: text('state', { enum: ['pending', 'approved', 'rejected'] }).notNull(),
  createdAt: integer('created_at').notNull(),
})


export const claimants = sqliteTable('claimants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  displayName: text('display_name').notNull(),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  deviceMaxAgeDays: integer('device_max_age_days').notNull().default(DEFAULT_DEVICE_MAX_AGE_DAYS),
  maxDevices: integer('max_devices').notNull().default(5),
  deviceIdleDays: integer('device_idle_days').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})

export const devices = sqliteTable(
  'devices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fingerprint: text('fingerprint').notNull(),
    publicKey: text('public_key').notNull(),
    hostname: text('hostname').notNull().default(''),
    status: text('status', { enum: ['pending', 'active', 'expired', 'revoked'] }).notNull(),
    claimantId: integer('claimant_id'),
    userId: integer('user_id'),
    createdAt: integer('created_at').notNull(),
    pendingExpiresAt: integer('pending_expires_at'),
    pairedAt: integer('paired_at'),
    expiresAt: integer('expires_at'),
    lastSeen: integer('last_seen'),
  },
  (t) => [unique('devices_fingerprint').on(t.fingerprint)],
)
export type User = typeof users.$inferSelect
export type UserProvider = User['provider']
export type AgentKey = typeof agentKeys.$inferSelect
export type CredentialProfile = typeof credentialProfiles.$inferSelect
export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
export type AuditEvent = typeof events.$inferSelect
export type Lease = typeof leases.$inferSelect
export type Submission = typeof submissions.$inferSelect
export type SubmissionRevision = typeof submissionRevisions.$inferSelect
export type ReviewRound = typeof reviewRounds.$inferSelect
export type DiscussionMessage = typeof discussionMessages.$inferSelect
export type ClaimConfirmation = typeof claimConfirmations.$inferSelect
export type Claimant = typeof claimants.$inferSelect
export type Device = typeof devices.$inferSelect

export const appSettings = sqliteTable('app_settings', {
  k: text('k').primaryKey(),
  v: text('v').notNull(),
})

export const devicePairings = sqliteTable(
  'device_pairings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pairingId: text('pairing_id').notNull(),
    deviceId: integer('device_id').notNull(),
    protocolVersion: text('protocol_version').notNull(),
    clientNonceHex: text('client_nonce_hex').notNull(),
    serverNonceHex: text('server_nonce_hex').notNull(),
    origin: text('origin').notNull(),
    instanceId: text('instance_id').notNull(),
    rootSha256: text('root_sha256').notNull(),
    commitmentHex: text('commitment_hex'),
    status: text('status', {
      enum: ['created', 'committed', 'approved', 'consumed', 'rejected', 'expired'],
    }).notNull(),
    approvalPayload: text('approval_payload'),
    approvalProof: text('approval_proof'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    approvedAt: integer('approved_at'),
    consumedAt: integer('consumed_at'),
  },
  (t) => [unique('device_pairings_pairing_id').on(t.pairingId)],
)

export type AppSetting = typeof appSettings.$inferSelect
export type DevicePairing = typeof devicePairings.$inferSelect
export type NewDevicePairing = typeof devicePairings.$inferInsert

