<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/11/1140ed08eba8859697bb45116dabb49228bed1b09cf7d7acb1c4a1c3ae8a828f.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Personal MCP 与标准 OAuth 资源访问 v1

2026-09-11，C05-06。本地可选实现；生产授权服务器、真实用户与宿主接入、动态服务部署尚未完成。当前使用项目已锁定的 MCP server/node/client 2.0.0 与 openid-client 6.8.8，不自行实现授权服务器或令牌密码学。独立开发测试使用 oidc-provider 9.12.2，不能作为生产身份服务部署。

## 接入流程与协议范围

Galaxy 持钥者先完成[外部账户关联](identity-login-v1.md)，再由独立 MCP 客户端使用已登记 client_id 向同一授权服务器取得资源令牌。OAuth 令牌不会创建 Galaxy ID、绑定或 Consent。业务读写仍通过既有服务及其当前对象权限，原生首次 `/galaxy` 初始化保持冻结。

| 入口 | 当前行为 |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp/personal` | 启用后提供 RFC9728 元数据，resource 为准确的 `{endpoint}/mcp/personal`，authorization_servers 为选定 issuer，初始 scopes_supported 仅 `galaxy:binding` |
| `POST /mcp/personal` | 标准 Bearer、Streamable HTTP、无持久 MCP session；SDK 提供初始化、工具发现和调用 |
| `GET` / `DELETE /mcp/personal` | 先检查认证；当前无长连接或持久会话，SDK 返回方法不支持 |
| `/mcp/docs` | 原独立匿名公开文档入口，无 Personal 数据或 OAuth 回退 |

401/403 使用 SDK 的 WWW-Authenticate 挑战，附准确 resource_metadata 及当前操作所需 scope。客户端按 OIDC/授权服务器元数据发现、S256 PKCE、授权码、resource 参数和返回 issuer 检查执行；每次资源请求使用 openid-client 的 RFC7662 introspection，核对 active、sub、client_id、exp、scope 和准确 aud。AS 不可用返回固定 503，不用旧查询结果继续访问；不传递用户令牌给业务工具或其他资源。

截至本次核对，所装 SDK 的 `LATEST_PROTOCOL_VERSION` 是 **2025-11-25**，测试使用 SDK 实际协商结果；不宣称支持 2026-07-28 的完整传输协议。授权适配另对照 [2025-11-25 授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) 与 [2026-07-28 授权章节](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/index.mdx)，覆盖资源元数据、发现、PKCE/resource、issuer、令牌与 scope 挑战要求。客户端预登记是本部署 profile；未增加自动动态注册、CIMD 获取、刷新令牌存储或机器主体模拟用户。

## 授权与工具

有效 scope 为 **令牌 `galaxy:<scope>` ∩ Personal MCP 配置 ∩ 原当前 binding**。只有私有认证适配器生成的 actor 可以进入 OAuth 授权路径，复制字段不能伪造身份。业务事务重新锁定当前外部关联及绑定，检查到期、撤销、主体和端点；所有原 Consent、可见性、来源与资源预算继续执行。一次已完成检查的在途请求无法原子追回；下一次请求重新 introspect，本地业务操作重新检查关联和绑定。

30 个工具直接复用现有服务（2026-09-11 增加 Profile 提交与三个项目发现工具，见[项目发现](project-discovery-v1.md)）：

| 范围 | 工具（共同前缀 `galaxy_`） |
|---|---|
| binding | connection_status |
| consent | consents_query、consent_submit、consent_revoke |
| case-teaser | case_get、case_submit |
| history | history_query、profile_submit、discovery_query；search_query 按查询类型要求对应范围 |
| evidence / proof | evidence_submit、evidence_get；proof_get、proof_submit、proof_revoke |
| assistance / context | assistance_query、assistance_get、assistance_submit；context_query、context_read |
| notifications / capsules / builders | notifications_query、discovery_preferences、discovery_preferences_save；capsules_query、capsule_get；builders_query |
| audit / data-export | audit_query；export_create、export_page、export_revoke |

工具输入由既有严格 schema 生成；工具写入仍要求原服务需要的精确签名或 Consent。MCP 不持有本机私钥、不代签，也未暴露完整本地宿主的管理与草稿工具。OAuth scope 只授予操作类别，不能代替某条 Case、Proof 或 Context 的授权。

## AI Agent 部署步骤

1. 复用已有隔离 API、PostgreSQL 和 Caddy 配置；运行当前 **Schema41** 迁移及匹配角色脚本。新增迁移仅扩充审计约束，仍为44张 public 表、32类本人导出集。
2. 先配置已有 `GALAXY_IDENTITY_CONFIG_FILE`。选定提供者必须支持 OIDC 发现、授权码 S256、资源 audience、RFC7662 及撤销。身份关联客户端和 MCP 客户端须取得可一致映射的 issuer/sub；pairwise sub 若因客户端不同而不同，将被当作未关联主体拒绝，不能用邮箱猜测合并。组织访问条件由选定 AS 执行，本版没有组织授权模型。
3. 在 AS 登记准确 MCP 客户端与回调，配置资源 URI 和所需 `galaxy:` scopes；另登记仅允许 introspection 的 confidential resource client。运营者从外部秘密存储向 API 子进程注入其 secret，不放入项目、JSON、日志、URL 或用户公开配置。
4. 设置 `GALAXY_PERSONAL_MCP_CONFIG_FILE` 为显式绝对 JSON 路径。以下仅是结构示例，不是可直接上线的身份服务：

```json
{
  "version": 1,
  "providerId": "selected-provider",
  "introspectionClientId": "galaxy-resource",
  "clientSecretEnv": "GALAXY_OAUTH_RESOURCE_SECRET",
  "allowedClientIds": ["registered-mcp-client"],
  "allowedScopes": ["binding", "consent", "case-teaser", "history"],
  "allowedOrigins": []
}
```

5. 默认只向选定 issuer origin 进行授权传输；若 AS 的发现/授权/token/introspection 分布在其他 HTTPS origin，在 allowedOrigins 中逐项明确配置。该字段不代表浏览器 CORS。所有 Origin 浏览器请求仍拒绝，未开放网页登录控制台或 Cookie 会话。
6. 使用当前 `deploy/caddy-routes.mjs` 路由片段。它只给准确 Official host 转发上述路径和方法；保留应用 no-store 及认证挑战头。API 启动先完成发现和配置校验，随后记录 `personalMcpConfigurationHash`；secret 值不进入摘要或审计。重启所有实例才能统一应用新配置，配置历史不等于全实例同步证明。
7. 用独立 MCP 客户端验证401发现、真实提供者登录/PKCE、工具发现、批准后的读写、403范围提示及撤销。客户端应按本地隐私策略保管令牌；本服务器没有客户端 token 持久存储。生产提供者、TLS与真实宿主验证属于部署验收，当前仅隔离测试已执行。

## 运行、审计与关闭

成功业务调用在同一事务追加 `oauth.access`，包含真实 OAuth client_id、准确 resource、Galaxy 主体、原绑定、外部关联、实际 scope 与请求ID，不含 token。原对象审计保留原 binding/Consent 语义，可用同一 HTTP request ID 关联；不能把原安装实例字段误解为 OAuth client_id。认证与范围拒绝进入既有持久 HTTP 失败审计，保留版本2的脱敏 caller 快照。工具业务失败按 MCP `isError` 返回固定错误码，不伪造成功的 oauth.access；既有业务事务规则决定其审计记录。

请求和主体配额继续生效，当前 MCP POST 统一使用保守的 submission 类别（包括查询）；没有新建无限额读取路径。事故 contained/recovery 与停服取回阶段按既有 HTTP 阻断规则关闭整个 Personal MCP；用户通过原本机入口使用仍开放的撤销/取回 API。

移除 Personal MCP 配置并重启即关闭该入口及其元数据，运行配置记为 null；不会删除既有账户关联、业务事实或审计。撤销外部关联/原绑定能阻止仍有效的外部 token；移除允许客户端、范围或身份提供者后须重启实例。Schema41 不可交给仅支持40的旧程序直接启动；关闭功能时保留当前兼容程序，代码降级走既有隔离恢复或兼容发布流程。

## 本地验证入口

```text
node --test packages/galaxy-official/test/personal-mcp.test.mjs packages/galaxy-official/test/personal-mcp-config.test.mjs
```

设置 `GALAXY_TEST_PG_BIN` 和 `GALAXY_TEST_PG_CASE=personal-mcp` 后运行 `node packages/galaxy-official/scripts/test-postgres.mjs`，会创建并清理专用临时数据库，使用 galaxy_api 角色和独立真实 OAuth 库验证协议。测试账户、密钥和 AS 仅存在于该隔离测试；它们不计为真实用户、生产登录或云服务上线。
