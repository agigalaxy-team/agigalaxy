<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/53/534e1178e8c4bb133dd1684e5c81f5efb7d156f5884b0280b7271492c72ad1b2.md)保留旧文字与定位。
> 2026-09-13 当前更新：业务开发和部署已按后续授权恢复，后台备份继续暂停。建设者新增支持范围、Pack 清单和分项报告，见[当前 v2 接口及边界](builders-support-v2.md)。下文日期型实现状态是演变记录，不作为当前 schema、部署或完整业务状态；运行范围以项目发布记录为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 建设者登记 v0.1：当前本地开发实现

2026-09-10。C15 的持久化、HTTP、客户端及宿主原生流程已接通；动态服务未部署，真实宿主/用户验收未执行。登记不会启动 Worker、安装 Bridge、连接 Hub 或修改现有 `/galaxy` 初始化。

当前补齐：所有者可管理不可读声明、发布独立维护公告，并在本机持久保存原事件以完成重启后的对账和准确重试。见[管理恢复与重试](builder-recovery-and-retry-v1.md)。数据库仍为 Schema33；下文早期 Schema18/20 是演化记录。

## 原始要求与实现范围

来源是项目执行计划 C15-01 至 C15-09，以及 v3.1 架构 §221–224、§238。§238 原文列出的 Conformance 范围是“IDs、Evidence、Signatures、Schema、Import、Privacy、Revocation”。当前v2报告结构覆盖这七项，旧六项报告仍按v1读取并明确缺少Evidence。对应本地source runner复用实际Case/Proof服务、独立签名验证和官方A2A SDK测试；它不认证任意第三方部署或Worker能力。

实现复用现有 Galaxy Genesis/Ed25519 绑定、精确载荷 Consent、事务/审计、Proof 当前状态和独立客户端构建，不新增身份协议、认证系统、执行引擎或网络探测器。

| 对象 | 当前保存内容 | 当前不能推断的结论 |
|---|---|---|
| Worker | 登记所有者、声明的 Node ID、版本、Build SHA-256、源码提交、依赖摘要、配置摘要、Policy、能力 Claim、联络、适用范围 | 登记本身不证明 Node 授权；真实执行能力和模型质量仍未证明 |
| Bridge | 来源系统/对象、目标对象、映射规则、强度上限、授权、版本、去重、撤销、来源说明 | 外部来源控制权已核验、独立验证完成、跨 Hub 复制增加证据 |
| Hub | operator、Charter、Policy、地区、版本、endpoint、Manifest 地址/摘要/版本、范围、退出与导出说明 | Hub Manifest 已验证、Hub 可连接、可信远程端点已内置 |

所有对象使用严格结构，不接受 `privatePrompt`、模型密钥等额外配置字段；用户填写的摘要仍须自行删减私有内容，结构校验不能判断自由文本是否含秘密。`redactionConfirmed:true` 表示发布者确认所选内容。地址是无认证信息和查询参数的 HTTPS 引用，服务不会抓取其内容。

`verifyManifest` 继续只验证 Official；Hub 使用独立的 `verifyHubManifest` 和 `galaxy-hub/1` profile。Hub 登记仍是所有者声明，必须通过独立 pin 主动核对签名与元数据，具体见 [Hub Manifest 与接入](hub-manifest-profile-v1.md)。核对不会自动连接。Worker Node ID 在登记时仍是声明。另行完成 Node 授权后，服务可证明：这个 Node Galaxy ID 的密钥持有者批准了指定所有者和准确声明；不能证明双方是同一个人，也不代表执行权限或私钥托管。

## 状态、版本和维护

`builders` 保存不可变所有者/对象类型与流版本；`builder_events` 追加事件，Schema 18（新增节点授权/撤销事件；原 Schema 17 记录不变）。事件以 UUID、`expectedRevision` 和精确载荷摘要去重；原事件不被重写，重复的同一授权返回原回执。一个对象最多 1000 个事件。

