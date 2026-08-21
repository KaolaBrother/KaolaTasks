# Investigation: dev-mode OAuth session cookie across the Vite proxy

## Claim under test

> "`PUBLIC_URL` defaults to `http://localhost:3000` and OAuth callback URLs are built from it. The
> Vite dev server runs the SPA on `:5173` and proxies `/api` to `:3000`. So an OAuth round trip
> initiated from the Vite origin may land the session cookie on `localhost:3000` while the SPA runs
> on `localhost:5173`, leaving the web UI permanently unauthenticated in dev."

## VERDICT: PARTIALLY TRUE — the premise is right, the stated consequence is FALSE

- **The cookie half is FALSE.** The session cookie is a host-only cookie for host `localhost` with
  no `Domain` and no port binding. It is sent to *both* `:3000` and `:5173`. Measured end-to-end: a
  session established at the `:3000` callback returns `200` with the user body from
  `http://localhost:5173/api/v1/me` through the proxy. The UI is **not** left unauthenticated.
- **The redirect half is TRUE.** The flow ends at `http://localhost:3000/`, which serves the Fastify
  placeholder `考拉任务服务占位` — not the SPA. The user is authenticated but ejected from the app.
- **A third, unclaimed failure mode is real:** opening the SPA at `http://127.0.0.1:5173` instead of
  `http://localhost:5173` *does* break auth, because `127.0.0.1` and `localhost` are different
  cookie hosts. This is a host mismatch, not a port mismatch.

## Setup

- Commit: `b8f27d91d4e8b17c9e2120b41244e5ea7dc81a48`
- Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`
- Node `v24.14.0`; Vite `v7.3.6`
- Ports 3000, 5173 and 4599 were free and were used as-is.
- Config measured against (`apps/web/vite.config.ts`, `server.proxy` block, byte-identical to HEAD;
  `tests-web` concurrently added a `test:` block that does not touch the proxy):

```ts
server: {
  proxy: {
    '/api': 'http://127.0.0.1:3000',
    '/login': 'http://127.0.0.1:3000',
  },
},
```

- Cookie attributes set by `registerAuth` (`apps/server/src/auth.ts:253-260`): session cookie
  `{ path: '/', secure: false, httpOnly: true, sameSite: 'lax' }`, `saveUninitialized: false`;
  the `@fastify/oauth2` state cookie is `{ path: '/' }`. **Neither sets a `Domain`.** That is why
  both are host-only cookies for whatever host the browser used.
- To complete a genuine callback round trip without contacting a real provider, a throwaway fake
  Gitea provider was run on `127.0.0.1:4599` (scratchpad only, no tracked file touched) and the
  server was started with `OAUTH_GITEA_BASE_URL=http://127.0.0.1:4599`. All other OAuth env values
  were dummies.

Server launch (secrets are dummies, not real credentials):

```
SESSION_SECRET='dev-probe-session-secret-must-be-at-least-32-chars-long' \
OAUTH_GITHUB_CLIENT_ID=... OAUTH_GITHUB_CLIENT_SECRET=... \
OAUTH_GITLAB_CLIENT_ID=... OAUTH_GITLAB_CLIENT_SECRET=... OAUTH_GITLAB_BASE_URL='https://gitlab.example.com' \
OAUTH_GITEA_CLIENT_ID='dummy-gitea-id' OAUTH_GITEA_CLIENT_SECRET='dummy-gitea-secret' \
OAUTH_GITEA_BASE_URL='http://127.0.0.1:4599' \
PORT=3000 HOST=0.0.0.0 SQLITE_PATH=<scratch>/probe.sqlite \
node --experimental-strip-types apps/server/src/index.ts
```

## Observations

| # | Measurement | Command | Result | Exit |
|---|---|---|---|---|
| A | `/login/github` direct | `curl -sS -i http://localhost:3000/login/github` | 302; `redirect_uri=http%3A%2F%2Flocalhost%3A3000%2F...` | 0 |
| B | `/login/github` via proxy | `curl -sS -i http://localhost:5173/login/github` | 302; **same** `redirect_uri` → `localhost:3000` | 0 |
| C1 | `/api/v1/me` direct, with session | `curl -sS -i -b jar -H 'Accept: application/json' http://localhost:3000/api/v1/me` | `200` + user JSON | 0 |
| C2 | `/api/v1/me` **via proxy**, with session | `curl -sS -i -b jar -H 'Accept: application/json' http://localhost:5173/api/v1/me` | **`200` + user JSON** | 0 |
| C3 | same, browser-style `Accept` | `curl -sS -i -b jar -H 'Accept: text/html,...' http://localhost:5173/api/v1/me` | `200` + user JSON | 0 |
| C4 | control, no cookie | `curl -sS -i -H 'Accept: application/json' http://localhost:5173/api/v1/me` | `401 {"error":"unauthorized"}` | 0 |
| D1 | same jar, host `127.0.0.1:5173` | `curl -sS -i -b jar -H 'Accept: application/json' http://127.0.0.1:5173/api/v1/me` | **`401`** | 0 |
| D2 | same jar, host `127.0.0.1:3000` | `curl -sS -i -b jar -H 'Accept: application/json' http://127.0.0.1:3000/api/v1/me` | **`401`** | 0 |
| E | unauth + browser `Accept`, via proxy | `curl -sS -i -H 'Accept: text/html,...' http://localhost:5173/api/v1/me` | `302 location: /login` (relative) | 0 |
| G | `/login` via proxy | `curl -sS -i http://localhost:5173/login` | `200 text/html`, server-rendered `登录 · 考拉任务` | 0 |

