# Ground truth: forge-smoke harness (#56 / #57 / #58)

Measured from worktree `/workspace/.kw/worktrees/bundle-56-57-58` at `3d04f28` (`cursor/smoke-uat-fixes-772b`). Path C is already on this tree. Source of this note is that worktree, not `/workspace` main checkout.

**This note does not choose a fix.** Empty-file policy is already pinned by the orchestrator: **empty `go` waits (same as missing)**. Recorded here as a given, not a recommendation.

Issue comments (claim/handoff) do not change the defect descriptions. #56 body still says empty file is “continue wait or fail immediately, pick one and document”; the run playbook already picked **wait**.

---

## Given (orchestrator, do not reopen)

- Empty `UAT_HOLD_DIR/go` (including whitespace-only after `.trim()`) **waits**, same as a missing file.
- Do not change product API, login, or token-reveal.
- Path B without `--web` must stay loopback.
- Do not loosen production `getPullRequest` default 10s unless a separate product contract says so.

---

## Worktree identity

| Field | Value |
|-------|--------|
| HEAD | `3d04f280f15f9575e81386e2c647fd5424f13197` (`3d04f28 chore: archive issue-55 [sink]`) |
| Branch | `cursor/smoke-uat-fixes-772b` |
| Script | `scripts/forge-smoke.ts` (1037 lines) |
| Handbook | `docs/smoke-test.md` |

---

## Shared primitives (needed by all three claims)

### `fail()` throws; it does not `process.exit`

```105:107:scripts/forge-smoke.ts
function fail(message: string): never {
  throw new Error(message)
}
```

Callers that `try { … fail(…) } catch { }` **swallow** the failure. The CLI only turns an uncaught throw into exit 1 at the bottom of the file:

```1029:1036:scripts/forge-smoke.ts
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  run().catch((err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err)
    console.error(message)
    process.exitCode = 1
  })
}
```

Importing the file as a module (Node test) does **not** run `run()` because `isMain` is false.

### `redact`

```155:161:scripts/forge-smoke.ts
function redact(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('***')
  }
  return out
}
```

`secrets` in `run()` is `[token, STUB_OAUTH_ACCESS]` (`GITLAB_TOKEN`/`GITEA_TOKEN` plus the OAuth stub string). Later `revealed` (claim token) is **not** added to `secrets` before `waitForUatFlag` (the live PAT and the claim token are usually the same string from the profile). Redact is substring replace, not regex.

### Export surface (decides how tests can reach helpers)

**Only one named export:**

```121:133:scripts/forge-smoke.ts
export function ensureSimulatedAuthEnv(): void {
  fillEnvIfEmpty('SESSION_SECRET', randomBytes(32).toString('hex'))
  …
  fillEnvIfEmpty('PUBLIC_URL', 'http://localhost:31415')
  …
}
```

**Not exported:** `fail`, `redact`, `waitForUatFlag`, `uatHoldTimeoutMs`, `uatHoldDir`, `waitForForgeHead`, `parseArgs`, `run`, `listenHost` logic.

There is **no** `scripts/*.test.ts` today. No test file imports `scripts/forge-smoke.ts` (repo-wide search of `from '…forge-smoke'` / `forge-smoke.ts` in `*.test.ts` is empty except a comment in `apps/server/src/lifecycle-matrix.test.ts`).

This is a closed CLI script with a single incidental export. Acceptance tests will need a new `scripts/forge-smoke.test.ts` (or similar) **and** named exports (or a extracted helper module). **This measurement pass does not export anything.**

To be reachable without executing the live forge loop, a later test author would typically export (or extract):

- `waitForUatFlag` (and possibly `redact` / `uatHoldTimeoutMs` if tests should not reimplement them)
- the listen-host resolution (`web ? (UAT_WEB_HOST \|\| '0.0.0.0') : '127.0.0.1'` today)
- `waitForForgeHead` (and a seam to inject `getPullRequest`, because today it always constructs a real adapter)

`run()` should stay behind the `isMain` gate.

---

## #56 `waitForUatFlag`

