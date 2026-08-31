# Documentation docking verdict — bundle-41-42-43-44

DOCKED

Two corrections were made to this session's OWN issue text before closing, both as body edits and never as
comments, per the standing instruction:

1. **#42** overstated its own defect. The run owner re-read `docs/smoke-test.md:151` and found it offers a
   SECOND path ("或走完到 `已完成`") that IS available from `进行中`, so the advice was ambiguous rather
   than unactionable. Body narrowed accordingly.
2. **#43** diagnosed the WRONG MECHANISM. Test custody falsified it and the run owner confirmed with
   `node -e`: `JSON.stringify` renders a `Headers` instance as `{}`, so the nine diagnostics do not leak;
   the real leak was `assert.equal` attaching both compared values to `AssertionError.actual`, which
   node's reporter prints regardless of any custom message. Body corrected to the measured mechanism.

A third correction was made to the run owner's own doc edit before anything was committed: the first
version of the `smoke-test.md` rewrite offered the lease-expiry path for BOTH `进行中` and `待验收`, which
is false for `待验收` because `submitPr` already released that lease. Caught by checking the code instead
of trusting the phrasing.

NOT CLAIMED ANYWHERE: no UAT, no smoke test, no browser/OAuth/device/real-token step, no
`pnpm smoke:forge`. Documentation asserts only what `pnpm typecheck`/`lint`/`test`/`build` and direct code
reading established.
