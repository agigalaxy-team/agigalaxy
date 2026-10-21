# 开发检查

[开发指南](development.md) · [贡献说明](../CONTRIBUTING.md)

按本次改动选择有意义的检查，整批相关改动完成后集中运行。保留原失败和验证边界，不用历史通过记录替代当前结果。

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

当前 GitHub product 工作流执行 setup、lint、根类型、统一前端构建、Core 和指定集成测试，见[实际 YAML](../.github/workflows/product-checks.yml)。在前一步失败后跳过的步骤没有结果。管理端、真实邮件、存储扫描、Prosody、真实模型和整站恢复需要相应环境，不由该工作流名称推定已经检查。

文档与图示修改可集中核对链接、资源和呈现，无需据此重复整套业务验收。源码、权限或行为改变时运行对应必要检查。
