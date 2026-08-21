# Finalization — Summary: issue-7

## Delivered
M1 slice for issue #7. Task CRUD + 发布即校验: `tasks` table (integer PK + `public_id` `kt-YYYY-NNNN`, credential XOR CHECK), session HTTP `GET/POST /api/v1/tasks` and `GET/PATCH /api/v1/tasks/:publicId`, post-time `createForgeAdapter(kind).validateToken` with distinct Chinese `422 token_check_failed` vs `502 forge_unreachable`. Brief `credential` is `{ profile_id }` | `{ inline: true }` (token never in the brief). Profile path binds forge+base_url+full_name before decrypt; `repo.base_url` must be http(s) with a host. Publish-time `token 揭示` audit on profile decrypt. Chinese 发布任务 form (create only). First server `workspace:*` deps on `@kaola/shared` and `@kaola/forge-adapters`. `GET /` remains `考拉任务服务占位`. MCP, claim, and board UI unchanged (unimplemented).

## Files Changed
Worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7` on `workflow/issue-7`. Tests authored by tdd-guide; production by implementer; docs by doc-updater; security repair tests by tdd-guide after review FAIL.

## Test Coverage
`apps/server/src/tasks.test.ts` (69) + `apps/web/src/App.form.test.ts` (27) + `packages/shared` credential-union extension. Full `pnpm test`: node `--test` 243 pass / 0 fail, 43 suites; vitest 27 pass / 0 fail.

## Validation
verdict: pass
command: `CI=true pnpm lint && CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm build`
record: `kaola-workflow/issue-7/.cache/final-validation.md`
validated_candidate_hash: `b8a6480294eb5fac131e912839a41004931b08eaa5638a0b46fc537024057d50`
tree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7` after docs landed.
Reuse boundary: the four scripts were re-run exit 0 on this worktree after documentation docking; the hash binds that tree.

## Changed Paths
- `apps/server/src/tasks.ts` (added)
- `apps/server/src/tasks.test.ts` (added)
- `apps/server/src/schema.ts`
- `apps/server/src/db.ts`
- `apps/server/src/app.ts`
- `apps/server/package.json`
- `packages/shared/src/index.ts`
- `packages/shared/src/index.test.ts`
- `apps/web/src/App.vue`
- `apps/web/src/App.form.test.ts` (added)
- `apps/web/package.json`
- `apps/web/vite.config.ts`
- `package.json`
- `pnpm-lock.yaml`
- `docs/DESIGN.md` (§6 credential union + id form)
- `README.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `docs/api.md`
- `docs/architecture.md`

## Mission List
All items `done` in `kaola-workflow/issue-7/mission-list.md`.

## Documentation Docking
DOCKED (`kaola-workflow/issue-7/.cache/doc-docking.md`). README / CHANGELOG / CLAUDE.md snapshot+Commands / docs/api.md / docs/architecture.md transcribed measured HTTP, `tasks` table, credential union, `validateToken` as adapter method. DESIGN.md §6 changed earlier in the run, not at docking.

## Run gaps

## Follow-Up Items
Not filed (gap sweep `sweptClasses: []`; Step 8 asks before creating issues). Carried to the user, not in this set:
- Dev OAuth `reply.redirect('/')` lands on the Fastify placeholder at `PUBLIC_URL` (`:3000`) rather than the Vite SPA (`:5173`). Session is valid on `localhost`; `127.0.0.1:5173` does not share the cookie. Documented in README. Pre-existing #3/#6 surface.
- `registerAuth` passes no OAuth `scope`, so authorize URLs carry literal `scope=undefined`. Pre-existing #3/#6; unmeasured against a real provider.
- Residual: inline-token path may still issue server-side GET to any http(s) host with the caller's own token (RFC1918 not blocked — self-hosted forges). Accepted for #7.
- Board UI remains #8. Claim/reveal-on-claim remains #9.

## Status: ARCHIVED AFTER FINAL GIT GATE

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-7/.cache/dev-auth-probe.md
- kaola-workflow/archive/issue-7/.cache/dispatch-log.jsonl
- kaola-workflow/archive/issue-7/.cache/doc-docking.md
- kaola-workflow/archive/issue-7/.cache/doc-updater.md
- kaola-workflow/archive/issue-7/.cache/final-validation.md
- kaola-workflow/archive/issue-7/.cache/ground-truth.md
- kaola-workflow/archive/issue-7/.cache/impl-sec.md
- kaola-workflow/archive/issue-7/.cache/impl-server.md
- kaola-workflow/archive/issue-7/.cache/impl-shared.md
- kaola-workflow/archive/issue-7/.cache/impl-web.md
- kaola-workflow/archive/issue-7/.cache/origin/selection-record.json
- kaola-workflow/archive/issue-7/.cache/run-gaps.json
- kaola-workflow/archive/issue-7/.cache/sec-rereview.md
- kaola-workflow/archive/issue-7/.cache/sec-review.md
- kaola-workflow/archive/issue-7/.cache/tests-sec-baseline.txt
- kaola-workflow/archive/issue-7/.cache/tests-sec.md
- kaola-workflow/archive/issue-7/.cache/tests-server-baseline.txt
- kaola-workflow/archive/issue-7/.cache/tests-server.md
- kaola-workflow/archive/issue-7/.cache/tests-shared.md
- kaola-workflow/archive/issue-7/.cache/tests-web-baseline.txt
- kaola-workflow/archive/issue-7/.cache/tests-web.md
- kaola-workflow/archive/issue-7/.cache/web-ground-truth.md
- kaola-workflow/archive/issue-7/finalization-summary.md
- kaola-workflow/archive/issue-7/mission-list.md
- kaola-workflow/archive/issue-7/workflow-state.md
