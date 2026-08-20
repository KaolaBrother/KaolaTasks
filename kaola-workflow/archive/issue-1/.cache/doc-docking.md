# Doc docking — issue #1

**Verdict:** DOCKED  
**Date:** 2026-08-20  
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-1`

Docs now match the measured M0 scaffold (package scripts, four workspace members, placeholder HTTP, compose skeleton, CI yaml). Product design in DESIGN.md is still the contract; README/CHANGELOG/CLAUDE Commands no longer say “实现未开始” or `unknown`.

## Docked against

| Fact | Source | Now in |
|------|--------|--------|
| `pnpm install`; `pnpm lint`=`eslint .`; `pnpm typecheck`=`pnpm -r --if-present typecheck`; `pnpm test`=`node --experimental-strip-types --test` three test files; `pnpm build`=`pnpm -r --if-present build` | root `package.json` | README 开发, CLAUDE.md Commands, CHANGELOG Unreleased |
| `packageManager` `pnpm@11.19.0`; `engines.node` `>=22` | root `package.json` | README 快速开始, CLAUDE.md Commands |
| Members `@kaola/web` `@kaola/server` `@kaola/shared` `@kaola/forge-adapters` | member `package.json` + `pnpm-workspace.yaml` | README 项目结构, CHANGELOG |
| Server `start`/`dev`; HOST `0.0.0.0` PORT `3000`; GET `/` `考拉任务服务占位` via `getPlaceholderBody()` | `apps/server/package.json`, `src/index.ts`, `src/app.ts`, `src/placeholder.ts` | README 快速开始, CLAUDE.md Commands, CHANGELOG |
| Web `dev`=`vite`, `preview`=`vite preview`; UI「考拉任务」/「占位界面」 | `apps/web/package.json`, `App.vue` | README |
| `getSharedHealth()` → `kaola-shared-ready`; `getForgeAdaptersHealth()` → `kaola-forge-adapters-ready` | package `src/index.ts` | README, CHANGELOG, CLAUDE Snapshot |
| Compose service `server` port 3000; Dockerfile CMD `pnpm --filter @kaola/server start` | `docker-compose.yml`, `apps/server/Dockerfile` | README 部署, CHANGELOG |
| CI `lint-test` Node 22: frozen-lockfile, lint, test | `.github/workflows/ci.yml` | README 开发, CHANGELOG |
| DESIGN.md version v0.2 | `docs/DESIGN.md` header | CLAUDE.md Documentation Map |
| M0 placeholder only, no public API | tree vs DESIGN §9 | `docs/architecture.md`, `docs/api.md` |

## Explicit non-claims (honest gaps)

- `docker compose up -d --build` failed on this host (Docker daemon down, Colima socket). README says compose needs a daemon and was not verified running.
- No remote Actions run; README says do not treat GitHub CI as green.
- Issue #2 schema not claimed.
- No `.env.example` created (absent; `.gitignore` `.env.*`).
- No root `pnpm dev`.

## Skipped surfaces

`docs/DESIGN.md` (contracts), `docs/README.md`, `docs/conventions.md`, `docs/decisions/`, tests, `.env.example`, `docs/CODEMAPS/`.

Full change list: `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-1/.cache/doc-updater.md`
