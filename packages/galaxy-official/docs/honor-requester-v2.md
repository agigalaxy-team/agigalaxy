# M08 S3：多方贡献 Honor 与请求方合作事实 v2

2026-09-13，当前可执行服务切片。业务逻辑、HTTP 和 MCP 已实现并在本地实际运行角色核对；不表示真实社区发放过荣耀、启用了榜单、完成网页交互或已部署此版本。

## 依据与边界

本实现沿用 [M08 完整工作包](../../../../../../02-architecture/redesign-v1/predevelopment/work-packages/M08.md)、[模块阅读包](../../../../../../02-architecture/redesign-v1/packets/M08.md)及[卷06](../../../../../../02-architecture/redesign-v1/volumes/06-history-capability-honor-capsule.md)。重点是06.05、06.11—06.13、06.18、06.22、06.25，以及授权代选 B-06-Q02、B-08-Q02、ROOT-Q-RANKING。原始[Core 架构](../../../../../../01-intake/source-documents/GALAXY_CORE_ARCHITECTURE_v3.1_COMPLETE_CORRECTED.md)§24、29、77、210、211、383、435、446、552分别支持：来源和规则、请求者行为历史、贡献与专业资格分离、多种实际介入、发行方和可查依据。

这些是历史正式设计及当前派生设计/授权代选，各自不提升为本轮直接用户原话。原架构的百分位、次数示例没有变成本轮硬门槛。已有真实授权事实自动投影；公开选定成果属于另一次有明确受众和字段的动作。未手动创建履历不抹去实际贡献，普通聊天也不自动变成任务。

## 当前用户得到什么

1. 贡献者可以看到自己或获准查看的其他主体在某个社区、领域、规则版本和时间窗中的实际参与依据。诊断、复核和失败检查可以是已经被请求者接受的有限工作，不要求整个 Case 成功。
2. 请求任务的潜在参与者可以读取当前可见的请求者合作事实：接受、取消、争议、分项反馈和可计算的回应/验收间隔。缺材料标为未知；取消和争议本身不证明恶意。
3. 来源作者可以预览并只公开指定事件的指定字段，取得实时状态链接，随后撤销。公开的是有界贡献投影及指定用途的有界推导，不改变原 Task/Case/消息的阅读权限。

最终解决、交付接受、独立验证、资格、荣耀与排名各自保留含义。相同主体在同一个 Case 的重复参与不会增加不同 Case 数；多个真实主体各自保留实际贡献。`synthetic:true` 的材料只可用于显式模拟输出，实际 `acceptedCases` 和榜单不计入。

## 接线与 HTTP

`createServices` 装配以下真实服务；不要求前端重建聚合逻辑。

| 服务方法 | HTTP | 身份与 scope |
|---|---|---|
| `contributionSharing.ownedSources(actor,{kind,parentId,after?,limit?})` | POST `/v2/contributions/sources` | 本人history；只枚举本人的当前可发布精确引用 |
| `contributionSharing.status(actor,{publicationId})` | POST `/v2/contributions/status` | 本人history；精确发布/撤销回执和当前许可状态 |
| `contributionSharing.preview(actor,input)` | POST `/v2/contributions/preview` | 必须本人，history |
| `contributionSharing.submit(actor,{consentId,payloadJson})` | POST `/v2/contributions/publish` | 必须本人，history；发布/撤销均精确签署 |
| `contributionSharing.readProjection(actor,input)` | POST `/v2/contributions/read` | 可匿名；带凭据时必须有效且有history |
| `honor.v2.query(actor,input)` | POST `/v2/honor/query` | 可匿名；有凭据时history |
| 同上，实时分享状态 | GET `/v2/honor/{subjectId}/{ruleId}/{ruleVersion}` | 同上 |
| `honor.v2.ranking(input)` | POST `/v2/honor/ranking` | 只用公开来源；不会通过传登录者打开私人榜单 |
| `requesterHistoryV2.query(actor,input)` | POST `/v2/requester-history/query` | 可匿名；有凭据时assistance |
| `requesterHistoryV2.facts(actor,input)` | POST `/v2/requester-history/facts` | 同上 |

