<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/9d/9dd005c50b71fdab8efd6dcf0c81e42a93384c43d165f82b71ce0900fb81bd21.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 撤销传播观测 v1

当前Schema41。业务读取仍使用现有授权检查、搜索触发器和Worker提交前复核；本批补齐运行指标与受控测量，不新增身份、业务副本或后台授权系统。

## 运行指标

原直接授权指标保留，新指标扩大到真实作业依赖，全部由API已有15秒缓存内的一次PostgreSQL语句快照采集：

| 指标 | 范围 |
|---|---|
| galaxy_revocation_open_jobs / galaxy_revocation_oldest_open_job_age_seconds | 兼容旧定义：Evidence或Builder probe作业的直接Consent/binding |
| galaxy_revocation_dependent_open_jobs | 有已撤销依赖的未结束Evidence、重验证或Builder probe作业数；同一作业只计一次 |
| galaxy_revocation_oldest_dependent_job_age_seconds | 上述作业最早依赖撤销至采集时刻的年龄；没有此类作业为0 |
| galaxy_revocation_search_documents | 搜索候选中仍引用已撤销Consent/binding的记录数；不是已发生越权读取次数 |

Evidence依赖包含直接提交、Case根、对应Attempt/Result、重验证指令的Consent及其binding；Builder probe包含请求引用的声明、节点控制和探测请求的Consent及binding。祖先撤销后直接提交授权可能仍有效，因此不能只看旧的直接授权指标。来源过期、删除、Case退出或维护状态有各自行为，不伪装成具有revoked_at的授权撤销。

搜索候选按依赖中的Consent/binding引用检查残留。正常触发器会在撤销事务内移除候选，指标用于发现异常或旧副本恢复产生的残留；服务仍逐个检查当前来源。只计算数量，不输出主体、对象ID、原文或凭据。采集失败时撤下旧值、保留最近成功时间，不把失败误报为零。

新增告警分别针对依赖撤销超过60秒仍有作业（持续2分钟）和搜索残留（持续2分钟）。它们反映后台处理和存储状态，不要求撤销接口等到全部作业结束才返回。见[告警与处置](alerting-v1.md)。

## 可复现的受控传播测量

设置 `GALAXY_TEST_PG_BIN` 为本机PostgreSQL工具目录，`GALAXY_TEST_PG_CASE=revocation`，运行：

```sh
node packages/galaxy-official/scripts/test-postgres.mjs
```

启动器创建独立临时集群、迁移当前Schema，使用受限API/Worker角色。它不接受生产数据库URL，不会撤销真实用户授权。源码：[测量入口](../packages/galaxy-official/test/postgres/revocation.test.mjs)、[主体链路](../packages/galaxy-official/test/revocation-propagation-workflow.mjs)。

测量先证明Case、Evidence、公开Proof及状态链接、History、Profile、Search和导出可用，再经真实HTTP撤销Case根授权，测量后续读取关闭、索引失效与Worker结束。额外复用既有Context客户端/导出、Honor、Evidence重验证和Builder探测流程，分别观察对应源授权撤销后的结果。结果写入 `outputs/revocation/propagation-<timestamp>.json`。

主链记录从撤销请求开始及收到成功回执到读取完成的墙钟耗时；复用流程以服务撤销调用返回作为提交已被观察到的起点。它们包含网络、排队和检查成本，是受控观测时间，不是精确的数据库提交时间。授权时钟固定仅为合成夹具，不用于伪造耗时。

额外注入一条旧搜索候选，检查指标可以发现、当前读取仍拒绝、清除后指标恢复。该注入只发生在独立测试库；常规运行只读聚合，无写入或自动生成测试身份。

## 覆盖边界与AI-agent使用

运行计量和受控测量分别解答“当前是否有撤销相关积压/残留”与“本次选定链路是否及时关闭”。指标为按需scrape，默认缓存15秒；告警另有持续时间。受控链路报告不作为持续生产可用率，也不替代其他对象各自的验收场景。

目标服务器、代理/TLS缓存、多实例、真实宿主界面和离线显示、外部接收者已保存的数据及备份副本仍按[生命周期规则](data-lifecycle-v0.1.md)处理。已经完成授权检查的在途请求和已下载副本不能追回。该实现不承诺互联网范围的同步删除或全局原子撤回。

部署先检查当前Schema、API数据库采集配置及SQL读取权限；检查新增指标与database_collection_success，保留明确的采集时间。出现积压先核对Worker是否运行、租约和依赖状态；出现残留检查触发器/恢复流程，保留当前来源读取检查，不依赖清空告警来恢复授权。回退可移除新增告警并回退采集代码，无数据库降级、凭据变更或业务删除。

## 当前本地结果（2026-09-11）

[实际报告](../outputs/revocation/propagation-1789067691207.json)：当前PostgreSQL18.6/Schema41、Node24.19.0，18条选定观测均通过。主链撤销HTTP回执为 16.55ms，从发起撤销到完成这些读取/索引/Worker观测的最大耗时为 282.16ms；这些是一次受控运行的观察上界，不是生产SLA。材料/导出、Honor、重验证指令和Builder声明/节点控制的逐项时间分别列在报告中。

新聚合验证了祖先撤销而直接授权仍有效时能够发现作业；多个祖先只计一个作业；撤销后Worker不读取来源。注入旧搜索候选时残留指标为1、服务查询仍为空，清除后恢复0。6项指标/API目录检查、22条规则的场景文件和lint通过。
