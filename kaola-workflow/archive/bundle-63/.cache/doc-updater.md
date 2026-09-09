# Documentation updater receipt

verdict: DOCKED
candidate: 390fd9c3f30118b7f2234ba8b84148071f8b860d

- `docs/DESIGN.md`: source-of-truth pairing transport lifetime and same-process in-flight write contract are present; design preceded production repair.
- `docs/api.md`: added exact `shareInFlightWrite` scope, keys, cleanup, event effect and non-guarantees; approval/mark-ready behavior points to it.
- `docs/architecture.md`: added same-process/same-DB-handle coalescing and corrected the already-stale #40 failure-event sentence in the touched paragraph.
- `docs/smoke-test.md`: final path L evidence, corrected browser-method diagnosis, three-device restart recovery, eight states, 35-surface scan and explicit exclusions are recorded.
- `CHANGELOG.md`: added the repair, test-only clock stabilization and final path L result under Unreleased.
- `README.md`: no new edit required in this continuation; the earlier #63 delivery already documents `kaola-mcp pair --url`, automatic v2 trust, strict reconnect and explicit v1 recovery path.
- `docs/decisions/0031-private-ca-approval-pairing.md`: no repair changes to frozen transcript/API/schema/proof semantics; existing decision remains accurate.
- `docs/conventions.md`, `docs/workflow-default.md`, `docs/runner-carrier.md`: no affected contract.

No signature, route, schema or configuration field was invented. Public behavior is transcribed from the frozen implementation and its tests.
