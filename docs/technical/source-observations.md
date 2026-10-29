# 来源观察与远程 Proof

Evidence 保存对指定来源的观察，远程 Proof 对获准的观察作签名声明；它们与本机 Proof Draft 分开。原始来源、归属声明、实际工作结果和能力判断仍按[工作事实](../product/collaboration.md#事实结果与经历)区分。通用身份、当前权限和原操作恢复见[接口](interfaces.md#管理身份与原操作)。

## 来源观察

当前 GitHub 适配器按仓库、提交、run ID 和 attempt 固定来源，核对公开性、返回身份与时间。结果明确标记为 CI 执行事实、仓库控制的来源及提交者声称的归属，能力未被验证；失败或取消的真实结论也可如实保存。只读取获准的公开 API，不运行上传代码、不替用户重跑 workflow。

[来源适配器](../../go/internal/evidence/github.go)与[通用观察合同](../../go/internal/evidence/github.go)定义合法字段、时效和限制。观察保留采集时间、来源、验证器版本、摘要及局限，不保存整份原始API响应。相同主体的固定来源键避免重复导入；采集前和提交前重新核权。

[Evidence服务](../../go/internal/evidence/service.go)与[Worker](../../go/internal/evidence/worker.go)以原业务任务号和租约领取任务，续接前核对原任务、当前来源与可选重验证事件；租约、退避、尝试次数和并发约束以该实现及配置为准。独立Worker没有因此成为沙箱，部署仍需限制数据库和网络权限。

## 预览、签名与读取

[Proof服务](../../go/internal/evidence/proofs.go)当前签名类型为 ci-execution-observation，断言范围仅是被引用的CI运行。预览返回准确字节及摘要，不发布；发布重新读取有效来源、重建投影、比较完整字节，并验证针对这些字节的 proof.publish 许可。

签名载荷保留主体与获准公开来源关联，不放入本地Case正文或内部Result ID。读取时还检查原来源观察、许可受众、当前签名密钥及有效期；来源改变不会悄悄替换已签载荷。签名证明对应字节和发行者，不证明结果独立核验、个人能力或永久访问资格。

拥有Proof不等于拥有Case详情。当前实现可以附加[获准Case更正与争议上下文](../../go/internal/cases/proof_context.go)，它在读取时独立核权，明确为 case-owner-reported，不改变已签CI事实。被隐藏、撤销、未知或无权读取的对象按统一不可见响应处理。

## 数据与实际效果

观察和Proof在事务中保持来源、许可与版本关系；对已另存副本的外部删除不能由这些读取控制保证。查询、重新观察及正式运行效果分别判断，原始合成测试记录不构成真实CI来源或全部生产流程已验收。运行状态和剩余工作只维护在 [WORK_STATUS](../../WORK_STATUS.md)。
