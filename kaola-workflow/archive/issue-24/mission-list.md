# 内网服务器 + 公网 IP 入口：HTTPS cookie、compose 持久库、README 一种拓扑

- item: Measure current session/OAuth cookie flags, Fastify() trustProxy, SQLITE_PATH default, docker-compose ports/env/volume, and README「生产向部署」against #24 body (the only non-claim comments do not amend the spec). Hints: `apps/server/src/auth.ts` `secure: false`; `apps/server/src/app.ts` `Fastify()`; `apps/server/src/index.ts` `SQLITE_PATH`; `docker-compose.yml`; existing `auth.test.ts` cookie helpers.
  status: done
  dispatched: code-explorer → kaola-workflow/issue-24/.cache/ground-truth.md
  result: kaola-workflow/issue-24/.cache/ground-truth.md — secure hardcoded false; Fastify() no trustProxy; SQLITE_PATH :memory:; compose 31415:31415 no SQLITE_PATH; no cookie-flag tests; hosting.test.ts pins unscoped 31415:31415.

- item: Confirm from current Fastify 5 / @fastify/session docs (not memory) how `trustProxy` plus cookie `secure` behaves behind a TLS-terminating reverse proxy, including the one-hop trust the issue asked for.
  status: done
  dispatched: knowledge-lookup → kaola-workflow/issue-24/.cache/fastify-session-trustproxy.md
  result: kaola-workflow/issue-24/.cache/fastify-session-trustproxy.md — Fastify 5.12.1 disables trustProxy:1 (GHSA-3m5p-2c4r-xxw2); session Secure requires request.protocol===https; rulings in orchestrator-rulings.md.

- item: Author failing tests that PUBLIC_URL starting with https: sets session and OAuth-state cookies Secure, while http://localhost keeps secure false; do not pull docker into CI.
  status: done
  dispatched: tdd-guide → apps/server tests + kaola-workflow/issue-24/.cache/tdd-cookie.md; baseline SHA recorded in that report
  result: kaola-workflow/issue-24/.cache/tdd-cookie.md — 5 RED on b2d93c5; files auth-cookie.test.ts, auth.test.ts HTTP pin, hosting.test.ts compose pin; commit de63fd7.

- item: Implement cookie Secure from PUBLIC_URL and Fastify trustProxy for the HTTPS-behind-proxy case; leave localhost HTTP unchanged.
  status: done
  dispatched: implementer → auth.ts + app.ts; notes at kaola-workflow/issue-24/.cache/impl-cookie.md
  result: commit cab2592 — cookieSecureFromPublicUrl, COOKIE_SECURE_TRUST_PROXY, skip session.save when Secure but protocol is http; 35/35 cookie+hosting+auth tests green.

- item: Make compose a real deploy: SQLITE_PATH=/data/kaola.sqlite on the existing volume, inject PUBLIC_URL/SESSION_SECRET/VAULT_MASTER_KEY/OAuth from env or env_file (nothing secret in git), bind 127.0.0.1:31415:31415.
  status: done
  dispatched: implementer → docker-compose.yml (same dispatch as cookie; compose tests already red); notes in impl-cookie.md
  result: same commit cab2592 — docker-compose.yml loopback bind, SQLITE_PATH, env_file .env, ${VAR} pass-through.

- item: Rewrite README 生产向部署 for the single intranet+public-IP topology (8 points in #24) and dock DESIGN §12, api.md, architecture.md, CHANGELOG Unreleased; keep local-dev section; do not change Task Brief, state machine, MCP tools, or token reveal.
  status: done
  dispatched: doc-updater → README/DESIGN/api/architecture/CHANGELOG/CLAUDE Commands; notes at kaola-workflow/issue-24/.cache/doc-updater.md
  result: commit d5e4218 plus README X-Forwarded-Proto overwrite; docking kaola-workflow/issue-24/.cache/doc-docking.md DOCKED.

- item: Security-review the cookie/trustProxy/compose candidate for proxy-trust and Secure-cookie mistakes.
  status: done
  dispatched: security-reviewer → kaola-workflow/issue-24/.cache/sec-review.md
  result: kaola-workflow/issue-24/.cache/sec-review.md — PASS, 0 blocking.
