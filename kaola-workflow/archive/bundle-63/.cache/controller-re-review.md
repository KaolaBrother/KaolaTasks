# Independent repair review — FAIL

candidate: f1e0a8c4cf4f16a493b24da6592ec67ad34a05a1
reviewer: native code-reviewer /root/pairing_final_review
verdict: fail
method: read-only source tracing and primary documentation; no tests or UAT executed by reviewer/controller.

R1, R2, R4, R5: resolved on execution-path analysis. Approved same-nonce recovery, exact-device administrator repair preserving owner/expiry, explicit default-root isolation with real TLS child coverage, and recoverable previous trust replace address originals.

## R3 — configured-chain validation remains incomplete

`apps/server/src/pairing.ts:138`: offline verifier uses `X509Certificate.checkIssued`, which checks issuer metadata, not cryptographic signatures. Matching issuer metadata with corrupted signature can pass. No certificate validity-time check exists. Must reject chains strict TLS rejects, including invalid signature, time and chain constraints/purpose. Use complete verification rather than treating metadata comparisons as trust proof.

`apps/server/src/pairing.ts:160`: online `openssl s_client` uses `-servername` (SNI) but omits hostname/IP verification. A valid chain for a different name passes. Both offline and online paths must validate server identity.

## R6 — repair delta rejects valid IP-SAN certificates

`apps/server/src/pairing.ts:131`: `checkHost` cannot validate an IP SAN. A valid certificate for `PUBLIC_URL=https://127.0.0.1:31415` with IP:127.0.0.1 and unrelated descriptive CN is rejected. Use proper IP verification and normalize bracketed IPv6 where applicable.

## Evidence and bounded repair direction

Runner owns all fixes and test execution. Add focused failing tests on this candidate before repair, then implement complete certificate validation and rerun affected gates. Cover invalid signature/time, wrong online identity, valid DNS/IP including IPv6 as supported. Preserve rejection of unrelated roots and do not weaken TLS or add features. Finalize remains on hold pending new frozen candidate review.

No persisted fail-first output was found in supplied Mission 9/cache evidence. Do not retrospectively claim it existed. R5 test covers interrupted recovery and successful replacement but not forced rename failure; add direct failure evidence if claiming that branch tested. This is an evidence gap, not another product finding. Preserve completed mission results; continue this finalization correction in lifecycle records, not a new mission per review round.

Primary references: https://nodejs.org/api/crypto.html#x509checkissuedothercert ; https://nodejs.org/api/crypto.html#x509checkipip ; https://docs.openssl.org/3.0/man1/openssl-s_client/
