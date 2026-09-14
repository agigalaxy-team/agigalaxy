# Task / Room 治理 v2（M24，迁移71）

本切片实现 NEW-M24-FLOW、NEW-M24-ACCEPT、NEW-J-M24-INTEGRATE 中独立 Task / Room 的举报、有限操作限制、恢复和申诉。评论治理继续使用61。依据为 PWP-M24 STEP02/03、IF02，卷12.12—12.18/12.22—12.24、卷08.16—08.21，B-09-Q02、ROOT-Q-NOTIFY-CHANNELS 及 Core177—185。CUR-11直接确认认证、限频和反广告；处理角色和具体时限来自历史方案及本轮授权细化，不能当作用户该句原话。

## 实際流程和责任

用户在当前可读任务或本人房间选择准确对象和版本，写本人说明、选择限定受众并确认签署。服务保存举报，单纯举报不限制目标。实际配置的处理身份需要既有 moderation scope、当前控制凭据、独立于当事人及其已验证 Account，并且能读取至少一份当前有效的本案说明，才可以复核、限制或裁定。自称运营者或持有 scope 不产生处理资格；没有实际处理角色时只记录请求，不承诺有人受理或响应时间。

Task 引用 rootEventId、观察版本和实际处分时当前版本；Room 引用当前 revision。举报人原文受 Private Consent 限定，最多16位明确受众。处理者没有因此取得任务原文、房间成员身份、聊天历史或附件。相关当事人可读必要处理状态，不能自动读其他人的私有说明。房间仍可没有任何 Task 引用，普通聊天不转成任务。

Task 支持 discovery-hidden 和 new-participation-paused；Room 支持 sending-paused 和 invitations-paused，AI子区继承父房间限制。发现隐藏影响对外列表和陌生人读取；已合法参与者仍需原授权才能继续读取。暂停新参与阻止新增申请、邀请、扩展招募以及首次加入确认。暂停发送同时阻止新消息和编辑，在外部消息传输前拒绝；旧消息历史、撤回和合法退出保持原有规则。暂停邀请会隐藏尚未接受的旧邀请列表和通知，恢复后按当时有效期、版本、权限重新显示。账号配额与具体来源权限仍分别执行。

多个案件各自保存限制；恢复仅清除本案，不解除其他案件。临时暂停最长7天、裁定限制最长30天是当前有界实施参数。临时暂停本身即可申诉，不必等最终裁定。申诉、撤回举报和撤销原正文 Consent 都不会静默删除已接受的操作限制。原任务 Consent 撤销后，即使治理恢复也不能重新公开原任务。裁定为 dismissed 必须不含限制；新的 upheld 裁定明确列出本案范围及期限。没有把举报转换为失败记录、失能认证或物理删除。

## 服务与 HTTP

装配 `TargetGovernanceServiceV2(access,consents,{tasks,chat,accounts,moderatorIds})`，复用实际 Task、Chat、CommunityAccountRegistry 与现有 moderatorIds 配置。稳定对象使用 UUID，事件 payloadJson 精确字节参与 hash 与 Consent。所有修改在同一事务重查当前身份、目标、案件版本和权限；锁序为目标后案件。重复事件使用相同 ID、Consent 和 hash 返回原回执，冲突内容不能覆盖。

| HTTP | 行为 |
| --- | --- |
| GET /v2/target-governance/config | 当前已配置角色与事实边界 |
| POST /v2/target-governance/target | 当前对象 `{type:'task'|'room',id}` 的准确举报定位 |
| POST /v2/target-governance/reports | `{consentId,payloadJson}` 新举报 |
| POST /v2/target-governance/events | 同样封套，review/supplement/appeal/withdraw-report/pause/resume/resolve |
| GET /v2/target-governance/:reportId | 当前授权下案件与必要状态 |
| POST /v2/target-governance/query | 本人可见案件分页，可选目标 |
| POST /v2/target-governance/receipt | `{eventId,payloadHash}` 本人原事件精确对账 |

