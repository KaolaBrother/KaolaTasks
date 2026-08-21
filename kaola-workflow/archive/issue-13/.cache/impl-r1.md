# impl-r1: bind webhook pr_url match to the signature-verified instance

Verification tier: **tests-green**

## Files changed

- `apps/server/src/poller.ts` — extracted the `(forge, base_url)` equality `isWebhookManaged`
  already used into an exported helper `taskMatchesForgeInstance(task, instance)`, so it can be
  reused by the webhook receiver instead of duplicating the two-field check.
- `apps/server/src/webhook.ts` — `findPendingReviewMatch` now takes the signature-verified
  `instance` (the one resolved from `:publicId`) and skips any pending task whose
  `(repoForge, repoBaseUrl)` doesn't match that instance via `taskMatchesForgeInstance`, before
  ever comparing `pr_url`. A cross-instance `pr_url` collision is now treated as no-match: 204
  empty, no status change, no event. Signature verification, the 404/401 branches, and the
  poll-mode-still-completes behavior are untouched.
- `packages/forge-adapters/src/index.ts` (R2, non-blocking) — Gitea `registerWebhook` now splits
  `repo.full_name` into owner/repo via the existing `splitFullName` helper and
  `encodeURIComponent`s each segment separately (matching the GitHub branch), instead of
  interpolating the unencoded `full_name` as one path segment. `acme/app` still renders as
  `/repos/acme/app/hooks`.

## Commands run

```
node --experimental-strip-types --test apps/server/src/webhook.test.ts apps/server/src/poller.test.ts packages/forge-adapters/src/webhook.shared.test.ts
```
→ 58/58 tests passed, including the "confused deputy" test (github-signed delivery must not
complete an unrelated gitea instance's task merely because `pr_url` matches) and the existing
poll-mode-still-completes test.

```
CI=true pnpm test
```
→ 445/445 tests passed (node --test suites across `@kaola/shared`, `@kaola/forge-adapters`,
`@kaola/server`) plus `pnpm --filter @kaola/web test` → 51/51 vitest tests passed.

No test files were edited. Not committed.
