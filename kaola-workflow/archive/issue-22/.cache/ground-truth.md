# Ground truth: issue #22 vs `workflow/issue-22` @ `2ce443a`

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-22`  
Issue body is the contract (comment 2 voids earlier comments). Measured from source, not from the first explorer draft (that draft mixed invented `apps/server` paths).

## Already true in code

`apps/server/src/claim.ts` success `201` body keys exactly `task`, `token`, `lease`, `clone`.

`clone` four keys (do not rename):

- `suggested_dir` = `brief.repo.suggested_dir`
- `token_usage` = `CLONE_TOKEN_USAGE` export: `token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。`
- `remote_url` = `{base_url stripped}/{full_name}.git`
- `extra_header` = `{ name, value_pattern }` with literal `${token}` (gitea `token ${token}`, else `Bearer ${token}`)

Plaintext is only top-level `token`. Decrypt is the claimed row (inline or that row’s profile).

MCP `claim_task` (`apps/server/src/mcp.ts`) returns the same success body. `list_tasks` / `get_task_brief` use `taskBrief` — no `token`, no `clone`. Session GET list/get same. `202` confirmation body has no `token` / `clone` (`claim-confirm.test.ts` already asserts this).

Reveal channels unchanged: REST claim `201` and MCP `claim_task` success only.

## Tests already pin

`claim.test.ts` / `mcp.test.ts` / `claim-confirm.test.ts`: envelope keys, clone four keys, three-forge `extra_header`, `CLONE_TOKEN_USAGE` sentence, list/brief/session GET have no token, `202` has no token/clone, same `publicId` second claim is 409.

Inline vs profile are **separate** tests. **No** test claims two different `publicId`s in one case and asserts two different `token` values.

## Docs vs #22 D

README「Agent 怎么接单」committed `mcpServers` example includes `headers.Authorization: Bearer ktk_…` (Agent Key placeholder). #22 B wants **URL only**. Does not teach env inject (`KAOLA_AGENT_KEY` → user-level `~/.cursor/mcp.json`). Does not say MCP 平时无仓库钥匙 / 换任务换 token. Does **not** tell anyone to put a forge PAT in MCP headers.

DESIGN.md §7 already documents reveal-on-claim, clone four keys, extra_header table, 202 has no clone/token. Missing the dedicated user-model sentences (#22 opening).

docs/api.md claim envelope already matches the four-key clone. Missing the same user-model sentences.

`docs/smoke-test.md` at HEAD `2ce443a` already records the model. It is **reference only** — not in #22 D’s required list.

## Missing code

None for envelope / per-task decrypt / reveal channels. Optional local mcp.json writer (“可以做”) is not an acceptance checkbox.

## CLONE_TOKEN_USAGE copies

Canonical export `claim.ts`. Local string copies in `claim.test.ts`, `mcp.test.ts`, `claim-confirm.test.ts` (do not change the sentence).
