# Evidence-binding header (do not modify above this line)
project: issue-24
issue: 24
branch: cursor/issue-24-intranet-deploy-9906
surface: apps/server/src/auth.ts cookieSecureFromPublicUrl session/OAuth Secure skip session.save when cookie.secure && protocol !== https; apps/server/src/app.ts Fastify trustProxy array when PUBLIC_URL is https; docker-compose.yml loopback bind env_file env interpolation
worktree: /workspace
tests: apps/server/src/auth-cookie.test.ts
# End evidence-binding header

# Security review — issue #24 (HTTPS cookie, trustProxy, compose)

Reviewer: security-reviewer. Read-only of product files. The only write is this evidence file.

Candidate: branch `cursor/issue-24-intranet-deploy-9906` @ `cab2592` versus `main` `b2d93c5`. Surface limited to `apps/server/src/auth.ts`, `apps/server/src/app.ts`, `docker-compose.yml` (tests `apps/server/src/auth-cookie.test.ts` used as pins, not a defect surface). Parallel doc-updater edits (README, `.env.example`) were read only to classify the ops-guidance look-for; they are not this candidate.

Trust model: PUBLIC_URL `https:` means cookie `Secure` plus peer-IP `trustProxy`. Numeric hop-count `1` is a Fastify 5.12.1 no-op (GHSA-3m5p-2c4r-xxw2). Compose publishes `127.0.0.1:31415:31415`. Forge tokens stay off this surface.

Method: read the `b2d93c5..cab2592` delta and callers (`completeOAuthLogin`, `registerAuth`, `buildApp`, compose, `.gitignore`). Confirmed Fastify 5.12.1 `lib/request.js` protocol getter (`proxyFn(socket.remoteAddress, 0)` then last `X-Forwarded-Proto`). Confirmed `@fastify/session` v11.1.2 `onSend` (`isInsecureConnection` still `setCookie`s if `session.isSaved()`). Measured `@fastify/proxy-addr@5.1.0` `compile` of the exact `COOKIE_SECURE_TRUST_PROXY` list against IPv4-mapped peers. Ran `node --experimental-strip-types --test apps/server/src/auth-cookie.test.ts apps/server/src/hosting.test.ts` (13 pass, 0 fail).

Verdict: PASS. No candidate-caused security defect admitted.

---

## Admitted findings

None.

---

## Checked and clean — trustProxy width versus LAN spoof

Primary anchors: `apps/server/src/auth.ts` `COOKIE_SECURE_TRUST_PROXY`; `apps/server/src/app.ts` `Fastify({ trustProxy: [...COOKIE_SECURE_TRUST_PROXY] })` only when `cookieSecureFromPublicUrl()`; `docker-compose.yml` `"127.0.0.1:31415:31415"`.

- Not `true`, not `0.0.0.0/0`, not hop-count `1`. HTTP `PUBLIC_URL` keeps `Fastify()` with no `trustProxy`.
- Docker publish on host loopback does not listen on the LAN interface. A host-network attacker on another LAN machine cannot TCP to 31415, so they never reach the RFC1918 trust predicate and cannot spoof `X-Forwarded-Proto` into Fastify.
- RFC1918 is the intended docker-bridge / private-proxy set (test peer `172.18.0.1` is trusted; public `203.0.113.10` is not). `apps/server/src/auth-cookie.test.ts` pins both.
- Sibling-container reachability of in-container `HOST: 0.0.0.0:31415` exists on the compose network, but this file has a single service and no extra network aliases. That is not a LAN host-network path.
- Bare-metal `index.ts` `HOST` default `0.0.0.0` is pre-existing. Combined with this `trustProxy` list it would trust RFC1918 only if 31415 is reachable; the candidate compose bind is the control the issue asked for. Not admitted as a candidate defect.

## Checked and clean — Secure cookie bypass / session fixation

