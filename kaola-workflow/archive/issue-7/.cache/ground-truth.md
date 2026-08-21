# Ground truth for issue #7 — M1 Task CRUD + 发布即校验

Read-only exploration. Every signature below is transcribed from source in the worktree
`/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`. Nothing was edited.
Where I could not verify something, it is marked **UNVERIFIED**.

**Scope note:** I was not able to read the text of GitHub issue #7 (no network/`gh` tool in this
role, and `kaola-workflow/issue-7/.cache/` contains only `origin/selection-record.json` and
`dispatch-log.jsonl` — no cached issue body). So this file maps *code*, not the issue. The
"issue vs. code" premise check is still owed by whoever holds the issue text.

---

## 0. Files that matter

| File (absolute) | Role |
|---|---|
| `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7/apps/server/src/app.ts` | `buildApp` — where a new `register*` must be wired |
| `.../apps/server/src/auth.ts` | session, OAuth, `getSessionUser`, `sendUnauthorized`, `wantsJson` |
| `.../apps/server/src/agent-keys.ts` | Bearer child-context pattern, `status === 'active'` gate |
| `.../apps/server/src/credential-profiles.ts` | closest template for a task-CRUD module |
| `.../apps/server/src/db.ts` | raw-DDL table creation — new tables must be registered here |
| `.../apps/server/src/schema.ts` | drizzle table defs + inferred types |
| `.../apps/server/src/vault.ts` | encrypt/decrypt/reveal + `insertAuditEvent` |
| `.../packages/shared/src/index.ts` | `taskBriefSchema`, `parseTaskBrief`, `transitionTaskStatus` |
| `.../packages/forge-adapters/src/index.ts` | `createForgeAdapter`, internal `validateToken` |
| `.../apps/web/src/App.vue` | the entire frontend (single file) |
| `.../apps/server/src/vault.test.ts`, `.../agent-keys.test.ts`, `.../auth.test.ts` | test idiom |
| `.../docs/DESIGN.md` §5/§6/§10 | contract source of truth |
| `.../docs/api.md` | records what is implemented (must be updated when HTTP changes) |

---

## 1. ROUTE CONVENTIONS

### 1.1 Registrar signature shape

All three registrars are **synchronous, non-async, void-returning** and take exactly
`(app: FastifyInstance, db: AppDb)`:

```ts
export function registerAuth(app: FastifyInstance, db: AppDb) {        // auth.ts:241
export function registerAgentKeys(app: FastifyInstance, db: AppDb) {   // agent-keys.ts:65
export function registerCredentialProfiles(app: FastifyInstance, db: AppDb) {  // credential-profiles.ts:88
```

`AppDb` is imported as a type only: `import type { AppDb } from './db.ts'`. Note the `.ts`
extension on every relative import (`allowImportingTsExtensions: true` in
`apps/server/tsconfig.json`, and `--experimental-strip-types` at runtime).

Wiring, `apps/server/src/app.ts` in full:

```ts
import Fastify from 'fastify'
import { registerAgentKeys } from './agent-keys.ts'
import { registerAuth } from './auth.ts'
import { registerCredentialProfiles } from './credential-profiles.ts'
import { createDb } from './db.ts'
import { getPlaceholderBody } from './placeholder.ts'

export function buildApp(options?: { sqlitePath?: string }) {
  const db = createDb(options?.sqlitePath ?? ':memory:')
  const app = Fastify()
  app.addHook('onClose', () => {
    db.$client.close()
  })
  app.get('/', async (_request, reply) => {
    return reply.type('text/plain; charset=utf-8').send(getPlaceholderBody())
  })
  registerAuth(app, db)
  registerAgentKeys(app, db)
  registerCredentialProfiles(app, db)
  return app
}
```

Order matters: `registerAuth` registers `@fastify/cookie` + `@fastify/session`, so any registrar
that reads `request.session` must be registered after it. A new `registerTasks(app, db)` goes
after `registerCredentialProfiles(app, db)`.

`buildApp` is **not** async; tests call `await app.ready()` themselves.

### 1.2 How routes are declared

Plain Fastify method calls with an inline async handler. No `fastify-plugin`, no route options
object, no `preHandler`, no `schema`:

```ts
app.get('/api/v1/credential-profiles', async (request, reply) => { ... })
app.post('/api/v1/credential-profiles', async (request, reply) => { ... })
app.delete('/api/v1/credential-profiles/:id', async (request, reply) => { ... })
```

The one exception is the Bearer surface in `agent-keys.ts:132`, which uses an encapsulated child
context so the `onRequest` hook only applies to routes inside it:

```ts
app.register(async function agentBearerContext(child) {
  child.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => { ... })
  child.get('/api/v1/agent/whoami', async (request, reply) => { ... })
})
```

That is the established pattern to copy if issue #7 needs Bearer-authenticated task routes.

### 1.3 Body / param validation — **manual, not zod, not Fastify schema**

There is **no** zod at the HTTP boundary anywhere in `apps/server`, and **no** Fastify JSON
schema. Bodies are hand-parsed from `unknown`. Verbatim, `credential-profiles.ts:66-86`:

```ts
function readCreateBody(body: unknown):
  | { forge: 'github' | 'gitlab' | 'gitea'; baseUrl: string; repoFullName: string; token: string }
  | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const raw = body as {
    forge?: unknown
    base_url?: unknown
    repo_full_name?: unknown
    token?: unknown
  }
  if (typeof raw.forge !== 'string' || !FORGES.has(raw.forge)) return undefined
  if (typeof raw.base_url !== 'string' || raw.base_url === '') return undefined
  if (typeof raw.repo_full_name !== 'string' || raw.repo_full_name === '') return undefined
  if (typeof raw.token !== 'string' || raw.token === '') return undefined
  return {
    forge: raw.forge as 'github' | 'gitlab' | 'gitea',
    baseUrl: raw.base_url,
    repoFullName: raw.repo_full_name,
    token: raw.token,
  }
}
```

Wire format is **snake_case**; internal/drizzle names are **camelCase**; the reader is the
translation layer. A lenient variant exists for optional fields (`agent-keys.ts:53`):

```ts
function labelFromBody(body: unknown): string {
  if (body == null || typeof body !== 'object') return ''
  const label = (body as { label?: unknown }).label
  return typeof label === 'string' ? label : ''
}
```

Path params are cast and range-checked. The identical helper is duplicated in **two** files
(`agent-keys.ts:59` and `credential-profiles.ts:60`) — it is not shared:

```ts
function parsePositiveInt(raw: string): number | undefined {
  const id = Number.parseInt(raw, 10)
  if (!Number.isInteger(id) || id <= 0) return undefined
  return id
}
```

Call site: `const id = parsePositiveInt((request.params as { id: string }).id)`.
`auth.ts:336` inlines the same logic with `Number.parseInt` + `Number.isInteger`.

> If issue #7 wants `parseTaskBrief` from `@kaola/shared` used at the HTTP boundary, that would
> be the **first** use of zod in `apps/server`, and it requires adding a workspace dependency
> (see §4.4). Today no server route validates with zod.

### 1.4 Error shape and status codes

Always `reply.code(N).send({ error: '<ascii_snake_case>' })`. The `error` value is a machine
code in **English/ASCII**. Chinese appears only in an *additional* `message` field, never in
`error`.

