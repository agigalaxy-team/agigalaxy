# 当前工作

## 当前任务与状态

2026-10-29 本轮进行中：按用户要求推进总控权限、角色／岗位提示词、策略全生命周期、自动值守和真实多轮操作；各线实现完成后统一冻结、检查、推送和部署，再以独立无头 Chromium 验证真实回执、暂停接续与结束判断。模型配置保持人工管理。

总控高级业务权限已通过正式接口新增 AI 专用角色并分配，四个其他岗位委派 v5 已启用；角色含 8 项管理／读取权限，委派含 7 个管理动作和 68 项可授业务权限。原角色保留，自动任务与策略授权另行核实。独立无头检查当前沟通历史、上下文、能力和卡片均返回 200；权限变更后的新会话可读取空历史并发送，后续已进行了真实模型多轮。

本轮真实治理岗位提示词多轮：模型读取委派与原正文，生成操作卡；确认后 v4，再以新卡恢复精确原空正文至 v5。两个原操作回执 completed，最终回读 revision/promptVersion 5、正文为空；不以配置版本推断新任务已采用。追问回答在恢复卡仍待确认时提前称已恢复，后文虽提示需确认，表述矛盾，待修复及复测。

总控值守曾启用，因真实巡检未收敛已正式暂停（配置 v3、nextDueAt=null）；基线 task `91ef2518-99b9-43f3-80bb-a2be9b720daf` 原失败为 `operations_agentos_not_configured`、unknown；精确 native GET 为 NOT_RECORDED，未重投。Worker 已通过 systemd credential 获得只读 AgentOS 配置并重启、实际 UID 可读；原任务经正式 reconcile 在同 task 下恢复，native run `24579867-ccc0-4619-8803-3d459c7f5250` 到 completed（6 次真实模型调用）；但 jobs/list 两次及 messaging/history 一次非法查询后无成功，assessment 仍声称全部核实，存在明确覆盖缺口，须修复并复测。

真实策略草稿准备两轮均未生成卡，模型工具参数类型校验失败；拟议配置已通过共享 schema，原策略仍暂停、无草稿、未改写。后续需部署工具参数反馈修复后再测。自然定时 task `f19873b2-468a-4257-bd95-cf5e517cdd34` 失败，native 5 次调用、最后一次网关报告上游 HTTP 500；保留原任务，不自动重投。两个受控对象与选定授权已建并记账，验收后须恢复原状态及停用临时授权。

第二批 `8179704` 已通过 CI `40843417830`、`40843417905` 并部署 Go、Admin、AgentOS；官网保持 `8e919ac`，未重复迁移。新巡检 task `c6fa2f32-7d04-45e5-9051-c425864bb026` 最终为 completion_incomplete：读失败和不完整分页未能被模型可靠解决，未错误宣称业务完成。策略草稿复测的原轮及一次正式接续均收到实际 token 后因流终态校验失败而终止，均未产生卡或业务写；具体终止原因待诊断，不能与另一次上游 HTTP 500 混同。

Gateway 诊断 `ca09091` 已通过 CI 并上线；新策略准备轮 `80b8c7fe-3456-48cb-9688-f44a67baef4f` 实际返回“请确认操作”，完整草稿卡 `83219989-caa7-4aa6-b7bc-3816eebaf29e` 与已批准候选一致。但人工确认原操作 `aa0924ac-fbf7-4500-bae7-d3f309f9d1c7` 返回 `not-available / business_admin_denied`；当前策略 revision 9、paused=true，未称草稿已保存。确认阶段授权链正在按原回执检查，不重发。第三批 `dce3879` Go 与 AgentOS 已激活，Admin 与官网保持；周期仍停，两个手动只读任务待验。原 CI 仅 Admin 租约时钟测试失败，修复 `d9c6228` 本地单项通过并已推送，CI 两项均通过。

第三批真实小目标 `7c1d0b9d-9c06-4b36-afb9-9e5af263d03a` 已按原工具账本精确读取受控反馈，随后 assessment 目标达成、无剩余，与独立读取的 pending/revision 1/suggestion/other/note 空一致；无业务写，native 三次模型调用、20084 tokens，任务 completed。临时配置已恢复 disabled v5。五域有界巡检任务 `760842a7-a155-424d-bfe0-f38b3ad58afe` 自然终态为 failed / completion_incomplete；32次模型调用、1641520 tokens，原账本显示首个聚合部分覆盖、消息计划修参后成功、多次评估 stale/superseded及未解决的拒权。未发 stop，已恢复 disabled v8；原账本已交设计线分析，不判验收通过。

