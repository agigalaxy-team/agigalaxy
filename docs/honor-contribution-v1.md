<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/2e/2e54a91bd6c36fb6461342efa85b5e39677092ef28c395e4b39e13b06758c1ba.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 贡献与Honor派生视图 v1

2026-09-10，本地开发实现；当前 Schema 38 / 43 张表，动态服务未部署。[规则版本与历史 v1](honor-rule-history-v1.md)已持久保存定义并关联运行配置，支持旧版本查询与当前撤销/移除状态。[贡献来源与循环验收检查 v2](contribution-risk-v2.md)按上游数字仓库/run/attempt 去重、排除冲突来源组。[大量来源与分页 v1](honor-pagination-v1.md)已改为完整分批扫描、一次响应一个数据库快照及结果/引用分页。当前派生方法为honor-contribution@2、风险政策为contribution-risk@4，支持纠正后的新交付与重新验收。当前便携客户端为20个入口。

## 原始依据与实现选择

[C13完整需求](../../../GALAXY_OFFICIAL_BASIC_CLOUD_DEVELOPMENT_CHECKLIST_v0.1.md)与[v3.1原始架构](../../../../01-intake/source-documents/GALAXY_CORE_ARCHITECTURE_v3.1_COMPLETE_CORRECTED.md)§295、§383、§552、§594、§614.8–614.12。原文要求“Honor 必须自动派生或由可信 Issuer 签发”（§446），并强调“Contribution 不等于 Reputation”“Ranking 不等于 Qualification”。本实现选择从当前授权来源自动派生，不引入可编辑徽章或奖励积分表。

首期支持两类明确限定的规则：开放协作者（open-contributor）和附带有限CI事实的协作者（ci-backed-contributor）。规则由具体能力、社区成员范围、固定时间窗、规则版本、issuer及证据门槛确定。第二类必须有当前匹配仓库的成功CI Proof，但仍不表示个人专业能力或独立任务质量认证。不会把它命名为已独立验证的解决者。

没有来自安装、邀请、ID数量、工具调用次数、自评或付费的荣誉触发器。开放贡献规则仅纳入 open-assistance；赏金协作在来源历史中保留，CI规则可按其具体证据纳入，支付行为本身不计入。

## 派生与当前状态

查询从数据库自动发现指定主体在能力/社区范围内被选择且确认参与的协作，查询者不能提交精选Evidence列表来隐藏同范围已可见的失败或争议。窗口依据首次确认参与时间，使用左闭右开区间。候选协作按100条、Proof按50条分批读到结束，完整汇总后分页展示；不再将旧批次大小作为总量上限。

验收过、当前未暂停/争议/纠正的协作可作为规则依据。同一Case多次协作只计一个Case；同一Evidence的多份Proof也只计一次。卡片ID由issuer、主体、规则ID/版本确定，重复查询无写入或重复奖励。sourceFingerprint反映来源及当前状态变化。

卡片包含规则和哈希、来源事件ID、Case/Assistance/Proof引用、issuer、checkedAt及statusUrl。没有长期有效截图或永久证书；来源、Consent、binding、Proof撤销与到期、规则撤销、争议、纠正或管理员暂停会在重新读取时改变卡片。没有异步通知推送或主动删除用户已保存截图的能力。[纠正后的交付与贡献恢复](honor-correction-recovery-v1.md)现已通过新交付明确引用Case纠正/复核版本、请求者重新验收来恢复符合规则的贡献；保留旧记录和独立性标记，CI重验仍单独处理。

分享遵循每项来源的当前可见性，接收方打开同一statusUrl时重新计算自己的视图。卡片不扩大来源权限。[公开贡献事件](public-contribution-sharing-v1.md)已允许公开请求中的作者逐条明确签署贡献事件；默认和既有Private事件保持私有。只有关键来源均公开可见时才形成匿名贡献投影。原生菜单提供“检查公开可见结果”，并提示截图不是当前证明。

## 分项、关联方与排名

贡献项统计不同Case验收数和声明的关联方Case；能力证据项只统计有限CI Proof；协作可靠性展示范围内已可见的验收、取消、争议和暂停事实；Requester History保留独立入口。没有全局总分或自动接单资格。可靠性统计不是完整全网失败率，不能推断不可见数据。

配置中 relatedPartyGroups 是issuer声明的关联组，关联协作保留贡献并显示 issuer-declared-related-party。未匹配的关系标注 unverified-relationship，不推断为独立第三方。关联方计数对每个Case去重。没有自动识别共用控制者或企业关系的功能。

排名须显式启用、privacyReview=approved、窗口结束且规则仍有效，只使用匿名公开可见且达到门槛的来源。最小合格群组不少于5，每成员至少3个不同Case；样本不足、来源扫描不完整或规则失效时只返回suppressed，不披露小群组统计。排名按公开合格Case数、并列同名次，公开方法/领域/社区/窗口，关联方数单列。该规则是贡献计数，不是能力排名或资格授予。

聚合统计仅随合格榜单出现：合格公开主体数、各主体Case计数之和（并非跨主体去重的独立任务总数）。benchmarkConclusion=null，industryComparison=false。已通过五位提供者/十五个公开Case的合成API工作流，验证有效榜单、并列名次、私有来源隔离及撤销后抑制。大量来源和结果分页见专项说明；真实样本、运营隐私审查仍待完成，不能提前给出可比较的行业结论。

## 接口、配置与AI Agent接线

- POST /v1/honor/rules：公开规则，不暴露配置成员或关联组名单。
- POST /v1/honor/rule-history：公开历史规则定义与当前状态，支持规则过滤及分页。
- POST /v1/honor/query：ruleId、ruleVersion、subjectId及可选分页参数；可匿名；携带会话时要求history scope。汇总完整，贡献/Proof/风险默认各8条，全部引用通过游标读取。
- GET /v1/honor/{subjectId}/{ruleId}/{ruleVersion}：当前卡片及来源状态。
- POST /v1/honor/ranking：ruleId、ruleVersion；只计算公开来源。

客户端 /honor 导出复用现有history会话；宿主控制器/本地运行时/原生菜单只执行读取，不新增签名或发布流程。共有20个客户端导出入口，旧tarball需按当前源码重新构建。

API的 GALAXY_GOVERNANCE_CONFIG 可增加 honorRules 数组（最多8条），完整字段由 shared/honor-schema.mjs 校验。省略时默认空数组。配置包含规则ID/版本、名称、kind、capabilityId、communityId、成员、关联组、有效期、窗口、最低Case/Proof数、仓库及排名/隐私/群组门槛。时间采用Unix秒；规则内容变更必须新建版本，启动事务拒绝同版本改义。Schema38持久保存版本定义和首次配置引用，定义摘要与撤销状态分开。真实政策及成员关系需要运营证据，不照搬合成测试ID。

复用已有数据库及API角色，Schema38新增 honor_rule_versions 的读/追加权限。部署仍须验证真实来源授权、成员关系和原生宿主体验。移除配置规则或设置revoked后，旧版本仍可查询但卡片失效；原始贡献记录保留。本人删除不删除多主体运营规则，回执明确报告相关保留引用；详见规则历史说明。

历史上Schema28仅记录政策摘要；当前Schema38已经持久保存完整规则版本并阻止同版本改义，详见[规则历史](honor-rule-history-v1.md)。
