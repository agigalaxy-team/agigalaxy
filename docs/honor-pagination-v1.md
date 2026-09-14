<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/78/78eb6576471867e2cef23141ad840bfc916a352047355dcf25645d004f71d059.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Honor 大量来源与分页 v1

2026-09-10，本地开发。Schema38 / 43表；无新增数据库迁移，动态服务未部署。

对应开发清单 C13-04：排名限定领域、社区、窗口和门槛，小样本不足时不发布排名。此次补齐原先超过200条候选协作、每协作50份Proof会截断扫描的实现差额，继续复用现有Case、Assistance、Consent和CI来源模型。

本次同时逐项核对C13中已有实现，未增加新的信誉产品：

|任务|当前实现与证据位置|仍需人工/外部复核|
|---|---|---|
|C13-02|Honor.sources/project只从当前有效协作、参与者验收和有限CI来源派生；没有安装、邀请、ID数量、工具调用、自评或付费计分输入，capabilityVerified恒为false；honor-workflow覆盖无依据/参与/同Case重复与CI撤销|真实来源与运营采用|
|C13-05|facets分列贡献、有限CI、协作可靠性和Requester History，globalScore=null；Honor原生分项菜单与honor-menu测试验证展示|实际宿主体验与真实用户理解|
|C13-07|ranking仅在隐私配置批准、有效封闭窗口和至少5人/每人3个Case时返回统计，否则不返回小群组统计；public-honor-workflow和PostgreSQL专项验证正向榜单及撤销抑制；benchmarkConclusion=null、industryComparison=false|真实隐私审查、群组与可比较样本；不提前提供行业结论|

以上本地实现可转待复核，原197项需求和共同验收条件保留。后续C13-06已补齐[纠正后的交付与贡献恢复](honor-correction-recovery-v1.md)，当前派生方法为honor-contribution@2、风险政策为contribution-risk@4；本文v3说明保留为分页批次的历史语境。

## 来源与汇总

服务按Assistance UUID每批100条、Proof UUID每批50条读取，直到当前范围扫描结束。批次大小不是总量上限。每条来源仍检查当前授权、可见性、时间窗、纠正、争议和撤销；所有可见来源先参与Case及数字仓库/run/attempt去重、冲突排除和风险判断，再生成展示页面。

一次卡片或排名请求使用一个PostgreSQL repeatable-read事务。来源读取使用共享锁，多个读者可以同时查询；并发修改引起序列化失败时重新计算一次，再次冲突返回409，提示重读。排名在一次社区扫描后按主体归组，避免逐成员重复扫描整个数据库。`contribution-risk@3`移除旧200候选范围声明，保留v2风险判断方法。

返回的acceptedCases、proofCount和可靠性分项始终覆盖本次完整可见范围，不是当前页条目数。分页不改变最小公开群组、每人最低Case数、隐私配置、时间窗、关联方单列和并列名次规则。

## API与原生菜单

`POST /v1/honor/query`保留ruleId、ruleVersion、subjectId，增加以下可选参数：

|参数|用途|
|---|---|
|limit|每类结果1–20条，默认8条|
|after|贡献Assistance UUID游标|
|proofAfter|去重后CI Proof UUID游标|
|riskAfter|风险提示偏移|
|sourceId、sourceAfter|某条当前可见贡献的事件、Proof、CI观察、纠正版本引用分页|
|riskIndex、riskReferenceAfter|风险的Case、Assistance、事件、Evidence、CI来源、主体、关系边及边上的验收事件引用分页|
|expectedFingerprint|继续查看同一投影时携带上一页card.sourceFingerprint；来源或风险变化返回409 `honor_projection_changed_refresh`|

`pagination`分别返回贡献、Proof和风险的after、nextAfter、total；null表示末页。卡片evidence与当前贡献页对应，evidenceCount/proofCount给出总数，Complete字段区分完整列表与分页片段。每项引用摘要最多20条，referenceCounts和referencesComplete说明是否完整。全部引用通过sourceDetail/riskDetail逐页取得，关系边的长验收事件列表另以edgeAcceptanceEvents条目完整展开。

不同请求重新核对权限，不保留跨请求数据库快照。客户端校验游标、条目数量、对象和投影指纹。原生菜单提供下一批贡献、下一批CI依据、下一批风险提示和全部引用；来源变化或读取失败可返回刷新。GET statusUrl仍返回默认第一页及完整汇总；完整追溯使用上述POST分页。

客户端保留对旧版无分页响应的基础读取兼容；显式分页请求必须得到相应分页响应。旧消费者如需完整来源列表，应更新为遍历nextAfter，不能把默认第一页当作完整历史。

## 运行与验证

AI Agent使用现有Honor客户端与history会话即可，无新凭据、表或云产品。重新构建便携客户端并验证源码摘要；首次初始化的 `/galaxy` 冻结流程保持原样。

专项真实PostgreSQL检查：设置现有 `GALAXY_TEST_PG_BIN`，设置 `GALAXY_TEST_PG_CASE=honor`，执行 `node packages/galaxy-official/scripts/test-postgres.mjs`。该入口创建并清理独立合成数据集，包含215条协作、214个不同Case及62份Proof；同时验证原生分页、嵌套引用完整性与客户端一致性。

分页限制响应体积，但服务仍需在内存保留当前范围的投影以完成去重和关系计算；不是无限数据容量承诺。真实社区数据量、并发和时延预算按C17部署容量要求验收。纠正恢复已由C13-06接通；人工隐私审查、真实关系与来源证据、实际OpenCode体验保留。

回退须同时回退客户端与服务器行为；旧服务会恢复来源截断限制。源事实和规则历史不变，无需数据库降级。
