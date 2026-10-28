# 银河服务器与本机 Go 核心重构实施计划

状态：用户已授权本地实施，开发分支 `refactor/go-core`，起始基线 `597cafa26c30540fedccb1b63a53e7232ecf1879`。完成本地开发、隔离验收和发行准备；GitHub上传、生产数据库变更、认证改配和服务器切换另行安排。

## 1 目标与实施边界

银河自己的服务器业务和本机 Native 核心迁入 Go，保留现有界面、操作、身份和资料。网页继续使用 Next.js／React；宿主 TUI、MCP Apps 小面板保留其平台代码；专业引擎继续复用。验收看业务和本机运行权威是否真正迁出 Node，不以 GitHub 语言占比为目标。

承接现有数据库和本机文件格式，只做队列、安装与版本衔接所需的技术变更。全套业务数据重新设计不与语言迁移捆绑。迁移当前有效功能，不将旧实验代码、助手自行推导或未确认业务规则固化为新需求。

## 2 当前代码中的真实边界

| 部分 | 已核对的源码入口与实际情况 | 对方案的影响 |
|---|---|---|
| Hub 服务族 | [API](../../packages/galaxy-official/src/server.mjs)、[Worker](../../packages/galaxy-official/src/worker.mjs)、[发布器](../../packages/galaxy-official/src/content-publisher.mjs)、`src/migrate.mjs` | 同源但分进程、分数据库角色；迁 Go 后保留职责隔离 |
| Native 主入口 | [native-v2-entry.mjs](../../packages/galaxy-edge-mcp/src/native-v2-entry.mjs) → [stdio.mjs](../../packages/galaxy-edge-mcp/src/native-v2/stdio.mjs) → runtime/server | 现行本机运行主线，不把旧 `src/index.mjs` 当成完整客户端 |
| CLI | [cli.mjs](../../packages/galaxy-node/src/cli.mjs) | 目前是本机 ID 的内部 init/status/export 回退工具，不是完整桌面客户端 |
| OpenCode 桥接 | [native-runtime-bridge.mjs](../../integrations/host-adapters/opencode-stable/native-runtime-bridge.mjs) | 直接导入 `startNativeStdio` 并用进程内 MCP Transport；只替换安装命令不能退出旧核心 |
| 宿主采集与整理 | [work-recorder.mjs](../../integrations/host-adapters/opencode-stable/work-recorder.mjs)、[work-summarizer.mjs](../../integrations/host-adapters/opencode-stable/work-summarizer.mjs) | 插件直接写本机历史／原件，并通过宿主 SDK 调用用户模型；必须拆开宿主取材与持久处理 |
| 本机资料 | [files.mjs](../../packages/galaxy-core/src/storage/files.mjs)、[Native Store](../../packages/galaxy-edge-mcp/src/native-v2/store.mjs)、Core `work-history/`、`conversation-archive/` | 身份及连接JSON、密钥PEM，工作履历 `work-history/history.sqlite`、会话原件 `conversation-archive/private.sqlite` 分别按原身份管理；协调锁数据库另行保留 |
| 跨进程写入 | [write-lock.mjs](../../packages/galaxy-core/src/storage/write-lock.mjs) | `.galaxy-coordination.sqlite` 只提供协调锁；不能在仍有使用者时删除，也不因此迁全部资料进 SQLite |
| 浏览器 | [runtime.mjs](../../packages/galaxy-web/src/runtime.mjs)、`application/galaxy-session.tsx` | 浏览器设备钥、IndexedDB、草稿与 Query 状态仍在浏览器；不能搬到服务器或要求安装 Go 才能访问网站 |
| 发行 | [build-native-v2.mjs](../../scripts/build-native-v2.mjs)、[组件清单](../../repository-components.json) | `galaxy.js` 是构建输出，不是源目录中的独立入口；现有打包导出 runtime/server/opencode 并依赖 Node |

上述是关键运行链路的源码核对，不等同于全部业务和全部宿主运行验收。现行功能与权限边界仍以产品正文和用户确认记录为准，入口定位见[架构](architecture.md)。

