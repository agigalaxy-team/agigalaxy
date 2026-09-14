<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/3e/3ebe0fcc934e402a5fd9de45baf8706b638678dc023e0c80f1b95a061f276726.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Capsule版本与真实复用 v1

2026-09-10，本地实现，Schema16，动态服务未部署。

## 原始依据

[开发清单C14-01至06](../../../GALAXY_OFFICIAL_BASIC_CLOUD_DEVELOPMENT_CHECKLIST_v0.1.md)与[v3.1原始架构](../../../../01-intake/source-documents/GALAXY_CORE_ARCHITECTURE_v3.1_COMPLETE_CORRECTED.md)§34、§145–147、§433–434。原文结构：Problem Pattern、Environment、Solution Strategy、Tools / Skills / MCP、Verification、Limitations、Source Resolution；“如果 Capsule 被后续真实 Case 复用并再次验证：成为新的 Evidence”。过时或失败不覆盖旧成功。

## 版本、发布与维护

版本保存作者ID、贡献者、许可、能力/适用范围、问题模式、环境/版本、策略、工具/技能/MCP引用、验证方法、局限及源Case/Result/Proof。贡献者归因为作者声明，不代表贡献者确认。首期作者须拥有源Case，引用实际存在且声明成功的Result；待纠正/争议的来源不能作为新版本发布依据。CI Proof是可选的有限事实，不作个人能力认证。

发布用capsule.publish准确载荷Consent，明确Private/Public、接收人和redactionConfirmed=true。原生表单要求用户检查脱敏后确认；此标记不冒充自动保密审查。公开的是用户选定字段，不是整个私有Case。

每Capsule最多100版本、200版本/维护事件，以expectedRevision避免并发覆盖。同ID/同Consent/同载荷幂等；旧版本不覆盖。新增版本不会扩大旧版可见性。作者可追加deprecate、security-issue、resolve-security，弃用可指向同Capsule的替代版本。弃用/未解决安全问题阻止新apply/reverify，历史仍可阅读与引用。维护沿用该版本的可见性/接收人；撤销维护正文授权不抹去操作性状态。

## 阅读、引用、应用与再次验证

- 阅读纯查询，不新增使用记录或荣誉。
- reference关联本人Case及说明/归因，不生成reuseEvidence。
- apply关联不同于原来源的新Case、真实Attempt/Result；核对环境与结果，记录精确versionId、环境差异、说明和作者归因。成功、部分、失败、不确定、冲突均保留。
- reverify引用本人同版本/同Case的先前apply，关联真实Result及当前对应Case/Result的Proof；保留其CI范围，不证明Capsule导致成功。

同版本/Case/行为/Result防重复。Case读取和履历查询附带可见capsuleUses/capsuleReuse。只有apply/reverify派生reuseEvidence：事件ID、载荷Hash、Case版本、Attempt/Result、归因、结果、有限Proof和checkedAt。provenance=case-owner-reported-application，明确是使用者声明及来源记录，不冒充独立观察工具执行，没有自动签发独立Capsule认证Proof。

Proof撤销/到期降低复查证据状态，实际应用记录保留。使用Consent或源Case授权撤销使相关投影不可见。纠正/争议显示sourceNeedsReview，失败与旧版本不覆盖。所有计数按可见页解释，不宣称整体成功率。

## 站内更新通知

引用/使用过Capsule且授权仍有效的用户，可在既有收件箱收到后续版本与维护通知。仅阅读不自动关注。复用通知总开关/已读，新增capsules分类开关；旧偏好缺字段时默认开启。无外部邮件/聊天发送，首期没有单Capsule静音，可关闭整个分类。已经下载的内容不能被远程销毁。

## API与客户端

以下全部POST。写入须capsules scope，Consent签发另外需要consent；读取可匿名，携带会话时须capsules。

|路径|用途|
|---|---|
|/v1/capsules/events|consentId/payloadJson：版本与维护事件|
|/v1/capsules/uses|consentId/payloadJson：引用/应用/复查|
|/v1/capsules/read|capsuleId及可选versionId|
|/v1/capsules/query|关键词/capabilityId/authorId/after/limit|
|/v1/capsules/uses/query|capsuleId/versionId或caseId、after/limit|

客户端新增/capsules，总15导出；控制器、本地实际签名与原生菜单接通。显式会话支持11个已实现范围；修复BindingService原固定8项限制，仍只允许服务配置集合，旧会话不会自动增加权限。版本编辑/应用/维护均一次准确确认覆盖Consent及事件。

## AI Agent部署与验收

先用部署角色迁移至16，再应用infrastructure/api-role.sql。新增capsules/capsule_events/capsule_uses；API仅追加事件/使用和更新capsules.revision；notification_reads增加capsule类型。Worker不扩权，复查仍使用现有有限CI观察。配置沿用endpoint、pin、会话与Consent，无新增供应商凭据；MCP引用字符串不是工具执行授权。

合成流程已覆盖v1、失败/成功应用、CI复查与撤销、v2、通知关闭、安全问题/解除/弃用、旧失败及权限撤销。真实PG覆盖Schema/约束与API/Worker分权；实际本地签名测试覆盖Capsule引用，原生自动测试覆盖被动阅读及应用确认，真实宿主用户验收尚待。

查询最多扫描200候选并通过游标继续；长期清理、单Capsule订阅、失效源管理恢复、共同作者签署、独立可携带复用Proof及规模测试另属后续。组合Consent/提交意图当前在内存，未知网络结果先读取现有记录，不自动生成新ID重发。

关闭新增客户端/代理入口并前向修复可保留历史。不能将16版库交给仅支持15版的程序。当前未全局安装、未更新公开官网或部署动态服务。
