<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/9a/9a66d2d44f69cc078ab5c0ea0576089e2fb794cfbe367dd0ad9f9e5132159968.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# OIDC 登录与 Galaxy 账户关联 v1

2026-09-11，C05-05。本地实现；生产提供者注册、真实用户登录和 OpenCode 人工体验尚未执行，动态云服务未部署。

复用 `openid-client 6.8.8` 实现 OIDC discovery、Authorization Code、S256 PKCE、state、nonce、issuer/audience 和 ID Token 签名验证。独立测试使用 `oidc-provider 9.12.2` 的真实授权服务器；该开发依赖只用于测试，不是生产身份服务。Passkey/GitHub/企业 SSO 可由选定的标准提供者承载，本项目不另造认证服务器。[标准库](https://github.com/panva/openid-client)。

## 用户流程

原生 `/galaxy` 的首次初始化保持冻结。已连接后的“绑定、审计与数据管理”增加“外部账户关联”：选择已配置的登录服务 → 浏览器完成外部登录 → 返回原生菜单查看账户与 Galaxy ID → 本机对准确关联意图签名 → 服务器保存关联。每次登录窗口最长 300 秒；不会自动打开浏览器或创建 Galaxy ID。

外部登录成功时尚未建立关联。只有当前 Galaxy 持钥者确认 `galaxy-identity-link+jws` 后，服务器才保存准确签名字节、issuer/sub、提供者、客户端、原 binding 和端点。服务不收集邮箱/昵称，不保存外部 access/refresh/ID token、Cookie、授权码或 PKCE verifier；临时登录状态仅驻留服务进程内存。认证库验证 ID Token 后只返回最少的身份元数据。

同一端点的同一 issuer/sub 同时只有一份未撤销关联。重新分配必须先由原 Galaxy 主体明确撤销，再由新主体完成自己的外部登录与本机签名；原事实、Proof、信誉和 ID 不转移。关联绑定过期/撤销或提供者移除、issuer/clientId 改变后，关联不能继续作为当前身份依据。仍持原 Galaxy 密钥的人可建立新 binding 后查询并撤销旧关联。

关联不产生 API 凭据，也不创建或扩大 Consent。当前原有 Galaxy 会话仍走原认证路径。OAuth 资源访问与受保护 Personal MCP 已作为独立可选适配器接通，见[配置和边界](personal-mcp-oauth-v1.md)；匿名 Docs MCP 的行为不变。没有提供密码找回、原 ID 换钥、账户合并或组织授权功能。

## 接口与客户端

除 OIDC 回调外，接口均要求当前 Galaxy `binding` 会话范围，POST JSON，不使用浏览器 Cookie 会话。

| 路径 | 输入与结果 |
|---|---|
| POST `/v1/identity/providers` | `{}`；返回当前配置的公开提供者信息 |
| POST `/v1/identity/begin` | `{providerId}`；返回准确授权 URL、Galaxy 主体/binding、loginId 和到期时间 |
| GET `/v1/identity/callback/{providerId}` | 固定预注册回调；标准 code/state/iss 或 error 参数；只显示返回宿主确认的消息 |
| POST `/v1/identity/status` | `{id:loginId}`；仅原主体及原 binding 可读取状态和待签字节 |
| POST `/v1/identity/cancel` | `{id:loginId}`；取消该临时登录，匹配回调不能继续消费 |
| POST `/v1/identity/confirm` | `{id:loginId,signed}`；验证本机签名后保存关联；相同字节可重试核对已提交结果 |
| POST `/v1/identity/query` | 可选 `{id,after,limit}`；仅本人、当前端点，UUID 分页，含撤销或失效状态 |
| POST `/v1/identity/revoke` | `{id}`；本人明确撤销，重复调用不重复审计，不删除本人签署的事实 |

便携客户端增加 `./identity`，提供 `read/prepare/execute/cancel`。准备阶段不签名；执行必须使用准确确认文本和仍有效的本机授权。与其他宿主操作共用忙碌/取消控制，迟到结果不能继续当前 UI 操作。页面提供登录取消、返回、关联预览、分页查询和明确撤销。

确认请求回执丢失时，在登录窗口内可以重取原意图并重试原签名字节；服务重启后已保存的关联仍可查询，原签名也可核对持久结果。重启前尚未完成的登录不可恢复，需重新开始。相同签名重放不会复活已撤销关联。进程最多 2048 个未到期登录、每主体最多 4 个；到期立即拒绝使用，下一次身份操作清理过期内存记录；配置多 API 实例时，登录及回调需要路由到同一实例，当前没有分布式登录状态库。

## 数据与运行

Schema40 增加 `external_identity_links`，当前共 44 张 public 表（含迁移表）。API 角色只增加 SELECT/INSERT 和 `revoked_at` 更新；关联/撤销与完整审计同事务。存储计入现有主体载荷预算，导出增加第 32 个本人数据集 `external-identity-links`。

本人删除执行器与隔离恢复删除重放均覆盖新表；备份保存历史签名字节，隔离恢复将旧关联标记撤销，避免恢复后重新生效。[生命周期](data-lifecycle-v0.1.md)、[清单](data-inventory-v0.1.json)、[备份](backup-recovery-v1.md)、[身份扩展设计](identity-recovery-and-accounts-v1.md)。

临时登录内存不进入备份；端点诊断/失败审计/指标使用固定路由，不保存回调 query。部署所用反向代理和身份提供者也应禁止记录回调参数及令牌。原生界面显示的 issuer/sub 和本人导出文件仍属于私有账户资料。

## AI agent 部署说明

1. 选择已存在的 OIDC 身份提供者，预注册授权码客户端；必须支持 S256，并将回调精确登记为 `https://<目标端点>/v1/identity/callback/<providerId>`。这些是待配置步骤，不是当前已注册的账户。
2. 显式提供 `GALAXY_IDENTITY_CONFIG_FILE` 的绝对路径 JSON。示例结构如下；缺省时加载空提供者列表，界面准确显示未配置。

   ```json
   {"version":1,"providers":[{"id":"enterprise","name":"企业登录","issuer":"https://login.example.org","clientId":"registered-client-id","clientSecretEnv":"GALAXY_OIDC_ENTERPRISE_SECRET","allowedOrigins":[]}]}
   ```

   公开客户端省略 `clientSecretEnv`。机密客户端只填写名称引用，运行进程通过受控注入取得对应值；不写入配置文件、仓库或报告。没有 `.env` 自动发现。跨 origin 的授权/token/JWKS 地址必须在 `allowedOrigins` 中明确列出。生产配置只允许 HTTPS；字面 loopback HTTP 仅为内部测试构造提供者使用。
3. 使用匹配的当前 Schema41 迁移、API 角色及 Caddy 路由片段，保持准确 Official host；Caddy 只放行规定方法和回调路径。实际配置摘要记录为 `identityConfigurationHash`，不包含解析后的秘密。
4. 先在隔离环境运行 OIDC 与本机签名流程，再进行真实提供者和宿主验收。SDK 的独立 HTTP OIDC 测试、本机真实密钥测试与生产登录是三种不同证据。
5. 关闭时移除提供者配置并重启；原记录保留并显示提供者不可用，新登录关闭。新 schema 不能直接交给只支持旧 schema 的程序；回退采用兼容版本或隔离备份恢复，不降级删表。

目前未配置生产提供者、未执行外部账户登录、未全局安装 OpenCode Adapter，未部署动态服务。C05-05 本地交付不替代原计划的真实用户、组织/运营、异地部署和共同发布条件。
