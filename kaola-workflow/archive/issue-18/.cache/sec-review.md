# Security review — issue #18 (Eucalyptus Ink workbench)

role: security-reviewer
candidate: worktree /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-18, branch workflow/issue-18, uncommitted working tree vs HEAD ancestor be2d963
production surface reviewed:
- apps/web/index.html (modified)
- apps/web/src/main.ts (modified)
- apps/web/src/App.vue (modified, 906 insertions / 394 deletions)
- apps/web/src/theme.ts (new, 137 lines)
- apps/web/src/theme.css (new, 681 lines)
non-production, read for secret material only: apps/web/src/App.shell.test.ts (new)
corroborating server files read (unchanged by candidate): apps/server/src/tasks.ts, apps/server/src/auth.ts

verdict: pass
findings_blocking: 0

## Admitted findings

None. No candidate-caused security defect was admitted.

## Verification record

### 1. New client PATCH /api/v1/tasks/:publicId

Anchor: apps/web/src/App.vue:1456-1477 (`patchTaskStatus`), callers at apps/web/src/App.vue:190-204.

Endpoint-surface delta confirmed by enumerating every `fetch(` target in the candidate against the
same enumeration on `git show HEAD:apps/web/src/App.vue`. Exactly one new target appears:
`` fetch(`/api/v1/tasks/${task.id}`) `` with `method: 'PATCH'`. All 14 other targets are byte-identical
to baseline.

- Auth material: `credentials: 'include'` only. No `Authorization` header, no bearer key, no forge
  token, no agent key is attached anywhere in the new call. Headers are exactly
  `{ Accept: 'application/json', 'Content-Type': 'application/json' }`.
- Request body: `JSON.stringify({ status })` where `status` is the literal `'已取消'` or `'待认领'`
  supplied at the two call sites and constrained by the parameter type
  `status: '已取消' | '待认领'`. No user-supplied or token-bearing field can enter the body.
- Server contract unchanged and not bypassed. apps/server/src/tasks.ts:750-795 enforces, in order:
  `getSessionUser` (401 on absent session), `canPostTasks(user)` (403), row existence (404),
  `row.task.posterUserId !== user.id` (403), `readStatusBody` zod parse (400), and
  `nextPosterStatus` against the shared lifecycle graph (409). The client's `canPosterCancel` /
  `canPosterReopen` computeds (apps/web/src/App.vue:900-916) are chrome only and are strictly
  narrower than the server checks, so no path exists where the new client reaches a transition the
  server would reject.
- Response handling: the success path calls `applyBriefUpdate(body)` only. The server returns
  `taskBrief(...)` (apps/server/src/tasks.ts:794), whose `credential` projection is
  `{ inline: true }` or `{ profile_id: String(...) }` (apps/server/src/tasks.ts:404-407) and which
  carries no token field at all.
- Error surface: on `!res.ok` the client renders `body.message` when it is a string, else
  `操作失败（<status>）`. The only `message` the PATCH route emits is
  `illegalTransitionMessage(from, requested)`, i.e. two lifecycle status names; 401/403/404/400
  return an `error` code with no `message`, so the fallback numeric string is shown. No credential,
  token, session value, or stack detail can reach the UI through this path.
- CSRF: the session cookie is registered `httpOnly: true, sameSite: 'lax'`
  (apps/server/src/auth.ts:266). A cross-site `PATCH` is neither a top-level navigation nor a simple
  request, so `Lax` withholds the cookie and the `application/json` content type forces a preflight.
  No new exposure, and the setting is pre-existing and untouched.

### 2. Credential chrome and JSON-to-DOM projection

Anchors: apps/web/src/App.vue:804-807 (`credentialModeOptions`), 1026-1029 (`credentialChrome`),
1110-1121 (`asCredential`), 1123-1158 (`asBoardTask`), 177 (render site).

