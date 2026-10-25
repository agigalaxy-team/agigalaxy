# AI 自动运行后端与运行验证

Schema 129 建立持久计划、任务、原操作回执、提交后事件与工作台运行关联。升级只创建结构和 disabled 默认配置，不启用任何岗位、旧授权或策略，也不改变人工模型配置。

所有定时执行仍由现有 PostgreSQL/pg-boss Worker 消费：`autonomy-tick` 写心跳、合并已到期事件、领取当期或一轮恢复任务；`autonomy-task` 领取任务、执行全局并发限制和岗位不重叠，并通过受保护的 Native 原任务接口启动。结果未知只读取同 taskId/operationId。Native code 分支回调 API 固定程序，不创建模型运行。业务完成数仅取实际业务回执。

高级运行配置保存在数据库并版本化，读取和保存位于 `/v1/operations/autonomy/settings`。新任务冻结当时的 roundSeconds 等版本；当前停止、撤权、人工接管每次读写都重核。总并发只允许 1 或 2，与 Native 全局上限一致。每日岗位没有人工选定时刻时只能保存停用草稿。

API 与 Worker 必须使用同一 endpoint、schema 129 和当前 least-privilege role SQL。Worker 需要现有受保护 `GALAXY_AGENTOS_CONFIG_FILE`，只能请求 Native 固定服务路径。API 私有桥继续要求既有 verified-AgentOS 服务鉴权和配额；JWT、service key 和模型凭据不进入任务、日志或前端。

## 独立监测

Worker 心跳的 producer 是 pg-boss `autonomy-tick` 和同一 Worker 的恢复循环；后者不能发现自身进程死亡。独立 consumer 是 API 的 loopback metrics exporter，它从数据库读取心跳和真实持久任务元数据，不依赖总控模型，也不调用模型。

现有 Prometheus `galaxy-api` scrape（示例 `127.0.0.1:9464/metrics`，30 秒）必须实际加载更新后的 `docs/alerts/galaxy.rules.json`。新增 `GalaxyAutonomyCollectionFailed`、`GalaxyAutonomyWorkerStale`、`GalaxyAutonomyTasksOverdue` 保留 `owner_role=operations` 标签，由部署环境既有 Alertmanager 路由决定接收器；标签本身不代表已配置独立分支。当前银河主机仍走既有 management 接收器。实际端口和配置路径以部署环境为准；源码示例不代表监控已经安装、启用或投递成功。沿用现有 Prometheus 服务，无需新增自主执行 timer。

API exporter 暴露 `galaxy_autonomy_collection_success`、`galaxy_autonomy_enabled_accounts`、`galaxy_autonomy_worker_health_available`、`galaxy_autonomy_worker_tick_age_seconds`、`galaxy_autonomy_worker_tick_limit_seconds`、`galaxy_autonomy_overdue_start_tasks`、`galaxy_autonomy_overdue_round_tasks`。没有心跳时 age 缺席并由 health_available=0 表示，不能补造一个零时刻。所有岗位停用时不触发值守心跳过期警报。API/Worker 本身掉线沿原 TargetDown/TargetMissing 警报发现。

## 部署与必要验收

统一发布包含 migration 129、API/Worker role SQL、API 路由与模块、Worker、Native duty 桥。先应用迁移及角色，再启动兼容进程；不能只发布单个挂接文件。不得整体发布工作区脏树。

核查五岗首次 disabled/pending、空历史曲线与未采集用量为 null；核查原操作 POST 失去回执后只读同 operation；核查角色撤销、计划停用、人工接管及源对象当前不可读均在服务内拒绝。用本地合成数据检查原生 PAUSED 同 run 续接及工作台具体卡回执，禁止用模型 completed 推导业务成功。告警规则用既有 promtool fixture 检查触发和恢复；真实接收器投递需由部署负责人单独验证。

程序模式当前有真实 P14 条件读取、固定规则未命中 no-action 回执，以及已接参数的文件扫描重试/内容恢复路径；其他动作缺少确定参数或当前资格时进入明确人工处理，不能宣称所有业务写都已程序化。AI 动作目录仍以当前角色、计划、grant、策略、处理器和原对象资格的交集为准。
