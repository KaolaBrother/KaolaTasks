# Stand up the M0 pnpm monorepo scaffold so install, lint, typecheck, test, build, and a server placeholder all run

- item: Measure the current tree against DESIGN.md §12 and issue #1 so the scaffold matches what is here, not a stale layout
  status: done
  dispatched: self
  result: Worktree HEAD 252877d356f7b7408ee3192d86c5db3653da07b2 is docs-only (README/CHANGELOG/CLAUDE/docs, no package.json). Target members are apps/web (Vue 3 + Vite + Naive UI), apps/server (Node 22 + Fastify + Drizzle/SQLite), packages/shared, packages/forge-adapters. Host Node v24.14.0; pnpm not on PATH (corepack 0.34.6 is); Docker CLI present, Colima socket missing so compose cannot boot here. Do not implement issue #2 schema.

- item: Author the failing acceptance suite that imports shipped server/shared/forge-adapters entry points and asserts real placeholder values; no production files
  status: done
  dispatched: tdd-guide in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-1; report to kaola-workflow/issue-1/.cache/tdd-guide-report.md; tests land under that worktree
  result: RED on 252877d356f7b7408ee3192d86c5db3653da07b2 — 3 fail / 0 pass (ERR_MODULE_NOT_FOUND). Tests at packages/shared/src/index.test.ts, packages/forge-adapters/src/index.test.ts, apps/server/src/placeholder.test.ts. Contract: getSharedHealth()→kaola-shared-ready; getForgeAdaptersHealth()→kaola-forge-adapters-ready; getPlaceholderBody()→考拉任务服务占位. Report kaola-workflow/issue-1/.cache/tdd-guide-report.md

- item: Confirm current Node-22-compatible versions for Vue 3, Vite, Naive UI, Fastify, Drizzle, SQLite driver, TypeScript, ESLint, Vitest/test runner
  status: done
  dispatched: knowledge-lookup; report to kaola-workflow/issue-1/.cache/stack-versions.md
  result: knowledge-lookup cancelled after hung registry probes; parent wrote kaola-workflow/issue-1/.cache/stack-versions.md (vue 3.5.41, naive-ui 2.45.x, fastify 5.12 / Node 20+, drizzle sqlite drivers including better-sqlite3; CI Node 22; pnpm via packageManager)

- item: Implement the pnpm workspaces monorepo (four members, root scripts, CI lint+test, docker-compose skeleton, server placeholder HTTP body) until the suite and scripts pass
  status: done
  dispatched: self in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-1 after implementer stalled on npm-view with no files landed; report to kaola-workflow/issue-1/.cache/implementer-report.md; do not write tests
  result: Worktree scaffold green. pnpm install/lint/typecheck/test/build exit 0; 3 tests pass; GET / body 考拉任务服务占位 twice; docker daemon down captured. Report kaola-workflow/issue-1/.cache/implementer-report.md


- item: Dock README/CHANGELOG/CLAUDE.md commands against measured output; no invented keys
  status: done
  dispatched: doc-updater in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-1; report to kaola-workflow/issue-1/.cache/doc-updater.md
  result: DOCKED. README/CHANGELOG/CLAUDE.md/docs/api.md/docs/architecture.md transcribed measured scripts. Reports in kaola-workflow/issue-1/.cache/doc-updater.md and doc-docking.md


