<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/aa/aa4f7e7d3522687db42b0d9d3351c1a86c650e52bae80f75028b4278fd6b8fc6.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# ADR-008：认证迁移与协议适配边界

日期：2026-09-09。范围：D0-08开发决策和独立样例。该决策不表示OAuth/OIDC、A2A、AIP或AITP服务已实现，也不改变Manifest公开能力。

## 决策

继续使用jose处理生产JWT/JWS，不新写生产密码学或OAuth授权服务器。未来受保护HTTP接入采用独立成熟授权服务器与标准客户端库，Galaxy作为资源服务器；具体产品和部署端点在M2集成任务中选定并验收。身份提供者可替换，不能成为本地Galaxy ID的所有者。

当前自定义会话保留为显式版本化的本地开发兼容路径。新标准认证必须通过自己的独立验证入口，不能把未知Bearer自动交给多个验证器尝试，也不能失败后降级回旧会话。D0-09先抽离客户端与纯验证模块；M2再实现标准认证适配，不在本ADR中把候选协议全部集成。

核心授权条件保持为：认证有效、目标资源一致、Galaxy主体关联有效、binding未撤销且未过期、所需scope存在、精确Consent有效。业务写入在同一数据库事务重新检查。任一外部认证成功、信任评分或AI判断都不能跳过这些条件。

## 当前源码的准确行为

| 对象/过程 | 当前实现 | 迁移时必须保留 |
|---|---|---|
| Galaxy ID | Core的GUID与Ed25519 genesis；Official通过独立binding关联 | 不改名、不重生成、不因外部账户登录替换本地身份 |
| Envelope | `signed-envelope.mjs`使用compact JWT，固定Ed25519、用途typ、kid和外部pin；验证原始编码字节 | 新profile不能重新序列化旧签名字节；issuer/audience/用途与有效期明确 |
| Session challenge | `access.mjs`签发120秒挑战，绑定bindingId、credentialHash、scopes；凭据有效期最多600秒且不超过binding | 不把挑战当access token；不从客户端传入的scope获得额外权限 |
| Session response | 本机密钥对完整挑战做`galaxy-session-response+jws`签名 | 用途严格区分；错误密钥、其他challenge或其他签名用途拒绝 |
| 激活与重放 | 锁binding后锁challenge；同一有效挑战重复激活返回同一结果，不再次插入凭据或审计 | 这是幂等消费，不是“所有重复请求都报错”；重放不得延长时限或生成新授权；撤销后拒绝 |
| Bearer | 32字节随机凭据的43字符base64url；数据库仅存摘要 | 不是JWT access token，也不是OAuth实现；保留当前有效期和撤销语义 |
| 授权事务 | `runAuthorized`锁定当前binding和credential；Consent另查精确对象、用途、接收方、字段、摘要及时限 | 外部token验证不能替代实时撤销与对象授权；旧actor不可在撤销后继续写 |
| 发现与Docs | 签名Manifest/根信任链与公开Docs MCP；本地连接工具只读 | 公开发现成功不等于binding、授权、上传或远程账户 |

源码位置：`packages/galaxy-official/src/access.mjs`、`signed-envelope.mjs`、`consents.mjs`、`domain/consent-policy.mjs`和`infrastructure/access-repository.mjs`。当前数据库六版迁移不因本决策修改。

## 迁移步骤与退出条件

