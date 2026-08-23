# tests-shell — `apps/web/src/App.shell.test.ts` (issue #18)

**Artifact (worktree):** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18/apps/web/src/App.shell.test.ts`
**Handoff (MAIN checkout):** `kaola-workflow/issue-18/.cache/tests-shell.md`
**Verbatim RED capture:** `kaola-workflow/issue-18/.cache/tests-shell-baseline.txt`
**Baseline SHA:** `be2d963b792fced8360354cfc4530b91387d50ea` (worktree HEAD; no `theme.css`, no nav/group/profile/PATCH seams)

I wrote tests only. **`App.vue`, `theme.css`, `theme.ts`, `main.ts`, `index.html`, server files, `DESIGN.md`, the four existing `App.*.test.ts` files, and `package.json` were not modified.**

`it(` count: **11**. All 11 failed on this baseline. None passed.

---

## 1. How to run

From the worktree:

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18
pnpm --filter @kaola/web exec vitest run src/App.shell.test.ts
```

(`pnpm --filter @kaola/web test -- src/App.shell.test.ts` runs the package script `vitest run` and still picks up all `src/**/*.test.ts` files. Use `exec vitest run src/App.shell.test.ts` to isolate this suite.)

Existing four suites (must stay green):

```
pnpm --filter @kaola/web test
```

On baseline that was **11 failed | 75 passed** (the 75 are board 18 + form 33 + audit 16 + settings 8).

Do **not** treat a later green shell suite as tdd-guide success. Green is the implementer's job.

---

## 2. RED signatures (baseline)

Every failure is a missing-testid / missing-PATCH-button / missing-CSS-var. None are unstubbed-fetch or missing-flush.

| # | `it(` | Why it failed |
|---|---|---|
| 1 | full+active nav + pending/login have none | `workbench-nav` `.exists() === false` |
| 2 | claim_only nav, no publish | `workbench-nav` `.exists() === false` |
| 3 | default pane 看板 + v-show panes | `workbench-pane-board` `.exists() === false` |
| 4 | five `task-group-*` | `task-group-task` `.exists() === false` |
| 5 | advanced closed + branch/dir still in DOM | `task-group-advanced` `.exists() === false` |
| 6 | profile row testids + password | `profile-forge` `.exists() === false` |
| 7 | github.com / gitlab.com / gitea empty | `no n-select with data-testid="profile-forge"` |
| 8 | typed base_url not overwritten | `no input/textarea under [data-testid="profile-base-url"]` |
| 9 | poster cancel PATCH + negatives + no claim/logout | `board-detail-cancel` `.exists() === false` (detail **did** open; card click is not the miss) |
| 10 | poster reopen PATCH | `board-detail-cancel` `.exists() === false` |
| 11 | theme tokens | `tokenVar('--motion-fast')` is `''`, expected `'120ms'` |

Absence checks that would have been green on this baseline (pending/login have no nav; non-poster/claim_only/进行中 have no PATCH buttons; no `board-detail-claim` / `logout`) are **folded into** its that first assert a missing positive seam, so they do not run until that seam exists.

---

## 3. CSS variable names (binding for implementer)

Tests read **computed** custom properties on `document.documentElement`, falling back to `document.body`:

```ts
getComputedStyle(document.documentElement | document.body).getPropertyValue(name).trim()
```

| Variable | Assertion |
|---|---|
| `--motion-fast` | exactly `120ms` |
| `--paper` | non-empty |
| `--leaf` | non-empty |

Hex is **not** asserted (Naive `themeOverrides` hex is also not asserted). Expected production values from the rulings, for the rest of the token file:

| Token | CSS variable | Hex (not pinned by tests) |
|---|---|---|
| Paper | `--paper` | `#F3F6F4` |
| Ink | `--ink` | `#1C2420` |
| Leaf | `--leaf` | `#3D6B54` |
| Bark | `--bark` | `#6B746F` |
| Slip | `--slip` | `#FFFEFB` |
| Clay | `--clay` | `#B4532A` |
| motion fast | `--motion-fast` | `120ms` (pinned) |
| motion med | `--motion-med` | `220ms` |
| motion slow | `--motion-slow` | `380ms` |
| motion ease | `--motion-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` |

**Vitest mounts `App.vue`, not `main.ts`.** Importing `theme.css` only from `main.ts` leaves this suite red. Import `theme.css` from `App.vue` (and still from `main.ts` per rulings) so `:root` / `html` / `body` carry the variables after member mount.

Do not pin hex via Naive `themeOverrides`. Do not write screenshot / motion-frame tests.

---

## 4. Additive `data-testid` contract

Do **not** rename or remove any existing testid (ground-truth §2). Put new ids on the Naive (or native) root, same as `task-forge` / `task-title`.

### Nav / panes

| testid | notes |
|---|---|
| `workbench-nav` | member chrome only; **absent** on login + pending |
| `workbench-nav-board` | `.text()` contains `看板` |
| `workbench-nav-publish` | `.text()` contains `发布`; **omit** when `!canApprove` (claim_only) |
| `workbench-nav-keys` | `.text()` contains `钥匙` |
| `workbench-nav-audit` | `.text()` contains `审计` |
| `workbench-pane-board` | default selected pane; `.exists()` on member mount |
| `workbench-pane-publish` | full user: `.exists()` on **default** mount (v-show, not v-if) |
| `workbench-pane-keys` | same |
| `workbench-pane-audit` | same |

Also on default full mount (no click 发布): existing `board` and `task-form` still `.exists()`.

### Form groups (inside existing `task-form`; do not rename `task-*`)

| testid | notes |
|---|---|
| `task-group-task` | 标题 / 描述 / 来源 / imported Issue URL + 导入 |
| `task-group-repo` | Forge / 仓库地址 / 仓库全名 |
| `task-group-advanced` | native `<details>` (preferred) **without** `open`; `.open` falsy. Must keep `task-base-branch` and `task-suggested-dir` mounted so `fillEverything` still finds `input`/`textarea` descendants while closed |
| `task-group-acceptance` | 验收 / 测试命令 / 路径 / 优先级 / 标签 |
| `task-group-credential` | existing credential XOR inputs |

### Credential-profile create row (currently no testids)

Put `profile-forge` on the **`n-select`** (same pattern as `task-forge`). Put the others on the `n-input` / submit control.

| testid | notes |
|---|---|
| `profile-forge` | `n-select`; values `github` / `gitlab` / `gitea` |
| `profile-base-url` | wraps an `input`/`textarea`; empty+github → `https://github.com`; empty+gitlab → `https://gitlab.com`; empty+gitea → `''` (not a public host); non-empty typed value is never overwritten when forge changes |
| `profile-repo` | exists |
| `profile-token` | exists; descendant `input` `type="password"` |
| `profile-submit` | exists |

Prefill helper: suite selects a *different* forge, clears `profile-base-url`, then selects the target, so a default of `gitlab` does not skip the watcher.

### Poster PATCH (detail pane)

Open detail via existing `board-card-${id}` click. `poster` is the brief username; `ME_FULL.username === 'zhang.wei'`.

| testid | label | when |
|---|---|---|
| `board-detail-cancel` | contains `取消` | `canApprove` **and** `me.username === selectedTask.poster` **and** status `待认领` or `已退回` |
| `board-detail-reopen` | contains `重新开放` | same gates **and** status `已退回` only |

Must **not** exist: `board-detail-claim`, `logout`. No Agent-claim / MCP / webhook / logout controls.

Click cancel → exactly one `PATCH /api/v1/tasks/<id>` with `credentials: 'include'`, `Accept: application/json`, `Content-Type: application/json`, body exactly `{ status: '已取消' }`. Click reopen → same headers, body `{ status: '待认领' }`. No `GET /api/v1/tasks/:id`. On 2xx, replace the in-memory brief from the JSON; `board-detail-status` text updates (`已取消` / `待认领`).

Fixtures in this suite:

| id | status | poster |
|---|---|---|
| `kt-2026-0101` | 待认领 | `zhang.wei` |
| `kt-2026-0102` | 已退回 | `zhang.wei` |
| `kt-2026-0103` | 待认领 | `someone.else` |
| `kt-2026-0104` | 进行中 | `zhang.wei` |

Negatives (neither button): non-poster full, claim_only on 待认领, 进行中 even when poster+full.

---

## 5. Harness (copy of existing App.*.test.ts)

- happy-dom, `mount(App, { global: { plugins: [naive] } })`
- fetch map keyed `` `${METHOD} ${url}` ``; unrouted → 500 `{ error: 'unstubbed' }`
- `settle()` = 5× `flushPromises` + `nextTick`
- `vi.waitFor` on `GET /api/v1/me`
- Member GETs all stubbed: `me`, `tasks`, `events`, `stats`, `agent-keys`, `claim-confirmations`, plus `credential-profiles` for full users
- PATCH cases also stub `PATCH /api/v1/tasks/:publicId` → 200 updated brief
- Naive select driven by `NSelect` `vm.$emit('update:value', …)`

Do not re-test audit ISO inputs (`App.audit.test.ts` owns those). Do not require `n-date-picker`.

---

## 6. Out of scope for this suite

- Hex equality of Naive `themeOverrides`
- The 16 motion items as screenshot tests; `prefers-reduced-motion`; font network loads
- vue-router (audit suite already asserts `$router` is undefined)
- Renaming existing testids or pinned Chinese literals (工作台 / 登录 / 账号待批准 / 导入内容 / …)
