# Project Instructions

## Project Snapshot

- Purpose: 考拉任务 (Kaola Tasks) — an internal Chinese-language task board where team members post/import coding tasks (GitHub / GitLab / Gitea issues) with a forge token attached, and teammates' agents claim them via MCP, implement on the real repo, and deliver a PR. Platform is routing/coordination only — no agent execution, no code hosting.
- Stack: TypeScript full-stack — Vue 3 + Vite + Naive UI (web), Node 22 + Fastify (API), Drizzle ORM + SQLite, official MCP TypeScript SDK, pnpm workspaces monorepo.
- Architecture: `apps/web` (前端) + `apps/server` (API + MCP server + webhooks) + `packages/shared` (task-brief zod schema, state machine) + `packages/forge-adapters` (GitHub/GitLab/Gitea behind one interface). Full design: `docs/DESIGN.md`.
- UI language is Chinese (中文界面); code identifiers and docs comments in English.

## Commands

- Install: `unknown` (planned: `pnpm install` after M0 scaffold)
- Test: `unknown` (planned: `pnpm test`)
- Lint/typecheck/build: `unknown` (planned: `pnpm lint` / `pnpm typecheck` / `pnpm build`)
- Dev server: `unknown` (planned: `pnpm dev`)

## Non-Negotiable Rules

- Think before coding: state assumptions, surface ambiguity, and ask when unclear.
- Read before writing: inspect the target file and relevant surrounding conventions immediately before editing or creating files.
- Keep it simple: solve the requested problem without speculative abstractions.
- Make surgical changes: touch only what the task requires.
- Goal-driven execution: Define verifiable success criteria before starting. Keep the tests in separate custody from the code they judge — whoever implements a behavior does not author its tests. Loop until criteria pass; don't declare done on weak signals.
- Verify facts, don't fabricate: do not guess API/library behavior, interfaces, or signatures — confirm them against documentation, source, or a run before relying on them. Do not claim to understand code, errors, or requirements you have not verified; name what you do not know and find out.
- Reuse before adding: before writing a new interface, search for an existing equivalent and extend it rather than duplicate functionality.
- Escalate irreversible changes: do not unilaterally make hard-to-reverse changes or alter a user-owned contract (public API, schema or data migration, dependency or build-tooling swap, deletion of working capability); state the decision and its evidence, then get confirmation before proceeding.

## Validation Policy

- Treat background hooks as advisory; do not duplicate validation they already perform.
- Own verdicts locally: run tests/lint/build in-session to judge done; CI is confirmation, not the judge.

## First Principles

The numbered axioms are tie-breakers, applied in priority order whenever a situation is not already settled; the paragraphs that follow them are standing defaults that hold whether or not anything else settles the case.

1. **Correct first.** Never trade correctness for speed or cost; rework is the most expensive outcome.
2. **Then save human time.** Remove manual steps and shorten the wait, without weakening axiom 1.
3. **Then spend as little as possible.** Use the cheapest sufficient mechanism — parallelism, extra agents, and higher model tiers are means, not goals.
4. **Machines decide facts; humans decide values.** Take irreversible and value-laden calls to the user and ask, in conversation; leave everything checkable to run automatically.
5. **Own your own verdicts.** Never let a system the workflow does not own (CI, an external service) be the judge of done.

**Tie-breaker protocol:** when nothing else covers a situation, resolve it by walking these axioms in order and record a one-line derivation alongside the work. Recording it is useful and never required.

**Check the premise before it shapes the work:** an issue is a claim recorded earlier against a tree that has since moved, so establish what is true *now* at the place it points and let the measurement rather than the filed text decide what gets built. The usual outcome is neither *right* nor *wrong* but right-with-a-detail-that-misroutes — a stale locator, a miscounted set, a clause that breaks if executed literally — so carry the measurement forward, never a bare verdict. Where the two disagree the issue gets corrected, not quietly worked around. Nothing inspects that you did this.

**Dispatch production; keep decisions:** the orchestrator's context is the run's scarcest resource — a handoff costs once, inline residue taxes every later decision — so delegating discretionary production is the default and only the deciding stays inline; weigh the economics per case by judgment, with no justifier, evidence line, or approval attached.

**Parallel by default:** concurrency is the standing default for independent work, and work that genuinely feeds other work runs in order because it has to. Nothing inspects that choice — no proof, no evidence line, no cap: you can tell the difference, and the frontier is in front of you. Width stays sized to the true shape of the task rather than pushed as wide as it will go.

## Kaola-Workflow

<!-- KW-CLAUDE-MANAGED-START -->
Everything between this marker and its matching END below is owned by `workflow-init`: a later run
may replace it in full. Nothing outside the two markers is touched — that content, wherever you have
added or changed it in this file, is yours.

