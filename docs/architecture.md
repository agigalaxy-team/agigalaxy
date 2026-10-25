# 架构与源码地图

[文档目录](README.md) · [项目概览](project-overview.md) · [部署](deployment.md)

银河提供具体帮助、项目发现、交流与协作等[网络功能](network-functions.md)，这些功能由客户端、服务和外部参与者共同完成。

银河保留五层职责：采集、解决、证据生产、核心、信息服务。它们描述数据与工作的关系，不对应五个强制独立的服务，也不表示每层已经具有完整生产覆盖。

![五层职责与组件](assets/architecture.svg)

## 五层职责

| 职责 | 处理什么 | 对应实现位置 |
|---|---|---|
| Acquisition / Capture | 获准工作中的目标、文字与工具观察、有限片段、环境变化及来源 | [本地工作记录](../packages/galaxy-core/src/work-history)、[Native](../integrations/native-v2)、[宿主适配](../integrations/host-adapters) |
| Resolution | 阅读背景、寻找方法或参与者、联系、使用工具及继续原工作 | [产品网页](../packages/galaxy-web/src)、[本地客户端](../packages/galaxy-node/src)、[A2A](../packages/galaxy-a2a/src) |
| Evidence Production | 实际尝试、介入、输出、有限结果、更正、检查和解决情况 | [核心领域](../packages/galaxy-core/src/domain)、[业务服务](../packages/galaxy-official/src)、[API 目录](development-api-reference-v1.md) |
| Core | 稳定身份、主体控制、声明、历史、外部凭据、有限认可与 Capsule 方法 | [Core](../packages/galaxy-core/src)、[Node](../packages/galaxy-node/src)、[Official](../packages/galaxy-official/src) |
| Information Services | 按当前权限发现、检索、读取、比较与关注变化 | [业务服务](../packages/galaxy-official/src)、[发现与查询界面](../packages/galaxy-web/src)、[MCP 接入](../packages/galaxy-edge-mcp/src) |

工作事实可包含 Case、Attempt、Result、Revision、Withdrawal 等版本化对象。普通用户不必为每次聊天手工补齐这些对象；界面按真实使用目的组织，后台维持事实与权限关系。

## 运行组件

- **网站。** `apps/galaxy-site` 生成官网、公开指南和下载页面；`packages/galaxy-web` 是当前业务网页。公开非首页内容可由同一 React 工作区渐进接管，保留静态阅读回退。
- **本机。** `galaxy-core`、`galaxy-node` 和 Native 保存本机身份、工作记录、会话与必要操作记录。用户模型留在宿主中，支持范围取决于实际宿主接口。
- **Hub。** `galaxy-official` 提供 HTTP 业务服务、数据库操作、权限检查、来源投影与 Worker。PostgreSQL 保存业务状态；迁移和运行角色分开。
- **服务端外部依赖。** Keycloak 负责账户认证；Prosody / XMPP 在 Hub 服务器内部处理消息传输与归档；对象存储与扫描器处理文件。普通客户端通过银河 HTTPS 业务接口使用聊天，无需安装、配置 XMPP 或单独注册 XMPP 账户。银河负责相应业务授权，不能由存储 URL 或聊天成员关系替代全部来源检查。
- **管理端。** `apps/galaxy-admin` 使用独立管理身份域和独立 CMS 数据库。官网内容进入 CMS，业务事实继续通过银河 API 处理；不由 CMS 直接修改业务表。
- **运行工具。** Caddy、systemd、Docker Compose 及监控、日志、备份工具位于部署与运行目录。准备脚本、配置或构建存在，不说明目标环境已经启动或恢复成功。

## 身份、授权与持久化

![账户、本机与共享关系](assets/identity-and-data.svg)

在线账户 Cookie、客户端设备签名、连接范围、内容使用许可和管理员角色分别核对。账户关联不合并本地 ID，登录不自动证明本机控制，管理权限不获取用户密钥。

读取受控正文时重新检查准确来源、版本、受众和期限。结果未知时沿原 operationId 查询和接续，不能通过生成新请求猜测是否成功。后续权限变化仍可使旧预览或读取失效。