### Full OAuth round trip, initiated from the Vite origin (verbatim)

```
$ curl -sS -L -c jar -b jar -D - http://localhost:5173/login/gitea

HTTP/1.1 302 Found
Vary: Origin
location: http://127.0.0.1:4599/login/oauth/authorize?response_type=code&client_id=dummy-gitea-id&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Flogin%2Fgitea%2Fcallback&scope=undefined&state=vcQntm3tGwEJAMyplcDHgA
set-cookie: oauth2-redirect-state=vcQntm3tGwEJAMyplcDHgA; Path=/; HttpOnly; SameSite=Lax

HTTP/1.1 302 Found
location: http://localhost:3000/login/gitea/callback?code=fake-code&state=vcQntm3tGwEJAMyplcDHgA

HTTP/1.1 302 Found
location: /
set-cookie: sessionId=6kxuZ0VXorj9GGOtr9G5XSKH0nvsO4B-.dJ9wlDbAZ68MgiZkpkjl6aDYGfo+dqmjfEGglN2V7QE; Path=/; HttpOnly; SameSite=Lax

HTTP/1.1 200 OK
content-type: text/plain; charset=utf-8

>>> FINAL URL: http://localhost:3000/
>>> FINAL CODE: 200
>>> NUM REDIRECTS: 3

--- final body ---
考拉任务服务占位
```

Resulting cookie jar (Netscape format; column 1 is the cookie host, and note there is **no port**):

```
#HttpOnly_localhost	FALSE	/	FALSE	0	sessionId	6kxuZ0VXorj9GGOtr9G5XSKH0nvsO4B-...
#HttpOnly_localhost	FALSE	/	FALSE	0	oauth2-redirect-state	vcQntm3tGwEJAMyplcDHgA
```

Two facts are load-bearing here and both are *measured*, not reasoned:

1. The `oauth2-redirect-state` cookie was **set through the proxy at `:5173`** and was successfully
   **presented at the callback on `:3000`** — the token exchange and state check both succeeded.
   That alone proves cookies cross the port boundary in this setup.
2. The session cookie has `Path=/; HttpOnly; SameSite=Lax` and **no `Domain` and no port**, so the
   browser scopes it to host `localhost` and sends it to every port on that host.

## Reproduction

- **Does not reproduce as claimed.** The "web UI permanently unauthenticated in dev" symptom did not
  occur. Observation C2 is the refutation: the SPA origin gets `200` and the full user object.
- **Reproduces in a different form.** The user finishes login on `http://localhost:3000/` looking at
  a 24-byte plain-text placeholder instead of the SPA.

## Narrowing

- **Leg 1 — proxy vs. direct (C1 vs C2).** Identical `200` + identical body. Eliminates "the Vite
  proxy strips or fails to forward cookies." The proxy is transparent to `Cookie` and `Set-Cookie`;
  it adds only `Vary: Origin`. Note that the proxy dials `127.0.0.1:3000` server-side, but that is
  invisible to the browser's cookie store, which only ever sees host `localhost`.
- **Leg 2 — `Accept` header (C2 vs C3).** Identical. Eliminates content-negotiation as a factor for
  the authenticated path. `wantsJson` only changes the *unauthenticated* branch (401 JSON vs 302 to
  `/login`), confirmed by E.
- **Leg 3 — host `localhost` vs `127.0.0.1` (C2 vs D1 vs D2).** `localhost:5173` → 200;
  `127.0.0.1:5173` → 401; `127.0.0.1:3000` → 401. Since D2 is the API server *directly* and still
  401s, this isolates the variable to the **cookie host string**, not the port and not the proxy.
- **Leg 4 — A/B on `PUBLIC_URL`.** Re-ran the identical flow with `PUBLIC_URL=http://localhost:5173`:
  `redirect_uri` became `http%3A%2F%2Flocalhost%3A5173%2Flogin%2Fgitea%2Fcallback`, the callback was
  proxied through Vite to the server, `sessionId` was still set correctly, and the flow terminated at
  `>>> FINAL URL: http://localhost:5173/` serving the SPA's `index.html` (`<div id="app">` +
  `/src/main.ts`). A follow-up `GET http://localhost:5173/api/v1/me` with that jar returned `200`.
  This eliminates "the landing problem is unfixable via `PUBLIC_URL`" — that lever demonstrably works
  in dev.

