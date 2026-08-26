# RED: issue #28 admin 升级入口 (电脑 pane)

baseline: `51dcc83c945cce6fce2214a7bac478d28d4b49bc`

suite: `apps/web/src/App.devices.test.ts`
command: `pnpm --filter @kaola/web test -- src/App.devices.test.ts`
result: `App.devices.test.ts` **18 tests | 3 failed** (existing devices cases still pass; publisher / claim_only absence pins pass because there is still no widget)

## Pinned testids (implementer must use these exactly)

| testid | role |
| --- | --- |
| `users-promote` | Admin-only 升级入口 container on the 电脑 pane (`workbench-pane-keys`). Chinese heading text must contain `升级`. |
| `user-row` | One wrapper per listed user from `GET /api/v1/users`. |
| `user-promote` | Promote button **inside** a `user-row`. Label `升级` or `升级为管理员`. Only gitlab/gitea `active`+`full`. Not on `local`, `github`, or already-`admin`. |

Nav stays `workbench-nav-keys` (label 电脑). Tests click that before asserting the widget.

## HTTP (do not invent keys)

- `GET /api/v1/users` → `{ users: [{ id, provider, username, display_name, status, permission_level }] }`, `credentials: 'include'`, `Accept: application/json`
- `POST /api/v1/users/:id/promote` → `200 { ok: true }`, `credentials: 'include'`, `Accept` + `Content-Type: application/json`, body `{}`
- After a successful POST, GET users again (stub then returns `permission_level: 'admin'` for that id; row text matches `/admin|管理员/`)

## Fixture users in the suite

- local admin id `1` `kaola-admin` — **no** `user-promote`
- gitlab full id `8` `zhang.wei` / `张伟` — **has** `user-promote`
- gitea full id `9` `li.na` / `李娜` — **has** `user-promote`
- github full id `10` `octo` — **no** `user-promote`
- gitlab already-admin id `11` `already-admin` — **no** `user-promote`

`full` publisher (`ME_FULL`) and leftover `claim_only` must not GET `/api/v1/users` and must not render `users-promote` / `user-promote`.

## Failure signatures (this baseline)

```
RED: 打开电脑后 GET /api/v1/users，gitlab/gitea full 行可升级
AssertionError: expected 0 to be greater than or equal to 1
(src/App.devices.test.ts: expect(usersGets(calls).length).toBeGreaterThanOrEqual(1))
```

```
RED: 点击升级 POST /api/v1/users/:id/promote 后重新 GET users，该行显示 admin
Error: no [data-testid="user-row"] containing "张伟"
```

```
RED: local 与 github 行没有升级按钮；已是 admin 的 gitlab 行也没有
Error: no [data-testid="user-row"] containing "kaola-admin"
```
