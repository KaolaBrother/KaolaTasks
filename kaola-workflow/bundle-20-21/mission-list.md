# Deliver forge-structured claim clone recipes (#20) and a read-only imported Issue publish card (#21)

- item: Measure the current REST/MCP claim clone envelope (`CLONE_TOKEN_USAGE`, two keys) and DESIGN §7/§9 so #20's new `remote_url` + `extra_header` rest on the tree, not the issue text; comments on #20 are empty so the body is current.
  status: in-flight
  dispatched: code-explorer → kaola-workflow/bundle-20-21/.cache/ground-truth-20.md (worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`)

- item: Measure the publish form's imported path (`task-title`/`task-description` still editable, `task-group-acceptance` still shown) and DESIGN 发布向导 so #21's read-only Issue card and omitted Kaola extra fields rest on the tree; comments on #21 are empty so the body is current.
  status: in-flight
  dispatched: code-explorer → kaola-workflow/bundle-20-21/.cache/ground-truth-21.md (worktree `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`)

- item: Write DESIGN.md §7/§9 and docs/api.md/README claim clone contract for the four-key `clone` object with the three-forge extra_header table, before any production code for #20.
  status: todo

- item: Write DESIGN.md 发布向导 so imported Issue is a read-only copy and Kaola extra fields are no longer collected, before any production code for #21; Task Brief keys stay.
  status: todo

- item: Author failing tests for claim 201 / MCP claim_task four-key clone (token-free remote_url, forge extra_header table, brief repo keys unchanged, no new MCP tools).
  status: todo

- item: Author failing tests for the publish pane: imported path has no task-title/task-description inputs, a read-only Issue card, and neither source type shows acceptance/test/path/priority/tag fields; POST omits those keys.
  status: todo

- item: Implement the four-key clone envelope on REST claim and MCP claim_task so the #20 tests pass; do not execute git on the server and do not put token in remote_url or extra_header.value_pattern.
  status: todo

- item: Implement the read-only imported Issue card and drop Kaola extra form fields so the #21 tests pass; keep POST /tasks and /tasks/import shapes; native title/description stay editable.
  status: todo

- item: Dock README/CHANGELOG/docs against measured implementation, then finalize the all-or-nothing bundle.
  status: todo
