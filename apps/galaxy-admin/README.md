# 银河运营后台

此应用使用真实 Payload 3.91.0、Next.js 16.4.2 和 React 19.2.8。官网内容保存在独立 PostgreSQL CMS 数据库；用户、限制、操作记录仍由银河业务 API 提供。管理账户使用独立 Keycloak 管理身份域与运营 OIDC，凭据、角色和会话与普通银河账户分开。同邮箱不自动关联，也不将普通账户升级为管理身份。

## 本地与自部署

在本目录安装依赖；Node.js 使用 24.13.0 或更高版本：

```sh
npm ci
```

按 `.env.example` 配置进程环境。`GALAXY_ADMIN_PUBLIC_ORIGIN` 是浏览器访问后台的完整 origin；`GALAXY_ADMIN_BFF_ORIGIN` 是服务端可达、受部署配置控制的银河 API origin。两者必须 HTTPS，独立本机夹具允许字面量 loopback HTTP。反向代理需要保留真实站点 Host；不要用请求参数决定内部 API 地址。

`GALAXY_CMS_DATABASE_URL` 必须指向独立 CMS 数据库；不要使用银河业务库。`GALAXY_CMS_SECRET` 从进程管理器或密钥存储注入，至少 32 字符。上传目录由 `GALAXY_CMS_MEDIA_DIR` 指定，应持久保存并与数据库一起备份。

全新本地开发库可显式设置 `GALAXY_CMS_DEV_PUSH=true` 后启动：

```sh
npm run dev -- --hostname 127.0.0.1 --port 3010
```

正式环境关闭自动 schema push。首次正式部署及模型变更，由 Payload 针对 CMS 库生成迁移，审阅该次 schema 变化并随发行保留迁移文件，再部署应用；不要对业务库运行这些命令：

```sh
npm run migrate:create -- cms-schema
npm run migrate
npm run build
npm run start
```

配置与模型的首次集中集成需要生成并保留初始 CMS 迁移；当前应用不伪造手写 Payload 内部表结构。运行配置需同时提供构建和启动过程。`npm run generate:types` 可生成本项目 Payload 类型；新增自定义组件时使用 `npm run generate:importmap` 更新映射。

使用 Next standalone 产物时，把本应用 `public/` 和 `.next/static/` 分别带入 standalone 的 `public/` 和 `.next/static/`；媒体目录仍通过运行配置持久挂载，不能只复制 `server.js`。

运营 OIDC 客户端回调为 `<public-origin>/v1/operations/callback`。BFF 的管理 origin 应与本应用配置相同。只有 BFF 实时返回的 `administrator` 或 `reader` 可以进入；`reader` 只读。应用不提供本地密码、首次管理员注册或普通账户提权入口。

## 内容编辑与发布

官网页面、站点设置支持草稿和版本；页面有鉴权预览入口。正文使用纯文本和受控模块：导语、段落、相关链接、图片、服务提示、正式发行入口。图片只允许常规位图；图片描述和来源许可分别保存。只有已发布页面引用的图片对访客开放。

“官网发布”显示已保存的发布版本，管理员点击“发布到官网”后，应用导出完整快照并提交实际发布队列。草稿保存不触发官网发布。状态来自队列的 `queued / building / published / failed`，不推算进度。网络结果未知时沿同一 `operationId` 和快照重试。

服务端 `GET /api/site/export` 要求当前运营登录，返回如下白名单数据；不包含草稿、操作员资料或业务私有资料：

```ts
{
  version: 1,
  settings: { siteTitle, description, footerLinks: [{ label, href }] },
  pages: [{ id, path, title, description, blocks, updatedAt }],
  media: [{ id, url, filename, alt, width, height, mimeType, filesize, credit }]
}
```

`blocks` 为 `hero {heading,text,links}`、`prose {heading,body}`、`linkList {heading,links}`、`image {mediaId,caption}`、`notice {tone,title,text}` 或 `releaseLinks {heading,channel:'stable',label}`，每项均带 `blockType`。链接为 `{label,href,description?}`。快照引用真实媒体 `filename`，发行版本、安装包、摘要和签名继续来自原发行流程。

## 业务用户管理

同一登录可查询 UID、用户名或完整邮箱，查看真实关联概况、账户类型记录和操作记录。管理员可按现有业务规则暂停或恢复社区参与，以及记录账户类型更正；这些操作不改变本地 ID 类型，不停用 Keycloak 登录。操作带原因、当前 revision 和稳定 `operationId`，未知结果重试沿用原意图；成功后重新读取当前资料。

“私聊举报”只读取用户明确选入案件的消息和附件，不提供房间历史入口。列表、材料和处理权限由业务服务实时给出；在读取期限到期、离线或请求失败时清除受控内容。管理员只有在服务端允许 `canModerate` 时才有处理入口，目标版本由当前案件自动带入。临时限制、处理结果及解除操作保留原操作号重试；案内附件每次下载都重新经业务服务核权。

## AI 代理部署接续

从项目现行入口读取产品目标和当前任务，再读取本目录配置。环境值在进程中发现和使用，不复制到提示、日志或仓库。先确认管理 public origin、受控 BFF origin、独立 CMS 数据库和媒体持久目录即可安排本批开发与部署；不要把普通官网 Cookie 当管理权限。

直接请求 Payload REST 写入口和 Next server action 均要求本站 Origin。运营代理只转发管理 Cookie 和实际 CSRF；跨站请求不会因代理而成为可信请求。自定义业务/发布视图在服务端鉴权，Local API 操作显式使用 `overrideAccess:false` 和当前用户。不要在新增页面省略这些真实权限处理。

阶段完成后集中执行与本次改动相称的类型、应用构建和定向行为检查；沿用已通过结果。首次实际集成应覆盖运营登录后编辑草稿/预览/发布状态，以及查询用户/写限制/回读审计这两条用户路径。常见失败是内部 API 地址被浏览器暴露、运营 origin 不一致、CMS 被连到业务库、未生成 CMS 迁移或上传目录未持久化；不要用开放注册或关闭鉴权来绕过这些配置问题。
