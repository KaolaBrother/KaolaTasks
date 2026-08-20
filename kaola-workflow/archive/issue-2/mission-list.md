# Ship the Task Brief zod schema and lifecycle state machine in packages/shared

- item: Measure DESIGN.md §5/§6 and the packages/shared shell so Chinese status labels, legal transitions, and §6 fields come from the document rather than invention; native source and temp-token credential keys are unspecified in the example
  status: done
  dispatched: self; notes to kaola-workflow/issue-2/.cache/design-measure.md
  result: Eight legal transitions; Chinese status labels; §6 example is the must-accept fixture; native source = {type:native} only; no invented temp-token credential key; reject raw token. Full notes in kaola-workflow/issue-2/.cache/design-measure.md

- item: Confirm a Node-22 + TypeScript-5.9 + ESM/NodeNext-compatible zod version and the parse/enum/discriminated-union APIs the schema will use
  status: done
  dispatched: knowledge-lookup; report to kaola-workflow/issue-2/.cache/zod-version.md
  result: zod ^4.4.3; import * as z from "zod"; z.enum, z.discriminatedUnion("type"), z.iso.datetime({ offset: true }), z.strictObject. Full notes kaola-workflow/issue-2/.cache/zod-version.md

- item: Author failing tests in packages/shared that accept the DESIGN.md §6 example, reject malformed briefs, cover every legal lifecycle transition and the main illegal ones, and keep getSharedHealth; do not write production code
  status: done
  dispatched: tdd-guide in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2; tests land under that worktree packages/shared/src; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-2/.cache/tdd-guide-report.md
  result: RED on eb479691dce6fb93fca7617c7fcfe95dee66866f — 87 tests, 1 pass (getSharedHealth), 86 fail (missing parseTaskBrief / transitionTaskStatus). Tests in packages/shared/src/index.test.ts. Report kaola-workflow/issue-2/.cache/tdd-guide-report.md

- item: Implement the Task Brief schema and transition guard in packages/shared until those tests pass; add zod if needed; do not write tests
  status: done
  dispatched: implementer in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2; production lands under that worktree packages/shared; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-2/.cache/implementer-report.md
  result: parseTaskBrief + transitionTaskStatus in packages/shared/src/index.ts; zod ^4.4.3. Orchestrator re-ran shared tests: 87 pass / 0 fail. Report kaola-workflow/issue-2/.cache/implementer-report.md

- item: Prove lint, typecheck, test, and build green in the issue-2 worktree
  status: done
  dispatched: self in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2; record to kaola-workflow/issue-2/.cache/final-validation.md
  result: lint/typecheck/test/build all exit 0. 89 tests pass. Record kaola-workflow/issue-2/.cache/final-validation.md

- item: Dock README/CHANGELOG/docs against the measured public surface without changing DESIGN.md contracts
  status: done
  dispatched: doc-updater in worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-2; docs land under that worktree; report to /Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-2/.cache/doc-updater.md
  result: DOCKED. README/CHANGELOG/CLAUDE.md/docs/api.md/docs/architecture.md transcribed measured exports. DESIGN.md untouched. Reports kaola-workflow/issue-2/.cache/doc-updater.md and doc-docking.md
