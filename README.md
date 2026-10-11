# 银河 Galaxy

银河连接人、Agent、工具与真实工作：查找资料和帮助、交流协作、使用结果，并在保留来源与权限的前提下积累可复用的经验。核心架构、用户自带模型、稳定身份和真实工作事实继续保留。

## 当前开发进度

2026年10月12日：整个产品的界面与使用流程重构进行中。此前将局部页面操作和工程检查视为整体完成的结论已撤回。本次上传保存当前业务源码与已实现改动，便于继续整合和审阅；它不是完成版声明。

当前正在处理从统一入口到可用结果的连续体验，包括发现与找人的查询接续、本人求助和参与工作的回到原处、客户端普通安装与真实宿主接入。官网、社区、消息、求助与工作、个人资料、设置、客户端与 AI 宿主、专业入口及异常状态都属于本次范围。社区是其中一部分。

已有实现与后续检查分别说明。10月10日的 TypeScript、网页构建及正常 lint 通过只属于当时源码的工程证据，不能证明整个产品已完成。页面验证使用隔离的虚拟无头浏览器。

## 源码入口

| 范围 | 实现 |
|---|---|
| 产品网页 | [galaxy-web](packages/galaxy-web/README.md)，入口为 [main.tsx](packages/galaxy-web/src/main.tsx) |
| 业务服务与权限 | [galaxy-official](packages/galaxy-official/README.md) |
| Core 与主体身份 | [galaxy-core](packages/galaxy-core)、[galaxy-node](packages/galaxy-node) |
| AI 与客户端 | [Native](integrations/native-v2)、[宿主适配](integrations/host-adapters/README.md)、[MCP](packages/galaxy-edge-mcp)、[A2A](packages/galaxy-a2a) |
| 实现参考 | [文档入口](docs/README.md)、[版本技术参考](docs/TECHNICAL_REFERENCE_INDEX.md) |

根目录 app 中保留的是早期演示；正常产品网页使用 galaxy-web。统一的开发启动入口仍在整合，不能把单独启动根目录演示等同于启动整个银河。

## 开发检查

要求 Node.js ≥ 22.13.0。从仓库根目录安装依赖后，可运行：

```sh
npm ci
node node_modules/vite/bin/vite.js build --config packages/galaxy-web/vite.config.mjs
node node_modules/typescript/bin/tsc --noEmit
npm run lint
```

运行检查应结合修改范围；测试、构建、实际页面操作和宿主验证各说明自己的边界。

## AI Agent 部署指引

先阅读 [Linux 部署](docs/linux-deployment-v1.md)、[运行环境](docs/runtime-environments.md)及现有发行清单，核对目标服务、域名、版本和实际在线状态。使用已配置的凭据引用，不把原始密钥、令牌或连接秘密写入源码、日志或仓库。

部署时保留已有数据语义、权限和有效能力，核验历史迁移与目标版本是否兼容，并准备回到原版本的路径。完成后检查真实 HTTPS 入口、API 健康、关键用户流程和客户端所需的公开配置；构建成功不能替代这些检查。不要把测试夹具、假身份、合成回复或局部预览部署成实际服务。
