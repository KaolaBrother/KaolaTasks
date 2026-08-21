# tests-sec — security-review repair pins for `POST /api/v1/tasks` (issue #7)

**Role:** tdd-guide. Tests only. `tasks.ts` / `schema.ts` / `db.ts` / `app.ts` / web / docs / package.json were not written.

**Artifact:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7/apps/server/src/tasks.test.ts`
(new `describe('POST /api/v1/tasks — security-review repair (profile binding / base_url / audit)')` plus helpers `recordOutboundFetch`, `assertOutboundCarriesNoPlaintext`, `tokenRevealEvents`, `profileCiphertext`, `publishRevealDetails`. `beginFetch` is unchanged.)

**Wired into:** already in the worktree test command (same file as the existing 59).

**Baseline:** `b8f27d91d4e8b17c9e2120b41244e5ea7dc81a48`
plus uncommitted worktree `apps/server/src/tasks.ts` (the subject these tests fail against). Other uncommitted files (`app.ts`, `schema.ts`, `db.ts`, web, DESIGN, lockfile) were already present; this role did not touch them. Concurrent web edits to `apps/web/src/App.vue` were left alone.

**Verbatim RED capture:** `kaola-workflow/issue-7/.cache/tests-sec-baseline.txt`

```
$ cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7
$ CI=true node --experimental-strip-types --test apps/server/src/tasks.test.ts
ℹ tests 69
ℹ suites 16
ℹ pass 59
ℹ fail 10
```

**Original 59 still pass. All 10 new tests fail.** Not one new test is green on this `tasks.ts`.

---

## 1. New test names

### F1 — profile-to-repo binding
1. `gitlab profile + gitea request is 400 before decrypt and never sends the plaintext token`
2. `matching forge and full_name with an attacker base_url is 400 before decrypt`
3. `matching forge and base_url with a different full_name is 400 before decrypt`

Matching-profile 201 is already covered by the existing profile-path tests; no extra happy-path test.

### F2 — `repo.base_url` scheme+host
4. `POST with repo.base_url a file: URL returns 400 invalid_body before any forge fetch`
5. `POST with repo.base_url a javascript: URL returns 400 invalid_body before any forge fetch`
6. `POST with repo.base_url a missing scheme returns 400 invalid_body before any forge fetch`
7. `POST with repo.base_url an empty host returns 400 invalid_body before any forge fetch`

### F3 — audit when a stored profile is decrypted
8. `a matching profile 201 writes token 揭示 with pinned details; an inline token does not`
9. `a profile-path 422 still writes token 揭示 (plaintext already left the process)`
10. `a profile-path 502 still writes token 揭示 (plaintext already left the process)`

Existing `statusTransitionEvents` still filters `type === '状态迁移'` only. Adding `token 揭示` rows will not break those tests.

---

## 2. Pinned request / response shapes and Chinese strings

### Shared constants (character-for-character)

```
PROFILE_REPO_MISMATCH_MESSAGE = '所选凭证档案与仓库不匹配。'
REPO_BASE_URL_INVALID_MESSAGE = '仓库地址不是合法的 http 或 https 地址。'
TOKEN_REVEAL_EVENT            = 'token 揭示'
```

House idiom: full-width period `。`, no token material. Same pattern as `'所选凭证档案不存在。'`.

F1 and F2 error bodies are **exactly two keys**:

```json
{ "error": "invalid_body", "message": "<pinned Chinese>" }
```

HTTP `400`. No task row. Response must not contain plaintext (asserted via `assertNoTokenMaterial`).

### F1 requests

Binding is **exact string match** of all three: `repo.forge === profile.forge`, `repo.base_url === profile.base_url`, `repo.full_name === profile.repo_full_name`. On any mismatch, reject **before** `decryptToken`. No outbound fetch may carry the victim plaintext (URL / `Authorization` / `PRIVATE-TOKEN`). No `token 揭示` row.

**Forge mismatch (PoC shape).** Profile:

```json
{ "forge": "gitlab", "base_url": "https://gitlab.internal.example", "repo_full_name": "team/orders", "token": "glpat-VICTIM-SHARED-SECRET-9f3a" }
```

POST `/api/v1/tasks`:

```json
{
  "title": "harvest",
  "repo": { "forge": "gitea", "base_url": "http://attacker.example", "full_name": "anything/at-all" },
  "credential": { "profile_id": <id> }
}
```

(`taskPayload` also fills the usual §6 fields.) Lying about forge is load-bearing: GitHub PATs are only pinned to `api.github.com` when the request says `github`.

**base_url mismatch.** Profile = default gitea + `https://gitea.forge.example.test` + `team/orders` + `PROFILE_TOKEN`. Request repo:

