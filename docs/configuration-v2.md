# 配置版本与来源权限 v2

本次属于 NEW-M03-FLOW-FACTS、M02 选定披露与 NEW-M05-FLOW 的计划内差额。配置的关键条件是主体报告，不是银河替用户扫描安装状态或运行模型。当前源码追加 schema63；线上状态由独立发行记录说明。

## 依据与采用层级

- 项目原始 Core v3.1 §13—15：Attempt 需要说明是谁、在什么能力状态下工作，包含 configuration_id 与模型、工具、Skill、MCP、运行环境等条件。历史 DB-006 node_configurations 定义不可变配置版本。出处：项目 `01-intake/source-documents/GALAXY_CORE_ARCHITECTURE_v3.1_COMPLETE_CORRECTED.md`，`01-intake/traceability/imported-freeze/GALAXY_DATABASE_EVENT_STORAGE_DESIGN_v3.1.md`。
- 现行授权代选 A-Q-10（CUR-33），卷05 A-05-03、PWP-M03：公开或选择披露关键条件，原始私有详情留在用户端，版本引用和指纹可选；缺失应显示未知。配置和输入权限版本引用属于需要增量实现的差额。
- B-06-Q03 / PWP-M05：实际选定来源复用明确现有许可，来源可读不能替代他人授权，不把署名变成共同批准。PWP-M02 的精确材料、接收者与现行权限规则继续有效。
- CUR-35 授权本轮业务实现；字段组织、两表与控制撤回机制属于此次技术细化，不称为用户逐字段原话。

## 两种引用

1. `Attempt.configurationRef:{id,version}` 记录这一段尝试采用的条件版本。写入时该精确版本必须存在且可读；后续配置的新版本不会改变原引用。读取增加 `configurationCondition`：当前许可可读时返回所选条件，不可读时给出 reference、sourceStatus、conditionsKnown:false 和未知含义。独立 Attempt/Result 不因此消失。无配置照常工作。
2. `Intervention.sourceRefs`、`Result.deliverableRefs` 中的 `{kind:'configuration',id,version}` 明确将选定元数据当作内容来源。当前来源撤回、删除或授权失效时，这一派生内容不可再通过 Case、Verification、Capsule 返回。它与仅比较条件的引用有不同责任。

Capsule 的显式 configuration 来源没有 caseId。来源适配定位到该版本的真实作者；其他作者需要实际 `capsule.permission` 覆盖对应精确版本与采用范围。本人选定内容由其精确发布 Consent 覆盖。已有许可可重复用于其允许范围，不增加无依据的重复审批。Attempt 的条件引用不会被悄悄加入 Capsule 的配置正文依赖。真实配置内容中的合成标识不能被 Capsule 当成真实来源；外部文件、prompt 与 Skill 正文的权利不从元数据推断。

## 对象、版本、接口

`configuration_objects` 保存稳定 id、subject_id、当前版本和 active/revoked 状态；`configuration_events` 按 operation_id 保存不可变版本、kind、subject_id、consent_id、payload_text/hash、接收时间。只有对象头可由 API 修改；事件不能通过 API 任意更新或删除。旧迁移、原事件和合法数据均不重写。

`ConfigurationServiceV2(access,consents)` 提供 `readWithin(db,actor,{id,version?})`、`requireReferenceWithin(db,actor,{kind:'configuration',id,version})`、`conditionWithin(db,actor,ref|null)`。Case 使用类型路由：Evidence/Verification → 原验证服务，selected-message → 原聊天精确消息读取，configuration → 本服务；其他类型明确 unavailable。

| POST 路径 | 输入与结果 |
|---|---|
| /v2/configurations/events | consentId + payloadJson；record 或 revoke；精确回执含 id/version/operationId |
| /v2/configurations/read | id、可选精确 version；当前授权正文或作者最小管理状态 |
| /v2/configurations/query | subjectId?、after?、limit≤50；逐对象授权后分页，不用不可见对象作为游标 |
| /v2/configurations/versions | id、afterVersion?、limit≤50；逐版本当前权限，不自动替换所选旧版本 |
| /v2/configurations/receipt | 本人 operationId、payloadHash；absent/acknowledged/conflict，ack 不等于仍可读 |

沿用 history scope；写入要求 `configuration.publish`，Consent.objectId 为 operationId，精确 payloadHash、来源绑定、当前身份控制、披露范围与 bytes 都由既有服务校验。Public 只公开用户明确选定的元数据；Private 为本人及列出的接收者。并发以对象头版本检查和同事务写入处理；重复操作只接受原有同一 payload/Consent。

