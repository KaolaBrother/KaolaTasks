# TDD web (issue #23) — red baseline

## Baseline

- commit: `6c9f01cf7e61630bec48fd4f0f3525a4fb5f5137`
- worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/issue-23`
- command: `pnpm --filter @kaola/web test` (`vitest run`)
- result: **14 failed | 95 passed (109)** — 2 files failed, 4 passed
- duration: ~4.9s
- production: **not edited** (`App.vue` still 钥匙 / 生成 Agent Key)

## Test paths

- `apps/web/src/App.devices.test.ts` (new)
- `apps/web/src/App.shell.test.ts` (nav 钥匙 → 电脑; keep `workbench-nav-keys`)
- fetch stubs only (no assertions) on `App.settings.test.ts` / `App.form.test.ts` / `App.board.test.ts` / `App.audit.test.ts`: `GET /api/v1/me/devices`, `GET /api/v1/devices/pending`, `GET /api/v1/claimants`

Pins: testid **`workbench-nav-keys`** stays; visible label is **电脑**. Empty-profile hint still may contain 钥匙 (`App.form.test.ts` unchanged).

## Failure signatures (expected red)

| Test | Failure |
|------|---------|
| `登录文案 > 不把 GitLab/Gitea 写成自动正式成员` | `not.toMatch(/GitLab\s*\/\s*Gitea\s*为正式成员/)` — login copy still has `GitLab / Gitea 为正式成员` |
| `full+active：没有「生成 Agent Key」文案，也不请求 /api/v1/agent-keys` | `not.toContain('生成 Agent Key')` |
| `没有 GitHub 数字 id 批准控件` | `not.toContain('批准 GitHub 用户')` |
| `GET /api/v1/me/devices 填入 我的电脑…` | `expected 0 to be greater than or equal to 1` (no GET `/api/v1/me/devices`) |
| `GET /api/v1/devices/pending 填入 待授权电脑…` | `expected 0 to be greater than or equal to 1` (no GET `/api/v1/devices/pending`) |
| `空 我的电脑 列表显示 暂无已绑定的电脑。` | `missing [data-testid="devices-mine"]` |
| `空认领者下拉提示输入显示名新建` | missing `暂无认领者，请输入显示名新建。` |
| `绑到我自己 POST { bind_to_self: true }…` | `Cannot call trigger on an empty DOMWrapper` (`device-bind-self`) |
| `认领者显示名提交 POST { claimant_display_name }…` | `no input/textarea under [data-testid="device-bind-claimant-name"]` |
| `已有认领者下拉提交 POST { claimant_id }` | `no n-select with data-testid="device-bind-claimant-select"` |
| `解除这台电脑 POST /api/v1/devices/:id/revoke` | `device-revoke` exists `false` |
| `解除认领者 POST /api/v1/claimants/:id/revoke` | `claimants-list` exists `false` |
| shell `full+active：…文案含看板/发布/电脑/审计` | `expected '钥匙' to contain '电脑'` |
| shell `claim_only+active：看板/电脑/审计…` | `expected '钥匙' to contain '电脑'` |

## Green on baseline (intentional pins, not the new pane)

- `full+active 仍有 trusted-automation-toggle 与 claim-confirmation-list` — #16 already in the keys pane
- `leftover claim_only …没有发布、没有待授权/绑定` — current UI already lacks bind; implementer must not add bind/`GET` pending for `claim_only`

## Testid contract for implementer

- Nav/pane: `workbench-nav-keys`, `workbench-pane-keys` (label 电脑)
- Lists: `devices-mine`, `devices-pending`, `claimants-list`
- Bind: `device-bind-claimant-name` (input), `device-bind-claimant-select` (`n-select`), `device-bind-submit`, `device-bind-self` (文案含 绑到我自己)
- Revoke: `device-revoke` (解除这台电脑), `claimant-revoke` (解除认领者)
- Absent: `github-user-approve`; no 生成 Agent Key; no GET `/api/v1/agent-keys`
- Bind POST `/api/v1/devices/:id/bind` body exactly one of `{ bind_to_self: true }` / `{ claimant_display_name }` / `{ claimant_id }`; success must not render trap `token`
- Credentials: `include` + `Accept` + `Content-Type: application/json` on mutations
