# 开发检查

[开发指南](development.md) · [贡献说明](../CONTRIBUTING.md)

先连续完成一批实质改动，形成阶段成果后由主会话合并最小必要检查。相同输入已有有效结果直接复用；失败只回查受影响处，不按文件、提交、成员或交接重复运行。交接带上准确源码、结果、已有检查及未查部分，不要求每名成员各跑一套。避免阅读证明、指纹、门禁和巡检工具；真实业务的身份、权限、签名和事务机制保持。

统一 CLI 保持 `scripts/check.mjs`；其测试发现和执行实现分别位于 `scripts/checks/test-discovery.mjs` 与 `scripts/checks/runner.mjs`。普通范围仍只发现原包的顶层 `.test.mjs`，独立 Prosody／已捕获 Native 制品检查仍需要原明确前提；新子目录不意味着可以省略环境准备或自动改跑全部测试。

| 检查 | 命令 | 范围与前提 |
|---|---|---|
| 相关模块测试 | `node --test <相关测试文件>` | 优先选择受影响业务、权限或恢复路径 |
| 根 lint | `npm run lint` | 由 scripts/check.mjs 定义；当前目标为 app、packages、scripts 及 lib/browser-demo.mjs，不能外推管理应用全部源码 |
| 根 TypeScript | `node node_modules/typescript/bin/tsc --noEmit` | 按根 tsconfig.json 的实际包含范围 |
| 网页构建 | `npm run build:web` | 当前 React 工作区 |
| 官网构建 | `npm run build:site` | Python 3.11+；首次构建需要公开归档资源 |
| 统一产品前端构建 | `npm run build` | 网页与官网，不启动 API 或运行业务验收 |
| Core | `npm run test:core` | 统一 runner 的 Core 范围 |
| PostgreSQL | `npm run test:postgres` | 需要独立实际 PostgreSQL 配置 |
| Native 安装 | `npm run test:client-install` | 按对应脚本前置和范围，不等于所有物理宿主 |
| 管理应用 | 在 apps/galaxy-admin 中运行 `npm run types`、`npm run test`、`npm run build` | 独立依赖与配置，不属于根产品构建的全部覆盖 |

CI 具体范围由[组件目录](component-catalog.md)与[实际 YAML](../.github/workflows/product-checks.yml)按变更选择，不在本页复制另一份固定执行清单。在前一步失败后跳过的步骤没有结果。管理端、真实邮件、存储扫描、Prosody、真实模型和整站恢复需要相应环境，不由该工作流名称推定已经检查。

文档与图示修改可集中核对链接、资源和呈现，无需据此重复整套业务验收。源码、权限或行为改变时运行对应必要检查。
