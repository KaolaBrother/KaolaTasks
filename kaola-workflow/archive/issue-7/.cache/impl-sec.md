# impl-sec — POST /api/v1/tasks security-review repair (issue #7)

**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`
**Verification tier:** `tests-green`

I wrote production code only. I did not create, modify, weaken, delete, or skip any `*.test.ts`.

---

## task

Make `apps/server/src/tasks.ts` satisfy the 10 RED security tests in `apps/server/src/tasks.test.ts` (F1 profile-to-repo binding before `decryptToken`, F2 `repo.base_url` scheme+host, F3 `token 揭示` audit on profile decrypt including 422/502). Honour `tests-sec.md` pinned Chinese strings and details shape.

## verification tier

`tests-green`

## files changed

- `apps/server/src/tasks.ts` only (worktree path: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7/apps/server/src/tasks.ts`)

No other files were written. `insertAuditEvent` was already imported from `./vault.ts`.

What landed in the POST handler:

1. Parse body (unchanged `readRepo` — any non-empty `base_url` string still parses).
2. Dedicated F2 check `isHttpOrHttpsUrlWithHost`: `new URL` must succeed, protocol `http:` or `https:`, non-empty `hostname`. Pinned 400 `{ error: 'invalid_body', message: '仓库地址不是合法的 http 或 https 地址。' }`. No fetch. RFC1918 / loopback not blocked (`http://127.0.0.1` remains legal). `file://example.com/tmp` is rejected by the scheme allowlist even though Node keeps a host.
3. Profile path: missing row still `'所选凭证档案不存在。'`. Exact `===` of `repo.forge` / `repo.baseUrl` / `repo.fullName` vs `profile.forge` / `profile.baseUrl` / `profile.repoFullName` **before** `decryptToken`. Mismatch: pinned 400 `{ error: 'invalid_body', message: '所选凭证档案与仓库不匹配。' }` — no decrypt, no `token 揭示`, no outbound fetch carrying the token.
4. After a successful profile `decryptToken`, one `insertAuditEvent` on 201 / 422 / 502 with `type: 'token 揭示'`, `actorUserId` = poster, details exactly `{ profile_id, forge, base_url, full_name, outcome }` where `outcome` is `'ok'` | `'token_check_failed'` | `'forge_unreachable'`. Omit `agent_key_id`. No token plaintext/ciphertext. Inline-token path writes none. F1 mismatch writes none.

## verification commands + exit codes

```
$ cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7
$ CI=true node --experimental-strip-types --test apps/server/src/tasks.test.ts
exit 0

ℹ tests 69
ℹ suites 16
ℹ pass 69
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 481.698291
```

Did not run `pnpm install`. Did not commit.

## before (baseline)

From `tests-sec.md` / `tests-sec-baseline.txt` (subject: uncommitted `tasks.ts` before this repair):

```
$ cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7
$ CI=true node --experimental-strip-types --test apps/server/src/tasks.test.ts
ℹ tests 69
ℹ suites 16
ℹ pass 59
ℹ fail 10
```

The 10 failures were exactly the new security-review tests (F1×3, F2×4, F3×3). Original 59 stayed green.

## after

```
$ CI=true node --experimental-strip-types --test apps/server/src/tasks.test.ts
exit 0
ℹ tests 69
ℹ pass 69
ℹ fail 0
```

All 10 security-review tests now pass. Original 59 still pass.

## findings

**No test is defective vs `tests-sec.md`.** Every assertion was satisfiable by writing the behaviour the spec describes. I did not edit `tasks.test.ts`.

Verified Node 22 URL parse (not assumed): `file://example.com/tmp` keeps hostname `example.com` with protocol `file:`; `javascript:alert(1)` parses with empty host; `gitea.example` and `https:///` throw `Invalid URL`; `http://127.0.0.1` is http + non-empty host.
