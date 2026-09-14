# 新增产品对象生命周期：M19 实施切片

日期：2026-09-13。本文件描述本地代码范围和可重现验收，不表示生产已部署。本次不恢复备份。当前源目录以迁移42—51为登记范围；未来新表必须登记后才能执行删除，未登记会明确停止该操作。

## 当前依据与用户行为

本轮依据 [M19 工作包](../../../../02-architecture/redesign-v1/predevelopment/work-packages/M19.md)、[卷12](../../../../02-architecture/redesign-v1/volumes/12-privacy-retention-governance.md)和[已确认保留政策](data-retention-policy-v0.1.md)。后者“三种操作”规定删除“立即隐藏”，普通主库目标7天；卷12.9规定“用户取消只影响尚可撤回的部分，已经物理删除的数据不能承诺恢复”。这些来源没有要求提交删除申请就不可逆地撤销全部 Consent。

实现因此把待删除状态作为**动态可见性**，不改原签名意图。ConsentReader 在同一读取事务中查询活跃删除申请，返回 `currentVisibility.deletionPending`；这一字段不是用户原始签名内容。非本人投影通过 `canReadProjection` 停止展示，本人仍可管理和导出。未执行申请取消后，动态限制解除，前提是原 Consent、绑定和其他限制仍有效。已明确撤销或自然到期的授权不会恢复。进入物理执行才撤销绑定、Consent和控制权限，此后不能承诺恢复。

Task列表、当前授权导出页、历史/证明读取通过原服务的当前权限判断；搜索候选查询另行排除待删除主体，索引新建也采用同一公开可见性判断。新聊天不使用 Consent，其作者状态门由M12消息读取实现，不能认为这个共同读取器自动覆盖独立消息存储。

## 表级职责、导出与删除

以下“长期”指对应关系或正式事实的存续期，仍支持主动删除，未实现账户闲置自动销毁。保留整个公开控制链是当前历史核验需求，不保留私钥或恢复秘密。清除后的哈希只证明记录关联，**无法重新核验已清除的原始正文**。

| 表 | 内容与本人导出 | 期限、删除及共享边界 |
|---|---|---|
| subject_control_heads | 当前控制链头、epoch、序号、事件hash | 不统一套短TTL；实际删除撤销控制，必要审计或独立事实依赖尚在时保留，避免丢链后回退Genesis控制 |
| subject_control_events | 公开签名事件、前序hash、接收时间 | 同上；保留完整公开核验链，源原文字节保持历史含义 |
| device_authorizations | 公开设备key、scope、epoch、状态、来源 | 删除先撤销；需核验历史时保留关联，依赖解除后按叶节点删除 |
| recovery_authorizations | 公开恢复key、代数、状态、来源 | 不存恢复码秘密；删除使当前恢复材料失效，历史按控制链处理 |
| identity_control_operations | 操作ID/hash、状态、期限、提交时间；不导出挑战/请求/认证回执正文 | 有效期届满即拒绝使用，过期24小时内由有界Worker清理；不销毁已提交的独立控制事件 |
| case_task_links | 本人建立的Task/Case ID、操作hash及关联回执 | 正式关联无自动短TTL；本人删除其关联，其他作者事件不连带删除 |
| cases、case_events | 本人容器与原始事实事件；跨作者Case经授权视图导出 | 沿用既有表。本人事件清理；被其他作者引用而暂留的容器把local_ref/source_ref替换为无原内容占位，稳定ID不变 |
| community_accounts | 本人已关联Account的有限服务信息 | 同Account关联多个GUID时不能因一个GUID删除全Account；无其他链接才进入该账号删除候选 |
| community_account_links | 当前GUID自己的关联 | 只删除本人关联，保留其他GUID的独立关联 |
| community_interactions | Account与实际接受的参与/交付事件关系；本人导出仅包含自己撰写源事件的部分 | 服务关系内保留，删除来源或对方主体后失效；不因最小关系仍在就承诺原互动可核验 |
| community_daily_usage | 同Account按日合计的公开动作次数，无正文 | 运行聚合保留30天，删除账号须先确认无其他GUID；近期期数不被某个GUID退出重置 |
| community_write_receipts | 本人公开动作的operation/hash及有限回执 | 作为已接收公开写安全记录，从接收事件起180天；不同于争议案件结案时钟。本人删除按已核准请求清理，业务事件自身仍负责稳定幂等 |
| task_requests | 本人Task的ID、关联与版本；不直接导出混合作者snapshot | 正式Task关系不因临时交流到期而删除；作者删除后快照变为无正文占位，其他作者事件保留 |
| task_participations | 本人参与的ID、关联、版本；snapshot只经当前授权读取 | 正式约定、实际交付、接受和退出不是短期消息；本人删除标记来源不可用，删除本人事件及其系统副本，保留独立作者内容 |
| task_events | 本人精确原始事件、hash、Consent关系 | 建立任务、约定、交付等正式事实长期；建议联系、邀请、回复、申请、撤申请及撤邀请的**临时正文**90天，ID/回应状态等必要约束保留 |
| verification_objects | 本人Evidence/Verification ID、类型、版本、状态、Case | 对应正式事实；删除先撤回当前引用能力，再依赖顺序清理 |
| verification_events | 本人精确版本、payload、payload_text、context、hash、Consent | 三处可能含正文的字段随本人原事件一起物理清理，不只清空text而遗漏JSON副本 |
| verification_dependencies | 本人验证对象精确版本与Attempt/Intervention/Result/Evidence版本关系 | 本人对象删除其依赖记录；其他作者的独立记录保留，但读取必须重新核验当前来源，不能沿用被删除依据的强结论 |
| lifecycle_erasure_records（48） | 无正文的表名/对象ID/主体/hash/清理原因/政策/清理时间/保留截止 | 只保留必要清理元数据；按记录retained_until有界清理。没有源正文时不把占位冒充原签名载荷 |