数据库迁移是显式部署步骤，API 启动不会自动修改 schema。业务数据库、CMS 数据库、身份服务数据、本地客户端目录与对象存储各自持久保存，整站恢复需要协调它们的时间与关系。

## 协议与角色

HTTP、MCP、MCP Apps 和 A2A 复用相应业务含义。MCP Apps 是受宿主支持约束的小面板；A2A 对端报告与本地工作结果分别保留。使用 SDK 不表示实现所有协议可选项，也不替代对端身份或内容真实性判断。

Hub 是服务环境；Worker 执行获准任务；Bridge 保留外部观察来源；Federation 进行具体范围的信息交换。Relay / Directory 等架构角色按实际组件和服务声明使用，不能从角色名称推定已有跨组织生产网络。

## 源码入口

| 目的 | 文件或目录 |
|---|---|
| 产品页面与路由 | [main.tsx](../packages/galaxy-web/src/main.tsx) |
| 共享网站、认证品牌与导航 | [site-chrome.mjs](../packages/galaxy-web/src/site-chrome.mjs)、[网站界面](site-ui.md) |
| API 启动与实际配置读取 | [server.mjs](../packages/galaxy-official/src/server.mjs) |
| Worker | [worker.mjs](../packages/galaxy-official/src/worker.mjs) |
| 数据库与迁移 | [database.mjs](../packages/galaxy-official/src/database.mjs)、[migrations.mjs](../packages/galaxy-official/src/infrastructure/migrations.mjs) |
| API 工具与接口目录 | [开发 API 说明](development-api-reference-v1.md) |
| 统一前端构建与预览 | [build-product.mjs](../scripts/build-product.mjs)、[serve-product.mjs](../scripts/serve-product.mjs) |
| 认证与共享邮件 | [认证](../apps/galaxy-auth/README.md)、[邮件](../packages/galaxy-mail) |
| 管理应用与配置 | [运营后台](../apps/galaxy-admin/README.md) |

根目录 `app/` 与相应 demo 脚本保留早期演示用途。当前生产网页不能从该目录推断，完整服务也不能由前端预览端口推断。

## 目录归属与依赖方向

目录按实际运行和发行边界组织。`apps/` 是可独立构建的应用，`packages/` 是银河自身的业务和接入代码，`services/` 是独立运行的原生引擎适配；这三类目录不各自复制同一业务实现。

| 目录 | 归属与入口 |
|---|---|
| `apps/galaxy-site` | 官网静态构建；`build.py` 消费已完成的 Web 构建及公开资料 |
| `apps/galaxy-admin` | 独立 Payload／Next.js 管理应用、CMS 和受控业务 BFF；自身 `package.json` 构建 |
| `apps/galaxy-auth` | Keycloak 主题、邮件验证码扩展和受限 realm 配置工具 |
| `packages/galaxy-web` | 当前 React 产品网页；`src/main.tsx` 为入口，调用业务 API |
| `packages/galaxy-core` | 本机身份、领域模型、工作／会话记录和存储；不依赖管理应用 |
| `packages/galaxy-node` | 本机 CLI 入口，组合 Core 与已有接入能力 |
| `packages/galaxy-edge-mcp` | MCP 与 Native 工具表面；复用 Core、Official 客户端和协议适配 |
| `packages/galaxy-a2a` | `protocol/`、`hosts/`、`facts/`、`storage/` 分别承担协议、宿主接续、事实映射和原操作日志 |
| `packages/galaxy-mail` | 认证和运营共用的受控邮件渲染；不配置 SMTP 或执行投递 |
| `packages/galaxy-official/src` | Hub 领域服务；`adapters/http/` 适配 HTTP，`shared/` 定义闭合合同，`infrastructure/` 管配置／迁移，`operations/` 管维护工作，`discovery-runtime/` 管公开发现引擎适配 |
| `services/galaxy-operations-agentos` | Python Agno 原生运行；业务效果经银河当前授权网关执行 |
| `services/galaxy-model-gateway` | 模型协议和人工模型目录的独立运行表面；凭据由受保护运行配置提供 |
| `services/galaxy-discovery` | 搜索／推荐／分析原生组件的构建与窄补丁材料；不代替 Hub 来源资格检查 |
| `integrations/` | Native、宿主和参考接入包；复用上述库，不另存一份业务实现 |
| `scripts/` | 仓库开发、构建和发行 CLI；根 `package.json` 保留统一入口 |
| `deploy/`、`packages/galaxy-official/deploy/` | 分别保存独立引擎和 Hub 的部署／维护源材料；实际运行配置、密钥和数据库资料不归入源码 |
| `docs/`、`examples/`、`test/` | 开发说明、明确示例和仓库级检查；包内行为检查仍归相应包的 `test/` |