1. 冻结旧profile：记录端点、签名类型、scope、最大有效期与数据库撤销规则；独立样例仅证明字节和密码学互通。
2. 增加标准认证入口：发现授权服务器元数据，固定可信issuer、算法和resource/audience；采用授权码与PKCE，精确回调、state和必要的OIDC nonce校验由成熟库处理。机器主体采用独立受限客户端身份，不继承人的权限。
3. 关联外部身份：使用外部`issuer + subject`作关联键，不能使用邮箱作为稳定绑定证明。登录后仍需本机持钥证明与明确同意建立Galaxy关联；不把外部sub当Galaxy ID。
4. 统一业务授权：标准认证适配输出受限身份上下文，并经显式关联和当前数据库授权检查进入用例。新token权限与本地授权取交集，不能并集；OAuth scope不能自动生成Consent。
5. 兼容试点：新旧凭据存储/issuer/验证路径可区分，逐客户端启用。历史凭据不会自动升级为refresh token，已有Consent不会自动扩大；记录不含令牌的验证结果与迁移覆盖率。
6. 退出旧会话：标准客户端、撤销竞态及恢复验收通过后停止旧challenge签发；等待已有凭据最长有效期结束，再关闭旧激活入口。保留审计，不删除事实。尚有依赖旧入口的客户端时不得宣称退出完成。
7. 回退：关闭新适配器并撤销其凭据，不重新激活已撤销binding/Consent，不自动延长旧凭据。必要时用户重新执行明确授权的兼容连接；恢复需要新代码兼容，而不是降级删库。

标准集成前必须补：错误issuer/audience、算法混淆、错误回调、PKCE/state/nonce失配、跨主体关联、重复code、过期、scope扩大、binding/Consent撤销竞态、refresh撤销、授权服务器不可达以及配置错误。当前样例不证明这些OAuth行为。

## 协议profile与范围

