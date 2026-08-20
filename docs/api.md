# API

Document public APIs, endpoints, schemas, events, and integration contracts.

Product contracts that are not yet in source remain in [DESIGN.md](DESIGN.md) §6 (任务卡 Schema), §8 (ForgeAdapter), §9 (MCP 工具面 / REST). This file records what is implemented.

MCP tools (`list_tasks`, `get_task_brief`, `claim_task`, `report_progress`, `submit_pr`, `release_task`) are not implemented. Task CRUD, vault, and claim HTTP are not implemented.

## HTTP (`@kaola/server`)

Sources: `apps/server/src/app.ts`, `auth.ts`, `schema.ts`, `db.ts`, `placeholder.ts`, `index.ts`.

`buildApp({ sqlitePath? })` creates its own SQLite via `createDb`. Process `index.ts` uses `SQLITE_PATH ?? ':memory:'`.

### `GET /`

`text/plain; charset=utf-8` body `考拉任务服务占位` (`getPlaceholderBody()`). Unauthenticated.

### `GET /login`

HTML 200 (`text/html; charset=utf-8`). Links to `/login/github`, `/login/gitlab`, `/login/gitea`.

### OAuth start (`@fastify/oauth2` `startRedirectPath`)

- `GET /login/github`
- `GET /login/gitlab`
- `GET /login/gitea`

### OAuth callbacks

- `GET /login/github/callback`
- `GET /login/gitlab/callback`
- `GET /login/gitea/callback`

Successful login sets `request.session.userId` and redirects to `/`. Userinfo fetch failure: `502` `{ error: 'userinfo_failed' }` or `{ error: 'userinfo_invalid' }`.

OAuth token hosts / paths in `registerAuth`: GitHub uses `@fastify/oauth2` `GITHUB_CONFIGURATION`; GitLab `authorizePath` `/oauth/authorize`, `tokenPath` `/oauth/token` on `OAUTH_GITLAB_BASE_URL`; Gitea `authorizePath` `/login/oauth/authorize`, `tokenPath` `/login/oauth/access_token` on `OAUTH_GITEA_BASE_URL`. Userinfo GET: GitHub `https://api.github.com/user`; GitLab `${gitlabBaseUrl}/api/v4/user`; Gitea `${giteaBaseUrl}/api/v1/user`.

### `GET /api/v1/me`

Session user JSON. Fields: `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`. When `status` is `待批准`, also `message` `你的账号待正式成员批准后方可认领任务。`.

Unauthenticated: `Accept` containing `application/json` → `401` `{ error: 'unauthorized' }`; otherwise `302` `/login`.

### `POST /api/v1/users/:id/approve`

Actor must be session user with `status` `active` and `permission_level` `full`. Sets target `status` to `active` (does not change `permission_level`; GitHub stays `claim_only`). Response is the updated user JSON (same fields as `GET /api/v1/me`); if the re-select is empty, `{ ok: true }`.

Errors: no session → `401` `{ error: 'unauthorized' }`; actor not `active`+`full` → `403` `{ error: 'forbidden' }`; non-integer or `<= 0` id → `400` `{ error: 'invalid_id' }`; missing user → `404` `{ error: 'not_found' }`.

### `users` table

SQL from `createDb` (`CREATE TABLE IF NOT EXISTS users`): `id`, `provider`, `remote_id`, `username`, `display_name`, `status`, `permission_level`; UNIQUE `(provider, remote_id)`.

Drizzle enums in `apps/server/src/schema.ts`: `provider` `github` | `gitlab` | `gitea`; `status` `active` | `待批准`; `permission_level` `full` | `claim_only`.

First insert (`mapProfile`): GitHub → `status` `待批准`, `permission_level` `claim_only`; GitLab / Gitea → `active` + `full`. Subsequent login updates `username` and `display_name` only.

### Env (`registerAuth`)

Required (throw `missing required environment variable …` if empty): `SESSION_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL`, `OAUTH_GITEA_CLIENT_ID`, `OAUTH_GITEA_CLIENT_SECRET`, `OAUTH_GITEA_BASE_URL`.

Optional: `PUBLIC_URL` default `http://localhost:3000` (trailing slash stripped). Existing `PORT` / `HOST` / `SQLITE_PATH`.

