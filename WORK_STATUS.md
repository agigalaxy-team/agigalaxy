# 当前工作

## 当前任务与状态

2026-10-29：总控四路独立读取已在`8e919ac`上线，GitHub该批CI全过。真实总控回复只提交一次、历史只读一次，6条原历史、输入框和后续草稿保留；线上分别延迟卡片/历史，另一模块先显示。随后用户问候暴露实际摘要503与AI业务身份接线错误，正在将修复、精简反馈及真实业务取数接续一起收尾。

- 当前线上：Go发行`go-source-8e919ac`；官网/后台`source-8e919ac`；AgentOS暂保持`galaxy-operations-agentos:source-6ab0e40`。`0e01a27`的健康空原因修正已上传，尚待并入本批最终后台运行包。原数据、账号、模型及配置保留，没有执行数据库迁移。
- 已完成结构：history/cards/context/management独立读取呈现；精确轮次事件只更新原operation，真实缺口才取历史。卡片批读4并行、同请求权限投影复用，原输出实时围栏保留；相同回执和已完成统计投影不反复重写。普通续读/故障/切回窗口保留显示，明确失权和真实来源变化执行对应清理。
- 本批真实缺陷：生产未装配PriorAction，已有完成卡使整个摘要503；部分业务facade把stored AI上下文交浏览器cookie校验导致business_admin_denied。已补原回执摘要及共同query/prepare主体复核，不修改真实角色。stored prepare禁止直接写入，人工确认路径保持；内部错误码只留诊断，前端无关预读不抢发送按钮。
- 验证：此前读取与事件定向、线上真实接续与双向延迟通过；本批Admin TypeScript/5项界面定向、Python19项、真实PG的查询/准备身份及人工执行检查通过。摘要新增回归、最终CI/部署及同会话问候→真实数据→能力查询仍待完成。前轮“回复完成”只证明对话接续，不代表全部业务取数成功，原失败保留。

## 重构后的现行结构

服务器由 `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle` 承担；Native由 `go/cmd/galaxy` 的native、integration-mcp、host、integration-host承接。Next官网与Admin/Payload分别运行，共用浏览器运行机制。

`packages/galaxy-contracts` 维护共同合同，`packages/galaxy-client` 维护浏览器／Node SDK，`go/internal/databaseschema/sql` 是132份迁移与四角色SQL的唯一现行来源，保留最高133与120空号。旧Core、Node CLI、Edge及Official业务树已移出整个项目，当前源码不保留替代内核或转发壳。

源码主库为公开的 `agigalaxy-team/agigalaxy`；银河自有代码Apache-2.0，第三方保留原许可。原公开仓库已整合并删除远端，原始Git历史及替代源码归档在项目外 `source-reviews/retired/`。现行产品、架构、开发、运维和公开说明集中在docs/；原始资料在originals/。

## 已有结果与实际边界

- Native原身份恢复码包含同GUID恢复、新设备／下一代码、本人临时本机页及原操作回执，空身份入口不强制创建新GUID。最终Windows候选包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；实际用户宿主安装仍未验收。
- 保留Next/React、Payload、Keycloak、Prosody、Agno/AgentOS、LiteLLM、搜索、推荐和分析组件及必要平台helper。没有恢复广泛模型测试、压测、模拟活跃或资料填充。
- macOS、全部第三方宿主及用户真实本机安装、PostgreSQL／Prosody／对象存储联合整站恢复未完成平台验收。R13仍限已接通且获准动作，不表示开放任意全领域自动操作。

现行机制见[架构](docs/technical/architecture.md)、[AI运行](docs/technical/agent-runtime.md)、[部署](docs/operations/deployment.md)。本轮唯一操作日志位于项目外 `ops-log/operations/2026/10/2026-10-29-galaxy-reconstruction.jsonl`，部署与独立无头证据位于 `work/galaxy-reconstruction-implementation-20261029/`。不将旧版本运行记录混作本轮结果。
