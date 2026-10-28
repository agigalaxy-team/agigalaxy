# 部署、配置发现与服务发行

按本次目标选组件与准确源码／冻结发行，再读取配置加载器、锁与受保护配置引用。源码公开、上传和部署已获授权；实际激活版本、运行单位、数据库迁移和任务接续结果仍以本次执行记录为准，不从构建成功推断已经部署。历史主机地址、端口和路径不作为新实例默认；普通开发见[开发](../technical/development.md)。

## 选择组件与配置

| 运行目标 | 组件与职责 |
|---|---|
| Hub API | `galaxy-api`；原 API 数据库角色、网站／管理门户、受控设备签名与业务接口 |
| Hub Worker | `galaxy-worker`；原受限 Worker 角色与实际作业配置 |
| Information Worker | `galaxy-information-worker`；API 源读取与受限 Worker 队列传输两池，无管理 Cookie 或设备签名私钥 |
| Publisher | `galaxy-publisher`；原 Publisher 连接、内容发布配置和发布权限 |
| 显式维护 | `galaxy-migrate`、`galaxy-lifecycle`；分别执行数据库／队列维护与原生命周期操作，不安装为常驻业务服务 |
| 官网/Web | 独立 Next.js standalone 运行包，读取准确 API 地址及公开签名 pin；根 Node 工具链、Python 公开数据编译按原构建职责使用 |
| CMS/Admin | 独立 Next/Payload 构建、CMS 数据库／迁移、持久媒体、管理 OIDC 与业务 BFF，CMS 不连接业务库 |
| 认证、聊天与附件 | 原 OIDC/Keycloak、Prosody、对象存储、ClamAV；保持 issuer/client/redirect、Cookie/CSRF、私有读取、配额与扫描策略 |
| AgentOS/Gateway/Discovery | 各自 README、固定上游／锁与显式配置，不因目录存在而启用 |

只启所需组件，不机械拆成微服务。Go 入口、目标平台、systemd 样例及各角色配置统一见 [`go/deploy/README.md`](../../go/deploy/README.md)。保留实际进程用户、group、supplementary groups、受保护环境文件和 systemd credentials；运行角色与迁移／所有权分离，不用 API 环境覆盖 Worker、Information Worker 或 Publisher 环境，也不覆盖 `/run/credentials` 运行副本。

