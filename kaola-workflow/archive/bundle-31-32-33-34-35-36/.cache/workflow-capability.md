# Kaola Workflow capability measurement — Issue #33

Question: does Kaola-Workflow's `/workflow-next` (or equivalent) support claiming and running a
project with NO forge Issue backing it, so a Kaola Tasks *native* Task could be mapped straight to a
Workflow project named from the Task id, with no forge Issue created?

Target repo measured (read-only, byte-identical, no write made there):
`/Volumes/WorkspaceA/ylminiserver/workspace/kaola-workflow`

## 1. Entry points

Directory layout observed at repo root (`find . -maxdepth 2`, git-clean tree):
- `commands/` — the Claude-native slash-command surface: `commands/workflow-init.md`,
  `commands/workflow-next.md`, `commands/kaola-workflow-finalize.md`.
- Per-runtime mirrors of the same three commands exist under `.cursor*/commands/`,
  `.grok*/commands/`, `.kimi*/skills/`, `.opencode*/commands/`, `.zcode*/commands/` (Cursor, Grok,
  Kimi, opencode, ZCode, each ×3 for GitHub/GitLab/Gitea forge editions) plus a Codex plugin under
  `plugins/`. AGENTS.md (repo root, `Source layout` section) states these are all generated mirrors
  of `templates/routing/` and the shared kernel — one behavioral surface, many renderings.
- `scripts/` (97 files) is the executable kernel. `AGENTS.md:16` (repo root): *"`scripts/kaola-workflow-claim.js`
  owns selection, claims, status, worktrees, finalization, archive, and claim release."* This is the
  single script behind all three commands.
