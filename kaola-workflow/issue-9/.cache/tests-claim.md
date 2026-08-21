# Issue #9 claim suite — tdd-guide handoff

Custody: `apps/server/src/claim.test.ts` and the root `package.json` `"test"` script append. **Implementer must NOT edit `claim.test.ts` or the `package.json` test-script file list.** Implementer writes production code only (`register*` routes, `leases` DDL, sweep, audit). Do not treat a green new suite as this role’s outcome — this file is RED on HEAD `1dae847c7af888aff8a92905a9cf2f448df68c74`.

Worktree: `.kw/worktrees/issue-9` (branch `workflow/issue-9`). Run tests with cwd = that worktree.

Baseline capture: `kaola-workflow/issue-9/.cache/tests-claim-baseline.txt`  
`CI=true node --experimental-strip-types --test apps/server/src/claim.test.ts` → **27 fail, 0 pass**.

Old suite still green (same worktree): `CI=true node --experimental-strip-types --test apps/server/src/tasks.test.ts apps/server/src/agent-keys.test.ts` → 78 pass, 0 fail.

---

## Describe tree (27 tests)

```
issue #9 lease-based claiming   { concurrency: false }
├── authentication — Bearer only
│   ├── unauthenticated claim, progress, and release are 401 unauthorized with WWW-Authenticate Bearer
│   ├── wrong and non-Bearer credentials are 401 with WWW-Authenticate Bearer
│   ├── a session cookie without Bearer does not authorize claim, progress, or release
│   ├── unknown publicId with a valid Bearer key is 404 not_found
│   └── numeric PK in the path with a valid Bearer key is 404 not_found
├── POST /api/v1/tasks/:publicId/claim — 201 envelope
│   ├── claiming an inline task returns 201 with task, forge token, lease TTL, and clone guidance
│   ├── claiming a profile task returns 201; credential stays { profile_id }; token is the profile forge plaintext
│   └── session GET list and GET one after a successful claim still omit forge token and secret keys
├── AuthZ
│   ├── pending 待批准 seeded Agent Key is 403, does not reveal the forge token, and writes no token 揭示
│   ├── approved GitHub claim_only can claim
│   └── active full can claim
├── conflicts / illegal states
│   ├── second claim while 进行中 is 409 conflict, no token, and no second reveal
│   ├── claiming a 已取消 task is 409 illegal_transition
│   ├── claiming a 待验收 task is 409 illegal_transition
│   ├── progress and release by a non-holder are 403 forbidden
│   ├── progress and release with no live lease are 409 conflict 任务未被认领
│   └── progress and release after the holder released are 409 任务未被认领
├── heartbeat
│   ├── omitted note still renews expires_at from heartbeat time and writes 心跳 with note empty string
│   └── a progress note is persisted on the 心跳 event; empty note still renews
├── release
│   ├── holder release returns 200 { task } 待认领, marks the lease released, and writes 状态迁移 without reason
│   └── release with reason stores reason on the 状态迁移 event
├── expiry
│   ├── check-on-read: after TTL, session GET list and GET one show 待认领, lease expired, actor_user_id null, reveal rows unchanged
│   ├── check-on-write: after TTL, progress sweeps then returns 409 任务未被认领
│   └── after expiry a different Agent Key can claim again and writes a second token 揭示
├── reveal audit
│   ├── inline claim writes token 揭示 { task_id, agent_key_id, credential: inline } and 状态迁移 待认领→进行中
│   └── profile claim writes token 揭示 with credential profile and integer profile_id; no plaintext or ciphertext
└── leases table
    └── successful claim inserts one active lease keyed by tasks.id PK; at most one active row per task
```

---

## Request / response shapes (pinned)

| Method | Path | Auth | Body | Success |
|--------|------|------|------|---------|
| POST | `/api/v1/tasks/:publicId/claim` | `Authorization: Bearer ktk_…` | none | `201` |
| POST | `/api/v1/tasks/:publicId/progress` | Bearer | `{ note?: string }` (omit body OK) | `200` |
| POST | `/api/v1/tasks/:publicId/release` | Bearer | `{ reason?: string }` (omit body OK) | `200` |

`:publicId` is `kt-YYYY-NNNN`. Integer PK (`1` / `0` / `-1`) and unknown `kt-2026-9999` → `404 { error: 'not_found' }` (Kaola shape, **not** Fastify `{ error: 'Not Found', statusCode, message }`).