`3cf6f20` Go/Admin/AgentOS 已上线、CI 两项通过，数据库迁移至 135；原幽灵任务 `80b8c7fe` 现投影 failed（原卡仍 not-available），历史不改。新策略准备轮 `ed08b655` 原 native `e2b1979f` 因 model-request 502 终止、1 次模型调用、无卡，策略 revision 9/paused/draft=null；同时间 Gateway 一条 overview 流报告 invalid-stream-event，精确 callId 关联尚待核。策略确认真实闭环尚未通过。

消息岗位真实只读轮 `97acc926` 的 workbench-summary 原工具 completed，native 两次模型调用；本次历史拒权未复现，不推断历史原因。角色创建轮 `103772e8` 在参数校验 extra_forbidden 后未出卡，原生事件不保存非法字段名，未写角色；待 nested schema 反馈修复后再验。策略失败追问 `db9048a5` 如实说明模型请求失败、具体原因未明，无新卡；原工具账本待核。

搜索真实链已按原回执闭合：草稿保存/应用及 native 采用均核实；恢复原active业务成功后卡曾unknown，89上线后沿原卡/原operation GET恢复completed，无重投。原v6草稿内容由新卡保存为新draft `1452b042-1881-464d-9090-4ab3ca53b501`，独立回读 draft内容、active及native均与原前像一致；版本ID改变、历史保留。恢复轮多余apply卡已取消未执行，多制卡问题仍待真实复测。

`64f5adf` Go/Admin/AgentOS 与源码等价的 `3866fc4` Gateway 已分别通过相应 CI 并上线；数据库已至137，受保护配置与官网保持。profile巡检、角色 nested 反馈、Gateway原run关联及清理/标签完整卡须以下一轮真实路径验收。

新版本角色创建轮 `223fbcaf` 未出卡，模型把旧搜索目标带入并两次准备已变更的搜索草稿；治理账户/角色无写。Go命令摘要、原native RunInput及唯一持久user均与本轮角色意图相符，但provider完整历史未持久，无法据此断定消息顺序；正在定位跨轮语义问题。

显式profile巡检 `a0714e3a` 自然 failed/completion_incomplete，原inspect记载 autonomy source-withheld、workbench not-authorized、maintenance partial，其他五段完整；19次模型调用、876032 tokens，无业务写/无stop。总控配置已恢复 disabled v10，具体来源缺口交设计线继续处理。

`595cd2a` Go-only 修复已上线；显式profile新任务 `ca2632d9` 原inspect八段完整、后续delegation读取与最新assessment有效，task/model completed、business not-started，native 4次调用/68003 tokens。读取与结束链通过，但模型最终摘要误称全平台，未说明 River 范围、维护异常和有界样本，汇报准确性未通过；原任务终态不改。

聊天记录审查（五岗位现可读历史）：治理轮 `9a95f54f-67a8-42ee-abe2-3e2c8751d3b5` 与消息轮 `25936a95-11ff-4f75-a669-19e31190118c` 的普通问候回答暴露内部授权错误码；后续同岗位问候可正常回答，需核历史来源与当前修复覆盖。总控追问轮 `15718d5d-7ac9-4ef7-9b7b-0bebbf20c313` 将前次失败解释为权限或对象不可用，而相邻三轮原生记录为模型请求 502；指代与当时授权仍在核对，不先断言错拒权。已知提示词 prepared 被说成已恢复、策略类型校验和流终态失败保留上文记录。

独立值守角色任务 `e76fcba3-918c-45d5-aa5c-cbda4884012a` 自然 completed，原工具账本按顺序记录创建角色、分配、读取、撤回同一分配、停用角色、再次读取和最新 assessment；四条原业务回执已独立核对，新增角色和分配均 v1 启用、v2 停用；治理岗位最终有效权限与前像相等且旧分配不变，中间 read-ai-delegation 的结果未持久，无法证明曾实际读到 effective=true；分配启用事件不能代替该证据。native 实际 13 次模型调用、448883 tokens，约 89 秒。临时配置已恢复 disabled v14。此结果不代替普通会话角色卡验收；后者 `04619614` 再次混入旧搜索目标且无角色卡，当前输入次序已核，历史投影修复待发布复测。

