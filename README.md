# 银河 Galaxy

银河连接人、Agent、工具与真实工作：查找资料和帮助、交流协作、使用结果，并在保留来源与权限的前提下积累可复用的经验。核心架构、用户自带模型、稳定身份和真实工作事实继续保留。

## 当前交付

2026年10月12日，内容发现与回找修正已随 **Web 0.1.19、API 0.1.14、Native 0.1.11 开发候选** 交付。上一版遗漏了社区主题及相关阅读组织；本轮在原有产品重构基础上补足，不用测试或发布数量代替产品结果。

社区现在按技术、创作、学习、生活和银河使用五个主题浏览，也保留全部及未分类入口。在主题内搜索标题和正文，进入帖子、回复后再返回，会接续原查询、已浏览页面、位置和键盘焦点。发帖沿用主题，身份接续和刷新保留草稿。帖子、方法、项目和人物提供只对本人可见的普通收藏，同一身份的获准设备可以回找。方法和项目支持无关键词浏览，项目的实际功能可继续筛选整个目录。

此前官网、聊天、求助与工作、人物资料、设置和专业入口的有效改动继续保留：内容、对话和结果构成主区，必要选择在对应动作中完成；来源、权限、分页、稳定提交与恢复由系统处理。原架构、用户自带模型、主体身份和真实历史不变。

本轮在正常页面、真实签名 HTTP 与隔离合成数据中操作主题发表、回复、两页阅读返回、四类收藏及两个获准网页设备接续，并核对390px及键盘。真实 PostgreSQL 从schema81升级至83，旧帖原始载荷、许可与时间保持；线上升级保留历史迁移和数据库。正式网站共432份制品经逐项核验，新版下载的签名与当前公钥状态通过独立检查。

统一工程检查为472文件、1565通过、0失败，另2项依赖独立 Python SDK 环境而跳过；真实 PostgreSQL、Prosody和宿主检查按各自环境单列。全仓 TypeScript、正常类型感知 lint及网页构建通过，约619kB主包警告保留。Native 0.1.11的社区和收藏增量完成菜单、真实本机 HTTP及包协议检查；实际OpenCode 1.18.31的此前操作属于0.1.10，不能外推为本次所有实体宿主已验收。本轮没有真实用户研究或真实模型调用。

正式入口：[银河官网](https://agigalaxy.org/)、[社区](https://agigalaxy.org/app/community)、[我的收藏](https://agigalaxy.org/app/bookmarks)、[安装客户端](https://agigalaxy.org/docs/native-client/0.1.11/installation/)、[宿主支持范围](https://agigalaxy.org/docs/native-client/0.1.11/hosts/)。

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
node scripts/check.mjs test
```

`npm run setup` 按各自 lockfile 安装根仓、业务服务、A2A 和 Native 紧凑应用的依赖。官网首次构建读取并校验已公开的历史文档和下载，后续可使用缓存。API 操作需要配置 `GALAXY_WEB_CONFIG_FILE`，指向所选服务提供的公开 `galaxy-web-config.json`（服务地址与公开签名验证钥），并在该服务的浏览器策略中明确允许本地网站 origin。缺少配置时仍可看官网，网页会明确说明尚未配置业务服务；预览不创建虚构账号或业务数据。

运行检查应结合修改范围；测试、构建、实际页面操作和宿主验证各说明自己的边界。

## AI Agent 部署指引

先阅读 [Linux 部署](docs/linux-deployment-v1.md)、[运行环境](docs/runtime-environments.md)及现有发行清单，核对目标服务、域名、版本和实际在线状态。使用已配置的凭据引用，不把原始密钥、令牌或连接秘密写入源码、日志或仓库。

部署时保留已有数据语义、权限和有效能力，核验历史迁移与目标版本是否兼容，并核对适用的恢复方式；数据库已追加结构后，未经兼容性验证不能直接切回旧二进制。完成后检查真实 HTTPS 入口、API 健康、关键用户流程和客户端所需的公开配置；构建成功不能替代这些检查。不要把测试夹具、假身份、合成回复或局部预览部署成实际服务。
