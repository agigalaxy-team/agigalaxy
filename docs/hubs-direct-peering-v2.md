# M22：结构化社区与获准材料直接互联

本切片提供可执行的 Hub Charter、受控加入、私密受理和 `galaxy-direct-proof/1` 双方直连。它保留旧 `galaxy-hub/1` Manifest、Builder 登记、兼容报告及其原签名含义。迁移 68 只追加九张表；旧迁移与旧记录不改写。真实独立运营方试点、参考 Hub 的实际成员规模及自治网络形成没有因本实现或自动测试而成立。

## 产品依据与范围

项目权威来源：`02-architecture/redesign-v1/packets/M22.md`、对应 JSON 阅读包、PWP-M22、`volumes/13-protocols-open-ecosystem.md`，以及 `C-Q-federation`、`C-Q-reference_hub`、`C-Q-hub_charter`、`C-Q-builder_scope`、`C-Q-worker_pack` 五项授权代选。实现前记录位于项目 `07-logs/development/hubs-v2.md`。

原架构 §221–229、§362–370、§614.22–26 保留：Official 可选，Hub 有自身规则与成员价值，Bridge 保持外部来源和强度，直连优先，Proof／获准摘要交换不等于 Raw Task 全量复制。历史 v1.3 快照 `01-intake/traceability/snapshots/b2/b25a0308fb651a3336334dda091e9d8be07d8698c4f515321bfc3c12c099af3c.md` §9.3.7（837–913 行）区分主网络、参考 Hub、第三方 Hub 和可选 Relay。卷13.30、13.32–34将首批落在受控直连、结构化 Charter 和真实范围验收。

M01 的当前主体控制继续由真实 Access／绑定检查处理。加入 Hub 不重建 GUID，不给成员全部 Task 或房间权限。M06 的 CI Proof 仍由原服务签发，主体是其描述对象，并不是签发者。M19 的本人导出、当前可读与再披露分别处理；M21 的 `trust-package-only` 专用许可不能用于本互联。

## 当前可以完成的流程

1. 运营者先登记现有 Builder `type:hub`，再签署精确声明 ID/hash 对应的结构化 Charter。22项条款分别保留文字、日期、声明／报告／未知状态；报告只能引用当前可读的同一 Builder 报告中的具体检查。报告通过不生成第三方认证。
2. 用户浏览公开 Charter，或打开自己当前有权读取的明确 Hub。运营者给本服务已有主体发出邀请；成员预览当前 Charter 和范围，可缩小接受、拒绝或退出。运营者可移除本次范围。新 Charter 不自动扩展旧成员同意，旧成员需要退出／移除后按新版本重新邀请。
3. 可读 Charter 的已绑定用户可向运营者提出私密问题；作者与运营者分别写入自己的回复。每条正文都由自己的 Consent 决定是否可读。这里是实际私密受理通道，没有虚构邮箱、外部团队回复或响应保证。
4. 两个端点的运营者通过各自本地签名，分别接受完全相同的互联 JSON。端点、Hub、运营者、选定公钥、版本、来源种类、到期、频率和回应窗口均属于约定。只有实际往返签名查询通过，才返回 `remoteApproval:verified-for-this-current-query`。
5. 来源控制方选择自己实际拥有的当前来源，预览有限内容，为明确对端与明确请求者另签逐来源许可。用户通过已加入的本地 Hub 查询，对端仅返回该请求者获准内容。本地用户模型解释与选择材料；服务不调用云端模型。
6. 撤销源授权、删除正文、撤销许可、退出相关成员范围、Charter 或互联约定失效都会停止后续当前查询中的使用。对端离线返回未知与空结果；没有旧回复缓存、Relay 回退或“仍然有效”的推测。

### 可交换的首批来源