- `declare`：建立或替换当前声明；保留旧版本。当前声明不可读/已撤销时，不回退展示旧公开声明。
- `heartbeat`：当前登记所有者主动报到，时间取服务端接收时间。15 分钟内显示 `recent-owner-heartbeat`；`endpointReachable` 始终为 `null`，不伪造可达或能力结论。无后台自动心跳。
- `compatibility`：由配置的评估者提交完整六项结果，绑定当前声明事件的 SHA-256、测试套件版本/摘要/来源、测试时间、有效期、失败/未测试项和限制。
- `maintenance`：下架、恢复、纠正说明、安全问题与问题解决。下架从普通目录搜索隐藏，按 ID 仍可看到当前可见声明及下架状态。公告正文受其 Consent 约束；撤销公告正文不自动取消下架或安全状态。

兼容结果是 `reported-pass`、`reported-fail`、`incomplete` 或 `unverified`，明确保留“指定评估者报告”的来源。任何当前失败报告优先于通过报告。声明更新、评估者从配置移除、授权/绑定撤销或过期都会使报告失效；最新报告撤销后不恢复其更早的通过报告。报告本身不运行测试、不验证测试套件文件，也不证明任务能力。没有评估者配置时不能提交兼容报告；所有者不能给自己提交该类报告。

所有者可以关联自己已发布且当前可见的 CI Proof。每次读取复用现有 Proof/来源有效性检查，撤销后变为 unavailable。目录只显示 `owner-ci-evidence`，`builderAttributionVerified:false`；这还不是 Worker 实际执行的 Evidence-bearing 证明。登记、报告、心跳和 CI 来源分开返回，`capabilityVerified` 始终为 false。

Private 声明仅所有者和授权查看者可读；Public 声明要求 `public-profile` Consent。Private 评估报告的接收者必须包含登记所有者，且不能扩大原声明的查看者集合。服务仅向有权限的指定评估者返回 reportDisclosure；宿主从中派生接收者，去掉评估者自身（其自身读取权限自动成立），避免重复占用接收者名额。维护事件沿用当前声明可见范围。授权到期后可以提交新的声明恢复登记，但旧声明不可读时的宿主管理恢复界面还未实现。

## 接口与 SDK

所有接口为 POST JSON；写入要求 `builders` 会话范围，另由 `consent` 范围创建逐事件 `builder.publish` Consent。

| 路径 | 请求 | 行为 |
|---|---|---|
| `/v1/builders/specification` | `{}` | 匿名读取此实现的边界和检查项 |
| `/v1/builders/events` | `{consentId,payloadJson}` | 追加声明、报告、心跳或维护事件 |
| `/v1/builders/read` | `{builderId}` | 按当前授权读取详情；允许匿名 Public 读取 |
| `/v1/builders/query` | `type? / ownerId? / query? / after? / limit?` | 当前可见目录；每页默认 8，最多 20 |

查询每次扫描至多 200 个候选对象，通过 `nextAfter` 继续；不返回总量或把不可见记录纳入公开统计。现有 HTTP 限流继续适用；大规模索引、专门登记额度、记录保留和定期心跳压缩尚待。

独立构建入口 `@galaxy/client/builders` 导出 `createBuilderClient`，具有 `prepare/execute/cancel/get/query/specification/exportReport/manage/owned/receipt/notices`。客户端使用宿主已有会话；当前读取客户端要求 builders 授权，匿名消费者可直接调用公开 HTTP 读取接口。导入不会发起连接或读取本机身份。

```js
import { createBuilderClient } from '@galaxy/client/builders';
const builders = createBuilderClient({ endpoint, sessions });
// approvedPayload 是宿主已获得的精确 {consentId, payloadJson}；不在这里自动生成授权。
const preview = builders.prepare(approvedPayload);
// 宿主先展示 preview.payloadJson，再取得用户对 preview.confirmation 的准确确认。
const receipt = await builders.execute(preview, confirmation);
const entry = await builders.get({ builderId: receipt.builderId });
```