## The two failure modes, distinguished

**Failure mode 1 — session cookie lost across origins. NOT REAL (as scoped by the claim).**
Cookies partition by host, never by port (RFC 6265 §8.5 explicitly notes cookies are not isolated by
port). `localhost:3000` and `localhost:5173` are the same cookie host. Measured: C2 returns 200.
There is nothing to fix here.

**Failure mode 1b — host mismatch `127.0.0.1` vs `localhost`. REAL but conditional.**
If a developer opens the SPA at `http://127.0.0.1:5173`, the session established at the
`PUBLIC_URL`-derived `localhost:3000` callback is invisible to it (D1: 401). Vite's own console
prints `➜  Local:   http://localhost:5173/`, so the default path a developer follows avoids this.
It bites anyone who types `127.0.0.1` by habit or has it bookmarked. Severity: confusing but
self-inflicted and recoverable; not a permanent breakage.

**Failure mode 2 — post-login landing on the API origin. REAL and unconditional.**
`completeOAuthLogin` ends with `reply.redirect('/')` (`apps/server/src/auth.ts:238`). That relative
redirect resolves against whatever origin served the callback — which is `PUBLIC_URL`, i.e.
`localhost:3000`. In dev that is the Fastify placeholder route, not the SPA. Every dev login ends on
a dead-end page and the developer must manually navigate back to `:5173`. The session is valid, so
this is a navigation/usability defect, not an auth defect.

## Options (not choosing between them)

For **failure mode 2** (and incidentally 1b, since both stem from `PUBLIC_URL` being the origin the
browser is returned to):

1. **Set `PUBLIC_URL=http://localhost:5173` in dev.** Documentation/env-only, zero code change.
   Measured working in Leg 4: the whole flow lands on the SPA and the session works. Requires the
   forge OAuth app to have `http://localhost:5173/login/*/callback` registered as an allowed
   callback, which is a per-developer forge-side setup cost.
2. **Make the post-login redirect target configurable** (e.g. a `POST_LOGIN_REDIRECT` / `WEB_ORIGIN`
   env read at `registerAuth`, used in place of the bare `'/'`). Keeps `redirect_uri` on `:3000` so
   the registered forge callback URL never changes, while returning the browser to the SPA. Costs a
   small code change in a file another agent is actively editing.
3. **Have Vite serve the SPA for the post-login landing path**, i.e. keep everything on `:3000` in
   dev by adding a dev-only proxy/static fallback so `http://localhost:3000/` serves the SPA. Avoids
   two origins entirely at the cost of dev-server configuration.
4. **Do nothing for mode 2, document it.** Since the session is genuinely valid, a single line in the
   dev docs ("after login you land on the API placeholder; navigate back to :5173") is sufficient to
   unblock a human.
5. **For 1b specifically:** document "use `localhost`, not `127.0.0.1`", or normalize the two.

Choosing among these is a values/ergonomics call about dev setup cost vs. code change, and is left to
the owning role.

## Incidental observation (out of scope, unfixed, worth recording)

Every authorize URL carries the literal string `scope=undefined`:

```
...&client_id=dummy-gitea-id&redirect_uri=...&scope=undefined&state=...
```

`registerAuth` never passes a `scope` to `@fastify/oauth2`, so `String(undefined)` is serialized into
the query. Against the dummy/fake providers used here this was harmless, but a real GitHub/GitLab/
Gitea provider will receive a scope literally named `undefined`. This was **not** measured against a
real provider and is not part of the claim under test; flagging only.

## Open

- Not measured against a real GitHub/GitLab/Gitea provider — the token exchange and userinfo call
  were served by a local fake. The cookie attributes and redirect topology are provider-independent
  (they are set by `registerAuth` and observed verbatim above), but real-provider behavior around
  `scope=undefined` and callback-URL allowlisting is unverified.
- Not measured in a real browser. `curl`'s cookie jar implements RFC 6265 host matching, which is the
  behavior at issue, but browser-specific extras (e.g. Chrome's treatment of `localhost` as a secure
  context, third-party-cookie heuristics on the provider hop) were not exercised.
- `SameSite=Lax` was not stress-tested against a real cross-site provider redirect. The return leg is
  a top-level `GET` navigation, which `Lax` permits, so it is expected to work — but that is an
  inference from the spec, not something this run measured.

## Cleanup

All three processes started by this probe (API server on 3000, Vite on 5173, fake provider on 4599)
were killed; `lsof` confirms no listeners remain on those ports. The scratch SQLite file was removed.
No tracked file was modified by this investigation.