| 来源 | 输出 | 强度边界 |
|---|---|---|
| 原生 v2 CI Proof | 原签名、原 issuer、精确 ID/hash、来源键、观察时间与有效期 | 原始观察保持字节与来源；不成为独立专家审核、解决结论或本地原生事实 |
| 作者选定贡献摘要 | 精确事件 ID/hash、本人 ID及明确选中的非叙述字段 | 仅作者声明／事实投影；不包含标题、任务背景、Case／Task正文或他人消息 |

贡献字段限定为 `eventType`、`actorId`、`role`、`interventionTypes`、`scopeVersion`、`reportedOutcome`、`time`；前两项是署名和类型所需。诊断、失败分析等可以出现，并未被缩成成功记录。共享不代表成功复用。合成标记沿原事实关系传播，不能确定时为 `null`，不会自动转成真实案例。

CI Proof 要求本服务确为原 issuer，原 Proof 的当前可见授权与新增对端来源许可同时成立。对其他 issuer 的 Proof、任意外部 Evidence、聊天全文、TrustPackage 专用许可，当前没有建立隐含转授权通道。Bridge 的通用导入目标保留为后续接口扩展，首期并不宣称所有来源适配完成。

同一数字仓库、Run、Attempt的 Proof 保留共同来源键；不同副本不会增加独立证据数量，矛盾的提交或结论会列入冲突。外部返回使用有限字段严格解析；即使签名正确，多余原始上下文或伪装为不可用状态的正文也会拒绝。

## 接口与签名

本地 POST 使用现有 `builders` scope 和真实当前主体。所有写入只接受 `{consentId,payloadJson}`，`hub.publish` Consent 与精确原文、操作 ID、主体、接收端、字段和期限匹配。MCP 不会以模型 `confirmed` 字段代替签名。

| POST路径后缀（`/v2/hubs/`） | 行为 |
|---|---|
| `status`、`read`、`query` | 状态、精确 Charter、分页；可匿名，错误凭据仍拒绝 |
| `manage` | 本人实际最新版本及管理状态；旧正文失效时不回退恢复 |
| `events`、`receipt` | 写入和原操作摘要核对 |
| `memberships`、`intake` | 本人或运营者当前可读范围 |
| `peering/party` | 运营者当前服务公开字段与公钥，不含密钥 |
| `peering/connections`、`peering/list`、`peering/read` | 成员可用范围／本人管理列表／本人原约定 |
| `peering/sources`、`peering/preview` | 本人可选精确来源与实际披露预览 |
| `peering/events`、`peering/receipt` | 精确约定、来源许可及撤销，原回执恢复 |
| `peering/query` | 以真实调用者查询；不允许传入另一个请求者身份 |
| `peering/exchange` | 双端 JWS 专用，按双方明确约定验证，不建立本地用户登录 |

HTTP映射集中在 `src/adapters/http/hub-http.mjs`；17个 canonical MCP工具集中在 `src/personal-mcp-hubs-v2.mjs`。分页返回实际游标；最多20条且受38KiB项目内容预算限制，剩余待复核项明确列为 `deferredRecheck`。已显示回复只在短期核对窗口内成立，使用前应按选定 grant ID重新核对。读取和重试不会延长期限。

固定跨端路径只允许公共 HTTPS、固定DNS解析绑定、有限超时和响应体；不跟随跳转，不带本地会话凭据、Cookie或 A2A 凭据。新 `hub-peering` JWS 类型仅用于本范围，由现有 Jose／签名服务实现。选定对端运营者的范围内身份断言不等于全网同步身份控制或官方根身份体系。

## 网页与回执恢复

`HubsWorkspace({runtime,subjectId,connected})` 内含 `HubPeeringWorkspace`。普通用户看到社区规则、邀请、私密问题、可选直连材料和本人来源；运营者看到版本化条款、公开身份字段和可共同审阅的技术约定。技术约定完整 JSON保留可复核性，未采用的示例不会自动成为能力声明。