| 技术 | 采用范围 | 差异与独立放行条件 |
|---|---|---|
| JWT/JWS | 已采用jose，Galaxy专用typ和严格pin；保留现有profile | 只证明签名与限定claims；业务schema、实时撤销和一次消费仍在业务层。参考[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html) |
| OAuth/OIDC | M2采用标准授权服务器/客户端；OIDC提供外部登录身份，OAuth面向受限资源访问 | ID Token不可作为Galaxy API access token；不自产OAuth服务器。以[OAuth安全BCP](https://www.rfc-editor.org/rfc/rfc9700.html)和[OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html)校验流程 |
| MCP | 保留公开Docs及本地stdio；受保护HTTP另做授权适配 | 本次成功读取的是[2025-11-25授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)：资源元数据、资源指示和PKCE纳入集成。`latest/basic/authorization`本次读取失败，不把固定页或SDK版本称为最新协议；之前2026-07-28记录须在集成时复核 |
| A2A | 候选任务传输适配，不替换Galaxy事实模型 | [官方latest页](https://a2a-protocol.org/latest/specification/)本次标latest release为1.0.0，wire版本1.0；AgentCard安全声明不代替逐请求授权；未部署A2A接口 |
| OpenA2A AIP | 实验性身份映射；不替换GUID或强制信任评分 | [官方页](https://specs.opena2a.org/specs/aip)标1.0.1-draft / draft-fane-opena2a-aip-02；同为Ed25519挑战不表示兼容；其能力声明与评分不直接授予银河权限 |
| AITP | 实验性双方信任握手profile | [Core](https://www.agentidentitytrustprotocol.io/spec/core)本次标0.2.5-draft，wire aitp/0.2；其双向TCT、JCS内部签名与可携带JWS不可直接复用Galaxy单方JWT。RFC-AITP不是IETF RFC |

MCP与A2A在这里是不同适配面。公开Docs不因本次决策被加上强制登录；受保护业务不因支持MCP而开放匿名写入。

### A2A任务映射（2026-09-10 首个本地适配切片）

同日宿主增量：可选工厂接入现有本地运行时和独立连接页第9项；明确选择端点/外部主体、实际本机签名的Result导入、固定事件/Consent及重启回执恢复已验证。没有改动默认初始化或增加公开A2A服务。下段首切片状态保留为历史，当前范围以适配器说明为准。

`packages/galaxy-a2a`现复用官方SDK 1.1.0的JSONRPC 1.0客户端和独立HTTP服务端fixture，完成发送、任务查询、取消、错误/中断状态、Artifact摘要及Case/Attempt关联。真实Case服务加独立Consent的Result提交已在合成数据上验证；未接原生宿主、未部署动态接口，其他传输/推送/标准认证仍待实现。精确范围与使用方式见[适配器说明](../packages/galaxy-a2a/README.md)。下表中的目标映射不代表全部可选功能已实现。

| A2A对象/动作 | Galaxy映射决定 | 不允许的推导 |
|---|---|---|
| contextId | 外部协作上下文映射记录，按端点和主体隔离 | 不能用一个contextId读取其他主体Case |
| taskId / Task | 独立远程Task关联一个Case中的Attempt；保留外部endpoint及id，不覆写Case ID | Task成功不等于Case已独立验证 |
| Message / Part | 明确授权后进入对应Attempt的事件；保留来源及顺序，内容按披露边界裁剪 | 不导入完整宿主聊天或秘密 |
| Artifact | Result的外部产物引用、摘要及来源信息 | Artifact不是已验证Evidence或Proof；链接仍走SSRF防护 |
| working / input-required / auth-required | 分别反映尝试进行中、待用户输入、待授权；准确事件名在适配实现时按schema确认 | auth-required不触发自动同意或给代理无限scope |
| completed / failed / canceled | 记录终态事件；验证结论另存；纠正通过新事实追加 | 不删除失败，不因取消擦除历史 |
| Cancel / stream / push | Cancel逐任务鉴权；先轮询/流式按能力实现，push另验回调URL和凭据边界 | 宣称A2A不意味着所有可选机制已支持 |

### 身份与信任候选逐项处理

OpenA2A AIP的身份字段/公钥、capability、nonce和trust score分别映射为外部身份关联、声明、独立挑战及带来源的观察；不直接映射成Galaxy ID、Consent或统一能力结论。其did:opena2a及加密存储规则需要专门适配；当前本地权限文件不等于其加密身份文件。

AITP的AID、签名Agent Manifest、握手nonce、受众/能力范围、TCT及撤销快照需要独立schema与编码验证；Galaxy Manifest与pin/keyring只可作为差异比较。双向TCT的生成、绑定密钥、失效与重放缓存必须独立测试，当前单方binding receipt不可冒充TCT。

既有历史资料中的DID/VC/OpenID4VC、Entra Agent ID、AuthZEN/OPA/Cedar、OASF、Sigstore/in-toto/SLSA继续保留候选：分别处理身份/凭证交换、企业身份适配、外部策略判定、能力目录和制品来源；全部需要独立用例及数据映射后才启用，不用一个“支持身份协议”勾选框代替。历史来源见项目`GALAXY_ORIGINAL_IDENTITY_CHAT_FINDINGS_2026-09-09.md`，本ADR不新增这些候选的兼容声明。

## 独立验签样例与证据边界

在代码仓根运行：

```text
node packages/galaxy-official/examples/verify-envelope-independent.mjs packages/galaxy-official/examples/envelope-fixture.json
node --test packages/galaxy-official/test/independent-envelope.test.mjs
```

样例仅依赖Node内置crypto/fs/url，未导入Galaxy业务或jose。fixture只含一次性合成公钥、签名对象及固定时钟策略，私钥不落盘。生产jose输出由独立样例验证，独立crypto按不同JSON排版签名再由生产验证器检查。覆盖错误用途、受众、issuer、密钥、撤销pin、过期、篡改、额外header及算法混淆。

fixture中的policy是测试输入，不是现实信任来源。实际调用必须从可信配置提供pin、当前时钟与撤销状态，不能采纳接收到的自声明。样例不是生产JWT解析器、通用JSON规范检查器或身份认证服务；不处理完整业务schema、重复JSON成员的互操作政策或远程撤销获取。输出`authorized: false`是刻意边界；同一对象可重复验签，挑战消费仍由数据库约束。

当前`bindings.test.mjs`还覆盖幂等会话激活、用途混淆、scope拒绝及撤销后访问/激活拒绝；真实PG并发证据单独保留。本ADR不把合成验签测试称为外部协议完整符合性测试。
