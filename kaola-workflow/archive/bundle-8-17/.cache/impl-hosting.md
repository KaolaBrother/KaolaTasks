# impl-hosting — issue #17 (implementer)

**Role:** implementer (production code only; tests were read and run, not written).
**Worktree:** `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17`
**Recorded:** 2026-08-21

All 9 tests in `apps/server/src/hosting.test.ts` are satisfied. Nothing reported back to tdd-guide.

---

## Plugin versions actually installed

From `apps/server/package.json` (added with `pnpm --filter @kaola/server add @fastify/static @fastify/http-proxy`):

| Package | package.json | lockfile resolved |
| --- | --- | --- |
| `@fastify/static` | `^10.1.3` | `10.1.3` |
| `@fastify/http-proxy` | `^11.6.0` | `11.6.0` |

Lockfile was rewritten (expected). Transitive `@fastify/reply-from` came in with http-proxy.

---

## Files changed

| Path | What |
| --- | --- |
| `apps/server/src/app.ts` | `buildApp({ sqlitePath?, webDist?, viteDevTarget? })`. Empty/omit both hosting options → placeholder `GET /` via `getPlaceholderBody()`. Non-empty `webDist` → `@fastify/static` (default wildcard) + exact `GET /` `sendFile('index.html')` + `setNotFoundHandler` SPA for GET except `/api` and `/login*`. Both set → `webDist` wins (no proxy). Only `viteDevTarget` → `@fastify/http-proxy` (`GET`/`HEAD` + `websocket`) after API/auth routes. No `existsSync` of a default dist. |
| `apps/server/src/index.ts` | `process.env.PORT ?? '31415'`. Passes `WEB_DIST` / `VITE_DEV_TARGET` through. `HOST` still `0.0.0.0`. |
| `apps/server/src/auth.ts` | exactly one `process.env.PUBLIC_URL ?? 'http://localhost:31415'`. `reply.redirect('/')` unchanged. No `scope` change. |
| `apps/web/vite.config.ts` | proxy `/api` and `/login` → `http://127.0.0.1:31415`. |
| `docker-compose.yml` | `"31415:31415"`, `PORT: "31415"`. |
| `apps/server/Dockerfile` | `EXPOSE 31415`, `ENV PORT=31415`, `RUN pnpm --filter @kaola/web build`, `ENV WEB_DIST=/app/apps/web/dist`. |
| `package.json` | added `"dev": "node scripts/dev.mjs"`. Existing `"test"` still includes `apps/server/src/hosting.test.ts`. |
| `scripts/dev.mjs` | Fastify on 31415 + internal Vite (`127.0.0.1:5173`) with `VITE_DEV_TARGET`. |
| `eslint.config.js` | Node globals for `**/*.mjs` so `scripts/dev.mjs` lints. |
| `apps/server/package.json` | new deps (see versions above). |
| `pnpm-lock.yaml` | rewritten by `pnpm add`. |

Did **not** touch: any `*.test.ts`, `docs/DESIGN.md`, OAuth `scope`, RFC1918 checks, `App.vue`.

---

## Verify command output

### hosting.test.ts — 9 pass

```
$ cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-8-17
$ CI=true node --experimental-strip-types --test apps/server/src/hosting.test.ts
▶ issue #17 single-port 31415 hosting
  ✔ omitted hosting options keep GET / as 考拉任务服务占位 with text/plain; webDist serves index.html at /
  ✔ webDist SPA-fallbacks unmatched GET, serves assets, and does not swallow /api or /login
  ✔ when webDist and viteDevTarget are both set, webDist wins
  ✔ index.ts PORT default is 31415 (source pin; does not import index.ts)
  ✔ auth.ts PUBLIC_URL default is http://localhost:31415 (source pin)
  ✔ vite.config.ts proxies /api and /login to http://127.0.0.1:31415
  ✔ docker-compose maps 31415:31415 and sets PORT 31415
  ✔ Dockerfile EXPOSE 31415, ENV PORT=31415, and image build includes web dist
  ✔ root package.json has a non-empty dev script
✔ issue #17 single-port 31415 hosting
ℹ tests 9
ℹ suites 1
ℹ pass 9
ℹ fail 0
ℹ duration_ms 415.585083
exit 0
```

### placeholder / vault / agent-keys — 26 pass

```
$ CI=true node --experimental-strip-types --test \
    apps/server/src/placeholder.test.ts \
    apps/server/src/vault.test.ts \
    apps/server/src/agent-keys.test.ts
ℹ tests 26
ℹ suites 16
ℹ pass 26
ℹ fail 0
exit 0
```

### extra (not required by the prompt loop)

```
$ CI=true node --experimental-strip-types --test \
    apps/server/src/auth.test.ts apps/server/src/tasks.test.ts
ℹ tests 85
ℹ pass 85
ℹ fail 0
exit 0

$ CI=true pnpm --filter @kaola/server typecheck
$ tsc --noEmit -p tsconfig.json
exit 0

$ pnpm typecheck
apps/web, packages/forge-adapters, packages/shared, apps/server typecheck: Done
exit 0

$ pnpm lint
$ eslint .
exit 0
```

Did **not** run full `pnpm test` (web vitest not re-run this turn). Server hosting + placeholder trio + auth + tasks are green.

---

## Tests that could not be satisfied

None.
