# 审计接手说明

本目录是一份可交接的阶段草稿，阶段版本已发布至PR #3，最终交付仍未完成，不是任务收尾。最早收尾时间为 2026-11-01 05:32 UTC，且必须合理完成后再结束。整体任务、后续获准工作及最终交付由主审协调，本报告整理者没有新增委派、远程操作或验证授权。

## 不得丢失的判断

1. 保持不可变基线 `aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2`；两次 delta 独立列示。旧审计已撤回，不恢复旧报告或结论。
2. 三项 availability 发现为静态支持；Capsule 和搜索有独立静态复核，归档有认证配额交叉核对。均没有线上 DoS 证据。
3. 搜索直达扣一次默认 25/60s/IP 分页额度；information reference 形状不扣分页额度，但受独立 60/60s/IP、1 至 8 项顺序选择限制。不得把两者混写成无限请求。
4. Outcome export 保持策略限定、排除确认发现；身份关联保持受害者交互和部署同意条件，不能写为静默接管。
5. Runtime SQL/Redis 保持条件项；平台中止不能通过新代理、工具或措辞绕开，不恢复其技术分析；不称互联网 RCE。

## 后续闭合清单

- 在允许范围内核对最新保存的逐文件账本、跨归属重复和 delta 剩余；不要把 full read 改成全链闭合。
- 处理 server 282 主分配未完成条目时先保留已标识限制；非受限独立工作与受限 remainder 不混为一谈，也不推定授权继续。
- Web 当前账本 1,063 full、1 binary；早期 checkpoint 为历史状态。最终发布前解决摘要与最新账本的时间差，不随意追认旧 checkpoint。
- 明确条件项需要的产品/部署证据；仅从已有材料无法完成时保留未知，不通过生产探测补齐。
- 记录修复是否实际发生、提交和部署证据；本阶段没有修复业务源码。
- 未到 72 小时不宣称完成；到点也不以时间替代合理收尾。最终仓库交付方式另由主审在授权范围内处理，本目录不自动发布。

## 本草稿依赖

只使用此次审计已保存的 plan、verification-limits、server HANDOFF/REPORT/COVERAGE-RECONCILIATION 与三项候选、independent-resource/REPORT、independent-search/REPORT/SOURCES、auth attack-notes/ledger/delta、runtime STATUS/findings、web ledger/checkpoint/delta。读取范围没有包含凭据事件定位材料；没有恢复已删除旧审计。引用原始记录不表示本整理者重新阅读所有源代码。

本次整理仅生成本目录的八份 Markdown。报告质量核对包括文件存在、内部链接、关键基线/时间、三项计费和证据等级、无原始源码复制或凭据值。仍需主审审阅，不代表全审计质量门已通过。
