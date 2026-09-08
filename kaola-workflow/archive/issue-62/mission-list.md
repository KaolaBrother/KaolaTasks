# README 与近期机制对齐

## M1
item: 核对近期机制并更新中文 README，与当前合同和源码一致。
status: done
dispatched: self → README.md 与 .cache/doc-updater.md；对照当前合同、源码及近期 issue，限文档。
result: PASS — README updated from current source/contracts; .cache/doc-updater.md records docking scope. No product changes.

## M2
item: 独立核对 README 的合同准确性、链接及文档 readiness。
status: done
dispatched: code-reviewer → .cache/code-reviewer.md；审查 README 相对 ea14305 的精确 diff，文档只读，核对合同和链接。

result: PASS — independent code-reviewer verdict pass, findings_blocking=0 (.cache/code-reviewer.md); 18 local link targets resolve, ten MCP entries checked, git diff --check passes. No runtime/UAT claimed.
