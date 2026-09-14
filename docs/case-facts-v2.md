# Case facts v2

实现范围：NEW-M03-FLOW-FACTS 的服务与持久化切片。依据完整方案卷05、PWP-M03、PREP-ACC-M03-01—05，保留旧 v1 原载荷、哈希、事件序列与兼容行为。这里描述源码及本地测试，不代表已经部署或通过真实客户端验收。

## 操作与版本

`CaseService.submitV2(actor, {consentId,payloadJson})` 接受严格的 `caseEventV2Schema`。调用者必须已通过 AccessService 认证；载荷 `actorId` 必须与当前调用者相等。写入沿用 `case-teaser` scope 和 `case.teaser.publish` 精确 Consent，Consent.objectId 使用 `eventId`。

新建根：`kind=case-created`，`eventId=caseId`，`expectedVersion=0`，明确 `synthetic`，以及 localRef、title、summary、source。普通原生根不强制 Task；关联已有主动 Task 使用下述原子用例。

后续事件支持：attempt-start、attempt-end、attempt-correct、intervention、intervention-response、result-recorded、resolution-recorded、case-scope-revised、case-withdrawn。必填字段以源码 Schema 为准；未知环境、输入或失败原因写 `unknown`，不从宿主名称猜测模型、不补造一次失败。

版本含义严格分开：

- `expectedVersion` / 回执 `caseVersion` 是 Case 总事件序列。
- `origin:{kind:attempt|intervention,id,version}` / `resultRef` 是实际对象的精确版本。初始版本为1；结束尝试或纠正增加相同对象ID的版本，旧事件保留。
- `scopeVersion`（Result）/ `taskScopeVersion` 是目标范围版本。
- `participationScopeVersion` 是某位参与者的约定版本；它与整体目标版本分别变化。有 participationId 而未传该字段时仅兼容首版1，后续约定版本必须显式给出。

Result 不能同时指两种来源，不能引用另一 Case、不存在的对象/版本或自己无权归属的工作。纯诊断可直接产生 Intervention 来源的 Result；此过程不创建 Attempt。接受交付由 M11 记录，Verification 由验证模块提供，整体 Resolution 由请求者明确追加。

`respondBatch(actor, requests)` 接受最多32个分别签署的 intervention-response 请求，逐项提交并返回 accepted/rejected 与错误码。相关方只能提交自己的意见；自我回应会标 self，不能成为外部确认。未回应保持 unconfirmed；不同参与者独立记录，不采用唯一赢家或强制百分比分配。

## 主动任务首次事实

`createAndLinkTask(actor, {operationId,taskId,expectedTaskVersion,case,initialFact})` 中 case / initialFact 均为 `{consentId,payloadJson}`。Case 根 source 为 `{kind:'active-task',reference:taskId}`，两份载荷具有相同 taskId / caseId。首事实是已实际发生的 attempt-start 或 intervention，expectedVersion为1。

该动作当前由请求者提交自己的首份工作事实；不允许通过一次根请求冒充另一参与者签署。参与者随后通过已确认的 Participation 提交自己的事实。有效对象级代报授权需在 M02 接通后扩展，不能把 owner 身份当作他人的签名。

事务先锁 Task，再锁 Case。Case 根、首事实、Task 链接和回执全部原子保存；任何事实校验失败都回滚，不留孤立 Case 或半链接。相同 operationId 与相同载荷重放返回原回执；冲突或另一个 Case 已链接则拒绝。

与准备稿输出示例的精化：Task 链接不是新的目标或参与约定事件，因此不增加 Task 的事件版本，避免 Task 序列缺号。回执返回真实 `taskVersion`、独立 `taskCaseLinkVersion:1`、`caseVersion:2` 和初始对象引用。原始准备稿样例中将二者合为2的示例不作为当前运行语义。

## 可见性与后续引用

`getV2(actor, caseId, {taskId?})` 对每个事件核对其作者的有效 Consent，再按读取者过滤。可读 Task 不自动开放全部 Case。返回 coverage 说明当前可见事件和缺失原因；普通原始事件和派生对象只包含合法范围。Result、确认和解决结论引用的事实或来源被撤销时，依赖内容也不能从事件列表或派生视图泄漏。

`validateDeliveryWithin` 给 M11 检查同 Case、精确 Result / Intervention、合法参与主体和参与约定版本。请求者可以接受提供者的交付；此时提交事实的 actor 仍是提供者。后续 Result 修订不无痕改写此前明确版本的交付。`validateTaskContextWithin` 仅校验所给真实 Attempt 引用及读取权限，不提供失败数触发规则。

外部 Evidence、选定消息、配置引用由拥有这些对象的模块通过 `sources.requireReferenceWithin(db,actor,ref,{caseId,resultRef?})` 验证；Resolution 验证引用通过 `verifications.requireReferenceWithin`。没有真实适配时返回明确 unavailable，不能仅检查UUID就声称已校验访问。空引用表示本次声明没有附件，不表示具有验证证据。

## 兼容、迁移和剩余交付

SQL 由 `infrastructure/case-facts-v2-migration.mjs` 导出并追加到统一迁移。只扩展 event kind 约束并增加不可变的 case_task_links；旧 migrations、JSON 和哈希不改写。API role 需要新表 SELECT/INSERT，运行时不获得更新/删除原链接的权限。

旧 v1 Result 保持真实 attemptId 必填。v2 查看旧记录时标 legacy-v1，旧 Attempt actor 保持 unknown，旧 succeeded 不变成整体 resolved。v1 读取或追加含 v2 语义的 Case 返回 `unsupported_semantics`，调用方转到 v2 详情，不构造假 attemptId。

本切片已有：本人和合法多参与者事实、原子 Task 关联、生命周期和修订、精确 Result 来源、分人确认、独立 Resolution、逐事件权限及递归来源失效、本地真实 M11 服务事务联调。

后续源码已接入 M06 Evidence/Verification、M07 当前授权履历、事实客户端/MCP，以及按类型分派的 M12 精确消息和 schema63 配置来源。[配置切片](configuration-v2.md) 明确 optional configurationRef 失效时只降低条件可知性，显式内容来源失效才过滤派生事实。M02 选定材料授权不等于替另一主体签署事实；owner 记录外部观察仍不能冒充他人签名。各切片的实测与发行范围分别记录，不能把整个 M03 或整体产品自动标为完成。

## 验证

`node --test packages/galaxy-official/test/cases-v2.test.mjs packages/galaxy-official/test/cases.test.mjs`

测试运行真实 Access / Consent / Task / Participation / Case 服务及 PGlite 事务；使用明确合成身份和对象，未接真实用户或服务器。覆盖无失败史发布、多人诊断/复核及分别确认、诊断结果交付接受、scope 分离、未知与取消、修订不覆写、精确引用拒绝、幂等和版本竞争、撤销依赖及链接回滚。生产 PostgreSQL并发和客户端体验另列，不以 PGlite 序列化替代真实并发验收。
