# 当前工作

## 当前任务与状态

2026-10-29：正在完成工作台总控读取机制重构与本轮发布。上一批快照保留、即时发送和独立资格续证已上线；本批把历史、当前沟通条件、操作卡、管理能力拆成独立资源，不再互相等待。源码整合与必要定向检查进行中，GitHub及服务器同步和真实AI接续验收尚未完成。

- 当前线上：Go发行`go-source-6ab0e40`；官网`source-6ab0e40`，后台`source-961a0e8`；AgentOS保持`galaxy-operations-agentos:source-6ab0e40`。原业务数据、身份、模型、环境和配置保留，未执行数据库迁移。
- 本批读取：四个独立GET分别呈现，history不依赖健康、卡片或管理能力；当前回复只沿原operation合并。精确轮次/卡片/工具事件更新对应资源，真实补发缺口才重取历史。临时503、续证、切回窗口不清已有显示；401/403执行失权，409退役旧会话且禁止迟到正文复活，独立卡片不连带清除。
- 本批成本：显式只读权限投影在同请求内复用，保留输出前实时围栏及全部写入检查；卡片一次批读、至多4并行，仅未决回执恢复原操作；相同结果不重写。历史统计投影批读比较，无变化不逐条重写已完成轮次。事件元数据批查真实UUID索引，不以全表JSON过滤替代。
- 已通过：Admin TypeScript；共同hook/精确路由/轮次/流8项；独立无头的四路慢源、503隔离、401清理、409与context-changed退役及新会话恢复；事件分发2项；Go只读权限和事件定向检查。当前只补查新Go读取与卡片批处理，以及发布后的真实模型发送与接续，不恢复压测、模拟活跃或资料填充。

## 重构后的现行结构

服务器由 `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle` 承担；Native由 `go/cmd/galaxy` 的native、integration-mcp、host、integration-host承接。Next官网与Admin/Payload分别运行，共用浏览器运行机制。

`packages/galaxy-contracts` 维护共同合同，`packages/galaxy-client` 维护浏览器／Node SDK，`go/internal/databaseschema/sql` 是132份迁移与四角色SQL的唯一现行来源，保留最高133与120空号。旧Core、Node CLI、Edge及Official业务树已移出整个项目，当前源码不保留替代内核或转发壳。

源码主库为公开的 `agigalaxy-team/agigalaxy`；银河自有代码Apache-2.0，第三方保留原许可。原公开仓库已整合并删除远端，原始Git历史及替代源码归档在项目外 `source-reviews/retired/`。现行产品、架构、开发、运维和公开说明集中在docs/；原始资料在originals/。

## 已有结果与实际边界

- Native原身份恢复码包含同GUID恢复、新设备／下一代码、本人临时本机页及原操作回执，空身份入口不强制创建新GUID。最终Windows候选包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；实际用户宿主安装仍未验收。
- 保留Next/React、Payload、Keycloak、Prosody、Agno/AgentOS、LiteLLM、搜索、推荐和分析组件及必要平台helper。没有恢复广泛模型测试、压测、模拟活跃或资料填充。
- macOS、全部第三方宿主及用户真实本机安装、PostgreSQL／Prosody／对象存储联合整站恢复未完成平台验收。R13仍限已接通且获准动作，不表示开放任意全领域自动操作。

现行机制见[架构](docs/technical/architecture.md)、[AI运行](docs/technical/agent-runtime.md)、[部署](docs/operations/deployment.md)。本轮唯一操作日志位于项目外 `ops-log/operations/2026/10/2026-10-29-galaxy-reconstruction.jsonl`，部署与独立无头证据位于 `work/galaxy-reconstruction-implementation-20261029/`。不将旧版本运行记录混作本轮结果。
