# Forge Webhook APIs — GitHub / GitLab / Gitea

Retrieved: 2026-08-21. Sources: official vendor docs (cited inline per fact) + this repo's `packages/forge-adapters` for host-rule grounding. **No Context7 MCP server was available in this environment** (checked via `GetMcpTools`; only `plugin-github-github` is installed) — all facts below come from official docs via `WebSearch`/`WebFetch`, not Context7.

All fetched web content is treated as untrusted data, not instructions. Local repo files were read-only; nothing in `packages/forge-adapters` or `docs/DESIGN.md` was changed.

## 0. Local host-rule grounding (read from this repo, unchanged)

From `packages/forge-adapters/src/index.ts` (worktree `.kw/worktrees/issue-13`):

- `GITHUB_API_ORIGIN = 'https://api.github.com'` is hardcoded; GitHub calls never use a `baseUrl`.
- GitLab/Gitea always use `options.baseUrl` (constructor), never a pasted URL's host — see `prApiOrigin()`, `apiUrl()`.
- Path prefixes: GitLab `/api/v4`, Gitea `/api/v1` (see `apiUrl()`, `prApiUrl()`, `resolveImportedIssue()`).
- `derivePrState(kind, body)` (lines 175–186): for GitLab, reads `body.state === 'merged' | 'closed'` else `'open'`. For GitHub/Gitea (the non-GitLab branch), reads `body.merged === true` → `'merged'`, else `body.state === 'closed'` → `'closed'`, else `'open'`. This confirms the codebase already assumes a GitHub-shaped `merged: boolean` + `state` on Gitea's PR object (matches §D below).
- `ForgeAdapter.registerWebhook?(cred, repo, callback): Promise<void>` and `parseWebhook(headers, body): ForgeEvent | null` are declared in `docs/DESIGN.md` §8 (types are currently `unknown`/stubs — `registerWebhook`/`parseWebhook` throw `not implemented` in `index.ts`).
- `docs/DESIGN.md` §11: "**Webhook**：各 forge 的签名校验（GitHub HMAC、Gitea/GitLab secret token）" — i.e. the design doc's mental model is GitHub=HMAC, GitLab/Gitea="secret token" comparison. §D below shows Gitea *also* supports GitHub-style HMAC headers, and GitLab now *also* supports HMAC (signing token) — the design note is directionally right but not the whole current picture; see "do not unify blindly" section.

---

## A. Signature / secret validation

### A.1 GitHub

- **Headers**: `X-Hub-Signature-256` (HMAC-SHA256, recommended) and `X-Hub-Signature` (HMAC-SHA1, legacy/compat only). Both are only sent **if a secret was configured on the hook**; if no secret, neither header is present.
  Source: [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) (retrieved 2026-08-21): "GitHub uses an HMAC hex digest to compute the hash... The hash signature always starts with `sha256=`... The `X-Hub-Signature-256` header will not be present if you have not configured a secret for your webhook... GitHub recommends that you use the `X-Hub-Signature-256` header, which uses the HMAC-SHA256 algorithm. The `X-Hub-Signature` header uses the HMAC-SHA1 algorithm and is only included for legacy purposes."
