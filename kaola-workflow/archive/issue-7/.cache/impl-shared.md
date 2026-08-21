# impl-shared — green proof

**Task**: widen `taskBriefSchema.credential` in `packages/shared/src/index.ts` into the two-form
union documented in `docs/DESIGN.md` §6 (lines 145-152 in this worktree): `{ profile_id: string }`
(shared credential profile reference) or `{ inline: true }` (single-task temporary token attached;
ciphertext lives on the task row, never in the brief). Neither form carries token material.

**Verification tier**: `tests-green` — the authored suite `packages/shared/src/index.test.ts`
(custody: tests-shared) is the oracle and it passes 112/112.

**Worktree**: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`

**Files changed**: `packages/shared/src/index.ts` (one file, the only file in scope). No test file
was read-modified; no other package touched.

## Diff

```diff
diff --git a/packages/shared/src/index.ts b/packages/shared/src/index.ts
index 3479628..773fce7 100644
--- a/packages/shared/src/index.ts
+++ b/packages/shared/src/index.ts
@@ -45,9 +45,12 @@ export const taskBriefSchema = z.strictObject({
     branch_prefix: z.string(),
     title_prefix: z.string(),
   }),
-  credential: z.strictObject({
-    profile_id: z.string(),
-  }),
+  // DESIGN.md §6: a reference, never the token itself — exactly one of two forms. The inline
+  // marker only declares that a single-task token exists; its ciphertext lives on the task row.
+  credential: z.union([
+    z.strictObject({ profile_id: z.string() }),
+    z.strictObject({ inline: z.literal(true) }),
+  ]),
   priority: z.enum(['P0', 'P1', 'P2', 'P3']),
   tags: z.array(z.string()),
   poster: z.string(),
```

That is the entire change. Nothing else in `packages/shared` reads `credential`: `src/` holds only
`index.ts` and `index.test.ts`, `parseTaskBrief` is a bare `taskBriefSchema.parse` passthrough, and
`transitionTaskStatus` never touches the brief. A repo-wide grep for `taskBriefSchema` / `TaskBrief`
outside `packages/shared/src` found no source importer — only the `"@kaola/shared": "workspace:*"`
dependency line in `apps/server/package.json`. So the `TaskBrief` type widening to a union broke no
call site; no compensating edit was needed anywhere.

## Verification — before

```
$ cd /Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7
$ node --experimental-strip-types --test packages/shared/src/index.test.ts
ℹ tests 112
ℹ pass 109
ℹ fail 3
exit 1
```

The 3 RED tests were exactly the inline-form cases:

```
✖ parseTaskBrief accepts credential { inline: true } — the single-task temporary token form
✖ parseTaskBrief round-trips credential { inline: true } without adding or dropping keys
✖ parseTaskBrief accepts the DESIGN.md §6 example when its credential row is the inline form
```

each failing with `ZodError ... "Unrecognized key: \"inline\""` from the old single strictObject.

## Verification — after

```
$ node --experimental-strip-types --test packages/shared/src/index.test.ts
ℹ tests 112
ℹ suites 3
ℹ pass 112
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 77.993458
exit 0
```

The full `parseTaskBrief credential union` suite, verbatim:

```
▶ parseTaskBrief credential union
  ✔ parseTaskBrief accepts credential { profile_id } — the shared credential profile form (0.155875ms)
  ✔ parseTaskBrief accepts credential { inline: true } — the single-task temporary token form (0.048458ms)
  ✔ parseTaskBrief round-trips credential { inline: true } without adding or dropping keys (0.045542ms)
  ✔ parseTaskBrief accepts the DESIGN.md §6 example when its credential row is the inline form (0.032792ms)
  ✔ parseTaskBrief rejects credential { inline: false } — inline is a marker, only true is legal (0.05675ms)
  ✔ parseTaskBrief rejects credential carrying both profile_id and inline (二选一, exactly one form) (0.049083ms)
  ✔ parseTaskBrief rejects credential inline of non-boolean type "yes" (0.058459ms)
  ✔ parseTaskBrief rejects credential inline of non-boolean type "true" (0.048417ms)
  ✔ parseTaskBrief rejects credential inline of non-boolean type 1 (0.032625ms)
  ✔ parseTaskBrief rejects credential inline of non-boolean type 0 (0.029667ms)
  ✔ parseTaskBrief rejects credential inline of non-boolean type null (0.027625ms)
  ✔ parseTaskBrief rejects credential inline of non-boolean type [] (0.027917ms)
  ✔ parseTaskBrief rejects credential inline of non-boolean type {} (0.026708ms)
  ✔ parseTaskBrief rejects credential {} — neither form is present (0.043667ms)
  ✔ parseTaskBrief rejects a credential shape that is neither profile_id nor inline (0.036625ms)
  ✔ parseTaskBrief rejects an unknown extra key alongside profile_id (0.035917ms)
  ✔ parseTaskBrief rejects an unknown extra key alongside inline: true (0.037917ms)
  ✔ parseTaskBrief rejects a raw token alongside inline: true (0.035334ms)
  ✔ parseTaskBrief rejects a ciphertext-bearing credential even in the inline form (0.050791ms)
  ✔ parseTaskBrief rejects profile_id that is not a string (0.044417ms)
  ✔ parseTaskBrief rejects credential that is not an object: "cp-gitea-orders" (0.034334ms)
  ✔ parseTaskBrief rejects credential that is not an object: 42 (0.039042ms)
  ✔ parseTaskBrief rejects credential that is not an object: true (0.031708ms)
  ✔ parseTaskBrief rejects credential that is not an object: null (0.025833ms)
  ✔ parseTaskBrief rejects credential that is not an object: [] (0.025875ms)
