# Public HTTPS certificate chain must be default-trusted for device authorization

- item: Measure the current repository TLS/deploy/MCP contract, the live public HTTPS endpoint under default verification, and whether authorized live-server access is already discoverable without guessing credentials.
  status: done
  dispatched: self → kaola-workflow/issue-46/.cache/ground-truth.md
  result: kaola-workflow/issue-46/.cache/ground-truth.md — default curl exit 60 self-signed; openssl verify 18; leaf subject=issuer, no SAN; Node DEPTH_ZERO_SELF_SIGNED_CERT; kaola-mcp already default fetch; no authorized live SSH/host access. (host/IP/fingerprint redacted from this line after owner git-hygiene rule)

- item: Patch `docs/DESIGN.md` so a public `PUBLIC_URL=https://…` requires a client-default-trusted full chain, SAN covering the hostname, and automatic renewal; production default is a public ACME CA.
  status: done
  dispatched: self → .kw/worktrees/issue-46/docs/DESIGN.md §7 / §12
  result: worktree `docs/DESIGN.md` v0.5 — §7 strict TLS / `NODE_EXTRA_CA_CERTS` diagnostic-only; §12 public HTTPS full chain + SAN + ACME renewal. No schema/MCP/claim changes.

- item: Dock README 生产向部署, `docs/architecture.md`, `docs/api.md`, `docs/smoke-test.md`, and CHANGELOG Unreleased to that same contract; keep `kaola-mcp` strict TLS; do not add a product test or nginx sample unless measurement shows a repository gap that requires one.
  status: done
  dispatched: self → worktree README / architecture.md / api.md / smoke-test.md / CHANGELOG.md / .env.example
  result: worktree docs docked to DESIGN v0.5. No product test, no nginx sample (measurement: kaola-mcp already default fetch; compose still loopback 31415). Files: README.md, docs/architecture.md, docs/api.md, docs/smoke-test.md, docs/README.md, CHANGELOG.md, .env.example.

- item: If authorized live-server access exists, replace the self-signed leaf with a publicly trusted full chain, preserve rollback, test reverse-proxy config before reload, and establish verifiable renewal; otherwise record the exact access blocker and stop live mutation.
  status: done
  dispatched: self → kaola-workflow/issue-46/.cache/live-access.md
  result: kaola-workflow/issue-46/.cache/live-access.md — BLOCKED: no authorized access to the public HTTPS host; no live mutation. (host/IP redacted from this line after owner git-hygiene rule)

- item: Run focused and required repository validation (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`) in the issue worktree.
  status: done
  dispatched: self → kaola-workflow/issue-46/.cache/validation.md
  result: kaola-workflow/issue-46/.cache/validation.md — lint/typecheck/test/build all exit 0; node 843/843, vitest 131/131. No unexecuted platform/OAuth/browser claims.

- item: Remove real deployment identifiers (public host, HTTPS port, IP, cert identity, SSH/tunnel aliases) from every tracked and untracked issue-46 file, and rewrite the unpushed branch commit so they do not remain in git history.
  status: done
  dispatched: self → worktree docs + kaola-workflow/issue-46/.cache (placeholders only)
  result: working tree `rg` clean for public host, IP, fingerprint, tunnel aliases, and the public HTTPS port. Locations listed in kaola-workflow/issue-46/.cache/redaction.md (no secret values). Unpushed commit rewrite follows.

- item: Freeze DESIGN §12 as a two-mode TLS contract (`DEBUG_PRIVATE_CA` / `STABLE_PUBLIC_CA`) using only deployment-neutral placeholders, then dock README, architecture, api, smoke-test, CHANGELOG, and `.env.example`.
  status: done
  dispatched: self → worktree DESIGN §7/§12 + README / architecture / api / smoke-test / CHANGELOG / .env.example
  result: DESIGN v0.5 two-mode contract with `<public-host>` `<https-port>` `<production-subdomain>` `<acme-dns-provider>`. No deploy scripts. No live mutation.

- item: `rg` audit for real identifiers, then re-run `pnpm lint` / `typecheck` / `test` / `build` in the issue worktree.
  status: done
  dispatched: self → kaola-workflow/issue-46/.cache/validation.md
  result: kaola-workflow/issue-46/.cache/validation.md — `rg`/`git grep` clean; lint/typecheck/test/build exit 0; node 843/843, vitest 131/131. No live mutation. No unexecuted platform claims.

- item: Use the owner-authorized server session to deploy the selected debug TLS mode with backup, configuration validation, reload, and rollback evidence; keep all real environment identifiers in a local untracked operator receipt.
  status: in-flight
  dispatched: self → user-local operator receipt outside the repository

- item: Complete browser login/OAuth, pending-device binding, and post-bind MCP `list_tasks` smoke against the deployed endpoint, recording only deployment-neutral acceptance in the repository.
  status: in-flight
  dispatched: self via Computer Use → local isolated Path A first; deployed endpoint after strict TLS is repaired
