<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/3c/3cbe4059e4edc140e024ea7adce36d45d4b68839b8b0f6fd85e80ece9a157a2a.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Profile 自述与派生字段 v1

2026-09-10 初版，2026-09-11 补充项目介绍。C10-03 待复核。`profile_statements` 始于 Schema30；当前系统为 Schema41/44表，本次无新迁移。公开动态业务未发布。

## 数据和操作

自述使用独立字段 `selfDeclared`，接受可选 `displayName`（100字符）、`about`（2000字符）、`claimedCapabilities`（20项、每项100字符），以及 2026-09-11 新增的 `projects` 项目／模块介绍（见[发现功能](project-discovery-v1.md)）。未知字段被拒绝，不能写入 Honor、Proof、派生履历或 `capabilityVerified`。自报能力只是主体自己的文字，显示时必须标为“自述，未经认证”。没有自述、没有履历也可参与，不要求填写简历。

`POST /v1/profiles/statements` 接受 `{consentId,payloadJson}`。正文为 `{id,expectedRevision,selfDeclared}`；必须有当前 history 会话和针对准确正文的 `profile.publish` 签名 Consent。Consent 创建沿用已有 consent scope、宿主明确确认与本机签名流程。可见性只支持 Private（本人及准确接收人）和 Public（public-profile 用途），默认集成应选择 Private。

每次更新追加一条完整替换记录；`expectedRevision` 校验当前主体版本，跨绑定写入用事务锁串行化。相同 ID、授权与正文的重试返回原回执，不重复留痕；过期版本返回409。`selfDeclared:{}` 清空当前自述。旧版本只供本人导出追溯，不在公开读取时自动回退。

既有 `GET /v1/profiles/{GUID}` 和 `POST /v1/history/query`（显式 subjectId）返回当前可见自述及 `selfDeclaredSource`，其中有来源 ID、self-declared 分类和 false 的认证标记。本人另得到 `selfDeclaredRevision` 以便更新。非本人看不到隐藏版本数量，公开自述换成私有或撤销后不会重新显示旧公开文字。未指定主体的跨主体查询不混入任何人的自述。

Case/Attempt/Proof/Capsule/Assistance 仍从事实生成，自述不参与 Case 重建摘要、计功、Honor或履历排序。项目发现另以自报功能标签排序，仅表示功能相关程度，不产生能力评价。`derived:true` 指原履历投影；自述来源明确独立标识。已有响应字段继续兼容，新项目字段需要兼容本次schema的客户端。

## 客户端与宿主

已有 `@galaxy/client/history` 入口提供 `publishProfile({consentId,payloadJson})`，并导出 `profileStatementSchema`、`selfDeclaredProfileSchema`。读取仍用 `history.profile(subjectId)`。写入要求调用方已通过 ConsentClient 完成准确正文授权；此方法不会自行创建授权、签名或重试。取消或会话变化后丢弃迟到回执，不能据此声称远端写入已回滚。

原生入口已接通：`/galaxy → 接入银河 → 绑定、审计与数据管理 → 我的资料与自述`。当前会话需要 history；编辑另需 consent。自述与事实派生履历分区显示，空资料不生成默认认证，履历页仅列当前八条，完整查询保留原入口。只读会话可以看资料，旧服务缺少自述版本时不提供编辑。

编辑器提供名称、简介、自报能力、可见性、准确私有接收者、发布预览和清空草稿。每次开始编辑默认 Private/仅本人；这也适用于旧公开自述，发布预览会明确显示替换后的可见性。清空草稿不立即发送；用户仍需确认准确JSON、Consent和确认文本。公开切换清除私有接收者，修改接收者切回Private。

2026-09-11后续：编辑器新增“项目／模块介绍”入口，支持表单编辑、候选开关和移除草稿，发布仍使用同一个完整替换预览。详见[原生项目发现](project-discovery-native-v1.md)。

`createProfileFlow` 复用 ConsentClient 和现有 HistoryClient；读取当前本人版本，生成固定正文与一小时以内的授权预览。确认后本机宿主只为正在执行的准确 `profile.publish` 意图签名，不生成新身份、不提供通用签名入口。端点返回版本冲突时不自动重读并覆盖，用户应重新读取后编辑。取消后不自动重发；发送途中取消不能证明远端回滚。

主控制器排他管理预览和执行，退出会取消当前操作并丢弃迟到响应。菜单回调绑定当前页面代次，旧输入或旧确认不能改写新的草稿。真实本机密钥、服务签名校验、版本冲突、授权期间取消、只读空资料、分区展示与主菜单入口已有自动化证据；C10-03转待复核，实际OpenCode人工体验与真实用户验收保留。

## 数据生命周期和 AI Agent 部署

本人导出新增 `profile-statements`，包括本人原文、版本、授权引用与摘要；已撤销自述仍属于本人的历史副本。现有全量删除执行器包含新表，并依赖外键顺序删除后再移除 Consent/主体。没有额外文件存储或后台投影任务。

在隔离数据库执行 Schema30 迁移后重放 `src/infrastructure/api-role.sql`，API 对新表只有 SELECT/INSERT。Caddy 路由片段增加准确的 POST 路径；该片段生成不等于已发布路由。停服和事故入口继续按原通用业务写入规则拦截。客户端需更新到包含新 schema 的构建产物；旧服务不支持新自述操作或新导出数据集。

查询一条空 Profile，明确签署一条测试自述，再验证独立履历不变、私有替换、撤销和本人导出。应用回退需遵循数据库版本兼容规则；旧应用不保证能启动 Schema30，不能仅回退代码就宣称数据库兼容。需要恢复时使用已有备份恢复及删除重放流程，不自动删除新表。
