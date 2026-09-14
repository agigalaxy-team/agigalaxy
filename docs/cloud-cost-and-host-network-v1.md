<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/2a/2af2c895ac42524498d3de26a4254e5b4c66232ee609a985b9555fc2b74b006f.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 云费用与主机网络采集 v1

2026-09-11私有integration：已安装监控并验证四目标/22规则、启停及历史保留；已运行restic定时备份、Schema41/44表7文件隔离恢复与API备份状态采集。最终停止，异地仓库和真实通知未配置。当前路径、版本和限制见[运行说明](integration-operations-v1.md)。

2026-09-11更新：除官方Python SDK查询外，已在本地独立运行时实际执行 OCI CLI 3.92.0（SDK 2.185.1），读取明确选择的 Oracle 实例费用并进入指标。CLI直接读取凭据中心原有私钥；包装脚本只暂存配置引用，完成后移除，没有复制私钥。实际 `isAggregateByTime=true` 汇总行可同时省略开始/结束时间，此时沿用该次请求明确的UTC边界，并记录 `rowsUsingQueryWindow`。完整费用归属、预算和定时采集仍待完成。实际账户金额只保留在项目私有运行记录。

费用查询复用 Oracle 官方 OCI CLI，网卡指标复用 Prometheus Node Exporter。通用模板与实际目标部署分开记录：本地CLI查询、目标监控已分别验证，费用定时器没有启用；目标应用发行及启停以具体部署记录为准。

## Oracle 费用接线

入口为 [collect-oci-cost.mjs](../packages/galaxy-official/scripts/collect-oci-cost.mjs)，配置格式见 [oci-cost.example.json](monitoring/oci-cost.example.json)。配置写明确的 CLI 绝对路径、查询区域、tenantId、计费币种、月预算，以及 resourceId 或 compartmentId 范围。示例金额和 OCID 都是占位值，不能据此判断实际费用。

资源范围需同时覆盖实例、磁盘及其他归属银河的计费资源；只选实例不代表项目全部费用。共享 compartment 会包含其他应用的消费，应先确定归属；脚本不默认汇总整个 tenancy。按 compartmentId 过滤是对应 compartment，不能推断覆盖所有子 compartment。

采集器输出费用格式v2：`budget`可为null，省略采集配置中的预算也得到null；明确的0预算与未知预算不同。`scope`记录查询维度、资源数量和范围SHA256，`attribution=unallocated`表示尚未分摊，不输出原始账号/资源ID。金额来源、期间和观察时间保持原义。指标新增`cost_budget_configured`和`cost_scope_info`；未知预算时不生成`cost_budget`序列，已有v1预算文件仍能读取。切回只支持v1的旧发行前，必须撤下v2费用输入配置；不能用虚构预算把v2降成v1。

脚本调用官方 `usage-api usage-summary request-summarized-usages`，使用 COST、DAILY、按服务分组和时间合计，读取全部分页。查询 UTC 当月开始至当天零点，预算期间为整个 UTC 月。首日尚无完整日时明确失败；没有记录不视为免费。对应选项和分页见 [Oracle CLI 参考](https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/usage-api/usage-summary/request-summarized-usages.html)。

金额来自 `computed-amount`，要求统一币种、非预测值及有效期间；不合并不同币种、不额外减去 credit，也不把缺失或负值强制转成零。输出使用既有 `billing-export` 分类，表示费用系统导出，不能当成最终发票或实时支出。官方 [UsageSummary 定义](https://docs.oracle.com/en-us/iaas/tools/python/latest/api/usage_api/models/oci.usage_api.models.UsageSummary.html) 区分 computed amount、币种和预测标志；[Cost Analysis](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/costanalysisoverview.htm) 说明数据存在延迟。

只有完整查询、验证通过后才用临时文件及 rename 更新指标输入。查询失败、币种不符、空结果、循环分页或输出失败均返回非零；旧文件及旧 observedAt 保留，由已有过期告警识别持续失败。成功刷新时 observedAt 表示此次向提供者读取的时间；queriedThrough 另在无原始账目/账号标识的 JSONL 回执中记录，不表示提供者已完成该时刻之前的全部入账。API 重读同一个文件不会修改 observedAt。

```sh
node /opt/galaxy/current/packages/galaxy-official/scripts/collect-oci-cost.mjs /etc/galaxy/oci-cost.json /var/lib/galaxy/metrics/cost.json
```

这是真实的认证查询入口。启用前核对该 tenancy/范围的读取授权，使用已安装并记录版本的官方 OCI CLI。`auth=instance_principal` 由 CLI 使用目标运行实例的已有身份；`auth=api_key` 必须显式给 configFile 的外部 OCI 配置路径，可给 profile。采集器不打开配置中的私钥、不导入凭据、不修改云权限；应按已有凭据中心流程供给。配置文件可以保存凭据引用，不能包含 token 或私钥正文。

可选模板：[service](monitoring/galaxy-cost-collector.service)、[timer](monitoring/galaxy-cost-collector.timer)。按目标服务账号调整 Node/CLI/发布目录，预先创建该账号可写的 metrics 目录；先运行一次，再在 API 上配置 `GALAXY_METRICS_COST_FILE`。每六小时查询一次，单一 writer；API/Worker 不重复汇总同一费用。API 默认最多每15秒重读一次文件，无需重启。模板没有被启用，也未在 Linux systemd 上执行。

## 主机网络接线

[galaxy-node-exporter.service](monitoring/galaxy-node-exporter.service) 使用上游 `--collector.disable-defaults --collector.netdev`，监听127.0.0.1:9100；服务路径为待安装的正式二进制位置。部署时固定上游版本、架构及发布摘要，使用目标主机的真实接口选择，不假定模板证明已安装。

[host-network.example.json](monitoring/host-network.example.json) 提供可合并进现有 Prometheus 的独立 scrape job，只保留网络字节/包/丢包/错误和采集成功指标；targets 为空，需在同机采集时明确填写127.0.0.1:9100。现有 API9464、Worker9465 配置不受影响。不要将9100加入公开网站路由。

以下查询中的 `<uplink>` 必须替换为实际出口设备；不要同时累加物理设备、网桥和虚拟接口，以免重复计数：

```promql
rate(node_network_receive_bytes_total{job="galaxy-host-network",device="<uplink>"}[5m])
rate(node_network_transmit_bytes_total{job="galaxy-host-network",device="<uplink>"}[5m])
```

接口计数包含该主机其他服务，不能直接归属银河，也不等同云商计费出站。API 正文计量提供应用范围的另一个视角，排除 HTTP/TLS 头、重传与未读取的拒绝正文。部署选项来自 [Node Exporter](https://github.com/prometheus/node_exporter)，速率查询见 [Prometheus 官方指南](https://prometheus.io/docs/guides/node-exporter/)。

## AI-agent 运行与回退

先发现当前服务配置、CLI 路径/版本、已有身份、费用归属和实际出口，再运行准确范围的采集。检查 collector 固定事件、费用来源观察时间与输入金额、API collection_enabled/input_available，以及 Node Exporter 的 up/采集结果。API 聚合结果与主机/云费用各自比较，不将未采集解释为零。

本地集成覆盖分页与范围参数、费用到指标文件的更新、失败保留、合法零金额、未知预算及预算撤下。实际CLI执行另有项目私有记录，不由合成响应测试推断。负载、Promtool与目标监控各有独立记录，单次查询不代表定时采集或持续运营。

回退时停用可选 timer/job，恢复先前明确标记的费用输入或取消对应环境配置；不删除账单、业务数据或任何云凭据。原阶段条件与全链路撤销传播计量仍按任务表保留。
