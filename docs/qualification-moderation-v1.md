<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/3c/3c3a3632123074dfa841cecd9d78af1d2a84d1fe08719ea6fe445459ae443538.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 具体能力资格与协作举报处理 v1

2026-09-10当前实现：资格判断方法升级为capability-participation/2，复用Honor的纠正/验收规则与CI来源去重。策略版本摘要进入既有运行配置历史，移除后仍不能用原版本改写门槛。Schema39/43表不变，无新表。举报、暂停、解决、申诉、补充/纠正及验证者自愿参与已通过当前自动化，真实运营与实际宿主体验保留。

2026-09-10后续：贡献查询现已返回独立风险提示，覆盖可见同源重复、声明关联方、集中参与和历史验收后的审查状态。提示不自动裁决、暂停或处罚；后续案件仍走明确的举报和处理流程。见[来源化风险提示](contribution-risk-v1.md)。

2026-09-10，本地开发实现，Schema 15，动态服务未部署。

## 来源与规则

原始需求 C12-08：`Qualification按具体Capability、证据和Policy判断；社区等级不授予全领域接单资格。`
原始需求 C12-09：`设计举报、暂停、申诉与滥用处理；不承诺任务必被响应、免费解决或由官方保障交易。`
来源：[详细清单](../../../GALAXY_OFFICIAL_BASIC_CLOUD_DEVELOPMENT_CHECKLIST_v0.1.md)；[v3.1原始架构](../../../../01-intake/source-documents/GALAXY_CORE_ARCHITECTURE_v3.1_COMPLETE_CORRECTED.md) §614.5–614.9：开放协助、付费资格、外部证据与排序边界。

资格按具体 capabilityId、Policy ID/版本/有效时间及证据动态计算，不保存永久证书或通用分数。策略可要求相关已验收Case数量，以及允许仓库内的当前CI来源数。付费策略至少要求一条相关已验收历史。CI事实始终capabilityVerified=false，验收及能力关联属于参与者声明；同一仓库的CI并不独立证明个人能力。当前没有导入外部学历/证书或独立人工裁定适配器。

保留minAcceptedCollaborations/minProofs输入字段；方法2分别按不同Case与不同数字仓库ID/run/attempt计数。同一Case的多个协作条目、同一次CI的多个Proof包装不增加门槛计数；冲突commit或conclusion的同一CI来源不计入。返回evaluationRule、policyDefinitionHash，以及当前交付、验收事件和CI来源键，便于查看判断依据。只评估调用者选定的最多16份Proof和16个协作来源，不宣称扫描完整履历。

已验收协作必须匹配当前交付的验收事件。Case有未处理纠正/争议、未知私有复核内容或暂停时不能贡献资格；纠正后需要新的版本绑定交付和请求者验收。重新同意工作本身不恢复资格。复用Case纠正及复核事件，不要求披露无关私有Attempt；参与确认、当前交付及当前验收也须可见。CI实际再收集仍走独立Evidence流程。

请求可附加capabilityId和qualification {policyId,policyVersion}；申请附带proofIds/assistanceIds。创建请求、选择及提供者确认均核对当前策略，后两步重算来源资格。来源私有不可见、撤销、暂停、过期或证据不足时不能通过。该检查作用于明确附策略的请求；普通Bounty说明仍可不附策略，它只保存赏金描述，不产生Paid Qualification或付款。运营方采用资格约束时应创建附策略的请求；是否统一禁止所有无策略赏金说明属于尚待决定的运营范围。

## 举报处理

注册主体具有 moderation scope 不等于管理员。配置中的 moderatorIds 才有处理权，且举报者或协作当事人不能裁定自己的案件。举报正文与申诉默认仅向指定管理员披露；处理决定通过管理员自己的准确载荷 Consent 向管理员、举报者及报告创建时的协作双方披露。其他参与者看到最低限度的状态及其可见决定，不能看到私有举报正文。

举报 → pause/resume → resolve(upheld/dismissed) → appeal，事件追加保留。resolve 不自动恢复；有多个暂停报告时须分别 resume。暂停阻止协作新增工作事件及 Context 材料读取，仍允许合法取消。撤销举报或决定的内容授权只隐藏正文，不自动解除操作性暂停；管理员配置变更也不自动恢复协作。

