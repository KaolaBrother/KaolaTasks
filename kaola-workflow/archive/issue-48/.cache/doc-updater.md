# Documentation review

- `docs/DESIGN.md`: private/public CA client modes, trust bootstrap, package-bin commands, privilege boundary, uninstall, rotation, and no-TOFU behavior are current.
- `README.md`: both client installation paths and the tested Ubuntu systemd + Nginx fallback are current; server and client responsibilities remain separate.
- `docs/api.md`: HTTPS launcher and OAuth callback behavior remain accurate.
- `docs/smoke-test.md`: macOS Claim-client trust/binding/OAuth/MCP and both real forge lifecycles are recorded without live identifiers.
- `CHANGELOG.md`: delivered trust CLI and fail-closed launcher are recorded.

Owner acceptance exception: Windows/Linux Claim clients and STABLE_PUBLIC_CA live validation are unexecuted and deferred. They are not described as PASS and do not block this run's closure.
