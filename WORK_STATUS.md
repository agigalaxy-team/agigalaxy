# 当前工作

## 当前任务与状态

2026-10-29 本轮进行中：按用户要求推进总控权限、角色／岗位提示词、策略全生命周期、自动值守和真实多轮操作；各线实现完成后统一冻结、检查、推送和部署，再以独立无头 Chromium 验证真实回执、暂停接续与结束判断。模型配置保持人工管理。

总控高级业务权限已通过正式接口新增 AI 专用角色并分配，四个其他岗位委派 v5 已启用；角色含 8 项管理／读取权限，委派含 7 个管理动作和 68 项可授业务权限。原角色保留，自动任务与策略授权另行核实。独立无头检查当前沟通历史、上下文、能力和卡片均返回 200；当前渲染无历史轮次，输入后可发送，尚未进行本轮模型请求。

本轮真实治理岗位提示词多轮：模型读取委派与原正文，生成操作卡；确认后 v4，再以新卡恢复精确原空正文至 v5。两个原操作回执 completed，最终回读 revision/promptVersion 5、正文为空；不以配置版本推断新任务已采用。追问回答在恢复卡仍待确认时提前称已恢复，后文虽提示需确认，表述矛盾，待修复及复测。

总控值守已启用，基线 task `91ef2518-99b9-43f3-80bb-a2be9b720daf` 原失败为 `operations_agentos_not_configured`、unknown；精确 native GET 为 NOT_RECORDED，未重投。Worker 已通过 systemd credential 获得只读 AgentOS 配置并重启、实际 UID 可读；原任务经正式 reconcile 在同 task 下恢复，native run `24579867-ccc0-4619-8803-3d459c7f5250` 到 completed（6 次真实模型调用）；但 jobs/list 两次及 messaging/history 一次非法查询后无成功，assessment 仍声称全部核实，存在明确覆盖缺口，须修复并复测。

真实策略草稿准备两轮均未生成卡，模型工具参数类型校验失败；拟议配置已通过共享 schema，原策略仍暂停、无草稿、未改写。后续需部署工具参数反馈修复后再测。自然定时 task `f19873b2-468a-4257-bd95-cf5e517cdd34` 失败，native 5 次调用、最后一次网关报告上游 HTTP 500；保留原任务，不自动重投。两个受控对象与选定授权已建并记账，验收后须恢复原状态及停用临时授权。

首批 `f65434e` 已通过 CI `40838654493`、`40838654443` 并部署 Go、Admin、AgentOS；官网保持 `8e919ac`。业务迁移 133→134，仅额外授予 Worker 角色对原操作命令表 SELECT。部署及无头结果均记入同一 canonical 操作日志。

上轮工作台通信、独立读取、原失败接续与能力反馈已上线；以下记录可复用的已验证结果。本轮增加高级能力真实模型验收，不进行无关用户填充或压测。

- 上轮线上基线：Go为`07f0ebf`，AgentOS为`72c9a13`，Admin为`58163e8`，官网为`8e919ac`。Go批CI `40831948219`/`40831948280`通过；AgentOS最新CI `40835148556`/`40835148566`通过。本批后续仅更新AgentOS镜像，11份运行文件与容器配置保持，无数据库迁移，模型和角色未调整。
- 最新真实无头流程：问候约5.3秒正常回答；摘要约7.2秒完成回答，实际workbench-summary账本completed、44.9ms（旧版同类调用14.19秒取消）。两轮各1 POST、编辑框立即清空、已完成消息节点与document均保留、无notice/pageerror。两项页面摘要均200：延后公开统计587ms，完整公开统计12.6秒；二者不混报。
- 底层已修：固定动作目录不再按每条权限重复全量JSON解码；CPU投影基准543.6ms/77.1MB降至18.1μs/6.4KB，只索引代码定义，实际授权仍实时读取。纯读工具采用单次同事务身份投影，独立首尾权限/来源复核保留；角色目录不持更新锁，准备和写入保留原围栏。隔离PG定向检查通过，覆盖末尾撤权、来源失效、固定AI、错owner和原写入边界。
- 前批实测已保留：历史与卡片独立呈现、注册/反馈真实查询成功；原失败接续1 POST、未重复用户消息，父run完整内容哈希不变。SDK先建立独立重试run再后台接续；原已知父74仅恢复可证字段，保护前像保留，不猜填其它metadata。未知写入沿原operation核对，不重发。
- 能力解释：实测发现原机器授权字段被模型误读为“功能未接通”，并复述历史时间。普通/值守摘要已共用单一模型业务事实视图，依据本轮功能、权限、委派分别映射；后台接口和原回执不变。25项原入口/SDK/反馈检查及新增视图4项检查通过。72c9a13真实自然追问约8.3秒、1 POST、无notice/pageerror，正确回答“功能已接通；权限未分配，尚未委派；当前不可办理”，未附旧时间或内部码，未产生修改。
- 上轮实测时总控尚未获 AI 角色／岗位提示词维护授权；本轮已新增并回读授权，当前范围以上述委派 v5 为准，模型配置仍由人工管理。
- 剩余已知慢路径：完整公开内容统计仍逐对象执行许可、受众和治理判定，约12.6秒。已核查批量证据方案，但尚未改写其授权判定；简单预取permission只能少一次查询，不能冒充解决。它不阻塞本轮已接通的AI摘要、沟通历史或操作卡读取。此项保留为独立性能问题，不宣称全站读取已全部优化。

## 重构后的现行结构

服务器由 `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle` 承担；Native由 `go/cmd/galaxy` 的native、integration-mcp、host、integration-host承接。Next官网与Admin/Payload分别运行，共用浏览器运行机制。

`packages/galaxy-contracts` 维护共同合同，`packages/galaxy-client` 维护浏览器／Node SDK，`go/internal/databaseschema/sql` 是132份迁移与四角色SQL的唯一现行来源，保留最高133与120空号。旧Core、Node CLI、Edge及Official业务树已移出整个项目，当前源码不保留替代内核或转发壳。

源码主库为公开的 `agigalaxy-team/agigalaxy`；银河自有代码Apache-2.0，第三方保留原许可。原公开仓库已整合并删除远端，原始Git历史及替代源码归档在项目外 `source-reviews/retired/`。现行产品、架构、开发、运维和公开说明集中在docs/；原始资料在originals/。

## 已有结果与实际边界

- Native原身份恢复码包含同GUID恢复、新设备／下一代码、本人临时本机页及原操作回执，空身份入口不强制创建新GUID。最终Windows候选包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；实际用户宿主安装仍未验收。
- 保留Next/React、Payload、Keycloak、Prosody、Agno/AgentOS、LiteLLM、搜索、推荐和分析组件及必要平台helper。没有恢复广泛模型测试、压测、模拟活跃或资料填充。
- macOS、全部第三方宿主及用户真实本机安装、PostgreSQL／Prosody／对象存储联合整站恢复未完成平台验收。R13仍限已接通且获准动作，不表示开放任意全领域自动操作。

现行机制见[架构](docs/technical/architecture.md)、[AI运行](docs/technical/agent-runtime.md)、[部署](docs/operations/deployment.md)。本轮唯一操作日志位于项目外 `ops-log/operations/2026/10/2026-10-29-galaxy-reconstruction.jsonl`，部署与独立无头证据位于 `work/galaxy-reconstruction-implementation-20261029/`。不将旧版本运行记录混作本轮结果。
