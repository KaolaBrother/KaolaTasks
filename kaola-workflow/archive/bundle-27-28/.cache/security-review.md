# Evidence-binding header (do not modify above this line)
project: bundle-27-28
issue: 28
branch: cursor/bundle-27-28-7976
surface: password setup/login, OAuth publisher insert, promote, GitHub login 404, split publish vs instance gates, password_hash column, scrypt hasher, session issuance
worktree: /workspace/.kw/worktrees/bundle-27-28
files: apps/server/src/password.ts, permissions.ts, auth.ts, schema.ts, db.ts, tasks.ts, credential-profiles.ts, devices.ts, claim-confirmations.ts, apps/web/src/App.vue, scripts/forge-smoke.ts
# End evidence-binding header

behavior: security-reviewer
candidate: worktree /workspace/.kw/worktrees/bundle-27-28 branch cursor/bundle-27-28-7976 committed HEAD a226c24746f7c16b95106f4b7a4035c066cd4558 plus uncommitted apps/server/src/auth.ts and apps/server/src/auth-cookie.test.ts (R1 skipUntrusted repair)
claim: POST /api/v1/setup and POST /api/v1/login now persistSession(..., { skipUntrusted: true }); shouldSkipSessionSave is cookie.secure && protocol !== https && !isTrustedSessionPeer; untrusted public peer 203.0.113.10 + spoofed X-Forwarded-Proto https + PUBLIC_URL=https does not mint sessionId; loopback setup still gets Secure sessionId
surface: POST /api/v1/setup, POST /api/v1/login, persistSession/shouldSkipSessionSave/isTrustedSessionPeer, COOKIE_SECURE_TRUST_PROXY, publicUser
evidence: /workspace/kaola-workflow/bundle-27-28/.cache/security-review.md

# Security re-review of R1 — issue #28 identity

