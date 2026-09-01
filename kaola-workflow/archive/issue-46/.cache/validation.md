# Repository validation — issue #46

Worktree: issue-46 worktree on `workflow/issue-46`
Acceptance owner: Codex, after independent review of the Grok handoff
Command: `CI=true pnpm lint|typecheck|test|build`
Identifier audit: branch tip, pending diff, range patch, commit metadata, and current Issue body/comments are clean of the private deployment identifiers measured in this run.

| Command | Exit | Notes |
|---------|------|-------|
| `CI=true pnpm lint` | 0 | `eslint .` |
| `CI=true pnpm typecheck` | 0 | 5 of 6 workspace projects |
| `CI=true pnpm test` | 0 | node `--test` ℹ tests 843 / pass 843 / fail 0; vitest 8 files, 131 tests |
| `CI=true pnpm build` | 0 | web vite v7.3.6; pre-existing chunk-size warning only |

Live MCP focused smoke from this Mac:

- Runtime-default TLS, without an extra CA: bridge failed before the application layer (`fetch failed`, exit 1), as expected for the current self-signed leaf.
- Extra certificate scoped only to the local bridge process: initialize reached the application layer and returned `authorization_required` (exit 0).
- This second leg is diagnostic only. The current CN-only self-signed leaf is not a compliant `DEBUG_PRIVATE_CA` chain and does not prove browser or clean-machine trust.

Verdict: required repository gates and the executable MCP boundary smoke are green for this docs/deploy-contract change. No Windows/Linux smoke, browser OAuth, administrator device binding, certificate replacement, renewal, or live-server reload was executed.
