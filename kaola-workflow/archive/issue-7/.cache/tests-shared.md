# tests-shared — credential union (issue #7)

Author: tdd-guide. Test custody only — no production code was written or modified.
File touched: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7/packages/shared/src/index.test.ts`
(appended one new `describe` block after the existing `parseTaskBrief` block, at lines 234-363 (file is now 393 lines);
all 87 pre-existing tests are byte-identical and still pass).

Baseline commit: `b8f27d91d4e8b17c9e2120b41244e5ea7dc81a48`
(worktree has `docs/DESIGN.md` modified; `packages/shared/src/index.ts` is unchanged from this commit —
`credential: z.strictObject({ profile_id: z.string() })`).

## RED signature

```
RED: parseTaskBrief accepts credential { inline: true } — the single-task temporary token form
     — ZodError: Unrecognized key: "inline" (+ expected string, received undefined at credential.profile_id)
baseline: b8f27d91d4e8b17c9e2120b41244e5ea7dc81a48
```

## Baseline run (verbatim)

Command, run from `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-7`:

```
node --experimental-strip-types --test packages/shared/src/index.test.ts
```

Counts before my edit: `tests 87 / suites 2 / pass 87 / fail 0`.
Counts after my edit, still with no implementation:

```
ℹ tests 112
ℹ suites 3
ℹ pass 109
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The three failures — and only these three — are the ones that require the union to exist:

```
✖ failing tests:

test at packages/shared/src/index.test.ts:250:3
✖ parseTaskBrief accepts credential { inline: true } — the single-task temporary token form (0.144917ms)
  ZodError: [
    {
      "expected": "string",
      "code": "invalid_type",
      "path": [
        "credential",
        "profile_id"
      ],
      "message": "Invalid input: expected string, received undefined"
    },
    {
      "code": "unrecognized_keys",
      "keys": [
        "inline"
      ],
      "path": [
        "credential"
      ],
      "message": "Unrecognized key: \"inline\""
    }
  ]
      at parseTaskBrief (file:///.../packages/shared/src/index.ts:62:26)
      at TestContext.<anonymous> (file:///.../packages/shared/src/index.test.ts:254:20)

test at packages/shared/src/index.test.ts:258:3
✖ parseTaskBrief round-trips credential { inline: true } without adding or dropping keys (0.083166ms)
  ZodError: [ ...identical two issues: invalid_type at credential.profile_id, unrecognized_keys "inline"... ]
      at parseTaskBrief (file:///.../packages/shared/src/index.ts:62:26)
      at TestContext.<anonymous> (file:///.../packages/shared/src/index.test.ts:262:20)

test at packages/shared/src/index.test.ts:270:3
✖ parseTaskBrief accepts the DESIGN.md §6 example when its credential row is the inline form (0.048042ms)
  ZodError: [ ...identical two issues: invalid_type at credential.profile_id, unrecognized_keys "inline"... ]
      at parseTaskBrief (file:///.../packages/shared/src/index.ts:62:26)
      at TestContext.<anonymous> (file:///.../packages/shared/src/index.test.ts:274:22)
```

The full untruncated run is reproducible with the command above; the two elided ZodError bodies are
character-identical to the first one.

## Tests added (25), exact names

New suite `parseTaskBrief credential union`:

Fail at baseline (the actual RED — they need the union):
1. `parseTaskBrief accepts credential { inline: true } — the single-task temporary token form`
2. `parseTaskBrief round-trips credential { inline: true } without adding or dropping keys`
3. `parseTaskBrief accepts the DESIGN.md §6 example when its credential row is the inline form`

