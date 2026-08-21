# Security review — bundle-8-17 (#8 board UI + #17 single-port hosting)

Reviewer: security-reviewer. Read-only. Product files were not edited. The only write is this file.

**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17` (uncommitted delta on `workflow/bundle-8-17` @ `190a79aa`).

**Scope (candidate-caused only):**
1. HTML sinks in `apps/web/src/App.vue` (title / `description_md` / `source.issue_url` / credential chrome).
2. Static + SPA fallback + Vite proxy in `apps/server/src/app.ts` `buildApp({ webDist, viteDevTarget })`.
3. New deps `@fastify/static` ^10.1.3 and `@fastify/http-proxy` ^11.6.0 (lockfile 10.1.3 / 11.6.0).

**Method:** full read of the hosting/board delta, `@fastify/static` 10.1.3 `getPathnameForSend` / `pumpSendToReply`, `@fastify/http-proxy` 11.6.0 + `reply-from` `buildURL`. Then live probes against real `buildApp()`: `inject`, raw HTTP/1.1 sockets (so `..` is not collapsed by the injector), and the same `boardIssueUrlIsHttp` predicate the template uses. No repository file was modified.

**Orchestrator rulings honoured:** `javascript:` must not become `href`; `viteDevTarget` is operator env, not a user-controlled upstream; do not re-open #7 OAuth `scope=undefined`, RFC1918 `repo.base_url`, or GitLab auto-full.

**Verdict: PASS.** No candidate-caused finding. A clean review is the measured outcome, not a withheld one.

---

## Admitted findings

None.

---

## Checked and clean — board HTML sinks (`App.vue`)

These were examined because #7 left a reminder that `description_md` / `source.issue_url` become interesting once rendered, and because this run is the first renderer.

- **No `v-html`, no `innerHTML`, no markdown package.** Title, description, status, poster, tags, forge, timeline copy, and card titles all go through Vue `{{ }}` / `<n-text>` (text vnodes). Naive UI select menus in this tree do not use `v-html`/`innerHTML` for option labels. XSS fixtures of the form “HTML in title/description” remain text; they do not grow `script` / `img` nodes.

- **`javascript:` does not become `href`.** Gate is `apps/web/src/App.vue:504-509`: `trim().toLowerCase()` then `startsWith('https:') || startsWith('http:')`. Only then is the raw string bound at `:href` (`App.vue:100-104`). Measured:

  | input class | becomes `<a href>`? | WHATWG protocol (base `http://localhost:31415/board`) |
  |---|---|---|
  | `javascript:…`, mixed-case, leading/trailing space, tab, newline | no (text) | `javascript:` |
  | leading NUL + `javascript:` | no (text) | parser yields `javascript:` after trim-equivalent; template still takes the `v-else` branch |
  | `ftp:`, `data:`, `vbscript:`, `file:`, protocol-relative `//host` | no (text) | native schemes / http via base for `//` — but the gate never promotes them to `href` |
  | normal `http(s)://…`, mixed-case `HTTPS://` | yes | `http:` / `https:` as intended |

  Because the `v-if` is false, Vue never writes a `javascript:` attribute. This is the sink #7 warned about; this change does **not** create it.

- **`http:` without `//` is syntactically loose and still not a JS sink.** `http:alert(1)`, `HTTP:alert(1)`, `http:javascript:alert(1)` pass the prefix check (they do start with `http:`). Node 22 `URL` resolves them as **`http:`** (same-origin path `/alert(1)` or `/javascript:alert(1)` against the page base), not `javascript:`. `https:alert(1)` parses as host `alert(1)` under `https:`. Clicking such a link is odd navigation / SPA fallback, not script execution. The product ruling asked for “`http:` or `https:` only”, not `new URL` + non-empty hostname. Not filed.

- **Token secrecy on the board holds.** `credentialChrome` (`App.vue:495-498`) returns only `共享档案` / `单任务临时 token`. The template never interpolates `token`, `token_encrypted`, ciphertext, or the brief JSON. `BoardTask.credential` is the DESIGN §6 reference union. Agent-key plaintext after create and the password inputs on the publish form are pre-existing #5/#6 UI, not board rendering of forge tokens.

---

## Checked and clean — static / SPA / proxy (`app.ts`)

- **`reply.sendFile` is not request-controlled.** Both call sites pass the literal `'index.html'` (`app.ts:54-55`, `app.ts:58-59`) into `@fastify/static`'s root (`resolve(webDist)`). Traversal via `sendFile` would require attacker input in that argument; there is none.

- **`@fastify/static` 10.1.3 does not read outside `webDist`.** Plugin rejects `..`, `%2e%2e`, duplicate slashes, and other non-canonical forms (`dotDotSegmentRegex` / `isNonCanonicalPathname`) with 403. Raw HTTP (not `inject`) against a real listener:

  | request-target | status | body |
  |---|---|---|
  | `/assets/app.js` | 200 | the dist asset |
  | `/foo/../assets/app.js` | 403 Forbidden | no file |
  | `/assets/../../../../../../etc/passwd` | 403 | no passwd |
  | `/%2e%2e/%2e%2e/etc/passwd` | 403 | no passwd |
  | `//api/v1/me`, `/./api/v1/me` | 403 | not SPA, not API |

  `inject` collapses some `..` forms before the handler (e.g. `/foo/../assets/app.js` → 200 asset); that is an injector artefact. The socket is the one that matters; it 403s and never returned `OUTSIDE_WEB_DIST_SECRET` or passwd content.

