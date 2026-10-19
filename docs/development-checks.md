# 开发检查

按实际改动选择已有构建、类型检查或相关模块测试，操作受影响的功能，发现问题后直接修正。检查通过后继续完成工作，不默认重跑无关的全项目检查。

常用入口：

- 模块测试：`node --test <相关测试文件>`。
- 网页构建：`npm run build:web`。
- 官网构建：`npm run build:site`。
- 类型检查：`node node_modules/typescript/bin/tsc --noEmit`。

当前开发方法见[项目工作规则](../../../../02-architecture/current/WORK_RULES.md)。旧检查记录见[历史技术说明](../../../../02-architecture/archive-ui-20261009/implementation/repo--development-checks.md)，保留其原版本含义。
