# Independent finalization review

candidate: 09a01f5c4701917a67914c931a341378379a3742
restored_candidate: 4993b1079c1b7ab5137e7e2225b65fa27a3fa6bf
equivalence: git diff 09a01f5 4993b10 -- apps packages scripts package.json is empty.
reviewer: native code-reviewer /root/pairing_final_review
verdict: fail
findings_blocking: 5

finding: id=R1 scope=in_scope action=fix status=open severity=medium fix_role=tdd-guide rationale=approved_receipt_cannot_resume
At apps/mcp/src/pair.ts:1071 the restarted client unconditionally creates; apps/server/src/pairing.ts:325 rejects active devices before recovering an approved pairing. After admin approval but before local trust commit, restart with the same unexpired receipt returns pairing create failed 409. Recover existing exact approved pairing and finish strict whoami.

finding: id=R2 scope=in_scope action=fix status=open severity=medium fix_role=tdd-guide rationale=missed_overlap_repair_impossible
At pair.ts:1034 existing extra CA plus unknown issuer is refused; the server active-device guard independently refuses re-pairing. Launcher directs missed-overlap users to pair, but that command cannot recover. Enable fresh explicitly admin-approved re-pair for the existing device with preserved owner/device fencing and no unapproved ready root.

finding: id=R3 scope=in_scope action=fix status=open severity=medium fix_role=tdd-guide rationale=advertised_root_unverified
loadPairingConfig at pairing.ts:75 only validates CA shape; ADR requires origin/leaf-chain verification. A structurally valid unrelated CA boots and is advertised, causing all pairings to fail strict whoami after approval. Prove configured CA roots the actual PUBLIC_URL chain or the configured leaf-chain at startup; fail configuration cleanly if unrelated.

finding: id=R4 scope=in_scope action=fix status=open severity=medium fix_role=tdd-guide rationale=caller_extra_ca_misclassified_public
pair.ts:544 uses ca undefined for the default-store migration probe. With valid v2 and process-start NODE_EXTRA_CA_CERTS private root, Node trusts that root, probe and whoami pass, and migration deletes v2 while endpoint is still private. Explicitly isolate default/system roots from caller extra roots. Test a real Node subprocess/TLS connection, not just extraCaPem undefined in a mock.

finding: id=R5 scope=in_scope action=fix status=open severity=medium fix_role=tdd-guide rationale=trust_deleted_before_atomic_commit
pair.ts:890-897 removes final trust directory before rename. Interruption or rename failure loses last committed trust; caller may also discard staging. Preserve old or new complete trust with bounded recoverable replacement and test interruption/rename failure.

Evidence is full product execution-path review, not live UAT. No additional admitted defect in MAC binding, shared device fences, SQL preserved rows.
review_conclusion: The restored product candidate has five concrete recovery and trust-boundary defects requiring focused repairs before finalization can complete.
