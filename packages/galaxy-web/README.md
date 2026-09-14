# 银河实际网页工作区

当前开发切片，使用正式 Core 浏览器身份材料、Official v2 Task 与签名验证。既有根目录 React 演示保持独立；此包单独生成静态资源，预期挂到已有 Oracle/Caddy 官网 `/app/`。本文件不证明已部署。

在仓库根运行：

```powershell
node node_modules/vite/bin/vite.js --config packages/galaxy-web/vite.config.mjs
node node_modules/vite/bin/vite.js build --config packages/galaxy-web/vite.config.mjs
```

网站根需由部署提供 `galaxy-web-config.json`：版本1、真实 `endpoint`、`operator`、`signingKeys`。每个签名公钥包含 `kid/publicKeyPem/notBefore/notAfter/revoked`；不得把示例公钥或接收到的未受信任manifest当配置。文件只有公开资料，不放客户端私钥/会话凭据。缺配置时界面明确不可连接，不返回演示业务。

API 使用 `GALAXY_BROWSER_POLICY_FILE` 指向版本1 JSON，字段 `origins` 为明确 HTTPS 网站 origin 列表；默认空列表维持旧API拒绝浏览器Origin。只开放GET/POST及Content-Type/Authorization/Accept，不允许通配符、cookie授权或任意子域。Origin允许不等于身份授权，各动作继续走实际 Access/Consent/Account。

当前网页已接本机ID创建/恢复/保存声明、真实账号验证流程、主动任务发布/申请/邀请/独立参与、普通房间/共同设置/消息恢复、项目发现与Capsule实时源权限读取。实际HTTP测试已贯穿新身份、无失败主动Task、申请回执恢复和参与确认。

聊天采用开源 Prosody/XMPP 通信与存档底座，银河实现房间、成员、授权、期限、业务关联及客户端界面。私有 Prosody 的实际部署记录见[后端部署 r12](../../../../../07-logs/development/public-deployment-v2-r12.md)，真实 Prosody、Garage、ClamAV 组合的聊天附件集成证据见[部署与集成 r8](../../../../../07-logs/development/public-deployment-v2-r8.md)。这些记录证明各自时点和范围，不表示当前服务健康、全部公网用户流程或八端宿主已验收。最新网页实现、部署、浏览器与本人验收分别以[实施记录](../../../../../02-architecture/redesign-v1/data/implementation-progress.json)为准，不能将构建通过写成26模块完成。

AI Agent 部署：先读项目 M18/M15/M01/M11 阅读包及CUR-35；使用已确认资源，保留官方公共资料白名单。部署API新迁移及角色后再发布工作区；给 `/app/*` 配SPA入口回退，API路径独立且不回退HTML；检查真实Browser Origin、签名pin期限、服务端点及一条实际授权旅程。身份与任务未验证时只记录构建/预览范围。禁用备份任务，不恢复旧实验，不复制本机身份材料进发行包。