## 3 目标运行结构

```text
官网／社区／私聊／管理后台        宿主 TUI／插件／MCP Apps
Next.js／React                    保留现有界面与宿主 SDK
       │                                  │
       │                         MCP 或受控本机调用
       │                                  │
       │                           Go Native 核心
       │                    身份、文件、履历、原件、连接
       │                    原操作恢复、MCP、已有本机能力
       │                                  │
       └─────────── HTTPS／SSE ────────────┘
                         │
                    Go Hub 核心
          API／Worker／内容发布器／技术迁移入口
                         │
            PostgreSQL 与保留的专业组件
```

服务器和 Native 使用一个 Go 源码模块，生成不同用途的程序。共用协议、签名基础、错误定义和 HTTP 客户端；服务器权限与本机私有资料各自拥有独立实现和运行身份，不共用一份“万能运行时”。

Native 由现有宿主按需启动，保留退出与在途操作收尾。OpenCode 的桥接改成与 Go 子进程通信，不默认新增系统服务或永久监听端口。已有临时本人选择页保留原生命周期与访问限制。

## 4 迁移与保留清单

| 模块 | Go 接管的部分 | 继续复用的部分 |
|---|---|---|
| 身份与账户 | 本机身份控制、设备与绑定；网站／管理账户业务、角色和权限、门户会话接线 | Keycloak 密码、验证、认证资料及自定义 Java Provider |
| 社区与业务对象 | 帖子、回复、分类、收藏关注、项目及其他当前有效业务的读写与访问条件 | 现有 React 页面；不据旧代码扩张官方对用户协作的管理 |
| 聊天与文件 | 成员业务、银河接口、治理、文件中转、访问与清理规则 | Prosody 投递／历史、对象存储、ClamAV；浏览器聊天交互 |
| 后台治理 | 举报申诉、处置、恢复、反馈、执行授权和审计 | 各页面布局和共享控件；人工要求不因迁移改变 |
| 规则、策略与自动运行 | 规则计算、调度、任务状态、业务执行、操作卡和结果账本 | Agno／AgentOS 的模型运行、工具步骤、会话与人工暂停接续 |
| 模型 | 场景授权、业务侧模型设置接线及用量读取 | LiteLLM 的协议转换和模型入口；配置仍由人工维护 |
| 搜索、推荐、分析 | 资格过滤、数据同步、运营调控、效果关联 | Meilisearch、Gorse、OpenPanel；保留主题调控，不新增逐篇人工选推荐 |
| 公告、通知与邮件 | 受众、计划、事件、投递账本、SMTP 消费与退信接线 | 已确认的五类发件身份和正式邮件视觉；邮件模板按原效果迁入或编译，不另起常驻 Node 渲染服务 |
| CMS 与公开内容 | 发布结果接收、快照激活、网页变化事件 | Payload 草稿／媒体／内容编辑、Next.js 服务端页面生成 |
| 本机工作资料 | 身份隔离、履历／会话原件存取、现有上传选择、删除导出和原操作接续 | 用户原资料与现有用途范围；不新增自动跨设备同步 |
| Native 接入 | MCP 工具、资源、真实本人选择、远端调用、A2A／Worker 接线 | 宿主依赖的 TUI／插件 SDK、Skill、小面板 HTML／React |
| 平台能力 | Go 中的能力调度、状态和结果解释 | 已有 Windows／macOS／Linux helper 按真实平台保留；不把交叉编译当作系统通知已验收 |
| 运行维护 | Go 服务配置、日志指标、备份协调和原有恢复接线 | 现有反代、监控、数据库和组件原生工具；整站恢复仍由代码执行且保留人工批准 |

保留的专业组件管理自己的内部数据库。Go 通过已有受控接口调用，不合并 Keycloak、聊天、AgentOS、CMS 与银河业务库为一张全站数据表。

## 5 关键接线如何改

### 服务器业务

