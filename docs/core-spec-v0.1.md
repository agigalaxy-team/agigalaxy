<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/29/29d6ae77a45a84e45feefdc7fd971ad141b16400bb4acbd56c66cb6c0cbeb5fa.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Galaxy Core当前实现说明 v0.1

2026-09-11开发参考。此文把已实现的本地语义、对象版本与云端适配入口集中说明，不新增线协议，也不代表公开服务已部署。代码与严格Schema是当前可执行定义；历史方案不能替代现行源码。配套[协议支持范围](protocol-support-v1.md)、[版本约定](version-contract.json)和[开发API目录](development-api-reference-v1.md)。

## 身份与控制权

GUID-32 v1为32字符：`GUID`前缀4位、版本1位、来源1位、毫秒时间的Base32编码10位、承诺16位。来源标记记录不可变签发背景，不表示信任级别、角色或Hub成员身份。完整算法、规范字符集和解析边界见[galaxy-guid.mjs](../packages/galaxy-core/src/galaxy-guid.mjs)。

承诺使用带`galaxy/guid/v1`域分隔的SHA-256，覆盖来源、时间、公钥与随机nonce，再截取80位；不能把它宣传为128位承诺。Genesis version1记录规范Ed25519 SPKI公钥和16–64字节nonce的base64url编码。Genesis是承诺开封材料，不是私钥；解析ID与证明当前密钥控制权是不同操作。

本机初始化在既定 `/galaxy` 原生流程中，由用户最后精确确认完成。已有身份不因升级、网络失败或新增协议自动重建。缺少原Genesis材料的旧ID不能通过任意新公钥补造证明；遗失密钥恢复、账户关联和组织规则的当前边界见[身份恢复与账户](identity-recovery-and-accounts-v1.md)。

## 本地事实与授权

Core Store版本2包含integration、cases、disclosurePlans、consentGrants、localProofDrafts和auditEvents。[本地模型](../packages/galaxy-core/src/domain/local-model.mjs)与[应用操作](../packages/galaxy-core/src/application/local-operations.mjs)处理实际状态；[本地存储](../packages/galaxy-core/src/local-store.mjs)负责宿主内持久化。浏览器演示使用独立状态，不是本机身份或远程服务的事实来源。

本地工作链为Case → 披露预览 → Consent记录 → Local Proof Draft。默认L3是本地能力与接入意图，不替代远程绑定、每次数据授权或公开发布。Local Proof Draft保留草稿性质，工作结果中的成功声明不自动升级为独立验证或能力认证。

远程Case/Attempt/Result/Revision/Withdrawal使用已有业务对象映射，不复制第二套履历本体。详情见[对象映射](object-mapping-v0.2.md)及[发布流程](local-case-publication.md)。Case事件追加和expectedVersion控制并发；纠错保留原事实，授权失效时按实际服务规则过滤或拒绝。

## 连接与数据动作

Connection Profile version1保留目标与本地意图；它与签名Manifest、绑定回执、访问凭据、Consent分别管理。发现只读取公开资料；绑定需要本机签名并明确目标/Scope；数据发布再核对精确载荷、接收方、用途、可见性和期限。已有会话不会因新增模块自动扩权。

Manifest schema1、Keyring version1、Consent version1/policy0.1、Proof payload version1；服务和客户端版本各为0.1.0，数据库当前Schema41。版本维度相互独立：keyring sequence、事件expectedVersion和数据库迁移号不能作为同一版本使用。完整限制见[版本与兼容](version-compatibility.md)。

OIDC账户关联不改变本地Galaxy ID；OAuth Personal MCP使用当前关联、绑定和Consent。MCP与A2A提供不同的适配通道；均不承担贡献或专业能力认证。DID/VC、OpenID4VC、AIP/AITP仍按候选映射评估，不对旧身份执行自动迁移。

## 可消费组件与验收范围

`@galaxy/client` 0.1.0是独立便携组件，提供21个明确导出入口，包含连接、身份关联、业务查询/发布预览、本人导出和证明核验。宿主负责界面、当前用户确认和最小签名接口；包不自动安装原生适配器，不托管私钥，也不创建用户身份。准确导出、依赖和产物摘要见[当前发行流程](client-release-pipeline-v1.md)。

Core、Official、Edge MCP和A2A保留现有源码边界。已有成熟库承担加密、MCP、OIDC/OAuth与A2A传输，Galaxy只实现必要的工作事实与授权映射。扩展协议需要独立profile、版本和对应外部实现证据，不能只因字段相似就宣称兼容。

Conformance v2检查ids、evidence、signatures、schema、import、privacy、revocation七类；runner2.1.0记录478项源码/输入摘要和逐测试结果。本次31项合成来源测试通过，证明固定范围内的本地实现；它不是全部功能验收或独立第三方认证。真实宿主、用户案例、运营采用与公开发布按原任务验收。

## AI Agent开发与部署

先定位代码仓和[版本契约](version-contract.json)，使用现有锁文件及目标模块的说明。保持初始化交互、本机身份和原日志；公开读取不隐式写入或扩大授权。运行与本次改动相关的检查即可；若准备发行，使用[单次候选构建](client-release-pipeline-v1.md)生成对应源码报告、实际包及安装证据。正式签名和部署只使用明确选定的目标与密钥供应，不从包内公钥建立信任。
