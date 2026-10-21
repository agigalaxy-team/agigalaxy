# 自部署与运行指南

[文档目录](README.md) · [开发](development.md) · [架构](architecture.md)

本页是当前源码的部署入口，说明要配置的组件、准确源码位置与运行顺序。它不提供可直接套用到任意机器的一键生产配置，也不把历史服务器状态当作新环境的验收结果。

## 选择部署范围

| 目标 | 需要的组件 | 仍需准备 |
|---|---|---|
| 查看官网与网页 | 根 setup / build / start | Node.js 24.13+、Python 3.11+；连接业务时配置公开 API |
| 运行 Hub 业务 | PostgreSQL、API、Worker、公开 HTTPS 反向代理 | 独立角色、迁移、Ed25519 服务签名与信任材料、实际业务策略 |
| 网站账户 | OIDC / Keycloak、账户会话与网站回调 | 精确 issuer、客户端、redirect URI、Cookie / CSRF、邮件服务 |
| 对话与附件 | Prosody、对象存储、ClamAV 及相关适配 | 当前传输配置、扫描策略、私有文件读取路径与存储配额 |
| 官网内容与管理 | Payload / Next.js 管理应用及管理 OIDC | 独立 CMS 数据库、持久媒体目录、CMS 迁移和实际业务授权 |
| 运行维护 | 按所选配置启用监控、日志、备份工具 | 实际接收人、保留空间、恢复目标与隔离恢复验证 |

Hub 业务不要求把五层架构拆成五个微服务。只启用已配置、确实要使用的组件，并如实说明缺少依赖时的功能范围。

## 服务环境与配置发现

API 入口为 [server.mjs](../packages/galaxy-official/src/server.mjs)，Worker 为 [worker.mjs](../packages/galaxy-official/src/worker.mjs)，环境约束位于 [runtime-environment.mjs](../packages/galaxy-official/src/runtime-environment.mjs)。

当前环境名只接受 `local`、`integration`、`pilot`，数据库名必须对应 `galaxy_<环境>`。API、Worker 和 migration 使用各自环境；Worker / migration 不携带 API 的签名字段。正式 API 要求准确 HTTPS origin，默认监听 loopback，Unix 上拒绝以 root 运行。

| 配置组 | 入口或变量 | 要点 |
|---|---|---|
| 数据库 | `DATABASE_URL`、`GALAXY_ENVIRONMENT` | 环境、数据库名和角色匹配；运行角色不作为 schema 所有者 |
| API 地址与监听 | `GALAXY_ENDPOINT`、`GALAXY_LISTEN_HOST`、`PORT` | HTTPS origin 与反向代理的实际外部地址一致 |
| 服务签名与信任 | `GALAXY_ENVIRONMENT_DIRECTORY`、`GALAXY_SIGNING_KEY_FILE`、`GALAXY_SIGNING_KEY_ID`、`GALAXY_ROOT_PINS_FILE`、`GALAXY_KEYRING_FILE`、`GALAXY_TRUST_DIRECTORY` | 精确环境目录内的材料；受信公钥必须与当前服务私钥相符 |
| 网页访问 | `GALAXY_BROWSER_POLICY_FILE`、`GALAXY_WEB_CONFIG_FILE` | 前者由 API 使用，后者由网站预览使用；公开配置只含公开信息 |
| 身份与账户 | `GALAXY_IDENTITY_CONFIG_FILE`、`GALAXY_ACCOUNT_CONFIG_FILE` | issuer、回调、客户端与来源按实际配置 |
| 聊天 | `GALAXY_CHAT_CONFIG_FILE` | Prosody 组件与业务权限一起核对 |
| 管理 | `GALAXY_OPERATIONS_CONFIG_FILE`、管理应用 `.env.example` | 独立管理身份和 CMS 数据库，见应用 README |

这不是全部环境变量列表。附件、日志、预算、规则等以当前消费者的配置加载器为准，不通过猜测环境名或复制旧服务器配置补齐。

## Linux 部署材料与顺序

[prepare-linux.mjs](../packages/galaxy-official/scripts/prepare-linux.mjs)依据已捕获的服务发行、准确摘要、运行时 pins 和可选 settings 生成新部署目录：

```text
node packages/galaxy-official/scripts/prepare-linux.mjs <服务发行绝对目录> <发行摘要> <运行时pins.json绝对路径> <全新输出绝对目录> [settings.json绝对路径]
```

输出由 [linux-plan.mjs](../packages/galaxy-official/deploy/linux-plan.mjs)生成；命令只准备材料，不连接服务器、不激活服务，也不生成真实凭据。不得把不完整示例当作已就绪配置。

部署时按同一发行处理：

1. 准备目标域名、HTTPS、数据库、持久目录、所选依赖与当前可恢复的备份。保留旧版本和数据，不用新安装覆盖既有身份。
2. 安装相应锁定依赖；通过进程管理器或受保护配置注入各角色的环境与凭据。
3. 使用迁移角色执行 [migrate.mjs](../packages/galaxy-official/src/migrate.mjs)，按需要显式配置受限角色。API 启动不会自动迁移数据库。
4. 配置所选认证、聊天、存储、扫描和管理组件，核对网站公开配置及准确 Origin。
5. 启动 API、Worker 和实际依赖，再切换对应网站制品。检查健康、就绪、版本及受影响的真实业务路径。
6. 失败时按该批发行和数据库兼容关系恢复，不对已升级 schema 盲目切回旧代码。

本页没有执行这些生产动作。当前操作必须使用目标环境的真实配置与授权，不能从文档中的例子推导可用账号或密钥。

## 管理、监控与整站恢复

[管理应用 README](../apps/galaxy-admin/README.md)说明 CMS 独立数据库、媒体持久目录、迁移、Next standalone 静态文件和管理登录。CMS 草稿保存与网站发布分别处理。

[operations-stack](../packages/galaxy-official/deploy/operations-stack)包含 Grafana、Loki、Alloy、备份与恢复编排；[配置示例](../packages/galaxy-official/deploy/operations-stack/configuration.example.json)中的目录、域名、端口和 null 字段需要由部署者按目标环境填写，不能当作自动发现结果。

备份按整站数据关系考虑业务库、身份服务数据、聊天、文件、CMS、媒体及必要配置。备份命令成功、存在恢复点、隔离恢复成功和实际整站恢复是不同结果。restic / pgBackRest 的代码或配置存在，不代表异机灾备、告警到人或整站恢复已经验收。

## AI Agent 部署接续

部署 Agent 先读本仓库的架构、组件 README、配置示例与目标环境现状，识别准确的服务、版本、数据库和凭据引用。原始秘密留在授权的进程或受保护存储，不进入 Git、网页配置、提示、截图或报告。

保持在线账户、本机签名控制、管理角色和内容许可的区别。新域名、回调、CSP 或跨站错误应修正准确配置，不通过任意 Origin、关闭 CSRF、跳过签名或给运行进程超级用户来绕开。

验证记录应说明实际发行、执行的功能、使用的依赖以及仍未知部分。`/healthz`、`/readyz` 和网络声明可以确认对应服务的有限运行状态，不能代替实际邮件收件、聊天、文件扫描、模型调用或恢复流程。

常见问题是运行角色未配置、数据库名不匹配、Worker 误带 API 签名环境、CMS 连接业务库、前端指向旧 API、公钥状态过期、缺少持久媒体目录，以及把合成适配器验证写成真实外部服务验收。
