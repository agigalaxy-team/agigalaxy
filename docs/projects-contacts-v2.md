# 独立项目与双向联系 v2

2026-09-13。本轮落实 M10 的 PRE-M10-02 / IF02—03 / F01—02 中 Project、共管、项目偏好和 Contact 交流切片。已经接真实服务与 HTTP、SQL 持久层、认证及配额；不代表完整 M10、真实外部账号或线上部署已验收。[原始修改依据](../../../../07-logs/development/project-contact-v2.md)保留用户原话与授权代选的区别。

## 项目是独立对象

Project 不再只是个人 Profile 中的一段声明。创建项目、编辑资料、授予编辑或代表身份、提供转交、接受转交、归档及恢复，均有独立操作 ID、项目修订号和精确 Consent。项目的自报功能、技术、说明和人／Agent／团队类别依然是声明，既不是能力证明，也不是法律所有权认证。

owner 管理项目和角色；editor 可编辑资料但不能修改发现开放、主体类别、代表权或管理其他人；representative 表示对外代表资格，不自动获得编辑、私有文件或 Agent 控制。最多10个管理主体包含 owner，同一主体的两个角色不重复计算。转交在新 owner 明确接受前不发生，取消转交保留原 owner。接收者的接受建立当前发布策略，但不能扩大其他历史字段作者的授权。

历史 Profile 合法数据不改写。显式导入需要当前本人声明 ID、相同稳定项目 ID，以及内容准确一致；之后项目独立修订，旧声明保持原样。发现查询会避免同时返回已导入的 Profile 声明和独立 Project。没有 Project 的用户仍直接使用临时目标查询。

字段按最后作者来源读取，不把某个最新事件当作包含所有内容的快照。最终字段来源撤回、过期或删除时，该字段不可用；必填字段缺失则项目当前视图不可读，不回退更早的公开值。owner 可以用新授权补写缺失字段。仅清正文时保留 affected_fields 和最终来源指针，防止旧值重新出现。未知文档扩展字段保持原样、不作业务推断；局部修改不套用创建默认值。

项目级偏好与个人长期偏好分开。明确的全局关闭或有效临时暂停优先，其余项目覆盖只影响指定项目；清除覆盖恢复继承。发现仍同时保留交流、复用、协作、招募目的和发布／参与任务／普通聊天入口。双向 GUID 屏蔽应用于已识别双方的查询与联系，不将个人屏蔽误称为撤回已有公共 Consent。

## 从机会到普通聊天室

机会卡片只是当前可联系线索。Contact send 带当前机会精确引用、临时或项目上下文、交流目的、给对方的说明和房间标题。发送者签署 Private Consent，明确允许该接收者读取；没有对方可读授权的请求不写入。服务重新核对功能、意愿、公开来源版本、暂停及屏蔽，返回 sent 仅表示银河接受请求，不表示对方已读或已同意。

send 不建房间、不创建 Task、Attempt、Participation，也不给信誉加分。联系有效期7天，接收者可以接受或拒绝，发送者可以撤回；过期或不再具备当前权限、意愿、来源或账号条件时不能接受。双方真实接受后，Contact 在同一事务创建唯一无房主普通房间，初始成员就是双方。相同 Account 的多个 GUID 不伪装成独立成员；如果两方实际控制者相同，房间仍处于等待独立成员状态。

接受的是交流，不是承诺完成工作。此后可讨论是否建立具体任务，由对应模块另行执行。联系说明撤回不自动撤销已经独立接受的房间关系；房间离开、解散、消息撤回和共享历史继续按 M12 处理。每位作者的说明按其当前 Consent 读取，其他作者的回应不会因引用了它就变成同一作者的数据。

发送 Contact 与任务邀请、房间邀请共用 Account 额度和同接收者7天未回应冷却。同一账号换 GUID、换入口不会绕过。精确重试先确认业务操作 ID 与载荷摘要，再读取原回执，不重复计数；失败事务回滚额度。真实接受／拒绝释放这一对象的未回应状态，后续新邀请建立新的冷却。撤回不释放冷却，避免用“发出再撤回”重复骚扰。

## HTTP 与接线