源码重构先移动实际实现并同步包内引用，必要的已发行入口可以保留单一转出。历史发行快照、既有运行资料和项目原始文档按原位置保留，不因源码目录整理而改写。

Official 的文件运营实现在 `src/operations/files/`：`service.mjs` 负责授权重核、CAS 和扫描重试命令，`read-model.mjs` 负责受权元数据目录及全范围聚合，`processing.mjs` 负责处理状态与既有附件服务共用的重排资格。原 `operations-files.mjs` 和 `operations-file-processing.mjs` 保留稳定转出，分别服务现有启动组合及附件调用；内部模块直接引用这一目录。SQL 合同和 HTTP 适配仍留在各自层，不因文件夹变动合并权限边界。

普通使用反馈归 `src/operations/feedback/`：`service.mjs` 承担已登录账户提交及运营分类／状态／备注命令，`read-model.mjs` 承担当前受权目录、详情、历史和附件读取。写服务继承同一读取模型，继续使用原账户锁、操作 ID、修订号和附件前后授权检查；原 `operations-feedback.mjs` 仅作为已有启动入口转出。反馈仍是私有使用反馈，不与安全案件、搜索反馈或画像来源合并。

Personal MCP 表面归 `src/adapters/mcp/personal/`：`configuration.mjs` 读取明确选择的 OAuth 资源配置，`handler.mjs` 组合 MCP SDK 和现有认证／审计链，`tools/` 中的领域定义调用各自业务服务。Native 的 HTTP 工具定义直接复用这里的 schema 与说明，不维护第二套业务协议。原 `personal-mcp.mjs`、`personal-mcp-config.mjs` 仅作为已有组合入口转出；二十六个原来散在 `src/` 的内部工具定义已移动，不保留重复实现或内部兼容文件。调用仍经当前来源、账户、scope 和原签名检查，目录归属不产生新的工具权限。

固定 policy 的纯合同归 `src/shared/policies/`。`resource-budget.mjs` 和 `forum-quota.mjs` 保存原校验、默认值及确定性 policy 标识；运行时的文件加载和资源用量 SQL 仍分别归原加载器。`operations-product-schema.mjs` 直接使用纯合同，避免共享校验反向加载数据库与迁移。旧加载器继续转出原合同供已有服务使用，额度、保留参数与配置启用方式不因拆分改变。

Native 客户端的 `src/native-v2/` 按实际职责分为 `work/`、`identity/`、`watch/`、`tools/`、`adapters/` 和 `interaction/`。原工作接续、身份交接、Watch 调度、HTTP 工具和宿主呈现分别保留自身边界；二十七个内部模块真实移动，所有直接消费者使用新路径，不在根部堆积内部转出文件。`native-v2-entry.mjs`、`runtime.mjs`、`server.mjs` 和 `stdio.mjs` 保留既有启动位置，平台通知资源与宿主驱动也保留原位。正式发行继续由同一四入口构建图捕获实现，目录细分不改变工具名称、服务路由、身份或来源许可。具体入口见 [MCP / Native 目录](../packages/galaxy-edge-mcp/README.md)。

Core 的本机初始化合同归 `src/initialization/`：`catalog.mjs` 保存模块／形态目录和依赖选择，`language.mjs` 保存原双语言文案，`contract.mjs` 生成宿主可用的呈现数据与编号列表，`selection.mjs` 校验本次初始化选择。它们都是本机纯合同，不加载 Hub 服务或数据库。原 `integration-modules.mjs` 只保留十三项明确公共导出，供已发行适配器和原合同调用；Core 内部与 Native 组合直接引用所需模块。初始化确认、隐私选项、身份种类和原文案保留，目录拆分不启动连接或远程操作。