公开读接口不会忽略无效 Bearer。匿名调用缺少必要公开材料时返回空/缺来源状态，不返回原私有文字。缓存状态不能代替重新查询。`/v1/honor/rules` 和原规则历史入口继续提供规则，带 `sourceProfile: facts-v2` 的规则提示 `requiredApiVersion:2`；使用 v1 查询新 profile 明确拒绝。

MCP 从 `honorToolDefinitions(services,actor)` 接入九个工具：`galaxy_contribution_sources`、`galaxy_contribution_status`、`galaxy_contribution_preview`、`galaxy_contribution_publish`、`galaxy_contribution_read`、`galaxy_honor_v2_query`、`galaxy_honor_v2_ranking`、`galaxy_requester_history_v2_query`、`galaxy_requester_history_v2_facts`。全部复用上表实际服务；模型解释材料和限制，不由银河执行用户模型推理。签署 Consent 仍由客户端的当前控制材料完成，MCP 不替用户伪造授权。

## 贡献发布的完整边界

网页先从本人请求/参与任务选择Task或其实际Case，再调用sources查询取得当前真实Hash；也可输入已知父对象标识。不存在要求用户或模型自己计算猜测历史正文Hash的步骤。每个来源是不可变事件的 `{kind,id,eventVersion:1,payloadHash}`，kind仅 `case-event` / `task-event`。这里eventVersion标识单个不可变事件，不等于 Case 聚合版本或 Result 版本。Hash必须来自当前已授权读取的真实原事件，不能由前端猜测或用原型字段拼造。

每条sourceRef独立选择 `fields`。必须含 `eventType`、`actorId`，可选 `role`、`interventionTypes`、`scopeVersion`、`reportedOutcome`、`feedback`、`scope`、`title`、`summary`、`time`、`caseId`、`taskId`、`participationId`。没有选择的正文和标识不返回；选择文字字段时需按预览检查其中的私人或第三方内容。`feedback` 仅包含清晰度/范围相符分项，反馈正文需要另外选择 `summary`。不允许选择整个 payload、workContext、聊天历史或任意 JSON 路径。

来源作者仅能签署自己的事件，Task 发布者不能代替参与者公开其确认、诊断、交付或反馈。引用的每个必要事件都应有当前原授权或独立有效的贡献投影许可；只有公开 Task 根不足以公开其全部参与者。邀请、申请和竞争者数据不在可发布事件白名单。

以下为**字段结构说明，尖括号需替换成当前真实事件值**，不能直接向服务提交：

```json
{
  "id": "<new-operation-uuid>",
  "kind": "publish",
  "sourceRefs": [{"kind":"case-event","id":"<owned-event-uuid>","eventVersion":1,"payloadHash":"<exact-sha256>","fields":["eventType","actorId","reportedOutcome"]}],
  "purposes": ["honor"],
  "purpose": "public-contribution-projections-only",
  "expiresAt": "<chosen-ISO-expiry>",
  "redactionConfirmed": true,
  "publicationScope": "selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged"
}
```

先用其中sourceRefs/purposes调用preview。用户确认后签署与payloadJson字节完全一致的 Consent：action=`contribution.publish`，objectId=payload.id，Public/public-profile，recipient=所选服务端；再提交 `{consentId,payloadJson}`。返回 `publicationId`、`state:published` 和 `originalPermissionsChanged:false`。网络响应不明时重试同一个id及同一份字节；不能自动生成新许可重复发布。

撤销payload：`{id:<new-operation-uuid>,kind:"revoke",publicationId,reason}`，也需相同action的本人Consent。返回 `state:revoked`。撤销的是该份许可；如果作者曾另行签过仍有效的相同字段许可，或原事件本来就公开，其他独立权限不会被冒充撤销。

公开 Honor 的 source 引用使用 `{publicationId,sourceKey}`，避免原 Case 根事件ID恰好等于 CaseID时泄露未选择的 CaseID。将此二元组加 `purpose:"honor"` 传 `/v2/contributions/read` 即可重新核对允许字段。对本来就具有原文读取权限的调用者，可返回原不可变事件ref。Requester历史中的事件引用为独立Task事件ID，分页用根operationID，不是TaskID，也不授予原文读取。

