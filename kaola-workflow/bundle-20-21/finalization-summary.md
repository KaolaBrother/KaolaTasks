# Finalization — Summary: bundle-20-21

## Delivered

- **#20** Successful REST claim `201` and MCP `claim_task` return a four-key `clone` object (`suggested_dir`, `token_usage`, `remote_url`, `extra_header`). `remote_url` is slash-stripped `repo.base_url` + `/` + `full_name` + `.git` with no token. `extra_header` is github/gitlab `Authorization: Bearer ${token}` and gitea `Authorization: token ${token}` (literal `${token}`). Token still only on top-level `token`. No new MCP tools; server does not run git.
- **#21** Publish pane no longer collects 验收标准 / 测试命令 / 路径 / 优先级 / 标签. Imported source shows a read-only `task-import-card` only after import `200`. Native still has editable title/description. `POST /api/v1/tasks` omits those extra keys (server defaults apply). Import POST shape unchanged.
- Typecheck: local `OAuth2Decorator` now accepts optional `reply` so the existing PKCE 2-arg token exchange typechecks (`d5fe1b8` runtime kept).

## Files Changed

- `apps/server/src/claim.ts` — four-key clone on `claimTask`
- `apps/server/src/claim.test.ts`, `mcp.test.ts`, `claim-confirm.test.ts` — `assertCloneRecipe`
- `apps/web/src/App.vue` — import card, drop extras, omit POST keys
- `apps/web/src/App.form.test.ts`, `App.shell.test.ts`
- `apps/server/src/auth.ts` — `OAuth2Decorator` 2-arg type
- `docs/DESIGN.md`, `docs/api.md`, `docs/smoke-test.md`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`

## Test Coverage

- REST/MCP/claim-confirm: 64 tests in those three files, including github/gitlab/gitea extra_header and trailing-slash `remote_url`
- Web: 95 vitest tests, including read-only import card testids and omitted extra POST keys

## Validation

verdict: pass (re-recorded after docking; see `.cache/final-validation.md`)
command: `pnpm lint && pnpm typecheck && pnpm test`
node `--test`: ℹ tests 545 / pass 545 / fail 0
vitest: Test Files 5 passed; Tests 95 passed

## Changed Paths

See git diff on `workflow/bundle-20-21` vs `0c2d15d`: claim clone envelope, publish UI, docs, auth PKCE types, workflow cache.

## Mission List

All items done except this finalize item, closed at archive.

## Documentation Docking

`.cache/doc-docking.md` verdict: DOCKED. DESIGN §7/§9, api.md claim clone, README 接单, 发布向导, CHANGELOG, CLAUDE.md snapshot, smoke-test clone steps.

## Run gaps

## Follow-Up Items

None. Review nits (userinfo in stored `base_url` flowing into `remote_url`; card href vs POST issue URL) follow the issue formula / tests; not filed.

## Status: READY FOR FINAL GIT GATE
