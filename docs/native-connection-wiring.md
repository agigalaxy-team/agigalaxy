<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/ba/ba5ef88ae9b55d841779d1a7ebde089513f123d15eb7e83379ebeb1979a7b9ab.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 原生连接控制器接线

Adapter现在导出`createGalaxyAdapter(connectionController)`，默认导出仍等价于不传控制器的本地只读版本。没有修改用户级OpenCode配置，没有因安装或打开/galaxy读取Manifest、签名或绑定。

可信部署组合入口可用现有createConnectionClient、createSessionMemory和createHostConnectionController构造控制器，再传给Adapter工厂。控制器组合参数为client、sessions、endpoint及readRequest；readRequest只读取已有本机公开ID/Genesis、安装ID和准确scope，不初始化身份或自动联网。client的sign/assertCurrent/trustedKeys配置仍遵守现有接线说明。

启用控制器时，现有第6项“接入银河”进入原生二级页，包含预览连接、断开本机会话和返回；原控制台菜单及设置项不改。预览页展示端点、准确请求JSON、最大有效期和精确确认文本。错误文本不执行；确认后才启动控制器。断开只丢弃本机凭据，不声称远端binding已经撤销。

执行中显示原生提示，Esc调用控制器cancel。页面代次检查使退出后的迟到prepare/execute不能重新打开页面；重复确认回调不会重复execute。控制器取消准备、丢弃晚到的连接结果，并在最终本地状态读取期间取消时清除已接收凭据。

Controller成功时只向UI返回session status，不返回握手凭据；错误提示不拼接异常对象或私密字段。session-local不表示远端持续在线。未配置控制器时原连接页仍显示未验证、未连接，保持冻结只读行为。

自动测试使用宿主原生Dialog API替身，检查第6项导航、准确请求呈现、错误/正确确认、Esc和迟到成功不重开；另有控制器prepare/execute/status竞态测试。Adapter TypeScript检查通过，但真实宿主排版、焦点与操作体验仍需人工验证。

本次提供并验证注入边界；默认宿主没有启用真实端点/签名回调。仍需把具体可信配置、已有本地状态校验及签名提供者接入部署入口，并完成HTTPS/远端恢复测试。没有注册远程账号或发布动态服务。

后续更新：[主动绑定核查](binding-status-client.md)已实现并通过本地自动验证；具体可信部署组合与HTTPS仍待完成。

后续组合实现：[可信本地主机入口](local-host-runtime.md)已提供；默认用户级配置未安装该入口，实际HTTPS和宿主人工另验收。
