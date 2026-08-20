# Final validation — bundle-4-5

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-4-5`  
Orchestrator re-run after docs docked (markdown + already-landed code/tests).  
`CI=true` (pnpm otherwise prompts in non-TTY).

| Command | Exit | Notes |
|---------|------|--------|
| `pnpm lint` | 0 | `eslint .` |
| `pnpm typecheck` | 0 | 4 of 5 workspace projects (server, web, forge-adapters, shared) |
| `pnpm test` | 0 | tests 149 / suites 26 / pass 149 / fail 0 |
| `pnpm build` | 0 | 4 of 5; web vite 2565 modules, `dist/assets/index-BCXNNTa7.js` 1,452.16 kB gzip 402.89 kB (chunk-size warning only) |

Root `package.json` `"test"` file list (measured):

```
node --experimental-strip-types --test packages/shared/src/index.test.ts packages/forge-adapters/src/index.test.ts packages/forge-adapters/src/validate-token.shared.test.ts apps/server/src/placeholder.test.ts apps/server/src/auth.test.ts apps/server/src/agent-keys.test.ts apps/server/src/vault.test.ts
```

Reuse boundary: this hash binds the worktree **including** documentation docking. The four scripts were re-run exit 0 after docs landed.

verdict: pass
validation_command: CI=true pnpm lint && CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm build
validated_candidate_hash: 7289abf8c213a77c3545b2c49647e7ed3a9817cf65d934da6b271994183f8079
