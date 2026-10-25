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

## 当前运营工作区

后台复用同一侧栏、顶栏、品牌资产和栏目页签。AI 沟通只位于工作台；尚未连接执行服务时发送禁用，不生成模拟回答。访问、留存、画像或预测未采集／未分析时保留未知状态，不用公开帖子数量代替访问指标。

- `/admin/operations/users` 提供业务账户列表和详情，共用概览、画像与使用、参与限制、处理历史页签；认证管理仍由原工具负责。
- `/admin/operations/feedback` 提供反馈列表、正文和分类处理三栏。普通账户从官网 `/app/feedback` 提交问题或建议；后台可分类、标记状态、追加内部备注，不提供客服往返、用户进度查询或人员指派。
- `/admin/operations/audit` 提供左列表、右详情。服务端按动作投影允许的元数据，按记录类型、精确动作、上海日期和元数据关键词筛选并分页；通用读口不返回或匹配正文、检索原词及备注。一次有界扫描未结束时明确提示继续，不把空批误报成全范围无结果；未知决定／执行来源显示未记录，不从管理角色推断。
- `/admin/operations/community?tab=posts` 统一公开帖子与回复的运营读取、分类标签、下架恢复及处理历史。`visibility=unavailable` 可查有当前归属及权限依据的不可读目录元数据，不返回旧标题、作者、正文、原分类或附件，不允许处置；四项统计完整性无法确定时显示未知。运营覆盖单独保存，作者签名原文不改；批量只提供有限公开内容下架／恢复，先预览资格，执行时逐对象重新校验。置顶、精选当前仅为编排标记，未接前台位置／排序消费者。
- `/admin/operations/community?tab=reports` 复用真实举报与申诉材料，显式区分维持、解除本案限制和获准新设限制；不能因省略期限而清除旧限制，也不解除其他案件或全站运营下架。当前结果由原案件读取，主动通知尚未接通。

反馈附件使用独立引用与权限，选择性复用已有 S3 加密存储、上传校验和 ClamAV 扫描。仅扫描通过的本次草稿附件可以绑定反馈，后台每次下载复查权限与文件状态；不公开存储 URL。附件未配置时仍允许文字反馈。7／30 天为受保护配置可覆盖的工程默认值，不是用户已确认的保留规则；到期／撤销／隔离停止读取，物理清理仍需具体计划人工批准。反馈附件的统一文件治理列表、手动隔离恢复、获批物理清理及本人导出／删除消费者尚待适配，不能把独立上传下载链路视为这些能力已完成。

Agno、分析、推荐及其他新增底层仍按候选接入方向管理；本地工作区实现不表示已安装或启用了全部候选服务。实际组件观察使用明确合成身份与网络适配器，类型／构建和定向 SQL／HTTP 检查不替代正式 OIDC、CMS、数据库、对象存储及扫描服务联调。

## 业务用户管理

同一登录可查询 UID、用户名或完整邮箱，查看真实关联概况、账户类型记录和操作记录。管理员可按现有业务规则暂停或恢复社区参与，以及记录账户类型更正；这些操作不改变本地 ID 类型，不停用 Keycloak 登录。操作带原因、当前 revision 和稳定 `operationId`，未知结果重试沿用原意图；成功后重新读取当前资料。

“私聊举报”只读取用户明确选入案件的消息和附件，不提供房间历史入口。列表、材料和处理权限由业务服务实时给出；在读取期限到期、离线或请求失败时清除受控内容。管理员只有在服务端允许 `canModerate` 时才有处理入口，目标版本由当前案件自动带入。临时限制、处理结果及解除操作保留原操作号重试。

案内附件POST要求当前管理会话、同源和CSRF，reader仍可在原材料资格内读取；存储读取前后及成功审计前重新核对同一管理身份，缺少绑定当前请求的授权回调时拒绝。客户端在失联、期限到达、回读失败／失去资格或身份切换时取消在途下载，并在落盘前再核当前材料；不只依赖稍后的页面清空。此修复未增加全站私聊检索、单消息运营屏蔽、扩查或独立案件留存能力，P08布局也未因此定案。上游角色目录仍有原15秒缓存，不承诺外部撤权即时生效。

## AI 代理部署接续

从项目现行入口读取产品目标和当前任务，再读取本目录配置。环境值在进程中发现和使用，不复制到提示、日志或仓库。先确认管理 public origin、受控 BFF origin、独立 CMS 数据库和媒体持久目录即可安排本批开发与部署；不要把普通官网 Cookie 当管理权限。

本轮新增的业务迁移 98—101 归银河业务数据库，分别提供反馈记录、公开内容运营覆盖、反馈附件和原业务审计表的两项非唯一查询索引；它们不是 Payload CMS 迁移。部署前按[业务部署流程](../../docs/deployment.md)使用独立迁移角色及 `packages/galaxy-official/src/migrate.mjs` 核对业务版本，再核对 API／worker 受限角色与匹配版本；API 启动不会自动迁移，不能对 CMS 库执行业务迁移。附件配置沿已有 `GALAXY_ATTACHMENTS_CONFIG_FILE` 或 systemd 受保护凭据目录发现，新增 `feedbackPolicy` 只放保留参数，不在仓库或日志记录存储密钥。新反馈 worker 仅扫描，不执行自动永久清理。

直接请求 Payload REST 写入口和 Next server action 均要求本站 Origin。运营代理只转发管理 Cookie 和实际 CSRF；跨站请求不会因代理而成为可信请求。自定义业务/发布视图在服务端鉴权，Local API 操作显式使用 `overrideAccess:false` 和当前用户。不要在新增页面省略这些真实权限处理。

阶段完成后集中执行与本次改动相称的类型、应用构建和定向行为检查；沿用已通过结果。首次实际集成应覆盖运营登录后编辑草稿/预览/发布状态，以及查询用户/写限制/回读审计这两条用户路径。常见失败是内部 API 地址被浏览器暴露、运营 origin 不一致、CMS 被连到业务库、未生成 CMS 迁移或上传目录未持久化；不要用开放注册或关闭鉴权来绕过这些配置问题。
