<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/64/640fa2df765c1596b0dab62c5053c809578e81a33e6708a272912b7ca4570c4e.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 贡献来源与循环验收检查 v2

最新补充：contribution-risk@4区分当前待处理纠正与已重新交付验收的历史提示，见[纠正后的贡献恢复](honor-correction-recovery-v1.md)。独立性声明继续保留，风险本身不改变贡献计数。

当前补充：`contribution-risk@3`保留本文判断规则，改为完整分批扫描和引用分页，详见[Honor大量来源与分页](honor-pagination-v1.md)。当前Schema38/43表；以下v2批次的200/50扫描限制已被替代。独立Verifier参与业务已接通既有Moderation，循环关系本身仍不能证明独立性。

2026-09-10，C16-03 本地实现。沿用当前 Schema 37、42 表和现有 Honor 接口；动态服务未部署。

## 实际变化

`contribution-risk@2` 在原有同 Case 重复、Evidence 复用、声明的关联方、集中活动及验收后争议提示上增加四类提示：

|规则|来源与含义|
|---|---|
|reciprocal-acceptance-cycle|当前可见且仍符合贡献条件的请求者→提供者验收边形成闭环，包括二人互相验收及三人以上循环；保留每条边的 Case、Assistance、accept 事件引用|
|ci-source-reused|多个 Case 或 Evidence ID 引用同一个已核验的数字仓库 ID、运行 ID、尝试次数；复用既有 CI provenance 分组规则|
|ci-source-conflict|同一个上游运行尝试的当前可见 Proof 对 commit 或 conclusion 存在分歧；记录并列保留|
|accepted-work-ci-not-successful|参与者已验收的协作引用了非成功的当前 CI 结果；说明 CI 与参与者验收需要分别检查，不据此判定整个任务失败或欺诈|

没有 CI 不单独触发虚假成功提示。现有集中活动规则仍为 60 秒内至少 20 条不同协作确认；参数随政策返回。阈值是本地候选规则，真实运营校准与案例复核保留。

## 可见关系范围

查询使用原 Honor rule 的能力、社区成员和时间窗，通过已有 Assistance、Case revision 和 Consent 读取检查取得来源。关系检查同时查看社区内其他提供者的可见协作，弥补只读所选主体贡献时无法看见中间边的问题。

请求者发出的 accept 事件构成有向边。所选主体在正向和反向可达集合的交集中形成闭环；单向链、同一主体自环、其他不相关闭环、已暂停/纠正/争议或缺少当前来源权限的协作不形成该主体的循环提示。返回关联闭环中的边及来源引用，不返回其他社区记录或完整成员名单。可见闭环也可能是正常协作，`relationshipInferred`、`independenceVerified`、`fraudDetermined` 和 `automaticPenalty` 均为 false。

主体贡献及社区关系各最多读取 200 条候选；单条协作最多检查 50 份 Proof。多取一条用于识别截断：贡献或 Proof 扫描不完整时不授予 Honor；仅关系扫描不完整时，风险视图返回 `incomplete-source-scan`，不会否定已完整计算的主体贡献卡片。分别返回 `contributionScanComplete` 与 `relationshipScanComplete`。已发现闭环仍附来源，但没有提示不证明不存在其他关系。

这是当前社区和授权范围内的图，不是全网隐藏数据扫描。独立人类 Verifier、企业控制关系或共同控制者不由循环推断。当前 GitHub API 观测继续明确 `repository-controlled`、`submitter-asserted` 和 `independentExecutionVerified:false`；不冒充独立能力认证。

## 与贡献计数分开

风险提示本身不扣分、处罚、改写参与者事实或生成全局分数。Case 贡献继续按不同 Case 计数。

CI 证据计数修正了原来只按本地 Evidence ID 去重的缺口：使用已通过 Proof 读取核验的既有 `provenance.sourceKey`（数字仓库 ID/run/attempt）分组。复制记录、不同本地 ID 或改名不会增加来源数量。一个来源组的当前记录存在 commit/conclusion 分歧时，该组暂不贡献 CI 门槛数量，原记录和冲突仍可查看。不同运行尝试仍为不同 CI 来源。此举落实原“同源不重复计功”，不是风险分数处罚，也不改写已签发 Proof。

非成功 CI 观测保存在独立 `observations` 投影中；成功且满足范围的 Proof 才能作为有限 CI 依据。旧客户端可忽略新增字段。公开/本人/其他授权查看者分别按当前权限计算，撤销或重验后重读即可反映变化。

## AI Agent 配置与回退

继续使用 `/v1/honor/query`、Honor 状态读取和现有 `history` scope；无新增认证或服务配置。原生 Honor 风险菜单显示四类新提示以及闭环方向、准确来源 ID。冻结的 `/galaxy` 首次初始化流程未改变。便携客户端依赖图未修改，可在确认源码和现有安装包摘要一致后复用发行包。

升级不需要数据库迁移。回退服务与原生菜单代码即可移除 v2 字段/提示；旧代码会恢复旧 Evidence ID 计数方式，因此不得把回退后的重复 CI 计数当作新增证据。源事实、Consent、Proof 和原审计记录保留。

对应自动证据包含纯规则、真实本地 HTTP、CI 读取与重验、原生菜单以及隔离 PostgreSQL 受限 API 角色工作流。人工运营、真实用户相关性、独立 Verifier 业务及正式发布仍按原任务单分别处理。