### Claim `201` exact keys `['clone','lease','task','token']`

```json
{
  "task": { /* 15-key brief; parseTaskBrief(task); status 进行中; credential { profile_id } or { inline: true } */ },
  "token": "<forge plaintext used at publish>",
  "lease": { "expires_at": "<ISO-8601 from unix (now+86400)*1000>", "ttl_seconds": 86400 },
  "clone": {
    "suggested_dir": "<equals task.repo.suggested_dir>",
    "token_usage": "token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。"
  }
}
```

Do **not** `parseTaskBrief` the envelope. Do **not** put forge plaintext inside `task` / `lease` / `clone`. Nested objects must not contain keys `token` / `token_encrypted` / `inline_token_encrypted` / `access_token`.

### Progress `200` exact keys `['lease','task']`

`task.status === '进行中'`. Same lease wire shape. **No** `token`. Renew `expires_at` from **heartbeat** `now+86400`, not original claim time.

### Release `200` exact keys `['task']`

`task.status === '待认领'`. **No** `token`. **No** `lease` on the wire.

### Errors

| Case | Status | Body |
|------|--------|------|
| missing / wrong / non-Bearer / session-cookie-only | 401 | `{ error: 'unauthorized' }` + `WWW-Authenticate` matching `/Bearer/` (same as whoami) |
| unknown publicId / numeric PK (with valid Bearer) | 404 | `{ error: 'not_found' }` |
| pending `users.status === '待批准'` | 403 | `{ error: 'forbidden', message: '你的账号待正式成员批准后方可认领任务。' }` — no forge token, no new `token 揭示` |
| second claim while `进行中` | 409 | `{ error: 'conflict', message: '任务已被认领。' }` — no token, no second reveal |
| claim when status is not `待认领` | 409 | `{ error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「进行中」。' }` |
| progress/release by non-holder | 403 | `{ error: 'forbidden' }` (message not required) |
| progress/release with no live lease | 409 | `{ error: 'conflict', message: '任务未被认领。' }` |

Session cookie does **not** authorize these three routes. GET list/get stay session-only; after a successful claim they still must not contain forge plaintext or secret key names; after expiry they show `待认领`.

Do **not** call `validateToken` / `fetch` on the claim path (inline 201 test wraps claim with `recordOutboundFetch` and asserts `outbound.length === 0`).

---

## Minting Bearer keys

**Active users** (`active` + `full`, or `active` + `claim_only` after approve): session `POST /api/v1/agent-keys` `{ label }` → `201 { token: "ktk_" + 64 hex, id, … }`. Then `Authorization: Bearer ${token}`.

**Pending (`待批准`)**: cannot `POST /api/v1/agent-keys` (suite still asserts that 403). Tests use a **file SQLite** (`sqliteFile` + `createApp({ sqlitePath })`) and a second `createDb(sqlitePath)` (`openDb`) to INSERT:

```sql
INSERT INTO agent_keys (user_id, key_hash, label, last_used_at) VALUES (?, ?, ?, NULL)
```

`key_hash = sha256(utf8).hex` of plaintext `ktk_` + 64 hex (`createHash('sha256').update(plaintext, 'utf8').digest('hex')`), same as `hashAgentKey`. In-memory DB cannot be reopened — pending tests **must** stay on a file DB.

---

## Date.now stub

House timestamps are unix seconds (`Math.floor(Date.now() / 1000)`). Helper `freezeNow(t, ms)` replaces `Date.now` and restores in `t.after`. Default freeze: `Date.UTC(2026, 7, 21, 4, 0, 0)`.

- Wire `lease.expires_at` = `new Date((unixNow + 86400) * 1000).toISOString()`
- Heartbeat advances 3600s then expects `expires_at` from the **new** unix now
- Expiry: after claim, GET still `进行中`; advance `86399s` still live; advance `1s` more (`expires_at <= now`) → session GET list/get `待认领`, lease `state: 'expired'`, `状态迁移` with `actor_user_id` **null**
- Check-on-write: advance `86400s` then POST progress (no GET first) → `409 任务未被认领` and the lease is already swept

Session cookie has no `maxAge` in `auth.ts`, so a 24h clock jump must not 401 the session GET.

---

## `leases` table (observed via second `createDb`)

Columns selected by the suite:

