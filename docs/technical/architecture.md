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
| 官网 | `apps/galaxy-site/` 的 Python 生成器消费 Web 构建及公开资料；静态阅读与 CMS 发布元数据分别保持 |
| 业务网页 | `packages/galaxy-web/src/main.tsx`；React/TypeScript/Vite。`runtime.mjs` 组合当前身份、设备、连接世代和受控客户端，`features/` 按业务域组织 |
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

Official 的 HTTP 适配位于 `src/adapters/http/`，闭合 schema 与纯合同位于 `src/shared/`，数据库、迁移和加载器位于 `src/infrastructure/`。领域下通常以 `authority`/`base`、`read-model`、`service` 区分授权事务、受权读取和命令，实际文件以源码为准。常用入口：

| 修改目标 | 实现目录或入口 |
|---|---|
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

稳定公共入口可转出实际实现，内部消费者直接引用所属目录。Hub 私有 AgentOS schema不因目录位置而成为公开协议。路径细分和搬移过程属于变更记录。

## 协议、授权与有限互联

各入口的身份、来源授权与原操作恢复统一见[管理身份与原操作](interfaces.md#管理身份与原操作)。

HTTP、MCP、MCP Apps、A2A 复用对应业务含义，宿主面板与协议可选项按实际能力使用。Hub 是服务环境，Worker 执行获准工作，Bridge 保留外部映射来源；角色名称不证明跨组织网络已经运行。

`galaxy-direct-proof/1` 是双方 HTTPS 签名查询：显式约定双方 endpoint、公钥、协议哈希、来源种类、请求者、用途、限流、分页、有效期及退出状态；只交换获准 `ci-proof-v2` 或选择的非叙述贡献字段。逐来源版本/哈希与许可重新核查，不夹带原任务上下文，不留存响应正文，不经官方中继。它不提供全站复制或 XMPP 聊天联邦；Bridge 映射与对端报告保留出处，不能自动升级为独立证据。

局部构建见[开发](development.md)，运行配置见[部署](../operations/deployment.md)，精确路由和授权定位见[接口](interfaces.md)。
