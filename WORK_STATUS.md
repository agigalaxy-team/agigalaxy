# 当前工作

## 当前任务与状态

2026-10-29：工作台读取与SDK重试身份修复已上线；当前完成临时故障重试和ACK丢失恢复的最后一批，不恢复广泛测试。

- 当前线上：Go/AgentOS为`aa9dbc6`，Admin为`0c99eac`，官网为`8e919ac`；相关CI全过，模型、权限和配置保留，无数据库迁移。
- 真实沟通：问候、注册/反馈查询、总控能力与摘要均已完成；注册3006、待处理反馈0。新能力核对约44秒、1 POST、无notice。当前AI角色/提示词维护权限和委派确实未授，未擅自扩大；可维护日常策略。
- 真实源码缺陷已修：摘要缺回调、AI查询身份、重复授权与串行摘要、候选任务逐条来源往返；detached运行查不到终态、SDK后台重试污染父ID/metadata及工具上下文。独立新尝试与严格PK/父链读取已上线；生产已知父74仅恢复可证的原操作/错误状态并删除错误重试父字段，保护前像保留，其他无证metadata未猜填。
- 首页默认摘要503已修（reply遗漏父postId）；实际默认读200，完整公开统计仍约17秒，延后统计的其它摘要约2.3秒且不互相阻塞。本批继续合并官方发布资格的重复证据/账户查询，不改变资格含义。
- 最后一批：临时授权服务不可用在当前资格已恢复、确定无业务效果时允许显式人工重试，提示“连接中断”；ACK丢失时按原owner/session/agent/operation精确SQL定位，不扫历史或重发。补充旧失败事件隔离及简短业务表达。此前UI/Go/SDK定向通过，新增ACK相关Go/SDK检查也通过；公开统计窄优化PG检查、最终上传CI/部署及真实原失败接续待完成。

## 重构后的现行结构

服务器由 `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle` 承担；Native由 `go/cmd/galaxy` 的native、integration-mcp、host、integration-host承接。Next官网与Admin/Payload分别运行，共用浏览器运行机制。

`packages/galaxy-contracts` 维护共同合同，`packages/galaxy-client` 维护浏览器／Node SDK，`go/internal/databaseschema/sql` 是132份迁移与四角色SQL的唯一现行来源，保留最高133与120空号。旧Core、Node CLI、Edge及Official业务树已移出整个项目，当前源码不保留替代内核或转发壳。

源码主库为公开的 `agigalaxy-team/agigalaxy`；银河自有代码Apache-2.0，第三方保留原许可。原公开仓库已整合并删除远端，原始Git历史及替代源码归档在项目外 `source-reviews/retired/`。现行产品、架构、开发、运维和公开说明集中在docs/；原始资料在originals/。

## 已有结果与实际边界

- Native原身份恢复码包含同GUID恢复、新设备／下一代码、本人临时本机页及原操作回执，空身份入口不强制创建新GUID。最终Windows候选包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；实际用户宿主安装仍未验收。
- 保留Next/React、Payload、Keycloak、Prosody、Agno/AgentOS、LiteLLM、搜索、推荐和分析组件及必要平台helper。没有恢复广泛模型测试、压测、模拟活跃或资料填充。
- macOS、全部第三方宿主及用户真实本机安装、PostgreSQL／Prosody／对象存储联合整站恢复未完成平台验收。R13仍限已接通且获准动作，不表示开放任意全领域自动操作。

现行机制见[架构](docs/technical/architecture.md)、[AI运行](docs/technical/agent-runtime.md)、[部署](docs/operations/deployment.md)。本轮唯一操作日志位于项目外 `ops-log/operations/2026/10/2026-10-29-galaxy-reconstruction.jsonl`，部署与独立无头证据位于 `work/galaxy-reconstruction-implementation-20261029/`。不将旧版本运行记录混作本轮结果。
