<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/f9/f9b37cb9485a71dd7f688bce10568516032c3d3dfaa945620f28c0362d3dee29.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 本地 Case 发布映射

`packages/galaxy-official/src/local-case-publication.mjs` 是宿主内部本地存储组件，不进入纯网络客户端包。它不联网、不读取密钥，也不创建 Consent。

- `listLocalPublicationCases(dataDirectory, endpoint)` 只读列出本人的本地草稿与该端点的映射状态。
- `prepareLocalCasePublication(dataDirectory, endpoint, localCaseId)` 在现有本地写锁内保存待提交事件，返回 eventId、原始 payloadJson 与 payloadHash。相同身份/端点/本地 Case 重复调用复用已保存内容，后续本地修改不悄悄改变授权对象。
- `recordLocalCasePublication(dataDirectory, endpoint, localCaseId, receipt)` 由宿主在 CaseClient 回执检查成功后调用；只接受匹配原事件的首版 Case 回执。acknowledged 是曾收到确认，不代表持续在线、公开发布或目前未撤销。

记录保存在现有本地状态的可选 `casePublications` 字段，随本地导出保留，使用原子文件替换。不同端点分别分配事件 ID，来源引用使用身份/端点/本地 ID 的散列。未改动原本地 Case 的 localOnly/status，也不把本地 Proof Draft 变成远程 Proof。只映射 title、failureSummary 和本机身份为 requester；attemptedApproaches 没有真实执行事件，因此不自动生成 Attempt/Result。

本组件已覆盖并发准备、重复读取、端点隔离及回执匹配的自动测试。

## 发布组合流程

`createLocalPublicationFlow`（local-publication-flow.mjs）组合本地映射、ConsentClient 和 CaseClient。宿主注入 sessions、本地 signIntent 及数据目录；`list()` 列出草稿，`prepare(localCaseId, {visibility, viewers})` 保存首次 Consent 意图，返回准确 intentJson、payloadJson 和统一 confirmation。默认 Private；Public 必须显式指定，其用途为 public-profile。授权有效期最多一小时且不超过绑定有效期。

用户确认同时显示的授权与 Case 后，`execute` 顺序创建 Consent、提交 Case、记录回执。两次远端操作之间检查同一会话，取消不自动推进下一步。此过程不是远端原子事务：Consent 成功而 Case 未提交是可能的中间状态。重试仍使用已保存的 Consent ID、意图和 Case 载荷，既有服务端幂等处理重复请求；不自动重新授权、换 ID 或扩权。

已确认的 Case 要通过后续 revision 修改。保存后的可见性/查看者不自动改动；过期授权、绑定变更及超出 Consent 新建签名时间窗口（当前五分钟）的未知结果需要后续对账流程。当前不会借重试绕过这些边界。网络失败时保留原记录供对账。

对账现已提供 `flow.reconcile(localCaseId)` 和宿主 `controller.reconcilePublication(localCaseId)`。读取原Case的首版根事件，与冻结载荷逐字段匹配后恢复本地回执；不执行远端写入。返回 acknowledged、mismatch、unknown 或 not-prepared。404、授权失效等读取失败均不被解释为“未提交”。原事件已成功但响应丢失、内容不一致、不可读及取消已纳入测试。开发版草稿可见性菜单对已准备记录显示“核对已有提交”。

若原Case因Consent过期而无法读取，对账仍是unknown；本批不自动替换授权或重新发布。恢复本地回执仅确认原事件存在，不代表Case后续未被撤销或修正。

宿主运行时已组合发布流程。controller 提供 `listPublicationDrafts`、`preparePublication`、`executePublication`，和其他操作共享取消/互斥。签名器在本地读锁内校验当前身份、授权及已保存的精确 Consent 意图，再用本地密钥签名；只允许 Case 发布意图。不会暴露通用签名接口。

开发版 Adapter 在当前会话含 consent 和 case-teaser 时显示“发布本地草稿”。列表每页8项，可选择私有（仅本人）或公开，然后一次确认完整授权和载荷。已确认草稿不再列为待发布；外部注入已授权草稿的旧入口仍兼容。

隔离集成测试现已使用实际本地初始化生成的密钥完成连接、Consent签名/服务验签、Case写入、公开履历读取和回执保存；界面替身测试覆盖草稿选择、可见性和确认。当前12项受影响测试通过，补充界面流程也已复测；lint及Adapter类型检查通过。这是可执行源码链路，未安装到用户全局OpenCode，未连接生产端点，真实宿主视觉/键盘验收仍待完成。历史fixture签名测试仍保留用于响应丢失恢复。
