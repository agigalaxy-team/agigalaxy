# 当前工作

## 当前任务与状态

2026-10-29：工作台显示接续与实际业务查询已上线；当前继续收敛总控能力摘要的成本，不恢复广泛测试。

- 当前线上：Go/Admin/AgentOS为`0c99eac`，官网保持`8e919ac`；该批GitHub CI全过。数据、账号、模型和配置保留，未执行数据库迁移。
- 真实结果：问候17秒正常完成；账户与反馈查询在同一会话正常完成，得到注册3006、待处理反馈0，工具读取约1.5秒/3.1秒。发送即清空、无重复POST，旧历史保留。
- 尚未闭合：第三轮能力摘要在15秒请求期限内超时；其后模型服务还返回真实502，该原失败保留，不能将三轮合称通过。原操作已显示ERROR，先前只等待完成复制按钮的夹具误把该失败终态当成等待超时，后续改用原失败的实际重试路径检查。
- 当前改动：管理能力的query/prepare只读投影去重；卡片末尾只读资格计算合并；处理记录、业务概览、管理能力并行获取；自动运行候选任务来源批量预取，逐对象授权及统计范围保留。新增摘要并行、管理能力投影、来源批量等价及原回执撤权PG回归全部通过；最终上传/CI/部署和未通过路径的真实接续待完成。

## 重构后的现行结构

服务器由 `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle` 承担；Native由 `go/cmd/galaxy` 的native、integration-mcp、host、integration-host承接。Next官网与Admin/Payload分别运行，共用浏览器运行机制。

`packages/galaxy-contracts` 维护共同合同，`packages/galaxy-client` 维护浏览器／Node SDK，`go/internal/databaseschema/sql` 是132份迁移与四角色SQL的唯一现行来源，保留最高133与120空号。旧Core、Node CLI、Edge及Official业务树已移出整个项目，当前源码不保留替代内核或转发壳。

源码主库为公开的 `agigalaxy-team/agigalaxy`；银河自有代码Apache-2.0，第三方保留原许可。原公开仓库已整合并删除远端，原始Git历史及替代源码归档在项目外 `source-reviews/retired/`。现行产品、架构、开发、运维和公开说明集中在docs/；原始资料在originals/。

## 已有结果与实际边界

- Native原身份恢复码包含同GUID恢复、新设备／下一代码、本人临时本机页及原操作回执，空身份入口不强制创建新GUID。最终Windows候选包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；实际用户宿主安装仍未验收。
- 保留Next/React、Payload、Keycloak、Prosody、Agno/AgentOS、LiteLLM、搜索、推荐和分析组件及必要平台helper。没有恢复广泛模型测试、压测、模拟活跃或资料填充。
- macOS、全部第三方宿主及用户真实本机安装、PostgreSQL／Prosody／对象存储联合整站恢复未完成平台验收。R13仍限已接通且获准动作，不表示开放任意全领域自动操作。

现行机制见[架构](docs/technical/architecture.md)、[AI运行](docs/technical/agent-runtime.md)、[部署](docs/operations/deployment.md)。本轮唯一操作日志位于项目外 `ops-log/operations/2026/10/2026-10-29-galaxy-reconstruction.jsonl`，部署与独立无头证据位于 `work/galaxy-reconstruction-implementation-20261029/`。不将旧版本运行记录混作本轮结果。
