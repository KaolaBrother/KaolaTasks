# tests-22 — issue #22 two-task token pin

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-22`  
Baseline: `2ce443ae6d4b5d17c9de26e827fdc919955d598e` (`2ce443a`)

## What was added (tests only)

**REST** `apps/server/src/claim.test.ts:911`  
`claiming a second publicId returns that task's token, not the first task's`

Same Agent Key claims two different `publicId`s in one case: first task inline (`INLINE_TOKEN`), second task profile (`PROFILE_TOKEN` via existing `postProfile`). Asserts `assertClaim201` for each envelope (clone four keys unchanged, `CLONE_TOKEN_USAGE` sentence unchanged), `task.id` matches the claimed id, and the second `token` is `PROFILE_TOKEN` — not equal to the first.

**MCP twin** `apps/server/src/mcp.test.ts:1100`  
`claim_task on a second task_id returns that task's token, not the first task's`

One cheap case reusing `createTaskOk` / `readyMcp` / `assertClaimEnvelope`. Two inline fixtures (`INLINE_TOKEN` then `PROFILE_TOKEN` as inline) because this file has no `postProfile`. Same pin: second `task_id` returns that task’s token.

Did not duplicate list/brief/session GET / `202` no-token cases. Did not weaken existing assertions. No production edits.

## Commands (from worktree)

Worktree had no `node_modules`; `pnpm install` once so `@kaola/shared` resolved. Then:

```
node --experimental-strip-types --test apps/server/src/claim.test.ts
node --experimental-strip-types --test apps/server/src/mcp.test.ts
```

## Result on this baseline

**PASS** (expected pin: production already decrypts per claimed row).

- claim.test.ts: 31 pass, 0 fail (`duration_ms` ~2286)
- mcp.test.ts: 21 pass, 0 fail (`duration_ms` ~518)

New cases:

| test | file:line | result |
|------|-----------|--------|
| claiming a second publicId returns that task's token, not the first task's | claim.test.ts:911 | pass (~6.4ms) |
| claim_task on a second task_id returns that task's token, not the first task's | mcp.test.ts:1100 | pass (~9.3ms) |
