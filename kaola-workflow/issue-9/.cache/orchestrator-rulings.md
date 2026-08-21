# Orchestrator rulings for issue #9

Evidence: `kaola-workflow/issue-9/.cache/ground-truth.md` (worktree `.kw/worktrees/issue-9`, HEAD at claim). These are technical decisions, not DESIGN.md contract changes. tdd-guide must pin them; implementer must not reopen them.

## In scope / out of scope

- In: REST claim / progress / release, `leases` table, reveal-on-claim + audit, expiry back to 待认领, clone guidance on claim success.
- Out: MCP server (#10), `submit_pr` / PR polling (#11), web UI / events HTTP, DESIGN.md schema edits, per-task TTL column (no §6 field and no tasks column today — default 24h only).

## Routes (Bearer only)

All three are `Authorization: Bearer <ktk_…>` on the existing public_id nested under `/api/v1/tasks`. Session cookie does not authorize them. Unauthenticated = same oracle as whoami: `401 { error: 'unauthorized' }` + `WWW-Authenticate: Bearer`.

| Method | Path | Body | 200/201 |
|--------|------|------|---------|
| POST | `/api/v1/tasks/:publicId/claim` | none required | `201` envelope below |
| POST | `/api/v1/tasks/:publicId/progress` | `{ "note"?: string }` | `200` `{ task, lease }` |
| POST | `/api/v1/tasks/:publicId/release` | `{ "reason"?: string }` | `200` `{ task }` |

`:publicId` is `kt-YYYY-NNNN` (same as GET/PATCH). Unknown id → `404 { error: 'not_found' }`. Integer PK in the path → 404.

GET list/get stay **session-only**. Never-token on those existing routes is still the #9 acceptance mapping of `list_tasks` / `get_task_brief`. Do not add Bearer list in this issue.

No session-cookie claim route.

## Claim success envelope (`201`)

```json
{
  "task": { /* existing 15-key brief; status 进行中; still credential union, never forge token inside task */ },
  "token": "<forge plaintext>",
  "lease": { "expires_at": "<ISO-8601>", "ttl_seconds": 86400 },
  "clone": {
    "suggested_dir": "<task.repo.suggested_dir>",
    "token_usage": "token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。"
  }
}
```

- `task` must `parseTaskBrief`. Do **not** `parseTaskBrief` the whole envelope (`z.strictObject` rejects extras).
- `token` is the decrypted forge token (agent-keys already use this JSON key for a secret).
- `clone.suggested_dir` equals `task.repo.suggested_dir` (already defaulted to the last path segment of `full_name` at publish).
- `clone.token_usage` is the exact string above (pinned).
- `lease.ttl_seconds` is `86400`. `expires_at` is unix-seconds `claimed_at + 86400` rendered like task `created_at` (`new Date(sec * 1000).toISOString()`).
- Progress `200`: `{ task, lease }` — **no** `token`. Release `200`: `{ task }` with `status` `待认领` — **no** `token`.

Do not reuse `assertNoTokenMaterial` on claim `201` (it forbids any key named `token`). Do apply a never-token assertion to session GET list/get after a claim, and to progress/release bodies.

## AuthZ

- Pending (`users.status === '待批准'`): `403 { error: 'forbidden', message: '你的账号待正式成员批准后方可认领任务。' }` (`auth.ts` `PENDING_CLAIM_MESSAGE`). **No decrypt, no `token` in body, no new `token 揭示` row.** Seed `agent_keys` via a second `createDb(sqlitePath)` connection — pending users cannot `POST /api/v1/agent-keys`. Hash = `sha256(utf8).hex` of a `ktk_` + 64 hex plaintext, same as `hashAgentKey`.
- Approved `claim_only` (`active` + `claim_only`): **can** claim (DESIGN §11).
- `active` + `full`: can claim.
- Bearer hook today does not check `user.status`; claim handlers must.

## Conflicts / illegal states

- Second claim on an already-`进行中` task (including a different Agent Key): `409 { error: 'conflict', message: '任务已被认领。' }`. No second reveal event, no token in the 409 body.
- Claim when status is not `待认领` (已取消 / 待验收 / …): `409 { error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「进行中」。' }` — reuse the existing PATCH message shape.
- Progress/release by a Bearer identity that is not the live lease holder: `403 { error: 'forbidden' }` (no message required).
- Progress/release when there is no live lease (task `待认领` / already released / expired and swept): `409 { error: 'illegal_transition', message: '任务状态不允许从「${from}」变更为「${to}」。' }` with the attempted edge (`进行中` for progress-as-no-op is wrong — progress on 待认领 is not a status change; pin `409 { error: 'conflict', message: '任务未被认领。' }` for progress/release without a live lease instead).

## Heartbeat

- `note` optional; omit/empty still renews. If a string is present, persist it.
- Renews `expires_at` to `now + 86400` (from heartbeat time, not original claim).
- Writes `events.type` `心跳` with `actor_user_id` = claimer user id and `details` `{ task_id: public_id, note }` (`note` is `''` when omitted).

## Release

- Live lease → `state: 'released'`; task `进行中 → 待认领` via `transitionTaskStatus`.
- Writes `状态迁移` `{ task_id, from: '进行中', to: '待认领' }` with `actor_user_id` = releaser.
- Optional `reason` stored in that event as `reason` (omit key when absent).

## Expiry

- Default TTL 86400 seconds. No per-task column.
- Check-on-read **and** check-on-write: session `GET /api/v1/tasks` and `GET /api/v1/tasks/:publicId`, plus Bearer claim/progress/release, must sweep expired live leases before acting. Tests stub `Date.now` (house time is unix seconds).
- Sweep: live lease with `expires_at <= now` → lease `state: 'expired'`; task `进行中 → 待认领`; `状态迁移` `{ task_id, from: '进行中', to: '待认领' }` with `actor_user_id` **null** (SQL column is nullable; do not invent a system user).
- "撤销该次 token 揭示的有效性记录" = no live (`active`) lease + task is `待认领`. Do **not** mutate old `token 揭示` rows (audit is append-only).
- After expiry, a different Agent Key can claim again (second reveal event).

## Reveal audit

Every successful decrypt on claim writes `token 揭示` (profile **and** inline). Details (no plaintext, no ciphertext):

```json
{ "task_id": "kt-…", "agent_key_id": <n>, "credential": "profile" | "inline", "profile_id": <n> }
```

`profile_id` present only when `credential === "profile"` (integer PK, same as publish events).

Also write `状态迁移` `{ task_id, from: '待认领', to: '进行中' }` with `actor_user_id` = claimer.

Do **not** call `validateToken` on claim (publish already did; keeps claim off the fetch stub).

Do **not** require `revealCredentialProfile` (it cannot do inline and its details lack `task_id`). Decrypt via `decryptToken`.

## `leases` table (DESIGN §10)

Observable via a second `createDb(sqlitePath)` connection after HTTP:

- Columns: `task_id` INTEGER (tasks.id PK), `claimer_user_id`, `agent_key_id`, `claimed_at`, `expires_at`, `last_heartbeat`, `state`.
- `state`: `'active' | 'released' | 'expired'`.
- At most one `active` row per `task_id` after any request returns.

## Tests file / wiring

- New file only: `apps/server/src/claim.test.ts`. Do not edit `tasks.test.ts` / `agent-keys.test.ts` / production sources.
- Append that file to the **worktree** root `package.json` `test` script (the `node --test` list, before `&& pnpm --filter @kaola/web test`).
- Copy the tasks.test.ts seams (`applyOauthTestEnv` **with** `VAULT_MASTER_KEY`, dynamic `import('./app.ts')`, `beginFetch`, login-via-callback, `sqliteFile` + `openDb`). Do not import from `tasks.test.ts`.
- Outer describe `{ concurrency: false }`.
- Baseline: existing `pnpm test` files must still be green; only the new file is RED.

## Web

No web tests or App.vue changes.
