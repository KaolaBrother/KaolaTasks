# doc-updater — bundle-56-57-58

Checked files (transcribed from worktree `scripts/forge-smoke.ts` and live Path B logs; no invented API fields):

- `docs/smoke-test.md` — FIXED: Path C HTTP listen vs localhost URL; hold-flag empty/missing wait + immediate wrong-content fail; 坑 #56/#57/#58 rewritten; #55 GitLab cell keeps historical Issue/MR and names `KAOLA_FORGE_TIMEOUT_MS` as unimplemented; added #56–#58 Path B live row (GitLab Issue #28 / MR !24, Gitea Issue #42 / PR #43).
- `CHANGELOG.md` — FIXED: Unreleased harness-only bullets for #56 #57 #58.
- `docs/DESIGN.md` — NO IMPACT: harness-only; no product contract change.
- `docs/api.md` — NO IMPACT: no new routes or envelopes.
- `docs/architecture.md` — NO IMPACT: production `HOST` / compose bind unchanged.
- `README.md` / `docs/README.md` — NO IMPACT: Path C one-liners already present; no `0.0.0.0` / swallowed-flag / `KAOLA_FORGE_TIMEOUT_MS` knobs.
- `docs/conventions.md`, `docs/workflow-default.md`, `docs/runner-carrier.md`, `.env.example`, MCP examples — NO IMPACT.
