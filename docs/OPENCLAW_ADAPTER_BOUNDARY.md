<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/2b/2b65a47f9963c02f1bc0b88dfa7f0d2326bac7a91341a9dda5db0b23f9c6b539.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# OpenClaw 适配边界（Founding Beta）

OpenClaw 可以是 Galaxy 的第一个 Agent runtime 入口，但不是 Galaxy 的身份、授权或验证替代品。

## 可接入的方式

OpenClaw / 其他 MCP Host 应通过 Galaxy Integration Pack 连接本地 stdio MCP。AI 先引导模块选择与预览；只有用户明确确认后，才初始化本地 Galaxy ID，并允许已启用模块创建 Case Draft、请求披露预览、确认本地 Consent Grant 或查看本地历史。

## 必须保持的边界

1. OpenClaw 的本地 Gateway/Agent 信任域不能自动扩展为 Galaxy Hub、多方协作或公开网络的信任域。
2. OpenClaw 的 Tool 调用只记录为 Attempt/配置来源；它本身不是 Galaxy Evidence 或能力证明。
3. Galaxy ID 的私钥、Consent Grant 和 Case 状态由 Galaxy 本地运行时管理；不交给插件安装状态、聊天账号或运行时内存替代。
4. MCP Server 默认 stdio、默认本地、默认无网络；任何远程 transport、自动发送或公开发布都属于未来单独的安全设计。

## 当前可用工具

详见根目录 `README.md`。其中所有“确认”只产生本地回执与 Local Proof Draft，不会向 OpenClaw、Hub 或公开网络传输数据。
