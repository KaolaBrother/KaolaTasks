# Subsequent delivery (after controller PASS on f1e0a8c)

Do not start until controller independent review of `f1e0a8c4cf4f16a493b24da6592ec67ad34a05a1` is PASS.

## Owner split

- Cursor CLI Runner: remaining product was R1–R5 (committed). After PASS: finalize `--keep-issue-open`, merge+push+archive, then live smoke/UAT. Do not stop at “ready”.
- Controller: supervise + independent review only; does not patch product. Browser admin `配对密语` is an explicit handoff.

## After PASS

1. Finalize from worktree with keep-open; sink merge+push; archive. Do not close #63.
2. Path B: `pnpm smoke:forge -- gitlab` then `gitea` from the sunk tree. PATs in main-repo `.env` (never print).
3. Isolate UAT dir `/private/tmp/kaolatasks-63-uat.7z077x` only. Refresh `source/` from final SHA, rebuild `kaolatasks-issue63-uat:final` (current image is `:prepared` at 4993-era source). Do not start until rebuild.
4. Private-CA pair UAT: start-linux + proxy; record only in `docs/smoke-test.md`. No fabricated PASS.

## UAT script vs R3 (inspected, not started)

`start-linux.mjs` already sets `KAOLA_PAIRING_MODE=private_ca`, `KAOLA_PUBLIC_ROOT_CA_PATH=/certs/root.pem`, `KAOLA_PUBLIC_LEAF_CHAIN_PATH=/certs/leaf.pem`, `PUBLIC_URL=https://localhost:34463`. Leaf SAN is `DNS:localhost, IP:127.0.0.1`; `openssl verify -CAfile root.pem leaf.pem` OK. With leaf path set, boot uses file-chain verify, not `openssl s_client` to origin (HTTP listen 31463 + TLS proxy 34463). `start-linux.mjs` image tag is `:final`; `server.env` uses `wx` (must not exist or rewrite). `proxy.mjs` TLS 34463 + admin 31415. Do not touch other Docker containers or old SQLite.

## Not PASS yet

Independent review still FAIL on `4993b10`. This file is a plan, not UAT evidence.
