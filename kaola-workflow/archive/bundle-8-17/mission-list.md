# Ship the Chinese task board (#8) and single-origin 31415 hosting (#17)

- item: Measure current web/server/hosting ground truth the two issues must fit — how App.vue and the posting form are structured, the exact GET /api/v1/tasks wire shape, whether events are queryable per task, PORT/PUBLIC_URL/GET / defaults, vite proxy, docker, and the OAuth redirect('/') landing. Facts already known from #7: no board UI; GET / is 考拉任务服务占位; OAuth redirect lands on that placeholder; events table exists with no events HTTP; description_md is stored verbatim (XSS sink becomes live once the board renders it).
  status: done
  dispatched: two code-explorer agents in parallel over worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17; board+API report to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/ground-truth-board.md; hosting report to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/ground-truth-hosting.md
  result: Both reports landed. Board: no board UI; GET list/get exist; no events HTTP; 发布 is not written (synthesize from created_at+poster); App.form.test.ts stubs GET /api/v1/tasks exact URL. Hosting: dual origin 5173/3000; GET / exact placeholder wins over any later static plugin; PUBLIC_URL default 3000; post-login is relative redirect('/'); Fastify 5.12.1; no @fastify/static. Rulings: kaola-workflow/bundle-8-17/.cache/orchestrator-rulings.md

- item: Author the failing board-UI suite for #8 in custody separate from the Vue — six Chinese status columns, list/kanban views, filters by status/tag/forge, task detail timeline of events (发布/认领/心跳/提交/完结), and the invariant that no UI path renders a forge token. Honour the existing vitest + data-testid conventions in apps/web; do not invent event types the server does not already write unless the board needs a read API, in which case pin that API in a server test file instead of guessing.
  status: done
  dispatched: tdd-guide (generalPurpose with tdd-guide custody) over worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17; tests to land at apps/web/src/App.board.test.ts; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/tests-board.md; baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/tests-board-baseline.txt. Follow orchestrator-rulings.md (no events HTTP; synthetic 发布; client-side filters; no vue-router).
  result: Orchestrator re-ran `CI=true pnpm --filter @kaola/web test` → 17 failed (App.board.test.ts) / 27 passed (App.form.test.ts). Handoff: kaola-workflow/bundle-8-17/.cache/tests-board.md. 17 tests; timeline is one synthetic 发布 only.

- item: Author the failing single-port hosting suite for #17 in custody separate from the server — default PORT/PUBLIC_URL 31415, GET / is the SPA when dist or the dev proxy is present and still 考拉任务服务占位 when neither is, OAuth redirect('/') lands on the SPA not the placeholder, vite proxy points at 31415, Docker exposes only 31415. Existing inject tests that pin the placeholder must stay green when dist/proxy are absent.
  status: done
  dispatched: tdd-guide (generalPurpose with tdd-guide custody) over worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17; tests to land at apps/server/src/hosting.test.ts plus root package.json test-script append of that file only; handoff at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/tests-hosting.md; baseline at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/tests-hosting-baseline.txt. Follow orchestrator-rulings.md (buildApp webDist/viteDevTarget seam; do not edit existing placeholder pins).
  result: Orchestrator re-ran `CI=true node --experimental-strip-types --test apps/server/src/hosting.test.ts` → 9 fail / 0 pass. Handoff: kaola-workflow/bundle-8-17/.cache/tests-hosting.md. Seam pinned: buildApp({ sqlitePath?, webDist?, viteDevTarget? }); both set → webDist wins; no existsSync default dist.

- item: Implement the Chinese board UI against the #8 tests — list and kanban, filters, detail timeline — reusing the existing App.vue 工作台 patterns (credentials:'include' + Accept:application/json on every fetch). Sanitize description_md / event details before they become an HTML sink; do not implement claim/heartbeat/submit.
  status: done
  dispatched: implementer over worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17 writing apps/web/src/App.vue; proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/impl-board.md. Do not write test files. Honour tests-board.md data-testid table.
  result: Orchestrator re-ran `CI=true pnpm --filter @kaola/web test` → 44 passed (17 board + 27 form); typecheck exit 0. App.vue only. Proof: kaola-workflow/bundle-8-17/.cache/impl-board.md

- item: Implement single-origin 31415 hosting against the #17 tests — Fastify serves /api and /login as today, production static + SPA fallback from apps/web dist, dev reverse-proxy to internal Vite, root pnpm dev occupying only 31415, docker-compose/Dockerfile leaving 3000. GET / stays the placeholder when there is no dist and no proxy so inject tests do not go red.
  status: done
  dispatched: implementer over worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17; proof to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/impl-hosting.md. Do not write test files. Do not edit App.vue / App.board.test.ts (board tdd still in flight).
  result: Orchestrator re-ran hosting+placeholder → 10 pass / 0 fail. Seam in app.ts; PORT/PUBLIC_URL 31415; @fastify/static ^10.1.3 and @fastify/http-proxy ^11.6.0; root `pnpm dev` via scripts/dev.mjs. Proof: kaola-workflow/bundle-8-17/.cache/impl-hosting.md

- item: Security-review the new HTML sinks and the new static/proxy surface — #7 already flagged description_md / source.issue_url as a live XSS/prompt-injection concern once the board renders them; #17 adds origin unification and static file serving.
  status: done
  dispatched: security-reviewer over worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17; findings to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/sec-review.md
  result: Verdict PASS, findings_blocking 0. Report: kaola-workflow/bundle-8-17/.cache/sec-review.md. Board uses text interpolation; javascript: never becomes href. Static 10.1.3 403s traversal on raw HTTP. SPA does not swallow /api or /login.

- item: Dock documentation against what actually shipped — README, CHANGELOG, CLAUDE.md Commands and snapshot, docs/api.md, docs/architecture.md. Do not change DESIGN.md contracts as a side effect of scaffolding; transcribe real ports, real routes, real commands.
  status: done
  dispatched: doc-updater over worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17; report to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/doc-updater.md
  result: DESIGN.md untouched. README / CHANGELOG / CLAUDE.md Commands+snapshot / docs/api.md / docs/architecture.md transcribed 31415, buildApp webDist/viteDevTarget, board UI, root pnpm dev. Report: kaola-workflow/bundle-8-17/.cache/doc-updater.md

- item: Validate the whole tree in-session — CI=true pnpm lint && typecheck && test && build must all exit 0 in the worktree.
  status: done
  dispatched: self, worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17; record to land at /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/bundle-8-17/.cache/final-validation.md
  result: All four gates green. node --test 252/252; vitest 44/44. Hash `0466f207ddadeb07c09aba7c9fba2a44789b4788976e6264a47aba5fddfff229` binds worktree. Record: kaola-workflow/bundle-8-17/.cache/final-validation.md
