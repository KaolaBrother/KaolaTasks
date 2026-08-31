# Issue #35 — Documentation docking report

Worktree: `/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/.kw/worktrees/bundle-31-32-33-34-35-36`
Branch: `workflow/bundle-31-32-33-34-35-36`, HEAD at start: `cfe50ff`

Scope: documentation only. No `*.ts` file, test, `package.json`, or `docs/workflow-default.md` /
`docs/runner-carrier.md` was touched (verified with `git status --porcelain` at the end — only the six
doc files below are modified; the pre-existing untracked `apps/server/src/lifecycle-matrix.test.ts` in
the worktree belongs to the concurrent integration-suite agent, not to this task).

## Commands run

- `pnpm lint` → `eslint .`, exit 0, clean.
- No test suite was run (out of scope for a docs-only task, and running it risked colliding with the
  other agent's concurrent work in this shared worktree). No CHANGELOG entry claims a measured test run
  for #36/#31/#32/#33/#34 — only descriptive behavior, matching the style of several existing entries
  (e.g. `#23`, `#22`) that also carry no "Measured …" line.
- No live smoke run was executed or claimed. `docs/smoke-test.md` was checked for the 配合-tagged
  honesty rule; no new claim of an executed browser/OAuth/token step was added.

## Files changed and the substance of each change

**`README.md`**
- Line 30 (the named drift): replaced "一次性仓库令牌（默认 24 小时）" with wording matching ADR-0030 —
  the credential is reusable and not minted per Claim; the 24h TTL only governs Kaola Tasks' own Claim
  lock, not the forge credential.
- MCP tool table (`claim_task`/`report_progress`/`release_task`/`submit_pr` rows): added a terse mention
  of optional `request_id` (claim) and `claim_id` (later mutations), and that repeated release/submit
  against the same Claim is idempotent.
- Left `README.md:58`'s "一次性 token" untouched — verified it names a different, legitimate concept
  (the per-task inline credential paste, as opposed to a stored credential profile), not the Claim
  lifecycle.

**`docs/DESIGN.md`**
- §5 line 99 (the named drift): "并撤销该次 token 揭示的有效性记录" replaced with wording that lease
  expiry/release revokes only Kaola Tasks' own lifecycle authority and Claim fencing, never the forge
  credential — cross-referenced to §15's already-correct "凭证语义" framing (§15 was written by #30/#35's
  design predecessor and was already accurate; I did not touch it, only pointed §5 at it).
- §7: added a new bullet documenting the `DELETE /api/v1/credential-profiles/:id` retention rule shipped
  by #36 (`409 credential_profile_in_use` while any non-terminal task references the profile).
- §9 (MCP 工具面): updated the envelope-unchanged sentence to describe the additive `claim_id` in
  `lease`, and updated all four tool-parameter rows to include `request_id?` / `claim_id?` plus a short
  behavior note (idempotent replay, fencing requirement, idempotent release/submit).
- §10 (数据模型): `leases` row gained `request_id` (nullable, partial unique index) and a note that
  `claim_id` is derived, not stored; `submissions` row gained the `lease_id` unique index and the
  canonicalized/cross-task-unique `pr_url` note.
- Left §5's "可按任务配置" (per-task-configurable TTL) untouched — it is forward design intent, not a
  claim about current implementation, and does not contradict shipped code (`LEASE_TTL_SECONDS` is a
  fixed constant); redesigning or flagging it was outside this docking task's scope ("do not redesign").
- Left §14 risk item 1 ("仓库级细粒度 token + 审计 + 易吊销") and §7's existing "档案页提供一键吊销"
  bullet untouched — both are about the pre-existing credential-profile delete-and-manually-revoke-on-
  forge workflow, unrelated to per-Claim mint/revoke.