- `package.json:3` — `"version": "10.2.1"`.
- `package.json:4` — description: *"Adaptive Kaola-Workflow — an issue-driven mission list..."*
  (repo's own self-description is "issue-driven").

There is no `skills/` directory at the repo root for Claude; Claude uses `commands/`. Kimi is the
runtime that uses a `skills/` directory (`.kimi*/skills/`).

## 2. Claim/selection path — `scripts/kaola-workflow-claim.js` (6,676 lines)

### 2a. Does the real entry point require an issue number?

`commands/workflow-next.md` is the actual `/workflow-next` prompt. Its documented claim invocation
(`workflow-next.md:~150`) is:

```
node "$CLAIM_JS" startup --runtime claude --target-issues "$KAOLA_TARGET_ISSUES"
```

`startup` (aliased `bootstrap`) is implemented by `cmdStartup()` at
`scripts/kaola-workflow-claim.js:2066`. Its target resolution (`:2068-2069`):

```js
const scalarTarget = args.targetIssue || args.issue;
const bundleTargets = Array.isArray(args.targetIssues) && args.targetIssues.length ? args.targetIssues : null;
```

If neither is present, `cmdStartup` refuses before any claim mutation
(`scripts/kaola-workflow-claim.js:2132-2135`):

```js
if (!scalarTarget) {
    output({ verdict: 'no_target', claim: 'none', project: null, issue: null, result: 'answer',
      reasoning: NO_TARGET_USAGE }, claimExitCode('no_target'));
    return;
}
```

`NO_TARGET_USAGE` (`scripts/kaola-workflow-claim.js:1970-1971`), verbatim:

> `usage: --target-issue <N> (or --target-issues A,B,C) required; the workflow never auto-picks an issue.`

There is no `--project`-only branch inside `cmdStartup` — it only recognizes a scalar
`--target-issue`/`--issue` or a comma-set `--target-issues`. So the actual command
`/workflow-next` runs (`startup`) **cannot claim anything without a numeric issue target.**
`cmdPickNext` (`:2151-2159`) delegates to the same `cmdStartup` and carries the identical `no_target`
refusal when no target is given.

Exact flags recognized project-wide, from the CLI usage string
(`scripts/kaola-workflow-claim.js:6551-6553`):

```
flags: --project P [--json] [--force] [--strict] [--issue N] [--target-issue N] [--target-issues A,B] [--pr-number N]
       [--branch B] [--reason R] [--runtime claude|codex|opencode|kimi|grok|zcode] [--sink merge|mr|pr] [--workflow-path VALUE (retired, ignored)]
       [--keep-worktree] [--keep-open|--keep-issue-open] [--keep-branch] [--execute] [--archive] [--export]
```

### 2b. Is there ANY code-visible path to claim without an issue?

Yes, but only at a **lower**, non-`/workflow-next` layer — the bare `claim` subcommand
(`cmdClaim`, `scripts/kaola-workflow-claim.js:2048-2053`):

```js
function cmdClaim() {
  const root = getRoot();
  const args = parseArgs(process.argv.slice(3));
  assert(args.project, '--project required');
  output(claimProject(root, args));
}
```

This only requires `--project`, not `--issue`/`--target-issue`. Tracing `claimProject`
(`:1172` onward): when neither `args.issue` nor `args.targetIssue` is supplied, `issueNumber` stays
`null` all the way through folder creation, worktree provisioning, and branch checkout — the live
forge-issue-existence probe (`probeIssueState`) is skipped entirely because it is gated by
`if (issueNumber != null)` (`:1190`). So `cmdClaim --project X` with no `--issue` never calls `gh` to
verify a target issue exists.

However this "door" is **not actually issue-less** — it is gated by a hard numeric-identity
requirement enforced two layers down, at `writeState` → `buildClaimAnchors` →
`adaptiveSchema.buildClaimIdentity` → `normalizeIssueNumbers`
(`scripts/kaola-workflow-adaptive-schema.js:162-170`):

```js
function normalizeIssueNumbers(values) {
  if (!Array.isArray(values)) throw new Error('claim_issue_numbers_invalid');
  const out = Array.from(new Set(values.map(value => {
    const number = typeof value === 'number' ? value : Number(String(value));
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('claim_issue_numbers_invalid');
    return number;
  }))).sort((a, b) => a - b);
  if (!out.length) throw new Error('claim_issue_numbers_invalid');
  return out;
}
```

`writeState` (`scripts/kaola-workflow-claim.js:858-861`) only ever fills `issue_number` from ONE
place when it wasn't given explicitly — by parsing it back out of the **project name string**,
and only when that name matches the literal pattern `issue-<N>`:

```js
if (data.issue_number == null) {
    const inferredIssue = /^issue-([1-9][0-9]*)$/.exec(String(data.project || ''));
    if (inferredIssue) data.issue_number = parseInt(inferredIssue[1], 10);
}
```

The comment block directly above `unreservedProjectName` (`scripts/kaola-workflow-claim.js:316-329`)
documents the author's own measurement of exactly this boundary, verbatim:

> `316: // ONE arm, and `issue-<N>` is not merely a convenient substitute — it is the only shape that can`
> `317: // be one. A claim may legitimately carry no issue field: `writeState` below infers the number back`
> `318: // out of the project NAME, and only from `/^issue-([1-9][0-9]*)$/`. So the substitute has to match`
> `319: // that pattern or the claim cannot complete at all.`
> `320: //`
> `321: // This carried a second arm briefly, yielding `project-<name>` for the no-issue case. It was removed`
> `322: // on measurement rather than pinned. Driven directly, with a control, at this tree:`
> `323: //   claimProject(root, {project:'issue-888'})       -> acquired; the no-issue door genuinely works`
> `324: //   claimProject(root, {project:'project-roadmap'}) -> THROWS claim_issue_numbers_invalid`
> `325: //   claimProject(root, {project:'.roadmap'})        -> THROWS claim_issue_numbers_invalid`
> `326: // The second arm's own output could never satisfy the inference, so it threw exactly where doing`
> `327: // nothing would have, leaving the reserved directory byte-identical either way — no observable`
> `328: // effect on any input. The CLI fails at this same line rather than earlier; `cmdClaim` has no issue`
> `329: // check of its own, so that exit-1 is this throw propagating. One dead path, not two.`

**Reading this precisely**: "the no-issue door genuinely works" describes only the case where
`--issue`/`--target-issue` is omitted from the *flag*, but the caller-supplied `--project` string
still spells `issue-<N>` for some positive integer N — i.e. the number is still present, just carried
inside the project name instead of a separate flag. A `--project` value that is a free-form name
(e.g. `project-roadmap`, or by direct extension a Kaola Tasks native task id like `bundle-31-32-33`
or `task-abc123`) throws `claim_issue_numbers_invalid` and the claim never completes — confirmed by
the code path traced above independently of the comment (the throw fires in
`adaptiveSchema.normalizeIssueNumbers`, not from any reserved-name substitution — `project-roadmap`
does not match `isReservedWorkflowDirName` at `scripts/kaola-workflow-claim.js:2466-2469`, which only
flags `archive` and dot-prefixed names; the throw is purely because the project string carries no
parseable positive integer anywhere).

**Net: there is no code path anywhere in this script — `cmdStartup`, `cmdPickNext`, or the lower-level
`cmdClaim`/`claimProject` — that will complete a claim for a project whose identity is not, or does
not encode, at least one positive-integer "issue number".** A caller-supplied free-form project name
is accepted by `--project` as a string, but the claim only actually completes if that string
resolves to a real positive integer via the `issue-<N>` regex (or an explicit `--issue`/bundle
`--target-issues`). It is unblocked at the argument-parsing layer, not supported as a genuine
issue-less mode — the identity layer refuses unconditionally.

### 2c. Bundle projects — same requirement

`claimExplicitBundle` (`scripts/kaola-workflow-claim.js:1863`) requires `args.targetIssues` to be a
non-empty array of positive integers (Step 1, `:1876`: `'--target-issues <A,B,...> required'`), and
derives the project name directly from them
(`scripts/kaola-workflow-claim.js:1943`):

```js
const project = 'bundle-' + targets.join('-');
```

This is confirmed by observation: the very run folder this measurement is being written into,
`kaola-workflow/bundle-31-32-33-34-35-36/`, is named exactly this way from six real forge issue
numbers (31–36) in Kaola Tasks' own upstream repo — matching the documented convention in
`docs/workflow-state-contract.md:322-333` (`Bundle project and branch naming` table:
`kaola-workflow/bundle-42-47-53/` example). There is no alternate bundle-naming path that accepts a
non-numeric label set.

### 2d. What does it do with no forge remote / no `gh` auth?

- `listOpenIssues` (`scripts/kaola-workflow-claim.js:267-281`) wraps `gh issue list` in try/catch and
  returns `[]` on any failure (missing `gh`, no auth, no remote) — `list-open` exits 0 unconditionally
  regardless of `gh` availability.
- `commands/workflow-init.md:36`: *"If there is no GitHub remote, or if `gh` is unavailable or
  unauthenticated, skip issue fetching immediately and note that GitHub issue sync is pending."* —
  this is advisory prose for `/workflow-init`, not a code gate, and it does not create an
  alternate claim path; it only defers issue sync.
- Inside `claimProject`, when an explicit `--issue`/`--target-issue` target IS given and the probe to
  the forge fails (not `KAOLA_WORKFLOW_OFFLINE=1`), the claim is refused outright
  (`scripts/kaola-workflow-claim.js:1220-1222`):
  `reasoning: 'gh issue #' + issueNumber + ' state probe failed; not claiming outside KAOLA_WORKFLOW_OFFLINE=1'`.
- `KAOLA_WORKFLOW_OFFLINE=1` (`OFFLINE` constant, `:35`) short-circuits every forge-network call
  (`listOpenIssues`, the issue-state probe, worktree/in-place git-history checks that assume a
  remote) to a safe default, but it is an **explicit env var an operator must set**, not something
  auto-detected from "no remote". Critically, offline mode still requires a real target-issue number
  on the CLI (`cmdStartup`'s `no_target` refusal at `:2132` is unconditional on `OFFLINE`) — offline
  mode changes whether the number is *verified* against the forge, not whether one is *required*.

### 2e. What does `workflow-state.md` require — is `issue_number` mandatory?

`docs/workflow-state-contract.md:228-249` (`## Workflow State Fields`) documents `## Sink` as
carrying "issue number, sink mode..." as a live block, and `docs/workflow-state-contract.md:290-291`:
*"On a bundle project, three additive fields are written alongside `issue_number`. **Single-issue
projects retain only `issue_number`** — these fields are absent on non-bundle projects."* This
documents `issue_number` as always present for every project shape the docs describe.

At the code level this is enforced not by a null-check on `issue_number` alone but transitively, as
shown in §2b: `writeState` cannot reach the point of emitting `issue_number: ` in
`workflow-state.md` (`scripts/kaola-workflow-claim.js:880`) unless `buildClaimAnchors` →
`normalizeIssueNumbers` has already accepted at least one positive integer — that call happens at
`scripts/kaola-workflow-claim.js:870`, strictly before the `lines` array (containing the
`issue_number:` line) is built at `:871`. So: **yes, `issue_number` is effectively mandatory** — no
`workflow-state.md` can be durably written for a claim that never resolved to at least one positive
integer issue number, whether real or an operator-fabricated one shaped like the `issue-<N>` pattern.

## 3. Project naming

`{project}` is derived one of three ways, all issue-number-rooted:
- Single-issue, from an explicit target: `projectNameForIssue` (`scripts/kaola-workflow-claim.js:296-298`)
  — `return 'issue-' + issueNumber;` (unconditional; the roadmap-source override this used to read
  was retired per ADR 0018 §5, per the comment at `:293-295`).
- Bundle, from a target set: `'bundle-' + targets.join('-')` (`:1943`), sorted ascending
  (`docs/workflow-state-contract.md:332-333`).
- Caller-supplied via `--project`, at the low-level `cmdClaim`/`claimProject` door only (not through
  `/workflow-next`'s `startup`): accepted as a literal string, but — per §2b — only *completes* if it
  resolves to a positive integer via `/^issue-([1-9][0-9]*)$/`, an explicit `--issue`, or a bundle
  `--target-issues` set. A caller-supplied name like `task-<TaskId>` or the bare Kaola Tasks task id
  is **not supported**: it is syntactically accepted by the CLI parser and then rejected deep inside
  the identity layer with `claim_issue_numbers_invalid`. This is "unblocked" only in the narrow sense
  that `--project` doesn't itself refuse malformed strings at the argument-parsing layer; the run
  never actually completes.

## 4. Finalization/closure — `commands/kaola-workflow-finalize.md` + `cmdFinalize`

Because no claim can exist without an `issue_number` resolved (§2e), this question is moot in
practice for the entry points Kaola Tasks would drive. For completeness: `cmdFinalize`'s remote-close
logic (`scripts/kaola-workflow-claim.js:4566-4695`) is defensive about a null `issueNumber` — if
`issueNumber` were somehow null (only reachable via the low-level, non-`/workflow-next` `cmdClaim`
door with a non-`issue-<N>` name, a state this repo's own identity layer makes unreachable per §2b),
none of the closing branches (`issueNumbers.length > 0`, `!OFFLINE && issueNumber`) would fire and
`remoteIssueClosed` stays at its `'skipped_offline'` default (`:4635`) — finalize would not crash, it
would simply skip forge-closing. `docs/decisions/0018-the-forge-is-the-backlog.md` (ADR title itself:
"The forge is the backlog") states the finalize contract additionally *"requires a run to comment
what it corrected"* on the forge issue (§8 status line) — an action with no target in an issue-less
run.

## 5. VERDICT: **NOT SUPPORTED**

Kaola-Workflow 10.2.1 does not support claiming or running an issue-less project through its real
entry point. `/workflow-next` → `startup`/`bootstrap` (`cmdStartup`,
`scripts/kaola-workflow-claim.js:2066`) unconditionally refuses with `no_target` /
`"the workflow never auto-picks an issue"` when neither `--target-issue` nor `--target-issues` is
given (`:1970-1971`, `:2132-2135`), and the procedural prompt text
(`commands/workflow-next.md:83`) instructs the operator: *"The user described a task but named no
issue: resolve or file its issue; priority never outranks the requested work"* — i.e. the documented
behavior for a described-but-unfiled task is to create a real forge issue for it, not to run without
one.

A lower-level `--project`-only door exists at `cmdClaim`/`claimProject`
(`scripts/kaola-workflow-claim.js:2048-2053`, `:1172`) that skips the *forge-existence probe*, but it
is not an issue-less mode: the durable-state write (`writeState` → `buildClaimAnchors` →
`adaptiveSchema.normalizeIssueNumbers`, `scripts/kaola-workflow-adaptive-schema.js:162-170`) requires
at least one positive-integer "issue number," resolvable only from an explicit `--issue`/
`--target-issues` flag or a project name spelled exactly `issue-<N>`. A free-form project name (a
Kaola Tasks native task id, or any name not encoding a real-looking positive integer) throws
`claim_issue_numbers_invalid` and the claim never completes — this is measured directly in the code's
own comment at `scripts/kaola-workflow-claim.js:321-325`, and cross-checked independently against
`normalizeIssueNumbers`.

**Measured fallback available to Kaola Tasks** (not a recommendation, only what is observably
possible in this tree): a native Task could be driven through the low-level `cmdClaim --project
issue-<N>` door using a synthetic positive integer N derived from the Task id (not a real forge
issue) to satisfy the identity layer without a real GitHub/GitLab/Gitea issue existing — this bypasses
the forge-existence probe (§2b/§2d) because that probe only runs when `--issue`/`--target-issue` is
passed explicitly, not when the number is only embedded in `--project`. This is not the documented
`/workflow-next` path, is not what any shipped command or skill surface invokes, and its
finalize-time behavior (real `gh issue close`/comment calls against a non-existent issue number,
unless `KAOLA_WORKFLOW_OFFLINE=1` is set) was not driven or measured in this investigation — only the
claim-time code path was traced. Whether this fallback is safe to use in practice (finalize's forge
calls against a fabricated issue number) is unmeasured and would need its own live run before Kaola
Tasks could rely on it.

## 6. Version / identity (advisory)

- `package.json:3` — `"version": "10.2.1"`.
- Latest commit at measurement time: `7e93763e43864091f722b306c404bb85d7f96052 2026-08-31 13:03:50 +0800`
  (`git log -1 --format='%H %ad' --date=iso`, run in `/Volumes/WorkspaceA/ylminiserver/workspace/kaola-workflow`).
- `git remote -v`: `origin https://github.com/KaolaBrother/Kaola-Workflow.git` (fetch/push) — matches
  the canonical GitHub repo named in the task.
- `CHANGELOG.md:3` — top entry `## [10.2.1] - 2026-08-31`, matching the commit date and
  `package.json` version (self-consistent).
- No single "contract-schema" version number was found inside the `kaola-workflow` repo itself (its
  ADR/decision docs are numbered `0017`, `0018`, `D-430-01`, etc., which are design-record IDs, not a
  contract-schema field). The `Contract schema: 1` string quoted in this session's system context
  belongs to the separate `kaola-workflow-global.md` user rule file (a KaolaTasks/user-side artifact),
  not to anything found inside the measured `kaola-workflow` repository.

## What was not determinable from source

- Whether the `cmdClaim --project issue-<N>` fallback door (§5) actually survives a full
  claim→run→finalize→archive cycle with a fabricated (non-real) issue number was not run or measured
  — only the static code path to claim-time completion was traced. This would require executing the
  script against a real or mocked forge, which this investigation did not do (read-only measurement
  only, per its own constraint).
- Whether any of the seven runtime editions (Cursor/Grok/Kimi/opencode/ZCode/Codex mirrors) diverge
  from the Claude `commands/` surface on this specific question was not checked file-by-file; AGENTS.md
  states they are generated mirrors of the same kernel, which was treated as sufficient given the
  claim/refusal logic lives in the single shared `scripts/kaola-workflow-claim.js`, not in the
  per-runtime prompt text.