Canonical schema 在 `src/shared/target-governance-v2-schema.mjs`。回执 acknowledged 只证明原事件已接受，不能代替当前限制查询。收到未知 ACK 后客户端保留原 ID、字节、Consent；重连只对账。旧授权与业务回执均不存在时，另经用户明确预览才可用新凭据为同一原操作重新授权。停止本机重试保留原 ID 可查，不宣称服务端取消。

客户端工厂 `createTargetGovernanceClientV2` 复用 browser-client，MCP 工厂 `targetGovernanceToolDefinitions` 提供7个工具。独立组件 `TargetGovernanceWorkspace` 接真实数据；主程序路由为 `/app/governance` 和 `/app/governance/:reportId`，对象入口使用 `?targetType=task|room&targetId=...`。普通查询不增加模型确认步骤，新的私有披露与处理决定需要准确意图确认。

## 持久化、通知、生命周期

71追加 `target_reports_v2` 与 `target_governance_events_v2`，保留1—70迁移原文。reports 保存最小目标、参与方与限制元数据；events 保存实际作者的独立签署内容。API可写新事件但不能改旧正文或物理删除；报告只有状态与限制相关列可更新。独立 Worker 可以按保留规则清理，不能给案件直接裁定。

资源预算计入报告 party_ids 字节+2048、事件 payload_text 字节+1024。每人每目标最多3个未关闭案件，每案最多3次申诉、100条一般事件；恢复和撤回不受100事件上限阻止。已有案件控制事件走控制操作预算与独立请求桶，不因公共发布配额或存储已满阻断退出和申诉。

收件箱新类型 target-governance 保留90天并逐次复核当前来源；只含对象和必要状态，不复制举报说明，不自动记为人类已读。信息服务70的 information-change 类型保留。关闭案件180天后且无有效限制时由既有生命周期 Worker 清理。本人全服务删除可先净化本人事件正文；独立他人事件和必要受约束元数据不假称已经删除。导出登记只含本人报告元数据和本人签署事件，不直接导出全房间资料。

## 本批验证与边界

2026-09-13，隔离 PostgreSQL 中实际 galaxy_api 与 galaxy_evidence_worker 角色定向测试 1/1 通过（3694.5607ms）。包含真实本地 HTTP、createBrowserClient 当前凭据/未知 ACK 重连、合成 OIDC 两 GUID 同 Account 的处理独立性、并发同版本只接受一个事件、两个案件独立限制、临时暂停申诉、撤回正文不取消限制、来源撤销后恢复不重新公开、Task/Chat 实际消费者、邀请列表/通知同步隐藏、本人正文净化及受限 Worker 到期清理。临时数据库清理另有回执。

聊天外部传输在此测试使用明确替身，仅断言受限操作未到达传输；没有重复声称这是新的 Prosody 实测。客户端存储在 HTTP 测试中是注入的本地 Map，不算真实浏览器 IndexedDB 或完整网页人工验收。本批没有真实运营者受理、公众联系、生产 Case、第三方投诉或远端部署证据。实际 UI 集成构建、发布及公共服务状态由主代理另行报告。

## AI Agent 部署说明

使用现有服务配置发现方式读取 moderatorIds 的配置位置，仅接受已有真实身份登记和当前控制证明，不能编造运营者账号或公开联系渠道。先应用追加71及配套 API/Worker 角色，再启动同版本服务；旧数据库不支持71相关查询，不允许只替换部分文件。既有生命周期 Worker承担保留清理，无新增备份或模型推理进程。部署后用明确合成对象检查路由与当前角色；真实受理流程仍需实际人参与。常见错误是把 moderation scope 当运营者、把举报正文读取当房间访问、把 accepted 回执当当前处置状态，或在恢复时越过原对象 Consent，这些均不属于本实现允许行为。
