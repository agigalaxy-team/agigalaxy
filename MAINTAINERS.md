# 维护主体与变更责任

源码 GitHub 仓库归属真实组织 [agigalaxy-team](https://github.com/agigalaxy-team)，仓库为 [agigalaxy](https://github.com/agigalaxy-team/agigalaxy)。组件目录不建立新的团队、账号、权限或自动审批。当前未核实可用于 CODEOWNERS 的具体人员/团队 handle，因而不编造该配置；维护者通过仓库现有 Issue/PR 和访问权限接续审阅。

| 范围 | 维护时要一并处理 |
| --- | --- |
| Hub 服务族 | API/worker/migration/publisher、完整数据库版本、角色、失败恢复和受影响协议消费者 |
| 共享合同/Core/Mail | 真实导入方、版本依赖、来源/许可及兼容检查 |
| Web/官网/认证/Admin | 各自构建入口、共用 UI、登录域与原操作接续，不把目录整理变成重新实现 |
| AgentOS/Gateway/发现引擎 | 固定上游/锁文件、独立运行边界、Node 权威合同和配置引用 |
| Native/宿主接入 | 本机身份与控制、来源及隐私档位、宿主合同和安装范围 |

具体拥有者、审阅者和发行操作人以真实仓库权限与该次批准为准。开源许可、仓库公开性、远端拆仓和默认/保护分支不是本地组件目录可以自行改变的维护设置。拆仓前置条件见 [组件目录](docs/component-catalog.md)，安全问题见 [安全说明](SECURITY.md)。
