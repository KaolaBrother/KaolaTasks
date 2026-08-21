# Orchestrator rulings — issue #13

Recorded 2026-08-21 after `ground-truth.md` (worktree HEAD `44eca32b`) and `forge-webhook-apis.md`. These pin the suite. Evidence: DESIGN.md §8 §11 §14; issue #13 body (no comments); measured poller/adapter; official forge docs.

## Scope

In: adapter `parseWebhook` + `registerWebhook`; typed `ForgeEvent`; Fastify receiver; per-instance webhook-vs-poll config that the poller honors.
Out: `commentOnIssue` / status write-back (#14). No DESIGN.md contract rewrite. No REST `submit_pr`. No audit-log UI (#15). No claim-confirmation (#16).

## 1. `ForgeEvent`

Replace the `unknown` placeholder. `parseWebhook` returns this or `null`:

```ts
export type ForgeEvent = {
  type: 'pull_request'
  state: 'merged' | 'closed'
  pr_url: string
  repo: { full_name: string }
}
```

Only terminal PR/MR events. `ping`, opened/synchronize/push/issues, and unparseable-but-signed payloads that are not a merge/close → `null` (never throw). `open` is not emitted.

## 2. `parseWebhook(headers, body)` — keep DESIGN signature

- `headers` is the Web `Headers` object (Fastify handler constructs it from the request).
- `body` is the **raw payload bytes as `string` or `Buffer`** (`unknown` in the signature). Verify first, then `JSON.parse`. Do not HMAC a re-serialized object.
- Secret is **not** a new parseWebhook argument. Pass it via existing constructor options: `createForgeAdapter(kind, { baseUrl?, webhookSecret? })`. Missing/empty secret on parse → same failure as a bad signature.
- Bad or missing signature/secret → throw a distinct error whose `name` is `WebhookSignatureError` (or `error.name === 'WebhookSignatureError'`). Do **not** return `null` for this — null means "ignore"; a throw means "reject the HTTP request".
- GitHub: HMAC-SHA256 over raw body; header `X-Hub-Signature-256` value `sha256=<hex>`; `crypto.timingSafeEqual` on equal-length Buffers.
- GitLab: DESIGN §11 secret token — header `X-Gitlab-Token` compared timing-safe to `webhookSecret`. Do **not** implement GitLab `webhook-signature` / `signing_token` in this issue.
- Gitea: current Gitea sends HMAC, not a plaintext token. Verify `X-Gitea-Signature` as hex HMAC-SHA256 of the raw body **with no `sha256=` prefix**. Do not treat Gitea as GitHub's prefixed header unless reading `X-Hub-Signature-256` as a fallback; the primary asserted header is `X-Gitea-Signature`.
- Event mapping:
  - GitHub: `X-GitHub-Event: pull_request`, `action === 'closed'`, `pull_request.merged === true` → merged; `merged !== true` → closed. `pr_url` = `pull_request.html_url`. `repo.full_name` = `repository.full_name`.
  - GitLab: `X-Gitlab-Event: Merge Request Hook`. Prefer `object_attributes.state === 'merged' | 'closed'`. `pr_url` = `object_attributes.url`. `repo.full_name` = `project.path_with_namespace`.
  - Gitea: `X-Gitea-Event: pull_request`, same closed+merged shape as GitHub. `pr_url` = `pull_request.html_url`. `repo.full_name` = `repository.full_name`.
- Host rule unchanged: GitHub API origin is always `https://api.github.com`; GitLab/Gitea use constructor `baseUrl` (registerWebhook only). parseWebhook does not fetch.

## 3. `registerWebhook`

Implement the existing method (stop throwing `not implemented`). Fetch-mock shared spec, same isolation as `get-pull-request.shared.test.ts` (copy helpers, do not import that file).

- GitHub: `POST https://api.github.com/repos/{owner}/{repo}/hooks` with `name: 'web'`, `events: ['pull_request']`, `config: { url: callback, content_type: 'json', secret: webhookSecret, insecure_ssl: '0' }`. Auth matches existing GitHub `authHeaders()`.
- GitLab: `POST {baseUrl}/api/v4/projects/{urlEncoded full_name}/hooks` with `url`, `merge_requests_events: true`, `token: webhookSecret` (legacy secret token, not `signing_token`). Auth matches existing GitLab headers. `baseUrl` from constructor, never `repo.base_url` host if they differ — wait: `RepoRef` has `base_url`. Existing methods use constructor `options.baseUrl`, not `repo.base_url`, for the API origin. Same here.
- Gitea: `POST {baseUrl}/api/v1/repos/{owner}/{repo}/hooks` with `type: 'gitea'`, `events: ['pull_request']`, `config: { url: callback, content_type: 'json', secret: webhookSecret }`, `active: true`. Auth matches existing Gitea `token` scheme.
- Non-OK HTTP: reject with a message containing `${kind} responded ${status}` after one fetch (same pattern as importIssue).
- Not required: listing hooks for idempotent update; HTTP route that calls registerWebhook. Operators may paste the callback in the forge UI. Adapter method must still work so the stub is gone.

## 4. Per-instance config — no new table

Mirror `#11`'s `pollIntervalMs` / `POLL_INTERVAL_MS`:

```ts
buildApp({
  pollIntervalMs?: number
  forgeInstances?: Array<{
    publicId: string
    forge: 'github' | 'gitlab' | 'gitea'
    baseUrl: string
    syncMode: 'webhook' | 'poll'
    webhookSecret: string
  }>
})
```

- Omitted / `[]` → every 待验收 row is still polled (today's behavior).
- Prod `index.ts` reads `FORGE_INSTANCES` (JSON array, same shape). Unset/`''` → `[]`. Invalid JSON → fail boot (throw), do not silently poll-everything.
- Instance identity for poller skip: exact `(task.repoForge, task.repoBaseUrl) === (forge, baseUrl)`.
- `syncMode === 'webhook'` → `pollPendingReviews` **skips** that task (does not call `getPullRequest`).
- `syncMode === 'poll'` or no matching instance → poll as today.
- A webhook POST for a poll-mode instance may still complete a task (harmless, idempotent). Mode "takes effect" is proven by the skip, not by rejecting inbound webhooks.

## 5. HTTP receiver

- `POST /api/v1/webhooks/:publicId` — no session, no Bearer. Signature is the auth.
- Capture **raw body** (Fastify default JSON parser must not eat the bytes on this route).
- Unknown `publicId` → `404` `{ error: 'not_found' }`.
- `WebhookSignatureError` → `401` `{ error: 'invalid_signature' }`. Do not leak the secret, the expected digest, or a forge token.
- `parseWebhook` returns `null` → `204` empty body (ping / irrelevant). GitHub hook setup depends on non-error.
- Terminal event: find a `待验收` task whose **latest** `submissions.pr_url` equals `event.pr_url`. If none, `204` (do not 404 a valid forge delivery).
- On match: same transaction as `pollOneTask` — `tasks.status` 已完成/已退回, `submissions.pr_state` `merged`/`closed`, `状态迁移` event with `actorUserId: null` and details `{ task_id, from, to, pr_url }`. `task_id` is the public id, matching the poller.
- Do **not** decrypt a forge token and do **not** call `getPullRequest` on the webhook path. The payload is the source of merge/close.
- Never put a token, webhook secret, or ciphertext in the response, logs, or `events.details`.
- Prefer `204` after a no-op if the task is no longer `待验收` (idempotent redelivery).
- No webhook-driven second token reveal.

## 6. Tests to author (custody)

- `packages/forge-adapters/src/webhook.shared.test.ts` — parameterized github/gitlab/gitea; parseWebhook signatures + event mapping + ping/irrelevant; registerWebhook URL/auth/body. Copy fetch helpers; do not import sibling shared specs. Assert `err.message !== 'not implemented'` on the paths that today throw that.
- `apps/server/src/webhook.test.ts` — real `buildApp` + `forgeInstances`; bad signature 401; merge 204 + 已完成 + event; closed 已退回; ping 204; unknown publicId 404; response/events contain no token/secret.
- Poller skip: extend `apps/server/src/poller.test.ts` with cases that a webhook-mode instance is not fetched, and an unlisted/poll-mode instance still is. Do not weaken existing poller cases.
- Root `package.json` `test` script: append the new node:test paths explicitly (no glob). This is the same one-line harness exemption as #11/#12.
- No web UI tests. No DESIGN.md edits. No production files.

## 7. Check-the-premise notes (do not freeze into DESIGN.md)

- DESIGN §11 says "Gitea/GitLab secret token". GitLab: implement the token header. Gitea: HMAC `X-Gitea-Signature` because current Gitea does not send a plaintext token header.
- GitLab HMAC signing tokens exist upstream; out of scope here.