将当前 HTTP 适配、领域事务和受权读取迁入 Go。保留可用的 URL、字段和操作含义，修正内部结构时让所有真实消费者同时更新，不为旧内部 JS 导入关系保留长期转发层。前后台 BFF 只承担网页 Cookie、CMS 或渲染需要的薄接线，最终业务授权与写入由 Go 决定。

普通登录、管理登录及受控设备请求仍有不同凭据和权限边界。Keycloak 不被替换；现有门户续期、撤销和准确错误分类进入 Go，正常续期不清空页面查询或草稿。

变化事件继续在真实业务提交后产生，保留发布游标、必要补发和具体查询消费者。私聊及 AI 流式通道保留各自用途；Go 取消等待不等于远端业务已撤销，未知结果仍核对原操作。

### Native 与宿主

标准 MCP 宿主把启动命令从 Node 包切到对应平台的 Go 可执行文件。现有工具名、输入／输出、资源、取消、选择与错误语义逐项承接，不能以 tools/list 成功视为全部兼容。

OpenCode 保留菜单、原输入框追加、宿主事件订阅及模型 SDK；桥接改为真正的子进程 MCP 会话。宿主只采集其实际可见的事件与必要片段，交 Go 进行身份检查、去重、持久保存及现有上传处理。录制器和整理器不再直接写同一套 JSON。需要宿主模型整理时，Go 只提供获准输入／待办与结果接收，宿主适配层调用用户已选模型并返回原任务结果，不将用户工作转给后台运营 AI。

MCP Apps 保留现有面板 HTML、资源 URI、元数据和权限消费者；由 Go 提供受控工具结果，面板不直接读取密钥或本机文件。当前请求状态令牌、2026 协议分支、elicitation、旧协议回退及 Apps 元数据并非任意 Go SDK 都能直接等价支持，属于首批必须解决的真实兼容点。

网页自己的设备钥继续留在浏览器。Go Native 只承接现有签名握手和设备授权，不把 Native 私钥、门户 Cookie 或宿主凭据注入页面。

### AI 与专业服务

Agno 发出的工具意图先到 Go：检查当前人员／AI 角色、任务用途、自主范围、对象状态与原操作，再调用原业务模块。Go 记录业务结果，AgentOS 记录原生运行；模型完成不能代替业务完成。工作台聊天指令的写入仍通过具体操作卡，后台自主任务仍使用 AI 工作账户，不借管理员会话执行。

LiteLLM 和人工模型配置保留，Node 侧受控网关、任务和审计接线迁 Go。搜索、推荐、分析也沿同样方式迁移银河适配层，专业计算继续复用原组件。

## 6 数据与在办事项承接

- 保留账户 ID、UID、本机 GUID、设备／绑定关系、密钥、公钥信任、操作号和有效记录，不重新生成身份。
- PostgreSQL 保留业务表和 SQL 含义；先提取 SQL，再用 Go 调用。账号库、业务库、CMS 与专业组件持久化边界保持。
- Native 首版原位读取现有 JSON／PEM／履历／原件格式，沿用 SQLite 协调锁和原子文件提交。不借换语言引入本机全量 SQL 化、密钥换代或新加密解锁。
- 签名与哈希按现有准确字节承接；JSON 字段顺序、数字／字符串、空值、默认值、时间单位和大序号必须明确，Go 零值不能替代业务上的未提供／未知。
- 已签未知操作只能沿原 owner／operation 查询。尚未执行的队列项可在停发、核对原状态后转换；已发出的外部发送或处置不能重新排队冒充未执行。
- 现有 Agno 会话／运行不重置；等待人工事项继续绑定原任务和决定。新旧队列不能同时领取同一业务，旧任务历史仍可定位，不要求保留旧 Node Worker 才能查看。

## 7 工程选型

