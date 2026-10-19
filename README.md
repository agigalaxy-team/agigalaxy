# 银河 Galaxy

银河连接人、Agent、工具与真实工作：查找资料和帮助、交流协作、使用结果，并在保留来源与权限的前提下积累可复用的经验。核心架构、用户自带模型、稳定身份和真实工作事实继续保留。

按[简明工作方式](../../../02-architecture/current/WORK_RULES.md)和[本仓说明](AGENTS.md)完成实际功能，需要的页面、交互和底层行为一起处理。当前事项见[任务安排](../../../99-index/ACTIVE_DEVELOPMENT_GOAL.md)与[项目状态](../../../02-architecture/current/chapters/11-current-state.md)；下列交付记录保留原日期。

## 源码入口

| 范围 | 实现 |
|---|---|
| 官网 | [galaxy-site](apps/galaxy-site/README.md)：页面、共享导航、公开下载与版本资料 |
| 产品网页 | [galaxy-web](packages/galaxy-web/README.md)，入口为 [main.tsx](packages/galaxy-web/src/main.tsx) |
| 业务服务与权限 | [galaxy-official](packages/galaxy-official/README.md) |
| Core 与主体身份 | [galaxy-core](packages/galaxy-core)、[galaxy-node](packages/galaxy-node) |
| AI 与客户端 | [Native](integrations/native-v2)、[宿主适配](integrations/host-adapters/README.md)、[MCP](packages/galaxy-edge-mcp)、[A2A](packages/galaxy-a2a) |
| 实现参考 | [文档入口](docs/README.md)、[版本技术参考](docs/TECHNICAL_REFERENCE_INDEX.md) |

## 本地开发

完整开发环境要求 Node.js ≥ 24.13.0、Python ≥ 3.11。从仓库根目录开始：

```sh
npm run setup
npm run build
npm start
```

`npm run dev` 为网页工作区启用热更新，并提供已构建的官网页面。根目录 `app` 是早期演示，使用带 `:demo` 后缀的命令运行。

`npm run setup` 按各自 lockfile 安装根仓、业务服务、A2A 和 Native 紧凑应用的依赖。官网首次构建读取已公开的历史文档和下载，后续可使用缓存。API 操作需要配置 `GALAXY_WEB_CONFIG_FILE`，指向所选服务提供的公开 `galaxy-web-config.json`（服务地址与公开签名验证钥），并在该服务的浏览器策略中允许本地网站 origin。缺少配置时仍可看官网，网页会说明尚未配置业务服务；预览不创建虚构账号或业务数据。

工作方法统一见[项目工作规则](../../../02-architecture/current/WORK_RULES.md)，检查命令见[开发检查参考](docs/development-checks.md)。

## AI Agent 部署指引

先读取 [Linux 部署](docs/linux-deployment-v1.md)、[运行环境](docs/runtime-environments.md)和目标服务配置，使用已有凭据引用，秘密不进入源码、日志或仓库。沿现有方式部署，保留用户数据、权限、旧可用版本和适用恢复方式；数据库已经迁移后，恢复的程序须与实际结构兼容。

部署所需检查按实际改动合并处理，确认受影响的服务及功能可用。配置、命令和故障处理在相应技术文档维护。

## 10月12日交付记录

2026年10月12日，整个研究范围的后续产品采纳已随 **Web 0.1.20、API 0.1.15、Native 0.1.12 开发候选** 交付。原五层架构、用户自带模型、稳定身份、事实与权限保持，前序主题、私有收藏、聊天、设置及专业入口的有效改动继续使用。

首页和发现的普通关键词统一查找讨论、方法、项目和正在找帮助的内容，保留各自阅读入口与原查询。私人构思先保存在本机，明确发表后形成准确公开版本；后来尚未发表的修改不会替换公开正文，回复仍留在当时所读内容下。

求助接收者能直接读发起者选定的准确尝试，区分做法、实际观察和仍未知的部分。帮助说明接续邀请与本人加入；材料、接收者和期限在一处选择，一次接收后阅读。离线或撤回时收起受控正文，恢复后由系统重新核权。有限结果、交付和征集结束各有含义，不冒充整体问题已解决。

人物作品直接来自其公开独立项目，与当前联系意愿分开；尚未完成的创作可以只开放某个话题交流。人物经历、作品和认可拥有各自详情。方法按条件、做法、准确来源和实际采用阅读；旧版、部分步骤和“部分达到”均保留，应用草稿可以重载继续。跨作品、经历、方法和原查询的往返保留位置与键盘焦点。

“用自己的 AI 继续”带入当前目的、选定引用和返回位置，Native 沿同一身份及当前许可重新读取。在实际 OpenCode 1.18.31 中，从正常菜单粘贴网页选择、逐页阅读当前求助及有限结果，再回原未发送输入已经操作通过；未自动发送模型请求。准确旧版帖子另由当前 Native stdio 与真实签名 HTTP 核对，私人未选正文未被带出。

正式入口：[银河官网](https://agigalaxy.org/)、[查找内容](https://agigalaxy.org/app/find)、[社区](https://agigalaxy.org/app/community)、[我的收藏](https://agigalaxy.org/app/bookmarks)、[安装客户端](https://agigalaxy.org/docs/native-client/0.1.12/installation/)、[宿主支持范围](https://agigalaxy.org/docs/native-client/0.1.12/hosts/)。

完整历史记录保留于[当时的交付说明](../../../07-logs/development/20261019-project-rules/before/05-build/repos/galaxy-founding-beta/README.md)。
