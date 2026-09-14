<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/6a/6a1b6e93866c9b6b4cefb021f2ad91b77ef3c34bbe7db90543109dcd413bffa7.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 资源预算 v1

API 与 Evidence Worker 已支持主体业务原文、有效导出票据、未完成作业和执行租约配额。服务启动默认启用；开发初始值不代表生产容量或 SLA。当前Schema41/44表；主体载荷预算包含外部账户关联原文及签名，动态云服务未部署。

## 配置与使用

API 和 Worker 使用相同的 `GALAXY_RESOURCE_BUDGET_FILE` 绝对路径 JSON 文件，格式见 [示例](resource-budgets.example.json)。不设置时使用默认值；设置后须提供完整字段，文件上限8192字节。更改后重启进程，实际加载摘要记录为运行配置事件的 `resourceBudgetHash`。

| 字段 | 开发初始值 | 含义 |
|---|---:|---|
| maxPayloadBytesPerSubject | 1048576 | 每主体累计业务原文 UTF-8 字节 |
| maxQueuedJobsPerSubject | 32 | 每主体 pending/running 作业总数 |
| maxActiveExportsPerSubject | 3 | 每主体未撤销且未到期的导出票据 |
| maxActiveJobsGlobal | 4 | 全库尚未到期的 running 租约 |
| maxActiveJobsPerSubject | 1 | 同一主体尚未到期的 running 租约 |

嵌入式 `createServices` / `EvidenceService` 调用需显式传入 `resourceBudgetPolicy`；启动入口 server.mjs、worker.mjs 自动加载。多 API/Worker 进程须配置一致，避免额度因请求路由产生差异。

## 计量范围与事务

原文字节合计以下12张表的 payload_text：external_identity_links、case_events、evidence_submissions、proofs、assistance_events、context_grants、context_acceptances、moderation_reports、moderation_events、capsule_events、capsule_uses、builder_events；proofs 同时计入签名回执 signed，external_identity_links 同时计入 signature。举报按 reporter_id，其余按 subject_id 归属。

这是业务原文预算，不是物理磁盘上限。身份、Consent、审计、通知、派生投影、Worker观察结果、索引、WAL和备份不在该字节合计内；这些空间仍需容量监测和保留策略。撤销不自动清除历史原文。

参与预算的写入在 PostgreSQL 事务内先获取主体 advisory lock，再授权和计算写入前后用量。若新增用量越界，业务事实、作业、导出票据及该事务的成功审计一起回滚。同库多个参与进程共享锁；直接写库或未启用策略的嵌入调用不受此保护。当前按表聚合，实际规模下的查询成本待负载测量。

即使运营下调预算到现有用量之下，未增加计量用量的幂等重试仍可执行。Case退出、协作取消/撤回申请/到期/争议、Capsule弃用或安全维护、节点撤销/下架/安全公告、治理处置等必要控制事件不因业务原文预算被阻断；保留的控制事件字节仍计入随后普通写入的基线。现有读取和授权撤销保持原入口。

导出票据按主体跨绑定合计，原每绑定3张限制仍适用；撤销或到期释放票据额度。队列统计关联主体的 pending/running 作业，完成/失败后释放额度。

## Worker与失败恢复

Worker领取作业时用全库 advisory lock 串行确定有效租约总数，再按主体有效租约数筛选可领取作业；领取完成即释放事务锁，实际来源读取在事务外执行。到期租约可由原有重试流程重新领取，原30秒租约和最多5次尝试保持。

租约额度不是操作系统 CPU、网络或进程并发硬上限：旧 Worker 挂起且租约过期时，另一个 Worker 可以接替；原租约持有者不能覆写新租约的结果。没有可用全局额度时返回内部 budgetLimited 状态，由既有 Worker 循环后续重试。

| HTTP错误 | 状态 | 处理 |
|---|---:|---|
| storage_quota_exceeded | 409 | 检查主体业务原文用量，按策略清理或调整配置 |
| job_queue_quota_exceeded | 409 | 等待已有作业完成，再重试原请求 |
| export_ticket_quota_exceeded | 409 | 撤销不用的票据或等其到期，再重试 |

没有固定的 Retry-After：资源释放时间无法从请求窗口推导。HTTP请求频率仍由独立的 [分类额度](request-quotas-v1.md) 控制。

## AI-agent部署与检查

发现目标服务的 API/Worker 启动配置，给两者指定同一份预算文件；不要从旧服务档案推断配置已生效。启动后检查两种组件最新运行配置事件的 resourceBudgetHash 与实际文件解析结果一致，并检查超额请求无部分业务写入。回退时选择先前预算文件并重启，无数据库降级。

本地 resource-budget-workflow 覆盖并发业务原文、整笔回滚、UTF-8计量、下调后的幂等重试、退出、导出票据撤销再建、队列额度、全局与主体租约、完成后释放。PostgreSQL集成复用该流程检验受限API/Worker角色；lifecycle检验实际进程加载和记录配置。真实负载、磁盘容量、成本告警与生产部署另行记录。

运行指标入口已接通，见[运行指标](operational-metrics-v1.md)。这些实测入口可用于后续负载/成本校准，默认额度尚未因此变成生产容量承诺。

2026-09-10：本机容量基线完成，576次2xx读写及默认30接受/34限流验证通过；payload增长额度0时撤销可用。默认资源参数保持不变，持续负载和目标资源校准未完成，见pilot-slo-v1.md。

2026-09-10：持续API/Worker混合场景通过，137次采样保持全局4/主体1活跃租约，最终队列清空。32req/s为本机所施加负载，不是容量上限；默认额度未变。见pilot-slo-v1.md。

2026-09-11：当前Schema41/44表启用指标后的持续负载完成，30.28秒内960次业务请求成功，P99 155ms；96个Worker作业完成，默认全局4/主体1租约保持。频率额度仍为校准上调，默认资源预算未提高；实际服务器容量、云费用与运营额度仍待确定。
