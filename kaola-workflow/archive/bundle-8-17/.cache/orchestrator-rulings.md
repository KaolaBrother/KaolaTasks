# Orchestrator rulings — bundle-8-17 (#8 + #17)

Recorded 2026-08-21 after ground-truth-board.md and ground-truth-hosting.md. tdd-guide and implementer must follow these; they are not value calls for the user.

## #8 board

1. **No new events HTTP** in this run. A GET events envelope would be a public contract #9/#10 would have to write into. Timeline **synthesizes 发布** from the existing brief (`created_at` + `poster`). Do **not** invent stored rows or UI rows for 认领 / 心跳 / 提交 / 完结. Do **not** relabel `token 揭示` as 发布.
2. **Client-side filters** on the full `GET /api/v1/tasks` list (`status`, `tags` membership, `repo.forge`). List URL must stay exactly `/api/v1/tasks` (no query string) so `App.form.test.ts`’s defensive stub keeps working.
3. **No vue-router / Pinia / markdown / sanitizer packages.** Detail is in-app selected-task state. `description_md` / title / tags / poster render as **escaped text** (`{{ }}` / `n-text` / `<pre>`), never `v-html`. `source.issue_url` may be an `<a href>` **only** when the URL is `http:` or `https:`; `javascript:` and other schemes must not become href.
4. **Board lives on `view === 'member'`** (active `claim_only` and `full`). Pending card stays as today. Server GET already allows 待批准; this run does not redesign that card.
5. **Six kanban columns** are the six status enum strings exactly: 待认领 / 进行中 / 待验收 / 已完成 / 已退回 / 已取消. Empty columns are correct. List view is the same array, different layout.
6. **Token secrecy:** never render `token` / `token_encrypted` / ciphertext. `credential` may show as 共享档案 (`profile_id`) or 单任务临时 token (`inline: true`) using already-pinned Chinese.
7. **Chinese UI.** Status labels are the enum strings, not English aliases. New testids must not collide with existing `task-form` / `task-submit` / …
8. **Do not implement claim / heartbeat / submit / PATCH-to-进行中.**
9. **Test file:** `apps/web/src/App.board.test.ts` only. Copy fetch/mount conventions from `App.form.test.ts`. Do not edit `App.form.test.ts` or any production file. Do not append a server test file.

## #17 hosting

1. **Seam:** extend `buildApp(options?: { sqlitePath?: string; webDist?: string; viteDevTarget?: string })`. Omit/empty both hosting options → today’s placeholder. **Do not** `existsSync` a default `../web/dist` inside `buildApp()` (would turn vault/agent-keys inject tests red when a dist happens to exist).
2. **Both set:** `webDist` wins (production). Pin that.
3. **Naked `buildApp()`** must keep `GET /` → `200` body `考拉任务服务占位` and `content-type` containing `text/plain`. Existing `placeholder.test.ts` / `vault.test.ts` / `agent-keys.test.ts` stay green; **do not edit them**.
4. **When `webDist` points at a dir with `index.html`:** `GET /` is that SPA (HTML, not the placeholder); unmatched GET (e.g. `/some/deep/path`) returns the same `index.html`; `/api/*` and `/login*` are **not** swallowed.
5. **Defaults leave 3000:** `PORT` default `31415`; `PUBLIC_URL` default `http://localhost:31415`. Existing suites that **assign** `PUBLIC_URL=http://localhost:3000` as a fixture must keep doing so — do not rewrite those fixtures.
6. **Vite legacy proxy** `/api` and `/login` → `http://127.0.0.1:31415`.
7. **Docker:** compose `31415:31415`, `PORT=31415`; Dockerfile `EXPOSE 31415` / `ENV PORT=31415`; image must build web dist (pin via Dockerfile/compose file tests).
8. **Root `package.json` has a `dev` script.** Pin that the script exists; do not require it to actually spawn processes in unit tests.
9. **Test file:** `apps/server/src/hosting.test.ts`. Append **only this file** to the root `package.json` `"test"` node --test list (before the `&& pnpm --filter @kaola/web test`). Use inject, not `listen` on 31415; ephemeral port `0` only if a listen is unavoidable. Copy `applyOauthTestEnv` + dynamic `import('./app.ts')` from an existing server test.
10. **Out of scope:** OAuth `scope=undefined`, RFC1918 blocking, DESIGN.md contract edits, cookie Domain / 127.0.0.1 vs localhost.

## Shared

- Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17`
- Baseline commit: `190a79aa5bc806286cb62ad8cddba5d40e65fb47`
- Ground truth: `kaola-workflow/bundle-8-17/.cache/ground-truth-board.md` and `ground-truth-hosting.md` on the MAIN checkout.
