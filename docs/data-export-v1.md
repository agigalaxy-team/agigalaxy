<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/1e/1ee6e75be385771a11287e8fd66a2c60ded90f98357f0dfcea247f22d929678d.md)保留旧文字与定位。
> CUR-35已恢复计划内开发与部署，后台备份仍暂停。保留、导出和删除按具体对象分批实施；[当前隐私网页与实际验证](../../../../07-logs/development/privacy-web-workspace.md)及[当前服务记录](../../../../07-logs/development/README.md)描述现状。下方日期型内容保留其证据范围，不能用于宣称全部数据类别或存储介质已完成删除。
> 当前实现校正（2026-09-13）：成果材料二进制导出已随 `official-2026.09.13-product-v2-r16` / Schema74 部署。小于等于现有单记录上限的内容可随页返回；更大附件通过 `/v1/data-exports/binary` 分块读取（每块最多524288字节），每次仍核验当前授权。此新增能力不改写下方历史批次的 Schema41 描述。
<!-- END GALAXY-CURRENT-ENTRY -->

# 本人及当前授权内容导出 v1（C18-04）

当前Schema41已实现32类本人记录与六类所选当前授权视图的服务导出、便携客户端、原生菜单、本机 NDJSON 文件及到期清理。使用独立 `data-export` 会话范围；不会扩大既有会话权限，也不触发本地资料上传。动态 Official 尚未部署。[当前生命周期](data-lifecycle-v0.1.md)。

## 导出范围

32类记录对应当前数据库中可归属于本人的业务/服务记录：身份公钥与Genesis、签名外部账户关联、绑定回执、Consent、Case、Case事件、Evidence来源、来源观察、Proof、协作请求、本人协作事件、本人材料授权及接收记录、通知偏好及已读记录、本人举报及治理事件、Capsule/版本/复用、建设者/本人登记事件、本人审计事件、本人审批的审计授权、本人审计查询、导出访问记录、删除申请/事件/执行、事故通知、Profile自述及建设者探测记录。数据集名称以[当前导出Schema](../packages/galaxy-official/src/shared/data-export-schema.mjs)为准。

每类使用明确列白名单和主体过滤。来源引用、原始业务事件文本及其摘要、Proof 原签名字节保留。排除认证挑战、访问凭据及其摘要、服务秘密、后台任务载荷和其他作者的私有记录；不下载远端 GitHub、其他源站或 Context 引用的实际文件。本人数据集不直接复制派生协作快照；所选授权视图通过原读取接口返回经过过滤的快照。

这是**本人记录副本**：先前撤销公开展示或 Proof 的记录仍可由本人取回，撤销/过期字段不被去掉，导出不会让其重新公开。原 Proof 签名仅代表历史签署事实，当前有效性仍需查询对应服务及可信密钥状态。Consent 表中的意图不是原始 JWS 文件；不能把意图 JSON 当成已独立验证的签名授权。

跨主体内容通过显式选择的 `authorized-views` 数据集导出：assistance、context、proof、capsule、builder、moderation六种当前视图。每个选择包含kind和记录UUID；Capsule可追加versionId。不扫描他人资料库。一次最多32个不重复选择，每页读取一个视图；同时可选本人数据集。默认仅包含32类本人数据。

创建与每页下载均调用原服务的readWithin，并要求data-export及该内容对应的当前会话范围；没有追加读取例外。未接收材料只返回摘要，接收后才含正文；范围改变、Consent撤销、到期等按原规则拒绝或隐藏相应内容。治理条目的正文撤销后可以仍有状态和可见事件。导出不会自动接受材料或授予再发布权限。选择内容在下载时重读，不能视为创建时的冻结快照。

混合票据标记mixed-authorized-copy，授权视图页标记current-authorized-view；其中selection、scope、checkedAt、authority与原视图一起保存。本人事实页仍标记owner-copy。客户端核对所选对象与返回对象、页次和摘要。C18-05停服窗口、删除执行、恢复重放和回执最小化已有本地实现；生产保留/调度和实际退出验收仍待落实。本站副本不替代本地身份私钥备份。

## 服务 API

以下均为 POST JSON，使用当前 `data-export` 会话凭据；已加入 Caddy 明确路径列表和 HTTP 失败审计：

| 路径 | 输入 | 结果 |
|---|---|---|
| `/v1/data-exports/specification` | `{}` | 当前主体、数据集和限制 |
| `/v1/data-exports/create` | `{id,datasets?,views?}` | 最长600秒、绑定到主体及当前绑定的下载记录 |
| `/v1/data-exports/page` | `{id,dataset,after?,limit?}` | 一页数据、SHA-256、后续游标及有效期 |
| `/v1/data-exports/binary` | `{id,dataset:"outcome-materials-v2",recordId,offset?,length?}` | 当前授权成果附件的分块 base64、偏移、总大小、SHA-256及下一偏移；撤销或到期返回不可用状态 |
| `/v1/data-exports/revoke` | `{id}` | 立即停止该记录的后续读取 |

数据集名称由 specification 返回，客户端也包含相同白名单。create 的 UUID 由客户端生成，同一主体/绑定和同一选择重试保持原记录；不能以同一 ID 改选数据集、所选视图或复活到期记录。每个绑定最多3个未到期且未撤销的记录。

