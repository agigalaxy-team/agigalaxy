# AI Agent 部署说明

先读 README、`repository-components.json`、组件接口和对应组件的 README、配置加载器、示例与锁文件。根据实际目录和进程核实部署来源、当前发行、完整迁移列表、账户域、角色和配置引用，不把状态页、旧日志或同名分支当成实时事实。无权限的远端读取不能自动扩大为修改权限。

本地准备按组件选择新输出目录，分别运行构建/封包。Hub 的 `capture` 只生成源码发行包，不安装依赖、不部署；Native/Gateway 的 Python 源编译不等于镜像构建。源码包的 apps/services、构建文件、配置示例和许可证需要保留；依赖原文及固定上游材料缺失时按真实缺口报告。

配置发现从实际加载器与受保护配置引用开始。只取所需字段的存在、路径、角色、端口和状态等元数据；凭据通过受保护进程使用，不打印值，不嵌入 URL，也不写到工作区、截图说明或提交。只在任务已经授权的主机、服务与用途内执行。

Native 持久化测试只接受全部显式 `GALAXY_AGENTOS_TEST_DATABASE_URL`、`GALAXY_AGENTOS_TEST_DATABASE_NAME`、`GALAXY_AGENTOS_TEST_ROLE`、`GALAXY_AGENTOS_TEST_SCHEMA`。名称遵循 `tests/database_contract.py` 的专用前缀，必须为 loopback 和显式端口；运行 URL 不作后备。先运行纯拒绝检查，随后以只读会话核对 actual database/role、危险角色能力、角色成员关系、数据库归属与 schema 所有者，完成后才能创建 AgentOS 表。

发行 `attempt` 需要明确的前后包/manifest digest、保护配置文件、原 operationId 和受保护输出位置。配置列出三项进程 unit、迁移 unit、每个目标环境/单位文件的准确目标与新源文件、保护快照目录、loopback `/readyz`；就绪必须返回 `status: ready` 和匹配的 `X-Galaxy-Release`。测试用文件适配器和进程替身，正式运行才调用 systemctl。

迁移提交前失败且完整数据库版本仍等于旧包时，程序恢复旧环境及 unit 文件、启动旧服务族并核对就绪。版本已推进、混合或无法判定时，保持服务停止并保留原尝试；未知只查询原记录，不能开始另一场迁移。提交后的兼容修复或具体数据库恢复需单独评审授权，不删除 `schema_migrations` 记录来伪装降级。业务恢复继续保留当前账户、密码、权限和密钥。

常见错误包括：把部署快照当完整开发仓库而漏锁文件；从旧 Git HEAD 丢掉已发布但未提交源码；用运行库跑测试；只改 API 忽略旧 UI 的 close 含义；把进程启动、代理200或模型登记当成真实业务效果；重新提交未知操作。处理时保留原事件、原失败和准确来源，程序核查当前事实后接续。
