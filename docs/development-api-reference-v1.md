# 当前开发 API 目录 v1

由实际路由、独立分发检查及显式接口描述生成。本文件是开发参考，公开 API 端点列表为空；目标服务的部署和运行状态以具体部署记录为准。不能把官网域名作为这里的服务器地址。

当前服务 0.1.0；Schema83；95 个业务路由与 12 个发现、协议或内部路由。

GET/DELETE 的 Personal MCP 条目明确为认证后405；不是成功可用操作。所有方法和配置条件见 [JSON目录](development-api-reference-v1.json)。

## 请求与授权

严格 HTTP JSON 和字节限制、错误、分页及重试见 [API行为约定](api-behavior-v0.1.md)。`galaxy-session` 是既有版本化会话，不能当作 OAuth；`optional-galaxy-session` 只允许匿名读取当前公开投影，提供失效凭据不会降级为匿名。`none` 表示没有 Bearer 要求，挑战/绑定/签名状态等接口仍须验证其专用证明。

`query-type` 的 scope 映射：case/history→history、proof→proof、capsule→capsules、worker/hub→builders。审核角色、可见性、精确Consent与当前来源另外检查。查询参数仅适用于 Consent after 与 OIDC 回调，其他分页参数在 POST body 中。

JSON中 input.fields 是精确顶层字段；input.schema 指向业务 schema 源文件，文件内各操作定义以对应 service.operation 为准，不代表任意该文件对象均可提交。signed/payloadJson 均保持原签名字节，不能由 Agent 根据文档自行签发。

## 业务路由