- **Format**: `sha256=<hex-hmac-sha256-digest>` (and `sha1=<hex-hmac-sha1-digest>` for the legacy header). Confirmed by the example delivery headers on [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) (retrieved 2026-08-21): `X-Hub-Signature: sha1=7d38cdd689735b008b3c702edd92eea23791c5f6`, `X-Hub-Signature-256: sha256=d57c68ca6f92289e6987922ff26938930f6e66a2d161ef06abdf1859230aa23c`.
- **Secret configuration**: set at hook-creation/edit time via the `config.secret` string field (REST API: `POST /repos/{owner}/{repo}/hooks` body `config.secret`). Source: [Repository webhooks — Create a repository webhook](https://docs.github.com/en/rest/repos/webhooks?apiVersion=2022-11-28) (retrieved 2026-08-21): "`secret` (string) If provided, the secret will be used as the key to generate the HMAC hex digest value for delivery signature headers."
- **What to compare against — the classic footgun**: the HMAC is computed over the **raw request body bytes exactly as sent**, not a re-serialized/re-parsed JSON object. Official doc: "In your code that handles webhook deliveries, you should calculate a hash using your secret token. Then, compare the hash that GitHub sent with the expected hash that you calculated" — the validating-deliveries doc's own code examples (Ruby/Node/Python) all hash `req.body`/raw payload bytes before any JSON parsing. Confirmed by multiple secondary sources reproducing GitHub's official guidance verbatim, e.g. Webhooker's writeup (retrieved 2026-08-21): "capture the raw body before any JSON parser touches it... a single re-ordered key or changed whitespace produces a completely different digest." **Implementer note**: if using a body-parsing framework (Fastify/Express), you must capture the raw bytes (e.g. `addContentTypeParser`/`rawBody` in Fastify) before JSON parsing, or verification will intermittently fail.
- **Timing-safe compare**: GitHub's own examples in [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) use constant-time compare functions per language (Node: `crypto.timingSafeEqual`; Python: `hmac.compare_digest`; Ruby: `ActiveSupport::SecurityUtils.secure_compare` or `OpenSSL.fixed_length_secure_compare`). Do not use `===`/`Buffer.equals`/string `==`.
- **2xx vs 4xx / retries**: GitHub does **not** automatically retry failed deliveries at all — a non-2xx response or a timeout (10s) simply marks the delivery as failed; there is no automatic redelivery, only manual redelivery via UI or the Redeliver-a-delivery REST endpoint. Source: [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) (retrieved 2026-08-21): "GitHub does not automatically redeliver failed deliveries... if your server is down or takes longer than 10 seconds to respond, GitHub will record the delivery as a failure." **Implication for Kaola**: return `401` for bad signature and expect no retry storm; return `2xx` fast (<10s) and do heavier processing after responding.

### A.2 GitLab

GitLab now has **two** parallel mechanisms; the legacy one is exact-match plaintext, the new one is HMAC.

- **Legacy — Secret token**: a plaintext string configured on the webhook, sent back verbatim in the `X-Gitlab-Token` header on every delivery. Your endpoint does a direct string-equality check against your stored secret. Source: [Webhooks | GitLab Docs](https://docs.gitlab.com/user/project/integrations/webhooks/) (retrieved 2026-08-21): "Secret token (not recommended): Enter a token in the Secret token field. This token is sent as plain text in the `X-Gitlab-Token` HTTP header and provides weaker security guarantees than a signing token... The `X-Gitlab-Token` header is still sent if a secret token is configured." GitLab explicitly marks this as **not recommended for new webhooks**.
- **Current — Signing token (HMAC)**: "For new webhooks, use a signing token instead of a secret token. The signing token computes an HMAC-SHA256 signature over the payload, so your endpoint can verify both the authenticity and integrity of the request." (same source). Delivery headers when a signing token is configured: `webhook-signature` and `webhook-id`. Verification procedure (same source, §"Verify the signature"):
  1. Read `webhook-id`, `webhook-timestamp`, `webhook-signature`.
  2. `webhook-signature` is a **space-separated list** of signatures, each formatted `v1,{base64_signature}` (multiple values support key rotation — check all of them).
  3. Construct the signed message string as `"{message_id}.{timestamp}.{body}"` (i.e. **not** just the raw body — it's `webhook-id` + `.` + `webhook-timestamp` + `.` + raw body).
  4. Compute HMAC-SHA256 over that string using the signing token, base64-encode, compare (constant-time) against each `v1,...` value in the header.
  Both tokens can be configured simultaneously on one webhook for migration.
- **Body vs raw bytes**: GitLab's signing-token HMAC is over the exact message string above (which embeds the raw body) — same raw-bytes caveat as GitHub applies to the `{body}` component.
- **2xx vs 4xx / retries / auto-disable**: GitLab auto-disables a webhook after repeated failures. Source: [Webhooks | GitLab Docs](https://docs.gitlab.com/user/project/integrations/webhooks/) §"Auto-disabled webhooks" (retrieved 2026-08-21): "GitLab automatically disables project or group webhooks that fail four consecutive times... Temporarily disabled webhooks are initially disabled for one minute, with the duration extending on subsequent failures up to 24 hours... Webhooks are permanently disabled if they fail 40 consecutive times." Failure = "The webhook receiver returns a response code in the `4xx` or `5xx` range" OR a connection timeout OR other HTTP errors. Re-enabling: "the webhook is re-enabled if the test request returns a response code in the `2xx` range." **Implication**: unlike GitHub, GitLab *does* retry/reattempt on subsequent real events and can silently stop sending events to Kaola if Kaola's endpoint 4xx's/5xx's/times-out repeatedly — a 401 on a legitimately-bad-signature request is fine (it's not "your" endpoint failing to GitLab's eyes in a way that should be common), but any endpoint bug returning 5xx on *valid* payloads risks the webhook getting disabled.
- **Content-Type note**: `X-Gitlab-Token`/signing-token verification is independent of the request's `Content-Type`; GitLab sends JSON by default (see §D).

### A.3 Gitea

Do **not** assume Gitea matches GitHub's header exactly — Gitea has its own primary header plus GitHub-compat aliases.

- **Primary header**: `X-Gitea-Signature` — "Hex-encoded HMAC-SHA256 of the raw request body, **without a prefix**" (i.e. no `sha256=` prefix, unlike GitHub). Source: [Webhooks | Gitea Documentation](https://docs.gitea.com/usage/repository/webhooks) (retrieved 2026-08-21).
- **GitHub-compat headers also sent**: `X-Hub-Signature-256` (same digest, **with** `sha256=` prefix, for GitHub-compatible receivers) and `X-Hub-Signature` (HMAC-SHA1, `sha1=` prefix, legacy compat). Same source: "`X-Gitea-Signature` contains only the lowercase hexadecimal SHA-256 digest. `X-Hub-Signature-256` contains the same digest with a `sha256=` prefix. `X-Hub-Signature` is also sent for compatibility and uses SHA-1."
- There is **no `X-Gitea-Token` plaintext-token header** documented for current Gitea — the doc explicitly warns: "Older examples may still show a `secret` field inside the JSON payload. Current Gitea versions do not send the webhook secret in the payload body. Always verify the request by checking the signature headers instead." So Gitea's model today is HMAC-only (via `X-Gitea-Signature` / `X-Hub-Signature-256`), not a `X-Gitlab-Token`-style plaintext-token comparison. This directly contradicts the `docs/DESIGN.md` §11 shorthand "Gitea/GitLab secret token" if read as "plaintext token" — Gitea's current mechanism is HMAC, same shape as GitHub's `X-Hub-Signature-256`.
- **Secret configuration**: the `Secret` field on the webhook settings UI / `config.secret` on the create-hook API request body (see §C.3) — "Secret: Used to sign the raw request body with HMAC."
- **Verification procedure** (same source, official steps): "1. Read the request body exactly as it was received. 2. Compute the HMAC-SHA256 digest with your webhook secret. 3. Compare the result with `X-Gitea-Signature` or with the GitHub-compatible `X-Hub-Signature-256` header. 4. Use a constant-time comparison when possible. ... The body must be verified before JSON parsing or any other modification." Same raw-bytes-before-parsing caveat as GitHub/GitLab.
- The doc's own PHP example for verification uses `hash_hmac('sha256', $payload, $secret)` compared with `hash_equals()` (PHP's constant-time compare) against `$_SERVER['HTTP_X_GITEA_SIGNATURE']`, and responds `204` on success.
- **2xx vs 4xx / retries**: the fetched Gitea docs did not state an explicit auto-disable-on-failure policy comparable to GitLab's; they note only that delivery history/redelivery ("Redelivery, which replays an earlier webhook delivery") is available in the UI, and that "Administrators can further control webhook delivery with instance settings such as host allow lists, delivery timeouts, and cleanup policies" (admin config, not a documented client-visible retry count). **Do not assume Gitea auto-disables like GitLab** — this specific fact was not found in the fetched docs; if it matters, verify against a running Gitea instance or its source before relying on it.

### A.4 Node.js `crypto` primitives (implementer-level, from official Node.js docs)

Source: [Node.js `crypto` module docs](https://nodejs.org/api/crypto.html) (retrieved 2026-08-21):

- `crypto.createHmac(algorithm, key[, options])` creates an `Hmac` instance; feed it the raw body via `hmac.update(data)`, then `hmac.digest('hex')` (or `'base64'` for GitLab's signing-token style) to get the digest. `Hmac` objects are not created with `new`; `digest()` can only be called once per instance.
- `crypto.timingSafeEqual(a, b)`: "compares the underlying bytes... using a constant-time algorithm... does not leak timing information... suitable for comparing HMAC digests." **Both arguments must be `Buffer`/`TypedArray`/`DataView` of the same byte length, or it throws** — so implementers must length-check (or catch) before calling, e.g. decode the expected digest and the received header value into same-shaped `Buffer`s (`Buffer.from(hex, 'hex')`) before comparing; a naive `Buffer.from(headerString)` vs `Buffer.from(hexDigest)` length mismatch will throw, not just return `false`.
- Doc's own caveat: "Use of `crypto.timingSafeEqual` does not guarantee that the surrounding code is timing-safe" — i.e. don't short-circuit-return based on header presence/format in a way that leaks information before reaching the constant-time compare (in practice: do the presence/format checks first since they don't depend on the secret, only the final digest compare needs to be constant-time).

---

## B. Event that means "PR merged" vs "PR closed unmerged"

### B.1 GitHub

- **Header**: `X-GitHub-Event: pull_request` (not a separate "merge" event — GitHub folds merge/close into one event with an `action` field). Source: [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) (retrieved 2026-08-21), example delivery header `X-GitHub-Event: issues` shown for the `issues` event — the equivalent for PRs is `X-GitHub-Event: pull_request`.
- **Fields to check**: `action === "closed"` AND `pull_request.merged === true` → merged; `action === "closed"` AND `pull_request.merged === false` (or absent/falsy) → closed-unmerged. This is GitHub's own documented guidance, not a third-party guess. Source: [Delivering deployments](https://docs.github.com/en/rest/guides/delivering-deployments) (retrieved 2026-08-21): "when a pull request is merged, its state is `closed`, and `merged` is `true`... `if @payload["action"] == "closed" && @payload["pull_request"]["merged"]`". The `pull_request` event's documented action-type set for this event (from [webhook-events-and-payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads), retrieved 2026-08-21) includes `closed` among `assigned, auto_merge_disabled, auto_merge_enabled, closed, converted_to_draft, demilestoned, dequeued, edited, enqueued, labeled, locked, milestoned, opened, ready_for_review, reopened, review_request_removed, review_requested, stacked, synchronize, unassigned, unlabeled, unlocked`.
- **PR URL / repo full_name**: `pull_request.html_url` (or `.url` for the API URL) and `repository.full_name` are present on `pull_request` event payloads (repository object shape confirmed generically via the `issues` event example on the same page, which has an identical `repository.full_name` field — GitHub reuses the same `repository` object shape across events).
- **Irrelevant events** (`push`, `issues`, etc.): should map to `null` in `parseWebhook` — Kaola only cares about PR merge/close for the poller-outcome mapping; anything not `pull_request` (or not actionable) is out of scope for this feature and `parseWebhook` should return `null` rather than throwing, so the webhook receiver doesn't 500 on legitimate-but-irrelevant deliveries.
- **`ping` event**: fired once when a webhook is created, as GitHub's "you configured this correctly" confirmation. Source: [webhook-events-and-payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) (retrieved 2026-08-21) §"ping": "This event occurs when you create a new webhook. The ping event is a confirmation from GitHub that you configured the webhook correctly." Payload fields: `hook` (object), `hook_id` (integer), `zen` (string, "random string of GitHub zen"). `parseWebhook` **must not throw** on `ping` — return `null` (or a dedicated non-throwing sentinel) so hook creation succeeds; GitHub does check the response and will flag the ping delivery as failed if the endpoint errors, which surfaces as a scary red "failed" delivery on hook setup even though nothing is actually wrong.

### B.2 GitLab

- **Header**: `X-Gitlab-Event: Merge Request Hook` (note the space and title-case "Hook" suffix — this is the literal header value format, not `merge_request`). Source: [Webhooks | GitLab Docs](https://docs.gitlab.com/user/project/integrations/webhooks/) (retrieved 2026-08-21): "`X-Gitlab-Event` | Webhook type name. Corresponds to event types in the format `\" Hook\"`. | `\"Push Hook\"`" (example given is for push; the merge-request equivalent follows the same `{Type} Hook` pattern documented across GitLab's webhook event pages, e.g. `hookdeck.com`'s reproduction (retrieved 2026-08-21) confirms "`X-Gitlab-Event` — The event type (e.g., `Push Hook`, `Merge Request Hook`)").
- **Fields to check**: `object_attributes.action` and `object_attributes.state`. Source: [Webhook events | GitLab Docs](https://docs.gitlab.com/user/project/integrations/webhook_events/) (retrieved 2026-08-21), §"Merge request events": documented `object_attributes.action` values are `open`, `close`, `reopen`, `update`, `approval`, `approved`, `unapproval`, `unapproved`, `merge` — "`merge`: A merge request is merged." and "`close`: A merge request is closed." `object_attributes.state` values: `opened`, `closed`, `merged`, `locked` (with `state_id`: `1`=opened, `2`=closed, `3`=merged, `4`=locked).
  - **Merged** → `action === "merge"` and/or `state === "merged"`.
  - **Closed unmerged** → `action === "close"` and/or `state === "closed"`.
  - Caveat from GitLab's own docs: `state` stays `"merged"` on *any subsequent* webhook for that MR (e.g. a label added post-merge fires `action: "update"`, `state: "merged"`), so **prefer `state` over `action`** for a "final status" read if you need to also handle stray later events, but for the *transition* event itself `action` is the more precise "this is the event where it happened" signal. This matches the local `derivePrState()` logic in `packages/forge-adapters/src/index.ts`, which reads `state` (not `action`) for GitLab.
- **`merged_at`**: recently added to `object_attributes` (sourced from `MergeRequestMetrics#merged_at`, null for non-merged MRs) per a GitLab merge request (`gitlab-org/gitlab!235360`, retrieved 2026-08-21) — **treat this as recent/version-dependent**, not guaranteed present on older GitLab instances (relevant since Kaola targets self-hosted GitLab of unknown version per `docs/DESIGN.md`).
- **PR URL / repo full_name**: `object_attributes.url` is the MR web URL; `project.path_with_namespace` (not `full_name` — GitLab's field is named differently from GitHub/Gitea) is the repo full path. (Field name confirmed structurally consistent with the example JSON snippet in [17.6 Webhook events](https://docs.gitlab.com/17.6/user/project/integrations/webhook_events/), which shows a nested `project`/`repository` object; exact field name for path was not re-verified character-for-character in this pass — **verify `path_with_namespace` against a live payload or GitLab's Project webhooks API schema before hardcoding**, since this fact came from GitLab's general project-serialization convention rather than a directly quoted MR-payload field table entry.)
- **Irrelevant events** (`Push Hook`, `Issue Hook`, etc.): map to `null`, same rationale as GitHub.
- **Ping/handshake equivalent**: GitLab's UI has a "Test" action per event type (send a synthetic event of that type) rather than a single dedicated `ping` event fired automatically on creation — source: [Webhooks | GitLab Docs](https://docs.gitlab.com/user/project/integrations/webhooks/) §"Test a webhook": "Test a webhook to ensure it's working properly or to re-enable a disabled webhook." No evidence of a GitLab-analogue to GitHub's auto-fired `ping` on creation was found in the fetched docs — **do not assume GitLab auto-pings on hook creation**; this was not confirmed and should not be relied upon.

### B.3 Gitea

- **Header**: `X-Gitea-Event: pull_request` (Gitea's own normalized name; GitHub-compat alias `X-GitHub-Event` is also sent per the 1.27 docs' header table, plus `X-Gitea-Event-Type` for finer-grained sub-events like `pull_request_review_comment`). Source: [Webhooks | Gitea Documentation](https://docs.gitea.com/usage/repository/webhooks) (retrieved 2026-08-21): "`X-Gitea-Event` | Normalized event name, such as `push`, `issues`, or `pull_request`."
- **Event group / action values**: the `pull_request` event's documented action types are `opened`, `closed`, `reopened`, `edited`, `deleted` (same source, §"pull_request"). There is **no separate "merged" action** — same GitHub-style pattern: merge state is a field on the nested `pull_request` object, not a distinct top-level action.
- **Merged vs closed-unmerged field**: the Gitea `PullRequest` object (Go struct `modules/structs/pull.go`, and its Swagger/JSON-schema mirror) has `merged: boolean` (json tag `"merged"`, doc comment "Whether the pull request has been merged") and `merged_at` (nullable timestamp), plus `state: string` (`"open"` or `"closed"`, enum `StateType`). Sources: [go-gitea/gitea `modules/structs/pull.go`](https://github.com/go-gitea/gitea/blob/356f589f/modules/structs/pull.go) (retrieved 2026-08-21) and the mirrored [Gitea REST API PullRequest JSON Schema](https://apis.io/schemas/gitea/gitea-rest-api-pullrequest/) (retrieved 2026-08-21): `"merged": {"description": "Whether the pull request has been merged", "type": "boolean"}`. So the check is the same shape as GitHub: `action === "closed"` AND `pull_request.merged === true` → merged; `action === "closed"` AND `pull_request.merged !== true` → closed-unmerged. This matches the local `derivePrState()` non-GitLab branch already in `packages/forge-adapters/src/index.ts`.
- **PR URL / repo full_name**: payload table for `pull_request` lists `pull_request` (object, "the pull request that was acted on") and `repository` (object, "the repository containing the pull request") as required top-level fields — same source. Field-level names inside those nested objects (`pull_request.url`/`html_url`, `repository.full_name`) were not individually re-quoted from a full example payload in this pass, but are structurally consistent with the Gitea PullRequest/Repository Swagger schemas referenced above (`html_url` on `PullRequest`, and Gitea's `Repository` struct uses `full_name` like GitHub — this is asserted by analogy to the confirmed `PullRequest` schema fields, not independently re-verified field-by-field; **verify against a live payload if exact casing/nesting matters**).
- **Irrelevant events** (`push`, `issues`, other groups under "Repository Events"/"Issue Events"): map to `null`.
- **Ping/handshake**: Gitea does not appear to have a dedicated `ping` event fired on hook creation (unlike GitHub); instead the UI offers "Test Delivery, which sends a synthetic `push` event for the repository" (source: [Webhooks | Gitea Documentation](https://docs.gitea.com/1.27/usage/repository/webhooks), retrieved 2026-08-21). **Do not assume Gitea sends an automatic ping-equivalent on hook creation** — this was not found in the fetched docs. If Gitea ever does send something outside the documented event set, `parseWebhook` should still fail safe (`null`, not throw) for any unrecognized `X-Gitea-Event` value.

---

## C. Register webhook API

### C.1 GitHub

- **Endpoint**: `POST /repos/{owner}/{repo}/hooks`, origin always `https://api.github.com` (per this repo's existing host rule). Source: [Repository webhooks | REST API](https://docs.github.com/en/rest/repos/webhooks?apiVersion=2022-11-28) (retrieved 2026-08-21).
- **Auth**: `Authorization: Bearer <token>` header (standard GitHub REST auth, matches this repo's existing `authHeaders()` for GitHub).
- **Scopes**: "OAuth app tokens and personal access tokens (classic) need the `write:repo_hook` or `repo` scope to use this endpoint" (documented on the sibling "Update a webhook configuration" endpoint in the same doc; the create-hook endpoint's own scope note was not independently re-quoted in this pass, but GitHub documents the same scope pair — `read:repo_hook`/`write:repo_hook` or the blanket `repo` scope — for webhook-management endpoints generally). For fine-grained PATs (which `docs/DESIGN.md` §7 recommends for this project), the equivalent fine-grained permission is "Webhooks" repository permission (`write` access) — **this specific fine-grained-PAT permission name was not directly re-quoted from a fetched page in this pass; verify against GitHub's fine-grained PAT permissions reference before hardcoding a scope-check.**
- **Body fields** (from the documented request schema + example):
  ```json
  {
    "name": "web",
    "active": true,
    "events": ["pull_request"],
    "config": {
      "url": "https://example.com/webhook",
      "content_type": "json",
      "secret": "your-secret",
      "insecure_ssl": "0"
    }
  }
  ```
  - `name`: must be `"web"` (only accepted value) — "Use web to create a webhook. Default: web. This parameter only accepts the value web."
  - `config.content_type`: `"json"` or `"form"` — **default is `"form"` (`application/x-www-form-urlencoded`), not JSON** — must explicitly set `"json"` to get JSON payloads.
  - `config.secret`: string, used to compute the HMAC signature headers (§A.1).
  - `config.insecure_ssl`: `"0"` (verify, default) or `"1"` (skip verification) — "We strongly recommend not setting this to 1."
  - `events`: array of event names to subscribe to; default `["push"]` if omitted — must explicitly include `"pull_request"`.
  - `active`: boolean, default `true`.
- **Idempotency**: GitHub explicitly allows multiple hooks per repo and does not de-duplicate: "Repositories can have multiple webhooks installed. Each webhook should have a unique config. Multiple webhooks can share the same config as long as those webhooks do not have any events that overlap." So calling create-hook twice with the same URL/events **will create a second hook**, not update the first — `registerWebhook` should check for an existing hook (e.g. via `GET /repos/{owner}/{repo}/hooks` and matching `config.url`) before creating, if idempotent registration is required. This was not explicitly tested; it follows directly from the quoted doc text.

### C.2 GitLab

- **Endpoint**: `POST /projects/:id/hooks`, at `{baseUrl}/api/v4/projects/:id/hooks` per this repo's existing host rule (`:id` is numeric project ID or URL-encoded `namespace/path`). Source: [Project webhooks API | GitLab Docs](https://docs.gitlab.com/api/project_webhooks/) (retrieved 2026-08-21).
- **Auth**: `PRIVATE-TOKEN: <token>` header (matches this repo's existing `authHeaders()` for GitLab).
- **Body fields** (documented attributes, relevant subset):
  - `url` (string, **required**)
  - `merge_requests_events` (boolean, optional) — must set `true` to receive MR webhooks.
  - `token` (string, optional) — the legacy secret token; "Secret token to validate received payloads. Not returned in the response. When you change the webhook URL, the secret token is reset and not retained."
  - `signing_token` (string, optional) — "HMAC signing token used to compute the `webhook-signature` header. Must be in `whsec_<random>` format encoding a 32-byte key. Not returned in the response." (this is the recommended, current mechanism per §A.2)
  - `enable_ssl_verification` (boolean, implied elsewhere in the same doc family; UI equivalent "Enable SSL verification").
  - `branch_filter_strategy`, `custom_headers`, `custom_webhook_template`, `push_events`, `tag_push_events`, `issues_events`, `job_events`, `deployment_events`, `wiki_page_events`, `resource_access_token_events`, etc. are all separate optional boolean/string toggles per event category — GitLab does not use a single generic `events` array like GitHub/Gitea; each event category is its own top-level boolean flag.
- **Scopes**: creating a project hook requires the `api` scope on a personal/project access token (standard for GitLab API write operations that manage project settings); the fetched docs did not include an explicit scope table for this specific endpoint in the excerpts retrieved — **this is inferred from GitLab's general API-scope convention, not a directly quoted scope statement for `POST /projects/:id/hooks`; verify against GitLab's Personal Access Tokens scope reference before hardcoding.**
- **Idempotency**: not explicitly documented as de-duplicated; the doc's request/response shape (`POST` returns a new hook object with its own `id`) implies repeated `POST`s create additional hooks, analogous to GitHub. Not independently confirmed via a live test in this pass.

### C.3 Gitea

- **Endpoint**: `POST /repos/{owner}/{repo}/hooks`, at `{baseUrl}/api/v1/repos/{owner}/{repo}/hooks` per this repo's existing host rule. Source: [Create a hook | Gitea Documentation](https://docs.gitea.com/api/1.25/operations/repo-create-hook/) (retrieved 2026-08-21).
- **Auth**: this repo's existing Gitea `authHeaders()` sends `Authorization: token <token>` (Gitea's classic-token scheme); the fetched Swagger example shows `Authorization: Basic <...>`, which is Gitea's Basic-auth alternative — **both schemes are supported by Gitea's API; this repo already standardizes on the `token` scheme for other endpoints, so continue that convention for hook creation** rather than switching to Basic.
- **Body fields** (`CreateHookOption` schema):
  - `type` (string, **required**) — must be `"gitea"` for a generic Gitea-format webhook (other allowed values are for third-party integrations: `dingtalk`, `discord`, `gogs`, `msteams`, `slack`, `telegram`, `feishu`, `wechatwork`, `packagist`).
  - `config` (object, **required**) — must include `url` and `content_type` (`"json"` or `"form"`); the create-hook-source (`routers/api/v1/utils/hook.go`) shows `config["secret"]`, `config["url"]`, `config["content_type"]` are all read directly out of this map. Source: [go-gitea/gitea `routers/api/v1/utils/hook.go`](https://github.com/go-gitea/gitea/blob/cc0d348d/routers/api/v1/utils/hook.go) (retrieved 2026-08-21): `w.URL = form.Config["url"]`, `w.ContentType = webhook.ToHookContentType(form.Config["content_type"])`, `w.Secret = form.Config["secret"]`.
  - `events` (array of strings, **required**) — must include `"pull_request"` to receive PR events.
  - `active` (boolean, optional).
  - `branch_filter` (string, optional glob).
  - `authorization_header` (string, optional custom header value).
  - A common footgun documented in a GitHub issue against this exact endpoint ([go-gitea/gitea#11382](https://github.com/go-gitea/gitea/issues/11382), retrieved 2026-08-21): `config.content_type` must be the literal string `"json"` or `"form"` (**not** a MIME type like `"application/json"`) — that value configures the Gitea *webhook's* payload format, separate from the HTTP request's own `Content-Type` header.
- **Idempotency**: not documented; the Go handler (`CreateHook` in `routers/api/v1/repo/hook.go`) is a straight insert with no dedup check visible in the reviewed source — treat as **not idempotent**, same caution as GitHub/GitLab.
- **Required scope**: Gitea API tokens/OAuth scopes include a dedicated `write:repository` (or the fine-grained `repo` scope family) needed for repo-admin actions like hook management; the specific scope name for hook creation was not directly quoted from an official scope-reference page in this pass — **verify against Gitea's token-scopes documentation before hardcoding a scope-check string**, though `docs/DESIGN.md` §7's recommendation of "Gitea 仓库级 scoped token" is consistent with a repo-scoped write token being sufficient.

---

## D. Payload delivery

- **GitHub**: `Content-Type: application/json` when `config.content_type = "json"` is set (default is `x-www-form-urlencoded` if unset — see §C.1). Source: [webhook-events-and-payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) (retrieved 2026-08-21): "You can choose to have payloads delivered in JSON format (`application/json`) or as URL-encoded data (`x-www-form-urlencoded`)." No explicit max-body-size figure was found in the fetched pages for this pass.
- **GitLab**: JSON by default for webhook deliveries (all documented payload examples across the fetched `webhook_events` pages are JSON bodies; GitLab's webhook body format is JSON, unlike GitHub which defaults to form-encoded). GitLab does document per-instance/administrable limits: "Maximum number of webhooks per project or group. Number of webhook calls per minute. Webhook timeout duration." (source: [Webhooks | GitLab Docs](https://docs.gitlab.com/user/project/integrations/webhooks/), retrieved 2026-08-21) — these are admin-configurable on GitLab Self-Managed, no fixed universal number was quoted in the fetched excerpt.
- **Gitea**: `application/json` or `application/x-www-form-urlencoded`, selected via the webhook's own `config.content_type`; "For POST requests, the payload can be sent either as JSON (`application/json`) or as a form field named `payload` (`application/x-www-form-urlencoded`)." Source: [Webhooks | Gitea Documentation](https://docs.gitea.com/1.27/usage/repository/webhooks) (retrieved 2026-08-21). No documented max-body-size was found in the fetched pages.

---

## Do not unify blindly

A single shared `parseWebhook(headers, body)` implementation across all three forges will break (or silently misbehave) if it assumes any of the following:

1. **Signature header name and format differ per forge, and are not 1:1 even within "the same" mechanism**:
   - GitHub: `X-Hub-Signature-256: sha256=<hex>` (prefixed).
   - GitLab (legacy): `X-Gitlab-Token: <plaintext>` (exact string equality, not HMAC at all).
   - GitLab (current): `webhook-signature: v1,<base64>` (space-separated *list*, base64, needs `webhook-id`+`webhook-timestamp`+body concatenated as the signed message — not just the raw body like GitHub/Gitea).
   - Gitea: `X-Gitea-Signature: <hex>` (**no** `sha256=` prefix) — a parser that strips a `sha256=` prefix unconditionally before hex-decoding will corrupt Gitea's header (it has no prefix to strip) unless you specifically use Gitea's own `X-Hub-Signature-256` compat header instead, which *does* have the prefix.
   - **Concretely**: do not write one `stripPrefixAndHexCompare(header, secret, body)` helper reused verbatim for all three — GitHub/Gitea's compat header are hex+prefix over raw body; GitLab's signing token is base64, no prefix, over a composed message string with two extra components, and can appear as *multiple* space-separated candidates.

2. **"Secret token" means two different security models depending on forge/vintage**: GitLab's legacy `X-Gitlab-Token` is a **plaintext value comparison** (equivalent in strength to comparing an API key), not a cryptographic MAC over the payload — an attacker who learns the token once can forge arbitrary payloads. GitHub and Gitea's mechanisms, and GitLab's *current* signing-token mechanism, are all payload-bound HMACs. If Kaola's `registerWebhook` sets a GitLab hook's `token` field (legacy) instead of `signing_token`, `parseWebhook` for GitLab must do a *plain string compare* against `X-Gitlab-Token`, not attempt an HMAC compare — mixing these up is a real vulnerability, not just a bug.

3. **Event-name headers use different casing/shape conventions and there is no shared "PR event" name**:
   - GitHub: `X-GitHub-Event: pull_request` (snake_case, generic name covering all PR sub-actions via `action` field).
   - GitLab: `X-Gitlab-Event: Merge Request Hook` (Title Case with a literal space and trailing " Hook" — not `merge_request`, not snake_case, not matching GitHub's or Gitea's naming at all).
   - Gitea: `X-Gitea-Event: pull_request` (matches GitHub's snake_case naming coincidentally, plus a *second*, more granular `X-Gitea-Event-Type` header for sub-events).
   A shared parser cannot do `if (header === 'pull_request')` across forges — it needs a per-forge event-name table, and GitLab's "merge" terminology (`Merge Request Hook`) is a different noun entirely from "pull request."

4. **The "did it merge" boolean lives in different places with different names**:
   - GitHub/Gitea: `action === "closed"` + `pull_request.merged === true|false` (two fields, action generic, merged specific).
   - GitLab: `object_attributes.action === "merge"` directly *is* the merged signal (no separate `merged` boolean) — or, more robustly, `object_attributes.state === "merged"` vs `"closed"` (a single field with three-plus mutually exclusive string states, not a boolean layered on top of a generic "closed" action).
   A shared "is this a merge-completion event" predicate needs forge-specific field paths, not a common `payload.merged` lookup.

5. **Repo identity field name differs**: GitHub/Gitea use `repository.full_name` (`"owner/repo"`); GitLab uses `project.path_with_namespace` (unverified exact name in this pass — see §B.2 caveat) on a `project` key, not `repository`. A shared "which repo is this for" extractor cannot assume a `repository.full_name` path.

6. **Response-code stakes differ**: GitHub never retries (a bug that 500s just silently drops that one delivery, no cascading risk to future deliveries); GitLab **auto-disables the whole webhook** after 4 consecutive failures (temporary) or 40 (permanent) — a shared error-handling path that swallows exceptions and always returns 200 "to be safe" would mask signature-check failures forever on GitHub, whereas being *too* strict and 500ing on any parse hiccup risks GitLab silently turning off the entire integration after a bad afternoon. Gitea's retry/auto-disable behavior was not confirmed in the fetched docs at all — treat it as unknown, not "probably like GitHub" or "probably like GitLab."

7. **`ping`/test-delivery handling is not symmetric**: GitHub fires an automatic, unsolicited `ping` event immediately on hook creation that the endpoint must not error on (or hook setup looks "failed" in GitHub's UI even though nothing is wrong). GitLab and Gitea, per the docs fetched in this pass, only send synthetic test events **on manual user action** ("Test a webhook" / "Test Delivery") using a *real* event type (e.g. GitLab's test sends whichever event type you pick; Gitea's Test Delivery sends a synthetic `push`) rather than a dedicated `ping`/`ping`-like event name — so a shared parser cannot special-case a universal `"ping"` event name; only GitHub has one, and Gitea/GitLab's "test" deliveries look like ordinary events of some other type (which may not even be `pull_request`/`Merge Request Hook`, e.g. Gitea's default test is a `push`) and should already be handled correctly by the ordinary "irrelevant event → null" path rather than needing dedicated ping-detection logic.

---

## Open items / not independently confirmed (flag before hardcoding)

- Exact fine-grained-PAT permission name for GitHub webhook management (assumed "Webhooks" repo permission, not directly re-quoted).
- Exact required PAT scope for GitLab's `POST /projects/:id/hooks` (assumed `api` scope by convention, not directly quoted for this endpoint).
- Exact required token scope for Gitea's `POST /repos/{owner}/{repo}/hooks` (assumed repo-scoped write token, not directly quoted).
- GitLab's exact repo-identity field name on the MR webhook payload (`project.path_with_namespace` assumed by GitLab's general convention, not directly quoted from a fetched MR-payload field table).
- Gitea's exact nested field names for `pull_request.html_url`/`repository.full_name` inside the `pull_request` webhook event specifically (asserted by analogy to Gitea's REST PullRequest/Repository schemas, not from a directly quoted webhook-payload example).
- Gitea's auto-disable-on-repeated-failure policy (or lack thereof) — not found in the fetched docs; unknown, not assumed.
- Whether GitLab sends any automatic ping-like event on hook creation — not found in the fetched docs; assume it does not.
- Max webhook payload body size for any of the three forges — not found in the fetched docs for this pass.
