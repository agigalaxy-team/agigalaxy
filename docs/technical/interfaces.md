# 接口、配置权威与协议边界

修改接口时先定位真实 dispatcher、shared schema 与领域服务。本页保存跨组件边界及源码定位，不维护另一张完整路由注册表；业务含义归产品主题，实际字段、方法和错误由对应源码定义。

## 权威边界

| 边界 | 权威入口 | 必须保留 |
|---|---|---|
| Hub 服务族 | `packages/galaxy-official/src/operations/configuration.mjs`、`deploy/runtime-settings.example.json`、`release-resources.json` | 四入口同发行、完整迁移列表、业务库及角色分离 |
| Web/Native | Official `browser-client.mjs`、`src/shared/`，Web runtime 与 Native handoff | 账户登录、本机控制、连接 scope、来源 Consent 各自有效；网页不因登录创建/恢复本机 ID |
| Admin/BFF | `apps/galaxy-admin/.env.example`、`lib/access/`、Node 运营路由 | 独立管理会话，当前人权与所选 AI 角色交集，后端事务内重新核权 |
| AgentOS | `services/galaxy-operations-agentos/runtime.env.example`、`config.py`、`tool_schemas.py` | 私有 service key/JWT，Node 签发控制与原操作归因；服务 key 不等于业务角色 |
| Gateway | `services/galaxy-model-gateway/SOURCE.json`、`models.empty.yaml` 与原生读回 | 固定上游、人工模型配置，测试不自动选择 provider 或发送真实模型请求 |
| Keycloak | `apps/galaxy-auth/client-contract.json`、`realm-profile.mjs` | 普通账户、管理账户、本机 ID 分离；主题复用 Web/Mail 源 |
| 发行恢复 | `service-release.mjs`、`deploy/service-release-host.mjs` | 主机文件、unit 与读回显式输入，原 operationId，不伪造 schema 降级 |

所有上述配置示例只描述格式。真实 `.env`、provider key、数据库密码、Cookie、私钥及运行配置通过保护存储或短期进程注入，不进入 Git、网页配置、源码包、日志或提示。

## 定位 HTTP 与生成参考

Official `src/adapters/http/` 下各 dispatcher 负责准入和解析，领域层负责当前授权与事务：

| 修改目标 | dispatcher 文件（相对该目录） |
|---|---|
| 网站账户/注册用户 | `official-account-http.mjs`、`operations-registered-users-http.mjs` |
| 管理账户/AI 账户/角色 | `operations-management-accounts-http.mjs`、`operations-ai-work-accounts-http.mjs`、`operations-permissions-http.mjs` |
| 审计/业务对象/文件 | `business-admin-http.mjs`、`operations-business-http.mjs`、`operations-file-access-http.mjs`、`operations-file-cleanup-http.mjs` |
| 社区与聊天治理/反馈 | `operations-forum-content-http.mjs`、`account-chat-governance-http.mjs`、`operations-chat-message-http.mjs`、`operations-feedback-http.mjs` |
| 消息/SMTP | `operations-messaging-http.mjs`、`operations-smtp-http.mjs` |
| 推荐/搜索质量 | `operations-recommendation-http.mjs`、`operations-search-quality-http.mjs` |
| 策略/固定规则 | `operations-strategies-http.mjs`、`operations-rules-http.mjs` |
| 工作台/模型 | `operations-agentos-http.mjs`、`operations-model-settings-http.mjs` |
| 系统/维护 | `operations-system-settings-http.mjs`、`operations-maintenance-http.mjs` |

公开搜索、推荐、事件及管理分析另在 `src/discovery-runtime/http.mjs`；`GET /v1/operations/discovery/analytics` 使用当前 `analytics.read`，并校验 kind/days/scope/accountId。自动运行在源码中定位 `/v1/operations/autonomy/`，不把接口存在视为处理器或执行环境就绪。

[`development-api-reference-v1.json`](reference/development-api-reference-v1.json) 是显式登记子集，未登记不等于接口不存在；[`api-error-catalog-v0.1.json`](reference/api-error-catalog-v0.1.json) 是静态 ServiceError 字面量索引，不推断动态/库错误或每路径可达性。生成使用 `node scripts/build-api-reference.mjs`，`--check` 只比对生成结果；扫描限 Official 源，不读取凭据或项目档案。相应测试入口为 `node --test packages/galaxy-official/test/api-reference.test.mjs`。