实际当前版本：服务/客户端包 0.1.0、HTTP v1、数据库 33、客户端 19 个入口。构建检查已覆盖新增入口；未签发生产发行包。Registry 版本不会重建 Galaxy ID，`builderId` 是登记记录 ID，不能代替 Galaxy ID。

## Node 对指定登记的授权

该流程直接复用现有 Genesis 检查、Node 自己的身份绑定/会话和 Ed25519 `builder.publish` Consent，没有新认证服务或要求所有者拿到 Node 私钥。

1. 所有者登记 Worker 的已有 Node ID。私有登记必须把 Node ID 加入查看者，Node 才能查看准确声明。
2. Node 持有人在以该 Node ID 连接的宿主中打开登记，选择“以Node身份授权此登记”，查看指定所有者、声明摘要、接收者与时限后准确确认。
3. `node-control` 事件只允许该 Node ID 的已认证主体提交，绑定所有者、Node ID、当前声明事件 ID/完整载荷 SHA-256、端点和有效期。有效期不能超过本次 Consent；本机组合默认不超过一天且受当前 binding 剩余时限约束。所有者与 Node 同 ID 时仍须这次明确授权，不自动根据登记成功生成证明。
4. `nodeControl.state` 返回 `node-authorized-owner`、`unverified`、`expired`、`revoked`、`unavailable` 或 `not-applicable`。每次读取重查 Node Consent 和原绑定；声明替换后必须重新批准，无旧版本授权继承。
5. Node 持有人或登记所有者可以追加 `node-control-revoke` 撤销当前批准。撤销事件正文授权过期/撤销不会让批准复活。Node 也可通过原 Consent 或绑定撤销功能使批准失效。再次批准必须产生新的 Node 签名授权。

原生界面按当前身份显示授权/撤销入口，不提供从任意路径导入私钥的功能。公开目录可展示已获准公开的节点批准状态；私有批准内容只能在原声明的允许范围内展示。

此证明是 Node 密钥持有人对登记关系的批准，不是 Worker 的实际任务执行、远程 endpoint 的控制证明、付费资格或能力认证。2026-09-10 已补服务签名快照及 Node 主动新签署的可携带证明、本机文件与独立客户端离线核验；历史 Consent 原始签名未保存，不能还原。见[可携带节点授权证明](node-control-portable-proof-v1.md)。真实第三方建设者验收仍待。

## 宿主原生操作（本次新增）

开发版连接页在已取得 `builders` 会话范围时提供“建设者登记”，无需额外申请 assistance 范围；协作页也提供目录入口。主初始化与本地身份流程不变。支持三类登记/更新、类型浏览和文字搜索、完整声明、分项状态、版本索引、维护公告、已有兼容测试报告。

登记表单包含原始声明结构的所有必填字段。依赖与能力声明按提示逐行填写，依赖固定版本/摘要和能力局限不会被界面省略。节点身份来自用户提供的已有 ID，界面不会生成新 Galaxy ID。当前版本索引展示历史标识和发行版本；完整历史声明读取仍待扩展。

`createBuilderFlow` 在宿主准备时读取最新声明并生成准确载荷和 Consent 预览。读取和取消不发布内容；一次准确确认后用已有本机密钥签名，先创建 Consent，再提交登记事件。所有者维护操作和评估报告自动沿用实际允许的可见范围。编辑表单及报告绑定打开时的 `baseDeclarationId`，期间声明更新则要求重新打开，避免静默把旧表单套到新版本。提交后的并发由服务 revision 检查处理。

组合流程仍保存在进程内；网络响应丢失时界面报告“结果未确认”，先按 ID 读取再决定重试。持久重试/对账和源声明不可读后的管理恢复尚未完成。真实本机签名在隔离临时身份测试中跑通，不是用户身份实测；未修改全局 OpenCode 配置。

