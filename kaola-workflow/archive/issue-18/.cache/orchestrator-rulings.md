# Orchestrator rulings — issue #18 Eucalyptus Ink workbench

Evidence: `kaola-workflow/issue-18/.cache/ground-truth.md` (HEAD `be2d963`), GitHub issue #18 body (comments were folded into that body; they do not contradict it).

These rulings are binding for tdd-guide and implementer. They exist because existing vitest oracles must stay green while the page becomes a shell.

## 1. Do not touch

- No vue-router. `App.audit.test.ts` asserts `$router` is undefined.
- No React, no second UI kit, no animation library, no canvas/WebGL particles.
- No HTTP / MCP / state-machine / `docs/DESIGN.md` contract changes. PATCH is **called**, not redesigned.
- Do not rename or remove any existing `data-testid` listed in ground-truth §2.
- Do not edit `App.board.test.ts` / `App.form.test.ts` / `App.audit.test.ts` / `App.settings.test.ts`.
- Do not change pinned Chinese literals in ground-truth §3 (especially `导入内容`, `导入`, `暂无任务。`, `工作台`, `登录`, `账号待批准`, board chrome, audit titles).
- No Agent claim / MCP / webhook / logout buttons. No `GET /users` search widget.
- No second accent color. Success/current/hover = Leaf alpha, errors/pending = Clay.

## 2. Compatibility: panes must not unmount existing oracles

Existing suites query these on **default member mount**, with `exists()` not `isVisible()`:

| Suite | Must exist on mount (full + active) |
|-------|-------------------------------------|
| board | `board`, and for full also `task-form` (`App.board.test.ts:391–394`) |
| form | `task-form`, `task-submit`, every `task-*` `fillEverything` touches including `task-base-branch` / `task-suggested-dir` |
| audit | `audit-section`, `stats-section`, `audit-filter-from` / `to` as a node that still has an `input`/`textarea` child |
| settings | `trusted-automation-toggle` (`NSwitch`), `claim-confirmation-list` |

**Ruling:** member pane switching uses `v-show` (or CSS that leaves nodes in the document), **not** `v-if`, for 看板 / 发布 / 钥匙 / 审计 content that already carries those testids. `v-if` is still correct for **gates** that already exist (`canApprove`, `canManageKeys`, imported-only fields).

Default selected pane is **看板**. Full user's 发布/钥匙/审计 stay in the DOM (hidden) so the four suites keep passing without navigating.

`claim_only`: 发布 nav item and `task-form` stay absent (`canApprove` false). 钥匙 nav remains (Agent Key / 受信自动化 / 待确认认领). 凭证档案 and 批准 GitHub 用户 stay `canApprove`.

Member view must still contain the substring `工作台` (board + form visibility tests). Keep it on the member chrome (header or landmark), even if the old `n-card title="工作台"` goes away.

## 3. Shell

Local state, four panes, no router:

1. 看板 — existing board (list/kanban, filters, detail). New: poster PATCH buttons in detail.
2. 发布 — existing `task-form` grouped (full only).
3. 钥匙 — 受信自动化, 待确认认领, Agent Key; plus 凭证档案 and 批准 GitHub 用户 when `canApprove`.
4. 审计 — existing audit + stats.

New testids (additive only):

- `workbench-nav`
- `workbench-nav-board` / `workbench-nav-publish` / `workbench-nav-keys` / `workbench-nav-audit`
- `workbench-pane-board` / `workbench-pane-publish` / `workbench-pane-keys` / `workbench-pane-audit`

Nav labels in Chinese: 看板 / 发布 / 钥匙 / 审计. `workbench-nav-publish` is omitted when `!canApprove`.

Wide layout: left nav + main. Narrow (`max-width: 768px`): nav becomes top horizontal scroll; kanban columns scroll horizontally (drop `min-width: 120px` squeezing six columns); filters/profile/audit controls stack; detail full-width; primary buttons min-height 44px and full width.

Login + pending keep titles **登录** / **账号待批准** and the same token set (wordmark 考拉任务, Leaf primary buttons, Paper background).

## 4. Tokens, files, fonts

Exact hex via CSS variables **and** `n-config-provider` `:theme-overrides`:

| Token | Hex |
|-------|-----|
| Paper | `#F3F6F4` |
| Ink | `#1C2420` |
| Leaf | `#3D6B54` |
| Bark | `#6B746F` |
| Slip | `#FFFEFB` |
| Clay | `#B4532A` |

Motion CSS variables (names exact):

- `--motion-fast: 120ms`
- `--motion-med: 220ms`
- `--motion-slow: 380ms`
- `--motion-ease: cubic-bezier(0.22, 1, 0.36, 1)`
- background drift loop ≥ 18s, own variable, not the three durations
- `prefers-reduced-motion: reduce` → durations 0, background stopped, ripples off

File split (only these extra production files under `apps/web/src`, plus `App.vue` / `main.ts` / `index.html` edits):

- `apps/web/src/theme.css` — tokens, ink-wash, ripples, reduced-motion, 768px shell, kanban slip cards
- Optional `apps/web/src/theme.ts` — Naive `theme-overrides` object (so App.vue stays readable)

No new Vue SFCs, no `components/` router layer. Import `theme.css` from `main.ts`.

Fonts: wordmark 「考拉任务」 `Noto Serif SC`; body `PingFang SC, "Noto Sans SC", ui-sans-serif, sans-serif`; public ids `ui-monospace, "IBM Plex Mono", monospace`. Google Fonts `<link>` with `display=swap` is allowed; system fallbacks are the runtime source of truth. Tests must not depend on network fonts.

## 5. Form grouping

Inside existing `task-form`, wrap with **new** testids (do not rename `task-*`):

