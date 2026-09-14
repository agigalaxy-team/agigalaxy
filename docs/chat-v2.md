# 普通聊天核心 v2（M12 首批实现）

2026-09-13后续增量：schema65的临时文件上传、真实扫描、消息精确引用、下载ACL和独立30天保留见[私有临时聊天附件](chat-attachments-v2.md)。本页核心规则继续适用；附件不改变旧无附件消息hash和MAM正文职责。

2026-09-13。本文件描述已经写入的服务代码和仍需取得的证据。没有据此声明官网或公开聊天上线。

## 用户行为及来源

普通房间不需要 Task 或 Case。创建者也是普通成员；默认无房主，最初一人等待邀请不触发解散提示。现有独立控制方同意邀请后，被邀请者自己接受，才能读取房间仍获准保留的完整历史。网络断开不改变成员关系；曾有多方后明确退出到一方，才进入单人选择。成为房主不自动改变期限或设置长期存在。

依据是项目完整方案卷09、M12工作包 PRE-M12-01/IF01/IF02/A01—A04，以及用户原话记录 U02/U03/U05/U07、CUR-29—32。共同治理、邀请7天、编辑24小时和7/30/90天期限来自 CUR-33 授权代选，不能标成用户逐字原话。旧G0实验中的加入码、1天TTL、nightly98和单人立即提示均未恢复。

## 持久化与通信的边界

47迁移追加8张表：`chat_rooms`、`chat_memberships`、`chat_decisions`、`chat_message_refs`、`chat_message_operations`、`chat_cursors`、`chat_message_preferences`、`chat_agent_grants`。原迁移和旧数据不修改。

51迁移追加正文预算列 `chat_message_refs.content_bytes` 及编辑预留状态。发送先按正文UTF-8字节提交预留，再调用Prosody；增大编辑先保存原操作ID、目标字节数及完整回执元数据，同时预留增长。额度不足时不调用通信服务。外部结果未知时保留pending操作及占用，使用同一operationId与相同正文恢复；其他编辑须先解决该操作。数据库只保存字节数与摘要，不保存消息正文。历史仍有效但长度未知的引用保守预留64000字节，不能将旧正文算成零。

现有资源预算按正文预留加有界元数据计算；发送和编辑的后半段确认不会因新回执状态增加预算。缩小编辑在实际存档确认后释放差额；到期或撤回只关闭读取，正文预留须等 `purgeOne` 取得物理删除回执后归零，未知删除结果继续占用。编辑失败不会出现数据库回滚后Prosody已增大正文而没有预留的情况。

Galaxy PostgreSQL保存产品身份、权限、共同决定和消息元数据。每条发送先保存稳定ID，再交给Prosody；连接超时保留pending，原clientMessageId重试，不新建消息。已接受表示通信存档接受，不表示另一个人已读。保留期限在第一次发送意图建立时固定；修改房间政策只影响后续消息。

Prosody 13.0.6负责MUC广播及MAM存档。薄插件直接使用原生archive get/set/delete/append接口补齐稳定ID、覆盖旧编辑正文和固定期限；没有修改Prosody核心。内部传输为私有XEP-0114组件的Galaxy IQ命令。原始MAM IQ、公网c2s/s2s和房间管理IQ关闭，所有产品读取经过Galaxy当前权限；这不是任意XMPP客户端直连服务。API分页使用PG稳定sequence选取100条以内元数据，按实际可读集合向MAM取正文，空页仍可有next。

正文不写入Galaxy PostgreSQL、操作日志或通知快照。引用只记录消息ID，不缓存被引用正文。作者24小时内可修改；修改覆盖MAM正文且保留编辑标识，过期则要求追加纠正。撤回先提交不可读墓碑，再删MAM正文；失败返回purgePending，不能把API不可见当物理删除。Prosody保留最长90天的无正文防重放墓碑，超过消息可能有效的最长区间后清理。

这套服务端存档不是端到端加密。个人摘要、跨端摘要同步、附件及通知正文传播仍是后续明确工作；本切片不创建这些副本，不宣称已完成它们。

## 构造和接线