Primary anchors: `auth.ts` `cookieSecureFromPublicUrl` (`startsWith('https:')`); session `cookie.secure = cookieSecure`; OAuth `cookie.secure = cookieSecure`; skip-save in `completeOAuthLogin`.

- Not `secure: 'auto'`. Cookie flags follow operator `PUBLIC_URL`, not a client `X-Forwarded-Proto`.
- `@fastify/session` v11.1.2 `onSend` treats `cookie.secure === true && request.protocol !== 'https'` as insecure and still emits `Set-Cookie` when `session.isSaved()`. The candidate skips `request.session.save()` on that path so a new login from an untrusted peer does not mark the session saved. Redirect still happens; no `sessionId` is minted (test: public peer + spoofed proto).
- `saveUninitialized: false`. Session ids are signed. An attacker cannot plant an unsigned `sessionId` and have login attach `userId` to it without `SESSION_SECRET`.
- Uninvited / revoked OAuth still returns before `userId` is set (`completeUserLogin`). Skip-save does not create a session for those outcomes.
- OAuth state cookies go through `@fastify/cookie` (no protocol gate). `Secure` on `GET /login/github` without forwarded proto is intended; the browser origin is the HTTPS `PUBLIC_URL`.

## Checked and clean — env_file / compose secrets in git

Primary anchors: `docker-compose.yml` `env_file: .env` and `${PUBLIC_URL}` / `${SESSION_SECRET}` / `${VAULT_MASTER_KEY}` / nine `OAUTH_*`; `.gitignore` `.env` and `.env.*`.

- Compose contains no secret literals. Hosting test rejects `NAME: "literal"` forms that are not `${…}`.
- `.env` is gitignored. `git ls-files` has no deploy `.env`. `.env.example` (doc-updater, empty placeholders only) is not a leak.

## Checked and clean — IPv4-mapped addresses versus CIDR trust

Measured `@fastify/proxy-addr@5.1.0` `compile` of the exact list. Mapped forms are converted to IPv4 and matched against IPv4 CIDRs (documented mapped-address support, not a widening of the set).

- Trusted (intended): `127.0.0.1`, `::ffff:127.0.0.1`, `::1`, `172.18.0.1`, `::ffff:172.18.0.1`, `10.1.2.3` / mapped, `192.168.1.50` / mapped.
- Untrusted (no bypass): `203.0.113.10`, `::ffff:203.0.113.10`, `8.8.8.8` / mapped, `169.254.1.1` / mapped, `fc00::1`, `fe80::1`, `172.15.0.1`, `172.32.0.1`.

A public mapped peer cannot satisfy RFC1918 or loopback and therefore cannot flip `request.protocol` via `X-Forwarded-Proto`.

## Residual / out of scope (not admitted)

- Ops: Fastify 5.12.1 protocol uses the last `X-Forwarded-Proto` token when the immediate peer is trusted. The terminator must overwrite proto from the client-facing scheme (`$scheme` / equivalent), not pass through a client header. README point 4 (doc-updater, not this surface) states 80/443 to `127.0.0.1:31415` and does not yet spell overwrite. Missing guidance is an ops note for docs, not a code trust-model breach: with overwrite, a LAN or Internet client cannot spoof proto because they are not the TCP peer; without overwrite, the already-trusted proxy would forward a client value. Route to doc-updater if the orchestrator wants that sentence.
- `HOST: 0.0.0.0` inside the container is required for Docker publish and is pre-existing in the Dockerfile / `index.ts`.
- `fc00::/7` unique-local IPv6 is not in the trust list (fail-closed). Default compose IPv4 bridge is covered by `172.16.0.0/12`.

---

verdict: pass
findings_blocking: 0

review_conclusion: Loopback publish plus RFC1918 peer trust does not let a LAN host spoof X-Forwarded-Proto, skip-save blocks untrusted Secure session minting, IPv4-mapped public addresses fail the CIDR predicate, and compose interpolates gitignored env with no secret literals.
