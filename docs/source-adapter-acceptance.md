<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/27/2727a19fdb5af1fd4529d39167e31508cc7b4893a2052dc70c846e8d0aa7e1e2.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 来源适配器验收边界

当前D0-09来源层继续复用evidenceSource、githubEvidenceSource及EvidenceService，不新增来源平台。适配器只能返回受限观察，不能授权或提升身份/能力结论。GitHub的run、attempt、commit、repository必须匹配，来源必须为公开仓库；来源内容变化产生不同摘要。CI结果始终是repository-controlled、submitter-asserted，capabilitiesVerified=false。

EvidenceService在抓取前检查Case/Attempt/Result/Evidence的有效Consent，抓取后在写事务重新检查。网络失败、无效或不匹配的观察记为unavailable，输出不含上游异常正文；最多5次尝试，并保留调度退避。等待重试期间撤销，下一次处理不抓取而记录revoked。失败事实不能成为可用Proof。任务租约与并发数据库的专门验收仍见D0-04/05和真实PG检查。

测试证据：evidence.test.mjs覆盖去重、发布受限Proof、排队/抓取中/重试前撤销、失败重试上限与不提前抓取、错误来源和输出脱敏；evidence-source.test.mjs覆盖来源字段变化、私库/错误run/attempt/commit和未来时间拒绝、观察字段不能扩大认证或有效期。worker-boundary.test.mjs检查Worker依赖边界。

这里的来源更新测试证明收到新响应后能够识别摘要/结果变化，不证明后台已实现周期重抓取、主动失效传播或完整跨来源验证。当前观察有短期有效期限；这些更完整的业务行为继续由M3任务实现与验收。不得把本次D0-09工程收口写成真实用户Case闭环完成。
