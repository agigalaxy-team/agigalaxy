# 当前工作

## 当前任务与状态

2026-10-29：工作台独立读取、SDK重试身份与临时故障接续已上线；继续完成实际摘要超时的底层修复，不恢复广泛测试。

- 当前线上：Go/Admin/AgentOS源码为`58163e8`，官网为`8e919ac`；最新GitHub `96b1dd2`仅修正AgentOS旧测试夹具，相关CI全过。原模型、权限和配置保留，无数据库迁移。
- 已实测：历史与卡片独立呈现；发送立即清空编辑框；原回复和草稿保留；普通问候及真实注册/反馈查询成功。一次实际原失败接续1 POST、未重复用户消息，父run完整内容哈希不变；新run完成不等于其中业务读取成功。
- 未闭合：原失败接续中的工作台摘要仍约12.4秒后取消；新增只读摘要也超时。145次数据库采样未见blocking，主要停在AI权限行查询后的客户端处理。已定位固定动作目录按每条权限重复全量JSON解码：单次CPU投影基准543.6ms/77.1MB，改静态索引后18.1μs/6.4KB；实际授权不缓存。正在整合纯读投影、目录无更新锁及最终权限复核后，集中检查、上传CI和部署实测。
- 当前AI角色/提示词维护权限及委派确实未授，未扩大；日常策略已有配置/发布能力。完整公开统计最近14.8秒；延后该统计的页面摘要约2.3秒，不能将这两个范围混报。
- 原已知SDK污染父74仅恢复可证的原操作/错误状态和错误重试父字段，保护前像保留，其余无证metadata未猜填。未知写入沿原operation查询，不重发。

## 重构后的现行结构

服务器由 `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle` 承担；Native由 `go/cmd/galaxy` 的native、integration-mcp、host、integration-host承接。Next官网与Admin/Payload分别运行，共用浏览器运行机制。

`packages/galaxy-contracts` 维护共同合同，`packages/galaxy-client` 维护浏览器／Node SDK，`go/internal/databaseschema/sql` 是132份迁移与四角色SQL的唯一现行来源，保留最高133与120空号。旧Core、Node CLI、Edge及Official业务树已移出整个项目，当前源码不保留替代内核或转发壳。

源码主库为公开的 `agigalaxy-team/agigalaxy`；银河自有代码Apache-2.0，第三方保留原许可。原公开仓库已整合并删除远端，原始Git历史及替代源码归档在项目外 `source-reviews/retired/`。现行产品、架构、开发、运维和公开说明集中在docs/；原始资料在originals/。

## 已有结果与实际边界

- Native原身份恢复码包含同GUID恢复、新设备／下一代码、本人临时本机页及原操作回执，空身份入口不强制创建新GUID。最终Windows候选包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；实际用户宿主安装仍未验收。
- 保留Next/React、Payload、Keycloak、Prosody、Agno/AgentOS、LiteLLM、搜索、推荐和分析组件及必要平台helper。没有恢复广泛模型测试、压测、模拟活跃或资料填充。
- macOS、全部第三方宿主及用户真实本机安装、PostgreSQL／Prosody／对象存储联合整站恢复未完成平台验收。R13仍限已接通且获准动作，不表示开放任意全领域自动操作。

现行机制见[架构](docs/technical/architecture.md)、[AI运行](docs/technical/agent-runtime.md)、[部署](docs/operations/deployment.md)。本轮唯一操作日志位于项目外 `ops-log/operations/2026/10/2026-10-29-galaxy-reconstruction.jsonl`，部署与独立无头证据位于 `work/galaxy-reconstruction-implementation-20261029/`。不将旧版本运行记录混作本轮结果。
