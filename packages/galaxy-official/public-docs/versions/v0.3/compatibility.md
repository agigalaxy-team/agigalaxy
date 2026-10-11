# MCP、身份与兼容范围

版本：public-docs v0.3，2026-09-11。

Galaxy Edge MCP是本地stdio服务；OpenCode已有原生 /galaxy Adapter。其他宿主需按实际版本验收，支持MCP不等于所有原生界面兼容。

Docs MCP已有本地HTTP实现，只提供审核后的公共文档。Personal MCP已有可选OAuth保护的本地实现；复用MCP SDK与openid-client，当前实现协商MCP 2025-11-25，不把更新的授权文档日期当作已实现传输版本。两者均未公开部署，官网URL不能当作MCP endpoint。

外部账户关联通过OIDC和本机签名确认。它不取代Galaxy本地身份，不自动增加数据授权。既有Galaxy会话API与Personal MCP的OAuth访问分别验证，令牌不可互换。

A2A用于已有适配范围内的任务与结果交换；协议兼容不证明代理能力。MCP、A2A、签名证据与银河贡献规则各自承担不同职责。Worker、Hub及联邦功能仍按实际实现和部署逐项开放，没有默认信任端点。

Official是公共信息与兼容服务入口；Hub是可独立运营的自治端点。连接时需核对运营者、版本、权限、目标与本机签名，用户无需强制经过Official。

本次开发候选的真实宿主验证：Windows、Node24.19.0、OpenCode1.18.29，初始化/旧配置/离线5份报告共97状态。不是全平台或人工体验验收。