30天日额聚合是CUR-35授权下的工程细化：它服务于最近的按日合计和排查，不是用户逐字选定的数据库TTL。180天写回执是已确认安全审计类别到“已接收公开动作”的映射；尚未结案的治理投诉仍按独立治理政策处理，不能套此计时起点。Task临时邀请/申请正文90天映射“临时协作交流”类别；正式参与约定和交付不跟着消失。读取层先隐藏超期正文，Worker之后擦除原文及系统快照副本，不等待清理周期才停止展示。

## 聊天表与外部正文的明确分工

迁移47八张表均显式登记为M12管理，不属于“未知表可忽略”的通配例外。

| 表 | 对象用途、期限和删除边界 |
|---|---|
| chat_rooms | 共同房间档案；creator仅来源不是全房间内容所有权。房间存续状态由成员及房间策略决定，不随某个作者删除整个共同房间 |
| chat_memberships | 成员加入/离开关系；删除本人显式离开，不能删除其他成员历史和权限 |
| chat_decisions | 房间共同决定和各自表态；不能raw导出整个payload/votes给某一用户，按房间授权处理 |
| chat_message_refs | 消息ID、作者、固定expires_at和Prosody archive定位；消息7/30/90天，默认90，到期不可读。外部删除成功前保留purge_pending和定位，不能先删引用丢失清理目标 |
| chat_message_operations | 消息写幂等回执；无消息正文，M12维护操作结果和来源生命周期，不将其误报为原始消息 |
| chat_cursors | 用户阅读与Agent处理游标分别保存；本人关系退出/删除由M12处理，游标不延长消息TTL |
| chat_message_preferences | 本人对特定消息的隐藏等偏好；不改别人的消息保存期限 |
| chat_agent_grants | 本人Agent房间授权；离开或删除时撤销，过期不表示Agent仍在运行 |

`ChatService.exportOwned(actor,{after,limit})` 由原服务认证本人并经Prosody作者核对导出本人仍保留的消息，不导出他人正文或共同决定私有载荷。它是独立消息导出入口，尚未纳入旧整包导出分页清单；这一区别须在产品入口说明。

迁移51没有新增表，增加 `chat_message_refs.content_bytes` 和消息操作 `state/previous_content_bytes/target_content_bytes/base_revision`。通用本人导出现追加8项元数据集：房间创建回执、本人提案回执、本人成员关系、消息回执、消息操作、本人阅读游标、本人消息偏好、本人Agent授权。消息操作仅导出显式结果revision/editedAt，不将通用result JSON未来可能新增的私密字段自动纳入；不导出共享房间当前正文、proposal payload或其他成员votes。正文仍走上面的独立外部存档入口。

content_bytes 是外部写入的实际预留／占用，不是消息已经送达的证明；待编辑预留也不是已完成编辑。清理仅由M12在实际transport.erase回执后清零，并取消对应pending edit；外部状态未知时继续保留预留和purge_pending。eraseSubject目前保留无正文refs/operation及共享档案等元数据，不应报告已完成全部物理删除。51新增字段及上述8项导出已通过带实际数据的受限 PostgreSQL API 角色检查，包含跨作者过滤与不泄露正文反例。

