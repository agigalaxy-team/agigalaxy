<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/ab/ab1580aca245f15b3b4abf00cc13cd70bb9694bd49eacf13c7bbf8188ced0538.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 可解释履历规则检索

2026-09-10，本地实现，Schema31/39表；动态服务未部署。C11-01/02/03实现进入待复核，原真实来源、用户相关性和实际宿主验收保留。

## 筛选与含义

复用 `POST /v1/history/query`、`@galaxy/client/history` 和 `galaxy_remote_history_query`，新增两个可组合字段：

|字段|取值|含义|
|---|---|---|
|capabilityId|准确Capability ID|当前可见Assistance请求声明需要的能力，不能解释为个人能力认证|
|verificationStrength|ci-execution-fact|此投影具有至少一份当前可读、有效的受限CI执行事实Proof|
|verificationStrength|reported-only|此有界视图没有当前可见CI Proof，不能推出实际不存在其他证据|

关键词、报告结果、Capability和验证强度按AND组合。关键词仍是标题/摘要全部词匹配，不使用语义猜测。来源类型、环境和登记时间沿用本人字段规则，须显式查询本人subjectId；不能通过新筛选绕过配置可见性。报告失败但CI运行成功可以同时存在，Proof不改写任务结果。

返回searchExplanation，包括具体命中的title/summary字段、Capability关联的Assistance ID及声明来源、当前Proof ID、检查时间、来源类型和局限。来源分别标为case/history/proof。排序继续为Case UUID升序，不输出无依据的最佳专家、成功率或能力分数。检查时间表示本次读取验证，登记时间只在本人视图显示，不伪装成任务发生时间。

## 授权、分页及上限

Case当前授权在SQL召回与排序前过滤。关联Proof和Assistance的当前可见授权也在候选LIMIT前过滤，随后继续执行各自完整授权/签名/来源校验。私有Proof或协作记录不能挤掉公开候选，也不影响公开强度匹配。

Capability和验证强度是在当前可见投影上匹配，随后才形成结果页，不能先取一页Case再在客户端筛掉不匹配项。有派生条件时每次最多检查200个可见Case候选；常规条件保持原分页规模。达到扫描上限且尚未填满结果页时返回 `search.windowLimited:true` 和继续游标，允许本页为空但继续向后搜索。游标来自已可见Case，不编码隐藏对象数。

没有全库命中数或无限扫描承诺。原生界面明确显示扫描上限并允许继续分页。返回matchReasons和searchExplanation属于查询解释，不改变Case事实摘要或重建规则；当前规则仍case-history@4。

每次读取重算授权、绑定、Proof重验/过期和关联请求授权。撤销后新的查询不能继续命中已不可读来源；客户端不使用本地旧结果填补。查询反馈继续明确保存在本地，新筛选加入反馈criteria，分页不会重复建记录，不同验证强度不会覆盖同一条反馈。

## 原生入口与AI Agent部署

`/galaxy → 接入银河 → 查询履历 → 能力、验证与清空`：输入Capability、选择验证强度，或清空全部筛选。既有1至8入口保留；编辑阶段不请求服务，开始查询才提交。详情解释命中字段、需求来源、证据范围和局限。

客户端和MCP从同一查询schema继承新字段，不新增独立搜索服务或Scope。部署使用本批API及客户端，Schema31无需新migration；全局OpenCode未安装本批改动。没有引入向量库、模型评分或复制私有证据到匿名索引。

验证使用固定相关/不相关查询集，覆盖组合筛选、先筛选后分页、不同可见性、撤销、HTTP便携客户端、真实MCP工具参数、原生表单和本地反馈。包含20个排序靠前的私有Proof不能挤掉排序靠后的公开Proof的负例。真实PostgreSQL以受限API/Worker角色执行这些流程。

## 仍需推进

C11-04继续丰富分类型的Case/History/Proof搜索入口；Capsule及Worker/Hub公共元数据按原阶段扩展。C11-05继续扫描上限、深分页与批量枚举的集中验收。C11-06保留物化索引与后台重建的原要求，当前按需查询不冒充已完成后台队列。C11-07继续反馈汇总及真实用户评价。C11-08仍以实际评测表明规则基线不足为引入向量检索的前提。
