# Documentation docking

DOCKED

After comment 5595967717, DESIGN/ADR/README/architecture restore the launcher public-CA migration: default-store TLS + matching `whoami` deletes only that origin digest v2 extra root (not `device.json` / v1). Pair recovery, overlap rotation, and public-CA pair-without-extra-root remain. CHANGELOG keeps the 5595770991 withdrawal line as history and prepends the restore. smoke-test adds a 2026-09-09 restore section; the prior correction section is not rewritten.

Independent review is not claimed. This docking is implementer-owned.
