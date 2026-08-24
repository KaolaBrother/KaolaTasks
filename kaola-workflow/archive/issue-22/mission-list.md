# MCP 平时无仓库钥匙；claim 成功才拿到该任务 token，换任务换 token

- item: Measure the current REST/MCP claim envelope, reveal channels, MCP examples, and DESIGN/README/api against issue #22 body (comments say the body is the contract; first comment is void). Base is `2ce443a` (adopted smoke-test docs).
  status: done
  dispatched: code-explorer → kaola-workflow/issue-22/.cache/ground-truth.md (first draft mixed foreign paths; orchestrator re-measured the worktree)
  result: Envelope, clone four keys, per-task decrypt, list/brief/202 hygiene already in code. Missing: two-task different-token test; README URL-only MCP example + user-model sentences in README/DESIGN §7/api.md. Optional mcp.json writer not required. See kaola-workflow/issue-22/.cache/ground-truth.md

- item: Author the missing #22 acceptance test — same Agent claims two different publicIds and gets each task’s own token (inline vs profile fixtures already in claim.test.ts); do not rename clone keys or change CLONE_TOKEN_USAGE.
  status: done
  dispatched: tdd-guide → apps/server/src/claim.test.ts and apps/server/src/mcp.test.ts; note at kaola-workflow/issue-22/.cache/tests-22.md
  result: REST `claiming a second publicId returns that task's token, not the first task's` and MCP `claim_task on a second task_id returns that task's token, not the first task's`. Pin on current code (pass). Orchestrator re-ran `node --experimental-strip-types --test apps/server/src/claim.test.ts apps/server/src/mcp.test.ts` → 52 pass / 0 fail.

- item: Close any code gaps the tests expose without changing the two HTTP reveal channels or renaming clone keys.
  status: done
  dispatched: skipped implementer — tests passed on baseline; no production edit
  result: No code gap. Decrypt is already per claimed row. Reveal channels unchanged.

- item: Dock README / DESIGN §7 / api.md (and repo MCP examples) to the two-key model: MCP Authorization is Kaola Agent Key only; forge token never enters mcp.json; switch task switch token.
  status: done
  dispatched: doc-updater → README.md, docs/DESIGN.md §7, docs/api.md; note at kaola-workflow/issue-22/.cache/doc-updater.md. Orchestrator added CHANGELOG Unreleased `#22`. Did not edit docs/smoke-test.md.
  result: URL-only mcpServers snippet; KAOLA_AGENT_KEY env inject; user-model sentences in README, DESIGN §7, api.md claim_task row; CHANGELOG `#22`.
