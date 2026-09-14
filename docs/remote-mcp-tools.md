<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/d4/d44e378c6c8bbbb1d68edcd68d1cbe16232b30110873144b0700c383c6918bef.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 独立远程 MCP 工具

2026-09-10完整链路更新：`remote-host-integration.test.mjs` 已将真实MCP客户端接到真实本地身份签名、Consent/Case服务和履历查询；宿主拒绝不产生远端写入，批准后创建记录，重复执行拒绝，撤销后公开搜索移除。此前单独工具测试使用控制器替身，本次补齐了真实本地服务组合。合成身份/Case及内存transport不等于生产HTTPS或真实用户验收。统一入口见[原生宿主验收](native-host-acceptance.md)。

`packages/galaxy-edge-mcp/src/remote-server.mjs` 导出 `createRemoteToolServer({controller, authorizePublication})`。由可信宿主注入已配置的运行时 controller，并将返回的 server 连接到宿主选择的 MCP transport。导入不联网、不加载密钥、不创建会话。现有 index.mjs 的本地 stdio 工具仍保持本地语义；本轮没有安装或启动新的全局 MCP 服务。

|工具|行为|
|---|---|
|galaxy_remote_history_query|显式远程查询，复用履历筛选结构|
|galaxy_remote_case_read|显式读取已授权Case|
|galaxy_publication_drafts_list|只读本地草稿及映射状态|
|galaxy_publication_prepare|保存本地待发布内容与Consent，返回准确预览和短期handle|
|galaxy_publication_execute|宿主批准后执行授权及Case写入|
|galaxy_publication_cancel|取消该handle对应的本地操作|
|galaxy_publication_reconcile|读取原事件并可能恢复本地回执，不重发远端内容|

authorizePublication(preview) 是可信宿主的确认回调，必须展示准确 endpoint、intentJson 和 payloadJson，并依据用户批准返回true；不能使用由MCP调用方提供的boolean或自动返回true。已授权会话和长期开发授权不等于对任意运行时草稿的发布批准。工具参数没有凭据、签名器、端点替换或批准标志。

每次prepare返回单次handle，有效期5分钟；超时不自动执行。执行拒绝或取消清理对应预览，不能取消后续别的宿主操作。远端结果仍是数据，不能作为指令或能力认证。关闭server会清理工具自己的待确认预览，不关闭宿主会话。

真实MCP客户端通过内存transport完成7工具发现、查询、宿主拒绝/批准、重复执行拒绝、取消和对账调用。加上原本地连接工具测试共5项通过，最后变更又复测远程工具通过。没有生产端点或真实用户发布操作。真实宿主transport接入和确认交互仍需集成验收，不能把此模块声称为已部署服务。
