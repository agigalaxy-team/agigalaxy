# 外部认证材料

已登录的银河在线账户可以导入、查阅和撤回本人持有的外部签名凭据，不要求安装本机银河或拥有银河ID。资料属于当前在线账户，默认仅本人可读；不会随导入公开。银河不签发主体或专业认证，也不根据凭据名称判断专业高低、能力或可信度。普通注册和发帖不以前置认证为条件。

签名有效、认证对象属于当前账户、处于有效期以及发行者的当前撤销状态分别呈现。不能核实归属的材料，只作为持有人提交的签名材料保留。创作者选择外部条件时，只有满足明确发行者、签名类型/声明、强主体绑定及当前未撤销状态的凭据才满足该条件。未知、过期或已撤销均不能通过条件。

## 支持的签名格式

- VC-JWT 1.1：JWT受保护头为 `typ: JWT` 或未声明typ，载荷中的 `vc` 使用 credentials/v1 context，类型包含 `VerifiableCredential`。JWT `iss/sub/jti` 与存在的对应VC字段须一致，`nbf/exp`及VC日期按声明的交集执行。
- JOSE VC 2.0：受保护头 `typ: vc+jwt`，载荷直接是使用 credentials/v2 context 的VC。发行者、对象与有效期来自已签载荷。

两者目前均支持单个 `credentialSubject` 对象。只使用配置中的公钥，支持 EdDSA/Ed25519、RS256、PS256、ES256、ES384 的明确选择。提交材料中的 `jku/jwk/x5u/x5c` 不用于找密钥；不请求VC context、DID文档、附件或材料中的URL。OIDC登录令牌不是专业凭据，也不能按VC导入。声明JWT audience时必须包含当前官方API endpoint。

强主体绑定可用签名中的 `sub` 或 `credentialSubject.id` 精确对应当前账户URI：`<endpoint>/v1/account/public/<account-id>`。发行者配置了 `subjectBinding` 时，也可精确对应服务端已验证的外部账户issuer/subject。材料自述、登录邮箱以及用户点了“导入”本身不构成专业归属证明。

## 配置发行者与撤销来源

API读取 `GALAXY_EXTERNAL_CREDENTIALS_CONFIG_FILE` 指向的绝对JSON路径。未配置时等价于下面的有效配置：

```json
{"version":1,"issuers":[]}
```

此时返回无可用发行者，不生成示例机构或假认证入口。已有私有记录仍可查看及撤回，但不再满足外部条件。

每个发行者配置包含 `id/name/issuer`、公开签名 `keys`（带唯一kid的JWK）、允许的 `algorithms/formats`，以及可选的 `subjectBinding/revocation/conditions`。不接受私钥、对称密钥或签发权。`conditions` 仅映射该发行者的精确VC类型及可选 `credentialSubject` JSON pointer 的标量相等值，不含专业等级推断或分数换算。只有配置了实际撤销源的条件才出现在可选目录。

当前提供一个明确的撤销适配协议：`revocation: {kind:"signed-list",url:"<fixed-https-source>",maxAgeSeconds:300}`。这个固定来源返回JSON `{jwt:"<issuer-signed-status>"}`；该JWS受保护头为 `typ: credential-status+jwt`，同一发行者签署的载荷为：

```json
{"iss":"<configured-issuer>","iat":2000000000,"exp":2000000240,"purpose":"revocation","complete":true,"revoked":["<credential-id>"]}
```

上述时间和占位符仅说明格式。`complete:true` 表示列表在其有效期内完整覆盖该发行者凭据ID；不在列表中的相应ID才可报告未撤销。没有凭据ID、未配置来源、状态签名错误、网络失败或快照过期时显示未知。若VC声明了 `credentialStatus`，此适配仅接受与配置URL相同的 `SignedCredentialStatusList`；其他声明的状态格式保留未知，不绕过。

这不是通用VC撤销栈，也不宣称支持StatusList2021或BitstringStatusList。真实发行者采用其他机制时需接对应适配，现有材料仍可如实保留，但不用于资格放行。请求仅访问配置中的固定HTTPS来源，复用公开地址解析与TLS保护，不跟随重定向，不带用户cookie、会话或其他凭据。

后台按批更新已导入材料的状态，受控内容读取只消费仍有效的签名快照，不为每次阅读发外网请求。公钥或来源配置变化后，不沿用不相符的旧状态。原始JWS仅留在服务端私有账户存储，不出现在列表、详情、日志或公开资料中。

## 官网接口

所有接口使用当前官方账户cookie和 `X-Galaxy-Account-Id`；写入还使用 `X-Galaxy-Account-Csrf`。响应为no-store，不授予Galaxy ID控制。

| 请求 | 结果 |
|---|---|
| `GET /v1/account/external-credentials?after=<id>` | 发行者可用状态、本人列表和下一页位置 |
| `POST /v1/account/external-credentials`，`{credential:"<JWS>"}` | 验证并导入；相同材料重试复用已有记录 |
| `GET /v1/account/external-credentials/<id>` | 本人可读说明及已签VC声明，不回显原JWS |
| `POST /v1/account/external-credentials/<id>/recheck`，`{}` | 按配置来源重新核对 |
| `DELETE /v1/account/external-credentials/<id>` | 本人停止使用，移除签名原件和完整声明；保留有限导入/撤回说明 |

本人撤回立即停止条件使用；它不等于发行者吊销，也不影响发行者自己的系统。需要重新使用时可明确重新导入。请求参数、状态读取和数据库访问都按当前账户隔离。

## AI Agent部署

部署者先读取当前服务endpoint与官方账户配置，采用迁移88并给API角色配置该私有表的必要读写权限，然后配置真实发行者公钥及其实际状态来源。不要从用户粘贴的凭据自动注册发行者、找远端密钥或开放网络目的地。未准备真实来源时保持 `issuers:[]`，官网继续提供普通参与。

仅在集中检查时使用该域代表测试：`node --test packages/galaxy-official/test/external-credentials.test.mjs packages/galaxy-official/test/external-credentials-http.test.mjs`。测试使用合成发行者和真实JOSE签名，不能据此声称真实机构、生产状态源或完整VC生态已验证。
