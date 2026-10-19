# 银河 Galaxy

银河连接人、Agent、工具与真实工作：查找资料和帮助、交流协作、使用结果，并在保留来源与权限的前提下积累可复用的经验。核心架构、用户自带模型、稳定身份和真实工作事实继续保留。

全部银河工作执行[项目工作规则](../../../02-architecture/current/WORK_RULES.md)和[本仓约束](AGENTS.md)。完整目标、实际读取、来源与采用、跨部分依赖和证据边界长期适用；[执行范围](../../../99-index/ACTIVE_DEVELOPMENT_GOAL.md)与[当前状态](../../../02-architecture/current/chapters/11-current-state.md)分别说明最新授权及事实。下列交付记录保留原日期，不代表已重新核验。

## 10月12日交付记录

2026年10月12日，整个研究范围的后续产品采纳已随 **Web 0.1.20、API 0.1.15、Native 0.1.12 开发候选** 交付。原五层架构、用户自带模型、稳定身份、事实与权限保持，前序主题、私有收藏、聊天、设置及专业入口的有效改动继续使用。

首页和发现的普通关键词统一查找讨论、方法、项目和正在找帮助的内容，保留各自阅读入口与原查询。私人构思先保存在本机，明确发表后形成准确公开版本；后来尚未发表的修改不会替换公开正文，回复仍留在当时所读内容下。

求助接收者能直接读发起者选定的准确尝试，区分做法、实际观察和仍未知的部分。帮助说明接续邀请与本人加入；材料、接收者和期限在一处选择，一次接收后阅读。离线或撤回时收起受控正文，恢复后由系统重新核权。有限结果、交付和征集结束各有含义，不冒充整体问题已解决。

人物作品直接来自其公开独立项目，与当前联系意愿分开；尚未完成的创作可以只开放某个话题交流。人物经历、作品和认可拥有各自详情。方法按条件、做法、准确来源和实际采用阅读；旧版、部分步骤和“部分达到”均保留，应用草稿可以重载继续。跨作品、经历、方法和原查询的往返保留位置与键盘焦点。

“用自己的 AI 继续”带入当前目的、选定引用和返回位置，Native 沿同一身份及当前许可重新读取。在实际 OpenCode 1.18.31 中，从正常菜单粘贴网页选择、逐页阅读当前求助及有限结果，再回原未发送输入已经操作通过；未自动发送模型请求。准确旧版帖子另由当前 Native stdio 与真实签名 HTTP 核对，私人未选正文未被带出。

工程检查为478个文件、1597项：1595通过、0失败、2项因独立 Python SDK 环境未配置而跳过；全仓 TypeScript、正常类型感知 lint、最终网页构建、Native 包协议与独立签名核验通过。三个隔离真实 PostgreSQL 流程另行通过；消息传输使用前序对应的真实 Prosody 证据，本批不重复声称新跑。网页主包约663kB的警告保留。

正式网站的452份制品清单与冻结目录一致，公开下载实际核验通过。本轮合成数据和正常页面操作、实体宿主、协议与线上观察各有自己的范围；没有真实用户研究、模型调用、所有实体宿主或稳定发行结论。认可页的当前实际场景为空态，不以虚构荣誉填充。

正式入口：[银河官网](https://agigalaxy.org/)、[查找内容](https://agigalaxy.org/app/find)、[社区](https://agigalaxy.org/app/community)、[我的收藏](https://agigalaxy.org/app/bookmarks)、[安装客户端](https://agigalaxy.org/docs/native-client/0.1.12/installation/)、[宿主支持范围](https://agigalaxy.org/docs/native-client/0.1.12/hosts/)。

## 源码入口

| 范围 | 实现 |
|---|---|
| 官网 | [galaxy-site](apps/galaxy-site/README.md)：页面、共享导航、公开下载与版本资料 |
| 产品网页 | [galaxy-web](packages/galaxy-web/README.md)，入口为 [main.tsx](packages/galaxy-web/src/main.tsx) |
| 业务服务与权限 | [galaxy-official](packages/galaxy-official/README.md) |
| Core 与主体身份 | [galaxy-core](packages/galaxy-core)、[galaxy-node](packages/galaxy-node) |
| AI 与客户端 | [Native](integrations/native-v2)、[宿主适配](integrations/host-adapters/README.md)、[MCP](packages/galaxy-edge-mcp)、[A2A](packages/galaxy-a2a) |
| 实现参考 | [文档入口](docs/README.md)、[版本技术参考](docs/TECHNICAL_REFERENCE_INDEX.md) |

`npm run build` 构建官网与实际网页工作区，`npm start` 提供二者的本地预览。`npm run dev` 为网页工作区启用热更新，并提供已构建的官网页面。根目录 `app` 是保留的早期演示，通过带 `:demo` 后缀的命令单独运行。

## 开发检查

完整开发环境要求 Node.js ≥ 24.13.0、Python ≥ 3.11。从仓库根目录安装依赖后，可运行：

```sh
npm run setup
npm run build
npm start
# 独立检查
node node_modules/typescript/bin/tsc --noEmit
npm run lint
node scripts/check.mjs test
```

`npm run setup` 按各自 lockfile 安装根仓、业务服务、A2A 和 Native 紧凑应用的依赖。官网首次构建读取并校验已公开的历史文档和下载，后续可使用缓存。API 操作需要配置 `GALAXY_WEB_CONFIG_FILE`，指向所选服务提供的公开 `galaxy-web-config.json`（服务地址与公开签名验证钥），并在该服务的浏览器策略中明确允许本地网站 origin。缺少配置时仍可看官网，网页会明确说明尚未配置业务服务；预览不创建虚构账号或业务数据。

运行检查应结合修改范围；测试、构建、实际页面操作和宿主验证各说明自己的边界。

## AI Agent 部署指引

先阅读 [Linux 部署](docs/linux-deployment-v1.md)、[运行环境](docs/runtime-environments.md)及现有发行清单，核对目标服务、域名、版本和实际在线状态。使用已配置的凭据引用，不把原始密钥、令牌或连接秘密写入源码、日志或仓库。

部署时保留已有数据语义、权限和有效能力，核验历史迁移与目标版本是否兼容，并核对适用的恢复方式；数据库已追加结构后，未经兼容性验证不能直接切回旧二进制。完成后检查真实 HTTPS 入口、API 健康、关键用户流程和客户端所需的公开配置；构建成功不能替代这些检查。不要把测试夹具、假身份、合成回复或局部预览部署成实际服务。