Codes actually in use today:

| Status | Body | Where |
|---|---|---|
| 400 | `{ error: 'invalid_id' }` | `auth.ts:339` (approve) |
| 400 | `{ error: 'invalid_body' }` | `credential-profiles.ts:109` |
| 401 | `{ error: 'unauthorized' }` | `auth.ts:64,321`, `auth.ts:331`, `agent-keys.ts:42` |
| 403 | `{ error: 'forbidden' }` | `auth.ts:334`, `agent-keys.ts:102,113`, `credential-profiles.ts:93,104,156` |
| 403 | `{ error: 'forbidden', message: '你的账号待正式成员批准后方可生成 Agent Key。' }` | `agent-keys.ts:70` |
| 404 | `{ error: 'not_found' }` | `auth.ts:343`, `agent-keys.ts:118,127`, `credential-profiles.ts:161,170` |
| 409 | `{ error: 'conflict' }` | `credential-profiles.ts:146` |
| 500 | `{ error: 'vault_unconfigured' }` | `credential-profiles.ts:117` |
| 502 | `{ error: 'userinfo_failed' }` / `{ error: 'userinfo_invalid' }` | `auth.ts:228,232` |

Success bodies: `201` + resource for create, `200` + `{ ok: true }` for delete
(`agent-keys.ts:129`), `200 { ok: true, message: '请同时到 forge 侧撤销该 token。' }`
(`credential-profiles.ts:177`), `200 { profiles: [...] }` / `{ keys: [...] }` for lists.

The three Chinese user-facing strings, verbatim (each declared as a module const):

```ts
const PENDING_STATUS = '待批准'                                              // auth.ts:9
const PENDING_CLAIM_MESSAGE = '你的账号待正式成员批准后方可认领任务。'          // auth.ts:10
const PENDING_GENERATE_MESSAGE = '你的账号待正式成员批准后方可生成 Agent Key。' // agent-keys.ts:8
const FORGE_REVOKE_MESSAGE = '请同时到 forge 侧撤销该 token。'                 // credential-profiles.ts:12
```

Unexpected errors are **thrown**, not caught (`throw new Error('failed to insert credential
profile')`), producing Fastify's default 500. Only two errors are translated: unique-constraint →
409 (via `isUniqueConstraintError`, which walks up to 4 `cause` levels checking
`SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT` / `/UNIQUE/i`) and `VaultUnconfiguredError` → 500.

### 1.5 Getting the session user inside a handler

```ts
export function getSessionUser(db: AppDb, request: FastifyRequest): User | undefined {  // auth.ts:175
  const userId = request.session.userId
  if (userId == null) return undefined
  return db.select().from(users).where(eq(users.id, userId)).get()
}
```

`request.session.userId` is typed by a module augmentation in `auth.ts:36-38`
(`interface Session { userId?: number }`). Every protected handler opens with the same two lines:

```ts
const user = getSessionUser(db, request)
if (user == null) return sendUnauthorized(request, reply)
```

`sendUnauthorized` does content negotiation (`auth.ts:57-67`):

```ts
export function wantsJson(request: FastifyRequest): boolean {
  const accept = request.headers.accept
  return typeof accept === 'string' && accept.includes('application/json')
}

export function sendUnauthorized(request: FastifyRequest, reply: FastifyReply) {
  if (wantsJson(request)) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
  return reply.redirect('/login')
}
```

Two inconsistencies worth knowing (both are current behavior, pinned by tests):
- `GET /api/v1/me` re-implements the same branch inline instead of calling `sendUnauthorized`.
- `POST /api/v1/users/:id/approve` returns a bare `401 { error: 'unauthorized' }` with **no**
  HTML redirect branch.

### 1.6 Permission gating as it exists today

There is **no exported/shared gate helper**. Three separate expressions:

```ts
// agent-keys.ts — "active" only (approved GitHub claim_only qualifies)
if (user.status !== 'active') { return reply.code(403).send({ error: 'forbidden' }) }

// credential-profiles.ts:15-17 — module-local, "active + full"
function canManageProfiles(user: { status: string; permissionLevel: string }): boolean {
  return user.status === 'active' && user.permissionLevel === 'full'
}

// auth.ts:333 — inlined, "active + full"
if (actor.status !== 'active' || actor.permissionLevel !== 'full') {
  return reply.code(403).send({ error: 'forbidden' })
}
```

Enum values (`schema.ts:11-12`): `status` is `'active' | '待批准'`; `permission_level` is
`'full' | 'claim_only'`. First-login mapping (`auth.ts:100-128`): GitHub → `待批准` +
`claim_only`; GitLab and Gitea → `active` + `full`. `approve` flips `status` to `active` and
never touches `permission_level`, so GitHub users stay `claim_only` forever.

