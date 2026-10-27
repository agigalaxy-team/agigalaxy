# 部署、配置发现与服务发行

按本次目标选组件与准确源码/冻结发行，再读取它的配置加载器、锁与保护配置引用。历史主机地址、端口、路径和回读不作为新实例默认；普通开发见[开发](../technical/development.md)。

## 选择组件与配置

| 运行目标 | 需要的组件与额外准备 |
|---|---|
| 官网/Web | 根 Node 工具链，Python 仅编译公开数据；前台 Node standalone、后台独立 Next，业务页接准确 API 和公开公钥配置 |
| Hub | PostgreSQL、API/Worker、HTTPS反代；显式迁移、最小数据库角色、Ed25519签名和信任材料 |
| 网站账户 | OIDC/Keycloak、准确 issuer/client/redirect URI、Cookie/CSRF 与邮件 |
| 聊天/附件 | Prosody、对象存储、ClamAV；私有读取、配额和扫描策略 |
| CMS/Admin | 独立 Next/Payload 构建、CMS 数据库/迁移、持久媒体、管理 OIDC 与业务 BFF |
| AgentOS/Gateway/Discovery | 各自 README、固定上游/锁与显式运行配置；不因目录存在而启用 |
| 运维 | 按配置启用监控、日志、接收者、备份与所需恢复能力 |

只启所需组件，不机械拆成微服务。API/Worker/migration 的环境约束由 [`runtime-environment.mjs`](../../packages/galaxy-official/src/infrastructure/runtime-environment.mjs) 执行：

| 约束 | 要求 |
|---|---|
| 环境与角色 | 仅 local/integration/pilot；api/worker/migration 各自最小环境 |
| 数据库 URL | postgres/postgresql、有用户名、数据库名 `galaxy_<环境>`，无 query/fragment；运行角色与迁移/所有权分离 |
| API 地址 | `GALAXY_ENDPOINT` 为无凭据精确 HTTPS origin，反代外部地址一致；默认 loopback监听，Unix拒绝root |
| 环境目录 | `GALAXY_ENVIRONMENT_DIRECTORY` 是以环境名结尾的绝对目录，签名/信任路径位于其中并核 realpath |
| API签名 | `GALAXY_SIGNING_KEY_FILE`、`GALAXY_SIGNING_KEY_ID`、`GALAXY_ROOT_PINS_FILE`、`GALAXY_KEYRING_FILE`、`GALAXY_TRUST_DIRECTORY`；启动重核授权/期限/撤销及公私钥对应 |
| Worker/migration | 不带 API 签名字段 |

其他配置按实际消费者发现：`GALAXY_BROWSER_POLICY_FILE` 供 API，`GALAXY_WEB_CONFIG_FILE` 供预览；`GALAXY_IDENTITY_CONFIG_FILE`、`GALAXY_ACCOUNT_CONFIG_FILE`、`GALAXY_CHAT_CONFIG_FILE`、`GALAXY_OPERATIONS_CONFIG_FILE` 处理身份、账户、聊天和管理。附件、预算、日志、规则变量从各加载器查，不猜字段补齐。Admin 以 [`apps/galaxy-admin/README.md`](../../apps/galaxy-admin/README.md) 和 `.env.example` 为准，CMS 不连接业务库；认证主题构建不修改 realm 或替代 Java provider 编译。

## 准备 Linux 材料与应用

```text
node packages/galaxy-official/scripts/prepare-linux.mjs <服务发行绝对目录> <发行摘要> <运行时pins绝对路径> <全新输出绝对目录> [settings绝对路径]
```

[`linux-plan.mjs`](../../packages/galaxy-official/deploy/linux-plan.mjs) 据发行/pins生成配置、角色、反代、进程材料。该命令不连接服务器、不安装运行时、不生成真实凭据或启动服务；参数示例不是可用生产环境。

