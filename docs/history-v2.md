# M07 履历事实查询 v2

本切片实现指定主体的现行授权履历查询；M05 是 Capsule，M07 才是本次履历/Profile/贡献模块。旧 `/v1/history` 及其合法数据保留。新接口不写手工履历、能力总分、Honor、付费资格或模型推理结果。

## 接口及接入

`POST /v2/history/query` 使用 `history` scope；匿名请求只按现行公开授权读取，携带无效凭据不能降为匿名。服务入口为 `history.queryV2(actor,input)`，MCP 入口为 `galaxy_history_v2_query`。服务层由 `HistoryV2Service` 组合 Case、VerificationRecord、Assistance 和 Profile 的实际同事务读取器。无新数据库迁移。

```json
{
  "subjectId": "GUID0000000000000000000000000000",
  "capabilityId": "software-debugging",
  "query": "输入格式",
  "timeWindow": {"kind": "all-visible"},
  "context": {"environment": "Node unknown-version"},
  "after": null,
  "limit": 20
}
```

示例 GUID 仅说明格式，不能代替真实已存在主体。`subjectId` 必填，`query` 最多 8 个空白分隔词；`limit` 为 1—50。时间窗口默认为 `all-visible`，另外支持 `90-days`、`365-days` 和 `custom`。自定义格式为 `{"kind":"custom","from":"2026-01-01T00:00:00Z","before":"2027-01-01T00:00:00Z"}`，左闭右开。窗口只根据已经获准披露的活动日期匹配，不以隐藏事件时间选择条目。匹配到一次可见活动后返回该经历的完整可见上下文，不将窗口外的必要版本解释静默删掉。

`capabilityId` 匹配已授权 Task 的明确能力类别声明，不能证明实际能力。文本匹配限于当前可见字段；环境显示匹配、不同或未知，不计算模型向量相似度或全球排名。`context.taskId` 仅说明与调用者提供的参考任务是否同一，不替调用者取得 Task 权限。

## 返回及事实含义

`items` 分为 `case-history` 和尚无可返回 Case 事实的 `task-history`。Task 发布、确认参与、撤回和交付历史各自有实际来源。仅发布或确认参与不能推导为完成工作。历史为空不会因“零履历”自动禁止开放协助，账号、限额和付费资格仍由相应模块按实际条件判断。

Case 条目包含真实 `attempts`、`interventions`、`results`、`responses`、历次 `resolutions`、当前 `resolution`、`verificationRecords`、可用旧 CI `proofs`、`collaborations` 和来源事件。每个事实保留原执行者或报告者，未取得执行者的旧 v1 Attempt 标记 `unknown`。报告者与执行者不互相代替。诊断、补丁、复核等不同参与者的事实不全部归到最后交付者。

Result 的 `reportedOutcome`、接收具体版本交付的 `acceptance`、限定范围 Verification、任务范围 Resolution 分开。CI Proof 沿用原服务的签名、源状态和精确观察校验，证明范围仍仅是其引用的 CI 执行。自声明 Profile 单列 `selfDeclared` 与 `selfDeclaredSource`，最新声明不可见或撤销时不回退旧公开声明。

同一对象的可见历史版本保留，`currentVisibleVersion` 明确只指调用者当前能看的版本，不泄露隐藏版本数量。旧 Result 被可见更正替代后，引用它的历史 Resolution 可以继续被读到，但标记 `currentDecisionAvailable:false` 与 `currentSupport:referenced-result-superseded`，需要重新审阅，不作为新的有效结论。Verification 的版本、过期、目标改变、依赖撤回保留原服务判定。

Case 总事件版本、Task 总版本、内部预期版本、全库或全主体计数不进入公开履历及游标。`coverage:current-visible-page` 明确当前返回的页；`sourceScan:all-candidates-for-specified-subject` 表示本次为确定可见页及摘要扫描该主体全部候选，没有沿用旧 20 条关联或 200 个候选的静默截断。具体条目中的来源事件仍有现有 Case 1000 事件上限；本切片没有取消业务已有写入上限。

## 纠正、撤销、删除与游标

数据每次从当前有效的 Consent 和绑定状态重建。未授权来源不先参与文本匹配、条目计数、游标或摘要。撤销介入后，其依赖 Result 和 Verification 的正文不可继续显示；可独立授权的其他参与者事实保留。历史交付的精确引用及接收事实可以留下受控元数据，依赖消失时交付摘要和接收摘要同时去掉，显示 `resultReferenceStatus:unavailable`。M19 删除继续由生命周期模块执行，这里不维护第二份永久履历缓存。

`affectsAttemptIds` 是现有写入格式。为避免后续私有 Attempt 更正反向改写旧介入的关联，投影按介入事件被接受时已经存在的 Attempt 版本解析，并显示 `affectsAttemptRefs`。其来源被撤权或物理删除时不能变成独立事实。该修订只补实际历史依赖，不重写旧事件。

游标绑定规范化查询、读取者和当前匹配的可见内容摘要，作为分页位置，不作为授权凭证。增加完全隐藏的无关事实不应改变公开游标。可见内容改变时返回 HTTP 409 `history_sources_changed_retry`；调用者保留筛选条件，清空 `after` 重新读取第一页。使用不同读取者或不同查询的游标返回 `invalid_history_cursor`。检查时间不写入摘要，避免无变化时游标无故失效。

## 复用、边界和后续关联

- 复用 M03 当前事件和逐来源授权、M06 Evidence/Verification 与旧 Proof 校验、M11 Task/Participation 的实际授权记录、现有 Profile 最新声明规则。
- `CaseService.readV2Within` 为 M19 同事务导出提供原有受控读取。内部 `projectAuthorizedWithin` 只提供逐来源投影，调用者仍须执行自己的入口授权。
- 没有新增数据库表、公开写接口、后台重建队列或模型服务。当前按一个主体扫描全部候选；大履历的检索索引、嵌套历史分段和性能优化需以后保持相同授权语义，不能把静默截断冒充完整。
- Capsule 的实际应用/复验投影、Honor 和付费资格判定、发现排序及网页完整履历体验仍属于相应后续工作包。当前 API 存在和自动测试通过，不表示这些下游产品已经完成或公开上线。

验证使用真实本地服务、独立签名主体及数据库，不把合成案例算真实履历试点。测试覆盖多人贡献、无履历入场、接收/验证/解决分开、来源撤回、隐藏事实不影响公开游标、可见更正过期游标、Profile 不回退、版本绑定及超过 200 个候选的分页。真实 PostgreSQL `galaxy_api` 与 HTTP 组合测试另有 `test/postgres/history-v2.test.mjs`，通过情况以实际运行记录为准。
