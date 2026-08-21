# impl-board — issue #8 任务看板

**Role:** implementer (production code only; tests were not written, weakened, deleted, or skipped)
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17`
**Production file changed:** `apps/web/src/App.vue` only (+188 lines)
**Tests:** READ and RUN; no `*.test.ts` edits

All 17 board tests and all 27 form tests were satisfied. Nothing to escalate to tdd-guide.

---

## Verify (run in-session, not paraphrased)

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17
CI=true pnpm --filter @kaola/web test
```

```
$ vitest run

 RUN  v4.1.11 /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17/apps/web


 Test Files  2 passed (2)
      Tests  44 passed (44)
   Start at  12:03:34
   Duration  3.11s (transform 149ms, setup 0ms, import 944ms, tests 3.70s, environment 234ms)
```

exit 0. That is 17 board + 27 form.

```
CI=true pnpm --filter @kaola/web typecheck
```

```
$ vue-tsc --noEmit -p tsconfig.json
```

exit 0.

---

## Files changed (this implementer)

| path | change |
|---|---|
| `apps/web/src/App.vue` | member workbench 任务看板: GET `/api/v1/tasks` once, kanban/list XOR, client filters, in-app detail + synthetic 发布 timeline |

`git diff --stat -- apps/web/src/App.vue`:

```
 apps/web/src/App.vue | 188 +++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 188 insertions(+)
```

Did **not** touch: any `*.test.ts`, `apps/server/**`, `docs/DESIGN.md`, `package.json`, `vite.config.ts`. Other dirty paths in the worktree (`apps/server/*`, `vite.config.ts`, `package.json`, `hosting.test.ts`, …) belong to the #17 hosting implementer.

---

## What landed (mapped to the binding contract)

- Board root `data-testid="board"` only inside `view === 'member'` (active `claim_only` and `full`). Pending / login have no board. `claim_only` still has no `task-form`.
- Default layout 看板: `board-kanban` XOR `board-list`. View buttons `board-view-list` / `board-view-kanban`. Filters sit outside the XOR.
- `onMounted` member path: `GET /api/v1/tasks` exactly once, `credentials: 'include'`, `Accept: application/json`. Parse `{ tasks }`. No query. Filters do not refetch. Detail uses the list payload (no GET one).
- Six columns in enum order: 待认领 / 进行中 / 待验收 / 已完成 / 已退回 / 已取消. Empty columns stay. Card order follows the list array. Hidden cards use `v-if` (filtered array), not CSS hide.
- n-select `v-model:value` + `data-testid` on the n-select root. All value `''` label `全部`. Status / tag / forge options as specified. Filters AND; tag match `tags.includes`.
- Detail from selected id in the list. Close clears it. Timeline: exactly one `board-timeline-item` synthesizing **发布** from `poster` + `created_at` (ISO verbatim). No 认领/心跳/提交/完结. No token 揭示.
- Credential chrome: `{ profile_id }` → `共享档案`; `{ inline: true }` → `单任务临时 token`.
- `description_md` / title via `{{ }}` (no `v-html`).
- `source.type === 'native'` → no `board-detail-issue-url`. Imported `http:`/`https:` → `<a :href>`. Other schemes (including `javascript:`) → text, no `<a>`.
- Empty `{ tasks: [] }` still shows board + six empty columns + `暂无任务。`
- Chinese copy character-for-character as pinned. No `Kanban` / `Timeline` / `Backlog`.

---

## Unsatisfied tests

None.
