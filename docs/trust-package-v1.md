# 可携带信任资料：普通包 v1 实施说明

更新：2026-09-13。对应 M21 / PREP-M21-IF02 / DEC-SEL-C-Q-trust_format，延续 CUR-35 自动实施授权。普通包已实现；可选 VC 2.0 JOSE 输出仍是独立后续 profile。不能从此文推定完整 M21、八宿主或钱包已验收。

## 用户得到什么

用户选择自述、准确来源、受众和期限，先审阅，再用自己的现有设备签署一份可读资料。接收者可独立离线核对文件、所含身份控制历史和专用复制许可，也可明确选择已连接服务查询当前状态。没有历史的新参与者可以只带明确标为未验证的原创自述。

包签名证明这些文件与所含控制链的对应关系。它不证明内部陈述真实、模型强弱、任务解决或专业资格。普通包是可读文件，受众是签署范围，**不加密、不能阻止转发**。导入只返回检查结果，不生成 Case、Verification、Honor、Capsule 成功复用或其他业务事实。

原文依据与实施边界见项目 `07-logs/development/portable-trust-preparation-v2.md`；原始身份消息定位见 `05-build/GALAXY_ORIGINAL_IDENTITY_CHAT_FINDINGS_2026-09-09.md` 及对应 EVIDENCE JSON。`C-Q-trust_format` 是既有授权代选，不能冒充用户逐字决定。

## 文件和身份

`format: galaxy-readable-trust/v1` 包含确定的 `summary.md`、`objects.json`、`identity.json`，以及原始 `manifest.json` 和 `manifest.jws`。网页另提供完整容器 `galaxy-trust-package.json`；原生导出这六个文件到本机数据目录下 `trust-packages/<packageId>/`，不覆盖不同内容。

摘要与 JSON 同源生成；manifest 保存文件字节数及 SHA256，packageId 是规范化 manifest 基础字段摘要。复用现有 JOSE/Ed25519、canonicalize、GUID 编码和控制事件验证，不新建身份体系。签名类型严格为 `galaxy-trust-package-v1+jws` 或 `galaxy-trust-source-permission-v1+jws`。

`identity.json` 保存真实 genesis 和公开控制事件。旧恢复链验证被提取到共享纯函数，原 Node 入口继续使用原语义；浏览器使用 WebCrypto。原生未初始化云控制的真实 genesis 可产生 epoch 0 自述包。网页首次缺少公开链时要求用户主动刷新公开身份资料；正常准备/签署使用本机缓存和实际私钥材料，不偷偷联网刷新。签署时间是签署者声明，不冒称可信时间戳。

离线 verifier 不执行内容、不跟随 URL、不抓取工件，不向包内任意地址发送身份或凭据。命令：

```powershell
node scripts/verify-trust-package.mjs '<明确选择的本地 JSON 文件>'
```

这是独立 Node 离线验证器，无须连接银河。源码接口在 `packages/galaxy-official/src/trust-package.mjs`：`prepareTrustPackage`、`sealTrustPackage`、`verifyTrustPackage`。返回完整性、历史控制链、期限、内部来源签名、复制许可和当前状态是否检查，分别呈现。

## 精确来源与再披露

当前活跃来源适配支持 Case event、Evidence、Verification。Case 来源的 `id` 是精确事件 UUID，`version` 是该事件的 **Case 版本**；不能拿 Attempt 自身逻辑版本替代。已被后续 Attempt/Result 等事件替代的旧版本标为 `superseded`，仍可明确携带获准读取的历史材料，不冒称当前事实。

`reference` 只带作者、对象/版本、hash、来源性质和观察状态，不含正文或原 Consent。首批无许可引用只允许本人原创来源；别人的当前私有阅读权不能自动变成可携带元数据许可。`copy` 必须有独立 `trust-package-only` 作者许可，精确绑定原作者、来源版本/hash、持包人、受众、期限、原签名摘要及当前设备控制。正文与其源 hash 必须一致。

