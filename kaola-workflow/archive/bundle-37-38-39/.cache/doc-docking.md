# Documentation docking verdict — bundle-37-38-39

DOCKED

Every public-behavior change in this bundle has a docked doc surface, and two overclaims were caught and
corrected before docking was accepted:

1. An earlier #39 draft asserted a task with NO forge Issue "统一进入 Workflow" — measurably false, since
   Kaola Workflow refuses `no_target` / `claim_issue_numbers_invalid` without an issue number. Corrected;
   the docs now cite that measured refusal as the REASON the contract is scoped.
2. The inverse then appeared: docs asserted unconditionally that every successful claim carries an Issue,
   while `tasks.ts:117` still defaults `source` to native and `claim.ts` never gates. Corrected on all
   four surfaces, and a fifth (workflow-default.md's headline section) was caught by an adversarial
   verifier and corrected by the run owner.

Verified after docking: `apps/server/src/workflow-default.test.ts` reads `docs/workflow-default.md` and
`docs/architecture.md` at runtime and is green; the retired terms appear zero times in live doc text.

NOT CLAIMED ANYWHERE: no UAT, no smoke test, no browser/OAuth/device/real-token step, no
`pnpm smoke:forge`. Documentation asserts only what `pnpm typecheck`/`lint`/`test`/`build` and direct code
reading established.
