# 技术参考索引

[文档目录](README.md) · [架构](architecture.md) · [当前状态](project-status.md)

优先从以下仓库内正文和源码进入。带版本的合同按该版本理解；接口、运行配置和最新实现继续以当前消费者源码为准。

## 开发、运行与发行

| 内容 | 入口 |
|---|---|
| 环境、预览、依赖与排障 | [开发指南](development.md) |
| 自部署与 AI Agent 接续 | [部署指南](deployment.md) |
| 独立运行环境约束 | [运行环境](runtime-environments.md)、[约束源码](../packages/galaxy-official/src/runtime-environment.mjs) |
| Linux 部署材料 | [Linux 准备](linux-deployment-v1.md)、[部署生成器](../packages/galaxy-official/scripts/prepare-linux.mjs) |
| 检查与实际 CI 范围 | [开发检查](development-checks.md)、[工作流](../.github/workflows/product-checks.yml) |
| Native 安装及兼容 | [下载](downloads.md)、[Native 工具说明](native-client-v2.md)、[宿主资料](native-client-hosts-v2.md) |
| Native 许可及打包范围 | [许可说明](native-client-license-v2.md)、[实际 LICENSE](../integrations/native-v2/legal/LICENSE)、[NOTICE](../integrations/native-v2/legal/NOTICE) |
| 官网构建 | [官网 README](../apps/galaxy-site/README.md) |
| 认证、注册与邮件 | [认证 README](../apps/galaxy-auth/README.md)、[验证码 Provider](../apps/galaxy-auth/providers/email-code/README.md)、[共享邮件](../packages/galaxy-mail) |
| 管理应用 | [后台 README](../apps/galaxy-admin/README.md)、[环境示例](../apps/galaxy-admin/.env.example) |
| 监控、日志与恢复编排 | [运行工具源码](../packages/galaxy-official/deploy/operations-stack)、[配置示例](../packages/galaxy-official/deploy/operations-stack/configuration.example.json) |

## 产品业务与接口

| 内容 | 入口 |
|---|---|
| 业务 API 与工具 | [开发 API 目录](development-api-reference-v1.md)、[生成源](../packages/galaxy-official/api-reference.mjs) |
| 在线账户参与、对话与附件 | [账户参与 v3](account-participation-v3.md) |
| UID、账户与 ID 的公开查询 | [公开查询合同](account-public-query-v1.md) |
| 外部凭据及状态来源 | [外部凭据](external-credentials.md) |
| 本机、上传与来源 | [数据与权限](privacy-and-data.md)、[上传范围](../packages/galaxy-core/src/upload-privacy.mjs) |
| 工作事实与摘要 | [本地工作源码](../packages/galaxy-core/src/work-history)、[Native 说明](native-client-v2.md) |
| 私有原会话 | [会话归档源码](../packages/galaxy-core/src/conversation-archive) |
| 客户端读取、加载与复制 | [交互模块](client-interactions.md) |
| 官网、Web 与认证共用外壳 | [网站界面模块](site-ui.md) |
| MCP 与宿主 | [适配器 README](../integrations/host-adapters/README.md)、[Native 源码](../integrations/native-v2) |
| A2A | [适配器 README](../packages/galaxy-a2a/README.md)、[源码导出](../packages/galaxy-a2a/package.json) |
| 数据库和迁移 | [数据库实现](../packages/galaxy-official/src/database.mjs)、[迁移列表](../packages/galaxy-official/src/infrastructure/migrations.mjs) |

## 版本与旧导航

旧技术入口有一部分只保留了指向维护工作区归档的跳转，正文不在此仓库中。不能把这些外置正文写成 GitHub 读者可以取得的资料，也不能把旧服务器路径与运行记录当作新环境配置。

目前可独立阅读的总览已经放在本仓库。历史导航中的外置引用应明确标注为未分发资料；原始路径可以保留在源码注释供维护者追溯。旧证据、演示和版本说明仍只证明各自范围，不替代当前产品状态或实际验收。