```js
const transport = new ProsodyChatTransport({ service, domain, roomsDomain, secret });
const chat = new ChatService({ db, access, transport, now,
  resolveControlParty: async (db, subjectId) => verifiedStableControlReference,
  validateTaskRef: async (db, actor, taskId) => checkCurrentTaskAccess(),
  requireAccountWithin: (db, actor) => communityAccounts.resolveWithin(db, actor),
  consumeInviteWithin, markInviteRespondedWithin });
```

`now`返回Unix秒。`resolveControlParty`仅可使用当前可信Account或明确委托关系；默认`subject:<GUID>`，不声称检测所有现实同控身份。控制关系变化时刷新成员版本，旧待决邀请不能沿用。不同设备和Agent不新增独立成员。

`validateTaskRef`非空任务引用必须提供；缺少时关联任务返回503，普通房间照常。主入口负责从真实访问令牌取得actor，不能直接把请求中的GUID作为actor。每个用户方法都重新进入AccessService `binding`授权事务；恢复后旧设备权限不能借缓存actor继续使用。

创建和接受加入前核对真实验证Account，缺少适配器明确503；拒绝邀请不强迫先完成外部账号验证。邀请新决议由`consumeInviteWithin(db,actor,{roomId,eventId,payloadHash,recipientId})`进入共享日额，接受或拒绝由`markInviteRespondedWithin(db,{roomId,recipientId})`关闭未回应状态。房间ID是明确roomId，不冒充Task ID。单元测试通过显式内部替身隔离房间规则，另以真实CommunityAccountRegistry验证未认证拒绝与伪造accountVerified无效。

| 方法 | 参数（actor之后） | 结果/约束 |
|---|---|---|
| create | `{roomId,operationId,title,kind?,parentRoomId?,taskRefs?,retentionDays?}` | stable操作，普通或独立ACL的AI子区 |
| get / list | `roomId` / `{after?,limit?}` | 实际成员、生命周期、transportAvailable；connectionCount未知为null |
| proposeDecision | `roomId,{decisionId,expectedRevision,action,targetSubjectId?,retentionDays?,persistent?}` | invite/remove/retention/become-owner/transfer-owner/persistent/dissolve |
| decisions | `roomId` | 最近100条决定；后续治理历史分页另补 |
| invitations | 无 | 本人可接受的当前有效邀请，不提前暴露房间历史 |
| voteDecision | `roomId,{decisionId,choice}` | approve/reject/cancel；沉默不等于同意 |
| acceptInvite | `roomId,{decisionId,accept?}` | 邀请/房主接任的目标方本人接受；可拒绝 |
| leave / dismissDecision | `roomId` | 明确退出/仅关闭本人单人提示，不改变Task参与 |
| send | `roomId,{clientMessageId,text,replyTo?,agentGrantId?}` | stable消息ID、archiveId、pending/accepted及固定期限 |
| messageStatus | `roomId,{clientMessageId}` | 只查本人发送，未知先对账 |
| history | `roomId,{after?,limit?,keyword?,author?,from?,to?,agentGrantId?}` | default50/max100；next/scannedThrough/complete |
| edit | `roomId,messageId,{operationId,expectedRevision,text}` | 作者24h窗口，重复操作回执 |
| retract | `roomId,messageId` | tombstone及archiveDeleted/purgePending |
| hide | `roomId,messageId,{hidden?}` | 仅本人可恢复的隐藏 |
| cursor | `roomId,{kind,sequence,agentGrantId?}` | 人类/Agent不同主键，跨设备单调合并 |
| grantAgent | `roomId,{grantId,bindingId,mode,primaryResponder?,expiresAt}` | 本人绑定的read/draft/respond，明确期限 |
| revokeAgent | `roomId,{grantId}` | 撤Galaxy权限；hostRuntimeStopped=false不冒充停止宿主 |
| exportOwned | `{after?,limit?}` | 当前本人认证，限本人仍保留原发正文及其元数据 |

其他已认证应用事务可以调用`readSelectedWithin(db,actor,{messageId,revision})`取得精确当前消息作者、版本、正文和SHA256；旧编辑版本/过期/撤回/源作者待删对非作者均不可用。返回`publicationPermission:false`，房间读取不是Capsule或其他公开再发布许可。

