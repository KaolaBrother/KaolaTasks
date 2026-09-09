# Frozen review 5808536

Product verdict: PASS (bounded independent review, not UAT).
All product findings R1–R7 resolved. Supplied tests include macOS/Bookworm OpenSSL3.0.20 pairing28/28; reviewer did not execute tests.

Documentation verdict: FAIL, two executable-design corrections.

- R8 docs/smoke-test.md:50: separate Linux claimant uses localhost:34463, which points inside its own network namespace, not host loopback proxy. Document actual forwarding/shared-network route preserving origin/SAN plus reachability check. Do not change product for this.
- R9 docs/smoke-test.md:118: L5 unknown issuer stops before MCP/device proof, so cannot prove pending authorization202. Keep TLS failure as transport evidence; add separate accurately labelled production authorization diagnostic with the actual pending device before approval, expecting202 authorization_required for list/claim. Preserve clean claim-client trust and no TLS bypass.
- Full prior UAT includes restack: create/run that scenario, not omit for lack of existing parent/child tasks.

Runner owns documentation corrections and final gates. No new product review needed if product bytes unchanged; controller verifies corrected docs then releases finalize/sink. No UAT executed yet.