- `task-group-task` — 标题, 描述, 来源; imported-only Issue URL + 导入 button stay here (导入 may stay at the foot of this group; do not drop `task-import`)
- `task-group-repo` — Forge, 仓库地址, 仓库全名
- `task-group-advanced` — `<details>` (or Naive collapse that **keeps descendants mounted**) default **closed**, containing `task-base-branch` and `task-suggested-dir`. `fillEverything` must still find those inputs without opening it.
- `task-group-acceptance` — 验收标准, 测试命令, 允许路径, 禁止路径, 优先级, 标签. Keep placeholders 「每行一条」 / 「每行一个」.
- `task-group-credential` — existing credential mode XOR inputs

## 6. Credential-profile base_url prefills

The 凭证档案 create row (currently no testids) gets additive testids:

- `profile-forge`
- `profile-base-url`
- `profile-repo`
- `profile-token` (keep `type=password`)
- `profile-submit`

When Forge is `github` and base_url is empty, set `https://github.com`. When Forge is `gitlab` and base_url is empty, set `https://gitlab.com`. `gitea`: do **not** invent a public host; leave empty. If the user has typed a non-empty base_url, changing Forge must **not** overwrite it.

Task-form `task-forge` / `task-base-url` may use the same helper; existing form tests always `setField` base_url after selecting forge, so they stay green.

## 7. Audit time filters

Do **not** change `App.audit.test.ts`. `setField('audit-filter-from'|'audit-filter-to', '2026-08-21T10:00:00Z')` must keep working: those testids must still wrap an `input` or `textarea` whose `setValue` updates the same string refs used for lexicographic `created_at` compare.

Visual date/time chrome (Naive date-picker or `datetime-local`) may sit beside or around that, but must not steal the testid or break ISO string assignment. Filter logic stays client-side; `GET /api/v1/events` stays query-free.

## 8. Poster PATCH buttons (new behavior)

Session `PATCH /api/v1/tasks/:publicId` body `{ status }`. Auth is already server-side (`active`+`full`+poster). Client shows buttons when **all** of:

- `canApprove` (same as `status === 'active' && permission_level === 'full'`)
- `me.username === selectedTask.poster` (`poster` is username; `Me.id` is not on the brief)
- status is `待认领` or `已退回`

Buttons (new testids, Chinese labels):

| testid | label | when | body |
|--------|-------|------|------|
| `board-detail-cancel` | 取消 | 待认领 or 已退回 | `{ status: '已取消' }` |
| `board-detail-reopen` | 重新开放 | 已退回 only | `{ status: '待认领' }` |

Absent for claim_only, non-poster, and other statuses (including 进行中 / 已取消 / 待验收 / 已完成). TASK_OPEN in board fixtures is 待认领 + poster `zhang.wei` = `ME_FULL.username`, so the cancel button **will** appear in existing full-user detail tests — labels must stay Chinese and must not include `Kanban`/`Timeline`/`Backlog`.

On 2xx: update the matching task in the in-memory list (and selected detail) from the JSON brief; do not invent a `GET /api/v1/tasks/:id`. Credentials `'include'`, `Accept` + JSON `Content-Type` like other mutations. On 4xx/5xx show Chinese error on the detail pane (new `board-detail-action-message` is allowed); never display a forge token.

Do not send PATCH for Agent claim transitions.

## 9. Approve-user widget

Keep numeric-id + 批准. Clarify the label is a **数字 id**. No user search, no `GET /users`. No new testid required unless tdd-guide wants one; existing suites do not cover this widget. Move it into 钥匙.

## 10. What the new suite may pin vs visual-only

**tdd-guide authors one new file** `apps/web/src/App.shell.test.ts` (vitest `include` already `src/**/*.test.ts`; do **not** edit `package.json` unless a run proves the include misses it). Do not modify the four existing test files.

Pin (behavioral):

- Nav testids + claim_only omits 发布 nav; full has all four
- Form group testids exist; advanced default closed **and** branch/dir inputs still in the document
- Profile forge empty→prefill github.com / gitlab.com; gitea stays empty; non-empty not overwritten
- PATCH cancel/reopen visibility matrix + exact method/URL/body/credentials
- No new Agent-claim / logout / user-search controls (`[data-testid="board-detail-claim"]` etc. must not exist)
- `theme.css` is imported (document or computed `--motion-fast` / Paper/Leaf variables on `:root` or `html`/`body`) so a restyle that forgets the token file fails

Do **not** pin:

- Hex equality of every Naive override (happy-dom + Naive JS theme is a poor oracle)
- The 16 motion items as screenshot tests. Implementer owns that checklist in CSS/Vue transitions. Reduced-motion is CSS `@media` in `theme.css`.
- Font network loads

## 11. Motion checklist (implementer, not tdd-guide)

Issue body items 1–16: enter stagger, nav Leaf bar, pane transition, kanban column Leaf grow, slip-card hover/press/selected, detail drawer, primary fill, publish flash, stats count-up, audit stagger, trusted-automation glow, confirmation row slide, empty-state breathe, Paper ink-wash (2–3 Leaf blurs 4–8% opacity, cycle ≥ 18s, CSS only), click ripples on real controls, focus ring fade. `prefers-reduced-motion: reduce` zeroes all of it.

Ripples only on real controls (the interaction table in the issue). Primary buttons: Leaf fill left→right.

Kanban cards are slips (title + mono public id + priority dot), not default `n-card`. Columns are ink tracks; current column left Leaf bar grows 0→100% height.

## 12. Evidence for "comments override body"

The four comments restated motion-more, professional grouping + PATCH, hard 768px, and CSS ink-wash+ripples. The current issue body already contains those. No leftover contradiction. Body is the spec.
