<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/f0/f05d80307bc06ce19bde02c536058d2a7a0f915ce1eb88d76b1e73a5d897a4b2.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 履历视图、结果变化和读取时重算

2026-09-10，C10-04/05/07/08 本地实现。Schema30、39表，无本批SQL迁移；动态服务未部署。

## 三类视图

`domain/history-fields.mjs` 为 owner、authorized、public 分别维护字段规则。当前 authorized 与 public 的基础字段相同，读取授权和关联来源的可见性仍独立判断。规则在关联数据组装后执行，避免未来新增内部字段默认外泄。

|字段|本人 owner|获授权 authorized|公开 public|
|---|---|---|---|
|Case ID、版本、标题、摘要、报告状态|当前有权读取|当前有权读取|当前公开来源|
|尝试 ID 和顺序、报告结果、失败说明及限制|保留|保留|保留|
|尝试方案、配置环境/版本/工具|保留|不返回|不返回|
|Case 自述参与者、来源引用、登记时间|保留|不返回|不返回|
|纠正与Case所有者报告的复核状态|保留原记录和变化|当前可见来源|当前公开来源|
|Proof、Capsule、Assistance来源|复用各自读取规则|复用各自读取规则|复用各自公开规则|

顶层及尝试配置、参与者、结果、纠正和复核的未知字段不会被自动复制。Proof签名内容和关联来源由已有专用服务生成，视图规则不改写其签名。每条返回 `fieldPolicy:{id:'history-fields',version:1,view}`，说明实际采用的条目视图；整页“authorized”查询可能同时包含本人条目，其条目视图仍为owner。

## 报告结果与后续变化

`reportedProgress` 根据已获准查看的Case事件顺序生成，包含结果ID、尝试ID、报告结果、事件版本和是否存在文字纠正。`latestResultId` 只指最后提交的结果，不代表最新独立验证结论。原有 `results`、`corrections` 和状态保持原语义，纠正不会覆写原成功/失败报告。

时间线展示 succeeded、partial、failed、inconclusive 和 conflicting。成功报告之后出现非成功报告时，`subsequentReports` 引用前一成功报告与后续结果，区分同一尝试和不同尝试；始终 `regressionVerified:false`。配置、范围或代码版本可能不同，所以这里只能确认报告先后关系，不能宣布已独立验证回归。成功报告本身被纠正时也保留其历史位置和纠正标记。

原生详情提供中文结果标签、失败说明、限制、事件顺序和后续结果引用。尝试数量、安装次数和结果条数均不变成能力评分；`capabilityVerified` 与 `attemptCountIsCapability` 始终为false。Case原有state（例如resolution-proposed）不会因一条后续失败而被暗中改写成最终裁决。

## 重算与空履历

History/主体Profile每次读取重新计算当前获准查看的投影。页面新增 `refresh:{mode:'on-demand',state:'rebuilt',backgroundQueue:false,checkedAt}`；这里的backgroundQueue只指履历重建，没有宣称Evidence Worker没有待处理任务。履历列表和我的资料显示查询检查时间。

Case事件Consent失效使该Case退出后续读取；Evidence来源撤销或Proof撤销移除对应Proof并重算关联复用内容，保留原报告结果；主体绑定撤销同时影响后续匿名和获授权读取。私有协作确认撤销仍按其独立授权处理。旧页面不是实时订阅，用户须重新查询获得更新，不能把本次查询时间当作永久有效保证。

新主体直接返回空items和空自述，没有默认专家认证，也不要求填简历后才允许提交Case或参与协作。只读原生页面可显示空资料，无编辑授权时不显示编辑入口。

## 版本与验证

新字段纳入 `case-history@3` 的稳定摘要。客户端同时理解v1/v2/v3，跨规则对照返回incomparable；原API `projectionVersion:1` 和原 `projectionHash` 保持旧语义。升级服务时同步更新需要核验重建记录的客户端；只支持v1/v2的旧客户端可能拒绝v3，不能承诺未知规则的向前兼容。

自动化覆盖三类真实服务视图、配置隔离、五类结果及纠正、授权/绑定撤销、Evidence源和Proof撤销、空履历、客户端版本切换、原生显示及受限角色PostgreSQL查询。原生交互使用自动化宿主接口；实际OpenCode人工体验、真实来源与相关性反馈及阶段共同验收仍保留。

AI Agent部署前应使用当前客户端构建，分别查询本人、获授权和匿名视图，对比fieldPolicy与隐藏字段；追加测试结果或撤销测试来源后重新查询，确认原报告保留而来源状态更新。本批不创建后台履历队列、外部索引或公开端点。C10-06的履历详情纠正/争议直接入口另行推进。
