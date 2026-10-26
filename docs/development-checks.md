# 开发检查

[开发指南](development.md) · [贡献说明](../CONTRIBUTING.md)

工作节奏以[源码工作说明](../AGENTS.md)为准；本页只提供可选命令与各自适用范围，不增加另一套流程。真实业务的身份、权限、签名和事务照其用途保留。

## 按改动选择

下表是选项，不是每次都要执行的清单。只跑能回答本次改动是否正确的项目；没有相关行为改变的文案或格式调整不需要业务验收。

| 需要确认的变化 | 局部入口 |
|---|---|
| JS 业务、权限、恢复逻辑 | `npm test -- packages/galaxy-official/test/相关文件.test.mjs`，也可指定多个文件 |
| 单个工具或 Core | `npm test -- scripts/test/相关文件.test.mjs` 或指定 Core 测试路径 |
| Web 打包或类型变化 | 按问题选择 `npm run build:web` 或 `node node_modules/typescript/bin/tsc --noEmit` |
| 相关代码 lint | `node node_modules/oxlint/bin/oxlint <相关文件或目录>`；需要根范围时用 `npm run lint` |
| 官网生成 | `npm run build:site`；只改 Web 不必重取官网公开材料 |
| 管理应用 | 在 `apps/galaxy-admin` 按变化选择 `npm run types`、相关测试或 `npm run build`；不要求每次三项都跑 |

统一测试 CLI 接受明确的 `.test.mjs` 文件；只运行所选文件，不再忽略附加路径后回退全套。可在 `test:core`、`test:official` 或 `test:a2a` 后同样追加本包文件。未知选项、无效文件或缺少专用环境会直接说明问题，不以全套执行掩盖选择错误。实现见 [check.mjs](../scripts/check.mjs) 及 [checks](../scripts/checks)。

根测试子进程与管理端测试入口复用已有 `tsx` 加载器，支持测试直接消费实际 TypeScript 组件及其正常模块导入；生产构建仍使用各自工具链。

根 lint 检查 `app/`、`packages/`、`scripts/` 和 `lib/browser-demo.mjs`，保留通用 correctness、React Hooks、可访问性和类型感知规则。Next 规则只用于 `app/` 的 Next/vinext 演示；当前未启用 React Compiler，因此不运行其专用规则。完整 TypeScript 类型检查使用对应模块的 `tsc`/`types` 入口，不由 oxlint 的 `typeCheck` 代替。已捆绑的 DiceBear 生成模块 `packages/galaxy-web/src/vendor/account-avatar-generator.mjs` 按[第三方来源说明](../packages/galaxy-web/THIRD_PARTY_AVATARS.md)精确排除，人工维护的调用代码仍检查。

## 完整与环境专用检查

`npm test` 无路径时保留普通全范围测试；`npm run check` 再包含根 lint。仅在本阶段确需整体回归时选用一次，不与相同范围的局部结果重复堆叠。`check:layers` 是包含重叠范围和真实环境前提的整体验收编排，不能作为日常开发的默认起点；需要某一层时直接 `node scripts/verify-layers.mjs --layers=<所需层>`。

Prosody、PostgreSQL、Native 安装／捕获制品、代理、TLS、真实模型和整站恢复需要各自明确环境，选择相关专用入口即可。普通测试保留现有隔离环境要求；指定文件也不会绕过它们。

`check:requirements` 仅供带完整项目资料的维护工作区核对文档，不是独立源码克隆的开发前提。`prepare:client` 用于正式客户端候选制品准备，不是普通编辑后必跑命令。

CI 范围由[组件目录](component-catalog.md)与[实际 YAML](../.github/workflows/product-checks.yml)按变更选择，本页不复制固定全套清单。按实际结果交接，不为提交或交接重复相同输入的检查。
