# 架构与源码定位

本页用于定位运行边界、数据所有者和实现。五层职责说明采集、解决、证据生产、核心与信息服务之间的关系，不要求拆成五个服务，也不代表各层都已完成生产覆盖。

| 职责 | 主要实现 |
|---|---|
| 采集：获准的文字、工具观察、有限片段、环境和来源 | `packages/galaxy-core/src/work-history/`、`integrations/native-v2/`、`integrations/host-adapters/` |
| 解决：阅读背景、查找参与者和方法、使用工具、继续原工作 | `packages/galaxy-web/src/`、`packages/galaxy-node/src/`、`packages/galaxy-a2a/src/` |
| 证据生产：尝试、结果、更正、撤回与核验 | `packages/galaxy-core/src/domain/`、`packages/galaxy-official/src/` |
| 核心：本机身份、主体控制、声明、历史与方法 | Core、Node、Official 的相应领域 |
| 信息服务：按当前权限发现、检索、比较与关注 | Official、Web、`packages/galaxy-edge-mcp/src/` |

## 运行与数据边界

| 组件 | 实现和数据归属 |
|---|---|
| 官网 | `apps/galaxy-site/src/app/` 的 Next.js 动态网页；公开正文服务器呈现，Python 只编译原有公开内容与历史资源，不生成现行 HTML |
| 业务网页 | `packages/galaxy-web/src/application/` 共享 React 业务实现，Next.js 页面持路由；Vite 薄入口仅保留独立诊断用途。`runtime.mjs` 组合当前身份、设备、连接世代和受控客户端，`features/` 按业务域组织 |
| 本机客户端 | Core 保存本机身份、领域与工作记录，Node 组合 CLI，edge-mcp 提供 MCP/Native 表面；模型由宿主提供，采集能力取决于宿主实际接口 |
| Hub | `packages/galaxy-official/src/server.mjs`、`worker.mjs`、`migrate.mjs` 与 publisher 属于同一发行服务族，共用业务 PostgreSQL；迁移、运行和所有权角色分开 |
| 身份 | `apps/galaxy-auth/` 的 Keycloak 主题、Java provider 与受限 realm 工具；普通账户与管理身份域分别配置 |
| 管理 | `apps/galaxy-admin/` 的 Next.js/Payload 与受控 Node BFF；CMS 数据库、媒体、会话独立，业务事实经银河 API 修改 |
| 聊天与文件 | Hub 服务器内部的 Prosody/XMPP、对象存储和 ClamAV；客户端调用银河 HTTPS 业务接口，不直接用 XMPP。传输成员关系、对象 URL 不替代来源授权 |
| AgentOS | `services/galaxy-operations-agentos/` 的 Python/Agno 原生运行；Node 保留业务权威，模型工具经受控网关执行 |
| 模型网关 | `services/galaxy-model-gateway/` 固定上游的模型协议与目录运行表面，配置边界见[接口](interfaces.md#权威边界) |
| 发现引擎 | `services/galaxy-discovery/` 与 Official `src/discovery-runtime/`；搜索、推荐、分析适配不代替来源资格检查 |
| 运行工具 | `deploy/` 与 Official `deploy/` 中的 Caddy、systemd、Compose、监控与备份材料 |

根 `app/` 和 demo 脚本用于早期演示。当前 Web 和完整 Hub 的入口分别以上表为准。本机目录、业务库、CMS、身份库、聊天与对象存储各自持久保存；备份恢复须协调它们的时间和关系。

## 依赖方向与领域定位

[`repository-components.json`](../../repository-components.json) 是组件构建输入，构建器、CI、Hub capture 与源码归档共同读取。`apps/`、`packages/`、`services/`、`integrations/` 按实际运行和发行职责组织，跨目录共享源码不复制实现。

组件dependsOn记录实际源码输入与变更传播，包含选用的跨目录客户端；它不表示需要启动同名服务。构建次序只按实际buildDependsOn处理。当前仍是共享源码的单仓工程，拆仓前再按真实接口收束依赖，不根据目录名推定已能独立安装或部署。

Official 的 HTTP 适配位于 `src/adapters/http/`，闭合 schema 与纯合同位于 `src/shared/`，数据库、迁移和加载器位于 `src/infrastructure/`。领域下通常以 `authority`/`base`、`read-model`、`service` 区分授权事务、受权读取和命令，实际文件以源码为准。常用入口：

Official顶层只保留API、Worker、迁移、发布器的启动与服务装配，以及明确的公共浏览器合同；账户、身份、社区、治理、事实、消息和运营实现归各自领域。可在浏览器/Native消费的客户端及本机流程归`src/clients/`，不与服务端事务混放。单目标内部转发文件不作为第二份入口维护。

| 修改目标 | 实现目录或入口 |
|---|---|
| 账户、认证与签名边界 | Official `src/accounts/`、`src/identity/`、`src/security/` |
| 客户端及本机持久流程 | Official `src/clients/`、`clients/flows/`、`clients/local/` |
| Task/参与、Builder/节点控制 | Official `src/tasks/v2/`、`src/builders/` |
| 文件、反馈、权限 | Official `src/operations/files/`、`feedback/`、`permissions/` |
| 规则、策略、三渠道消息 | Official `src/operations/rules/`、`strategies/`、`messaging/` |
| 搜索质量、公开发现 | Official `src/operations/search-quality/`、`src/discovery-runtime/` |
| Personal MCP 工具和配置 | Official `src/adapters/mcp/personal/`；Native HTTP 工具复用其 schema |
| 固定预算与论坛额度纯合同 | Official `src/shared/policies/`；文件加载与 SQL 用量留在运行层 |
| 个人摘要、会话笔记 | Official `src/summaries/local/`；Web `src/features/conversation-notes/` 的 account/native 保持不同身份隔离 |
| Native 工作、身份、关注与宿主交互 | edge-mcp `src/native-v2/{work,identity,watch,tools,adapters,interaction}/` |
| Core 初始化 | Core `src/initialization/` 的纯目录、呈现与选择合同，不加载 Hub/数据库 |
| A2A | `packages/galaxy-a2a/src/{protocol,hosts,facts,storage}/` |
| 共享邮件、运行日志 | `packages/galaxy-mail/`；Official `src/shared/runtime-logger.mjs`，调用方各自闭合投影 |
| 仓库检查 | `scripts/check.mjs` 与 `scripts/checks/` 的测试发现和 runner |

Admin 的 Payload 服务入口继续在 `src/components/Welcome.tsx`、`FeedbackView.tsx`、`SystemSettingsView.tsx`、`AnalyticsView.tsx`，客户端实现分别归 `components/workbench/`、`feedback/`、`system-settings/`、`analytics/`，沿 `BusinessViewClients` 的原动态边界加载。DTO、读/命令hooks、草稿、账户选择与通用控件保持共享，工作台/账户复用同一分析图表，不新造会话状态、轮询或模型客户端。目录拆分不证明首屏性能改进，收起沟通面板保留状态，图表保留原lazy plot导入。

Web的业务实现、类型及同域样式集中在`src/features/`，跨域人物、身份、阅读与操作生命周期在`src/shared/`；根入口保留应用、运行时和全站外壳的真实组合职责。复杂页面由唯一会话控制器持有草稿、权限租约和原操作，子面板只消费受控数据。Admin同样将业务族的页面实现与命令hooks归同域目录，公共读取、账户选择及提交反馈继续共享。

AgentOS的`app.py`装配应用，`surface.py`维护唯一ASGI请求权限边界，运行投影与工具合同分别独立；Node的`operations/agentos/actions/`按准备、执行和原回执核对分工。OpenCode的`galaxy.tui.ts`装配宿主会话，领域菜单消费同一实时会话上下文；不复制代际控制或恢复流程。Site 数据编译保留原作者内容；CMS 发布器只激活安全 snapshot 与选中媒体，Next.js 按实际发布指针呈现，不执行 HTML 应用器。

稳定公共入口可转出实际实现，内部消费者直接引用所属目录。Hub 私有 AgentOS schema不因目录位置而成为公开协议。路径细分和搬移过程属于变更记录。

## 协议、授权与有限互联

各入口的身份、来源授权与原操作恢复统一见[管理身份与原操作](interfaces.md#管理身份与原操作)。

HTTP、MCP、MCP Apps、A2A 复用对应业务含义，宿主面板与协议可选项按实际能力使用。Hub 是服务环境，Worker 执行获准工作，Bridge 保留外部映射来源；角色名称不证明跨组织网络已经运行。

`galaxy-direct-proof/1` 是双方 HTTPS 签名查询：显式约定双方 endpoint、公钥、协议哈希、来源种类、请求者、用途、限流、分页、有效期及退出状态；只交换获准 `ci-proof-v2` 或选择的非叙述贡献字段。逐来源版本/哈希与许可重新核查，不夹带原任务上下文，不留存响应正文，不经官方中继。它不提供全站复制或 XMPP 聊天联邦；Bridge 映射与对端报告保留出处，不能自动升级为独立证据。

局部构建见[开发](development.md)，运行配置见[部署](../operations/deployment.md)，精确路由和授权定位见[接口](interfaces.md)。

## 网页运行机制

前台与管理后台分别运行，使用同一 Query/事件方法，不共享身份缓存。Next.js 管路由、常驻布局与服务端公开首屏；业务组件保留，主网页不再经旧 App 启动桥接。浏览器设备、私钥与 IndexedDB 仅在浏览器初始化。 SSR 与浏览器接续保持同一 provider/页面结构；初始化只更新上下文，不能以初始化完成为由替换正文。草稿等待保存与普通显示也使用同一上下文层级，避免重新挂载编辑器。

服务器数据由 QueryClient 持有，按 endpoint、主体/连接世代、前后台表面、模块与对象隔离；输入草稿、筛选和阅读位置独立保存。常规切页、聚焦与重连不整批读取。真实业务变更通过提交后事件使相应模块查询失效；事件不广播源正文，断线补发不足只重核相关模块。

读取资格与内容变化分开：权限目录已提供真正的轻量版本/资格续证；其它来源保留其必要授权重核。不得把一般条件 GET、保留期限或本机状态时钟称为完整资格续证。jobs、独立搜索存储及外部扫描/运维源未被虚报为完整事件覆盖。

门户续期复用原会话表，配置、边界和切换要求见[认证](authentication.md#门户会话与连续使用)。新技术迁移和源码交付不代表生产已启用。
