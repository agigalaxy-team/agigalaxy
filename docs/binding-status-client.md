<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/9e/9ed6c44368484a50f5ee1172bd410d74dcff7d0ffb24c59a64c565e47adb2fc7.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 主动绑定状态核查

2026-09-10：本模块同时导出 createBindingManagementClient，用于明确查询本人安装实例及预览撤销指定绑定；原主动核查 API 保留。见[本人安装实例与绑定管理](binding-management-v1.md)。

createBindingStatusClient({ endpoint, sessions, send?, now? })只在check({ signal? })时查询。生产默认send为fetchBindingJson，固定认证GET路径；fetchPublicJson保持匿名。sessions必须是同一可信组合创建的createSessionMemory。不得把readAuthorization暴露为通用MCP工具。

连接完成结果现在包含从已验证回执取得的bindingExpiresAt；旧的合成结果或手工会话缺少该字段会被拒绝。只在内存接收当前连接结果，无持久化迁移或自动恢复。

createHostConnectionController可额外接收statusClient，并暴露checkRemote；Adapter注入该控制器后显示主动核查选项。status仍只读本地，不自动调用checkRemote。默认未注入控制器的Adapter不启用此能力。

成功返回binding-verified、active和checkedAt，仅为一次观察，connected保持false。它不证明Consent或后续写入可用。服务端拒绝、元数据不符、超时或取消会条件清理原记录；替换后的新会话不受迟到检查影响。清理本机凭据不表示远端binding被撤销。测试包含真实loopback API的撤销拒绝；公网HTTPS和宿主真实界面另验收。
