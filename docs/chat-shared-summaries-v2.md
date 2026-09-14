# 房间共享摘要与关键消息 v2

当前为 CUR-35 下 M12 独立切片，关联 NEW-M12-FLOW / NEW-M12-ACCEPT。来源是 CUR-30—32、卷09.13—14、DISC-Q-ROOM-SUMMARY-MAINTENANCE、ROOT-Q-NEW-DATA-TTL、PRE-M12-IF03。共享版本由本人选择内容后形成，个人编辑和私有云同步均不自动发布。普通房间不要求 Task，无模型时可手工选择关键消息或整理本人笔记。

## 实际接口

`ChatSharedSummaryService({db,access,chat,now})` 复用 binding 当前授权和 ChatService 现行成员/AI父区权限。POST `/v2/chat/shared-summaries/publish|get|list|retract` 已由主代理统一装配；输入严格，不接受外部指定 actor。

publish 输入：`shareId`、`roomId`、`expectedMemberRevision`、`audience:room-authorized-members`、`content`，以及可选 `supersedesShareId`、`agentGrantId`。content沿用个人摘要的生成者、覆盖范围、片段与精确版本消息引用结构，但仅包含明确选定内容，不是自动读取私有云记录。MCP发布强制给出当前 respond Agent grant。网页本人动作可不带 Agent grant。

同一房间当前获准成员为初版受众，后续成员须通过已有共同邀请再读取房间允许的历史。不支持直接将主区/子区或不同房间消息相互转发；跨范围公开和长期事实授权属于其他独立流程。当前读取不构成 Capsule 再发布许可。

发布先持久化 `room_shared_summaries` 的稳定分享意图、选择结果和来源事实，再使用同一个 shareId 作为 Chat clientMessageId，发送仅含共享ID的普通 MAM 消息。发生未知回执时 get 对账；publish 同ID同内容恢复，不新造消息ID。消息历史增加 `sharedSummaryId`，界面通过共享接口取得正文。引用消息不复制摘要文本，因此源失效不会在MAM留下等价摘要副本。

publish/get结果含 shareId/roomId/authorId/state/messageId、独立更正关联、createdAt/expiresAt、content/sourceFacts、sourceInvalidated/sourcesTemporarilyUnavailable。`publicationPermission:false`、`acceptedByRoom`不等于他人已读。list 按稳定UUID分页，空页有 nextAfter 时继续；完整历史继续独立可达。修改已分享内容需明确发布新版本，可用 supersedesShareId关联本人同房间旧版，不暗改旧版。引用消息不能用普通 edit 绕过这一要求。本人可撤回共享对象，其个人摘要不随之删除。

## 来源、期限及生命周期

发布核对每条源消息的实际MAM版本，记录作者、版本、正文哈希和来源期限；不复制原消息全文。读取重查当前房间权限、消息版本、撤回、到期、待定编辑及作者删除状态。正式撤回/旧版本/到期导致受管片段清除；待定删除/待定编辑只隐藏，取消后仍可恢复原授权投影。后台维护也遵守这个区别，不能将申请状态当成已执行删除。

共享对象默认90天，继承发布时房间7/30/90规则；消息实际期限更短时取更短值，不延长已发版本。源片段先于整个摘要到期时先移除相应片段和重点，独立本人笔记保留到共享对象自身期限。没有成员的房间仍通过内部来源元数据清理，不能借无人读取永久保留副本。

M19/服务维护内部接口：

- `purgeExpired({limit=100})`：有限批次清理共享到期正文及sourceFacts，消息删除仍交Chat。
- `purgeInvalidSources({after:null,limit:20})`：分页清除永久失效派生片段，返回checked/changed/nextAfter；不调用模型或共享新版本。
- `eraseSubjectWithin(db,subjectId)`：本人共享正文/sourceFacts撤回，保留最小回执；普通引用消息由chat.eraseSubject执行并报告外部删除结果。
- `exportOwnedWithin(db,actor,{after,limit})`：仅本人分享；正文仍需当前房间/源访问，退出后仅返回定位及不可读原因。不能raw导出他人房间资料或用本人发布者身份绕过源授权。

全服务硬删除和保留回执的策略由M19负责；本切片不物理删除subject、源消息或整个房间。资源预算计content/sourceFacts实际JSON字节+每行2048元数据，51的消息正文/元数据另计；超额在任何外发之前拒绝，后续ack不会产生新增正文预算。

## 客户端与MCP

`createChatSharedSummaryClient({call})`复用已认证API传输。`prepareRoomSummaryShare({local,summaryId,expectedLocalRevision,fragmentIds,keyMessageRefs,room,shareId?,supersedesShareId?})`只准备明确选定的独立请求，未选私密片段不进入载荷；不调用publish、不改变本地私有版本。expectedLocalRevision必须匹配本人刚审阅的版本，不能在另一标签改写后仅沿相同片段ID发送新文字。界面必须显示真实内容、房间受众和有效期后提交，并保存稳定请求用于未知结果恢复。

`summaryToolDefinitions(services,actor)`提供个人云摘要7工具、房间共享4工具和通知3工具，由主代理统一组合到现有Personal MCP。个人云默认不启用，不提供模型生成器；站内通知查询不标记人类已读，也不假报系统送达。实际OAuth和宿主接入另沿现有验证，不以工具定义存在冒充安装成功。

## AI Agent部署与验证

追加 migration56（chatSharedSummariesMigrationSql），新表API只需SELECT/INSERT/UPDATE，无DELETE。装配services.sharedSummaries、4条HTTP入口和MCP定义；前端读取history.sharedSummaryId而非解析用户文本冒充系统对象。部署沿主代理已有Prosody13.0.6组件，此切片不修改Lua或引入第二消息服务器。后台同一组件连接顺序维护，分页运行且避免重叠，不恢复备份。

本切片本地服务/选择测试2/2及实际PostgreSQL18.6 galaxy_api 1/1通过，隔离集群removed:true。覆盖同ID未知消息恢复、并发同意图、独立版本、同房间边界、共同邀请后的历史、成员变更拒绝、临时限制取消恢复、源撤回清理、本人撤回、7/90天期限、预算外发前拒绝。测试传输为明确替身；主代理随后取得现有真实Prosody核心测试证据，来源分开记录，不扩写为本切片全部真实宿主体验。

随后真实HTTP客户端+实际MCP SDK的组合测试1/1通过：默认关闭、工具列举、精确来源、伪造actor拒绝、Agent缺grant拒绝及respond消息标记、通知查询不标人类已读。该测试使用已有真实绑定夹具固定actor，不冒充额外OAuth登录验收。前端配合取消原分享时，服务端404仅停止本机重试，保留shareId并返回serverRetractionConfirmed:false；已在途发布仍可能晚到，需要继续对账。只有实际撤回回执才称服务端撤回。
