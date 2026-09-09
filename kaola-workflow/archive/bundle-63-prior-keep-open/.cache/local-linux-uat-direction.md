# #63 本机 Linux 全闭环 UAT 设计要求

## 最新用户更正：全程 Agent，无人工等待

用户随后明确本次 smoke 全程由 Agent 完成，所需 token/key 已在主仓 gitignored `.env`。本节优先于下文先前“配合/等人”的描述，例外仅限本机隔离 Linux UAT，不修改生产管理员授权规则。Agent 读取所需凭证但不输出内容、不写入仓库/聊天/remote URL，不复制整份.env到认领端。发布/管理端与认领Agent权限隔离，认领端只从成功claim获得该任务forge凭证。

更新 smoke 手册时将此路径明确标为全Agent：管理员Agent使用隔离环境的真实管理员登录会话，在生产工作台通过浏览器自动化输入客户端配对密语并批准；会话建立、密语传递只通过受保护本地通道，不贴聊天或共享日志。真实REST可作协议诊断，但只有实际运行工作台才记UI通过。不得直接改库、使用测试注入身份或旧pairDeviceToSelf代替新配对链。配置、导入发布、认领交付、评审合并均由Agent执行；不设置虚构人工门。真实OAuth若能使用已有配置则Agent执行，若提供商外部人机挑战阻断则如实记阻塞，不能伪称OAuth通过。旧A路径人工规则保留，新路径记录这项用户授权的明确范围。交付当前文档设计后，按原授权先完成收尾再执行UAT。

用户明确：在本机模拟 Linux 电脑，完整测试新私有 CA 自动配对与 MCP 驱动 Agent 的认领交付机制。先设计 UAT 并更新 docs/smoke-test.md；不要把路径 B 加单独 pair 测试拼成新机制全闭环通过。

Runner 负责设计与文档写入，主控只监督复核。先读取 AGENTS.md、DESIGN/ADR、现有 smoke 手册和实际脚本接口，新增明确的当前本地 Linux 路径。文档结果只写 smoke 手册，不把 UAT 结果写 Issue。保留历史记录但明确旧“本轮不部署/不做”的限制已被用户授权本地测试取代；不授权外部部署。

最小完整方案：

- 本机隔离的 Linux 服务端与干净 Linux 认领端（容器/VM），真实 HTTPS 私有 CA 入口、生产服务/MCP package-bin、独立 SQLite/KAOLA_HOME 和网络。服务器容器本身不等于 Linux 认领端。固定最终提交与构建来源、明确 host/container URL/DNS/SAN 对应与回收目标；不动现有库和无关容器。
- 认领端初始无额外根、无历史 receipt/设备授权、无 forge PAT。不得预挂根、手工 trust install、手工 PEM/指纹/env/重启作为自动配对成功条件。CA 签发私钥只留隔离签发端，不挂入认领端；浏览器信任与 MCP 用户级信任分开。
- 管理员准备凭证档案、导入发布 GitLab/Gitea smoke 任务；两家真实 forge，不含 GitHub。PAT仅发布侧已有 env/页面，Agent只在 claim 成功响应拿任务凭证，不进日志/remote URL。
- Linux Agent 通过生产 MCP 发现工具与发起请求，证明未配对不能 list/claim；收到 pairing_required 后按产品现有 CLI 运行 pair（pair 是辅助 CLI，不能虚构成 MCP tool）；密语仅安全本地展示。管理员按手册“配合”在人机在场的工作台批准。不能用 inject/直接写 SQLite/pairDeviceToSelf 绕过新配对授权当作本路径 PASS。
- 批准后同一设备自动校验 approval proof、严格 TLS/active whoami、落地 v2，接续生产 MCP tools/list、list_tasks、claim_task，完成真实 clone/改 README/PR/submit_pr、评审修改/submit_revision、合并、已完成及源 Issue 回写。区分 MCP协议驱动器与实际 coding Agent；不能把脚本调用冒称真实 Agent 会话。设计明确 Linux 上选用的真实 Agent 承载与不含密钥 MCP 配置，缺少该承载时标缺项而非替代。
- 在这一本地拓扑设计恢复/负例矩阵：批准前后客户端中断与同receipt恢复、错误密语、到期与不滑动86400窗口、90天默认授权/存量不变、换root/origin/replay、pending无权限、overlap与错过overlap重pair、证书配置错误、caller extra根污染、trust替换中断与rename失败、公开CA迁移保留与实际可验证边界。区分真实运行与可控时钟自动测试，不为了24h/90d改真实时间；不把单元测试当物理等待证据。
- 每步提供前置/操作/期望/证据/自动或配合/失败恢复，结果模板绑定SHA、Linux镜像与Node/OpenSSL、设备隔离、forge资源、脱敏日志、未执行项。真实OAuth、Windows、macOS物理客户端、公开CA等不因本次Linux通过而自动PASS。标配合步骤必须停下等待人操作，不能Agent代点管理员批准。

此刻先交付可执行设计文档，不先启动UAT。后续仍按已授权收尾再启动测试顺序。

## 同时到达的独立复核 e50f761 — FAIL

R1/R2/R4/R5/R6 resolved。R3仅剩：两条OpenSSL验证路径指定CAfile却未隔离默认CApath/CAstore，实际根B在默认库而配置无关A仍可通过。必须两路径只信配置根，增加默认库污染回归。R7：新expired fixture用openssl x509 -not_before/-not_after，在Debian Bookworm OpenSSL3.0不支持，测试命令在断言前失败。使用可移植fixture并在目标Linux验证。签名/有效期/用途/DNS/IP上一轮修复已认可，不重复扩范围。审查为源路径与官方文档核验，未实际执行Linux测试。所有修复与测试仍由Runner完成，最终候选再次复核前不得sink。

References: https://docs.openssl.org/3.0/man1/openssl-verification-options/ ; https://docs.openssl.org/3.0/man1/openssl-x509/
