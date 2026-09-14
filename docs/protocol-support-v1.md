<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/b8/b873ece8c51e897b4394d484d3d220ac2a681daafc0d37aa6feadc443a56ce57.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 协议、SDK与宿主支持矩阵 v1

2026-09-11按安装依赖、实际适配源码和已有互操作用例核对。这里说明当前开发范围，不宣称协议最新版本、全功能兼容、正式认证或公开部署。上游资料按既有研究保留，当前安装与实现以源码为准。

|协议/技术|当前实现与版本|外部实现样例/依据|未覆盖范围|
|---|---|---|---|
|Galaxy Core|GUID-32 v1、Genesis1、Store2、Connection Profile1|[Core实现说明](core-spec-v0.1.md)、规范ID样例与原生适配器|不是DID/实名/专业能力认证；旧ID不自动迁移|
|Galaxy会话与Consent|HTTP v1；客户端/服务各0.1.0；Consent1/policy0.1|[接口目录](development-api-reference-v1.md)、[确认式客户端](confirmed-connection-client.md)|既有Galaxy会话令牌不是OAuth token；没有公众API地址|
|MCP本地Edge|现有stdio工具与原生OpenCode接入；安装server SDK2.0.0|[远程工具组合](remote-mcp-tools.md)、仓内真实MCP客户端用例|便携客户端包不包含MCP Server；其他宿主UI未全验|
|MCP Docs|SDK2.0.0；无状态HTTP JSON；当前v0.2/历史v0.1各四文档|[Docs MCP真实SDK客户端测试](../packages/galaxy-official/test/docs-mcp.test.mjs)|没有公开MCP地址；文档版本不等于协议版本|
|MCP Personal + OAuth|SDK当前传输协商2025-11-25；RFC9728发现、RFC7662 introspection、OAuth PKCE/resource|[个人MCP实现](personal-mcp-oauth-v1.md)，真实oidc-provider与独立MCP客户端|26个现有工具；可选配置；未证明2026-07-28整套传输、任意AS/组织或浏览器控制台|
|OIDC账户关联|openid-client6.8.8；认证后本机签署关联；不合并Galaxy身份|[账户关联实现](identity-login-v1.md)，真实oidc-provider9.12.2测试提供者|生产提供者注册与用户未接入；无邮箱猜测关联或自动组织授权|
|A2A|仓内@galaxy/a2a0.1.0；官方@a2a-js/sdk1.1.0；wire1.0/JSONRPC|[适配器范围与双端SDK样例](../packages/galaxy-a2a/README.md)|不是独立公开SDK；无自动OAuth/发现、其他传输或任意远端Task恢复承诺|
|JWS/Ed25519|jose6.2.12；各用途显式header/schema/受众/时限|[发行签名](../packages/galaxy-official/src/release-artifact.mjs)、[独立封装样例](../packages/galaxy-official/test/independent-envelope.test.mjs)|Galaxy封装不能直接等同VC/AITP；固定可信键不等于在线撤销发现|
|DID/VC/OpenID4VC、Passkey|独立候选与后续映射设计|[既有复用策略](../../../../02-architecture/GALAXY_BUILD_AND_REUSE_STRATEGY_v0.2.md)|未实现映射，不修改GUID；不承诺已具备钱包或凭证生态互通|
|AIP、AITP|保持候选状态，分别评估用途与签名/授权语义|[历史技术与复用决定](../../../../02-architecture/GALAXY_BUILD_AND_REUSE_STRATEGY_v0.2.md)|AIP不是A2A的别名；AITP不是通用身份方案同义词；当前不宣称兼容|

历史还提到的身份、授权与代理技术按[原始技术发现](../../../../05-build/GALAXY_ORIGINAL_IDENTITY_CHAT_FINDINGS_2026-09-09.md)和[补充分析](../../../../05-build/GALAXY_HISTORY_TECHNOLOGY_SUPPLEMENT_2026-09-09.md)保留。此矩阵不删除候选，也不因资料存在就把它们加入实现清单。THP不当作已存在外部标准；CloudEvents/PROV等分析候选不倒写为已完成实现。

## 本次构建与宿主范围

|环境|已验证/声明范围|当前限制|
|---|---|---|
|Node24.19.0 / Windows x64|本次31项固定Conformance测试、独立离线客户端安装和21入口消费|不是全部操作系统或真实宿主升级验收|
|Core/便携客户端最低Node22.13.0|package engines声明；既有D0矩阵另存历史证据|本次未重复全部旧版本；不把范围声明当作逐版本实测|
|Official/A2A Node>=24.13.0|服务包engines与runner要求|数据库/生产网络/全功能容量另验|
|OpenCode原生适配|已有 `/galaxy` 与独立接入流程、用户本机签名组合|保留首次冻结交互；实际终端、真实用户和升级/回退体验仍待人工|
|其他宿主/云端服务|分别以已选profile为接入条件|不因支持MCP/A2A就自动列为已支持宿主；Official/Hub动态服务未上线|

本次候选及确切源码范围见[发行流程](client-release-pipeline-v1.md)。Core Spec、协议支持和Conformance资料可在原公共文档发布范围内审阅后发行；当前本地交付不替代公开下载、提供者登记或运营承诺。