- **SPA fallback does not swallow `/api` or `/login`.** `isApiOrLoginPath` (`app.ts:21-24`) uses path-without-query, exact `/api`, prefix `/api/`, prefix `/login`. Measured on `webDist`:

  | GET | result |
  |---|---|
  | `/` and `/some/deep/path` | 200 `index.html` |
  | `/api`, `/api/`, `/api/v1/no-such` | JSON 404, not SPA |
  | `/api/v1/me` (Accept json) | 401 `{error:unauthorized}` |
  | `/login` | auth HTML (`考拉任务登录`), not SPA |
  | `/login/github` | 302 to GitHub authorize |
  | POST `/some/deep/path` | JSON 404 (SPA is GET-only) |
  | `/%61pi/v1/me` | 401 API (`/api` after decode), not SPA |

  Unauthenticated `/api/v1/me` without `Accept: application/json` is 302 `/login` (`auth.ts:317-323` `wantsJson`); that handler is pre-existing and is not the SPA 404.

- **`viteDevTarget` is not request-controlled SSRF.** Upstream is `buildApp` / `process.env.VITE_DEV_TARGET` only (`index.ts:3-6`). `@fastify/reply-from` `buildURL` rejects absolute sources that leave the operator origin (`source must be a relative path string`) and rejects `..`. Raw absolute-form `GET http://127.0.0.1:9/steal` and `GET http://example.invalid/steal` against the proxy returned 500 with that message and **zero** hits on a loopback sink — not a connect to port 9, not a DNS fetch. Protocol-relative `//host` is rewritten onto the operator upstream (`http://127.0.0.1:<vite>//host/...`), which is the library's documented anti-override behaviour. `httpMethods: ['GET','HEAD']` (`app.ts:71`) so POST is not forwarded. `preHandler` + more-specific routes keep `/api/v1/me` and `/login` off the upstream (upstream hit count 0).

- **New deps are the patched lines, not the vulnerable ones.** Lockfile pins `@fastify/static@10.1.3` (GHSA-423g-23ch-w7c6 / CVE-2026-18427 non-canonical guard bypass is `< 10.1.3`) and `@fastify/http-proxy@11.6.0` (GHSA-mx7v-qhg9-2mvv / GHSA-7hrw-592w-9wh2 prefix-escape, patched in 11.6.0). This app does not use `rewritePrefix` to hide an upstream subtree, and does not use route-based guards in front of a static subtree, so those CVE classes are extra-defence rather than a close call. Directory listing is off (`list` unset). `scripts/dev.mjs` binds Vite to `127.0.0.1:5173 --strictPort`. Docker image sets `WEB_DIST` and does not set `VITE_DEV_TARGET`, so production takes the static branch.

---

## Residual / pre-existing (not blocking, not re-opened)

- **#7 leftovers, unchanged by this delta:** OAuth `scope=undefined` on the GitHub authorize URL; RFC1918 / loopback still allowed on `repo.base_url` for 发布即校验; GitLab/Gitea login still auto-`active`+`full`. Observed in the `/login/github` Location during hosting probes; out of scope per dispatch.

- **`source.issue_url` is still stored verbatim** (`tasks.ts` `readSource` — any non-empty string). The board now refuses to promote non-`http(s):` values to `href`, which is the renderer half of the #7 note. A stored `javascript:` URL remains visible as **escaped text**. Tightening POST validation to the same `isHttpOrHttpsUrlWithHost` used for `repo.base_url` would be a later hardening, not a hole this UI opened.

- **`description_md` as prompt-injection into a future claiming agent** is DESIGN §7's 提示注入 warning. This run renders it as text to humans. That is the task brief, not an HTML sink.

- **Dev-only Vite filesystem through the public Fastify port.** When `VITE_DEV_TARGET` is set (`pnpm dev` does this) and `HOST` stays `0.0.0.0` (pre-existing default), GET `/@fs/...` is forwarded to localhost Vite. The upstream is still operator env; the path is request-chosen on that upstream. Production `WEB_DIST` does not proxy. Not classified as user-controlled SSRF.

- **Session cookie `secure: false`** — pre-existing #5; deployment/TLS.

---

finding: none

verdict: pass
findings_blocking: 0

review_conclusion: The board interpolates untrusted title/description as text and promotes issue_url to href only after an http(s) prefix check that, when measured, never emits a javascript: attribute. Hosting serves dist from a resolved root with request-path traversal rejected by @fastify/static 10.1.3; SPA fallback is GET-only and skips /api and /login; the Vite proxy's upstream is operator env and reply-from rejects absolute-form overrides. New deps are the CVE-patched releases. No candidate-caused issue to fix before merge.
