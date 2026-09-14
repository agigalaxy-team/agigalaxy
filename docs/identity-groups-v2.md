# 多身份展示关系 v2：实施切片 72

本切片实现 NEW-M01-FLOW 的身份组差额。使用者可在同一所选 Official 下，让各银河身份的当前管理设备分别确认同一份准确内容，选择 canonicalDisplayId、可见范围及选定记录的展示归属。它不会修改 GUID genesis、原始事实 actor、原签名、Account 分组、配额、绑定、房间控制方或来源 Consent。

## 已采用依据与范围

完整定位：[M01 阅读包](C:/Users/USER1/Documents/ChatGPT/projects/active/银河项目/agi-galaxy-network/02-architecture/redesign-v1/packets/M01.md)、[M01 实施工作包](C:/Users/USER1/Documents/ChatGPT/projects/active/银河项目/agi-galaxy-network/02-architecture/redesign-v1/predevelopment/work-packages/M01.md:430)、[卷04 身份与情境信任](C:/Users/USER1/Documents/ChatGPT/projects/active/银河项目/agi-galaxy-network/02-architecture/redesign-v1/volumes/04-identity-and-contextual-trust.md)。原文与授权代选的层级沿用这些来源登记。

- 完整产品方案卷04 A-04-10、A-Q-06 采用决定，以及 PRE-M01-S4 / PREP-API-M01-GROUP：双向持钥、准确预览、版本化 create/revise/revoke、canonicalDisplayId 与归属更正。
- 原始架构第57、58节：多设备声明关系、原始 provenance、后续更正事件。原始第57节曾列外部证据/人工审阅选项；当前采用决定收窄到双方当前控制证明。本实现不凭邮箱、同名、自报控制或运营者名称认领另一个 GUID。
- 准备包 M01 中当前控制及恢复要求：设备恢复沿用原 GUID 和签名历史。未完成的旧控制批准需要当前设备再次明确批准；已经提交完成的历史关系不会仅因正常恢复而被重写。
- M19：申请删除暂停当前关系投影；取消申请可以恢复。执行原文净化/删除与成员签署撤回分别记录；外部副本不被描述为已物理删除。

关系不是能力等价认证。没有经历也可建立仅含身份与可见范围的关系。用户可选择原 Case 事件或配置版本，展示视图按原事件/版本去重、按原 Case 分组。没有自动扫描全部历史，也没有将跨身份全部记录加入能力计分。全站其他页面继续使用各自原身份，不能将本切片称作已完成全站 canonical 展示迁移。

## 实际用户流程

1. 当前设备连接既定服务，读取当前 manage-identity 控制。填写至少两个自有 GUID，选择显示 ID、Private/Public 关系范围与可选查看者；可以不选历史记录。
2. 可从自己的精确 Case 事件或配置版本读取来源预览。服务返回真实存储 hash 与原作者，用户不用自行编造 hash。选中更正时显示原签署身份、目标展示身份和原因。
3. 预览准确成员、当前版本、服务、期限、来源及更正。确认后只签署这个操作的精确 hash。第一份有效签名形成 pending 记录，尚不对外形成共同控制关系。
4. 用户在另一个身份的当前设备输入同一操作编号，读取原字节，选择批准或拒绝；发起者可以取消。客户端不复制设备私钥。
5. 服务在同一事务重查所有所需成员的当前设备、控制 epoch、批准期限、来源实际权限和当前版本，全部满足才提交。修订需要原成员和新成员的并集批准；成员退出需要在原关系当前版本发起。
6. 任一当前成员可独立撤回当前展示关系，额度已满时仍允许这一控制操作。后续读取停止给出当前 canonicalDisplayId；原事实和其他作者签名保持其历史归属。
7. 丢失回执时保留 operationId、proofId、原字节与本机签名。重连先查询精确 receipt。服务已接受此批准就不重复写；换钥需要重新预览并确认同一原操作，不能静默替换 ID 或扩大范围。
8. “停止本机重试”保留对账编号，只有明确的 cancel 操作回执才能描述为服务已取消。其他成员可能已经提交，不能用 absent 推断永久取消。