目录的源码包版本不是部署发行号；空 `publicApiEndpoints` 不表示现网无 API。`input.fields` 是精确顶层字段，`input.schema` 指向业务定义，不能将同一文件的任意对象混用于操作。`signed`/`payloadJson` 保留原签名字节，不按说明自行生成证明。

`galaxy-session` 是版本化会话，不等同 OAuth；`optional-galaxy-session` 只允许匿名公开投影，失效凭据不降级匿名；`none` 不免除专用挑战/签名/绑定证明。query-type 中 case/history→history、proof→proof、capsule→capsules、worker/hub→builders，审核角色、可见性及精确来源仍另查。Personal MCP GET/DELETE 认证后返回 405，当前 profile 无持久 MCP session/event stream；`/mcp/docs` 仅提供审定公开白名单。`/healthz`、`/readyz` 是内部探测，不放入公网 Caddy 路由。

[`version-contract.json`](reference/version-contract.json) 保存协议/本机格式比较值；[`data-inventory-v0.1.json`](reference/data-inventory-v0.1.json) 是声明与独立存储差额索引，不证明全站生命周期或恢复覆盖。迁移以当前 registry 的完整序列为准，不从最大数字推断中间版本均已注册。

## 管理身份与原操作

在线账户Cookie、本机设备签名、连接scope、来源Consent与管理角色是不同权威。正文读取按准确来源、版本、受众和期限重核；旧预览或成功回执不授予当前读取权。实现应在领域服务和提交事务内落实相关检查，不能从界面可见、同名字段或调用方权限快照推定授权。

浏览器经独立管理登录、Next BFF 的精确路径、Cookie/CSRF、服务授权进入领域。角色分给不可变管理 ID，受托读取、准备和卡执行同时核人类当前权限与岗位当前角色；无人值守另核真实岗位、原 grant、动作、对象、策略与版本。`/v1/internal/agentos/` 仅供受保护服务调用，不经公网/BFF。模型字段、旧 preview、同名账户或管理员 cookie 均不能制造 AI 身份。

根资格由保护文件固定管理 issuer、subject、operatorId；邮箱不是身份。`rootOperatorFile`、`managementAccounts.writerCredentialFile` 是 operations 配置引用，读/业务写/管理写客户端分离，writer 不进入 Worker/前端。管理目录与 AI 账户的结构分别源于迁移122/123；部署按完整 registry 前进，不用 GET/构造器偷偷创建岗位。AI 初始化无默认角色/关联/自动授权，能力单源为 `operations-ai-work-capabilities` 的纯 shared 合同。

管理邮箱通过原生 `UpdateEmailActionTokenHandler` 验证成功才替换，保持 subject/角色；Keycloak26.7.3 的 build 需 update-email feature，不因此启用整个 realm 的 verifyEmail 或 UPDATE_EMAIL required action。提交邮件仅为 submitted。provider 更新须核实际挂载 JAR、索引 mtime 与镜像，而非只检查导出文件。

自动运行由 PostgreSQL/pg-boss 保存计划、任务、领取、版本和回执，Agno 处理模型/工具。新任务冻结工程参数、岗位提示词和策略版本，每次业务写仍重核停用、撤权、接管及对象。PAUSED 仅在原 run/待决调用上接续，CANCELLED/完成不伪称恢复。总并发仅支持1或2，日计划须明确时刻。具体调用次数/token 取真实请求与 SDK 元数据；缺项未知，业务完成取实际业务回执。原任务/工具/稳定身份生成审计 actor_context，拒绝 HTTP/模型自报。