Web 业务按 `src/features/` 归类。通知的 `features/notifications/` 统一容纳工作区、账户回复提醒、设置及其局部样式；`loader.mjs`、`merge.mjs`、`read-lease.mjs`、`settings-model.mjs` 和 `target.mjs` 分别维护分页读取、原通知标识、当前可读期限、原设置操作接续和目的地。主路由仍懒加载同一个工作区，当前账户／设备与来源许可仍沿原客户端核对；目录调整不合并通知正文来源，不续期旧页，也不改变消息标记和未知响应的重试语义。

同一 Web 层的 `features/bookmarks/` 负责原收藏客户端／工作区，`features/public-reading/` 负责当前公开阅读合同、工作区与 Native 公开呈现，`features/discovery/` 负责发现、公共检索／浏览及轻反馈客户端，`features/feedback/` 负责账户使用反馈与其附件字段。各自局部样式随实际工作区归属；通用阅读细节、账户会话、主路由和跨领域 shell 仍在原共享位置。主路由及其他工作区直接导入新位置，不留内部转发实现；服务端搜索／推荐、当前来源资格、账户授权和反馈附件操作协议保持各自原边界。

收藏域的 `controls.tsx` 是聊天、帖子、方法、项目和个人页共用的收藏控件与账户 Provider，`workspace.tsx` 是主路由懒加载的完整书签页；两者从同一个模块取得唯一 AccountContext。共用控件不反向导入整页，其他工作区也不从整页取得按钮。原登录接续、当前账户 lease、未知回执与客户端保留原实现，完整页的读取／目录恢复／来源到期处理仍属于页面。现有 `workspace.css` 继续共用，分离 JS 职责不宣称 CSS 已延迟加载或改变视觉。

共用 Node 日志写入归 Official `src/shared/runtime-logger.mjs`，复用 Pino 和原轮转实现，要求调用方提供闭合元数据投影。服务器的 `operations/runtime-log.mjs` 保留服务器事件允许表与 HTTP 路由投影，并保持原公共 API 的默认行为；Native 直接组合共用写入器和自己的严格字段投影，构建图不再装入服务器 HTTP 层。错误原文、正文、凭据和未知字段不因共用写入器而获准记录；现有容量、保留、文件权限与退出 drain 不因职责拆分改变。

仓库检查的正式 CLI 仍是 `scripts/check.mjs`，实际发现与执行归 `scripts/checks/`：`test-discovery.mjs` 维护原包范围、顶层测试与隔离前提，`runner.mjs` 维护 Node 版本要求、固定命令、子进程及失败退出。`package.json` 和现有分层检查继续使用原入口；目录细分不把未准备的真实传输或制品验收自动纳入普通检查，也不把整仓检查误当具体生产验收。

运营策略的 Node 实现归 Official `src/operations/strategies/`。`base.mjs` 维护当前人员授权、事务锁和策略事实，`read-model.mjs` 维护受权版本、事项及原操作回执读取，`runtime.mjs` 维护固定版本运行、原人工暂停续接和原生步骤资格，`service.mjs` 维护草稿、演练、发布及日常启停命令。`authority.mjs`、`effects.mjs`、`ordinary.mjs`、`gateway.mjs` 和 `native-client.mjs` 分别衔接现有执行授权、受控业务效果、普通策略工具、工具网关和 Agno 原生工作流；目录及判定纯函数留在同域的 `catalog.mjs`、`evaluator.mjs`。HTTP 路由归 `adapters/http/operations-strategies-http.mjs`，启动组合和测试直接引用实际实现，不保留九个旧内部入口。该分层不改变策略版本、当前权限、人工边界、CAS、原操作幂等或未知回执恢复规则，也不复制原生工作流或另起调度引擎。