`task_id` (integer `tasks.id` PK, **not** public_id), `claimer_user_id`, `agent_key_id`, `claimed_at`, `expires_at`, `last_heartbeat`, `state`.

- `state`: `'active' | 'released' | 'expired'`
- At claim: `claimed_at === last_heartbeat === unixNow`, `expires_at === unixNow + 86400`, `state === 'active'`
- At heartbeat: `last_heartbeat` and `expires_at` update; `claimed_at` stays
- After any HTTP return: **at most one** `active` row per `task_id`
- Tests do **not** create this table. Implementer adds DDL in `createDb`.

## Events

| type | when | details | actor |
|------|------|---------|-------|
| `token 揭示` | successful claim decrypt (inline **and** profile) | `{ task_id, agent_key_id, credential: 'inline' \| 'profile', profile_id? }` — `profile_id` **only** when `credential === 'profile'` (integer PK). No plaintext, no ciphertext | claimer user id |
| `状态迁移` | claim | `{ task_id, from: '待认领', to: '进行中' }` | claimer |
| `状态迁移` | release | `{ task_id, from: '进行中', to: '待认领' }` + `reason` key **only** when body had `reason` | releaser |
| `状态迁移` | auto-expiry | `{ task_id, from: '进行中', to: '待认领' }` (no reason) | **null** |
| `心跳` | progress | `{ task_id, note }` with `note: ''` when omitted | claimer |

Do **not** mutate old `token 揭示` rows on expiry. Publish-time profile `token 揭示` (no `task_id` / `agent_key_id`) is a different shape; claim-shaped rows are those with both.

`insertAuditEvent` today requires `actorUserId: number`. Expiry still must persist SQL NULL — extend or bypass that helper; do not invent a system user.

---

## Judgement calls the implementer must respect (not reopen)

These are implied by the suite where the ruling JSON was exact enough to pin keys, or where a test had to choose a checkable oracle.

1. Claim / progress / release **wire objects use exact key sets** above (`Object.keys` sorted). Extra keys fail.
2. `lease.ttl_seconds` is the number `86400`, not a string.
3. Auth runs **before** resource lookup: unauthenticated claim of a real `kt-…` is `401`, not `404`.
4. Non-holder `403` pins `error === 'forbidden'` and no forge token; a `message` is **not** required (pending 403 **does** require the exact Chinese `message`).
5. Heartbeat `details.note` is always present; omitted/empty → `''`.
6. Expiry uses `expires_at <= now` (equal counts as expired).
7. Lease DB times are unix seconds; heartbeat does not insert a second `active` row.
8. Claim-path `token 揭示` is a **third details shape** (`task_id` + `agent_key_id` + `credential`); do not reuse `revealCredentialProfile` as-is (no inline, no `task_id`). Decrypt with `decryptToken`.
9. Fixture vault key is `'cd'.repeat(32)` (same as `tasks.test.ts`) so POST `/tasks` ciphertext decrypts.
10. Fetch seam is `beginFetch` keyed on bare token; unregistered tokens → 500. Claim must not touch it.
11. Poster PATCH still must not grow `待认领 → 进行中`; claiming is these Bearer routes.

---

## Failure signature sample + baseline SHA

HEAD (worktree, no production claim yet): **`1dae847c7af888aff8a92905a9cf2f448df68c74`**

Typical RED (route missing):

```
AssertionError [ERR_ASSERTION]: expected 401, got 404: {"message":"Route POST:/api/v1/tasks/kt-2026-0001/claim not found","error":"Not Found","statusCode":404}
404 !== 401
```

Unknown-id test fails on **body**, not status (Fastify already 404s):

```
+   error: 'Not Found',
+   message: 'Route POST:/api/v1/tasks/kt-2026-9999/claim not found',
+   statusCode: 404
-   error: 'not_found'
```

Success-path tests fail `404 !== 201`. Counts: **tests 27, pass 0, fail 27**.

Full log: `kaola-workflow/issue-9/.cache/tests-claim-baseline.txt`.

Root `package.json` `"test"` now lists `apps/server/src/claim.test.ts` after `hosting.test.ts` and before `&& pnpm --filter @kaola/web test`.

---

## Explicit custody

**Implementer must NOT edit `apps/server/src/claim.test.ts` or the root `package.json` `"test"` script.** If a test is defective, bounce to tdd-guide. Do not add MCP tests, web tests, or `validateToken` on claim. Do not add a per-task TTL column.