## AI Agent 部署与回退

1. 从当前版本约定、部署脚本和治理配置读取实际范围；不要从本文合成域名、评估者身份或凭据。可选 `GALAXY_GOVERNANCE_CONFIG` 中增加 `builderAssessorIds`（最多 8 个已确定的 Galaxy ID），默认空。
2. 先用管理角色迁移到当前 Schema 20，再应用现有 `api-role.sql`：API 可插入新事件、更新登记 revision，不能修改历史载荷或删除登记。写入事实和对应 C16 审计保持同一事务。19版新增HTTP失败去重索引，20版新增审计访问授权/读取记录；Builder业务表沿用18版。
3. 复用 `deploy/caddy-routes.mjs` 中当前完整精确路径，包含管理、公告、回执和统一搜索；登记引用不触发 fetch、DNS 解析或端口扫描，不安装用户登记的软件。
4. 运行 `test/builders.test.mjs`；真实 PostgreSQL 用现有隔离测试脚本验证新表及 API 角色。所有测试数据合成，不计入真实建设者/用户验收。
5. 关闭入口可移除 builders 会话范围及代理路径。数据库是前向迁移：Schema 18 不能交给只支持 17 的旧程序，旧程序回退需要事先验证的升级前备份，不能丢弃新增表来伪装兼容。

还需完成：端点控制权证明、真实第三方 Conformance runner 和完整 Evidence 互操作、受限端点探测（若决定提供）、真实 Hub Manifest profile、正式发行密钥/发布及目标平台适配、配额/保留与恢复、真实用户及运营验收。本地发行签名和包消费流程见[客户端发行](client-release-v1.md)。可携带报告签名快照已实现如下；它不是第三方测试执行证明。

## 可携带兼容报告快照（2026-09-10）

复用现有 `jose`、Official 签名键/pin、Consent、角色和事务。没有另造签名算法、认证协议或探测服务。`POST /v1/builders/reports/export` 使用现有 `builders` 会话，重查当前声明、评估者、报告 Consent/原绑定、套件配置和时限，返回 `{signed}`。匿名导出不可用；有权限的主体可导出公开或获准查看的私有报告。原生报告详情中的“生成可携带签名报告”是显式操作。

报告携带：登记/声明 ID 和精确声明载荷 SHA-256、发行版本/Build 摘要/源码提交、评估者、完整报告、套件名/版本/来源/摘要、检查时间/有效期、六项检查及失败内容、限制与维护状态。`sourceEventHash` 是原始签名 Consent 所绑定报告载荷的字节摘要；`reportHash` 是本 schema 规范化后的报告 JSON 摘要，二者用途不同。

签名使用 `galaxy-conformance+jwt`，发行者/受众固定为该 Official origin，数据 schema 1，最长 300 秒。快照还受报告、原 Consent、声明 Consent 和已固定套件有效期限制。`authority=registry-signed-assessor-report`、`suiteVerification=operator-pinned-reference`，始终 `capabilityVerified=false`、`independentExecutionVerified=false`。报告有失败项也可以签名导出，不把失败藏掉。

`verifyConformance()` 验证签名、pin、版本、具体登记/报告 ID、关联与时限，返回 `currentRevocationChecked=false`：离线签名核验无法知道签出后发生的撤销。`builderClient.exportReport()` 完成一次获授权的在线刷新并校验新签名，返回此次快照的 `checkedAt`；它也不是未来持续有效的承诺。签名撤销、未知 key 或过期快照必须重新获取，不能降级信任。

每次导出追加 `builder.export` 审计，记录实际调用者及其 binding/scope，并单独保存来源评估者的 Consent/binding 上下文。签名报告正文和 token 不进入审计。导出不修改原报告或登记版本。

### 套件来源配置

`GALAXY_GOVERNANCE_CONFIG` 的可选 `conformanceSuitePins` 数组由运营者在启动配置中提供；变更文件后需重新加载服务，当前没有热加载接口。每个 `name + version` 只允许一条：