许可不允许训练、不授予线上读取权，不自动许可被引用的第三方正文。包含尚未覆盖的关联第三方材料时，报告具体不可复制原因；不能从 M19 当前可读导出、Capsule 再用、history/honor 或单任务资格许可借权。现有来源 Consent 中的其他收件人、原绑定等不随复制正文导出。来源正文仅取实际已授权作者记录，不写到许可表。

Proof/CI Proof 的签署主体是特定机构/服务，不等于记录中的用户主体。当前 live reader 对它们返回 `trust_issuer_source_profile_unavailable`；不伪造作者许可。离线格式可单独核对调用者明确信任的原 issuer JWS，但不把包内自行带入的公钥自动升级成可信机构。

## 许可和 HTTP

迁移 67 追加 `trust_package_permissions`，保存作者的精确签署意图、公开控制链、grant/revoke 操作与签名摘要，不保存源正文或整个信任包。原迁移和合法数据不重写。`TrustPackagePermissionService` 挂为 `services.trustPackages`。

以下均为 POST，调用者只来自现有认证；scope `consent`，作者读取来源时还要求当前凭据具备对应 `case-teaser`/`evidence` scope。

| 路径 | 输入和实际行为 |
| --- | --- |
| `/v2/trust-package/permissions/preview` | `id, operationId, source, grantee, audience, expiresAt`；返回精确待签 payload 与正文预览，不创建许可 |
| `/v2/trust-package/permissions/submit` | `{signed}`；校验原作者当前设备、绑定、epoch、精确来源/受众；同一签名重试幂等 |
| `/v2/trust-package/permissions/revoke-preview` | `id, operationId`；原作者预览精确撤销 |
| `/v2/trust-package/permissions/receipt` | `{id}`；原作者原操作回执，其他作者得到 absent |
| `/v2/trust-package/permissions/status` | `{id}`；当次查询 revoked/expired/active/source-or-control-unavailable，不返回正文 |
| `/v2/trust-package/permissions/query` | `role: author 或 grantee, after?`；50 条分页，返回 `items,nextAfter` |
| `/v2/trust-package/sources` | `selections:[{ref,mode,permissionId?}],audience,expiresAt`；逐项可用状态与准确快照，最多 50 条 |

`receipt.state=recorded` 仅证明原操作已记录。未撤销且未到期的回执返回 `recorded-needs-current-source-check`；只有 `status`/来源读取实际重查后才可报告 `active`。作者绑定失效、控制设备改变、源授权撤销、源主体删除等可令新读取不可用，即使包签名仍能离线核对。

许可最长 30 天。许可到期后 180 天清理回执是本切片沿用的技术保留细化，不是原用户逐字决定。本人导出只含自己的签署许可事实；删除不声称能收回外部已发送包。资源预算覆盖许可原签署意图、公开链及撤销元数据；拒绝时事务回滚。

## 网页、原生和模型

网页独立组件 `packages/galaxy-web/src/trust-package-workspace.tsx` 挂 `/app/settings/trust-package`。流程是身份资料→选择自述/来源→受众/期限→准确预览→本机签署→本机下载。带复制许可时实际包期限不超过所选许可最早到期时间，界面提前说明，完整预览列出确切期限。离线导入无需登录；可选在线检查只到已经配置并验证的服务。

`createTrustPackageClient` 复用宿主现有身份签名和本地存储。许可签名先保存原操作再发送。断线只对账原 ID 和签名 hash；重连、旧绑定失效不静默生成新授权。停止本机重试保留对账能力，不宣称服务端取消。未签预览可以取消；已经落盘或发送的外部文件不能用取消预览收回。

`trustPackageToolDefinitions(services,actor)` 提供七个 canonical 数据 MCP 工具。`integrations/native-v2/trust-tools.mjs` 的 `registerNativeTrustTools(server,{runtime,review})` 提供八个用户端工具：公开身份刷新、准备、执行、取消未签预览、离线导入、显式在线检查、许可查询及原操作恢复。`review` 复用现有 choice/loopback；普通授权内查询不新增弹窗，新的精确签署通过真实用户选择，不接受模型伪造 `confirmed:true`。关闭 stdio 进程即关闭审阅页，无新增常驻服务。