固定运营规则归 Official `src/operations/rules/`。`base.mjs` 维护现有授权、事务锁、已发布事实与初始化，`read-model.mjs` 维护目录、采纳状态、版本及原操作回执，`service.mjs` 维护草稿／发布／恢复和不产生业务效果的样本判断。`policies.mjs`、`catalog.mjs`、`evaluator.mjs`、`quota.mjs` 分别复用固定校验表、可编辑目录、原三值条件判定和额度计算；`runtime.mjs` 仍在已有业务事务内执行当前已发布规则，不授予来源或房间权限。HTTP 表面归 `adapters/http/operations-rules-http.mjs`，实际业务消费者直接引用新目录；六个旧内部入口不再保留。目录归类不改变阈值、发布时点、进程采纳、名单例外或原有来源／额度边界。

Web 的正式运行入口仍是 `src/runtime.mjs`，保留 `loadWebConfiguration` 和 `createWebRuntime` 两项公共导出。入口负责当前本机身份、设备接续、连接世代和受控客户端组合；`runtime/configuration.mjs` 读取原网站配置及固定签名 pin，`runtime/task-source.mjs` 递归标记当前任务的来源／用途，`runtime/task-operations.mjs` 维护原任务发布、参与、持久队列、停止及丢 ACK 回执接续。任务运行工厂为每个 Web runtime 分别保留原队列和在途状态，当前身份及关闭状态通过只读 getter 每次取值，不能以静态快照跨过断开、换身份或连接重建。原操作 ID、字节、原期限、来源重读和一次性回执判断沿用既有代码，不因模块化额外取得资料或重发未知结果。

三渠道消息生命周期归 Official `src/operations/messaging/`：`base.mjs` 维护当前请求／发布资格、原命令账本和一致的计划／run 锁顺序，`read-model.mjs` 维护受权计划／执行／逐收件人读取与当前公开公告，`plans.mjs` 维护具体版本和原生调度的启停，`execution.mjs` 在每次执行时冻结当时账户名单并接续同一原生队列，`service.mjs` 维护当前收件资格、提交 claim、DATA 前复核及真实结果记账。固定技术恢复参数和闭合错误映射归 `policy.mjs`，既有 SQL 投影归 `views.mjs`，既有两队列 Worker 组合归 `workers.mjs`。原 `operations-messaging.mjs` 保留三项正式导出，供 API、Worker 和跨领域工具复用；旧内部视图入口不再保留。SMTP transport、身份目录、旧账户通知及三渠道事实保持各自职责，SMTP 接受仍只表示 submitted，未知结果仍不盲重发。

运营人员与业务角色归 Official `src/operations/permissions/`。`authority.mjs` 以现有管理身份资格和当前已提交的 PG grants 计算有效动作及选定对象交集；`read-model.mjs` 负责获准目录、人员有效状态与原历史；`service.mjs` 负责角色、人员授予和自动授权的版本命令。闭合历史差异校验归 `history-delta.mjs`，安全视图归 `views.mjs`，身份／错误校验归 `helpers.mjs`。原 `operations-permissions.mjs` 仍是两项正式公共导出，固定动作 catalog 和 shared schema 不随本次分层迁移。模块化不缓存有效权限、不信任调用者 role／caps、不改变原管理资格来源、事务锁、撤权后重放拒绝或缺对象范围的失败关闭；交集查询也不代替真实执行授权。

搜索质量归 Official `src/operations/search-quality/`。`base.mjs` 维护当前授权、原持久状态和版本读取，`configuration.mjs` 维护不可变配置、原操作意图以及 Meili 提交／任务／读回核对，`measurement.mjs` 维护公开查询凭据与按实际请求归属的质量事实，`read-model.mjs` 维护获准配置、历史和概览，`service.mjs` 保留原草稿／应用／恢复命令。纯错误及视图函数归 `helpers.mjs`；原 `operations-search-quality.mjs` 是既有单类公共入口。来源仍由原匿名公开 reader 决定，请求凭据不授予管理权；实例内的原在途核对 Map、CAS、原操作幂等和结果未知状态不因分层改变，也不另起原生任务或缓存身份。