新AI子区有独立成员集合；访问还要求当前父房间成员，不因前端标签可见而自动授权。首次仅创建者加入，其他人走独立邀请。不承担展示内部思维链或启动云端模型。消息actorKind由使用的AgentGrant/普通调用区分，是访问渠道标识，不是声称识别文本到底由人还是模型写出。

所有敏感房规操作采用共同决定；当前没有管理员委任/撤任界面与完整管理员角色。房主离开后只读7天，现有成员可共同指定并接受新房主；没有接任由维护作业归档。不得把基础owner字段当成完整长期群管理交付。

## M19维护接口

以下方法只供已授权后台作业调用，不可注册用户HTTP路由。它们管理自己的数据库事务。

- `purgeExpired({limit=100})`：先将到期内容设为不可读，逐条删除外部正文；通信失败抛错留待重试。
- `eraseSubject(subjectId,{limit=100})`：退出本人房间关系、撤本人AgentGrant、将本人全部pending/accepted消息撤回并逐批删除。返回`pendingArchiveDeletes`、`complete`及删除计数；其他人的正文与独立Task数据不删除。`complete`只表示该调用的聊天正文清理范围，不代表全产品删除单完成。
- `purgeOne(messageId)`：只处理已登记purge_pending消息；供重试作业使用。

房间共同档案、无正文回执、退出关系和治理审计的最终到期清理继续接M19登记。不能只删除消息引用表后声称Prosody原文已删除，也不能因为共享一个房间而导出其他人的未授权数据。

## AI Agent部署说明

1. 使用官方稳定源包或经核对的13.0.6稳定构建；不要把`13.0`镜像标签当稳定证据。来源和下载摘要见项目`07-logs/development/chat-core.md`。
2. 应用47和51追加迁移及实际API权限；注册程序会依次应用其间其他模块的迁移。API需要8张表SELECT/INSERT/UPDATE和`chat_message_refs_sequence_seq` USAGE/SELECT，不需DELETE；维护作业角色另按M19授权。
3. `deploy/prosody/prosody.cfg.lua`和`mod_galaxy_rooms_v2.lua`按指定目录部署；组件密钥由运行环境的私有文件提供，不能放入仓库、配置示例或日志。组件仅loopback5347。容器场景应共享受控网络命名空间或明确受限映射，不能直接改成公网监听。
4. Prosody需要支持archive get/set/delete的驱动；当前配置使用internal。存储满拒绝新消息，不截断合法未过期历史。容量、磁盘故障和多实例是独立部署验收项。
5. API构造transport后启动组件；连接失败保留明确503。关闭时stop。公网仅通过既有HTTPS API提供产品能力，不额外开放XMPP端口。
6. 在隔离数据环境运行`test/chat-prosody.test.mjs`；必需`GALAXY_TEST_CHAT_ISOLATED=1`、`GALAXY_TEST_CHAT_SECRET_FILE`，可选loopback `GALAXY_TEST_CHAT_SERVICE`。这是合成通信测试，不是真实用户试点；临时数据由隔离环境生命周期清除。

## 验证范围

本地`chat.test.mjs`已3/3通过：实际身份签名和数据库治理流程、真实未认证Account拒绝、不同意邀请、双人不能单方踢人、独立成员、恢复重试、固定TTL、分别游标、修改及撤回故障、待删除投影隔离和取消恢复。通信使用显式契约替身，只验证服务协调，不计Prosody运行成功。

51迁移及实际 `resourceBudgetPolicy` 接入后，上述3项重新通过；新增断言覆盖发送及编辑增长超额时通信调用次数不增加、未知编辑保留预留并稳定恢复、撤回物理清除前仍占额度、清除后释放为零。该验证检查协调顺序，不替代实际Prosody磁盘故障或容量验收。

实际PostgreSQL18.6 `galaxy_api`角色并发测试已1/1通过，同operation并发建房和同clientMessageId并发发送唯一，隔离集群清理回执`removed:true`。已提供真实Prosody存档/修改/重连/物理删除测试，由主代理在Linux隔离服务执行；未运行前不得改成已通过。完整网页、客户端通知、个人摘要、附件、全治理管理和用户实际体验仍不在这些测试的完成声明内。