```json
{
  "conformanceSuitePins": [{
    "name": "Operator-selected suite",
    "version": "1.0",
    "sha256": "replace-with-actual-64-character-lowercase-sha256",
    "source": "https://suite.example.org/versioned-source",
    "notBefore": 0,
    "notAfter": 1,
    "revoked": false
  }]
}
```

以上仅字段示意，摘要和时间必须换成实际已审核值；示例不会通过生产配置验证。默认数组为空。未跟踪套件可保留原“评估者报告”及其限定范围，不能生成本签名快照。已配置套件摘要/来源不匹配、被撤销、过期或超出起始时限时，报告显示相应套件失效状态，不回退到旧通过结果。配置 pin 表示运营者固定了引用，不证明系统下载或实际运行过该套件。

首期六项报告保留为既有版本范围，当前七项v2及本地runner如下。回退时关闭导出入口并保留报告/审计；旧客户端可继续读取旧登记，不能把不能验证的新版签名视为通过。Schema18不变，现有 `/galaxy` 初始化不变，动态服务未部署。

## 七项报告 v2 与本地生成器

新的报告显式携带 `profile: galaxy-conformance/2`，必须恰好包含七项不同检查。旧报告没有profile，必须恰好保留原六项；读取/签名核验不为旧载荷补默认字段或改变原hash。`coverage`显示报告范围和缺项，`compatibility.fullScopeState`仅在某份当前七项报告全部通过时为`reported-pass`。七项齐备但有`not-tested`仍是`incomplete`，任何当前失败不会被另一个通过覆盖。旧`compatibility.state`继续表示它原有的限定范围结论。

原生提交表单改为七项，新签名快照的外层schema为2；旧六项快照保持schema1。客户端验证外层schema与报告profile一致；未知版本拒绝。可选`execution`可保留本地测试源码hash、运行报告hash、runner版本和runtime，仅是评估者提交的运行引用，不提升证明强度。

从已按三个锁文件安装依赖的仓库运行：

```sh
npm run test:conformance
```

生成器使用Node内置`node:test`执行固定测试集合，输出到新的`outputs/conformance-<uuid>/report.json`；退出码在任何失败、缺测、跳过或运行期间源码变化时非零。报告包括七项结果、每个文件的计数、失败测试名、runtime、起止时间、源码/锁文件摘要和报告字节hash。旧失败运行不会覆盖或删除。

| 检查项 | 当前自动验证范围 |
|---|---|
| IDs | GUID编码、时间顺序、Genesis绑定和不支持声明 |
| Evidence | CI来源/尝试/提交匹配，去重，Case Result→Evidence→有限Proof，撤销阻断；A2A二进制/数据/URL引用哈希，不把Artifact变成Proof |
| Signatures | 实际JOSE签名与独立Node crypto互验，目的/来源/时限/pin边界 |
| Schema | 旧六项与新七项范围、错误/重复/未知profile，登记业务对象 |
| Import | 官方A2A SDK HTTP结果→实际本地密钥Consent→Case Result；丢失回执和重启恢复 |
| Privacy | Case授权与原始披露，A2A按主体/端点隔离和选定内容发送 |
| Revocation | 评估者/Consent/绑定、来源版本/套件/签名pin变化，失败保留和签名快照过期 |

生成器的测试目标是被哈希固定的本地源码树，不接受远端URL、用户凭据或任意命令。它不会给任意登记自动生成“通过”。产物因此标记`publicationReady:false`：发布前仍需选定真实的版本化套件来源、把测试源码与准确发行声明关联，并由获授权评估者按既有Consent流程提交。源码/锁文件摘要不是已安装依赖的二进制供应链认证。

当前缺口转为：第三方实际运行端点/发行包的对应验证与签名发行链；不再遗漏七项检查结构。运行配置与业务服务未上线。