发布/预览/读投影都检查当前原事件、原Consent、当前控制和源删除状态。分享许可有自己的expiry和Consent时限，不能让它越过源材料的到期/撤销。原事件全文从未复制到新许可表；源删除留下空正文的受管占位也明确不可用。

## Honor 规则和查询

查询输入 `{ruleId,ruleVersion,subjectId,limit?,after?,expectedFingerprint?,includeSimulation?}`；limit默认8，最多20。`after`取上次nextAfter，跨页同时带sourceFingerprint作为expectedFingerprint；期间来源/规则变化会返回 `honor_sources_changed_retry`，重新从第一页读取，不能把两次状态拼成一张证书。GET分享页不默认包含模拟数据。

规则显式加入 `sourceProfile:"facts-v2"`，用**新规则版本**登记；旧profile缺省值及旧不可变规则Hash不改变。规则继续经既有运行配置登记及Honor规则历史机制加载，本次不虚构发行方配置。`open-contributor`最低一个不同真实Case的当前可接受工作；`ci-backed-contributor`还需有效的匹配CI事实。

**本切片的确切CI差额：** M11 v2交付引用M06通用Evidence，旧CI Proof引用另一组已验证CI证据对象。两者尚缺显式核验和绑定适配，不能仅凭UUID、字符串标签或 `evidenceType:"ci-result"` 串接。v2 CI加强规则返回 `ciEvidenceSupport.state:"awaiting-v2-verified-proof-link-adapter"`，Proof数为0，不能授予该加强荣耀。旧v1合法CI能力保留。此项属于后续开发依赖，不是需要用户补模型、停止无关功能的理由。

响应的card有issuer、规则及定义Hash、checkedAt、status、实时statusUrl；state区分active、insufficient-evidence、inactive-rule。它的active只代表这条**贡献**规则当前条件成立，始终 `capabilityVerified:false`、`qualificationGranted:false`、`globalScore:null`。每项有当前允许的projections和来源状态；未知关系不称独立，发行方申明的相关方也不自动称舞弊。

事实链需要真实确认参与、当前范围、精确交付和接受、实际 Result 及 Attempt/Intervention origin。接受新的较少范围、复核失败或诊断部分结果仍需明示其含义。Result后来纠正时，旧接受不会改绑新版本；待重新交付和接受。M06交付Evidence现在允许UUID或明确的 `{id,version}`。旧UUID保留第一代语义，第二代及以后必须明确引用该版本并重新交付、接受。撤销、纠正或来源权限失效会撤掉相关依据，不静默跟随新版本。

榜单默认关闭。仅当特定规则明确启用、privacyReview批准、时间窗结束，且当前公开真实样本达到配置下限（至少5主体、每人至少3不同Case）时才可能返回限定群组的贡献顺序；相同数量并列。小群组不足时不输出个体数值明细，合成测试不满足真实样本。

## Requester 与反馈

query输入 `{subjectId?,after?,limit?}`，本人可省subjectId，匿名必须提供；返回的是当前可见的一页，不能当全部任务历史分母。空页仍可能有nextAfter。每项默认展示最多8个fact，详情用 `{rootEventId,after?,limit?}`；rootEventId取项的source.id。

页面显示当前可见的接受/取消/争议事件数和当前反馈数。响应间隔由首个可见申请及随后请求者的可见回应计算，验收间隔对应同一交付与实际accept两条事件。没有可见数据返回null，不显示“从未回应”。同一任务多次accept是多次交付确认，不是多个请求；没有外部结算来源时明确 `settlementCoverage:not-recorded-by-this-source-profile`。

提供者已确认参与且交付接受、退出或任务关闭后，可以经原M11参与事件入口提交 `kind:"requester-feedback"`，字段 `descriptionClarity:clear|partly-clear|unclear`、`scopeMatched:boolean`、`note`、eventId和expectedParticipationVersion。请求者不能伪造对自己的提供者反馈。修改需新eventId、精确supersedes和reason，旧记录保留为superseded，当前记录失效时不能回退旧反馈伪装现状。

