# Documentation update — bundle-53 (#53)

Custody: self (transcribed from the landed code at 4875bd7; no invented fields).

| file | checked | outcome |
|------|---------|---------|
| `docs/DESIGN.md` | v0.6 header; §2 D9–D17; §5 eight statuses + per-edge table; §6 `pr_convention.draft` / `parent_task_id` / `review_round` / derived `base_branch`; §7 in-use credential statuses; §8 `PrStatus`, `markPullRequestReady`, `commentOnPullRequest`; §9 ten tools (incl. `head_branch?`) + Review Brief; §10 tables/events; §17 评审循环 (REST population + size caps) | updated |
| `docs/api.md` | review REST section (routes, error codes, caps, GET population), SSE (`preClose`, 8 streams/user), MCP rows for the four tools, `report_progress` percent/phase, `submit_pr` head_sha/head_branch/use_submit_revision/reopen, terminate → `pr_state terminated`, poller/webhook over three states + restack, submissions/new tables, events, `getPullRequest` fields, `markPullRequestReady`, `commentOnPullRequest`, shared edges | updated |
| `docs/architecture.md` | route map (review routes, stream, ten tools, new tables, poller behaviour) | updated |
| `README.md` | sequence diagram, 一次任务怎么走完 steps 5–8 + sub-task paragraph, MCP tool table (ten tools, percent/phase, Draft) | updated |
| `CHANGELOG.md` | `#53` Unreleased entry | updated |
| `docs/smoke-test.md` | 标准闭环 rows 10–14 (Draft PR, review round, revision claim, approve/ready, merge), 配合 paragraph, 本轮记录 row (GitLab #20/!16, Gitea #30/#31, first attempts noted) | updated |
| `docs/workflow-default.md`, `docs/runner-carrier.md` | Claim → Workflow guidance unchanged by #53 (MCP instructions gained a 评审循环 paragraph in `mcp.ts`; the default-Workflow contract text is untouched) | no impact |
| `docs/conventions.md` | engineering conventions unchanged | no impact |
| `.env.example` | new optional `KAOLA_REVIEW_SUMMARY_COMMENT=1` is documented in api.md/DESIGN §17.1; not added to `.env.example` because it is an opt-in flag with a safe default | no impact |

Status: DOCKED
