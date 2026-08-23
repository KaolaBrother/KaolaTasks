# Tests #20 — structured claim `clone` recipe (RED on current production)

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`  
Baseline: `0c2d15d53d6ce41b82fd8aa2ebf6028c019b1d50` (`0c2d15d`)  
No production edits. No commit.

## Files changed

- `apps/server/src/claim.test.ts`
- `apps/server/src/mcp.test.ts`
- `apps/server/src/claim-confirm.test.ts`

Local `CLONE_TOKEN_USAGE` copies left verbatim (same sentence as `claim.ts`).  
`assertClaimRevealToken` not weakened.

## Helpers

Shared in all three files:

- `EXTRA_HEADER_BY_FORGE` — github/gitlab `Authorization` + `Bearer ${token}`; gitea `Authorization` + `token ${token}`
- `expectedCloneRemoteUrl(repo)` — strip trailing `/` from `repo.base_url`, then `'/' + full_name + '.git'`
- `assertCloneRecipe(clone, { suggestedDir, repo, forgePlaintext })` — four clone keys + extra_header two keys + hygiene

Callers:

- `assertClaim201` (REST) in `claim.test.ts` and `claim-confirm.test.ts`
- `assertClaimEnvelope` (MCP) in `mcp.test.ts` and `claim-confirm.test.ts`

`assertPending202` now also requires `clone` absent (token was already forbidden). MCP pending structuredContent in claim-confirm also asserts `Object.hasOwn(body, 'clone') === false`.

Session GET list/one and MCP `get_task_brief` assert no `clone` key on the brief (plus existing `assertBriefShape` / `assertNoForgeSecretMaterial`).

## Expected clone shape (success REST 201 / MCP `claim_task`)

Outer keys (sorted): `clone`, `lease`, `task`, `token`.

`clone` keys (sorted): `extra_header`, `remote_url`, `suggested_dir`, `token_usage`.

| key | pin |
|-----|-----|
| `suggested_dir` | equals `task.repo.suggested_dir` |
| `token_usage` | local `CLONE_TOKEN_USAGE` (unchanged sentence) |
| `remote_url` | `strip_trailing_slash(base_url) + '/' + full_name + '.git'`; no `@` / forge plaintext; not `api.github.com`; not `%2F` |
| `extra_header` | exactly `{ name, value_pattern }`; `value_pattern` contains literal `${token}`, not forge plaintext |

Gitea fixtures (`https://gitea.forge.example.test` + `team/orders`) therefore expect:

- `remote_url`: `https://gitea.forge.example.test/team/orders.git`
- `extra_header`: `{ name: 'Authorization', value_pattern: 'token ${token}' }`

## `it(` names added

REST (`claim.test.ts`):

- `claiming a github task returns Bearer extra_header and a web-origin remote_url, not api.github.com`
- `claiming a gitlab subgroup task keeps slashes in remote_url and uses Bearer extra_header`
- `claim remote_url strips trailing slashes from stored repo.base_url`

MCP (`mcp.test.ts`):

- `claim_task on a github task returns Bearer extra_header and github.com remote_url, not api.github.com`
- `claim_task on a gitlab task returns Bearer extra_header and keeps slashes in remote_url`

Trailing-slash case: publish **did** store `base_url` with a trailing `/` (the test reached `assertClaim201`, it did not skip). Expected remote after strip: `https://gitea.forge.example.test/team/orders.git`.

GitLab subgroup fixture: `group/subgroup/app` → `https://gitlab.forge.example.test/group/subgroup/app.git`.

Existing success-claim tests now fail via the shared helpers (right reason: two-key clone). Existing `202` / list / get / six-tool tests still pass.

## RED run (exit non-zero is success for this mission)

Command (worktree root):

```
node --experimental-strip-types --test apps/server/src/claim.test.ts apps/server/src/mcp.test.ts apps/server/src/claim-confirm.test.ts
```

Result: **exit 1**. `64` tests, **46 pass / 18 fail**. All 18 fails are the same clone key-set assertion.

```
RED: claiming an inline task returns 201 with task, forge token, lease TTL, and clone guidance
AssertionError: actual ['suggested_dir', 'token_usage']
           expected ['extra_header', 'remote_url', 'suggested_dir', 'token_usage']
at assertCloneRecipe → assertClaim201
baseline: 0c2d15d53d6ce41b82fd8aa2ebf6028c019b1d50
```

Same signature for MCP:

```
RED: claim_task success envelope keys are exactly task, token, lease, clone with the REST clone pin
AssertionError: actual ['suggested_dir', 'token_usage']
           expected ['extra_header', 'remote_url', 'suggested_dir', 'token_usage']
at assertCloneRecipe → assertClaimEnvelope
```

Representative stack (claim-confirm instructed 201):

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    [
  -   'extra_header',
  -   'remote_url',
      'suggested_dir',
      'token_usage'
    ]

      at assertCloneRecipe (.../claim-confirm.test.ts:567:10)
      at assertClaim201 (.../claim-confirm.test.ts:601:3)
    actual: [ 'suggested_dir', 'token_usage' ],
    expected: [ 'extra_header', 'remote_url', 'suggested_dir', 'token_usage' ],
```

Full captured log: `kaola-workflow/bundle-20-21/.cache/tests-20-run.txt`.

## Kept green (contract still holds on current production)

- MCP `tools/list` still exactly six tools; `claim_task` description still includes `CLONE_TOKEN_USAGE`
- `list_tasks` / `get_task_brief` / session GET after claim: no token, no `clone` on the brief
- `202 confirmation_required` REST and MCP pending: no token, no clone
- `assertClaimRevealToken` still walks nested `task` / `lease` / `clone` (literal `${token}` would be allowed; interpolating plaintext would not)

Implementer: thicken `claimTask` clone only (`claim.ts`); MCP already reuses that body. Do not author tests.

## GREEN run (after production)

Command (worktree root, same as RED):

```
node --experimental-strip-types --test apps/server/src/claim.test.ts apps/server/src/mcp.test.ts apps/server/src/claim-confirm.test.ts
```

Result: **exit 0**. `64` tests, **64 pass / 0 fail**. Duration ~671ms.

Production: `apps/server/src/claim.ts` only. See `impl-20.md`.