## 签名与当前控制

签名类型为 `galaxy-identity-group-v2+jws`，使用既有 jose Ed25519 Compact JWS。`proofJson` 包含 subjectId、keyId、epoch、operationId、groupId、payloadHash、服务、批准/拒绝/取消、签署及截止时间。服务校验的原文是收到的精确 proofJson；外层 payloadJson 由签入 proof 的 hash 精确约束。

每份批准保留独立 proofId、原签名、公钥、epoch 和控制链头。后续恢复不会覆盖旧签名。组修订使用 expectedVersion 和 previousOperationId；并发同版本修订只允许一个提交，另一条保留 conflict 回执。没有将共享账号认定为另一份独立持钥批准。

创建/修订批准最长24小时有效，单人未完成提案上限20属于存储/请求控制，不是触发银河的模型尝试阈值。过期提案不能激活。正式关系一直保留至撤回或来源删除；退出/过期的最小原操作与独立批准回执按180天窗口清理。原操作只含关系选择、来源引用/hash、展示更正原因，不包含原 Case、配置或聊天正文。

## 接口与客户端接线

全部接口位于 `/v2/identity-groups`，当前已装配 services.identityGroups。

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | /current | 当前实际设备的 manage-identity keyId/epoch，需 binding |
| POST | /source | 选择本人当前可读来源，输入 kind/id/version 与 Case 必需 caseId，返回精确 ref/record |
| POST | /submit | 严格 payloadJson、proofJson、signature；当前签署身份取认证 |
| GET | /operations/:operationId | 仅原提案者和所需批准身份读取原提案及回执 |
| POST | /receipt | operationId+payloadHash 精确对账，不借此授正文访问 |
| GET | /:groupId | 当前关系视图，匿名可读仅限公开关系，逐源重验权限 |
| POST | /query | 当前有权查看的关系，按 subjectId/after/limit 分页 |
| POST | /resolve | 按原 GUID 查当前关系；返回可能的多个显示 ID 与 ambiguous，不擅自挑一个 |

source 和关系 source 投影继续要求相关读取范围，关系 binding 本身不授 history/case-teaser 权限。公开关系中的私有来源显示 unavailable，原作者仍可按实际来源权限读取。来源撤回、删除或精确 hash 不再可核对时不能借历史批准恢复内容。

`createIdentityGroupClientV2` 在 `src/identity-group-client-v2.mjs`，注入 `{api, sign, getLocal, putLocal, subjectId, now?, locks?}`。`sign(proofJson,type,{subjectId,keyId,epoch})` 只能使用实际当前本地设备匹配的钥；不应复用可签任意类型的宽代理。客户端方法包括 current/source、prepare、prepareResponse、execute、pending/reconcile/retry/reviewPending/stopLocalRetry、proposal/read/query/resolve。

MCP 工厂 `identityGroupToolDefinitions(services,actor)` 位于 `src/personal-mcp-identity-groups-v2.mjs`，提供上述8个 canonical 工具。工具不会代模型决定建立关系，不因普通查询重复要求确认。

网页独立组件 `IdentityGroupWorkspace` 使用 props `{runtime,subjectId,connected,navigate,initialOperationId?}`，消费 `runtime.identityGroups`。主代理已将它接入 `/app/settings/identity`，可用 `identityGroupOperation` 查询参数填写原操作编号；网页和原生 runtime 使用独立的 `createIdentityGroupDeviceSignerV2`，不会扩大 TrustPackage 签名白名单。当前组件包含提案、不同身份批准/拒绝、修订/移除成员、精确来源预览、更正、撤回、分页和原回执恢复。源码接入不等于生产发布。

