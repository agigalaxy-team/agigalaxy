<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/87/87afdc3a9d9c4a80bc1f06c20e2a36ae53d14cbea5ce64e7e6b6d47460c46ede.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 原生宿主与独立工具验收入口

2026-09-11最新：候选5完成80×24/120×40完整初始化与实际数字键，修复L3、隐私页和确认说明溢出；当前候选旧配置/离线复跑通过。CL-09自动交付待复核，原真人/来源/发布条件保留，见[初始化与多尺寸证据](native-initialization-layout-v1.md)。

2026-09-11配置切换更新：独立候选4在真实120×40 OpenCode中记录41个状态，完成端点、Scope、请求内容、身份和合成重置后的会话失效；CL-07自动交付待复核。15项宿主契约、严格类型和lint通过。CL-09仍需完整首次初始化及多尺寸布局体验；详见[实际切换证据](native-configuration-switch-v1.md)。

2026-09-11最新：独立安装包在真实 OpenCode/ConPTY 完成显式读取、取消、错误/精确确认、绑定查询、撤销与错误/过期 Manifest。原生关闭时序修复；14 项宿主契约、10 项原验收相关检查、严格类型和 lint 通过。当前独立远程 MCP 为 8 个工具；下文早期数量保留历史语境。具体覆盖、合成材料和剩余真实尺寸/配置切换见[原生绑定实测](native-binding-host-v1.md)。

2026-09-11原生包更新：111源码/9个ESM的原生宿主包已独立离线安装，真实OpenCode完成已初始化、旧格式、恢复、配置错误及离线5场景，本地文件摘要不变。完整配置绑定、真实用户和人工体验保留；见[包与实际运行](native-host-package-v1.md)。

2026-09-11更新：真实OpenCode 1.18.29完成有限的加载/页面切换/停用重启检查，修复生命周期和旧页面误清新按键问题。当前host-contract为7文件13项，完整体验仍待人工验收；下文9月10日“没有启动渲染进程”仅指当时测试。见[实际宿主接线与证据](native-host-lifecycle-v1.md)。

2026-09-10：CL-08/CL-09。使用现有分层检查脚本运行本批相关检查：

```text
node scripts/verify-layers.mjs --layers=adapter,host-contract
```

`adapter` 使用仓库严格 TypeScript 配置，包含配置工厂、原生入口和窄宿主类型。`host-contract` 以并发 2 运行下列 6 个测试文件，共 9 项测试。报告和原始输出保存在独立 `outputs/layer-check-*/` 目录；未选择的层保持 `not-run`，真实宿主和发布层保持 `manual`。

|验收内容|自动化证据|仍需独立验收|
|---|---|---|
|旧配置只读、L3、首次初始化与恢复分支|Core `l3-initialization.test.mjs`|实际支持宿主的首次/旧配置体验|
|六项主菜单、独立接入、精确确认、Esc|Core `l3-initialization.test.mjs`、`host-connection.test.mjs`|原生窗口渲染、键盘与焦点、不同终端尺寸|
|配置读取、真实本机签名、断开/重读、卸载/迟到回调、离线回执|Official `configured-adapter.test.mjs`|实际宿主插件挂载/卸载钩子|
|履历筛选与宿主选中草稿、准确发布预览|Official `history-adapter.test.mjs`|真实用户查询相关性与披露体验|
|7个独立MCP工具、单次handle、宿主拒绝/批准/取消|Official `remote-tools.test.mjs`|宿主实际选用的transport与批准界面|
|真实MCP客户端→本机身份签名→授权与Case写入→查询→撤销|Official `remote-host-integration.test.mjs`|生产HTTPS、真实经授权Case与第三方验证|

原生测试调用稳定宿主的 Dialog/keymap API 模拟器，没有启动 OpenCode 渲染进程；不能据此说 80×24 或其他终端尺寸通过。MCP 测试使用真实客户端/服务端和内存transport，业务处理器及数据库是真实本地实现，身份和Case是合成测试材料。当前报告的 `releaseReady` 保持 false。

## 工具接线

配置工厂现在接受第二个可选参数 `{ readCaseSubmission }`。此回调仅在用户选择“提交已授权草稿”后调用，返回 `{ consentId, payloadJson }` 或 `null`。回调由可信宿主提供，选择范围、接收者和准确内容仍由现有原生预览与服务端Consent校验约束。没有回调时不显示此入口；本地草稿发布仍走独立的选择、可见性和授权流程。

独立 MCP 工具通过 `createRemoteToolServer({ controller, authorizePublication })` 连接同一已配置的本地运行时，见[远程工具](remote-mcp-tools.md)。原本地 `galaxy_connection_preview/status` 的只读含义不变。MCP调用方不能通过传递 `approved: true` 代替宿主批准，查询结果继续标为端点报告。

本轮实际执行：上述两层通过，host-contract 9项通过；lint通过。真实MCP集成在纳入统一层前也独立通过。没有新建远程端点、修改全局插件配置或部署动态服务。
