<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/cc/ccccbab3c22ffe750c7be43bb03bd5916bd1e176529640e90366c06668e40586.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 纠正后的交付、复验与贡献恢复 v1

2026-09-10后续：Case复核事件读取与当前验收判定已抽为同一共享实现，供Honor和[具体能力资格](qualification-moderation-v1.md)使用；资格不会再使用纠正前的第一次验收。当前Schema39/43表，本次无新迁移。下方Schema38为本页首次交付时版本。

2026-09-10，本地实现；Schema38 / 43表，无新增迁移。对应C13-06原要求：“关联方协作保留真实贡献但标注独立性；撤销、纠正与冲突触发重算和UI提示。”动态云服务未部署。

## 修正的行为

原实现把“Case曾有文字纠正”作为永久排除条件，新的交付与验收也无法恢复贡献。现在区分历史纠正与当前是否需要重新交付：保留原纠正、交付、验收与CI记录，以明确引用当前纠正/复核版本的新交付和请求者重新验收确定当前贡献。

这仍是提供者交付、请求者验收的参与者事实，不是独立能力认证。关联方继续单列为issuer声明关系，未证明的关系仍为unverified-relationship；不会因为重新验收变成“独立第三方”。

## 继续工作与交付依据

- 原propose-resolution增加可选`outcome: resume-work`。另一方确认准确proposalId后回到active，清除当前交付和待确认范围，沿用已同意范围；旧事件保留。默认未指定outcome或close时仍结束为resolved。
- 同意继续工作不会恢复已验收状态，也不会付款或创建材料授权。需要新的deliver和accept。提供者在delivered状态可替换尚未验收的交付；新的Assistance版本使针对旧交付的验收失效。
- deliver增加可选`caseReviewVersion`，表示已审阅的Case纠正/复核记录截至哪个Case事件版本；没有此类记录时为0。它不是整个Case的当前版本号。
- 协作requester/selected-provider可得到deliverySource，包含Case ID、reviewVersion、文字纠正数和case-correction-and-review-events-only范围。只检查这些纠正/复核事件的可见性；不要求共享其他私有尝试，不泄露私有尝试引起的版本增量。相关纠正不可见时返回null，不能凭猜测的版本提交。
- 服务在现有Case锁内核对deliver引用的复核版本；accept再次核对当前复核版本和当前deliveryId。纠正在预览后或验收前变化时返回409 assistance_case_version_changed，保留原记录供重新查看和交付。

新端点通过eventFeatures.deliveryCaseReview=1、resumeWorkResolution=1声明扩展。客户端从当前可见deliverySource固定交付依据并放入完整签名预览；旧端点没有相关声明时不提供继续工作入口。既有省略新字段的事件不补写、不改变签名字节；它们仍支持未纠正的工作，但不能证明已审阅后来的纠正。

## Honor与CI

honor-contribution@2公开派生方法版本，并纳入sourceFingerprint；issuer定义的规则ID/版本及原记录保持不变。每个贡献返回：

|字段|含义|
|---|---|
|corrected|历史上存在文字纠正或尚在处理的纠正报告|
|correctionPending|有文字纠正未被本次交付引用，或仍有开放的纠正报告|
|correctionReview.state|无需复核、需要新交付、等待请求者验收、已重新交付并验收|
|deliveredCaseReviewVersion|本次交付签署的纠正/复核版本|
|deliveryEventId / acceptanceEventId|本次恢复的准确来源引用|

贡献恢复要求当前accepted、没有暂停/未处理纠正/争议，并保留原领域、社区、首次参与时间窗和来源权限。重复交付和验收仍按同一Case去重，不产生新奖励窗口。原始corrected标记继续保留。

风险政策升级contribution-risk@4：当前待处理事项与corrected-work-reaccepted历史提示分开。后者展示双方重新验收的来源，不推断独立性或施加处罚。

文字更正不改写原始CI运行事实。需要重新采集CI时，仍由既有Moderation的独立处理人明确发起Evidence重验；排队后旧Proof停止作为当前依据，新观察必须另行预览授权并签发新Proof。CI支持的Honor在新有效Proof出现后重新计算；一般贡献与有限CI分项保持独立。重新验收或处理人决定均不能自动替代Worker采集。

## 原生使用与AI Agent接线

原生协作菜单新增“提出继续工作方案”，明确双方确认后重新交付/验收；保留原结束方案。交付草稿保存复核版本，Case纠正变化时保留已填内容并要求刷新草稿来源。原生Honor展示当前复核状态、版本、交付和验收引用，提示双方验收不等于独立认证。

使用当前服务、客户端和项目内原生Adapter；重建便携客户端并检查源码摘要即可，无新增凭据或云设施。数据库无需迁移。旧客户端可继续读取基础字段；新功能需新客户端及声明相应eventFeatures的端点。未修改冻结的首次 `/galaxy` 初始化流程、用户级OpenCode配置或公开服务。

真实数据库专项纳入既有GALAXY_TEST_PG_CASE=context。自动流程涵盖版本变化、单方不能确认自己的方案、重新交付前不恢复、重复Case不增计、关联方计数、CI重验/新Proof、私有尝试与不可见纠正、撤销后失效及原记录保留。原生草稿覆盖版本变化后的保留、刷新和准确预览。

真实关系与运营来源、真实协作质量、实际宿主体验及原发布条件仍需复核。回退代码会恢复旧实现对所有文字纠正永久排除的行为，也不再识别resume-work；存在新事件后不能将旧服务作为兼容运行版本继续处理这些协作，宜前向修复，原数据库和签名记录保留。
