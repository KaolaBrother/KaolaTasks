# impl-shell — issue #18 Eucalyptus Ink workbench

**task:** Implement the Eucalyptus Ink member workbench (four-pane shell, form groups, credential prefills, poster PATCH cancel/reopen, theme tokens, 16-item motion + 768px checklist) against `App.shell.test.ts` plus the four existing App suites. Tests were read-only. No HTTP/MCP/DESIGN contract changes. No commit.

**verification tier:** `tests-green`

**files changed** (worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18` only):

| File | Role |
|------|------|
| `apps/web/src/App.vue` | Single SFC: nav/panes (`v-show`), form groups, native `<details>` advanced, profile testids + forge prefill, poster PATCH, ink-wash shell, ripples, datetime-local beside ISO audit inputs |
| `apps/web/src/theme.css` | Token table, motion, ink-wash, ripples, reduced-motion, 768px, slip cards, kanban tracks |
| `apps/web/src/theme.ts` | Naive `themeOverrides` (Leaf primary, Clay error/warning, Paper/Ink/Slip) + `ensureRootTokens()` so vitest `getComputedStyle` sees `--motion-fast` |
| `apps/web/src/main.ts` | `import './theme.css'` |
| `apps/web/index.html` | Google Fonts `display=swap` (Noto Serif SC, Noto Sans SC, IBM Plex Mono) + existing fallbacks |

Did **not** edit any `*.test.ts`, server, shared, DESIGN.md, or package.json.

---

## before

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18
pnpm --filter @kaola/web test
```

- **exit code:** 1
- **result:** `Tests  11 failed | 75 passed (86)` — all 11 failures in `App.shell.test.ts` (missing nav/panes/groups/profile/PATCH/`--motion-fast`). Existing four suites green.

## after

```
cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18
pnpm --filter @kaola/web test
```

- **exit code:** 0
- **result:** `Tests  86 passed (86)` (75 existing + 11 shell)

```
pnpm --filter @kaola/web typecheck
```

- **exit code:** 0 (`vue-tsc --noEmit -p tsconfig.json`)

Production files have no new lint diagnostics. Test files were not touched.

---

## Motion checklist (issue body 1–16)

1. [x] First enter: wordmark / nav items (`--i * 50ms`) / main fade+6px up
2. [x] Nav Leaf bar slides between items (`--nav-index` translate)
3. [x] Pane switch: **enter** 220ms fade+4px up on the shown pane (`v-show` hides the old pane immediately — see corners)
4. [x] Kanban columns stagger; current column left Leaf bar `height` 0→100%
5. [x] Slip cards: hover `translateY(-3px)`, `:active` `scale(0.98)`, selected left border 0→3px Leaf
6. [x] Detail 280ms slide-in; narrow full width
7. [x] Primary fill left→right (`.primary-fill::before` scaleX) + short press
8. [x] Publish success: new slip Leaf 12% flash; message still `任务已发布：${id}`; failure Clay text
9. [x] Stats `完成数` CSS settle + JS 380ms `--count-now`; **testid text is the final count immediately** (oracles)
10. [x] Audit rows stagger fade (`--i * 50ms`, capped at 8)
11. [x] Trusted-automation on → Leaf glow 20%
12. [x] Confirmation approve slides right / reject left (CSS class; `Element.animate` when present)
13. [x] Empty-state 2.4s 70%↔100% breathe
14. [x] Paper ink-wash: 2–3 Leaf radial-gradients at 4%/6%/8%, cycles 22s and 26s, login/pending/member
15. [x] Ripples on real controls only (pointer `--ripple-x/y`, not blank canvas)
16. [x] `:focus-visible` Leaf 2px ring fades via `box-shadow` transition

`prefers-reduced-motion: reduce`: durations 0 (stylesheet + `ensureRootTokens` matchMedia), wash stopped, ripples off, hover/press transforms none.

---

## Corners cut

1. **Outgoing pane.** Spec asked old pane 220ms fade-out+down. Compatibility requires `v-show` (not `v-if`) so existing testids stay mounted; `display: none` cannot fade. Incoming pane still animates.
2. **Confirmation leave vs oracles.** Settings tests click 批准/拒绝 then `settle()` and expect the POST + empty list. Cannot delay the refetch 220ms. Slide is a CSS class (and WAAPI when `element.animate` exists). happy-dom has no `animate`; guarded so the POST still fires.
3. **Stats digits vs oracles.** `App.audit.test.ts` reads `stats-completed-count` after `settle()` (no 380ms wait). The testid text is `stats.completed_count` immediately. Count-up is CSS settle + JS `--count-now` over 380ms, not intermediate digits in the oracle node.
4. **Token visibility in vitest.** happy-dom `getComputedStyle` did not see Vite-imported `:root` vars. `ensureRootTokens()` writes the token table onto `document.documentElement.style` (and a `<style id="kaola-eucalyptus-tokens">`) at App setup. Inline `--motion-*` wins over the reduced-motion stylesheet rule; `matchMedia('(prefers-reduced-motion: reduce)')` zeros those four at apply-time. Live OS toggle without reload is not wired.
5. **Audit datetime-local.** Native picker sits **beside** `audit-filter-from` / `to` (does not steal the testid). It writes ISO only on user `change`; typed ISO strings from tests are not reformatted.
6. **Kanban “current” column.** Leaf grow bar uses selected task status, else the status filter, else `待认领`.
7. **Primary fill** is a `::before` overlay on `.primary-fill` buttons; Naive’s own paint may still show under it depending on overflow.
8. **No second SFC / no vue-router / no extra accent.** Palette is Paper/Ink/Leaf/Bark/Slip/Clay only; success/info = Leaf, warning/error = Clay.
9. **Initial forge prefill (orchestrator follow-up).** Default `gitlab` + empty base_url now applies `https://gitlab.com` at setup (same helper as the watchers), so the 凭证档案/发布 forms match 「选 gitlab 时空则预填」 without waiting for a Forge change.