Read-only review of the current worktree (committed a226c24 plus uncommitted auth.ts / auth-cookie.test.ts). Product files were not edited. Rate-limit, helmet, GCM AAD, and device flood are out of scope (left on #27). Missing promote UI and HTML form 415 are not blocking. Tests were used as corroboration, not as the sole oracle.

Trust model: empty DB is wizard-only; after a loginable admin exists, GitLab/Gitea OAuth inserts active+full publishers. Session cookies with PUBLIC_URL https are Secure. Fastify trustProxy is the COOKIE_SECURE_TRUST_PROXY list (loopback + RFC1918), never true. Untrusted public TCP peers must not flip request.protocol via X-Forwarded-Proto and must not receive sessionId when the connection is still HTTP.

Method: read auth.ts persistSession / shouldSkipSessionSave / isTrustedSessionPeer and @fastify/session@11.1.2 onSend (isInsecureConnection still setCookies when session.isSaved()). Live inject under PUBLIC_URL=https://tasks.example.test via buildApp() + Fastify inject, capturing request.protocol, request.ip, request.socket.remoteAddress, Set-Cookie, and JSON body keys.

Verdict: PASS. R1 is fixed. No new blocking findings.

---

## R1 status: fixed

Previous FAIL: setup (auth.ts:531) and login (auth.ts:546) called persistSession without skipUntrusted, so save() ran, session.isSaved() was true, and onSend minted sessionId on an untrusted HTTP peer.

Current anchors:

- apps/server/src/auth.ts:553 POST /api/v1/setup persistSession(request, inserted.id, { skipUntrusted: true })
- apps/server/src/auth.ts:568 POST /api/v1/login persistSession(request, user.id, { skipUntrusted: true })
- apps/server/src/auth.ts:385 OAuth already passed skipUntrusted
- apps/server/src/auth.ts:332-341 persistSession still returns false without save() when skipUntrusted and shouldSkipSessionSave
- apps/server/src/auth.ts:324-330 shouldSkipSessionSave
- apps/server/src/auth.ts:58-81 COOKIE_SECURE_TRUST_PROXY + BlockList + isTrustedSessionPeer (::ffff: strip)
- apps/server/src/app.ts:42-43 trustProxy is that same list when cookie Secure is on
- node_modules/@fastify/session@11.1.2/index.js:169-184 onSend still emits sessionId on insecure connections only if isSaved()

All three persistSession call sites pass skipUntrusted: true.

---

## Live inject (current tree)

PUBLIC_URL=https://tasks.example.test. Independent script, not the unit test file. Cookie values are not reproduced.

1. UNTRUSTED setup 203.0.113.10 + X-Forwarded-Proto https
   status 201, protocol http (spoof ignored), ip 203.0.113.10, sessionId false, Set-Cookie empty.
   Body keys: id, provider, remote_id, username, display_name, status, permission_level, trusted_automation.
   No password, password_hash, hash, token, access_token, ciphertext; password plaintext absent.
   Follow-up GET /api/v1/me from the same peer: 401 { error: unauthorized }. Attacker is not logged in.

2. UNTRUSTED login 203.0.113.10 + X-Forwarded-Proto https (after loopback setup)
   status 200, protocol http, sessionId false, Set-Cookie empty. Same publicUser keys, no secret keys.
   GET /me using that response's cookies (none): 401.

3. LOOPBACK setup 127.0.0.1, no X-Forwarded-Proto
   status 201, protocol http, sessionId true, Set-Cookie sessionId Path=/ HttpOnly Secure SameSite=Lax.

4. LOOPBACK setup 127.0.0.1 + X-Forwarded-Proto https
   status 201, protocol https, sessionId true, same Secure flags.

5. RFC1918 login 10.4.5.6 + X-Forwarded-Proto https
   status 200, protocol https (trusted proxy hop), sessionId true.

6. RFC1918 login 172.18.0.1 + X-Forwarded-Proto https
   status 200, protocol https, sessionId true.

7. RFC1918 login 192.168.1.50, no X-Forwarded-Proto (trusted HTTP peer)
   status 200, protocol http, sessionId true. This is the new !isTrustedSessionPeer branch (see below). Not a public-internet mint.

8. MAPPED IPv6 setup ::ffff:203.0.113.10 + X-Forwarded-Proto https
   status 201, protocol http, sessionId false. ::ffff: strip does not let a public v4-mapped peer become trusted.

9. UNTRUSTED login 198.51.100.20 TEST-NET-2 + X-Forwarded-Proto https
   status 200, protocol http, sessionId false.

10. UNTRUSTED login 2001:db8::10 + X-Forwarded-Proto https
    status 200, protocol http, sessionId false. Public IPv6 is not in the BlockList.

Corroboration: node --experimental-strip-types --test apps/server/src/auth-cookie.test.ts in the worktree: tests 7 pass 7 fail 0, including untrusted setup, untrusted login, loopback HTTPS setup Secure cookie, and GitLab untrusted-peer.

---

## !isTrustedSessionPeer vs old OAuth protocol-only skip

Old shouldSkipSessionSave: cookie.secure && protocol !== 'https'. Any peer on HTTP skipped save, including Fastify inject's default 127.0.0.1. That would omit sessionId on loopback setup under PUBLIC_URL https and break ensureSetup / the existing Secure-cookie test. Hence the extra clause.

New shouldSkipSessionSave: cookie.secure && protocol !== 'https' && !isTrustedSessionPeer(request). Trusted peers = COOKIE_SECURE_TRUST_PROXY via node:net BlockList: 127.0.0.1, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.

Is trusted HTTP cookie issuance a new public-internet hole? No. Public IPs are not in the list. Live inject of 203.0.113.10, 198.51.100.20, 2001:db8::10, and ::ffff:203.0.113.10 all kept protocol http (spoofed proto ignored) and received no sessionId.

RFC1918 peers were already trusted for X-Forwarded-Proto: a 10/8 or 172.16/12 peer with X-Forwarded-Proto https already flipped protocol to https (live: 10.4.5.6 and 172.18.0.1), so old OAuth skip-save would not have applied either (protocol === 'https'). They could already mint a Secure cookie by adding that header. The new clause lets the same trusted peer get a cookie on raw HTTP without the header (live: 192.168.1.50 protocol http, sessionId true). That is a private-network behavior change, not a public-internet bypass. An internet attacker cannot source RFC1918 or loopback as the TCP peer of a listener they reach from a public address.

Not admitted.

---

## 201/200 bodies omit password/hash/token

publicUser (auth.ts:99-124) is an allow-list: id, provider, remote_id, username, display_name, status, permission_level, trusted_automation, optional pending message. Live setup 201 and login 200 matched that set. No password, password_hash, hash, token, access_token, ciphertext. Password plaintext and scrypt$ absent from body and headers.

Setup/login still return 201/200 when save is skipped (cookie withheld, user created / credentials valid). That is fail-closed for session mint: GET /me is 401. OAuth still redirects either way. Not a remaining session-issuance defect.

---

## Checked and not admitted

No new persistSession sites without skipUntrusted.

#27 leftovers (rate-limit, helmet, GCM AAD, device flood) not admitted.

Missing promote UI and HTML form 415 not blocking.

Wizard still inserts the first admin from an untrusted peer (201, no cookie). That is empty-DB setup by design, not R1.

---

finding: id=R1 scope=in_scope action=fix status=fixed severity=high fix_role=security rationale=setup-and-login-pass-skipUntrusted-untrusted-HTTP-peer-no-longer-mints-sessionId
verdict: pass
findings_blocking: 0
review_conclusion: Live inject on the current tree shows POST setup and login from public peer 203.0.113.10 with spoofed X-Forwarded-Proto https no longer emit sessionId, loopback and RFC1918 still receive Secure cookies when expected, and the new trusted-peer skip clause is not a public-internet hole.
