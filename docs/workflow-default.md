# 默认直连 Kaola Workflow（Issue #33）

本文档面向通过 MCP 连接 Kaola Tasks 的 Agent 客户端，说明 Claim 之后应当如何选择执行承载
（carrier），以及应当如何看待 Kaola Workflow / Kaola Project Runner 的能力观测。它补充
`docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md` 中的设计决定，不改变其中任何
决定。

## 默认路径：无需显式请求即直连 Workflow

认领任务成功后，当前 Agent 的默认（default）行为是**直接（directly）运行 Kaola Workflow**处理该
任务，不需要用户或调用方做任何额外声明——这是减法优先的默认值。只有当用户**明确（explicit）**
要求使用 Kaola Project Runner 这一可选 CLI 承载时，Agent 才切换到 Runner 承载；没有显式请求就永
远走 Workflow 直连，也绝不在两个承载之间静默切换。

```text
get_task_brief
claim_task(request_id)
从既有 clone 信封安全克隆
Workflow 启动或续跑
Mission List 执行与 report_progress 心跳
Workflow 收尾与 PR/MR 落地
submit_pr(task_id, claim_id, pr_url, summary)
```

这条路径不产生任何 Project Runner 调用；当前 Agent 独自承担 Claim 控制、Workflow 执行、验收与结
算。Kaola Tasks 本身仍然只做路由与协调，不运行 Agent、Workflow 或 Runner，也不把 Workflow 的阶
段、Mission List 内容复制进服务端状态。

## Workflow 目标映射

- **imported 任务**（`source.type === 'imported'` 且 `issue_url` 非空）：使用该任务已经存在的
  `issue_url` 作为 Workflow 目标，`workflowTargetForTask` 返回 `target_kind: 'issue'`，
  `available: true`。
- **native 任务**（或 `issue_url` 缺失/为空的 imported 任务）：没有可用的既有 Issue，Kaola Tasks
  **从不**代为在 forge 上新建一个 Issue 去凑合目标。`workflowTargetForTask` 返回
  `target_kind: 'issueless_project'`、`available: false`、`project_name` 取任务的公开 id，并附带
  一份 advisory 观测。

### 已实测的 issue-less（issueless）项目回退

对 Kaola Workflow 仓库做过一次只读测量（版本 `10.2.1`，commit `7e93763e`）：`cmdStartup` 在没有
`--target-issue`/`--target-issues` 时以 `no_target` 拒绝启动；`writeState` →
`normalizeIssueNumbers` 要求至少一个正整数 Issue 编号才能写出 `workflow-state.md`；
`commands/workflow-next.md` 也要求先解决或登记为真实 Issue。结论是 **not supported**：issue-less
项目当前不受 Kaola Workflow 支持。

因此，native 任务的 Workflow 目标只标记为 advisory-unavailable，其 `advisory` 字段忠实记录这次
测量，而不是假设该能力可行，也不是伪造一个 `issue-<N>` 项目名去骗过 Workflow 的存在性探测（这样
做会让 finalize 阶段对一个不存在的编号执行 `gh issue close`）。`advisory.reason` 命名上述
`no_target` 拒绝，`advisory.workflow_version`/`advisory.workflow_commit` 精确等于测量到的
`10.2.1` / `7e93763e`，不是占位符。

## 兼容性只是证据，不是硬性关卡

Workflow 或 Runner 的可用性、版本、能力是否可识别，都只是本地 **advisory** 观察，供 Agent 自行
判断如何继续（重试、更换承载、在明确获得批准后继续直连、或安全释放）——不是持久化为服务端策略
的硬性关卡。具体而言：

- 没有版本清单式的核对放行，一次 Claim 不会因为版本不在“已知列表”中而被拒绝；
- 一项可选能力探测不到，不会阻断 Claim；
- Workflow 或 Runner 返回了新的但可观察的接口形态，也不会阻断 Claim；
- 六个 MCP 工具（`list_tasks`、`get_task_brief`、`claim_task`、`report_progress`、
  `release_task`、`submit_pr`）的输入 schema 都没有新增任何 carrier/runner/execution/capability
  形状的字段，服务端本身也没有可以据此拒绝 Claim 的通道。

设备鉴权、任务状态合法迁移、token 解密、Claim/设备锁定、事务完整性、PR 仓库身份等正确性与安全不
变式仍然照常失败即拒绝（fail closed）；它们不属于兼容性关卡的范畴。

## 补偿遵循已完成的工作，不是进程退出码

- **compensation（补偿）**：在任何持久工作产生之前（例如 clone/Workflow 启动尚未开始或刚失败）
  出问题，就清理这次外部尝试，然后释放 Claim；
- **preservation（保留）**：一旦持久工作已经存在（本地仓库、Workflow 状态、有效 Claim），就保
  留它们，绝不自动丢弃；
- **forward-only（前向恢复）**：一旦 PR/MR 已经创建，恢复路径永远是前向的——复用同一个远端
  PR/MR、重试 `submit_pr`，绝不会仅因为一次本地回执写入或 MCP 响应不确定就再创建第二个 PR。

## 与 Issue #30 的措辞修正一致

`claim_task` 揭示的是任务的可复用、已持久保存的**仓库凭证（repository credential）**，不是为每
次 Claim 单独铸造的一次性令牌；per-Claim 铸造/吊销仍是明确的非目标（non-goal）。释放或
lease（租约）到期只会撤销 Kaola Tasks 自身的生命周期权威与 Claim 锁定，绝不会撤销 forge 令牌本
身——这与 `docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md` 中“凭证语义”一节的措
辞修正保持一致。
