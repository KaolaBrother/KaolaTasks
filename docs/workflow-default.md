# 直连 Kaola Workflow：默认承载，且是强制要求（Issue #33 → #39）

本文档面向通过 MCP 连接 Kaola Tasks 的 Agent 客户端，说明 Claim 之后应当如何选择执行承载
（carrier），以及应当如何看待 Kaola Workflow / Kaola Project Runner 的能力观测。它补充
`docs/decisions/0030-claim-mcp-workflow-runner-compatibility.md` 中的设计决定，不改变其中任何
决定。

## 必须直连 Workflow：无需显式请求，也不允许省略

本节适用于**来自外部 forge Issue、并随任务携带该 Issue 凭证**（`source.issue_url`）的任务——该
Issue 就是 Workflow 目标。对这类任务，认领成功后，当前 Agent **必须（required）直接（directly）
运行 Kaola Workflow** 处理该任务，不需要用户或调用方做任何额外声明；Workflow 直连是默认
（default）承载，而且不再只是一个可以省略的默认值。只有当用户**明确（explicit）**要求使用 Kaola
Project Runner 这一可选 CLI 承载时，Agent 才切换到 Runner 承载；没有显式请求就永远走 Workflow 直
连，也绝不在两个承载之间静默切换。

若认领到的任务没有随附的 forge Issue（例如 native 任务），则不在本节范围内：Kaola Workflow 本身
启动就要求至少一个 Issue 编号（已实测 `no_target` / `claim_issue_numbers_invalid` 拒绝），因此无
法为其启动 Workflow。

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

- 本节范围限定在来自外部 forge Issue、随任务携带该 Issue 凭证的任务：这类任务的 Issue
  （`source.issue_url`）就是 Workflow 目标。对这类任务而言，每一次成功认领（claim_task 成功）都
  必须启动 Kaola Workflow：Claim MCP 合同不再为它们建模“认领成功但没有 Workflow 目标”的组合。
  Kaola Workflow 启动要求至少一个正整数 Issue 编号（已实测：`cmdStartup` 在没有
  `--target-issue`/`--target-issues` 时以 `no_target` 拒绝；`normalizeIssueNumbers` 缺少合法 Issue
  编号时抛 `claim_issue_numbers_invalid`）。
- 认领到的任务若没有随附的 forge Issue（例如 native 任务），则不在本节范围内：Kaola Tasks 从不代
  为在 forge 上新建 Issue 去凑合目标，Agent 也无法为其启动 Kaola Workflow——上面测得的
  `no_target` / `claim_issue_numbers_invalid` 拒绝就是原因。

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