`ChatService.eraseSubject(subjectId,{limit})` 自己管理事务，离开关系、撤Agent授权、标记消息不可读，再调用外部清理。`purgeExpired({limit})` 按每条消息固定时间处理。主库事务不能包住外部副作用，因此新增 `executeDeletionWithTransports` 先取得核准的主库执行回执，再调用聊天清理。返回数据库回执与当前聊天状态两个部分；外部失败保留pending，重试同一命令继续。即便聊天受控范围清理完成，也不把未来备份和第三方副本称为完成。

## 导出与兼容

原v1导出端点和合法请求保留，追加本人数据集及Task/Case/Evidence/Verification当前授权视图。本人原始提交不夹带多人Task/Participation快照；混合对象只能选择受当前权限约束的视图，每一页重新检查。Case视图若通过Task读取，还要求assistance scope。Evidence/Verification可选择精确版本，复合游标上限扩为200字符；新客户端同步接受该界限。

旧197项基线和旧迁移不改写。48只增加无正文清理记录；并未将旧对象或旧日志伪造为新版本事件。验证工具只读，运行Worker清理才修改实际过期对象；本轮测试仅用隔离合成数据。

## 执行结果与未覆盖范围

新增测试入口 `test/lifecycle-v2.test.mjs`；实际PG入口 `test/postgres/lifecycle-v2.test.mjs`，由现有隔离临时集群runner启动。检查对象包括待删除/取消、公开列表/索引、分页权限重查、本人原始字节、多人内容擦除、共享Account不被误清、控制链不降级、未知新增表拒绝漏删、正文到期及Worker最小权限。实际结果记录在项目 `07-logs/development/lifecycle-v2.md`，本文不预先宣称测试通过。

追加登记：迁移49的 `capsule_permissions`、`capsule_uses_v2` 均按subject_id本人导出与删除；许可grant与revoke正文一起清理。共享use引用阻止Case/Capsule源事件物理删除时，源正文及相关JSON副本清空，保留原hash及ID，不以FK存在宣称材料仍可核验。迁移50新增 `community_write_receipts.room_id` 纳入导出，房间邀请不伪装成Task。49/50的新业务行为由M05/M12场景独立验收。

52—56后续实现：本人通知偏好与呈现、私有摘要元数据、项目/角色/转交/字段来源、Contact、Experience/review/任务限定资格许可、房间共享摘要已加入清单。Project按当前owner归属，转交后不能依creator删除；个人字段作者删除后保留最终字段定位但不保留正文，owner需明确补写，不回退旧值。Contact个人说明90天到期读与导出即时过滤，bounded worker物理清正文；7天邀请期限不删除既有房间。共享对象含其他作者时只清本人的原文和JSON副本。Experience/review及项目管理关系不统一套临时期限。

私有摘要与房间共享摘要原始导出只有本人回执元数据，不含content/source_facts；私人正文经`personal-summary`当前授权视图读取。项目和Contact新授权视图分别要求history scope，仍逐次调用实际reader。M14的30天私有云正文与来源失效清理由所属服务管理；M19全服务删除可以删除没有其他依赖的本人私有摘要元数据，M14普通单摘要删除仍保留版本回执。这些操作不删除用户本地文件。

测试 `discovery-lifecycle-v2` 在真实PostgreSQL18.6受限API与worker上综合1/1通过，覆盖所有当前productV2数据集SQL、源撤回再导出、Contact到期、最终字段来源不回退、独立review/Contact回应/共享替代记录不被误删。消息和Experience等引用使用注明的合成归属夹具，不将其当作外部消息投递或真实能力验证。临时集群removed:true。

迁移57的 `recruitment_opportunities` 按当前 Project owner 归属，招募事件和 Task 关联按各自作者归属；发布者删除时暂停仍由其负责的招募，owner 删除时关闭其项目招募，不能关闭已由其他 owner 接续且独立发布的对象。本人事件正文随删除清理，被独立引用保留的回执不保留原文。招募30天到期只结束当前分发，不删除正式 Task 或历史关系。原始导出包含本人事件、关联及实际 `community_write_receipts.recruitment_id`，当前授权 `recruitment` 视图要求 history scope，Task 详情另依 assistance scope。迁移57的真实 PostgreSQL 综合场景已验证这些导出和原发布者删除后的独立 owner 数据保留；这项结果不代表生产迁移或全部生命周期完成。

尚未以本切片完成的工作：聊天全部表级元数据最小化、外部消息正文与整包分页统一、附件存储、备份清理证明、运营真实删除个案和公开部署时点。M05/M14/M12完整业务由所属模块单独验收；本文件仅核对其实际新表生命周期，不替代业务验收。整单 `serviceWideDeletionComplete` 继续为false。
