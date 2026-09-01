# Documentation review

- `docs/DESIGN.md`: two-mode server TLS contract, SAN/fullchain, DNS-01, and deployment-identifier boundary are current.
- `README.md`: production topology, Docker Compose default, tested systemd + Nginx fallback, OAuth callbacks, client trust, binding, rollback, and verification are current.
- `docs/architecture.md`: loopback application listener and host TLS terminator remain accurate.
- `docs/api.md`: HTTPS `PUBLIC_URL`, OAuth callback, Secure cookie, and trusted reverse-proxy behavior remain accurate.
- `docs/smoke-test.md`: external private-CA deployment and both real forge lifecycles are recorded without live identifiers.
- `CHANGELOG.md` and `.env.example`: public contract and placeholder-only environment surface remain accurate.

No API, schema, MCP tool, or status-machine change was introduced during final UAT. Owner acceptance exception: Windows/Linux Claim clients and STABLE_PUBLIC_CA live validation are unexecuted and deferred.
