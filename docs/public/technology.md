# 技术栈与产品组成

[文档目录](README.md) · [网络功能](network.md) · [当前状态](status.md)

本页提供产品技术概览；实际源码、接口与自建说明在同一主库的[开发文档](../technical/development.md)和[部署文档](../operations/deployment.md)维护。生产配置和用户资料不随源码公开。客户端发行的安装要求见[开始使用](getting-started.md)。

## 谁需要准备这些技术

网站使用者、客户端使用者和 Hub 运营者的准备范围见[客户端入门的使用方式表](client-entry.md)。这里按技术列出承担的工作，安装环境与步骤统一见[开始使用](getting-started.md)。

## 产品组成

网站、Native、自己的 AI、业务服务、Worker、Hub 与 Bridge 的职责集中见[架构中的组成部分](vision-and-architecture.md)。下面的依赖为这些职责提供实现基础。

## 采用的主要技术

| 领域 | 技术 | 用途 |
|---|---|---|
| Web | Next.js、TypeScript、React、Vite、Tailwind CSS | 类型化开发、组件界面、构建与样式 |
| 业务与本机核心 | Go、River、SQLite | `go/` 中的 Hub 与 Native 独立入口；业务库使用 PostgreSQL，本机资料保留原 JSON／PEM／SQLite 格式 |
| 网页与宿主运行 | Node.js、JavaScript／TypeScript、Python | Next.js 网页、宿主 SDK／UI 与公开内容编译保留各自运行时；Go 核心不依赖旧 Node 业务进程 |
| 服务端数据 | PostgreSQL | Hub／官方的业务数据持久化，由服务维护者配置 |
| 客户端宿主接入 | 插件、MCP、MCP Apps、Skill | 在已有 AI 环境中连接工具、初始化本地身份并使用宿主支持的界面；由安装程序和 AI 协助处理配置 |
| 专用 Agent 执行接入 | A2A | 所支持执行环境的协作接口；普通客户端初次接入无需全部配置 |
| Hub／官方服务端认证 | [Keycloak](https://www.keycloak.org/) / OpenID Connect | 由服务维护者配置，承接相应网站环境的账户认证 |
| Hub／官方服务端聊天 | [Prosody / XMPP](https://prosody.im/) | 服务器内部的消息传输与归档；客户端经银河 HTTPS 业务接口使用，无需安装、配置 XMPP 或单独注册 XMPP 账户 |
| Hub／官方服务端文件 | S3 兼容存储、ClamAV；[Garage](https://garagehq.deuxfleurs.fr/) 是自部署对象存储工程选择 | 对象存储与安全扫描，自部署标准和运行覆盖继续落实 |
| 指标、告警与日志 | Prometheus、Alertmanager、Grafana OSS、Loki、Alloy | 已选定的运行工具组合，真实集中采集覆盖分别核对 |
| 统一备份与恢复 | [restic](https://restic.net/)、[pgBackRest](https://pgbackrest.org/) | 已采用的运行保障方案；配置和构建不等于完整灾备验收 |

表中技术不一定在每种入口中同时运行，客户端与各服务组件分别管理版本。

## 接入与开放方向

MCP 与 A2A 的协议分工见[愿景与架构](vision-and-architecture.md)。Hub 的 `galaxy-direct-proof/1` 有限直连、可交换字段和未启用的 Relay 统一见[Hub 信息流](ecosystem-and-hubs.md)。技术采用本身不代表全部可选协议、跨站聊天室联邦或独立生态已经实现。

## 基础组件的工程整合

运营后台采用 [Payload](https://github.com/payloadcms/payload)、Next.js 与银河业务扩展，Go 任务传输使用 [River](https://github.com/riverqueue/river)，原任务 ID／回执和持久调度由实际业务适配接续；旧 pg-boss 是迁移来源，不是 Go 队列权威。存储、监测、日志和备份恢复复用相应成熟工具；实际接线、部署与完整验收分别处理。

AI 运营引擎、专门服务和候选框架的实际采用范围集中见[开放组件](open-components.md)。普通使用者继续使用自己的模型；框架选型不替代产品效果，整体成熟度见[当前状态](status.md)。
