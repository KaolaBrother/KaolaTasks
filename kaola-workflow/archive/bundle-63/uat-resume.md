# Repaired UAT frontier — resolved

Production repair candidate `a76674f`, test-only clock candidate `720e239`, and final documentation candidate `390fd9c` are on `workflow/bundle-63`. Mission 2 is done; the authoritative dated result is `docs/smoke-test.md`, while protected operator evidence remains under `.kw/local-receipts/uat-repair-20260909/` and is not uploaded.

The earlier in-app-browser confirm blocker was a control-method mismatch, not a product or Private CA failure. A real Playwright Chromium session dismissed and then accepted the native termination dialog, reopened the resulting `已退回` task, and cancelled it through the workbench. Gitea PR61 was closed and verified unmerged.

The third clean device resumed the same pending attempt after the recorded server/claimant restart, was approved through the real workbench secret form, completed strict TLS plus active `whoami`, wrote v2, and consumed its one-time receipt. All three devices are active with 90-day expiry; all three pairing attempts are consumed with 86400-second TTL.

Final `verify-containment.mjs` result: PASS across 35 exposed surfaces, eight task states, seven tasks and 128 events; no PAT or CA private key found. All 14 leases are released. Pairing logs have no `MaxListenersExceededWarning`. Tasks 1/2/3 are completed and tasks 4/5/6/7 are cancelled.

The exact UAT containers and Playwright session are stopped. Older containers, databases, images and evidence were left untouched. Physical 24h/90d waits, Windows/macOS physical clients, a clean public-CA machine, HTTPS browser OAuth callback and the removed VPS remain explicitly outside this PASS.

Finalization is active. The main checkout's modified `docs/smoke-test.md` intentionally matches the branch report and must be reconciled by the sink rather than discarded.