下载 ID 不是匿名下载令牌：每页都重新核验会话、`data-export` 范围、主体、原绑定和下载有效期。刷新为同一绑定的新凭据不自动更新已建立客户端实例的授权快照；发生会话替换时须重新创建导出。取消本机下载只中止本次网络读取，下载记录仍按原到期时间失效；可显式 revoke 提前关闭。

默认每页50条、最多100条，页数据约700KB上限，超大单条失败而不静默跳过。客户端对429按服务器重试时间最多重试两次，等待期间可以取消；401/403会使本机授权失效。到期、持续限流或网络错误产生未完成下载，不会伪装成完整数据集。

选择时固定每类最高游标与数据库时间截点，每页重新读取当前行状态；这是有界的实时分页，**不是跨页数据库事务快照**。并发状态更新可能体现在后面的页，更新后的偏好等记录可能不属于原截点。需要完整恢复点时使用 [数据库备份](backup-recovery-v1.md)，不能用此用户导出替代灾备。

## 客户端和原生入口

便携包新增 `@galaxy/client/data-export`：`createDataExportClient({endpoint,sessions})` 返回 specification/create/page/binary/revoke/download。`binary` 只读取当前授权的成果材料附件分块，不暴露对象存储 key 或加密 key ID；`download(id,{onPage,signal})` 逐页交付，核对主体、端点、票据、游标、范围、有效期及页摘要；不自行发现身份、读取私钥或写文件。全部页完成且授权仍一致才返回 `complete:true`。最多10000页，超限保留未完成状态。

原生入口：可选“接入银河”页面 → “绑定、审计与导出” → “导出本人资料”。仅当前会话包含 `data-export` 且已注入对应控制器时显示。用户明确选择创建下载，再输入现有本机目录的绝对路径；程序在其下新建 `galaxy-export-*` 文件夹，不覆盖旧文件。

“导出当前有权查看的内容”可选择类型并输入记录ID；原生菜单每次选一个，API/客户端支持最多32个。

每类保存为 `<dataset>.ndjson`，完整导出附 `manifest.json`，含票据范围、逐页摘要、行数、文件摘要及历史 Proof 提示。下载按页写入，默认本机总量上限1GiB。没有完成时保留 `.partial` 文件和 `incomplete.json`；使用者可以检查或删除这些准确目录，不会自动删除其他本机资料。取消后重新下载会创建新目录，不将两次不同实时分页拼成同一个“完整快照”。

私有数据文件使用0600创建意图；实际 Windows ACL/共享目录访问由所选目录和主机账户决定。文件已下载后，服务无法远程撤回该副本。

## 到期、审计与清理

`data_exports` 只存选择、游标上界和期限，不另存打包数据。到期或撤销立即拒绝下一次请求；Worker 每60秒最多删除100条已到期/撤销的下载记录。Worker 未运行或积压时，物理清理会延迟，但下载访问仍拒绝。

`data_export_reads` 保留主体、数据集、游标、结果摘要、数量和时间；清理票据时其票据外键置空，页摘要和独立审计事件保留，可与本机 manifest 中的页摘要核对。API 可以追加读取记录，不能删除读取记录或下载票据；Worker 只获票据清理权限。审计元数据的长期保留仍遵循待确定的运营保留规则。

备份覆盖这两张新表；恢复隔离流程会使恢复的下载记录失效，与旧绑定/会话/其他授权同时关闭。

## AI Agent 接入与验证

沿用当前连接配置，用户明确申请包含 `data-export` 的新会话；不自动给旧绑定增加范围。服务迁移到当前Schema41并执行匹配的API/Worker角色配置后，使用准确端点调用specification。当前便携客户端有21个公开入口；服务端文件与本机写入模块不包含在客户端包中。

相关测试为 `data-export.test.mjs`、`data-export-menu.test.mjs`，覆盖真实 HTTP、客户端、主体隔离、分页、篡改、下载到期、撤销、限流、NDJSON 文件、页/文件摘要和取消标记。PostgreSQL `context.test.mjs` 用受限 API/Worker 角色执行同一工作流，验证清理不删除读取审计。可设置 `GALAXY_TEST_PG_CASE=context` 与 `GALAXY_TEST_PG_BIN` 后运行 `scripts/test-postgres.mjs`，只创建新的合成集群。

既有 `/galaxy` 主流程和本地身份不因导出功能发生迁移或重建。真实宿主操作及公开停服计划的部署、通知与实际取回保留为后续工作。

停服配置已接入：票据到期时间还会被takeoutUntil截断，截止后旧票据也拒绝读取。公开状态、老主体重绑定、撤销查询和删除影响预览见[停服与删除处理](service-retirement-v1.md)。

历史批次：Schema25时已包含本人删除申请/事件，并加入deletion-executions；当前完整范围以本文开头和Schema41清单为准。[删除申请流程](deletion-requests-v1.md)。

主库执行、部分处理续跑及无云端会话持钥status查询见[删除流程](deletion-requests-v1.md)；[备份恢复重放](deletion-recovery-v1.md)及[回执最小化](deletion-minimization-v1.md)已有本地实现。动态服务未部署。