`3e29352` 会话历史投影与 138 工具修复已提交，Runner CI 通过但 AgentOS CI 的原生 HTTP retry 断言失败：原问题作为 user 的次数为 0，正在核续接语义；该提交未部署。

`8521c6c` 测试修复及 138 实际上线：两项 CI 成功；Go 实际使用 ee8 源 manifest、AgentOS 实际使用与 8521 运行源码相同的 3e 镜像，138 原账本迁移完成、保护配置保持。原会话历史投影与角色卡仍待真实复测。

原会话角色轮 `b0dddf11` 经历史投影后仅生成正确角色创建卡并完成；新角色 `06cf9484` 已分配，治理岗位 `analytics.read` 从无到有且来源指向该角色，并真实调用 analytics/overview 成功。原分配与新角色均 v2 disabled，最终有效权限和旧分配与前像相同，独立观察无→有→无并核四笔原回执；治理答复将 2026-10-25 误写为周六（实际周日），日期准确性未通过；当前滑动7天的数字一致仅作旁证，不是同窗原结果，时区转换疑似问题尚未证明。139 事实报告与最终分析接线已本地实现，待统一发行及真实验收。

`ec475a9` 的 Go、Admin、AgentOS 已通过 CI 并激活，139 迁移已记账，保护配置保持；旧意图 profile d009a700 已完成，Task GET 八段完整、finalAnalysis available，AiRuns 与绑定工作台两处均展示事实、分析和评估；但 AI 正文仍称全平台队列，同轮事实明确并非全平台，汇报准确性未通过。配置已恢复 disabled v16。站内消息草稿轮 `08ad1f68` 在两次读后发生 Gateway error frame 拒绝，原轮无卡无写；原失败保留，待定方案继续。

`1ea1914` Go 日期上下文修复已上线。新目标 PROFILE-RIVER-REPORT-01 任务 `50219151` 自然完成，读取/结束与分析交付通过，River 范围表述正确；AI 把包含零结果的 resultKnownSearches 误称有结果搜索，指标解释仍未全通过。临时配置已恢复 disabled v18，原任务与输出保留。

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

`packages/galaxy-contracts` 维护共同合同，`packages/galaxy-client` 维护浏览器／Node SDK，`go/internal/databaseschema/sql` 是迁移与四角色SQL的唯一现行来源，线上最高137并保留120空号。旧Core、Node CLI、Edge及Official业务树已移出整个项目，当前源码不保留替代内核或转发壳。

源码主库为公开的 `agigalaxy-team/agigalaxy`；银河自有代码Apache-2.0，第三方保留原许可。原公开仓库已整合并删除远端，原始Git历史及替代源码归档在项目外 `source-reviews/retired/`。现行产品、架构、开发、运维和公开说明集中在docs/；原始资料在originals/。

## 已有结果与实际边界

- Native原身份恢复码包含同GUID恢复、新设备／下一代码、本人临时本机页及原操作回执，空身份入口不强制创建新GUID。最终Windows候选包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；实际用户宿主安装仍未验收。
- 保留Next/React、Payload、Keycloak、Prosody、Agno/AgentOS、LiteLLM、搜索、推荐和分析组件及必要平台helper。没有恢复广泛模型测试、压测、模拟活跃或资料填充。
- macOS、全部第三方宿主及用户真实本机安装、PostgreSQL／Prosody／对象存储联合整站恢复未完成平台验收。R13仍限已接通且获准动作，不表示开放任意全领域自动操作。

现行机制见[架构](docs/technical/architecture.md)、[AI运行](docs/technical/agent-runtime.md)、[部署](docs/operations/deployment.md)。本轮唯一操作日志位于项目外 `ops-log/operations/2026/10/2026-10-29-galaxy-reconstruction.jsonl`，部署与独立无头证据位于 `work/galaxy-reconstruction-implementation-20261029/`。不将旧版本运行记录混作本轮结果。
