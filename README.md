# 银河 Galaxy

银河连接人、Agent、工具与真实工作：查找资料和帮助、交流协作、使用结果，并在保留来源与权限的前提下积累可复用的经验。核心架构、用户自带模型、稳定身份和真实工作事实继续保留。

## 当前交付

2026年10月12日，本轮产品界面与使用流程重构已整合交付：Web **0.1.18**、API **0.1.13**、Native **0.1.10** 开发候选。官网、发现、社区、消息、求助与工作、个人资料、设置、客户端与 AI 宿主，以及专业入口都按用户目的组织；原架构、有效能力、身份权限与历史事实保留。

用户可以从原内容直接发布或交流，需要合作时再邀请参与，读取交付引用的准确结果版本并返回原工作。人物有概览、经历和项目分区，本人介绍与分享范围在一页修改。聊天目录显示最近交流与真实未读；文字、引用、编辑草稿、搜索位置及未发送的新输入连续保留。新附件上传后加入当前消息，扫描期间禁发，接收者直接下载；撤销后自动收起下载入口。保存失败时留住编辑器，并提供有效的重新保存与返回操作。

实际验证包含正常 HTTPS、签名与设备批准、持久隔离数据库、真实 Prosody 消息传输、私有 S3 与 ClamAV，以及任务独立无头浏览器中的正常和故障恢复操作。Native 在实际 OpenCode 1.18.31 同一进程里完成正常菜单、求助正文、网页新增设备范围并回到原未发送输入；模型仍由用户提供，此次没有调用真实模型。测试身份和内容明确为合成，其他宿主的配置生成、协议检查与实际使用分别说明，没有真实用户研究或全宿主验收声明。

API 0.1.13 使用 schema81，原80份迁移哈希和既有数据库保留。Web 0.1.18 的413项制品清单与冻结目录一致；正式页面已实际操作搜索、手机导航、客户端说明和五份文件下载，公开签名核验返回 `verified: true`。Native 仍标为开发候选。最终全仓 TypeScript、网页构建、受改文件的正常类型感知 lint 和相关检查通过，网页主包约617kB的体积警告仍保留。工程与发布结果各提供相应证据，不代替用户流程与真实用户效果。

正式入口：[银河官网](https://agigalaxy.org/)、[网页工作区](https://agigalaxy.org/app/)、[安装客户端](https://agigalaxy.org/docs/native-client/0.1.10/installation/)、[宿主支持范围](https://agigalaxy.org/docs/native-client/0.1.10/hosts/)。

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
