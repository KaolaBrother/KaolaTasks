# webhook.shared.test.ts — createAdapter helper fix

## Defect

`createAdapter(kind, secret: string | undefined = WEBHOOK_SECRET, ...)` used a default
parameter on `secret`. JS default parameters replace an **explicit** `undefined` argument
with the default, same as an omitted argument — there is no way to tell them apart from
inside the function via the parameter value alone. So in the "adapter created without a
webhookSecret" test, `createAdapter(kind, undefined)` silently built an adapter with
`webhookSecret: WEBHOOK_SECRET` (the correct secret), the headers were signed with that
same secret, and `assert.throws(...)` failed with "Missing expected exception" for all
three kinds (github/gitlab/gitea) — the 3 failures out of 441/444.

The empty-string half (`createAdapter(kind, '')`) was already correct and passing; it was
just never reached in isolation because the suite failed on the `undefined` assertion first.

## Fix

Only `packages/forge-adapters/src/webhook.shared.test.ts` touched. No production files
changed.

- Added a dedicated sentinel `const NO_SECRET = Symbol('no-secret')`, distinct from
  `undefined`, to mean "omit `webhookSecret` entirely."
- Changed `createAdapter`'s second parameter type from `string | undefined` to
  `string | typeof NO_SECRET`, still defaulting to `WEBHOOK_SECRET` when omitted.
- Changed the body check from `if (secret !== undefined)` to `if (secret !== NO_SECRET)`,
  so passing an empty string `''` still sets `webhookSecret: ''` (empty-secret case
  unaffected), and passing `NO_SECRET` explicitly skips setting `webhookSecret` at all
  (true omission, not swallowed by the default parameter).
- Updated the one call site that exercised the "no secret" branch:
  `createAdapter(kind, undefined)` → `createAdapter(kind, NO_SECRET)`.
- No other call site changed — every other caller either omits the second argument
  (still resolves to `WEBHOOK_SECRET` via the default) or passes an explicit string
  (`WEBHOOK_SECRET`, `''`, or a custom baseUrl-shifted 3-arg form), all unaffected by
  this change.
- `assertSignatureError` untouched. The empty-string half of the "adapter created
  without a webhookSecret" test untouched.

## Verification

```
node --experimental-strip-types --test packages/forge-adapters/src/webhook.shared.test.ts
```
→ 34/34 pass, 0 fail (all three kinds' "adapter created without a webhookSecret" cases
now correctly throw `WebhookSignatureError`).

```
CI=true pnpm test
```
→ 444/444 node-side tests pass (was 441/444), plus `@kaola/web` vitest 51/51 pass. No
regressions elsewhere.

Not committed — left for review/commit by the owning role.