`hubs-client.mjs` 使用现有 BrowserClient、真实本机签名和本机存储。授权原文先持久化再发送；丢失响应后只核对原 ID/hash，只有明确选择重试才重发原内容。身份或端点改变后旧操作不会转投新主体／服务。取消预览不发布；放弃本机重试前核对已接受操作，不能把已完成远端操作写成已取消。

网页邀请当前采用明确的短期受控范围；API允许运营者指定不超过原授权和30天的期限。`member-updates` 当前提供本人范围更新的查询，未承诺单独的消息推送。独立普通聊天与任务评论仍各有自己的入口及权限。

## 数据生命周期与兼容

迁移68新增：`hub_heads_v2`、`hub_events_v2`、`hub_memberships_v2`、`hub_intake_v2`、`hub_peering_agreements_v2`、`hub_peering_events_v2`、`hub_peering_grants_v2`、`hub_peering_changes_v2`、`hub_peering_receipts_v2`。声明父对象仍在原 Builder 表。全部加入 M19 本人导出、删除目录和实际资源预算。

私密受理正文自首次打开起90天，到期只读入口立即隐藏，现有 worker 每分钟调用的有界生命周期维护清除正文。受理最小元数据在到期后180天清理；查询回执自首次创建起180天清理，不保存回复正文。期限属于现有临时沟通／操作回执类别的技术细化，不冒充原用户逐字段指定的天数。

删除请求挂起后其他读者不能继续使用来源；执行时清理本人事件和许可，暂停本人运营范围。独立成员、回复或来源引用留下必要外键时，仅保留源 ID/hash与最小状态，清除删除者原文；不会用外键存在证明正文仍可读取。外部主动保存的副本不被描述为已删除。

私密受理事件通过可延迟外键明确关联线程。提问者删除后，线程关闭且原提问事件可以删除；独立运营者回复保留所需的无正文线程元数据，仍能由其作者查询及导出。该反例已经实际 PostgreSQL 审批删除流程验证，不能用孤立事件“仍在表中”替代可用性。

## 必要验证与实际限制

- 实际签名服务／HTTP：双方独立测试数据库、正确与缺失双边许可、精确原请求者、CI 原签名、作者非叙述摘要、源撤销、删正文、离线、重复查询冲突、拒绝带多余正文的已签回复。
- 实际 PostgreSQL `galaxy_api`：上述接口及精确授权；`galaxy_evidence_worker`：到期维护；M19：新数据导出、已批准删除、保留独立成员原文并清理删除者被外键留住的正文。隔离测试库已关闭删除。
- 实际 BrowserRuntime／本机签名／HTTP：Charter和互联写响应丢失后查询原回执，没有重复提交；严格 TypeScript检查通过。

这些是合成夹具和实现证据，不是实际独立运营方互联验收。未启动真实第三方Hub、真实成员冷启动、任意Bridge源映射或Relay服务；没有启动备份。公开部署与用户体验验收另由当前发布流程记录。

## AI Agent部署说明

使用现有发行与追加迁移流程部署包含68的服务；不要改旧迁移、直接重写旧 Manifest 或把测试数据库复制到生产。API角色追加最小Hub业务表权限；现有受限worker只承担到期受理／回执维护。没有新增云桶、图数据库、模型服务或采购。

先从当前代码与服务装配确认 `hubs`／`peering` 和专用签名类型，再核对现有发布端点、公钥和当前运行版本。创建网络约定前核对两端运营者、实际Hub声明与精确版本；本方Hub登记端点必须等于实际服务端点。公钥来自明确选择的对端信任渠道，不能由未经核对的地址自行建立信任。不要把运行探针当作专业能力证明。

常见失败：`peering_local_endpoint_mismatch` 表示登记不属于此服务端点；`peering_scope_changed` 表示双方版本/hash不一致；`charter-reconfirmation-required` 需要按新条款重新邀请；`unknown` 表示本次尚不能确认对端或来源。旧响应、过去自动测试或仅有静态页面都不能消除这些状态。
