# Restyle @kaola/web into the Eucalyptus Ink workbench without changing HTTP, MCP, DESIGN, or existing data-testid oracles

- item: Map the current member workbench ground truth — App.vue views/gates/testids, existing vitest (board/form/audit/settings), PATCH task UI absence, CSS/themeOverrides, claim_only vs full, 768px behavior. Comments on #18 were folded into the body (more motion, professional grouping, hard narrow-screen, CSS ink-wash + ripples); body is the spec. Stay off implementing.
  status: done
  dispatched: code-explorer (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-18/.cache/ground-truth.md
  result: kaola-workflow/issue-18/.cache/ground-truth.md. HEAD be2d963. App.vue 1177 lines, no CSS, no theme-overrides, no PATCH UI. Existing suites 18+33+16+8 it(. Full member mount asserts board AND task-form exist together. Audit filters are n-input ISO strings. poster is username.

- item: Pin orchestrator rulings for #18 from that ground truth plus the issue body — tokens, shell (four panes, no vue-router), what the new suite may pin vs visual-only motion, PATCH cancel/reopen semantics, form groups + forge base_url prefills, file split (tokens/motion only under apps/web/src), fonts, reduced-motion. Stay off implementing.
  status: done
  dispatched: self; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-18/.cache/orchestrator-rulings.md
  result: kaola-workflow/issue-18/.cache/orchestrator-rulings.md. Panes v-show so existing testids stay mounted; new App.shell.test.ts; PATCH by username+canApprove; audit ISO inputs keep testids; theme.css + optional theme.ts.

- item: Author the failing suite for the new behavioral surface — workbench shell panes, form four-group + advanced collapse, credential base_url prefills, poster PATCH cancel/reopen, date-time audit filter (client-side), claim_only nav hiding 发布/凭证. Do not weaken or retarget existing data-testid oracles. Do not implement production.
  status: done
  dispatched: tdd-guide (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18 against rulings at kaola-workflow/issue-18/.cache/orchestrator-rulings.md; tests to land at apps/web/src/App.shell.test.ts; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-18/.cache/tests-shell.md; RED baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-18/.cache/tests-shell-baseline.txt
  result: apps/web/src/App.shell.test.ts 11 it( all RED on be2d963; existing 75 still green. CSS vars --motion-fast/--paper/--leaf; import theme.css from App.vue because vitest mounts App not main.ts. Handoff kaola-workflow/issue-18/.cache/tests-shell.md

- item: Implement the Eucalyptus Ink workbench against that suite and the 16-item motion/narrow-screen checklist. Do not touch test files. Do not change HTTP/MCP/DESIGN contracts or Chinese copy literals the existing tests pin.
  status: done
  dispatched: implementer (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18 against App.shell.test.ts plus existing App.*.test.ts; green proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-18/.cache/impl-shell.md
  result: kaola-workflow/issue-18/.cache/impl-shell.md. tests-green: web vitest 86/86, vue-tsc 0. theme.css + theme.ts + App.vue shell. Orchestrator added setup-time gitlab.com prefill. Motion 1–16 ticked with documented v-show/count-up corners.

- item: Security-review the new poster PATCH UI and any new client fetches — no forge token in session responses or UI, no fake Agent-claim buttons, approve-user still id-only.
  status: done
  dispatched: security-reviewer (reasoning tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18 production diff; output to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-18/.cache/sec-review.md
  result: verdict pass, findings_blocking 0. PATCH session-only, asCredential allow-list, no claim/logout. Deferred notes only (encodeURIComponent on publicId, Google Fonts origin). Evidence kaola-workflow/issue-18/.cache/sec-review.md

- item: Dock README/CHANGELOG/CLAUDE.md snapshot and docs that describe the workbench layout to the implemented UI. Transcribe verified structure; do not change DESIGN.md contracts.
  status: done
  dispatched: doc-updater (standard tier) over the worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18; proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-18/.cache/doc-updater.md
  result: kaola-workflow/issue-18/.cache/doc-updater.md. CHANGELOG/README/CLAUDE.md/docs/architecture.md/docs/api.md. DESIGN.md untouched.

- item: Validate the worktree in-session: CI=true pnpm lint && typecheck && test && build all exit 0, including pnpm --filter @kaola/web test.
  status: done
  dispatched: self, worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18
  result: All four gates exit 0. node --test 502 pass / 0 fail (110 suites); vitest 86 pass. Record: kaola-workflow/issue-18/.cache/final-validation.md hash eab64310c149999b5ab7fefea944699bf7c4ccd81bbe15750d86da975023717e
