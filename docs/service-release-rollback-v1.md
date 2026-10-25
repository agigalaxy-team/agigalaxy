# 服务发行与失败恢复

本仓库的 `packages/galaxy-official/scripts/service-release.mjs` 提供 `capture`、只读 `compare` 和显式 `attempt`。实际主机变更只在已经获得具体部署授权后运行；本地构建不会自动启用该动作。

## 生成和比较

```sh
node packages/galaxy-official/scripts/service-release.mjs capture <新包绝对目录> <releaseId> <configurationVersion> <新回执绝对路径>
node packages/galaxy-official/scripts/service-release.mjs compare <原包绝对目录> <原manifest摘要> <目标包绝对目录> <目标manifest摘要> <新回执绝对路径>
```

`capture` 读取 catalog 的 Hub 服务族四入口，递归跟随字面 static/dynamic import，缺失模块直接阻止封包；包内还保存 API/Core 源、SQL、共用邮件和显式资源清单。可变模块名、环境选择的文件与外部包不由字面闭包证明，继续按显式资源和原锁文件处理。

`compare` 从受保护进程的 `GALAXY_RELEASE_DATABASE_URL` 取得只读数据库连接，核对完整迁移列表和恢复状态。历史 SQL 不同、目标完整列表不等于当前数据库时拒绝应用回滚；它不执行数据库降级。

## 分阶段尝试与恢复

```sh
node packages/galaxy-official/scripts/service-release.mjs attempt <原包绝对目录> <原manifest摘要> <目标包绝对目录> <目标manifest摘要> <保护配置绝对路径> <原operationId> <新结果绝对路径>
```

保护配置是仅管理员可读的 JSON，包含 `stateDirectory`、`units`（API/worker/publisher三个真实单位）、`migrationUnit`、loopback `readyUrl`（路径必须 `/readyz`），以及 `files` 数组；每项明确 `destination` 和 `targetSource`，涵盖本次会改的全部环境和 systemd unit 文件。秘密留在对应受保护文件，配置只引用路径。需要切换的迁移 unit/环境也必须纳入，不能省掉后声称已完整恢复。

程序先取得 PostgreSQL session advisory lock，核对旧包完整版本，保存保护快照和原 operationId，再停止三进程、更新准确文件、daemon-reload、运行迁移。迁移完成后重读完整版本，启动目标并通过匹配 `X-Galaxy-Release` 的 `/readyz`（`status: ready`）确认。

| 失败时数据库事实 | 自动行为 |
| --- | --- |
| 迁移已停止，完整版本仍等于旧包 | 恢复全部原文件，daemon-reload，启动旧三进程并核对旧发行就绪 |
| 完整版本已推进或出现其他列表 | 保持停止，不把旧进程指向新 schema；准备兼容修复或另行批准的数据库恢复 |
| 迁移仍运行、数据库观察不可达或恢复结果未知 | 保留 `result-unknown` 与失败阶段；只查询同一 operationId，不再迁移 |

重复 `attempt` 使用相同 operationId 和相同前后清单，只读取/接续原记录。结果文件必须用新路径，原失败回执保留。已激活或已经要求兼容修复的记录只作原尝试结果，不冒充当前服务状态。实现不删除/改写 schema_migrations 版本来假降级。

`test/postgres/service-release-attempt.test.mjs` 用专用 PostgreSQL 做提交前事务回滚、提交后失败、未知 ACK 原操作查询及并发锁；`test/service-release-host.test.mjs` 用真实隔离文件和进程替身验证环境/unit字节快照恢复与就绪合同。它们不代表已在生产切换、执行真实业务恢复或 Caddy 整链验收。业务恢复继续保留当前账户/密码/权限/密钥，具体恢复点、损失与重新开放仍由人工批准。

本主题现行要求：[部署与运行](deployment.md)、[开发与验证](development.md)。相关界面与操作遵循[产品原则与能力边界](project-overview.md)。

开发方法见[贡献与开发说明](../CONTRIBUTING.md)，工具入口见[开发检查参考](development-checks.md)。

## 外置历史参考

这些引用的正文保存在维护工作区，不在当前 Git 仓库内。当前可读入口：[文档目录](README.md)、[架构](architecture.md)、[项目状态](project-status.md)。旧运行记录不作为当前环境或功能验收依据。

<!-- Workspace reference retained: 历史技术说明 | ../../../../02-architecture/archive-ui-20261009/implementation/repo-&#45;service-release-rollback-v1.md -->