```json
{ "forge": "gitea", "base_url": "http://attacker.example", "full_name": "team/orders" }
```

**full_name mismatch.** Same default profile. Request repo:

```json
{ "forge": "gitea", "base_url": "https://gitea.forge.example.test", "full_name": "anything/at-all" }
```

Forge token is stubbed so a missing binding currently yields **201** (the attack looks like a normal post). After the fix this must be 400 without that fetch.

### F2 requests

Inline-token path (F2 survives F1). After login, wrap fetch and POST with `credential: { token: INLINE_TOKEN }` and:

| label | `repo.base_url` |
|---|---|
| file: | `file://example.com/tmp` |
| javascript: | `javascript:alert(1)` |
| missing scheme | `gitea.example` |
| empty host | `https:///` |

Must 400 with `REPO_BASE_URL_INVALID_MESSAGE` **and** `outbound.length === 0` (no adapter/`fetch` after the POST starts). Existing tests using `https://gitea.forge.example.test` stay green. **Do not** reject RFC1918 / loopback; `http://127.0.0.1` remains legal (not pinned as a rejection).

### F3 `events` row (DESIGN §10 type `token 揭示`)

Written when the profile path **actually decrypts** a vault token for 发布即校验 — including when `validateToken` later returns 422 or 502. Not written on F1 mismatch. Not written on the inline-token path (nothing stored was revealed). Publish-time has no agent key: **omit `agent_key_id`**. Must not contain token plaintext or ciphertext.