`integrations/native-v2/identity-group-tools.mjs` 提供4个高层工具：`galaxy_identity_group_native_prepare/execute/cancel_preview/recover`。prepare 可以处理完整新意图、原操作的 approve/decline/cancel 或明确换钥后的原操作重审。execute 将整个准确 preview 交给既有真实 MCP elicitation/本机 loopback 审阅页；工具参数不接受模型填写的 confirmed，也不返回私钥或原签名。没有表单能力时仍使用已有浏览器衔接，读和原签名对账不额外弹确认。server 的独立注册和清理已接，新源码需要纳入下次不可变原生候选，不改旧签名包。

## 数据、删除与部署

追加 migration72：`identity_groups_v2` 当前头；`identity_group_operations_v2` 精确操作原文；`identity_group_approvals_v2` 独立不可改签名记录。1–71 迁移未重写。API 只可追加批准，不能改写 signature；worker 只可做保留清理，不能激活身份关系。现有资源预算计入三表各自实际作者的字节占用。

M19 导出只含本人创建的头、本人提案及本人批准，不导出其他作者签名或原材料正文。叶删除受到其他作者 FK 约束时，保留其关系指针但净化本人提案内容，设置 source_erased_at；这表示来源删除，不伪造成员 revoke。关系共同回执180天后按依赖顺序清理。全服务实际执行由既有 M19 通道调用；本切片测试执行了该实际主库删除通道，确认本人的批准行已删除且另一作者原签名保留。测试仅使用临时合成主体，不能描述成真实用户删除案例。

AI Agent 部署接手：保持原服务配置、数据库追加迁移及 API/worker 分工；当前设备签名在客户端完成，服务器不接触其私钥。先确认 migration72、角色 grants 和 services.identityGroups 都在同一发行包，再核对客户端 dedicated signing type。不要把旧客户端包、源码组件或测试数描述成宿主已安装/生产已支持。部署与新原生包签发由主代理统一执行。

## 已取得的验证证据

2026-09-13：PGlite实际HTTP流程1/1通过；最终受限 PostgreSQL `identity-group-v2` 流程1/1，4441.7351ms，隔离集群清理 `removed:true`。覆盖双当前控制、错误代签拒绝、源预览真实hash、原 GUID/正文不变、私有来源不授予他方、同版本两修订只有一个提交、撤回与拒绝/取消、真实 recovery epoch2 后旧待确认签名失败且重新持钥批准有效、旧签名保留、来源撤回、存储额度拒绝但撤回可用、删除申请可取消、本人导出、实际主库删除及独立作者签名保留、原文净化及180天清理、API/worker不能改签名或激活。

createBrowserClient 经实际HTTP丢ACK与重连验证，业务写入1次、身份组签名1次。新增 `identity-group-web-v2.test.mjs` 直接执行已接入的 createWebRuntime：两个独立实际 WebCrypto 设备钥、变更预览被修改时拒绝、关闭/重建 runtime 后原回执查询、双方批准同一准确字节，1/1通过（5483.336ms）。这些本地 journal 使用 Map，不是新的实际浏览器 IndexedDB/DOM/宿主验收。独立网页组件传递 TypeScript 检查 diagnostics=0。

`integrations/native-v2/identity-group-tools.test.mjs` 启动真实 stdio 进程与真实本机 loopback 审阅页，核对完整成员、Private受众、用途及内容hash；拒绝后组表0行；明确批准后pending；另一实际持钥身份确认同一原文后committed；同一preview重放不重复签署，进程退出后审阅端口关闭，1/1通过（10392.7676ms）。只访问合成本地HTTP服务，付费/模型调用0；临时设备与配置目录已在绝对路径校验后清理。不是八宿主 UI 支持证明。

复现命令：`node --test packages/galaxy-official/test/identity-group-web-v2.test.mjs`；`node --test integrations/native-v2/identity-group-tools.test.mjs`；实际PG设置 `GALAXY_TEST_PG_BIN` 为已安装的 PostgreSQL bin 路径、`GALAXY_TEST_PG_CASE=identity-group-v2` 后运行 `node packages/galaxy-official/scripts/test-postgres.mjs`。生产部署、新包签发和真实用户多设备材料保管须分别记录；这些证据不提升为整个 M01 全部完成。