Callback URIs: `${PUBLIC_URL}/login/{github|gitlab|gitea}/callback`.

Server dependencies added: `@fastify/oauth2@^8.3.0`, `@fastify/cookie@^11.1.2`, `@fastify/session@^11.1.2` (plus existing `fastify`, `drizzle-orm`, `better-sqlite3`).

## `@kaola/forge-adapters`

Package export `"."` → `./src/index.ts`. No runtime HTTP dependency (global `fetch`).

- `getForgeAdaptersHealth(): string` → `'kaola-forge-adapters-ready'`
- `createForgeAdapter(kind, options?: { baseUrl?: string }): ForgeAdapter`

Types: `ForgeKind` `'github' | 'gitlab' | 'gitea'`; `Credential` `{ token: string }`; `RepoRef` `{ full_name: string; base_url: string }`; `TokenCapability` `'读' | '推' | 'PR'`; `TokenCheck` `{ missing: TokenCapability[] }`; `CreateForgeAdapterOptions`; `ForgeAdapter`.

Placeholders: `ImportedIssue`, `PrStatus`, `ForgeEvent`, `IssueRef` are `unknown`.

Implemented: `kind` + `validateToken` (GET-only). Other interface methods throw `Error('not implemented')`.

API hosts: GitHub always `https://api.github.com` (ignores `baseUrl`). GitLab: strip trailing slashes then `/api/v4`. Gitea: `/api/v1`. GitLab/Gitea origin is `options?.baseUrl ?? repo.base_url`. GitLab repo path: `/projects/${encodeURIComponent(full_name)}`. GitHub/Gitea repo path: `/repos/${full_name}`. User path: `/user`.

Auth headers: GitHub `Authorization: Bearer`, `User-Agent: KaolaTasks`, `Accept: application/vnd.github+json`; GitLab `PRIVATE-TOKEN`; Gitea `Authorization: token`.

Push/PR checks are REST permission proxies, not mutating git push / POST PR.

Unknown `kind` throws `Error('unknown forge kind: …')`.

## `@kaola/shared`

(`packages/shared/src/index.ts`, package export `"."` → `./src/index.ts`) library contract matching [DESIGN.md](DESIGN.md) §5–§6:

- `getSharedHealth(): string` → `'kaola-shared-ready'`
- `taskStatusSchema` — `z.enum(['待认领', '进行中', '待验收', '已完成', '已退回', '已取消'])`
- `type TaskStatus`
- `taskBriefSchema` — `z.strictObject` (unknown keys throw)
- `type TaskBrief`
- `parseTaskBrief(input: unknown): TaskBrief` — `taskBriefSchema.parse(input)` (throws on invalid)
- `transitionTaskStatus(from: string, to: string): string` — legal edges return `to`; others throw

`taskBriefSchema` keys in source: `id`, `title`, `description_md`, `source`, `repo`, `acceptance_criteria`, `test_command`, `constraints`, `pr_convention`, `credential`, `priority`, `tags`, `poster`, `status`, `created_at`. `source` is a discriminated union on `type`: `native` (type only) | `imported` (type + `issue_url` string). `repo`: `forge` enum `github` | `gitlab` | `gitea`; `base_url`, `full_name`, `base_branch`, `suggested_dir` strings. `acceptance_criteria`: `string[]`. `test_command`: string. `constraints`: `allowed_paths`, `forbidden_paths` `string[]`. `pr_convention`: `branch_prefix`, `title_prefix`. `credential`: `{ profile_id: string }` only (strict). `priority`: `P0` | `P1` | `P2` | `P3`. `tags`: `string[]`. `poster`, `title`, `description_md`, `id`: string. `status`: `taskStatusSchema`. `created_at`: `z.iso.datetime({ offset: true })`.

Legal `transitionTaskStatus` edges in source: 待认领 → 进行中, 已取消; 进行中 → 待认领, 待验收; 待验收 → 已完成, 已退回; 已退回 → 待认领, 已取消.

The DESIGN.md §6 example still parses (`packages/shared/src/index.test.ts` pins it). Field names and enums live in source and DESIGN.md §6 — this file does not duplicate that JSON example. Dependency: `zod` `^4.4.3`.
