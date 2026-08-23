# Implementer #21 — publish pane: drop extras, read-only import card

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`  
No commit. Tests not edited. Main checkout not edited except this cache file.

## task

Publish pane (issue #21): remove `task-group-acceptance` and the six extra fields; omit those keys from `POST /api/v1/tasks`; native keeps title/description inputs; imported shows a read-only Issue card only after import 200 (and clears the card on native or Issue/URL change). Form order credential → repo → task unchanged.

## verification tier

`tests-green`

## files changed

- `apps/web/src/App.vue` — drop acceptance group and unused refs; imported 200 → `task-import-card` (+ title/body/url, `task-import-source-label` only on the card); `createTask` JSON is `{ title, description_md, source, repo, credential }` (still omit empty `base_branch` / `suggested_dir`); `importTask` still fills title/description/repo/source and sets `taskImportReady`.

`theme.css` not changed.

## verification commands

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21
pnpm --filter @kaola/web test
```

## before

Same command: **exit 1**. Vitest **8 failed | 87 passed** (95), 2 failed files (`App.form.test.ts`, `App.shell.test.ts`). Extras still in the form and POST body; `task-import-source-label` shown as soon as source=imported; no `task-import-card`.

## after

**exit 0**. Test Files **5 passed (5)**. Tests **95 passed (95)**. Duration ~4.72s.
