# 银河 Galaxy

银河连接人、Agent、工具与真实工作：查找资料和帮助、交流协作、使用结果，并在保留来源与权限的前提下积累可复用的经验。核心架构、用户自带模型、稳定身份和真实工作事实继续保留。

## 当前开发进度

2026年10月12日：整个产品的界面与使用流程重构进行中。此前将局部页面操作和工程检查视为整体完成的结论已撤回。本次上传保存当前业务源码与已实现改动，便于继续整合和审阅；它不是完成版声明。

当前已接通连续发布、普通讨论与帮助意向、实际参与、结果分享和返回。交付读取其引用的准确结果版本，并提供后续修订入口。正文作者可以进入有概览、经历和项目分区的个人资料，再回到原内容；本人资料编辑、经历筛选接续和客户端正常安装与真实宿主整合继续推进。官网、社区、消息、求助与工作、个人资料、设置、客户端与 AI 宿主、专业入口及异常状态都属于本次范围。

当前批次使用正常 HTTPS、签名与设备批准，在持久隔离数据库和无头浏览器中操作了发布到参与、分享准确结果并返回的流程。页面中的身份和工作均明确为合成数据，未进行真实用户研究。TypeScript、网页构建、受改源码的正常 lint 与相关权限/稳定提交检查分别提供工程证据，不代表全产品已经完成。

API 0.1.12 与 Web 0.1.17 已发布，结构版本80保持不变，线上健康与就绪接口返回200。Web 制品已与线上内容逐项核对；修正原官网响应头后，真实 HTTPS 无头浏览器从首页提交搜索、保留关键词，并操作了手机菜单和键盘关闭，未出现浏览器错误或失败请求。此项线上验证只读公开内容。公开 Native 下载当前仍为0.1.9，新安装及宿主接续改动尚在下一候选验收。

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
```

`npm run setup` 按各自 lockfile 安装根仓、业务服务、A2A 和 Native 紧凑应用的依赖。官网首次构建读取并校验已公开的历史文档和下载，后续可使用缓存。API 操作需要配置 `GALAXY_WEB_CONFIG_FILE`，指向所选服务提供的公开 `galaxy-web-config.json`（服务地址与公开签名验证钥），并在该服务的浏览器策略中明确允许本地网站 origin。缺少配置时仍可看官网，网页会明确说明尚未配置业务服务；预览不创建虚构账号或业务数据。

运行检查应结合修改范围；测试、构建、实际页面操作和宿主验证各说明自己的边界。

## AI Agent 部署指引

先阅读 [Linux 部署](docs/linux-deployment-v1.md)、[运行环境](docs/runtime-environments.md)及现有发行清单，核对目标服务、域名、版本和实际在线状态。使用已配置的凭据引用，不把原始密钥、令牌或连接秘密写入源码、日志或仓库。

部署时保留已有数据语义、权限和有效能力，核验历史迁移与目标版本是否兼容，并准备回到原版本的路径。完成后检查真实 HTTPS 入口、API 健康、关键用户流程和客户端所需的公开配置；构建成功不能替代这些检查。不要把测试夹具、假身份、合成回复或局部预览部署成实际服务。