- `credentialModeOptions` labels remain exactly `共享档案` and `单任务临时 token`. `credentialChrome`
  returns exactly one of those two constant strings and never interpolates any value from the
  credential object, so the rendered credential cell is a constant regardless of response content.
- `asCredential` is allow-listing, not merging: it reads only `inline` and `profile_id`, returns
  freshly constructed literals `{ inline: true }` / `{ profile_id: <string> }`, and falls back to the
  caller-supplied prior credential. There is no spread, no `Object.assign`, and no dynamic key copy,
  so a `token` key present on incoming JSON cannot survive into the model.
- `asBoardTask` likewise constructs an explicit 10-key object literal (`id`, `title`,
  `description_md`, `source`, `repo`, `tags`, `poster`, `status`, `created_at`, `credential`,
  `priority`). `repo` is narrowed to `{ forge }` alone, dropping `base_url` / `full_name`. No
  wildcard copy exists, so no extra field from `POST /api/v1/tasks`, `PATCH /api/v1/tasks/:publicId`,
  or `GET /api/v1/tasks` can reach the DOM. Confirmed at both call sites: `applyBriefUpdate`
  (App.vue:1160-1167) and the post-publish insertion (App.vue:1625-1634).

### 3. No new agent-claim / MCP / webhook / logout surface

The `fetch` target diff in section 1 is exhaustive: no `POST /api/v1/tasks/:publicId/claim`,
`/progress`, `/release`, no MCP route, no webhook route, no logout route was added. The
`claim-confirmations` approve/reject calls (App.vue:1263-1289) exist verbatim at baseline; the
candidate only threads an optional `event` argument into them to trigger `slideOutRow`, a
presentation-only helper (App.vue:1093-1108) that mutates `classList` and calls
`Element.animate` with constant keyframes. The trusted-automation switch still targets the
pre-existing `PUT /api/v1/me/settings`.

### 4. Approve-user surface

Anchor: apps/web/src/App.vue:514-524 (chrome), 1291-1320 (`approveUser`).

Still a single free-text input plus `` fetch(`/api/v1/users/${encodeURIComponent(id)}/approve`) ``
with `method: 'POST'`. `encodeURIComponent` is retained from baseline. No user-search or
user-enumeration endpoint was introduced. The only change is the placeholder copy, now
`GitHub 用户数字 id`.

### 5. XSS