Exact `details` JSON (flat; `profile_id` is the numeric PK, matching `vault.ts` `revealCredentialProfile`, not the brief's string form):

```json
{
  "profile_id": 1,
  "forge": "gitea",
  "base_url": "https://gitea.forge.example.test",
  "full_name": "team/orders",
  "outcome": "ok"
}
```

`outcome` values:

| HTTP | `outcome` |
|---|---|
| 201 | `"ok"` |
| 422 `token_check_failed` | `"token_check_failed"` |
| 502 `forge_unreachable` | `"forge_unreachable"` |

Also pinned: `actor_user_id` = poster, `created_at` unix seconds, `type` = `'token 揭示'`.

The inline negative is the second half of test 8: after a profile 201 (one reveal row), an inline 201 must leave `token 揭示` count at 1.

---

## 3. Numbered judgement calls

1. **F1 Chinese copy.** `'所选凭证档案与仓库不匹配。'` — one message for forge / base_url / full_name mismatch. No per-field oracle.
2. **F1 comparison.** Exact `===` on the three stored strings vs the request. Trailing-slash / case variants are mismatches; not extra-tested.
3. **F1/F2 body shape.** `deepEqual` to `{ error: 'invalid_body', message }` only — extra keys fail.
4. **F2 Chinese copy.** `'仓库地址不是合法的 http 或 https 地址。'`
5. **F2 `file:` value.** `file://example.com/tmp`, not `file:///etc/passwd`. Node 22's URL parser empties the host on `file://localhost/...`; a hostful `file:` URL makes the **scheme allowlist** load-bearing (an empty-host-only check cannot green this case).
6. **F2 empty-host value.** `https:///`. In this Node, `new URL('https:///')` throws `Invalid URL` (no parseable http(s)+empty-host string). Reject-via-parse-failure still satisfies “before any fetch”.
7. **F2 does not pin a private-IP / RFC1918 block.** No test requires rejecting `http://127.0.0.1`. (A standalone “loopback is allowed” test would be green on the baseline and was not shipped.)
8. **F3 details shape.** Flat `{ profile_id, forge, base_url, full_name, outcome }`. Not a nested `repo` object. `profile_id` is a JSON number (PK). No `agent_key_id` (do not invent 0).
9. **F3 `outcome` strings.** `'ok'` / `'token_check_failed'` / `'forge_unreachable'` — the last two match the existing HTTP `error` field.
10. **F3 inline negative.** Bundled into the 201 test. A standalone “inline writes no token 揭示” test is already true on current `tasks.ts` and would prove nothing.
11. **F1 “no token 揭示”.** Conjunct on the three F1 tests (those tests fail on 201≠400 today). Same green-trap reason.
12. **Event type.** DESIGN §10 existing `'token 揭示'`. No new type.

---

## 4. Failure signatures (RED on this baseline)

Subject: uncommitted `apps/server/src/tasks.ts` at worktree `b8f27d91d4e8b17c9e2120b41244e5ea7dc81a48`.

```
RED: gitlab profile + gitea request is 400 before decrypt and never sends the plaintext token
     AssertionError: POST: 201 {...,"repo":{"forge":"gitea","base_url":"http://attacker.example","full_name":"anything/at-all",...}}
     201 !== 400

RED: matching forge and full_name with an attacker base_url is 400 before decrypt
     AssertionError: POST: 201 {...,"repo":{"forge":"gitea","base_url":"http://attacker.example","full_name":"team/orders",...}}
     201 !== 400

RED: matching forge and base_url with a different full_name is 400 before decrypt
     AssertionError: POST: 201 {...,"repo":{"forge":"gitea","base_url":"https://gitea.forge.example.test","full_name":"anything/at-all",...}}
     201 !== 400

RED: POST with repo.base_url a file: URL returns 400 invalid_body before any forge fetch
     AssertionError: POST with a file: URL (file://example.com/tmp): 201 {...}
     201 !== 400

RED: POST with repo.base_url a javascript: URL returns 400 invalid_body before any forge fetch
     AssertionError: POST with a javascript: URL (javascript:alert(1)): 201 {...}
     201 !== 400

RED: POST with repo.base_url a missing scheme returns 400 invalid_body before any forge fetch
     AssertionError: POST with a missing scheme (gitea.example): 201 {...}
     201 !== 400

RED: POST with repo.base_url an empty host returns 400 invalid_body before any forge fetch
     AssertionError: POST with an empty host (https:///): 201 {...}
     201 !== 400

RED: a matching profile 201 writes token 揭示 with pinned details; an inline token does not
     AssertionError: expected one token 揭示 after profile publish, got [{"type":"变更",...}]
     0 !== 1

RED: a profile-path 422 still writes token 揭示 (plaintext already left the process)
     AssertionError: expected one token 揭示 after 422, got [{"type":"变更",...}]
     0 !== 1

RED: a profile-path 502 still writes token 揭示 (plaintext already left the process)
     AssertionError: expected one token 揭示 after 502, got [{"type":"变更",...}]
     0 !== 1
```

F1/F2 fail because current `readRepo` / `readCredential` never bind the profile to the repo and never validate scheme/host, so 发布即校验 runs (stub answers by token) and the handler returns 201. F3 fails because `POST /api/v1/tasks` never calls `insertAuditEvent` on decrypt.

---

## 5. Original 59 still pass

```
ℹ tests 69
ℹ pass 59
ℹ fail 10
```

The 10 failures are exactly the new security-review tests. `statusTransitionEvents` was not widened.

---

## 6. Out of remit

`tasks.ts` was not implemented. The implementer must: bind profile→repo (all three strings) before `decryptToken`; reject non-http(s) / empty-host `repo.base_url` before any adapter/`fetch`; write `token 揭示` with the pinned details when a stored profile is decrypted for 发布即校验 (including 422/502), omit it on F1 mismatch and on the inline path.