### Claim vs current behavior

| Claim (#56) | Current code |
|-------------|--------------|
| Wrong non-empty `go` content should fail immediately; handbook says 内容不对则失败 | **Not true of runtime.** `fail('unexpected UAT flag …')` is inside the same `try` as `readFileSync`. Empty `catch` treats it as “file missing”. Loop continues until `UAT_HOLD_TIMEOUT_MS`. If the file is later corrected, the bad content is forgotten. |
| Missing file: keep waiting | **True.** `readFileSync` throws `ENOENT`; catch swallows; poll continues. |
| Empty file: pick wait or fail | **Already waits** (see given). `got === ''` skips both the success branch and `if (got !== '') fail(…)`. |

**Verdict: claimed bug is real** for unexpected non-empty content. Empty file already matches the orchestrator given.

### Full function

```571:590:scripts/forge-smoke.ts
async function waitForUatFlag(dir: string, expected: string, secrets: string[]): Promise<void> {
  const flag = join(dir, 'go')
  const deadline = Date.now() + uatHoldTimeoutMs()
  console.log(`uat_wait ${expected} timeout_ms=${uatHoldTimeoutMs()}`)
  while (Date.now() < deadline) {
    try {
      const got = redact(readFileSync(flag, 'utf8').trim(), secrets)
      if (got === expected) {
        unlinkSync(flag)
        console.log(`uat_flag ${expected}`)
        return
      }
      if (got !== '') fail(`unexpected UAT flag ${JSON.stringify(got)} (want ${expected})`)
    } catch {
      // flag file missing
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  fail(`timed out waiting for ${flag} to contain ${expected}`)
}
```

Timeout helper:

```560:564:scripts/forge-smoke.ts
function uatHoldTimeoutMs(): number {
  const raw = process.env.UAT_HOLD_TIMEOUT_MS
  const parsed = raw != null && raw !== '' ? Number.parseInt(raw, 10) : 1_800_000
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1_800_000
}
```

Hold dir:

```554:558:scripts/forge-smoke.ts
function uatHoldDir(): string {
  return process.env.UAT_HOLD_DIR != null && process.env.UAT_HOLD_DIR !== ''
    ? process.env.UAT_HOLD_DIR
    : join(tmpdir(), 'kaola-uat-web')
}
```

### What is in the `try`, what the empty `catch` swallows

**Inside try:**

1. `readFileSync(flag, 'utf8')` — missing file → throw
2. `.trim()` then `redact(…, secrets)` — comparison and log payload are redacted **before** equality check
3. exact `got === expected` → `unlinkSync(flag)` then `console.log('uat_flag ' + expected)` (logs expected, not actual)
4. `got !== ''` → `fail(...)` which **throws `Error`**
5. empty `got` → fall through out of try with no throw (wait)

**Empty catch swallows every throw**, not only ENOENT:

- missing `go` (`ENOENT`) — intended
- `fail('unexpected UAT flag …')` — **the defect**
- `unlinkSync` failure after a match (would retry until timeout; flag may still exist)
- permission / EISDIR / encoding errors

There is no `err.code === 'ENOENT'` filter.

### Timeout env, poll interval, expected values

| Knob | Value |
|------|--------|
| `UAT_HOLD_TIMEOUT_MS` unset/empty/non-positive/NaN | `1_800_000` (30 minutes) |
| Valid positive integer | that many ms |
| Poll interval | **500 ms** (hardcoded) |
| Flag path | `join(dir, 'go')` |
| Expected values at callers | `'round-done'` then `'approved'` |
| Match | after `trim` + `redact`, **strict `===`**, not “first line only” beyond trim (a second line makes `got` not equal) |

Handbook says “恰好一行”; code does not split lines — it trims the whole file. `"round-done\n"` after trim is `"round-done"` and matches. `"round-done\nextra"` does not.

### Callers (Path C only)

Both are inside `if (web)`. Path B never calls this function.

1. After undeclared-push + `waitForForgeHead`, first UI hold (`phase: 'awaiting_ui_stale'`):

```864:877:scripts/forge-smoke.ts
    if (web) {
      writeUatState(holdDir, { phase: 'awaiting_ui_stale', … })
      console.log(`uat_hold ${holdDir} task ${task.id}`)
      await waitForUatFlag(holdDir, 'round-done', secrets)
```

2. After second `submit_revision`, second UI hold (`phase: 'awaiting_ui_approve'`):

```950:960:scripts/forge-smoke.ts
    if (web) {
      writeUatState(holdDir, { phase: 'awaiting_ui_approve', … })
      await waitForUatFlag(holdDir, 'approved', secrets)
```

`holdDir` is `uatHoldDir()` only when `web` is true; otherwise `''` (unused).

### How `redact` hits flags / logs

- Applied to **file bytes** before compare and before the fail message.
- Fail string: `` unexpected UAT flag ${JSON.stringify(got)} (want ${expected}) `` — `got` is already redacted, so a PAT pasted into `go` becomes `***` in the throw message **if that throw ever escaped the catch**. Today it does not escape.
- Success log does not print file contents.
- Timeout log: `` timed out waiting for ${flag} to contain ${expected} `` — path + expected only.

### Empty / missing / wrong matrix (current)

| `go` | Current |
|------|---------|
| absent | wait (ENOENT swallowed) |
| empty or whitespace-only | wait (no throw) — **given** |
| non-empty ≠ expected | **wait until hold timeout** (fail swallowed) — **bug vs handbook / #56** |
| exact expected after trim+redact | unlink, return |
| hold deadline exceeded | `fail('timed out waiting for …')` **outside** try → uncaught → exit 1 |

---

## #57 `--web` `listenHost`

### Claim vs current behavior

| Claim (#57) | Current code |
|-------------|--------------|
| Path B binds `127.0.0.1` | **True.** `listenHost = '127.0.0.1'` when `web` is false. |
| Path C `--web` default `UAT_WEB_HOST \|\| '0.0.0.0'` | **True.** |
| `PUBLIC_URL` is `http://localhost:${UAT_WEB_PORT}` | **True** (forced when `web`). |
| Isolated sqlite uses `DEFAULT_SETUP` and holds the live PAT | **True** (`ensureSetup(app, DEFAULT_SETUP)`; profile POST includes `token`). |
| `skipUntrusted` does not block sessions when `PUBLIC_URL` is `http://` | **True** (see below). |
| Docker Compose production still publishes loopback only | **True** and **orthogonal** — this defect is harness bind, not compose. |
| Handbook HTTP row does not say listen is `0.0.0.0` | **True** — it says default URL `http://localhost:31416`. Pit list **does** name `0.0.0.0` (see handbook quotes). |

**Verdict: claimed bug is real** for Path C default bind.

### Exact listen / PUBLIC_URL / env

```592:630:scripts/forge-smoke.ts
async function run(): Promise<void> {
  const { kind, web } = parseArgs(process.argv)
  const spec = FORGES[kind]
  const webPort = Number.parseInt(process.env.UAT_WEB_PORT ?? '31416', 10)
  if (web) {
    if (!Number.isInteger(webPort) || webPort <= 0) fail(`invalid UAT_WEB_PORT ${process.env.UAT_WEB_PORT}`)
    process.env.PUBLIC_URL = `http://localhost:${webPort}`
  }
  ensureSimulatedAuthEnv()
  …
  const viteDevTarget =
    process.env.VITE_DEV_TARGET != null && process.env.VITE_DEV_TARGET !== ''
      ? process.env.VITE_DEV_TARGET
      : 'http://127.0.0.1:5173'
  const app = buildApp({
    sqlitePath,
    pollIntervalMs: web ? 2_000 : 0,
    viteDevTarget: web ? viteDevTarget : undefined,
  })
  …
    const listenHost = web ? (process.env.UAT_WEB_HOST || '0.0.0.0') : '127.0.0.1'
    const bridgeUrl = await app.listen({ host: listenHost, port: web ? webPort : 0 })
    const origin = web ? `http://localhost:${webPort}` : bridgeUrl
    if (web) console.log(`uat_origin ${origin}`)
```

`--web` comes from `parseArgs` (`token === '--web'`). `pnpm smoke:forge` and `pnpm smoke:uat` are the **same** script.

| Mode | `listenHost` | `port` | `PUBLIC_URL` | Browser origin log |
|------|--------------|--------|--------------|--------------------|
| Path B (no `--web`) | **hardcoded `'127.0.0.1'`** (`UAT_WEB_HOST` ignored) | `0` (ephemeral) | `fillEnvIfEmpty` → `http://localhost:31415` if unset | none; MCP uses Fastify listen URL (`bridgeUrl`) |
| Path C (`--web`) | `process.env.UAT_WEB_HOST \|\| '0.0.0.0'` | `UAT_WEB_PORT` default **31416** | **overwritten** to `http://localhost:${webPort}` **before** `ensureSimulatedAuthEnv` (so a pre-set `PUBLIC_URL` is replaced) | `http://localhost:${webPort}` |

`UAT_WEB_HOST` empty string is falsy → still `'0.0.0.0'`. Only a non-empty string overrides.

Bound API is **Fastify `app.listen({ host, port })`** from `buildApp` (`apps/server/src/app.ts`). Not `http.createServer` directly. Path C also sets `viteDevTarget` so the same listener reverse-proxies Vue.

### `skipUntrusted` / HTTP localhost — relevant, does not mitigate LAN bind

`persistSession(..., { skipUntrusted: true })` on setup/login/OAuth (`apps/server/src/auth.ts`). Skip fires only when **all** of:

- session cookie `secure === true` (`cookieSecureFromPublicUrl()` → trimmed `PUBLIC_URL` **starts with `https:`**)
- `request.protocol !== 'https'`
- peer is not loopback/RFC1918 (`COOKIE_SECURE_TRUST_PROXY`)

Path C forces `PUBLIC_URL=http://localhost:…` → cookie **not** Secure → `shouldSkipSessionSave` is false → sessions **are** saved for any peer that can hit the port.

So `skipUntrusted` does **not** protect an `0.0.0.0` HTTP UAT listener. A LAN client can POST `/api/v1/login` with `DEFAULT_SETUP` (`kaola-admin` / `correct-horse-battery` in `apps/server/src/auth.test-helpers.ts`) against the isolated sqlite that also stores the live forge PAT (reveal still only on claim `201` / MCP `claim_task`, but the process holds the secret).

Path B listener is loopback + APIs mostly `inject`; MCP stdio talks to `127.0.0.1`.

### Harness-only vs Docker Compose

**Harness:** `scripts/forge-smoke.ts` listen above.

**Compose** (`docker-compose.yml`):

```yaml
ports:
  - "127.0.0.1:31415:31415"
environment:
  HOST: "0.0.0.0"
```

Host publish is loopback. Container process binds all interfaces **inside** the network namespace; that is production-entry design, not the smoke default. Production boot (`apps/server/src/index.ts`) is `HOST ?? '0.0.0.0'` + `PORT ?? 31415` — also not this ticket.

Do not treat a smoke `--web` bind change as a compose/`HOST` change.

---

## #58 `waitForForgeHead`

### Claim vs current behavior

| Claim (#58) | Current code |
|-------------|--------------|
| `createForgeAdapter` in the waiter is **not** passed `timeoutMs` | **True.** `{ baseUrl: spec.baseUrl }` only. |
| Per-call abort is package `DEFAULT_TIMEOUT_MS = 10_000` | **True.** |
| One `TimeoutError` from `getPullRequest` fails the **whole** smoke, not one poll | **True.** No try/catch in the loop. |
| Outer wait is 90s with 3s sleep when sha mismatches | **True**, but that path is never reached if the await throws. |
| Handbook / live log: GitLab Path B needed `KAOLA_FORGE_TIMEOUT_MS=30000` | **Env name is not implemented in this tree.** Setting `KAOLA_FORGE_TIMEOUT_MS` does **not** change adapter timeout. See below. |
| Do not loosen production default 10s | Production default is package-local; smoke is a separate caller. |

**Verdict: claimed abort-on-first-timeout is real.** The documented env workaround is **not wired** in source; a later retry succeeding under that env is unexplained by this tree (forge faster, coincidence, or out-of-tree wrapper). Tests should not assume the env currently works.

### Full function

```516:530:scripts/forge-smoke.ts
// Issue #54: a forge reports a pushed head on its PR object only eventually …
async function waitForForgeHead(kind: ForgeKind, spec: ForgeSpec, token: string, prUrl: string, expected: string): Promise<void> {
  const adapter = createForgeAdapter(kind, { baseUrl: spec.baseUrl })
  const deadline = Date.now() + 90_000
  let seen = ''
  while (Date.now() < deadline) {
    seen = (await adapter.getPullRequest({ token }, prUrl)).head_sha
    if (seen === expected) return
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  fail(`forge never reported pushed head ${expected.slice(0, 12)} within 90s (last seen ${seen.slice(0, 12)})`)
}
```

| Knob | Value |
|------|--------|
| Loop deadline | **90_000 ms hardcoded** (not env) |
| Sleep on sha mismatch | **3_000 ms** |
| Per `getPullRequest` abort | `options.timeoutMs ?? DEFAULT_TIMEOUT_MS` → **10_000** |
| `timeoutMs` passed? | **No** |
| Timeout / HTTP error handling | **none** — any rejection leaves the while |

Mismatch-only continues. Throw aborts. After 90s of successful-but-wrong sha, `fail(...)`.

### Caller (Path B **and** Path C)

Single call, after undeclared follow-up push, **before** the `if (web)` split:

```860:862:scripts/forge-smoke.ts
    const driftLine = `Smoke undeclared push ${kind} ${task.id} ${stamp}.`
    const driftSha = pushFollowUp({ dir: pushed.dir, header: pushed.header, branch, line: driftLine, secrets })
    await waitForForgeHead(kind, spec, revealed, pull.url, driftSha)
```

This is immediately after the **first** `submit_revision` (revision claim), not after the second. Token is `revealed` (claim envelope), not the env PAT variable name.

A later `createForgeAdapter(kind, { baseUrl: spec.baseUrl })` at line 986 (post-approve draft check) also omits `timeoutMs`. Out of #58’s wait-loop claim, but the same 10s abort applies to that single call.

### Production adapter timeout location (package, not smoke)

File: `packages/forge-adapters/src/index.ts`

```83:87:packages/forge-adapters/src/index.ts
export type CreateForgeAdapterOptions = {
  baseUrl?: string
  webhookSecret?: string
  timeoutMs?: number
}
```

```93:97:packages/forge-adapters/src/index.ts
// Issue #37: every outbound forge fetch must carry a bounded, configurable abort deadline …
const DEFAULT_TIMEOUT_MS = 10_000
```

**Not exported.** Callers cannot `import { DEFAULT_TIMEOUT_MS }`.

Threaded into every verb via `forgeRequest`:

```883:900:packages/forge-adapters/src/index.ts
async function forgeRequest(…): Promise<Response> {
  …
  return globalThis.fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
}
```

`getPullRequest` uses `forgeGet` → `forgeRequest`. Non-OK → `throw new Error(\`getPullRequest: ${kind} responded ${res.status}\`)` (also uncaught by the waiter). Hang/slow → undici `TimeoutError` / `DOMException` (`The operation was aborted due to timeout`) as in the GitLab live log.

**There is no `process.env.KAOLA_FORGE_TIMEOUT_MS` reader** in `packages/forge-adapters`, `scripts/forge-smoke.ts`, or `apps/server`. Grep hits **only** `docs/smoke-test.md`. Configurable timeout is **constructor option `timeoutMs`**, not an env.

Other production call sites (context only; do not change for this bundle):

- Most server `createForgeAdapter(..., { baseUrl })` — inherit 10s (`poller.ts`, `tasks.ts`, …)
- Writeback: `timeoutMs: WRITEBACK_TIMEOUT_MS` (30_000) in `apps/server/src/writeback.ts`
- Review mark-ready: `timeoutMs: MARK_READY_TIMEOUT_MS` (30_000) in `apps/server/src/review.ts`

Those 30s values are **not** the smoke waiter.

### Deadline vs per-call timeout (pin this for tests)

Two clocks, independent:

1. **Per fetch:** `AbortSignal.timeout(10_000)` unless `timeoutMs` set. Fires even if 80s remain on the outer loop.
2. **Outer loop:** 90s wall clock, only advances on **resolved** `getPullRequest` whose `head_sha !== expected`.

A single 10s abort **does not** “count as a poll and continue.” It rejects `waitForForgeHead`, `run().catch` prints the stack, `process.exitCode = 1`. The 90s lag wait from #54 never runs.

Suggested product directions in #58 (longer smoke `timeoutMs` **or** treat `TimeoutError` as continue-poll) are **not chosen here**. Acceptance should pin observable: one adapter timeout must not fail the 90s wait **without** changing `DEFAULT_TIMEOUT_MS` in the package.

---

## Handbook `docs/smoke-test.md` — current wording

### Path C hold flags (wrong content → fail)

Paragraph after the numbered hold protocol (lines 80–87):

> 脚本先把任务推到路径 B 的 #53 一轮 + #54 未申报提交（forge 已报告新头），任务停在 `待验收`。然后写入 `UAT_HOLD_DIR/state.json`（默认系统临时目录下的 `kaola-uat-web`，**不含 token、不含密码**）并等待旗标文件 `UAT_HOLD_DIR/go`：
>
> 1. … 写 `go`，内容恰好一行 `round-done`。
> 2. 脚本：bridge 再 `claim_task`（`review_round` 2）并以该漂移头 `submit_revision` → `待验收`。
> 3. … 写 `go`，内容恰好一行 `approved`。
> 4. …
>
> `UAT_HOLD_TIMEOUT_MS` 默认 30 分钟。… **超时或旗标内容不对则失败**，不把 UI 步骤编成已通过。未实际打开浏览器的跑法不要写路径 C 通过。

**Contradiction:** handbook “内容不对则失败”; code swallows `fail` until timeout. Empty file is not mentioned (orchestrator: wait).

Pit (line 237):

> 路径 C `waitForUatFlag` 把错误 `go` 内容的 `fail()` 放进空 `catch`，不会立刻失败。手册要求「内容不对则失败」。本轮未改该函数，见 [#56](https://github.com/KaolaBrother/KaolaTasks/issues/56)。

### HTTP listen default

Path B table (line 48):

> HTTP | 混合 | 发布侧 API 用 Fastify `inject`；真实 `kaola-mcp` stdio bridge 连接同一应用的临时 `127.0.0.1` listener

Path C table (line 74):

> HTTP | 真 listen | 默认 `http://localhost:31416`（`UAT_WEB_PORT`，不要抢已在跑的 `pnpm dev` :31415）。浏览器必须开 `localhost` 这个 host，不要 `127.0.0.1`

That row names the **URL host** for cookies, not the **listen address**.

Pit (line 236):

> 路径 C `--web` 默认 listen `0.0.0.0`（路径 B 是 `127.0.0.1`）。本轮 UAT 仍用该默认跑通，不改绑定，见 [#57](https://github.com/KaolaBrother/KaolaTasks/issues/57)。

`UAT_WEB_HOST` is **not** named in the handbook.

### GitLab `KAOLA_FORGE_TIMEOUT_MS=30000` pit

Results table (line 213), GitLab cell:

> 首次 [Issue #24](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/24) → [MR !20](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/20) 在 `waitForForgeHead` / `getPullRequest` 上 `TimeoutError`（#37 默认 10s），未合并；`KAOLA_FORGE_TIMEOUT_MS=30000` 复跑 [Issue #25](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/issues/25) → [MR !22](https://gitlab.com/KaolaBrother/kaola-tasks-smoke/-/merge_requests/22)，`clone_auth=gitlab-basic-oauth2`，`已完成`。缺口见 [#58](https://github.com/KaolaBrother/KaolaTasks/issues/58)

Pit (line 235):

> GitLab 路径 B 的 `waitForForgeHead` 每次 `getPullRequest` 走 #37 默认 10s：gitlab.com 偶发一次慢读会整段失败，而不是继续 poll。本轮用 `KAOLA_FORGE_TIMEOUT_MS=30000` 才复跑通过。不修脚本，见 [#58](https://github.com/KaolaBrother/KaolaTasks/issues/58)。

**Source fact:** that env is documentation-only in this commit. Adapter honors `timeoutMs` option + `DEFAULT_TIMEOUT_MS` only.

---

## Test surface

### Root `pnpm test`

`package.json` `"test"` is **one** `node --experimental-strip-types --test` invocation with an **explicit file list** (shared, forge-adapters, apps/server, apps/mcp), then `&& pnpm --filter @kaola/web test` (Vitest).

It is **not** a glob over `**/*.test.ts`. A new `scripts/forge-smoke.test.ts` **will not run** until that path is appended to the Node `--test` list.

Node 22+ (`engines.node: ">=22"`). `"type": "module"`. Specs use `node:test` + `node:assert/strict` and `.ts` specifiers; they rely on `--experimental-strip-types` (same as smoke: `node --experimental-strip-types scripts/forge-smoke.ts`).

### Existing imports of the smoke script

**None.** Do not assume `ensureSimulatedAuthEnv` is covered by unit tests.

### How a later test author can pin without a live forge

Because helpers are not exported, tests cannot currently import `waitForUatFlag` / `waitForForgeHead`. Options for the **next** mission (not this one):

1. Export the three helpers (and keep `run` behind `isMain`).
2. Move them to e.g. `scripts/forge-smoke-hold.ts` imported by both the CLI and tests.

For #56: temp dir, write `go`, stub short `UAT_HOLD_TIMEOUT_MS`, assert missing/empty wait vs wrong content **rejects immediately** (and message uses redact).

For #57: export or unit-test the host ternary; Path B must ignore `UAT_WEB_HOST`.

For #58: inject a `getPullRequest` that rejects `TimeoutError` once then returns the expected sha; outer wait should still succeed. Do **not** change `packages/forge-adapters/src/index.ts` `DEFAULT_TIMEOUT_MS`. Shared adapter timeout specs stay in `packages/forge-adapters/src/timeout.shared.test.ts`.

---

## Pin list for acceptance (facts only)

1. **#56:** unexpected non-empty `go` currently waits until hold timeout; handbook and issue require immediate fail with redacted actual. Missing waits. Empty waits (given).
2. **#57:** `--web` default listen `'0.0.0.0'`; override `UAT_WEB_HOST`; Path B `'127.0.0.1'` + port `0`. Compose `127.0.0.1:31415:31415` is unrelated. HTTP `PUBLIC_URL` means `skipUntrusted` does not block.
3. **#58:** waiter deadline 90s / poll 3s; per-call 10s via unexported `DEFAULT_TIMEOUT_MS` because `timeoutMs` omitted; first `TimeoutError` aborts the script. `KAOLA_FORGE_TIMEOUT_MS` is **not** read by production or smoke.
4. **Exports:** only `ensureSimulatedAuthEnv`. New `scripts/forge-smoke.test.ts` plus root `package.json` `test` list membership required for `pnpm test` to see harness tests.

---

## Files touched by later repair (inventory, not a patch)

| File | Why |
|------|-----|
| `scripts/forge-smoke.ts` | all three defects |
| `docs/smoke-test.md` | hold protocol, HTTP listen, GitLab timeout pit / results row |
| `package.json` | only if a new test file is added to `"test"` |
| `packages/forge-adapters/src/index.ts` | **out of scope** unless a new product contract changes `DEFAULT_TIMEOUT_MS` |

No DESIGN.md change is required for harness-only behavior.
