# 范围和覆盖快照

时间为 2026-10-29 11:34 UTC 附近的已保存账本快照。full 表示有全文件静态阅读记录，不表示跨文件攻击链全部闭合、测试通过或安全认证。不得将相互重叠的账本直接相加为总体百分比。

## 不可变基线

基线 `aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2`，原始清单 tree 为 `61b71a56f90f07cd3c49ad05eb9e37f309da0ca2`，清单标记未截断。旧审计统计不参与此次计数。

| 账本 | 已保存状态 | 不能推出的结论 |
|---|---|---|
| Server 1,678 条记录 | 自行全读 1,324；跨审阅证据 35；partial/other 199；pending 120 | 不是 1,324 个独占主分配文件，也非全仓覆盖 |
| Server 主分配 1,501 | 自行全读 1,217；跨审阅 2；未完成 282 | 其余 107 自行全读来自跨归属依赖，不可重复累计 |
| Auth 307 条行记录 | full 290；cross-review full 4；partial 13 | 含交叉审阅，不等于独立重读全部内容 |
| Web 当前 1,064 条 | full 1,063；binary 1 | 二进制不当作源代码阅读完成；账本不证明依赖闭合 |
| Runtime | 原 STATUS 仍明确未完成；平台门槛后中止 | 不计算完成率；不把 SQL 关键词筛查算全语义审阅 |

Server 的 81 文件有界后续检查增加 15 个全读，66 个仍有明确剩余范围。保留的 runtime 边界包括主分配中 86 个 pending、130 个混合 partial，以及跨归属 37 个未完成项；并非每个文件分别遭到工具拒绝。未读普通片段也不能被默认为已完成或一概被禁止。

Web 早期 checkpoint.md 的 1,061 分配、751 筛查是历史快照，不能覆盖当前 ledger.json。部分较早 checkpoint 仍叙述当时未读段；后续交付前应核对最新逐文件状态与证据，不以旧摘要回退或新增虚假完成记录。

## 分离的变更审阅

| 变更基线与提交 | 已保存结果 | 剩余边界 |
|---|---|---|
| aa9dbc6 → 81797043ca9e871c353608c4c990a8daeb155f35 | Server 86 全读、6 完整比较、2 partial、6 显式排除、5 pending；Web 9 个变更文件全读；Auth 8 个分配变更文件已审 | 不覆盖全 HEAD；Server 13 个未完成/排除项仍单列；重叠不相加 |
| 8179704 → 595cd2ad4e3d09eab61739ffa1b034c993f962cc | Web 8 个分配变更文件全读，未确认可利用回归 | Server HEAD595 尚未开始；inspection profile 的服务端权限语义不由 UI 证明 |

前端 delegation ceiling 差量已由 auth 交叉核对：去除 UI 前缀屏蔽并未证明可授予敏感写权限。差量“无新增已确认漏洞”不等于基线三项已修复，也不等于当前 main 或线上版本安全。

## 可追溯账本

本地审计人员可查同级上层目录的 `server/coverage.json`、`server/COVERAGE-RECONCILIATION.json`、`server/FOLLOWUP-81-RESULT.md`、`auth/ledger.md`、`web/ledger.json` 与各 delta ledger。它们是已保存审阅证据，未随本草稿打包；本报告不生成原始证据总归档。Runtime 仅继承已保存 STATUS 的未完成标记，不恢复被中止分析。
