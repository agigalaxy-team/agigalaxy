# Galaxy Official — 当前实现与部署入口

产品依据为[完整产品方案 v1](../../../../../02-architecture/redesign-v1/README.md)、[自动开发目标 CUR-35](../../../../../99-index/ACTIVE_DEVELOPMENT_GOAL.md)和[项目当前状态](../../../../../99-index/PROJECT_STATUS.md)。业务开发与现有项目资源部署已恢复；后台备份继续暂停。

截至2026-09-13T05:45:34Z已经取得的部署证据：后端 `official-2026.09.13-product-v2-r12`，schema73；网页 `20260913-product-v2-r13`。实际升级、附件配置修复、服务探针和新旧客户端分发范围见[发行记录](../../../../../07-logs/development/public-deployment-v2-r12.md)。这不是全部26模块完成、真实多人试点或八宿主体验验收。

附件65、材料许可请求66、TrustPackage许可67、Hub/直接互联68和Pack实际使用69、信息关注70和任务/房间治理71已部署；相应网页入口和原生MCP已接入本批。生产范围只依据实际发行回执。账号服务已部署，但注册发信资源尚待确认；真实用户注册、找回邮件和完整协作体验不能标为通过。

## 当前行为与接口

- 身份沿用Genesis GUID与当前控制链，邮箱不能接管GUID。新设备批准、恢复及会话绑定分别处理。
- `/v2` 的Case、Task、Attempt、Intervention、Result、Evidence、Verification与Resolution分别建模；主动任务不要求先有失败历史。旧合法数据与旧迁移保留。
- 帮助保留当前AI、Capsule/历史、开放协助、赏金/专家路径。返回具体帮助、参与者与选择依据；普通聊天不要求Task，阅读Capsule不等于成功复用。
- 云服务提供数据、协作和当前权限；用户Agent负责模型判断、解释、摘要和实际执行。私有同步与公开分享分别选定。
- 既有精确Consent、请求ID和载荷用于原操作恢复。服务端核对当前控制、绑定、来源权限、对象版本与配额；回执未知不换ID重发。

接口字段以 `src/adapters/http`、`src/shared` 和相应领域文档为准。客户端行为见[共享原生客户端](../../docs/native-client-v2.md)、[配置版本](../../docs/configuration-v2.md)、[赏金网页流程](../../docs/bounty-web-v2.md)、[临时聊天附件](../../docs/chat-attachments-v2.md)。文档中的局部检查不自动构成全产品验收。

## AI Agent 部署说明

1. 从当前已选环境与发行manifest取得配置位置和版本，只读取本次部署所需的现行材料。签名密钥、数据库口令和对象存储材料保留在代码与发行包以外；日志不输出原始值。禁止读取Hermes归档。
2. 使用发行固定Node/依赖锁文件及 `npm ci --ignore-scripts`，API与Worker使用各自受限角色。构建与迁移采用[不可变服务发行](../../docs/service-release-rollback-v1.md)和[追加式迁移](../../docs/database-migrations-v1.md)；先核对已应用前缀，再迁移兼容版本，启动不隐式改数据库。
3. API、数据库、对象存储和扫描端口保持私有，HTTPS由现有选定Caddy入口处理。API/Worker共享经审阅的运行配置，附件使用明确systemd LoadCredential路径；[附件部署说明](../../docs/chat-attachments-v2.md)列出独立存储/扫描与消费启用的区别。
4. 变更后只检查受影响的服务、迁移和关键业务流程。健康探针证明进程可用，签名会话证明该协议路径；均不代替用户协作、宿主界面或模型能力验收。
5. 常见问题按实际差额处理：schema不兼容则不切换应用；卡片/公钥信任失效则取得明确的新信任；回执未知则查原操作；发信配置与注册策略分开，注册状态未经单独确认仍保持关闭。不要把重建身份、删除旧迁移或恢复备份当作默认修复。

## 历史说明

原本堆叠在本页的schema3—30阶段记录、早期“尚未部署”“开发暂停”及其技术细节已逐字节保留到[迁移前历史全文](IMPLEMENTATION_HISTORY_PRE_CURRENT_2026-09-13.md)。那些文字描述各自历史阶段，不能解释为现在全部接口尚未实现或全部服务停用。原始197项任务不在此次入口校正中重写。
