# Linux 部署材料

本页是当前源码的可移植入口。历史服务器的端口、路径和启停记录不作为新实例配置；完整顺序见[部署指南](deployment.md)。

## 准备入口

[prepare-linux.mjs](../packages/galaxy-official/scripts/prepare-linux.mjs)读取捕获服务发行、发行摘要、准确 pins 和可选 settings，再调用 [linux-plan.mjs](../packages/galaxy-official/deploy/linux-plan.mjs)生成部署材料。

```text
node packages/galaxy-official/scripts/prepare-linux.mjs <服务发行绝对目录> <发行摘要> <运行时pins.json绝对路径> <全新部署包绝对目录> [settings.json绝对路径]
```

目录参数必须为绝对路径，输出目录必须全新。该命令验证所选发行并写材料，不接触服务器、不安装运行时、不生成真实凭据、不启动服务。

## 配置和安装

生成材料包含所选发行与 pins 对应的配置示例、数据库角色、反向代理及进程管理文件，以实际生成目录为准。

生成后按[部署指南](deployment.md#linux-部署材料与顺序)配置和应用本次所选组件；本页不重复安装步骤。

[运行环境约束](runtime-environments.md)说明数据库名和角色分离。API 不执行自动 schema 升级；涉及已升级数据库时，回退必须符合发行兼容关系，不删除原数据或盲目降级。

## 配套源码

| 范围 | 入口 |
|---|---|
| Linux 计划 | [linux-plan.mjs](../packages/galaxy-official/deploy/linux-plan.mjs) |
| Caddy 路由与候选 | [deploy](../packages/galaxy-official/deploy) |
| Prosody | [聊天部署目录](../packages/galaxy-official/deploy/prosody) |
| 监控、日志、备份与恢复 | [operations-stack](../packages/galaxy-official/deploy/operations-stack) |
| 认证主题与验证码 | [认证应用](../apps/galaxy-auth/README.md) |
| Payload 管理应用 | [后台](../apps/galaxy-admin/README.md) |

常见配置问题及 AI Agent 接续见[部署指南](deployment.md)；生成材料成功不表示已经应用到服务器。
