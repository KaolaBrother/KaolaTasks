# Fail-first (this correction, not Mission 9)

Candidate before repair: `f1e0a8c4cf4f16a493b24da6592ec67ad34a05a1`.
Do not backfill this as Mission 9 RED.

`apps/server/src/pairing.test.ts` on that SHA, after adding assertions:

- corrupted signature: Missing expected exception (`checkIssued` still passed)
- expired leaf: Missing expected exception
- clientAuth-only leaf: Missing expected exception
- IP SAN 127.0.0.1 / ::1: `configured leaf SAN does not cover PUBLIC_URL hostname`
- same-process HTTPS + `execFileSync` timed out (event loop blocked); not used as identity evidence
- after child TLS origin: wrong-name / matching DNS+IP/IPv6 became real probe cases

R5 `forced rename failure after moving final to previous restores the previous directory` was added on this checkpoint and was already green against existing restore code. Not claimed in Mission 9.
