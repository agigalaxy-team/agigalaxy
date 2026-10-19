# 开发检查

工作方法见[项目工作规则](../../../../02-architecture/current/WORK_RULES.md)。本页只列可用工具入口。

常用入口：

- 模块测试：`node --test <相关测试文件>`。
- 网页构建：`npm run build:web`。
- 官网构建：`npm run build:site`。
- 类型检查：`node node_modules/typescript/bin/tsc --noEmit`。
- API 目录相关测试：`node --test packages/galaxy-official/test/api-reference.test.mjs`。
- 参考 Worker 协议测试：`node --test packages/galaxy-official/test/worker-pack-process-v2.test.mjs`。

旧检查记录见[历史技术说明](../../../../02-architecture/archive-ui-20261009/implementation/repo--development-checks.md)，保留其原版本含义。