`GALAXY_ENDPOINT` 使用与反代一致的精确 HTTPS origin，进程监听及可信代理按实际 loader 配置。API 的 `GALAXY_SIGNING_KEY_FILE`、`GALAXY_SIGNING_KEY_ID`、`GALAXY_ROOT_PINS_FILE`、`GALAXY_KEYRING_FILE`、`GALAXY_TRUST_DIRECTORY` 保留原授权、期限、撤销、公私钥对应与信任历史；Worker 和维护角色不加载 API 签名私钥。配置、凭据和运行数据留在发行目录外，秘密处理遵循[配置权威](../technical/interfaces.md#权威边界)。

其他配置沿真实消费者发现：`GALAXY_BROWSER_POLICY_FILE` 供 API；`GALAXY_WEB_CONFIG_FILE` 指向网站公开配置；`GALAXY_IDENTITY_CONFIG_FILE`、`GALAXY_ACCOUNT_CONFIG_FILE`、`GALAXY_CHAT_CONFIG_FILE`、`GALAXY_OPERATIONS_CONFIG_FILE` 对应身份、账户、聊天和管理。附件、预算、日志与规则字段从各 loader 查，不猜字段补齐。Admin 以 [`apps/galaxy-admin/README.md`](../../apps/galaxy-admin/README.md) 和 `.env.example` 为准。认证主题构建不修改 realm，也不替代 Java provider 编译。

## Go 正式发行与部署

使用 [`scripts/build-go-core.mjs`](../../scripts/build-go-core.mjs) 的 `--mode release` 构建全新的不可变目录，明确 release ID、configuration version 和目标平台。准确参数与目录布局只维护在 [Go 构建与运行说明](../../go/deploy/README.md)。正式产物使用 `go-core-artifact.json`，其 `kind` 为 `galaxy-go-core-release`、`mode` 为 `release`；默认开发模式仍是 `galaxy-go-core-local-candidate`／`candidate`。两者都记录真实二进制入口与文件 bytes／SHA-256，不使用旧 Node `service-release.json` 格式。

运行进程沿原三项引用绑定发行：`GALAXY_RELEASE_DIRECTORY`、`GALAXY_RELEASE_SHA256`、`GALAXY_CONFIGURATION_VERSION`。pin 对应实际 manifest 的原始字节；loader 核完整 inventory、目标平台、配置版本及当前角色的精确二进制归属。普通 Worker 与 Information Worker 虽共享 runtime log 的 `worker` component，仍对应不同二进制和独立日志实例。未配置发行引用时不会补造版本元数据。

构建 manifest 中的 `publicRelease:false`、`deployed:false`、`migrationComplete:false` 描述构建动作本身没有发布、激活或完成环境迁移，并非撤销本次部署授权。上传、公开 release、主机切换和实际验收结果分别据执行事实记录，不回写构建清单冒充完成。银河自有源码采用 Apache-2.0，产物保留根 `LICENSE`／`NOTICE` 和真实第三方许可；依赖原许可证与资源限制继续适用。

现行部署按以下顺序接线：

1. 选定源码和 Go 正式产物，核 manifest pin、目标架构、准确入口与持久资源。将产物上传到新的不可变发行目录，保留旧运行目录及当前可恢复备份，不覆盖身份、UID、密钥、资料或媒体。
2. 沿目标现有服务账户和保护文件配置六个 Go 程序的职责。常驻进程为 API、Worker、Information Worker 和 Publisher；Migrate、Lifecycle 按显式维护命令执行。实际 unit 名、工作目录、credentials 和反代入口从当前目标读取，不直接批量安装或启动示例 unit。
3. 在任务接管前停止对应旧领取者，包括旧 API 内的信息订阅领取、Worker 与独立 Publisher。以原业务 UUID、lease、状态和回执选择待接任务；已发出或结果未知的工作继续查原操作，不重新提交。队列配置不能证明旧服务已经停止。
4. 用原维护连接显式执行 `galaxy-migrate business-up`，沿原 SQL、`schema_migrations` 和事务锁初始化／升级业务库，角色供应按实际目标显式选择。jobs、storage 技术迁移／角色供应、River 启用、旧任务及消息周期接管分别执行，准确参数见 [显式维护入口](../../go/deploy/README.md#显式维护入口)。服务启动不迁移数据库、不自动采用旧任务；Evidence／CI／Probe／搜索的原自有 jobs 表继续沿原 lease 与 ID 接续，不混入 pg-boss 导入。
5. 将所选 unit 的 `ExecStart` 指向同一 Go 发行目录，保留原用户、数据库角色、权限和 credentials。启动 API 及所需依赖后，按已采用的队列和配置启用对应后台消费者。Information Worker 分别使用已有源读取与队列传输账户，不以新增进程为由扩大数据库权限。
6. 独立部署官网 Next.js 与后台 Next/Payload，使用实际 API 地址和同一服务公开 keyring／pin。网站、CMS、认证和专业服务保持各自进程、数据库与配置；Hub 替换不自动改 realm、模型、邮件身份或第三方服务。CMS 自身迁移单独执行。
7. 切换实际 HTTPS 反代及所需网站运行包，集中检查受影响的启动、`/healthz`、`/readyz`、发行归属与代表性业务读写／原操作恢复。政策采用、进程存活和某一接口成功分别记录，不互相代替；邮件、模型、恢复和平台行为只在本次受影响且具备真实环境时核对。

失败按数据库和原操作事实接续。完整 schema 列表仍与旧包相容时才恢复对应旧程序及配置；schema 已推进时使用兼容修复或明确的数据恢复，不能修改 `schema_migrations` 假降级。迁移、任务提交或主机操作结果未知时保留原 ID 和失败记录，只查询／接续原操作，不因重试部署而再次迁移、改 UUID 或重投业务写入。

## 旧 Node 发行兼容定位

原 [`prepare-linux.mjs`](../../packages/galaxy-official/scripts/prepare-linux.mjs)、[`linux-plan.mjs`](../../packages/galaxy-official/deploy/linux-plan.mjs) 与 [`service-release.mjs`](../../packages/galaxy-official/scripts/service-release.mjs) 的 capture／compare／attempt，仅用于读取旧 `galaxy-official-service-release` 包、理解存量主机材料及接续其原 operation 回执。它们不接受 Go artifact，也不是本轮 Go 部署入口；旧 Node 的环境限制保留在 [`runtime-environment.mjs`](../../packages/galaxy-official/src/infrastructure/runtime-environment.mjs)，不拿旧约束替代 Go loader 的现行配置。
## 系统设置与 AI 接续

[接口说明](../technical/interfaces.md#系统设置与消费者采用)集中root/operator、管理writer、System元数据文件和采用判定。部署时保证Worker只读自身文件、不加入管理组以绕过目录限制，原UDS/HMAC控制文件与API/Admin/迁移/SQL角色同批；Payload共享Zod解析也取同发行。不要覆写 `/run/credentials` 运行副本。

AgentOS的数据库变量、Docker与隔离测试以 [`services/galaxy-operations-agentos/README.md`](../../services/galaxy-operations-agentos/README.md) 为准，Gateway固定上游和许可见[源码与许可](../technical/source-and-licensing.md)。构建层次见[开发](../technical/development.md#组件构建与真实边界)，恢复按[恢复](recovery.md)处理。

Admin目录拆分需同一冻结源码／发行中的动态入口、服务端type导入与真实客户端模块一致，以实际Linux Next/TypeScript构建集中检查，激活保留旧不可变静态资产。位置变动只观察受影响入口、图表、沟通展开和草稿，不发送新模型轮次或测试邮件。回退同步恢复模块与消费者导入；结果读取按[原操作恢复](../technical/interfaces.md#管理身份与原操作)。

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

部署代理先读取目标实际配置：选定 Hub 产物及其二进制／manifest、网站所需 Node 路径、前台端口、公开配置文件、软件内容根、CMS 指针、身份/业务数据库版本和原服务账户。Go 部署按上述正式发行说明，存量 Node 维护按其服务包；两类 manifest 不互换。秘密由保护文件/进程注入，不从示例推断可用凭据，不借部署扩大数据库或用户权限。

本轮技术迁移 132/133 涉及原会话字段和网页事件表/触发器；不能只更新网页就宣称续期与变化推送可用。应用迁移、API role、API 服务及网站配置后，集中检查实际登录续期、一个真实提交到页面的事件、内容发布及原 operation 恢复。部署执行和实际业务回读结果记录在本次操作记录，不从网页或构建单独推断整站切换完成。

生产构建通过 `GALAXY_WEB_DEPLOYMENT_ID` 为前台与后台分别设置 Next.js 官方 deploymentId。发布时反代按 `X-Deployment-Id` 将在用页面的 RSC 请求送回同一构建；没有 ID 的旧构建仅以 RSC 请求作一次过渡，新文档进入新构建。常规保留当前与上一运行版本；既有仍承接在用请求的历史版本待不再使用时收束，所有版本均执行当前业务权限，不延长认证或私有读取资格；收掉旧进程前需确认不再承接在用页面。不要将版本不匹配交给框架默认硬导航。反代优先使用真实配置的平滑重载；如使用 Caddy 管理接口，仅开放受限的本机 Unix socket，不开放公网管理端口。替换保护配置时保留原附加 ACL，避免 Worker／发布器失去既有读取权限。

代码运行包支持只携带上一构建自身的 JS/CSS，避免打开中的页面因资源被移除报错；不长期积累历史产物，不把旧业务源码混入新运行包。使用不可变运行目录切换，不在运行中的 `.next` 目录原地构建。运行故障/结果未知保留原回执，不通过自动刷新或重发写入掩盖。