record 包含 schemaVersion=2、id、operationId、expectedVersion、actorId、title、summary、conditions、observedAt、synthetic、selectedFieldsOnly=true。conditions 包含 model/runtime/environment 的 name/version（明确 null 表示未知或未披露）、tools/skills/mcp 的选定标识与版本、promptPolicyVersion、rulesVersion、operationScope、inputScopeSummary、可选 SHA-256 指纹、limitations。操作范围和材料摘要仍只是报告，不提供真实权限或材料读取能力；真实选定材料继续由 Context 授权。

严格 Schema 不接受额外 prompt/文件正文/凭据字段，字符串沿用选定文本约束；不读取环境变量、本地密钥、全量目录或不明确选定的 Skill。服务器不抓取标识所指外部 URL。输入保持未知时不能从客户端品牌推断模型、权限、安装或能力。

revoke 使用新 operationId、当前 expectedVersion、reason；对象停止提供所有内容版本，旧版本只留其当前允许的状态。撤回原 Consent 和撤回整个对象分别成立。撤销账户删除请求恢复原本仍有效的可见性，不永久撤销它们的 Consent。原 Consent 不可读时，作者仍可获得对象头版本以撤回，不从管理入口泄漏失效原文。

## 客户端与用户模型

`ConfigurationWorkspace({runtime,subjectId,connected,navigate})` 接在 /app/configurations。表单明确选定条件、观察时间、合成标识、披露与已接受联系中的接收者；预览后提交，旧版本可选择、可据其追加版本，也可撤回对象。草稿只显式保存在本机。用户模型选择何时有必要登记，不要求每个任务都有配置。

FactWorkspace 的尝试表单提供可不选的条件版本；介入与结果另有明确内容来源选取。Capsule 创作和来源许可区也可以选择独立配置的精确版本。无可读结果显示空或未知，不让用户手填虚假 hash/对象。普通聊天不转换成 Task。

配置和 Capsule 共用既有精确操作日志机制，按独立类别、endpoint、subjectId 分区。先持久化原载荷及签署的 Consent，再发送；丢失 ACK 后查原回执，重连复用已经接受的授权，不重发另一业务 ID。停止本机重试仅清除本机可重发正文和签名，保留最小对账信息，不能声称服务端在途请求已取消。

## 导出、删除、容量与保留

M19 登记两表，按 subject_id 导出本人所选元数据及原事件。它们没有第三方正文快照，不使用强制云同步或备份。核心条件事实不新增无依据的自动 TTL；正常读取仍受每份 Consent 的截止、撤回与账户待删除可见性控制。删除执行按现有子表先于父表顺序清理本人对象与事件；如果独立引用需保留最小回执，由现有清理记录说明原 hash 和原因，清除的正文不能再称为原签名可重验。

引用位于独立作者的事件 JSON 中，没有强制删除他人 Case 的外键。原作者删除后，其他人的基本工作与独立声明保留，但比较条件变为 unavailable，明确内容依赖不再返回。预算计入对象固定元数据及事件实际 bytes，审计记录绑定、凭据 scope 与精确 Consent，不记录密钥。不存在本轮新增的后台备份。

## 验证与发行

实际受限 PostgreSQL API + HTTP + createBrowserClient 关键流程：1/1，3518.9435ms；隔离集群清理回执 removed:true。覆盖对象写入、幂等、额外字段/冒充拒绝、旧版不漂移、私有新版不公开、配置权利链、来源失效传播、待删除取消恢复、本人导出、真正删除后独立工作保留、丢 Consent ACK/重连原授权、丢业务 ACK 查询原操作。客户端存储使用显式内存替身，此项不冒充真实 IndexedDB 验收。

共用 Capsule 日志的受影响回归与配置流程测试 2/2；配置、事实、Capsule 组件及依赖的 TypeScript 检查通过。生产浏览器与部署由主代理统一执行和记录，测试不代表真实安装或用户业务成功。

AI Agent 发行时一起追加迁移63、API角色权限、来源路由、配置服务/API/MCP、预算/M19和网页组件；没有63表不启动依赖它们的版本。构建后检查 /app/configurations 路径及无配置协作入口，保留历史发行包，不用模拟成功响应掩盖缺接口。原生宿主仅打开官网或由 Skill/MCP 解释元数据，不需自动扫描宿主私有环境。
