# 长期招募 v2

2026-09-13。实施 M10 / PRE-M10-F02 和 RecruitmentOpportunity 工作包切片。依据卷07与已采用 ROOT-Q-TASK-TYPES，持续角色需求是独立机会；交流后具体交付单独建立 Task。30天复核与角色细分属于授权代选及已整合实施设计，不称为用户逐字原话。[修改依据与结果](../../../../07-logs/development/project-contact-v2.md)。

## 可完成的流程

当前 Project owner 或 representative 可以发布角色需求，editor 单独没有这项权利。发布者是本次实际接触人，必须对该项目仍有代表权；首片要求 contactSubjectId 与发布者一致，避免替别人承诺接受联系。由其他代表负责时，该代表用自己的身份发布或续期。未来更复杂的代理提名与对方接受可追加设计，本片不静默当作已获本人同意。

需求包括角色、功能、技术、条件和当前说明，不要求失败 Case、Attempt、一次性交付或赏金金额。文档属于明确声明，不验证法律所有权或能力。每次发布、修订、续期均签署完整当前文档和精确 Consent，最长30天复核窗口；数据库记录当前发布者、接触人、事件来源、期限及状态。原有历史事件保留其真实作者，不把 owner 接续更新反向归为早先代表的贡献。

无项目查询者可直接从临时功能目标发现招募，也可混合使用交流／复用／协作／招募目的。功能匹配沿用明确标签方法，技术差异用于解释，不当作排除同功能新参与者的门槛。服务不推理、不生成模型总结、不替用户判断是否接受角色；卡片包含角色需求、当前代表权和来源，用户模型结合真实历史解释。没有历史的主体不会因此被拒绝查询或接触。

Contact 使用精确的 recruitmentId 和发布事件 ID。发送只是表达交流意愿，双方私有授权和接受仍走 Contact 的7天流程；接受后建普通聊天室，不新增 Task 或 Participation。暂停、关闭、过期、当前声明撤回、项目不可见、代表撤权、发现暂停或屏蔽都会阻止新接触。旧联系不会因 owner 换人而偷偷改收件人；新版本需重新读取并形成新选择。

暂停仅停止新分发。续期或修订必须重新签署完整文档、明确新期限，并重新核对代表权；已关闭对象不可通过暂停再续期绕回开放，可新建新的机会。get 可以显示仍获准的历史声明及 acceptingContacts:false，发现查询只返回当前可接触机会。管理查询在正文来源失效时返回有限状态回执，现任 owner/代表可据此处理，不能据此读到已被撤回的旧正文。

## 与具体 Task 的关系

当一项交付明确后，先通过现有 Task API 创建真实任务，再提交 link-task。当前切片要求调用者同时拥有项目 owner/代表权和该 Task requester 身份，并提供精确任务版本；请求需 history 与 assistance scope。关联不改变 Task 修订号、状态、约定、参与者或验收，也不以房间成员关系代替 Task 参与确认。

暂停或关闭招募不取消已关联 Task。查询者只能看见当前获准的关联记录和任务；没有 assistance scope、不具备关联事件授权、或任务当前不可读时，不返回该私有 Task ID。匿名招募卡片不暴露关联任务清单。招募结束不意味着其中任何 Task 已验收，Task 结束也不意味着长期角色需求已结束。

## 接口与重复请求

| 入口 | 语义 |
|---|---|
| POST /v2/recruitment | history scope，`{consentId,payloadJson}`，action recruitment.write |
| GET /v2/recruitment/:id | 当前可读声明及真实状态；匿名仅Public |
| POST /v2/recruitment/query | discover需临时或项目context；managed需当前本人项目管理身份 |
| POST /v2/discovery/query、detail | 原入口追加招募机会；旧Profile／Project引用不改 |
| POST /v2/contacts | 使用 sourceKind:recruitment 的精确机会引用，沿用双方私有确认 |

事件共同字段为 operationId、recruitmentId、projectId、expectedRevision。create/revise/renew 要求 document 和 expiresAt；pause/close 可带 note；link-task 带 taskId/expectedTaskVersion。create 从修订0开始。公开写使用 Public/public-profile Consent，控制与关联可以使用私有 Consent。超过30天、非代表、错误版本或错误目标直接拒绝，不写半成品。重试相同操作 ID 必须保持完整载荷摘要、作者、对象及 Consent 一致，返回已接受操作的 appliedRevision 和当前状态。

招募机会引用为 `{sourceKind:"recruitment",subjectId,projectId,recruitmentId,eventId}`；subjectId 是当前接触人。主发现查询每个主体最多枚举200个招募对象，返回这一边界和独立分页入口；不宣称全网完整排名。独立招募查询每次扫描最多20个候选，可出现空页但仍有 nextAfter。游标复用发现服务的加密、15分钟和进程有效性，不裸露隐藏对象ID。换查询、换身份、游标失效或进程重启需重新查询，每页重新核对权限与状态。

## 反广告和保留

PublicWriteService 接受真实 kind:recruitment，映射既有 task 日额作为共同“任务或招募公开发布”类别。额度返回 covers 列出两种发布；公共回执保存 recruitment_id，task_id保持空，不创建虚假 Task。create/revise/renew 都是新的公开发布操作，受真实 Account、限制状态与共享日额约束；pause/close/link-task不占公开发布额。精确重试不重复计数，额度不足或后续失败整笔事务回滚。

30天期限控制招募继续分发，不是删除原始关系和已签署历史的统一期限。M19将57三张表逐项登记：机会归属当前项目owner，事件和关联归属签署者；删除早先代表不删除后来owner的独立声明或关联任务。被其他关系保留的原作者事件只留必要 ID/hash，清原正文，不伪称原文仍可验签。导出分为本人原始事件、有限机会元数据、本人链接，以及逐次核验的 recruitment 授权视图；共享发布回执增加实际 recruitment_id。

## 部署 Agent 接入与已验证边界

追加迁移57 `recruitmentV2MigrationSql`，保留1—56原SQL。服务工厂注入 `RecruitmentV2Service(access,{projects,consents,discovery:discovery.v2,assistance,inbox,publicWrites})`，并将实例交给 `discovery.v2.recruitment`。HTTP、Consent action、对象审计、受限API权限、每主体存储预算和本人导出都已接入。旧发布回执合法数据 recruitment_id 为NULL，原身份、Task、Contact与Room规则不改为特殊豁免。

当前验证：Recruitment HTTP/PGlite1/1；真实PostgreSQL18.6 galaxy_api综合1/1，临时合成集群removed:true，包含实际本地OIDC与生产Account/共享配额服务，没有账号配额替身。覆盖编辑者无代表权、超过30天拒绝、无失败历史匹配、代表撤权、普通房间接受、暂停阻止旧联系、旧事件不随owner接续改收件人、公开任务和招募共额、到期续期、具体私有Task独立关联、暂停不改Task、本人导出及删除者/后续作者隔离。时间超期场景明确将合成记录deadline提前，保持测试登录会话可用，未伪造生产时间证据。

公共配额受影响回归2/2通过：真实OIDC绑定、多GUID共享、私有Task可用、冲突重试、事务回滚和邀请冷却。关联Task实现曾因误读 helper 返回结构而拒绝合法链接，已使用实际 requesterId/row.version 修复并通过上述场景。

仍需对应客户端表单与Skill/MCP写流程接入、机会通知/定向分发和真实宿主体验验收。网页已有相关页面不等于已经绑定这些新增写入口。57未参与此前根代理冻结的56发布包，本文件不宣称57已部署。
