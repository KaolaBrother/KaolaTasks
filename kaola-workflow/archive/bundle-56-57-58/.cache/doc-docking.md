# doc-docking — bundle #56 #57 #58

status: DOCKED
date: 2026-09-07
worktree: `/workspace/.kw/worktrees/bundle-56-57-58`
source of truth for facts: `scripts/forge-smoke.ts` (`waitForUatFlag`, `resolveSmokeListenHost` / `app.listen`, `waitForForgeHead`, `isAbortTimeout`)
codemaps: skipped — this repo has neither `scripts/codemaps/` nor `docs/CODEMAPS/`

This pass is handbook + CHANGELOG only. No product code, tests, `docs/DESIGN.md`, login, or token-reveal edits. No live Path B/C forge-smoke re-run; #55 results rows remain historical.

## Surfaces

| Surface | Changed? | Reason |
|---------|----------|--------|
| `docs/smoke-test.md` Path C HTTP table row | **yes** | Distinguish browser URL `http://localhost:${UAT_WEB_PORT}` (cookie host) from listen host (default `127.0.0.1`; `UAT_WEB_HOST` non-empty overrides; explicit `0.0.0.0` still possible). Path B always `127.0.0.1` + ephemeral port, ignores `UAT_WEB_HOST`. Compose `127.0.0.1:31415:31415` / production `HOST` unchanged. |
| `docs/smoke-test.md` hold-flag paragraph | **yes** | Nail: missing `go` (`ENOENT`) or trim-empty / whitespace-only keeps waiting; timeout fails; non-empty ≠ expected fails immediately after `redact` + `JSON.stringify`; exact match unlinks and continues. |
| `docs/smoke-test.md` 坑 #56 | **yes** | Was “empty catch swallows wrong `go` / 本轮未改”. Now matches `waitForUatFlag`. |
| `docs/smoke-test.md` 坑 #57 | **yes** | Was “Path C default listen `0.0.0.0` / 不改绑定”. Now loopback default + optional `UAT_WEB_HOST`, URL host vs listen host, compose unrelated. |
| `docs/smoke-test.md` 坑 #58 | **yes** | Was “set `KAOLA_FORGE_TIMEOUT_MS=30000` or the whole smoke fails / 不修脚本”. Now: outer 90s, per-call 10s `DEFAULT_TIMEOUT_MS` unchanged, single `TimeoutError` continues poll; env still unimplemented. |
| `docs/smoke-test.md` 本轮记录 GitLab cell (#55 层 2) | **yes** | Kept historical Issue #24 / MR !20 and Issue #25 / MR !22 links. Named the env as a historical, unimplemented workaround, not a live knob; pointed current behavior at #58 continue-poll. Did not claim this bundle re-ran Path B. |
| `docs/smoke-test.md` 本轮记录 Path C row | no | Historical #55 UAT results; this bundle did not re-execute Path C. |
| `docs/smoke-test.md` Path B HTTP table | no | Already said temporary `127.0.0.1` listener. |
| `CHANGELOG.md` Unreleased | **yes** | Short Chinese harness-only bullets for #56 #57 #58 above existing #55. |
| `README.md` | no | Mentions Path C at a high level; does not name `0.0.0.0` smoke bind, swallowed `go`, or `KAOLA_FORGE_TIMEOUT_MS`. |
| `docs/README.md` | no | Same: Path C one-liner, no those knobs. |
| `docs/architecture.md` | no | `HOST` `0.0.0.0` and compose `127.0.0.1:31415:31415` are production/deploy facts, not the smoke listen. |
| `.env.example` | no | No smoke bind, hold-flag, or `KAOLA_FORGE_TIMEOUT_MS`. |
| `docs/DESIGN.md` | no | Harness-only; no product contract change (explicitly not edited). |
| `docs/api.md` | no | No smoke `UAT_WEB_HOST` / hold-flag / `KAOLA_FORGE_TIMEOUT_MS`. |
| `docs/conventions.md` | no | No matching claims. |
| `docs/workflow-default.md` | no | No matching claims. |
| `docs/runner-carrier.md` | no | No matching claims. |
| `docs/CODEMAPS/*` | skipped | Tooling and tree do not exist; not invented. |

## Not claimed

- This docking did not run `pnpm smoke:forge` or `pnpm smoke:uat`.
- `KAOLA_FORGE_TIMEOUT_MS` is still not implemented in `scripts/forge-smoke.ts`.
- Production adapter `DEFAULT_TIMEOUT_MS = 10_000` in `packages/forge-adapters/src/index.ts` is unchanged and not re-documented as a new default.