同一主体对同一协作最多3份报告、单报告最多3次申诉及100个版本。此为基础限量，不是完整的身份防滥用系统。无响应SLA、免费解决或交易保障。管理员更换不会自动扩大旧正文Consent受众。后续仍需实际运营人选、保留期限和人工案件处理验收。

## API与客户端

所有下列路由 POST，按现有 Bearer 会话验证范围，不发外部通知。

|路由|范围|输入|
|---|---|---|
|/v1/qualification/policies|assistance|{}|
|/v1/qualification/evaluate|assistance|policyId, policyVersion, capabilityId, 可选subjectId, evidence|
|/v1/moderation/config|moderation|{}|
|/v1/moderation/reports|moderation|consentId, payloadJson|
|/v1/moderation/reports/query|moderation|可选assistanceId/after/limit|
|/v1/moderation/reports/{id}/read|moderation|{}|
|/v1/moderation/reports/{id}/events|moderation|consentId, payloadJson|

独立客户端新增 /moderation 导出；资格复用 /assistance。宿主控制器、本地签名运行时和开发版原生协作菜单已接通；举报和决定采用一次准确确认覆盖Consent及事件。主菜单结构不改，全局宿主未安装。预览只在内存中；响应丢失后先查询报告，不自动重发或生成重复举报。

## AI Agent 配置与部署

API可设置非秘密配置文件路径GALAXY_GOVERNANCE_CONFIG，最大64KiB，JSON顶层可包含honorRules（贡献规则，默认空；见honor-contribution-v1.md）、qualificationPolicies（最多64项）和moderatorIds（最多8项），以及已有审计/建设者/兼容性角色配置。省略时为空，不编造策略或管理员。配置在服务启动时读取；修改后需重启。使用shared/qualification-schema.mjs的完整策略字段，id@version唯一。

当前启动流程把已加载策略的每个id/version/definitionHash追加到runtime_config_events的qualificationRegistry；与配置摘要同一事务、沿用原配置锁和审计，无新表。仓库大小写、顺序和重复拼写按现有匹配语义规范化；修改门槛、能力、有效期等内容必须使用新版本。移除再加入也不能改写旧版本，两个进程同时提交冲突版本只有一个可成功。此规则从首条带qualificationRegistry的观察记录起生效，不伪造旧记录缺失的逐策略历史。

服务在创建请求、列举和评估时核对数据库中的当前登记，本版实例持有已移除策略时不能继续批准；新版本需重启加载后使用。部署切换应停止尚未接入登记的旧二进制，不能把本版行为套用于仍在运行的老代码。策略完整正文仍在受版本控制的运营配置与配置备份中，运行历史保存可核对的摘要，不声称已经保存旧配置全文。资格列表提供当前正文和摘要；没有启用登记的嵌入式旧测试组合明确返回registeredPolicyVersion=false，正式server启动总会启用登记。

示例空配置：`{"qualificationPolicies":[],"moderatorIds":[]}`。真实策略的能力、仓库、门槛、时间窗及管理员由运营方填写；本仓测试中所有身份及CI均为合成样本。

部署前使用专用迁移角色升至当前Schema39并应用infrastructure/api-role.sql；本批没有新迁移或数据库权限。启动前保留完整治理配置和其运营复核记录；核对策略列表中的configurationEventId、definitionHash与当前配置，验证策略移除后旧实例停止批准、暂停传播和当前验收来源，随后做真实宿主验收。客户端接口仍兼容当前独立包，使用源码摘要确认匹配，不仅凭tarball文件日期判断。

关闭新入口可移除客户端菜单及代理路由，但后台暂停状态必须由明确决定处理；不能直接用空配置解除。资格方法2会使重复来源或纠正前的旧验收不再满足门槛，这是当前来源语义的修正。回退不得丢弃逐策略版本观察或绕过其含义；旧运行时若不认识新快照字段应停止服务，保留数据后使用兼容版本或前向修复。

Schema28最初只记录整组政策摘要；本次在同一历史表中增加逐资格策略摘要并拒绝同版本替换。旧版整组摘要不回填。详见[runtime configuration audit](runtime-configuration-audit-v1.md)。

2026-09-10争议说明补充：协作争议新增四类举报、带引用的补充和附理由的本人说明纠正；原生准确确认、私有正文及导出联动已接通，原记录保留。Schema28/37表不变；新客户端已完成离线安装。详见 `docs/moderation-statements-v1.md`，旧日期记录保留为历史。