**`docs/architecture.md`**
- Fixed a stale claim that `claimTask` "awaits `attemptWriteback`" (true before #36) — it now calls
  `scheduleWriteback`, fire-and-forget; `submitPr` still awaits its own writeback, unchanged.
- Added `request_id?` / `claim_id?` to the claim/progress/release ASCII-tree route entries, plus a note
  on the #31 device-fencing tightening and the #36 replay/conflict behavior.
- Added the `credential_profile_in_use` refusal to the `/api/v1/credential-profiles` tree line.
- Updated the unique-index list (added `leases_device_request_identity`, `submissions_lease_id`) and the
  `createDb` paragraph's DDL description to match.
- Corrected the `leases`/`submissions` column lists, which were already stale before this bundle (missing
  `device_id`/`claimer_claimant_id`, added by #23) — fixed while already rewriting the same sentence for
  #36's `request_id` addition, and added the `claim_id`-is-derived-not-stored note.
- Added a new `## Claim lifecycle (#36 / #31 / #32 / #33 / #34)` section (between `## Server` and
  `## Web`) covering: the #36 atomic-acquisition transaction and derived `claim_id`; the #31 fencing
  tightening, transaction boundaries, and `pr_url` canonicalization/uniqueness; the #32 bridge receipt
  store under `KAOLA_HOME/receipts/…` (permissions, atomic write, cross-process lock); the #33
  Workflow-direct default and the measured issue-less-project finding; the #34 explicit-Runner env-only
  carrier split, pinned snapshot, and advisory-not-silent-fallback rule. Cross-links
  `docs/workflow-default.md` and `docs/runner-carrier.md`.

**`docs/api.md`** (the heaviest job)
- Intro paragraph: added a sentence naming the new optional `request_id`/`claim_id` fields and the seven
  new typed errors, plus the credential-semantics correction with a pointer to ADR-0030.
- `DELETE /api/v1/credential-profiles/:id`: documented the new `409 credential_profile_in_use` pre-check.
- `POST /api/v1/tasks/:publicId/claim`: documented `request_id` in the body; added a full subsection on
  idempotent claim identity (replay-before-lookup, digest match/mismatch, active-vs-terminal-lease
  outcomes, pending-confirmation interaction); updated the `lease` shape to `{ claim_id, expires_at,
  ttl_seconds }` with `claim_id`'s derivation explained; updated the `token` bullet with the
  reusable-credential/no-per-Claim-revoke framing; added `claim_request_conflict` to the error list;
  rewrote the "Holder identity" and "Writes" paragraphs for the one-transaction acquisition and the
  `scheduleWriteback` fire-and-forget change (`claimTask` no longer delays its `201` on the forge
  comment; `submitPr` is unaffected).
- `POST /api/v1/tasks/:publicId/progress` and `.../release`: added `claim_id` to the body, added fencing
  subsections (claim_id_required / owner+device match / stale_claim, in check order), noted the #31
  device-fencing tightening explicitly as a behavior change, noted release's idempotent-terminal path,
  and corrected a pre-existing "Bearer only" mislabel on both routes to "Device proof only" (these routes
  have used device-proof auth since #23; the old text predated that migration and was already wrong,
  independent of this bundle — fixed while rewriting the same lines for #31).
- MCP tools table: added `request_id?`/`claim_id?` to the four affected tool input columns and rewrote
  their behavior cells for identity/fencing/idempotency/pr_url validation; added the `instructions` field
  note for #33; updated the shared-error-bodies paragraph with the seven new codes.
- `leases` table section: added `request_id` column, the `leases_device_request_identity` unique index,
  and the "claim_id is derived, never stored" explanation with its exact input fields.
- `submissions` table section: added the `submissions_lease_id` unique index and the canonicalization /
  cross-task-uniqueness rules for `pr_url`.
- `events` table: corrected the claim `token 揭示` details shape — it previously said `agent_key_id`,
  which does not match `claim.ts`'s actual `RevealDetailsBase` (`device_id`, not `agent_key_id`; this was
  pre-existing drift from before #23's device-proof migration, fixed while adding #36's `claim_id`/
  `request_id`/`autonomous`/`replay` fields to the same JSON shape); added a canonicalization note to the
  `submit_pr` event details.
- "Status write-back" section: fixed the call-site table and its surrounding paragraph to state that
  `claimTask`'s writeback is now fire-and-forget via `scheduleWriteback` (#36) while `submitPr`'s stays
  `await`ed; added a short paragraph on `scheduleWriteback`/`settleWritebacks` (the test-only
  deterministic seam).
- Sources line: added `workflow-target.ts` and `apps/mcp/src/runner-carrier.ts`.
- stdio-bridge paragraph: added a paragraph on request_id generation/recovery and claim_id auto-attach
  by the bridge (#32), and the stale-session re-initialize-once/replay-once behavior (verified against
  `apps/mcp/src/main.ts`'s actual retry logic, not assumed).
- Fixed one other stray "Bearer" mislabel (the `revealCredentialProfile` doc comment calling the claim
  route "Bearer" — corrected to "device-proof").

**`docs/smoke-test.md`**
- Added a note under the "认领怎么走 (#23)" section explaining that `claim_task`'s `lease` now carries
  `claim_id` and that `report_progress`/`release_task`/MCP `submit_pr` accept `claim_id`, but that
  `scripts/forge-smoke.ts` (verified by reading it) never sends `request_id`, so the manual/scripted
  smoke walkthrough exercises the legacy Claim path and is unaffected by the #31 device-fencing
  tightening (it only ever uses one paired device throughout).
- Added a note to "测完可收" that deleting the credential profile during cleanup can now be refused with
  `409 credential_profile_in_use` if a task was left in a non-terminal status, with the fix (finish or
  cancel the task first).
- No claim of an executed live run was added or implied; both notes are prospective/explanatory, matching
  what the code now does regardless of whether a run has happened.

**`CHANGELOG.md`**
- Added five new entries at the top of `## Unreleased`, in ADR-0030's delivery order (`#36` → `#31` →
  `#32` → `#33` → `#34`), matching the file's existing per-issue narrative-paragraph style (file paths,
  exact error codes/messages, table/index names, new test file names). No fabricated "Measured …" test
  run line was added to any of the five (see "Commands run" above).
- The `#36` entry explicitly calls out the credential-semantics wording fix and names exactly which two
  files/lines were corrected (`README.md:30`, `docs/DESIGN.md` §5) versus which two were left alone
  (`docs/DESIGN.md:168`, `README.md:58`, the legitimate single-task inline-credential usage).
- The `#31` entry explicitly labels the device-fencing change "刻意收紧的行为变化" (a deliberate
  tightening) and states the concrete before/after behavior, per the brief's instruction to call it out
  prominently.

**`AGENTS.md`**
- No changes. `## Documentation` already lists `docs/workflow-default.md` and `docs/runner-carrier.md`
  (written by #33/#34's own agents, as the brief expected). `## Project Constraints` was checked line by
  line against the shipped code; nothing there is now inaccurate — in particular "只允许现有 REST claim
  `201` 和 MCP `claim_task` 成功响应揭示" (forge token still reveals only at those two response points)
  remains true after #36/#31.

## The full drift hit list (search terms: 一次性 / one-shot / oneshot / 撤销 / revoke / 24 小时 /
short-lived / 短期)

| Location | Verdict | Reasoning |
|---|---|---|
| `README.md:30` | **Fixed** (named drift) | Claimed the token was one-shot/24h-scoped; the credential is reusable and never revoked on the forge by lease expiry. |
| `README.md:58` | Kept | "一次性 token" here names the single-task inline-credential-paste path (an alternative to a stored credential profile), a real and distinct product concept — not the Claim lifecycle. |
| `docs/DESIGN.md:99` (now ~99) | **Fixed** (named drift) | Same class of drift as README:30, sitting exactly where ADR-0030's correction applies. |
| `docs/DESIGN.md:168` (now ~169) | Kept | Same inline-credential concept as README:58 — "也允许发布者为某个任务粘贴一次性 token（覆盖档案）". |
| `docs/DESIGN.md:192` | Kept | "解除立即生效…将 `users.status` 置为 `revoked`" — user/claimant account revocation, unrelated to Claim credentials. |
| `docs/DESIGN.md:202` | Kept, but added an adjacent new bullet | "档案页提供一键吊销（删除档案 + 提示去 forge 侧撤销）" describes the existing credential-profile delete-and-manually-revoke-on-forge feature, which is legitimate and unrelated to per-Claim revoke; I added a new sibling bullet right after it for the #36 in-use-deletion refusal rather than editing this line. |
| `docs/DESIGN.md:272,273,274,298` | Kept | All `revoked` hits are `users`/`devices` status enum values (account/device revocation), unrelated. |
| `docs/DESIGN.md:359` (§15) | Kept, cited | Already the correct ADR-0030 credential-semantics wording ("并非 lease-scoped token；真正 per-Claim mint/revoke 是独立后续能力"), written by the design predecessor to this bundle. I pointed §5's fix at this section rather than duplicating it. |
| `docs/architecture.md:27,32,33` | Kept | Agent-Key / device / claimant `revoke` routes — unrelated leftover-Bearer and device-management surfaces. |
| `docs/api.md:58,70,122,134,136,164,401,403` (pre-edit line numbers) | Kept | All are `users`/`devices`/`claimants` status-`revoked` or Agent-Key/credential-profile-delete "请同时到 forge 侧撤销该 token" (the existing delete-and-manually-revoke-on-forge feature) — none describe per-Claim token revocation. |
| `docs/smoke-test.md:148` | Kept | "两家：撤销冒烟 PAT" — post-smoke-test manual PAT cleanup instruction, unrelated to Claim lifecycle semantics. |
| `CHANGELOG.md:14,46,47` (historical entries) | Kept unedited | Device/Agent-Key/credential-profile revoke, describing already-shipped `#23`/`#4`/`#5` behavior; historical changelog entries are not rewritten. |
| `docs/workflow-default.md:81-82` | Kept, cited (not edited — owned by #33) | Already states the correct credential semantics ("次 Claim 单独铸造的一次性令牌；per-Claim 铸造/吊销仍是明确的非目标…绝不会撤销 forge 令牌本身"). Confirms this is the wording pattern the rest of the docs should match, which is what I applied to README.md:30 and DESIGN.md:99. |
| `docs/runner-carrier.md` | No hits | Clean. |
| `docs/README.md`, `docs/conventions.md` | No hits | Clean. |
| `apps/server/src/mcp.ts` | No hits (verified, not edited) | #33 already replaced the "one-shot" wording with the correct "reusable stored repository credential (not minted per claim)…release and lease expiry revoke only Kaola Tasks' own lifecycle authority and Claim fencing — never the forge token itself" phrasing in the `claim_task` tool description. Read the file directly to confirm; made no edit (protected `.ts` file). |

New hits introduced by my own edits (all correct, listed for completeness): `CHANGELOG.md`'s new `#36`
entry explicitly discusses and quotes "一次性 token"/"一次性令牌" while explaining the fix — expected,
since it is a changelog entry *about* the correction.

## Where the code contradicted this brief

- The brief's summary said `claimTask` "awaits" writeback the same way `submitPr` does; reading
  `claim.ts`/`writeback.ts` showed `claimTask` actually calls the new fire-and-forget
  `scheduleWriteback` (tracked in a module-level `Set`, never awaited), while only `submitPr` still
  `await`s `attemptWriteback` directly. I documented the distinction explicitly in `docs/api.md` and
  `docs/architecture.md` rather than describing both as symmetric.
- `apps/server/src/workflow-target.ts`'s `workflowTargetForTask` is **not** wired into any HTTP or MCP
  route — it is a pure function exercised only by `workflow-default.test.ts`; the actual Agent-facing
  surface for the #33 default is the `McpServer` `instructions` string in `mcp.ts`, which restates the
  same mapping in prose for the Agent to compute itself from a `TaskBrief` it already has. I described it
  that way (pure/unwired, cited as the mapping definition, not as an API surface) rather than implying it
  is a new endpoint or field.

## What I could not verify from the code

- Nothing in the assigned scope was unverifiable — every claim added to the docs was checked directly
  against `apps/server/src/claim.ts`, `leases.ts`, `credential-profiles.ts`, `schema.ts`, `db.ts`,
  `mcp.ts`, `workflow-target.ts`, `apps/mcp/src/main.ts`, `apps/mcp/src/runner-carrier.ts`, and the
  relevant `*.test.ts` file names (read only for their names/exports where cited, not executed).
- I did not execute `pnpm test`, so I cannot and did not claim any test count in the CHANGELOG entries or
  elsewhere — the task's own framing note ("Everything is green: 761 node + 117 web tests") is the
  environment's own prior claim, not something I re-verified by running the suite myself in this session.

## Paths changed

- `/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/.kw/worktrees/bundle-31-32-33-34-35-36/README.md`
- `/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/.kw/worktrees/bundle-31-32-33-34-35-36/docs/DESIGN.md`
- `/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/.kw/worktrees/bundle-31-32-33-34-35-36/docs/architecture.md`
- `/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/.kw/worktrees/bundle-31-32-33-34-35-36/docs/api.md`
- `/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/.kw/worktrees/bundle-31-32-33-34-35-36/docs/smoke-test.md`
- `/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/.kw/worktrees/bundle-31-32-33-34-35-36/CHANGELOG.md`

Report file: `/Volumes/WorkspaceA/ylminiserver/workspace/KaolaTasks/kaola-workflow/bundle-31-32-33-34-35-36/.cache/doc-docking.md` (this file).