Per DESIGN §11, **发布任务 / 管理凭证档案 is GitLab/Gitea only** — i.e. task posting should use
the `active + full` gate (`canManageProfiles`'s predicate), not the `active` gate.

### 1.7 Representative route, end to end (verbatim, `credential-profiles.ts:100-150`)

```ts
  app.post('/api/v1/credential-profiles', async (request, reply) => {
    const user = getSessionUser(db, request)
    if (user == null) return sendUnauthorized(request, reply)
    if (!canManageProfiles(user)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const parsed = readCreateBody(request.body)
    if (parsed == null) {
      return reply.code(400).send({ error: 'invalid_body' })
    }

    let tokenEncrypted: string
    try {
      tokenEncrypted = encryptToken(parsed.token)
    } catch (err) {
      if (isVaultUnconfiguredError(err)) {
        return reply.code(500).send({ error: 'vault_unconfigured' })
      }
      throw err
    }

    try {
      const inserted = db
        .insert(credentialProfiles)
        .values({
          forge: parsed.forge,
          baseUrl: parsed.baseUrl,
          repoFullName: parsed.repoFullName,
          tokenEncrypted,
          scopesChecked: '[]',
          createdBy: user.id,
        })
        .returning()
        .get()
      if (inserted == null) {
        throw new Error('failed to insert credential profile')
      }
      insertAuditEvent(db, {
        type: '变更',
        actorUserId: user.id,
        details: { action: 'create', profile_id: inserted.id },
      })
      return reply.code(201).send(publicProfile(inserted))
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({ error: 'conflict' })
      }
      throw err
    }
  })
```

Its response projector (`credential-profiles.ts:28-37`) — note the camelCase → snake_case flip
and that the token column is simply never selected into the body:

```ts
function publicProfile(row: CredentialProfile) {
  return {
    id: row.id,
    forge: row.forge,
    base_url: row.baseUrl,
    repo_full_name: row.repoFullName,
    scopes_checked: parseScopes(row.scopesChecked),
    created_by: row.createdBy,
  }
}
```

Drizzle style throughout: **synchronous** better-sqlite3 driver, `.get()` for one row, `.all()`
for many, `.run()` for writes, `.returning().get()` on insert/delete. No `await` on db calls.

---

## 2. DB LAYER

### 2.1 Construction — raw DDL, no migrations

`apps/server/src/db.ts` in full is reproduced here because it is the exact place a `tasks` table
must be registered:

```ts
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
```

Facts that follow:
- **No** drizzle-kit, **no** `drizzle.config.*`, **no** `migrations/` directory, **no**
  `push`. Schema exists at boot solely because `createDb` executes these `CREATE TABLE IF NOT
  EXISTS` strings.
- **No** `FOREIGN KEY` clauses and no `PRAGMA foreign_keys`. `agent_keys.user_id`,
  `credential_profiles.created_by`, `events.actor_user_id` are unenforced integers.
- **No** indexes beyond the inline `UNIQUE` constraints.
- Because `IF NOT EXISTS` is used and there is no migration runner, **an existing on-disk SQLite
  file will NOT gain new columns on a table that already exists**. A new `tasks` table is safe;
  altering an existing table is not (and would be an escalation-worthy schema change).

### 2.2 Registering a new table — three edits, all required

1. `apps/server/src/schema.ts`: add a `sqliteTable(...)` definition + an
   `export type Task = typeof tasks.$inferSelect`.
2. `apps/server/src/db.ts`: add a `const TASKS_DDL = \`...\`` and a `sqlite.exec(TASKS_DDL)`
   line inside `createDb` (before the `drizzle(...)` return).
3. `apps/server/src/db.ts`: add the table to the schema map:
   `drizzle(sqlite, { schema: { users, agentKeys, credentialProfiles, events, tasks } })`,
   and to the import list at the top of the file.

The drizzle table style to mirror (`schema.ts:29-41`), including how a multi-column UNIQUE is
declared with a *named* constraint:

```ts
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
```

Imports available in schema.ts today: `import { integer, sqliteTable, text, unique } from
'drizzle-orm/sqlite-core'`. Chinese enum labels are already used in a `text(..., { enum: [...] })`
(`status: text('status', { enum: ['active', '待批准'] })`), so a
`text('status', { enum: ['待认领', '进行中', '待验收', '已完成', '已退回', '已取消'] })` column is
consistent with existing practice.

### 2.3 The `events` insert pattern used by credential-profiles.ts

The only writer helper (`vault.ts:67-79`), verbatim:

```ts
export function insertAuditEvent(
  db: AppDb,
  input: { type: string; actorUserId: number; details: unknown },
): void {
  db.insert(events)
    .values({
      type: input.type,
      actorUserId: input.actorUserId,
      createdAt: Math.floor(Date.now() / 1000),
      details: JSON.stringify(input.details),
    })
    .run()
}
```

- `type` is a free-form `string` at the type level (the column has no enum).
- `actorUserId` is **required `number`** in the helper even though the column is nullable. A
  system-generated event with no actor cannot use this helper as written.
- `createdAt` is unix **seconds**, computed inside the helper — callers never pass a timestamp.
- `details` is `JSON.stringify`'d by the helper — callers pass a plain object.

Every `type` string that exists in source today (exhaustive):

| `type` | `details` JSON | Written by |
|---|---|---|
| `'变更'` | `{ "action": "create", "profile_id": <int> }` | `credential-profiles.ts:138-142` |
| `'变更'` | `{ "action": "delete", "profile_id": <int> }` | `credential-profiles.ts:172-176` |
| `'token 揭示'` | `{ "agent_key_id": <int>, "profile_id": <int> }` | `vault.ts:94-98` |

`details` keys are **snake_case**. Note the space in `'token 揭示'`.

**Divergence to decide:** DESIGN §10 names the event taxonomy as
`状态迁移 / token 揭示 / 心跳 / 回写`. `变更` is not in that list — it was introduced by the
credential-profiles work. A task status change most naturally becomes `状态迁移`, but nothing in
code establishes that yet. See §8.

---

## 3. VAULT (`apps/server/src/vault.ts`)

Exact exported surface:

```ts
export const VAULT_UNCONFIGURED = 'vault_unconfigured'
export class VaultUnconfiguredError extends Error { readonly code = VAULT_UNCONFIGURED /* name = 'VaultUnconfiguredError' */ }
export function isVaultUnconfiguredError(err: unknown): boolean
export function encryptToken(plaintext: string): string
export function decryptToken(encoded: string | Buffer): string
export function insertAuditEvent(db: AppDb, input: { type: string; actorUserId: number; details: unknown }): void
export function revealCredentialProfile(db: AppDb, input: { profileId: number; actorUserId: number; agentKeyId: number }): string
```

All are **synchronous** (they return `string`/`void`, not promises — the existing tests `await`
them, which is harmless).

Constants: `ALGORITHM = 'aes-256-gcm'`, `IV_LENGTH = 12`, `AUTH_TAG_LENGTH = 16`,
`MASTER_KEY_HEX_RE = /^[0-9a-fA-F]{64}$/`.

`VAULT_MASTER_KEY` is read **at every call**, never cached, never read at boot
(`vault.ts:32-42`):

```ts
function readMasterKey(): Buffer {
  const hex = process.env.VAULT_MASTER_KEY
  if (hex == null || hex === '' || !MASTER_KEY_HEX_RE.test(hex)) {
    throw new VaultUnconfiguredError()
  }
  const key = Buffer.from(hex, 'hex')
  if (key.length !== 32) {
    throw new VaultUnconfiguredError()
  }
  return key
}
```

Throwing behavior:

| Function | Throws |
|---|---|
| `encryptToken` | `VaultUnconfiguredError` if key missing/empty/not 64-hex/not 32 bytes |
| `decryptToken` | same, plus `Error('invalid ciphertext')` when the base64 blob is shorter than `IV_LENGTH + AUTH_TAG_LENGTH` (28 bytes), plus whatever `node:crypto` throws on GCM auth-tag failure (`decipher.final()`) |
| `revealCredentialProfile` | `Error('credential profile not found')` when no row for `profileId`; otherwise propagates `decryptToken`'s throws |

Ciphertext layout: `Buffer.concat([iv, ciphertext, tag]).toString('base64')` — a base64 TEXT
string stored in `token_encrypted`.

`revealCredentialProfile` order of operations (matters for auditing): select row → **decrypt** →
`insertAuditEvent({ type: 'token 揭示', ... })` → return plaintext. A decrypt failure therefore
leaves **no** audit row.

There is no HTTP route that reveals a token; `revealCredentialProfile` is a module export only.

---

## 4. FORGE ADAPTERS (`packages/forge-adapters/src/index.ts`)

### 4.1 What is actually exported

```ts
export function getForgeAdaptersHealth(): string
export type ForgeKind = 'github' | 'gitlab' | 'gitea'
export type Credential = { token: string }
export type RepoRef = { full_name: string; base_url: string }
export type TokenCapability = '读' | '推' | 'PR'
export type TokenCheck = { missing: TokenCapability[] }
export type ImportedIssue = unknown
export type PrStatus = unknown
export type ForgeEvent = unknown
export type IssueRef = unknown
export interface ForgeAdapter { ... }
export type CreateForgeAdapterOptions = { baseUrl?: string }
export function createForgeAdapter(kind: ForgeKind, options?: CreateForgeAdapterOptions): ForgeAdapter
```

> **Correction to CLAUDE.md.** CLAUDE.md's Project Snapshot says the package "exports
> `createForgeAdapter` / `validateToken`". It does **not** export a standalone `validateToken`.
> Line 67 is `async function validateToken(` with **no** `export` keyword, and its signature is
> the 4-arg internal form `(kind, options, cred, repo)`. The only public path is
> `createForgeAdapter(kind, options).validateToken(cred, repo)`. I verified this by grepping all
> `export` occurrences in both the worktree and the main-root copy of the file — identical in both.

Interface method signature as declared (`index.ts:26-34`):

```ts
export interface ForgeAdapter {
  readonly kind: ForgeKind
  validateToken(cred: Credential, repo: RepoRef): Promise<TokenCheck>
  importIssue(cred: Credential, issueUrl: string): Promise<ImportedIssue>
  getPullRequest(cred: Credential, prUrl: string): Promise<PrStatus>
  registerWebhook(cred: Credential, repo: RepoRef, callback: string): Promise<void>
  parseWebhook(headers: Headers, body: unknown): ForgeEvent | null
  commentOnIssue(cred: Credential, issueRef: IssueRef, body: string): Promise<void>
}
```

Factory (`index.ts:45-65`):

```ts
export function createForgeAdapter(
  kind: ForgeKind,
  options?: CreateForgeAdapterOptions,
): ForgeAdapter {
  if (kind !== 'github' && kind !== 'gitlab' && kind !== 'gitea') {
    throw new Error(`unknown forge kind: ${String(kind)}`)
  }
  return {
    kind,
    validateToken: (cred, repo) => validateToken(kind, options, cred, repo),
    importIssue: notImplemented,
    getPullRequest: notImplemented,
    registerWebhook: notImplemented,
    parseWebhook: notImplemented,
    commentOnIssue: notImplemented,
  }
}

function notImplemented(): never {
  throw new Error('not implemented')
}
```

Methods that throw `Error('not implemented')`: **`importIssue`, `getPullRequest`,
`registerWebhook`, `parseWebhook`, `commentOnIssue`** — all five. `notImplemented` throws
*synchronously* (it is not `async`), so `await adapter.importIssue(...)` throws rather than
rejects; `try/catch` around an `await` still catches it, but `.catch()` on the return value does
not.

### 4.2 `validateToken` return value and decision tree

Returns `Promise<TokenCheck>` where `TokenCheck = { missing: TokenCapability[] }` and
`TokenCapability = '读' | '推' | 'PR'` (Chinese 读 = read, 推 = push, PR). `missing` is an
**array of what the token CANNOT do**; `{ missing: [] }` means fully capable.

```ts
const ALL_MISSING: TokenCheck = { missing: ['读', '推', 'PR'] }
```

Flow (`index.ts:67-94`):

1. `GET <user endpoint>` (`/user` on every forge).
2. If `userRes.status === 401` → return `{ missing: ['读', '推', 'PR'] }` (new array copy). Any
   other non-200 user status (403, 500, …) **falls through** and is not treated as failure.
3. `GET <repo endpoint>`. If `repoRes.status !== 200` → return `{ missing: ['读', '推', 'PR'] }`.
4. Else `await repoRes.json()` and compute per-forge capabilities.

`missingFromFlags` is always called with `canRead: true` hard-coded
(`githubCapabilities` / `gitlabCapabilities` / `giteaCapabilities` all pass `canRead: true`), so
**`'读'` can only appear via the two all-missing early returns in steps 2 and 3.**

Per-forge capability rules:
- **GitHub**: `canPush = repo.permissions.push === true`; if the token starts with `ghp_`
  (classic PAT), additionally requires an `x-oauth-scopes` response header containing `repo`, or
  `public_repo` when `repo.private === false`. `canPr = canPush`.
- **GitLab**: `accessLevel = max(permissions.project_access.access_level,
  permissions.group_access.access_level)`; `canPush = accessLevel >= 30 &&
  repository_access_level !== 'disabled'`; `canPr = can_create_merge_request_in === true &&
  merge_requests_access_level !== 'disabled'`.
- **Gitea**: `canPush = permissions.push === true`; `canPr = canPush && has_pull_requests !== false`.

Endpoints: GitHub is pinned to `https://api.github.com` and **ignores** both `options.baseUrl`
and `repo.base_url`. GitLab uses `(options?.baseUrl ?? repo.base_url)` trailing-slash-stripped +
`/api/v4`, repo path `/projects/${encodeURIComponent(full_name)}`. Gitea likewise + `/api/v1`,
repo path `/repos/${full_name}`. Auth headers: GitHub `Authorization: Bearer <t>` +
`User-Agent: KaolaTasks` + `Accept: application/vnd.github+json`; GitLab `PRIVATE-TOKEN: <t>`;
Gitea `Authorization: token <t>`. All requests are `method: 'GET'` — nothing mutates the forge.

### 4.3 Network failure behavior — **it rejects; it does not degrade**

```ts
async function forgeGet(kind: ForgeKind, url: string, token: string): Promise<Response> {
  return globalThis.fetch(url, {
    method: 'GET',
    headers: authHeaders(kind, token),
  })
}
```

There is **no** `try/catch` anywhere in `validateToken`. Consequences the implementer must handle
at the HTTP layer:
- DNS failure / connection refused / TLS error / abort → `fetch` rejects → `validateToken`'s
  promise rejects with a `TypeError` (Node undici `fetch failed`, with a `cause`). It does **not**
  return `{ missing: [...] }`.
- A 200 response whose body is not JSON → `repoRes.json()` rejects, same propagation.
- There is **no timeout**. No `AbortSignal` is passed. A hung self-hosted forge hangs the request.

So a 发布即校验 route that calls `validateToken` must wrap it in `try/catch` and choose its own
status code + Chinese message for "could not reach the forge" — which is a *different* outcome
from "token lacks permissions". Nothing in the codebase decides that yet.

### 4.4 `apps/server` does NOT depend on the adapters (or on shared)

`apps/server/package.json`, dependencies block verbatim:

```json
  "dependencies": {
    "@fastify/cookie": "^11.1.2",
    "@fastify/oauth2": "^8.3.0",
    "@fastify/session": "^11.1.2",
    "better-sqlite3": "^12.2.0",
    "drizzle-orm": "^0.44.4",
    "fastify": "^5.4.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.17.0",
    "typescript": "^5.9.2"
  }
```

Neither `@kaola/forge-adapters` nor `@kaola/shared` is listed. I grepped every `package.json` in
the tree for `workspace:` / `@kaola/` — the only hits are the four `"name"` fields. **No
cross-package workspace dependency exists anywhere in this repo yet.** `apps/server/node_modules/@kaola/`
does not exist.

To `import { createForgeAdapter } from '@kaola/forge-adapters'` (or `parseTaskBrief` from
`@kaola/shared`) inside `apps/server`, someone must add e.g.
`"@kaola/forge-adapters": "workspace:*"` to `apps/server/package.json` **and re-run
`pnpm install`**. Both packages declare `"exports": { ".": "./src/index.ts" }` and
`"types": "./src/index.ts"`, i.e. they resolve to raw `.ts` — which works under
`--experimental-strip-types` and under `moduleResolution: NodeNext`. UNVERIFIED: I could not run
`pnpm install` or `pnpm typecheck` from this role, so the exact resolution outcome for a
`.ts`-only workspace export consumed by `tsc --noEmit` in `apps/server` is not empirically
confirmed here. Worth an early smoke check by the implementer.

Per CLAUDE.md, "dependency or build-tooling swap" is on the escalate list — adding the first
cross-package dependency is a judgment call for the orchestrator, not a silent edit.

**Operational gotcha:** the worktree at `.kw/worktrees/issue-7` has **no `node_modules` at all**
(`.kw/worktrees/issue-7/node_modules/.modules.yaml` does not exist; the installed store lives at
`/Users/ylpromax5/Workspace/KaolaTasks/node_modules/.modules.yaml`). `pnpm test` / `pnpm lint`
run from inside the worktree will fail until `pnpm install` is run there.

---

## 5. SHARED SCHEMA (`packages/shared/src/index.ts`)

### 5.1 `taskBriefSchema`, field by field

Declared with `z.strictObject` (unknown keys **throw**). Zod v4, imported as
`import * as z from 'zod'`. Dependency pinned `"zod": "^4.4.3"`.

| Key | Zod type | Optional? |
|---|---|---|
| `id` | `z.string()` | required |
| `title` | `z.string()` | required |
| `description_md` | `z.string()` | required |
| `source` | `z.discriminatedUnion('type', [...])` — see below | required |
| `repo` | `z.strictObject({...})` — see below | required |
| `acceptance_criteria` | `z.array(z.string())` | required |
| `test_command` | `z.string()` | required |
| `constraints` | `z.strictObject({ allowed_paths: z.array(z.string()), forbidden_paths: z.array(z.string()) })` | required (both inner keys required) |
| `pr_convention` | `z.strictObject({ branch_prefix: z.string(), title_prefix: z.string() })` | required (both inner keys required) |
| `credential` | `z.strictObject({ profile_id: z.string() })` | required; **`profile_id` is the only permitted key** |
| `priority` | `z.enum(['P0', 'P1', 'P2', 'P3'])` | required |
| `tags` | `z.array(z.string())` | required |
| `poster` | `z.string()` | required |
| `status` | `taskStatusSchema` | required |
| `created_at` | `z.iso.datetime({ offset: true })` | required |

`source` (discriminated on `type`, both members strict):
- `{ type: z.literal('native') }` — **no other key permitted** (a `native` source carrying
  `issue_url` is rejected; pinned by a test).
- `{ type: z.literal('imported'), issue_url: z.string() }` — `issue_url` required, a plain
  string (no `.url()` refinement).

`repo` (`z.strictObject`), all required: `forge: z.enum(['github','gitlab','gitea'])`,
`base_url: z.string()`, `full_name: z.string()`, `base_branch: z.string()`,
`suggested_dir: z.string()`.

**Nothing is `.optional()` anywhere in the schema.** There are no defaults, no `.min(1)`, no
`.url()`, no `.regex()`. Empty strings and empty arrays pass.

`taskStatusSchema` (`index.ts:7-14`):

```ts
export const taskStatusSchema = z.enum([
  '待认领',
  '进行中',
  '待验收',
  '已完成',
  '已退回',
  '已取消',
])
```

The source carries this comment above `created_at`:
`// Default ISO datetime rejects offset-only values such as +08:00.`
`{ offset: true }` is what makes `2026-08-20T12:00:00+08:00` (the DESIGN example) parse.
UNVERIFIED by execution in this session: whether the bare `...Z` form is also accepted (zod docs
say `offset: true` *widens* the default, which accepts `Z`, so both should pass — but I did not
run it. The repo's own research note
`kaola-workflow/archive/issue-2/.cache/zod-version.md` says only that the default *rejects*
`+08:00`.)

### 5.2 `parseTaskBrief`

```ts
export type TaskBrief = z.infer<typeof taskBriefSchema>

export function parseTaskBrief(input: unknown): TaskBrief {
  return taskBriefSchema.parse(input)
}
```

Throws `z.ZodError` (issues on `.issues`) on any invalid input. There is **no** `safeParse`
wrapper exported — a route wanting a 400 instead of a 500 must `try/catch` it, or call
`taskBriefSchema.safeParse` directly.

### 5.3 `transitionTaskStatus` and the eight legal edges

```ts
const LEGAL_TRANSITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['待认领', new Set(['进行中', '已取消'])],
  ['进行中', new Set(['待认领', '待验收'])],
  ['待验收', new Set(['已完成', '已退回'])],
  ['已退回', new Set(['待认领', '已取消'])],
])

export function transitionTaskStatus(from: string, to: string): string {
  const allowed = LEGAL_TRANSITIONS.get(from)
  if (!allowed?.has(to)) {
    throw new Error(`Illegal task status transition: ${from} → ${to}`)
  }
  return to
}
```

Signature is `(from: string, to: string): string` — **plain `string`, not `TaskStatus`**. It
returns `to` on success and throws `Error` (message uses a `→` arrow) otherwise.

The eight legal edges:

1. 待认领 → 进行中
2. 待认领 → 已取消
3. 进行中 → 待认领
4. 进行中 → 待验收
5. 待验收 → 已完成
6. 待验收 → 已退回
7. 已退回 → 待认领
8. 已退回 → 已取消

Terminal (no outgoing edges): 已完成, 已取消. `LEGAL_TRANSITIONS.get()` returns `undefined` for
them and for any unknown string, so those all throw.

Relevant to issue #7: **there is no edge into 待认领 from nothing** — task creation is not a
transition, it is an initial value. DESIGN §5's diagram shows `[*] --> 待认领: 发布/导入（token
校验通过）`, so a newly posted task is inserted directly with `status = '待认领'`;
`transitionTaskStatus` is not involved in creation. Also note **there is no 已完成 → anything**
and no way to reopen 已取消.

### 5.4 Schema vs. DESIGN.md §6 (lines 105-141) — field-by-field

The §6 JSON example is pinned as a passing case by
`packages/shared/src/index.test.ts` (`designExample()` at line 56, asserted with
`assert.deepEqual(parseTaskBrief(brief), brief)`). So **every key name and value type in the §6
example matches the zod schema exactly.** There is no name-level divergence.

The divergences are in what §6's *prose/comments* imply that the schema does not express:

| # | DESIGN §6 | zod schema | Impact |
|---|---|---|---|
| D1 | `"credential": { "profile_id": "cp-gitea-orders" },  // 或单任务临时 token 的引用` — the comment says a **one-off per-task token reference** is an alternative | `credential: z.strictObject({ profile_id: z.string() })` — strict, `profile_id` only. Tests explicitly assert that `{ token: ... }`, `{}`, and `{ profile_id, token }` all **throw** | The XOR of §10 (`credential_profile_id / inline_token_encrypted 二选一`) has **no representation in the brief**. Either an inline token is surfaced as a synthetic `profile_id` string, or `taskBriefSchema` must change — and that is a DESIGN-first contract change |
| D2 | `"id": "kt-2026-0142"` — a human-readable string id | `id: z.string()` | Consistent with each other, but **inconsistent with every existing table**, which uses `id INTEGER PRIMARY KEY AUTOINCREMENT`. See §8 Q2 |
| D3 | `"credential": { "profile_id": "cp-gitea-orders" }` — a string profile id | `credential_profiles.id` is `INTEGER` | A join needs `String(row.id)` on the way out and `Number.parseInt` on the way in, unless a separate string key column is added |
| D4 | `"poster": "zhang.wei"` — looks like a username | `poster: z.string()` | The DB has `users.id INTEGER` and `users.username TEXT`. The brief carries the username, so a `tasks` table storing `poster_user_id INTEGER` must project `users.username` into the brief |
| D5 | `"created_at": "2026-08-20T12:00:00+08:00"` — ISO 8601 with offset | `z.iso.datetime({ offset: true })` | Consistent, but **inconsistent with the DB convention**: `events.created_at` and `agent_keys.last_used_at` are unix **seconds** integers. A `tasks.created_at` column must pick one and convert at the boundary |
| D6 | §6 says "发布表单与 Agent 拿到的 JSON 是同一份契约" | schema has no token field at all, and a test pins that a top-level `token` key throws | The **post form** must therefore carry `token` (or a profile ref) **outside** the brief object — the brief cannot be the literal request body for a create-with-inline-token |
| D7 | §5 rule 发布即校验 | nothing in `@kaola/shared` models the validation result | Where the `TokenCheck` result (analogous to `credential_profiles.scopes_checked`) gets stored for a task is undecided |

**§6 fields that have no column yet: all fifteen.** There is **no `tasks` table** in
`schema.ts` or `db.ts` — `docs/api.md:130` states this explicitly ("There is no `tasks` table.").
Likewise no `leases` and no `submissions` table (DESIGN §10 lists both). Beyond the §6 fields,
§10's `tasks` row also calls for `status` (already a §6 field) plus
`credential_profile_id / inline_token_encrypted（二选一）`, neither of which is a §6 field.

---

## 6. TEST CONVENTIONS

### 6.1 Runner and file shape

- `node:test` with `import { describe, test } from 'node:test'` and
  `import assert from 'node:assert/strict'`. (`packages/forge-adapters/src/validate-token.shared.test.ts`
  uses `describe, it` instead — server tests use `test`.)
- Files are named `*.test.ts` and live **next to** the source (`apps/server/src/vault.test.ts`).
- They are `.ts` by extension but written as **plain JavaScript** — no type annotations, no
  imported types. `apps/server/tsconfig.json` has `"exclude": ["src/**/*.test.ts"]`, so tests are
  never typechecked. Do not add annotations expecting them to be checked; do not break
  `--experimental-strip-types` (no enums, no decorators, no `satisfies`-only constructs).
- A new test file **must be appended to the root `package.json` `test` script** or it will not
  run. Current script verbatim:

```
node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts
```

- `vault.test.ts` wraps everything in `describe('issue #5 credential vault', { concurrency: false }, () => {`
  — serialized because the tests mutate `process.env` and `globalThis.fetch`. Any new suite that
  does the same should do likewise.
- Both server suites carry a provenance comment on line ~4/9:
  `// Binding names: kaola-workflow/bundle-4-5/.cache/technical-decisions.md`.

### 6.2 Env-before-import: the load-bearing idiom

`registerAuth` calls `requireEnv` at registration time, so `buildApp()` throws unless the OAuth
env is set **before the module graph loads**. Every server test does this with a top-level `await
import`:

```js
function applyOauthTestEnv() {
  process.env.OAUTH_GITHUB_CLIENT_ID = 'test-github-client-id'
  process.env.OAUTH_GITHUB_CLIENT_SECRET = 'test-github-client-secret'
  process.env.OAUTH_GITLAB_CLIENT_ID = 'test-gitlab-client-id'
  process.env.OAUTH_GITLAB_CLIENT_SECRET = 'test-gitlab-client-secret'
  process.env.OAUTH_GITLAB_BASE_URL = GITLAB_BASE_URL
  process.env.OAUTH_GITEA_CLIENT_ID = 'test-gitea-client-id'
  process.env.OAUTH_GITEA_CLIENT_SECRET = 'test-gitea-client-secret'
  process.env.OAUTH_GITEA_BASE_URL = GITEA_BASE_URL
  process.env.SESSION_SECRET = '0'.repeat(32)
  process.env.PUBLIC_URL = 'http://localhost:3000'
  process.env.VAULT_MASTER_KEY = VAULT_MASTER_KEY_HEX     // vault.test.ts only
}

applyOauthTestEnv()

const { buildApp } = await import('./app.ts')
```

`VAULT_MASTER_KEY` handling differs by suite and is deliberate:
- `vault.test.ts:12`: `const VAULT_MASTER_KEY_HEX = 'ab'.repeat(32)` (64 hex chars), set in
  `applyOauthTestEnv`.
- `agent-keys.test.ts:29`: `delete process.env.VAULT_MASTER_KEY` — and a test asserts
  `assert.equal(process.env.VAULT_MASTER_KEY, undefined)` to prove agent keys work without a vault.
- Per-test removal uses save/restore in `t.after`:

```js
const previous = process.env.VAULT_MASTER_KEY
t.after(() => { process.env.VAULT_MASTER_KEY = previous })
delete process.env.VAULT_MASTER_KEY
```

`auth.test.ts` sets no `VAULT_MASTER_KEY` at all.

### 6.3 App instance, DB, and cleanup

```js
async function createApp(t, sqlitePath) {           // vault.test.ts:144
  const app = buildApp(sqlitePath ? { sqlitePath } : undefined)
  t.after(async () => { await app.close() })
  await app.ready()
  return app
}
```

(`agent-keys.test.ts:135` has the same helper taking the whole `options` object:
`const app = buildApp(options)`, called as `createApp(t, { sqlitePath })`.)

Default DB is `:memory:` (from `buildApp`'s own default) — **fresh per app instance**, so
per-test isolation comes from building a new app, not from truncating tables. When a test needs
to inspect SQL directly it uses a temp file:

```js
function sqliteFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kaola-vault-'))
  const sqlitePath = join(dir, 'kaola.sqlite')
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return sqlitePath
}

function openDb(t, sqlitePath) {          // second connection to the same file
  const db = createDb(sqlitePath)
  t.after(() => { db.$client.close() })
  return db
}
```

Raw SQL reads go through the drizzle escape hatch `db.$client.prepare(...)`:

```js
function eventRows(db) {
  return db.$client.prepare('SELECT type, actor_user_id, created_at, details FROM events').all()
}
```

`agent-keys.test.ts` instead opens `new Database(sqlitePath, { readonly: false })` from
`better-sqlite3` directly.

### 6.4 Simulating an authenticated session

There is no session-injection shortcut — tests drive the **real OAuth callback** with two stubs,
then reuse the resulting cookie jar.

```js
function stubTokenExchange(app, decoratorName, accessToken) {
  const oauth = app[decoratorName]
  assert.equal(typeof oauth?.getAccessTokenFromAuthorizationCodeFlow, 'function', ...)
  oauth.getAccessTokenFromAuthorizationCodeFlow = async () => ({
    token: { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 },
  })
}

function stubUserinfoByAccessToken(t, profiles) {   // replaces globalThis.fetch, restores in t.after
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (input, init) => { /* map Authorization token -> profile JSON */ }
}

function cookieJar(response) {
  const jar = {}
  for (const cookie of response.cookies) { jar[cookie.name] = cookie.value }
  return jar
}

async function loginViaCallback(app, { decoratorName, callbackPath, accessToken }) {
  stubTokenExchange(app, decoratorName, accessToken)
  const callback = await app.inject({ method: 'GET', url: `${callbackPath}?code=test-authorization-code` })
  assert.ok(callback.statusCode >= 200 && callback.statusCode < 400, ...)
  const cookies = cookieJar(callback)
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies, headers: jsonHeaders })
  assert.equal(me.statusCode, 200, ...)
  return { callback, cookies, me, body: me.json() }
}
```

Role shortcuts: `loginGitlab` / `loginGitea` produce `active` + `full` users (can manage
profiles); `loginGithub` produces a `待批准` + `claim_only` user. Profile ids are seeded as
`80000 + tokenSeq` / `70000 + tokenSeq` / `60000 + tokenSeq` to keep remote ids distinct across
tests. Note `globalThis.fetch` is stubbed for the *whole process* during a test, which is exactly
why 发布即校验 tests (which must also intercept `fetch` for `validateToken`) will need care: the
existing `stubUserinfoByAccessToken` returns HTTP 500 for any unrecognized Authorization token.

Requests go through `app.inject({ method, url, cookies, headers, payload })`; `headers` is
`{ accept: 'application/json' }` (`jsonHeaders` / `JSON_ACCEPT`) or
`{ accept: 'application/json', 'content-type': 'application/json' }` (`JSON_HEADERS`).
Bodies are passed as `payload` (an object; Fastify serializes it).

### 6.5 One full representative test (verbatim, `vault.test.ts:409-427`)

```js
  test('duplicate (forge, base_url, repo_full_name) returns 409 conflict', async (t) => {
    const app = await createApp(t)
    const profiles = beginUserinfo(t)
    const first = await loginGitlab(app, profiles, 'dup-a')
    const second = await loginGitlab(app, profiles, 'dup-b')
    const payload = profilePayload({ repo_full_name: 'acme/unique-triple' })

    const created = await postProfile(app, first.cookies, payload)
    assert.equal(created.statusCode, 201, `first POST: ${created.statusCode} ${created.body}`)

    const sameUser = await postProfile(app, first.cookies, payload)
    assert.equal(sameUser.statusCode, 409, `same user duplicate: ${sameUser.statusCode} ${sameUser.body}`)
    assert.equal(jsonBody(sameUser)?.error, 'conflict')
    assertNoSecrets(jsonBody(sameUser), payload.token)

    const otherUser = await postProfile(app, second.cookies, payload)
    assert.equal(otherUser.statusCode, 409, `other user duplicate: ${otherUser.statusCode} ${otherUser.body}`)
    assert.equal(jsonBody(otherUser)?.error, 'conflict')
  })
```

And the env-manipulation shape (`vault.test.ts:607-620`):

```js
  test('HTTP POST without VAULT_MASTER_KEY returns 500 vault_unconfigured', async (t) => {
    const previous = process.env.VAULT_MASTER_KEY
    t.after(() => { process.env.VAULT_MASTER_KEY = previous })
    delete process.env.VAULT_MASTER_KEY

    const app = await createApp(t)
    const profiles = beginUserinfo(t)
    const gitlab = await loginGitlab(app, profiles, 'unconfigured')
    const created = await postProfile(app, gitlab.cookies, profilePayload({ repo_full_name: 'acme/no-master-key' }))
    assert.equal(created.statusCode, 500, `POST: ${created.statusCode} ${created.body}`)
    assert.equal(jsonBody(created)?.error, 'vault_unconfigured')
  })
```

House assertion style worth copying: every `assert.equal` on a status code carries a message
interpolating `${res.statusCode} ${res.body}`, and every response is checked for secret leakage:

```js
function assertNoSecrets(body, plaintext) {
  assert.equal(body?.token, undefined)
  assert.equal(body?.token_encrypted, undefined)
  const dumped = JSON.stringify(body)
  assert.equal(dumped.includes(plaintext), false, `response leaked plaintext token: ${dumped}`)
}
```

A tasks suite must do the same — DESIGN §7 and CLAUDE.md both require that no task-listing
response ever contains a forge token.

Also pinned in both suites: `GET /` still returns `考拉任务服务占位` (a placeholder regression
guard). Keep it passing.

---

## 7. WEB (`apps/web/src/App.vue`)

### 7.1 Structure

The frontend is **one file**. `apps/web/src/` contains exactly `App.vue`, `main.ts`, `env.d.ts`
— no `components/`, no `views/`, no router, no Pinia/store, no API client module, no i18n file.
`<script setup lang="ts">` with `ref` / `computed` / `onMounted` from `vue`, and
`import { dateZhCN, zhCN } from 'naive-ui'`.

Layout: `<n-config-provider :locale="zhCN" :date-locale="dateZhCN">` → `<n-layout>` →
header (`考拉任务`) → content containing **three mutually exclusive `n-card`s** selected by a
single computed:

```ts
const view = computed(() => {
  if (!loaded.value || me.value == null) return 'login'
  if (me.value.status === '待批准') return 'pending'
  return 'member'
})
```

- `v-if="view === 'login'"` — 登录 card with three OAuth buttons.
- `v-else-if="view === 'pending'"` — 账号待批准 card.
- `v-else-if="view === 'member'"` — **工作台** card, which holds every feature, each as a
  `<n-divider>` + `<n-space vertical>` block gated by a permission computed:

```ts
const canApprove = computed(() => me.value?.status === 'active' && me.value?.permission_level === 'full')
const canManageKeys = computed(() => me.value?.status === 'active')
```

Existing blocks inside 工作台, in order: 批准 GitHub 用户 (`v-if="canApprove"`), `Agent Key`
(`v-if="canManageKeys"`), 凭证档案 (`v-if="canApprove"`).

Naive UI components are used **without explicit imports** — resolved globally. UNVERIFIED: I did
not read `main.ts`, so whether that is `createApp(App).use(naive)` or auto-import is unconfirmed;
either way, adding more `n-*` components follows the same pattern with no import edits.

### 7.2 How it calls the API

Raw `fetch`, no wrapper client. Every call repeats the same shape:

```ts
const res = await fetch('/api/v1/credential-profiles', {
  method: 'POST',
  credentials: 'include',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify({ forge: ..., base_url: ..., repo_full_name: ..., token: ... }),
})
const body = await readJson(res)
if (!res.ok) { /* map res.status to a Chinese message */ return }
```

- `credentials: 'include'` on every call (session cookie).
- `Accept: application/json` on every call — this is what makes the server return `401` JSON
  instead of a `302` redirect.
- `readJson(res)` is the shared tolerant parser (returns `null` on parse failure).
- Status codes are mapped to Chinese strings **at each call site**, e.g. in `createProfile`:
  `409 → '该仓库档案已存在'`, `500 && body?.error === 'vault_unconfigured' → '凭证保险库未配置'`,
  else `` `添加失败（${res.status}）` ``. Server-provided `message` is preferred when present
  (`typeof body?.message === 'string' ? body.message : ...`).
- Per-feature state is a flat cluster of refs: `xCreating` (loading), `xMessage` (text),
  `xOk` (boolean → `:type="xOk ? 'success' : 'error'"`), plus the list ref.
- `onMounted` loads `/api/v1/me`, then conditionally `loadAgentKeys()` / `loadProfiles()`.

Dev proxy (`apps/web/vite.config.ts`):

```ts
server: { proxy: { '/api': 'http://127.0.0.1:3000', '/login': 'http://127.0.0.1:3000' } }
```

So relative `/api/v1/...` paths work in dev with `pnpm --filter @kaola/web dev` alongside
`pnpm --filter @kaola/server start`.

### 7.3 Where a posting form attaches

Naturally: a **fourth block inside the 工作台 card**, after the 凭证档案 block (i.e. after line
81's closing `</n-space>`, before line 82's `</n-space>`), gated `v-if="canApprove"` — because
DESIGN §11 grants 发布任务 to the same GitLab/Gitea `active + full` population as 管理凭证档案.
Mirror the 凭证档案 block exactly:

- `<n-divider v-if="canApprove">发布任务</n-divider>`
- rows of `<n-input>` / `<n-select>` / `<n-input type="password" show-password-on="click">` for
  the one-off token, `<n-button type="primary" :loading="taskCreating" @click="createTask">`
- `<n-text v-if="taskMessage" :type="taskOk ? 'success' : 'error'">{{ taskMessage }}</n-text>`
- an empty-state `<n-text v-if="tasks.length === 0">暂无任务。</n-text>` and a
  `v-for` list of tasks

plus, in `<script setup>`: a `type TaskRow = {...}` next to `ProfileRow`, the ref cluster, and
`loadTasks()` / `createTask()` following `loadProfiles()` / `createProfile()` verbatim in shape.
`onMounted` needs a `if (canApprove.value) await loadTasks()` line. There is an existing
`forgeOptions` array for the forge `n-select` that can be reused, and `profiles` is already
loaded — a credential-profile `n-select` can be built from it.

Typecheck for web is `vue-tsc --noEmit -p tsconfig.json`; lint config gives `apps/web/**/*.{ts,vue}`
browser globals with the TS parser.

---

## 8. OPEN QUESTIONS FOR THE ORCHESTRATOR

**Q1 — `credential_profile_id` XOR `inline_token_encrypted`: not determined by any code.**
DESIGN §10 says the `tasks` row carries `credential_profile_id / inline_token_encrypted（二选一）`;
§6's `credential` comment says `{ profile_id }` "或单任务临时 token 的引用". But
`taskBriefSchema.credential` is `z.strictObject({ profile_id: z.string() })` and three tests
explicitly pin that a `token` key inside `credential` **throws**. So the brief has exactly one
slot and the DB wants two columns. Three possible readings, none settled by code:
 (a) two nullable columns + a CHECK-like invariant enforced in the handler, and the brief always
     projects `credential.profile_id = String(credential_profile_id)` — leaving the inline case
     with no representable brief value;
 (b) an inline token creates a hidden `credential_profiles` row (reusing `encryptToken` and the
     existing UNIQUE `(forge, base_url, repo_full_name)`), so tasks only ever reference a profile
     id — but that UNIQUE means a second one-off token for the same repo triggers a 409;
 (c) change `taskBriefSchema.credential` to a discriminated union — which is a **DESIGN-first
     contract change** under CLAUDE.md ("change DESIGN.md before changing contracts") and would
     break the existing pinned tests in `packages/shared/src/index.test.ts`.
Recommendation to decide before dispatch: (a) or (b). I'd lean (a) with the brief exposing
`profile_id` as a synthetic string like `inline-<task_id>` for the inline case, but that string
form is an invention with no basis in code — it needs a human call.

**Q2 — Task id: `kt-2026-0142` string vs. autoincrement integer.**
DESIGN §6 shows a string id, and `taskBriefSchema.id` is `z.string()` (pinned by tests, including
`pr_convention.branch_prefix` = `kaola/kt-2026-0142-` which embeds the id). Every existing table
(`users`, `agent_keys`, `credential_profiles`, `events`) uses `id INTEGER PRIMARY KEY
AUTOINCREMENT`, and every existing route parses path ids with `parsePositiveInt` (rejecting
non-numeric ids with 404). The two conventions are incompatible at the route level: with a
`kt-…` id, `/api/v1/tasks/:id` cannot use `parsePositiveInt`. Options: integer PK + a separate
`public_id TEXT UNIQUE` generated as `kt-<year>-<4 digits>` (satisfies both, costs a column and a
sequence decision — what does the counter reset on?); or integer PK with the brief carrying
`String(id)` (violates the §6 example's spirit but nothing in the schema); or a TEXT PK
(departs from every other table). **Not derivable from code — needs a decision.**

**Q3 — Event `type` string for a task status change.** DESIGN §10 says the taxonomy is
`状态迁移 / token 揭示 / 心跳 / 回写`; the code today writes `变更` (not in that list) and
`token 揭示`. Should task create/status-change write `状态迁移`, keep `变更`, or add a new label?
`insertAuditEvent` also requires a non-null `actorUserId`, which will not hold for
system-generated transitions (lease expiry) later in M1.

**Q4 — 发布即校验 failure taxonomy and copy.** Nothing in code decides:
 - status code when `validateToken` returns a non-empty `missing` (400? 422?) and the body shape —
   presumably `{ error: '…', missing: ['推','PR'] }` plus a Chinese `message`, but no precedent
   exists for returning a structured detail array alongside `error`;
 - status code when `validateToken` **rejects** (unreachable forge / non-JSON body) — a genuinely
   different failure from insufficient permissions, and `validateToken` has no timeout and no
   try/catch (§4.3), so the route must add both;
 - whether the resulting `TokenCheck` is persisted on the task the way `scopes_checked` is
   persisted on a profile (the `credential_profiles.scopes_checked` column exists but is always
   written as `'[]'` today — it is dead storage right now).

**Q5 — Adding the first cross-package workspace dependency.** `apps/server` currently imports
neither `@kaola/shared` nor `@kaola/forge-adapters`, and no workspace-to-workspace dependency
exists anywhere in the repo (§4.4). Issue #7 needs both. Per CLAUDE.md this is on the "escalate
irreversible changes" list (dependency/build-tooling). Also unverified whether
`tsc --noEmit` in `apps/server` cleanly consumes a workspace package whose `exports` points at raw
`.ts` — worth a smoke check first, since a failure here would reshape the whole approach (e.g.
forcing a build step on `packages/*`).

**Q6 — Who may post.** DESIGN §11's table gives 发布任务 to GitLab/Gitea only (= `active` +
`full`), which matches `canManageProfiles`. But `canManageProfiles` is module-private in
`credential-profiles.ts`. Should it be extracted into a shared exported gate (e.g. in `auth.ts`
next to `getSessionUser`), or duplicated a third time? Extraction touches an existing file that
other issues' tests pin; duplication is the current house style (`parsePositiveInt` is already
duplicated). Low stakes, but pick one so the implementer doesn't guess.

**Q7 — `created_at` representation.** Brief says ISO-8601-with-offset string; every existing DB
timestamp is unix seconds integer. If `tasks.created_at` is an integer, the brief projector must
format with a fixed offset (which offset? the server's local tz? `+08:00` hard-coded? UTC `Z`?) —
and per §5.1 I did not verify that the bare `Z` form passes `z.iso.datetime({ offset: true })`.
Worth one execution check before the projector is written.

**Q8 — Premise check still owed.** I could not read issue #7's title/body/comments. Per CLAUDE.md
("Check the premise before it shapes the work"), whoever holds the issue text should reconcile it
against the measurements above — particularly the CLAUDE.md claim that `@kaola/forge-adapters`
exports a standalone `validateToken` (it does not — §4.1), and the `docs/api.md:130` statement
that there is no `tasks` table (still true).

**Operational, not a question:** `.kw/worktrees/issue-7` has no `node_modules`; `pnpm install`
must be run inside the worktree before `pnpm test` / `pnpm lint` / `pnpm typecheck` will work
there (§4.4).