反馈默认沿用M11的Private授权。另行公开必须该反馈作者预览选字段并签贡献许可。文本/分项均标记provider-reported；不生成独立质量评级、恶意结论、总信誉分或专业能力标签。M19同时擦除事件原文和参与快照中的反馈正文副本。

## 数据、迁移与退出

追加migration58 `contribution_publications`，原1—57迁移不改写。每行owner为source author subject_id，保存选定字段/ref/Hash/签名Consent关联及撤销意图；无Case/Task事件外键，不妨碍源作者删除。API仅SELECT/INSERT及指定撤销字段UPDATE；不为读取不可变case_events新增UPDATE权限。源锁沿用Task/Case父对象，贡献许可读与撤销互斥锁定。

新表纳入资源预算、M19按owner导出及删除，导出数据集 `contribution-publications` 可取本人精确原许可。删除请求待处理期间立刻隐藏外部投影；取消请求只恢复仍有效权限，不复活已撤销来源。物理擦除后既不从Hash重建正文，也不把旧缓存状态当当前有效。

## 验证记录与后续

- 实际PGlite服务场景1/1：真实签名和多方操作，部分诊断与失败复核分别归属、合成不授予；字段/作者/Hash/到期反例；公开最小字段且私有原任务仍拒读；反馈纠正；本人导出；删除待处理/取消；M06撤销、Result纠正、原Consent撤销及空正文占位。
- 隔离PostgreSQL18.6 `galaxy_api`运行角色+10条HTTP路径流程1/1；无效Bearer被拒；清理removed=true。首轮发现不可变event行锁要求额外权限，改为沿用父对象锁，未扩大原event写权限。
- 旧Honor、M11 Task和M08 qualification相关11项测试通过。测试环境材料均为合成，不能计作真实社区/真实资格/真实Honor。

独立运行命令：`node --test test/honor-v2.test.mjs`；PG由既有隔离runner选择 `GALAXY_TEST_PG_CASE=honor-v2`，仅子进程设置 `GALAXY_TEST_PG_BIN`。不连接生产数据库，不启动备份。后续前端可直接用上述方法串预览、确认、签署、发布、实时状态与撤销；页面和真实宿主尚待该模块UI流程验收，实际Issuer/来源许可/社区样本需真实具备后才运营启用。

## 网页工作台与真实操作恢复

`packages/galaxy-web/src/contribution-workspace.tsx` 导出 `ContributionWorkspace({runtime,connected,subjectId,navigate})`，主应用挂接 `/app/history`。从本人任务清单或已知父对象选择事实，逐条选字段和用途，服务端预览后确认公开期限；可取消预览、查看许可当前状态、撤销和恢复结果未知操作。默认不显示未选字段，实际介入类型通过独立 `interventionTypes` 字段选择。当前Honor与Requester按真实权限显示分项，不提供默认全局榜单；CI缺口用用户可理解的说明表达。

`contribution-client.mjs` 只依赖现有 `runtime.api/getLocal/putLocal`。先持久化同一操作ID及精确payload，再保存本机签署的prepared Consent，之后提交授权和业务写入；网络失败时不丢弃它们。恢复时查询status匹配发布payloadHash或撤销operationId+Hash，已被撤销的许可不会因旧发布重试显示重新公开。若需要重新确认授权，也复用原payload及操作ID，不改变已预览字段。跨身份/连接拒绝继续操作。本机管理清单明确仅覆盖此浏览器记录，可以按已知许可标识读取本人其他设备发布的许可。

实际客户端集成测试 `test/contribution-browser-v2.test.mjs` 1/1：真实浏览器身份、实际签名、真实HTTP和服务端存储，模拟丢失的是已提交后的网络响应；验证原Consent回复丢失、重建runtime后跨binding精确恢复、发布/撤销回执丢失、用途隔离、断连拒绝。本测试不等于视觉审阅或用户宿主验收。TSX经esbuild转换，主应用最终打包和页面审阅由主代理统一执行。