推荐运营归 Official `src/operations/recommendations/`。`base.mjs` 读取现有分类、标签、人工主题映射及 policy，`provenance.mjs` 维护公开计划和同 profile／来源版本绑定的实际返回位置凭据，`read-model.mjs` 维护受限当前公开供给扫描、用途受限的主题观测及获准概览／历史，`service.mjs` 维护映射和 policy 的 CAS 命令，纯视图归 `helpers.mjs`。原 `operations-recommendation.mjs` 保留既有单类公共导出；Gorse 候选、固定排序控制、OpenPanel 原生聚合和公共 runtime 仍归原发现运行层。未完整扫描或未采集的指标仍未知，普通查看、曝光、负反馈和真实点击凭据沿用原语义，目录分层不把私聊、案件或官方消息引入画像。

公开帖子／回复治理归 Official `src/operations/public-content/`。`source.mjs` 核对当前 endpoint 的原公开形态、保留版本元数据与当前来源／父来源资格，`read-model.mjs` 投影获准目录、详情、历史、标签及附件，`commands.mjs` 维护单项显示状态、编排和标签命令，`service.mjs` 组合原逐项批量预览、来源／修订复核及 savepoint 结果。纯候选 SQL 和状态判定归 `helpers.mjs`；原 `operations-forum-content.mjs` 保留既有单类公共导出。原业务授权父类、独立单项／批量 grants、当前源 CAS、父来源失效后的标题／分类脱敏、不可读目录的空正文，以及附件存储读取前后验权仍由原代码执行；分层不把保留字节当读权，不修改作者签名，也不更改论坛普通读取或任何真实运营处置。

普通聊天服务归 Official `src/chat/`。`base.mjs` 维护当前 Access／账户、成员与独立控制方资格，`read-model.mjs` 维护受权房间目录、消息历史、上下文与选定来源，`governance.mjs` 维护原共治、邀请／本人接受与 Agent 参与授权，`messages.mjs` 维护发送／编辑意图、原回执、个人隐藏及独立游标，`service.mjs` 保留正式 ChatService 和既有 worker 生命周期／本人导出／无正文就绪探针，纯校验归 `helpers.mjs`。原 `chat.mjs` 为既有单类公共转出；Prosody 客户端、附件、当前运营消息覆盖和房间治理纯合同仍归原共享层。原构造字段顺序、当前身份与来源复核、未知发送重试、额度预占、原消息到期、清除 ACK 和参与者独立性不因分层改变；原生 MUC 只是受限投影，不能取代 Galaxy 授权。

Web 的公共浏览和项目匹配分属实际职责：`features/discovery/browse.tsx` 实现公共首页与各类公开摘要读取，`content-card.tsx` 呈现同一当前内容卡／高亮，`contracts.ts` 保存原浏览类型与固定目录，`return-navigation.ts` 维护受限站内返回目标。`features/projects/directory.tsx` 实现原公开项目目录、当前分页与位置恢复，`discovery.tsx` 实现原目标匹配／机会详情和联系接续，其局部样式及纯查询记忆分别归 `discovery.css`、`query-memory.ts`。主路由和实际消费者直接导入对应实现，原混在公共发现里的两个项目 workspace 文件不再保留；公共 browse 为独立隐私消费者保留一项既有类型转出，不复制实现。原路由、读取世代、来源／身份失效、无正文查询记忆、目录恢复和 Hook 状态保持不变，公共推荐及业务权限仍由各自原服务决定。

完整项目领域也归同一 `features/projects/`：`management/workspace.tsx` 保留原项目／招募／Contact 管理主 Hook 和完整编排闭包，`management/people-selection.tsx` 是原有的角色／代表选择组件及其准确回执核对，不新建第二套管理状态。`clients/operations.mjs` 保留同一运行对象上的原操作队列、Consent 与本机原回执日志，`clients/views.mjs` 保留受当前身份／来源约束的读取和查询记忆，偏好保存与未知响应核对归 `clients/preferences.mjs`。原类型、表单和纯校验归 `contracts.ts`，偏好页、完整详情、个人项目列表分别归 `preferences.tsx`、`detail.tsx`、`portfolio.tsx`；具体机会联系和来源返回归 `contacts/opportunity.tsx`、`contacts/origin.tsx`。局部样式随实际组件归属，所有主路由、工作区、现行 QA 入口及仓库测试直接使用这些真实实现。原 93084 字节主 Hook 保持整体，不把成员选择抽取当新授权，不改变 ID、当前 lease、原 Consent、未知发送、归档或来源失效语义；旧根部项目实现不留内部转发壳。

