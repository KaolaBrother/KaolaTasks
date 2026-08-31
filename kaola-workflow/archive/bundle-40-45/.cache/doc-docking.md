# Documentation docking verdict — bundle-40-45

DOCKED

The one contract that genuinely changed is documented rather than quietly broken: before #40 a failed
write-back wrote NO event, and `docs/api.md:488` said so explicitly. The implementation needs to persist
whether the last failure left the forge-side outcome unknown, so a failure now CAN write a `回写` row —
but only when that outcome changes, never once per retry tick. Both the mechanism and the bound are stated.

Nothing else in the documentation set was touched, and each omission was checked rather than assumed.

NOT CLAIMED ANYWHERE: no UAT, no smoke test, no browser/OAuth/device/real-token step, no
`pnpm smoke:forge`. Documentation asserts only what `pnpm typecheck`/`lint`/`test`/`build` and direct code
reading established. In particular, the three-forge behaviour of `listIssueComments` is asserted from its
shared contract spec and from primary API documentation — NOT from any live call against a real GitHub,
GitLab or Gitea instance, which this run did not make.
