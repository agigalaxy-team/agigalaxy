# 当前工作

## 当前任务与状态

2026-10-29：工作台历史、卡片、沟通条件和管理能力已独立呈现；当前继续修复真实多轮调用暴露的重复读、慢读及终态接续，不恢复广泛测试。

- 当前线上：Go/Admin/AgentOS为`4ff4623`，官网保持`8e919ac`；该批GitHub CI全过。数据、账号、模型和配置保留，未执行数据库迁移。
- 已接通：独立资源、显示与资格分离、精确事件和原操作回执；摘要缺失回调与AI查询/准备身份接线已修复，不调整真实角色。真实问候正常；注册用户查询取得3006，反馈查询仍在慢读超时，本轮不能视作业务取数全部通过。
- 当前收尾：摘要去重、完成回执复用与有限并发；查询减少同事务重复权限计算；取消后闭合已观察工具账本；慢读超时停止立即整次重试；原操作读取单飞并继续收敛终态。
- 已观察结果：原有显示和双向延迟检查通过；本批查询PG回归和Python13项通过。摘要两项新增回归、前端5项独立无头检查及TypeScript通过；最终CI、部署和修复后真实多轮调用待完成。上一轮回复完成仅证明对话接续，不能代表全部业务查询成功；原失败保留。

## 重构后的现行结构

服务器由 `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle` 承担；Native由 `go/cmd/galaxy` 的native、integration-mcp、host、integration-host承接。Next官网与Admin/Payload分别运行，共用浏览器运行机制。

`packages/galaxy-contracts` 维护共同合同，`packages/galaxy-client` 维护浏览器／Node SDK，`go/internal/databaseschema/sql` 是132份迁移与四角色SQL的唯一现行来源，保留最高133与120空号。旧Core、Node CLI、Edge及Official业务树已移出整个项目，当前源码不保留替代内核或转发壳。

源码主库为公开的 `agigalaxy-team/agigalaxy`；银河自有代码Apache-2.0，第三方保留原许可。原公开仓库已整合并删除远端，原始Git历史及替代源码归档在项目外 `source-reviews/retired/`。现行产品、架构、开发、运维和公开说明集中在docs/；原始资料在originals/。

## 已有结果与实际边界

- Native原身份恢复码包含同GUID恢复、新设备／下一代码、本人临时本机页及原操作回执，空身份入口不强制创建新GUID。最终Windows候选包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；实际用户宿主安装仍未验收。
- 保留Next/React、Payload、Keycloak、Prosody、Agno/AgentOS、LiteLLM、搜索、推荐和分析组件及必要平台helper。没有恢复广泛模型测试、压测、模拟活跃或资料填充。
- macOS、全部第三方宿主及用户真实本机安装、PostgreSQL／Prosody／对象存储联合整站恢复未完成平台验收。R13仍限已接通且获准动作，不表示开放任意全领域自动操作。

现行机制见[架构](docs/technical/architecture.md)、[AI运行](docs/technical/agent-runtime.md)、[部署](docs/operations/deployment.md)。本轮唯一操作日志位于项目外 `ops-log/operations/2026/10/2026-10-29-galaxy-reconstruction.jsonl`，部署与独立无头证据位于 `work/galaxy-reconstruction-implementation-20261029/`。不将旧版本运行记录混作本轮结果。