Conversation原provider工具ID只供SDK配对/后续模型请求，Node接收按当前run与完整provider值派生的短UUID5引用，公开元数据不带thought signature；持久化核同run真实已存投影，不能仅凭UUID形状或marker认引用。Duty私有PAUSED保存继续原工具所需坐标，公开读取仍过滤。相关原生持久化与续接见[原生运行](agent-runtime.md#持久化调用与有限恢复)。

`jobs.cancel/jobs.retry/search.retry` 使用已有队列或索引事务与同事务审计。具体操作卡冻结任务状态、重试次数或索引代数；原operation只读恢复，不因任务后续变化重复派发。泛化队列自主处理限已获准的information-watch，发布、消息与清理队列仍经具体人工卡并检查各自业务权限；索引重排继续在后续构建时核当前来源资格。

Task征集与整单终止的业务含义由产品正文维护；工程合同仍共用 `task-schema-v2.mjs`、`task-owner-control-v2-schema.mjs`。stop-enrollment是追加事件，不改原事件；新的close要求 `terminationIntent:"terminate-task"`，缺该字段的旧close只读已接受原回执，不补字段、转换事件或在absent后重发。HTTP/MCP/Web共同升级，沿任务版本CAS/数据库锁，重复原事件回原回执而不增长事实；文档合并不代表该候选已上线。

跨HTTP、Native与管理工具的结果未知统一保留原operationId、准确输入字节/摘要及身份，先查询原回执；读取终态失败不能推断原写入失败，也不新建编号重发。各适配器的journal、requestId或主机状态机在所属文档说明。工作台人工操作通过具体卡点击；暂停不撤销已提交效果。人工重试仅在完整原body、同身份/CSRF、原GET新鲜not-recorded、当前权限及所有原版本仍一致时适用；locator-only不重建body，自动链只GET。

### 受控查询投影与使用分析

Official `src/operations/agentos/query/` 的 `registered-directory.mjs`、`system-settings.mjs`、`safe-values.mjs` 只生成安全DTO、有界标量和联合read lease，原 `operations-agentos-query-extensions-view.mjs` 是明确兼容转出；分派、当前人/AI权限交集和evidence lease仍在原服务，不执行效果。注册目录口径不是业务profile数，General只表示当前公开publication、不是未读CMS草稿；邮件/服务各自保目标、连接与adopted-version。禁止spread上游DTO；凭据及其references、原subject/issuer、session和上游错误排除。服务capture须真实包含新相对模块，import成功不证明制品齐备。

`src/discovery-runtime/analytics.mjs` 集中校验输入、账户/访客口径、时间窗口与OpenPanel来源，`DiscoveryRuntime.analytics`保留入口并委托它。业务本期/前期为等长不重叠秒级窗口，留存是原生近12周活动cohort，不称注册留存；零、未知、无样本分别保留，不能用当前日历或空结果补历史。原生读取前和返回前各核权限。相同服务制品需runtime与analytics两个模块，不另启分析服务，不因空样本扩权、改模型或写历史事件。

Native查询窗口显式传days；缺省采用该视图已发布schema默认并在答案说明，保period/basis/coverage。全局运行仅投影已记录的modelSettingsVersion/modelSettingsVersions，旧/非法值null，不查当前配置回填历史、不由单数推复数，也不公开模型名称/端点/凭据。反馈的分类/模块/状态恢复不附带新增内部备注授权；反馈是收集、分类和处理状态，AI取材使用独立feedback-processing用途，不形成双向客服、画像或发现事件。

## 系统设置与消费者采用

`system.settings.read/configure/test/apply/credentials.write` 是人工专有权限，路由和事务内均查。保存是不可变版本与 CAS revision；测试/采用绑定已保存版本、操作者、原输入和 operationId。凭据只落主机保护存储，PG/浏览器/回执只存引用与元数据。

SiteSettings 是常规品牌设置的唯一真源；发布只替换 settings，保留 pages/media 并校验基底，冲突保留草稿并重读。邮件 NULL 绑定表示沿用原来源，不是停用。五服务为 OpenPanel/Gorse/Meilisearch/Agno/ClamAV，模型、业务规则、预算和数据策略保留各自权威。保存、写 JSON、健康正常与实际采用不同：运营邮件/五服务需当前 PID、同版本与实际消费者连接回执；认证/告警回读原生配置。初次接入前的来源保持 observed/unknown。

API/Worker 的 `GALAXY_SERVICE_CONNECTIONS_METADATA_FILE`、`GALAXY_SYSTEM_SETTINGS_MAIL_METADATA_FILE`、`GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE` 分别指向准确角色可读文件；维护执行沿原 UDS/HMAC 通道及同一控制文件，不新造端口/密钥。固定源原子替换需受限父目录 `ReadWritePaths`，不覆写 `/run/credentials` 运行副本。CMS 需同批迁移 `20261024_110000_system_settings_general`。Payload 原生 CLI 的共享 Zod 解析不受 Next alias 影响：所需 Zod4.5.4 从同发行已安装 app 建受限相对链接并核目标，不能复制合同或安装整个后端作为绕过。

## CMS快照与发布

管理员选择正式快照，银河原发布队列准备并激活不可变 `cms-snapshot.json`、选中媒体及私有 `cms-publication.json` 指针。不执行 Python HTML 应用器，也不复制软件基线。首次无指针可正常发布；显式 baseline marker 使用 null ID，不能伪造已发布 UUID。

Next.js 读取当前发布数据；发布根损坏不能回落到软件旧内容。首页保留原互动区域，发布调整作者文案及额外内容；下载/版本页面保留程序化发行资料。媒体 URL 保持 `/media/cms/<id>/<filename>`。

`GET /site-publication.json` 只公开 version/publicationId，系统设置据此核对实际采用；私有 marker/snapshot 不公开。`GET /cms-routes.json` 返回当前公开 CMS 路径。公开页面收到真实完成事件后只核对最小 publication metadata，ID 改变才刷新当前 React 服务端正文，不重载整页或重建根会话。

## 网页变化与快照接续

`GET /v1/web-events` 服务网站账户/匿名或原 Native Bearer，`GET /v1/operations/web-events` 使用独立管理会话。`topics` 为固定模块，`cursor` 为十进制接续位置；默认 SSE，`stream=false` 返回有限事件与当前位置。source 当前权限由原业务服务核验，订阅对象编号不是授权。

帧为 change/reset/snapshot；change 只在核权后提供最小对象标识、可得版本和原操作号。共享客户端目前按模块失效，不能声称所有对象均精准到单条查询。snapshot 只推进位置，不触发周期 GET；reset 清相应投影并恢复。补发最多 256 条，日志最多 4096 条且不超过 7 天，超界要求模块快照。

业务 GET 在源读取前捕获 `X-Galaxy-Event-Cursor`，后台 SSR 通过这一位置接续，保留字符串 `0`。没有可靠位置的兼容来源先重核，不能直接跳到最新并丢掉窗口变化。事件按 cursor 去重并合并在途读取；没有完整投影证据时不跳过本人的真实变化读取。

`GET /v1/operations/permissions/catalog` 返回 sourceVersion；`GET /v1/operations/permissions/catalog/lease?version=<64hex>` 重新核当前权限和能力，unchanged 时只返回新读取元数据。该能力限固定目录，不把其它来源的保留期或事件头当作完整资格证明。

## 外部签名凭据的技术 profile

API 的 `GALAXY_EXTERNAL_CREDENTIALS_CONFIG_FILE` 是绝对 JSON 路径，未配置等价 `{"version":1,"issuers":[]}`。发行者明确 `id/name/issuer`、带唯一 kid 的公开 JWK、`algorithms/formats`，可选 `subjectBinding/revocation/conditions`；拒绝私钥、对称密钥和签发权，不按用户材料注册发行者或寻找远端密钥。

支持单个 credentialSubject 的 VC-JWT1.1（JWT/缺 typ、credentials/v1、VerifiableCredential；JWT 与 VC 对应字段一致）及 JOSE VC2.0（`typ:vc+jwt`、credentials/v2）。算法显式选择 EdDSA/Ed25519、RS256、PS256、ES256、ES384；不请求材料内 jku/jwk/x5u/x5c、context、DID、附件或 URL。声明 aud 必须包含当前 endpoint，日期取各声明交集。强绑定是签名 sub/subject.id 精确账户 URI，或配置的已验证外部 issuer/subject，不以邮箱或导入动作代替。

撤销 profile 为固定 HTTPS `signed-list`，返回 `{jwt:...}`，头 `typ:credential-status+jwt`，同发行者签署 iss/iat/exp/purpose=revocation/complete=true/revoked 列表；有效完整快照中未列 ID 才为未撤销。缺 ID、来源、签名或新鲜快照均未知；VC 声明状态时只接受与配置 URL 相同的 SignedCredentialStatusList，不宣称通用 StatusList2021/BitstringStatusList。请求不跟重定向、不带用户凭据，按公开地址/TLS保护；批量更新快照，读取不逐次联网，配置变化不复用不相符快照。

本人接口使用账户 Cookie、`X-Galaxy-Account-Id`，写入加 `X-Galaxy-Account-Csrf`，响应 no-store。原 JWS 仅私有存储，不回显；撤回删除签名原件和完整声明、保留有限说明。部署采用相应迁移及 API 最小表权限；合成 JOSE 测试不证明真实机构或状态源已验证。
