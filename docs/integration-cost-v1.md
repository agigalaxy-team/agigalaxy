<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/77/77dce5a4b9040671ab3aa0fb45e966ef7b45c266729b38ec11d5752a88515f28.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 私有 integration 费用接线 v1

2026-09-11后续：已在目标独立目录安装OCI CLI 3.92.0/SDK2.185.1，并使用实例自身身份执行准确范围查询，实际返回404 `NotAuthorizedOrNotFound`。当前实例身份无法用于该费用读取；本次未改变IAM或复制OCI私钥，既有费用输入保持不变，定时器未安装。root手动查询配置在 `/etc/galaxy/cost/integration/collector.json`，CLI在 `/opt/galaxy/runtime/oci-cli-3.92.0/bin/oci`。这是一项已定位的读取前置条件，不是自动采集已启用。

2026-09-11在所选Oracle Kulai主机部署验证，当前选中 `official-2026.09.11-cost`，363文件，Schema41/44表。发行清单SHA256为 `2f200f5a140c0c56b1455a061a0992014eda19cd50210f98a00873a820f1743b`。本文是在冻结发行后补充的运行记录；已部署源文件由该清单确定。

## 数据来源与范围

本地独立OCI CLI 3.92.0（SDK 2.185.1）读取现有凭据中心原私钥，对一个明确实例执行Usage API查询；复用服务采集脚本生成v2输入。传到服务器的只有金额、币种、时间和范围摘要等费用观察，不含云账号、资源ID或云私钥。该观测属于共享实例，`attribution=unallocated`，不能作为银河新增费用或整个项目费用。数值和原始观察时间见项目私有运行记录。

预算为null，`cost_budget_configured=0`，不输出预算序列；费用金额仍正常读取。预算0是另外一种明确配置，不能用来填未知预算。当前输入路径 `/var/lib/galaxy/cost/integration/instance.json`，目录root/API组0750，文件root/API组0440。普通API进程只读，Worker不配置费用，避免重复汇总。

CLI包装入口是项目 `05-build/tools/collect-oracle-instance-cost-cli.py`；必须使用已安装PyYAML及OCI依赖的独立运行时Python。查询失败返回非零并保留之前的成功输入；OCI配置引用只在本机临时目录存在，最终移除。费用输出文件保留提供者查询的原observedAt，上传、API重读及Prometheus抓取均不刷新这一时间。

## 实际验证

- Linux API实际暴露单份费用金额、budget_configured=0、正确查询范围摘要及unallocated标签。
- Prometheus实际采到 `galaxy_cost_amount{job="galaxy-api"}`，币种和金额与CLI观察一致。
- 新版→drain旧版→新版均实际启动，readyz为200；9张选定事实/授权表摘要与Schema保持不变。
- 切回drain时自动移除API费用环境字段，旧版collection_enabled=0且无金额序列；选回cost时恢复并验证v2输入。
- 最终API、Worker、数据库、Prometheus、Node Exporter和备份timer全部停止；Caddy保持运行。没有修改公开路由。

## AI Agent 操作与回退

先检查所选发行、三份环境配置的一致性、已有费用文件及来源时间。发行切换入口、停止和启动顺序见[Linux运行说明](linux-deployment-v1.md)。不要重新运行一次性安装脚本：它要求新发行/费用目录不存在，已有发行必须保留冻结。

`integration-release.mjs`将费用配置与固定发行一起管理。API的 `GALAXY_METRICS_COST_FILE` 是额外受管字段；其余非发行配置保留。所有旧版回退移除此字段，费用文件仍保留。源码中的v1兼容只表示新版仍能读取旧输入，不表示旧发行能读取v2。

此前成本发行是实际单次查询与上传；后续自动采集还需落实目标可用读取身份与单一写入方。查询范围归属、同范围月预算、独立通知接收者和正式运行拓扑也未确定。旧观察会按原来源时间进入过期告警，不能把文件存在当作持续采集成功。

Oracle官方[Cost Analysis](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/costanalysisoverview.htm)给出的读取权限范围是tenancy的usage-report；[实例身份说明](https://docs.oracle.com/en-us/iaas/Content/Identity/Tasks/callingservicesfrominstances.htm)通过动态组与策略授予实例能力，并明确实例上的用户可以使用该身份。脚本只查询单一资源并不把IAM权限缩小到该资源。因此没有因开发自动采集而擅自授予整机租户费用读取权限。可接续选择已有独立采集身份，或在明确该权限范围后准备准确IAM变更。
