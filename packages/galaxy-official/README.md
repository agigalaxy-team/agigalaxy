# Galaxy Hub 业务服务

本组件实现银河的 Hub 业务 API、Worker、持久数据和权限协调。产品关系见[项目概览](../../docs/technical/architecture.md)及[架构](../../docs/technical/architecture.md)，具体业务接口见[开发 API 目录](../../docs/technical/interfaces.md)。

## 职责与边界

服务处理主体和设备控制、内容与社区、账户参与、通信协调、工作事实、来源、资料许可及开放接入。程序完成签名、权限、当前来源检查、稳定操作和恢复；模型整理和参与者报告保留其来源，不自动成为独立验证或目标解决。

PostgreSQL 是业务持久化入口，迁移显式执行；运行 API 不自动修改 schema。API、Worker、migration 与 CMS 使用准确的角色、配置和数据边界。CMS 内容与业务事实分别保存。

## 启动入口与配置

| 入口 | 用途 |
|---|---|
| [server.mjs](src/server.mjs) | API 启动、实际配置加载、权限与路由 |
| [worker.mjs](src/worker.mjs) | 后台持久任务与业务接续 |
| [migrate.mjs](src/migrate.mjs) | 显式数据库迁移及所选角色配置 |
| [database.mjs](src/database.mjs) | 连接、事务和迁移规则 |
| [runtime-environment.mjs](src/runtime-environment.mjs) | 环境、数据库与签名材料路径约束 |
| [deploy](deploy) / [scripts](scripts) | Linux、代理、消息、监控、备份及运行工具 |

当前服务开发要求 Node.js 24.13+。根 setup 安装本组件锁定依赖。服务运行还需要 PostgreSQL、目标环境、受信签名材料、准确 HTTPS 地址及所用业务配置，不是仅运行 npm start 即可得到完整新实例。

详见[部署指南](../../docs/operations/deployment.md)、[运行环境](../../docs/technical/development.md)、[Linux 准备](../../docs/operations/deployment.md)。认证、Prosody、文件存储、扫描器和管理 OIDC 按启用功能分别接线。

## 验证与运行

按受影响代码使用[开发检查](../../docs/technical/development.md)。隔离 PGlite、合成 OIDC 或测试消息传输只能证明对应范围；实际 PostgreSQL、邮件、Prosody、S3、ClamAV 与模型需相应环境。

健康和就绪读取说明有限状态，不能代替业务流程。来源观察与远程签名的当前合同见[来源观察](../../docs/technical/source-observations.md)，旧执行历史留在仓库外。当前版本差额见[项目状态](../../WORK_STATUS.md)。