| 方法与路径 | 认证 / Scope | 服务方法 | 详细说明 |
|---|---|---|---|
| POST `/v1/identity/providers` | galaxy-session / binding | identity.providers | [说明](identity-login-v1.md) |
| POST `/v1/identity/begin` | galaxy-session / binding | identity.begin | [说明](identity-login-v1.md) |
| POST `/v1/identity/status` | galaxy-session / binding | identity.status | [说明](identity-login-v1.md) |
| POST `/v1/identity/cancel` | galaxy-session / binding | identity.cancel | [说明](identity-login-v1.md) |
| POST `/v1/identity/confirm` | galaxy-session / binding | identity.confirm | [说明](identity-login-v1.md) |
| POST `/v1/identity/query` | galaxy-session / binding | identity.query | [说明](identity-login-v1.md) |
| POST `/v1/identity/revoke` | galaxy-session / binding | identity.revoke | [说明](identity-login-v1.md) |
| GET `/v1/identity/callback/{providerId}` | none | identity.callback | [说明](identity-login-v1.md) |
| POST `/v1/binding-challenges` | none | bindings.challenge | [说明](connection-contract-v0.2.md) |
| POST `/v1/bindings` | none | bindings.bind | [说明](connection-contract-v0.2.md) |
| POST `/v1/session-challenges` | none | access.challenge | [说明](adr-008-authentication-and-protocol-profiles.md) |
| POST `/v1/sessions` | none | access.activate | [说明](adr-008-authentication-and-protocol-profiles.md) |
| GET `/v1/bindings/{id}` | galaxy-session / binding | bindings.get | [说明](binding-management-v1.md) |
| POST `/v1/bindings/{id}/revoke` | galaxy-session / binding | bindings.revoke | [说明](binding-management-v1.md) |
| POST `/v1/bindings/query` | galaxy-session / binding | bindings.query | [说明](binding-management-v1.md) |
| GET `/v1/consents` | galaxy-session / consent | consents.list | [说明](api-behavior-v0.1.md) |
| POST `/v1/consents` | galaxy-session / consent | consents.create | [说明](confirmed-consent-client.md) |
| POST `/v1/consents/{id}/revoke` | galaxy-session / consent | consents.revoke | [说明](confirmed-consent-client.md) |
| POST `/v1/cases` | galaxy-session / case-teaser | cases.submit | [说明](local-case-publication.md) |
| POST `/v1/case-events` | galaxy-session / case-teaser | cases.submit | [说明](local-case-publication.md) |
| GET `/v1/cases/{id}` | galaxy-session / case-teaser | cases.get | [说明](api-behavior-v0.1.md) |
| POST `/v1/evidence-submissions` | galaxy-session / evidence | evidence.submit | [说明](source-adapter-acceptance.md) |
| GET `/v1/verifications/{id}` | galaxy-session / evidence | evidence.get | [说明](source-adapter-acceptance.md) |
| POST `/v1/proof-previews` | galaxy-session / proof | proofs.preview | [说明](confirmed-consent-client.md) |
| POST `/v1/proofs` | galaxy-session / proof | proofs.publish | [说明](confirmed-consent-client.md) |
| POST `/v1/proofs/{id}/revoke` | galaxy-session / proof | proofs.revoke | [说明](confirmed-consent-client.md) |
| GET `/v1/proofs/{id}` | optional-galaxy-session / proof | proofs.get | [说明](api-behavior-v0.1.md) |
| GET `/v1/proofs/{id}/status` | optional-galaxy-session / proof | proofs.get | [说明](api-behavior-v0.1.md) |
| POST `/v1/history/query` | optional-galaxy-session / history | history.query | [说明](history-query-v1.md) |
| GET `/v1/profiles/{subjectId}` | optional-galaxy-session / history | history.query | [说明](history-query-v1.md) |
| POST `/v1/profiles/statements` | galaxy-session / history | profiles.publish | [说明](profile-statements-v1.md) |
| POST `/v1/discovery/query` | galaxy-session / history | discovery.query | [说明](project-discovery-v1.md) |
| POST `/v1/discovery/preferences/read` | galaxy-session / notifications | discovery.preferences | [说明](project-discovery-v1.md) |
| POST `/v1/discovery/preferences/save` | galaxy-session / notifications | discovery.save | [说明](project-discovery-v1.md) |
| POST `/v1/search/query` | optional-galaxy-session / query-type | search.query | [说明](typed-source-search-v1.md) |
| POST `/v1/assistance` | galaxy-session / assistance | assistance.create | [说明](open-assistance-v1.md) |
| POST `/v1/assistance/{id}/events` | galaxy-session / assistance | assistance.submit | [说明](open-assistance-v1.md) |
| GET `/v1/assistance/{id}` | galaxy-session / assistance | assistance.get | [说明](open-assistance-v1.md) |
| POST `/v1/assistance/query` | galaxy-session / assistance | assistance.query | [说明](notifications-requester-history-v1.md) |
| POST `/v1/assistance/events/receipt` | galaxy-session / assistance | assistance.receipt | [说明](notifications-requester-history-v1.md) |
| POST `/v1/requester-history/query` | galaxy-session / assistance | assistance.requesterHistory | [说明](notifications-requester-history-v1.md) |
| POST `/v1/requester-history/facts` | galaxy-session / assistance | assistance.requesterHistoryFacts | [说明](notifications-requester-history-v1.md) |
| POST `/v1/context-grants` | galaxy-session / context | context.create | [说明](context-grants-v1.md) |
| POST `/v1/context-grants/{id}/accept` | galaxy-session / context | context.accept | [说明](context-grants-v1.md) |
| POST `/v1/context-grants/{id}/revoke` | galaxy-session / context | context.revoke | [说明](context-grants-v1.md) |
| GET `/v1/context-grants/{id}` | galaxy-session / context | context.get | [说明](context-grants-v1.md) |
| POST `/v1/context-grants/query` | galaxy-session / context | context.query | [说明](context-recovery-v1.md) |
| POST `/v1/context-grants/receipt` | galaxy-session / context | context.receipt | [说明](context-recovery-v1.md) |
| POST `/v1/notifications/query` | galaxy-session / notifications | notifications.query | [说明](notifications-requester-history-v1.md) |
| POST `/v1/notifications/preferences/read` | galaxy-session / notifications | notifications.preferences | [说明](notifications-requester-history-v1.md) |
| POST `/v1/notifications/preferences/save` | galaxy-session / notifications | notifications.save | [说明](notifications-requester-history-v1.md) |
| POST `/v1/notifications/read` | galaxy-session / notifications | notifications.markRead | [说明](notifications-requester-history-v1.md) |
| POST `/v1/notifications/archive` | galaxy-session / notifications | notifications.archive | [说明](notifications-requester-history-v1.md) |
| POST `/v1/qualification/policies` | galaxy-session / assistance | qualification.list | [说明](qualification-moderation-v1.md) |
| POST `/v1/qualification/evaluate` | galaxy-session / assistance | qualification.evaluate | [说明](qualification-moderation-v1.md) |
| POST `/v1/moderation/config` | galaxy-session / moderation | moderation.config | [说明](case-moderation-v1.md) |
| POST `/v1/moderation/reports` | galaxy-session / moderation | moderation.report | [说明](case-moderation-v1.md) |
| POST `/v1/moderation/reports/query` | galaxy-session / moderation | moderation.query | [说明](case-moderation-v1.md) |
| POST `/v1/moderation/reports/{id}/read` | galaxy-session / moderation | moderation.get | [说明](case-moderation-v1.md) |
| POST `/v1/moderation/reports/{id}/events` | galaxy-session / moderation | moderation.event | [说明](case-moderation-v1.md) |
| POST `/v1/honor/rules` | none | honor.list | [说明](honor-rule-history-v1.md) |
| POST `/v1/honor/rule-history` | none | honor.ruleHistory | [说明](honor-rule-history-v1.md) |
| POST `/v1/honor/ranking` | none | honor.ranking | [说明](public-contribution-sharing-v1.md) |
| POST `/v1/honor/query` | optional-galaxy-session / history | honor.query | [说明](honor-pagination-v1.md) |
| GET `/v1/honor/{subjectId}/{ruleId}/{ruleVersion}` | optional-galaxy-session / history | honor.query | [说明](honor-pagination-v1.md) |
| POST `/v1/capsules/events` | galaxy-session / capsules | capsules.publish | [说明](capsule-v1.md) |
| POST `/v1/capsules/uses` | galaxy-session / capsules | capsules.recordUse | [说明](capsule-v1.md) |
| POST `/v1/capsules/read` | optional-galaxy-session / capsules | capsules.get | [说明](capsule-v1.md) |
| POST `/v1/capsules/query` | optional-galaxy-session / capsules | capsules.query | [说明](capsule-v1.md) |
| POST `/v1/capsules/uses/query` | optional-galaxy-session / capsules | capsules.uses | [说明](capsule-v1.md) |
| POST `/v1/builders/specification` | none | builders.specification | [说明](builders-registry-v1.md) |
| POST `/v1/builders/events` | galaxy-session / builders | builders.publish | [说明](builders-registry-v1.md) |
| POST `/v1/builders/read` | optional-galaxy-session / builders | builders.get | [说明](builders-registry-v1.md) |
| POST `/v1/builders/query` | optional-galaxy-session / builders | builders.query | [说明](builders-registry-v1.md) |
| POST `/v1/builders/notices/query` | optional-galaxy-session / builders | builders.notices | [说明](builders-registry-v1.md) |
| POST `/v1/builders/reports/export` | galaxy-session / builders | builders.exportReport | [说明](builder-recovery-and-retry-v1.md) |
| POST `/v1/builders/manage/read` | galaxy-session / builders | builders.manage | [说明](builder-recovery-and-retry-v1.md) |
| POST `/v1/builders/owned/query` | galaxy-session / builders | builders.owned | [说明](builder-recovery-and-retry-v1.md) |
| POST `/v1/builders/events/receipt` | galaxy-session / builders | builders.receipt | [说明](builder-recovery-and-retry-v1.md) |
| POST `/v1/builders/node-control/export` | galaxy-session / builders | builders.exportNodeControl | [说明](node-control-portable-proof-v1.md) |
| POST `/v1/audit/config` | galaxy-session / audit | audit.config | [说明](audit-access-v1.md) |
| POST `/v1/audit/grants` | galaxy-session / audit | audit.listGrants | [说明](audit-access-v1.md) |
| POST `/v1/audit/query` | galaxy-session / audit | audit.query | [说明](audit-access-v1.md) |
| POST `/v1/audit/export` | galaxy-session / audit | audit.query | [说明](audit-access-v1.md) |
| POST `/v1/audit/grants/approve` | galaxy-session / audit-review | audit.approve | [说明](audit-access-v1.md) |
| POST `/v1/audit/grants/revoke` | galaxy-session / audit-review | audit.revoke | [说明](audit-access-v1.md) |
| POST `/v1/data-exports/specification` | galaxy-session / data-export | dataExport.specification | [说明](data-export-v1.md) |
| POST `/v1/data-exports/create` | galaxy-session / data-export | dataExport.create | [说明](data-export-v1.md) |
| POST `/v1/data-exports/page` | galaxy-session / data-export | dataExport.page | [说明](data-export-v1.md) |
| POST `/v1/data-exports/revoke` | galaxy-session / data-export | dataExport.revoke | [说明](data-export-v1.md) |
| POST `/v1/deletion-requests/status` | local-key-signature | deletion.statusWithProof | [说明](deletion-requests-v1.md) |
| POST `/v1/deletion-requests/config` | galaxy-session / data-delete | deletion.config | [说明](deletion-requests-v1.md) |
| POST `/v1/deletion-requests/submit` | galaxy-session / data-delete | deletion.submit | [说明](deletion-requests-v1.md) |
| POST `/v1/deletion-requests/read` | galaxy-session / data-delete | deletion.read | [说明](deletion-requests-v1.md) |
| POST `/v1/deletion-requests/query` | galaxy-session / data-delete | deletion.query | [说明](deletion-requests-v1.md) |

