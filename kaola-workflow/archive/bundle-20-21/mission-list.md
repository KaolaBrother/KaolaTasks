# Deliver forge-structured claim clone recipes (#20) and a read-only imported Issue publish card (#21)

- item: Measure the current REST/MCP claim clone envelope (`CLONE_TOKEN_USAGE`, two keys) and DESIGN §7/§9 so #20's new `remote_url` + `extra_header` rest on the tree, not the issue text; comments on #20 are empty so the body is current. Re-measure after fast-forwarding the worktree to `0c2d15d` (`d5fe1b8` GitLab OAuth + publish field order is now on the branch).
  status: done
  dispatched: code-explorer (fresh, not resumed) → kaola-workflow/bundle-20-21/.cache/ground-truth-20.md against worktree at `0c2d15d`
  result: kaola-workflow/bundle-20-21/.cache/ground-truth-20.md — clone is inline in `claimTask`; REST and MCP share one builder.

- item: Measure the publish form's imported path (`task-title`/`task-description` still editable, `task-group-acceptance` still shown) and DESIGN 发布向导 so #21's read-only Issue card and omitted Kaola extra fields rest on the tree; comments on #21 are empty so the body is current. Baseline now includes `d5fe1b8` form order credential → repo → issue; that reorder is committed, not WIP.
  status: done
  dispatched: code-explorer (fresh, not resumed) → kaola-workflow/bundle-20-21/.cache/ground-truth-21.md against worktree at `0c2d15d`
  result: kaola-workflow/bundle-20-21/.cache/ground-truth-21.md — form is credential→repo→task; extras always POSTed until #21.

- item: Write DESIGN.md §7/§9 and docs/api.md/README claim clone contract for the four-key `clone` object with the three-forge extra_header table, before any production code for #20.
  status: done
  dispatched: doc-updater → worktree docs/DESIGN.md §7/§9, docs/api.md, README.md
  result: four-key clone + extra_header table in DESIGN/api/README. Note kaola-workflow/bundle-20-21/.cache/docs-contract.md

- item: Write DESIGN.md 发布向导 so imported Issue is a read-only copy and Kaola extra fields are no longer collected, before any production code for #21; Task Brief keys stay.
  status: done
  dispatched: same doc-updater as the #20 DESIGN item
  result: DESIGN.md §6 `### 发布向导`; §7 从档案列 Issue no longer says 预填标题/正文

- item: Author failing tests for claim 201 / MCP claim_task four-key clone (token-free remote_url, forge extra_header table, brief repo keys unchanged, no new MCP tools).
  status: done
  dispatched: tdd-guide → worktree claim.test.ts, mcp.test.ts, claim-confirm.test.ts
  result: RED 18 fail / 46 pass. Report kaola-workflow/bundle-20-21/.cache/tests-20.md

- item: Author failing tests for the publish pane: imported path has no task-title/task-description inputs, a read-only Issue card, and neither source type shows acceptance/test/path/priority/tag fields; POST omits those keys.
  status: done
  dispatched: tdd-guide → worktree App.form.test.ts, App.shell.test.ts
  result: RED 8 fail / 87 pass. Report kaola-workflow/bundle-20-21/.cache/tests-21.md

- item: Implement the four-key clone envelope on REST claim and MCP claim_task so the #20 tests pass; do not execute git on the server and do not put token in remote_url or extra_header.value_pattern.
  status: done
  dispatched: implementer → worktree apps/server/src/claim.ts
  result: four-key clone in claimTask; orchestrator 64/64. Note kaola-workflow/bundle-20-21/.cache/impl-20.md. Security review pass: .cache/sec-review-20.md

- item: Implement the read-only imported Issue card and drop Kaola extra form fields so the #21 tests pass; keep POST /tasks and /tasks/import shapes; native title/description stay editable.
  status: done
  dispatched: implementer → worktree apps/web/src/App.vue
  result: import card + omitted extras; orchestrator vitest 95/95. Note kaola-workflow/bundle-20-21/.cache/impl-21.md

- item: Dock README/CHANGELOG/docs against measured implementation, then finalize the all-or-nothing bundle.
  status: done
  dispatched: doc-updater + security-reviewer + code-reviewer + build-error-resolver (auth PKCE types) + self `pnpm lint && pnpm typecheck && pnpm test`
  result: DOCKED `.cache/doc-docking.md`; sec-review pass; code-review pass; typecheck green; 545+95 tests pass; proceeding to finalize transaction
