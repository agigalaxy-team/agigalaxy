# Context v2：逐参与关系的选定材料

当前代码将 v2 Task 的多个 Participation 分别绑定到明确材料、授权人、接收人、约定版本和期限。它保留 v1 Context 接口及原数据；没有把旧 selected 提供者转换为多个参与者，也没有给全部房间成员共享材料。

需求依据为 [M02 工作包](../../../../02-architecture/redesign-v1/predevelopment/work-packages/M02.md)、[M11 工作包](../../../../02-architecture/redesign-v1/predevelopment/work-packages/M11.md)及卷12的分阶段披露。UXD-015—017保留双边约定、独立材料、明确到期和撤销；四段信息披露不是四次固定确认。实现受 CUR-35 授权，备份仍暂停。

## 已实现流程

请求者选择当前已确认的一个 Participation，预览所选 text/plain 材料、实际收件人及到期时间。用户模型可以建议选哪些内容；服务不采集整个项目，不调用模型、不获取仓库或运行时权限。诊断者与验证者可得到两份不同材料，未提供材料也不代表协助拒绝或违规。

服务检查 taskId、participationId、participantId、scopeVersion、scopeEventId 全部对应真实当前约定。接收者先读取材料元数据，再以其真实 materialsHash 签署接受或拒绝；接受后每次读取仍重新检查来源、Consent、当前参与和期限。读取和接受不自动记录能力验证、任务成功、房间成员或执行权限。

已确认的新范围使旧范围材料不可读，等待对方确认的范围提案不扩大旧授权。active/delivered/accepted 的未终结任务可继续原范围材料读取；争议、退出、参与结束、任务结束和暂停停止读取。其他 Participation 不受同伴范围变更影响。招募到期只影响招募，绝不替代 Context 或交付期限：当前 Participation 没有交付期限字段。

请求者可在原任务或材料已失效后签署撤回，接收者可明确拒绝。原操作 ID 和 hash 保留作为回执，不把历史接收当作当前读取权限。无关身份只能得到不存在或拒绝，不能获得另一位参与者的材料元数据。

## HTTP

全部操作要求当前 `context` scope；写入使用原始 `{consentId,payloadJson}`，Consent action 为 `context.grant`，objectId 为本次稳定事件 ID。

|入口|行为|
|---|---|
|POST `/v2/context/grants`|新建一位参与者的选定文本授权|
|POST `/v2/context/{grantId}/events`|accept、decline、revoke 精确签署事件|
|GET `/v2/context/{grantId}/metadata`|当前材料元数据，不返回正文|
|GET `/v2/context/{grantId}`|当前获授权时返回正文；其他状态给明确状态|
|POST `/v2/context/query`|按 taskId、可选 participationId，最多50条，after分页|
|POST `/v2/context/receipt`|本作者原 grantId/eventId/payloadHash 的准确历史回执|

创建载荷由 `shared/context-v2-schema.mjs` 约束：`schemaVersion:2,id,taskId,participationId,participantId,scopeVersion,scopeEventId,expiresAt,materials`。每项材料是 `{id,label,mediaType:'text/plain',content}`，最多8项、每项4000字符、整个载荷最多40000 UTF-8字节。已知凭据格式拒绝，不能将这种有限检查表述为识别全部秘密的保证。

事件载荷是 `{schemaVersion:2,id,grantId,taskId,participationId,scopeVersion,materialsHash,kind}`。创建的 Private Consent 唯一 viewer 是该参与者；accept/decline 由该参与者签署并唯一共享给请求者；revoke 由请求者签署并指向该参与者。

读取返回 `metadata`（实际 ID、双方、范围版本、材料整体 hash 和期限）、`state`、逐材料列表以及 `contextAccessGranted`。列表不返回正文。完整正文返回时客户端重新计算材料整体 hash。失效、拒绝和删除状态不返回标签及材料正文；两位已知当事人仍能看到必要状态及稳定定位。

## 客户端与模型入口

`createContextClientV2({api,getLocal,putLocal})` 复用真实 browser-client 身份和本地持久化。`prepareGrant(payload)`、`prepareEvent(kind,metadata)`产生本地预览；`execute(preview,{confirmed:true})`才保存并发送。原操作及完整签署 Consent 都在网络请求前保存。

`pending()`列出原操作；`reconcile(operationId)`只查询；`retry(operationId,{confirmed:true})`先查原回执。若原 Consent 已经接受，重连继续使用原 Consent；若服务器确认尚未接受且旧绑定或签署窗口失效，通过 `reviewAuthorization` 展示准确载荷和新授权期限，再由用户明确 `reauthorize`，业务 ID 不变。

`abandon(operationId,{confirmed:true})`仅停止本机重试，清理原文及本机签署材料，保留最小 ID/hash 查询记录。absent 不能排除尚在途请求晚到，因此返回 `serverCancellationConfirmed:false`；后来服务器接受原请求仍可对账。真正撤销已经创建的材料须发送 revoke 事件。

浏览器 Web Locks 在同源多窗口间串行维护同一身份的待发索引；无 Web Locks 的运行环境只有本进程串行能力，不作跨进程写入保证。本切片真实协议客户端测试在 Node 中使用明示的内存存储替身；真实 IndexedDB 的既有测试不能自动证明此新流程的完整跨标签体验。

个人 MCP 新增五个 `galaxy_context_v2_*` 工具，复用同一服务和 scope。模型读取可用数据并解释选择，写入仍需要现有准确用户签署 Consent，不把 OAuth 或工具调用自身当作材料授权。MCP不会替用户制造签名、固定失败次数或集中运行模型。

## 存储、删除与部署

追加 migration59 的 `context_grants_v2` / `context_events_v2`，旧迁移不修改。grant 保存唯一范围和正文，event 只保存原作者接受/拒绝/撤回的准确事件。API角色不能修改原正文、原事件或删除表行；只有 grant 状态字段可更新。正文实际 UTF-8字节及每行固定元数据进入现有主体预算，额度拒绝整笔数据库事务回滚，没有外部传输副作用。

M19 同时登记两表的本人导出、共享引用保留、正文净化和到期清除。grant 到期立即读过滤，Worker依据真实 expires_at 清除正文并记录最小 hash 回执。作者删除不会删除对方独立接受事实；不可恢复原文时不会继续宣称原始签名可用原字节复核。清理不启动备份。

部署者应先应用顺序迁移和 API/Worker 角色，再使用同版 services、HTTP、MCP 与前端客户端。Worker的 `SELECT(erased_at)` 支持到期清除幂等；API不因此获得原文更新权。调用失败时先区分身份失效、材料状态、原回执和临时传输错误，不重新生成同一业务对象。当前独立测试记录只覆盖本地实现，部署与真实宿主状态以主代理实际运行证据为准。

## 验证范围和后续差额

已通过真实 HTTP/PGlite、真实 PostgreSQL galaxy_api 角色、真实 browser-client 协议重连与签名、真实 MCP传输的窄场景。覆盖双人隔离、真实 hash 接受、拒绝/撤回、范围变更、材料期限、招募期限独立、额度回滚、缺失 ACK、原 Consent 重用、显式重新授权及晚到对账。M19专项另记录生命周期验证。

首批完成的是选定文本；仓库资源树的 path/branch/permission、高风险执行授权、文件附件适配仍属可追溯后续工作。本切片没有宣称 M02全模块、全部客户端体验或完整业务已经上线。
