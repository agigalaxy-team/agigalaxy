<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/93/939063aa914f7c85c494ba1c0b71a084840a56406057d9205c26359004d52a43.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# C00-02 版本与兼容窗口

2026-09-11当前基线：Schema41，既有Galaxy会话与可选OAuth Personal MCP分别验证。机器可读定义为[version-contract.json](version-contract.json)，其中protocolProfiles独立登记A2A/MCP/OIDC的实际SDK和wire/profile及仍为候选的协议，当前接口见[开发目录](development-api-reference-v1.md)。本规范冻结当前开发profile，不新增服务能力、协议兼容或免费支持期限。服务和客户端目前都为0.1.0，但它们是独立发行号，不保证以后同步升级。

| 维度 | 当前值 | 规则 |
|---|---|---|
| Official服务 / 轻量客户端 | 分别0.1.0 / 0.1.0 | 独立验证、发行；private产物不是公开稳定版 |
| HTTP路径 | /v1 | 未实现新版本协商或降级；不能仅改URL就使用旧验证器 |
| Manifest / Keyring | schemaVersion1 / version1 | 未知版本拒绝；sequence是信任状态序号，不是版本 |
| Genesis / Core本地存储 | version1 / STORE_VERSION2 | 旧身份不重生成；只读不迁移；缺少Genesis不能远程绑定 |
| Connection Profile / Consent | version1 / version1、policyVersion0.1 | 本地意图与远端授权分别验证 |
| Case事件 | 严格/v1对象schema，无独立version字段 | expectedVersion是事件并发序号；configuration.version是工作环境版本 |
| Proof payload / 数据库 | version1 / 迁移1至41 | 不改历史SQL或签名字节；新迁移新增编号 |
| 浏览器演示 | 独立v2 | v1缓存保留、不导入Core；不是客户端协议版本 |

当前Manifest验证器要求serviceVersion精确等于0.1.0。因此0.1.1也不能在未更新兼容矩阵/客户端验证器前直接宣称兼容。允许补丁版本范围是未来显式设计变更，不能靠宽松解析或失败后降级实现。服务内部不改变wire的修复与公开发行版本应分别评估。

## 当前有界窗口

Manifest300秒；binding challenge180秒；binding最长86400秒；session challenge120秒；会话凭据最长600秒且不超过binding；本机确认300秒；CI观察有效3600秒。这些是协议/授权上限，不是版本支持SLA。实际失效还受pin、Consent、本地意图、服务器撤销和来源状态影响，任一先失效就停止使用。

当前已本地实现OIDC外部账户关联与可选OAuth Personal MCP；既有HTTP `/v1` 接口继续使用Galaxy会话，二者不自动互换，均未因本地实现而公开上线。Personal MCP使用SDK已实现的2025-11-25协议，不能将较新的授权文档日期当成已支持的传输版本。见[认证边界](adr-008-authentication-and-protocol-profiles.md)和[Personal MCP配置](personal-mcp-oauth-v1.md)。以下600秒规则是旧会话入口停发时的迁移约束，不表示当前已自动替换认证。停止旧session challenge签发后，最晚等待最后签发挑战的600秒凭据上限；激活不延长挑战中的credentialExpiresAt。必须确认没有其他旧凭据签发/续期入口，再关闭旧认证路径。可以立即拒绝旧激活以缩小过渡面，但需明确提示未完成连接的用户重新确认。binding仍可保留24小时不表示Bearer认证还能使用24小时；不得恢复撤销记录或自动迁移Consent。

## 发布/回退验收

变更签名对象字段、算法、用途、schema或校验范围时提供新旧矩阵及负向样例；未知版本、旧字段扩权、签名重新序列化、错误issuer/audience均不应通过。修改历史迁移或重生成旧身份不属于兼容升级。回退只能关闭新入口或恢复相容代码/数据副本，不能重新激活撤销权限。

当前验收边界：Node24.13/24.19全量、Node22.13 Core/客户端安装与Bun1.3.14 Core专项见D0-12。不证明所有中间版本、系统或未来新协议。公开维护时间和标准认证迁移日期属于尚未决定的发布承诺，不填写虚构日期。

C00-02版本交付还需与M0威胁模型、数据规则和试点责任完成共同验收；本文件不把M0或生产标成通过。

## 历史迁移记录

以下按原批次保留；其中“当前”仅指该批次时点，现行基线为本文顶部Schema41。

C16后续变更：数据库当前1至7，第7版追加审计上下文；前六版SQL不改。旧六版运行程序会拒绝七版数据库，不直接回退旧进程。见audit-context-v1.md；历史六版验证记录只代表当时状态。

C16认证审计后续：当前迁移1至8；第8版明确认证事件Consent不适用，业务事件要求仍保留。旧7版/6版运行器会拒绝8版库，升级与回退须按当前发行验证。


当前数据库迁移为1至9：第9版仅增加绑定范围审计快照。旧行NULL不回填；8版及更旧严格校验程序不能直接回退到9版数据库。新增字段不是会话权限或Consent有效性的证明。


当前数据库迁移为1至10：第10版增加凭据范围审计快照，旧行NULL不回填。9版及更旧程序不能直接用于10版库。业务审计范围来自事务内锁定凭据，不使用调用者actor.scopes。


2026-09-10更新：当前数据库迁移1至11，新增审计调用方四字段，保留目标字段原语义与历史NULL值。10版及更旧严格校验程序不能直接回退到11版库；需前向修复或经过验证的隔离恢复，不删除历史迁移。

2026-09-10协作更新：Schema12追加Assistance请求/事件表，增加assistance scope与assistance.publish动作，既有凭据不扩权。独立客户端新增/assistance入口，共10个入口。此前1至11说明为历史快照；旧11版程序不能直接回退到12版库。

2026-09-10材料授权更新：Schema13追加Context Grant/接受记录，新增独立context scope（共8种），复用已定义context.grant动作。客户端新增/context入口，共11个入口；旧12版程序不能直接用于13版库。

2026-09-10通知更新：Schema14新增通知偏好/已读表；notifications是第9种独立scope，客户端增加/notifications共12个入口；Assistance事件新增invite与requester-feedback，严格旧解析器需升级。13版程序不能直接用于14版库。
