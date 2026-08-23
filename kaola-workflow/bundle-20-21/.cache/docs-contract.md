# Docs contract note — #20 + #21 (uncommitted worktree docs)

Worktree: `/Users/ylpromax5/Workspace/KaolaTasks/.kw/worktrees/bundle-20-21`  
HEAD pin: `0c2d15d` (docs not committed). No production code/tests. No `CHANGELOG.md` / `CLAUDE.md`. No `docs/CODEMAPS/` tooling in this repo — skipped.

Ground truth: `.cache/ground-truth-20.md`, `.cache/ground-truth-21.md`. Issue comments are workflow bookkeeping only.

---

## Headings changed

### `docs/DESIGN.md` (v0.2 line left as-is)

- **§6 `### 发布向导`** (new, after Task Brief JSON / credential tables; #21) — findable 发布向导 subsection.
- **§7 `## 7. 凭证与安全模型`**
  - bullet **从档案列 Issue** — 预填标题/正文 → 只读 Issue 副本 (#21)
  - bullet **Agent 侧 token 卫生** — four-key `clone` + extra_header table (#20)
  - bullet **无账号认领者（token 即访问权）** — clone 四键 + extra_header table (#20)
- **§9 `## 9. MCP 工具面`** — `claim_task` row (#20; additive `autonomous?` in parameters)

### `docs/api.md`

- **`### POST /api/v1/tasks`** — one clause: web 发布向导 omits the five optional extra keys; HTTP shape unchanged (#21)
- **`### POST /api/v1/tasks/:publicId/claim`** — `201` `clone` four keys + extra_header table; `202` has no `clone` (#20)
- **`### POST /api/mcp`** — `claim_task` success row same four-key `clone`; `202` structuredContent no `clone` (#20)

### `README.md`

- **`## Agent 怎么接单`** — one sentence on `clone.extra_header` + `clone.remote_url` + `clone.suggested_dir`; six-tool table unchanged; URL hygiene sentence kept (#20)

### Skipped (reason)

- `docs/DESIGN.md` version header — not bumped.
- `docs/DESIGN.md` §6 Task Brief JSON — extras keys kept (#21).
- `docs/api.md` `POST /api/v1/tasks/import` request/response — unchanged (#21).
- `CHANGELOG.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/README.md` — out of this doc pass.
- Codemaps — neither `scripts/codemaps/` nor `docs/CODEMAPS/` exists.

---

## Exact new `clone` keys (#20)

Outer success envelope (REST `201` and MCP `claim_task` success) still: `clone`, `lease`, `task`, `token`.

`clone` four keys:

| key | meaning |
|-----|---------|
| `suggested_dir` | = `task.repo.suggested_dir` (relative dir name) |
| `token_usage` | verbatim `token 请通过环境变量或 git -c http.extraHeader 按次传递，不要写入 remote URL（会落盘到 .git/config）。` |
| `remote_url` | HTTPS git remote, no username/password/token: strip trailing slash from `repo.base_url` + `/` + `repo.full_name` + `.git`. GitLab subgroups keep slashes in `full_name`. Not GitLab API `%2F`. Not `api.github.com`. |
| `extra_header` | `{ "name": string, "value_pattern": string }`. `value_pattern` contains literal `${token}`; must not contain revealed forge token. |

### extra_header table (all three forges)

| forge | name | value_pattern |
|-------|------|----------------|
| github | Authorization | Bearer ${token} |
| gitlab | Authorization | Bearer ${token} |
| gitea | Authorization | token ${token} |

Agent: substitute top-level `token` into `value_pattern` ≡ `git -c http.extraHeader="<name>: <value>" clone <remote_url> <suggested_dir>`.

Still: no new MCP tools; server does not run git; Task Brief `repo` five fields; list/get/session GET never get `clone` extras or token; `202` `confirmation_required` has no clone/token.

---

## 发布向导 facts (#21)

- Main path 来源=从 Issue 导入: 选档案 → 选 Issue → 「导入」=`POST /api/v1/tasks/import` (no persist, no 发布即校验).
- After successful import: no editable title/description inputs; read-only Issue card (title as text; `description_md` Markdown **or** monospace/text; clickable `source.issue_url`).
- Card until another 导入 or different Issue; no empty card before import.
- Publish still `POST /api/v1/tasks`; `title` / `description_md` / `source` / `repo` / `credential` from import + profile (person cannot edit title/body).
- No longer collect or display: 验收标准、测试命令、允许路径、禁止路径、优先级、标签. POST **omits** those keys; server defaults: `acceptance_criteria` `[]`, `test_command` `''`, `constraints` `{ allowed_paths: [], forbidden_paths: [] }`, `priority` `'P2'`, `tags` `[]`.
- Native (来源=自有): editable title+description; same extras omitted from UI and POST.
- Fallback: inline token + pasted Issue URL still imports; after success, same read-only card.
- HTTP contracts of POST `/tasks` and `/tasks/import` unchanged; Brief §6 key set unchanged.