银河云只提供数据、当前授权和回执。自述撰写与判断属于用户模型或本人，不引入云模型推理；没有模型参与也可手工完成普通包。

## 实際验证和范围

2026-09-13 已执行的窄检查：原身份恢复 2 项、普通包/独立离线导入 2 项、客户端原操作恢复 1 项、来源历史 1 项、真实 HTTP/PGlite 许可 workflow 1 项、同 workflow + 生命周期的实际 PostgreSQL `galaxy_api`/`galaxy_evidence_worker` 角色检查 1 项、真实 native stdio/loopback 1 项。PG runner 已报告隔离目录清理。测试范围重叠，不相加为产品模块完成率。

主代理另执行 `test/trust-package-device-runtime.test.mjs`：原生真实本地 genesis→连接 epoch 1→断开重启、网页 CryptoKey 缓存离线签署及显式刷新；它是 runtime/协议证据，不是网页 UI 或真实八宿主验收。

公网 `official-2026.09.13-product-v2-r8` / schema 67 已实际验证，报告为项目 `05-build/GALAXY_TRUST_PACKAGE_PUBLIC_R8.json`。2026-09-13 03:35:48–03:35:59 UTC，29 次 API 请求，`passed:true`。本轮使用新建合成身份、明确私有 synthetic Case、仅本人受众与本人作者许可，完成引用、复制、离线验签、选定服务状态检查及撤销后新复制拒绝。许可、source Consent、绑定都已撤销，内存设备材料已清除；合成 Case、身份和审计留存不冒称物理删除。首轮探针把回执误断言为 active，已纠正并保留 `GALAXY_TRUST_PACKAGE_PUBLIC_R8_ATTEMPT1.json`，没有为测试改动服务语义。

网页 r8 部署范围尚不含本组件；截至本说明，源码装配由主代理完成，待合批构建发布。新原生工具已在当前源码接入并实测 stdio；不能把旧签名包当作已包含这八工具。真实浏览器完整流程、真实宿主、新原生发行、可选 VC 输出/钱包及 issuer 复制许可 profile 分别等待后续范围验收。

## AI Agent 接手与部署

先读产品基线、M21 完整阅读包/当前工作包及相关 M01/M06/M19 接口，再查看本文。使用既有部署入口和所选服务公开配置核对 endpoint、公钥与实际 release；不要自动刷新信任 pin，不读取其他宿主归档或用户凭据。服务接线必须包含迁移 67、窄角色权限、资源预算及 M19 保留/导出规则，不能只复制前端。

本地检查按所改切片选择，生成与验证分开：

```powershell
node --test packages/galaxy-official/test/trust-package-format.test.mjs
node --test packages/galaxy-official/test/trust-package-client.test.mjs
node --test integrations/native-v2/trust-tools.test.mjs
$env:GALAXY_TEST_PG_CASE='trust-package-permissions'
# GALAXY_TEST_PG_BIN 必须是明确已核验的本机 PostgreSQL bin。
node packages/galaxy-official/scripts/test-postgres.mjs
```

`scripts/verify-public-trust-package-v2.mjs <实际release> <新绝对报告路径>` 会创建并撤销合成私有资料，只在已有明确外部操作授权内运行，不能用于偷偷验证真实账号。它先核对 HTTPS 公共配置和实际 release，不接触用户浏览器数据库。离线包验签不是线上部署证据；公开 HTTP 成功也不是网页体验验收。

可选 VC 方向只引用官方稳定规范：[VC JOSE/COSE Recommendation](https://www.w3.org/TR/vc-jose-cose/) 与 [VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)。本轮普通包不伪称 VC，也不把后续草案能力写成当前支持。