Official 的宿主连接公共入口仍是 `src/host-connection-controller.mjs`，负责活动预览、连接世代、当前身份采纳、取消和会话失效。`host/connection/domain-access.mjs` 使用原已配置客户端执行各领域的有界访问，`search-feedback.mjs` 将显式反馈绑定到当前展示结果和同一会话授权，`recovery.mjs` 衔接原本机操作日志与准确回执核对。每个控制器分别创建自己的工厂闭包；`generation`、`checking` 与 `feedbackPage` 通过 getter/setter 每次访问原状态，不在工厂创建时复制旧身份或在途操作。原调用顺序、活动预览互斥、取消迟到结果和未知回执处理保持不变；正式 client 构建白名单包含三个实际依赖，目录调整不隐式连接、重新授权或重发。

随案选材与私聊举报归 Official `src/chat/reports/`。`authority.mjs` 保留普通账户参与、当前管理身份及已知当事关系的独立性判断，`materials.mjs` 保留精确消息版本／附件选入、来源失效和存储前后当前请求验权，`read-model.mjs` 投影本人或独立管理者当前获准的案件／历史／回执，`service.mjs` 执行原举报、补充／申诉和运营事件命令及既有生命周期，纯校验归 `helpers.mjs`。原 `account-chat-governance.mjs` 为既有单类公共转出，当前消息覆盖仍由原专用服务执行。职责分层不把案件材料许可当完整房间访问，不合并普通账户与管理身份，也不改变当前 PG grants、CAS、原操作重放、必传请求复核、材料期限或附件读取边界。

Capsule v2 归 Official `src/capsules/v2/`：`sources.mjs` 维护原精确注册来源、作者许可和发布覆盖证明，`versions.mjs` 维护指定版本、当前来源／可读资格及原所有者回执，`publication.mjs` 维护用户侧预览和准确 Consent 发布／维护命令，`uses.mjs` 维护真实引用、应用、再验证及各自证据，`service.mjs` 投影当前可读内容／通知／公开查询，纯服务函数归 `helpers.mjs`。原 `capsules-v2.mjs` 保留单类公共导出，唯一内部来源模块已真实移动，不另留根部实现。版本变化不重定向历史使用，当前私有版本不回落到旧公开版本，撤回来源不因保留使用记录重新出现；阅读、采用、成功自述和独立验证仍分别表达，目录归属不扩大来源或发布许可。

工作事实 Case 归 Official `src/cases/`。`authority.mjs` 保留 Access／Consent 和精确事件、事实、外部来源资格，`read-model.mjs` 保留 v1／v2 受权历史、当前事实与原操作回执投影，`service.mjs` 保留原字节提交、v2 追加事实、Task 首次工作原子关联和交付核对，`helpers.mjs` 保存同一载荷校验与闭合判定。原 `cases.mjs` 继续提供 CaseService 及两项既有 schema 公共导出。旧事件不补造原始执行者，私有／撤销／擦除的新变更不复活旧事实为当前支持；Task→Case 原锁序、当前参与范围、actor／Consent、CAS 和确定回执含义保持不变。

Web 的工作事实、结果及受权历史归 `src/features/work-records/`。`workspace.tsx` 保留完整事实编辑、原回执恢复和原 FactSession 编排闭包，`client.mjs` 保留同一 runtime／owner 的唯一实例、串行日志、准确 Consent 与原 ID／字节回执核对；`contracts.ts` 保存原工作类型及本机稿校验。`result-reading.tsx` 读取当前有资格的精确结果／Evidence，`result-navigation.mjs` 保留结果版本和原 delivery 返回位置；`history.tsx`、`history-types.ts` 负责各入口的当前许可历史投影，`presentation.tsx`、`presentation-types.ts` 负责原干预／解决意见及引用呈现。两份局部样式随对应实现归属，原 `FactDetails` 正式包装仍在共享根入口。归并不拆开原大 Hook 或重建事实客户端，不把接受过的操作回执当当前正文权限，不改变参与者、来源撤回、版本、CAS、未知提交或原稿接续；Web 中既有 Native 历史呈现只同步导入位置，没有重新挂入普通账户页面。

