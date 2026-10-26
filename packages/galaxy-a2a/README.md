# Galaxy A2A 适配器

此组件通过 @a2a-js/sdk 适配对端任务与结果，供 Native、宿主流程及银河工作事实使用。它不替代用户模型、对端授权或对实际结果的判断。当前完整仓库开发需要 Node.js 24.13+。

## 源码入口

package.json 的实际导出为：

| 导出 | 文件 |
|---|---|
| 主桥接 | [src/protocol/bridge.mjs](src/protocol/bridge.mjs) |
| host | [src/hosts/host-flow.mjs](src/hosts/host-flow.mjs) |
| host-v2 | [src/hosts/host-flow-v2.mjs](src/hosts/host-flow-v2.mjs) |
| facts-v2 | [src/facts/facts-v2.mjs](src/facts/facts-v2.mjs) |
| discovery | [src/protocol/card-discovery.mjs](src/protocol/card-discovery.mjs) |

实现按运行职责组织：`protocol/` 处理固定 A2A 接口和卡片发现，`hosts/` 接入已有 Native／宿主工作，`facts/` 映射银河事实与对端报告，`storage/` 保存原操作日志。宿主不直接操作日志文件，协议层也不自行取得宿主授权。

旧的 `src/bridge.mjs`、`card-discovery.mjs`、`facts-v2.mjs`、`host-flow.mjs`、`host-flow-v2.mjs` 和 `worker-pack-flow-v2.mjs` 只转出同一实现，供已有 Native／宿主源码入口继续使用。包导出和包内引用使用上表的新位置；新代码不通过这些兼容入口倒接内部模块。

对端卡片、接口、授权和期限依据所选配置固定。读取、准备、执行、取消及导入分别处理；结果未知时查询原任务和操作，不能换 ID 重复派发。停止本地等待不等于已取消远程任务。

对端完成、导入 participant-reported 结果、记录应用与原目标解决是不同事实。签名与协议可用不代表能力认证，参考 Worker 不是已有独立运营者的生产采用证据。

## 开发和集成

根 setup 安装本目录锁定依赖。相关检查可使用根 npm run test:a2a 或对应 node --test 文件，前置与边界见[开发检查](../../docs/technical/development.md)。

Native 配置、预览及使用方式见[客户端说明](../../docs/technical/native-client.md)。[架构](../../docs/technical/architecture.md)说明与 Hub、Core、HTTP 和 MCP 的关系；[项目状态](../../WORK_STATUS.md)区分源码、发行与实际运行范围。
