<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/bd/bd253d058b16dedb4688abbaa2fd7b00d738a974739f3fcd96a4444b18663b76.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 运行指标 v1

服务采用 Prometheus 维护的 [@prometheus-io/client](https://github.com/prometheus/client_js) 0.16.1，锁定于 Official 自己的 package.json/package-lock.json。复用其 Registry、Counter、Gauge、Histogram 和默认进程指标，不自建指标协议。当前在本机开发与隔离 PostgreSQL 中集成；未部署动态服务或监控平台。

## 入口与配置

API、Worker各自设置 `GALAXY_METRICS_PORT`，例如9464、9465，监听地址固定127.0.0.1；只接受GET /metrics。不配置端口则不开放监听，进程内仍记录计数。指标不挂在业务API路由上，也不加入官网公开能力声明。

可选 `GALAXY_METRICS_STORAGE_DIRECTORY` 指向需测量的本机文件系统绝对路径。返回该文件系统总容量与当前用户可用空间；它不证明远程PostgreSQL主机的磁盘空间。可选 `GALAXY_METRICS_COST_FILE` 指向完整费用输入，见[示例](metrics-cost.example.json)。端口和目录配置在启动时读取；费用文件启动时校验，之后默认最多每15秒重读一次，更改费用无需重启。API和Worker不应使用同一个指标端口；同一份费用只配置给API，避免重复汇总。

同机Prometheus采集配置见[prometheus.example.yml](prometheus.example.yml)。例子未启用任何真实监控服务，不能代替跨故障域监控；后续可由Prometheus或OpenTelemetry Collector采集。

## 已采集内容

| 指标 | 来源与含义 |
|---|---|
| galaxy_http_requests_total | 请求完成/连接关闭，固定路由模板、状态码；可计算错误率 |
| galaxy_http_request_duration_seconds | 从收到请求到响应finish/close的直方图 |
| galaxy_http_in_flight | 当前未结束的业务HTTP请求 |
| galaxy_http_request_body_bytes_total | JSON解析器实际读取的请求正文字节，含导致解析失败或超限的已读部分 |
| galaxy_http_response_body_bytes_total | 实际交给Node响应write/end的业务正文大小，含流式输出 |
| galaxy_http_parser_errors_total | 400/408/431解析拒绝；独立于已进入应用的请求 |
| galaxy_revocation_ack_duration_seconds | 撤销接口成功响应延迟，不等于跨系统传播时间 |
| galaxy_worker_iterations_total / galaxy_worker_iteration_duration_seconds | observed、revoked、unavailable、idle、budget_limited、lease_lost、paused、error |
| galaxy_worker_last_iteration_timestamp_seconds | 最近一次结束迭代的时间；首次迭代前为0 |
| galaxy_worker_retirement_paused | 因停服策略暂停领取 |
| galaxy_jobs / galaxy_job_active_leases / galaxy_job_oldest_open_age_seconds | 数据库作业状态、有效租约和最老未完成作业年龄 |
| galaxy_revocation_open_jobs / galaxy_revocation_oldest_open_job_age_seconds | 直接关联的Evidence/Builder probe Consent或binding已撤销，但作业仍未结束的数量和等待年龄 |
| galaxy_revocation_dependent_open_jobs / galaxy_revocation_oldest_dependent_job_age_seconds | 包含Case/Attempt/Result、重验证指令及Builder声明/节点控制的撤销依赖作业与最老年龄 |
| galaxy_revocation_search_documents | 存储中仍引用已撤销Consent/binding的搜索候选，不代表越权读取次数 |
| galaxy_database_bytes | pg_database_size；含库内表/索引，排除集群WAL和备份 |
| galaxy_storage_bytes | 显式选择的本机文件系统total/available |
| galaxy_process_*、galaxy_nodejs_* | 客户端库提供的CPU、内存、事件循环等进程指标；部分指标仅Linux支持 |

HTTP标签只使用已有固定路由分类（动态ID折叠为:id，未知路径为http.request）和有限状态。没有IP、Galaxy ID、凭据、原文、查询串或用户自定义标签。出站计量是应用交出正文的字节，不证明客户端收到；入站计量是JSON解析器实际消费的字节，不包含鉴权/媒体类型拒绝后未读的正文。两者均排除HTTP头、TLS和重传。主机网卡采集复用Node Exporter，见[云费用与主机网络](cloud-cost-and-host-network-v1.md)，它也不等于云账单计费量。

只有API采集数据库全局量，避免同机Worker重复汇报全库总数。默认15秒内共用一次数据库采集，重叠scrape复用同一在途查询。单个SQL语句快照返回聚合，不写业务表。采集失败时success置0、撤下旧业务数值、保留last_success时间；缺失值不解释为0。collection_enabled明确是否配置了该采集项。

## 产品阶段定义

`galaxy_product_subjects{stage="connected"}`：数据库中至少有一个未到期且未撤销binding的不同主体。它不是实时在线会话数，也不是本地生成Galaxy ID的总数。

`stage="evidence_bearing"`：主体至少有一项state=observed的Evidence，最新ordinal观察仍在validUntil内，直接Consent/binding有效，Case未退出，Case/Attempt/Result三项祖先授权仍有效。它可以包含CI失败结果；“持有来源事实”不要求结果成功。指标用于运营汇总，不代替逐次对象读取、披露、哈希和签名检查。

当前来源观察明确不证明独立能力。`galaxy_verified_capability_measurement_available=0`，不产生虚构的Verified-capability人数。已连接与持有证据可重叠，不能相加为用户总数。合成测试数据不是试点用户，生产指标需有明确环境边界。

## 费用、可用性与撤销的边界

费用输入明确币种、金额、预算、账单/估算性质、期间和观察时间。未提供输入时cost_input_available=0，不输出金额。提供后保留来源时间和期间供判断是否过期；程序不从本机流量或“免费云套餐”推算真实账单，配置的费用文件会在采集缓存到期后重读。失败时input_available=0，撤下旧金额/期间/来源时间，保留cost_last_success_timestamp_seconds；文件恢复后自行恢复。cost_collection_enabled区分未配置与采集失败。读取成功时间不替代来源observedAt，换币种或性质时移除旧标签序列。

Oracle费用采集脚本复用官方CLI，按明确资源或compartment范围读取完整分页后原子更新文件；另提供未启用的systemd定时模板。见[接线与限制](cloud-cost-and-host-network-v1.md)。普通估算文件也可继续使用；写入方应先写临时文件，再rename替换，避免半写文件。

费用v2允许预算为null并记录未分摊的查询范围。`galaxy_cost_budget_configured=0`时金额仍可用，但没有`galaxy_cost_budget`序列；明确预算0时configured=1且预算序列为0。`galaxy_cost_scope_info`只输出维度、数量、范围摘要和`unallocated`标记；切换或输入失败会移除旧范围。v1输入继续兼容，其原有预算语义不变。金额不能自动解释为银河项目费用，预算必须属于同一范围。

健康、就绪请求的成功率和Prometheus的up反映各自检查范围；未持续发起探测时不能推算一段历史的可用率。C17-07的独立Blackbox/Prometheus配置与本机真实探测已经实现，见[独立监控](independent-monitoring-v1.md)；异地部署仍未完成。

撤销指标覆盖接口确认、直接与祖先依赖作业，以及搜索残留。另提供真实HTTP/PostgreSQL的受控传播测量，覆盖选定Proof/履历/搜索、Context/导出、Honor及后台作业路径，见[撤销观测](revocation-observability-v1.md)。真实宿主缓存、代理、多实例和外部副本仍需对应证据，不由这些指标推断。请求配额使用单API进程计数；跨进程资源配额见[资源预算](resource-budgets-v1.md)。

## 查询与AI-agent操作

先核对API/Worker环境和各自端口，再启动本机采集。用/metrics检查content type、数据库collection_success、last_success以及Worker时间；不要把指标端口加入公网Caddy反代。进程关闭时指标监听一并关闭。回退可取消指标端口配置或回退代码，当前Schema41，本批不改变数据库。

示例PromQL：

```promql
sum by (route) (rate(galaxy_http_requests_total{component="api",status=~"5.."}[5m]))
histogram_quantile(0.95, sum by (le,route) (rate(galaxy_http_request_duration_seconds_bucket{component="api"}[5m])))
sum(rate(galaxy_http_request_body_bytes_total{component="api"}[5m]))
sum(rate(galaxy_http_response_body_bytes_total{component="api"}[5m]))
galaxy_jobs{component="api",state="pending"}
time() - galaxy_worker_last_iteration_timestamp_seconds
```

本机HTTP测试覆盖成功/失败/流式响应、固定标签、共享采集、故障撤下旧值、费用与真实文件系统统计。真实PostgreSQL流程核对绑定/证据阶段、队列变化和直接撤销清理；生命周期流程检查实际API/Worker指标监听、默认进程指标和关闭。请求/资源额度、日志轮转、规则告警、费用导入和独立探测已有本地实现；目标资源校准、实际费用来源、接收责任人及监控部署仍按C17推进。

运行日志已提供runtime_log_ready与runtime_log_events（写入失败、丢弃、轮转警告/完成）；采集频率沿用现有15秒缓存。见[运行日志](runtime-logging-v1.md)。

2026-09-10：新增固定类别resource_quota_rejections_total和可选backup状态指标（available/running/latest outcome/start/finish/last success）。API与备份CLI共享GALAXY_BACKUP_STATUS_DIRECTORY；Worker不重复采集。默认监控create/check/copy。19条标准告警与处置说明见[alerting-v1.md](alerting-v1.md)；接收渠道尚未部署。

2026-09-10：试点SLO候选使用既有HTTP计数/直方图，6条记录规则和3条告警可选加载；4xx策略拒绝单独统计。30日目标未冻结，成本未知，见pilot-slo-v1.md。

2026-09-11：费用文件动态刷新、入站正文计量、Oracle费用查询适配和Node Exporter接线完成本地交付；新增费用输入不可用告警，当前共20条标准规则。当前Schema41的持续负载同时启用指标，961次计量请求含960次业务请求和1次撤销，入站451202字节、出站797351字节；详见[容量记录](pilot-slo-v1.md)。真实Oracle查询与Linux采集服务尚未执行。