| 用途 | 采用方向 | 选用理由与接入条件 |
|---|---|---|
| HTTP／SSE | Go 标准库，按真实需要补轻量路由 | 少一层自建框架；复用当前接口含义与连接恢复 |
| PostgreSQL | [pgx](https://github.com/jackc/pgx) | 原生 PostgreSQL 驱动、连接池及通知能力 |
| SQL 接线 | [sqlc](https://docs.sqlc.dev/) 按需使用 | 从现有 SQL 生成有类型的 Go 调用，复杂动态查询保留明确实现，不为工具重写数据模型 |
| 后台队列 | [River](https://riverqueue.com/docs/transactional-enqueueing) 开源基础 | 支持事务内入队；不直接复用 pg-boss 内部表。持久计划仍由银河计划记录负责，不默认为商业功能加依赖 |
| MCP | [官方 Go SDK](https://github.com/modelcontextprotocol/go-sdk) | 复用标准协议；现行请求状态、版本分支和 Apps 接线须用实际协议路径确认，缺口集中适配，不维护第二套业务实现 |
| 本机协调 | 原 SQLite 锁协议＋modernc.org/sqlite | 纯 Go 驱动承接实际事务锁，不用进程内 mutex 代替跨进程锁 |
| OIDC | [coreos/go-oidc](https://github.com/coreos/go-oidc)＋[golang.org/x/oauth2](https://github.com/golang/oauth2) | 复用发现、签名校验及 OAuth；银河承接原作用域、门户会话、本人／管理身份及失败恢复，不手写另一套 JWT 验证 |
| 邮件、签名、对象存储 | 标准库与成熟协议库组合 | 保留原身份和验证含义；实施时锁定兼容版本，不为追求纯 Go 改写外部组件 |

首批版本为Go1.27.3、pgx5.11.0、sqlc1.31.1、River0.50.0、官方MCP Go SDK1.8.0。当前已消费依赖锁入go.mod/go.sum：SQLite1.61.0、go-oidc3.21.0、oauth2 0.36.0等；River及sqlc随实际队列／生成消费者接入，不用未使用依赖充当完成。版本选择不表示全部协议互通或性能测量。

## 8 建议源码组织

```text
apps/                         保留前台、后台、认证主题
packages/galaxy-web/           保留网页业务与共用交互
integrations/host-adapters/    宿主界面、事件和模型 SDK 薄适配
integrations/native-v2/        安装材料、Skill、嵌入面板等保留部分
services/                     保留 AgentOS、模型网关及专业组件适配
contracts/                    从现行有效接口整理的共同描述与样例

go/                           一个 Go 模块，不按目录拆微服务
├─ go.mod
├─ cmd/
│  ├─ api/                    HTTP 与事件入口
│  ├─ worker/                 后台任务入口
│  ├─ publisher/              独立内容发布权限入口
│  ├─ migrate/                技术迁移入口
│  └─ galaxy/                 本机 CLI／MCP／安装子命令
└─ internal/
   ├─ protocol/               协议、错误及准确字节约定
   ├─ identity/               真正共用的签名与身份基础
   ├─ client/                 Go HTTP／SSE 客户端
   ├─ server/                 按账户、社区、治理等业务域组织
   ├─ native/                 本机存取、履历、原件、连接和本人选择
   └─ platform/               真实共享的日志、配置及运行基础
```

目录为职责示意，按真实实现调整。OpenAPI／JSON Schema 只描述适合生成的合同，不能假装从任意 Zod refine 自动生成等价 Go 校验。必要的 Go／TS 类型和调用代码从一个来源生成，签名及状态语义保留少量跨语言样例。浏览器所需的 TS 客户端继续保留，不再从服务器私有实现中跨目录取代码。

## 9 实施顺序和阶段交付

| 阶段 | 实际工作 | 阶段交付 |
|---|---|---|
| A 计划与共同基础 | 原位整理本计划；独立 Go 工具链、单一模块、配置／错误／日志／协议／签名及 PostgreSQL／SQLite 接线 | 可运行的基础及原资料读取，身份、签名字节和跨进程锁保持；不建一批无消费者框架 |
| B 第一条完整路径 | 服务器先迁反馈提交、查询、分类／状态更新、历史及原操作回执；Native 先迁身份状态、履历读取和一个现有本人选择流程 | 网页与宿主沿真实 Go 权限、持久化、事件及失败恢复办理，不仅是库函数通过 |
| C 全面迁移 | 按完整领域迁读写／权限／事件／审计；迁本机履历、原件、连接、已有上传选择及设备接续 | 有效业务独立由 Go 承担，原 ID／UID／绑定和资料不变；新旧调度不重复领取 |
| D 宿主及专业组件 | OpenCode 改 Go 子进程 MCP；宿主录制与整理结果交 Go 保存；接 AI、聊天、邮件、搜索、推荐、分析及 CMS 发布 | 原界面及专业服务与 Go 核心贯通；用户选定的宿主模型仍由宿主 SDK 调用 |
| E 发行与收束 | 构建、安装、签名、部署材料及组件清单；处理在办任务；退出无消费者的旧核心及依赖 | 可发布源码、服务器及 Native 产物，不再维护两套核心。正式上传、真实迁移及切换仍在本轮授权之外 |

本轮从 A 阶段开始，由主会话协调共享协议、依赖、迁移登记和总装配。共享文件不多处重复定义；按完整模块整理审阅和提交，不建立长期漂移的模块分支。阶段 B 贯通后再根据实际业务量评估余量，不按新增文件或测试数量折算完成比例。

## 10 发布与旧实现退出

服务器保留 API、Worker、发布器和迁移的独立权限／启动配置；共享源码不要求合为一个全权限进程。Next.js、Payload、认证 Provider 和专业组件仍分别构建。

Native 按 Windows／Linux／macOS 的实际目标架构生成包，MCP 命令改指对应二进制；安装器迁 Go，仍保留宿主配置、Skill、UI 资源与签名校验。核心不再依赖 Node，但宿主插件自身可能仍依赖宿主 Node／Bun 环境，不能宣传整个生态无 JavaScript。平台 helper 的真实系统能力按实际机器验收，不新增自升级服务。

切换时先停止旧调度和 Native 写入者，核对未决操作与本机文件锁，再启用新入口。现有资料原位承接，只有必要技术结构作迁移。冻结旧发行包不改字节；源码内已被完整替代且无实际消费者的旧 Node 服务、Native 核心、构建入口与重复依赖移出当前主链路。迁移适配不能长期演变成第二套业务核心。

同步更新组件清单、CI、安装命令、部署和恢复说明；保留旧运行记录的真实性，不补造新系统历史。GitHub、生产迁移、认证改配和正式切换需另有实施授权。

## 11 必要检查与完成判定

检查集中在最小贯通、整批接通、最终发行三个节点。只验证改变的行为及跨语言边界，复用未变输入的结果，不增加逐文件证明或大范围压力测试。

必须覆盖：原身份／签名字节和资料回读；权限与撤销；真实业务提交、事件和原回执；未知写入不重复；Native MCP 会话、本人选择、Apps 与宿主关闭；OpenCode 事件／模型结果正确归属；本机多进程锁与中断后原文件；门户续期及网页草稿；有实际目标机器的安装和 helper。其余已有有效业务按受影响领域代表性闭环检查。

只有服务器和 Native 的有效业务能力真正迁入 Go、旧主核心退出、现有界面和数据承接成立，才算完成。Go 外壳转发全部旧 Node、空工具列表、单纯编译通过或语言统计变绿，都不是完成。

## 12 实施约束与待核对事项

本轮已确定保留现有业务数据库结构、本机文件格式及宿主 UI，完整就绪后统一切换。重设计数据库或新增独立桌面 App不属于本轮。Go SDK现行协议能力缺口及平台打包问题先由实际实现给出具体影响，再核对真正需要用户选择的取舍。

整体范围已获用户授权。常规实现持续推进；影响业务含义、数据归属或发布边界的问题带具体影响核对。当前进展只维护于根 WORK_STATUS.md，不按批次增加总结。
