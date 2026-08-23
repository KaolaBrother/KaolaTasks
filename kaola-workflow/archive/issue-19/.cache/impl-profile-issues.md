# impl: GET /api/v1/credential-profiles/:id/issues (issue #19)

- **worktree**: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-19`
- **branch**: `workflow/issue-19`
- **HEAD SHA**: `41e1e01ff4ec58e4651bb6825ee1bcfa7c158c3d` (uncommitted; not pushed)
- **file changed**: `apps/server/src/credential-profiles.ts` (+73)

## What changed

Added `GET /api/v1/credential-profiles/:id/issues` in `registerCredentialProfiles`. POST/DELETE handlers untouched. `tasks.ts` import path untouched.

- Gate matches GET list: `getSessionUser` + `sendUnauthorized` (401 JSON / 302 `/login`) then `canManageProfiles` (`active`+`full`) else `403 { error: 'forbidden' }`.
- `parsePositiveInt` miss and missing row → `404 { error: 'not_found' }`.
- Decrypts `profile.tokenEncrypted` via `decryptToken`; `isVaultUnconfiguredError` → `500 { error: 'vault_unconfigured' }`.
- `createForgeAdapter(profile.forge, { baseUrl: profile.baseUrl }).listIssues({ token }, { full_name: profile.repoFullName, base_url: profile.baseUrl })`.
- Success: `200 { issues }` as returned by the adapter (constructed `issue_url`, no forge `html_url`/`web_url`).
- Local `listForgeFailure` (does **not** reuse `importForgeFailure`): parse `listIssues: ${kind} responded N` with `/responded (\d+)\s*$/u`; 401 → `422 { error: 'token_check_failed', missing: ['读'], message: 'token 无效或无权读取该 Issue。' }`; any other throw including 404/410/500/network → `502 { error: 'forge_unreachable', message: '无法连接 forge 列出 Issue。' }`.
- Does **not** call `insertAuditEvent` / does **not** write `token 揭示`. Response has no token / ciphertext.

## Verification

**tier**: `tests-green`

**before** (`credential-profile-issues.test.ts`): tests 13 / pass 0 / fail 13 (route missing; Fastify 404)

**after** (`credential-profile-issues.test.ts`):

```
node --experimental-strip-types --test apps/server/src/credential-profile-issues.test.ts
→ tests 13 / pass 13 / fail 0  (exit 0)
```

**sanity** (vault + import, unchanged handlers):

```
node --experimental-strip-types --test apps/server/src/vault.test.ts apps/server/src/import.test.ts
→ tests 40 / pass 40 / fail 0  (exit 0)
```
