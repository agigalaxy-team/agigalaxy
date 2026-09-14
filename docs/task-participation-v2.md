# Task 与多人 Participation v2

实现对应 `NEW-M11-FLOW-PARTICIPATION`。依据项目 `predevelopment/work-packages/M11.md`、第八卷、CUR-25—29及B-08-Q01/Q02/Q04，保留原 v1 Assistance 的合法字段与事件。本说明记录接口实现，不能代替模块完整阅读包或证明生产部署完成。

## 真实业务边界

Task 使用真实 `workContext`，可以 `caseId:null` 和 `attemptRefs:[]`。发布不会创建 Case 或失败 Attempt。需要保存实际工作事实时调用 M03 的 create-and-link-task，同一事务建立 Case、首份事实及 Task 关系。普通聊天不自动调用任务发布。

建议联系清单仅属于请求者，和 `contacts.responses` 中的实际邀请、回应和申请分开。邀请逐对象持久化，`question`、`interested`、`declined` 都不建立承担关系。请求者创建 Participation 约定，提供者确认后才 `active`；每方单独版本、范围和交付。角色包括诊断、建议、工具、补丁、评审、验证和主要责任方。房间成员及材料权限继续独立。

一个人退出保留已经发生的交付与归因，其他人继续工作。交付引用真实核心 `Result` 和 `Intervention` 精确版本，请求者接受不会创建 Verification、Resolution、Proof、Honor 或付款。范围变更待对方确认，旧范围仍生效；对方拒绝新范围不会被当成此前工作失败。

## 服务与路由

所有写入口采用 `{consentId,payloadJson}`；`payloadJson` 的原始字节受到已有 `assistance.publish` Consent 约束。Task 发布 Consent 对象是 `operationId`，其他动作是各自 `eventId`。私有交互只授予作者和其明确对方；Task 公开不自动公开邀请、名单、申请、报价或多人私有约定。

| 操作 | 服务 | 路由 |
|---|---|---|
| 创建Task | createTask | POST /v2/tasks |
| 公开列表/详情 | queryPublicTasks / getPublicTask | GET /v2/tasks / GET /v2/tasks/{taskId} |
| 登录查询 | queryTasks / getTask | POST /v2/tasks/query / GET /v2/tasks/{taskId} |
| 建议、邀请、回应、申请及结束 | submitTaskEvent | POST /v2/tasks/{taskId}/events |
| 提出具体承担范围 | proposeParticipation | POST /v2/tasks/{taskId}/participations |
| 确认、退出、交付、接受和争议 | submitParticipationEvent | POST /v2/participations/{participationId}/events |
| 固定ID提交回执 | taskReceipt | POST /v2/tasks/receipt |
| 首次保存真实事实并关联 | CaseService.createAndLinkTask | POST /v2/tasks/{taskId}/case |

路由由统一 HTTP 组合接入。精确字段由 `src/shared/task-schema-v2.mjs` 校验：任务动作使用 `expectedTaskVersion`，参与动作使用 `expectedParticipationVersion`，同一人的范围另有 `scopeVersion`。跨对象版本冲突返回409；回执未知先按原ID/hash查询，不生成第二个操作。

`resultRef` 采用 `{id,version}`，`interventionRefs` 是相同结构数组，`evidenceRefs` 是原 Evidence UUID。准备文件的占位UUID示例在此细化为精确版本，不能用新结果覆盖已接受交付。Task总体目标版本与Participation约定版本在核心事实中分别保存。

## 持久化与兼容

`task_requests`、`task_participations` 和 `task_events` 是追加迁移。旧 Assistance/Case 原事件、payload hash和版本保持原样。Task/Participation均由当前事务持有，写锁次序是 Task → Participation/Case，不启动嵌套事务。

v2 可以把已有 v1 selected 显示为标明 `legacy-v1` 的单一 Participation，只读映射不伪造新事件。旧v1不能写新多方Task，返回 `unsupported_semantics`；新任务读取返回 `compatibility.writableApiVersion=2`。旧标题160等合法边界仍可读，v2标题120和摘要10000的边界不回写旧载荷。

公开发布及邀请，包括原v1入口，均调用 `PublicWriteService.consumeWithin`，先核对业务幂等，再在同一数据库事务消费Account日额。缺少实际验证服务时明确拒绝。邀请有效期最多7天并受招募期约束；同Task明确拒绝后不重复邀请。双方真实确认和交付接受接入Account真实互动记录，不用普通建议或申请升级信誉。

## AI Agent 部署及后续接线

使用项目已配置的迁移执行入口追加版本，再启动已有服务组合；不得手动更改旧迁移或删除数据。API运行角色需要新三张表的读写权限。配置发现沿用服务入口与现行资源资料，不从此文档寻找或保存凭据。写客户端必须使用实际身份、Consent、准确端点与当前版本；公开读取无需先安装插件。

验证先调用公开列表，然后用明确标为合成的数据执行私有Task发布/邀请/双方确认/交付。合成流程与真实公开认证、宿主和试点分别报告；不要为排错让未验证Account公开写入。常见问题包括旧版客户端向v1提交多方内容、Consent objectId错用Task ID、参与版本与Task版本混用，以及缺少M03精确来源导致交付被拒。

后续任务仍需接上 M12房间、M14通知、Context收件者、治理Task目标、事实删除/导出以及履历资格投影；它们必须从所有实际Participation出发。当前源码支持的首批服务切片不代表完整M11体验和这些跨模块任务已完成。