所有写入必须有当前绑定，业务调用入口继续有资源预算。Project／Contact 用 history scope，公开 Project 写入还要求真实 Account；Contact 发送使用真实统一邀请额度。普通房间走 binding scope 与 M12 真实账号认证。

| 入口 | 内容 |
|---|---|
| POST /v2/projects | `{consentId,payloadJson}`，project.write 的 create/revise/grant-role/revoke-role/offer-transfer/accept-transfer/cancel-transfer/archive/restore |
| GET /v2/projects/:id | 当前逐字段授权投影；匿名只读公开 |
| POST /v2/projects/query | 当前 owner 或角色项目；有界分页 |
| POST /v2/projects/:id/preferences/read、save | 本人项目覆盖；save 使用 expectedRevision |
| POST /v2/contacts | contact.write 的 send/accept/decline/withdraw，精确私有接收者授权 |
| GET /v2/contacts/:id | 仅双方 GUID 可读，当前说明授权与90天内容期限重新核对 |
| POST /v2/contacts/query | incoming/outgoing/both，每页最多100 |

Project 事件输入使用 operationId/projectId/expectedRevision；Contact 使用 operationId/contactId/expectedRevision。revision 冲突先读当前状态再形成新的选择，不能复用旧签名替换载荷。精确重试返回 replayed 与 appliedRevision；Contact 的当前状态可能已不同于该原操作发生时状态。

独立项目机会引用为 `{sourceKind:"project",subjectId,projectId,documentEventId,policyEventId}`；旧 Profile 引用保留 `{subjectId,projectId,statementId}`。新查询继续支持两者，不强迫旧调用者重写 Profile。

部署 Agent 只追加迁移53、54，不改旧迁移。工厂实际注入 ProjectV2Service、ContactV2Service、DiscoveryV2Service 的 projects/inbox，以及 createChatContactAdapter(chat)。公开账号与 PublicWriteService 缺失时拒绝操作，不能加入生产“跳过认证”开关。53含六张项目表，54含两张 Contact 表和共享回执 contact_id；角色权限、资源计量及对象审计都由统一入口注册。MAM 消息传输可用性需单独验证，建房元数据成功不表示正文已经送达。

## 保留与删除

项目/管理关系按持续业务对象保留，不统一90天过期；归档停止发现，但不伪称已删除。全服务删除只归属当前 owner 的项目，已转交项目不按 creator 误删。删除者自己的字段正文清除，他人的独立资料保留并按当前来源读取。

Contact 的说明与上下文90天后即停止读取/导出正文，worker 每类最多100条清正文，留下精确 ID、摘要、状态及到期信息。7天联系超时不自动销毁已接受的房间。本人删除保留对方独立回应；MAM 正文删除经 chat.eraseSubject 外部回执核对。53—56新数据已进入 M19 本人数据集和当前授权导出，不把共享 Project、共享摘要或对方回应当作本人原始数据导出。

## 验证范围与剩余

Project HTTP/PGlite1/1：稳定导入、旧 Profile 原文保留、三种角色、最终字段来源失效、owner 修复、转交、归档、项目偏好、发现集成和缺账号适配器拒绝。该用例对账号使用明确替身，不能单独证明账号功能。

Contact HTTP/PGlite1/1及真实 PostgreSQL18.6受限 galaxy_api 综合1/1：独立本地 OIDC code/PKCE 和银河本地签名绑定，未使用账号/配额替身；两 GUID 共用 Account、跨三入口冷却、错误私有授权拒绝、屏蔽后不得接受、唯一普通房间、无伪造任务及信誉、精确重试和独立作者撤回。临时合成集群 removed:true。

M19 的 discovery-lifecycle-v2 真实 PostgreSQL API/worker 角色综合1/1通过，涵盖52—56的全数据集SQL、当前授权摘要导出、正文过期、字段来源失效及删除者／独立作者隔离。测试中的消息、体验审核和共享摘要引用是明确的存储归属样例，不代替相应模块真实业务或 Prosody 传输验收。

后续独立长期 RecruitmentOpportunity 已在[招募v2切片](recruitment-v2.md)实现持久状态、代表权、30天复核、Contact联系、真实额度及显式任务关联并完成工程验证。相关通知分发、客户端写流程和实际宿主验收仍各自登记；这些不通过 Project/Contact 当前切片冒充完成。
