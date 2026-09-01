# Finalization — Summary: issue-46

## Delivered

Delivered the two-mode server TLS contract and completed the required `DEBUG_PRIVATE_CA` path on an external Ubuntu service. The deployed application uses a loopback-only listener behind Nginx TLS, a controlled private root with a SAN leaf, persistent SQLite, real GitLab and Gitea OAuth, device pending/binding, production MCP, and two real Issue-to-merge-to-completed forge lifecycles. README now documents both Docker Compose and the smoke-tested systemd + Nginx fallback.

Real deployment identifiers, credentials, certificate identity, and operator paths remain outside Git. The server does not contain the root CA private key.

## Files Changed

- `docs/DESIGN.md`, `README.md`, `docs/architecture.md`, `docs/api.md`, and `.env.example`: deployment-neutral TLS and reverse-proxy contracts.
- `docs/smoke-test.md`: redacted external deployment and forge lifecycle evidence.
- `CHANGELOG.md` and `docs/README.md`: documentation docking.
- `eslint.config.js`: exclude nested Workflow worktrees from the root lint gate.

## Test Coverage

Final candidate: lint and typecheck pass; Node 878/878 and Web 131/131 pass; build and diff check pass. PR #51 and PR #52 each passed both GitHub `lint-test` checks. Real macOS UAT covered strict TLS negative, trust install/uninstall/reinstall, system/browser trust, OAuth callbacks, pending/bind, post-bind MCP, restart persistence, Claim/Git/PR or MR/merge/poller/writeback.

Owner acceptance exception: Windows/Linux Claim clients and `STABLE_PUBLIC_CA` live validation were not executed, are not claimed as PASS, and are explicitly deferred without blocking closure.

## Validation

verdict: pass
command: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && git diff --check`
validated_candidate_hash: `cac676cbed10a5eb5d3724d893af08d8c777a9a9cee9985dec13ff97e1d440b0`
The consumer repository has no `test:kaola-workflow:*` chain; `run-chains` returned `chains_config_missing`, so the required consumer receipt is `.cache/final-validation.md`.

## Changed Paths

.env.example
CHANGELOG.md
README.md
docs/DESIGN.md
docs/README.md
docs/api.md
docs/architecture.md
docs/smoke-test.md
eslint.config.js

## Mission List

Ten items, all `done`: live contract measurement; TLS and documentation contract; access boundary; repository validation and redaction; two-mode design; owner-authorized external deployment; browser/OAuth/device/MCP/forge UAT.

## Documentation Docking

DOCKED — see `.cache/doc-updater.md` and `.cache/doc-docking.md`.

## Run gaps

## Follow-Up Items

Windows/Linux Claim-client UAT and `STABLE_PUBLIC_CA` fixed-domain/public-CA/renewal validation are intentionally deferred by the owner. They are future verification opportunities, not defects discovered by this run, and no new issue is required for this closure.

## Status: READY TO ARCHIVE AND SINK

## Sink Findings

post_rebase_tests: skipped

archived_paths:
- kaola-workflow/archive/issue-46/finalization-summary.md
