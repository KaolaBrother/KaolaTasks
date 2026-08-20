# Zod version and APIs for `@kaola/shared` (issue #2)

**Retrieval date:** 2026-08-20  
**Source:** knowledge-lookup subagent (citations at end).

## 1. Version to depend on

**Use Zod 4.** npm `latest` on 2026-08-20: `4.4.3`. Recommended range: `"zod": "^4.4.3"` as a **runtime dependency** of `@kaola/shared`.

Do not use Zod 3 (EOL for new libraries). Do not use canary.

## 2. Import

Prefer:

```ts
import * as z from "zod";
```

Works under Node 22 + `"type": "module"` + `moduleResolution: "NodeNext"` + `verbatimModuleSyntax`. `import { z } from "zod"` is valid but esbuild can pull every locale; namespace import avoids that.

## 3. APIs

- Status: `z.enum(["待认领", "进行中", "待验收", "已完成", "已退回", "已取消"])` with the array inline / `as const`. Do not use `z.nativeEnum()`.
- `source`: nest `z.discriminatedUnion("type", [ z.object({ type: z.literal("native") }), z.object({ type: z.literal("imported"), issue_url: z.string() }) ])`. Discriminator is `"type"` on the source object, not `"source.type"`.
- `created_at`: `z.iso.datetime({ offset: true })` — default `z.iso.datetime()` **rejects** `+08:00`. `z.string().datetime()` is deprecated.
- Parse: `.parse` throws `z.ZodError`; `.safeParse` returns `{ success, data | error }`. `z.infer<typeof schema>`. Issues live on `.issues`.
- Unknown keys: `z.object()` **strips**; `z.strictObject()` throws. Use `z.strictObject` so a raw `token` field is rejected.

## 4. Peers

None. Zod 4.4.3 has zero dependencies.

## 5. One-liners

- package.json: `"zod": "^4.4.3"`
- import: `import * as z from "zod"`
- APIs: `z.enum`, `z.discriminatedUnion("type", ...)`, `z.iso.datetime({ offset: true })`, `.parse` / `.safeParse` / `z.infer`

## Sources (retrieved 2026-08-20)

- https://registry.npmjs.org/zod/latest — 4.4.3
- https://zod.dev/ , https://zod.dev/api , https://zod.dev/v4/changelog
- https://github.com/colinhacks/zod/releases/tag/v4.4.3