本机个人摘要归 Official `src/summaries/local/`。`indexeddb-store.mjs` 维护原按身份分记录的 IndexedDB 事务和多记录原子迁移，`cloud-contract.mjs` 严格校验 owner-only 云响应，`service.mjs` 保留完整的本人偏好、本机草稿、当前绑定／来源检查、同步队列、冲突与原回执编排闭包，纯函数归 `helpers.mjs`。原 `personal-summary-local.mjs` 继续提供三项公共函数，Web 与 Native 按原入口组合。模块化不把云删除等同本机删除，不重发未知操作，不绕过换绑定或撤源；原 IDB CAS、本人选择和临时不可读时保留可恢复本机资料的语义保持不变。

Web 的会话笔记按两种真实身份边界归 `src/features/conversation-notes/`。`account/workspace.tsx` 和 `account/store.mjs` 是当前 Chat 使用的账户备注，按原 endpoint、accountId、roomId 隔离本机记录，并保留同一会话 lease、草稿／笔记 CAS 和迟到读取拒绝。`native/workspace.tsx`、`runtime.mjs`、`composer-state.mjs` 保留原 Native 身份摘要的独立工作区、运行缓存与分享接续；其类型归 `contracts.ts`，纯呈现与来源过滤归 `presentation.ts`。旧 Native 工作区没有重新挂入普通账户 Chat，原局部样式保留原位；主路由仅继续原运行清理，目录调整不合并两类本机资料、不新开云同步或房间读取，也不改变原来源期限与未知回执。

Task v2 的持久业务归 Official `src/tasks/v2/`。`authority.mjs` 保留当前 Access／Consent、TaskRepository、精确来源、Task 先于 Participation 的锁序、配额与原事件回执；`read-model.mjs` 保留受权投影、本人／公开目录和仅匹配当前可读文本的分页；`service.mjs` 将原 Task／Participation 写入、资格复核及材料／Case 原子关联保持在同一职责层，纯校验归 `helpers.mjs`。原 `tasks-v2.mjs` 继续提供 TaskServiceV2；AssistanceService 仍继承它并通过原动态 `this` 提供 v1 grant、visible 与 legacy readWithin，不能因拆分替换父权威或把保留事件当当前许可。既有容量工作流的源码枚举包含新实现，历史版本化制品不重新生成。

Builder 注册、节点控制和便携证据归 Official `src/builders/`。`authority.mjs` 保留登记所有者、Node 密钥控制者与配置中的 assessor 三种原权威及最新声明／当前 Consent 核对，`read-model.mjs` 保留受权目录、所有者维护视图、回执和原证据投影，`portable-evidence.mjs` 保留精确 Node control／conformance 快照、原签名参数和调用者／来源分开的导出审计，`service.mjs` 保留完整 publish 事务与原管理入口。原 `builders.mjs` 继续提供同一 BuilderService 公共类。本人声明、节点关联、兼容性自述、可达探针和实际能力仍分别表达，目录分层不把声明升级为证明，不自动探测 endpoint，也不改变原构造引用、来源期限、CAS 或原签名范围。

## Hub 和官方之间的信息流

Hub 内部数据按本地业务和来源许可处理。选择性公共发现只提供允许的元数据、摘要与引用，不让官方自动取得所有正文。当前 `galaxy-direct-proof/1` 为双边 HTTPS 签名查询，只交换获准 `ci-proof-v2` 和选定非叙述贡献字段；不是全站资料复制，也不是 XMPP 聊天联邦。

![Hub 与官方信息流](assets/hub-topology.svg)

角色、协议协商、逐来源授权、请求与返回、后续联系、Bridge、撤回和可选 Relay 见 [Hub 与官方的运作](ecosystem-and-hubs.md)。原始模块职责与当前开源复用见[开放组件](open-components.md)，Capsule 与上传流程的具体字段和边界见[实现核对](technical-faq.md)。
