# 通用 Evidence/Verification 数据 API

实现切片：NEW-M06-FLOW，PREP-M06-S1/S2/S3 的当前数据读取传播。M03 的 Case/Attempt/Intervention/Result v2 和 M11 的真实参与协议是前置依据。旧 `/v1/evidence-submissions`、CI 工作队列与 `ci-execution-observation` Proof 字节语义保留。

## 用户获得什么

某个交付的请求者反馈、本人本地检查、另一位已确认参与者的复核可以同时保存，并保留每份记录实际检查的范围、目标版本、来源和限制。记录通过签名 Consent 明确由谁提交，但不会自动将 Case 标为解决、把意见变成独立执行证明，或授予通用能力认证。Galaxy 不替用户执行项目或模型。

## 当前入口

- `POST /v2/verification-records/submit`：`{consentId,payloadJson}`。payload 是以下三类之一。复用 `evidence` scope；Consent action 为 `evidence.submit`，objectId 必须是此次唯一 `operationId`，授权载荷与 payloadJson 完全一致。
- `POST /v2/verification-records/read`：`{type:"evidence"|"verification",id,version?}`。省略版本读取当前对象，指定版本读取当时的获准记录并标示与当前状态的差别。
- `POST /v2/verification-records/status`：`{refs:[{type:"evidence"|"verification"|"proof",id,version?}]}`，最多100项，逐项返回权限、来源与版本状态。旧 CI Proof 还要求 proof scope，沿旧签名与撤销读取路径处理。
- `personal-mcp-facts-v2.mjs` 导出 `factToolDefinitions(services,actor)`，提供同一服务的精确载荷提交、读取与状态工具，以及 M03 v2 事实、批量回应和 Task 首次关联工具。MCP不生成用户签名或替用户选择结果。

## 对象与版本

通用字段：`id` 稳定对象 UUID，`operationId` 此次写入 UUID，`expectedVersion` 初次0、后续当前版本，`caseId`，`reportedBy` 当前本人GUID，`synthetic`。参与者另带实际 `taskId`、`participationId` 和 `participationScopeVersion`。纠正及撤销必须给 `reason`；纠正写完整新版本。版本不超过1000，载荷不超过24KB。

`kind:"evidence"` 包含 `evidenceType`、`source`、`observedAt`、`reportedSourceState`、`summary` 和可选 `expiresAt`。`source` 是 `originSystem, externalStableId, contentVersion, originalAt, issuer`，可附 `contentHash`、`uri`、`owner`。外部 issuer/owner 是有报告者的来源声明，不能冒充已经验证的外部身份。

`kind:"verification"` 包含 `target:{type:"attempt"|"intervention"|"result",id,version}`、整体目标 `scopeVersion`、`method`、`scope`、`conditions`、`observation`、`summary`、`evidenceRefs:[{id,version}]`、`relationship`、`observedAt` 与可选到期。目标和全部来源必须是真实存在、同Case、当前可读的精确版本。新增/纠正验证要求目标当前版本；旧验证仍定位原版本，目标改变会使其退出当前验证状态。

反馈方法 `participant-feedback` 和 `requester-acceptance` 使用 accepted/partially-accepted/rejected/comment/inconclusive。其余测试、构建、CI报告、评审等使用 passed/failed/inconclusive，并要求实际登记的支持证据；没有材料可另存明确的反馈，服务不默默伪造或转换测试方法。

`kind:"revoke"` 带 `objectType`、同对象ID及当前 `expectedVersion`，记录永久的本对象撤回事件。后续恢复表达应使用新对象关联原历史，当前接口不抹除撤回事实。本人退出参与后仍能纠正当前可访问材料的既有报告，或撤回自己的记录；他人不能代签。Case已经退出后的来源访问不因此恢复。

## 状态边界

`recorded` 表示报告已记录。`payload-hash-matches-storage` 只表示保存载荷与摘要一致，签名 Consent 在写入时已经核验且每次读仍检查当前权限；不是新生成的可离线携带证明。`reportedSourceState` 是本人报告的当时状态；当前外部来源仍是 `not-checked`，外部撤销仍为 `unknown`。可保留不可达的历史引用，不将不可达判为造假或自动有效。

所有本地声明均保留 `independentExecutionVerified:false`、`capabilityVerified:false`、`taskOutcomeVerified:false`。`recordedRelationship` 表达目标作者本人、请求者或任务参与者；`declaredRelationship` 原样保存其同控制/独立等声明，另标 `relationshipIndependentlyVerified:false`。多签名或多 GUID 不增加独立来源数。

来源按 `originSystem + externalStableId` 的声明键分组，同源多个对象不变成多次独立证明。该分组是请求内可见范围，不是全网计数，也不是外部来源身份已经核实。合成标记从 Case 传递，禁止降为真实；不会进入本服务的真实成功统计，因为本服务不生成这种统计。

Evidence/Verification 纠正、撤销、Consent撤回、到期或引用目标改版后，每次 Case/M03、M11 新交付校验及状态读取都会重新核对。依赖不可用的验证正文不继续外露；Case当前投影剔除依赖该来源的强结论，保留覆盖不完整原因。旧事件仍在数据库，不以省略当前视图冒充未发生。

M11 当前 `evidenceRefs` 的旧 UUID 输入只表示版本1；它不会悄悄指向纠正后的版本2。精确版本 v2 EvidenceReference 已用于新版 Case 和 Verification；M11支持后续版本的载荷扩展仍属于后续兼容接线。

## 实现与权限

migration46追加 `verification_objects`（对象类型、Case、本人、当前版本/状态），`verification_events`（精确载荷、Consent、版本及接收时点），`verification_dependencies`（目标类型/id/版本）。历史迁移1—41不改。API角色只可读写所需对象当前状态，并可读取/追加事件和依赖；不能 UPDATE/DELETE 事件。旧 CI 作业不被转换成通用消息来源。

锁顺序沿 Task → Case → 通用对象，读取先以不加锁的不可变Case归属定位再锁Case和对象。数据库摘要/乐观版本、授权和审计在同一写事务内；生成器或只读查询不修改事实。

开发依据见项目 `07-logs/development/verification-v2.md`。工具语法/哈希不能代替语义复核。

## 当前可用范围和后续接点

当前：数据 API、MCP 工具定义、本人/实际参与者报告、精确版本、授权撤销、Case/Resolution 读取传播和旧CI兼容。Evidence只登记元数据和引用，不托管原始日志内容。

后续：M02受托Agent对象委托、M12选定消息和附件真实权限、M03配置快照、M07新版全履历/贡献视图、M05真实Capsule复用、M08资格、M09搜索与M14通知逐一接同一引用状态接口；不把这些尚未接入的聚合层说成已贯通。CI原生profile仍只接原来的v1结果，通用`ci-report`不是该profile的替代品。真实外部来源观察、独立复核、生产实测和用户界面验收各按后续场景取得，不以合成测试宣称公开业务上线。
