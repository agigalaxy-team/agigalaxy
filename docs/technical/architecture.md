# 架构与源码定位

银河使用一个仓库维护网页、Go 业务核心、宿主界面和专业服务。职责划分用于明确数据与执行归属，不要求把每个领域拆成独立服务。当前收束进度和未完成项只在 [WORK_STATUS.md](../../WORK_STATUS.md) 维护；已部署版本与本地在办改动分别记录。

## 运行与数据边界

| 组件 | 实现与职责 |
|---|---|
| 官网、社区、私聊 | `apps/galaxy-site` 的 Next.js 路由与常驻布局，复用 `packages/galaxy-web/src` 的 React 页面；公开正文服务端呈现，浏览器保留设备钥、IndexedDB 和草稿 |
| 管理后台 | `apps/galaxy-admin` 的 Next.js/Payload 和受控 BFF；CMS 库、媒体及管理会话独立，业务事实通过 Go API 修改 |
| 业务核心 | `go/cmd/galaxy-api` 与 `go/internal` 各领域；账户、权限、社区、消息、文件、任务、策略、审计和专业服务适配使用同一业务权威 |
| 后台执行 | `galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher` 分工运行；River 管理所选任务队列，原业务作业保留其 ID、租约与回执 |
| 本机核心 | `go/cmd/galaxy`、`go/internal/native`、`go/internal/localdata` 管身份 JSON/PEM、履历与会话原件 SQLite、协调锁、连接、MCP 与本人选择 |
| 宿主 | `integrations/host-adapters` 保留 TUI、宿主 SDK 与模型调用，通过 Go MCP/私有宿主子进程读取和保存银河本机资料 |
| 共同合同 | `packages/galaxy-contracts/src` 是 JS schema、权限/动作元数据和签名合同的维护来源；Go 权限投影由 `scripts/go/generate-permission-catalog.mjs` 生成 |
| 客户端 SDK | `packages/galaxy-client/src` 提供浏览器 HTTP/签名客户端、浏览器身份和摘要 IndexedDB；`node/` 仅供宿主或 Node 工具，不进入浏览器启动路径 |
| 认证 | Keycloak 与 `apps/galaxy-auth` 的主题/provider；普通账户和管理身份域保持分离 |
| 聊天与附件 | Prosody、对象存储与 ClamAV 保留专业职责，Go 负责银河成员关系、业务权限与治理；客户端不直连 XMPP |
| AI | `services/galaxy-operations-agentos` 的 Python/Agno 承担模型运行、暂停和接续；Go 核对业务权限、任务、动作和原回执，LiteLLM 保留模型协议职责 |
| 发现 | Meilisearch、Gorse、OpenPanel 保留搜索/推荐/分析计算，Go 负责资格过滤、策略和业务适配 |
| 维护 | `go/cmd/galaxy-migrate`、`galaxy-lifecycle` 是显式维护命令；`packages/galaxy-official/deploy` 保留系统服务、平台恢复及外部组件接线 |

本机身份、履历、原件、业务库、CMS、认证、聊天和对象存储分别持久保存。备份按网站协调；恢复仍由人工批准具体方案，不能把 AI 诊断当作恢复执行者。`packages/galaxy-official` 的保留职责是部署材料、公开资料与必要平台接线，不再定义第二套当前 Node 业务核心。

## 源码与依赖方向

```text
Next.js 页面 / 宿主 UI
    ├─ Web、Client SDK、共享合同
    └─ Go API / Go Native
           ├─ Go 业务领域与数据存储
           ├─ Worker、Publisher、显式维护命令
           └─ 认证、聊天、AI、搜索、推荐、分析组件
```

`repository-components.json` 记录实际源码所有者、构建输入与变更传播；`dependsOn` 不等于必须启动同名服务，构建顺序只由 `buildDependsOn` 决定。Go 是单一模块，按领域组织，不复制每个客户端或服务的 schema。业务迁移 SQL 与角色 SQL 的唯一现行来源为 `go/internal/databaseschema/sql`；生成器只从该目录产生版本目录，不加载旧业务服务。

Web 的领域组件、类型和样式归 `features/`；跨领域读取、草稿、身份、提交反馈归共享层。Admin 同样复用页签、DTO、查询和操作恢复组件。AI 入口只在工作台，业务页展示相关任务和结果，不各自加聊天框。A2A SDK 保留自身协议和原操作日志，其 JavaScript 日志不是 Go Native 用户资料的另一写入内核。

## 网页运行机制

前台与后台分别运行、分别鉴权，不共享主体缓存。Next.js 管路由、常驻布局和公开首屏；React 接续复杂交互，不再经旧 App 启动桥或独立 Vite 路由切成第二套网站。初始化更新同一上下文，不替换编辑器正文。

服务器数据由共同 QueryClient 持有，按入口、服务、主体/连接世代、读取用途和对象隔离；草稿、选择与阅读位置单独保存。普通切页、聚焦和重连不整批重读。真实提交事件只更新相关查询；断线补发不足时重取有关模块。私聊与 AI 保留专用通道，不广播正文。

显示快照、更新状态与当前操作资格分开：普通续读、短读取期限到期、暂时故障及切回窗口不清空已有内容，新结果到达后仅替换相关区域。明确退出、撤权、对象不可读及材料自身到期仍清除对应内容；写入与确认保留当前资格校验。事件补发缺口（replay-gap）只使相关模块后台更新，不能冒充权限失效。

资格与版本分别核验。权限目录与AI对话已有轻量资格续证，其余来源仍按必要授权重核；对话续证不承诺历史未变。 同一只读事务可复用当前人员和固定AI的权限投影，输出前仍执行独立实时围栏，写入不使用该捷径；不跨请求缓存权限。条件 GET、状态计时器不等于资格续证。未知写入只查原 operation，不自动改号重发。门户续期边界见 [认证](authentication.md#门户会话与连续使用)。

## 协议与有限互联

HTTP、MCP、MCP Apps 和 A2A 承接已有业务含义。身份、授权与未知操作恢复见 [接口](interfaces.md#管理身份与原操作)。Hub 是服务环境，Worker 执行获准工作，Bridge 保留映射来源；名称不证明跨组织网络已经运行。

`galaxy-direct-proof/1` 是双方显式约定 endpoint、公钥、协议、来源、用途、期限、分页和退出状态的 HTTPS 签名查询。仅交换获准的 CI proof 或非叙述贡献字段，保留来源与许可，不复制任务上下文、不保留响应正文，也不提供全站复制或 XMPP 联邦。

构建见 [开发](development.md)，运行见 [部署](../operations/deployment.md)，AI 与模型边界见 [AgentOS](agent-runtime.md)。平台验收与实际交付范围以当前状态和对应实际结果为准，源码目录或构建成功不能证明整个业务链已验收。
