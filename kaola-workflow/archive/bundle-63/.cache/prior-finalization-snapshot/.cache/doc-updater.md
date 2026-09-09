verdict: pass
status: DOCKED

Checked public docs against `workflow/bundle-63` HEAD `4993b1079c1b7ab5137e7e2225b65fa27a3fa6bf` after Issue comment 5595967717.

- DESIGN D18 / §16.5: launcher may delete that origin digest v2 extra root after default-store TLS + matching whoami (restored from `09a01f5`).
- ADR 0031 rotation section: overlap kept; public-CA auto-migration restored.
- README / architecture: same. Public-CA direct connect (no extra root install on a clean client) remains.
- CHANGELOG Unreleased: restore line above the 5595770991 withdrawal; prior Unreleased sentences not rewritten.
- smoke-test 2026-09-09 restore section records 5595967717; the correction section for 5595770991 is historical.

No new MCP tool. Live UAT not claimed. Implementer self-review only.