- Start and resume all workflow work through the workflow router entrypoint your runtime installs.
- A run claims an explicitly selected set of issues — normally three to five, sometimes one — each open, unclaimed, and closeable on its own evidence, and records what it owns in `kaola-workflow/{project}/workflow-state.md`: which issues, which branch, which worktree. An issue runs alone when it moves something the others read, when closing it needs a value call from the user, or when its scope is not knowable until it has been investigated.
- `kaola-workflow/{project}/mission-list.md` is the run's coordination record and the one file a successor needs. No script owns this file; you write it. An H1 carrying the goal in one line, then one item per mission.
- An item is a **mission, not a specification**. One line of prose: what to achieve, plus the hints and facts you already know. It carries no role, no file list, no dependency edge, no model, no cardinality and no shape, because you decide all of that when you reach it.
- The frontier is not computed — it is the list minus done minus in-flight, visible by reading. When you reach an item, decide whether to dispatch subagents or do the work yourself, and at what width.
- **Three write moments.** These are the whole discipline. **Created** — write `item` and `status: todo`. **Dispatched** — write `dispatched` and flip `status` to `in-flight`, **before the work goes out**. Writing it afterwards is precisely the failure this file exists to prevent. Name **where the output was to land** — that locator is what makes recovery possible at all. **Closed** — write `result` and flip `status` to `done`.
- Delegate work to the vendored subagents by default; the main session owns orchestration, review, validation, integration, and final decisions. Subagents and worktrees are tools — offered, and declinable.
- Name roles by function and reasoning tier, never by a vendor model name — write `planner (reasoning tier)`, not `planner (<model>)`. Keep this section runtime-neutral so it reads correctly on every runtime that reads this repo.
- For read/research work, spawn `code-explorer` for codebase research and `knowledge-lookup` when external library/API behavior or open-web/expertise knowledge that cannot be confirmed locally is needed.
- Custody, not order, splits the two writing roles: `tdd-guide` authors the tests and writes no production code; `implementer` writes the production code and reads and runs the tests but never writes them.
- Route build/type/lint validation failures to `build-error-resolver`; route behavior, coverage, and test-defect failures back to `tdd-guide`, the role that owns the test artifact.
- Route documentation work to `doc-updater`, and require it to transcribe verified ground truth — real command output, real signatures, existing schema — or to say what it needs; never let it invent field names, keys, enum values, or example numbers.
- Use the vendored agent role names exactly as installed; prefer short names like `planner`. When spawning a Kaola subagent, pass the role's configured model on the spawn call — each agent ships its model in its installed profile.
- At workflow-router startup, fetch remote-tracking refs, classify local/upstream sync state, and ask before any risky synchronization.
- Use a persistent-objective prompt so work continues until its objective and completion audit are satisfied.
- That objective prompt must not use "next issue in line" or any phrasing that implies automatic cross-issue continuation. Each workflow run targets one selected set of issues; finishing the set is the terminal event. The completion contract requires explicit re-direction for the next set.
- Treat nonessential workflow bookkeeping as autonomous: generated project names, collision suffixes like `-2`, cache/artifact paths, and harmless ordering choices are selected automatically and recorded.
- For essential technical decisions, apply your own judgment, apply the selected answer, and say what the evidence was.
- Take irreversible and value-laden calls to the user and ask, in conversation, before acting: risky Git synchronization, destructive rewrites, deployment or credential actions, and issue reorganization. Nothing collects that approval for you.
<!-- PIN: forge-is-the-backlog -->
- GitHub issues are the backlog: title, labels and comments are what the work is — comments override the body.
- `kaola-workflow/.roadmap/_rules.md` is the one optional local file that survives, for standing
  project-local rules read directly; nothing else is generated or tracked under
  `kaola-workflow/.roadmap/`.
<!-- /PIN -->
- Active work lives in `kaola-workflow/{project}/` until archived or safely discarded.
<!-- PIN: forge-is-the-backlog -->
- Roadmap/research sessions create or refine issues on the forge; workflow runs implement one selected set — there is no local mirror to refresh.
<!-- /PIN -->
- After resume or compaction, read `workflow-state.md` and `mission-list.md` before continuing: the H1 is the goal, `done` items carry what is already known, `in-flight` items are the decision to make, `todo` items are what remains.
- Resuming an `in-flight` item means looking for the WORK, not the worker: if the output its `dispatched` line promised has landed, close it; otherwise re-dispatch, unless the dispatch is provably still alive.
- End each cycle by docking docs against code changes, resolving closure decisions, updating issues, archiving completed workflow folders, and then the final commit and push.
- Active issue work runs in a repo-local worktree at `<repo-root>/.kw/worktrees/<project>/` by default; set `KAOLA_WORKTREE_NATIVE=0` to disable. See README for the full contract.
<!-- PIN: forge-is-the-backlog -->
- Top-priority labels: declare in `kaola-workflow/config.json` (`priority_top_tier_labels`) when the repo uses something other than P0–P3 naming.
<!-- /PIN -->
<!-- KW-CLAUDE-MANAGED-END -->

## Project Conventions

- `docs/DESIGN.md` is the product/architecture source of truth; change it before changing contracts (task-brief schema, state machine, adapter interface, MCP tool surface).
- The three forge adapters stay behavior-identical: one shared integration-test spec runs against all three implementations.
- Tokens are never logged, never returned by `list_tasks`/`get_task_brief`; reveal only via `claim_task`, always audited.
- Task lifecycle states use the Chinese names from `docs/DESIGN.md` §5 (待认领/进行中/待验收/已完成/已退回/已取消) as the canonical enum labels.

## Documentation Map

- `README.md` — project overview and usage.
- `CHANGELOG.md` — user-visible changes.
- `docs/README.md` — documentation index.
- `docs/DESIGN.md` — full product & system design (v0.1, source of truth).
- `docs/architecture.md` — system structure and data flow.
- `docs/api.md` — APIs, schemas, events, and external contracts.
- `docs/conventions.md` — coding, testing, Git, and review rules.
- `docs/decisions/` — architecture decision records.

## Maintenance

- Keep this file under 200 lines — a recommendation, not a limit; move detail to docs or skills.
- Add rules only after repeated mistakes, review feedback, or stable project conventions.
- Do not use `@path` imports for optional reference material.