✔ parseTaskBrief credential union (1.531125ms)
```

The security-boundary tests that predate the union stayed green — nothing was weakened to fit:

```
  ✔ parseTaskBrief rejects a raw token field on the brief
  ✔ parseTaskBrief rejects credential that has no profile_id
  ✔ parseTaskBrief rejects a raw token field inside credential
  ✔ parseTaskBrief rejects credential that includes both profile_id and a raw token
```

### Typecheck

```
$ ./node_modules/.bin/tsc --noEmit -p packages/shared/tsconfig.json
(no output)
exit 0
```

### Lint

```
$ npx eslint packages/shared/src/index.ts
(no output)
exit 0
```

`pnpm test` (root) was deliberately NOT run: another agent is mid-edit on `apps/server/src/tasks.test.ts`
and the root `package.json` in this same worktree, so a full-suite run would report a torn tree.
`pnpm install` was not run. Scope held to the one assigned file.

## Choices the tests forced

- **`z.union`, not `z.discriminatedUnion`.** The two members share no common key, so there is no
  discriminator to key on. Confirmed against the suggestion from the test author, who verified the
  shape standalone against zod 4.4.3 (version confirmed here at
  `packages/shared/node_modules/zod/package.json` → `4.4.3`).
- **Both members `z.strictObject`, not `z.object`.** The mutual unknown-key rejection is the whole
  mechanism behind four separate assertions: `{ profile_id, inline: true }` (二选一), the two
  extra-key cases, and — load-bearing for security — `{ inline: true, token: ... }` and
  `{ inline: true, token_ciphertext: ... }`. With `z.object` those five would silently pass by
  key-stripping and the token invariant would have a hole in the inline form.
- **`z.literal(true)`, not `z.boolean()`.** The test at `index.test.ts:282` pins `{ inline: false }`
  as rejected, with a comment stating the reasoning: `inline` is a marker, `false` would be a second
  redundant encoding of "no inline credential" (the `profile_id` form already says that). This is
  the one place I would plausibly have written `z.boolean()` on my own; the test decides it, and its
  reasoning holds up against DESIGN.md §6, which lists `{ "inline": true }` and gives `false` no
  meaning.

Nothing in the suite asserted anything I consider wrong; no findings to route back to the test author.