1. 确认目标域名、TLS、数据/发行/持久目录、数据库和所选依赖，保留旧版本及当前可恢复备份，不覆盖既有身份。
2. 安装对应锁定依赖，以进程管理器/保护文件注入各角色配置，秘密处理遵循[配置权威](../technical/interfaces.md#权威边界)。
3. 用迁移角色显式执行 `packages/galaxy-official/src/migrate.mjs`，配置最小 SQL 角色；API 不自动迁移。以完整 registry 为准，不能从编号连续性推断可带入未注册迁移。
4. 配置实际账户/管理realm、聊天、存储、扫描与公开网站JSON；准确 Origin/回调/CSP 不能用任意来源、关闭CSRF/签名或超级用户绕过。
5. 启 API、Worker 与实际依赖，再切网站产物；集中验证受影响启动、`/healthz`、`/readyz`、发行与所需业务路径。邮件/模型/恢复只在本次相关且有环境时验证，不附加为每次部署门槛。
6. 失败按数据库事实恢复；schema已推进时不能把旧代码盲目接回。

### 服务 capture、compare、attempt

```text
node packages/galaxy-official/scripts/service-release.mjs capture <新包绝对目录> <releaseId> <configurationVersion> <新回执绝对路径>
node packages/galaxy-official/scripts/service-release.mjs compare <原包绝对目录> <原manifest摘要> <目标包绝对目录> <目标manifest摘要> <新回执绝对路径>
node packages/galaxy-official/scripts/service-release.mjs attempt <原包绝对目录> <原manifest摘要> <目标包绝对目录> <目标manifest摘要> <保护配置绝对路径> <原operationId> <新结果绝对路径>
```

capture 读取 catalog 四入口，递归字面 static/dynamic imports，缺模块失败；同时保留 API/Core、SQL、共享邮件和显式资源。可变模块名、环境选择文件、外部依赖仍需原锁/资源，字面闭包不能证明它们齐备。

compare 使用保护进程的 `GALAXY_RELEASE_DATABASE_URL` 只读核完整迁移列表和恢复状态；历史SQL差异或目标列表不等当前数据库时拒绝回滚，不降级数据库。attempt 仅在目标主机变更已准确授权时执行，配置为管理员可读 JSON：stateDirectory、真实 api/worker/publisher units、migrationUnit、loopback `/readyz` readyUrl、全部将修改文件的 destination/targetSource；迁移 unit/环境也要列入，秘密只引用保护文件。

attempt 取得 PG session advisory lock，核旧版、存原operationId和字节快照，停三进程、更新准确文件/daemon-reload、迁移、重读完整版本，再以匹配 `X-Galaxy-Release` 的 `status:ready` 确认。

| 失败数据库事实 | 接续 |
|---|---|
| 迁移已停且完整列表仍为旧包 | 恢复全部原文件并reload，启旧三进程、核旧发行ready |
| 列表已推进或其他列表 | 保持停止，准备兼容修复或另行批准的数据恢复 |
| 迁移仍运行、观察不可达或未知 | 保留 result-unknown 与阶段，只查同 operationId，不再迁移 |

相同 ID/前后清单的重复 attempt 只读/接续原记录，新结果路径不覆盖失败。终态记录不是当前服务健康证明，不改 schema_migrations 假降级。事务回滚、未知ACK与主机替身测试不等真实生产切换或Caddy整链验收。

## 系统设置与 AI 接续

[接口说明](../technical/interfaces.md#系统设置与消费者采用)集中root/operator、管理writer、System元数据文件和采用判定。部署时保证Worker只读自身文件、不加入管理组以绕过目录限制，原UDS/HMAC控制文件与API/Admin/迁移/SQL角色同批；Payload共享Zod解析也取同发行。不要覆写 `/run/credentials` 运行副本。

AgentOS的数据库变量、Docker与隔离测试以 [`services/galaxy-operations-agentos/README.md`](../../services/galaxy-operations-agentos/README.md) 为准，Gateway固定上游和许可见[源码与许可](../technical/source-and-licensing.md)。构建层次见[开发](../technical/development.md#组件构建与真实边界)，恢复按[恢复](recovery.md)处理。

Admin目录拆分需同一冻结候选/CAPTURE中的动态入口、服务端type导入与真实客户端模块一致，以实际Linux Next/TypeScript构建集中检查，激活保留旧不可变静态资产。位置变动只观察受影响入口、图表、沟通展开和草稿，不发送新模型轮次或测试邮件。回退同步恢复模块与消费者导入；结果读取按[原操作恢复](../technical/interfaces.md#管理身份与原操作)。

常见故障按角色/数据库名、Worker误带API签名、CMS误连业务库、前端旧endpoint、公钥状态、媒体持久目录、BFF/realm和消费者文件引用逐项定位。输出按真实观察区分进程启动、合成适配器与真实外部成功。

## 管理应用与CMS

Admin独立锁/工具链，环境字段以 `apps/galaxy-admin/.env.example` 为准。GALAXY_ADMIN_PUBLIC_ORIGIN是浏览器origin，GALAXY_ADMIN_BFF_ORIGIN是服务端受控API origin，HTTPS、隔离本机可literal loopback HTTP，反代保真实Host；回调 `<public-origin>/v1/operations/callback`。GALAXY_CMS_DATABASE_URL仅独立CMS库，SECRET至少32字符，MEDIA_DIR持久并随库备份。配置须同时供build/start，不用请求参数决定BFF地址。

在apps/galaxy-admin中 `npm ci` 后，只有全新本地开发库可设置GALAXY_CMS_DEV_PUSH=true并 `npm run dev -- --hostname 127.0.0.1 --port 3010`。正式禁push，模型变化用 `npm run migrate:create -- cms-schema` 生成/审阅并保存Payload迁移，再 `npm run migrate`、build、start；不能对业务库执行CMS迁移。类型/importmap分别generate:types、generate:importmap；standalone须带public与.next/static，不只复制server.js，媒体仍独立挂载。

业务API迁移与CMS迁移分别执行；反馈/内容覆盖/附件/审计索引结构属业务库，反馈扫描worker不执行自动永久清理，附件feedbackPolicy只配置保留参数。Payload REST写及Next server action核本站Origin，代理仅转管理Cookie/实际CSRF；Local API明确overrideAccess:false与当前user。CMS快照/发布合同见[接口](../technical/interfaces.md#cms快照与发布)。

认证主题、邮件码、管理邮箱的准确构建/原生配置与回退见[认证工程](../technical/authentication.md)；搜索/推荐/分析初装和Worker接线见[发现适配](../technical/discovery.md)；AgentOS/Gateway/P13见[原生运行](../technical/agent-runtime.md)。

## 自托管 GitHub Runner

Runner只获得完成可信CI所需的独立低权限系统账号；无sudo、不加入docker/业务组，独立私有安装/home，凭据文件受限。systemd采用 NoNewPrivileges、ProtectSystem=strict、ProtectHome、PrivateTmp、UMask0077，仅开放自身写目录。标签只是调度条件，不是安全隔离；可修改可信workflow者具有该账号的执行能力，普通PR不得调度生产Runner。不能因构建需求给NOPASSWD:ALL或生产权限。

注册token仅短期进程注入，不保存长期PAT或输出token。自检使用手动workflow、准确可信ref、最小/空permissions、无checkout/部署，检查非root、架构、临时目录可写及业务/TLS/服务配置不可写。现有仓库查询：`gh api repos/agigalaxy-team/agigalaxy/actions/runners`；仅在明确需要自检时运行 `gh workflow run runner-healthcheck.yml --repo agigalaxy-team/agigalaxy --ref main`，以 `gh run view <run-id> --repo agigalaxy-team/agigalaxy` 读取结果。新增目标须独立注册，不复用其他项目运行目录或生产权限；停用仅处理准确Runner unit及仓库注册。

## 动态网页交付与 AI 代理部署

前台部署运行包的 `start.mjs`，不再将公开数据目录当成现行网站根。运行配置与 unit 示例位于 Official deploy 的 `galaxy-website.*.example`；网站反代使用独立 loopback 端口，保留现有 HTTPS/域名边界。旧静态站脚本/CSP配置须按 Next.js 实际资源与连接方式适配，不能把动态页面当作 HTML 文件服务。

部署代理先读取目标实际配置：Node 路径、前台端口、公开配置文件、软件内容根、CMS 指针、身份/业务数据库版本和原服务账户。秘密由保护文件/进程注入，不从示例推断可用凭据，不借部署扩大数据库或用户权限。

本轮技术迁移 132/133 涉及原会话字段和网页事件表/触发器；不能只更新网页就宣称续期与变化推送可用。应用迁移、API role、API 服务及网站配置后，集中检查实际登录续期、一个真实提交到页面的事件、内容发布及原 operation 恢复。未获部署授权时只交付材料，不连接或改变生产。

生产构建通过 `GALAXY_WEB_DEPLOYMENT_ID` 为前台与后台分别设置 Next.js 官方 deploymentId。发布时反代按 `X-Deployment-Id` 将在用页面的 RSC 请求送回同一构建；没有 ID 的旧构建仅以 RSC 请求作一次过渡，新文档进入新构建。只保留当前与上一运行版本，均执行当前业务权限，不延长认证或私有读取资格；收掉旧进程前需确认不再承接在用页面。不要将版本不匹配交给框架默认硬导航。

代码运行包支持只携带上一构建自身的 JS/CSS，避免打开中的页面因资源被移除报错；不长期积累历史产物，不把旧业务源码混入新运行包。使用不可变运行目录切换，不在运行中的 `.next` 目录原地构建。运行故障/结果未知保留原回执，不通过自动刷新或重发写入掩盖。
