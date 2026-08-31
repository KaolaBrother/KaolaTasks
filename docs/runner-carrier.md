# Kaola Project Runner 承载兼容性（Issue #34）

本文档面向通过 MCP 连接 Kaola Tasks 的 Agent 客户端（kaola-mcp 桥接进程），说明认领任务
（Claim）之后如何**显式（explicit）**选用 Kaola Project Runner 这一可选 CLI 承载，以及该承载在
凭证、心跳、验收与结算上的边界。本文档补充 `docs/workflow-default.md`，不改变其中任何决定：直
连 Kaola Workflow 仍然是默认（default）路径，Runner 始终是一个需要显式请求的例外。

## 只在用户显式请求时使用，绝无静默切换

与 `docs/workflow-default.md` 中"默认路径"一致：没有显式请求，Agent 永远走 Workflow 直连；
只有当用户明确要求使用 Kaola Project Runner 时，Agent 才切换到 Runner 承载。这个选择只发生一
次、只在本地环境中声明，绝不会在两个承载之间静默切换——`resolveCarrierIntent` 在无法确认这是
一次完整、明确的 Runner 选择时，返回的是 `advisory`（观测），而不是悄悄退回 `direct`。

## 承载意图只来自本地环境变量

Runner 承载意图只通过 kaola-mcp 桥接进程自身的环境变量声明，从不进入任何 MCP 工具的输入参数，
也不进入服务端或数据库状态：

- `KAOLA_CARRIER`：`direct`（默认，等价于未设置或空字符串）或 `runner`；其他任何非空值都是
  advisory，不是静默 `direct`。
- `KAOLA_RUNNER`：五个已固定（pinned）的变体 id 之一（见下）。
- `KAOLA_RUNNER_SESSION`：非空会话名。
- `KAOLA_RUNNER_REPO`：绝对路径，指向 Runner 要接管的既有 git 仓库顶层目录（top-level）。

四者缺一或形状不对（未知 carrier 值、未知/缺失 runner id、缺失/空会话名、缺失/非绝对路径的仓库）
都会得到一个可读的 `advisory` 观测，而不是抛出异常，也不是伪装成 `direct`。这个解析逻辑本身是
纯函数（`apps/mcp/src/runner-carrier.ts`），不做任何文件系统、进程或网络 I/O。

## 固定的变体清单与快照版本

Kaola Project Runner 没有 semver、没有 tag，commit hash 本身就是版本号。本次兼容性绑定的是一次
只读测量记录的快照：

- **快照 commit：`fa19c63d`**（`kaola-project-runner`，2026-08-31，只读测量，不写入外部仓库）。
- **固定变体清单**（`scripts/kaola-tmux.sh:51`），验收只绑定下面这五项，不随外部仓库之后暴露的
  清单变化：

  | id            | binary         |
  | ------------- | -------------- |
  | `grok`        | `grok`         |
  | `claude-code` | `claude`       |
  | `opencode`    | `opencode`     |
  | `kimi-cli`    | `kimi`         |
  | `cursor-cli`  | `cursor-agent` |

## `(repo, session)` 定位符与工作区必须先于 Runner 启动而存在

Runner 的会话由 `(--repo ABS_PATH, --session NAME)` 这一对唯一定位：`ABS_PATH` 必须是精确的
git 顶层目录。**Runner 自身从不 clone、init 或 checkout**——它硬性要求一个已经存在的、精确等于
git 顶层目录的 checkout。因此 Kaola Tasks 必须在调用 Runner 的 `start` 之前，先建立好 Kaola
Workflow 的 worktree/checkout；Runner 不会替 Kaola Tasks 完成这一步。

这个 `(repo, session)` 定位符会被序列化为单个字符串，写入既有 Claim 回执（receipt）的
`runner_session` 字段（该字段的形状由 Issue #32 冻结为单一的 `string | null`，见
`claim-receipt.test.ts`）。`apps/mcp/src/runner-carrier.ts` 的 `runnerSessionLocator` /
`parseRunnerSessionLocator` 负责这一对打包/解包，使一个全新的桥接进程只读回执就能还原出同一个
`(repo, session)`，无需重新发起 Claim、也无需启动任何东西。

## 生命周期动词与 `capture` 是纯文本

`scripts/kaola-tmux.sh PLATFORM {preflight|start|observe|status|capture|send|key|answer|stop}
--repo ABS_PATH --session NAME` 是 Runner 侧唯一的调用面；没有全局二进制在 PATH 上。
`capture` **只返回文本**，Runner 从未在任何地方提供截图（screenshot）能力。

## 控制权仍然由已连接 MCP 的 Agent 持有

选用 Runner 承载不会改变六个 MCP 工具（`list_tasks`、`get_task_brief`、`claim_task`、
`report_progress`、`release_task`、`submit_pr`）中任何一个的行为或参数。心跳
（heartbeat，即 `report_progress`）、验收证据校验、携带凭证的结算、以及 `submit_pr` 全部继续由
当前受控 MCP 连接的 Agent 完成；Runner 只是执行承载，不获得任何独立的 Claim 控制权、凭证访问权
或结算权。

## 秘密规则：环境转发是最大的泄漏面

Runner 的 `start` 命令会把调用方环境中所有匹配
`CLAUDE_*|GROK_*|OPENCODE_*|KIMI_*|CURSOR_*|FAKE_*` 的变量原样转发进新建的 tmux 会话
（`kaola-tmux.sh:403-408`）。这是目前观测到的最大秘密泄漏面。因此：

- forge token（或任何凭证）绝不能被放进匹配上述通配符的变量名里，也绝不能写入 git remote、
  git config 字符串，或写入 Claim 回执；
- Issue #32 既有的回执字段白名单继续适用，不因引入 Runner 承载而放宽；
- `apps/mcp/src/runner-carrier.ts` 的 `runnerForwardedEnv` 只是这个转发通配符的纯投影，供桥
  接进程和测试推理"如果发起 Runner start 会转发什么"，它自身从不启动任何进程。

## 不可用或未识别的 Runner 只是 advisory 观测，绝不伪造成功

一次 `KAOLA_CARRIER=runner` 的显式选择如果因为未知/缺失的 `KAOLA_RUNNER`、缺失的会话名，或非
绝对路径的仓库而无法构成一次完整的 Runner 选择，`resolveCarrierIntent` 返回的是一个携带可读
`observation` 的 `advisory` 结果——底层的 Claim 依然照常成功，六个工具的行为不受影响，但这次
Runner 选择本身既不会被静默当作 `direct` 处理，也不会被伪造成一次成功的 Runner 附着
（attachment）。桥接进程把这类 advisory 结果记录为回执 `carrier: 'advisory'`，`runner` /
`runner_session` 保持 `null`：诚实记录"确实请求了非默认路径"，而不是为一个从未真正落地的选择
编造一个 runner id 或会话定位符。
