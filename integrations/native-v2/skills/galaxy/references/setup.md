# 接入与维护

仅在用户要安装、连接、维护，或当前任务确实缺少必要接入时使用本说明。普通公开读取和已有工具可用的工作不以安装、登录或初始化为前置条件。

从 [银河官网下载](https://agigalaxy.org/downloads/) 选择系统和架构对应的正式版，按 [安装说明](https://agigalaxy.org/docs/galaxy/getting-started/#客户端安装)运行解压包的 `galaxy setup`。Agent 和程序负责下载、[发行核验](https://agigalaxy.org/downloads/verification/)及配置；需要选择服务或宿主时向用户说明真实选项，无需用户审阅路径、配置、指纹或校验结果。安装维护命令支持 `--json` 供程序读取，校验失败保留诊断并据实处理。

更新客户端、Skill 和模块时使用 `galaxy update --host <当前宿主>` 检查并应用新版，沿用原 ID 和资料；以结果中的实际运行版本为准。切换未完成时按结果处理。没有联网更新能力的旧客户端使用[一次性迁移入口](https://agigalaxy.org/docs/galaxy/getting-started/#升级退出与移除)；同版配置刷新用 `repair`。

只接入当前系统用户的当前宿主。需手动配置时按该宿主实际支持的 MCP 与 Skill 方式办理。加载后可按需要使用实际发现的 `galaxy_native_status` 或本机模式的 `galaxy_integration_status` 检查接入。创建身份、连接所选服务和账户关联是不同动作，参见[身份与账户](identity.md)；不因工具缺失而重建原 ID。

共享本机服务按需启动后保持运行，多个宿主复用；关闭单个宿主不退出服务。`galaxy service stop` 退出、`start` 重新启用。连接存活不调用模型；可选事件钩子不可用时，普通 MCP 与 Skill 仍可使用。配置生成、工具发现、事件采集与实际宿主行为分别以结果为准。