Pass at baseline — deliberate invariant guards, not filler. Today `strictObject` rejects all of
these for the trivial reason that only `profile_id` is known; after the union lands they are the
only thing stopping a loose implementation (`z.object` instead of `z.strictObject`, `z.boolean()`
instead of `z.literal(true)`, `.and()`/merge instead of a real either-or) from opening a hole:
4. `parseTaskBrief accepts credential { profile_id } — the shared credential profile form` (regression: existing form must keep working)
5. `parseTaskBrief rejects credential { inline: false } — inline is a marker, only true is legal`
6. `parseTaskBrief rejects credential carrying both profile_id and inline (二选一, exactly one form)`
7-13. `parseTaskBrief rejects credential inline of non-boolean type X` for X in `"yes"`, `"true"`, `1`, `0`, `null`, `[]`, `{}`
14. `parseTaskBrief rejects credential {} — neither form is present`
15. `parseTaskBrief rejects a credential shape that is neither profile_id nor inline`
16. `parseTaskBrief rejects an unknown extra key alongside profile_id`
17. `parseTaskBrief rejects an unknown extra key alongside inline: true`
18. `parseTaskBrief rejects a raw token alongside inline: true`
19. `parseTaskBrief rejects a ciphertext-bearing credential even in the inline form`
20. `parseTaskBrief rejects profile_id that is not a string`
21-25. `parseTaskBrief rejects credential that is not an object: X` for X in `"cp-gitea-orders"`, `42`, `true`, `null`, `[]`

Pre-existing tests confirmed still passing unchanged (the security invariant, lines 202-231):
`parseTaskBrief rejects a raw token field on the brief`,
`parseTaskBrief rejects credential that has no profile_id`,
`parseTaskBrief rejects a raw token field inside credential`,
`parseTaskBrief rejects credential that includes both profile_id and a raw token`.
Also still passing: `parseTaskBrief accepts the DESIGN.md §6 Task Brief example ...` — the DESIGN
example object itself was not changed by the §6 edit (only the trailing comment and the new table
below it), so that test does cover the updated example as written.

## Suggested zod shape (a suggestion, not a mandate)

Replace lines 48-50 of `packages/shared/src/index.ts` with:

```ts
  // DESIGN.md §6: a reference, never the token itself — exactly one of two forms.
  credential: z.union([
    z.strictObject({ profile_id: z.string() }),
    z.strictObject({ inline: z.literal(true) }),
  ]),
```

Verified against every credential value the suite uses, by running the shape standalone against
zod 4.4.3 (the version in this worktree): all 2 accept-cases parse and round-trip byte-identical,
all 23 reject-cases throw. Notes for whoever implements it:

- It must be `z.union`, not `z.discriminatedUnion` — the two forms share no discriminator key.
- Both members must be `strictObject`. That is what makes `{ profile_id, inline: true }`,
  `{ inline: true, token }` and every extra-key case fail: each member rejects the other's key as
  unrecognized, so no member accepts, so the union rejects. Swap either one for `z.object` and
  tests 6, 16-19 go red.
- `z.literal(true)`, not `z.boolean()` — test 5 pins that.
- Exported `TaskBrief` type becomes `credential: { profile_id: string } | { inline: true }`;
  any server-side consumer that reads `brief.credential.profile_id` unguarded will now fail
  typecheck. Nothing in `apps/server` imports `taskBriefSchema` today, so this should be inert,
  but check before assuming.

## Rulings I had to make, and DESIGN ambiguities

1. **`{ inline: false }` is illegal.** DESIGN §6 lists exactly two forms and gives `inline: false`
   no meaning; a task with no attached token uses the `profile_id` form, so `false` would be a
   second, redundant encoding of "no inline credential". Pinned as rejected via `z.literal(true)`,
   with an explanatory comment in the test file so it reads as a decision. If the product actually
   wants `inline: false` to be a legal no-op, this is the one test to change — and DESIGN §6 should
   say so first.
2. **Empty-string `profile_id` is left legal.** Current schema is `z.string()` and DESIGN says
   nothing about format or non-emptiness (contrast `id`, which §6 does pin as `kt-<year>-<4 digits>`).
   I did not invent a constraint. Worth a DESIGN sentence if profile ids have a shape.
3. **DESIGN §6 says the inline ciphertext "随任务存储" (stored with the task) but does not name the
   task-row column.** Out of scope for the brief schema — the brief only carries the marker — but the
   task-row/DB work for issue #7 needs that name settled somewhere.
4. **`二选一` is read as exclusive-or, not inclusive-or.** Test 6 pins that both forms at once throws.
   The DESIGN table plus "二选一" supports this reading; flagging it only because "either-or" is
   occasionally written loosely in Chinese specs.