- Zero occurrences of `v-html`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval(`, or
  `new Function` across all of `apps/web/src`. Verified by content search over the directory.
- `description_md` (App.vue:172), `title` (App.vue:144, 163, 171), `poster`, `status`, `tags`,
  `forge`, audit `details` JSON (App.vue:596-597) and stats usernames (App.vue:623) are all rendered
  through `{{ }}` mustache interpolation, which Vue escapes as text.
- `javascript:` issue URLs are still gated. `boardIssueUrlIsHttp` (App.vue:1035-1040) lowercases and
  trims before requiring an `http:` / `https:` prefix, and `:href` is bound only inside
  `v-if="boardIssueUrlIsHttp(selectedTask)"` (App.vue:183-187). A non-http scheme falls to the
  `<template v-else>` text branch. This logic is unchanged from baseline.
- Server-derived strings that reach attribute position are inert: `:data-priority="task.priority"`
  (App.vue:146, 165) lands in a `data-` attribute that theme.css reads only via the exact-match
  selectors `.slip-dot[data-priority='P0']` / `[data-priority='P1']` (theme.css:292, 296). All
  `:style` bindings carry numbers (`--i`, `--nav-index`, `--count-to`, `--count-now`) or
  `onRipple`-computed pixel offsets from `event.clientX/clientY` (App.vue:1078-1091).

### 6. Token input fields

Both remain `type="password"` with `show-password-on="click"`, matching baseline: the credential
profile token at apps/web/src/App.vue:487-494 and the inline task token at
apps/web/src/App.vue:352-359. Both are still cleared on success (`profileToken.value = ''` at
App.vue:1508, `taskCredentialToken.value = ''` at App.vue:1624). Neither is logged, placed in a URL,
or echoed back into the DOM.

### 7. Google Fonts link

Anchor: apps/web/index.html:7-12. Two `preconnect` hints plus one `css2` stylesheet for
`IBM Plex Mono`, `Noto Sans SC`, `Noto Serif SC`. The URL carries only public font family and weight
parameters; no identifier, session value, or credential is present. This is a third-party asset
dependency, not a secret leak, and matches the dispatch's stated expectation.

### 8. ensureRootTokens style injection

Anchor: apps/web/src/theme.ts:31-55.

`ensureRootTokens` iterates the module-level `cssTokens` constant map (theme.ts:16-29) whose keys and
values are all literal hex colors, durations, and one `cubic-bezier` easing. It writes via
`root.style.setProperty(name, next)` and `style.textContent = ...`. `textContent` assignment does not
parse markup, and no runtime, network, or user value participates in the concatenated declaration
string. The `document.getElementById('kaola-eucalyptus-tokens')` guard makes it idempotent. Not XSS,
consistent with the dispatch's stated expectation.

### 9. Privileged chrome and pane visibility

The pane wrappers use `v-show`, which keeps markup mounted, so gating was checked at the content
level rather than the pane level. Privileged blocks retain their own `v-if`: the publish pane carries
`v-if="canApprove"` on the wrapper itself (App.vue:227-233), and inside the keys pane the automation
and Agent Key blocks are `v-if="canManageKeys"` while the credential-profile and approve-user blocks
are `v-if="canApprove"` (App.vue:391, 392, 439, 440, 463, 464, 514, 515). No privileged content is
mounted into the DOM for an unauthorized member. `loadProfiles` / `loadAgentKeys` /
`loadClaimConfirmations` remain behind the same capability checks in `onMounted`
(App.vue:1220-1226). Audit and stats loading for every member is baseline behavior, unchanged.

### 10. Secret material in new files

No credential-shaped literal in apps/web/src/theme.ts, apps/web/src/theme.css, or
apps/web/src/App.shell.test.ts. In the test file, every `token` occurrence is either a CSS
custom-property helper (`tokenVar`, `--motion-fast`, `--paper`, `--leaf`) or a `data-testid`
assertion that the profile token field's `type` attribute equals `password`.

## Deferred non-blocking notes

- note: `patchTaskStatus` interpolates `task.id` into the request path without
  `encodeURIComponent`, unlike `approveUser` which encodes its id. Not admitted as a finding: the
  value originates from the server's own `public_id` allocator, which emits the fixed
  `kt-YYYY-NNNN` shape (apps/server/src/tasks.ts:435-449), and `asBoardTask` only ever populates
  `id` from a server response. Reaching a traversal payload would require the trusted API to be
  serving hostile data, which is outside the trust model the project establishes. Recorded as
  optional defense-in-depth symmetry with the neighboring call, not a reachable defect.
  Anchor: apps/web/src/App.vue:1461.
- note: `show-password-on="click"` on both token inputs permits on-screen reveal of a typed token.
  Pre-existing and unchanged by this candidate; recorded for visibility only.
  Anchors: apps/web/src/App.vue:357, apps/web/src/App.vue:492.
- note: the Google Fonts stylesheet adds a third-party runtime origin to the page's asset graph, and
  the app sets no Content-Security-Policy. This is an availability and supply-chain posture
  observation about an internal tool, not a candidate-caused security defect, and CSP absence is
  pre-existing. Anchor: apps/web/index.html:7-12.

review_conclusion: The candidate confines its only new network surface to a session-cookie PATCH that
carries no credential material and is fully gated server-side by poster ownership and the shared
lifecycle graph, while credential chrome stays constant, the JSON projection helpers allow-list
fields so no token can reach the DOM, all task-supplied text stays in escaped interpolation with
non-http issue URLs kept out of href, and the injected theme style is built entirely from module
constants, so I admit no security defect and record three non-blocking observations.