## 发现、协议与内部入口

| 方法与路径 | 行为 | 详细说明 |
|---|---|---|
| GET `/.well-known/galaxy-network.json` | Signed Manifest, ETag and conditional 304; default capability labels binding/sessions/docs-mcp only. | [说明](connection-contract-v0.2.md) |
| GET `/.well-known/galaxy-signing-keys.json` | Configured public keyring; no private keys. | [说明](connection-contract-v0.2.md) |
| GET `/v1/policy` | Public Manifest policy. | [说明](connection-contract-v0.2.md) |
| GET `/v1/signing-keys/status` | Current loaded public trust metadata. | [说明](connection-contract-v0.2.md) |
| GET `/v1/service-status` | Configured retirement/incident status; not independent monitoring. | [说明](service-retirement-v1.md) |
| POST `/mcp/docs` | MCP JSON-RPC, reviewed public document allowlist only; exact Host. | [说明](personal-mcp-oauth-v1.md) |
| GET `/.well-known/oauth-protected-resource/mcp/personal` | Only when Personal MCP configured; RFC9728 metadata. | [说明](personal-mcp-oauth-v1.md) |
| POST `/mcp/personal` | Only when configured; MCP JSON-RPC with scope challenges and current Galaxy authorization. | [说明](personal-mcp-oauth-v1.md) |
| GET `/mcp/personal` | Authenticates then SDK returns 405; no persistent MCP session or event stream in this profile. | [说明](personal-mcp-oauth-v1.md) |
| DELETE `/mcp/personal` | Authenticates then SDK returns 405; no persistent MCP session or event stream in this profile. | [说明](personal-mcp-oauth-v1.md) |
| GET `/healthz` | Internal API probe; excluded from public Caddy routes. | [说明](runtime-health-and-limits.md) |
| GET `/readyz` | Internal API probe; excluded from public Caddy routes. | [说明](runtime-health-and-limits.md) |

## 重建和使用

`node scripts/build-api-reference.mjs` 重建目录及错误字面量索引；`--check` 只检查文件是否匹配。来源扫描限于 Official src，不读取工作区凭据或项目归档。错误索引包含静态 ServiceError 声明；动态/库错误及每个端点的可达状态不由静态扫描推断。

开发方法见[项目工作规则](../../../../02-architecture/current/WORK_RULES.md)，命令见[开发检查参考](development-checks.md)。
